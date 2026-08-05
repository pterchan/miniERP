from __future__ import annotations

import unittest

from pydantic import ValidationError

from ocr_service.contracts import ExtractRequest


class ContractTests(unittest.TestCase):
    def test_request_accepts_raw_base64(self) -> None:
        request = ExtractRequest(media_type="image/jpeg", image_base64="/9j/" + "A" * 20)
        self.assertEqual(request.media_type, "image/jpeg")

    def test_request_rejects_data_uri_and_whitespace(self) -> None:
        with self.assertRaises(ValidationError):
            ExtractRequest(media_type="image/jpeg", image_base64="data:image/jpeg;base64,/9j/AAAA")
        with self.assertRaises(ValidationError):
            ExtractRequest(media_type="image/jpeg", image_base64="/9j/ AAAA")


if __name__ == "__main__":
    unittest.main()
