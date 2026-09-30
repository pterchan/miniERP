"""只读报表与审计的分页、筛选和导出；共享查询确保合计与导出口径一致。"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import HTTPException

from .db import connection, fetch_all, fetch_one
from .export import MAX_EXPORT_ROWS, export_response
from .list_params import clamp_page, clamp_page_size, like_escape, parse_composite_ids, parse_filters, parse_ids, parse_sort


def read_list(sql: str, params: list[Any], *, fields: dict[str, tuple[str, ...]],
              search_fields: tuple[str, ...], default_sort: str, key_fields: tuple[str, ...],
              columns: list, filename: str, summary: dict[str, str] | None = None,
              numeric_fields: tuple[str, ...] = (), date_fields: tuple[str, ...] = (),
              q: str = "", f: list[str] | None = None, sort: str = "", order: str = "asc",
              page: int = 1, page_size: int = 30, paginated: bool = False,
              fmt: str = "", ids: str = "", legacy_limit: int | None = None) -> Any:
    """SQL、字段及汇总表达式只能由调用方的常量提供；所有用户值均使用绑定参数。"""
    f = f or []
    allow = {name: (f"r.{name}", ops) for name, ops in fields.items()}
    try:
        clauses, filter_params = parse_filters(f, allow)
        for raw in f:
            name, op, value = (part.strip() for part in raw.split(":", 2))
            values = value.split(",") if op == "in" else [value]
            if name in numeric_fields:
                if any(not Decimal(v.strip()).is_finite() for v in values):
                    raise ValueError("数字筛选必须为有限数值")
                if name.endswith("_id") and any(not -(2 ** 63) <= int(v.strip()) < 2 ** 63 for v in values):
                    raise ValueError("编号超出允许范围")
            if name in date_fields:
                for value in values:
                    datetime.fromisoformat(value.strip()) if "T" in value or " " in value else date.fromisoformat(value.strip())
    except (ValueError, InvalidOperation):
        raise HTTPException(status_code=422, detail="筛选字段、操作符或值不正确") from None
    params = list(params) + filter_params
    if q.strip() and search_fields:
        clauses.append("(" + " OR ".join(f"r.{name} ILIKE %s ESCAPE '\\'" for name in search_fields) + ")")
        params.extend(["%" + like_escape(q.strip()) + "%"] * len(search_fields))
    if ids:
        try:
            if len(key_fields) == 1:
                selected = parse_ids(ids)
                clauses.append(f"r.{key_fields[0]} = ANY(%s)")
                params.append(selected)
            else:
                selected = parse_composite_ids(ids, parts=len(key_fields))
                clauses.append("(" + " OR ".join("(" + " AND ".join(f"r.{key}=%s" for key in key_fields) + ")" for _ in selected) + ")" if selected else "FALSE")
                params.extend(value for key in selected for value in key)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
    where = " AND ".join(clauses) or "TRUE"
    base = f"FROM ({sql}) r WHERE {where}"
    ordering = parse_sort(sort, order, {key: f"r.{key}" for key in fields}, default_sort)
    ordering += ", " + ", ".join(f"r.{key} ASC" for key in key_fields)
    page, page_size = clamp_page(page), clamp_page_size(page_size)
    with connection() as conn:
        if fmt:
            if fmt not in ("csv", "xlsx"):
                raise HTTPException(status_code=422, detail="fmt 仅支持 csv 或 xlsx")
            rows = fetch_all(conn, f"SELECT r.* {base} ORDER BY {ordering} LIMIT %s", tuple(params + [MAX_EXPORT_ROWS + 1]))
            return export_response(rows, columns, filename, fmt)
        if not paginated:
            limit_sql = " LIMIT %s" if legacy_limit else ""
            return fetch_all(conn, f"SELECT r.* {base} ORDER BY {ordering}{limit_sql}", tuple(params + ([legacy_limit] if legacy_limit else [])))
        totals = [f"{expression} AS {name}" for name, expression in (summary or {}).items()]
        aggregate = "count(*) AS total" + (", " + ", ".join(totals) if totals else "")
        counts = fetch_one(conn, f"SELECT {aggregate} {base}", tuple(params))
        rows = fetch_all(conn, f"SELECT r.* {base} ORDER BY {ordering} LIMIT %s OFFSET %s", tuple(params + [page_size, (page - 1) * page_size]))
    return {"items": rows, "total": int(counts["total"]), "page": page, "page_size": page_size,
            "summary": {name: counts[name] for name in (summary or {})}}
