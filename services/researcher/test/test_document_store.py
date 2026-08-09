from __future__ import annotations

from io import BytesIO
import json

import pytest

from app.document_store import DocumentLimits, DocumentStore, DocumentStoreError


def test_upload_is_stored_under_task_and_reopened_by_document_id(tmp_path) -> None:
    store = DocumentStore(tmp_path)
    record = store.register_upload("task-1", "notes.txt", BytesIO(b"private notes"))

    assert record.media_type == "text/plain"
    assert record.locator == f"document:{record.document_id}"
    reopened, stream = store.open("task-1", record.document_id)
    assert reopened == record
    assert stream.read() == b"private notes"
    stream.close()
    assert list(tmp_path.glob("task-1/*/content.txt"))


def test_upload_rejects_oversized_and_unsupported_files(tmp_path) -> None:
    store = DocumentStore(tmp_path, DocumentLimits(max_bytes=4))
    with pytest.raises(DocumentStoreError) as oversized:
        store.register_upload("task-1", "notes.txt", BytesIO(b"12345"))
    assert oversized.value.code == "document_too_large"

    with pytest.raises(DocumentStoreError) as unsupported:
        store.register_upload("task-1", "archive.zip", BytesIO(b"PK\x03\x04"))
    assert unsupported.value.code == "document_type_invalid"


def test_upload_limits_can_be_configured_from_environment(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("LOCAL_DOCUMENT_MAX_BYTES", "4")
    store = DocumentStore(tmp_path)

    with pytest.raises(DocumentStoreError) as captured:
        store.register_upload("task-1", "notes.txt", BytesIO(b"12345"))

    assert captured.value.code == "document_too_large"


def test_document_id_cannot_escape_task_directory(tmp_path) -> None:
    store = DocumentStore(tmp_path)
    with pytest.raises(DocumentStoreError) as captured:
        store.open("task-1", "../other")
    assert captured.value.code == "document_identifier_invalid"


def test_opens_document_record_written_by_web_upload_store(tmp_path) -> None:
    document_root = tmp_path / "task-web" / "doc_web"
    document_root.mkdir(parents=True)
    content = b"uploaded from the web"
    (document_root / "content.txt").write_bytes(content)
    (document_root / "record.json").write_text(
        json.dumps(
            {
                "documentId": "doc_web",
                "taskId": "task-web",
                "displayName": "web.txt",
                "mediaType": "text/plain",
                "byteSize": len(content),
                "sha256": "test-digest",
                "locator": "document:doc_web",
                "status": "ready",
            }
        ),
        encoding="utf-8",
    )

    record, stream = DocumentStore(tmp_path).open("task-web", "doc_web")

    assert record.document_id == "doc_web"
    assert stream.read() == content
    stream.close()
