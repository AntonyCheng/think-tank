from __future__ import annotations

import asyncio
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import anyio
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .ocr_runtime import OcrRuntime

_MAX_UPLOAD_BYTES = int(os.getenv("OCR_MAX_UPLOAD_BYTES", str(40 * 1024 * 1024)))

runtime = OcrRuntime()
_warmup_state = {"ready": False}


async def _warmup() -> None:
    try:
        await anyio.to_thread.run_sync(runtime.warmup)
        _warmup_state["ready"] = True
    except Exception:  # noqa: BLE001 - warmup is best-effort; /ocr will retry
        pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    task: asyncio.Task[None] | None = None
    if os.getenv("OCR_WARMUP", "true").lower() != "false":
        task = asyncio.create_task(_warmup())
    yield
    if task is not None and not task.done():
        task.cancel()


app = FastAPI(title="think-tank OCR", lifespan=lifespan)


class OcrResponse(BaseModel):
    markdown: str
    pageCount: int | None
    characterCount: int
    averageConfidence: float | None
    profile: str
    warnings: list[str]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, str]:
    return {"status": "ready" if runtime else "starting"}


def _sniff_suffix(body: bytes, fallback: str) -> str:
    if body.startswith(b"%PDF-"):
        return ".pdf"
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if body.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if body.startswith(b"BM"):
        return ".bmp"
    if body[:4] in (b"II*\x00", b"MM\x00*"):
        return ".tiff"
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return ".webp"
    return fallback


@app.post("/ocr", response_model=OcrResponse)
async def ocr(
    file: UploadFile = File(...),
    profile: Literal["mobile", "server"] = Form("mobile"),
) -> OcrResponse:
    body = await file.read()
    if not body:
        raise HTTPException(status_code=422, detail={"code": "ocr_empty_upload", "message": "The uploaded file is empty."})
    if len(body) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail={"code": "ocr_upload_too_large", "message": "The uploaded file exceeds the OCR size limit."})

    named = Path(file.filename or "upload").suffix.lower()
    suffix = named if named in {".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"} else _sniff_suffix(body, ".png")
    with tempfile.TemporaryDirectory(prefix="tt-ocr-") as directory:
        source = Path(directory) / f"source{suffix}"
        source.write_bytes(body)
        try:
            result = await anyio.to_thread.run_sync(runtime.extract, source, profile)
        except Exception as exc:  # noqa: BLE001 - report a structured failure
            raise HTTPException(
                status_code=502,
                detail={"code": "ocr_failed", "message": str(exc)[:800]},
            ) from exc

    return OcrResponse(
        markdown=result.markdown,
        pageCount=result.page_count,
        characterCount=result.character_count,
        averageConfidence=result.average_confidence,
        profile=result.profile,
        warnings=result.warnings,
    )
