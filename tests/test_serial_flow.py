"""SN 序列追踪状态机行为测试（复现 P0-1：状态判定基于永不更新的 asset.status_id）。

覆盖场景：
- 在库 SN 重复入库应拒（原有正确行为，回归保护）；
- 已出库 SN 重复出库应拒（现状放行 → 红）；
- 已出库 SN 经销售退货应可回库（现状必 422 → 红）；
- 已出库 SN 调拨应拒（现状放行 → 红）；
- 红冲出库单后 SN 应回到在库，可再次出库；
- parse_serials 预检展示的应为真实在库状态。
"""

from __future__ import annotations

import os
import unittest
from decimal import Decimal
from typing import Any
from unittest.mock import patch

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase


class SerialUnitGuardTests(unittest.TestCase):
    def test_unknown_current_unit_is_rejected(self) -> None:
        from fastapi import HTTPException
        from api.serial_tracking import _require_in_stock

        asset = {"asset_id": 1, "status_code": "active", "condition_id": 1,
                 "current_location_id": 1, "current_uom_id": None}
        with self.assertRaises(HTTPException) as caught:
            _require_in_stock(asset, "未知单位SN", "出库", location_id=1, condition_id=1, uom_id=1)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("当前库存单位", caught.exception.detail)


def _line(product_id: int, serial: str, *, source: int | None = None, dest: int | None = None,
          condition: int | None = None) -> dict[str, Any]:
    line: dict[str, Any] = {"product_id": product_id, "quantity": 1, "serial_numbers": [serial]}
    if source is not None:
        line["source_location_id"] = source
    if dest is not None:
        line["destination_location_id"] = dest
    if condition is not None:
        line["condition_id"] = condition
    return line


class SerialStateMachineTests(DbTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.warehouse = api_for("warehouse")
        cls.sales = api_for("sales")
        cls.loc1 = cls.admin.post("/api/locations", json={"code": "SNLOC1", "name": "序列测试库位1"}).json()["location_id"]
        cls.loc2 = cls.admin.post("/api/locations", json={"code": "SNLOC2", "name": "序列测试库位2"}).json()["location_id"]
        uoms = cls.admin.get("/api/uoms").json()
        ea = next(u for u in uoms if u["code"] == "EA")
        cls.ea_uom_id = ea["uom_id"]
        cls.kg_uom_id = next(u["uom_id"] for u in uoms if u["code"] == "KG")
        from api.db import connection, fetch_all
        with connection() as conn:
            cls.conditions = {row["code"]: row["condition_id"] for row in fetch_all(conn, "SELECT code,condition_id FROM inventory_condition")}
        cls.product_id = cls.admin.post("/api/products", json={
            "display_name": "序列化测试货品", "serialized": True, "default_uom_id": ea["uom_id"],
            "purchase_cost_price": "10.00", "sales_price": "20.00", "source_uom_raw": "个",
        }).json()["product_id"]
        cls.supplier_id = cls.warehouse.post("/api/suppliers", json={"name": "SN测试供应商"}).json()["supplier_id"]
        cls.customer_id = cls.sales.post("/api/customers", json={"name": "SN测试客户"}).json()["customer_id"]

    # ---- 构造助手 ----------------------------------------------------------

    def _create(self, api: Any, doc_type: str, lines: list[dict[str, Any]], party_id: int | None = None) -> int:
        payload: dict[str, Any] = {"doc_type": doc_type, "lines": lines}
        if party_id is not None:
            payload["party_id"] = party_id
        response = api.post("/api/documents", json=payload)
        assert response.status_code == 200, f"创建{doc_type}失败: {response.status_code} {response.text}"
        return response.json()["document_id"]

    def _post(self, api: Any, document_id: int) -> Any:
        return api.post(f"/api/documents/{document_id}/post", json={})

    def _receipt(self, serial: str) -> int:
        doc_id = self._create(self.warehouse, "PURCHASE_RECEIPT",
                              [_line(self.product_id, serial, dest=self.loc1)], self.supplier_id)
        response = self._post(self.warehouse, doc_id)
        assert response.status_code == 200, f"入库过账失败: {response.status_code} {response.text}"
        return doc_id

    def _delivery_doc(self, serial: str) -> int:
        return self._create(self.sales, "SALES_DELIVERY",
                            [_line(self.product_id, serial, source=self.loc1)], self.customer_id)

    def _delivery(self, serial: str) -> Any:
        return self._post(self.sales, self._delivery_doc(serial))

    def _ledger_status(self, serial: str) -> str | None:
        items = self.admin.get("/api/serial-ledger", params={"q": serial}).json()["items"]
        return items[0]["status_code"] if items else None

    def _ledger_row(self, serial: str) -> dict[str, Any]:
        return self.admin.get("/api/serial-ledger", params={"q": serial}).json()["items"][0]

    def _stock(self, location_id: int, condition_id: int, uom_id: int | None = None) -> Decimal:
        uom_id = self.ea_uom_id if uom_id is None else uom_id
        rows = self.admin.get("/api/inventory/balance").json()
        row = next((row for row in rows if row["product_id"] == self.product_id
                    and row["location_id"] == location_id and row["condition_id"] == condition_id
                    and row["uom_id"] == uom_id), None)
        return Decimal(str(row["on_hand_quantity"])) if row else Decimal(0)

    # ---- 场景 ----------------------------------------------------------

    def test_duplicate_in_while_active_rejected(self) -> None:
        self._receipt("SN-DUP-IN")
        doc_id = self._create(self.warehouse, "PURCHASE_RECEIPT",
                              [_line(self.product_id, "SN-DUP-IN", dest=self.loc1)], self.supplier_id)
        self.assertEqual(self._post(self.warehouse, doc_id).status_code, 422)
        self.assertEqual(self._ledger_status("SN-DUP-IN"), "active")

    def test_out_then_duplicate_out_rejected(self) -> None:
        self._receipt("SN-OUT2")
        self.assertEqual(self._delivery("SN-OUT2").status_code, 200)
        self.assertEqual(self._ledger_status("SN-OUT2"), "retired")
        self.assertEqual(self._delivery("SN-OUT2").status_code, 422, "已出库 SN 不应能再次出库")

    def test_sales_return_brings_sold_sn_back(self) -> None:
        self._receipt("SN-RET1")
        self.assertEqual(self._delivery("SN-RET1").status_code, 200)
        doc_id = self._create(self.sales, "SALES_RETURN",
                              [_line(self.product_id, "SN-RET1", dest=self.loc1)], self.customer_id)
        response = self._post(self.sales, doc_id)
        self.assertEqual(response.status_code, 200, f"销售退货应可回库: {response.text}")
        self.assertEqual(self._ledger_status("SN-RET1"), "active")

    def test_transfer_of_sold_sn_rejected(self) -> None:
        self._receipt("SN-TRF1")
        self.assertEqual(self._delivery("SN-TRF1").status_code, 200)
        doc_id = self._create(self.warehouse, "STOCK_TRANSFER",
                              [_line(self.product_id, "SN-TRF1", source=self.loc1, dest=self.loc2)])
        response = self._post(self.warehouse, doc_id)
        self.assertEqual(response.status_code, 422, "已出库 SN 不应能调拨")

    def test_reverse_delivery_restores_sn(self) -> None:
        self._receipt("SN-REV1")
        delivery_id = self._delivery_doc("SN-REV1")
        self.assertEqual(self._post(self.sales, delivery_id).status_code, 200)
        self.assertEqual(self._ledger_status("SN-REV1"), "retired")
        self.assertEqual(self.sales.post(f"/api/documents/{delivery_id}/reverse").status_code, 200)
        self.assertEqual(self._ledger_status("SN-REV1"), "active")
        self.assertEqual(self._delivery("SN-REV1").status_code, 200, "红冲后 SN 应可再次出库")

    def test_parse_serials_reports_real_state(self) -> None:
        self._receipt("SN-PARSE1")
        self.assertEqual(self._delivery("SN-PARSE1").status_code, 200)
        response = self.warehouse.post("/api/serial-ledger/parse",
                                       json={"product_id": self.product_id, "text": "SN-PARSE1"})
        item = response.json()["items"][0]
        self.assertTrue(item["exists"])
        self.assertEqual(item["status"], "retired", "预检应展示真实在库状态")

    def test_out_and_transfer_reject_sn_at_another_source_location(self) -> None:
        self._receipt("SN-SOURCE-A")
        filler = self._create(self.warehouse, "PURCHASE_RECEIPT",
                              [_line(self.product_id, "SN-SOURCE-FILL", dest=self.loc2)], self.supplier_id)
        self.assertEqual(self._post(self.warehouse, filler).status_code, 200)
        before = self._stock(self.loc2, self.conditions["new"])
        for doc_type, actor, party in (("SALES_DELIVERY", self.sales, self.customer_id),
                                        ("STOCK_TRANSFER", self.warehouse, None)):
            with self.subTest(doc_type=doc_type):
                line = _line(self.product_id, "SN-SOURCE-A", source=self.loc2,
                             dest=self.loc1 if doc_type == "STOCK_TRANSFER" else None)
                document_id = self._create(actor, doc_type, [line], party)
                with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}):
                    response = self._post(actor, document_id)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertIn("来源库位", response.json()["detail"])
                self.assertEqual(actor.get(f"/api/documents/{document_id}").json()["status"], "DRAFT")
                self.assertEqual(self._ledger_row("SN-SOURCE-A")["current_location_id"], self.loc1)
                self.assertEqual(self._stock(self.loc2, self.conditions["new"]), before)

    def test_out_and_transfer_reject_sn_with_another_condition(self) -> None:
        self._receipt("SN-CONDITION-A")
        filler = self._create(self.warehouse, "PURCHASE_RECEIPT",
                              [_line(self.product_id, "SN-CONDITION-FILL", dest=self.loc1,
                                     condition=self.conditions["used"])], self.supplier_id)
        self.assertEqual(self._post(self.warehouse, filler).status_code, 200)
        before = self._stock(self.loc1, self.conditions["used"])
        for doc_type, actor, party in (("SALES_DELIVERY", self.sales, self.customer_id),
                                        ("STOCK_TRANSFER", self.warehouse, None)):
            with self.subTest(doc_type=doc_type):
                line = _line(self.product_id, "SN-CONDITION-A", source=self.loc1,
                             dest=self.loc2 if doc_type == "STOCK_TRANSFER" else None,
                             condition=self.conditions["used"])
                document_id = self._create(actor, doc_type, [line], party)
                with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}):
                    response = self._post(actor, document_id)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertIn("成色", response.json()["detail"])
                self.assertEqual(actor.get(f"/api/documents/{document_id}").json()["status"], "DRAFT")
                self.assertEqual(self._ledger_row("SN-CONDITION-A")["condition_code"], "new")
                self.assertEqual(self._stock(self.loc1, self.conditions["used"]), before)

    def test_quick_count_rejects_wrong_sn_location_and_condition(self) -> None:
        self._receipt("SN-COUNT-A")
        for serial, location, condition in (("SN-COUNT-FILL-LOC", self.loc2, self.conditions["new"]),
                                             ("SN-COUNT-FILL-COND", self.loc1, self.conditions["used"])):
            filler = self._create(self.warehouse, "PURCHASE_RECEIPT",
                                  [_line(self.product_id, serial, dest=location, condition=condition)], self.supplier_id)
            self.assertEqual(self._post(self.warehouse, filler).status_code, 200)
            before = self._stock(location, condition)
            response = self.warehouse.post("/api/inventory/adjust", json={
                "product_id": self.product_id, "location_id": location, "uom_id": self.ea_uom_id,
                "condition_id": condition, "counted_quantity": str(before - 1), "serial_numbers": ["SN-COUNT-A"],
            })
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(self._stock(location, condition), before)
            self.assertEqual(self._ledger_row("SN-COUNT-A")["status_code"], "active")

    def test_reverse_return_restores_previous_condition_before_reversing_delivery(self) -> None:
        receipt_id = self._receipt("SN-REVERSE-COND")
        delivery_id = self._delivery_doc("SN-REVERSE-COND")
        self.assertEqual(self._post(self.sales, delivery_id).status_code, 200)
        return_id = self._create(self.sales, "SALES_RETURN",
                                 [_line(self.product_id, "SN-REVERSE-COND", dest=self.loc1,
                                        condition=self.conditions["used"])], self.customer_id)
        self.assertEqual(self._post(self.sales, return_id).status_code, 200)
        self.assertEqual(self._ledger_row("SN-REVERSE-COND")["condition_code"], "used")
        self.assertEqual(self.sales.post(f"/api/documents/{return_id}/reverse").status_code, 200)
        row = self._ledger_row("SN-REVERSE-COND")
        self.assertEqual((row["status_code"], row["condition_code"]), ("retired", "new"))
        self.assertEqual(self.sales.post(f"/api/documents/{delivery_id}/reverse").status_code, 200)
        row = self._ledger_row("SN-REVERSE-COND")
        self.assertEqual((row["status_code"], row["condition_code"], row["current_location_id"]),
                         ("active", "new", self.loc1))
        self.assertEqual(self.warehouse.post(f"/api/documents/{receipt_id}/reverse").status_code, 200)

    def test_rereceipt_reverse_restores_actual_prior_reversal_condition(self) -> None:
        first = self._receipt("SN-RECEIPT-AGAIN")
        self.assertEqual(self.warehouse.post(f"/api/documents/{first}/reverse").status_code, 200)
        again = self._create(self.warehouse, "PURCHASE_RECEIPT",
                              [_line(self.product_id, "SN-RECEIPT-AGAIN", dest=self.loc1,
                                     condition=self.conditions["used"])], self.supplier_id)
        self.assertEqual(self._post(self.warehouse, again).status_code, 200)
        self.assertEqual(self._ledger_row("SN-RECEIPT-AGAIN")["condition_code"], "used")
        response = self.warehouse.post(f"/api/documents/{again}/reverse")
        self.assertEqual(response.status_code, 200, response.text)
        row = self._ledger_row("SN-RECEIPT-AGAIN")
        self.assertEqual((row["status_code"], row["condition_code"]), ("retired", "new"))

    def test_zero_delta_count_and_quick_adjust_reject_serial_input(self) -> None:
        self._receipt("SN-ZERO-COUNT")
        before = self._stock(self.loc1, self.conditions["new"])
        line = _line(self.product_id, "SN-ZERO-COUNT", source=self.loc1)
        line["counted_quantity"] = str(before)
        count_id = self._create(self.warehouse, "STOCK_COUNT", [line])
        response = self._post(self.warehouse, count_id)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("无库存差额", response.json()["detail"])
        detail = self.warehouse.get(f"/api/documents/{count_id}").json()
        self.assertEqual(detail["status"], "DRAFT")
        self.assertIsNone(detail["lines"][0]["book_quantity"])
        adjusted = self.warehouse.post("/api/inventory/adjust", json={
            "product_id": self.product_id, "location_id": self.loc1, "uom_id": self.ea_uom_id,
            "condition_id": self.conditions["new"], "counted_quantity": str(before),
            "serial_numbers": ["SN-ZERO-COUNT"],
        })
        self.assertEqual(adjusted.status_code, 422, adjusted.text)
        self.assertEqual(self._stock(self.loc1, self.conditions["new"]), before)
        self.assertEqual(self._ledger_row("SN-ZERO-COUNT")["status_code"], "active")

    def test_all_stock_out_paths_reject_cross_unit_serials(self) -> None:
        """同库位、成色且 KG 余额足够时，也不能用 KG 流水减少 EA 登记的 SN。"""
        self._receipt("SN-CROSS-UNIT")
        filler = self._create(self.warehouse, "PURCHASE_RECEIPT", [{
            "product_id": self.product_id, "quantity": 1, "uom_id": self.kg_uom_id,
            "destination_location_id": self.loc1,
        }], self.supplier_id)
        self.assertEqual(self._post(self.warehouse, filler).status_code, 200)
        before_ea = self._stock(self.loc1, self.conditions["new"])
        before_kg = self._stock(self.loc1, self.conditions["new"], self.kg_uom_id)
        for doc_type, actor, party in (("SALES_DELIVERY", self.sales, self.customer_id),
                                        ("STOCK_TRANSFER", self.warehouse, None),
                                        ("STOCK_COUNT", self.warehouse, None)):
            with self.subTest(doc_type=doc_type):
                line = _line(self.product_id, "SN-CROSS-UNIT", source=self.loc1,
                             dest=self.loc2 if doc_type == "STOCK_TRANSFER" else None)
                line["uom_id"] = self.kg_uom_id
                if doc_type == "STOCK_COUNT":
                    line["counted_quantity"] = str(before_kg - 1)
                document_id = self._create(actor, doc_type, [line], party)
                with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}):
                    response = self._post(actor, document_id)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertIn("单位", response.json()["detail"])
                self.assertEqual(actor.get(f"/api/documents/{document_id}").json()["status"], "DRAFT")
        with patch.dict(os.environ, {"ERP_FORBID_NEGATIVE_STOCK": "1"}):
            adjusted = self.warehouse.post("/api/inventory/adjust", json={
                "product_id": self.product_id, "location_id": self.loc1, "uom_id": self.kg_uom_id,
                "condition_id": self.conditions["new"], "counted_quantity": str(before_kg - 1),
                "serial_numbers": ["SN-CROSS-UNIT"],
            })
        self.assertEqual(adjusted.status_code, 422, adjusted.text)
        self.assertIn("单位", adjusted.json()["detail"])
        self.assertEqual(self._stock(self.loc1, self.conditions["new"]), before_ea)
        self.assertEqual(self._stock(self.loc1, self.conditions["new"], self.kg_uom_id), before_kg)
        row = self._ledger_row("SN-CROSS-UNIT")
        self.assertEqual((row["status_code"], row["current_location_id"]), ("active", self.loc1))


if __name__ == "__main__":
    unittest.main()
