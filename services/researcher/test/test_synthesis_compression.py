"""synthesis_compression 单元测试：去重、预算路由、萃取兜底。"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.synthesis_compression import (
    DEFAULT_ROUTE_THRESHOLD,
    CompressionStats,
    SynthesisCompressor,
    dedupe_sources,
    estimate_original_characters,
    resolve_extraction_llm,
)


def _bundle(step: str, sources: list[dict]) -> dict:
    return {
        "aoStepId": step,
        "report": {"content": f"report of {step}"},
        "sources": sources,
    }


def _source(url: str, summary: str, title: str = "t") -> dict:
    return {"visibility": "public", "url": url, "title": title, "summary": summary}


class TestDedupeSources:
    def test_cross_bundle_duplicate_removed(self):
        long_a = "x" * 500
        b1 = _bundle("s1", [_source("https://a.com/doc", long_a)])
        b2 = _bundle("s2", [_source("https://a.com/doc", long_a)])
        _, total, removed = dedupe_sources([b1, b2])
        assert removed == 1
        assert total == 500
        # 第一个包保留正文，第二个包置空但 URL 身份保留（引用不受影响）
        assert b1["sources"][0]["summary"] == long_a
        assert b2["sources"][0]["summary"] is None
        assert b2["sources"][0]["url"] == "https://a.com/doc"

    def test_url_normalization_query_and_trailing_slash(self):
        b1 = _bundle("s1", [_source("https://a.com/doc?utm=1", "x" * 100)])
        b2 = _bundle("s2", [_source("https://a.com/doc/", "x" * 100)])
        _, _, removed = dedupe_sources([b1, b2])
        assert removed == 1

    def test_private_sources_untouched(self):
        private = {"visibility": "private", "title": "p", "summary": "sec" * 10}
        b1 = _bundle("s1", [private])
        _, total, removed = dedupe_sources([b1])
        assert removed == 0
        assert total == len("sec" * 10)
        assert private["summary"] == "sec" * 10

    def test_estimate_original_counts_all(self):
        b1 = _bundle("s1", [_source("https://a.com", "a" * 300), _source("https://b.com", "b" * 200)])
        assert estimate_original_characters([b1]) == 500


class TestRouting:
    def test_below_threshold_passthrough(self):
        small = _bundle("s1", [_source("https://a.com", "a" * 100)])
        compressor = SynthesisCompressor("http://x", "k", "m")
        out, stats = asyncio.run(compressor.compress([small], 100))
        assert stats.passthrough is True
        assert stats.final_characters == 100
        assert out[0]["sources"][0]["summary"] == "a" * 100


class TestExtraction:
    def _compressor(self):
        return SynthesisCompressor("http://llm", "key", "provider:model")

    def test_long_source_extracted(self):
        long_text = "数字事实 123 万亿。" * 400  # 远超阈值
        b1 = _bundle("s1", [_source("https://a.com", long_text)])
        extracted = "- 保留的萃取件"
        with patch.object(
            SynthesisCompressor, "_chat", new=AsyncMock(return_value=extracted)
        ):
            _, stats = asyncio.run(self._compressor().compress([b1], len(long_text)))
        assert stats.passthrough is False
        assert stats.extracted_count == 1
        assert stats.extraction_failures == 0
        assert b1["sources"][0]["summary"] == extracted

    def test_short_source_not_extracted(self):
        short = "s" * 1000  # 低于 2500 阈值
        b1 = _bundle("s1", [_source("https://a.com", short)])
        with patch.object(
            SynthesisCompressor, "_chat", new=AsyncMock(return_value="不该被调用")
        ):
            _, stats = asyncio.run(self._compressor().compress([b1], 300000))
        assert stats.extracted_count == 0
        assert b1["sources"][0]["summary"] == short

    def test_extraction_failure_falls_back_to_head(self):
        long_text = "头部内容。" + "x" * 5000
        b1 = _bundle("s1", [_source("https://a.com", long_text)])
        with patch.object(
            SynthesisCompressor,
            "_chat",
            new=AsyncMock(side_effect=RuntimeError("api down")),
        ):
            _, stats = asyncio.run(self._compressor().compress([b1], len(long_text)))
        assert stats.extraction_failures == 1
        # 兜底保留头部而非丢整篇
        assert b1["sources"][0]["summary"] == long_text[:2000]

    def test_empty_extraction_result_falls_back(self):
        long_text = "y" * 5000
        b1 = _bundle("s1", [_source("https://a.com", long_text)])
        with patch.object(
            SynthesisCompressor, "_chat", new=AsyncMock(return_value="   ")
        ):
            _, stats = asyncio.run(self._compressor().compress([b1], len(long_text)))
        assert stats.extraction_failures == 1
        assert b1["sources"][0]["summary"] == long_text[:2000]


class TestResolveLLM:
    def test_missing_credentials_returns_none(self, monkeypatch):
        monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("FAST_LLM", raising=False)
        monkeypatch.delenv("SMART_LLM", raising=False)

        class R:
            base_url = None
            api_key = None
            fast_llm = None

        assert resolve_extraction_llm(R()) is None

    def test_request_fields_win(self, monkeypatch):
        monkeypatch.setenv("OPENAI_BASE_URL", "http://env")
        monkeypatch.setenv("OPENAI_API_KEY", "env-key")
        monkeypatch.setenv("FAST_LLM", "env-model")

        class R:
            base_url = "http://req/"
            api_key = "req-key"
            fast_llm = "openai:req-model"

        base, key, model = resolve_extraction_llm(R())
        assert (base, key, model) == ("http://req", "req-key", "req-model")


def test_stats_event_shape():
    stats = CompressionStats(
        original_characters=100, deduped_characters=80, final_characters=30
    )
    data = stats.event_data()
    assert data["originalCharacters"] == 100
    assert data["duplicatesRemoved"] == 0
    assert data["passthrough"] is True
