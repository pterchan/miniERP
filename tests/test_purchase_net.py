"""采购净额在列表、分页摘要、筛选、导出与红冲中的同一口径。"""
import csv
import io
from decimal import Decimal

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase


class PurchaseNetTests(DbTestCase):
    def test_receipt_return_and_reversals_share_net_amount(self):
        admin, warehouse = api_for("admin"), api_for("warehouse")
        uom_id = next(row["uom_id"] for row in admin.get("/api/uoms").json() if row["code"] == "EA")
        pid = admin.post("/api/products", json={"display_name": "采购净额货品", "default_uom_id": uom_id}).json()["product_id"]
        loc = admin.post("/api/locations", json={"code": "NET", "name": "采购净额仓"}).json()["location_id"]
        supplier = warehouse.post("/api/suppliers", json={"name": "采购净额供应商"}).json()["supplier_id"]

        def post(kind, quantity):
            line = {"product_id": pid, "quantity": quantity, "price": 10,
                    "destination_location_id" if kind == "PURCHASE_RECEIPT" else "source_location_id": loc}
            response = warehouse.post("/api/documents", json={"doc_type": kind, "party_id": supplier, "lines": [line]})
            self.assertEqual(response.status_code, 200, response.text)
            document_id = response.json()["document_id"]
            response = warehouse.post(f"/api/documents/{document_id}/post", json={})
            self.assertEqual(response.status_code, 200, response.text)
            return document_id

        receipt, returned = post("PURCHASE_RECEIPT", 10), post("PURCHASE_RETURN", 3)
        endpoint = "/api/reports/purchase-reconciliation"
        params = {"supplier_id": supplier, "paginated": "true", "page_size": 1, "sort": "total_amount", "order": "asc"}
        data = admin.get(endpoint, params=params).json()
        self.assertEqual(data["total"], 2)
        self.assertEqual(Decimal(str(data["summary"]["total_amount"])), Decimal(70))
        self.assertEqual(Decimal(str(data["items"][0]["total_amount"])), Decimal(-30))
        second_page = admin.get(endpoint, params={**params, "page": 2}).json()
        self.assertEqual(Decimal(str(second_page["items"][0]["total_amount"])), Decimal(100))
        self.assertEqual(Decimal(str(second_page["summary"]["total_amount"])), Decimal(70))
        filtered = admin.get(endpoint, params={**params, "f": "total_amount:lt:0"}).json()
        self.assertEqual(filtered["total"], 1)
        self.assertEqual(Decimal(str(filtered["summary"]["total_amount"])), Decimal(-30))
        response = admin.get(endpoint, params={**params, "fmt": "csv"})
        self.assertEqual(response.status_code, 200, response.text)
        rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
        self.assertEqual([Decimal(row["金额"]) for row in rows], [Decimal(-30), Decimal(100)])
        filtered_export = admin.get(endpoint, params={**params, "f": "total_amount:lt:0", "fmt": "csv"})
        self.assertEqual(filtered_export.status_code, 200, filtered_export.text)
        filtered_rows = list(csv.DictReader(io.StringIO(filtered_export.content.decode("utf-8-sig"))))
        self.assertEqual([Decimal(row["金额"]) for row in filtered_rows], [Decimal(-30)])
        legacy = admin.get(endpoint, params={"supplier_id": supplier}).json()
        self.assertEqual(len(legacy["rows"]), 2)

        for document_id, expected in ((returned, 100), (receipt, 0)):
            response = warehouse.post(f"/api/documents/{document_id}/reverse")
            self.assertEqual(response.status_code, 200, response.text)
            data = admin.get(endpoint, params=params).json()
            self.assertEqual(Decimal(str(data["summary"]["total_amount"])), Decimal(expected))
            self.assertTrue(all(row["document_id"] != document_id for row in data["items"]))
        self.assertEqual(data["total"], 0)
        self.assertEqual(admin.get(endpoint, params={"supplier_id": supplier}).json(), {"rows": []})
