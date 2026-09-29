"""附件端点访问控制行为测试（复现 P1：附件读/写零对象级授权）。

覆盖：
- 无该单据查看权的角色（COLLEAGUE）不能下载/上传附件（现状放行 → 红）；
- 有查看权的角色可正常下载（回归）；
- 已过账/红冲单据不可再追加附件（现状放行 → 红）；
- 单个单据附件数量上限（现状无上限 → 红）。
"""

from __future__ import annotations

from typing import Any

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase

FILE = {"file": ("合同扫描件.txt", b"purchase-contract-secret", "text/plain")}


class AttachmentAccessTests(DbTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.warehouse = api_for("warehouse")
        cls.colleague = api_for("colleague")
        cls.loc1 = cls.admin.post("/api/locations", json={"code": "ATTLOC", "name": "附件测试库位"}).json()["location_id"]
        ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")
        cls.product_id = cls.admin.post("/api/products", json={
            "display_name": "附件测试货品", "default_uom_id": ea["uom_id"], "source_uom_raw": "个",
        }).json()["product_id"]
        cls.supplier_id = cls.warehouse.post("/api/suppliers", json={"name": "附件测试供应商"}).json()["supplier_id"]

    def _draft_doc(self) -> int:
        response = self.warehouse.post("/api/documents", json={
            "doc_type": "PURCHASE_ORDER", "party_id": self.supplier_id,
            "lines": [{"product_id": self.product_id, "quantity": 1}],
        })
        assert response.status_code == 200, response.text
        return response.json()["document_id"]

    def _posted_doc(self) -> int:
        doc_id = self._draft_doc()
        response = self.warehouse.post(f"/api/documents/{doc_id}/post", json={})
        assert response.status_code == 200, response.text
        return doc_id

    def _upload(self, api: Any, document_id: int) -> Any:
        return api.post(f"/api/documents/{document_id}/attachments", files=dict(FILE))

    def test_colleague_cannot_download_attachment(self) -> None:
        doc_id = self._draft_doc()
        created = self._upload(self.warehouse, doc_id).json()
        response = self.colleague.get(f"/api/attachments/{created['attachment_id']}")
        self.assertEqual(response.status_code, 403, "无单据查看权的角色不应能下载附件")
        self.assertNotIn(b"purchase-contract-secret", response.content)

    def test_colleague_cannot_upload_attachment(self) -> None:
        doc_id = self._draft_doc()
        response = self._upload(self.colleague, doc_id)
        self.assertEqual(response.status_code, 403, "无单据查看权的角色不应能上传附件")

    def test_warehouse_can_download_attachment(self) -> None:
        doc_id = self._draft_doc()
        created = self._upload(self.warehouse, doc_id).json()
        response = self.warehouse.get(f"/api/attachments/{created['attachment_id']}")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"purchase-contract-secret", response.content)

    def test_cannot_attach_to_posted_document(self) -> None:
        doc_id = self._posted_doc()
        response = self._upload(self.warehouse, doc_id)
        self.assertEqual(response.status_code, 409, "已过账单据不可追加附件")

    def test_cannot_attach_to_reversed_document(self) -> None:
        doc_id = self._posted_doc()
        response = self.warehouse.post(f"/api/documents/{doc_id}/reverse")
        assert response.status_code == 200, response.text
        response = self._upload(self.warehouse, doc_id)
        self.assertEqual(response.status_code, 409, "已红冲单据不可追加附件")

    def test_attachment_count_per_document_capped(self) -> None:
        doc_id = self._draft_doc()
        for _ in range(20):
            response = self._upload(self.warehouse, doc_id)
            assert response.status_code == 200, response.text
        self.assertEqual(self._upload(self.warehouse, doc_id).status_code, 422, "单个单据附件数量应有上限")

    def test_download_missing_attachment_404(self) -> None:
        self.assertEqual(self.warehouse.get("/api/attachments/999999").status_code, 404)


if __name__ == "__main__":
    import unittest

    unittest.main()
