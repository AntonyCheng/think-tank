from __future__ import annotations

from io import BytesIO

import pytest

from app.document_extractors import extract_document
from app.document_store import DocumentStore, DocumentStoreError


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
