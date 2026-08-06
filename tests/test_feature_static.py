import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
API = (ROOT / "api/main.py").read_text(encoding="utf-8")
SEARCH = (ROOT / "api/search.py").read_text(encoding="utf-8")
SCHEMAS = (ROOT / "api/schemas.py").read_text(encoding="utf-8")
FRONTEND = (ROOT / "web/src/main.jsx").read_text(encoding="utf-8")
SCAN_UTILS = (ROOT / "web/src/scan-utils.js").read_text(encoding="utf-8")
STYLES = (ROOT / "web/src/styles.css").read_text(encoding="utf-8")
LIST_UTILS = (ROOT / "web/src/list-utils.js").read_text(encoding="utf-8")
UI = (ROOT / "web/src/ui.jsx").read_text(encoding="utf-8")


class FeatureContractTests(unittest.TestCase):
    def test_product_identifier_and_detail_contract(self):
        self.assertIn('@app.get("/api/products/{product_id}")', API)
        self.assertIn("_normalize_identifier", API)
        self.assertIn("primary_identifier", SCHEMAS)
        self.assertIn("default_uom_id", SCHEMAS)

    def test_request_version_and_state_contract(self):
        self.assertIn("line_count", API)
        self.assertIn("payload.version", API)
        self.assertIn('"WITHDRAWN": {"SUBMITTED"}', API)
        self.assertIn("submitted_at=NULL", API)
        self.assertIn("至少需要一条有效明细", API)

    def test_readonly_detail_and_admin_guard_routes(self):
        for route in (
            "/api/inventory/balance/{product_id}/{location_id}/{condition_id}/{uom_id}",
            "/api/conflicts/{case_id}",
            "/api/audit/{audit_event_id}",
        ):
            self.assertIn(route, API)
        self.assertIn("不能停用或降级最后一个有效管理员", API)

    def test_mobile_ocr_and_history_router_contract(self):
        for token in ("capture=\"environment\"", "heic2any", "reshoot_required", "MAX_OCR_CANDIDATES", "100dvh"):
            source = STYLES if token == "100dvh" else SCAN_UTILS if token == "MAX_OCR_CANDIDATES" else FRONTEND
            self.assertIn(token, source)
        self.assertIn("pushState", FRONTEND)
        self.assertIn("bottom-nav", STYLES)

    def test_stock_count_and_unit_creation_contract(self):
        for route in ('@app.post("/api/inventory/adjust")', '@app.post("/api/uoms")'):
            self.assertIn(route, API)
        for token in ("InventoryAdjustIn", "counted_quantity", "change_default_unit", "UomIn", "decimal_scale"):
            self.assertIn(token, SCHEMAS)
        self.assertIn("清点库存", FRONTEND)
        self.assertIn("useIsMobile", UI)
        self.assertIn("matchMedia", UI)
        self.assertIn("first === 'count'", FRONTEND)
        self.assertIn("formatQuantity", LIST_UTILS)

    def test_conflict_edit_loop_contract(self):
        for route in ("/link-product", "/create-product", "/edit-product"):
            self.assertIn(route, API)
        for token in ("ConflictLinkIn", "ConflictCreateProductIn", "ConflictEditProductIn", "outcome"):
            self.assertIn(token, SCHEMAS)
        self.assertIn("identifier_conflicts", API)
        self.assertIn("_resolve_case", API)
        self.assertIn("关联现有货品", FRONTEND)
        self.assertIn("按观测新建货品", FRONTEND)
        self.assertIn("编辑货品主数据", FRONTEND)

    def test_fuzzy_search_contract(self):
        for token in ("normalize_search", "fuzzy_search", "SequenceMatcher"):
            self.assertIn(token, SEARCH)
        self.assertIn("LIKE %s ESCAPE", API)
        self.assertIn("_FUZZY_POOL_QUERY", API)
        self.assertIn("match_type", SEARCH)
        self.assertIn("match_score", SEARCH)
        self.assertIn("FuzzyTag", FRONTEND)
        self.assertIn("fuzzy-badge", FRONTEND)
        self.assertIn("fuzzy-badge", STYLES)


if __name__ == "__main__":
    unittest.main()
