import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
MIGRATION = (ROOT / "db/migrations/003_full_erp.sql").read_text(encoding="utf-8")
PERMISSIONS = (ROOT / "api/permissions.py").read_text(encoding="utf-8")
DOCUMENTS = (ROOT / "api/documents.py").read_text(encoding="utf-8")
MASTER = (ROOT / "api/master.py").read_text(encoding="utf-8")
REPORTS = (ROOT / "api/reports.py").read_text(encoding="utf-8")
SCHEMAS = (ROOT / "api/schemas.py").read_text(encoding="utf-8")
API = (ROOT / "api/main.py").read_text(encoding="utf-8")
DOCS_JSX = (ROOT / "web/src/documents.jsx").read_text(encoding="utf-8")
API_JS = (ROOT / "web/src/api.js").read_text(encoding="utf-8")
ROLES_JS = (ROOT / "web/src/roles.js").read_text(encoding="utf-8")


class ERPContractTests(unittest.TestCase):
    def test_full_erp_tables_and_sequences(self):
        for token in (
            "CREATE TABLE business_document (",
            "CREATE TABLE business_document_line (",
            "CREATE TABLE ar_ap_entry (",
            "CREATE TABLE document_attachment (",
            "CREATE TABLE product_category (",
            "CREATE TABLE customer (",
            "CREATE TABLE supplier (",
            "CREATE TABLE product_price_tier (",
            "CREATE TABLE department (",
            "CREATE SEQUENCE IF NOT EXISTS document_no_seq",
            "app_user_role_check",
        ):
            self.assertIn(token, MIGRATION)
        self.assertIn("PURCHASE_IN", MIGRATION)
        self.assertIn("SALES_OUT", MIGRATION)
        self.assertIn("STOCK_LOSS", MIGRATION)

    def test_five_roles_and_rbac_helpers(self):
        for role in ("'ADMIN'", "'WAREHOUSE'", "'SALES'", "'FINANCE'", "'COLLEAGUE'"):
            self.assertIn(role, MIGRATION)
        self.assertIn("VALID_ROLES", PERMISSIONS)
        self.assertIn("require_roles", PERMISSIONS)
        self.assertIn("_can_post", PERMISSIONS)
        self.assertIn("override_review", PERMISSIONS)
        self.assertIn("ROLE_LABELS", ROLES_JS)
        self.assertIn("canView", ROLES_JS)

    def test_document_engine_routes(self):
        for token in (
            '@router.post("")',
            '@router.put("/{document_id}")',
            '@router.post("/{document_id}/submit")',
            '@router.post("/{document_id}/post")',
            '@router.post("/{document_id}/reverse")',
            '@router.post("/{document_id}/attachments")',
            'attachments_router = APIRouter(prefix="/api/attachments"',
        ):
            self.assertIn(token, DOCUMENTS)
        self.assertIn("INVERSE_MOVEMENT", DOCUMENTS)
        self.assertIn("DOC_TYPE_META", PERMISSIONS)

    def test_master_and_report_routes(self):
        for token in (
            '@router.get("/categories")',
            '@router.get("/customers")',
            '@router.post("/customers")',
            '@router.get("/suppliers")',
            '@router.post("/suppliers")',
            '@router.post("/products/{product_id}/price-tiers")',
        ):
            self.assertIn(token, MASTER)
        for token in (
            '@router.get("/purchase-reconciliation")',
            '@router.get("/ar-ap-summary")',
            '@router.get("/receivables")',
            '@router.get("/payables")',
            '@router.get("/inventory-cost")',
        ):
            self.assertIn(token, REPORTS)
        self.assertIn('@app.post("/api/auth/change-password")', API)

    def test_schemas_and_frontend_contract(self):
        for token in ("DocCreateIn", "DocLineIn", "DocUpdateIn", "AttachmentIn", "ChangePasswordIn", "CustomerIn", "SupplierIn", "PriceTierIn", "ROLE_VALUES"):
            self.assertIn(token, SCHEMAS)
        for token in ("DOC_TYPE_CONFIG", "红冲", "override_review", "documentRoute"):
            self.assertIn(token, DOCS_JSX)
        for token in ("attachmentUrl", "reverseDocument", "postDocument", "changePassword"):
            self.assertIn(token, API_JS)


if __name__ == "__main__":
    unittest.main()
