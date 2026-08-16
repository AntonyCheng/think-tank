from __future__ import annotations

import asyncio
from contextlib import suppress
import json
import os
import sys
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator, MutableMapping
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from dotenv import dotenv_values

from .contracts import (
    EditorResearchRequest,
    EditorResearchResponse,
    EditorResearchSource,
    EditorSearchRequest,
    EditorSearchResponse,
    ResearchEvent,
    ResearchRequest,
    ResearchResponse,
)
from .editor_search import search_editor_sources
from .research_profile import ResearchRetriever
from .source_access import SourceAccessError, default_source_materializer
from . import research_worker
from .report_processing import (
    collapse_repeated_report_blocks,
    normalize_citation_links,
    sanitize_report,
)
from .research_executor import (
    ProcessResearchExecutor,
    ResearchExecutionError,
)
from .research_worker import (
    LogCollector,
    execute_gptr_research,
    run_research,
)
from .gptr_compat import load_gpt_researcher
from .retriever_runtime import build_retriever_catalog
from .exporter import export_docx, export_markdown, export_pdf


def load_project_environment(
    environment: MutableMapping[str, str] | None = None,
    *,
    env_file: Path | None = None,
) -> None:
    """Load the project .env once without overriding deployment variables."""
    target = environment if environment is not None else os.environ
    source = env_file or Path(__file__).resolve().parents[3] / ".env"
    for name, value in dotenv_values(source).items():
        if value is not None:
            target.setdefault(name, value)


load_project_environment()


class ExportRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    task_id: str = Field(alias="taskId", min_length=1)
    title: str = Field(min_length=1)
    markdown: str = Field(min_length=1)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await research_executor.close()


app = FastAPI(
    title="Think Tank Researcher",
    version="0.1.0",
    lifespan=lifespan,
)
_editor_search_environment_lock = asyncio.Lock()


@asynccontextmanager
async def _editor_search_credentials(
    api_keys: dict[str, str],
) -> AsyncIterator[None]:
    """Apply request-scoped retriever credentials for editor/search probes."""
    async with _editor_search_environment_lock:
        previous = os.environ.get("TAVILY_API_KEY")
        tavily_api_key = api_keys.get("tavily", "").strip()
        if tavily_api_key:
            os.environ["TAVILY_API_KEY"] = tavily_api_key
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop("TAVILY_API_KEY", None)
            else:
                os.environ["TAVILY_API_KEY"] = previous


async def _search_with_request_credentials(
    query: str,
    retrievers: tuple[ResearchRetriever, ...],
    *,
    limit: int,
    api_keys: dict[str, str],
) -> tuple[list[EditorSearchResult], dict[str, Any]]:
    async with _editor_search_credentials(api_keys):
        catalog = build_retriever_catalog(os.environ)
        available = {item.id: item for item in catalog.retrievers}
        if len(set(retrievers)) != len(retrievers):
            raise ValueError("Retrievers must not contain duplicates.")
        if len(retrievers) > catalog.max_retrievers:
            raise ValueError("Too many retrievers were requested.")
        if any(retriever not in available for retriever in retrievers):
            raise ValueError("A requested retriever is not available.")
        timeout_ms = min(available[retriever].timeout_ms for retriever in retrievers)
        return await search_editor_sources(
            query,
            retrievers,
            limit=limit,
            timeout_ms=timeout_ms,
        )


def mark_redirected_logs_as_utf8() -> None:
    """Make redirected uvicorn logs self-identifying on Windows."""
    if "uvicorn" not in sys.argv[0].lower():
        return
    for stream in (sys.stdout, sys.stderr):
        if not stream.isatty():
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
            stream.write("\ufeff")
            stream.flush()


mark_redirected_logs_as_utf8()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def ready() -> dict[str, str]:
    try:
        load_gpt_researcher()
        catalog = build_retriever_catalog(os.environ)
    except (ImportError, NameError) as exc:
        raise HTTPException(
            status_code=503,
            detail=f"gpt-researcher could not be loaded: {exc}",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not catalog.retrievers:
        raise HTTPException(
            status_code=503,
            detail="No configured GPTR retriever is ready.",
        )
    return {"status": "ready"}


@app.get("/capabilities")
async def capabilities() -> dict[str, Any]:
    try:
        catalog = build_retriever_catalog(os.environ)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "schemaVersion": 1,
        "retrievers": [
            {
                "id": item.id,
                "label": item.label,
                "category": item.category,
                "selectable": True,
                "credentialRequired": item.credential_required,
                "timeoutMs": item.timeout_ms,
            }
            for item in catalog.retrievers
        ],
        "maxRetrievers": catalog.max_retrievers,
    }


@app.post("/search", response_model=EditorSearchResponse)
async def search_editor_sources_endpoint(
    request: EditorSearchRequest,
) -> EditorSearchResponse:
    try:
        requested = tuple(request.retrievers)
        results, summary = await _search_with_request_credentials(
            request.query.strip(),
            requested,
            limit=request.limit,
            api_keys=request.retriever_api_keys,
        )
        return EditorSearchResponse(results=results, summary=summary)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/editor/research", response_model=EditorResearchResponse)
async def research_editor_sources_endpoint(
    request: EditorResearchRequest,
) -> EditorResearchResponse:
    query = request.query.strip() if request.query else ""
    urls = [value.strip() for value in request.urls if value.strip()]
    if not query and not urls:
        raise HTTPException(status_code=422, detail="A query or URL is required.")
    try:
        requested = tuple(request.retrievers)
        results = []
        runtime_summary: dict[str, Any] = {}
        if query:
            results, runtime_summary = await _search_with_request_credentials(
                query,
                requested,
                limit=request.limit,
                api_keys=request.retriever_api_keys,
            )
        else:
            async with _editor_search_credentials(request.retriever_api_keys):
                catalog = build_retriever_catalog(os.environ)
                available = {item.id: item for item in catalog.retrievers}
                if len(set(requested)) != len(requested):
                    raise ValueError("Retrievers must not contain duplicates.")
                if len(requested) > catalog.max_retrievers:
                    raise ValueError("Too many retrievers were requested.")
                if any(retriever not in available for retriever in requested):
                    raise ValueError("A requested retriever is not available.")
        candidates: list[tuple[str, str, str, str | None]] = [
            ("specified_url", url, url, None) for url in urls
        ]
        candidates.extend(
            (result.provider, result.title, result.url, result.snippet)
            for result in results
        )
        seen: set[str] = set()
        unique_candidates: list[tuple[str, str, str, str | None]] = []
        for candidate in candidates:
            if candidate[2] in seen or len(unique_candidates) >= request.limit:
                continue
            seen.add(candidate[2])
            unique_candidates.append(candidate)
        materializer = default_source_materializer()
        semaphore = asyncio.Semaphore(3)

        async def read_candidate(
            candidate: tuple[str, str, str, str | None],
        ) -> EditorResearchSource:
            provider, title, url, snippet = candidate
            try:
                async with semaphore:
                    materialized = await materializer.materialize([url])
                if not materialized.sources:
                    failure = materialized.failures[0] if materialized.failures else None
                    return EditorResearchSource(
                        provider=provider,
                        title=title,
                        url=url,
                        snippet=snippet,
                        fetchStatus="failed",
                        fetchError=failure.message if failure else "The page did not contain readable text.",
                    )
                page = materialized.sources[0]
                return EditorResearchSource(
                    provider=provider,
                    title=page.title or title,
                    url=page.canonical_url,
                    snippet=snippet,
                    content=page.text[:30_000],
                    fetchStatus="fetched",
                )
            except SourceAccessError as exc:
                return EditorResearchSource(
                    provider=provider,
                    title=title,
                    url=url,
                    snippet=snippet,
                    fetchStatus="failed",
                    fetchError=str(exc),
                )

        sources = list(await asyncio.gather(*(
            read_candidate(candidate) for candidate in unique_candidates
        )))
        return EditorResearchResponse(
            query=query or None,
            sources=sources,
            summary={
                **runtime_summary,
                "requested": len(candidates),
                "fetched": sum(source.fetch_status == "fetched" for source in sources),
                "failed": sum(source.fetch_status == "failed" for source in sources),
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/export/{export_format}")
async def export_report(
    export_format: Literal["markdown", "docx", "pdf"],
    request: ExportRequest,
) -> FileResponse:
    export_root = Path(".think-tank") / "exports"
    exporters = {
        "markdown": (
            lambda: export_markdown(
                request.markdown,
                request.task_id,
                export_root,
            ),
            "text/markdown; charset=utf-8",
            "md",
        ),
        "docx": (
            lambda: export_docx(
                request.title,
                request.markdown,
                request.task_id,
                export_root,
            ),
            (
                "application/vnd.openxmlformats-officedocument."
                "wordprocessingml.document"
            ),
            "docx",
        ),
        "pdf": (
            lambda: export_pdf(
                request.title,
                request.markdown,
                request.task_id,
                export_root,
            ),
            "application/pdf",
            "pdf",
        ),
    }
    exporter, media_type, extension = exporters[export_format]
    try:
        path = exporter()
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"report export failed: {exc}",
        ) from exc
    return FileResponse(
        path,
        media_type=media_type,
        filename=f"think-tank-report.{extension}",
    )


@app.post("/research", response_model=ResearchResponse)
async def research(request: ResearchRequest) -> ResearchResponse:
    try:
        return await research_executor.execute(request)
    except ResearchExecutionError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.detail,
        ) from exc


@app.post("/research/stream")
async def research_stream(request: ResearchRequest) -> StreamingResponse:
    async def generate() -> AsyncIterator[str]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        async def publish(event: ResearchEvent) -> None:
            await queue.put({
                "type": "event",
                "event": event.model_dump(),
            })

        async def execute() -> None:
            try:
                result = await research_executor.execute(request, publish)
                await queue.put({
                    "type": "result",
                    "result": result.model_dump(by_alias=True),
                })
            except ResearchExecutionError as exc:
                await queue.put({
                    "type": "error",
                    "error": {
                        "status": exc.status_code,
                        "detail": exc.detail,
                    },
                })
            except HTTPException as exc:
                await queue.put({
                    "type": "error",
                    "error": {
                        "status": exc.status_code,
                        "detail": exc.detail,
                    },
                })
            except Exception as exc:
                await queue.put({
                    "type": "error",
                    "error": {"status": 500, "detail": str(exc)},
                })

        task = asyncio.create_task(execute())
        try:
            while True:
                message = await queue.get()
                yield json.dumps(
                    message,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ) + "\n"
                if message["type"] in {"result", "error"}:
                    break
        finally:
            if not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache"},
    )


def worker_concurrency_from_environment() -> int:
    raw_value = os.getenv("GPTR_WORKER_CONCURRENCY", "2")
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise RuntimeError(
            "GPTR_WORKER_CONCURRENCY must be an integer."
        ) from exc
    if value < 1:
        raise RuntimeError(
            "GPTR_WORKER_CONCURRENCY must be at least 1."
        )
    return value


research_executor = ProcessResearchExecutor(
    engine=execute_gptr_research,
    worker_concurrency=worker_concurrency_from_environment(),
)
