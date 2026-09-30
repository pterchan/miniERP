"""共用过账入口的事务顺序、跨入口库存守卫和并发行为回归。"""

from __future__ import annotations

import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from unittest.mock import MagicMock, patch

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase


class PostingOrderTests(unittest.TestCase):
    def test_reverse_serial_validation_happens_before_inverse_insert(self) -> None:
        """先插入 inverse 会让有效事件查询错误地排除当前原事件。"""
        from api.inventory_posting import post_inventory_movement

        order: list[str] = []
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.execute.side_effect = lambda *_args: order.append("insert")
        cur.fetchone.return_value = (42,)
        original = {"inventory_movement_id": 7}
        with patch("api.inventory_posting._condition_id", return_value=1), \
                patch("api.inventory_posting._movement_id", return_value=2), \
                patch("api.inventory_posting._status_id", return_value=3), \
                patch("api.inventory_posting.audit") as audit, \
                patch("api.inventory_posting.validate_reverse_movement_serials",
                      side_effect=lambda *_args: order.append("validate") or []), \
                patch("api.inventory_posting.require_sufficient_stock",
                      side_effect=lambda *_args, **_kwargs: order.append("stock")), \
                patch("api.inventory_posting.reverse_movement_serials",
                      side_effect=lambda *_args, **_kwargs: order.append("serial")) as reverse:
            result = post_inventory_movement(
                conn, {"user_id": 1, "username": "仓管"}, {}, movement_code="PURCHASE_RETURN",
                product_id=1, quantity=Decimal(1), uom_id=1, condition_id=1,
                source_location_id=1, destination_location_id=None, stock_effect="OUT",
                reversal_of_movement=original)
        self.assertEqual(result, 42)
        self.assertEqual(order, ["validate", "stock", "insert", "serial"])
        self.assertEqual(reverse.call_args.kwargs["validated_assets"], [])
        after = audit.call_args.kwargs["after"]
        self.assertEqual({key: after[key] for key in ("uom_id", "condition_id", "source_location_id", "destination_location_id")},
                         {"uom_id": 1, "condition_id": 1, "source_location_id": 1, "destination_location_id": None})

    def test_insufficient_stock_does_not_write_audit_or_movement(self) -> None:
        from fastapi import HTTPException
        from api.inventory_posting import post_inventory_movement

        conn = MagicMock()
        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}), \
                patch("api.inventory_posting._condition_id", return_value=1), \
                patch("api.inventory_posting.fetch_one", return_value={"on_hand_quantity": Decimal(2)}), \
                patch("api.inventory_posting.audit") as audit:
            with self.assertRaises(HTTPException) as caught:
                post_inventory_movement(
                    conn, {"user_id": 1, "username": "仓管"}, {}, movement_code="ISSUE_OTHER",
                    product_id=1, quantity=Decimal(3), uom_id=1, condition_id=1,
                    source_location_id=1, destination_location_id=None, stock_effect="OUT")
        self.assertEqual(caught.exception.status_code, 422)
        audit.assert_not_called()
        conn.cursor.assert_not_called()


class InventoryPostingFlowTests(DbTestCase):
    product_seq = 0

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.sales = api_for("sales")
        cls.warehouse = api_for("warehouse")
        cls.colleague = api_for("colleague")
        cls.location_id = cls.admin.post("/api/locations", json={"code": "COMMON_POST", "name": "共用过账库位"}).json()["location_id"]
        cls.uom_id = next(row["uom_id"] for row in cls.admin.get("/api/uoms").json() if row["code"] == "EA")
        cls.supplier_id = cls.warehouse.post("/api/suppliers", json={"name": "共用过账供应商"}).json()["supplier_id"]
        cls.customer_id = cls.sales.post("/api/customers", json={"name": "共用过账客户"}).json()["customer_id"]

    def _product(self) -> int:
        type(self).product_seq += 1
        response = self.admin.post("/api/products", json={
            "display_name": f"共用过账货品{self.product_seq}", "default_uom_id": self.uom_id,
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["product_id"]

    def _document(self, product_id: int, doc_type: str, quantities: list[int]) -> int:
        receipt = doc_type == "PURCHASE_RECEIPT"
        actor = self.warehouse if receipt else self.sales
        response = actor.post("/api/documents", json={
            "doc_type": doc_type, "party_id": self.supplier_id if receipt else self.customer_id,
            "lines": [{"product_id": product_id, "quantity": quantity, "price": 1,
                       "destination_location_id" if receipt else "source_location_id": self.location_id}
                      for quantity in quantities],
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["document_id"]

    def _receipt(self, product_id: int, quantities: list[int]) -> int:
        document_id = self._document(product_id, "PURCHASE_RECEIPT", quantities)
        response = self.warehouse.post(f"/api/documents/{document_id}/post", json={})
        self.assertEqual(response.status_code, 200, response.text)
        return document_id

    def _approved_oa(self, product_id: int, quantities: list[int]) -> int:
        response = self.colleague.post("/api/stock-requests", json={
            "request_type": "ISSUE_CONSUMPTION", "source_location_id": self.location_id,
            "lines": [{"product_id": product_id, "quantity": quantity} for quantity in quantities],
        })
        self.assertEqual(response.status_code, 200, response.text)
        request_id = response.json()["stock_request_id"]
        self.assertEqual(self.colleague.post(f"/api/stock-requests/{request_id}/submit").status_code, 200)
        self.assertEqual(self.warehouse.post(f"/api/stock-requests/{request_id}/approve").status_code, 200)
        return request_id

    def _balance(self, product_id: int) -> Decimal:
        rows = self.admin.get("/api/inventory/balance").json()
        row = next((row for row in rows if row["product_id"] == product_id and row["location_id"] == self.location_id), None)
        return Decimal(str(row["on_hand_quantity"])) if row else Decimal(0)

    def _movement_count(self, product_id: int) -> int:
        from api.db import connection, fetch_one
        with connection() as conn:
            return int(fetch_one(conn, "SELECT count(*) AS n FROM inventory_movement WHERE product_id=%s", (product_id,))["n"])

    def test_default_oa_without_serials_still_allows_negative_stock(self) -> None:
        product_id = self._product()
        request_id = self._approved_oa(product_id, [3])
        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "0"}):
            response = self.warehouse.post(f"/api/stock-requests/{request_id}/release")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self._balance(product_id), Decimal(-3))

    def test_strict_oa_insufficient_stock_keeps_approved_status(self) -> None:
        product_id = self._product()
        request_id = self._approved_oa(product_id, [3])
        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}):
            response = self.warehouse.post(f"/api/stock-requests/{request_id}/release")
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.warehouse.get(f"/api/stock-requests/{request_id}").json()["status"], "APPROVED")
        self.assertEqual(self._movement_count(product_id), 0)

    def test_oa_multiline_total_is_checked_and_rolled_back(self) -> None:
        product_id = self._product()
        self._receipt(product_id, [5])
        request_id = self._approved_oa(product_id, [3, 3])
        before = self._movement_count(product_id)
        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}):
            response = self.warehouse.post(f"/api/stock-requests/{request_id}/release")
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self._balance(product_id), Decimal(5))
        self.assertEqual(self._movement_count(product_id), before)
        self.assertEqual(self.warehouse.get(f"/api/stock-requests/{request_id}").json()["status"], "APPROVED")

    def test_quick_adjust_respects_strict_switch_and_default_mode(self) -> None:
        product_id = self._product()
        payload = {"product_id": product_id, "location_id": self.location_id,
                   "uom_id": self.uom_id, "counted_quantity": -2}
        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}):
            rejected = self.warehouse.post("/api/inventory/adjust", json=payload)
        self.assertEqual(rejected.status_code, 422, rejected.text)
        self.assertEqual(self._movement_count(product_id), 0)
        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "0"}):
            accepted = self.warehouse.post("/api/inventory/adjust", json=payload)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(self._balance(product_id), Decimal(-2))

    def test_reverse_checks_cumulative_quantity_and_rolls_back(self) -> None:
        product_id = self._product()
        receipt_id = self._receipt(product_id, [5, 5])
        delivery_id = self._document(product_id, "SALES_DELIVERY", [3])
        self.assertEqual(self.sales.post(f"/api/documents/{delivery_id}/post", json={}).status_code, 200)
        before = self._movement_count(product_id)
        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}):
            response = self.warehouse.post(f"/api/documents/{receipt_id}/reverse")
        self.assertEqual(response.status_code, 422, response.text)
        receipt = self.warehouse.get(f"/api/documents/{receipt_id}").json()
        self.assertEqual(receipt["status"], "POSTED")
        self.assertIsNone(receipt["reversal_document"])
        self.assertEqual(self._balance(product_id), Decimal(7))
        self.assertEqual(self._movement_count(product_id), before)

    def test_concurrent_document_and_oa_only_one_can_consume_balance(self) -> None:
        """固定在单据已检查余额、未写流水的位置，让 OA 竞争同一货品锁。"""
        import api.inventory_posting as posting
        import api.main as main

        product_id = self._product()
        self._receipt(product_id, [10])
        delivery_id = self._document(product_id, "SALES_DELIVERY", [6])
        request_id = self._approved_oa(product_id, [6])
        checked = threading.Event()
        oa_lock_started = threading.Event()
        resume = threading.Event()
        check_stock = posting.require_sufficient_stock
        lock_products = main.lock_products

        def pause_after_check(*args, **kwargs):
            check_stock(*args, **kwargs)
            # FastAPI 同步端点在自己的工作线程执行；用首次检查标记而非请求线程本地变量。
            if not checked.is_set():
                checked.set()
                if not resume.wait(10):
                    raise AssertionError("并发测试未及时解除单据过账暂停")

        def signal_oa_lock(*args, **kwargs):
            oa_lock_started.set()
            return lock_products(*args, **kwargs)

        def post_document():
            return self.sales.post(f"/api/documents/{delivery_id}/post", json={})

        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}), \
                patch("api.inventory_posting.require_sufficient_stock", side_effect=pause_after_check), \
                patch("api.main.lock_products", side_effect=signal_oa_lock), \
                ThreadPoolExecutor(max_workers=2) as executor:
            document_future = executor.submit(post_document)
            try:
                self.assertTrue(checked.wait(5), "单据未进入库存检查")
                oa_future = executor.submit(self.warehouse.post, f"/api/stock-requests/{request_id}/release")
                self.assertTrue(oa_lock_started.wait(5), "OA 放行没有获取货品锁")
            finally:
                resume.set()
            document_response = document_future.result(timeout=10)
            oa_response = oa_future.result(timeout=10)
        self.assertEqual(document_response.status_code, 200, document_response.text)
        self.assertEqual(oa_response.status_code, 422, oa_response.text)
        self.assertEqual(self._balance(product_id), Decimal(4))
        self.assertEqual(self.warehouse.get(f"/api/stock-requests/{request_id}").json()["status"], "APPROVED")

    def test_concurrent_release_of_same_oa_posts_only_once(self) -> None:
        """首次放行持有申请行锁；第二次等待后只能读到已放行状态。"""
        import api.main as main

        product_id = self._product()
        self._receipt(product_id, [10])
        request_id = self._approved_oa(product_id, [3])
        another_warehouse = api_for("warehouse")
        before = self._movement_count(product_id)
        first_writer_started = threading.Event()
        second_lock_started = threading.Event()
        resume = threading.Event()
        write_movement = main.post_inventory_movement
        fetch_one = main.fetch_one

        def pause_first_writer(*args, **kwargs):
            if not first_writer_started.is_set():
                first_writer_started.set()
                if not resume.wait(10):
                    raise AssertionError("并发重复放行测试未及时解除暂停")
            return write_movement(*args, **kwargs)

        def signal_second_request_lock(conn, sql, params=()):
            if ("FROM stock_request WHERE stock_request_id=%s FOR UPDATE" in sql
                    and params == (request_id,) and first_writer_started.is_set()):
                second_lock_started.set()
            return fetch_one(conn, sql, params)

        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}), \
                patch("api.main.post_inventory_movement", side_effect=pause_first_writer), \
                patch("api.main.fetch_one", side_effect=signal_second_request_lock), \
                ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(self.warehouse.post, f"/api/stock-requests/{request_id}/release")
            try:
                self.assertTrue(first_writer_started.wait(5), "首次放行未进入共用写入入口")
                second = executor.submit(another_warehouse.post, f"/api/stock-requests/{request_id}/release")
                self.assertTrue(second_lock_started.wait(5), "第二次放行未尝试锁定同一申请")
            finally:
                resume.set()
            first_response = first.result(timeout=10)
            second_response = second.result(timeout=10)
        self.assertEqual(first_response.status_code, 200, first_response.text)
        self.assertEqual(second_response.status_code, 409, second_response.text)
        self.assertEqual(self._movement_count(product_id), before + 1)
        self.assertEqual(self._balance(product_id), Decimal(7))
        from api.db import connection, fetch_one as read_one
        with connection() as conn:
            actions = read_one(conn, """SELECT count(*) AS n FROM stock_request_action
                                        WHERE stock_request_id=%s AND action='RELEASE'""", (request_id,))
        self.assertEqual(actions["n"], 1)


if __name__ == "__main__":
    unittest.main()
