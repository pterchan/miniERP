from __future__ import annotations

import os
import unittest
from pathlib import Path


@unittest.skipUnless(os.environ.get("OCR_SAMPLE_IMAGE"), "set OCR_SAMPLE_IMAGE to run the local golden case")
class GoldenImageTests(unittest.TestCase):
    """Optional local acceptance test; the source photo is never committed."""

    def test_core_fields_survive_common_rotations(self) -> None:
        from PIL import Image

        from ocr_service.engines.rapidocr import RapidOCRBackend
        from ocr_service.pipeline import extract_from_image

        path = Path(os.environ["OCR_SAMPLE_IMAGE"])
        self.assertTrue(path.is_file(), path)
        base = Image.open(path).convert("RGB")
        backend = RapidOCRBackend()
        expected = {
            "reference_number": "011518",
            "lot_number": "54711",
            "manufacture_date": "2021-03-15",
            "registration_number": "国械注进20212070123",
            "shelf_life": "5年",
        }
        for degrees in (0, 15, 90, 180, 270):
            image = base.rotate(degrees, expand=True, fillcolor="white")
            decoded = type("Decoded", (), {"image": image, "width": image.width, "height": image.height, "media_type": "image/jpeg"})()
            result = extract_from_image(decoded, f"golden-{degrees}", backend)
            self.assertGreaterEqual(len(result.labels), 2, degrees)
            for field, value in expected.items():
                values = {candidate.value_normalized for candidate in result.fields.get(field, [])}
                self.assertIn(value, values, (degrees, field, values))
            product_values = {candidate.value_normalized for candidate in result.fields.get("product_name", [])}
            self.assertIn("XactTrace预定制一次性使用中号绑带", product_values)
            self.assertIn("XactTrace Belt-Medium", product_values)


if __name__ == "__main__":
    unittest.main()
