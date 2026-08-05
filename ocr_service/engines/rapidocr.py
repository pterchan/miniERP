from __future__ import annotations

import hashlib
import time
from pathlib import Path

from .base import OCRLine, OCRRawResult


class RapidOCRBackend:
    name = "rapidocr-3.9.2-pp-ocrv6-small-onnxruntime"
    _MODEL_SHA256 = {
        "PP-OCRv6_det_small.onnx": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
        "ch_ppocr_mobile_v2.0_cls_mobile.onnx": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
        "PP-OCRv6_rec_small.onnx": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
    }

    def __init__(self) -> None:
        import rapidocr
        from rapidocr import RapidOCR

        # RapidOCR's default helper downloads a missing model.  The service is
        # deliberately offline at runtime, so fail startup instead of ever
        # attempting that fallback and pin the wheel-bundled model directory.
        model_root = Path(rapidocr.__file__).resolve().parent / "models"
        invalid = []
        for name, expected_sha256 in self._MODEL_SHA256.items():
            path = model_root / name
            if not path.is_file():
                invalid.append(f"{name}: missing")
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != expected_sha256:
                invalid.append(f"{name}: sha256 mismatch")
        if invalid:
            raise RuntimeError(f"RapidOCR bundled model validation failed: {', '.join(invalid)}")
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
