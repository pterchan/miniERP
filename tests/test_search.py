import unittest

from api.search import fuzzy_search, normalize_search


class NormalizeSearchTests(unittest.TestCase):
    def test_nfkc_fullwidth_parens_to_halfwidth(self):
        self.assertEqual(normalize_search("BLA扣式电极（橙色）"), "bla扣式电极(橙色)")

    def test_removes_all_whitespace(self):
        self.assertEqual(normalize_search("EMBLA 扣式电极（橙色）"), "embla扣式电极(橙色)")

    def test_casefold(self):
        self.assertEqual(normalize_search("EMBLA"), "embla")

    def test_fullwidth_space_and_nbsp(self):
        self.assertEqual(normalize_search("A　B C"), "abc")

    def test_empty_and_none(self):
        self.assertEqual(normalize_search(""), "")
        self.assertEqual(normalize_search(None), "")


class FuzzySearchTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {"product_id": 1, "display_name": "EMBLA 扣式电极（橙色）", "manufacturer": None,
             "specification": "", "identifier_normalized": "embla 扣式电极(橙色)", "aliases_normalized": ""},
            {"product_id": 2, "display_name": "EMELA 扣式电极（橙色）", "manufacturer": None,
             "specification": "", "identifier_normalized": "", "aliases_normalized": ""},
            {"product_id": 3, "display_name": "血压计", "manufacturer": None,
             "specification": "", "identifier_normalized": "", "aliases_normalized": ""},
        ]

    def test_dropped_prefix_matches_with_score(self):
        out = fuzzy_search("BLA扣式电极（橙色）", self.rows)
        self.assertEqual(out[0]["product_id"], 1)
        self.assertEqual(out[0]["match_type"], "fuzzy")
        self.assertGreaterEqual(out[0]["match_score"], 0.8)

    def test_substitution_still_matches(self):
        out = fuzzy_search("EMELA扣式电极（橙色）", self.rows)
        self.assertTrue(any(item["product_id"] == 2 for item in out))

    def test_top_n_and_sort(self):
        out = fuzzy_search("BLA扣式电极（橙色）", self.rows, top_n=1)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["match_score"], max(item["match_score"] for item in out))

    def test_short_query_skipped(self):
        self.assertEqual(fuzzy_search("AB", self.rows), [])

    def test_unrelated_query_empty(self):
        self.assertEqual(fuzzy_search("xyzxyzxyz", self.rows), [])

    def test_pool_rows_not_mutated(self):
        pool = [{"product_id": 1, "display_name": "EMBLA 扣式电极（橙色）"}]
        out = fuzzy_search("EMBLA扣式电极", pool)
        self.assertNotIn("match_type", pool[0])
        self.assertIn("match_type", out[0])


if __name__ == "__main__":
    unittest.main()
