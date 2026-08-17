"""Prepare upstream expert reports for a bounded final synthesis context.

Complete upstream reports are the primary input for a synthesis step. Source
summaries and raw page text remain stored in the evidence bundle for audit, but
are intentionally not repeated in the final prompt. When the combined reports
exceed the configured context budget, this module produces temporary,
source-link-preserving briefs. It never modifies the persisted evidence bundle.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from hashlib import sha256
import os
import re
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit

import aiohttp


DEFAULT_LEGACY_ROUTE_THRESHOLD = 120_000
DEFAULT_CONTEXT_INPUT_RATIO = 0.75
DEFAULT_OUTPUT_RESERVE_TOKENS = 16_000
DEFAULT_CHARS_PER_TOKEN = 4.0
DEFAULT_COMPRESSION_CACHE_ENTRIES = 64
_REPORT_BRIEF_PROMPT_VERSION = "report-brief-v1"
_REPORT_BRIEF_CACHE: OrderedDict[str, str] = OrderedDict()
DEFAULT_REPORT_CHUNK_CHARS = int(
    os.getenv("SYNTHESIS_REPORT_CHUNK_CHARS", "30000")
)
DEFAULT_REPORT_BRIEF_TARGET = int(
    os.getenv("SYNTHESIS_REPORT_BRIEF_TARGET_CHARS", "10000")
)
DEFAULT_EXTRACT_CONCURRENCY = int(
    os.getenv("SYNTHESIS_EXTRACT_CONCURRENCY", "3")
)
DEFAULT_EXTRACT_TIMEOUT_S = float(
    os.getenv("SYNTHESIS_EXTRACT_TIMEOUT_S", "240")
)

_EXTRACT_SYSTEM = (
    "You are a rigorous research editor. Preserve traceable factual claims "
    "and source links while preparing material for a downstream synthesis."
)
_REPORT_CHUNK_PROMPT = """Compress this section of an upstream expert report into a faithful research brief of no more than {target} characters.

Requirements:
1. Preserve concrete facts, numbers, dates, institutions, named policies, disagreements, uncertainties, and causal reasoning.
2. Preserve every Markdown source link exactly. Never invent, replace, or remove a URL.
3. Keep the report's conclusions, supporting reasoning, and limitations. Do not add information.
4. Write concise structured Markdown in the report's language.

Upstream report section:
{text}"""
_REPORT_MERGE_PROMPT = """Merge the following section briefs from one upstream expert report into one faithful, detailed brief of no more than {target} characters.

Requirements:
1. Preserve the expert's conclusions, evidence, causal reasoning, disagreements, and material uncertainty.
2. Preserve every Markdown source link exactly. Never invent, replace, or remove a URL.
3. Do not add a reference section or any information not present below.
4. Write structured Markdown in the report's language.

Section briefs:
{text}"""


def resolve_synthesis_context_budget(
    environment: Mapping[str, str] | None = None,
) -> int:
    """Return the report-character budget available to final synthesis.

    New deployments derive this from the configured model context window. The
    previous character budget remains the compatibility path for existing
    runtime.env files until they opt into the token-aware settings.
    """
    env = os.environ if environment is None else environment
    context_window = _positive_int(env.get("SYNTHESIS_CONTEXT_WINDOW_TOKENS"))
    if context_window is None:
        return _legacy_context_budget(env)

    input_ratio = _bounded_float(
        env.get("SYNTHESIS_CONTEXT_INPUT_RATIO"),
        DEFAULT_CONTEXT_INPUT_RATIO,
        minimum=0.1,
        maximum=1.0,
    )
    output_reserve = _positive_int(
        env.get("SYNTHESIS_OUTPUT_RESERVE_TOKENS"),
        default=DEFAULT_OUTPUT_RESERVE_TOKENS,
    )
    chars_per_token = _bounded_float(
        env.get("SYNTHESIS_CHARS_PER_TOKEN"),
        DEFAULT_CHARS_PER_TOKEN,
        minimum=1.0,
        maximum=8.0,
    )
    available_input_tokens = max(1, context_window - output_reserve)
    budget = int(available_input_tokens * input_ratio * chars_per_token)
    return max(1_000, budget)


def _legacy_context_budget(environment: Mapping[str, str]) -> int:
    return max(
        1_000,
        _positive_int(
            environment.get("SYNTHESIS_REPORT_CONTEXT_BUDGET_CHARS"),
            default=_positive_int(
                environment.get("SYNTHESIS_ROUTE_THRESHOLD_CHARS"),
                default=DEFAULT_LEGACY_ROUTE_THRESHOLD,
            ),
        ),
    )


def _positive_int(value: str | None, default: int | None = None) -> int | None:
    try:
        parsed = int(value) if value is not None and value.strip() else None
    except ValueError:
        parsed = None
    if parsed is not None and parsed > 0:
        return parsed
    return default


def _bounded_float(
    value: str | None,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    try:
        parsed = float(value) if value is not None and value.strip() else default
    except ValueError:
        parsed = default
    return min(maximum, max(minimum, parsed))


def clear_synthesis_compression_cache() -> None:
    """Clear the process-local temporary brief cache, primarily for tests."""
    _REPORT_BRIEF_CACHE.clear()


@dataclass
class CompressionStats:
    """Structured diagnostics for a synthesis-context preparation run."""

    original_characters: int = 0
    deduped_characters: int = 0
    final_characters: int = 0
    source_count: int = 0
    duplicate_count: int = 0
    extracted_count: int = 0
    extraction_failures: int = 0
    passthrough: bool = True
    duration_ms: int = 0
    original_report_characters: int = 0
    final_report_characters: int = 0
    compressed_report_count: int = 0
    cache_hit_count: int = 0
    cache_miss_count: int = 0
    fallback_attempt_count: int = 0
    fallback_success_count: int = 0
    fallback_failure_count: int = 0
    strategy: str = "full_reports"

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
            "originalReportCharacters": self.original_report_characters,
            "finalReportCharacters": self.final_report_characters,
            "compressedReports": self.compressed_report_count,
            "cacheHits": self.cache_hit_count,
            "cacheMisses": self.cache_miss_count,
            "fallbackAttempts": self.fallback_attempt_count,
            "fallbackSuccesses": self.fallback_success_count,
            "fallbackFailures": self.fallback_failure_count,
            "strategy": self.strategy,
        }


@dataclass
class _ExtractResult:
    text: str
    extracted: bool = False
    failed: bool = False


def _canonical_key(url: str | None) -> str | None:
    """URL normalization key kept for callers that need evidence de-duplication."""
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


def _report_content(bundle: dict[str, Any]) -> str:
    report = bundle.get("report")
    if not isinstance(report, dict):
        return ""
    content = report.get("content")
    return content.strip() if isinstance(content, str) else ""


def dedupe_sources(
    bundles: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int]:
    """Retain one raw summary per public URL without removing source identity.

    This is retained for evidence maintenance and compatibility. The final
    synthesis prompt now renders source metadata only, not source summaries.
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


def estimate_original_characters(bundles: list[dict[str, Any]]) -> int:
    """Return raw source-summary characters for backwards-compatible telemetry."""
    return sum(
        _summary_length(source)
        for bundle in bundles
        if isinstance(bundle.get("sources"), list)
        for source in bundle["sources"]
        if isinstance(source, dict)
    )


def estimate_report_characters(bundles: list[dict[str, Any]]) -> int:
    return sum(len(_report_content(bundle)) for bundle in bundles)


class SynthesisCompressor:
    """Compress reports only after their combined size exceeds the budget."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        fallback_base_url: str | None = None,
        fallback_api_key: str | None = None,
        fallback_model: str | None = None,
        route_threshold: int | None = None,
        cache_entries: int | None = None,
        report_chunk_chars: int = DEFAULT_REPORT_CHUNK_CHARS,
        report_brief_target: int = DEFAULT_REPORT_BRIEF_TARGET,
        concurrency: int = DEFAULT_EXTRACT_CONCURRENCY,
        timeout_s: float = DEFAULT_EXTRACT_TIMEOUT_S,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model.split(":", 1)[-1] if ":" in model else model
        self._fallback = (
            (
                fallback_base_url.rstrip("/"),
                fallback_api_key,
                fallback_model.split(":", 1)[-1]
                if ":" in fallback_model
                else fallback_model,
            )
            if fallback_base_url and fallback_api_key and fallback_model
            else None
        )
        self._route_threshold = max(
            1_000,
            route_threshold
            if route_threshold is not None
            else resolve_synthesis_context_budget(),
        )
        self._report_chunk_chars = max(1_000, report_chunk_chars)
        self._report_brief_target = max(1_000, report_brief_target)
        self._concurrency = max(1, concurrency)
        self._timeout_s = timeout_s
        self._cache_entries = max(
            1,
            cache_entries
            if cache_entries is not None
            else _positive_int(
                os.getenv("SYNTHESIS_COMPRESSION_CACHE_ENTRIES"),
                default=DEFAULT_COMPRESSION_CACHE_ENTRIES,
            )
            or DEFAULT_COMPRESSION_CACHE_ENTRIES,
        )
        self._active_stats: CompressionStats | None = None

    async def compress_reports(
        self,
        bundles: list[dict[str, Any]],
        report_characters: int,
    ) -> tuple[list[dict[str, Any]], CompressionStats]:
        """Keep full reports below budget; otherwise prepare per-expert briefs."""
        reports = [
            (bundle, _report_content(bundle))
            for bundle in bundles
            if _report_content(bundle)
        ]
        stats = CompressionStats(
            original_characters=report_characters,
            final_characters=report_characters,
            original_report_characters=report_characters,
            final_report_characters=report_characters,
            source_count=sum(
                len(bundle.get("sources") or [])
                for bundle in bundles
                if isinstance(bundle.get("sources"), list)
            ),
        )
        if report_characters <= self._route_threshold or not reports:
            return bundles, stats

        stats.passthrough = False
        stats.strategy = "hierarchical_report_briefs"
        target = min(
            self._report_brief_target,
            max(1_000, self._route_threshold // len(reports)),
        )
        semaphore = asyncio.Semaphore(self._concurrency)
        session_timeout = aiohttp.ClientTimeout(total=self._timeout_s)
        self._active_stats = stats
        try:
            async with aiohttp.ClientSession(timeout=session_timeout) as session:
                results = await asyncio.gather(*[
                    self._compress_report(session, semaphore, content, target)
                    for _, content in reports
                ])
        finally:
            self._active_stats = None

        for (bundle, _), result in zip(reports, results, strict=True):
            report = bundle.get("report")
            if not isinstance(report, dict):
                continue
            report["content"] = result.text
            if result.extracted:
                stats.extracted_count += 1
                stats.compressed_report_count += 1
            if result.failed:
                stats.extraction_failures += 1

        stats.final_report_characters = estimate_report_characters(bundles)
        stats.final_characters = stats.final_report_characters
        return bundles, stats

    async def _compress_report(
        self,
        session: aiohttp.ClientSession,
        semaphore: asyncio.Semaphore,
        report: str,
        target: int,
    ) -> _ExtractResult:
        if len(report) <= target:
            return _ExtractResult(text=report)
        cache_key = self._report_cache_key(report, target)
        cached = _REPORT_BRIEF_CACHE.pop(cache_key, None)
        if cached is not None:
            _REPORT_BRIEF_CACHE[cache_key] = cached
            if self._active_stats is not None:
                self._active_stats.cache_hit_count += 1
            return _ExtractResult(text=cached, extracted=True)
        if self._active_stats is not None:
            self._active_stats.cache_miss_count += 1
        chunks = _split_report(report, self._report_chunk_chars)
        chunk_target = min(2_500, max(800, target // max(1, len(chunks))))
        try:
            briefs = [
                await self._chat(
                    session,
                    semaphore,
                    _REPORT_CHUNK_PROMPT.format(target=chunk_target, text=chunk),
                    chunk_target,
                )
                for chunk in chunks
            ]
            merged = "\n\n".join(brief.strip() for brief in briefs if brief.strip())
            if not merged:
                raise RuntimeError("report compression returned no content")
            if len(chunks) > 1 or len(merged) > target:
                merged = await self._chat(
                    session,
                    semaphore,
                    _REPORT_MERGE_PROMPT.format(target=target, text=merged),
                    target,
                )
            if not merged.strip():
                raise RuntimeError("report compression returned an empty brief")
            brief = merged.strip()
            _REPORT_BRIEF_CACHE[cache_key] = brief
            while len(_REPORT_BRIEF_CACHE) > self._cache_entries:
                _REPORT_BRIEF_CACHE.popitem(last=False)
            return _ExtractResult(text=brief, extracted=True)
        except Exception:
            # The original report is still persisted. This fallback keeps the
            # degraded request observable through the compression event.
            return _ExtractResult(text=_fallback_brief(report, target), failed=True)

    def _report_cache_key(self, report: str, target: int) -> str:
        report_hash = sha256(report.encode("utf-8")).hexdigest()
        provider_identity = "\0".join([
            self._base_url,
            self._model,
            _secret_identity(self._api_key),
            *(
                (
                    self._fallback[0],
                    _secret_identity(self._fallback[1]),
                    self._fallback[2],
                )
                if self._fallback
                else ("", "", "")
            ),
        ])
        return sha256(
            "\0".join([
                _REPORT_BRIEF_PROMPT_VERSION,
                report_hash,
                str(target),
                provider_identity,
            ]).encode("utf-8")
        ).hexdigest()

    async def _chat(
        self,
        session: aiohttp.ClientSession,
        semaphore: asyncio.Semaphore,
        prompt: str,
        target: int,
    ) -> str:
        try:
            return await self._chat_with_provider(
                session,
                semaphore,
                prompt,
                target,
                self._base_url,
                self._api_key,
                self._model,
            )
        except Exception as primary_error:
            if self._fallback is None or not _is_retryable_provider_error(primary_error):
                raise
            if self._active_stats is not None:
                self._active_stats.fallback_attempt_count += 1
            fallback_base_url, fallback_api_key, fallback_model = self._fallback
            try:
                content = await self._chat_with_provider(
                    session,
                    semaphore,
                    prompt,
                    target,
                    fallback_base_url,
                    fallback_api_key,
                    fallback_model,
                )
            except Exception:
                if self._active_stats is not None:
                    self._active_stats.fallback_failure_count += 1
                raise
            if self._active_stats is not None:
                self._active_stats.fallback_success_count += 1
            return content

    async def _chat_with_provider(
        self,
        session: aiohttp.ClientSession,
        semaphore: asyncio.Semaphore,
        prompt: str,
        target: int,
        base_url: str,
        api_key: str,
        model: str,
    ) -> str:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": _EXTRACT_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": min(16_000, max(1_024, int(target * 1.3))),
        }
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        }
        async with semaphore:
            async with session.post(
                base_url + "/chat/completions",
                json=payload,
                headers=headers,
            ) as response:
                response.raise_for_status()
                data = await response.json()
        content = data["choices"][0]["message"]["content"]
        return content or ""


def _is_retryable_provider_error(error: Exception) -> bool:
    if isinstance(error, aiohttp.ClientResponseError):
        return error.status in {408, 409, 425, 429} or error.status >= 500
    if isinstance(error, (aiohttp.ClientConnectionError, asyncio.TimeoutError)):
        return True
    message = str(error).lower()
    status_match = re.search(
        r"\b(?:http|status|code|error)\D{0,8}(4\d{2}|5\d{2})\b",
        message,
    )
    if status_match:
        status = int(status_match.group(1))
        return status in {408, 409, 425, 429} or status >= 500
    return bool(re.search(
        r"fetch|network|timeout|timed out|econnreset|econnrefused|socket|connection|temporarily unavailable",
        message,
    ))


def _secret_identity(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()[:16]


def _split_report(report: str, limit: int) -> list[str]:
    paragraphs = [
        paragraph.strip()
        for paragraph in re.split(r"\n\s*\n", report)
        if paragraph.strip()
    ]
    chunks: list[str] = []
    current: list[str] = []
    current_length = 0
    for paragraph in paragraphs or [report]:
        for piece in _split_long_text(paragraph, limit):
            additional = len(piece) + (2 if current else 0)
            if current and current_length + additional > limit:
                chunks.append("\n\n".join(current))
                current = []
                current_length = 0
            current.append(piece)
            current_length += len(piece) + (2 if len(current) > 1 else 0)
    if current:
        chunks.append("\n\n".join(current))
    return chunks or [report]


def _split_long_text(text: str, limit: int) -> list[str]:
    if len(text) <= limit:
        return [text]
    return [text[offset : offset + limit] for offset in range(0, len(text), limit)]


def _fallback_brief(report: str, target: int) -> str:
    headings = re.findall(r"^#{1,6}\s+.+$", report, re.MULTILINE)
    links = re.findall(r"(?<!!)\[[^\]\n]+\]\(https?://[^)\n]+\)", report)
    prefix = report[: max(500, target - 1_000)].strip()
    components = [
        "<!-- Upstream report compression degraded; full report remains stored. -->",
        *headings[:20],
        prefix,
        *links,
    ]
    return "\n\n".join(part for part in components if part)[: max(target, 1_000)]


def resolve_extraction_llm(request: Any) -> tuple[str, str, str] | None:
    """Resolve the fast OpenAI-compatible model used for temporary briefs."""
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
    return base_url, api_key, model.split(":", 1)[-1]
