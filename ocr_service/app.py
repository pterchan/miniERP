from __future__ import annotations

import logging
import os
import threading
import uuid

from fastapi import FastAPI, Header, HTTPException, Request, status

from .contracts import ExtractRequest, ExtractResponse
from .image_io import ImageInputError, ImageTooLarge, UnsupportedMediaType, decode_image
from .pipeline import extract_from_image


logger = logging.getLogger("ocr_service")
app = FastAPI(title="Offline Product Label OCR", version="0.1.0")
_backend: object | None = None
_backend_error: str | None = None
_inference_slot = threading.BoundedSemaphore(1)


@app.on_event("startup")
def load_backend() -> None:
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


def _request_id(request: Request) -> str:
    return request.headers.get("X-Request-ID") or str(uuid.uuid4())


def _check_internal_token(provided: str | None) -> None:
    expected = os.environ.get("OCR_INTERNAL_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=503, detail="OCR 内部令牌未配置")
    if provided != expected:
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
    request_id = _request_id(request)
    if _backend is None:
        raise HTTPException(status_code=503, detail="OCR 模型尚未就绪")
    if not _inference_slot.acquire(timeout=5.0):
        raise HTTPException(status_code=429, detail="OCR 当前繁忙，请稍后重试", headers={"Retry-After": "2"})
    try:
        try:
            image = decode_image(payload.image_base64, payload.media_type)
        except ImageTooLarge as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        except UnsupportedMediaType as exc:
            raise HTTPException(status_code=415, detail=str(exc)) from exc
        except ImageInputError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        try:
            return extract_from_image(image, request_id, _backend)
        except Exception as exc:
            logger.exception("OCR request failed request_id=%s", request_id)
            raise HTTPException(status_code=503, detail="OCR 推理失败，请稍后重试") from exc
    finally:
        _inference_slot.release()
