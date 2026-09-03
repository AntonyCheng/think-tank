import json
from pathlib import Path

import pytest

from app.report_evidence_policy import (
    _REDACTED_MARKER,
    derive_report_evidence_policy,
    enforce_report_evidence_policy,
    render_citation_contract,
)
from app.research_profile import ResearchProfile


FIXTURE_PATH = (
    Path(__file__).parents[3]
    / "contracts"
    / "report-evidence-policy"
    / "v1"
    / "cases.json"
)
POLICY_FIXTURES = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["cases"]


def profile(source: dict) -> ResearchProfile:
    return ResearchProfile.model_validate({
        "schemaVersion": 1,
        "mode": "standard",
        "source": source,
        "quality": {"curateSources": True},
        "limits": {
            "maxSearchResultsPerQuery": 5,
            "maxIterations": 3,
            "maxSubtopics": 3,
        },
    })


@pytest.mark.parametrize(
    "case",
    POLICY_FIXTURES,
    ids=lambda case: f"ReportEvidencePolicy: {case['name']}",
)
def test_report_evidence_policy_contract(case: dict) -> None:
    fixture_profile = case["profile"]
    resolved_profile = ResearchProfile.model_validate({
        "schemaVersion": 1,
        "mode": fixture_profile["mode"],
        "source": fixture_profile["source"],
        "quality": {"curateSources": False}
        if fixture_profile["mode"] == "synthesis"
        else {"curateSources": True},
        "limits": {
            "maxSearchResultsPerQuery": 5,
            "maxIterations": 3,
            "maxSubtopics": 3,
        },
    })
    result = derive_report_evidence_policy(
        resolved_profile,
        case.get("upstreamEvidence"),
    )

    assert result.strategy == case["expectedStrategy"]


def test_private_policy_replaces_link_only_report_with_safe_brief() -> None:
    policy = derive_report_evidence_policy(profile({
        "mode": "local",
        "documentIds": ["document-1"],
    }))
    report, removed = enforce_report_evidence_policy(
        "# Report\n\nFake [link](https://unknown.example/policy)",
        policy,
        [],
        [],
    )

    assert "unknown.example" not in report
    assert "restricted materials" in report
    assert removed == 1


def test_private_policy_removes_untagged_claims() -> None:
    policy = derive_report_evidence_policy(profile({
        "mode": "local",
        "documentIds": ["document-1"],
    }))
    report, removed = enforce_report_evidence_policy(
        "# Report\n\nThe policy requires a 99% threshold.",
        policy,
        [],
        [],
    )

    assert "99%" not in report
    assert "restricted materials" in report
    assert removed == 1


def test_private_policy_renders_a_safe_restricted_attribution() -> None:
    policy = derive_report_evidence_policy(profile({
        "mode": "local",
        "documentIds": ["document-1"],
    }))
    report, removed = enforce_report_evidence_policy(
        "# Report\n\nThe document supports a phased rollout. "
        "[[restricted-evidence]]",
        policy,
        [],
        [],
    )

    assert "restricted-evidence" not in report
    assert "based on restricted materials" in report
    assert removed == 0


def test_private_local_document_keeps_the_models_tagged_conclusions() -> None:
    policy = derive_report_evidence_policy(profile({
        "mode": "local",
        "documentIds": ["document-1"],
    }))
    report, removed = enforce_report_evidence_policy(
        "# Analysis\n\n"
        "Segment revenue climbed 18% year over year. [[restricted-evidence]]\n"
        "This sentence is an untagged aside.",
        policy,
        [],
        [],
        restricted_document_texts=[
            "Segment revenue was 4.2 billion, up from 3.6 billion."
        ],
    )

    assert "Segment revenue climbed" in report
    assert "18%" not in report
    assert _REDACTED_MARKER in report
    assert "based on restricted materials" in report
    assert "untagged aside" not in report
    assert removed == 1


def test_private_local_document_falls_back_to_document_lines_when_nothing_is_tagged() -> None:
    policy = derive_report_evidence_policy(profile({
        "mode": "local",
        "documentIds": ["document-1"],
    }))
    report, _ = enforce_report_evidence_policy(
        "# Draft\n\nEvery line here is untagged speculation with no marker.",
        policy,
        [],
        [],
        restricted_document_texts=[
            "The internal security review must finish before the 2026 launch window.\n"
            "Use https://internal.example only for operations."
        ],
    )

    assert "internal security review" in report
    assert "2026" not in report
    assert _REDACTED_MARKER in report
    assert "internal.example" not in report
    assert "speculation" not in report


def test_private_synthesis_keeps_tagged_conclusions_from_the_synthesis_draft() -> None:
    synthesis = ResearchProfile.model_validate({
        "schemaVersion": 1,
        "mode": "synthesis",
        "source": {"mode": "urls", "urls": ["https://example.com"]},
        "quality": {"curateSources": False},
        "limits": {
            "maxSearchResultsPerQuery": 5,
            "maxIterations": 3,
            "maxSubtopics": 3,
        },
    })
    upstream = [{
        "sources": [{
            "visibility": "private",
            "sourceType": "document",
            "locator": "document:doc_private",
            "title": "本地文档",
            "summary": (
                "The service must complete a security review before deployment."
            ),
        }],
        "report": {
            "content": (
                "# Research brief\n\n"
                "- The service must complete a security review before deployment. "
                "(based on restricted materials)"
            ),
        },
    }]
    policy = derive_report_evidence_policy(synthesis, upstream)
    report, _ = enforce_report_evidence_policy(
        "# Synthesis\n\n"
        "The restricted evidence supports a phased rollout. [[restricted-evidence]]\n"
        "An unfounded aside with no marker.",
        policy,
        [],
        [],
        upstream,
    )

    assert policy.strategy == "private_bounded"
    assert "phased rollout" in report
    assert "unfounded aside" not in report
    assert "doc_private" not in report


def test_mixed_local_document_keeps_private_findings_separate_from_public_links() -> None:
    policy = derive_report_evidence_policy(profile({
        "mode": "hybrid",
        "documentIds": ["document-1"],
        "urls": ["https://known.example/public"],
    }))
    report, _ = enforce_report_evidence_policy(
        "# Draft\n\nAn invented public claim is true. "
        "[[restricted-evidence]]",
        policy,
        ["https://known.example/public"],
        [],
        restricted_document_texts=[
            "The service must restrict access to authorized personnel."
        ],
    )

    assert "restrict access to authorized personnel" in report
    assert "invented public claim" not in report
    assert "based on restricted materials" in report
    assert "https://known.example/public" in report


def test_mixed_synthesis_uses_public_urls_from_upstream_evidence() -> None:
    synthesis = ResearchProfile.model_validate({
        "schemaVersion": 1,
        "mode": "synthesis",
        "source": {"mode": "urls", "urls": ["https://example.com"]},
        "quality": {"curateSources": False},
        "limits": {"maxSearchResultsPerQuery": 5, "maxIterations": 3, "maxSubtopics": 3},
    })
    upstream = [{
        "sources": [
            {"visibility": "private", "sourceType": "document", "locator": "document:doc_private", "title": "Local"},
            {"visibility": "public", "url": "https://known.example/public", "title": "Public"},
        ],
        "report": {"content": "- The service must retain an audit record. (based on restricted materials)"},
    }]
    report, _ = enforce_report_evidence_policy(
        "# Draft", derive_report_evidence_policy(synthesis, upstream), [], [], upstream
    )

    assert "https://known.example/public" in report


def test_private_policy_redacts_policy_terms_and_dates_in_tagged_conclusions() -> None:
    policy = derive_report_evidence_policy(profile({
        "mode": "local",
        "documentIds": ["document-1"],
    }))
    report, removed = enforce_report_evidence_policy(
        "# Heading\n\n"
        "The rollout tracks SOC 2 and starts 2026-01-01. [[restricted-evidence]]\n"
        "An ISO 27001 mandate with no marker applies.",
        policy,
        [],
        [],
    )

    assert "SOC" not in report
    assert "ISO" not in report
    assert "2026" not in report
    assert "The rollout tracks" in report
    assert _REDACTED_MARKER in report
    assert "restricted materials" in report
    assert "mandate with no marker" not in report
    assert removed == 1


def test_private_policy_drops_repeated_citation_contract() -> None:
    policy = derive_report_evidence_policy(profile({
        "mode": "local",
        "documentIds": ["document-1"],
    }))
    report, removed = enforce_report_evidence_policy(
        "# Report\n\n"
        "This report is based on restricted evidence only. Every non-heading "
        "report paragraph must end with [[restricted-evidence]].",
        policy,
        [],
        [],
    )

    assert report.startswith("# Research brief")
    assert "Every non-heading" not in report
    assert removed == 1


"""def test_private_policy_uses_safe_brief_for_query_echo_only_mcp_evidence() -> None:
    policy = derive_report_evidence_policy(profile({
        "mode": "mcp",
        "mcpProfileIds": ["policy"],
    }))
    report, removed = enforce_report_evidence_policy(
        "# Report\n\nThe policy requires audit controls. [[restricted-evidence]]",
        policy,
        [],
        [{
            "summary": (
                '[{"text":"Managed policy evidence for: audit controls",'
                '"type":"text"}]'
            ),
        }],
    )

    assert report.startswith("# Research brief")
    assert "audit controls" not in report
    assert removed == 3
"""


def test_private_synthesis_uses_upstream_mcp_evidence_for_safe_fallback() -> None:
    policy = ResearchProfile.model_validate({
        "schemaVersion": 1,
        "mode": "synthesis",
        "source": {"mode": "urls", "urls": ["https://example.com"]},
        "quality": {"curateSources": False},
        "limits": {
            "maxSearchResultsPerQuery": 5,
            "maxIterations": 3,
            "maxSubtopics": 3,
        },
    })
    report_policy = derive_report_evidence_policy(
        policy,
        [{
            "sources": [{
                "visibility": "private",
                "summary": (
                    '[{"text":"Managed policy evidence for: policy controls",'
                    '"type":"text"}]'
                ),
            }],
        }],
    )
    report, removed = enforce_report_evidence_policy(
        "# Summary\n\nA policy requires mandatory controls. "
        "[[restricted-evidence]]",
        report_policy,
        [],
        [],
        [{
            "sources": [{
                "visibility": "private",
                "summary": (
                    '[{"text":"Managed policy evidence for: policy controls",'
                    '"type":"text"}]'
                ),
            }],
        }],
    )

    assert report_policy.strategy == "private_bounded"
    assert report.startswith("# Research brief")
    assert "mandatory controls" not in report
    assert removed == 3
