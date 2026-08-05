"""货品附图接口：元数据入库（product_image），图片字节存 MinIO 对象存储。

链路：浏览器 → API（multipart 流式）→ MinIO；展示经 API 代理流式返回。
MinIO 仅内网、不暴露给浏览器，object_key/bucket 永不下发给客户端。

写入角色：ADMIN / WAREHOUSE（与货品维护一致）；读取：登录用户。
"""

from __future__ import annotations

import io
import unicodedata
import uuid
from urllib.parse import quote
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse

from .db import audit, connection, fetch_all, fetch_one
from .helpers import _request_meta
from .permissions import _csrf, require_roles, require_user
from .schemas import ImageUpdateIn
from .storage import bucket_name, get_client

router = APIRouter(prefix="/api", tags=["images"])

_MAX_IMAGE = 20 * 1024 * 1024   # 单图 ≤20MB（反代 body 上限已调至 ~25m）
_MAX_FILES = 10                 # 单次请求最多 10 张（总数量不限制，可分批上传）

_EXT_BY_TYPE = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
}


def _sniff_image_type(data: bytes) -> str | None:
    """Magic-byte 嗅探，只放行位图/HEIC；SVG 等文本型（可注入脚本）一律拒绝。"""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"):
            return "image/heic"
    return None


def _ext_for_type(content_type: str) -> str:
    return _EXT_BY_TYPE.get(content_type, "bin")


def _safe_filename(name: str) -> str:
    name = unicodedata.normalize("NFKC", name or "image")
    name = "".join(ch for ch in name if ch not in '/\\"\x00' and (ch.isprintable() or ch in "-_.() "))
    name = name.strip()
    if not name or name in (".", ".."):
        return "image"
    return name[:255]


def _quote_filename(name: str) -> str:
    return quote(name, safe="")


def _cleanup_objects(keys: list[tuple[str, str]]) -> None:
    """DB 写入失败时尽力删除已上传的孤儿对象。"""
    for bucket, key in keys:
        try:
            get_client().remove_object(bucket, key)
        except Exception:
            pass


def _stream_object(bucket: str, object_key: str):
    response = get_client().get_object(bucket, object_key)
    try:
        for chunk in response.stream(32 * 1024):
            yield chunk
    finally:
        response.close()
        response.release_conn()


@router.get("/products/{product_id}/images")
def list_product_images(product_id: int, user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        if not fetch_one(conn, "SELECT product_id FROM product WHERE product_id=%s", (product_id,)):
            raise HTTPException(status_code=404, detail="货品不存在")
        return fetch_all(
            conn,
            """SELECT image_id, product_id, filename, content_type, size, sort_order, uploaded_by, created_at
                 FROM product_image WHERE product_id=%s ORDER BY sort_order, image_id""",
            (product_id,),
        )


@router.post("/products/{product_id}/images")
def upload_product_images(
    product_id: int,
    request: Request,
    files: list[UploadFile] = File(...),
    user: dict[str, Any] = Depends(require_roles("ADMIN", "WAREHOUSE")),
) -> list[dict[str, Any]]:
    _csrf(request)
    meta = _request_meta(request)
    if not files:
        raise HTTPException(status_code=422, detail="未选择图片")
    if len(files) > _MAX_FILES:
        raise HTTPException(status_code=422, detail=f"单次最多上传 {_MAX_FILES} 张")

    with connection() as conn:
        if not fetch_one(conn, "SELECT product_id FROM product WHERE product_id=%s", (product_id,)):
            raise HTTPException(status_code=404, detail="货品不存在")
        max_sort = fetch_one(conn, "SELECT COALESCE(MAX(sort_order),0) AS m FROM product_image WHERE product_id=%s", (product_id,))
    base_sort = int(max_sort["m"])

    prepared: list[tuple[UploadFile, bytes, str, str]] = []  # (up, data, content_type, object_key)
    for up in files:
        data = up.file.read(_MAX_IMAGE + 1)
        if len(data) > _MAX_IMAGE:
            raise HTTPException(status_code=413, detail=f"单张图片不能超过 {_MAX_IMAGE // (1024 * 1024)}MB")
        content_type = _sniff_image_type(data)
        if not content_type:
            raise HTTPException(status_code=422, detail=f"不支持的文件类型: {up.filename or '未知'}")
        object_key = f"products/{product_id}/{uuid.uuid4().hex}.{_ext_for_type(content_type)}"
        prepared.append((up, data, content_type, object_key))

    uploaded_keys: list[tuple[str, str]] = []
    try:
        for _up, data, content_type, object_key in prepared:
            get_client().put_object(bucket_name(), object_key, io.BytesIO(data), len(data), content_type=content_type)
            uploaded_keys.append((bucket_name(), object_key))
        with connection() as conn:
            if not fetch_one(conn, "SELECT product_id FROM product WHERE product_id=%s", (product_id,)):
                raise HTTPException(status_code=404, detail="货品不存在")
            rows: list[dict[str, Any]] = []
            for i, (up, data, content_type, object_key) in enumerate(prepared):
                after = {
                    "product_id": product_id,
                    "filename": _safe_filename(up.filename),
                    "content_type": content_type,
                    "size": len(data),
                    "sort_order": base_sort + 1 + i,
                }
                audit(conn, user, "UPLOAD", "product_image", after=after,
                      request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
                with conn.cursor() as cur:
                    cur.execute(
                        """INSERT INTO product_image(product_id, object_key, bucket, filename, content_type, size, sort_order, uploaded_by)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                           RETURNING image_id, product_id, filename, content_type, size, sort_order, uploaded_by, created_at""",
                        (product_id, object_key, bucket_name(), after["filename"], after["content_type"], after["size"], after["sort_order"], user["user_id"]),
                    )
                    rows.append(dict(zip([d.name for d in cur.description], cur.fetchone())))
            return rows
    except HTTPException:
        _cleanup_objects(uploaded_keys)
        raise
    except Exception:
        _cleanup_objects(uploaded_keys)
        raise


@router.get("/product-images/{image_id}/content")
def product_image_content(image_id: int, user: dict[str, Any] = Depends(require_user)) -> Response:
    with connection() as conn:
        row = fetch_one(conn, "SELECT * FROM product_image WHERE image_id=%s", (image_id,))
    if not row:
        raise HTTPException(status_code=404, detail="图片不存在")
    filename = _safe_filename(row["filename"])
    headers = {
        "Content-Disposition": f"inline; filename*=UTF-8''{_quote_filename(filename)}",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": str(row["size"]),
        "Cache-Control": "private, max-age=3600",
    }
    return StreamingResponse(
        _stream_object(row["bucket"], row["object_key"]),
        media_type=row["content_type"],
        headers=headers,
    )


@router.put("/product-images/{image_id}")
def update_product_image(
    image_id: int,
    payload: ImageUpdateIn,
    request: Request,
    user: dict[str, Any] = Depends(require_roles("ADMIN", "WAREHOUSE")),
) -> dict[str, Any]:
    _csrf(request)
    meta = _request_meta(request)
    values = payload.model_dump(exclude_unset=True)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM product_image WHERE image_id=%s FOR UPDATE", (image_id,))
        if not before:
            raise HTTPException(status_code=404, detail="图片不存在")
        after = {**before, **values}
        if values.get("filename"):
            after["filename"] = _safe_filename(values["filename"])
        field_diff = {k: [before.get(k), v] for k, v in after.items() if before.get(k) != v}
        audit(conn, user, "EDIT", "product_image", target_id=image_id, before=before, after=after,
              field_diff=field_diff, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE product_image SET sort_order=%s, filename=%s WHERE image_id=%s
                   RETURNING image_id, product_id, filename, content_type, size, sort_order, uploaded_by, created_at""",
                (after.get("sort_order", before["sort_order"]), after.get("filename", before["filename"]), image_id),
            )
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@router.delete("/product-images/{image_id}")
def delete_product_image(
    image_id: int,
    request: Request,
    user: dict[str, Any] = Depends(require_roles("ADMIN", "WAREHOUSE")),
) -> dict[str, str]:
    _csrf(request)
    meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM product_image WHERE image_id=%s FOR UPDATE", (image_id,))
        if not before:
            raise HTTPException(status_code=404, detail="图片不存在")
        audit(conn, user, "DELETE", "product_image", target_id=image_id, before=before,
              request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("DELETE FROM product_image WHERE image_id=%s", (image_id,))
    try:
        get_client().remove_object(before["bucket"], before["object_key"])
    except Exception:
        pass
    return {"status": "ok"}
