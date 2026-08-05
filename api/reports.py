"""Report routers (FINANCE/ADMIN): 采购对账、应收应付汇总/明细、库存成本."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from .db import connection, fetch_all
from .permissions import require_roles

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("/purchase-reconciliation")
def purchase_reconciliation(supplier_id: int | None = None, start_date: str = "", end_date: str = "",
                            user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> dict[str, Any]:
    sql = """SELECT s.supplier_id, s.name AS supplier_name, d.doc_no, d.doc_date, d.total_amount, d.posted_by
               FROM business_document d
               JOIN supplier s ON s.supplier_id = d.party_id
              WHERE d.doc_type='PURCHASE_RECEIPT' AND d.status='POSTED'"""
    params: list[Any] = []
    if supplier_id:
        sql += " AND d.party_id=%s"
        params.append(supplier_id)
    if start_date:
        sql += " AND d.doc_date>=%s"
        params.append(start_date)
    if end_date:
        sql += " AND d.doc_date<=%s"
        params.append(end_date)
    sql += " ORDER BY d.doc_date DESC, d.document_id DESC"
    with connection() as conn:
        rows = fetch_all(conn, sql, tuple(params))
    return {"rows": rows}


@router.get("/ar-ap-summary")
def ar_ap_summary(user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> dict[str, Any]:
    with connection() as conn:
        return {
            "customers": fetch_all(conn, "SELECT customer_id,name,receivable_balance FROM v_customer_balance ORDER BY name"),
            "suppliers": fetch_all(conn, "SELECT supplier_id,name,payable_balance FROM v_supplier_balance ORDER BY name"),
        }


@router.get("/receivables")
def receivables(party_id: int | None = None, user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, """SELECT e.ar_ap_entry_id,e.party_id,c.name AS party_name,e.entry_type,e.direction,e.amount,e.created_at,
                                         d.doc_no,d.doc_date
                                    FROM ar_ap_entry e
                                    JOIN business_document d ON d.document_id=e.document_id
                                    LEFT JOIN customer c ON e.party_type='CUSTOMER' AND c.customer_id=e.party_id
                                   WHERE e.party_type='CUSTOMER' AND (%s IS NULL OR e.party_id=%s)
                                   ORDER BY e.created_at DESC""", (party_id, party_id))


@router.get("/payables")
def payables(party_id: int | None = None, user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, """SELECT e.ar_ap_entry_id,e.party_id,s.name AS party_name,e.entry_type,e.direction,e.amount,e.created_at,
                                         d.doc_no,d.doc_date
                                    FROM ar_ap_entry e
                                    JOIN business_document d ON d.document_id=e.document_id
                                    LEFT JOIN supplier s ON e.party_type='SUPPLIER' AND s.supplier_id=e.party_id
                                   WHERE e.party_type='SUPPLIER' AND (%s IS NULL OR e.party_id=%s)
                                   ORDER BY e.created_at DESC""", (party_id, party_id))


@router.get("/inventory-cost")
def inventory_cost(user: dict[str, Any] = Depends(require_roles("FINANCE", "ADMIN"))) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, """SELECT b.product_id,b.product_name,b.uom_id,b.uom_code,
                                         SUM(b.on_hand_quantity)::NUMERIC(18,3) AS on_hand_quantity,
                                         COALESCE(p.purchase_cost_price,0) AS cost_price,
                                         (SUM(b.on_hand_quantity) * COALESCE(p.purchase_cost_price,0))::NUMERIC(18,2) AS cost_value
                                    FROM v_inventory_balance b
                                    JOIN product p ON p.product_id=b.product_id
                                   GROUP BY b.product_id,b.product_name,b.uom_id,b.uom_code,p.purchase_cost_price
                                   ORDER BY b.product_name""")
