"""单据流程行为测试：SUBMITTED 撤回/驳回（补齐 OA 流程闭环）。"""

from __future__ import annotations

from typing import Any

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase


def _doc_payload(product_id: int, supplier_id: int) -> dict[str, Any]:
    return {"doc_type": "PURCHASE_ORDER", "party_id": supplier_id,
            "lines": [{"product_id": product_id, "quantity": 1}]}


class DocumentWorkflowTests(DbTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.warehouse = api_for("warehouse")
        cls.finance = api_for("finance")
        ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")
        cls.product_id = cls.admin.post("/api/products", json={
            "display_name": "流程测试货品", "default_uom_id": ea["uom_id"], "source_uom_raw": "个",
        }).json()["product_id"]
        cls.supplier_id = cls.warehouse.post("/api/suppliers", json={"name": "流程供应商"}).json()["supplier_id"]

    def _draft(self) -> int:
        response = self.warehouse.post("/api/documents", json=_doc_payload(self.product_id, self.supplier_id))
        assert response.status_code == 200, response.text
        return response.json()["document_id"]

    def _submitted(self) -> int:
        doc_id = self._draft()
        assert self.warehouse.post(f"/api/documents/{doc_id}/submit").status_code == 200
        return doc_id

    def test_creator_can_withdraw_submitted(self) -> None:
        doc_id = self._submitted()
        response = self.warehouse.post(f"/api/documents/{doc_id}/withdraw")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "DRAFT")
        from api.db import connection, fetch_one
        with connection() as conn:
            row = fetch_one(conn, "SELECT action FROM audit_event WHERE action='WITHDRAW' AND target_table='business_document' ORDER BY audit_event_id DESC LIMIT 1")
        self.assertIsNotNone(row, "撤回必须落审计")

    def test_non_creator_cannot_withdraw(self) -> None:
        doc_id = self._submitted()
        self.assertEqual(self.admin.post(f"/api/documents/{doc_id}/withdraw").status_code, 403)

    def test_withdraw_requires_submitted(self) -> None:
        doc_id = self._draft()
        self.assertEqual(self.warehouse.post(f"/api/documents/{doc_id}/withdraw").status_code, 409)

    def test_post_role_can_reject_submitted(self) -> None:
        doc_id = self._submitted()
        response = self.admin.post(f"/api/documents/{doc_id}/reject")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "DRAFT")

    def test_non_post_role_cannot_reject(self) -> None:
        doc_id = self._submitted()
        self.assertEqual(self.finance.post(f"/api/documents/{doc_id}/reject").status_code, 403)

    def test_reject_requires_submitted(self) -> None:
        doc_id = self._draft()
        self.assertEqual(self.admin.post(f"/api/documents/{doc_id}/reject").status_code, 409)

    def test_withdrawn_document_can_be_resubmitted(self) -> None:
        doc_id = self._submitted()
        assert self.warehouse.post(f"/api/documents/{doc_id}/withdraw").status_code == 200
        self.assertEqual(self.warehouse.post(f"/api/documents/{doc_id}/submit").status_code, 200)


if __name__ == "__main__":
    import unittest

    unittest.main()
