import asyncio

from app import source_relevance
from app.source_relevance import partition_by_relevance, score_sources


def test_partition_keeps_unscored_and_high_scoring_records() -> None:
    records = [
        {"url": "https://a.example", "title": "on topic", "text": "..."},
        {"url": "https://b.example", "title": "off topic", "text": "..."},
        {"url": "https://c.example", "title": "unknown", "text": "..."},
    ]
    scores = {"https://a.example": 0.42, "https://b.example": 0.04}
    kept, dropped = partition_by_relevance(records, scores, threshold=0.18)
    assert [r["url"] for r in kept] == ["https://a.example", "https://c.example"]
    assert [r["url"] for r in dropped] == ["https://b.example"]


def test_score_sources_uses_the_embedding_endpoint(monkeypatch) -> None:
    seen = {}

    async def fake_embed(texts, *, base_url, api_key, model):
        seen["texts"] = list(texts)
        seen["model"] = model
        # topic vector, then one aligned + one orthogonal source vector
        return [[1.0, 0.0], [1.0, 0.0], [0.0, 1.0]]

    monkeypatch.setattr(source_relevance, "_embed", fake_embed)
    records = [
        {"url": "https://match.example", "title": "T", "text": "aligned body"},
        {"url": "https://junk.example", "title": "T2", "text": "orthogonal body"},
    ]
    scores = asyncio.run(
        score_sources(
            "研究主题",
            records,
            embedding_base_url="http://embed.local/v1",
            embedding_api_key="k",
            embedding_model="m3e",
        )
    )
    assert seen["texts"][0] == "研究主题"
    assert seen["model"] == "m3e"
    assert scores["https://match.example"] > 0.9
    assert scores["https://junk.example"] < 0.1


def test_relevance_filtering_toggle(monkeypatch) -> None:
    monkeypatch.delenv("GPTR_SOURCE_RELEVANCE_FILTER", raising=False)
    assert source_relevance.relevance_filtering_enabled() is True
    monkeypatch.setenv("GPTR_SOURCE_RELEVANCE_FILTER", "0")
    assert source_relevance.relevance_filtering_enabled() is False
