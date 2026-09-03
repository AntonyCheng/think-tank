from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO


@dataclass(frozen=True)
class DocumentLimits:
    max_bytes: int = 25 * 1024 * 1024
    max_task_bytes: int = 100 * 1024 * 1024
    max_count: int = 20


@dataclass(frozen=True)
class DocumentRecord:
    document_id: str
    task_id: str
    display_name: str
    media_type: str
    byte_size: int
    sha256: str
    locator: str
    status: str = "ready"


class DocumentStoreError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class DocumentStore:
    def __init__(
        self,
        root: Path | None = None,
        limits: DocumentLimits | None = None,
    ) -> None:
        self._root = (root or Path(os.getenv(
            "LOCAL_DOCUMENTS_ROOT", ".think-tank/documents"
        )).resolve())
        self._limits = limits or DocumentLimits(
            max_bytes=_positive_environment_integer(
                "LOCAL_DOCUMENT_MAX_BYTES", 25 * 1024 * 1024
            ),
            max_task_bytes=_positive_environment_integer(
                "LOCAL_DOCUMENT_TASK_MAX_BYTES", 100 * 1024 * 1024
            ),
            max_count=_positive_environment_integer(
                "LOCAL_DOCUMENT_MAX_COUNT", 20
            ),
        )

    def register_upload(
        self,
        task_id: str,
        display_name: str,
        stream: BinaryIO,
    ) -> DocumentRecord:
        self._assert_identifier(task_id, "task")
        clean_name = self._display_name(display_name)
        task_root = self._task_root(task_id)
        existing = self.list(task_id)
        if len(existing) >= self._limits.max_count:
            raise DocumentStoreError("document_count_exceeded", "The task has reached its document limit.")
        document_id = f"doc_{secrets.token_urlsafe(18)}"
        document_root = task_root / document_id
        document_root.mkdir(parents=True, exist_ok=False)
        temporary = document_root / "upload.tmp"
        digest = hashlib.sha256()
        size = 0
        try:
            with temporary.open("xb") as destination:
                while chunk := stream.read(64 * 1024):
                    size += len(chunk)
                    if size > self._limits.max_bytes:
                        raise DocumentStoreError("document_too_large", "The document exceeds the per-file size limit.")
                    digest.update(chunk)
                    destination.write(chunk)
            if sum(item.byte_size for item in existing) + size > self._limits.max_task_bytes:
                raise DocumentStoreError("document_task_too_large", "The documents exceed the task size limit.")
            media_type = _detect_media_type(temporary, clean_name)
            content_path = document_root / _storage_name(media_type)
            temporary.replace(content_path)
            record = DocumentRecord(
                document_id=document_id,
                task_id=task_id,
                display_name=clean_name,
                media_type=media_type,
                byte_size=size,
                sha256=digest.hexdigest(),
                locator=f"document:{document_id}",
            )
            (document_root / "record.json").write_text(
                json.dumps(asdict(record), ensure_ascii=False), encoding="utf-8"
            )
            return record
        except Exception:
            for path in document_root.glob("*"):
                path.unlink(missing_ok=True)
            document_root.rmdir()
            raise

    def list(self, task_id: str) -> tuple[DocumentRecord, ...]:
        task_root = self._task_root(task_id)
        if not task_root.exists():
            return ()
        records: list[DocumentRecord] = []
        for record_path in task_root.glob("doc_*/record.json"):
            try:
                data = json.loads(record_path.read_text(encoding="utf-8"))
                record = _document_record(data)
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                continue
            if record.task_id == task_id:
                records.append(record)
        return tuple(sorted(records, key=lambda item: item.document_id))

    def open(self, task_id: str, document_id: str) -> tuple[DocumentRecord, BinaryIO]:
        self._assert_identifier(task_id, "task")
        self._assert_identifier(document_id, "document")
        record = next((item for item in self.list(task_id) if item.document_id == document_id), None)
        if record is None:
            raise DocumentStoreError("document_not_found", "The document is not available for this task.")
        path = self._task_root(task_id) / document_id / _storage_name(record.media_type)
        if not path.is_file():
            raise DocumentStoreError("document_not_found", "The document content is not available.")
        return record, path.open("rb")

    def _task_root(self, task_id: str) -> Path:
        self._assert_identifier(task_id, "task")
        path = (self._root / task_id).resolve()
        if path.parent != self._root:
            raise DocumentStoreError("document_path_invalid", "The document path is invalid.")
        return path

    @staticmethod
    def _assert_identifier(value: str, label: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
            raise DocumentStoreError("document_identifier_invalid", f"The {label} identifier is invalid.")

    @staticmethod
    def _display_name(value: str) -> str:
        name = value.strip()
        if not name or len(name) > 180 or any(char in name for char in "\\/\x00"):
            raise DocumentStoreError("document_name_invalid", "The document name is invalid.")
        return name


_OOXML_MEDIA_TYPES = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

_OLE2_MEDIA_TYPES = {
    ".doc": "application/msword",
    ".xls": "application/vnd.ms-excel",
    ".ppt": "application/vnd.ms-powerpoint",
}

_IMAGE_SIGNATURES: tuple[tuple[bytes, frozenset[str], str], ...] = (
    (b"\x89PNG\r\n\x1a\n", frozenset({".png"}), "image/png"),
    (b"\xff\xd8\xff", frozenset({".jpg", ".jpeg"}), "image/jpeg"),
    (b"BM", frozenset({".bmp"}), "image/bmp"),
    (b"II*\x00", frozenset({".tif", ".tiff"}), "image/tiff"),
    (b"MM\x00*", frozenset({".tif", ".tiff"}), "image/tiff"),
)

_STORAGE_NAMES = {
    "application/pdf": "content.pdf",
    "application/msword": "content.doc",
    "application/vnd.ms-excel": "content.xls",
    "application/vnd.ms-powerpoint": "content.ppt",
    _OOXML_MEDIA_TYPES[".docx"]: "content.docx",
    _OOXML_MEDIA_TYPES[".xlsx"]: "content.xlsx",
    _OOXML_MEDIA_TYPES[".pptx"]: "content.pptx",
    "image/png": "content.png",
    "image/jpeg": "content.jpg",
    "image/bmp": "content.bmp",
    "image/tiff": "content.tiff",
    "image/webp": "content.webp",
    "text/csv": "content.csv",
    "text/plain": "content.txt",
    "text/markdown": "content.md",
}


def _detect_media_type(path: Path, display_name: str) -> str:
    header = path.read_bytes()[:16]
    suffix = Path(display_name).suffix.lower()
    if header.startswith(b"%PDF-") and suffix == ".pdf":
        return "application/pdf"
    if header.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") and suffix in _OLE2_MEDIA_TYPES:
        return _OLE2_MEDIA_TYPES[suffix]
    if header.startswith(b"PK\x03\x04") and suffix in _OOXML_MEDIA_TYPES:
        return _OOXML_MEDIA_TYPES[suffix]
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP" and suffix == ".webp":
        return "image/webp"
    for signature, suffixes, media_type in _IMAGE_SIGNATURES:
        if header.startswith(signature) and suffix in suffixes:
            return media_type
    if suffix in {".txt", ".md", ".markdown", ".csv"}:
        try:
            path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            for encoding in ("gb18030", "utf-16"):
                try:
                    path.read_text(encoding=encoding)
                    break
                except UnicodeDecodeError:
                    continue
            else:
                raise DocumentStoreError(
                    "document_type_invalid",
                    "The text document uses an unsupported character encoding.",
                ) from None
        if suffix == ".csv":
            return "text/csv"
        return "text/markdown" if suffix in {".md", ".markdown"} else "text/plain"
    raise DocumentStoreError("document_type_invalid", "The document type is not allowed.")


def _storage_name(media_type: str) -> str:
    return _STORAGE_NAMES[media_type]


def _document_record(data: object) -> DocumentRecord:
    if not isinstance(data, dict):
        raise TypeError("The document record must be an object.")
    return DocumentRecord(
        document_id=(
            data["document_id"]
            if "document_id" in data
            else data["documentId"]
        ),
        task_id=(
            data["task_id"] if "task_id" in data else data["taskId"]
        ),
        display_name=(
            data["display_name"]
            if "display_name" in data
            else data["displayName"]
        ),
        media_type=(
            data["media_type"]
            if "media_type" in data
            else data["mediaType"]
        ),
        byte_size=(
            data["byte_size"]
            if "byte_size" in data
            else data["byteSize"]
        ),
        sha256=data["sha256"],
        locator=data["locator"],
        status=data.get("status", "ready"),
    )


def _positive_environment_integer(name: str, fallback: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return fallback
    value = int(raw)
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer.")
    return value
