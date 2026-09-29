"""OCR 服务请求门禁测试：令牌先于 body 解析、请求体双重上限。"""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

TOKEN = "test-internal-token-0123456789"


class OcrGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        os.environ["OCR_INTERNAL_TOKEN"] = TOKEN
        from ocr_service.app import app
        cls.client = TestClient(app)

    def test_invalid_token_rejected(self) -> None:
        response = self.client.post(
            "/v1/extract",
            json={"media_type": "image/png", "image_base64": "A" * 32},
            headers={"X-Internal-Token": "wrong-token"},
        )
        self.assertEqual(response.status_code, 401)

    def test_missing_token_rejected(self) -> None:
        response = self.client.post(
            "/v1/extract",
            json={"media_type": "image/png", "image_base64": "A" * 32},
        )
        self.assertEqual(response.status_code, 401)

    def test_oversized_content_length_rejected_at_gate(self) -> None:
        """超过 MAX_REQUEST_BYTES 的 body 必须在解析前 413（内存上限保护）。"""
        from ocr_service.app import MAX_REQUEST_BYTES
        response = self.client.post(
            "/v1/extract",
            content=b"x" * (MAX_REQUEST_BYTES + 1),
            headers={"X-Internal-Token": TOKEN, "Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 413)

    def test_oversized_streamed_body_rejected_even_without_content_length(self) -> None:
        """chunked/无 content-length 的超大流也要被截断——直接驱动 ASGI 层验证。"""
        import asyncio

        from ocr_service.app import MAX_REQUEST_BYTES, app

        chunks = [b"x" * (MAX_REQUEST_BYTES // 3 + 1)] * 4  # 分块累计超限
        sent: list = []

        async def receive():
            if chunks:
                return {"type": "http.request", "body": chunks.pop(0), "more_body": True}
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
            "scheme": "http", "path": "/v1/extract", "raw_path": b"/v1/extract", "query_string": b"",
            "root_path": "", "server": ("test", 80), "client": ("test", 12345),
            "headers": [(b"x-internal-token", TOKEN.encode())],
        }
        asyncio.run(app(scope, receive, send))
        status = next((m["status"] for m in sent if m["type"] == "http.response.start"), None)
        self.assertEqual(status, 413, "无 content-length 的超大流必须在门禁层 413")

    def test_healthz_needs_no_token(self) -> None:
        self.assertEqual(self.client.get("/healthz").status_code, 200)


if __name__ == "__main__":
    unittest.main()
