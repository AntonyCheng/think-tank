from __future__ import annotations

import asyncio

import httpx
import pytest

from app import ocr_client
from app.ocr_client import OcrFailedError, OcrUnavailableError, ocr_document


def _client_with(handler, monkeypatch) -> None:
    transport = httpx.MockTransport(handler)

    class _Client(httpx.AsyncClient):
        def __init__(self, *args, **kwargs) -> None:
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(ocr_client.httpx, "AsyncClient", _Client)
    monkeypatch.setenv("OCR_SERVICE_URL", "http://ocr.test")


def test_ocr_document_returns_markdown(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.content
        return httpx.Response(
            200,
            json={
                "markdown": "# 扫描件\n\n正文",
                "pageCount": 1,
                "characterCount": 6,
                "averageConfidence": 0.91,
                "profile": "mobile",
                "warnings": ["置信度偏低"],
            },
        )

    _client_with(handler, monkeypatch)
    result = asyncio.run(ocr_document(b"\x89PNG\r\n\x1a\n0", media_type="image/png"))

    assert result.markdown == "# 扫描件\n\n正文"
    assert result.average_confidence == 0.91
    assert result.warnings == ("置信度偏低",)
    assert captured["url"] == "http://ocr.test/ocr"
    assert b"document.png" in captured["body"]


def test_ocr_document_raises_when_service_unconfigured(monkeypatch) -> None:
    monkeypatch.delenv("OCR_SERVICE_URL", raising=False)
    with pytest.raises(OcrUnavailableError):
        asyncio.run(ocr_document(b"data", media_type="image/png"))


def test_ocr_document_raises_on_server_error(monkeypatch) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"detail": {"code": "ocr_failed", "message": "boom"}})

    _client_with(handler, monkeypatch)
    with pytest.raises(OcrFailedError, match="boom"):
        asyncio.run(ocr_document(b"data", media_type="image/png"))


def test_ocr_document_raises_when_unreachable(monkeypatch) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    _client_with(handler, monkeypatch)
    with pytest.raises(OcrUnavailableError):
        asyncio.run(ocr_document(b"data", media_type="image/png"))
