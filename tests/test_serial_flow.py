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

from typing import Any

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase


def _line(product_id: int, serial: str, *, source: int | None = None, dest: int | None = None) -> dict[str, Any]:
    line: dict[str, Any] = {"product_id": product_id, "quantity": 1, "serial_numbers": [serial]}
    if source is not None:
        line["source_location_id"] = source
    if dest is not None:
        line["destination_location_id"] = dest
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
        ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")
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


if __name__ == "__main__":
    import unittest

    unittest.main()
