"""批次4 后端 P3 行为测试：输入净化、约束映射 422、环检测、唯一冲突 409 等。"""

from __future__ import annotations

import unittest
from decimal import Decimal

from tests.support.testdb import DbTestCase


class RequestMetaTests(unittest.TestCase):
    def test_request_id_is_sanitized_and_truncated(self) -> None:
        from api.helpers import _request_meta

        class FakeHeaders(dict):
            def get(self, key, default=None):  # noqa: N802
                return dict.get(self, key, default)

        class FakeRequest:
            headers = FakeHeaders({"X-Request-ID": "evil\x00-id " + "A" * 5000, "User-Agent": "ua"})
            client = None

        meta = _request_meta(FakeRequest())
        self.assertLessEqual(len(meta["request_id"]), 64, "用户可控的 Request-ID 必须截断，防审计投毒")
        self.assertRegex(meta["request_id"], r"^[A-Za-z0-9._-]*$", "Request-ID 只放行安全字符集")


class ConditionIdTests(unittest.TestCase):
    def test_nonexistent_condition_rejected_422(self) -> None:
        from fastapi import HTTPException

        from api.db import connection
        from api.helpers import _condition_id
        from tests.support.testdb import DbTestCase, probe, setup_test_env
        if not probe():
            raise unittest.SkipTest("测试数据库不可达")
        setup_test_env()
        with connection() as conn:
            with self.assertRaises(HTTPException) as ctx:
                _condition_id(conn, 999999)
        self.assertEqual(ctx.exception.status_code, 422, "不存在的成色应 422，而不是 FK 违反 500")


class SchemaPrecisionTests(unittest.TestCase):
    def test_request_line_quantity_precision_limited(self) -> None:
        from api.schemas import RequestLineIn
        with self.assertRaises(Exception):
            RequestLineIn(product_id=1, quantity=Decimal("1.1234"))

    def test_counted_quantity_negative_rejected_at_validation(self) -> None:
        from api.schemas import DocLineIn
        with self.assertRaises(Exception):
            DocLineIn(product_id=1, quantity=Decimal(1), counted_quantity=Decimal("-1"))


class DateParamTests(unittest.TestCase):
    def test_report_date_params_reject_garbage(self) -> None:
        from api.reports import purchase_reconciliation  # noqa: F401 - 导入即校验签名注解
        import inspect
        signature = inspect.signature(purchase_reconciliation)
        for param in ("start_date", "end_date"):
            annotation = signature.parameters[param].annotation
            self.assertIn("date", str(annotation), f"{param} 必须声明为 date 类型让 FastAPI 校验 422")


class SerialsFileTests(unittest.TestCase):
    def test_legacy_xls_rejected_with_422(self) -> None:
        from api.serial_tracking import _extract_serials_from_file
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            _extract_serials_from_file(b"garbage", "清单.xls")
        self.assertEqual(ctx.exception.status_code, 422, "openpyxl 不支持旧版 .xls，应明确 422 提示另存")



class MasterBehaviorTests(DbTestCase):
    def test_category_cycle_rejected(self) -> None:
        from tests.support.api_client import api_for
        admin = api_for("admin")
        a = admin.post("/api/categories", json={"name": "环测试A", "sort_order": 1, "is_active": True}).json()
        b = admin.post("/api/categories", json={"name": "环测试B", "parent_category_id": a["category_id"], "sort_order": 2, "is_active": True}).json()
        response = admin.put(f"/api/categories/{a['category_id']}",
                             json={"name": "环测试A", "parent_category_id": b["category_id"], "sort_order": 1, "is_active": True})
        self.assertEqual(response.status_code, 422, "把祖先挂到子孙形成环应 422")

    def test_duplicate_min_quantity_tier_rejected(self) -> None:
        from tests.support.api_client import api_for
        admin = api_for("admin")
        ea = next(u for u in admin.get("/api/uoms").json() if u["code"] == "EA")
        product_id = admin.post("/api/products", json={"display_name": "档位测试货品", "default_uom_id": ea["uom_id"], "source_uom_raw": "个"}).json()["product_id"]
        first = admin.post(f"/api/products/{product_id}/price-tiers",
                           json={"tier_name": "批发一档", "min_quantity": 10, "price": "9.00"})
        self.assertEqual(first.status_code, 200, first.text)
        second = admin.post(f"/api/products/{product_id}/price-tiers",
                            json={"tier_name": "批发二档", "min_quantity": 10, "price": "8.00"})
        self.assertEqual(second.status_code, 409, "同一起订数量两档并存会让命中价不确定")

    def test_parse_serials_batch_lookup_correct(self) -> None:
        from tests.support.api_client import api_for
        from api.db import connection, fetch_one
        admin = api_for("admin")
        warehouse = api_for("warehouse")
        ea = next(u for u in admin.get("/api/uoms").json() if u["code"] == "EA")
        loc = admin.post("/api/locations", json={"code": "PARSELOC", "name": "批查库位"}).json()["location_id"]
        product_id = admin.post("/api/products", json={"display_name": "批查货品", "serialized": True, "default_uom_id": ea["uom_id"], "source_uom_raw": "个"}).json()["product_id"]
        supplier_id = warehouse.post("/api/suppliers", json={"name": "批查供应商"}).json()["supplier_id"]
        doc = warehouse.post("/api/documents", json={
            "doc_type": "PURCHASE_RECEIPT", "party_id": supplier_id,
            "lines": [{"product_id": product_id, "quantity": 1, "serial_numbers": ["BATCH-1"], "destination_location_id": loc}],
        }).json()
        warehouse.post(f"/api/documents/{doc['document_id']}/post", json={})
        result = warehouse.post("/api/serial-ledger/parse",
                                json={"product_id": product_id, "text": "BATCH-1\nUNKNOWN-9"}).json()
        by_sn = {x["serial_number"]: x for x in result["items"]}  # serial_number 已归一化（casefold）
        self.assertTrue(by_sn["batch-1"]["exists"])
        self.assertFalse(by_sn["unknown-9"]["exists"])


