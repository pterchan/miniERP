import unittest
from pathlib import Path


DDL = (Path(__file__).parents[1] / "db" / "migrations" / "001_inventory.sql").read_text(encoding="utf-8")


class SchemaContractTests(unittest.TestCase):
    def test_internal_keys_and_non_unique_source_identifiers(self):
        self.assertIn("product_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY", DDL)
        self.assertIn("value_raw           TEXT NOT NULL", DDL)
        self.assertIn("CREATE UNIQUE INDEX product_identifier_verified_exclusive_uq", DDL)
        self.assertIn("WHERE is_verified AND is_exclusive", DDL)
        self.assertNotIn("UNIQUE (value_normalized)", DDL)

    def test_staging_and_business_tables_exist(self):
        for table in ("import_batch", "source_record", "product_observation", "movement_candidate", "asset_observation", "resolution_case", "data_quality_issue", "product", "product_identifier", "location", "inventory_movement", "inventory_snapshot", "asset", "asset_identifier", "asset_component_assignment", "asset_event"):
            self.assertIn(f"CREATE TABLE {table} (", DDL)

    def test_views_and_posting_guard_exist(self):
        for view in ("v_inventory_balance", "v_company_inventory_balance", "v_asset_current_state", "v_migration_reconciliation"):
            self.assertIn(f"CREATE OR REPLACE VIEW {view} AS", DDL)
        self.assertIn("CREATE TRIGGER inventory_movement_posted_shape_trg", DDL)
        self.assertIn("IF v_status_code = 'posted'", DDL)

    def test_source_row_idempotency_and_snapshot_is_audit_only(self):
        self.assertIn("UNIQUE (import_batch_id, sheet_name, block_name, source_row_number)", DDL)
        self.assertIn("Reported workbook quantity retained for migration reconciliation", DDL)
        self.assertIn("snapshot_date       DATE,", DDL)


if __name__ == "__main__":
    unittest.main()
