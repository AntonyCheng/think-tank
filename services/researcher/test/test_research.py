import json
from typing import Any
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app import main
from app.research_executor import ResearchExecutionError
from app.source_access import (
    MaterializedSource,
    MaterializedSourceFailure,
    MaterializedSourceSet,
)


class FakeResearcher:
    init_kwargs: dict[str, Any] = {}
    init_openai_base_url: str | None = None
    init_openai_api_key: str | None = None

    def __init__(self, **kwargs: Any) -> None:
        type(self).init_kwargs = kwargs
        type(self).init_openai_base_url = main.os.getenv("OPENAI_BASE_URL")
        type(self).init_openai_api_key = main.os.getenv("OPENAI_API_KEY")
        self.websocket = kwargs["websocket"]
        self.cfg = SimpleNamespace(scraper="beautiful_soup")

    async def conduct_research(self) -> None:
        await self.websocket.send_json(
            {
                "type": "logs",
                "content": "research",
                "output": "Searching sources",
            }
        )

    async def write_report(self) -> str:
        return "# researched report"

    def get_source_urls(self) -> list[str]:
        return ["https://example.com/evidence"]

    def get_research_sources(self) -> list[dict[str, str]]:
        return [{
            "url": "https://example.com/evidence",
            "title": "Evidence",
            "raw_content": "Verified evidence context.",
        }]

    def get_research_context(self) -> str:
        return "Compressed research context."

    def get_costs(self) -> float:
        return 0.25


class ModeRoutingResearcher(FakeResearcher):
    calls: list[tuple[str, Any]] = []

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        type(self).calls = []

    async def conduct_research(self, on_progress=None) -> None:
        type(self).calls.append(("conduct_research", None))
        if on_progress:
            on_progress(SimpleNamespace(
                current_depth=1,
                total_depth=2,
                current_breadth=2,
                total_breadth=3,
                completed_queries=2,
                total_queries=3,
            ))
            on_progress(SimpleNamespace(
                current_depth=1,
                total_depth=1,
                current_breadth=1,
                total_breadth=2,
                completed_queries=1,
                total_queries=2,
            ))

    async def write_report(self, *args: Any, **kwargs: Any) -> str:
        type(self).calls.append(
            ("write_report", {"args": args, "kwargs": kwargs})
        )
        return "# routed report"

    def get_source_urls(self) -> list[str]:
        if any(name == "conduct_research" for name, _ in type(self).calls):
            return ["https://example.com/evidence"]
        return []

    def get_research_sources(self) -> list[dict[str, str]]:
        if self.get_source_urls():
            return [{
                "url": "https://example.com/evidence",
                "title": "Evidence",
            }]
        return []


class SourceRoutingResearcher(FakeResearcher):
    calls: list[tuple[str, Any]] = []

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        type(self).calls = []
        self.sources: list[dict[str, str]] = []
        self.context = "Web research context."

    def add_research_sources(
        self,
        sources: list[dict[str, str]],
    ) -> None:
        type(self).calls.append(("add_research_sources", sources))
        self.sources.extend(sources)

    async def conduct_research(self) -> None:
        type(self).calls.append(("conduct_research", None))
        self.sources.append({
            "url": "https://web.example/evidence",
            "title": "Web evidence",
            "raw_content": "Supplemental Web evidence.",
        })

    async def write_report(self, *args: Any, **kwargs: Any) -> str:
        type(self).calls.append(
            ("write_report", {"args": args, "kwargs": kwargs})
        )
        return "# source-routed report"

    def get_source_urls(self) -> list[str]:
        return [source["url"] for source in self.sources]

    def get_research_sources(self) -> list[dict[str, str]]:
        return self.sources

    def get_research_context(self) -> str:
        return self.context


class StubSourceMaterializer:
    async def materialize(self, urls: list[str]) -> MaterializedSourceSet:
        assert urls == ["https://input.example/report"]
        source = MaterializedSource(
            requested_url=urls[0],
            canonical_url="https://canonical.example/report",
            title="Specified report",
            media_type="text/html",
            text="Verified specified evidence.",
            byte_size=128,
        )
        return MaterializedSourceSet(sources=(source,), total_bytes=128)


class UnavailableSourceMaterializer:
    async def materialize(self, urls: list[str]) -> MaterializedSourceSet:
        return MaterializedSourceSet(
            sources=(),
            total_bytes=0,
            failures=(
                MaterializedSourceFailure(
                    url=urls[0],
                    code="source_unavailable",
                    message="The source could not be downloaded.",
                ),
            ),
        )


class FakeExecutor:
    def __init__(self) -> None:
        self.requests: list[main.ResearchRequest] = []

    async def execute(
        self,
        request: main.ResearchRequest,
        publish=None,
    ) -> main.ResearchResponse:
        self.requests.append(request)
        return main.ResearchResponse(
            report="# isolated report",
            sourceUrls=["https://example.com/isolated"],
            sources=[],
            cost=0.5,
            events=[],
        )

    async def close(self) -> None:
        return None


class InProcessExecutor:
    async def execute(
        self,
        request: main.ResearchRequest,
        publish=None,
    ) -> main.ResearchResponse:
        return await main.run_research(
            request,
            main.LogCollector(publish),
        )

    async def close(self) -> None:
        return None


class FailingExecutor:
    async def execute(
        self,
        request: main.ResearchRequest,
        publish=None,
    ) -> main.ResearchResponse:
        raise ResearchExecutionError(422, "invalid isolated configuration")

    async def close(self) -> None:
        return None


class TrackingExecutor(FakeExecutor):
    def __init__(self) -> None:
        super().__init__()
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def test_execution_capacity_endpoint_updates_the_running_executor(
    monkeypatch,
) -> None:
    class CapacityExecutor(FakeExecutor):
        async def update_worker_concurrency(
            self,
            concurrency: int,
        ) -> dict[str, int]:
            return {"concurrency": concurrency, "active": 2, "queued": 1}

    monkeypatch.setattr(
        main,
        "research_executor",
        CapacityExecutor(),
        raising=False,
    )

    response = TestClient(main.app).post(
        "/runtime/execution-capacity",
        json={"concurrency": 4},
    )

    assert response.status_code == 200
    assert response.json() == {"concurrency": 4, "active": 2, "queued": 1}


def test_research_endpoint_delegates_to_executor(monkeypatch) -> None:
    executor = FakeExecutor()
    monkeypatch.setattr(main, "research_executor", executor, raising=False)
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: (_ for _ in ()).throw(
            AssertionError("endpoint bypassed ResearchExecutor")
        ),
    )

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Complete expert identity.",
            "task": "Investigate the evidence.",
            "baseUrl": "https://models.example/v1",
            "apiKey": "request-secret",
            "fallbackBaseUrl": "https://backup.example/v1",
            "fallbackApiKey": "backup-secret",
            "fallbackFastLlm": "openai:backup-fast-model",
        },
    )

    assert response.status_code == 200
    assert response.json()["report"] == "# isolated report"
    assert len(executor.requests) == 1
    assert executor.requests[0].system_prompt == "Complete expert identity."
    assert executor.requests[0].api_key == "request-secret"
    assert executor.requests[0].fallback_base_url == "https://backup.example/v1"
    assert executor.requests[0].fallback_api_key == "backup-secret"
    assert executor.requests[0].fallback_fast_llm == "openai:backup-fast-model"


def test_application_shutdown_closes_research_executor(monkeypatch) -> None:
    executor = TrackingExecutor()
    monkeypatch.setattr(main, "research_executor", executor)

    with TestClient(main.app):
        pass

    assert executor.closed is True


def test_research_endpoint_preserves_executor_error_status(monkeypatch) -> None:
    monkeypatch.setattr(main, "research_executor", FailingExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert.",
            "task": "Research.",
        },
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "invalid isolated configuration"}


def test_research_stream_preserves_executor_error_status(monkeypatch) -> None:
    monkeypatch.setattr(main, "research_executor", FailingExecutor())

    with TestClient(main.app).stream(
        "POST",
        "/research/stream",
        json={
            "systemPrompt": "Expert.",
            "task": "Research.",
        },
    ) as response:
        messages = [
            json.loads(line)
            for line in response.iter_lines()
            if line
        ]

    assert response.status_code == 200
    assert messages == [{
        "type": "error",
        "error": {
            "status": 422,
            "detail": "invalid isolated configuration",
        },
    }]


def test_research_contract_and_active_configuration(monkeypatch) -> None:
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: FakeResearcher,
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())
    for name in (
        "RETRIEVER",
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "GPTR_EMBEDDING_API_KEY",
        "FAST_LLM",
        "SMART_LLM",
        "STRATEGIC_LLM",
        "EMBEDDING",
        "MAX_SEARCH_RESULTS_PER_QUERY",
        "MAX_ITERATIONS",
        "MAX_SUBTOPICS",
        "CURATE_SOURCES",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GPTR_EMBEDDING_API_KEY", "embedding-secret")

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "You are the complete expert identity.",
            "task": "Investigate the evidence.",
            "reportSource": "web",
            "retriever": "duckduckgo",
            "baseUrl": "https://models.example/v1/",
            "apiKey": "secret",
            "fastLlm": "openai:fast-model",
            "smartLlm": "openai:smart-model",
            "embedding": "openai:embedding-model",
            "embeddingBaseUrl": "https://embeddings.example/v1/",
            "embeddingApiKey": "request-embedding-secret",
            "researchProfile": {
                "schemaVersion": 1,
                "mode": "standard",
                "source": {
                    "mode": "web",
                    "retrievers": ["duckduckgo"],
                },
                "quality": {"curateSources": True},
                "limits": {
                    "maxSearchResultsPerQuery": 8,
                    "maxIterations": 6,
                    "maxSubtopics": 5,
                },
            },
            "runtimeContext": {
                "startedAt": "2026-07-29T03:20:00.000Z",
                "timeZone": "Asia/Shanghai",
                "localDate": "2026-07-29",
                "localTime": "11:20:00",
                "weekday": "星期三",
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["report"] == "# researched report"
    assert body["sourceUrls"] == ["https://example.com/evidence"]
    assert body["cost"] == 0.25
    assert body["events"][0]["type"] == "logs"
    assert body["researchEvidence"] == {
        "queries": [],
        "sources": [{
            "visibility": "public",
            "url": "https://example.com/evidence",
            "title": "Evidence",
            "sourceType": "web",
            "summary": "Verified evidence context.",
        }],
        "researchContext": {
            "content": "Compressed research context.",
            "originalCharacters": 28,
            "truncated": False,
        },
        "scraper": "beautiful_soup",
    }

    query = FakeResearcher.init_kwargs["query"]
    assert query == "Investigate the evidence."
    assert FakeResearcher.init_kwargs["report_type"] == "custom_report"
    assert FakeResearcher.init_kwargs["report_source"] == "web"
    assert FakeResearcher.init_kwargs["agent"] == "Agency Orchestrator Expert"
    role = FakeResearcher.init_kwargs["role"]
    assert "Current local date: 2026-07-29" in role
    assert "You are the complete expert identity." in role
    assert "Investigate the evidence." in role
    assert "<citation_contract>" in role

    assert main.os.environ["RETRIEVER"] == "duckduckgo"
    assert main.os.environ["OPENAI_BASE_URL"] == "https://models.example/v1"
    assert main.os.environ["OPENAI_API_KEY"] == "secret"
    assert main.os.environ["FAST_LLM"] == "openai:fast-model"
    assert main.os.environ["SMART_LLM"] == "openai:smart-model"
    assert main.os.environ["STRATEGIC_LLM"] == "openai:smart-model"
    assert main.os.environ["EMBEDDING"] == "openai:embedding-model"
    assert main.os.environ["MAX_SEARCH_RESULTS_PER_QUERY"] == "8"
    assert main.os.environ["MAX_ITERATIONS"] == "6"
    assert main.os.environ["MAX_SUBTOPICS"] == "5"
    assert main.os.environ["CURATE_SOURCES"] == "true"
    assert (
        FakeResearcher.init_openai_base_url
        == "https://embeddings.example/v1"
    )
    assert FakeResearcher.init_openai_api_key == "request-embedding-secret"
    assert main.os.environ["OPENAI_BASE_URL"] == "https://models.example/v1"
    assert main.os.environ["OPENAI_API_KEY"] == "secret"


def test_search_query_seed_is_compact_and_excludes_internal_instructions() -> None:
    task = "  研究中国企业供应链韧性。\n\n" + ("补充背景信息。" * 100)

    query = main.research_worker._build_search_query(task)

    assert len(query) == 320
    assert "\n" not in query
    assert query.startswith("研究中国企业供应链韧性。 补充背景信息。")


def test_research_rejects_deep_profile_beyond_deployment_limit(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: (_ for _ in ()).throw(
            AssertionError("disabled profile reached GPTR construction")
        ),
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Research task.",
            "researchProfile": {
                "schemaVersion": 1,
                "mode": "deep",
                "source": {
                    "mode": "web",
                    "retrievers": ["duckduckgo"],
                },
                "quality": {"curateSources": False},
                "limits": {
                    "maxSearchResultsPerQuery": 5,
                    "maxIterations": 3,
                    "maxSubtopics": 3,
                },
                "deep": {
                    "breadth": 5,
                    "depth": 2,
                    "concurrency": 2,
                },
            },
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "code": "profile_capability_disabled",
            "path": "$.researchProfile.deep.breadth",
            "message": (
                "Deep research breadth 5 exceeds the deployment limit 4."
            ),
        }
    }


def test_deep_mode_routes_to_native_gptr_deep_research(monkeypatch) -> None:
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: ModeRoutingResearcher,
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())
    for name in (
        "DEEP_RESEARCH_BREADTH",
        "DEEP_RESEARCH_DEPTH",
        "DEEP_RESEARCH_CONCURRENCY",
    ):
        monkeypatch.delenv(name, raising=False)

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Investigate the topic deeply.",
            "researchProfile": {
                "schemaVersion": 1,
                "mode": "deep",
                "source": {
                    "mode": "web",
                    "retrievers": ["duckduckgo"],
                },
                "quality": {"curateSources": False},
                "limits": {
                    "maxSearchResultsPerQuery": 5,
                    "maxIterations": 3,
                    "maxSubtopics": 3,
                },
                "deep": {
                    "breadth": 3,
                    "depth": 2,
                    "concurrency": 2,
                },
            },
        },
    )

    assert response.status_code == 200
    assert ModeRoutingResearcher.init_kwargs["report_type"] == "deep"
    assert [name for name, _ in ModeRoutingResearcher.calls] == [
        "conduct_research",
        "write_report",
    ]
    assert main.os.environ["DEEP_RESEARCH_BREADTH"] == "3"
    assert main.os.environ["DEEP_RESEARCH_DEPTH"] == "2"
    assert main.os.environ["DEEP_RESEARCH_CONCURRENCY"] == "2"
    assert main.os.environ["CURATE_SOURCES"] == "false"
    assert [
        event["type"]
        for event in response.json()["events"]
    ] == [
        "deep_research.initialize",
        "deep_research.progress",
        "deep_research.progress",
        "deep_research.complete",
    ]
    assert [
        event["data"]
        for event in response.json()["events"]
        if event["type"] == "deep_research.progress"
    ] == [
        {
            "currentDepth": 1,
            "totalDepth": 2,
            "currentBreadth": 2,
            "totalBreadth": 3,
            "totalQueries": 3,
            "completedQueries": 2,
            "currentLevel": 1,
            "totalLevels": 2,
        },
        {
            "currentDepth": 1,
            "totalDepth": 1,
            "currentBreadth": 1,
            "totalBreadth": 2,
            "totalQueries": 2,
            "completedQueries": 1,
            "currentLevel": 2,
            "totalLevels": 2,
        },
    ]


def test_synthesis_mode_skips_research_and_writes_from_dependency_context(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: ModeRoutingResearcher,
    )
    monkeypatch.setattr(
        main.research_worker,
        "default_source_materializer",
        lambda: pytest.fail(
            "synthesis must not initialize the specified URL reader"
        ),
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Synthesis expert identity.",
            "task": "Combine the rendered upstream reports.",
            "upstreamEvidence": [{
                "schemaVersion": 1,
                "aoStepId": "market_analysis",
                "researchRunId": "research-1",
                "attempt": 1,
                "mode": "standard",
                "startedAt": "2026-07-29T10:00:00.000Z",
                "completedAt": "2026-07-29T10:02:00.000Z",
                "derivedFromStepIds": [],
                "queries": [{
                    "id": "query-1",
                    "kind": "subquery",
                    "text": "2026 AI market size",
                }],
                "sources": [{
                    "id": "source-1",
                    "visibility": "public",
                    "url": "https://example.com/market",
                    "title": "Market evidence",
                    "summary": "Verified market data.",
                    "observedAt": "2026-07-29T10:02:00.000Z",
                }],
                "researchContext": {
                    "content": "Bounded research context.",
                    "originalCharacters": 25,
                    "truncated": False,
                },
                "method": {
                    "sourceMode": "web",
                    "retrievers": ["duckduckgo"],
                },
                "report": {
                    "format": "markdown",
                    "content": "# Market analysis\n\nVerified finding.",
                    "revision": 1,
                },
                "cost": 0.1,
            }],
            "researchProfile": {
                "schemaVersion": 1,
                "mode": "synthesis",
                "source": {
                    "mode": "urls",
                    "urls": ["https://www.hrbcu.edu.cn/xxgk/sdjj.htm"],
                },
                "quality": {"curateSources": False},
                "limits": {
                    "maxSearchResultsPerQuery": 5,
                    "maxIterations": 3,
                    "maxSubtopics": 3,
                },
            },
        },
    )

    assert response.status_code == 200
    assert main.os.environ["CURATE_SOURCES"] == "false"
    assert ModeRoutingResearcher.init_kwargs["report_type"] == "custom_report"
    assert [name for name, _ in ModeRoutingResearcher.calls] == [
        "write_report",
    ]
    synthesis_context = ModeRoutingResearcher.calls[0][1]["kwargs"][
        "ext_context"
    ]
    assert "Combine the rendered upstream reports." in synthesis_context
    assert "market_analysis" in synthesis_context
    assert "# Market analysis\n\nVerified finding." in synthesis_context
    assert "[Market evidence](https://example.com/market)" in synthesis_context
    assert "Bounded research context." not in synthesis_context
    assert response.json()["sourceUrls"] == []
    assert [
        event["type"]
        for event in response.json()["events"]
    ] == [
        "synthesis.compression",
        "synthesis.started",
        "synthesis.completed",
    ]


def test_url_only_materializes_once_and_skips_web_research(monkeypatch) -> None:
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: SourceRoutingResearcher,
    )
    monkeypatch.setattr(
        main.research_worker,
        "default_source_materializer",
        lambda: StubSourceMaterializer(),
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Analyze the specified report.",
            "researchProfile": {
                "schemaVersion": 1,
                "mode": "standard",
                "source": {
                    "mode": "urls",
                    "urls": ["https://input.example/report"],
                },
                "quality": {"curateSources": False},
                "limits": {
                    "maxSearchResultsPerQuery": 5,
                    "maxIterations": 3,
                    "maxSubtopics": 3,
                },
            },
        },
    )

    assert response.status_code == 200
    assert [name for name, _ in SourceRoutingResearcher.calls] == [
        "add_research_sources",
        "write_report",
    ]
    report_context = SourceRoutingResearcher.calls[-1][1]["kwargs"][
        "ext_context"
    ]
    assert "Verified specified evidence." in report_context
    assert "https://canonical.example/report" in report_context
    assert response.json()["sourceUrls"] == [
        "https://canonical.example/report"
    ]
    assert response.json()["researchEvidence"]["sources"][0][
        "sourceType"
    ] == "specified_url"
    assert [
        event["type"] for event in response.json()["events"]
    ] == [
        "source.validation_started",
        "source.materialized",
    ]


def test_url_plus_web_combines_context_and_writes_one_report(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: SourceRoutingResearcher,
    )
    monkeypatch.setattr(
        main.research_worker,
        "default_source_materializer",
        lambda: StubSourceMaterializer(),
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Analyze and supplement the report.",
            "researchProfile": {
                "schemaVersion": 1,
                "mode": "standard",
                "source": {
                    "mode": "urls",
                    "urls": ["https://input.example/report"],
                    "web": {
                        "retrievers": ["duckduckgo"],
                        "includeDomains": ["web.example"],
                    },
                },
                "quality": {"curateSources": False},
                "limits": {
                    "maxSearchResultsPerQuery": 5,
                    "maxIterations": 3,
                    "maxSubtopics": 3,
                },
            },
        },
    )

    assert response.status_code == 200
    assert [name for name, _ in SourceRoutingResearcher.calls] == [
        "add_research_sources",
        "conduct_research",
        "write_report",
    ]
    report_context = SourceRoutingResearcher.calls[-1][1]["kwargs"][
        "ext_context"
    ]
    assert "Verified specified evidence." in report_context
    assert "Web research context." in report_context
    assert SourceRoutingResearcher.init_kwargs["query_domains"] == [
        "web.example"
    ]
    assert [
        event["type"] for event in response.json()["events"]
    ] == [
        "source.validation_started",
        "source.materialized",
        "source.web_supplement_started",
    ]


"""def test_pure_managed_mcp_uses_private_evidence_and_skips_web(
    monkeypatch,
) -> None:
    from app.managed_mcp_runtime import (
        install_managed_mcp_runtime as install_runtime,
    )
    from app.mcp_registry import (
        McpProfileConfig,
        McpToolConfig,
        McpTransportConfig,
        ResolvedMcpProfile,
    )

    class AdvertisedTool:
        name = "search_policy"

        async def ainvoke(self, arguments):
            return f"Managed evidence for {arguments['query']}"

    class Client:
        async def get_tools(self):
            return [AdvertisedTool()]

    class WebRetriever:
        calls = 0

        def __init__(self, *_args, **_kwargs):
            type(self).calls += 1

    class McpResearcher(SourceRoutingResearcher):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self.retrievers = [WebRetriever]

        async def conduct_research(self) -> None:
            type(self).calls.append(("conduct_research", None))
            for retriever in self.retrievers:
                self.sources.extend(
                    retriever(
                        "government model",
                        researcher=self,
                    ).search(max_results=5)
                )

        def get_source_urls(self) -> list[str]:
            return []

        def get_research_sources(self) -> list[dict[str, str]]:
            return []

    async def plan(_query, tools, _researcher):
        return [(tools[0].name, {"query": "government model"})]

    resolved = ResolvedMcpProfile(
        profile=McpProfileConfig(
            id="policy-library",
            label="Policy library",
            revision="sha256:test-revision",
            transport=McpTransportConfig(
                type="streamable_http",
                url="https://internal.example/mcp",
            ),
            tools=(McpToolConfig(
                name="search_policy",
                label="Search policy",
                result_visibility="private",
            ),),
        ),
        adapter_config={
            "transport": "streamable_http",
            "url": "https://internal.example/mcp",
        },
        secret_values=("private-secret",),
    )
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: McpResearcher,
    )
    monkeypatch.setattr(
        main.research_worker,
        "build_mcp_profile_catalog",
        lambda _environment: object(),
    )
    monkeypatch.setattr(
        main.research_worker,
        "resolve_mcp_execution_profiles",
        lambda *_args: (resolved,),
    )
    monkeypatch.setattr(
        main.research_worker,
        "install_managed_mcp_runtime",
        lambda researcher, profiles, **kwargs: install_runtime(
            researcher,
            profiles,
            include_web=kwargs["include_web"],
            limits=kwargs["limits"],
            observer=kwargs["observer"],
            client_factory=lambda _configs: Client(),
            planner=plan,
        ),
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Analyze government model policy.",
            "researchProfile": {
                "mode": "standard",
                "source": {
                    "mode": "mcp",
                    "mcpProfileIds": ["policy-library"],
                },
            },
            "mcpGrant": {
                "schemaVersion": 1,
                "profiles": [{
                    "id": "policy-library",
                    "revision": "sha256:test-revision",
                    "tools": ["search_policy"],
                }],
            },
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert WebRetriever.calls == 0
    assert body["researchEvidence"]["sources"][-1] == {
        "visibility": "private",
        "locator": "mcp:policy-library/search_policy/call_01",
        "title": "Policy library / Search policy",
        "sourceType": "mcp",
        "summary": "Managed evidence for government model",
    }
    assert "internal.example" not in json.dumps(body)
    assert "private-secret" not in json.dumps(body)
    assert any(event["type"] == "mcp.summary" for event in body["events"])


def test_mcp_plus_web_degrades_when_frozen_profile_is_unavailable(
    monkeypatch,
) -> None:
    from app.mcp_registry import McpRegistryError

    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: SourceRoutingResearcher,
    )
    monkeypatch.setattr(
        main.research_worker,
        "build_mcp_profile_catalog",
        lambda _environment: object(),
    )

    def unavailable(*_args):
        raise McpRegistryError(
            "mcp_profile_unavailable",
            "$.mcpGrant.profiles[0].id",
            "Managed MCP profile is unavailable.",
        )

    monkeypatch.setattr(
        main.research_worker,
        "resolve_mcp_execution_profiles",
        unavailable,
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Use managed and Web evidence.",
            "researchProfile": {
                "mode": "standard",
                "source": {
                    "mode": "mcp",
                    "mcpProfileIds": ["policy-library"],
                    "web": {"retrievers": ["duckduckgo"]},
                },
            },
            "mcpGrant": {
                "schemaVersion": 1,
                "profiles": [{
                    "id": "policy-library",
                    "revision": "sha256:test-revision",
                    "tools": ["search_policy"],
                }],
            },
        },
    )

    assert response.status_code == 200
    degraded = next(
        event for event in response.json()["events"]
        if event["type"] == "mcp.degraded"
    )
    assert degraded["data"] == {
        "code": "mcp_profile_unavailable",
        "webFallback": True,
    }


"""

def test_domain_constraints_filter_retriever_results_before_scraping() -> None:
    class FakeRetriever:
        def __init__(self, query, query_domains=None) -> None:
            self.query = query
            self.query_domains = query_domains

        def search(self, max_results: int) -> list[dict[str, str]]:
            del max_results
            return [
                {"href": "https://news.example.com/allowed"},
                {"href": "https://ads.example.com/blocked"},
                {"href": "https://example.com.evil.test/lookalike"},
            ]

    researcher = SimpleNamespace(retrievers=[FakeRetriever])

    runtime = main.research_worker.install_retriever_runtime(
        researcher,
        ("duckduckgo",),
        include_domains=("example.com",),
        exclude_domains=("ads.example.com",),
    )
    constrained = researcher.retrievers[0](
        "query",
        query_domains=["example.com"],
    )

    assert constrained.search(max_results=10) == [
        {"href": "https://news.example.com/allowed"}
    ]
    assert runtime.summary()["domainRejected"] == 2


def test_multi_retriever_execution_emits_bounded_diagnostics(
    monkeypatch,
) -> None:
    class WebRetriever:
        def __init__(self, query, query_domains=None) -> None:
            del query, query_domains

        def search(self, max_results: int):
            del max_results
            return [{"href": "https://example.com/shared"}]

    class AcademicRetriever:
        def __init__(self, query, query_domains=None) -> None:
            del query, query_domains

        def search(self, max_results: int):
            del max_results
            return [
                {"url": "https://example.com/shared"},
                {"url": "https://papers.example.com/study"},
            ]

    class MultiRetrieverResearcher(FakeResearcher):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self.retrievers = [WebRetriever, AcademicRetriever]
            self.results: list[dict[str, str]] = []

        async def conduct_research(self) -> None:
            for retriever in self.retrievers:
                self.results.extend(
                    retriever("topic").search(max_results=6)
                )

        def get_source_urls(self) -> list[str]:
            return [
                result.get("href") or result["url"]
                for result in self.results
            ]

        def get_research_sources(self) -> list[dict[str, str]]:
            return [
                {
                    "url": url,
                    "title": "Evidence",
                    "raw_content": "Verified evidence context.",
                }
                for url in self.get_source_urls()
            ]

    monkeypatch.setenv(
        "GPTR_ENABLED_RETRIEVERS",
        "duckduckgo,openalex",
    )
    monkeypatch.setenv("GPTR_MAX_RETRIEVERS", "2")
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: MultiRetrieverResearcher,
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Research task.",
            "researchProfile": {
                "source": {
                    "mode": "web",
                    "retrievers": ["duckduckgo", "openalex"],
                },
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["sourceUrls"] == [
        "https://example.com/shared",
        "https://papers.example.com/study",
    ]
    summary = next(
        event["data"]
        for event in body["events"]
        if event["type"] == "retriever.summary"
    )
    assert summary["configured"] == ["duckduckgo", "openalex"]
    assert summary["accepted"] == 2
    assert summary["duplicates"] == 1


def test_web_only_research_fails_when_all_retrievers_fail(
    monkeypatch,
) -> None:
    class FailedRetriever:
        def __init__(self, query, query_domains=None) -> None:
            del query, query_domains

        def search(self, max_results: int):
            del max_results
            raise RuntimeError("provider unavailable")

    class FailedResearcher(FakeResearcher):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self.retrievers = [FailedRetriever]

        async def conduct_research(self) -> None:
            self.retrievers[0]("topic").search(max_results=5)

    monkeypatch.setenv("GPTR_ENABLED_RETRIEVERS", "duckduckgo")
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: FailedResearcher,
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Research task.",
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "retriever_all_failed"


def test_url_plus_web_continues_when_the_specified_url_is_unavailable(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: SourceRoutingResearcher,
    )
    monkeypatch.setattr(
        main.research_worker,
        "default_source_materializer",
        lambda: UnavailableSourceMaterializer(),
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Supplement the unavailable report.",
            "researchProfile": {
                "mode": "standard",
                "source": {
                    "mode": "urls",
                    "urls": ["https://input.example/report"],
                    "web": {"retrievers": ["duckduckgo"]},
                },
            },
        },
    )

    assert response.status_code == 200
    assert [name for name, _ in SourceRoutingResearcher.calls] == [
        "add_research_sources",
        "conduct_research",
        "write_report",
    ]
    warning = next(
        event
        for event in response.json()["events"]
        if event["type"] == "source.unavailable"
    )
    assert warning["data"] == {
        "url": "https://input.example/report",
        "code": "source_unavailable",
    }


def test_url_only_fails_when_no_specified_source_is_usable(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: SourceRoutingResearcher,
    )
    monkeypatch.setattr(
        main.research_worker,
        "default_source_materializer",
        lambda: UnavailableSourceMaterializer(),
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Analyze the unavailable report.",
            "researchProfile": {
                "mode": "standard",
                "source": {
                    "mode": "urls",
                    "urls": ["https://input.example/report"],
                },
            },
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "source_no_usable_sources"


def test_streams_gptr_events_before_the_final_result(monkeypatch) -> None:
    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: FakeResearcher,
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    with TestClient(main.app).stream(
        "POST",
        "/research/stream",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Research task.",
        },
    ) as response:
        messages = [
            json.loads(line)
            for line in response.iter_lines()
            if line
        ]

    assert response.status_code == 200
    assert response.headers["content-type"].startswith(
        "application/x-ndjson"
    )
    assert messages[0]["type"] == "event"
    assert messages[0]["event"]["data"]["content"] == "research"
    assert messages[-1]["type"] == "result"
    assert messages[-1]["result"]["report"] == "# researched report"


def test_stream_drops_raw_report_fragments_from_observability(
    monkeypatch,
) -> None:
    class FragmentingResearcher(FakeResearcher):
        async def conduct_research(self) -> None:
            await super().conduct_research()
            for fragment in ["First line\n", "Second line\n", "Third line"]:
                await self.websocket.send_json(
                    {"type": "report", "output": fragment}
                )

    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: FragmentingResearcher,
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    with TestClient(main.app).stream(
        "POST",
        "/research/stream",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Research task.",
        },
    ) as response:
        messages = [
            json.loads(line)
            for line in response.iter_lines()
            if line
        ]

    streamed_events = [
        message["event"]
        for message in messages
        if message["type"] == "event"
    ]
    assert [event["type"] for event in streamed_events] == ["logs"]
    assert all(
        event["type"] != "report"
        for event in messages[-1]["result"]["events"]
    )


def test_sanitize_report_removes_explicit_reasoning_block() -> None:
    report = "internal reasoning\n</think>\n\n# Final report"

    assert main.sanitize_report(report) == "# Final report"


def test_sanitize_report_preserves_regular_report() -> None:
    assert main.sanitize_report("  # Final report\n") == "# Final report"


def test_sanitize_report_collapses_a_repeated_complete_report() -> None:
    introduction = "# Final report\n\n" + (
        "Evidence-backed introduction. " * 30
    ).strip()
    analysis = "## Analysis\n\n" + (
        "Detailed comparison with citations. " * 30
    ).strip()
    conclusion = "## Conclusion\n\n" + (
        "Scenario-specific recommendation. " * 30
    ).strip()
    report = "\n\n".join([introduction, analysis, conclusion]).strip()

    assert main.sanitize_report(f"{report}\n\n{report}") == report


def test_sanitize_report_collapses_a_repeated_large_paragraph_run() -> None:
    introduction = "# Final report\n\nUnique introduction."
    repeated_section = "\n\n".join(
        [
            "## Evidence",
            ("Source comparison. " * 40).strip(),
            "## Recommendation",
            ("Scenario recommendation. " * 40).strip(),
        ]
    ).strip()
    conclusion = "## Limitations\n\nUnique limitations."
    report = "\n\n".join(
        [introduction, repeated_section, repeated_section, conclusion]
    )

    assert main.sanitize_report(report) == "\n\n".join(
        [introduction, repeated_section, conclusion]
    )


def test_sanitize_report_preserves_short_intentional_repetition() -> None:
    report = "# Report\n\nSame label\n\nAnalysis\n\nSame label\n\nConclusion"

    assert main.sanitize_report(report) == report


def test_research_endpoint_normalizes_repeated_report_and_emits_diagnostics(
    monkeypatch,
) -> None:
    section = "\n\n".join(
        [
            "# Report",
            ("Evidence paragraph. " * 40).strip(),
            "## Conclusion",
            ("Recommendation paragraph. " * 40).strip(),
        ]
    )

    class RepeatingResearcher(FakeResearcher):
        async def write_report(self) -> str:
            return f"{section}\n\n{section}"

    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: RepeatingResearcher,
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Research task.",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["report"] == section
    diagnostic = next(
        event
        for event in body["events"]
        if event["type"] == "gptr.report.normalized"
    )
    assert diagnostic["data"]["removedCharacters"] > 0
    assert diagnostic["data"]["reportCharacters"] == len(section)


def test_normalize_citation_links_replaces_source_titles_with_urls() -> None:
    source_title = (
        "哈尔滨市统计局，《2024年全年GDP统一核算结果》"
        "及第五次全国经济普查修订数据"
    )
    source_url = "https://tjj.harbin.gov.cn/example/gdp-2024.html"
    report = (
        f"哈尔滨经济数据来自官方统计[^1]({source_title})。\n\n"
        "[官方页面](https://example.com/already-valid)"
    )

    normalized, replacements = main.normalize_citation_links(
        report,
        [source_url],
        [{"title": source_title, "url": source_url}],
    )

    assert replacements == 1
    assert f"[^1]({source_url})" in normalized
    assert "[官方页面](https://example.com/already-valid)" in normalized


def test_normalize_citation_links_uses_citation_number_as_fallback() -> None:
    source_url = "https://example.com/second-source"
    report = "结论来自第二项证据[^2](无法匹配的来源标题)。"

    normalized, replacements = main.normalize_citation_links(
        report,
        ["https://example.com/first-source", source_url],
        [],
    )

    assert replacements == 1
    assert normalized == f"结论来自第二项证据[^2]({source_url})。"


def test_research_endpoint_normalizes_citations_and_emits_diagnostics(
    monkeypatch,
) -> None:
    source_title = "哈尔滨市统计局，2024年GDP统一核算结果"
    source_url = "https://tjj.harbin.gov.cn/example/gdp-2024.html"

    class CitationResearcher(FakeResearcher):
        async def write_report(self) -> str:
            return f"官方数据[^1]({source_title})"

        def get_source_urls(self) -> list[str]:
            return [source_url]

        def get_research_sources(self) -> list[dict[str, str]]:
            return [{"title": source_title, "url": source_url}]

    monkeypatch.setattr(
        main.research_worker,
        "load_gpt_researcher",
        lambda: CitationResearcher,
    )
    monkeypatch.setattr(main, "research_executor", InProcessExecutor())

    response = TestClient(main.app).post(
        "/research",
        json={
            "systemPrompt": "Expert identity.",
            "task": "Research task.",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["report"] == f"官方数据[^1]({source_url})"
    diagnostic = next(
        event
        for event in body["events"]
        if event["type"] == "gptr.citations.normalized"
    )
    assert diagnostic["data"]["replacements"] == 1
