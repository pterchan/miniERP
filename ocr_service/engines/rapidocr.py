from __future__ import annotations

import time
from pathlib import Path

from .base import OCRLine, OCRRawResult


class RapidOCRBackend:
    name = "rapidocr-3.9.2-pp-ocrv6-small-onnxruntime"

    def __init__(self) -> None:
        import rapidocr
        from rapidocr import RapidOCR

        # RapidOCR's default helper downloads a missing model.  The service is
        # deliberately offline at runtime, so fail startup instead of ever
        # attempting that fallback and pin the wheel-bundled model directory.
        model_root = Path(rapidocr.__file__).resolve().parent / "models"
        required_models = (
            "PP-OCRv6_det_small.onnx",
            "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
            "PP-OCRv6_rec_small.onnx",
        )
        missing = [name for name in required_models if not (model_root / name).is_file()]
        if missing:
            raise RuntimeError(f"RapidOCR bundled models missing: {', '.join(missing)}")
        self._engine = RapidOCR(
            params={
                "Global.model_root_dir": str(model_root),
                "EngineConfig.onnxruntime.intra_op_num_threads": 2,
                "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            }
        )

    def recognize(self, image: object) -> OCRRawResult:
        started = time.perf_counter()
        result = self._engine(image)
        lines: list[OCRLine] = []
        boxes = getattr(result, "boxes", None)
        texts = getattr(result, "txts", None)
        scores = getattr(result, "scores", None)
        if boxes is None or texts is None or scores is None:
            return OCRRawResult([], time.perf_counter() - started, self.name)
        for box, text, score in zip(boxes, texts, scores):
            value = str(text).strip()
            if not value:
                continue
            polygon = [[float(point[0]), float(point[1])] for point in box]
            if len(polygon) != 4:
                continue
            lines.append(OCRLine(value, max(0.0, min(1.0, float(score))), polygon))
        return OCRRawResult(lines, time.perf_counter() - started, self.name)
