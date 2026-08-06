import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
MIGRATION = (ROOT / "db/migrations/006_serial_tracking.sql").read_text(encoding="utf-8")
SERIAL = (ROOT / "api/serial_tracking.py").read_text(encoding="utf-8")
DOCUMENTS = (ROOT / "api/documents.py").read_text(encoding="utf-8")
SCHEMAS = (ROOT / "api/schemas.py").read_text(encoding="utf-8")
API = (ROOT / "api/main.py").read_text(encoding="utf-8")
SERIAL_JSX = (ROOT / "web/src/serial.jsx").read_text(encoding="utf-8")
API_JS = (ROOT / "web/src/api.js").read_text(encoding="utf-8")
ROLES_JS = (ROOT / "web/src/roles.js").read_text(encoding="utf-8")
STYLES = (ROOT / "web/src/styles.css").read_text(encoding="utf-8")


class SerialContractTests(unittest.TestCase):
    def test_migration_006_schema(self):
        for token in (
            "ADD COLUMN IF NOT EXISTS serialized BOOLEAN NOT NULL DEFAULT FALSE",
            "ADD COLUMN IF NOT EXISTS product_id BIGINT REFERENCES product(product_id)",
            "asset_product_idx",
            "asset_identifier_identifier_type_check",
            "'product_serial'",
            "ADD COLUMN IF NOT EXISTS serial_numbers TEXT[]",
            "CREATE OR REPLACE VIEW v_asset_current_state",
            "product_name",
            "CREATE OR REPLACE VIEW v_serial_ledger",
        ):
            self.assertIn(token, MIGRATION)

    def test_serial_tracking_module_hooks(self):
        for token in (
            "SN_IDENT_TYPE",
            "apply_line_serials",
            "reverse_movement_serials",
            "apply_adjustment_serials",
            'APIRouter(prefix="/api/serial-ledger"',
            '"received"',
            '"issued"',
            '"transferred"',
            "identifier_type",
            '"active"',
            '"retired"',
        ):
            self.assertIn(token, SERIAL)

    def test_document_engine_sn_hooks(self):
        for token in (
            "RETURNING inventory_movement_id",
            "apply_line_serials(",
            "reverse_movement_serials(",
            "serial_numbers",
        ):
            self.assertIn(token, DOCUMENTS)

    def test_schemas_and_routes(self):
        for token in ("serialized", "serial_numbers", "SerialParseIn"):
            self.assertIn(token, SCHEMAS)
        for token in ("serial_tracking.router", '@app.post("/api/inventory/adjust")', "apply_adjustment_serials"):
            self.assertIn(token, API)

    def test_frontend_serial_contract(self):
        for token in ("SerialLedger", "SerialDetail", "SerialEntry", "序列台账"):
            self.assertIn(token, SERIAL_JSX)
        for token in ("serialLedger", "serialAsset", "parseSerials", "importSerialsFile"):
            self.assertIn(token, API_JS)
        self.assertIn("serials", ROLES_JS)
        self.assertIn("line-serial", STYLES)


if __name__ == "__main__":
    unittest.main()
