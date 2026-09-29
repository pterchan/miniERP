import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
MAIN = (ROOT / "api/main.py").read_text(encoding="utf-8")
DOCS = (ROOT / "api/documents.py").read_text(encoding="utf-8")
MASTER = (ROOT / "api/master.py").read_text(encoding="utf-8")
EXPORT = (ROOT / "api/export.py").read_text(encoding="utf-8")
LIST_PARAMS = (ROOT / "api/list_params.py").read_text(encoding="utf-8")
DATATABLE = (ROOT / "web/src/data-table.jsx").read_text(encoding="utf-8")


class ExportContractTests(unittest.TestCase):
    def test_export_helper_symbols(self):
        self.assertIn("def csv_bytes", EXPORT)
        self.assertIn("def xlsx_bytes", EXPORT)
        self.assertIn("def export_response", EXPORT)
        self.assertIn("def export_rows_by_ids", EXPORT)
        self.assertIn("utf-8-sig", EXPORT)
        self.assertIn("openpyxl", EXPORT)

    def test_disposition_header_is_ascii_safe(self):
        # 响应头按 latin-1 编码，中文必须走 filename*=UTF-8''，普通 filename= 只能含 ASCII；
        # 导出与附件下载共用 attachment_disposition，禁止各处手拼 Content-Disposition
        self.assertIn("def attachment_disposition", EXPORT)
        self.assertIn('.encode("ascii", "replace")', EXPORT)
        self.assertIn('quote(filename or "attachment", safe="")', EXPORT)
        self.assertIn("attachment_disposition(row[\"filename\"])", DOCS)
        self.assertNotIn('f\'attachment; filename="{row["filename"]}"\'', DOCS)

    def test_export_cells_neutralize_formula_injection(self):
        # CSV/XLSX 单元格以 = + - @ 等开头时会被 Excel 当公式执行，统一在 _cell 清洗
        self.assertIn("_FORMULA_PREFIXES", EXPORT)
        self.assertIn('"\'" + value', EXPORT)
        self.assertIn("_cell(extractor(row))", EXPORT)

    def test_list_params_injection_safety(self):
        self.assertIn("def parse_sort", LIST_PARAMS)
        self.assertIn("def parse_filters", LIST_PARAMS)
        self.assertIn("def parse_ids", LIST_PARAMS)
        self.assertIn("def parse_composite_ids", LIST_PARAMS)
        self.assertIn("不允许原始字符串进入 SQL", LIST_PARAMS)

    def test_products_support_sort_filter_and_page_500(self):
        self.assertIn('sort: str = "", order: str = "asc"', MAIN)
        self.assertIn("f: list[str] = Query(default=[])", MAIN)
        self.assertIn("clamp_page_size(page_size, cap=500)", MAIN)
        self.assertIn('@app.get("/api/products/export")', MAIN)

    def test_documents_export_endpoint(self):
        self.assertIn('@router.get("/export")', DOCS)
        self.assertIn("_resolve_doc_types", DOCS)
        self.assertIn("clamp_page_size(page_size, cap=500)", DOCS)

    def test_client_list_export_endpoints_exist(self):
        for route in (
            '@app.get("/api/inventory/balance/export")',
            '@app.get("/api/locations/export")',
            '@app.get("/api/admin/users/export")',
            '@app.get("/api/stock-requests/export")',
            '@app.get("/api/conflicts/export")',
            '@app.get("/api/audit/export")',
        ):
            self.assertIn(route, MAIN)
        for route in (
            '@router.get("/customers/export")',
            '@router.get("/suppliers/export")',
        ):
            self.assertIn(route, MASTER)

    def test_export_respects_ids_param(self):
        self.assertIn("ids: str = \"\"", MAIN)
        self.assertIn("parse_ids", MAIN)
        self.assertIn("parse_composite_ids", MAIN)

    def test_datatable_supports_export_and_page_size_500(self):
        self.assertIn("pageSizeOptions = [10, 25, 50, 100, 200, 500]", DATATABLE)
        self.assertIn("doExport", DATATABLE)
        self.assertIn("allScope", DATATABLE)
        self.assertIn("rowKey", DATATABLE)
        self.assertIn("toServerFilters", DATATABLE)


if __name__ == "__main__":
    unittest.main()
