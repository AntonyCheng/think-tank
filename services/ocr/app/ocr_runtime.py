"""PaddleOCR PP-OCRv5 runtime for Chinese scanned documents.

Ported from kLegal's document-runtime worker: the same PP-OCRv5 configuration,
row ordering and adaptive mobile -> server escalation, exposed over a small
in-process API instead of a JSON-lines subprocess.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class OcrExtraction:
    markdown: str
    page_count: int | None
    character_count: int
    average_confidence: float | None
    profile: str
    warnings: list[str] = field(default_factory=list)


def _result_data(result: Any) -> dict[str, Any]:
    value = getattr(result, "json", None)
    if callable(value):
        value = value()
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        return {}
    nested = value.get("res")
    return nested if isinstance(nested, dict) else value


def _polygon_position(polygon: Any) -> tuple[float, float]:
    try:
        points = list(polygon)
        xs = [float(point[0]) for point in points]
        ys = [float(point[1]) for point in points]
        return min(ys), min(xs)
    except (TypeError, ValueError, IndexError):
        return 0.0, 0.0


class OcrRuntime:
    """Lazy per-profile PP-OCRv5 engines with adaptive escalation."""

    def __init__(
        self,
        *,
        escalate_below: float = 0.65,
        low_confidence_below: float = 0.75,
    ) -> None:
        self._engines: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._escalate_below = escalate_below
        self._low_confidence_below = low_confidence_below

    def warmup(self) -> None:
        self._engine("mobile")

    def _engine(self, profile: str) -> Any:
        with self._lock:
            if profile in self._engines:
                return self._engines[profile]
            from paddleocr import PaddleOCR

            model_kind = "server" if profile == "server" else "mobile"
            engine = PaddleOCR(
                lang="ch",
                ocr_version="PP-OCRv5",
                text_detection_model_name=f"PP-OCRv5_{model_kind}_det",
                text_recognition_model_name=f"PP-OCRv5_{model_kind}_rec",
                use_doc_orientation_classify=True,
                use_doc_unwarping=False,
                use_textline_orientation=True,
            )
            self._engines[profile] = engine
            return engine

    def _run(self, input_path: Path, profile: str) -> tuple[str, int, float | None]:
        engine = self._engine(profile)
        pages: list[str] = []
        scores: list[float] = []

        for page_number, result in enumerate(
            engine.predict(input=str(input_path)), start=1
        ):
            data = _result_data(result)
            texts = [str(value).strip() for value in (data.get("rec_texts") or [])]
            raw_scores = list(data.get("rec_scores") or [])
            polygons = list(data.get("rec_polys") or data.get("dt_polys") or [])

            rows: list[tuple[float, float, str]] = []
            for index, text in enumerate(texts):
                if not text:
                    continue
                y, x = _polygon_position(
                    polygons[index] if index < len(polygons) else None
                )
                if index < len(raw_scores):
                    try:
                        scores.append(float(raw_scores[index]))
                    except (TypeError, ValueError):
                        pass
                rows.append((y, x, text))
            rows.sort(key=lambda row: (round(row[0] / 12), row[1]))
            page_text = "\n".join(row[2] for row in rows).strip()
            pages.append(f"<!-- page: {page_number} -->\n\n{page_text}".strip())

        markdown = "\n\n".join(pages).strip()
        average = (sum(scores) / len(scores)) if scores else None
        return markdown, len(pages), average

    def extract(self, input_path: Path, requested_profile: str = "mobile") -> OcrExtraction:
        profile = "server" if requested_profile == "server" else "mobile"
        warnings: list[str] = []
        markdown, page_count, average = self._run(input_path, profile)

        if (
            profile == "mobile"
            and average is not None
            and average < self._escalate_below
        ):
            profile = "server"
            markdown, page_count, average = self._run(input_path, profile)
            warnings.append("移动版 OCR 置信度过低，已升级为高精度中文识别模型")

        if average is not None and average < self._low_confidence_below:
            warnings.append(
                f"OCR 平均置信度较低（{round(average * 100)}%），关键内容需对照原件"
            )

        return OcrExtraction(
            markdown=markdown,
            page_count=page_count or None,
            character_count=len(markdown),
            average_confidence=average,
            profile=profile,
            warnings=warnings,
        )
