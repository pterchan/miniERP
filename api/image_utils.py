"""图片字节级公共工具：类型嗅探 / 扩展名 / 缩略图 / 超限重编码。

被 api/images.py（货品附图，MinIO）与 api/documents.py（附件，BYTEA）共用。
重编码是服务端的兜底限制：端侧已把新上传压到 ≤400KB/1280px，
这里只在绕过端侧或极端尺寸时，把存储与下载体积拉回可控范围。
"""

from __future__ import annotations

import io

SERVER_MAX_EDGE = 1600                 # 兜底，略宽于端侧 1280
SERVER_MAX_BYTES = 700 * 1024          # 端侧才是真正的限流点

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


def _make_thumbnail(data: bytes, max_size: int = 320) -> tuple[bytes, int] | None:
    """生成 JPEG 缩略图；(bytes, size)。Pillow 无法解码（如 HEIC 直传）时返回 None，
    前端在网格中回退到原图。"""
    try:
        from PIL import Image
        image = Image.open(io.BytesIO(data))
        image = image.convert("RGB")
        image.thumbnail((max_size, max_size), Image.LANCZOS)
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=80)
        out = buf.getvalue()
        return out, len(out)
    except Exception:
        return None


def _reencode_to_cap(data: bytes, content_type: str) -> tuple[bytes, str, int] | None:
    """可解码且超限（>SERVER_MAX_EDGE 或 >SERVER_MAX_BYTES）的图重编码为
    JPEG ≤SERVER_MAX_EDGE / ≤SERVER_MAX_BYTES。

    返回 (jpeg_bytes, "image/jpeg", len)；已达标 / 不可解码（HEIC 直传等）返回 None，
    调用方按原样存储。Pillow wheels 自带 WebP/PNG/GIF 解码。
    """
    try:
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(data)) as im:
            if im.format not in ("JPEG", "PNG", "WEBP", "GIF"):
                return None
            if im.width <= SERVER_MAX_EDGE and im.height <= SERVER_MAX_EDGE and len(data) <= SERVER_MAX_BYTES:
                return None
            oriented = ImageOps.exif_transpose(im).convert("RGB")
            oriented.thumbnail((SERVER_MAX_EDGE, SERVER_MAX_EDGE), Image.LANCZOS)
            quality = 82
            while True:
                buf = io.BytesIO()
                oriented.save(buf, format="JPEG", quality=quality)
                out = buf.getvalue()
                if len(out) <= SERVER_MAX_BYTES or quality <= 55:
                    return out, "image/jpeg", len(out)
                quality -= 5
    except Exception:
        return None
