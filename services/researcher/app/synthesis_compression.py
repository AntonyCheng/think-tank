"""综合上下文压缩：跨包去重 + 分级路由 + LLM 逐篇萃取。

针对多专家研究任务的最终综合步骤：上游各专家的证据包会把同一来源
的完整正文重复带入，且机构文档动辄数万字符，拼接后轻松超出模型
上下文窗口，导致综合报告为空或直接报错。

管线（每级只在仍超预算时触发）：
  L0 跨包去重   同一 URL 的正文只保留一份，URL/标题元信息全包可见
  L1 路由判断   去重后低于阈值则原文直喂（零信息损失）
  L2 逐篇萃取   超阈值的来源用 fast 模型压缩为结构化萃取件，
                强指令保全数字/日期/政策名；失败兜底保留头部

引用不受影响：引用锚定的是 URL+标题（见 collectObservedSources），
压缩只动正文，不动来源身份。
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import aiohttp

# ---- 可调参数（环境变量覆盖，见 runtime.env.example 注释）----
DEFAULT_ROUTE_THRESHOLD = int(os.getenv("SYNTHESIS_ROUTE_THRESHOLD_CHARS", "250000"))
DEFAULT_EXTRACT_THRESHOLD = int(os.getenv("SYNTHESIS_EXTRACT_THRESHOLD_CHARS", "2500"))
DEFAULT_EXTRACT_TARGET = int(os.getenv("SYNTHESIS_EXTRACT_TARGET_CHARS", "2000"))
DEFAULT_EXTRACT_CONCURRENCY = int(os.getenv("SYNTHESIS_EXTRACT_CONCURRENCY", "6"))
DEFAULT_EXTRACT_TIMEOUT_S = float(os.getenv("SYNTHESIS_EXTRACT_TIMEOUT_S", "240"))

_EXTRACT_SYSTEM = "你是一名严谨的研究助理，负责为下游综合报告保全可引用证据。"
_EXTRACT_PROMPT = """以下是一篇研究来源的正文。请把它压缩成不超过{target}字的结构化萃取件，用于撰写最终综合报告。

要求：
1. 【必须保留】所有具体数字、百分比、金额、年份日期、增速、排名、政策/法规/报告全名、机构名——一个都不能丢。
2. 保留关键结论句（尽量原文）。
3. 丢弃：广告、导航、页眉页脚、重复段落、与主题无关的内容。
4. 不要评论、不要总结体会、不要添加原文没有的信息。
5. 输出为紧凑的要点列表，每条一个事实。

来源标题：{title}
正文：
{text}"""


@dataclass
class CompressionStats:
    """一次综合压缩的结构化结果，用于诊断事件。"""

    original_characters: int = 0
    deduped_characters: int = 0
    final_characters: int = 0
    source_count: int = 0
    duplicate_count: int = 0
    extracted_count: int = 0
    extraction_failures: int = 0
    passthrough: bool = True
    duration_ms: int = 0

    def event_data(self) -> dict[str, Any]:
        return {
            "originalCharacters": self.original_characters,
            "dedupedCharacters": self.deduped_characters,
            "finalCharacters": self.final_characters,
            "sourceCount": self.source_count,
            "duplicatesRemoved": self.duplicate_count,
            "extractedSources": self.extracted_count,
            "extractionFailures": self.extraction_failures,
            "passthrough": self.passthrough,
            "durationMs": self.duration_ms,
        }


@dataclass
class _ExtractResult:
    text: str
    extracted: bool = False
    failed: bool = False


def _canonical_key(url: str | None) -> str | None:
    """URL 归一化去重键：去 query/fragment 的小写 host+path。"""
    if not url:
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return None
    return (parts.netloc.lower() + parts.path.rstrip("/")) or None


def _summary_length(source: dict[str, Any]) -> int:
    summary = source.get("summary")
    return len(summary) if isinstance(summary, str) else 0


def dedupe_sources(
    bundles: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int]:
    """跨证据包按 URL 去重。

    返回 (新 bundles, 去重后来源总字符, 移除的重复数)。第一个包里的
    来源保留原正文；后续包遇到同 URL 只保留 title/url 元信息（summary
    置空），URL 身份仍全包可见，引用不受影响。私有来源不参与去重。
    """
    seen: set[str] = set()
    removed = 0
    total_chars = 0
    for bundle in bundles:
        sources = bundle.get("sources")
        if not isinstance(sources, list):
            continue
        for source in sources:
            if not isinstance(source, dict):
                continue
            if source.get("visibility") != "public":
                total_chars += _summary_length(source)
                continue
            key = _canonical_key(source.get("url"))
            if key is None:
                total_chars += _summary_length(source)
                continue
            if key in seen:
                if _summary_length(source) > 0:
                    removed += 1
                source["summary"] = None
                continue
            seen.add(key)
            total_chars += _summary_length(source)
    return bundles, total_chars, removed


class SynthesisCompressor:
    """综合上下文压缩器。dedupe_sources 已就地的 bundle 上工作。"""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        route_threshold: int = DEFAULT_ROUTE_THRESHOLD,
        extract_threshold: int = DEFAULT_EXTRACT_THRESHOLD,
        extract_target: int = DEFAULT_EXTRACT_TARGET,
        concurrency: int = DEFAULT_EXTRACT_CONCURRENCY,
        timeout_s: float = DEFAULT_EXTRACT_TIMEOUT_S,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model.split(":", 1)[-1] if ":" in model else model
        self._route_threshold = route_threshold
        self._extract_threshold = extract_threshold
        self._extract_target = extract_target
        self._concurrency = max(1, concurrency)
        self._timeout_s = timeout_s

    async def compress(
        self,
        bundles: list[dict[str, Any]],
        deduped_characters: int,
    ) -> tuple[list[dict[str, Any]], CompressionStats]:
        """按预算压缩各来源正文，返回统计。"""
        stats = CompressionStats(deduped_characters=deduped_characters)
        if deduped_characters <= self._route_threshold:
            stats.passthrough = True
            stats.final_characters = deduped_characters
            return bundles, stats

        stats.passthrough = False
        semaphore = asyncio.Semaphore(self._concurrency)
        session_timeout = aiohttp.ClientTimeout(total=self._timeout_s)
        async with aiohttp.ClientSession(timeout=session_timeout) as session:
            jobs: list[asyncio.Task[_ExtractResult]] = []
            for bundle in bundles:
                sources = bundle.get("sources")
                if not isinstance(sources, list):
                    continue
                for source in sources:
                    if not isinstance(source, dict):
                        continue
                    # 私有文档正文不得外发到萃取模型，跳过。
                    if source.get("visibility") != "public":
                        continue
                    if _summary_length(source) <= self._extract_threshold:
                        continue
                    jobs.append(asyncio.create_task(
                        self._extract_source(session, semaphore, source)
                    ))
            results = await asyncio.gather(*jobs)
        for result in results:
            if result.failed:
                stats.extraction_failures += 1
            elif result.extracted:
                stats.extracted_count += 1
        stats.final_characters = sum(
            _summary_length(s)
            for b in bundles
            if isinstance(b.get("sources"), list)
            for s in b["sources"]
            if isinstance(s, dict)
        )
        return bundles, stats

    async def _extract_source(
        self,
        session: aiohttp.ClientSession,
        semaphore: asyncio.Semaphore,
        source: dict[str, Any],
    ) -> _ExtractResult:
        summary = source.get("summary")
        if not isinstance(summary, str) or not summary:
            return _ExtractResult(text="")
        title = source.get("title") if isinstance(source.get("title"), str) else ""
        prompt = _EXTRACT_PROMPT.format(
            target=self._extract_target,
            title=title[:80],
            text=summary,
        )
        async with semaphore:
            try:
                extracted = await self._chat(session, prompt)
            except Exception:
                # 兜底：萃取失败保留头部，丢整篇比丢开头更糟。
                source["summary"] = summary[: self._extract_target]
                return _ExtractResult(
                    text=source["summary"], failed=True
                )
        text = extracted.strip()
        if not text:
            source["summary"] = summary[: self._extract_target]
            return _ExtractResult(text=source["summary"], failed=True)
        source["summary"] = text
        return _ExtractResult(text=text, extracted=True)

    async def _chat(self, session: aiohttp.ClientSession, prompt: str) -> str:
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": _EXTRACT_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": int(self._extract_target * 1.5),
        }
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {self._api_key}",
        }
        async with session.post(
            self._base_url + "/chat/completions",
            json=payload,
            headers=headers,
        ) as response:
            response.raise_for_status()
            data = await response.json()
        content = data["choices"][0]["message"]["content"]
        return content or ""


def estimate_original_characters(bundles: list[dict[str, Any]]) -> int:
    return sum(
        _summary_length(s)
        for b in bundles
        if isinstance(b.get("sources"), list)
        for s in b["sources"]
        if isinstance(s, dict)
    )


def resolve_extraction_llm(request: Any) -> tuple[str, str, str] | None:
    """从请求与环境解析萃取用的 (base_url, api_key, model)。

    优先请求显式配置（AO 下发的 fast 模型），回退环境变量。萃取是
    信息保全作业，用 fast 模型即可；缺凭据时返回 None，调用方走
    纯去重路径。
    """
    base_url = (
        getattr(request, "base_url", None)
        or os.getenv("OPENAI_BASE_URL")
        or ""
    ).rstrip("/")
    api_key = getattr(request, "api_key", None) or os.getenv("OPENAI_API_KEY") or ""
    model = (
        getattr(request, "fast_llm", None)
        or os.getenv("FAST_LLM")
        or os.getenv("SMART_LLM")
        or ""
    )
    if not base_url or not api_key or not model:
        return None
    return base_url, api_key, model
