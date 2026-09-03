"""Client for the think-tank OCR sidecar (thinktank-ocr).

Local documents that anydoc cannot read on its own (scanned PDFs, images) are
sent here for PaddleOCR PP-OCRv5 Chinese recognition.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import httpx


_EXTENSION_BY_MEDIA_TYPE = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/webp": ".webp",
}


class OcrUnavailableError(RuntimeError):
    """The OCR sidecar is not configured or could not be reached."""


class OcrFailedError(RuntimeError):
    """The OCR sidecar rejected or failed the document."""


@dataclass(frozen=True)
class OcrResult:
    markdown: str
    page_count: int | None
    character_count: int
    average_confidence: float | None
    profile: str
    warnings: tuple[str, ...] = field(default_factory=tuple)


def _service_url() -> str:
    url = os.getenv("OCR_SERVICE_URL", "").strip().rstrip("/")
    if not url:
        raise OcrUnavailableError("OCR_SERVICE_URL is not configured.")
    return url


def _timeout_seconds() -> float:
    raw = os.getenv("OCR_TIMEOUT_MS", "").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 180_000
    return max(1.0, value / 1000)


async def ocr_document(
    body: bytes,
    *,
    media_type: str,
    profile: str = "mobile",
) -> OcrResult:
    url = f"{_service_url()}/ocr"
    filename = f"document{_EXTENSION_BY_MEDIA_TYPE.get(media_type, '.bin')}"
    timeout = httpx.Timeout(_timeout_seconds(), connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                url,
                files={"file": (filename, body, media_type)},
                data={"profile": profile},
            )
    except httpx.HTTPError as exc:
        raise OcrUnavailableError(f"The OCR service could not be reached: {exc}") from exc

    if response.status_code >= 500:
        raise OcrFailedError(_detail_message(response))
    if response.status_code >= 400:
        raise OcrFailedError(_detail_message(response))

    payload = response.json()
    return OcrResult(
        markdown=str(payload.get("markdown") or ""),
        page_count=payload.get("pageCount"),
        character_count=int(payload.get("characterCount") or 0),
        average_confidence=payload.get("averageConfidence"),
        profile=str(payload.get("profile") or profile),
        warnings=tuple(payload.get("warnings") or ()),
    )


def _detail_message(response: httpx.Response) -> str:
    try:
        detail = response.json().get("detail")
    except ValueError:
        return f"OCR service returned {response.status_code}."
    if isinstance(detail, dict):
        return str(detail.get("message") or detail)
    return str(detail or f"OCR service returned {response.status_code}.")
