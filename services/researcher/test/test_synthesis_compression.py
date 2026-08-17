"""Tests for report-first synthesis context preparation."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from app.synthesis_compression import (
    CompressionStats,
    SynthesisCompressor,
    clear_synthesis_compression_cache,
    dedupe_sources,
    estimate_original_characters,
    estimate_report_characters,
    resolve_extraction_llm,
    resolve_synthesis_context_budget,
)


def _bundle(step: str, report: str, sources: list[dict] | None = None) -> dict:
    return {
        "aoStepId": step,
        "report": {"content": report},
        "sources": sources or [],
    }


def _source(url: str, summary: str, title: str = "Source") -> dict:
    return {
        "visibility": "public",
        "url": url,
        "title": title,
        "summary": summary,
    }


class TestEvidenceCompatibility:
    def test_cross_bundle_duplicate_summary_removed(self):
        b1 = _bundle("s1", "report", [_source("https://a.com/doc", "x" * 500)])
        b2 = _bundle("s2", "report", [_source("https://a.com/doc", "x" * 500)])

        _, total, removed = dedupe_sources([b1, b2])

        assert removed == 1
        assert total == 500
        assert b1["sources"][0]["summary"] == "x" * 500
        assert b2["sources"][0]["summary"] is None

    def test_report_and_source_character_counters_are_separate(self):
        bundle = _bundle("s1", "report" * 100, [_source("https://a.com", "x" * 500)])

        assert estimate_report_characters([bundle]) == len("report" * 100)
        assert estimate_original_characters([bundle]) == 500


class TestReportRouting:
    def _compressor(self, **kwargs):
        return SynthesisCompressor(
            "http://llm",
            "key",
            "openai:fast-model",
            route_threshold=1_000,
            report_chunk_chars=300,
            report_brief_target=240,
            **kwargs,
        )

    def _single_chunk_compressor(self, **kwargs):
        return SynthesisCompressor(
            "http://llm",
            "key",
            "openai:fast-model",
            route_threshold=1_000,
            report_chunk_chars=10_000,
            report_brief_target=1_000,
            **kwargs,
        )

    def test_reports_below_budget_pass_through_unchanged(self):
        bundle = _bundle("market", "# Market\n\nVerified finding.")

        output, stats = asyncio.run(
            self._compressor().compress_reports([bundle], len(bundle["report"]["content"]))
        )

        assert stats.passthrough is True
        assert stats.strategy == "full_reports"
        assert output[0]["report"]["content"] == "# Market\n\nVerified finding."

    def test_large_reports_are_replaced_with_temporary_briefs(self):
        report = "# Market\n\n" + ("Verified fact [source](https://example.com/data). " * 100)
        bundle = _bundle("market", report)
        brief = "# Market brief\n\nVerified fact [source](https://example.com/data)."

        with patch.object(SynthesisCompressor, "_chat", new=AsyncMock(return_value=brief)):
            output, stats = asyncio.run(
                self._compressor().compress_reports([bundle], len(report))
            )

        assert stats.passthrough is False
        assert stats.strategy == "hierarchical_report_briefs"
        assert stats.compressed_report_count == 1
        assert stats.extraction_failures == 0
        assert output[0]["report"]["content"] == brief

    def test_compression_failure_keeps_a_traceable_fallback(self):
        clear_synthesis_compression_cache()
        report = "# Market\n\n" + ("Verified fact [source](https://example.com/data). " * 100)
        bundle = _bundle("market", report)

        with patch.object(
            SynthesisCompressor,
            "_chat",
            new=AsyncMock(side_effect=RuntimeError("provider unavailable")),
        ):
            output, stats = asyncio.run(
                self._compressor().compress_reports([bundle], len(report))
            )

        fallback = output[0]["report"]["content"]
        assert stats.extraction_failures == 1
        assert "compression degraded" in fallback
        assert "https://example.com/data" in fallback
        assert len(fallback) <= 1_000

    def test_retries_temporary_compression_with_fallback_provider(self):
        clear_synthesis_compression_cache()
        report = "# Market\n\n" + ("Verified fact. " * 100)
        bundle = _bundle("market", report)
        compressor = SynthesisCompressor(
            "http://primary",
            "primary-key",
            "primary-model",
            fallback_base_url="http://fallback",
            fallback_api_key="fallback-key",
            fallback_model="fallback-model",
            route_threshold=1_000,
            report_chunk_chars=10_000,
            report_brief_target=1_000,
        )

        with patch.object(
            compressor,
            "_chat_with_provider",
            new=AsyncMock(side_effect=[RuntimeError("provider timeout"), "# Brief\n\nVerified fact."]),
        ):
            output, stats = asyncio.run(
                compressor.compress_reports([bundle], len(report))
            )

        assert output[0]["report"]["content"] == "# Brief\n\nVerified fact."
        assert stats.fallback_attempt_count == 1
        assert stats.fallback_success_count == 1
        assert stats.fallback_failure_count == 0

    def test_does_not_fallback_for_configuration_error(self):
        clear_synthesis_compression_cache()
        report = "# Market\n\n" + ("Verified fact. " * 100)
        bundle = _bundle("market", report)
        compressor = SynthesisCompressor(
            "http://primary",
            "primary-key",
            "primary-model",
            fallback_base_url="http://fallback",
            fallback_api_key="fallback-key",
            fallback_model="fallback-model",
            route_threshold=1_000,
            report_chunk_chars=10_000,
            report_brief_target=1_000,
        )

        with patch.object(
            compressor,
            "_chat_with_provider",
            new=AsyncMock(side_effect=RuntimeError("HTTP 401")),
        ):
            _, stats = asyncio.run(
                compressor.compress_reports([bundle], len(report))
            )

        assert stats.extraction_failures == 1
        assert stats.fallback_attempt_count == 0

    def test_reuses_identical_successful_report_brief_from_lru_cache(self):
        clear_synthesis_compression_cache()
        report = "# Market\n\n" + ("Verified fact. " * 100)
        brief = "# Brief\n\nVerified fact."
        first = _bundle("market", report)
        second = _bundle("market-copy", report)

        with patch.object(SynthesisCompressor, "_chat", new=AsyncMock(return_value=brief)):
            _, first_stats = asyncio.run(
                self._single_chunk_compressor().compress_reports([first], len(report))
            )
        with patch.object(
            SynthesisCompressor,
            "_chat",
            new=AsyncMock(side_effect=AssertionError("cache should avoid LLM call")),
        ):
            output, second_stats = asyncio.run(
                self._single_chunk_compressor().compress_reports([second], len(report))
            )

        assert first_stats.cache_miss_count == 1
        assert second_stats.cache_hit_count == 1
        assert output[0]["report"]["content"] == brief

    def test_degraded_fallback_brief_is_not_cached(self):
        clear_synthesis_compression_cache()
        report = "# Market\n\n" + ("Verified fact. " * 100)
        first = _bundle("market", report)
        second = _bundle("market-copy", report)

        with patch.object(
            SynthesisCompressor,
            "_chat",
            new=AsyncMock(side_effect=RuntimeError("provider unavailable")),
        ):
            _, first_stats = asyncio.run(
                self._single_chunk_compressor().compress_reports([first], len(report))
            )
        with patch.object(SynthesisCompressor, "_chat", new=AsyncMock(return_value="# Brief")):
            _, second_stats = asyncio.run(
                self._single_chunk_compressor().compress_reports([second], len(report))
            )

        assert first_stats.extraction_failures == 1
        assert second_stats.cache_hit_count == 0
        assert second_stats.cache_miss_count == 1


class TestSynthesisContextBudget:
    def test_derives_budget_from_model_context_window(self):
        budget = resolve_synthesis_context_budget({
            "SYNTHESIS_CONTEXT_WINDOW_TOKENS": "128000",
            "SYNTHESIS_CONTEXT_INPUT_RATIO": "0.75",
            "SYNTHESIS_OUTPUT_RESERVE_TOKENS": "16000",
            "SYNTHESIS_CHARS_PER_TOKEN": "4",
            "SYNTHESIS_REPORT_CONTEXT_BUDGET_CHARS": "120000",
        })

        assert budget == 336_000

    def test_uses_legacy_character_budget_without_context_window(self):
        assert resolve_synthesis_context_budget({
            "SYNTHESIS_REPORT_CONTEXT_BUDGET_CHARS": "180000",
            "SYNTHESIS_ROUTE_THRESHOLD_CHARS": "120000",
        }) == 180_000

    def test_uses_oldest_route_threshold_as_legacy_fallback(self):
        assert resolve_synthesis_context_budget({
            "SYNTHESIS_ROUTE_THRESHOLD_CHARS": "90000",
        }) == 90_000


def test_stats_event_shape_includes_report_diagnostics():
    stats = CompressionStats(
        original_characters=100,
        final_characters=80,
        original_report_characters=100,
        final_report_characters=80,
        compressed_report_count=2,
        strategy="hierarchical_report_briefs",
    )

    data = stats.event_data()

    assert data["originalCharacters"] == 100
    assert data["originalReportCharacters"] == 100
    assert data["compressedReports"] == 2
    assert data["strategy"] == "hierarchical_report_briefs"


class TestResolveLLM:
    def test_missing_credentials_returns_none(self, monkeypatch):
        monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("FAST_LLM", raising=False)
        monkeypatch.delenv("SMART_LLM", raising=False)

        class Request:
            base_url = None
            api_key = None
            fast_llm = None

        assert resolve_extraction_llm(Request()) is None

    def test_request_fields_win(self, monkeypatch):
        monkeypatch.setenv("OPENAI_BASE_URL", "http://env")
        monkeypatch.setenv("OPENAI_API_KEY", "env-key")
        monkeypatch.setenv("FAST_LLM", "env-model")

        class Request:
            base_url = "http://request/"
            api_key = "request-key"
            fast_llm = "openai:request-model"

        assert resolve_extraction_llm(Request()) == (
            "http://request",
            "request-key",
            "request-model",
        )
