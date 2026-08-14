from __future__ import annotations

import time
from types import SimpleNamespace

from app.retriever_runtime import (
    build_retriever_catalog,
    install_retriever_runtime,
)


def test_catalog_exposes_only_enabled_and_ready_retrievers() -> None:
    available = {
        "duckduckgo": object(),
        "tavily": object(),
        "openalex": object(),
    }

    catalog = build_retriever_catalog(
        {
            "GPTR_ENABLED_RETRIEVERS": "duckduckgo,tavily,openalex",
            "GPTR_MAX_RETRIEVERS": "3",
            "GPTR_RETRIEVER_TIMEOUT_MS": "15000",
        },
        adapter_loader=available.get,
    )

    assert [item.id for item in catalog.retrievers] == [
        "duckduckgo",
        "openalex",
    ]
    assert catalog.max_retrievers == 2
    assert catalog.retrievers[0].timeout_ms == 15000
    assert catalog.retrievers[0].credential_required is False
    assert catalog.retrievers[1].category == "academic"


def test_catalog_uses_legacy_retriever_as_default_enablement() -> None:
    catalog = build_retriever_catalog(
        {"RETRIEVER": "duckduckgo"},
        adapter_loader=lambda provider_id: (
            object() if provider_id == "duckduckgo" else None
        ),
    )

    assert [item.id for item in catalog.retrievers] == ["duckduckgo"]
    assert catalog.max_retrievers == 1


def test_catalog_requires_searx_url_without_marking_it_as_a_credential() -> None:
    adapter = object()

    unavailable = build_retriever_catalog(
        {"GPTR_ENABLED_RETRIEVERS": "searx"},
        adapter_loader=lambda provider_id: (
            adapter if provider_id == "searx" else None
        ),
    )
    assert unavailable.retrievers == ()
    assert unavailable.max_retrievers == 0

    available = build_retriever_catalog(
        {
            "GPTR_ENABLED_RETRIEVERS": "searx",
            "SEARX_URL": "http://thinktank-searxng:8080",
        },
        adapter_loader=lambda provider_id: (
            adapter if provider_id == "searx" else None
        ),
    )

    assert [item.id for item in available.retrievers] == ["searx"]
    assert available.retrievers[0].label == "SearXNG"
    assert available.retrievers[0].category == "web"
    assert available.retrievers[0].credential_required is False
    assert available.max_retrievers == 1


def test_runtime_applies_fair_budget_domain_filter_and_cross_provider_dedup() -> None:
    calls: list[tuple[str, int]] = []

    class WebRetriever:
        def __init__(self, query, query_domains=None) -> None:
            self.query = query
            self.query_domains = query_domains

        def search(self, max_results: int):
            calls.append(("web", max_results))
            return [
                {
                    "href": (
                        "https://Example.com/article/?utm_source=test"
                    ),
                },
                {"href": "https://ads.example.com/blocked"},
                {"title": "missing URL"},
            ]

    class AcademicRetriever:
        def __init__(self, query, query_domains=None) -> None:
            self.query = query
            self.query_domains = query_domains

        def search(self, max_results: int):
            calls.append(("academic", max_results))
            return [
                {"url": "https://example.com/article"},
                {"url": "https://papers.example.com/study"},
            ]

    researcher = SimpleNamespace(
        retrievers=[WebRetriever, AcademicRetriever],
    )
    runtime = install_retriever_runtime(
        researcher,
        ("duckduckgo", "openalex"),
        include_domains=("example.com",),
        exclude_domains=("ads.example.com",),
        timeout_ms=1_000,
    )

    web_results = researcher.retrievers[0]("topic").search(max_results=5)
    academic_results = researcher.retrievers[1](
        "topic",
    ).search(max_results=5)

    assert calls == [("web", 3), ("academic", 2)]
    assert web_results == [{
        "href": "https://Example.com/article/?utm_source=test",
    }]
    assert academic_results == [{
        "url": "https://papers.example.com/study",
    }]
    assert runtime.summary() == {
        "configured": ["duckduckgo", "openalex"],
        "installed": True,
        "attempts": 2,
        "returned": 5,
        "accepted": 2,
        "duplicates": 1,
        "domainRejected": 2,
        "allFailed": False,
        "providers": [
            {
                "id": "duckduckgo",
                "status": "succeeded",
                "attempts": 1,
                "returned": 3,
                "accepted": 1,
                "duplicates": 0,
                "domainRejected": 2,
                "errors": 0,
                "timeouts": 0,
                "lastError": None,
            },
            {
                "id": "openalex",
                "status": "succeeded",
                "attempts": 1,
                "returned": 2,
                "accepted": 1,
                "duplicates": 1,
                "domainRejected": 0,
                "errors": 0,
                "timeouts": 0,
                "lastError": None,
            },
        ],
    }


def test_runtime_degrades_provider_errors_and_timeouts_without_raising() -> None:
    class FailedRetriever:
        def __init__(self, query, query_domains=None) -> None:
            del query, query_domains

        def search(self, max_results: int):
            del max_results
            raise RuntimeError("provider token must not be exposed")

    class SlowRetriever:
        def __init__(self, query, query_domains=None) -> None:
            del query, query_domains

        def search(self, max_results: int):
            del max_results
            time.sleep(0.1)
            return [{"url": "https://example.com/late"}]

    researcher = SimpleNamespace(
        retrievers=[FailedRetriever, SlowRetriever],
    )
    runtime = install_retriever_runtime(
        researcher,
        ("duckduckgo", "openalex"),
        timeout_ms=10,
    )

    assert researcher.retrievers[0]("topic").search(max_results=4) == []
    assert researcher.retrievers[1]("topic").search(max_results=4) == []

    summary = runtime.summary()
    assert summary["allFailed"] is True
    assert [
        provider["status"]
        for provider in summary["providers"]
    ] == ["failed", "timed_out"]
    assert summary["providers"][0]["lastError"] == "RuntimeError"
    assert summary["providers"][1]["lastError"] == "timeout"


def test_runtime_does_not_exceed_a_small_shared_result_budget() -> None:
    calls: list[str] = []

    def provider(name: str):
        class FakeRetriever:
            def __init__(self, query, query_domains=None) -> None:
                del query, query_domains

            def search(self, max_results: int):
                calls.append(f"{name}:{max_results}")
                return [{"url": f"https://{name}.example/source"}]

        return FakeRetriever

    researcher = SimpleNamespace(
        retrievers=[
            provider("first"),
            provider("second"),
            provider("third"),
        ],
    )
    install_retriever_runtime(
        researcher,
        ("duckduckgo", "openalex", "arxiv"),
    )

    for retriever in researcher.retrievers:
        retriever("topic").search(max_results=2)

    assert calls == ["first:1", "second:1"]
