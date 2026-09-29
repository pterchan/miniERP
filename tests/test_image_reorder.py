"""货品图片原子重排端点测试（替代前端两次 PUT 的非原子交换）。"""

from __future__ import annotations

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase


def _insert_image(conn, product_id: int, sort_order: int, uploaded_by: int) -> int:
    from api.db import audit
    audit(conn, None, "TEST_SETUP", "product_image", after={"product_id": product_id, "sort_order": sort_order})
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO product_image(product_id, object_key, bucket, filename, content_type, size, sort_order, uploaded_by)
                       VALUES (%s, %s, 'test-bucket', %s, 'image/jpeg', 10, %s, %s) RETURNING image_id""",
                    (product_id, f"products/{product_id}/fake-{sort_order}.jpg", f"fake-{sort_order}.jpg", sort_order, uploaded_by))
        return int(cur.fetchone()[0])


class ImageReorderTests(DbTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.warehouse = api_for("warehouse")
        ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")
        cls.product_id = cls.admin.post("/api/products", json={
            "display_name": "重排测试货品A", "default_uom_id": ea["uom_id"], "source_uom_raw": "个",
        }).json()["product_id"]
        cls.other_product_id = cls.admin.post("/api/products", json={
            "display_name": "重排测试货品B", "default_uom_id": ea["uom_id"], "source_uom_raw": "个",
        }).json()["product_id"]
        from api.db import connection
        with connection() as conn:
            admin_id = cls.admin.user["user_id"]
            cls.image_a = _insert_image(conn, cls.product_id, 1, admin_id)
            cls.image_b = _insert_image(conn, cls.product_id, 2, admin_id)
            cls.foreign_image = _insert_image(conn, cls.other_product_id, 1, admin_id)

    def test_reorder_is_atomic_and_persists(self) -> None:
        response = self.warehouse.post(f"/api/products/{self.product_id}/images/reorder",
                                       json={"order": [self.image_b, self.image_a]})
        self.assertEqual(response.status_code, 200, response.text)
        rows = {r["image_id"]: r["sort_order"] for r in self.admin.get(f"/api/products/{self.product_id}/images").json()}
        self.assertEqual(rows[self.image_b], 1)
        self.assertEqual(rows[self.image_a], 2)

    def test_reorder_rejects_foreign_image(self) -> None:
        response = self.warehouse.post(f"/api/products/{self.product_id}/images/reorder",
                                       json={"order": [self.foreign_image]})
        self.assertEqual(response.status_code, 422, "不能把其它货品的图片排进本货品")

    def test_reorder_requires_warehouse_role(self) -> None:
        sales = api_for("sales")
        self.assertEqual(sales.post(f"/api/products/{self.product_id}/images/reorder",
                                    json={"order": [self.image_a, self.image_b]}).status_code, 403)


if __name__ == "__main__":
    import unittest

    unittest.main()
