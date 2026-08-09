from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.contracts import ResearchRequest
from app.research_profile import (
    ResearchCapabilities,
    ResearchProfileDefaults,
    ResearchProfileError,
    resolve_research_profile,
)
from app.research_policy import (
    current_research_environment,
    resolve_request_research_profile,
)


FIXTURE_PATH = (
    Path(__file__).parents[3]
    / "contracts"
    / "research-profile"
    / "v1"
    / "cases.json"
)
FIXTURES = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "case",
    FIXTURES["cases"],
    ids=lambda case: f"ResearchProfile: {case['name']}",
)
def test_research_profile_contract(case: dict[str, Any]) -> None:
    environment = FIXTURES["environments"][case["environment"]]
    defaults = ResearchProfileDefaults.model_validate(environment["defaults"])
    capabilities = ResearchCapabilities.model_validate(
        environment["capabilities"]
    )

    if "expected" in case:
        result = resolve_research_profile(
            case["input"],
            defaults,
            capabilities,
        )
        assert result.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ) == case["expected"]
        with pytest.raises(ValidationError):
            result.mode = "deep"
        assert_no_mutable_lists(result)
        return

    with pytest.raises(ResearchProfileError) as captured:
        resolve_research_profile(case["input"], defaults, capabilities)
    assert captured.value.code == case["error"]["code"]
    assert captured.value.path == case["error"]["path"]


def assert_no_mutable_lists(value: Any) -> None:
    if isinstance(value, list):
        pytest.fail("resolved ResearchProfile contains a mutable list")
    if hasattr(value.__class__, "model_fields"):
        for field_name in value.__class__.model_fields:
            assert_no_mutable_lists(getattr(value, field_name))
    elif isinstance(value, (tuple, frozenset)):
        for child in value:
            assert_no_mutable_lists(child)


def test_current_environment_accepts_standard_url_sources() -> None:
    defaults, capabilities = current_research_environment("duckduckgo")

    result = resolve_research_profile(
        {
            "source": {
                "mode": "urls",
                "urls": ["https://example.com/report"],
                "web": {
                    "retrievers": ["duckduckgo"],
                    "includeDomains": ["example.com"],
                },
            },
        },
        defaults,
        capabilities,
    )

    assert result.source.mode == "urls"
    assert capabilities.source_modes == ("web", "urls", "local", "hybrid")
    assert capabilities.domain_filters is True


def test_current_environment_exposes_ready_multi_retriever_set() -> None:
    defaults, capabilities = current_research_environment(
        ("duckduckgo", "openalex"),
        max_retrievers=2,
    )

    result = resolve_research_profile(
        {
            "source": {
                "mode": "web",
                "retrievers": ["duckduckgo", "openalex"],
            },
        },
        defaults,
        capabilities,
    )

    assert result.source.retrievers == ("duckduckgo", "openalex")
    assert capabilities.retrievers == ("duckduckgo", "openalex")
    assert capabilities.max_retrievers == 2


def test_request_profile_uses_ready_deployment_retriever_catalog() -> None:
    request = ResearchRequest(
        systemPrompt="Expert.",
        task="Research.",
        retriever="duckduckgo",
        researchProfile={
            "source": {
                "mode": "web",
                "retrievers": ["duckduckgo", "openalex"],
            },
        },
    )

    profile = resolve_request_research_profile(
        request,
        {
            "GPTR_ENABLED_RETRIEVERS": "duckduckgo,openalex",
            "GPTR_MAX_RETRIEVERS": "2",
        },
        adapter_loader=lambda provider_id: object(),
    )

    assert profile.source.retrievers == ("duckduckgo", "openalex")


def test_research_request_accepts_task_id_alias() -> None:
    request = ResearchRequest.model_validate(
        {
            "taskId": "task-local-documents",
            "systemPrompt": "Expert.",
            "task": "Research the uploaded document.",
        }
    )

    assert request.task_id == "task-local-documents"
    assert request.model_dump(by_alias=True)["taskId"] == (
        "task-local-documents"
    )


def test_current_environment_rejects_url_sources_for_deep_research() -> None:
    defaults, capabilities = current_research_environment("duckduckgo")

    with pytest.raises(ResearchProfileError) as captured:
        resolve_research_profile(
            {
                "mode": "deep",
                "deep": {
                    "breadth": 2,
                    "depth": 2,
                    "concurrency": 2,
                },
                "source": {
                    "mode": "urls",
                    "urls": ["https://example.com/report"],
                },
            },
            defaults,
            capabilities,
        )

    assert captured.value.code == "profile_capability_disabled"
    assert captured.value.path == "$.source.mode"


def test_current_environment_allows_synthesis_to_preserve_url_source_grant() -> None:
    defaults, capabilities = current_research_environment("duckduckgo")

    result = resolve_research_profile(
        {
            "mode": "synthesis",
            "source": {
                "mode": "urls",
                "urls": ["https://www.hrbcu.edu.cn/xxgk/sdjj.htm"],
            },
            "quality": {"curateSources": False},
        },
        defaults,
        capabilities,
    )

    assert result.mode == "synthesis"
    assert result.source.mode == "urls"


def test_current_environment_allows_synthesis_to_preserve_domain_source_grant() -> None:
    defaults, capabilities = current_research_environment("duckduckgo")

    result = resolve_research_profile(
        {
            "mode": "synthesis",
            "source": {
                "mode": "web",
                "retrievers": ["duckduckgo"],
                "includeDomains": ["hrbcu.edu.cn"],
            },
            "quality": {"curateSources": False},
        },
        defaults,
        capabilities,
    )

    assert result.mode == "synthesis"
    assert result.source.include_domains == ("hrbcu.edu.cn",)


def test_current_environment_rejects_domain_filters_for_deep_research() -> None:
    defaults, capabilities = current_research_environment("duckduckgo")

    with pytest.raises(ResearchProfileError) as captured:
        resolve_research_profile(
            {
                "mode": "deep",
                "deep": {
                    "breadth": 2,
                    "depth": 2,
                    "concurrency": 2,
                },
                "source": {
                    "mode": "web",
                    "retrievers": ["duckduckgo"],
                    "includeDomains": ["example.com"],
                },
            },
            defaults,
            capabilities,
        )

    assert captured.value.code == "profile_capability_disabled"
    assert captured.value.path == "$.source.includeDomains"
