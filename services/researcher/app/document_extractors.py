from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import anydoc

from .document_store import DocumentRecord, DocumentStore, DocumentStoreError
from .ocr_client import OcrFailedError, OcrResult, OcrUnavailableError, ocr_document


# Media types that carry no reliable binary signature. anydoc needs an explicit
# format hint for these; everything else is detected from the bytes themselves.
_ANYDOC_FORMAT_HINT: dict[str, str] = {
    "text/csv": "csv",
}

# Text formats that are already Markdown-ready (or close enough) and never need
# a document engine.
_PLAIN_TEXT_MEDIA_TYPES = {"text/plain", "text/markdown"}

# Image uploads always go straight to OCR - anydoc has no image path.
_IMAGE_MEDIA_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/tiff",
    "image/bmp",
}

EmitEvent = Callable[[str, dict[str, object]], Awaitable[None]]


@dataclass(frozen=True)
class PrivateDocumentEvidence:
    document_id: str
    locator: str
    title: str
    media_type: str
    text: str
    original_characters: int
    truncated: bool
    needs_ocr: bool = False
    warnings: tuple[str, ...] = ()


def _normalize(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def _evidence(
    record: DocumentRecord,
    text: str,
    *,
    needs_ocr: bool,
    warnings: tuple[str, ...] = (),
) -> PrivateDocumentEvidence:
    normalized = _normalize(text)
    if not normalized:
        raise DocumentStoreError(
            "document_content_empty",
            "The document contains no extractable text.",
        )
    return PrivateDocumentEvidence(
        document_id=record.document_id,
        locator=record.locator,
        title="本地文档",
        media_type=record.media_type,
        text=normalized,
        original_characters=len(normalized),
        truncated=False,
        needs_ocr=needs_ocr,
        warnings=warnings,
    )


def extract_document(
    store: DocumentStore,
    task_id: str,
    document_id: str,
) -> PrivateDocumentEvidence:
    """Synchronous extraction without OCR. Scanned documents raise a signal."""
    record, stream = store.open(task_id, document_id)
    try:
        body = stream.read()
    finally:
        stream.close()
    if record.media_type in _IMAGE_MEDIA_TYPES:
        raise DocumentStoreError(
            "document_needs_ocr",
            "The image needs OCR, which is not available in this path.",
        )
    text, needs_ocr = _extract(record, body)
    if needs_ocr:
        raise DocumentStoreError(
            "document_needs_ocr",
            "The document appears to be scanned and needs OCR.",
        )
    return _evidence(record, text, needs_ocr=False)


async def materialize_private_document(
    store: DocumentStore,
    task_id: str,
    document_id: str,
    *,
    emit: EmitEvent | None = None,
) -> PrivateDocumentEvidence:
    """Extraction with the OCR sidecar as a fallback for scanned pages/images."""
    record, stream = store.open(task_id, document_id)
    try:
        body = stream.read()
    finally:
        stream.close()

    is_image = record.media_type in _IMAGE_MEDIA_TYPES
    if not is_image:
        text, needs_ocr = _extract(record, body)
        if not needs_ocr:
            return _evidence(record, text, needs_ocr=False)

    if emit is not None:
        await emit(
            "document.ocr_started",
            {"documentId": document_id, "mediaType": record.media_type},
        )
    try:
        ocr = await ocr_document(body, media_type=record.media_type)
    except OcrUnavailableError as exc:
        raise DocumentStoreError(
            "document_ocr_unavailable",
            "The document is scanned and the OCR service is unavailable.",
        ) from exc
    except OcrFailedError as exc:
        raise DocumentStoreError(
            "document_ocr_failed",
            f"OCR could not read the document: {exc}",
        ) from exc
    if emit is not None:
        await emit("document.ocr_completed", _ocr_event(document_id, ocr))
    return _evidence(
        record,
        ocr.markdown,
        needs_ocr=True,
        warnings=tuple(ocr.warnings),
    )


def _ocr_event(document_id: str, ocr: OcrResult) -> dict[str, object]:
    return {
        "documentId": document_id,
        "profile": ocr.profile,
        "pageCount": ocr.page_count,
        "characterCount": ocr.character_count,
        "averageConfidence": ocr.average_confidence,
    }


def _extract(record: DocumentRecord, body: bytes) -> tuple[str, bool]:
    """Return (markdown_text, needs_ocr)."""
    if record.media_type in _PLAIN_TEXT_MEDIA_TYPES:
        return _decode_text(body), False

    format_hint = _ANYDOC_FORMAT_HINT.get(record.media_type)
    try:
        if format_hint is None:
            return anydoc.to_markdown_bytes(body), False
        return anydoc.to_markdown_bytes(body, format_hint), False
    except anydoc.NeedsOcrError:
        # Scanned / image-only pages. The OCR fallback is wired separately; for
        # now surface a clear, recoverable signal instead of an opaque failure.
        return "", True
    except anydoc.EncryptedError as exc:
        raise DocumentStoreError(
            "document_encrypted",
            "The document is password protected. Upload an unlocked copy.",
        ) from exc
    except anydoc.UnsupportedError as exc:
        raise DocumentStoreError(
            "document_type_invalid",
            "The document format is not supported.",
        ) from exc
    except anydoc.ResourceLimitError as exc:
        raise DocumentStoreError(
            "document_too_complex",
            "The document structure exceeds the safe processing limit.",
        ) from exc
    except anydoc.ConvertError as exc:
        raise DocumentStoreError(
            "document_parse_failed",
            f"The document could not be parsed: {exc}",
        ) from exc


def _decode_text(body: bytes) -> str:
    for encoding in ("utf-8", "gb18030", "utf-16"):
        try:
            return body.decode(encoding)
        except UnicodeDecodeError:
            continue
    return body.decode("utf-8", errors="replace")
