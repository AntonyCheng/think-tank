from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlparse

from .research_profile import ResearchProfile


ReportEvidenceStrategy = Literal[
    "public_verified",
    "private_bounded",
    "mixed_evidence",
]

_HTTP_URL = re.compile(r"https?://[^\s)<]+", re.IGNORECASE)
_INTERNAL_DISCLOSURE = re.compile(
    r"(?:document:|127\.0\.0\.1|localhost|\.venv[\\/]|\bdoc_[a-z0-9]+\b)",
    re.IGNORECASE,
)
_RESTRICTED_EVIDENCE_TAG = "[[restricted-evidence]]"
_PRIVATE_EXTERNAL_POLICY_TERM = re.compile(
    r"\b(?:iso|soc|gdpr|hipaa|nist|ccpa|pci(?:[-\s]?dss)?)\b",
    re.IGNORECASE,
)
_PRIVATE_NUMBER_OR_DATE = re.compile(r"\b\d[\d,./:-]*\b|\d+\s*%")
_POLICY_INSTRUCTION = re.compile(
    r"(?:this report is based on restricted evidence only|"
    r"every non-heading report paragraph|<citation_contract>|</citation_contract>)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ReportEvidencePolicy:
    strategy: ReportEvidenceStrategy
    forbids_external_links: bool
    requires_public_citation_for_fact: bool
    allows_private_attribution: bool


def derive_report_evidence_policy(
    profile: ResearchProfile,
    upstream_evidence: list[dict[str, Any]] | None = None,
) -> ReportEvidencePolicy:
    if profile.mode == "synthesis":
        return _policy(_strategy_for_upstream(upstream_evidence or []))

    source = profile.source
    if source.mode == "local":
        return _policy("private_bounded")
    if source.mode == "hybrid":
        return _policy("mixed_evidence")
    return _policy("public_verified")


def render_citation_contract(policy: ReportEvidencePolicy) -> str:
    if policy.strategy == "private_bounded":
        return (
            "<citation_contract>\n"
            "This report is based on restricted evidence only. Use only facts "
            "explicitly present in the supplied research context. Do not add "
            "external policy names, numbers, dates, quotations, URLs, Markdown "
            "links, references, or a source list. If the materials do not support "
            "a conclusion, say that the restricted evidence is insufficient to "
            "confirm it. Do not reveal source locators, profile names, tool names, "
            "commands, paths, endpoints, or credentials. Every non-heading report "
            "paragraph that states a conclusion must end with the exact marker "
            "[[restricted-evidence]].\n"
            "</citation_contract>"
        )
    if policy.strategy == "mixed_evidence":
        return (
            "<citation_contract>\n"
            "Distinguish public and restricted evidence. A factual claim supported "
            "by public evidence must end with a Markdown source link using only a "
            "URL present in the research context. A claim supported only by "
            "restricted evidence must be explicitly labeled as based on restricted "
            "materials and must not contain a URL or source identifier. Never "
            "invent a source URL or reveal source locators, profile names, tool "
            "names, commands, paths, endpoints, or credentials. Do not add a "
            "references section. A conclusion based only on restricted evidence "
            "must end with the exact marker [[restricted-evidence]].\n"
            "</citation_contract>"
        )
    return (
        "<citation_contract>\n"
        "Every factual claim, number, percentage, date, price, benchmark, or "
        "quote must end with a Markdown source link in the form "
        "[source title](https://source-url). Use only URLs present in the research "
        "context. Preserve these links in the report. Do not add a references "
        "section because the platform builds it from verified links. Never invent "
        "a source URL.\n"
        "</citation_contract>"
    )


def enforce_report_evidence_policy(
    report: str,
    policy: ReportEvidencePolicy,
    source_urls: list[str],
    sources: list[Any],
    upstream_evidence: list[dict[str, Any]] | None = None,
    restricted_document_texts: list[str] | None = None,
) -> tuple[str, int]:
    policy_sources = _policy_sources(sources, upstream_evidence)
    allowed_urls = _allowed_urls(source_urls, policy_sources)
    if restricted_document_texts and policy.strategy in {
        "private_bounded",
        "mixed_evidence",
    }:
        return _bounded_document_report(
            policy,
            restricted_document_texts,
            list(allowed_urls),
        ), len(report.splitlines())
    if policy.strategy in {"private_bounded", "mixed_evidence"}:
        upstream_document_texts = _upstream_document_texts(
            upstream_evidence or []
        )
        if upstream_document_texts:
            return _bounded_document_report(
                policy,
                upstream_document_texts,
                list(allowed_urls),
            ), len(report.splitlines())

    if (
        policy.strategy == "private_bounded"
        and policy_sources
        and not _has_actionable_restricted_evidence(policy_sources)
    ):
        return _restricted_evidence_brief(), len(report.splitlines())

    kept: list[str] = []
    removed = 0
    for line in report.splitlines():
        urls = [
            _canonical_http_url(match.group(0))
            for match in _HTTP_URL.finditer(line)
        ]
        has_internal_disclosure = bool(_INTERNAL_DISCLOSURE.search(line))
        if policy.strategy == "private_bounded" and _POLICY_INSTRUCTION.search(line):
            removed += 1
            continue
        if policy.forbids_external_links and (urls or has_internal_disclosure):
            removed += 1
            continue
        if (
            policy.strategy == "private_bounded"
            and (
                _PRIVATE_EXTERNAL_POLICY_TERM.search(line)
                or _PRIVATE_NUMBER_OR_DATE.search(line)
            )
        ):
            removed += 1
            continue
        if (
            policy.strategy == "private_bounded"
            and _is_body_line(line)
            and _RESTRICTED_EVIDENCE_TAG not in line
        ):
            removed += 1
            continue
        if (
            not policy.forbids_external_links
            and urls
            and any(url not in allowed_urls for url in urls)
        ):
            removed += 1
            continue
        kept.append(_render_restricted_attribution(line))

    normalized = "\n".join(kept).strip()
    if policy.strategy == "private_bounded" and not _has_body_content(normalized):
        normalized = _restricted_evidence_brief()
    return normalized, removed


def _policy(strategy: ReportEvidenceStrategy) -> ReportEvidencePolicy:
    return ReportEvidencePolicy(
        strategy=strategy,
        forbids_external_links=strategy == "private_bounded",
        requires_public_citation_for_fact=strategy != "private_bounded",
        allows_private_attribution=strategy != "public_verified",
    )


def _strategy_for_upstream(
    upstream_evidence: list[dict[str, Any]],
) -> ReportEvidenceStrategy:
    has_private = False
    has_public = False
    for bundle in upstream_evidence:
        sources = bundle.get("sources") if isinstance(bundle, dict) else None
        if not isinstance(sources, list):
            continue
        for source in sources:
            if not isinstance(source, dict):
                continue
            if source.get("visibility") == "private":
                has_private = True
            elif source.get("visibility") == "public":
                has_public = True
    if has_private and has_public:
        return "mixed_evidence"
    if has_private:
        return "private_bounded"
    return "public_verified"


def _allowed_urls(source_urls: list[str], sources: list[Any]) -> set[str]:
    values = list(source_urls)
    for source in sources:
        if not isinstance(source, dict):
            continue
        values.extend(
            str(source[key])
            for key in ("url", "href", "link")
            if source.get(key)
        )
    return {
        canonical
        for value in values
        if (canonical := _canonical_http_url(value))
    }


def _policy_sources(
    sources: list[Any],
    upstream_evidence: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    values = [source for source in sources if isinstance(source, dict)]
    for bundle in upstream_evidence or []:
        if not isinstance(bundle, dict):
            continue
        values.extend(
            source
            for source in bundle.get("sources", [])
            if isinstance(source, dict)
        )
    return values


def _canonical_http_url(value: str) -> str:
    try:
        parsed = urlparse(value.rstrip(".,;:!?"))
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return parsed._replace(fragment="").geturl()


def _has_body_content(report: str) -> bool:
    return any(
        line.strip() and not line.lstrip().startswith("#")
        for line in report.splitlines()
    )


def _is_body_line(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and not stripped.startswith("#")


def _render_restricted_attribution(line: str) -> str:
    if _RESTRICTED_EVIDENCE_TAG not in line:
        return line
    return line.replace(
        _RESTRICTED_EVIDENCE_TAG,
        "(based on restricted materials)",
    )


def _has_actionable_restricted_evidence(sources: list[Any]) -> bool:
    summaries = [
        str(source.get("summary", "")).strip()
        for source in sources
        if isinstance(source, dict)
    ]
    if not summaries:
        return False
    return any(
        summary and not _is_query_echo_summary(summary)
        for summary in summaries
    )


def _is_query_echo_summary(summary: str) -> bool:
    try:
        value = json.loads(summary)
    except (TypeError, ValueError):
        value = None
    if isinstance(value, list):
        texts = [
            str(item.get("text", "")).strip()
            for item in value
            if isinstance(item, dict)
        ]
        return bool(texts) and all(
            text.startswith("Managed policy evidence for:")
            for text in texts
        )
    return summary.startswith("Managed policy evidence for:")


def _restricted_evidence_brief() -> str:
    return (
        "# Research brief\n\n"
        "The restricted materials available for this research do not provide "
        "enough detail to confirm specific factual conclusions."
    )


def _restricted_document_brief(document_texts: list[str]) -> str:
    statements: list[str] = []
    for document_text in document_texts:
        for candidate in _restricted_document_statements(document_text):
            if candidate not in statements:
                statements.append(candidate)

    if not statements:
        return _restricted_evidence_brief()

    rendered = "\n".join(
        f"- {statement} (based on restricted materials)"
        for statement in statements[:12]
    )
    return (
        "# Research brief\n\n"
        "## Source-backed findings\n\n"
        f"{rendered}"
    )


def _bounded_document_report(
    policy: ReportEvidencePolicy,
    document_texts: list[str],
    source_urls: list[str],
) -> str:
    report = _restricted_document_brief(document_texts)
    if policy.strategy != "mixed_evidence":
        return report

    public_urls = sorted(_allowed_urls(source_urls, []))[:8]
    if not public_urls:
        return report
    public_links = "\n".join(
        f"- [Verified public source]({url})"
        for url in public_urls
    )
    return f"{report}\n\n## Public evidence available for verification\n\n{public_links}"


def _restricted_document_statements(document_text: str) -> list[str]:
    values: list[str] = []
    for line in document_text.splitlines():
        candidate = " ".join(line.split()).strip(" -\t")
        candidate = candidate.removesuffix("(based on restricted materials)").strip()
        if not candidate or candidate.startswith("#") or len(candidate) < 24:
            continue
        if (
            _HTTP_URL.search(candidate)
            or _INTERNAL_DISCLOSURE.search(candidate)
            or _PRIVATE_EXTERNAL_POLICY_TERM.search(candidate)
            or _PRIVATE_NUMBER_OR_DATE.search(candidate)
        ):
            continue
        values.append(candidate)
    return values


def _upstream_document_texts(
    upstream_evidence: list[dict[str, Any]],
) -> list[str]:
    values: list[str] = []
    for bundle in upstream_evidence:
        if not isinstance(bundle, dict):
            continue
        sources = bundle.get("sources")
        has_document_source = isinstance(sources, list) and any(
            isinstance(source, dict)
            and source.get("visibility") == "private"
            and source.get("sourceType") == "document"
            for source in sources
        )
        if not has_document_source:
            continue
        report = bundle.get("report")
        content = report.get("content") if isinstance(report, dict) else None
        if isinstance(content, str):
            values.append(content)
    return values
