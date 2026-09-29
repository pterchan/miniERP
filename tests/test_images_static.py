import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
MAIN = (ROOT / "api/main.py").read_text(encoding="utf-8")
IMAGES = (ROOT / "api/images.py").read_text(encoding="utf-8")
IMAGE_UTILS = (ROOT / "api/image_utils.py").read_text(encoding="utf-8")
DOCS = (ROOT / "api/documents.py").read_text(encoding="utf-8")
STORAGE = (ROOT / "api/storage.py").read_text(encoding="utf-8")
SCHEMAS = (ROOT / "api/schemas.py").read_text(encoding="utf-8")
REQS = (ROOT / "api/requirements.txt").read_text(encoding="utf-8")
MIGRATION = (ROOT / "db/migrations/004_product_images.sql").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
GALLERY = (ROOT / "web/src/product-gallery.jsx").read_text(encoding="utf-8")
APIJS = (ROOT / "web/src/api.js").read_text(encoding="utf-8")
NGINX = (ROOT / "web/nginx.conf").read_text(encoding="utf-8")


class ImageFeatureContractTests(unittest.TestCase):
    def test_migration_defines_product_image_with_audit_trigger(self):
        self.assertIn("CREATE TABLE product_image", MIGRATION)
        self.assertIn("object_key", MIGRATION)
        self.assertIn("REFERENCES product(product_id) ON DELETE CASCADE", MIGRATION)
        self.assertIn("size          INTEGER NOT NULL CHECK (size >= 0 AND size <= 20971520)", MIGRATION)
        self.assertIn("EXECUTE FUNCTION require_audit_context()", MIGRATION)

    def test_router_exposes_expected_endpoints(self):
        for route in (
            '@router.get("/products/{product_id}/images")',
            '@router.post("/products/{product_id}/images")',
            '@router.get("/product-images/{image_id}/content")',
            '@router.put("/product-images/{image_id}")',
            '@router.delete("/product-images/{image_id}")',
        ):
            self.assertIn(route, IMAGES)

    def test_upload_writes_with_audit_and_20mb_cap(self):
        self.assertIn("_MAX_IMAGE = 20 * 1024 * 1024", IMAGES)
        self.assertIn('detail=f"单张图片不能超过', IMAGES)
        self.assertIn('audit(conn, user, "UPLOAD", "product_image"', IMAGES)
        self.assertIn("require_roles(\"ADMIN\", \"WAREHOUSE\")", IMAGES)
        self.assertIn("_csrf(request)", IMAGES)

    def test_magic_byte_sniffing_rejects_non_images(self):
        # 嗅探逻辑迁移到共享模块 image_utils.py，images.py 仍保留 import
        self.assertIn("_sniff_image_type", IMAGES)
        self.assertIn("_sniff_image_type", IMAGE_UTILS)
        # JPEG 魔数（FF D8 FF）；SVG 等文本型不被放行
        self.assertIn("\\xff\\xd8\\xff", IMAGE_UTILS)
        self.assertIn("一律拒绝", IMAGE_UTILS)

    def test_server_reencode_cap_and_attachment_wiring(self):
        # 服务端兜底：超限（>1600px 或 >700KB）重编码为 JPEG
        self.assertIn("_reencode_to_cap", IMAGE_UTILS)
        self.assertIn("_reencode_to_cap", IMAGES)
        self.assertIn("SERVER_MAX_EDGE = 1600", IMAGE_UTILS)
        self.assertIn("SERVER_MAX_BYTES = 700 * 1024", IMAGE_UTILS)
        self.assertIn("ImageOps.exif_transpose", IMAGE_UTILS)
        # 附件（documents.py）与货品附图（images.py）共用同一套媒体工具；
        # 解码必须走统一入口（解码前像素上限），超限 422 而非回退存原图
        self.assertIn("from .image_utils import ImageTooLargeError, _reencode_to_cap, _sniff_image_type", DOCS)
        self.assertIn("from .image_utils import ImageTooLargeError", IMAGES)
        self.assertIn("MAX_IMAGE_PIXELS = 20_000_000", IMAGE_UTILS)
        self.assertIn("except ImageTooLargeError", IMAGES)
        self.assertIn("except ImageTooLargeError", DOCS)

    def test_object_key_never_serialized(self):
        # 客户端响应不得含 object_key/bucket
        self.assertNotIn("object_key", GALLERY)
        self.assertNotIn("object_key", APIJS)

    def test_storage_module_uses_minio_sdk_and_env(self):
        self.assertIn("from minio import Minio", STORAGE)
        self.assertIn("MINIO_ENDPOINT", STORAGE)
        self.assertIn("ensure_bucket", STORAGE)

    def test_requirements_include_minio_and_multipart(self):
        self.assertIn("minio>=", REQS)
        self.assertIn("python-multipart", REQS)

    def test_compose_adds_minio_service(self):
        self.assertIn("minio:", COMPOSE)
        self.assertIn("MINIO_ROOT_USER", COMPOSE)
        self.assertIn("minio_data:", COMPOSE)
        self.assertIn("MINIO_BUCKET", COMPOSE)

    def test_main_wires_router_and_bucket_creation(self):
        self.assertIn("from . import documents, images, master, reports", MAIN)
        self.assertIn("app.include_router(images.router)", MAIN)
        self.assertIn("ensure_bucket()", MAIN)

    def test_schemas_has_image_update(self):
        self.assertIn("class ImageUpdateIn", SCHEMAS)

    def test_proxy_body_limit_raised(self):
        self.assertIn("client_max_body_size 25m", NGINX)

    def test_frontend_uploads_multipart_and_renders_gallery(self):
        self.assertIn("FormData", APIJS)
        self.assertIn("uploadProductImages", APIJS)
        self.assertIn("ProductGallery", (ROOT / "web/src/main.jsx").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
