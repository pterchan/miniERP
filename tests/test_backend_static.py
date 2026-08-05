import re
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
DDL = (ROOT / "db/migrations/002_erp_oa.sql").read_text(encoding="utf-8")
FULL_DDL = (ROOT / "db/migrations/003_full_erp.sql").read_text(encoding="utf-8")
API = (ROOT / "api/main.py").read_text(encoding="utf-8")
SEED = (ROOT / "scripts/seed_inventory.py").read_text(encoding="utf-8")


class BackendContractTests(unittest.TestCase):
    def test_approval_and_audit_tables(self):
        for table in ("app_user", "app_session", "audit_event", "stock_request", "stock_request_line", "stock_request_action"):
            self.assertIn(f"CREATE TABLE {table} (", DDL)
        self.assertIn("audit_event_immutable_trg", DDL)
        self.assertIn("production write requires app.actor_id", DDL)

    def test_roles_and_state_machine_are_constrained(self):
        self.assertIn("WAREHOUSE_ADMIN", DDL)
        self.assertIn("REQUESTER", DDL)
        for state in ("DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "RELEASED", "WITHDRAWN"):
            self.assertIn(state, DDL)
        for role in ("'ADMIN'", "'WAREHOUSE'", "'SALES'", "'FINANCE'", "'COLLEAGUE'"):
            self.assertIn(role, FULL_DDL)

    def test_required_routes_and_cookie_csrf(self):
        for route in ("/api/auth/login", "/api/products", "/api/inventory/balance", "/api/stock-requests", "/submit", "/approve", "/reject", "/release", "/api/conflicts", "/api/audit"):
            self.assertIn(route, API)
        self.assertIn("httponly=True", API)
        self.assertIn("X-CSRF-Token", API)

    def test_passwords_are_not_logged_or_stored_plaintext(self):
        self.assertIn("hash_password", API)
        self.assertNotIn("print(payload.password", API)

    def test_admin_management_and_seed_observation_contract(self):
        for route in ("/api/uoms", "/api/locations", "/api/admin/users"):
            self.assertIn(route, API)
        for table in ("product_observation", "movement_candidate", "asset_observation"):
            self.assertIn(table, SEED)
        self.assertIn("--post-opening", SEED)
        self.assertIn("open_case", SEED)


if __name__ == "__main__":
    unittest.main()
