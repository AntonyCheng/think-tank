"""Drop research sources that a retriever returned but that are not actually
about the research topic.

Chinese-mainland search engines (and DuckDuckGo under load) periodically answer a
query with unrelated content-farm pages. Deep research amplifies this because it
fans out into many nested searches. This module scores every collected source
against the topic with the embedding model that is already configured for the
run and removes the ones that are clearly off-topic, before the sources reach
the report writer or the citation list.
"""
from __future__ import annotations

import math
import os
from collections.abc import Sequence
from typing import Any

import httpx

# Cosine similarity below this is treated as "not about the topic". Chosen
# empirically: on-topic Chinese news/analysis pages score ~0.35-0.6 against a
# topic sentence with the m3e model; unrelated pages score < 0.15.
_DEFAULT_THRESHOLD = 0.18
_SNIPPET_CHARS = 600
_MAX_SOURCES = 80
_HTTP_TIMEOUT = 20.0


def _threshold() -> float:
    raw = os.getenv("GPTR_SOURCE_RELEVANCE_MIN_COSINE", "").strip()
    try:
        value = float(raw)
    except ValueError:
        return _DEFAULT_THRESHOLD
    return value if 0.0 <= value < 1.0 else _DEFAULT_THRESHOLD


def relevance_filtering_enabled() -> bool:
    return os.getenv("GPTR_SOURCE_RELEVANCE_FILTER", "1").strip().lower() not in {
        "0",
        "false",
        "off",
        "",
    }


async def _embed(
    texts: Sequence[str],
    *,
    base_url: str,
    api_key: str,
    model: str,
) -> list[list[float]]:
    payload = {"input": list(texts), "model": model}
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    url = base_url.rstrip("/") + "/embeddings"
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT, trust_env=False) as client:
        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()
    rows = sorted(data.get("data", []), key=lambda row: row.get("index", 0))
    return [row["embedding"] for row in rows]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def _record_probe(record: dict[str, Any]) -> str:
    title = str(record.get("title") or "").strip()
    text = str(record.get("text") or record.get("raw_content") or "").strip()
    probe = f"{title}\n{text}" if title and title not in text else (text or title)
    return probe[:_SNIPPET_CHARS].strip()


async def score_sources(
    topic: str,
    records: Sequence[dict[str, Any]],
    *,
    embedding_base_url: str,
    embedding_api_key: str,
    embedding_model: str,
) -> dict[str, float]:
    """Return {url: cosine similarity to the topic} for records that carry text.

    Records without a usable text probe are omitted from the result; callers
    should treat "missing" as "unknown / keep".
    """
    probes: list[str] = []
    urls: list[str] = []
    for record in records:
        url = str(record.get("url") or record.get("href") or "").strip()
        probe = _record_probe(record)
        if not url or not probe:
            continue
        urls.append(url)
        probes.append(probe)
        if len(urls) >= _MAX_SOURCES:
            break
    if not probes:
        return {}
    vectors = await _embed(
        [topic, *probes],
        base_url=embedding_base_url,
        api_key=embedding_api_key,
        model=embedding_model,
    )
    topic_vec, source_vecs = vectors[0], vectors[1:]
    return {
        url: _cosine(topic_vec, vec)
        for url, vec in zip(urls, source_vecs)
    }


def partition_by_relevance(
    records: Sequence[dict[str, Any]],
    scores: dict[str, float],
    *,
    threshold: float | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split records into (kept, dropped). Records with no score are kept."""
    cutoff = _threshold() if threshold is None else threshold
    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for record in records:
        url = str(record.get("url") or record.get("href") or "").strip()
        score = scores.get(url)
        if score is None or score >= cutoff:
            kept.append(record)
        else:
            dropped.append(record)
    return kept, dropped
