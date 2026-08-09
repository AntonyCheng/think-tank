from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

import fitz
from docx import Document

from .document_store import DocumentRecord, DocumentStore, DocumentStoreError


@dataclass(frozen=True)
class PrivateDocumentEvidence:
    document_id: str
    locator: str
    title: str
    media_type: str
    text: str
    original_characters: int
    truncated: bool


def extract_document(
    store: DocumentStore,
    task_id: str,
    document_id: str,
) -> PrivateDocumentEvidence:
    record, stream = store.open(task_id, document_id)
    try:
        body = stream.read()
    finally:
        stream.close()
    text = _extract(record, body)
    normalized = "\n".join(line.strip() for line in text.splitlines() if line.strip()).strip()
    if not normalized:
        raise DocumentStoreError("document_content_empty", "The document contains no extractable text.")
    return PrivateDocumentEvidence(
        document_id=record.document_id,
        locator=record.locator,
        title="本地文档",
        media_type=record.media_type,
        text=normalized,
        original_characters=len(normalized),
        truncated=False,
    )


def _extract(record: DocumentRecord, body: bytes) -> str:
    if record.media_type in {"text/plain", "text/markdown"}:
        return body.decode("utf-8")
    if record.media_type == "application/pdf":
        document = fitz.open(stream=body, filetype="pdf")
        try:
            return "\n\n".join(page.get_text("text") for page in document)
        finally:
            document.close()
    if record.media_type.endswith("wordprocessingml.document"):
        document = Document(BytesIO(body))
        return "\n".join(paragraph.text for paragraph in document.paragraphs)
    raise DocumentStoreError("document_type_invalid", "The document type is not supported.")
