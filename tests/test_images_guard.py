"""图片炸弹防护行为测试（复现 P1：API 侧无像素上限、失败静默存原图）。"""

from __future__ import annotations

import struct
import unittest
import zlib

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase


def _png_with_dimensions(width: int, height: int) -> bytes:
    """构造只含 IHDR 的 PNG：头部声明巨大尺寸、无像素数据。

    Image.open 惰性解析头部即可读到 (width, height)，让「解码前像素预检」
    无需真正解码就能触发——这正是防解压炸弹的语义。
    """

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    return b"\x89PNG\r\n\x1a\n" + ihdr + chunk(b"IEND", b"")


BOMB_PNG = _png_with_dimensions(20000, 20000)  # 4 亿像素声明


class ImageUtilsBombTests(unittest.TestCase):
    """纯函数级：解码入口必须在解码前拒绝超限像素。"""

    def test_reencode_rejects_declared_huge_dimensions(self) -> None:
        from api.image_utils import ImageTooLargeError, _reencode_to_cap
        with self.assertRaises(ImageTooLargeError):
            _reencode_to_cap(BOMB_PNG, "image/png")

    def test_thumbnail_rejects_declared_huge_dimensions(self) -> None:
        from api.image_utils import ImageTooLargeError, _make_thumbnail
        with self.assertRaises(ImageTooLargeError):
            _make_thumbnail(BOMB_PNG)

    def test_normal_small_image_still_reencodable(self) -> None:
        import io

        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (3000, 3000), "red").save(buf, format="PNG")
        from api.image_utils import _reencode_to_cap
        result = _reencode_to_cap(buf.getvalue(), "image/png")
        self.assertIsNotNone(result, "3000x3000 未超像素上限，超边长应触发重编码")


class ImageUploadBombTests(DbTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.loc1 = cls.admin.post("/api/locations", json={"code": "BOMBLOC1", "name": "炸弹库位1"}).json()["location_id"]
        cls.loc2 = cls.admin.post("/api/locations", json={"code": "BOMBLOC2", "name": "炸弹库位2"}).json()["location_id"]
        ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")
        cls.product_id = cls.admin.post("/api/products", json={
            "display_name": "炸弹测试货品", "default_uom_id": ea["uom_id"], "source_uom_raw": "个",
        }).json()["product_id"]

    def test_product_image_upload_rejects_pixel_bomb(self) -> None:
        response = self.admin.post(f"/api/products/{self.product_id}/images",
                                   files={"files": ("bomb.png", BOMB_PNG, "image/png")})
        self.assertEqual(response.status_code, 422, "声明超限像素的图片应 422 拒绝，而不是解码失败后存原图")

    def test_attachment_upload_rejects_pixel_bomb(self) -> None:
        doc = self.admin.post("/api/documents", json={
            "doc_type": "STOCK_TRANSFER",
            "lines": [{"product_id": self.product_id, "quantity": 1,
                       "source_location_id": self.loc1, "destination_location_id": self.loc2}],
        })
        assert doc.status_code == 200, doc.text
        response = self.admin.post(f"/api/documents/{doc.json()['document_id']}/attachments",
                                   files={"file": ("bomb.png", BOMB_PNG, "image/png")})
        self.assertEqual(response.status_code, 422, "附件路径同样要在解码前拒绝像素炸弹")


class OcrPayloadCapTests(DbTestCase):
    def test_oversized_base64_rejected_by_schema(self) -> None:
        api = api_for("admin")
        response = api.post("/api/ocr/extract", json={"image_base64": "A" * 21_000_000, "page_hint": ""})
        self.assertEqual(response.status_code, 422, "超长 base64 应在校验层 422，而不是转发后才失败")


if __name__ == "__main__":
    unittest.main()
