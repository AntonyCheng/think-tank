from __future__ import annotations

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from .contracts import ResearchEvent, ResearchRequest, ResearchResponse
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
