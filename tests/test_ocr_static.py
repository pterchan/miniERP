import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
CONTRACTS = (ROOT / "ocr_service/contracts.py").read_text(encoding="utf-8")
PIPELINE = (ROOT / "ocr_service/pipeline.py").read_text(encoding="utf-8")
API = (ROOT / "api/main.py").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")


class OCRContractTests(unittest.TestCase):
    def test_versioned_contract_and_required_sections(self) -> None:
        for field in ("schema_version", "raw_text", "lines", "labels", "fields", "key_values", "search_terms", "diagnostics"):
            self.assertIn(field, CONTRACTS)

    def test_generic_pipeline_does_not_bind_to_sample_brand(self) -> None:
        self.assertNotIn("sample vendor", PIPELINE)
        self.assertIn("cluster_lines", PIPELINE)
        self.assertIn("rotate_variant", PIPELINE)

    def test_erp_proxy_and_private_service_are_wired(self) -> None:
        self.assertIn("/api/ocr/extract", API)
        self.assertIn("http://ocr:8010", COMPOSE)
        self.assertIn("OCR_INTERNAL_TOKEN", COMPOSE)
        self.assertIn("expose:", COMPOSE)


if __name__ == "__main__":
    unittest.main()
