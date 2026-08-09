from __future__ import annotations

from io import BytesIO

import fitz

from app.document_extractors import extract_document
from app.document_store import DocumentStore


def test_extracts_complete_private_evidence(tmp_path) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload("task-1", "notes.md", BytesIO(b"# Private\n\nEvidence"))

    evidence = extract_document(store, "task-1", record.document_id)

    assert evidence.locator == record.locator
    assert evidence.text == "# Private\nEvidence"
    assert not evidence.truncated


def test_extracts_pdf_text_without_exposing_file_path(tmp_path) -> None:
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "Private PDF evidence")
    body = document.tobytes()
    document.close()
    store = DocumentStore(tmp_path)
    record = store.register_upload("task-1", "report.pdf", BytesIO(body))

    evidence = extract_document(store, "task-1", record.document_id)

    assert "Private PDF evidence" in evidence.text
    assert "tmp_path" not in evidence.text


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
