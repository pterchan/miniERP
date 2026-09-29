"""核心不变量行为测试：申请单状态机、CSRF 绑定、审计触发器、审计脱敏。"""

from __future__ import annotations

import json
import unittest

import psycopg2

from tests.support.api_client import Api, api_for, make_client
from tests.support.testdb import DbTestCase, TEST_PASSWORD


class StockRequestLifecycleTests(DbTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.warehouse = api_for("warehouse")
        cls.colleague = api_for("colleague")
        cls.loc1 = cls.admin.post("/api/locations", json={"code": "REQLOC1", "name": "申请库位1"}).json()["location_id"]
        ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")
        cls.ea_uom_id = ea["uom_id"]
        cls.product_id = cls.admin.post("/api/products", json={
            "display_name": "申请测试货品", "default_uom_id": ea["uom_id"], "source_uom_raw": "个",
        }).json()["product_id"]

    def _create_request(self, request_type: str = "RECEIPT", dest: int | None = None, source: int | None = None) -> dict:
        payload: dict = {"request_type": request_type,
                         "lines": [{"product_id": self.product_id, "quantity": 5}]}
        if dest is not None:
            payload["destination_location_id"] = dest
        if source is not None:
            payload["source_location_id"] = source
        response = self.colleague.post("/api/stock-requests", json=payload)
        assert response.status_code == 200, response.text
        return response.json()

    def test_full_lifecycle_posts_stock(self) -> None:
        req = self._create_request(dest=self.loc1)
        rid = req["stock_request_id"]
        self.assertEqual(self.colleague.post(f"/api/stock-requests/{rid}/submit").status_code, 200)
        self.assertEqual(self.warehouse.post(f"/api/stock-requests/{rid}/approve").status_code, 200)
        self.assertEqual(self.warehouse.post(f"/api/stock-requests/{rid}/release").status_code, 200)
        rows = self.admin.get("/api/inventory/balance").json()
        row = next(r for r in rows if r["product_id"] == self.product_id)
        self.assertEqual(float(row["on_hand_quantity"]), 5.0, "放行 RECEIPT 申请应入库")

    def test_illegal_transitions_rejected(self) -> None:
        req = self._create_request(dest=self.loc1)
        rid = req["stock_request_id"]
        self.assertEqual(self.warehouse.post(f"/api/stock-requests/{rid}/approve").status_code, 409, "DRAFT 不能直接审批")
        self.assertEqual(self.warehouse.post(f"/api/stock-requests/{rid}/release").status_code, 409, "DRAFT 不能直接放行")
        self.assertEqual(self.colleague.post(f"/api/stock-requests/{rid}/submit").status_code, 200)
        self.assertEqual(self.warehouse.post(f"/api/stock-requests/{rid}/release").status_code, 409, "SUBMITTED 不能直接放行")
        self.assertEqual(self.warehouse.post(f"/api/stock-requests/{rid}/approve").status_code, 200)
        self.assertEqual(self.warehouse.post(f"/api/stock-requests/{rid}/approve").status_code, 409, "APPROVED 不能重复审批")

    def test_withdraw_returns_to_draft_and_can_resubmit(self) -> None:
        req = self._create_request(dest=self.loc1)
        rid = req["stock_request_id"]
        assert self.colleague.post(f"/api/stock-requests/{rid}/submit").status_code == 200
        self.assertEqual(self.colleague.post(f"/api/stock-requests/{rid}/withdraw").status_code, 200)
        detail = self.colleague.get(f"/api/stock-requests/{rid}").json()
        self.assertEqual(detail["status"], "DRAFT")
        self.assertEqual(self.colleague.post(f"/api/stock-requests/{rid}/submit").status_code, 200)

    def test_only_owner_may_submit_or_withdraw(self) -> None:
        req = self._create_request(dest=self.loc1)
        rid = req["stock_request_id"]
        self.assertEqual(self.colleague.post(f"/api/stock-requests/{rid}/submit").status_code, 200)
        # 管理员另建一个同事账号：非申请人对他人单据撤回应被拒绝（403/404）
        created = self.admin.post("/api/admin/users", json={
            "username": "colleague2", "display_name": "第二个同事", "role": "COLLEAGUE", "password": "second-pass-123",
        })
        self.assertEqual(created.status_code, 200, created.text)
        another = Api(make_client()).login("colleague2", "second-pass-123")
        self.assertIn(another.post(f"/api/stock-requests/{rid}/withdraw").status_code, (403, 404))

    def test_only_warehouse_may_approve(self) -> None:
        req = self._create_request(dest=self.loc1)
        rid = req["stock_request_id"]
        assert self.colleague.post(f"/api/stock-requests/{rid}/submit").status_code == 200
        self.assertEqual(self.colleague.post(f"/api/stock-requests/{rid}/approve").status_code, 403)

    def test_reject_records_reason(self) -> None:
        req = self._create_request(dest=self.loc1)
        rid = req["stock_request_id"]
        assert self.colleague.post(f"/api/stock-requests/{rid}/submit").status_code == 200
        response = self.warehouse.post(f"/api/stock-requests/{rid}/reject",
                                       json={"reason": "数量与实物不符"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "REJECTED")


class CsrfBindingTests(DbTestCase):
    def test_cross_session_csrf_token_rejected(self) -> None:
        """A 的 CSRF token 不能配 B 的会话使用（token 与会话哈希绑定）。"""
        alice = api_for("admin")
        bob = Api(make_client()).login("warehouse")
        response = bob.client.post(
            "/api/uoms",
            json={"code": "XCSRF", "display_name": "跨会话测试", "decimal_scale": 0},
            headers={"X-CSRF-Token": alice.csrf_token},
        )
        self.assertEqual(response.status_code, 403)


class AuditTriggerTests(DbTestCase):
    def test_write_without_audit_context_rejected(self) -> None:
        from api.db import connection
        with self.assertRaises(psycopg2.Error):
            with connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("INSERT INTO product(display_name) VALUES ('触发器测试')")

    def test_audit_event_is_immutable(self) -> None:
        from api.db import connection
        with self.assertRaises(psycopg2.Error):
            with connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("UPDATE audit_event SET action='TAMPERED' WHERE audit_event_id=1")

    def test_passwords_never_appear_in_audit_payloads(self) -> None:
        admin = api_for("admin")
        target = api_for("sales")
        admin.post(f"/api/admin/users/{target.user['user_id']}/password", json={"password": "audit-secret-99"})
        from api.db import connection, fetch_all
        with connection() as conn:
            rows = fetch_all(conn, "SELECT after_data, before_data, field_diff FROM audit_event ORDER BY audit_event_id DESC LIMIT 50")
        serialized = json.dumps(rows, ensure_ascii=False, default=str)
        self.assertNotIn("audit-secret-99", serialized)
        self.assertNotIn(TEST_PASSWORD, serialized)


if __name__ == "__main__":
    unittest.main()
