from __future__ import annotations

import unittest

from ocr_service.field_extractor import extract_fields, normalize_value


def ocr_line(line_id: str, text: str, y: float, label_id: str = "label-1", confidence: float = 0.99) -> dict:
    return {
        "line_id": line_id,
        "text": text,
        "confidence": confidence,
        "polygon": [[10, y], [300, y], [300, y + 20], [10, y + 20]],
        "label_id": label_id,
        "height": 20.0,
        "median_height": 20.0,
    }


class FieldExtractionTests(unittest.TestCase):
    def test_sample_like_bilingual_fields_and_search_terms(self) -> None:
        result = extract_fields(
            [
                ocr_line("1", "XactTrace Belt-Medium", 0, confidence=0.99),
                ocr_line("2", "REF 011518 Rev.F", 30),
                ocr_line("3", "LOT 54711", 60),
                ocr_line("4", "2021-03-15", 90),
                ocr_line("5", "产品名称：XactTrace预定制一次性使用中号绑带", 120, "label-2"),
                ocr_line("6", "注册证编号：国械注进20212070123", 150, "label-2"),
                ocr_line("7", "使用期限：5年", 180, "label-2"),
            ]
        )
        self.assertEqual(result.fields["reference_number"][0].value_normalized, "011518")
        self.assertEqual(result.fields["revision"][0].value_normalized, "F")
        self.assertEqual(result.fields["lot_number"][0].value_normalized, "54711")
        self.assertEqual(result.fields["manufacture_date"][0].value_normalized, "2021-03-15")
        self.assertEqual(result.fields["registration_number"][0].value_normalized, "国械注进20212070123")
        self.assertEqual(result.fields["shelf_life"][0].value_normalized, "5年")
        self.assertTrue(any(term.value == "011518" for term in result.search_terms))
        self.assertFalse(any(term.value == "54711" for term in result.search_terms))

    def test_unknown_key_value_is_preserved_and_leading_zero_survives(self) -> None:
        result = extract_fields([ocr_line("1", "内部代码：000012", 0), ocr_line("2", "包装说明：请置于干燥处", 30)])
        self.assertEqual(result.key_values[0].value_normalized, "000012")
        self.assertEqual(result.key_values[1].key_normalized, "包装说明")
        self.assertEqual(normalize_value("2021/3/5", "manufacture_date"), "2021-03-05")

    def test_conflicting_values_are_marked_ambiguous(self) -> None:
        result = extract_fields([ocr_line("1", "REF：011518", 0), ocr_line("2", "REF：011519", 30, confidence=0.98)])
        self.assertEqual({item.status for item in result.fields["reference_number"]}, {"ambiguous"})
        self.assertEqual(result.search_terms, [])

    def test_key_only_line_consumes_wrapped_value(self) -> None:
        result = extract_fields(
            [
                ocr_line("1", "Product Name", 0),
                ocr_line("2", "XactTrace", 24),
                ocr_line("3", "Belt Medium", 46),
            ]
        )
        self.assertEqual(result.fields["product_name"][0].value_normalized, "XactTrace Belt Medium")


if __name__ == "__main__":
    unittest.main()
