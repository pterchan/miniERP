"""过账守卫行为测试（复现 P1：盘点无锁丢更新、超卖无校验、红冲不校验现状）。"""

from __future__ import annotations

import os
import unittest
from decimal import Decimal
from unittest.mock import patch

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase

FORBID = {"ERP_FORBID_NEGATIVE_STOCK": "1"}


class OversellSwitchTests(DbTestCase):
    product_seq = 0

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.warehouse = api_for("warehouse")
        cls.sales = api_for("sales")
        cls.loc1 = cls.admin.post("/api/locations", json={"code": "OVRLOC1", "name": "超卖库位1"}).json()["location_id"]
        cls.loc2 = cls.admin.post("/api/locations", json={"code": "OVRLOC2", "name": "超卖库位2"}).json()["location_id"]
        ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")
        cls.ea_uom_id = ea["uom_id"]
        cls.supplier_id = cls.warehouse.post("/api/suppliers", json={"name": "超卖供应商"}).json()["supplier_id"]
        cls.customer_id = cls.sales.post("/api/customers", json={"name": "超卖客户"}).json()["customer_id"]

    @classmethod
    def _fresh_product(cls) -> int:
        """每个用例独立货品：余额互不叠加，用例可任意顺序执行。"""
        cls.product_seq += 1
        return cls.admin.post("/api/products", json={
            "display_name": f"超卖测试货品{cls.product_seq}", "default_uom_id": cls.ea_uom_id, "source_uom_raw": "个",
        }).json()["product_id"]

    def _receipt(self, product_id: int, quantity: int) -> int:
        doc = self.warehouse.post("/api/documents", json={
            "doc_type": "PURCHASE_RECEIPT", "party_id": self.supplier_id,
            "lines": [{"product_id": product_id, "quantity": quantity, "destination_location_id": self.loc1}],
        }).json()
        response = self.warehouse.post(f"/api/documents/{doc['document_id']}/post", json={})
        assert response.status_code == 200, response.text
        return doc["document_id"]

    def _post_out(self, product_id: int, quantity: int, doc_type: str = "SALES_DELIVERY"):
        payload: dict = {"doc_type": doc_type,
                         "lines": [{"product_id": product_id, "quantity": quantity, "source_location_id": self.loc1}]}
        if doc_type.startswith("SALES"):
            payload["party_id"] = self.customer_id
        doc = self.sales.post("/api/documents", json=payload).json() if doc_type.startswith("SALES") \
            else self.warehouse.post("/api/documents", json=payload).json()
        actor = self.sales if doc_type.startswith("SALES") else self.warehouse
        return actor.post(f"/api/documents/{doc['document_id']}/post", json={})

    def test_oversell_rejected_when_switch_on(self) -> None:
        product_id = self._fresh_product()
        with patch.dict(os.environ, FORBID):
            response = self._post_out(product_id, 10)
        self.assertEqual(response.status_code, 422, "开启禁止超卖后，无库存出库应被拒绝")

    def test_negative_balance_allowed_when_switch_off(self) -> None:
        """默认（开关关闭）维持既有设计：允许负库存。"""
        product_id = self._fresh_product()
        response = self._post_out(product_id, 3)
        self.assertEqual(response.status_code, 200, response.text)
        rows = self.admin.get("/api/inventory/balance").json()
        row = next(r for r in rows if r["product_id"] == product_id and r["location_id"] == self.loc1)
        self.assertEqual(Decimal(row["on_hand_quantity"]), Decimal(-3))

    def test_exact_balance_out_ok_when_switch_on(self) -> None:
        product_id = self._fresh_product()
        self._receipt(product_id, 5)
        with patch.dict(os.environ, FORBID):
            response = self._post_out(product_id, 5)
        self.assertEqual(response.status_code, 200, response.text)

    def test_excess_transfer_rejected_when_switch_on(self) -> None:
        product_id = self._fresh_product()
        self._receipt(product_id, 2)
        doc = self.warehouse.post("/api/documents", json={
            "doc_type": "STOCK_TRANSFER",
            "lines": [{"product_id": product_id, "quantity": 5,
                       "source_location_id": self.loc1, "destination_location_id": self.loc2}],
        }).json()
        with patch.dict(os.environ, FORBID):
            response = self.warehouse.post(f"/api/documents/{doc['document_id']}/post", json={})
        self.assertEqual(response.status_code, 422, "开启开关后调拨超出余量应被拒绝")

    def test_reverse_of_consumed_receipt_rejected_when_switch_on(self) -> None:
        product_id = self._fresh_product()
        receipt_id = self._receipt(product_id, 4)
        self.assertEqual(self._post_out(product_id, 4).status_code, 200)
        with patch.dict(os.environ, FORBID):
            response = self.warehouse.post(f"/api/documents/{receipt_id}/reverse")
        self.assertEqual(response.status_code, 422, "货已全部售出时红冲入库单会打出负库存，开启开关后应拒绝")

    def test_reverse_when_stock_intact_ok_when_switch_on(self) -> None:
        product_id = self._fresh_product()
        receipt_id = self._receipt(product_id, 3)
        with patch.dict(os.environ, FORBID):
            response = self.warehouse.post(f"/api/documents/{receipt_id}/reverse")
        self.assertEqual(response.status_code, 200, response.text)

    def test_count_down_below_stock_rejected_when_switch_on(self) -> None:
        product_id = self._fresh_product()
        self._receipt(product_id, 5)
        doc = self.warehouse.post("/api/documents", json={
            "doc_type": "STOCK_COUNT",
            "lines": [{"product_id": product_id, "quantity": 5, "counted_quantity": -1,
                       "source_location_id": self.loc1}],
        }).json()
        with patch.dict(os.environ, FORBID):
            response = self.warehouse.post(f"/api/documents/{doc['document_id']}/post", json={})
        self.assertEqual(response.status_code, 422, "盘点为负无业务意义，开启开关后应拒绝")


class ReverseSerialGuardTests(DbTestCase):
    """红冲的 SN 现状校验（始终启用，与超卖开关无关）。"""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.warehouse = api_for("warehouse")
        cls.sales = api_for("sales")
        cls.loc1 = cls.admin.post("/api/locations", json={"code": "RSGLOC", "name": "红冲SN库位"}).json()["location_id"]
        ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")
        cls.product_id = cls.admin.post("/api/products", json={
            "display_name": "红冲SN货品", "serialized": True, "default_uom_id": ea["uom_id"], "source_uom_raw": "个",
        }).json()["product_id"]
        cls.supplier_id = cls.warehouse.post("/api/suppliers", json={"name": "红冲SN供应商"}).json()["supplier_id"]
        cls.customer_id = cls.sales.post("/api/customers", json={"name": "红冲SN客户"}).json()["customer_id"]

    def _receipt(self, serial: str) -> int:
        doc = self.warehouse.post("/api/documents", json={
            "doc_type": "PURCHASE_RECEIPT", "party_id": self.supplier_id,
            "lines": [{"product_id": self.product_id, "quantity": 1, "serial_numbers": [serial],
                       "destination_location_id": self.loc1}],
        }).json()
        assert self.warehouse.post(f"/api/documents/{doc['document_id']}/post", json={}).status_code == 200
        return doc["document_id"]

    def _delivery(self, serial: str) -> int:
        doc = self.sales.post("/api/documents", json={
            "doc_type": "SALES_DELIVERY", "party_id": self.customer_id,
            "lines": [{"product_id": self.product_id, "quantity": 1, "serial_numbers": [serial],
                       "source_location_id": self.loc1}],
        }).json()
        assert self.sales.post(f"/api/documents/{doc['document_id']}/post", json={}).status_code == 200
        return doc["document_id"]

    def test_reverse_delivery_blocked_when_sn_already_returned(self) -> None:
        """红冲出库单=SN 回库；若 SN 已被退货单回库，再红冲会重复计入。"""
        self._receipt("RSG-1")
        delivery_id = self._delivery("RSG-1")
        returned = self.sales.post("/api/documents", json={
            "doc_type": "SALES_RETURN", "party_id": self.customer_id,
            "lines": [{"product_id": self.product_id, "quantity": 1, "serial_numbers": ["RSG-1"],
                       "destination_location_id": self.loc1}],
        }).json()
        assert self.sales.post(f"/api/documents/{returned['document_id']}/post", json={}).status_code == 200
        response = self.sales.post(f"/api/documents/{delivery_id}/reverse")
        self.assertEqual(response.status_code, 422, "SN 已在库时红冲原出库单应拒绝")

    def test_reverse_receipt_blocked_when_sn_sold(self) -> None:
        """红冲入库单=SN 出库；若 SN 已售出，再红冲会造成矛盾事件。"""
        receipt_id = self._receipt("RSG-2")
        self._delivery("RSG-2")
        response = self.warehouse.post(f"/api/documents/{receipt_id}/reverse")
        self.assertEqual(response.status_code, 422, "SN 已出库时红冲原入库单应拒绝")

    def test_reverse_normal_flow_still_works(self) -> None:
        receipt_id = self._receipt("RSG-3")
        delivery_id = self._delivery("RSG-3")
        self.assertEqual(self.sales.post(f"/api/documents/{delivery_id}/reverse").status_code, 200)
        self.assertEqual(self.warehouse.post(f"/api/documents/{receipt_id}/reverse").status_code, 200)


if __name__ == "__main__":
    unittest.main()
