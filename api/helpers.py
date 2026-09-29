"""Shared request/dictionary helpers, split out of main.py so the documents
router can reuse them without a circular import (main <-> documents)."""

from __future__ import annotations

import ipaddress
import unicodedata
import uuid
from typing import Any

from fastapi import HTTPException, Request

from .db import fetch_one


def _normalize_query(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value or "").split())


def _normalize_identifier(value: str) -> str:
    """Normalize identifiers for matching while retaining value_raw verbatim."""
    return _normalize_query(value).casefold()


def _request_meta(request: Request) -> dict[str, str | None]:
    raw_ip = request.client.host if request.client else None
    try:
        ip_address = str(ipaddress.ip_address(raw_ip)) if raw_ip else None
    except ValueError:
        ip_address = None
    return {
        "request_id": request.headers.get("X-Request-ID", str(uuid.uuid4())),
        "ip_address": ip_address,
        "user_agent": request.headers.get("User-Agent"),
    }


def _status_id(conn: Any, code: str) -> int:
    row = fetch_one(conn, "SELECT status_id FROM record_status WHERE code=%s", (code,))
    if not row:
        raise HTTPException(status_code=500, detail=f"缺少状态字典: {code}")
    return int(row["status_id"])


def _movement_id(conn: Any, code: str) -> int:
    row = fetch_one(conn, "SELECT movement_type_id FROM movement_type WHERE code=%s", (code,))
    if not row:
        raise HTTPException(status_code=500, detail=f"缺少流水类型: {code}")
    return int(row["movement_type_id"])


def lock_products(conn: Any, product_ids: Any) -> list[dict[str, Any]]:
    """按 product_id 升序对 product 行加 FOR UPDATE 锁并返回行数据。

    同一货品的并发过账/清点/调整都先走这里串行化，防止「读账面数→写调整」
    之间的丢失更新；升序加锁避免交叉死锁。
    """
    ids = sorted({int(p) for p in product_ids if p is not None})
    if not ids:
        return []
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM product WHERE product_id = ANY(%s) ORDER BY product_id FOR UPDATE", (ids,))
        columns = [d.name for d in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]


def _condition_id(conn: Any, value: int | None) -> int:
    if value:
        return value
    row = fetch_one(conn, "SELECT condition_id FROM inventory_condition WHERE code='new'")
    return int(row["condition_id"])


def _line_uom_id(conn: Any, line: Any) -> int:
    """Resolve a requested unit without converting its quantity."""
    if not fetch_one(conn, "SELECT product_id FROM product WHERE product_id=%s", (line.product_id,)):
        raise HTTPException(status_code=404, detail="货品不存在")
    if line.uom_id:
        row = fetch_one(conn, "SELECT uom_id FROM uom WHERE uom_id=%s AND is_active", (line.uom_id,))
        if row:
            return int(row["uom_id"])
        raise HTTPException(status_code=422, detail="单位不存在或已停用")
    if line.uom_code:
        aliases = {"个": "EA", "件": "EA", "台": "EA", "盒": "BOX", "箱": "BOX", "套": "SET", "米": "M"}
        code = aliases.get(line.uom_code.strip(), line.uom_code.strip().upper())
        row = fetch_one(conn, "SELECT uom_id FROM uom WHERE code=%s AND is_active", (code,))
        if row:
            return int(row["uom_id"])
        raise HTTPException(status_code=422, detail="单位不存在或已停用")
    row = fetch_one(conn, "SELECT COALESCE(default_uom_id,(SELECT uom_id FROM uom WHERE code='UNKNOWN')) AS uom_id FROM product WHERE product_id=%s", (line.product_id,))
    if not row:
        raise HTTPException(status_code=404, detail="货品不存在")
    return int(row["uom_id"])
