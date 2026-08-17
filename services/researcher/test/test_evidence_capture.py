from __future__ import annotations

from types import SimpleNamespace

from app.contracts import ResearchEvent
from app.evidence_capture import (
    capture_research_evidence,
    render_synthesis_context,
)


class FakeResearcher:
    cfg = SimpleNamespace(scraper="beautiful_soup")

    def get_source_urls(self) -> list[str]:
        return [
            "https://example.com/report#section",
            "https://example.com/fallback",
        ]

    def get_research_sources(self) -> list[dict[str, str]]:
        return [
            {
                "url": "https://example.com/report#section",
                "title": "行业报告",
                "raw_content": " 可验证的行业数据 " * 200,
            },
        ]

    def get_research_context(self) -> list[str]:
        return ["第一段上下文", "第二段上下文"]


def test_captures_standard_gptr_evidence_through_public_methods() -> None:
    events = [
        ResearchEvent(
            timestamp="2026-07-29T10:01:00Z",
            type="logs",
            data={
                "content": "subqueries",
                "output": [
                    "2026 AI 市场规模",
                    "2026 AI 市场规模",
                    "AI 监管政策",
                ],
            },
        ),
    ]

    evidence = capture_research_evidence(
        FakeResearcher(),
        events,
        mode="standard",
    )

    assert evidence.model_dump(by_alias=True) == {
        "queries": [
            {"kind": "subquery", "text": "2026 AI 市场规模"},
            {"kind": "subquery", "text": "AI 监管政策"},
        ],
        "sources": [
            {
                "visibility": "public",
                    "url": "https://example.com/report",
                    "title": "行业报告",
                    "sourceType": "web",
                    "summary": ("可验证的行业数据 " * 200).strip(),
            },
            {
                "visibility": "public",
                    "url": "https://example.com/fallback",
                    "title": "example.com",
                    "sourceType": "web",
                    "summary": None,
            },
        ],
        "researchContext": {
            "content": "第一段上下文\n\n第二段上下文",
            "originalCharacters": 14,
            "truncated": False,
        },
        "scraper": "beautiful_soup",
    }


def test_synthesis_context_avoids_duplicate_raw_context_when_report_exists() -> None:
    context = render_synthesis_context(
        "Write a concise synthesis.",
        [{
            "aoStepId": "market",
            "report": {"content": "# Market\n" + "evidence " * 50},
            "sources": [{
                "visibility": "public",
                "url": "https://example.com/source",
                "title": "Source",
                "summary": "verified source",
            }],
            "researchContext": {"content": "RAW-CONTEXT-MUST-NOT-APPEAR"},
        }],
    )

    assert "# Market" in context
    assert "https://example.com/source" in context
    assert "verified source" not in context
    assert "RAW-CONTEXT-MUST-NOT-APPEAR" not in context


def test_synthesis_context_uses_a_deduplicated_source_directory() -> None:
    context = render_synthesis_context(
        "Combine the expert reports.",
        [
            {
                "aoStepId": "market",
                "report": {"content": "# Market\n\nFinding A."},
                "claimCitations": [{
                    "claim": "Finding A is supported by the shared source.",
                    "sourceIds": ["source-market-1"],
                }],
                "sources": [{
                    "id": "source-market-1",
                    "visibility": "public",
                    "url": "https://example.com/source",
                    "title": "Shared source",
                    "summary": "Large raw page text must not be repeated.",
                }],
            },
            {
                "aoStepId": "policy",
                "report": {"content": "# Policy\n\nFinding B."},
                "sources": [{
                    "visibility": "public",
                    "url": "https://example.com/source#duplicate",
                    "title": "Shared source copy",
                    "summary": "Another raw page copy.",
                }],
            },
        ],
    )

    assert "<upstream_expert_reports>" in context
    assert "<source_directory>" in context
    assert context.count("https://example.com/source") == 1
    assert "source-market-1" in context
    assert "Verified claim-source bindings" in context
    assert "Large raw page text" not in context
    assert "Another raw page copy" not in context


def test_synthesis_context_hides_private_source_locator() -> None:
    context = render_synthesis_context(
        "Write a concise synthesis.",
        [{
            "aoStepId": "restricted",
            "report": {"content": "# Brief\n\nSource-backed finding."},
            "sources": [{
                "visibility": "private",
                "locator": "document:doc_private_123",
                "title": "Local document",
                "summary": "Restricted material was parsed.",
            }],
        }],
    )

    assert "Restricted source: Local document" in context
    assert "document:doc_private_123" not in context
