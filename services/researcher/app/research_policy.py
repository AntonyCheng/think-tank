from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from typing import Any

from .contracts import ResearchRequest
from .research_profile import (
    DeepResearchCapabilityLimits,
    ResearchCapabilities,
    ResearchProfile,
    ResearchProfileDefaults,
    ResearchProfileError,
    ResearchRetriever,
    resolve_research_profile,
)
from .retriever_runtime import build_retriever_catalog


def current_research_environment(
    retriever: ResearchRetriever | tuple[ResearchRetriever, ...],
    *,
    max_retrievers: int | None = None,
) -> tuple[ResearchProfileDefaults, ResearchCapabilities]:
    retrievers = (
        (retriever,)
        if isinstance(retriever, str)
        else tuple(retriever)
    )
    if not retrievers:
        raise ValueError("At least one research retriever must be available.")
    return (
        ResearchProfileDefaults(
            default_retriever=retrievers[0],
            default_retrievers=retrievers,
        ),
        ResearchCapabilities(
            modes=("standard", "deep", "synthesis"),
            source_modes=(
                "web",
                "urls",
                "local",
                "hybrid",
            ),
            url_source_modes=("standard",),
            domain_filter_modes=("standard",),
            retrievers=retrievers,
            max_retrievers=min(
                max_retrievers or len(retrievers),
                len(retrievers),
            ),
            source_curation=True,
            domain_filters=True,
            deep_research=DeepResearchCapabilityLimits(
                max_breadth=_positive_integer_environment(
                    "GPTR_DEEP_MAX_BREADTH",
                    4,
                ),
                max_depth=_positive_integer_environment(
                    "GPTR_DEEP_MAX_DEPTH",
                    3,
                ),
                max_research_calls=_positive_integer_environment(
                    "GPTR_DEEP_MAX_RESEARCH_CALLS",
                    32,
                ),
            ),
        ),
    )


def resolve_request_research_profile(
    request: ResearchRequest,
    environment: Mapping[str, str] | None = None,
    *,
    adapter_loader: Callable[[str], object | None] | None = None,
) -> ResearchProfile:
    catalog = build_retriever_catalog(
        os.environ if environment is None else environment,
        adapter_loader=adapter_loader,
    )
    available_retrievers = tuple(
        item.id for item in catalog.retrievers
    )
    if not available_retrievers:
        raise ValueError(
            "No configured GPTR retriever is ready for research."
        )
    defaults, capabilities = current_research_environment(
        available_retrievers,
        max_retrievers=catalog.max_retrievers,
    )
    try:
        return resolve_research_profile(
            request.research_profile,
            defaults,
            capabilities,
        )
    except ResearchProfileError as exc:
        raise ResearchProfileError(
            exc.code,
            _rebase_profile_path(exc.path),
            str(exc),
        ) from exc


def research_profile_error_detail(
    error: ResearchProfileError,
) -> dict[str, Any]:
    return {
        "code": error.code,
        "path": error.path,
        "message": str(error),
    }


def _rebase_profile_path(path: str) -> str:
    if path == "$":
        return "$.researchProfile"
    return f"$.researchProfile{path[1:]}"


def _positive_integer_environment(name: str, fallback: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None or not raw_value.strip():
        return fallback
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value
