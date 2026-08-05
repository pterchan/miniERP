from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from io import BytesIO


SUPPORTED_MEDIA_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_DECODED_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 20_000_000
MAX_SIDE = 8192
MIN_SIDE = 64
MAX_BASE64_CHARS = ((MAX_DECODED_BYTES + 2) // 3) * 4 + 4


class ImageInputError(ValueError):
    pass


class UnsupportedMediaType(ImageInputError):
    pass


class ImageTooLarge(ImageInputError):
    pass


@dataclass
class DecodedImage:
    image: object
    media_type: str
    width: int
    height: int


def _magic_matches(data: bytes, media_type: str) -> bool:
    if media_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if media_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if media_type == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


def decode_image(image_base64: str, media_type: str) -> DecodedImage:
    if media_type not in SUPPORTED_MEDIA_TYPES:
        raise UnsupportedMediaType("仅支持 JPEG、PNG 和 WebP")
    if len(image_base64) > MAX_BASE64_CHARS:
        raise ImageTooLarge("图片 Base64 编码超过 10 MiB 限制")
    try:
        data = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageInputError("image_base64 不是有效的 RFC 4648 Base64") from exc
    if len(data) > MAX_DECODED_BYTES:
        raise ImageTooLarge("图片解码后超过 10 MiB")
    if not _magic_matches(data, media_type):
        raise UnsupportedMediaType("media_type 与图片文件签名不匹配")
    try:
        from PIL import Image, ImageOps

        with Image.open(BytesIO(data)) as source:
            width, height = source.size
            if min(width, height) < MIN_SIDE:
                raise ImageInputError("图片尺寸过小")
            if max(width, height) > MAX_SIDE or width * height > MAX_PIXELS:
                raise ImageTooLarge("图片像素或边长超过限制")
            source.load()
            oriented = ImageOps.exif_transpose(source).convert("RGB")
    except ImageInputError:
        raise
    except Exception as exc:  # Pillow raises different errors per codec.
        raise ImageInputError("图片无法解码") from exc
    return DecodedImage(oriented, media_type, oriented.width, oriented.height)
