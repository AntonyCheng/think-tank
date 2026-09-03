from __future__ import annotations

from starlette.testclient import TestClient

from app import main
from app.main import _sniff_suffix, app
from app.ocr_runtime import OcrExtraction


def test_sniff_suffix_detects_image_and_pdf_signatures() -> None:
    assert _sniff_suffix(b"%PDF-1.7", ".png") == ".pdf"
    assert _sniff_suffix(b"\x89PNG\r\n\x1a\n rest", ".x") == ".png"
    assert _sniff_suffix(b"\xff\xd8\xff\xe0", ".x") == ".jpg"
    assert _sniff_suffix(b"RIFF\x00\x00\x00\x00WEBP", ".x") == ".webp"
    assert _sniff_suffix(b"unknown", ".bin") == ".bin"


def test_health_and_ready() -> None:
    client = TestClient(app)
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").status_code == 200


def test_ocr_endpoint_returns_runtime_result(monkeypatch) -> None:
    def fake_extract(path, profile="mobile") -> OcrExtraction:
        assert path.suffix == ".png"
        return OcrExtraction(
            markdown="<!-- page: 1 -->\n\n识别文本",
            page_count=1,
            character_count=4,
            average_confidence=0.97,
            profile=profile,
            warnings=[],
        )

    monkeypatch.setattr(main.runtime, "extract", fake_extract)
    client = TestClient(app)
    response = client.post(
        "/ocr",
        files={"file": ("scan.png", b"\x89PNG\r\n\x1a\n0", "image/png")},
        data={"profile": "mobile"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["markdown"] == "<!-- page: 1 -->\n\n识别文本"
    assert body["averageConfidence"] == 0.97
    assert body["profile"] == "mobile"


def test_ocr_endpoint_rejects_empty_upload() -> None:
    response = TestClient(app).post("/ocr", files={"file": ("scan.png", b"", "image/png")})
    assert response.status_code == 422
