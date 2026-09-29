"""Master-data routers: product categories, customers, suppliers, price tiers, departments."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .db import audit, connection, fetch_all, fetch_one
from .export import export_response, export_rows_by_ids
from .helpers import _request_meta
from .permissions import _csrf, require_roles, require_user
from .schemas import CategoryIn, CustomerIn, DepartmentIn, PriceTierIn, SupplierIn

router = APIRouter(prefix="/api", tags=["master"])


@router.get("/categories")
def categories(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, """WITH RECURSIVE tree AS (
                SELECT category_id, parent_category_id, name, sort_order, is_active, 0 AS depth
                  FROM product_category WHERE parent_category_id IS NULL
                UNION ALL
                SELECT c.category_id, c.parent_category_id, c.name, c.sort_order, c.is_active, t.depth+1
                  FROM product_category c JOIN tree t ON c.parent_category_id=t.category_id
            ) SELECT category_id, parent_category_id, name, sort_order, is_active, depth
              FROM tree ORDER BY depth, sort_order, name""")


@router.post("/categories")
def create_category(payload: CategoryIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        if payload.parent_category_id and not fetch_one(conn, "SELECT category_id FROM product_category WHERE category_id=%s", (payload.parent_category_id,)):
            raise HTTPException(status_code=422, detail="父分类不存在")
        audit(conn, user, "CREATE", "product_category",
              after={"name": payload.name, "parent_category_id": payload.parent_category_id},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO product_category(parent_category_id,name,sort_order,is_active)
                         VALUES (%s,%s,%s,%s) RETURNING category_id,parent_category_id,name,sort_order,is_active""",
                        (payload.parent_category_id, payload.name.strip(), payload.sort_order, payload.is_active))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@router.put("/categories/{category_id}")
def update_category(category_id: int, payload: CategoryIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM product_category WHERE category_id=%s FOR UPDATE", (category_id,))
        if not before:
            raise HTTPException(status_code=404, detail="分类不存在")
        if payload.parent_category_id and payload.parent_category_id == category_id:
            raise HTTPException(status_code=422, detail="父分类不能是自己")
        if payload.parent_category_id:
            # 沿祖先链上溯，防止把祖先挂到子孙形成环（环上节点会从树中「消失」）
            ancestor = payload.parent_category_id
            for _ in range(100):
                if ancestor == category_id:
                    raise HTTPException(status_code=422, detail="父分类不能是自己的子孙分类")
                row = fetch_one(conn, "SELECT parent_category_id FROM product_category WHERE category_id=%s", (ancestor,))
                ancestor = row["parent_category_id"] if row else None
                if ancestor is None:
                    break
        audit(conn, user, "EDIT", "product_category", target_id=category_id, before=before,
              after={"name": payload.name, "parent_category_id": payload.parent_category_id, "sort_order": payload.sort_order, "is_active": payload.is_active},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""UPDATE product_category SET parent_category_id=%s,name=%s,sort_order=%s,is_active=%s WHERE category_id=%s""",
                        (payload.parent_category_id, payload.name.strip(), payload.sort_order, payload.is_active, category_id))
    return {"category_id": category_id, "name": payload.name, "parent_category_id": payload.parent_category_id, "sort_order": payload.sort_order, "is_active": payload.is_active}


_CUSTOMER_COLUMNS = [
    ("客户ID", lambda r: r["customer_id"]),
    ("名称", lambda r: r["name"]),
    ("联系人", lambda r: r["contact_person"] or ""),
    ("电话", lambda r: r["phone"] or ""),
    ("结算方式", lambda r: r["settlement_method"] or ""),
    ("等级", lambda r: r["level"] or ""),
    ("信用上限", lambda r: r["credit_limit"]),
    ("应收余额", lambda r: r["receivable_balance"]),
    ("启用", lambda r: "是" if r["is_active"] else "否"),
]


@router.get("/customers")
def customers(user: dict[str, Any] = Depends(require_roles("SALES", "FINANCE", "ADMIN"))) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, """SELECT c.customer_id,c.name,c.contact_person,c.phone,c.address,c.settlement_method,c.level,c.credit_limit,c.is_active,
                                         COALESCE(v.receivable_balance,0) AS receivable_balance
                                    FROM customer c
                                    LEFT JOIN v_customer_balance v ON v.customer_id=c.customer_id
                                   ORDER BY c.name""")


@router.get("/customers/export")
def customers_export(ids: str = "", fmt: str = "xlsx", user: dict[str, Any] = Depends(require_roles("SALES", "FINANCE", "ADMIN"))) -> Response:
    with connection() as conn:
        return export_rows_by_ids(conn, ids, "c.customer_id",
            """SELECT c.customer_id,c.name,c.contact_person,c.phone,c.address,c.settlement_method,c.level,c.credit_limit,c.is_active,
                      COALESCE(v.receivable_balance,0) AS receivable_balance
                 FROM customer c LEFT JOIN v_customer_balance v ON v.customer_id=c.customer_id
                WHERE {where} ORDER BY {order_by}""",
            "c.name", _CUSTOMER_COLUMNS, "客户", fmt)


@router.get("/customers/{customer_id}")
def customer_detail(customer_id: int, user: dict[str, Any] = Depends(require_roles("SALES", "FINANCE", "ADMIN"))) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, """SELECT c.*, COALESCE(v.receivable_balance,0) AS receivable_balance
                                   FROM customer c LEFT JOIN v_customer_balance v ON v.customer_id=c.customer_id
                                  WHERE c.customer_id=%s""", (customer_id,))
        if not row:
            raise HTTPException(status_code=404, detail="客户不存在")
        row["history"] = fetch_all(conn, """SELECT e.ar_ap_entry_id,e.entry_type,e.direction,e.amount,e.created_at,
                                                   d.doc_no,d.doc_type,d.doc_date
                                              FROM ar_ap_entry e JOIN business_document d ON d.document_id=e.document_id
                                             WHERE e.party_type='CUSTOMER' AND e.party_id=%s
                                             ORDER BY e.created_at DESC LIMIT 50""", (customer_id,))
        return row


@router.post("/customers")
def create_customer(payload: CustomerIn, request: Request, user: dict[str, Any] = Depends(require_roles("SALES", "ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        audit(conn, user, "CREATE", "customer", after={"name": payload.name, "settlement_method": payload.settlement_method},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO customer(name,contact_person,phone,address,settlement_method,level,credit_limit,notes,is_active)
                         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING customer_id,name,contact_person,phone,address,settlement_method,level,credit_limit,notes,is_active,created_at""",
                        (payload.name.strip(), payload.contact_person, payload.phone, payload.address, payload.settlement_method,
                         payload.level, payload.credit_limit, payload.notes, payload.is_active))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@router.put("/customers/{customer_id}")
def update_customer(customer_id: int, payload: CustomerIn, request: Request, user: dict[str, Any] = Depends(require_roles("SALES", "ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM customer WHERE customer_id=%s FOR UPDATE", (customer_id,))
        if not before:
            raise HTTPException(status_code=404, detail="客户不存在")
        audit(conn, user, "EDIT", "customer", target_id=customer_id, before=before,
              after={"name": payload.name, "contact_person": payload.contact_person, "phone": payload.phone,
                     "address": payload.address, "settlement_method": payload.settlement_method, "level": payload.level,
                     "credit_limit": str(payload.credit_limit), "notes": payload.notes, "is_active": payload.is_active},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""UPDATE customer SET name=%s,contact_person=%s,phone=%s,address=%s,settlement_method=%s,level=%s,credit_limit=%s,notes=%s,is_active=%s,updated_at=now()
                         WHERE customer_id=%s""",
                        (payload.name.strip(), payload.contact_person, payload.phone, payload.address, payload.settlement_method,
                         payload.level, payload.credit_limit, payload.notes, payload.is_active, customer_id))
    return customer_detail(customer_id, user)


_SUPPLIER_COLUMNS = [
    ("供应商ID", lambda r: r["supplier_id"]),
    ("名称", lambda r: r["name"]),
    ("联系人", lambda r: r["contact_person"] or ""),
    ("电话", lambda r: r["phone"] or ""),
    ("账期(天)", lambda r: r["settlement_days"] if r["settlement_days"] is not None else ""),
    ("应付余额", lambda r: r["payable_balance"]),
    ("启用", lambda r: "是" if r["is_active"] else "否"),
]


@router.get("/suppliers")
def suppliers(user: dict[str, Any] = Depends(require_roles("WAREHOUSE", "FINANCE", "ADMIN"))) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, """SELECT s.supplier_id,s.name,s.contact_person,s.phone,s.address,s.settlement_days,s.is_active,
                                         COALESCE(v.payable_balance,0) AS payable_balance
                                    FROM supplier s LEFT JOIN v_supplier_balance v ON v.supplier_id=s.supplier_id
                                   ORDER BY s.name""")


@router.get("/suppliers/export")
def suppliers_export(ids: str = "", fmt: str = "xlsx", user: dict[str, Any] = Depends(require_roles("WAREHOUSE", "FINANCE", "ADMIN"))) -> Response:
    with connection() as conn:
        return export_rows_by_ids(conn, ids, "s.supplier_id",
            """SELECT s.supplier_id,s.name,s.contact_person,s.phone,s.address,s.settlement_days,s.is_active,
                      COALESCE(v.payable_balance,0) AS payable_balance
                 FROM supplier s LEFT JOIN v_supplier_balance v ON v.supplier_id=s.supplier_id
                WHERE {where} ORDER BY {order_by}""",
            "s.name", _SUPPLIER_COLUMNS, "供应商", fmt)


@router.get("/suppliers/{supplier_id}")
def supplier_detail(supplier_id: int, user: dict[str, Any] = Depends(require_roles("WAREHOUSE", "FINANCE", "ADMIN"))) -> dict[str, Any]:
    with connection() as conn:
        row = fetch_one(conn, """SELECT s.*, COALESCE(v.payable_balance,0) AS payable_balance
                                   FROM supplier s LEFT JOIN v_supplier_balance v ON v.supplier_id=s.supplier_id
                                  WHERE s.supplier_id=%s""", (supplier_id,))
        if not row:
            raise HTTPException(status_code=404, detail="供应商不存在")
        row["history"] = fetch_all(conn, """SELECT e.ar_ap_entry_id,e.entry_type,e.direction,e.amount,e.created_at,
                                                   d.doc_no,d.doc_type,d.doc_date
                                              FROM ar_ap_entry e JOIN business_document d ON d.document_id=e.document_id
                                             WHERE e.party_type='SUPPLIER' AND e.party_id=%s
                                             ORDER BY e.created_at DESC LIMIT 50""", (supplier_id,))
        avg = fetch_one(conn, """SELECT CASE WHEN SUM(l.quantity) > 0 THEN ROUND(SUM(l.amount) / SUM(l.quantity), 2) ELSE 0 END AS avg_price
                                   FROM business_document d JOIN business_document_line l ON l.document_id=d.document_id
                                  WHERE d.doc_type='PURCHASE_RECEIPT' AND d.status='POSTED' AND d.party_type='SUPPLIER' AND d.party_id=%s""", (supplier_id,))
        row["avg_price"] = avg["avg_price"] if avg else 0
        row["supplied_products"] = fetch_all(conn, """SELECT DISTINCT p.product_id,p.display_name,p.specification
                                                        FROM business_document d JOIN business_document_line l ON l.document_id=d.document_id
                                                        JOIN product p ON p.product_id=l.product_id
                                                       WHERE d.doc_type='PURCHASE_RECEIPT' AND d.status='POSTED' AND d.party_type='SUPPLIER' AND d.party_id=%s
                                                       ORDER BY p.display_name""", (supplier_id,))
        return row


@router.post("/suppliers")
def create_supplier(payload: SupplierIn, request: Request, user: dict[str, Any] = Depends(require_roles("WAREHOUSE", "ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        audit(conn, user, "CREATE", "supplier", after={"name": payload.name},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO supplier(name,contact_person,phone,address,settlement_days,notes,is_active)
                         VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING supplier_id,name,contact_person,phone,address,settlement_days,notes,is_active,created_at""",
                        (payload.name.strip(), payload.contact_person, payload.phone, payload.address, payload.settlement_days, payload.notes, payload.is_active))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@router.put("/suppliers/{supplier_id}")
def update_supplier(supplier_id: int, payload: SupplierIn, request: Request, user: dict[str, Any] = Depends(require_roles("WAREHOUSE", "ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM supplier WHERE supplier_id=%s FOR UPDATE", (supplier_id,))
        if not before:
            raise HTTPException(status_code=404, detail="供应商不存在")
        audit(conn, user, "EDIT", "supplier", target_id=supplier_id, before=before,
              after={"name": payload.name, "contact_person": payload.contact_person, "phone": payload.phone,
                     "address": payload.address, "settlement_days": payload.settlement_days,
                     "notes": payload.notes, "is_active": payload.is_active},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""UPDATE supplier SET name=%s,contact_person=%s,phone=%s,address=%s,settlement_days=%s,notes=%s,is_active=%s,updated_at=now()
                         WHERE supplier_id=%s""",
                        (payload.name.strip(), payload.contact_person, payload.phone, payload.address, payload.settlement_days, payload.notes, payload.is_active, supplier_id))
    return supplier_detail(supplier_id, user)


@router.get("/products/{product_id}/price-tiers")
def price_tiers(product_id: int, user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT price_tier_id,tier_name,min_quantity,price FROM product_price_tier WHERE product_id=%s ORDER BY min_quantity, price_tier_id", (product_id,))


@router.post("/products/{product_id}/price-tiers")
def create_price_tier(product_id: int, payload: PriceTierIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        if not fetch_one(conn, "SELECT product_id FROM product WHERE product_id=%s", (product_id,)):
            raise HTTPException(status_code=404, detail="货品不存在")
        if fetch_one(conn, "SELECT price_tier_id FROM product_price_tier WHERE product_id=%s AND tier_name=%s", (product_id, payload.tier_name)):
            raise HTTPException(status_code=409, detail="批发档名称已存在")
        if fetch_one(conn, "SELECT price_tier_id FROM product_price_tier WHERE product_id=%s AND min_quantity=%s AND price_tier_id<>%s", (product_id, payload.min_quantity, -1)):
            raise HTTPException(status_code=409, detail="同一起订数量已存在批发档")
        audit(conn, user, "CREATE", "product_price_tier", after={"product_id": product_id, "tier_name": payload.tier_name, "price": str(payload.price)},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO product_price_tier(product_id,tier_name,min_quantity,price)
                         VALUES (%s,%s,%s,%s) RETURNING price_tier_id,tier_name,min_quantity,price""",
                        (product_id, payload.tier_name, payload.min_quantity, payload.price))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))


@router.put("/products/{product_id}/price-tiers/{price_tier_id}")
def update_price_tier(product_id: int, price_tier_id: int, payload: PriceTierIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM product_price_tier WHERE price_tier_id=%s AND product_id=%s FOR UPDATE", (price_tier_id, product_id))
        if not before:
            raise HTTPException(status_code=404, detail="批发档不存在")
        if fetch_one(conn, "SELECT price_tier_id FROM product_price_tier WHERE product_id=%s AND min_quantity=%s AND price_tier_id<>%s", (product_id, payload.min_quantity, price_tier_id)):
            raise HTTPException(status_code=409, detail="同一起订数量已存在批发档")
        audit(conn, user, "EDIT", "product_price_tier", target_id=price_tier_id, before=before,
              after={"tier_name": payload.tier_name, "min_quantity": str(payload.min_quantity), "price": str(payload.price)},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""UPDATE product_price_tier SET tier_name=%s,min_quantity=%s,price=%s WHERE price_tier_id=%s""",
                        (payload.tier_name, payload.min_quantity, payload.price, price_tier_id))
    return {"price_tier_id": price_tier_id, "tier_name": payload.tier_name, "min_quantity": payload.min_quantity, "price": payload.price}


@router.delete("/products/{product_id}/price-tiers/{price_tier_id}")
def delete_price_tier(product_id: int, price_tier_id: int, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        before = fetch_one(conn, "SELECT * FROM product_price_tier WHERE price_tier_id=%s AND product_id=%s", (price_tier_id, product_id))
        if not before:
            raise HTTPException(status_code=404, detail="批发档不存在")
        audit(conn, user, "DELETE", "product_price_tier", target_id=price_tier_id, before=before,
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("DELETE FROM product_price_tier WHERE price_tier_id=%s", (price_tier_id,))
    return {"status": "ok"}


@router.get("/departments")
def departments(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connection() as conn:
        return fetch_all(conn, "SELECT department_id,name,sort_order,is_active FROM department ORDER BY sort_order,name")


@router.post("/departments")
def create_department(payload: DepartmentIn, request: Request, user: dict[str, Any] = Depends(require_roles("ADMIN"))) -> dict[str, Any]:
    _csrf(request)
    req_meta = _request_meta(request)
    with connection() as conn:
        audit(conn, user, "CREATE", "department", after={"name": payload.name},
              request_id=req_meta["request_id"], ip_address=req_meta["ip_address"], user_agent=req_meta["user_agent"])
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO department(name,sort_order,is_active) VALUES (%s,%s,%s) RETURNING department_id,name,sort_order,is_active""",
                        (payload.name.strip(), payload.sort_order, payload.is_active))
            return dict(zip([d.name for d in cur.description], cur.fetchone()))
