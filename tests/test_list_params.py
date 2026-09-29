import unittest

from api.list_params import (
    clamp_page,
    clamp_page_size,
    parse_composite_ids,
    parse_filters,
    parse_ids,
    parse_sort,
)


class ClampTests(unittest.TestCase):
    def test_clamp_page(self):
        self.assertEqual(clamp_page(1), 1)
        self.assertEqual(clamp_page(0), 1)
        self.assertEqual(clamp_page(-3), 1)
        self.assertEqual(clamp_page(5), 5)

    def test_clamp_page_size_cap_500(self):
        self.assertEqual(clamp_page_size(1), 1)
        self.assertEqual(clamp_page_size(0), 1)
        self.assertEqual(clamp_page_size(100), 100)
        self.assertEqual(clamp_page_size(500), 500)
        self.assertEqual(clamp_page_size(999), 500)
        self.assertEqual(clamp_page_size(50, cap=100), 50)
        self.assertEqual(clamp_page_size(999, cap=100), 100)


class SortTests(unittest.TestCase):
    ALLOW = {"name": "p.name", "id": "p.id"}

    def test_allowlisted_column(self):
        self.assertEqual(parse_sort("name", "asc", self.ALLOW, "name"), "p.name ASC")
        self.assertEqual(parse_sort("id", "DESC", self.ALLOW, "name"), "p.id DESC")

    def test_unknown_sort_falls_back_to_default(self):
        # 未知列绝不进入 SQL，回退默认排序列
        self.assertEqual(parse_sort("evil_col", "asc", self.ALLOW, "name"), "p.name ASC")

    def test_empty_sort_uses_default(self):
        self.assertEqual(parse_sort("", "", self.ALLOW, "name"), "p.name ASC")


class FilterTests(unittest.TestCase):
    ALLOW = {
        "name": ("p.name", ("contains", "eq")),
        "status": ("d.status", ("in", "eq")),
        "qty": ("p.qty", ("gte", "lt")),
    }

    def test_contains_builds_parameterized_iliKE(self):
        where, params = parse_filters(["name:contains:abc"], self.ALLOW)
        self.assertEqual(where, ["p.name ILIKE %s"])
        self.assertEqual(params, ["%abc%"])

    def test_eq_passes_value_as_param(self):
        where, params = parse_filters(["name:eq:xyz"], self.ALLOW)
        self.assertEqual(where, ["p.name = %s"])
        self.assertEqual(params, ["xyz"])

    def test_range_operators(self):
        where, params = parse_filters(["qty:gte:5"], self.ALLOW)
        self.assertEqual(where, ["p.qty >= %s"])
        self.assertEqual(params, ["5"])

    def test_in_expands_placeholders(self):
        where, params = parse_filters(["status:in:OPEN,CLOSED"], self.ALLOW)
        self.assertEqual(where, ["d.status IN (%s, %s)"])
        self.assertEqual(params, ["OPEN", "CLOSED"])

    def test_empty_value_rejected_not_silently_dropped(self):
        # 空筛选值若静默跳过，等于放行无过滤全量数据——必须显式 422
        with self.assertRaises(ValueError):
            parse_filters(["name:contains:"], self.ALLOW)

    def test_unknown_operator_rejected(self):
        with self.assertRaises(ValueError):
            parse_filters(["name:gt:1"], self.ALLOW)

    def test_unknown_column_rejected(self):
        with self.assertRaises(ValueError):
            parse_filters(["evil:eq:1"], self.ALLOW)

    def test_bad_format_rejected(self):
        with self.assertRaises(ValueError):
            parse_filters(["name:contains"], self.ALLOW)


class IdTests(unittest.TestCase):
    def test_parse_ids(self):
        self.assertEqual(parse_ids("1,2,3"), [1, 2, 3])
        self.assertEqual(parse_ids("1, 2"), [1, 2])
        self.assertEqual(parse_ids(""), [])

    def test_parse_ids_rejects_non_int(self):
        with self.assertRaises(ValueError):
            parse_ids("1,abc")

    def test_parse_composite_ids(self):
        self.assertEqual(parse_composite_ids("1:2:3:4,5:6:7:8"), [(1, 2, 3, 4), (5, 6, 7, 8)])
        self.assertEqual(parse_composite_ids(""), [])

    def test_parse_composite_ids_rejects_wrong_parts(self):
        with self.assertRaises(ValueError):
            parse_composite_ids("1:2:3")


if __name__ == "__main__":
    unittest.main()
