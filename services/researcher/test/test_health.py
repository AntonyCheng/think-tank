from fastapi.testclient import TestClient

import app.main as main
from app.main import app
from app.retriever_runtime import (
    RetrieverCapability,
    RetrieverCatalog,
)


def test_health() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


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
