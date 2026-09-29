"""批次3 后端 P2 行为测试：筛选转义/空值拒绝、导出 SQL 限行、显式 null 422、盘点 SN、池耗尽 503。"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from api.list_params import clamp_page, parse_filters

ALLOW = {"name": ("p.name", ("contains", "eq", "ne", "in"))}


class FilterParsingTests(unittest.TestCase):
    def test_contains_escapes_like_wildcards(self) -> None:
        where, params = parse_filters(["name:contains:100%_x"], ALLOW)
        self.assertEqual(params, ["%100\\%\\_x%"], "值里的 %/_ 必须作为字面量转义")

    def test_empty_filter_value_rejected(self) -> None:
        with self.assertRaises(ValueError):
            parse_filters(["name:contains:"], ALLOW)

    def test_in_with_no_values_rejected(self) -> None:
        with self.assertRaises(ValueError):
            parse_filters(["name:in: ,"], ALLOW)

    def test_clamp_page_has_upper_bound(self) -> None:
        self.assertLessEqual(clamp_page(10 ** 9), 100_000, "巨大页码会生成巨大 OFFSET 慢查询")


from tests.support.api_client import api_for  # noqa: E402
from tests.support.testdb import DbTestCase  # noqa: E402


class ExportLimitBehaviorTests(DbTestCase):
    def test_products_export_rejected_before_materializing(self) -> None:
        admin = api_for("admin")
        ea = next(u for u in admin.get("/api/uoms").json() if u["code"] == "EA")
        for i in range(3):
            admin.post("/api/products", json={"display_name": f"导出上限货品{i}", "default_uom_id": ea["uom_id"], "source_uom_raw": "个"})
        with patch("api.export.MAX_EXPORT_ROWS", 2):
            response = admin.get("/api/products/export")
        self.assertEqual(response.status_code, 422, "超过上限应在校验层 422，不应先全量物化再报错")


class DocUpdateNullTests(DbTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.warehouse = api_for("warehouse")
        ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")
        cls.product_id = cls.admin.post("/api/products", json={
            "display_name": "null 测试货品", "default_uom_id": ea["uom_id"], "source_uom_raw": "个",
        }).json()["product_id"]
        cls.supplier_id = cls.warehouse.post("/api/suppliers", json={"name": "null 测试供应商"}).json()["supplier_id"]

    def _draft(self) -> dict:
        response = self.warehouse.post("/api/documents", json={
            "doc_type": "PURCHASE_ORDER", "party_id": self.supplier_id,
            "lines": [{"product_id": self.product_id, "quantity": 1}],
        })
        assert response.status_code == 200, response.text
        return response.json()

    def test_explicit_null_party_rejected_with_422(self) -> None:
        doc = self._draft()
        response = self.warehouse.put(f"/api/documents/{doc['document_id']}",
                                      json={"version": doc["version"], "party_id": None})
        self.assertEqual(response.status_code, 422, "显式置空 party_id 应 422，而不是击穿约束 500")

    def test_explicit_null_doc_date_rejected_with_422(self) -> None:
        doc = self._draft()
        response = self.warehouse.put(f"/api/documents/{doc['document_id']}",
                                      json={"version": doc["version"], "doc_date": None})
        self.assertEqual(response.status_code, 422)


class StockCountSerialTests(DbTestCase):
    def test_stock_count_registers_serial_events(self) -> None:
        admin = api_for("admin")
        warehouse = api_for("warehouse")
        loc = admin.post("/api/locations", json={"code": "CNTLOC", "name": "盘点SN库位"}).json()["location_id"]
        ea = next(u for u in admin.get("/api/uoms").json() if u["code"] == "EA")
        product_id = admin.post("/api/products", json={
            "display_name": "盘点SN货品", "serialized": True, "default_uom_id": ea["uom_id"], "source_uom_raw": "个",
        }).json()["product_id"]
        doc = warehouse.post("/api/documents", json={
            "doc_type": "STOCK_COUNT",
            "lines": [{"product_id": product_id, "quantity": 1, "counted_quantity": 1,
                       "source_location_id": loc, "serial_numbers": ["CNT-SN-1"]}],
        })
        assert doc.status_code == 200, doc.text
        response = warehouse.post(f"/api/documents/{doc.json()['document_id']}/post", json={})
        assert response.status_code == 200, response.text
        items = admin.get("/api/serial-ledger", params={"q": "CNT-SN-1"}).json()["items"]
        self.assertTrue(items, "盘点登记的 SN 应建档并写入资产事件")
        self.assertEqual(items[0]["status_code"], "active")


class PoolExhaustionTests(DbTestCase):
    def test_pool_exhaustion_maps_to_503(self) -> None:
        from psycopg2 import pool as pg_pool

        import api.db as db
        from tests.support.api_client import api_for

        class ExhaustedPool:
            def getconn(self):
                raise pg_pool.PoolError("connection pool exhausted")

            def putconn(self, conn):
                pass

        api = api_for("admin")  # 先登录，再替换池，隔离后续请求
        original = db._pool
        db._pool = ExhaustedPool()
        try:
            response = api.get("/api/uoms")
            self.assertEqual(response.status_code, 503, "池耗尽应映射为 503 而不是 500")
            self.assertTrue(response.headers.get("Retry-After"))
        finally:
            db._pool = original


if __name__ == "__main__":
    unittest.main()
