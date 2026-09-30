"""财务报表：兼容原响应，按需分页，并在相同 GET 路径导出当前筛选。"""

from __future__ import annotations

from datetime import date as _date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from .db import connection, fetch_all
from .permissions import require_roles
from .read_lists import read_list

router = APIRouter(prefix="/api/reports", tags=["reports"])
_TEXT = ("contains", "eq", "in")
_NUMBER = ("eq", "ne", "gt", "gte", "lt", "lte", "in")
_DATE = ("eq", "gte", "lte")


@router.get("/purchase-reconciliation")
def purchase_reconciliation(supplier_id: int | None = None, start_date: _date | None = None, end_date: _date | None = None,
                            paginated: bool = False, page: int = 1, page_size: int = 30,
                            q: str = Query(default="", max_length=200), f: list[str] = Query(default=[]),
                            sort: str = "", order: str = "desc", fmt: str = "", ids: str = "",
                            user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> Any:
    # 有效采购净额：红冲原单与反向单排除，退货抵减；所有读列表路径共用有符号金额。
    sql = """SELECT s.supplier_id,s.name AS supplier_name,d.document_id,d.doc_type,d.doc_no,d.doc_date,
                    CASE WHEN d.doc_type='PURCHASE_RETURN' THEN -d.total_amount ELSE d.total_amount END AS total_amount,d.posted_by
               FROM business_document d JOIN supplier s ON s.supplier_id=d.party_id
              WHERE d.doc_type IN ('PURCHASE_RECEIPT','PURCHASE_RETURN') AND d.status='POSTED'
                AND d.reversal_of_document_id IS NULL"""
    params: list[Any] = []
    for condition, value in (("d.party_id=%s", supplier_id), ("d.doc_date>=%s", start_date), ("d.doc_date<=%s", end_date)):
        if value is not None:
            sql += " AND " + condition
            params.append(value)
    result = read_list(sql, params,
        fields={"supplier_name": _TEXT, "supplier_id": _NUMBER, "doc_no": _TEXT, "doc_date": _DATE,
                "total_amount": _NUMBER, "posted_by": _TEXT}, search_fields=("supplier_name", "doc_no"),
        default_sort="doc_date", key_fields=("document_id",),
        columns=[("供应商", lambda r: r["supplier_name"]), ("单号", lambda r: r["doc_no"]),
                 ("日期", lambda r: r["doc_date"]), ("金额", lambda r: r["total_amount"]), ("过账人", lambda r: r["posted_by"])],
        filename="采购对账", summary={"total_amount": "COALESCE(SUM(r.total_amount),0)"},
        numeric_fields=("supplier_id", "total_amount"), date_fields=("doc_date",),
        q=q, f=f, sort=sort, order=order, page=page, page_size=page_size, paginated=paginated, fmt=fmt, ids=ids, legacy_limit=20000)
    return result if paginated or fmt else {"rows": result}


@router.get("/ar-ap-summary")
def ar_ap_summary(party_type: str = "customer", paginated: bool = False, page: int = 1, page_size: int = 30,
                  q: str = Query(default="", max_length=200), f: list[str] = Query(default=[]),
                  sort: str = "", order: str = "asc", fmt: str = "", ids: str = "",
                  user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> Any:
    if party_type not in ("customer", "supplier"):
        raise HTTPException(status_code=422, detail="往来方类型应为 customer 或 supplier")
    if not paginated and not fmt:
        with connection() as conn:
            return {"customers": fetch_all(conn, "SELECT customer_id,name,receivable_balance FROM v_customer_balance ORDER BY name"),
                    "suppliers": fetch_all(conn, "SELECT supplier_id,name,payable_balance FROM v_supplier_balance ORDER BY name")}
    customer = party_type == "customer"
    key = "customer_id" if customer else "supplier_id"
    balance = "receivable_balance" if customer else "payable_balance"
    view = "v_customer_balance" if customer else "v_supplier_balance"
    label = "应收余额" if customer else "应付余额"
    return read_list(f"SELECT {key},name,{balance} FROM {view}", [],
        fields={key: _NUMBER, "name": _TEXT, balance: _NUMBER}, search_fields=("name",),
        default_sort="name", key_fields=(key,), columns=[("客户" if customer else "供应商", lambda r: r["name"]), (label, lambda r: r[balance])],
        filename="应收汇总" if customer else "应付汇总", summary={balance: f"COALESCE(SUM(r.{balance}),0)"},
        numeric_fields=(key, balance), q=q, f=f, sort=sort, order=order, page=page, page_size=page_size, paginated=paginated, fmt=fmt, ids=ids)


def _ledger(party_type: str, party_id: int | None, start_date: _date | None, end_date: _date | None, **options) -> Any:
    customer = party_type == "CUSTOMER"
    table, key = ("customer", "customer_id") if customer else ("supplier", "supplier_id")
    sql = f"""SELECT e.ar_ap_entry_id,e.party_id,p.name AS party_name,e.entry_type,e.direction,e.amount,e.created_at,
                      d.document_id,d.doc_type,d.doc_no,d.doc_date
                 FROM ar_ap_entry e JOIN business_document d ON d.document_id=e.document_id
                 LEFT JOIN {table} p ON p.{key}=e.party_id
                WHERE e.party_type=%s"""
    params: list[Any] = [party_type]
    for condition, value in (("e.party_id=%s", party_id), ("d.doc_date>=%s", start_date), ("d.doc_date<=%s", end_date)):
        if value is not None:
            sql += " AND " + condition
            params.append(value)
    return read_list(sql, params,
        fields={"party_id": _NUMBER, "party_name": _TEXT, "doc_no": _TEXT, "doc_type": _TEXT,
                "doc_date": _DATE, "entry_type": _TEXT, "direction": _TEXT, "amount": _NUMBER, "created_at": _DATE},
        search_fields=("party_name", "doc_no"), default_sort="created_at", key_fields=("ar_ap_entry_id",),
        columns=[("客户" if customer else "供应商", lambda r: r["party_name"]), ("单号", lambda r: r["doc_no"]),
                 ("日期", lambda r: r["doc_date"]), ("方向", lambda r: "增加" if r["direction"] == "UP" else "减少"),
                 ("金额", lambda r: r["amount"]), ("发生时间", lambda r: r["created_at"])],
        filename="应收明细" if customer else "应付明细",
        summary={"amount": "COALESCE(SUM(r.amount),0)", "amount_up": "COALESCE(SUM(r.amount) FILTER (WHERE r.direction='UP'),0)",
                 "amount_down": "COALESCE(SUM(r.amount) FILTER (WHERE r.direction='DOWN'),0)",
                 "balance": "COALESCE(SUM(CASE WHEN r.direction='UP' THEN r.amount ELSE -r.amount END),0)"},
        numeric_fields=("party_id", "amount"), date_fields=("doc_date", "created_at"), legacy_limit=20000, **options)


@router.get("/receivables")
def receivables(party_id: int | None = None, start_date: _date | None = None, end_date: _date | None = None,
                paginated: bool = False, page: int = 1, page_size: int = 30, q: str = Query(default="", max_length=200),
                f: list[str] = Query(default=[]), sort: str = "", order: str = "desc", fmt: str = "", ids: str = "",
                user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> Any:
    return _ledger("CUSTOMER", party_id, start_date, end_date, paginated=paginated, page=page, page_size=page_size,
                   q=q, f=f, sort=sort, order=order, fmt=fmt, ids=ids)


@router.get("/payables")
def payables(party_id: int | None = None, start_date: _date | None = None, end_date: _date | None = None,
             paginated: bool = False, page: int = 1, page_size: int = 30, q: str = Query(default="", max_length=200),
             f: list[str] = Query(default=[]), sort: str = "", order: str = "desc", fmt: str = "", ids: str = "",
             user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> Any:
    return _ledger("SUPPLIER", party_id, start_date, end_date, paginated=paginated, page=page, page_size=page_size,
                   q=q, f=f, sort=sort, order=order, fmt=fmt, ids=ids)


@router.get("/inventory-cost")
def inventory_cost(paginated: bool = False, page: int = 1, page_size: int = 30, q: str = Query(default="", max_length=200),
                   f: list[str] = Query(default=[]), sort: str = "", order: str = "asc", fmt: str = "", ids: str = "",
                   user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> Any:
    sql = """SELECT b.product_id,b.product_name,b.uom_id,b.uom_code,
                    SUM(b.on_hand_quantity)::NUMERIC(18,3) AS on_hand_quantity,COALESCE(p.purchase_cost_price,0) AS cost_price,
                    (SUM(b.on_hand_quantity)*COALESCE(p.purchase_cost_price,0))::NUMERIC(18,2) AS cost_value
               FROM v_inventory_balance b JOIN product p ON p.product_id=b.product_id
              GROUP BY b.product_id,b.product_name,b.uom_id,b.uom_code,p.purchase_cost_price"""
    return read_list(sql, [], fields={"product_id": _NUMBER, "product_name": _TEXT, "uom_code": _TEXT,
                                     "on_hand_quantity": _NUMBER, "cost_price": _NUMBER, "cost_value": _NUMBER},
        search_fields=("product_name",), default_sort="product_name", key_fields=("product_id", "uom_id"),
        columns=[("货品", lambda r: r["product_name"]), ("单位", lambda r: r["uom_code"]), ("数量", lambda r: r["on_hand_quantity"]),
                 ("成本单价", lambda r: r["cost_price"]), ("库存成本", lambda r: r["cost_value"])],
        filename="库存成本", summary={"cost_value": "COALESCE(SUM(r.cost_value),0)"},
        numeric_fields=("product_id", "on_hand_quantity", "cost_price", "cost_value"),
        q=q, f=f, sort=sort, order=order, page=page, page_size=page_size, paginated=paginated, fmt=fmt, ids=ids)
