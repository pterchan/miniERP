from __future__ import annotations

import os
from typing import Any

import httpx


class OCRProxyError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def forward_ocr(payload: dict[str, Any], request_id: str) -> dict[str, Any]:
    service_url = os.environ.get("OCR_SERVICE_URL", "http://ocr:8010").rstrip("/")
    timeout = float(os.environ.get("OCR_PROXY_TIMEOUT_SECONDS", "15"))
    headers = {"X-Request-ID": request_id}
    token = os.environ.get("OCR_INTERNAL_TOKEN")
    if token:
        headers["X-Internal-Token"] = token
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(f"{service_url}/v1/extract", json=payload, headers=headers)
    except httpx.TimeoutException as exc:
        raise OCRProxyError(504, "OCR 服务超时") from exc
    except httpx.HTTPError as exc:
        raise OCRProxyError(503, "OCR 服务不可用") from exc

    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.is_error:
        detail = body.get("detail", "OCR 服务返回错误") if isinstance(body, dict) else "OCR 服务返回错误"
        # Do not expose an internal authentication failure as a client error.
        mapped_status = 503 if response.status_code == 401 else response.status_code
        raise OCRProxyError(mapped_status, str(detail))
    if not isinstance(body, dict):
        raise OCRProxyError(502, "OCR 服务响应格式无效")
    return body
