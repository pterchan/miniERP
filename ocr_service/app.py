from __future__ import annotations

import hmac
import logging
import os
import threading
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request

from .contracts import ExtractRequest, ExtractResponse
from .image_io import ImageInputError, ImageTooLarge, UnsupportedMediaType, decode_image
from .pipeline import extract_from_image


logger = logging.getLogger("ocr_service")


def _load_backend() -> None:
    global _backend, _backend_error
    try:
        if not os.environ.get("OCR_INTERNAL_TOKEN"):
            raise RuntimeError("OCR_INTERNAL_TOKEN is required")
        from .engines.rapidocr import RapidOCRBackend

        _backend = RapidOCRBackend()
        _backend_error = None
        logger.info("OCR engine ready: %s", _backend.name)
    except Exception as exc:  # Keep liveness available so Compose can report readiness accurately.
        _backend = None
        _backend_error = type(exc).__name__
        logger.exception("OCR engine failed to load")


@asynccontextmanager
async def lifespan(_app):
    _load_backend()
    yield


app = FastAPI(title="Offline Product Label OCR", version="0.1.0", lifespan=lifespan)
_backend: object | None = None
_backend_error: str | None = None
_inference_slot = threading.BoundedSemaphore(1)
MAX_REQUEST_BYTES = 14 * 1024 * 1024


class RequestGateMiddleware:
    """/v1/extract 的请求门禁：内部令牌与请求体上限都必须先于 body 解析。

    handler 内的检查发生在 FastAPI 读完并解析 JSON 之后——超大 body（尤其
    chunked 无 content-length）在那之前就已吃满内存。因此在 ASGI 消息流层
    双重拦截：content-length 预检 + 流式累计超限即拒。
    """

    def __init__(self, app_asgi: object, max_bytes: int):
        self.app = app_asgi
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope.get("path") != "/v1/extract":
            await self.app(scope, receive, send)
            return
        expected = os.environ.get("OCR_INTERNAL_TOKEN", "")
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        provided = headers.get("x-internal-token")
        if not expected:
            await self._reject(send, 503, "OCR 内部令牌未配置")
            return
        if not provided or not hmac.compare_digest(provided, expected):
            await self._reject(send, 401, "OCR 内部令牌无效")
            return
        raw_length = headers.get("content-length")
        if raw_length and raw_length.isdigit() and int(raw_length) > self.max_bytes:
            await self._reject(send, 413, "OCR 请求体过大")
            return
        body = b""
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            body += message.get("body", b"")
            if len(body) > self.max_bytes:
                await self._reject(send, 413, "OCR 请求体过大")
                return
            if not message.get("more_body", False):
                break

        async def replay():
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)

    @staticmethod
    async def _reject(send, status: int, detail: str) -> None:
        import json as _json

        payload = _json.dumps({"detail": detail}).encode("utf-8")
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())]})
        await send({"type": "http.response.body", "body": payload})


def _request_id(request: Request) -> str:
    return request.headers.get("X-Request-ID") or str(uuid.uuid4())


def _check_internal_token(provided: str | None) -> None:
    expected = os.environ.get("OCR_INTERNAL_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=503, detail="OCR 内部令牌未配置")
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="OCR 内部令牌无效")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    if _backend is None:
        raise HTTPException(status_code=503, detail="OCR 模型尚未就绪")
    return {"status": "ready"}


@app.post("/v1/extract", response_model=ExtractResponse)
def extract(
    payload: ExtractRequest,
    request: Request,
    x_internal_token: str | None = Header(default=None),
) -> ExtractResponse:
    _check_internal_token(x_internal_token)
    raw_length = request.headers.get("content-length")
    if raw_length and int(raw_length) > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="OCR 请求体过大")
    request_id = _request_id(request)
    if _backend is None:
        raise HTTPException(status_code=503, detail="OCR 模型尚未就绪")
    if not _inference_slot.acquire(timeout=5.0):
        logger.warning("OCR request rejected request_id=%s code=429", request_id)
        raise HTTPException(status_code=429, detail="OCR 当前繁忙，请稍后重试", headers={"Retry-After": "2"})
    try:
        try:
            image = decode_image(payload.image_base64, payload.media_type)
        except ImageTooLarge as exc:
            logger.warning("OCR request rejected request_id=%s code=413", request_id)
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        except UnsupportedMediaType as exc:
            logger.warning("OCR request rejected request_id=%s code=415", request_id)
            raise HTTPException(status_code=415, detail=str(exc)) from exc
        except ImageInputError as exc:
            logger.warning("OCR request rejected request_id=%s code=422", request_id)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        try:
            result = extract_from_image(image, request_id, _backend)
            logger.info(
                "OCR request completed request_id=%s width=%s height=%s status=%s elapsed_ms=%s",
                request_id,
                image.width,
                image.height,
                result.status,
                result.diagnostics.timings_ms.get("total"),
            )
            return result
        except Exception as exc:
            logger.exception("OCR request failed request_id=%s", request_id)
            raise HTTPException(status_code=503, detail="OCR 推理失败，请稍后重试") from exc
    finally:
        _inference_slot.release()


# 门禁中间件必须在全部路由定义完成后包装（见类注释）
app = RequestGateMiddleware(app, MAX_REQUEST_BYTES)
