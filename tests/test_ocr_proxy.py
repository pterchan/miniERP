import os
import unittest
from unittest.mock import patch

from api.ocr_client import OCRProxyError, forward_ocr


class FakeResponse:
    def __init__(self, status_code, body, headers=None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}
        self.is_error = status_code >= 400

    def json(self):
        return self._body


class FakeClient:
    def __init__(self, response):
        self.response = response

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, *args, **kwargs):
        return self.response


class OCRProxyTests(unittest.TestCase):
    def test_retry_after_is_preserved_for_busy_service(self):
        response = FakeResponse(429, {"detail": "busy"}, {"Retry-After": "2"})
        with patch.dict(os.environ, {"OCR_SERVICE_URL": "http://ocr:8010", "OCR_PROXY_TIMEOUT_SECONDS": "25"}, clear=False):
            with patch("api.ocr_client.httpx.Client", return_value=FakeClient(response)):
                with self.assertRaises(OCRProxyError) as raised:
                    forward_ocr({"image_base64": "abc", "media_type": "image/jpeg"}, "req-1")
        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(raised.exception.retry_after, "2")

    def test_unknown_upstream_status_maps_to_bad_gateway(self):
        response = FakeResponse(418, {"detail": "teapot"})
        with patch("api.ocr_client.httpx.Client", return_value=FakeClient(response)):
            with self.assertRaises(OCRProxyError) as raised:
                forward_ocr({}, "req-2")
        self.assertEqual(raised.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
