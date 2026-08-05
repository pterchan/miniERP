"""可复用、防注入的排序/筛选/分页解析，列表接口与导出接口共用同一套构造器，
保证「当前视图 = 导出结果」。

所有列名/操作符都来自白名单，值一律作为绑定参数传入，绝不允许原始字符串进入 SQL。
"""

from __future__ import annotations

from typing import Any

_ALLOWED_OPS = ("contains", "eq", "ne", "gt", "gte", "lt", "lte", "in")


def clamp_page(page: int) -> int:
    return max(1, int(page))


def clamp_page_size(page_size: int, cap: int = 500) -> int:
    return max(1, min(cap, int(page_size)))


def parse_sort(sort: str, order: str, allowlist: dict[str, str], default: str) -> str:
    """allowlist: {query_key: sql_expression}。未知排序列回退到 default。"""
    expr = allowlist.get(sort) or allowlist.get(default) or next(iter(allowlist.values()))
    direction = "DESC" if str(order).upper() == "DESC" else "ASC"
    return f"{expr} {direction}"


def parse_filters(filters: list[str], allow: dict[str, tuple[str, tuple[str, ...]]]) -> tuple[list[str], list[Any]]:
    """filters: ['col:op:value', ...]；allow: {col: (sql_expr, allowed_ops)}。

    返回 (where_parts, params)，所有值均为绑定参数。列名/操作符不在白名单时抛 ValueError。
    op 支持：contains（ILIKE %val%）、eq、ne、gt、gte、lt、lte、in（逗号分隔）。
    """
    where: list[str] = []
    params: list[Any] = []
    for item in filters:
        parts = item.split(":", 2)
        if len(parts) != 3:
            raise ValueError(f"筛选格式应为 列:操作:值 → {item}")
        col, op, value = (part.strip() for part in parts)
        if col not in allow:
            raise ValueError(f"不支持的筛选列: {col}")
        expr, allowed_ops = allow[col]
        if op not in allowed_ops:
            raise ValueError(f"列 {col} 不支持操作: {op}")
        if value == "":
            continue
        if op == "contains":
            where.append(f"{expr} ILIKE %s")
            params.append(f"%{value}%")
        elif op == "eq":
            where.append(f"{expr} = %s")
            params.append(value)
        elif op == "ne":
            where.append(f"{expr} <> %s")
            params.append(value)
        elif op in ("gt", "gte", "lt", "lte"):
            symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
            where.append(f"{expr} {symbol} %s")
            params.append(value)
        elif op == "in":
            values = [v.strip() for v in value.split(",") if v.strip()]
            if values:
                placeholders = ", ".join(["%s"] * len(values))
                where.append(f"{expr} IN ({placeholders})")
                params.extend(values)
    return where, params


def parse_ids(ids: str, cap: int = 50000) -> list[int]:
    """解析逗号分隔的整数 ID 列表（多选行导出）。"""
    values: list[int] = []
    for token in (ids or "").split(","):
        token = token.strip()
        if not token:
            continue
        try:
            values.append(int(token))
        except ValueError:
            raise ValueError(f"无效的 ID: {token}") from None
    if len(values) > cap:
        raise ValueError(f"单次最多导出 {cap} 行")
    return values


def parse_composite_ids(ids: str, parts: int = 4, cap: int = 50000) -> list[tuple[int, ...]]:
    """解析冒号分隔的复合主键（如库存余额 product_id:location_id:condition_id:uom_id）。"""
    result: list[tuple[int, ...]] = []
    for token in (ids or "").split(","):
        token = token.strip()
        if not token:
            continue
        segments = token.split(":")
        if len(segments) != parts:
            raise ValueError(f"无效的复合 ID: {token}")
        try:
            result.append(tuple(int(s) for s in segments))
        except ValueError:
            raise ValueError(f"无效的复合 ID: {token}") from None
    if len(result) > cap:
        raise ValueError(f"单次最多导出 {cap} 行")
    return result
