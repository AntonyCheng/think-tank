from __future__ import annotations

import asyncio
from io import BytesIO

import pytest

from app import document_extractors
from app.document_extractors import extract_document, materialize_private_document
from app.document_store import DocumentStore, DocumentStoreError
from app.ocr_client import OcrResult, OcrUnavailableError


def test_extracts_complete_private_evidence(tmp_path) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload("task-1", "notes.md", BytesIO(b"# Private\n\nEvidence"))

    evidence = extract_document(store, "task-1", record.document_id)

    assert evidence.locator == record.locator
    assert evidence.text == "# Private\n\nEvidence"
    assert not evidence.truncated
    assert not evidence.needs_ocr


def test_decodes_non_utf8_text_without_failing(tmp_path) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload(
        "task-1",
        "notes.txt",
        BytesIO("研究证据".encode("gb18030")),
    )

    evidence = extract_document(store, "task-1", record.document_id)

    assert evidence.text == "研究证据"


def test_extracts_csv_as_markdown_without_exposing_file_path(tmp_path) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload(
        "task-1",
        "rows.csv",
        BytesIO(b"name,city\nAlphaCorp,Shanghai\n"),
    )

    evidence = extract_document(store, "task-1", record.document_id)

    assert "AlphaCorp" in evidence.text
    assert "Shanghai" in evidence.text
    assert str(tmp_path) not in evidence.text


def test_rejects_empty_document(tmp_path) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload("task-1", "blank.txt", BytesIO(b"   \n\n"))

    with pytest.raises(DocumentStoreError) as error:
        extract_document(store, "task-1", record.document_id)
    assert error.value.code == "document_content_empty"


_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def test_extract_document_signals_needs_ocr_for_images(tmp_path) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload("task-1", "scan.png", BytesIO(_PNG))

    with pytest.raises(DocumentStoreError) as error:
        extract_document(store, "task-1", record.document_id)
    assert error.value.code == "document_needs_ocr"


def test_materialize_routes_images_through_ocr(tmp_path, monkeypatch) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload("task-1", "scan.png", BytesIO(_PNG))
    seen: dict[str, object] = {}

    async def fake_ocr(body: bytes, *, media_type: str, profile: str = "mobile") -> OcrResult:
        seen["media_type"] = media_type
        return OcrResult(
            markdown="# 扫描件\n\n识别正文",
            page_count=1,
            character_count=8,
            average_confidence=0.88,
            profile="mobile",
            warnings=("置信度较低",),
        )

    monkeypatch.setattr(document_extractors, "ocr_document", fake_ocr)
    events: list[str] = []

    async def emit(event_type: str, _: dict) -> None:
        events.append(event_type)

    evidence = asyncio.run(
        materialize_private_document(store, "task-1", record.document_id, emit=emit)
    )

    assert evidence.needs_ocr
    assert evidence.text == "# 扫描件\n\n识别正文"
    assert evidence.warnings == ("置信度较低",)
    assert seen["media_type"] == "image/png"
    assert events == ["document.ocr_started", "document.ocr_completed"]


def test_materialize_reports_when_ocr_unavailable(tmp_path, monkeypatch) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload("task-1", "scan.png", BytesIO(_PNG))

    async def broken_ocr(*_args, **_kwargs) -> OcrResult:
        raise OcrUnavailableError("down")

    monkeypatch.setattr(document_extractors, "ocr_document", broken_ocr)

    with pytest.raises(DocumentStoreError) as error:
        asyncio.run(materialize_private_document(store, "task-1", record.document_id))
    assert error.value.code == "document_ocr_unavailable"


def test_materialize_keeps_text_documents_off_the_ocr_path(tmp_path, monkeypatch) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload("task-1", "notes.md", BytesIO(b"# Local\n\nEvidence"))

    async def fail(*_args, **_kwargs) -> OcrResult:
        raise AssertionError("OCR must not be called for text documents")

    monkeypatch.setattr(document_extractors, "ocr_document", fail)
    evidence = asyncio.run(
        materialize_private_document(store, "task-1", record.document_id)
    )
    assert not evidence.needs_ocr
    assert evidence.text == "# Local\n\nEvidence"


def test_text_is_not_limited_by_environment(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_DOCUMENT_MAX_TEXT_CHARACTERS", "7")
    store = DocumentStore(tmp_path)
    record = store.register_upload(
        "task-1",
        "notes.txt",
        BytesIO(b"evidence text"),
    )

    evidence = extract_document(store, "task-1", record.document_id)

    assert evidence.text == "evidence text"
    assert not evidence.truncated
