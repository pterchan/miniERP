"""搜索/货品列表性能修复的行为回归（010 迁移 + 生成列 + 两段式取数）。

覆盖：全角/半角/空格变体命中（生成列语义 = NFKC+去空白+casefold）、
厂家/型号字段命中、无子串命中时的模糊回退、深分页末页行的库存汇总。
"""

from __future__ import annotations

from decimal import Decimal

from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase


class SearchGeneratedColumnTests(DbTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.admin = api_for("admin")
        cls.warehouse = api_for("warehouse")
        cls.ea = next(u for u in cls.admin.get("/api/uoms").json() if u["code"] == "EA")

    def _create(self, name: str, **extra: object) -> int:
        payload = {"display_name": name, "default_uom_id": self.ea["uom_id"], "source_uom_raw": "个", **extra}
        response = self.admin.post("/api/products", json=payload)
        assert response.status_code == 200, response.text
        return response.json()["product_id"]

    def _hit_ids(self, q: str) -> list[int]:
        response = self.admin.get("/api/products", params={"q": q, "page_size": 500})
        assert response.status_code == 200, response.text
        return [item["product_id"] for item in response.json()["items"]]

    def test_search_matches_fullwidth_and_space_variants(self) -> None:
        """全角字母数字、多余空格不影响命中——归一化语义与 005 时代逐字节一致。"""
        pid = self._create("ＡＢＣ １２３ 输液器")
        for q in ("abc123", "ＡＢＣ１２３", " ABC 123 ", "ａｂｃ123 输液器"):
            self.assertIn(pid, self._hit_ids(q), f"q={q!r} 应命中全角货品")

    def test_search_by_manufacturer_and_specification(self) -> None:
        pid = self._create("厂家搜索货品", manufacturer="华康 医疗", specification="5ml 灭菌型")
        for q in ("华康医疗", "５ｍｌ灭菌"):
            self.assertIn(pid, self._hit_ids(q), f"q={q!r} 应经厂家/型号生成列命中")

    def test_no_substring_match_falls_back_to_fuzzy(self) -> None:
        pid = self._create("一次性使用输液器儿童型")
        response = self.admin.get("/api/products", params={"q": "一次性使输液器儿童型"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertTrue(data.get("fuzzy"), "无子串命中时应走模糊回退")
        matches = [i for i in data["items"] if i["product_id"] == pid]
        self.assertTrue(matches, "近串查询（少一个字）应命中目标货品")
        self.assertEqual(matches[0]["match_type"], "fuzzy")
        self.assertGreaterEqual(matches[0]["match_score"], 0.6)

    def test_deep_page_returns_stock_summary(self) -> None:
        """两段式取数：OFFSET 末页行也带 stock_summary，且有流水的货品能看到数量。"""
        loc = self.admin.post("/api/locations", json={"code": "SRCHLOC", "name": "搜索测试库位"}).json()["location_id"]
        supplier_id = self.warehouse.post("/api/suppliers", json={"name": "搜索测试供应商"}).json()["supplier_id"]
        # 命名保证按 display_name 排序落在最后一位：深分页货品00..33 + 深分页货品99
        stocked_id = self._create("深分页货品99")
        doc = self.warehouse.post("/api/documents", json={
            "doc_type": "PURCHASE_RECEIPT", "party_id": supplier_id,
            "lines": [{"product_id": stocked_id, "quantity": 7, "destination_location_id": loc}],
        }).json()
        assert self.warehouse.post(f"/api/documents/{doc['document_id']}/post", json={}).status_code == 200
        for i in range(34):
            self._create(f"深分页货品{i:02d}")

        total = self.admin.get("/api/products", params={"page_size": 1}).json()["total"]
        self.assertEqual(total, 35)
        # page_size=1 + page=total → OFFSET 34 的末页，只含最后一位货品
        response = self.admin.get("/api/products", params={"page": total, "page_size": 1})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(len(data["items"]), 1)
        item = data["items"][0]
        self.assertEqual(item["display_name"], "深分页货品99")
        self.assertIsInstance(item["stock_summary"], list, "末页行必须补齐库存汇总")
        self.assertEqual([(e["uom_code"], Decimal(str(e["quantity"]))) for e in item["stock_summary"]],
                         [("EA", Decimal("7.000"))])

        # 每一页的行都应带 stock_summary 键（无流水为空数组）
        page = self.admin.get("/api/products", params={"page": 2, "page_size": 30}).json()
        self.assertTrue(page["items"])
        for row in page["items"]:
            self.assertIsInstance(row["stock_summary"], list)


if __name__ == "__main__":
    import unittest

    unittest.main()
