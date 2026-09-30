"""重设计只读接口的真实数据库契约：权限、所有权、全量汇总与历史关联。"""
from __future__ import annotations

import csv
import io
from decimal import Decimal

from tests.support.api_client import api_for, make_client
from tests.support.testdb import DbTestCase


class RedesignBackendTests(DbTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.clients = {role: api_for(role) for role in ("admin", "warehouse", "sales", "finance", "colleague")}
        cls.admin = cls.clients["admin"]
        ea = next(row for row in cls.admin.get("/api/uoms").json() if row["code"] == "EA")
        cls.product_id = cls.admin.post("/api/products", json={"display_name": "重设计精密测试仪", "default_uom_id": ea["uom_id"], "source_uom_raw": "个", "purchase_cost_price": 12}).json()["product_id"]
        cls.location_id = cls.admin.post("/api/locations", json={"code": "REDESIGN", "name": "重设计测试仓"}).json()["location_id"]
        cls.supplier_id = cls.admin.post("/api/suppliers", json={"name": "重设计供应商", "contact_person": "李测试", "phone": "18812345678"}).json()["supplier_id"]
        cls.customer_id = cls.admin.post("/api/customers", json={"name": "重设计客户", "credit_limit": 10}).json()["customer_id"]

    def draft(self, role="warehouse", doc_type="PURCHASE_ORDER", quantity=1, price=12):
        body = {"doc_type": doc_type, "party_id": self.customer_id if doc_type.startswith("SALES") else self.supplier_id,
                "source_location_id": self.location_id, "lines": [{"product_id": self.product_id, "quantity": quantity, "price": price, "destination_location_id": self.location_id}]}
        response = self.clients[role].post("/api/documents", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_workbench_roles_and_mine_match_list(self):
        draft = self.draft()
        submitted = self.draft()
        self.clients["warehouse"].post(f"/api/documents/{submitted['document_id']}/submit")
        for role, client in self.clients.items():
            response = client.get("/api/workbench/summary")
            self.assertEqual(response.status_code, 200, response.text)
            summary = response.json()
            self.assertEqual("pending_conflicts" in summary, role == "admin")
            self.assertEqual("over_credit_customers" in summary, role in {"admin", "finance"})
            if role in {"finance", "colleague"}:
                self.assertEqual(summary["pending_documents"], [])
            self.assertEqual(summary["my_draft_documents"], sum(row["count"] for row in summary["my_draft_documents_by_group"]))
            for group in summary["my_draft_documents_by_group"]:
                result = client.get("/api/documents", params={"group": group["group"], "mine": "true", "f": "status:eq:DRAFT"}).json()
                self.assertEqual(result["total"], group["count"])
        own = self.clients["warehouse"].get("/api/documents/export", params={"mine": "true", "fmt": "csv", "ids": draft["document_id"]})
        self.assertIn(draft["doc_no"], own.text)
        other = self.admin.get("/api/documents/export", params={"mine": "true", "fmt": "csv", "ids": draft["document_id"]})
        self.assertNotIn(draft["doc_no"], other.text)
        params = {"q": draft["doc_no"], "mine": "true"}
        matched = self.clients["warehouse"].get("/api/documents", params=params).json()
        self.assertEqual([row["document_id"] for row in matched["items"]], [draft["document_id"]])
        exported = self.clients["warehouse"].get("/api/documents/export", params={**params, "fmt": "csv"})
        self.assertIn(draft["doc_no"], exported.text)
        self.assertNotIn(submitted["doc_no"], exported.text)

    def test_request_ownership_names_and_waiting_counts(self):
        client = self.clients["colleague"]
        response = client.post("/api/stock-requests", json={"request_type": "RECEIPT", "destination_location_id": self.location_id,
                              "reason": "重设计申请", "lines": [{"product_id": self.product_id, "quantity": 1}]})
        self.assertEqual(response.status_code, 200, response.text)
        request = response.json()
        self.assertEqual(request["destination_location_name"], "重设计测试仓")
        self.assertIsNone(request["source_location_name"])
        client.post(f"/api/stock-requests/{request['stock_request_id']}/submit")
        self.assertGreaterEqual(client.get("/api/workbench/summary").json()["pending_requests"], 1)
        self.assertEqual(client.get("/api/workbench/summary").json()["approved_requests"], 0)
        for role in self.clients:
            result = self.clients[role].get("/api/search", params={"q": request["request_no"]}).json()
            matches = next(group["items"] for group in result["groups"] if group["kind"] == "request")
            self.assertEqual(bool(matches), role in {"admin", "warehouse", "colleague"})

    def test_search_roles_normalization_and_document_links(self):
        purchase = self.draft()
        sales = self.draft(role="sales", doc_type="SALES_ORDER")
        allowed_groups = {
            "admin": {"product", "document", "request", "customer", "supplier", "serial"},
            "warehouse": {"product", "document", "request", "supplier", "serial"},
            "sales": {"product", "document", "request", "customer"},
            "finance": {"product", "document", "request", "customer", "supplier"},
            "colleague": {"product", "request"},
        }
        for role, client in self.clients.items():
            response = client.get("/api/search", params={"q": "重设计", "limit": 500})
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            self.assertEqual({group["kind"] for group in result["groups"]}, allowed_groups[role])
            self.assertTrue(all(len(group["items"]) <= 10 for group in result["groups"]))
        full_width = ''.join(chr(ord(char) + 0xFEE0) if 33 <= ord(char) <= 126 else char for char in purchase["doc_no"])
        result = self.clients["finance"].get("/api/search", params={"q": " " + full_width + " "}).json()
        doc = next(group["items"][0] for group in result["groups"] if group["kind"] == "document")
        self.assertEqual(doc["href"], f"/purchase/purchase_order/{purchase['document_id']}")
        hidden = self.clients["finance"].get("/api/search", params={"q": sales["doc_no"]}).json()
        self.assertEqual(next(group["items"] for group in hidden["groups"] if group["kind"] == "document"), [])
        self.assertEqual(self.admin.get("/api/search", params={"q": "  "}).json(), {"q": "", "groups": []})
        self.assertEqual(self.admin.get("/api/search", params={"q": "%_' OR 1=1 --"}).status_code, 200)

    def test_history_includes_legacy_creation_edit_and_attachment(self):
        doc = self.draft()
        client = self.clients["warehouse"]
        edit = client.put(f"/api/documents/{doc['document_id']}", json={"version": doc["version"], "notes": "重设计备注"})
        self.assertEqual(edit.status_code, 200, edit.text)
        upload = client.post(f"/api/documents/{doc['document_id']}/attachments", files={"file": ("合同.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")})
        self.assertEqual(upload.status_code, 200, upload.text)
        self.assertEqual(client.post(f"/api/documents/{doc['document_id']}/submit").status_code, 200)
        response = client.get(f"/api/documents/{doc['document_id']}/history")
        self.assertEqual(response.status_code, 200, response.text)
        rows = response.json()
        self.assertEqual([row["action"] for row in rows], ["CREATE", "EDIT", "UPLOAD", "SUBMIT"])
        self.assertEqual(next(row["field_diff"] for row in rows if row["action"] == "EDIT"), {})
        self.assertTrue(all(row["actor_name"] == "测试仓管" for row in rows))
        detail = self.admin.get(f"/api/audit/{rows[0]['audit_event_id']}").json()
        self.assertEqual(detail["actor_name"], "测试仓管")
        self.assertEqual(next(row["field_diff"] for row in rows if row["action"] == "SUBMIT")["status"], ["DRAFT", "SUBMITTED"])
        self.assertEqual(self.clients["sales"].get(f"/api/documents/{doc['document_id']}/history").status_code, 403)
        self.assertEqual(self.admin.get("/api/documents/999999/history").status_code, 404)

    def test_reports_complete_totals_export_and_legacy_shapes(self):
        for amount in (13, 17, 23):
            doc = self.draft(doc_type="PURCHASE_RECEIPT", price=amount)
            posted = self.clients["warehouse"].post(f"/api/documents/{doc['document_id']}/post", json={})
            self.assertEqual(posted.status_code, 200, posted.text)
        params = {"paginated": "true", "supplier_id": self.supplier_id, "page_size": 1, "page": 2, "sort": "total_amount", "order": "asc", "f": "total_amount:gte:17"}
        page = self.admin.get("/api/reports/purchase-reconciliation", params=params).json()
        self.assertEqual(page["total"], 2)
        self.assertEqual(len(page["items"]), 1)
        self.assertEqual(Decimal(str(page["summary"]["total_amount"])), Decimal(40))
        self.assertEqual(Decimal(str(page["items"][0]["total_amount"])), Decimal(23))
        exported = self.admin.get("/api/reports/purchase-reconciliation", params={**params, "fmt": "csv"})
        self.assertEqual(len(list(csv.reader(io.StringIO(exported.content.decode("utf-8-sig"))))), 3)
        ledger = self.admin.get("/api/reports/payables", params={"paginated": "true", "party_id": self.supplier_id, "page_size": 1}).json()
        self.assertEqual(Decimal(str(ledger["summary"]["amount_up"])), Decimal(53))
        self.assertEqual(Decimal(str(ledger["summary"]["balance"])), Decimal(53))
        self.assertIn("document_id", ledger["items"][0])
        history = self.admin.get(f"/api/suppliers/{self.supplier_id}").json()["history"]
        self.assertTrue(all(row["document_id"] for row in history))
        for endpoint in ("purchase-reconciliation", "ar-ap-summary", "receivables", "payables", "inventory-cost"):
            with self.subTest(endpoint=endpoint):
                response = self.admin.get(f"/api/reports/{endpoint}", params={"paginated": "true", "page_size": 1})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(set(response.json()), {"items", "total", "page", "page_size", "summary"})
                self.assertEqual(self.clients["sales"].get(f"/api/reports/{endpoint}", params={"paginated": "true"}).status_code, 403)
                legacy = self.admin.get(f"/api/reports/{endpoint}").json()
                self.assertIsInstance(legacy, dict if endpoint in {"purchase-reconciliation", "ar-ap-summary"} else list)
        summary = self.admin.get("/api/reports/ar-ap-summary", params={"paginated": "true", "party_type": "supplier", "q": "重设计"}).json()
        self.assertEqual(Decimal(str(summary["summary"]["payable_balance"])), Decimal(53))
        inventory = self.admin.get("/api/reports/inventory-cost", params={"paginated": "true", "q": "重设计"}).json()
        self.assertEqual(Decimal(str(inventory["summary"]["cost_value"])), Decimal(36))

    def test_audit_pagination_export_and_validation(self):
        params = {"paginated": "true", "page_size": 1, "f": "target_table:eq:app_user", "sort": "audit_event_id", "order": "asc"}
        first = self.admin.get("/api/audit", params=params).json()
        second = self.admin.get("/api/audit", params={**params, "page": 2}).json()
        self.assertGreater(first["total"], 1)
        self.assertNotEqual(first["items"][0]["audit_event_id"], second["items"][0]["audit_event_id"])
        exported = self.admin.get("/api/audit/export", params={"fmt": "csv", "f": "target_table:eq:app_user", "sort": "audit_event_id", "order": "asc"})
        self.assertEqual(len(list(csv.reader(io.StringIO(exported.content.decode("utf-8-sig"))))), first["total"] + 1)
        self.assertEqual(self.clients["warehouse"].get("/api/audit", params=params).status_code, 403)
        self.assertIsInstance(self.admin.get("/api/audit").json(), list)
        for endpoint, params in (("audit", {"f": "actor_user_id:eq:garbage"}), ("reports/inventory-cost", {"f": "cost_value:gte:NaN"}),
                                 ("reports/payables", {"f": "created_at:gte:garbage"}), ("reports/payables", {"f": "unknown:eq:value"}),
                                 ("reports/ar-ap-summary", {"party_type": "evil"})):
            response = self.admin.get(f"/api/{endpoint}", params={"paginated": "true", **params})
            self.assertEqual(response.status_code, 422, response.text)

    def test_new_endpoints_require_authentication(self):
        client = make_client()
        for path in ("/api/workbench/summary", "/api/search?q=test", "/api/documents/1/history"):
            self.assertEqual(client.get(path).status_code, 401)

    def test_zero_stock_counts_products_without_netting_units_and_credit_alert(self):
        before = self.admin.get("/api/workbench/summary").json()
        uoms = self.admin.get("/api/uoms").json()
        ea = next(row["uom_id"] for row in uoms if row["code"] == "EA")
        unit = self.admin.post("/api/uoms", json={"code": "REDESIGNBOX", "display_name": "测试箱"}).json()["uom_id"]
        product = self.admin.post("/api/products", json={"display_name": "异常口径校验", "default_uom_id": ea, "source_uom_raw": "个"}).json()["product_id"]
        for uom_id, quantity in ((ea, 100), (unit, -1)):
            response = self.admin.post("/api/inventory/adjust", json={"product_id": product, "location_id": self.location_id, "uom_id": uom_id, "counted_quantity": quantity})
            self.assertEqual(response.status_code, 200, response.text)
        sales = self.draft(role="sales", doc_type="SALES_DELIVERY", price=25)
        posted = self.clients["sales"].post(f"/api/documents/{sales['document_id']}/post", json={})
        self.assertEqual(posted.status_code, 200, posted.text)
        after = self.admin.get("/api/workbench/summary").json()
        self.assertEqual(after["zero_stock_products"], before["zero_stock_products"] + 1)
        self.assertEqual(after["over_credit_customers"], before["over_credit_customers"] + 1)
        history = self.clients["finance"].get(f"/api/customers/{self.customer_id}").json()["history"]
        self.assertTrue(any(row["document_id"] == sales["document_id"] for row in history))
