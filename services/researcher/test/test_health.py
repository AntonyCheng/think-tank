import json
from pathlib import Path

from fastapi.testclient import TestClient

import app.main as main
from app.main import app
from app.retriever_runtime import (
    RetrieverCapability,
    RetrieverCatalog,
)
from app.source_access import MaterializedSource, MaterializedSourceSet


def test_health() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_loads_project_env_without_overriding_deployment_values(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "GPTR_ENABLED_RETRIEVERS=duckduckgo,tavily\n"
        "TAVILY_API_KEY=from-dotenv\n"
        "OPENAI_API_KEY=from-dotenv\n",
        encoding="utf-8",
    )
    environment = {"OPENAI_API_KEY": "from-deployment"}

    main.load_project_environment(environment, env_file=env_file)

    assert environment == {
        "GPTR_ENABLED_RETRIEVERS": "duckduckgo,tavily",
        "TAVILY_API_KEY": "from-dotenv",
        "OPENAI_API_KEY": "from-deployment",
    }


def test_ready_loads_gptr_adapter(monkeypatch) -> None:
    monkeypatch.setattr(main, "load_gpt_researcher", lambda: object)
    monkeypatch.setattr(
        main,
        "build_retriever_catalog",
        lambda _environment: RetrieverCatalog(
            retrievers=(
                RetrieverCapability(
                    id="duckduckgo",
                    label="DuckDuckGo",
                    category="web",
                    credential_required=False,
                    timeout_ms=20000,
                ),
            ),
            max_retrievers=1,
        ),
    )

    response = TestClient(app).get("/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_ready_requires_at_least_one_ready_retriever(monkeypatch) -> None:
    monkeypatch.setattr(main, "load_gpt_researcher", lambda: object)
    monkeypatch.setattr(
        main,
        "build_retriever_catalog",
        lambda _environment: RetrieverCatalog(
            retrievers=(),
            max_retrievers=0,
        ),
    )

    response = TestClient(app).get("/ready")

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "No configured GPTR retriever is ready."
    )


def test_capabilities_exposes_safe_retriever_catalog(monkeypatch) -> None:
    monkeypatch.setattr(
        main,
        "build_retriever_catalog",
        lambda _environment: RetrieverCatalog(
            retrievers=(
                RetrieverCapability(
                    id="duckduckgo",
                    label="DuckDuckGo",
                    category="web",
                    credential_required=False,
                    timeout_ms=20000,
                ),
                RetrieverCapability(
                    id="openalex",
                    label="OpenAlex",
                    category="academic",
                    credential_required=False,
                    timeout_ms=20000,
                ),
            ),
            max_retrievers=2,
        ),
    )

    response = TestClient(app).get("/capabilities")

    assert response.status_code == 200
    assert response.json() == {
        "schemaVersion": 1,
        "retrievers": [
            {
                "id": "duckduckgo",
                "label": "DuckDuckGo",
                "category": "web",
                "selectable": True,
                "credentialRequired": False,
                "timeoutMs": 20000,
            },
            {
                "id": "openalex",
                "label": "OpenAlex",
                "category": "academic",
                "selectable": True,
                "credentialRequired": False,
                "timeoutMs": 20000,
            },
        ],
        "maxRetrievers": 2,
    }


def test_editor_search_uses_only_configured_retrievers(monkeypatch) -> None:
    monkeypatch.setattr(
        main,
        "build_retriever_catalog",
        lambda _environment: RetrieverCatalog(
            retrievers=(
                RetrieverCapability(
                    id="duckduckgo",
                    label="DuckDuckGo",
                    category="web",
                    credential_required=False,
                    timeout_ms=20_000,
                ),
            ),
            max_retrievers=1,
        ),
    )

    async def search(query, retrievers, *, limit, timeout_ms):
        assert query == "UK inflation"
        assert retrievers == ("duckduckgo",)
        assert limit == 8
        assert timeout_ms == 20_000
        return [
            {
                "provider": "duckduckgo",
                "title": "Official statistics",
                "url": "https://example.com/statistics",
                "snippet": "Latest release",
            }
        ], {"configured": ["duckduckgo"]}

    monkeypatch.setattr(main, "search_editor_sources", search)

    response = TestClient(app).post(
        "/search",
        json={
            "query": "UK inflation",
            "retrievers": ["duckduckgo"],
        },
    )

    assert response.status_code == 200
    assert response.json()["results"][0]["url"] == (
        "https://example.com/statistics"
    )


def test_editor_research_reads_the_page_body(monkeypatch) -> None:
    monkeypatch.setattr(
        main,
        "build_retriever_catalog",
        lambda _environment: RetrieverCatalog(
            retrievers=(RetrieverCapability(
                id="duckduckgo",
                label="DuckDuckGo",
                category="web",
                credential_required=False,
                timeout_ms=20_000,
            ),),
            max_retrievers=1,
        ),
    )

    class Materializer:
        async def materialize(self, urls):
            url = urls[0]
            return MaterializedSourceSet((MaterializedSource(
                requested_url=url,
                canonical_url=url,
                title="Harbin profile",
                media_type="text/html",
                text="Harbin is introduced through its history and ice tourism.",
                byte_size=128,
            ),), 128)

    monkeypatch.setattr(main, "default_source_materializer", Materializer)
    response = TestClient(app).post(
        "/editor/research",
        json={
            "urls": ["https://example.com/harbin"],
            "retrievers": ["duckduckgo"],
        },
    )
    assert response.status_code == 200
    source = response.json()["sources"][0]
    assert source["fetchStatus"] == "fetched"
    assert "ice tourism" in source["content"]
