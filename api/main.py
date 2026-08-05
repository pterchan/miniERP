from __future__ import annotations

import os
import uuid
import unicodedata
from decimal import Decimal
from typing import Any, Callable

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware

from . import documents, images, master, reports
from .db import audit, connection, ensure_bootstrap_users, fetch_all, fetch_one
from .export import export_response, export_rows_by_ids
from .list_params import clamp_page, clamp_page_size, parse_composite_ids, parse_filters, parse_ids, parse_sort
from .helpers import _condition_id, _line_uom_id, _movement_id, _request_meta, _status_id
from .ocr_client import OCRProxyError, forward_ocr
from .permissions import CSRF_COOKIE, SESSION_COOKIE, _csrf, require_roles, require_user
from .schemas import (
    ChangePasswordIn,
    ConflictCreateProductIn,
    ConflictEditProductIn,
    ConflictLinkIn,
    ConflictResolveIn,
    InventoryAdjustIn,
    LocationIn,
    LocationUpdateIn,
    LoginIn,
    OCRExtractIn,
    ProductCreateIn,
    ProductIn,
    ProductUpdateIn,
    RejectIn,
    StockRequestIn,
    StockRequestPatch,
    UomIn,
    UserCreateIn,
    UserUpdateIn,
)
from .security import hash_password, random_token, token_hash, utc_after, verify_password


app = FastAPI(title="miniERP", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[x for x in os.environ.get("ERP_CORS_ORIGINS", "http://localhost:5173").split(",") if x],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "X-CSRF-Token"],
)

app.include_router(documents.router)
app.include_router(documents.attachments_router)
app.include_router(images.router)
app.include_router(master.router)
app.include_router(reports.router)


@app.on_event("startup")
def startup() -> None:
    # Compose starts the API after postgres health is ready. The try keeps the
    # API usable for migrations run after container startup.
    try:
        ensure_bootstrap_users()
    except Exception:
        if os.environ.get("ERP_BOOTSTRAP_STRICT", "0") == "1":
            raise
    # Ensure the MinIO bucket exists; a missing/unreachable MinIO must never
    # block the API from starting (image upload will simply fail per-request).
    try:
        from .storage import ensure_bucket
        ensure_bucket()
    except Exception:
        pass


def _normalize_query(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value or "").split())


def _normalize_identifier(value: str) -> str:
    """Normalize identifiers for matching while retaining value_raw verbatim."""
    return _normalize_query(value).casefold()


def _valid_location_type(value: str | None) -> bool:
    return value in {"warehouse", "hospital", "department", "customer", "external", "transit", "other"}


def _primary_identifier(conn: Any, product_id: int) -> dict[str, Any] | None:
    return fetch_one(
        conn,
        """SELECT product_identifier_id,identifier_type,namespace,value_raw,value_normalized,is_primary,
                  is_verified,is_exclusive,notes
             FROM product_identifier
            WHERE product_id=%s AND is_primary
            ORDER BY is_primary DESC, product_identifier_id
            LIMIT 1""",
        (product_id,),
    )


def _set_primary_identifier(conn: Any, product_id: int, identifier: str | None, user: dict[str, Any], meta: dict[str, Any]) -> list[dict[str, Any]]:
    """Set a human-entered primary identifier and return non-fatal conflicts."""
    if identifier is None:
        with conn.cursor() as cur:
            existing = fetch_all(conn, "SELECT * FROM product_identifier WHERE product_id=%s AND is_primary FOR UPDATE", (product_id,))
            for row in existing:
                audit(conn, user, "EDIT", "product_identifier", target_id=row["product_identifier_id"], before=row, after={"is_primary": False}, field_diff={"is_primary": [True, False]}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
            cur.execute("UPDATE product_identifier SET is_primary=FALSE WHERE product_id=%s", (product_id,))
        return []
    raw = identifier.strip()
    if not raw:
        with conn.cursor() as cur:
            existing = fetch_all(conn, "SELECT * FROM product_identifier WHERE product_id=%s AND is_primary FOR UPDATE", (product_id,))
            if existing:
                audit(conn, user, "EDIT", "product_identifier", target_id=existing[0]["product_identifier_id"], before=existing[0], after={"is_primary": False}, field_diff={"is_primary": [True, False]}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
                cur.execute("UPDATE product_identifier SET is_primary=FALSE WHERE product_identifier_id=%s", (existing[0]["product_identifier_id"],))
        return []
    normalized = _normalize_identifier(raw)
    conflicts = fetch_all(
        conn,
        """SELECT pi.product_id,p.display_name,pi.value_raw,pi.namespace,pi.identifier_type
             FROM product_identifier pi JOIN product p ON p.product_id=pi.product_id
            WHERE pi.value_normalized=%s AND pi.product_id<>%s
            ORDER BY pi.product_id""",
        (normalized, product_id),
    )
    existing = fetch_one(conn, "SELECT * FROM product_identifier WHERE product_id=%s AND value_normalized=%s FOR UPDATE", (product_id, normalized))
    current_primary = fetch_all(conn, "SELECT * FROM product_identifier WHERE product_id=%s AND is_primary FOR UPDATE", (product_id,))
    for row in current_primary:
        if not existing or row["product_identifier_id"] != existing["product_identifier_id"]:
            audit(conn, user, "EDIT", "product_identifier", target_id=row["product_identifier_id"], before=row, after={"is_primary": False}, field_diff={"is_primary": [True, False]}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
    if existing:
        after = {"is_primary": True}
        audit(conn, user, "EDIT", "product_identifier", target_id=existing["product_identifier_id"], before=existing, after=after, field_diff={"is_primary": [existing["is_primary"], True]}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE product_identifier SET is_primary=FALSE WHERE product_id=%s", (product_id,))
            cur.execute("UPDATE product_identifier SET is_primary=TRUE WHERE product_identifier_id=%s", (existing["product_identifier_id"],))
    else:
        after = {"product_id": product_id, "identifier_type": "source_number", "namespace": "erp.manual", "value_raw": raw, "value_normalized": normalized, "is_primary": True}
        audit(conn, user, "CREATE", "product_identifier", after=after, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE product_identifier SET is_primary=FALSE WHERE product_id=%s", (product_id,))
            cur.execute("""INSERT INTO product_identifier(product_id,identifier_type,namespace,value_raw,value_normalized,is_primary,is_verified,is_exclusive)
                         VALUES (%s,'source_number','erp.manual',%s,%s,TRUE,FALSE,FALSE)""", (product_id, raw, normalized))
    return conflicts



def _main_location_id(conn: Any) -> int | None:
    row = fetch_one(conn, "SELECT location_id FROM location WHERE code='MAIN' AND is_active")
    return int(row["location_id"]) if row else None


@app.get("/healthz")
def healthz() -> dict[str, str]:
    with connection() as conn:
        fetch_one(conn, "SELECT 1 AS ok")
    return {"status": "ok"}


@app.post("/api/ocr/extract")
def ocr_extract(payload: OCRExtractIn, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request)
    request_id = _request_meta(request)["request_id"] or str(uuid.uuid4())
    try:
        return forward_ocr(payload.model_dump(), request_id)
    except OCRProxyError as exc:
        headers = {"Retry-After": exc.retry_after} if exc.retry_after else None
        raise HTTPException(status_code=exc.status_code, detail=exc.detail, headers=headers) from exc


@app.post("/api/auth/login")
def login(payload: LoginIn, response: Response, request: Request) -> dict[str, Any]:
    with connection() as conn:
        user_row = fetch_one(conn, "SELECT * FROM app_user WHERE username=%s AND is_active", (payload.username.strip(),))
        if not user_row or not verify_password(payload.password, user_row["password_hash"]):
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        session_token = random_token()
        csrf_token = random_token()
        meta = _request_meta(request)
        audit(conn, {"user_id": user_row["user_id"], "role": user_row["role"]}, "LOGIN", "app_session", request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("INSERT INTO app_session(user_id,token_hash,csrf_token_hash,expires_at) VALUES (%s,%s,%s,%s)", (user_row["user_id"], token_hash(session_token), token_hash(csrf_token), utc_after()))
    secure = os.environ.get("ERP_SECURE_COOKIES", "0") == "1"
    response.set_cookie(SESSION_COOKIE, session_token, httponly=True, secure=secure, samesite="lax", max_age=12 * 3600)
    response.set_cookie(CSRF_COOKIE, csrf_token, httponly=False, secure=secure, samesite="lax", max_age=12 * 3600)
    return {"user_id": user_row["user_id"], "username": user_row["username"], "display_name": user_row["display_name"], "role": user_row["role"]}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, user: dict[str, Any] = Depends(require_user)) -> dict[str, str]:
    _csrf(request)
    raw = request.cookies.get(SESSION_COOKIE)
    with connection() as conn:
        meta = _request_meta(request)
        audit(conn, user, "LOGOUT", "app_session", request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE app_session SET revoked_at=now() WHERE token_hash=%s", (token_hash(raw),))
    response.delete_cookie(SESSION_COOKIE)
    response.delete_cookie(CSRF_COOKIE)
    return {"status": "ok"}


@app.get("/api/auth/me")
def me(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return user


@app.post("/api/auth/change-password")
def change_password(payload: ChangePasswordIn, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, str]:
    _csrf(request)
    meta = _request_meta(request)
    with connection() as conn:
        row = fetch_one(conn, "SELECT password_hash FROM app_user WHERE user_id=%s FOR UPDATE", (user["user_id"],))
        if not row or not verify_password(payload.current_password, row["password_hash"]):
            raise HTTPException(status_code=403, detail="当前密码不正确")
        audit(conn, user, "CHANGE_PASSWORD", "app_user", target_id=user["user_id"],
              before={"user_id": user["user_id"]}, after={"user_id": user["user_id"]},
              request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE app_user SET password_hash=%s,updated_at=now() WHERE user_id=%s", (hash_password(payload.new_password), user["user_id"]))
    return {"status": "ok"}


_PRODUCT_SORT = {
    "display_name": "p.display_name",
    "product_id": "p.product_id",
    "manufacturer": "coalesce(p.manufacturer, '')",
    "specification": "coalesce(p.specification, '')",
    "created_at": "p.created_at",
    "updated_at": "p.updated_at",
}

_PRODUCT_FILTERS = {
    "display_name": ("p.display_name", ("contains", "eq")),
    "manufacturer": ("coalesce(p.manufacturer, '')", ("contains", "eq")),
    "specification": ("coalesce(p.specification, '')", ("contains", "eq")),
    "category_id": ("p.category_id", ("eq", "in")),
    "status_id": ("p.status_id", ("eq", "in")),
}

_PRODUCT_COLUMNS = [
    ("货品ID", lambda r: r["product_id"]),
    ("业务编号", lambda r: r["identifier"] or ""),
    ("货品名称", lambda r: r["display_name"]),
    ("厂家", lambda r: r["manufacturer"] or ""),
    ("规格型号", lambda r: r["specification"] or ""),
    ("默认单位", lambda r: r["uom_code"] or ""),
    ("更新时间", lambda r: r["updated_at"]),
]


def _product_where(q: str, filters: list[str]) -> tuple[str, list]:
    """货品列表/导出的共享 WHERE 构造器。q 走名称/编号/别名 EXISTS 子查询避免行膨胀。"""
    clauses: list[str] = []
    params: list = []
    if q.strip():
        needle = "%" + q.strip() + "%"
        clauses.append(
            "(p.display_name ILIKE %s OR coalesce(p.manufacturer,'') ILIKE %s OR coalesce(p.specification,'') ILIKE %s"
            " OR EXISTS (SELECT 1 FROM product_identifier pi WHERE pi.product_id=p.product_id AND pi.value_raw ILIKE %s)"
            " OR EXISTS (SELECT 1 FROM product_name_alias pa WHERE pa.product_id=p.product_id AND pa.alias_raw ILIKE %s))"
        )
        params.extend([needle] * 5)
    filter_parts, filter_params = parse_filters(filters, _PRODUCT_FILTERS)
    clauses.extend(filter_parts)
    params.extend(filter_params)
    return " AND ".join(clauses), params


def _products_query(where: str, order_by: str) -> str:
    return f"""SELECT p.product_id, p.display_name, p.manufacturer, p.specification, p.status_id, p.category_id,
                      p.created_at, p.updated_at,
                      u.uom_id, u.code AS uom_code, p.source_uom_raw,
                      ident.value_raw AS identifier, ident.value_normalized AS identifier_normalized
                 FROM product p
                 LEFT JOIN uom u ON u.uom_id = p.default_uom_id
                 LEFT JOIN LATERAL (SELECT value_raw, value_normalized FROM product_identifier p0
                                     WHERE p0.product_id = p.product_id AND p0.is_primary
                                     ORDER BY p0.product_identifier_id LIMIT 1) ident ON TRUE
                WHERE {where} ORDER BY {order_by}"""


@app.get("/api/products")
def products(q: str = "", page: int = 1, page_size: int = 30, sort: str = "", order: str = "asc",
             f: list[str] = Query(default=[]), user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    page = clamp_page(page)
    page_size = clamp_page_size(page_size, cap=500)
    q = _normalize_query(q)
    where, params = _product_where(q, f)
    order_by = parse_sort(sort, order, _PRODUCT_SORT, "display_name")
    where = where or "TRUE"
    with connection() as conn:
        rows = fetch_all(conn, _products_query(where, order_by) + " LIMIT %s OFFSET %s", tuple(params + [page_size, (page - 1) * page_size]))
        total = fetch_one(conn, f"SELECT count(*) AS n FROM product p WHERE {where}", tuple(params))
    return {"items": rows, "page": page, "page_size": page_size, "total": int(total["n"])}


@app.get("/api/products/export")
def products_export(q: str = "", sort: str = "", order: str = "asc", f: list[str] = Query(default=[]),
                    ids: str = "", fmt: str = "xlsx", user: dict[str, Any] = Depends(require_user)) -> Response:
    q = _normalize_query(q)
    where, params = _product_where(q, f)
    if ids:
        try:
            id_list = parse_ids(ids)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        id_params = ", ".join(["%s"] * len(id_list))
        where = (where + f" AND p.product_id IN ({id_params})") if where else f"p.product_id IN ({id_params})"
        params.extend(id_list)
    order_by = parse_sort(sort, order, _PRODUCT_SORT, "display_name")
    where = where or "TRUE"
    with connection() as conn:
        rows = fetch_all(conn, _products_query(where, order_by), tuple(params))
    return export_response(rows, _PRODUCT_COLUMNS, "货品", fmt)


@app.get("/api/products/{product_id}")
def product_detail(product_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, """SELECT p.*,u.code AS uom_code,u.display_name AS uom_display_name
                                  FROM product p LEFT JOIN uom u ON u.uom_id=p.default_uom_id
                                 WHERE p.product_id=%s""", (product_id,))
        if not row:
            raise HTTPException(status_code=404, detail="货品不存在")
        row["primary_identifier"] = _primary_identifier(conn, product_id)
        row["identifiers"] = fetch_all(conn, """SELECT product_identifier_id,identifier_type,namespace,value_raw,value_normalized,
                                                       is_primary,is_verified,is_exclusive,notes
                                                  FROM product_identifier WHERE product_id=%s
                                                 ORDER BY is_primary DESC,product_identifier_id""", (product_id,))
        primary = row["primary_identifier"]
        row["identifier_conflicts"] = fetch_all(conn, """SELECT pi.product_id,p.display_name,pi.value_raw,pi.namespace,pi.identifier_type
                                                           FROM product_identifier pi JOIN product p ON p.product_id=pi.product_id
                                                          WHERE pi.value_normalized=%s AND pi.product_id<>%s""", (primary["value_normalized"], product_id)) if primary else []
        row["aliases"] = fetch_all(conn, "SELECT product_name_alias_id,alias_raw,alias_normalized,is_verified,is_exclusive,notes FROM product_name_alias WHERE product_id=%s ORDER BY product_name_alias_id", (product_id,))
        row["price_tiers"] = fetch_all(conn, "SELECT price_tier_id,tier_name,min_quantity,price FROM product_price_tier WHERE product_id=%s ORDER BY min_quantity", (product_id,))
        if user["role"] in ("SALES", "COLLEAGUE"):
            row["purchase_cost_price"] = None
        return row


@app.post("/api/products")
def create_product(payload: ProductCreateIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    meta = _request_meta(request)
    with connection() as conn:
        if payload.default_uom_id is not None and not fetch_one(conn, "SELECT uom_id FROM uom WHERE uom_id=%s AND is_active", (payload.default_uom_id,)):
            raise HTTPException(status_code=422, detail="默认单位不存在或已停用")
        uom_id = payload.default_uom_id or int(fetch_one(conn, "SELECT uom_id FROM uom WHERE code='EA'")["uom_id"])
        after = {**payload.model_dump(), "default_uom_id": uom_id}
        audit(conn, user, "CREATE", "product", after=after, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO product(display_name,manufacturer,specification,default_uom_id,source_uom_raw,category_id,purchase_cost_price,sales_price)
                         VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING product_id""", (payload.display_name.strip(), payload.manufacturer, payload.specification, uom_id, payload.source_uom_raw, payload.category_id, payload.purchase_cost_price or 0, payload.sales_price or 0))
            product_id = cur.fetchone()[0]
        _set_primary_identifier(conn, product_id, payload.primary_identifier, user, meta)
    return product_detail(product_id, user)


@app.put("/api/products/{product_id}")
def update_product(product_id: int, payload: ProductUpdateIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM product WHERE product_id=%s FOR UPDATE", (product_id,))
        if not before:
            raise HTTPException(status_code=404, detail="货品不存在")
        values = payload.model_dump(exclude_unset=True)
        uom_id = values.get("default_uom_id", before.get("default_uom_id"))
        if uom_id is not None and not fetch_one(conn, "SELECT uom_id FROM uom WHERE uom_id=%s AND is_active", (uom_id,)):
            raise HTTPException(status_code=422, detail="默认单位不存在或已停用")
        after = {**before, **values, "default_uom_id": uom_id}
        audit(conn, user, "EDIT", "product", target_id=product_id, before=before, after=after, field_diff={k: [before.get(k), v] for k, v in after.items() if before.get(k) != v}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""UPDATE product SET display_name=%s,manufacturer=%s,specification=%s,default_uom_id=%s,source_uom_raw=%s,
                                 category_id=%s,purchase_cost_price=%s,sales_price=%s,updated_at=now()
                         WHERE product_id=%s""", (after.get("display_name", before["display_name"]).strip(), after.get("manufacturer"), after.get("specification"), uom_id, after.get("source_uom_raw"), after.get("category_id"), after.get("purchase_cost_price", 0), after.get("sales_price", 0), product_id))
        conflicts = _set_primary_identifier(conn, product_id, values["primary_identifier"] if values["primary_identifier"] is not None else "", user, meta) if "primary_identifier" in values else []
    result = product_detail(product_id, user)
    result["identifier_conflicts"] = conflicts
    return result


_INVENTORY_EXPORT_QUERY = """SELECT b.product_id, b.product_name, b.location_id, b.location_name,
                                    b.condition_id, b.condition_code, b.uom_id, b.uom_code, b.on_hand_quantity,
                                    p.manufacturer, p.specification,
                                    ident.value_raw AS identifier
                               FROM v_inventory_balance b
                               JOIN product p ON p.product_id = b.product_id
                               LEFT JOIN LATERAL (SELECT value_raw FROM product_identifier p0
                                                   WHERE p0.product_id = b.product_id AND p0.is_primary
                                                   ORDER BY p0.product_identifier_id LIMIT 1) ident ON TRUE
                              WHERE {where} ORDER BY {order_by}"""

_INVENTORY_SORT = {
    "product_name": "b.product_name",
    "location_name": "b.location_name",
    "condition_code": "b.condition_code",
    "uom_code": "b.uom_code",
    "on_hand_quantity": "b.on_hand_quantity",
    "identifier": "ident.value_raw",
    "manufacturer": "p.manufacturer",
    "specification": "p.specification",
}

_INVENTORY_FILTERS = {
    "identifier": ("coalesce(ident.value_raw, '')", ("contains", "eq")),
    "product_name": ("b.product_name", ("contains", "eq")),
    "manufacturer": ("coalesce(p.manufacturer, '')", ("contains", "eq")),
    "specification": ("coalesce(p.specification, '')", ("contains", "eq")),
    "location_name": ("b.location_name", ("contains", "eq")),
    "condition_code": ("b.condition_code", ("eq",)),
    "uom_code": ("b.uom_code", ("eq",)),
}

_INVENTORY_COLUMNS = [
    ("业务编号", lambda r: r["identifier"] or ""),
    ("货品名称", lambda r: r["product_name"]),
    ("厂家", lambda r: r["manufacturer"] or ""),
    ("规格型号", lambda r: r["specification"] or ""),
    ("库位", lambda r: r["location_name"] or ""),
    ("成色", lambda r: r["condition_code"] or ""),
    ("现库存", lambda r: r["on_hand_quantity"]),
    ("单位", lambda r: r["uom_code"] or ""),
]


@app.get("/api/inventory/balance")
def inventory_balance(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT * FROM v_inventory_balance ORDER BY product_name,location_name")


@app.get("/api/inventory/balance/export")
def inventory_balance_export(q: str = "", sort: str = "", order: str = "asc", f: list[str] = Query(default=[]),
                             ids: str = "", fmt: str = "xlsx", user: dict[str, Any] = Depends(require_user)) -> Response:
    q = _normalize_query(q)
    clauses: list[str] = []
    params: list = []
    if q.strip():
        needle = "%" + q.strip() + "%"
        clauses.append("(b.product_name ILIKE %s OR coalesce(p.manufacturer,'') ILIKE %s OR coalesce(p.specification,'') ILIKE %s"
                       " OR coalesce(ident.value_raw,'') ILIKE %s OR b.location_name ILIKE %s OR b.condition_code ILIKE %s OR b.uom_code ILIKE %s)")
        params.extend([needle] * 7)
    filter_parts, filter_params = parse_filters(f, _INVENTORY_FILTERS)
    clauses.extend(filter_parts)
    params.extend(filter_params)
    if ids:
        try:
            id_list = parse_composite_ids(ids, parts=4)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        sub_clauses = ["(b.product_id=%s AND b.location_id=%s AND b.condition_id=%s AND b.uom_id=%s)"] * len(id_list)
        flat = [x for tup in id_list for x in tup]
        clauses.append(f"({' OR '.join(sub_clauses)})")
        params.extend(flat)
    where = " AND ".join(clauses) if clauses else "TRUE"
    order_by = parse_sort(sort, order, _INVENTORY_SORT, "product_name")
    with connection() as conn:
        rows = fetch_all(conn, _INVENTORY_EXPORT_QUERY.format(where=where, order_by=order_by), tuple(params))
    return export_response(rows, _INVENTORY_COLUMNS, "库存余额", fmt)


@app.get("/api/inventory/balance/{product_id}/{location_id}/{condition_id}/{uom_id}")
def inventory_balance_detail(product_id: int, location_id: int, condition_id: int, uom_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, """SELECT * FROM v_inventory_balance
                                WHERE product_id=%s AND location_id=%s AND condition_id=%s AND uom_id=%s""", (product_id, location_id, condition_id, uom_id))
        if not row:
            raise HTTPException(status_code=404, detail="库存余额不存在")
        row["movements"] = fetch_all(conn, """SELECT im.inventory_movement_id,im.movement_date,im.quantity,im.source_uom_raw,
                                                      mt.code AS movement_type,rs.code AS status_code,
                                                      sl.name AS source_location_name,dl.name AS destination_location_name,
                                                      im.notes,im.posted_at,im.posted_by
                                                 FROM inventory_movement im
                                                 JOIN movement_type mt ON mt.movement_type_id=im.movement_type_id
                                                 JOIN record_status rs ON rs.status_id=im.status_id
                                                 LEFT JOIN location sl ON sl.location_id=im.source_location_id
                                                 LEFT JOIN location dl ON dl.location_id=im.destination_location_id
                                                WHERE im.product_id=%s
                                                  AND (im.source_location_id=%s OR im.destination_location_id=%s)
                                                ORDER BY im.movement_date DESC,im.inventory_movement_id DESC LIMIT 50""", (product_id, location_id, location_id))
        return row


@app.post("/api/inventory/adjust")
def adjust_inventory(payload: InventoryAdjustIn, request: Request, user: dict[str, Any] = Depends(require_roles("WAREHOUSE", "ADMIN"))) -> dict[str, Any]:
    """Override a product's on-hand at one location by posting an ADJUSTMENT.

    A positive delta lands as a destination-side receipt, a negative delta as a
    source-side issue, so the ledger CHECK (quantity > 0) always holds while the
    balance view still nets to the counted value (negatives are allowed).
    """
    _csrf(request)
    meta = _request_meta(request)
    with connection() as conn:
        product = fetch_one(conn, "SELECT * FROM product WHERE product_id=%s FOR UPDATE", (payload.product_id,))
        if not product:
            raise HTTPException(status_code=404, detail="货品不存在")
        if not fetch_one(conn, "SELECT location_id FROM location WHERE location_id=%s AND is_active", (payload.location_id,)):
            raise HTTPException(status_code=422, detail="库位不存在或已停用")
        uom = fetch_one(conn, "SELECT uom_id,code FROM uom WHERE uom_id=%s AND is_active", (payload.uom_id,))
        if not uom:
            raise HTTPException(status_code=422, detail="单位不存在或已停用")
        condition_id = _condition_id(conn, payload.condition_id)
        balance = fetch_one(conn, """SELECT * FROM v_inventory_balance
                                      WHERE product_id=%s AND location_id=%s AND condition_id=%s AND uom_id=%s""",
                            (payload.product_id, payload.location_id, condition_id, payload.uom_id))
        current_qty = Decimal(balance["on_hand_quantity"]) if balance else Decimal(0)
        delta = payload.counted_quantity - current_qty
        movement_posted = False
        if delta != 0:
            movement_posted = True
            quantity = abs(delta)
            destination_location = payload.location_id if delta > 0 else None
            source_location = None if delta > 0 else payload.location_id
            audit(conn, user, "ADJUST", "inventory_movement",
                  after={"product_id": payload.product_id, "location_id": payload.location_id,
                         "uom_id": payload.uom_id, "quantity": str(quantity), "delta": str(delta)},
                  request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
            with conn.cursor() as cur:
                cur.execute("""INSERT INTO inventory_movement(movement_type_id,status_id,movement_date,product_id,quantity,uom_id,condition_id,source_location_id,destination_location_id,source_uom_raw,notes,posted_at,posted_by)
                             VALUES (%s,%s,current_date,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s)""",
                            (_movement_id(conn, "ADJUSTMENT"), _status_id(conn, "posted"), payload.product_id,
                             quantity, payload.uom_id, condition_id, source_location, destination_location,
                             payload.source_uom_raw, payload.notes, user["username"]))
        if payload.change_default_unit and product["default_uom_id"] != payload.uom_id:
            audit(conn, user, "EDIT", "product", target_id=payload.product_id,
                  before={"default_uom_id": product["default_uom_id"]}, after={"default_uom_id": payload.uom_id},
                  field_diff={"default_uom_id": [product["default_uom_id"], payload.uom_id]},
                  request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
            with conn.cursor() as cur:
                cur.execute("UPDATE product SET default_uom_id=%s,updated_at=now() WHERE product_id=%s", (payload.uom_id, payload.product_id))
        after_balance = fetch_one(conn, """SELECT * FROM v_inventory_balance
                                            WHERE product_id=%s AND location_id=%s AND condition_id=%s AND uom_id=%s""",
                                  (payload.product_id, payload.location_id, condition_id, payload.uom_id))
    on_hand = after_balance["on_hand_quantity"] if after_balance else Decimal(0)
    return {
        "product_id": payload.product_id,
        "product_name": product["display_name"],
        "location_id": payload.location_id,
        "location_name": (after_balance or balance or {}).get("location_name") or "—",
        "condition_id": condition_id,
        "condition_code": (after_balance or balance or {}).get("condition_code") or "—",
        "uom_id": payload.uom_id,
        "uom_code": (after_balance or balance or {}).get("uom_code") or uom["code"],
        "on_hand_quantity": on_hand,
        "delta": delta,
        "movement_posted": movement_posted,
    }


@app.get("/api/uoms")
def uoms(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT uom_id,code,display_name,decimal_scale FROM uom WHERE is_active ORDER BY code")


@app.post("/api/uoms")
def create_uom(payload: UomIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    code = payload.code.strip().upper()
    meta = _request_meta(request)
    with connection() as conn:
        if fetch_one(conn, "SELECT uom_id FROM uom WHERE code=%s", (code,)):
            raise HTTPException(status_code=409, detail="单位编码已存在")
        audit(conn, user, "CREATE", "uom",
              after={"code": code, "display_name": payload.display_name.strip(), "decimal_scale": payload.decimal_scale, "is_active": payload.is_active},
              request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO uom(code,display_name,decimal_scale,is_active)
                         VALUES (%s,%s,%s,%s) RETURNING uom_id,code,display_name,decimal_scale,is_active""",
                        (code, payload.display_name.strip(), payload.decimal_scale, payload.is_active))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@app.get("/api/locations")
def locations(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT location_id,code,name,location_type,is_company_inventory,is_active FROM location WHERE is_active ORDER BY name")


_LOCATION_COLUMNS = [
    ("库位ID", lambda r: r["location_id"]),
    ("编码", lambda r: r["code"]),
    ("名称", lambda r: r["name"]),
    ("类型", lambda r: r["location_type"]),
    ("公司库存", lambda r: "是" if r["is_company_inventory"] else "否"),
    ("启用", lambda r: "是" if r["is_active"] else "否"),
]


@app.get("/api/locations/export")
def locations_export(ids: str = "", fmt: str = "xlsx", user: dict[str, Any] = Depends(require_user)) -> Response:
    with connection() as conn:
        return export_rows_by_ids(conn, ids, "location_id",
            "SELECT location_id,code,name,location_type,is_company_inventory,is_active FROM location WHERE is_active AND {where} ORDER BY {order_by}",
            "name", _LOCATION_COLUMNS, "库位", fmt)


@app.get("/api/locations/{location_id}")
def location_detail(location_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, """SELECT l.*,o.name AS organization_name
                                  FROM location l LEFT JOIN organization o ON o.organization_id=l.organization_id
                                 WHERE l.location_id=%s""", (location_id,))
        if not row:
            raise HTTPException(status_code=404, detail="库位不存在")
        row["aliases"] = fetch_all(conn, "SELECT location_alias_id,alias_raw,alias_normalized,is_verified,is_exclusive,notes FROM location_alias WHERE location_id=%s ORDER BY location_alias_id", (location_id,))
        return row


@app.post("/api/locations")
def create_location(payload: LocationIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    if payload.location_type not in {"warehouse", "hospital", "department", "customer", "external", "transit", "other"}:
        raise HTTPException(status_code=422, detail="库位类型无效")
    with connection() as conn:
        if fetch_one(conn, "SELECT location_id FROM location WHERE code=%s", (payload.code.strip(),)):
            raise HTTPException(status_code=409, detail="库位编码已存在")
        org = fetch_one(conn, "SELECT organization_id FROM organization WHERE organization_type='company' AND is_company_entity ORDER BY organization_id LIMIT 1")
        if not org:
            audit(conn, user, "CREATE", "organization", after={"name": "公司", "organization_type": "company"})
            with conn.cursor() as cur:
                cur.execute("INSERT INTO organization(organization_type,name,is_company_entity) VALUES ('company','公司',true) RETURNING organization_id")
                org = {"organization_id": cur.fetchone()[0]}
        audit(conn, user, "CREATE", "location", after=payload.model_dump())
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO location(organization_id,location_type,code,name,is_company_inventory)
                         VALUES (%s,%s,%s,%s,%s) RETURNING location_id,code,name,location_type,is_company_inventory,is_active""", (org["organization_id"], payload.location_type, payload.code.strip(), payload.name.strip(), payload.is_company_inventory))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@app.put("/api/locations/{location_id}")
def update_location(location_id: int, payload: LocationUpdateIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    values = payload.model_dump(exclude_unset=True)
    if "location_type" in values and not _valid_location_type(values["location_type"]):
        raise HTTPException(status_code=422, detail="库位类型无效")
    meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM location WHERE location_id=%s FOR UPDATE", (location_id,))
        if not before:
            raise HTTPException(status_code=404, detail="库位不存在")
        after = {**before, **values}
        audit(conn, user, "EDIT", "location", target_id=location_id, before=before, after=after, field_diff={k: [before.get(k), after.get(k)] for k in values if before.get(k) != after.get(k)}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""UPDATE location SET name=%s,location_type=%s,is_company_inventory=%s,is_active=%s
                              WHERE location_id=%s""", (after["name"].strip(), after["location_type"], after["is_company_inventory"], after["is_active"], location_id))
    return location_detail(location_id, user)


@app.get("/api/admin/users")
def users(user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT user_id,username,display_name,role,is_active,created_at FROM app_user ORDER BY username")


_USER_COLUMNS = [
    ("用户ID", lambda r: r["user_id"]),
    ("用户名", lambda r: r["username"]),
    ("显示名", lambda r: r["display_name"] or ""),
    ("角色", lambda r: r["role"]),
    ("启用", lambda r: "是" if r["is_active"] else "否"),
    ("创建时间", lambda r: r["created_at"]),
]


@app.get("/api/admin/users/export")
def users_export(ids: str = "", fmt: str = "xlsx", user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> Response:
    with connection() as conn:
        return export_rows_by_ids(conn, ids, "user_id",
            "SELECT user_id,username,display_name,role,is_active,created_at FROM app_user WHERE {where} ORDER BY {order_by}",
            "username", _USER_COLUMNS, "用户", fmt)


@app.get("/api/admin/users/{user_id}")
def user_detail(user_id: int, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, "SELECT user_id,username,display_name,role,is_active,created_at,updated_at FROM app_user WHERE user_id=%s", (user_id,))
        if not row:
            raise HTTPException(status_code=404, detail="用户不存在")
        return row


@app.post("/api/admin/users")
def create_user(payload: UserCreateIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    if payload.role not in {"ADMIN", "WAREHOUSE", "SALES", "FINANCE", "COLLEAGUE"}:
        raise HTTPException(status_code=422, detail="角色无效")
    with connection() as conn:
        if fetch_one(conn, "SELECT user_id FROM app_user WHERE username=%s", (payload.username.strip(),)):
            raise HTTPException(status_code=409, detail="用户名已存在")
        audit(conn, user, "CREATE", "app_user", after={"username": payload.username.strip(), "display_name": payload.display_name, "role": payload.role})
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO app_user(username,display_name,role,password_hash)
                         VALUES (%s,%s,%s,%s) RETURNING user_id,username,display_name,role,is_active,created_at""", (payload.username.strip(), payload.display_name.strip(), payload.role, hash_password(payload.password)))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@app.put("/api/admin/users/{user_id}")
def update_user(user_id: int, payload: UserUpdateIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    values = payload.model_dump(exclude_unset=True)
    if "role" in values and values["role"] not in {"ADMIN", "WAREHOUSE", "SALES", "FINANCE", "COLLEAGUE"}:
        raise HTTPException(status_code=422, detail="角色无效")
    meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM app_user WHERE user_id=%s FOR UPDATE", (user_id,))
        if not before:
            raise HTTPException(status_code=404, detail="用户不存在")
        after = {**before, **{k: v for k, v in values.items() if k != "password"}}
        if (after["role"] != "ADMIN" or not after["is_active"]) and before["role"] == "ADMIN" and before["is_active"]:
            remaining = fetch_one(conn, "SELECT count(*) AS n FROM app_user WHERE role='ADMIN' AND is_active AND user_id<>%s", (user_id,))
            if not remaining or int(remaining["n"]) < 1:
                raise HTTPException(status_code=409, detail="不能停用或降级最后一个有效管理员")
        audit(conn, user, "EDIT", "app_user", target_id=user_id, before={k: before.get(k) for k in after if k != "password_hash"}, after=after, field_diff={k: [before.get(k), after.get(k)] for k in values if before.get(k) != after.get(k)}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            if "password" in values:
                cur.execute("""UPDATE app_user SET display_name=%s,role=%s,is_active=%s,password_hash=%s,updated_at=now() WHERE user_id=%s""", (after["display_name"].strip(), after["role"], after["is_active"], hash_password(values["password"]), user_id))
            else:
                cur.execute("""UPDATE app_user SET display_name=%s,role=%s,is_active=%s,updated_at=now() WHERE user_id=%s""", (after["display_name"].strip(), after["role"], after["is_active"], user_id))
    return user_detail(user_id, user)


@app.post("/api/admin/users/{user_id}/password")
def reset_user_password(user_id: int, payload: UserUpdateIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    """Explicit password-reset route; only the password field is honored."""
    if not payload.password:
        raise HTTPException(status_code=422, detail="密码不能为空")
    _csrf(request)
    meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT user_id,username,display_name,role,is_active FROM app_user WHERE user_id=%s FOR UPDATE", (user_id,))
        if not before:
            raise HTTPException(status_code=404, detail="用户不存在")
        audit(conn, user, "RESET_PASSWORD", "app_user", target_id=user_id, before={"user_id": user_id}, after={"user_id": user_id}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE app_user SET password_hash=%s,updated_at=now() WHERE user_id=%s", (hash_password(payload.password), user_id))
    return user_detail(user_id, user)


@app.get("/api/stock-requests")
def stock_requests(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        if user["role"] in {"WAREHOUSE", "ADMIN"}:
            rows = fetch_all(conn, "SELECT sr.*,u.username AS requester_username,u.display_name AS requester_display_name FROM stock_request sr JOIN app_user u ON u.user_id=sr.requester_user_id ORDER BY sr.created_at DESC")
        else:
            rows = fetch_all(conn, "SELECT * FROM stock_request WHERE requester_user_id=%s ORDER BY created_at DESC", (user["user_id"],))
        for row in rows:
            count = fetch_one(conn, "SELECT count(*) AS n FROM stock_request_line WHERE stock_request_id=%s", (row["stock_request_id"],))
            row["line_count"] = int(count["n"])
            row["total_quantity"] = None
        return rows


_STOCK_REQUEST_COLUMNS = [
    ("申请ID", lambda r: r["stock_request_id"]),
    ("单号", lambda r: r["request_no"]),
    ("类型", lambda r: r["request_type"]),
    ("申请人", lambda r: r["requester_display_name"] or r["requester_username"] or ""),
    ("状态", lambda r: r["status"]),
    ("明细数", lambda r: r["line_count"]),
    ("原因", lambda r: r["reason"] or ""),
    ("创建时间", lambda r: r["created_at"]),
]


@app.get("/api/stock-requests/export")
def stock_requests_export(ids: str = "", fmt: str = "xlsx", user: dict[str, Any] = Depends(require_user)) -> Response:
    is_warehouse = user["role"] in {"WAREHOUSE", "ADMIN"}
    clauses: list[str] = []
    params: list = []
    if ids:
        try:
            id_list = parse_ids(ids)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        clauses.append(f"sr.stock_request_id IN ({', '.join(['%s'] * len(id_list))})")
        params.extend(id_list)
    if not is_warehouse:
        clauses.append("sr.requester_user_id=%s")
        params.append(user["user_id"])
    where = " AND ".join(clauses) if clauses else "TRUE"
    with connection() as conn:
        rows = fetch_all(conn, f"""SELECT sr.*,u.username AS requester_username,u.display_name AS requester_display_name
                                     FROM stock_request sr JOIN app_user u ON u.user_id=sr.requester_user_id
                                    WHERE {where} ORDER BY sr.created_at DESC""", tuple(params))
        for row in rows:
            count = fetch_one(conn, "SELECT count(*) AS n FROM stock_request_line WHERE stock_request_id=%s", (row["stock_request_id"],))
            row["line_count"] = int(count["n"])
    return export_response(rows, _STOCK_REQUEST_COLUMNS, "库存申请", fmt)


@app.get("/api/stock-requests/{request_id}")
def stock_request_detail(request_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, "SELECT * FROM stock_request WHERE stock_request_id=%s", (request_id,))
        if not row or (user["role"] not in {"WAREHOUSE", "ADMIN"} and row["requester_user_id"] != user["user_id"]):
            raise HTTPException(status_code=404, detail="申请单不存在")
        row["lines"] = fetch_all(conn, """SELECT l.*,p.display_name AS product_name,p.manufacturer,p.specification,
                                                    u.code AS uom_code,u.display_name AS uom_display_name,
                                                    sl.code AS source_location_code,sl.name AS source_location_name,
                                                    dl.code AS destination_location_code,dl.name AS destination_location_name,
                                                    ic.code AS condition_code
                                               FROM stock_request_line l
                                               JOIN product p ON p.product_id=l.product_id
                                               JOIN uom u ON u.uom_id=l.uom_id
                                               JOIN inventory_condition ic ON ic.condition_id=l.condition_id
                                               LEFT JOIN location sl ON sl.location_id=l.source_location_id
                                               LEFT JOIN location dl ON dl.location_id=l.destination_location_id
                                              WHERE l.stock_request_id=%s ORDER BY l.stock_request_line_id""", (request_id,))
        row["actions"] = fetch_all(conn, """SELECT a.*,u.username AS actor_username,u.display_name AS actor_display_name
                                               FROM stock_request_action a JOIN app_user u ON u.user_id=a.actor_user_id
                                              WHERE a.stock_request_id=%s ORDER BY a.created_at""", (request_id,))
        return row


def _create_request(payload: StockRequestIn, request: Request, user: dict[str, Any]) -> dict[str, Any]:
    allowed = {"RECEIPT", "ISSUE_OTHER", "ISSUE_SALE", "ISSUE_CONSUMPTION", "ISSUE_GIFT", "ISSUE_SCRAP", "TRANSFER", "RETURN"}
    if payload.request_type not in allowed:
        raise HTTPException(status_code=422, detail="不支持的申请类型")
    if payload.source_location_id and payload.destination_location_id and payload.source_location_id == payload.destination_location_id:
        raise HTTPException(status_code=422, detail="来源和目的库位不能相同")
    req_no = "REQ-" + uuid.uuid4().hex[:12].upper()
    meta = _request_meta(request)
    with connection() as conn:
        audit(conn, user, "CREATE", "stock_request", after={"request_no": req_no, "request_type": payload.request_type}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO stock_request(request_no,request_type,requester_user_id,source_location_id,destination_location_id,reason)
                         VALUES (%s,%s,%s,%s,%s,%s) RETURNING stock_request_id""", (req_no, payload.request_type, user["user_id"], payload.source_location_id, payload.destination_location_id, payload.reason))
            request_id = cur.fetchone()[0]
            audit(conn, user, "CREATE", "stock_request_action", after={"stock_request_id": request_id, "action": "CREATE", "to_status": "DRAFT"}, request_id=meta["request_id"])
            cur.execute("INSERT INTO stock_request_action(stock_request_id,actor_user_id,action,to_status,comment) VALUES (%s,%s,'CREATE','DRAFT',%s)", (request_id, user["user_id"], payload.reason))
            for line in payload.lines:
                uom_id = _line_uom_id(conn, line)
                audit(conn, user, "CREATE", "stock_request_line", target_id=None, after={"stock_request_id": request_id, "product_id": line.product_id, "quantity": str(line.quantity)}, request_id=meta["request_id"])
                cur.execute("""INSERT INTO stock_request_line(stock_request_id,product_id,quantity,uom_id,source_uom_raw,condition_id,source_location_id,destination_location_id,notes)
                             VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (request_id, line.product_id, line.quantity, uom_id, line.source_uom_raw, _condition_id(conn, line.condition_id), line.source_location_id or payload.source_location_id, line.destination_location_id or payload.destination_location_id, line.notes))
    return stock_request_detail(request_id, user)


@app.post("/api/stock-requests")
def create_stock_request(payload: StockRequestIn, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request)
    return _create_request(payload, request, user)


@app.put("/api/stock-requests/{request_id}")
def edit_stock_request(request_id: int, payload: StockRequestPatch, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """Edit a request before release; every replacement line is audited."""
    _csrf(request)
    meta = _request_meta(request)
    if payload.source_location_id and payload.destination_location_id and payload.source_location_id == payload.destination_location_id:
        raise HTTPException(status_code=422, detail="来源和目的库位不能相同")
    with connection() as conn:
        row = fetch_one(conn, "SELECT * FROM stock_request WHERE stock_request_id=%s FOR UPDATE", (request_id,))
        if not row or (user["role"] not in {"WAREHOUSE", "ADMIN"} and row["requester_user_id"] != user["user_id"]):
            raise HTTPException(status_code=404, detail="申请单不存在")
        if row["version"] != payload.version:
            raise HTTPException(status_code=409, detail="申请单已被其他人修改，请刷新后重试")
        if row["status"] not in {"DRAFT", "SUBMITTED"} or (user["role"] not in {"WAREHOUSE", "ADMIN"} and row["status"] != "DRAFT"):
            raise HTTPException(status_code=409, detail="当前状态不可编辑")
        values = payload.model_dump(exclude_unset=True)
        before = {"source_location_id": row["source_location_id"], "destination_location_id": row["destination_location_id"], "reason": row["reason"], "version": row["version"]}
        after = {"source_location_id": values.get("source_location_id", row["source_location_id"]), "destination_location_id": values.get("destination_location_id", row["destination_location_id"]), "reason": values.get("reason", row["reason"]), "version": row["version"] + 1}
        audit(conn, user, "EDIT", "stock_request", target_id=request_id, before=before, after=after, field_diff={k: [before[k], after[k]] for k in before if before[k] != after[k]}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE stock_request SET source_location_id=%s,destination_location_id=%s,reason=%s,version=version+1,updated_at=now() WHERE stock_request_id=%s AND version=%s", (after["source_location_id"], after["destination_location_id"], after["reason"], request_id, payload.version))
            if payload.lines is not None:
                old_lines = fetch_all(conn, "SELECT * FROM stock_request_line WHERE stock_request_id=%s", (request_id,))
                for old in old_lines:
                    audit(conn, user, "DELETE", "stock_request_line", target_id=old["stock_request_line_id"], before=old, request_id=meta["request_id"])
                    cur.execute("DELETE FROM stock_request_line WHERE stock_request_line_id=%s", (old["stock_request_line_id"],))
                for line in payload.lines:
                    uom_id = _line_uom_id(conn, line)
                    audit(conn, user, "CREATE", "stock_request_line", after={"stock_request_id": request_id, "product_id": line.product_id, "quantity": str(line.quantity)}, request_id=meta["request_id"])
                    cur.execute("""INSERT INTO stock_request_line(stock_request_id,product_id,quantity,uom_id,source_uom_raw,condition_id,source_location_id,destination_location_id,notes)
                                 VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (request_id, line.product_id, line.quantity, uom_id, line.source_uom_raw, _condition_id(conn, line.condition_id), line.source_location_id or payload.source_location_id, line.destination_location_id or payload.destination_location_id, line.notes))
    return stock_request_detail(request_id, user)


def _validate_submission(conn: Any, row: dict[str, Any]) -> None:
    lines = fetch_all(conn, "SELECT * FROM stock_request_line WHERE stock_request_id=%s", (row["stock_request_id"],))
    if not lines:
        raise HTTPException(status_code=422, detail="申请单至少需要一条有效明细")
    for line in lines:
        if not fetch_one(conn, "SELECT product_id FROM product WHERE product_id=%s", (line["product_id"],)):
            raise HTTPException(status_code=422, detail="申请明细货品不存在")
        source_location = line["source_location_id"] or row["source_location_id"]
        destination_location = line["destination_location_id"] or row["destination_location_id"]
        for location_id in (source_location, destination_location):
            if location_id and not fetch_one(conn, "SELECT location_id FROM location WHERE location_id=%s AND is_active", (location_id,)):
                raise HTTPException(status_code=422, detail="提交前只能使用启用中的库位")
        if source_location and destination_location and source_location == destination_location:
            raise HTTPException(status_code=422, detail="来源和目的库位不能相同")
        if row["request_type"] in {"RECEIPT", "RETURN"} and not (line["destination_location_id"] or row["destination_location_id"]):
            raise HTTPException(status_code=422, detail="入库/退回提交前必须指定目的库位")
        if row["request_type"] in {"ISSUE_OTHER", "ISSUE_SALE", "ISSUE_CONSUMPTION", "ISSUE_GIFT", "ISSUE_SCRAP"} and not (line["source_location_id"] or row["source_location_id"]):
            raise HTTPException(status_code=422, detail="出库提交前必须指定来源库位")
        if row["request_type"] == "TRANSFER" and (not (line["source_location_id"] or row["source_location_id"]) or not (line["destination_location_id"] or row["destination_location_id"])):
            raise HTTPException(status_code=422, detail="调货提交前必须指定来源和目的库位")


def _transition(request_id: int, target: str, request: Request, user: dict[str, Any], comment: str | None = None) -> dict[str, Any]:
    meta = _request_meta(request)
    with connection() as conn:
        row = fetch_one(conn, "SELECT * FROM stock_request WHERE stock_request_id=%s FOR UPDATE", (request_id,))
        if not row or (user["role"] not in {"WAREHOUSE", "ADMIN"} and row["requester_user_id"] != user["user_id"]):
            raise HTTPException(status_code=404, detail="申请单不存在")
        current = row["status"]
        rules = {"SUBMITTED": {"DRAFT"}, "WITHDRAWN": {"SUBMITTED"}, "APPROVED": {"SUBMITTED"}, "REJECTED": {"SUBMITTED"}, "RELEASED": {"APPROVED"}}
        if current not in rules.get(target, set()):
            raise HTTPException(status_code=409, detail=f"不允许从 {current} 转为 {target}")
        if target in {"SUBMITTED", "WITHDRAWN"} and row["requester_user_id"] != user["user_id"]:
            raise HTTPException(status_code=403, detail="仅申请单本人可提交或撤回申请")
        if target in {"APPROVED", "REJECTED", "RELEASED"} and user["role"] not in {"WAREHOUSE", "ADMIN"}:
            raise HTTPException(status_code=403, detail="仅仓管可审批或放行")
        if target == "SUBMITTED":
            _validate_submission(conn, row)
        db_target = "DRAFT" if target == "WITHDRAWN" else target
        audit(conn, user, target, "stock_request", target_id=request_id, before={"status": current}, after={"status": db_target}, field_diff={"status": [current, db_target]}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            if target == "REJECTED":
                cur.execute("UPDATE stock_request SET status=%s,rejection_reason=%s,version=version+1,updated_at=now() WHERE stock_request_id=%s", (target, comment, request_id))
            elif target == "SUBMITTED":
                cur.execute("UPDATE stock_request SET status=%s,submitted_at=now(),version=version+1,updated_at=now() WHERE stock_request_id=%s", (target, request_id))
            elif target == "APPROVED":
                cur.execute("UPDATE stock_request SET status=%s,approved_at=now(),version=version+1,updated_at=now() WHERE stock_request_id=%s", (target, request_id))
            elif target == "RELEASED":
                cur.execute("UPDATE stock_request SET status=%s,released_at=now(),version=version+1,updated_at=now() WHERE stock_request_id=%s", (target, request_id))
            elif target == "WITHDRAWN":
                cur.execute("UPDATE stock_request SET status='DRAFT',submitted_at=NULL,version=version+1,updated_at=now() WHERE stock_request_id=%s", (request_id,))
            else:
                cur.execute("UPDATE stock_request SET status=%s,version=version+1,updated_at=now() WHERE stock_request_id=%s", (db_target, request_id))
            action_name = {"SUBMITTED": "SUBMIT", "WITHDRAWN": "WITHDRAW", "APPROVED": "APPROVE", "REJECTED": "REJECT", "RELEASED": "RELEASE"}[target]
            audit(conn, user, action_name, "stock_request_action", after={"stock_request_id": request_id, "action": action_name, "from_status": current, "to_status": target}, request_id=meta["request_id"])
            cur.execute("INSERT INTO stock_request_action(stock_request_id,actor_user_id,action,from_status,to_status,comment) VALUES (%s,%s,%s,%s,%s,%s)", (request_id, user["user_id"], action_name, current, db_target, comment))
            if target == "RELEASED":
                lines = fetch_all(conn, "SELECT * FROM stock_request_line WHERE stock_request_id=%s", (request_id,))
                posted = _status_id(conn, "posted")
                main_location = _main_location_id(conn)
                for line in lines:
                    movement_type = row["request_type"]
                    source_location = line["source_location_id"] or row["source_location_id"]
                    destination_location = line["destination_location_id"] or row["destination_location_id"]
                    if movement_type == "RECEIPT":
                        source_location, destination_location = None, destination_location or main_location
                    elif movement_type in {"ISSUE_OTHER", "ISSUE_SALE", "ISSUE_CONSUMPTION", "ISSUE_GIFT", "ISSUE_SCRAP"}:
                        source_location = source_location or main_location
                    elif movement_type == "RETURN":
                        source_location, destination_location = None, destination_location or main_location
                    elif movement_type == "TRANSFER" and (source_location is None or destination_location is None):
                        raise HTTPException(status_code=422, detail="调货放行前必须指定来源和目的库位")
                    if movement_type in {"RECEIPT", "RETURN"} and destination_location is None:
                        raise HTTPException(status_code=422, detail="入库/退回放行前必须存在目的库位")
                    audit(conn, user, "RELEASE", "inventory_movement", after={"stock_request_id": request_id, "product_id": line["product_id"], "quantity": str(line["quantity"])}, request_id=meta["request_id"])
                    cur.execute("""INSERT INTO inventory_movement(movement_type_id,status_id,movement_date,product_id,quantity,uom_id,condition_id,source_location_id,destination_location_id,source_uom_raw,notes,posted_at,posted_by)
                                 VALUES (%s,%s,current_date,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s)""", (_movement_id(conn, row["request_type"]), posted, line["product_id"], line["quantity"], line["uom_id"], line["condition_id"], source_location, destination_location, line["source_uom_raw"], f"OA申请 {row['request_no']}", user["username"]))
    return stock_request_detail(request_id, user)


def _action_endpoint(target: str) -> Callable[..., dict[str, Any]]:
    def endpoint(request_id: int, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
        _csrf(request)
        return _transition(request_id, target, request, user)
    return endpoint


@app.post("/api/stock-requests/{request_id}/submit")
def submit(request_id: int, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request); return _transition(request_id, "SUBMITTED", request, user)


@app.post("/api/stock-requests/{request_id}/withdraw")
def withdraw(request_id: int, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request); return _transition(request_id, "WITHDRAWN", request, user)


@app.post("/api/stock-requests/{request_id}/approve")
def approve(request_id: int, request: Request, user: dict[str, Any] = Depends(require_roles("WAREHOUSE", "ADMIN"))) -> dict[str, Any]:
    _csrf(request); return _transition(request_id, "APPROVED", request, user)


@app.post("/api/stock-requests/{request_id}/reject")
def reject(request_id: int, payload: RejectIn, request: Request, user: dict[str, Any] = Depends(require_roles("WAREHOUSE", "ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    if not payload.reason.strip():
        raise HTTPException(status_code=422, detail="驳回原因不能为空")
    return _transition(request_id, "REJECTED", request, user, payload.reason.strip())


@app.post("/api/stock-requests/{request_id}/release")
def release(request_id: int, request: Request, user: dict[str, Any] = Depends(require_roles("WAREHOUSE", "ADMIN"))) -> dict[str, Any]:
    _csrf(request); return _transition(request_id, "RELEASED", request, user)


def _case_observation(conn: Any, row: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve the product_observation for a case.

    The seeder historically fills only resolution_case.source_record_id, so fall
    back to the first observation keyed by that source row when no direct FK is
    populated.
    """
    if row.get("product_observation_id"):
        return fetch_one(conn, "SELECT * FROM product_observation WHERE product_observation_id=%s", (row["product_observation_id"],))
    if row.get("source_record_id"):
        return fetch_one(conn, "SELECT * FROM product_observation WHERE source_record_id=%s ORDER BY observation_ordinal LIMIT 1", (row["source_record_id"],))
    return None


def _lock_case(conn: Any, case_id: int) -> dict[str, Any]:
    row = fetch_one(conn, """SELECT rc.*,rs.code AS status_code FROM resolution_case rc
                              JOIN record_status rs ON rs.status_id=rc.status_id
                             WHERE rc.resolution_case_id=%s FOR UPDATE""", (case_id,))
    if not row:
        raise HTTPException(status_code=404, detail="冲突不存在")
    if row["status_code"] != "pending_review":
        raise HTTPException(status_code=409, detail="该冲突已处理，只读")
    return row


def _resolve_case(conn: Any, user: dict[str, Any], meta: dict[str, Any], row: dict[str, Any], outcome: str, notes: str) -> None:
    terminal = _status_id(conn, outcome)
    audit(conn, user, "RESOLVE", "resolution_case", target_id=row["resolution_case_id"],
          before={"status": row["status_code"]}, after={"status": outcome, "notes": notes},
          request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
    with conn.cursor() as cur:
        cur.execute("UPDATE resolution_case SET status_id=%s,resolved_at=now(),assigned_to=%s,resolution_notes=%s WHERE resolution_case_id=%s",
                    (terminal, user["username"], notes, row["resolution_case_id"]))
    observation = _case_observation(conn, row)
    if observation:
        with conn.cursor() as cur:
            cur.execute("UPDATE product_observation SET resolution_status_id=%s WHERE product_observation_id=%s",
                        (terminal, observation["product_observation_id"]))


_CONFLICT_QUERY = """SELECT rc.resolution_case_id,rc.case_type,rc.source_record_id,
                            rc.product_observation_id,rc.movement_candidate_id,
                            rc.opened_at,rc.assigned_to,rc.resolution_notes,
                            rs.code AS status_code,
                            COALESCE(po.source_name_raw, NULLIF(sr.display_values->>'品名','')) AS source_name,
                            po.source_identifier_raw AS source_identifier,
                            mc.movement_type_code,mc.quantity_raw,mc.movement_date_raw
                       FROM resolution_case rc
                       JOIN record_status rs ON rs.status_id=rc.status_id
                       LEFT JOIN source_record sr ON sr.source_record_id=rc.source_record_id
                       LEFT JOIN LATERAL (SELECT p.source_name_raw,p.source_identifier_raw
                                            FROM product_observation p
                                           WHERE p.product_observation_id=rc.product_observation_id
                                              OR (rc.product_observation_id IS NULL AND p.source_record_id=rc.source_record_id)
                                           ORDER BY (p.product_observation_id=rc.product_observation_id) DESC,p.observation_ordinal
                                           LIMIT 1) po ON TRUE
                       LEFT JOIN LATERAL (SELECT mt.code AS movement_type_code,m2.quantity_raw,m2.movement_date_raw
                                            FROM movement_candidate m2
                                            LEFT JOIN movement_type mt ON mt.movement_type_id=m2.movement_type_id
                                           WHERE m2.movement_candidate_id=rc.movement_candidate_id
                                              OR (rc.movement_candidate_id IS NULL AND m2.source_record_id=rc.source_record_id)
                                           ORDER BY (m2.movement_candidate_id=rc.movement_candidate_id) DESC,m2.candidate_ordinal
                                           LIMIT 1) mc ON TRUE
                      WHERE {where}
                      ORDER BY rc.opened_at DESC"""

_CONFLICT_COLUMNS = [
    ("冲突ID", lambda r: r["resolution_case_id"]),
    ("类型", lambda r: r["case_type"]),
    ("来源名称", lambda r: r["source_name"] or ""),
    ("来源编号", lambda r: r["source_identifier"] or ""),
    ("状态", lambda r: r["status_code"]),
    ("打开时间", lambda r: r["opened_at"]),
]


@app.get("/api/conflicts")
def conflicts(user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, _CONFLICT_QUERY.format(where="rs.code='pending_review'"))


@app.get("/api/conflicts/export")
def conflicts_export(ids: str = "", fmt: str = "xlsx", user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> Response:
    where = "rs.code='pending_review'"
    params: list = []
    if ids:
        try:
            id_list = parse_ids(ids)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        where += f" AND rc.resolution_case_id IN ({', '.join(['%s'] * len(id_list))})"
        params.extend(id_list)
    with connection() as conn:
        rows = fetch_all(conn, _CONFLICT_QUERY.format(where=where), tuple(params))
    return export_response(rows, _CONFLICT_COLUMNS, "冲突", fmt)


@app.get("/api/conflicts/{case_id}")
def conflict_detail(case_id: int, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, """SELECT rc.*,rs.code AS status_code,rs.display_name AS status_name
                                  FROM resolution_case rc JOIN record_status rs ON rs.status_id=rc.status_id
                                 WHERE rc.resolution_case_id=%s""", (case_id,))
        if not row:
            raise HTTPException(status_code=404, detail="冲突不存在")
        row["source_record"] = fetch_one(conn, "SELECT * FROM source_record WHERE source_record_id=%s", (row["source_record_id"],)) if row["source_record_id"] else None
        observation = _case_observation(conn, row)
        row["product_observation"] = observation
        row["product"] = None
        if observation and observation.get("resolved_product_id"):
            row["product"] = fetch_one(conn, """SELECT p.product_id,p.display_name,p.manufacturer,p.specification,p.default_uom_id,
                                                       u.code AS uom_code,u.display_name AS uom_display_name,
                                                       (SELECT pi.value_raw FROM product_identifier pi
                                                         WHERE pi.product_id=p.product_id AND pi.is_primary
                                                         ORDER BY pi.product_identifier_id LIMIT 1) AS primary_identifier_value
                                                  FROM product p LEFT JOIN uom u ON u.uom_id=p.default_uom_id
                                                 WHERE p.product_id=%s""", (observation["resolved_product_id"],))
        row["movement_candidate"] = None
        if row["movement_candidate_id"]:
            row["movement_candidate"] = fetch_one(conn, """SELECT m.*,mt.code AS movement_type_code
                                                             FROM movement_candidate m
                                                             LEFT JOIN movement_type mt ON mt.movement_type_id=m.movement_type_id
                                                            WHERE m.movement_candidate_id=%s""", (row["movement_candidate_id"],))
        elif row["source_record_id"]:
            row["movement_candidate"] = fetch_one(conn, """SELECT m.*,mt.code AS movement_type_code
                                                             FROM movement_candidate m
                                                             LEFT JOIN movement_type mt ON mt.movement_type_id=m.movement_type_id
                                                            WHERE m.source_record_id=%s ORDER BY m.candidate_ordinal LIMIT 1""", (row["source_record_id"],))
        return row


@app.post("/api/conflicts/{case_id}/link-product")
def link_conflict_product(case_id: int, payload: ConflictLinkIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    if not payload.resolution_notes.strip():
        raise HTTPException(status_code=422, detail="处理备注不能为空")
    meta = _request_meta(request)
    with connection() as conn:
        row = _lock_case(conn, case_id)
        if not fetch_one(conn, "SELECT product_id FROM product WHERE product_id=%s", (payload.product_id,)):
            raise HTTPException(status_code=404, detail="货品不存在")
        observation = _case_observation(conn, row)
        conflicts: list[dict[str, Any]] = []
        if observation and observation.get("source_identifier_raw"):
            conflicts = _set_primary_identifier(conn, payload.product_id, observation["source_identifier_raw"], user, meta)
        if observation:
            with conn.cursor() as cur:
                cur.execute("UPDATE product_observation SET resolved_product_id=%s,match_method='manual_link' WHERE product_observation_id=%s",
                            (payload.product_id, observation["product_observation_id"]))
        _resolve_case(conn, user, meta, row, "resolved", payload.resolution_notes.strip())
    result = conflict_detail(case_id, user)
    result["identifier_conflicts"] = conflicts
    return result


@app.post("/api/conflicts/{case_id}/create-product")
def create_conflict_product(case_id: int, payload: ConflictCreateProductIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    if not payload.resolution_notes.strip():
        raise HTTPException(status_code=422, detail="处理备注不能为空")
    meta = _request_meta(request)
    with connection() as conn:
        row = _lock_case(conn, case_id)
        uom_id = payload.default_uom_id
        if uom_id is not None and not fetch_one(conn, "SELECT uom_id FROM uom WHERE uom_id=%s AND is_active", (uom_id,)):
            raise HTTPException(status_code=422, detail="默认单位不存在或已停用")
        if uom_id is None:
            uom_id = int(fetch_one(conn, "SELECT uom_id FROM uom WHERE code='EA'")["uom_id"])
        audit(conn, user, "CREATE", "product",
              after={"display_name": payload.display_name, "default_uom_id": uom_id},
              request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO product(display_name,manufacturer,specification,default_uom_id,source_uom_raw)
                         VALUES (%s,%s,%s,%s,%s) RETURNING product_id""",
                        (payload.display_name.strip(), payload.manufacturer, payload.specification, uom_id, payload.source_uom_raw))
            product_id = cur.fetchone()[0]
        conflicts = _set_primary_identifier(conn, product_id, payload.primary_identifier, user, meta) if payload.primary_identifier else []
        observation = _case_observation(conn, row)
        if observation:
            with conn.cursor() as cur:
                cur.execute("UPDATE product_observation SET resolved_product_id=%s,match_method='manual_create' WHERE product_observation_id=%s",
                            (product_id, observation["product_observation_id"]))
        _resolve_case(conn, user, meta, row, "resolved", payload.resolution_notes.strip())
    result = conflict_detail(case_id, user)
    result["identifier_conflicts"] = conflicts
    return result


@app.post("/api/conflicts/{case_id}/edit-product")
def edit_conflict_product(case_id: int, payload: ConflictEditProductIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    if not payload.resolution_notes.strip():
        raise HTTPException(status_code=422, detail="处理备注不能为空")
    meta = _request_meta(request)
    with connection() as conn:
        row = _lock_case(conn, case_id)
        observation = _case_observation(conn, row)
        if not observation or not observation.get("resolved_product_id"):
            raise HTTPException(status_code=409, detail="该冲突未关联货品，无法编辑")
        product_id = int(observation["resolved_product_id"])
        before = fetch_one(conn, "SELECT * FROM product WHERE product_id=%s FOR UPDATE", (product_id,))
        if not before:
            raise HTTPException(status_code=404, detail="货品不存在")
        values = payload.model_dump(exclude_unset=True, exclude={"resolution_notes"})
        uom_id = values.get("default_uom_id", before.get("default_uom_id"))
        if uom_id is not None and not fetch_one(conn, "SELECT uom_id FROM uom WHERE uom_id=%s AND is_active", (uom_id,)):
            raise HTTPException(status_code=422, detail="默认单位不存在或已停用")
        after = {**before, **values, "default_uom_id": uom_id}
        audit(conn, user, "EDIT", "product", target_id=product_id, before=before, after=after,
              field_diff={k: [before.get(k), v] for k, v in after.items() if before.get(k) != v},
              request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""UPDATE product SET display_name=%s,manufacturer=%s,specification=%s,default_uom_id=%s,source_uom_raw=%s,
                                 category_id=%s,purchase_cost_price=%s,sales_price=%s,updated_at=now()
                         WHERE product_id=%s""",
                        (after["display_name"].strip(), after.get("manufacturer"), after.get("specification"), uom_id, after.get("source_uom_raw"),
                         after.get("category_id"), after.get("purchase_cost_price", 0), after.get("sales_price", 0), product_id))
        conflicts = _set_primary_identifier(conn, product_id, values["primary_identifier"] if values.get("primary_identifier") is not None else "", user, meta) if "primary_identifier" in values else []
        _resolve_case(conn, user, meta, row, "resolved", payload.resolution_notes.strip())
    result = conflict_detail(case_id, user)
    result["identifier_conflicts"] = conflicts
    return result


@app.post("/api/conflicts/{case_id}/resolve")
def resolve_conflict(case_id: int, payload: ConflictResolveIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    if not payload.resolution_notes.strip():
        raise HTTPException(status_code=422, detail="处理备注不能为空")
    meta = _request_meta(request)
    with connection() as conn:
        row = _lock_case(conn, case_id)
        _resolve_case(conn, user, meta, row, payload.outcome, payload.resolution_notes.strip())
    return conflict_detail(case_id, user)


@app.get("/api/audit")
def audit_log(limit: int = 100, user: dict[str, Any] = Depends(require_roles("ADMIN", "FINANCE"))) -> list[dict[str, Any]]:
    limit = min(500, max(1, limit))
    with connection() as conn:
        return fetch_all(conn, "SELECT audit_event_id,actor_user_id,actor_role,action,target_table,target_id,request_id,before_data,after_data,field_diff,created_at FROM audit_event ORDER BY created_at DESC LIMIT %s", (limit,))


_AUDIT_COLUMNS = [
    ("审计ID", lambda r: r["audit_event_id"]),
    ("操作者", lambda r: r["actor_user_id"] or r["actor_role"] or ""),
    ("角色", lambda r: r["actor_role"] or ""),
    ("动作", lambda r: r["action"]),
    ("目标表", lambda r: r["target_table"] or ""),
    ("目标ID", lambda r: r["target_id"] if r["target_id"] is not None else ""),
    ("时间", lambda r: r["created_at"]),
]


@app.get("/api/audit/export")
def audit_export(ids: str = "", fmt: str = "xlsx", user: dict[str, Any] = Depends(require_roles("ADMIN", "FINANCE"))) -> Response:
    if ids:
        try:
            id_list = parse_ids(ids)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        arr = ", ".join(str(i) for i in id_list)
        placeholders = ", ".join(["%s"] * len(id_list))
        with connection() as conn:
            rows = fetch_all(conn, f"""SELECT audit_event_id,actor_user_id,actor_role,action,target_table,target_id,request_id,before_data,after_data,field_diff,created_at
                                         FROM audit_event WHERE audit_event_id IN ({placeholders})
                                         ORDER BY array_position(ARRAY[{arr}], audit_event_id)""", tuple(id_list))
    else:
        with connection() as conn:
            rows = fetch_all(conn, """SELECT audit_event_id,actor_user_id,actor_role,action,target_table,target_id,request_id,before_data,after_data,field_diff,created_at
                                        FROM audit_event ORDER BY created_at DESC LIMIT 500""")
    return export_response(rows, _AUDIT_COLUMNS, "审计日志", fmt)


@app.get("/api/audit/{audit_event_id}")
def audit_detail(audit_event_id: int, user: dict[str, Any] = Depends(require_roles("ADMIN", "FINANCE"))) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, "SELECT audit_event_id,actor_user_id,actor_role,action,target_table,target_id,request_id,ip_address,user_agent,before_data,after_data,field_diff,created_at FROM audit_event WHERE audit_event_id=%s", (audit_event_id,))
        if not row:
            raise HTTPException(status_code=404, detail="审计记录不存在")
        return row
