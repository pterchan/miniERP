"""seed_inventory --apply 行为测试（复现 P1：未知单位静默回退、跨文件重复双倍过账）。"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from tests.support.testdb import DbTestCase, test_database_url

MAPPING = {
    "version": 1,
    "sheets": [
        {"name": "Items", "role": "products", "header_row": 1,
         "columns": {"identifier": "SKU", "name": "Product", "uom": "Unit",
                     "opening_quantity": "Opening", "existing_quantity": "On hand"}},
        {"name": "Inbound log", "role": "movement", "movement_type": "RECEIPT", "header_row": 1,
         "columns": {"identifier": "SKU", "name": "Product", "date": "Date",
                     "quantity": "Quantity", "uom": "Unit"}},
    ],
}


def _build_workbook(path: Path, unit: str, sku: str, name: str, note_cell: str = "x") -> None:
    workbook = Workbook()
    products = workbook.active
    products.title = "Items"
    products.append(["SKU", "Product", "Unit", "Opening", "On hand", "Internal comment"])
    products.append([sku, name, "EA", None, 0, note_cell])
    receipts = workbook.create_sheet("Inbound log")
    receipts.append(["SKU", "Product", "Date", "Quantity", "Unit", "Note"])
    receipts.append([sku, name, "2024-01-02", 3, unit, note_cell])
    workbook.save(path)
    workbook.close()


def _run_seed(input_path: Path, mapping_path: Path) -> dict:
    import seed_inventory
    args = argparse.Namespace(input=str(input_path), mapping=str(mapping_path), password="",
                              apply=True, post_opening=False, cutover_date=None)
    return seed_inventory.load(args)


def _fetch_one(sql: str, params: tuple = ()):
    from api.db import connection, fetch_one
    with connection() as conn:
        return fetch_one(conn, sql, params)


class SeedApplyTests(DbTestCase):
    seq = 0

    def _prepare(self, unit: str, note_cell: str = "x", sku: str | None = None, name: str | None = None) -> tuple[Path, Path]:
        """默认每个用例独立 SKU/货名（row_hash 互不相同）；重导用例可显式复用。"""
        if sku is None:
            SeedApplyTests.seq += 1
            sku = f"{9000 + SeedApplyTests.seq}"
            name = f"Seed 测试货品{SeedApplyTests.seq}"
        temp = tempfile.TemporaryDirectory(prefix="mini-erp-seed-test-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        workbook_path = root / "synthetic.xlsx"
        mapping_path = root / "mapping.json"
        _build_workbook(workbook_path, unit, sku, name or f"Seed 测试货品{sku}", note_cell)
        mapping_path.write_text(json.dumps(MAPPING), encoding="utf-8")
        return workbook_path, mapping_path

    def test_unknown_unit_marks_review_instead_of_silent_fallback(self) -> None:
        """「桶」无法识别时应进人工复核，而不是按产品默认单位 EA 静默过账。"""
        workbook_path, mapping_path = self._prepare(unit="桶")
        result = _run_seed(workbook_path, mapping_path)
        self.assertEqual(result["counts"].get("movements", 0), 0, "未知单位的历史流水不应自动过账")
        issue = _fetch_one("SELECT issue_code FROM data_quality_issue WHERE issue_code='unknown_uom'")
        self.assertIsNotNone(issue, "未知单位必须记录 data_quality_issue 进复核")
        case = _fetch_one("""SELECT rc.resolution_case_id FROM resolution_case rc
                              JOIN source_record sr ON sr.source_record_id=rc.source_record_id
                              JOIN movement_candidate mc ON mc.source_record_id=sr.source_record_id
                             WHERE sr.sheet_name='Inbound log'""")
        self.assertIsNotNone(case, "未知单位应开复核案例")
        unknown = _fetch_one("SELECT uom_id FROM uom WHERE code='UNKNOWN'")
        candidate = _fetch_one("""SELECT mc.uom_id FROM movement_candidate mc
                                   JOIN source_record sr ON sr.source_record_id=mc.source_record_id
                                  WHERE sr.sheet_name='Inbound log'
                                  ORDER BY mc.movement_candidate_id DESC""")
        self.assertEqual(candidate["uom_id"], unknown["uom_id"], "候选项应暂存为 UNKNOWN 单位")

    def test_reimport_with_different_sha_does_not_double_post(self) -> None:
        """同一逻辑数据换文件（不同 SHA）再次 --apply 不得双倍过账。"""
        workbook_path, mapping_path = self._prepare(unit="EA", note_cell="first", sku="9100", name="重导测试货品")
        first = _run_seed(workbook_path, mapping_path)
        self.assertEqual(first["counts"].get("movements", 0), 1)

        # 相同 SKU/货名（映射列内容一致 → 同 row_hash），仅未映射单元格变化 → 新 SHA 新批次
        workbook_path2, mapping_path2 = self._prepare(unit="EA", note_cell="second", sku="9100", name="重导测试货品")
        second = _run_seed(workbook_path2, mapping_path2)
        balance = _fetch_one("""SELECT COALESCE(sum(im.quantity),0) AS total FROM inventory_movement im
                                  JOIN product p ON p.product_id=im.product_id
                                  JOIN record_status rs ON rs.status_id=im.status_id
                                 WHERE rs.code='posted' AND p.display_name='重导测试货品'""")
        self.assertEqual(int(balance["total"]), 3, "换文件重导不得双倍过账")
        issue = _fetch_one("SELECT issue_code FROM data_quality_issue WHERE issue_code='duplicate_movement'")
        self.assertIsNotNone(issue, "内容重复应记录 duplicate_movement 进复核")

    def test_first_import_still_posts_clean_receipt(self) -> None:
        workbook_path, mapping_path = self._prepare(unit="EA")
        result = _run_seed(workbook_path, mapping_path)
        self.assertEqual(result["counts"].get("movements", 0), 1, "干净流水首次导入仍应正常过账")


if __name__ == "__main__":
    unittest.main()
