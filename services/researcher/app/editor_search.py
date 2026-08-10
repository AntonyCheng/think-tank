from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .contracts import EditorSearchResult
from .retriever_runtime import (
    RetrieverId,
    _load_gptr_adapter,
    install_retriever_runtime,
)


async def search_editor_sources(
    query: str,
    retrievers: tuple[RetrieverId, ...],
    *,
    limit: int,
    timeout_ms: int,
) -> tuple[list[EditorSearchResult], dict[str, Any]]:
    adapters = [_load_gptr_adapter(retriever) for retriever in retrievers]
    if any(adapter is None for adapter in adapters):
        raise RuntimeError("A configured retriever is unavailable.")
    runtime_host = SimpleNamespace(retrievers=adapters)
    runtime = install_retriever_runtime(
        runtime_host,
        retrievers,
        timeout_ms=timeout_ms,
    )
    calls = [
        asyncio.to_thread(
            lambda retriever=retriever: retriever(query).search(
                max_results=limit,
            )
        )
        for retriever in runtime_host.retrievers
    ]
    responses = await asyncio.gather(*calls)
    seen: set[str] = set()
    results: list[EditorSearchResult] = []
    for provider, response in zip(retrievers, responses, strict=True):
        for result in response or ():
            normalized = _normalize_result(provider, result)
            if normalized is None:
                continue
            key = _canonical_url(normalized.url)
            if not key or key in seen:
                continue
            seen.add(key)
            results.append(normalized)
    return results[:limit], runtime.summary()


def _normalize_result(
    provider: RetrieverId,
    value: Any,
) -> EditorSearchResult | None:
    if not isinstance(value, dict):
        return None
    url = value.get("url") or value.get("href") or value.get("link")
    if not isinstance(url, str) or not _canonical_url(url):
        return None
    title = value.get("title") or value.get("name") or urlsplit(url).hostname
    if not isinstance(title, str) or not title.strip():
        return None
    snippet = value.get("snippet") or value.get("description") or value.get("content")
    return EditorSearchResult(
        provider=provider,
        title=title.strip()[:500],
        url=url.strip(),
        snippet=snippet.strip()[:2_000]
        if isinstance(snippet, str) and snippet.strip()
        else None,
    )


def _canonical_url(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return ""
        path = parsed.path.rstrip("/") or "/"
        return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, ""))
    except ValueError:
        return ""
