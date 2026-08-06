"""纯 Python 产品搜索辅助（仅标准库，不依赖数据库）。

与 api/main.py 分离，便于无 FastAPI/psycopg2 的单元测试。

归一化只用于搜索匹配，绝不写入数据库的 *_normalized 列——
那是写入期由 _normalize_identifier 生成的、受唯一约束约束的持久值。
"""
from __future__ import annotations

import unicodedata
from difflib import SequenceMatcher
from typing import Any, Iterable

# 1-2 字符的查询不做模糊，避免低价值噪音
FUZZY_MIN_QUERY_LEN = 3
# SequenceMatcher ratio 下限；低于视为不相关
FUZZY_THRESHOLD = 0.6
# 模糊结果条数上限
FUZZY_TOP_N = 5


def normalize_search(value: str) -> str:
    """NFKC + 去除全部空白 + 小写。仅用于搜索匹配，绝不可写入 *_normalized 列。"""
    return "".join(unicodedata.normalize("NFKC", value or "").split()).casefold()


def candidate_fields(row: dict[str, Any]) -> list[str]:
    """单个货品的可搜索字段（已 normalize_search）。"""
    out: list[str] = []
    for key in (
        "display_name",
        "manufacturer",
        "specification",
        "identifier_normalized",
        "aliases_normalized",
    ):
        text = normalize_search(row.get(key) or "")
        if text:
            out.append(text)
    return out


def _best_score(query: str, fields: list[str]) -> float:
    """逐字段取最大相似度，避免长货品名稀释短字段（编号）的命中。"""
    best = 0.0
    for field in fields:
        ratio = SequenceMatcher(None, query, field).ratio()
        if ratio > best:
            best = ratio
    return best


def fuzzy_search(
    query: str,
    rows: Iterable[dict[str, Any]],
    *,
    threshold: float = FUZZY_THRESHOLD,
    top_n: int = FUZZY_TOP_N,
    min_query_len: int = FUZZY_MIN_QUERY_LEN,
) -> list[dict[str, Any]]:
    """对候选行打分，返回带 match_type/match_score 的货品行副本（不污染候选池）。"""
    q = normalize_search(query)
    if len(q) < min_query_len:
        return []
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        score = _best_score(q, candidate_fields(row))
        if score >= threshold:
            item = dict(row)
            item["match_type"] = "fuzzy"
            item["match_score"] = round(score, 3)
            scored.append((score, item))
    scored.sort(key=lambda pair: (-pair[0], pair[1].get("display_name") or ""))
    return [item for _, item in scored[:top_n]]
