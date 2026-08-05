from __future__ import annotations

import os
import ipaddress
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware

from .db import audit, connection, ensure_bootstrap_users, fetch_all, fetch_one
from .ocr_client import OCRProxyError, forward_ocr
from .schemas import ConflictResolveIn, LocationIn, LoginIn, OCRExtractIn, ProductIn, RejectIn, StockRequestIn, StockRequestPatch, UserCreateIn
from .security import hash_password, random_token, token_hash, utc_after, verify_password


app = FastAPI(title="Inventory ERP/OA POC", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[x for x in os.environ.get("ERP_CORS_ORIGINS", "http://localhost:5173").split(",") if x],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "X-CSRF-Token"],
)

SESSION_COOKIE = "erp_session"
CSRF_COOKIE = "erp_csrf"


@app.on_event("startup")
def startup() -> None:
    # Compose starts the API after postgres health is ready. The try keeps the
    # API usable for migrations run after container startup.
    try:
        ensure_bootstrap_users()
    except Exception:
        if os.environ.get("ERP_BOOTSTRAP_STRICT", "0") == "1":
            raise


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


def _normalize_query(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value or "").split())


def _user_from_request(request: Request) -> dict[str, Any]:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        raise HTTPException(status_code=401, detail="登录已失效")
    with connection() as conn:
        user = fetch_one(
            conn,
            """SELECT u.user_id,u.username,u.display_name,u.role
               FROM app_session s JOIN app_user u USING(user_id)
               WHERE s.token_hash=%s AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_active""",
            (token_hash(raw),),
        )
    if not user:
        raise HTTPException(status_code=401, detail="登录已失效")
    return user


def require_user(request: Request) -> dict[str, Any]:
    return _user_from_request(request)


def require_admin(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    if user["role"] != "WAREHOUSE_ADMIN":
        raise HTTPException(status_code=403, detail="仅仓管可执行此操作")
    return user


def _csrf(request: Request) -> None:
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    expected = request.cookies.get(CSRF_COOKIE)
    provided = request.headers.get("X-CSRF-Token")
    if not expected or not provided or expected != provided:
        raise HTTPException(status_code=403, detail="CSRF token 无效")
    session = request.cookies.get(SESSION_COOKIE)
    if not session:
        raise HTTPException(status_code=403, detail="会话不存在")
    with connection() as conn:
        row = fetch_one(conn, "SELECT csrf_token_hash FROM app_session WHERE token_hash=%s AND revoked_at IS NULL AND expires_at>now()", (token_hash(session),))
    if not row or row["csrf_token_hash"] != token_hash(expected):
        raise HTTPException(status_code=403, detail="CSRF token 已失效")


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


def _condition_id(conn: Any, value: int | None) -> int:
    if value:
        return value
    row = fetch_one(conn, "SELECT condition_id FROM inventory_condition WHERE code='new'")
    return int(row["condition_id"])


def _line_uom_id(conn: Any, line: Any) -> int:
    """Resolve a requested unit without converting its quantity."""
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
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


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


@app.get("/api/products")
def products(q: str = "", page: int = 1, page_size: int = 30, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    page = max(1, page)
    page_size = min(100, max(1, page_size))
    q = _normalize_query(q)
    needle = "%" + q.strip() + "%"
    with connection() as conn:
        rows = fetch_all(conn, """SELECT DISTINCT p.product_id,p.display_name,p.manufacturer,p.specification,
                    u.code AS uom_code, p.source_uom_raw, ident.value_raw AS identifier
                    FROM product p LEFT JOIN uom u ON u.uom_id=p.default_uom_id
                    LEFT JOIN product_identifier pi ON pi.product_id=p.product_id
                    LEFT JOIN product_name_alias pa ON pa.product_id=p.product_id
                    LEFT JOIN LATERAL (SELECT value_raw FROM product_identifier p0 WHERE p0.product_id=p.product_id ORDER BY p0.product_identifier_id LIMIT 1) ident ON TRUE
                    WHERE (%s='' OR p.display_name ILIKE %s OR coalesce(p.manufacturer,'') ILIKE %s
                      OR coalesce(p.specification,'') ILIKE %s OR coalesce(pi.value_raw,'') ILIKE %s
                      OR coalesce(pa.alias_raw,'') ILIKE %s)
                    ORDER BY p.display_name LIMIT %s OFFSET %s""", (q.strip(), needle, needle, needle, needle, needle, page_size, (page - 1) * page_size))
        total = fetch_one(conn, """SELECT count(DISTINCT p.product_id) AS n FROM product p
                    LEFT JOIN product_identifier pi ON pi.product_id=p.product_id
                    LEFT JOIN product_name_alias pa ON pa.product_id=p.product_id
                    WHERE (%s='' OR p.display_name ILIKE %s OR coalesce(p.manufacturer,'') ILIKE %s
                      OR coalesce(p.specification,'') ILIKE %s OR coalesce(pi.value_raw,'') ILIKE %s OR coalesce(pa.alias_raw,'') ILIKE %s)""", (q.strip(), needle, needle, needle, needle, needle))
    return {"items": rows, "page": page, "page_size": page_size, "total": total["n"]}


@app.post("/api/products")
def create_product(payload: ProductIn, request: Request, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    _csrf(request)
    meta = _request_meta(request)
    with connection() as conn:
        uom_id = payload.default_uom_id or int(fetch_one(conn, "SELECT uom_id FROM uom WHERE code='EA'")["uom_id"])
        audit(conn, user, "CREATE", "product", after=payload.model_dump(), request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO product(display_name,manufacturer,specification,default_uom_id,source_uom_raw)
                         VALUES (%s,%s,%s,%s,%s) RETURNING product_id""", (payload.display_name.strip(), payload.manufacturer, payload.specification, uom_id, payload.source_uom_raw))
            product_id = cur.fetchone()[0]
        return fetch_one(conn, "SELECT * FROM product WHERE product_id=%s", (product_id,)) or {}


@app.put("/api/products/{product_id}")
def update_product(product_id: int, payload: ProductIn, request: Request, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    _csrf(request)
    meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM product WHERE product_id=%s FOR UPDATE", (product_id,))
        if not before:
            raise HTTPException(status_code=404, detail="货品不存在")
        uom_id = payload.default_uom_id or int(fetch_one(conn, "SELECT uom_id FROM uom WHERE code='EA'")["uom_id"])
        after = {**payload.model_dump(), "default_uom_id": uom_id}
        audit(conn, user, "EDIT", "product", target_id=product_id, before=before, after=after, field_diff={k: [before.get(k), v] for k, v in after.items() if before.get(k) != v}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""UPDATE product SET display_name=%s,manufacturer=%s,specification=%s,default_uom_id=%s,source_uom_raw=%s,updated_at=now()
                         WHERE product_id=%s""", (payload.display_name.strip(), payload.manufacturer, payload.specification, uom_id, payload.source_uom_raw, product_id))
        return fetch_one(conn, "SELECT * FROM product WHERE product_id=%s", (product_id,)) or {}


@app.get("/api/inventory/balance")
def inventory_balance(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT * FROM v_inventory_balance ORDER BY product_name,location_name")


@app.get("/api/uoms")
def uoms(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT uom_id,code,display_name,decimal_scale FROM uom WHERE is_active ORDER BY code")


@app.get("/api/locations")
def locations(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT location_id,code,name,location_type,is_company_inventory,is_active FROM location WHERE is_active ORDER BY name")


@app.post("/api/locations")
def create_location(payload: LocationIn, request: Request, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
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


@app.get("/api/admin/users")
def users(user: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT user_id,username,display_name,role,is_active,created_at FROM app_user ORDER BY username")


@app.post("/api/admin/users")
def create_user(payload: UserCreateIn, request: Request, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    _csrf(request)
    if payload.role not in {"WAREHOUSE_ADMIN", "REQUESTER"}:
        raise HTTPException(status_code=422, detail="角色无效")
    with connection() as conn:
        if fetch_one(conn, "SELECT user_id FROM app_user WHERE username=%s", (payload.username.strip(),)):
            raise HTTPException(status_code=409, detail="用户名已存在")
        audit(conn, user, "CREATE", "app_user", after={"username": payload.username.strip(), "display_name": payload.display_name, "role": payload.role})
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO app_user(username,display_name,role,password_hash)
                         VALUES (%s,%s,%s,%s) RETURNING user_id,username,display_name,role,is_active,created_at""", (payload.username.strip(), payload.display_name.strip(), payload.role, hash_password(payload.password)))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@app.get("/api/stock-requests")
def stock_requests(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        if user["role"] == "WAREHOUSE_ADMIN":
            return fetch_all(conn, "SELECT sr.*,u.username AS requester_username FROM stock_request sr JOIN app_user u ON u.user_id=sr.requester_user_id ORDER BY sr.created_at DESC")
        return fetch_all(conn, "SELECT * FROM stock_request WHERE requester_user_id=%s ORDER BY created_at DESC", (user["user_id"],))


@app.get("/api/stock-requests/{request_id}")
def stock_request_detail(request_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, "SELECT * FROM stock_request WHERE stock_request_id=%s", (request_id,))
        if not row or (user["role"] != "WAREHOUSE_ADMIN" and row["requester_user_id"] != user["user_id"]):
            raise HTTPException(status_code=404, detail="申请单不存在")
        row["lines"] = fetch_all(conn, "SELECT * FROM stock_request_line WHERE stock_request_id=%s ORDER BY stock_request_line_id", (request_id,))
        row["actions"] = fetch_all(conn, "SELECT * FROM stock_request_action WHERE stock_request_id=%s ORDER BY created_at", (request_id,))
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
        if not row or (user["role"] != "WAREHOUSE_ADMIN" and row["requester_user_id"] != user["user_id"]):
            raise HTTPException(status_code=404, detail="申请单不存在")
        if row["status"] == "RELEASED" or (user["role"] != "WAREHOUSE_ADMIN" and row["status"] != "DRAFT"):
            raise HTTPException(status_code=409, detail="当前状态不可编辑")
        before = {"source_location_id": row["source_location_id"], "destination_location_id": row["destination_location_id"], "reason": row["reason"]}
        after = {"source_location_id": payload.source_location_id, "destination_location_id": payload.destination_location_id, "reason": payload.reason}
        audit(conn, user, "EDIT", "stock_request", target_id=request_id, before=before, after=after, field_diff={k: [before[k], after[k]] for k in before if before[k] != after[k]}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE stock_request SET source_location_id=%s,destination_location_id=%s,reason=%s,version=version+1,updated_at=now() WHERE stock_request_id=%s", (payload.source_location_id, payload.destination_location_id, payload.reason, request_id))
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


def _transition(request_id: int, target: str, request: Request, user: dict[str, Any], comment: str | None = None) -> dict[str, Any]:
    meta = _request_meta(request)
    with connection() as conn:
        row = fetch_one(conn, "SELECT * FROM stock_request WHERE stock_request_id=%s FOR UPDATE", (request_id,))
        if not row or (user["role"] != "WAREHOUSE_ADMIN" and row["requester_user_id"] != user["user_id"]):
            raise HTTPException(status_code=404, detail="申请单不存在")
        current = row["status"]
        rules = {"SUBMITTED": {"DRAFT"}, "WITHDRAWN": {"DRAFT"}, "APPROVED": {"SUBMITTED"}, "REJECTED": {"SUBMITTED"}, "RELEASED": {"APPROVED"}}
        if current not in rules.get(target, set()):
            raise HTTPException(status_code=409, detail=f"不允许从 {current} 转为 {target}")
        if target in {"APPROVED", "REJECTED", "RELEASED"} and user["role"] != "WAREHOUSE_ADMIN":
            raise HTTPException(status_code=403, detail="仅仓管可审批或放行")
        audit(conn, user, target, "stock_request", target_id=request_id, before={"status": current}, after={"status": target}, field_diff={"status": [current, target]}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            if target == "REJECTED":
                cur.execute("UPDATE stock_request SET status=%s,rejection_reason=%s,version=version+1,updated_at=now() WHERE stock_request_id=%s", (target, comment, request_id))
            elif target == "SUBMITTED":
                cur.execute("UPDATE stock_request SET status=%s,submitted_at=now(),version=version+1,updated_at=now() WHERE stock_request_id=%s", (target, request_id))
            elif target == "APPROVED":
                cur.execute("UPDATE stock_request SET status=%s,approved_at=now(),version=version+1,updated_at=now() WHERE stock_request_id=%s", (target, request_id))
            elif target == "RELEASED":
                cur.execute("UPDATE stock_request SET status=%s,released_at=now(),version=version+1,updated_at=now() WHERE stock_request_id=%s", (target, request_id))
            else:
                cur.execute("UPDATE stock_request SET status=%s,version=version+1,updated_at=now() WHERE stock_request_id=%s", (target, request_id))
            action_name = {"SUBMITTED": "SUBMIT", "WITHDRAWN": "WITHDRAW", "APPROVED": "APPROVE", "REJECTED": "REJECT", "RELEASED": "RELEASE"}[target]
            audit(conn, user, action_name, "stock_request_action", after={"stock_request_id": request_id, "action": action_name, "from_status": current, "to_status": target}, request_id=meta["request_id"])
            cur.execute("INSERT INTO stock_request_action(stock_request_id,actor_user_id,action,from_status,to_status,comment) VALUES (%s,%s,%s,%s,%s,%s)", (request_id, user["user_id"], action_name, current, target, comment))
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
def approve(request_id: int, request: Request, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    _csrf(request); return _transition(request_id, "APPROVED", request, user)


@app.post("/api/stock-requests/{request_id}/reject")
def reject(request_id: int, payload: RejectIn, request: Request, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    _csrf(request); return _transition(request_id, "REJECTED", request, user, payload.reason)


@app.post("/api/stock-requests/{request_id}/release")
def release(request_id: int, request: Request, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    _csrf(request); return _transition(request_id, "RELEASED", request, user)


@app.get("/api/conflicts")
def conflicts(user: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, """SELECT rc.*,dr.code AS status_code FROM resolution_case rc JOIN record_status dr ON dr.status_id=rc.status_id
                                  WHERE dr.code='pending_review' ORDER BY rc.opened_at DESC""")


@app.post("/api/conflicts/{case_id}/resolve")
def resolve_conflict(case_id: int, payload: ConflictResolveIn, request: Request, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    _csrf(request)
    meta = _request_meta(request)
    with connection() as conn:
        row = fetch_one(conn, "SELECT rc.*,rs.code AS status_code FROM resolution_case rc JOIN record_status rs ON rs.status_id=rc.status_id WHERE resolution_case_id=%s FOR UPDATE", (case_id,))
        if not row:
            raise HTTPException(status_code=404, detail="冲突不存在")
        resolved_id = _status_id(conn, "resolved")
        audit(conn, user, "RESOLVE", "resolution_case", target_id=case_id, before={"status": row["status_code"]}, after={"status": "resolved", "notes": payload.resolution_notes}, request_id=meta["request_id"], ip_address=meta["ip_address"], user_agent=meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE resolution_case SET status_id=%s,resolved_at=now(),assigned_to=%s,resolution_notes=%s WHERE resolution_case_id=%s", (resolved_id, user["username"], payload.resolution_notes, case_id))
        return fetch_one(conn, "SELECT * FROM resolution_case WHERE resolution_case_id=%s", (case_id,)) or {}


@app.get("/api/audit")
def audit_log(limit: int = 100, user: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    limit = min(500, max(1, limit))
    with connection() as conn:
        return fetch_all(conn, "SELECT audit_event_id,actor_user_id,actor_role,action,target_table,target_id,request_id,before_data,after_data,field_diff,created_at FROM audit_event ORDER BY created_at DESC LIMIT %s", (limit,))
