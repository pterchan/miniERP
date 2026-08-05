"""Generic business-document engine.

Posting a document writes posted inventory_movement rows (stock) and ar_ap_entry
rows (receivable/payable/deposit). 红冲 (reverse) creates a reversal document and
posts the inverse movements/entries so the ledger nets to zero.
"""

from __future__ import annotations

import base64
from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from psycopg2 import Binary

from .db import audit, connection, fetch_all, fetch_one
from .export import export_response
from .list_params import clamp_page, clamp_page_size, parse_filters, parse_ids, parse_sort
from .helpers import _condition_id, _line_uom_id, _movement_id, _request_meta, _status_id
from .permissions import DOC_TYPE_META, GROUP_META, _can_post, _csrf, require_user
from .schemas import AttachmentIn, DocCreateIn, DocSubmitIn, DocUpdateIn

router = APIRouter(prefix="/api/documents", tags=["documents"])
attachments_router = APIRouter(prefix="/api/attachments", tags=["documents"])

# 价格来源：销售单用销售价（可命中批发档）、采购单用采购成本价
PRICE_SOURCE = {
    "PURCHASE_ORDER": "cost", "PURCHASE_RECEIPT": "cost", "PURCHASE_RETURN": "cost",
    "SALES_ORDER": "sales", "SALES_DELIVERY": "sales", "SALES_RETURN": "sales",
    "STOCK_TRANSFER": None, "STOCK_COUNT": None, "STOCK_LOSS": None, "OTHER_IN": None, "OTHER_OUT": None,
}

MOVEMENT_FOR_DOC = {
    "PURCHASE_RECEIPT": "PURCHASE_IN",
    "PURCHASE_RETURN": "PURCHASE_RETURN",
    "SALES_DELIVERY": "SALES_OUT",
    "SALES_RETURN": "SALES_RETURN",
    "STOCK_TRANSFER": "TRANSFER",
    "STOCK_COUNT": "ADJUSTMENT",
    "STOCK_LOSS": "STOCK_LOSS",
    "OTHER_IN": "OTHER_IN",
    "OTHER_OUT": "OTHER_OUT",
}

# 红冲时反向流水类型（换类型以满足 validate_posted_inventory_movement 的形状约束）
INVERSE_MOVEMENT = {
    "PURCHASE_IN": "PURCHASE_RETURN",
    "PURCHASE_RETURN": "PURCHASE_IN",
    "SALES_OUT": "SALES_RETURN",
    "SALES_RETURN": "SALES_OUT",
    "STOCK_LOSS": "OTHER_IN",
    "OTHER_IN": "OTHER_OUT",
    "OTHER_OUT": "OTHER_IN",
    "TRANSFER": "TRANSFER",
    "ADJUSTMENT": "ADJUSTMENT",
}


def _next_doc_no(conn: Any, doc_type: str) -> str:
    with conn.cursor() as cur:
        cur.execute("SELECT nextval('document_no_seq')")
        n = cur.fetchone()[0]
    return f"{DOC_TYPE_META[doc_type]['prefix']}-{n:06d}"


def _main_location(conn: Any) -> int | None:
    row = fetch_one(conn, "SELECT location_id FROM location WHERE code='MAIN' AND is_active")
    return int(row["location_id"]) if row else None


def _resolve_price(conn: Any, doc_type: str, line: Any, product: dict[str, Any]) -> Decimal:
    if line.price is not None:
        return line.price
    source = PRICE_SOURCE.get(doc_type)
    if source == "sales":
        chosen: Decimal | None = None
        tiers = fetch_all(conn, "SELECT min_quantity, price FROM product_price_tier WHERE product_id=%s ORDER BY min_quantity", (line.product_id,))
        for tier in tiers:
            if line.quantity >= tier["min_quantity"]:
                chosen = tier["price"]
        if chosen is not None:
            return chosen
        return product.get("sales_price") or Decimal(0)
    if source == "cost":
        return product.get("purchase_cost_price") or Decimal(0)
    return Decimal(0)


def _doc_detail(conn: Any, document_id: int, user: dict[str, Any]) -> dict[str, Any]:
    row = fetch_one(conn, "SELECT * FROM business_document WHERE document_id=%s", (document_id,))
    if not row:
        raise HTTPException(status_code=404, detail="单据不存在")
    meta = DOC_TYPE_META[row["doc_type"]]
    if user["role"] not in meta["view_roles"]:
        raise HTTPException(status_code=403, detail="无权查看此单据")
    if row["party_type"] == "CUSTOMER":
        party = fetch_one(conn, "SELECT name FROM customer WHERE customer_id=%s", (row["party_id"],))
        row["party_name"] = party["name"] if party else None
    elif row["party_type"] == "SUPPLIER":
        party = fetch_one(conn, "SELECT name FROM supplier WHERE supplier_id=%s", (row["party_id"],))
        row["party_name"] = party["name"] if party else None
    else:
        row["party_name"] = None
    row["doc_type_label"] = meta["label"]
    lines = fetch_all(conn, """SELECT l.*, p.display_name AS product_name, p.manufacturer, p.specification,
                                      u.code AS uom_code, u.display_name AS uom_display_name,
                                      sl.name AS source_location_name, dl.name AS destination_location_name,
                                      ic.code AS condition_code
                                 FROM business_document_line l
                                 JOIN product p ON p.product_id=l.product_id
                                 JOIN uom u ON u.uom_id=l.uom_id
                                 LEFT JOIN location sl ON sl.location_id=l.source_location_id
                                 LEFT JOIN location dl ON dl.location_id=l.destination_location_id
                                 LEFT JOIN inventory_condition ic ON ic.condition_id=l.condition_id
                                WHERE l.document_id=%s ORDER BY l.line_no""", (document_id,))
    row["lines"] = lines
    row["attachments"] = fetch_all(conn, """SELECT attachment_id,filename,content_type,size,created_at,uploaded_by
                                              FROM document_attachment WHERE document_id=%s ORDER BY attachment_id""", (document_id,))
    row["ar_ap_entries"] = []
    if user["role"] in ("FINANCE", "ADMIN"):
        row["ar_ap_entries"] = fetch_all(conn, """SELECT ar_ap_entry_id,entry_type,direction,amount,created_at
                                                    FROM ar_ap_entry WHERE document_id=%s ORDER BY ar_ap_entry_id""", (document_id,))
    creator = fetch_one(conn, "SELECT username FROM app_user WHERE user_id=%s", (row["created_by"],))
    row["creator_name"] = creator["username"] if creator else None
    row["reversal_document"] = None
    if row["reversal_of_document_id"]:
        row["reversal_document"] = fetch_one(conn, "SELECT document_id,doc_no,doc_type FROM business_document WHERE document_id=%s", (row["reversal_of_document_id"],))
    elif row["status"] == "REVERSED":
        row["reversal_document"] = fetch_one(conn, "SELECT document_id,doc_no,doc_type FROM business_document WHERE reversal_of_document_id=%s", (document_id,))
    return row


def _resolve_locations(conn: Any, doc: dict[str, Any], line: dict[str, Any], meta: dict[str, Any]) -> tuple[int | None, int | None]:
    """Return (source_location_id, destination_location_id) for posting a line."""
    source = line["source_location_id"] or doc["source_location_id"]
    dest = line["destination_location_id"] or doc["destination_location_id"]
    stock = meta["stock_effect"]
    if stock in ("IN",):
        dest = dest or _main_location(conn)
        if not dest:
            raise HTTPException(status_code=422, detail="入库单据必须指定目的库位")
        return None, dest
    if stock == "OUT":
        source = source or _main_location(conn)
        if not source:
            raise HTTPException(status_code=422, detail="出库单据必须指定来源库位")
        return source, None
    if stock == "TRANSFER":
        if not source or not dest:
            raise HTTPException(status_code=422, detail="调拨单据必须指定来源和目的库位")
        if source == dest:
            raise HTTPException(status_code=422, detail="来源和目的库位不能相同")
        return source, dest
    if stock == "COUNT":
        source = source or _main_location(conn)
        if not source:
            raise HTTPException(status_code=422, detail="盘点单据必须指定盘点库位")
        return source, None
    return None, None


def _insert_movement(conn: Any, user: dict[str, Any], req_meta: dict[str, Any], movement_code: str,
                     doc: dict[str, Any], line: dict[str, Any], quantity: Decimal,
                     source: int | None, dest: int | None, reversal_of: int | None = None, document_id: int | None = None) -> None:
    audit(conn, user, "POST", "inventory_movement",
          after={"document_id": doc["document_id"], "product_id": line["product_id"], "quantity": str(quantity),
                 "movement_type": movement_code, "reversal_of": reversal_of},
          request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO inventory_movement(movement_type_id,status_id,movement_date,product_id,quantity,uom_id,condition_id,source_location_id,destination_location_id,document_id,reversal_of_movement_id,notes,posted_at,posted_by)
                     VALUES (%s,%s,current_date,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s)""",
                    (_movement_id(conn, movement_code), _status_id(conn, "posted"), line["product_id"], quantity,
                     line["uom_id"], _condition_id(conn, line["condition_id"]), source, dest,
                     document_id or doc["document_id"], reversal_of, doc["notes"], user["username"]))


def _insert_arap(conn: Any, user: dict[str, Any], req_meta: dict[str, Any], party_type: str, party_id: int,
                 entry_type: str, direction: str, amount: Decimal, document_id: int) -> None:
    audit(conn, user, "POST", "ar_ap_entry",
          after={"party_type": party_type, "party_id": party_id, "entry_type": entry_type,
                 "direction": direction, "amount": str(amount), "document_id": document_id},
          request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO ar_ap_entry(party_type,party_id,entry_type,direction,amount,document_id,created_by)
                     VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (party_type, party_id, entry_type, direction, amount, document_id, user["user_id"]))


def _post_line(conn: Any, user: dict[str, Any], req_meta: dict[str, Any], doc: dict[str, Any],
               meta: dict[str, Any], line: dict[str, Any], source: int | None, dest: int | None) -> None:
    stock = meta["stock_effect"]
    if stock == "COUNT":
        condition_id = _condition_id(conn, line["condition_id"])
        balance = fetch_one(conn, """SELECT on_hand_quantity FROM v_inventory_balance
                                      WHERE product_id=%s AND location_id=%s AND condition_id=%s AND uom_id=%s""",
                            (line["product_id"], source, condition_id, line["uom_id"]))
        book = Decimal(balance["on_hand_quantity"]) if balance else Decimal(0)
        counted = Decimal(line["counted_quantity"]) if line["counted_quantity"] is not None else Decimal(line["quantity"])
        audit(conn, user, "COUNT_BOOK", "business_document_line", target_id=line["document_line_id"],
              after={"book_quantity": str(book), "counted_quantity": str(counted)},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE business_document_line SET book_quantity=%s WHERE document_line_id=%s", (book, line["document_line_id"]))
        delta = counted - book
        if delta != 0:
            _insert_movement(conn, user, req_meta, "ADJUSTMENT", doc, line, abs(delta),
                             source if delta < 0 else None, source if delta > 0 else None)
        return
    if stock in ("IN", "OUT", "TRANSFER"):
        movement_code = MOVEMENT_FOR_DOC[doc["doc_type"]]
        qty = line["quantity"]
        if stock == "IN":
            _insert_movement(conn, user, req_meta, movement_code, doc, line, qty, None, dest)
        elif stock == "OUT":
            _insert_movement(conn, user, req_meta, movement_code, doc, line, qty, source, None)
        else:
            _insert_movement(conn, user, req_meta, movement_code, doc, line, qty, source, dest)
    ap = meta["ap_effect"]
    if ap in ("PAYABLE_UP", "PAYABLE_DOWN"):
        amount = (line["quantity"] * line["price"]).quantize(Decimal("0.01"))
        _insert_arap(conn, user, req_meta, "SUPPLIER", doc["party_id"], "INVOICE",
                     "UP" if ap == "PAYABLE_UP" else "DOWN", amount, doc["document_id"])
    elif ap in ("RECEIVABLE_UP", "RECEIVABLE_DOWN"):
        amount = (line["quantity"] * line["price"]).quantize(Decimal("0.01"))
        _insert_arap(conn, user, req_meta, "CUSTOMER", doc["party_id"], "INVOICE",
                     "UP" if ap == "RECEIVABLE_UP" else "DOWN", amount, doc["document_id"])


def _post_document(conn: Any, document_id: int, user: dict[str, Any], req_meta: dict[str, Any], override_review: bool) -> dict[str, Any]:
    doc = fetch_one(conn, "SELECT * FROM business_document WHERE document_id=%s FOR UPDATE", (document_id,))
    if not doc:
        raise HTTPException(status_code=404, detail="单据不存在")
    if doc["status"] not in ("DRAFT", "SUBMITTED"):
        raise HTTPException(status_code=409, detail="仅草稿或已提交单据可过账")
    _can_post(user, doc, override_review)
    meta = DOC_TYPE_META[doc["doc_type"]]
    lines = fetch_all(conn, "SELECT * FROM business_document_line WHERE document_id=%s ORDER BY line_no", (document_id,))
    if not lines:
        raise HTTPException(status_code=422, detail="单据至少需要一条明细")
    locations: dict[int, tuple[int | None, int | None]] = {}
    for line in lines:
        locations[line["document_line_id"]] = _resolve_locations(conn, doc, line, meta)
    audit(conn, user, "POST", "business_document", target_id=document_id,
          before={"status": doc["status"]}, after={"status": "POSTED"},
          request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
    with conn.cursor() as cur:
        cur.execute("UPDATE business_document SET status='POSTED',posted_by=%s,posted_at=now(),updated_at=now() WHERE document_id=%s", (user["username"], document_id))
    for line in lines:
        source, dest = locations[line["document_line_id"]]
        _post_line(conn, user, req_meta, doc, meta, line, source, dest)
    if meta["ap_effect"] == "DEPOSIT" and doc["deposit_amount"] and Decimal(doc["deposit_amount"]) > 0:
        _insert_arap(conn, user, req_meta, "CUSTOMER", doc["party_id"], "DEPOSIT", "DOWN", Decimal(doc["deposit_amount"]), document_id)
    return _doc_detail(conn, document_id, user)


def _reverse_document(conn: Any, document_id: int, user: dict[str, Any], req_meta: dict[str, Any]) -> dict[str, Any]:
    doc = fetch_one(conn, "SELECT * FROM business_document WHERE document_id=%s FOR UPDATE", (document_id,))
    if not doc:
        raise HTTPException(status_code=404, detail="单据不存在")
    if doc["status"] != "POSTED":
        raise HTTPException(status_code=409, detail="仅已过账单据可红冲")
    if doc["reversal_of_document_id"]:
        raise HTTPException(status_code=409, detail="红冲单据不能再红冲")
    _can_post(user, doc, False)
    # 原单标记红冲
    audit(conn, user, "REVERSE", "business_document", target_id=document_id,
          before={"status": "POSTED"}, after={"status": "REVERSED"},
          request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
    with conn.cursor() as cur:
        cur.execute("UPDATE business_document SET status='REVERSED',reversed_by=%s,reversed_at=now(),updated_at=now() WHERE document_id=%s", (user["username"], document_id))
    # 反向单据（直接 POSTED）
    rev_no = _next_doc_no(conn, doc["doc_type"])
    audit(conn, user, "CREATE", "business_document",
          after={"doc_type": doc["doc_type"], "doc_no": rev_no, "reversal_of": document_id},
          request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO business_document(doc_type,doc_no,status,doc_date,party_type,party_id,source_location_id,destination_location_id,deposit_amount,total_amount,notes,created_by,posted_by,posted_at,reversal_of_document_id)
                     VALUES (%s,%s,'POSTED',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s) RETURNING document_id""",
                    (doc["doc_type"], rev_no, doc["doc_date"], doc["party_type"], doc["party_id"],
                     doc["source_location_id"], doc["destination_location_id"], doc["deposit_amount"],
                     doc["total_amount"], doc["notes"], user["user_id"], user["username"], document_id))
        rev_doc_id = cur.fetchone()[0]
        # 反向单据复制原单明细，便于追溯
        original_lines = fetch_all(conn, "SELECT * FROM business_document_line WHERE document_id=%s ORDER BY line_no", (document_id,))
        for ol in original_lines:
            audit(conn, user, "CREATE", "business_document_line",
                  after={"document_id": rev_doc_id, "line_no": ol["line_no"], "product_id": ol["product_id"]},
                  request_id=req_meta["request_id"])
            cur.execute("""INSERT INTO business_document_line(document_id,line_no,product_id,uom_id,quantity,price,amount,condition_id,source_location_id,destination_location_id,counted_quantity,book_quantity,notes)
                         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (rev_doc_id, ol["line_no"], ol["product_id"], ol["uom_id"], ol["quantity"], ol["price"], ol["amount"],
                         ol["condition_id"], ol["source_location_id"], ol["destination_location_id"], ol["counted_quantity"], ol["book_quantity"], ol["notes"]))
    # 反向库存流水：换反向类型 + 对调库位
    mtype_codes = {int(r["movement_type_id"]): r["code"] for r in fetch_all(conn, "SELECT movement_type_id, code FROM movement_type")}
    movements = fetch_all(conn, """SELECT * FROM inventory_movement
                                    WHERE document_id=%s AND status_id=(SELECT status_id FROM record_status WHERE code='posted')""", (document_id,))
    for m in movements:
        code = mtype_codes.get(int(m["movement_type_id"]), "ADJUSTMENT")
        inv = INVERSE_MOVEMENT.get(code, code)
        _insert_movement(conn, user, req_meta, inv, doc, m, m["quantity"],
                         m["destination_location_id"], m["source_location_id"],
                         reversal_of=int(m["inventory_movement_id"]), document_id=rev_doc_id)
    # 反向应收应付：direction 翻转
    entries = fetch_all(conn, "SELECT * FROM ar_ap_entry WHERE document_id=%s", (document_id,))
    for e in entries:
        _insert_arap(conn, user, req_meta, e["party_type"], e["party_id"], e["entry_type"],
                     "DOWN" if e["direction"] == "UP" else "UP", e["amount"], rev_doc_id)
    return _doc_detail(conn, document_id, user)


_DOC_SORT = {
    "created_at": "d.created_at",
    "doc_no": "d.doc_no",
    "doc_date": "d.doc_date",
    "total_amount": "d.total_amount",
    "status": "d.status",
    "doc_type": "d.doc_type",
}

_DOC_FILTERS = {
    "status": ("d.status", ("eq", "in", "ne")),
    "doc_type": ("d.doc_type", ("eq", "in")),
    "doc_no": ("d.doc_no", ("contains", "eq")),
    "party_name": ("coalesce(c.name, s.name, '')", ("contains", "eq")),
    "doc_date": ("d.doc_date", ("gte", "lte", "eq")),
}

_DOC_QUERY = """SELECT d.document_id, d.doc_type, d.doc_no, d.status, d.doc_date, d.deposit_amount, d.total_amount,
                       d.posted_by, d.created_at,
                       CASE WHEN d.party_type='CUSTOMER' THEN c.name WHEN d.party_type='SUPPLIER' THEN s.name END AS party_name,
                       (SELECT count(*) FROM business_document_line l WHERE l.document_id=d.document_id) AS line_count
                  FROM business_document d
                  LEFT JOIN customer c ON d.party_type='CUSTOMER' AND c.customer_id=d.party_id
                  LEFT JOIN supplier s ON d.party_type='SUPPLIER' AND s.supplier_id=d.party_id
                 WHERE {where}
                 ORDER BY {order_by}"""

_DOC_COUNT = """SELECT count(*) AS n FROM business_document d
                  LEFT JOIN customer c ON d.party_type='CUSTOMER' AND c.customer_id=d.party_id
                  LEFT JOIN supplier s ON d.party_type='SUPPLIER' AND s.supplier_id=d.party_id
                 WHERE {where}"""

_DOC_COLUMNS = [
    ("单据ID", lambda r: r["document_id"]),
    ("单号", lambda r: r["doc_no"]),
    ("类型", lambda r: r["doc_type_label"]),
    ("日期", lambda r: r["doc_date"]),
    ("往来方", lambda r: r["party_name"] or ""),
    ("金额", lambda r: r["total_amount"]),
    ("状态", lambda r: r["status"]),
    ("过账人", lambda r: r["posted_by"] or ""),
    ("创建时间", lambda r: r["created_at"]),
]


def _resolve_doc_types(doc_type: str, group: str, user: dict[str, Any]) -> list[str]:
    """按 group/doc_type 解析当前用户可见的单据类型集合；列表与导出共用。"""
    if group:
        g = GROUP_META.get(group)
        if not g:
            raise HTTPException(status_code=422, detail="单据分组不存在")
        if user["role"] not in g["view_roles"]:
            raise HTTPException(status_code=403, detail="无权查看该分组")
        return list(g["types"])
    if doc_type:
        meta = DOC_TYPE_META.get(doc_type)
        if not meta:
            raise HTTPException(status_code=422, detail="单据类型不存在")
        if user["role"] not in meta["view_roles"]:
            raise HTTPException(status_code=403, detail="无权查看此单据")
        return [doc_type]
    return [t for t, m in DOC_TYPE_META.items() if user["role"] in m["view_roles"]]


def _doc_where(allowed: list[str], filters: list[str]) -> tuple[str, list]:
    clauses = ["d.doc_type = ANY(%s)"]
    params: list = [list(allowed)]
    filter_parts, filter_params = parse_filters(filters, _DOC_FILTERS)
    clauses.extend(filter_parts)
    params.extend(filter_params)
    return " AND ".join(clauses), params


@router.get("")
def documents(doc_type: str = "", group: str = "", page: int = 1, page_size: int = 30,
              sort: str = "", order: str = "asc", f: list[str] = Query(default=[]),
              user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    page = clamp_page(page)
    page_size = clamp_page_size(page_size, cap=500)
    allowed = _resolve_doc_types(doc_type, group, user)
    if not allowed:
        return {"items": [], "page": page, "page_size": page_size, "total": 0}
    where, params = _doc_where(allowed, f)
    order_by = parse_sort(sort, order, _DOC_SORT, "created_at")
    with connection() as conn:
        rows = fetch_all(conn, _DOC_QUERY.format(where=where, order_by=order_by) + " LIMIT %s OFFSET %s", tuple(params + [page_size, (page - 1) * page_size]))
        total = fetch_one(conn, _DOC_COUNT.format(where=where), tuple(params))
    for row in rows:
        row["doc_type_label"] = DOC_TYPE_META[row["doc_type"]]["label"]
    return {"items": rows, "page": page, "page_size": page_size, "total": int(total["n"])}


@router.get("/export")
def documents_export(doc_type: str = "", group: str = "", sort: str = "", order: str = "asc",
                     f: list[str] = Query(default=[]), ids: str = "", fmt: str = "xlsx",
                     user: dict[str, Any] = Depends(require_user)) -> Response:
    allowed = _resolve_doc_types(doc_type, group, user)
    if not allowed:
        return export_response([], _DOC_COLUMNS, "单据", fmt)
    where, params = _doc_where(allowed, f)
    if ids:
        try:
            id_list = parse_ids(ids)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        id_params = ", ".join(["%s"] * len(id_list))
        where = f"{where} AND d.document_id IN ({id_params})"
        params.extend(id_list)
    order_by = parse_sort(sort, order, _DOC_SORT, "created_at")
    with connection() as conn:
        rows = fetch_all(conn, _DOC_QUERY.format(where=where, order_by=order_by), tuple(params))
    for row in rows:
        row["doc_type_label"] = DOC_TYPE_META[row["doc_type"]]["label"]
    return export_response(rows, _DOC_COLUMNS, "单据", fmt)


@router.get("/{document_id}")
def get_document(document_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    with connection() as conn:
        return _doc_detail(conn, document_id, user)


@router.post("")
def create_document(payload: DocCreateIn, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request)
    meta = DOC_TYPE_META.get(payload.doc_type)
    if not meta:
        raise HTTPException(status_code=422, detail="单据类型不存在")
    if user["role"] not in meta["create_roles"]:
        raise HTTPException(status_code=403, detail="无权创建此单据")
    req_meta = _request_meta(request)
    with connection() as conn:
        if meta["party"] == "supplier":
            if not payload.party_id or not fetch_one(conn, "SELECT supplier_id FROM supplier WHERE supplier_id=%s AND is_active", (payload.party_id,)):
                raise HTTPException(status_code=422, detail="供应商不存在或已停用")
            party_type, party_id = "SUPPLIER", payload.party_id
        elif meta["party"] == "customer":
            if not payload.party_id or not fetch_one(conn, "SELECT customer_id FROM customer WHERE customer_id=%s AND is_active", (payload.party_id,)):
                raise HTTPException(status_code=422, detail="客户不存在或已停用")
            party_type, party_id = "CUSTOMER", payload.party_id
        else:
            party_type, party_id = None, None
        line_rows: list[tuple[int, Any, dict[str, Any], int, Decimal, Decimal]] = []
        total = Decimal(0)
        for i, line in enumerate(payload.lines, start=1):
            product = fetch_one(conn, "SELECT * FROM product WHERE product_id=%s", (line.product_id,))
            if not product:
                raise HTTPException(status_code=404, detail=f"明细第 {i} 行货品不存在")
            uom_id = _line_uom_id(conn, line)
            price = _resolve_price(conn, payload.doc_type, line, product)
            amount = (line.quantity * price).quantize(Decimal("0.01"))
            total += amount
            line_rows.append((i, line, product, uom_id, price, amount))
        doc_no = _next_doc_no(conn, payload.doc_type)
        audit(conn, user, "CREATE", "business_document",
              after={"doc_type": payload.doc_type, "doc_no": doc_no, "party_id": party_id},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO business_document(doc_type,doc_no,status,doc_date,party_type,party_id,source_location_id,destination_location_id,deposit_amount,total_amount,notes,created_by)
                         VALUES (%s,%s,'DRAFT',%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING document_id""",
                        (payload.doc_type, doc_no, payload.doc_date or date.today(), party_type, party_id,
                         payload.source_location_id, payload.destination_location_id, payload.deposit_amount or 0,
                         total, payload.notes, user["user_id"]))
            document_id = cur.fetchone()[0]
            for i, (line_no, line, _product, uom_id, price, amount) in enumerate(line_rows, start=1):
                audit(conn, user, "CREATE", "business_document_line",
                      after={"document_id": document_id, "line_no": i, "product_id": line.product_id},
                      request_id=req_meta["request_id"])
                cur.execute("""INSERT INTO business_document_line(document_id,line_no,product_id,uom_id,quantity,price,amount,condition_id,source_location_id,destination_location_id,counted_quantity,notes)
                             VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (document_id, i, line.product_id, uom_id, line.quantity, price, amount,
                             _condition_id(conn, line.condition_id), line.source_location_id, line.destination_location_id,
                             line.counted_quantity, line.notes))
        return _doc_detail(conn, document_id, user)


@router.put("/{document_id}")
def update_document(document_id: int, payload: DocUpdateIn, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        doc = fetch_one(conn, "SELECT * FROM business_document WHERE document_id=%s FOR UPDATE", (document_id,))
        if not doc:
            raise HTTPException(status_code=404, detail="单据不存在")
        meta = DOC_TYPE_META[doc["doc_type"]]
        if user["role"] != "ADMIN" and int(doc["created_by"]) != int(user["user_id"]):
            raise HTTPException(status_code=403, detail="仅创建人或管理员可编辑")
        if doc["status"] != "DRAFT":
            raise HTTPException(status_code=409, detail="仅草稿可编辑")
        if doc["version"] != payload.version:
            raise HTTPException(status_code=409, detail="单据已被其他人修改，请刷新后重试")
        if payload.party_id is not None:
            if meta["party"] == "supplier" and not fetch_one(conn, "SELECT supplier_id FROM supplier WHERE supplier_id=%s AND is_active", (payload.party_id,)):
                raise HTTPException(status_code=422, detail="供应商不存在或已停用")
            if meta["party"] == "customer" and not fetch_one(conn, "SELECT customer_id FROM customer WHERE customer_id=%s AND is_active", (payload.party_id,)):
                raise HTTPException(status_code=422, detail="客户不存在或已停用")
        line_rows: list[tuple[int, Any, dict[str, Any], int, Decimal, Decimal]] = []
        total = doc["total_amount"]
        if payload.lines is not None:
            total = Decimal(0)
            for i, line in enumerate(payload.lines, start=1):
                product = fetch_one(conn, "SELECT * FROM product WHERE product_id=%s", (line.product_id,))
                if not product:
                    raise HTTPException(status_code=404, detail=f"明细第 {i} 行货品不存在")
                uom_id = _line_uom_id(conn, line)
                price = _resolve_price(conn, doc["doc_type"], line, product)
                amount = (line.quantity * price).quantize(Decimal("0.01"))
                total += amount
                line_rows.append((i, line, product, uom_id, price, amount))
        values = payload.model_dump(exclude_unset=True, exclude={"lines", "version"})
        audit(conn, user, "EDIT", "business_document", target_id=document_id,
              before={"version": doc["version"]}, after={"version": doc["version"] + 1},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""UPDATE business_document SET party_id=%s,doc_date=%s,source_location_id=%s,destination_location_id=%s,
                                 deposit_amount=%s,total_amount=%s,notes=%s,version=version+1,updated_at=now()
                           WHERE document_id=%s""",
                        (values.get("party_id", doc["party_id"]), values.get("doc_date", doc["doc_date"]),
                         values.get("source_location_id", doc["source_location_id"]),
                         values.get("destination_location_id", doc["destination_location_id"]),
                         values.get("deposit_amount", doc["deposit_amount"]), total, values.get("notes", doc["notes"]), document_id))
            if payload.lines is not None:
                old_lines = fetch_all(conn, "SELECT * FROM business_document_line WHERE document_id=%s", (document_id,))
                for old in old_lines:
                    audit(conn, user, "DELETE", "business_document_line", target_id=old["document_line_id"], before=old, request_id=req_meta["request_id"])
                    cur.execute("DELETE FROM business_document_line WHERE document_line_id=%s", (old["document_line_id"],))
                for i, (line_no, line, _product, uom_id, price, amount) in enumerate(line_rows, start=1):
                    audit(conn, user, "CREATE", "business_document_line",
                          after={"document_id": document_id, "line_no": i, "product_id": line.product_id},
                          request_id=req_meta["request_id"])
                    cur.execute("""INSERT INTO business_document_line(document_id,line_no,product_id,uom_id,quantity,price,amount,condition_id,source_location_id,destination_location_id,counted_quantity,notes)
                                 VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                                (document_id, i, line.product_id, uom_id, line.quantity, price, amount,
                                 _condition_id(conn, line.condition_id), line.source_location_id, line.destination_location_id,
                                 line.counted_quantity, line.notes))
        return _doc_detail(conn, document_id, user)


@router.post("/{document_id}/submit")
def submit_document(document_id: int, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        doc = fetch_one(conn, "SELECT * FROM business_document WHERE document_id=%s FOR UPDATE", (document_id,))
        if not doc:
            raise HTTPException(status_code=404, detail="单据不存在")
        if doc["status"] != "DRAFT":
            raise HTTPException(status_code=409, detail="仅草稿可提交")
        if user["role"] not in DOC_TYPE_META[doc["doc_type"]]["create_roles"] and int(doc["created_by"]) != int(user["user_id"]):
            raise HTTPException(status_code=403, detail="无权提交此单据")
        if not fetch_one(conn, "SELECT 1 FROM business_document_line WHERE document_id=%s LIMIT 1", (document_id,)):
            raise HTTPException(status_code=422, detail="单据至少需要一条明细")
        audit(conn, user, "SUBMIT", "business_document", target_id=document_id,
              before={"status": "DRAFT"}, after={"status": "SUBMITTED"},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("UPDATE business_document SET status='SUBMITTED',submitted_at=now(),updated_at=now() WHERE document_id=%s", (document_id,))
        return _doc_detail(conn, document_id, user)


@router.post("/{document_id}/post")
def post_document(document_id: int, payload: DocSubmitIn, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        return _post_document(conn, document_id, user, req_meta, payload.override_review)


@router.post("/{document_id}/reverse")
def reverse_document(document_id: int, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        return _reverse_document(conn, document_id, user, req_meta)


@router.post("/{document_id}/attachments")
def add_attachment(document_id: int, payload: AttachmentIn, request: Request, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    data = base64.b64decode(payload.data_base64)
    if len(data) != payload.size:
        raise HTTPException(status_code=422, detail="附件大小与内容不符")
    with connection() as conn:
        if not fetch_one(conn, "SELECT document_id FROM business_document WHERE document_id=%s", (document_id,)):
            raise HTTPException(status_code=404, detail="单据不存在")
        audit(conn, user, "UPLOAD", "document_attachment",
              after={"document_id": document_id, "filename": payload.filename, "size": payload.size},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO document_attachment(document_id,filename,content_type,size,data,uploaded_by)
                         VALUES (%s,%s,%s,%s,%s,%s) RETURNING attachment_id,filename,content_type,size,created_at,uploaded_by""",
                        (document_id, payload.filename, payload.content_type, payload.size, Binary(data), user["user_id"]))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@attachments_router.get("/{attachment_id}")
def download_attachment(attachment_id: int, user: dict[str, Any] = Depends(require_user)) -> Response:
    with connection() as conn:
        row = fetch_one(conn, "SELECT * FROM document_attachment WHERE attachment_id=%s", (attachment_id,))
    if not row:
        raise HTTPException(status_code=404, detail="附件不存在")
    headers = {"Content-Disposition": f'attachment; filename="{row["filename"]}"'}
    return Response(content=bytes(row["data"]), media_type=row["content_type"], headers=headers)
