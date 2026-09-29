"""RBAC roles, session/csrf helpers and the per-document-type permission map.

Split out of main.py so the documents/master/reports routers can share the auth
helpers without a circular import (main <-> documents)."""

from __future__ import annotations

import hmac
from typing import Any

from fastapi import Depends, HTTPException, Request

from .db import connection, fetch_one
from .security import token_hash

SESSION_COOKIE = "erp_session"
CSRF_COOKIE = "erp_csrf"

VALID_ROLES = ("ADMIN", "WAREHOUSE", "SALES", "FINANCE", "COLLEAGUE")

ROLE_LABELS = {
    "ADMIN": "管理员",
    "WAREHOUSE": "仓管",
    "SALES": "销售",
    "FINANCE": "财务",
    "COLLEAGUE": "同事",
}

# doc_type -> label/前缀/往来方/可见·开单·过账角色/库存效果/应收应付效果
DOC_TYPE_META: dict[str, dict[str, Any]] = {
    "PURCHASE_ORDER":   {"label": "采购订单", "prefix": "PO", "party": "supplier",
                         "view_roles": ("WAREHOUSE", "ADMIN", "FINANCE"), "create_roles": ("WAREHOUSE", "ADMIN"), "post_roles": ("WAREHOUSE", "ADMIN"),
                         "stock_effect": "NONE", "ap_effect": "NONE"},
    "PURCHASE_RECEIPT": {"label": "采购入库", "prefix": "CG", "party": "supplier",
                         "view_roles": ("WAREHOUSE", "ADMIN", "FINANCE"), "create_roles": ("WAREHOUSE", "ADMIN"), "post_roles": ("WAREHOUSE", "ADMIN"),
                         "stock_effect": "IN", "ap_effect": "PAYABLE_UP"},
    "PURCHASE_RETURN":  {"label": "采购退货", "prefix": "CT", "party": "supplier",
                         "view_roles": ("WAREHOUSE", "ADMIN", "FINANCE"), "create_roles": ("WAREHOUSE", "ADMIN"), "post_roles": ("WAREHOUSE", "ADMIN"),
                         "stock_effect": "OUT", "ap_effect": "PAYABLE_DOWN"},
    "SALES_ORDER":      {"label": "销售订单", "prefix": "SO", "party": "customer",
                         "view_roles": ("SALES", "ADMIN", "WAREHOUSE"), "create_roles": ("SALES", "ADMIN"), "post_roles": ("SALES", "ADMIN"),
                         "stock_effect": "NONE", "ap_effect": "DEPOSIT"},
    "SALES_DELIVERY":   {"label": "销售出库", "prefix": "XS", "party": "customer",
                         "view_roles": ("SALES", "ADMIN", "WAREHOUSE"), "create_roles": ("SALES", "ADMIN"), "post_roles": ("SALES", "ADMIN", "WAREHOUSE"),
                         "stock_effect": "OUT", "ap_effect": "RECEIVABLE_UP"},
    "SALES_RETURN":     {"label": "销售退货", "prefix": "XT", "party": "customer",
                         "view_roles": ("SALES", "ADMIN", "WAREHOUSE"), "create_roles": ("SALES", "ADMIN"), "post_roles": ("SALES", "ADMIN", "WAREHOUSE"),
                         "stock_effect": "IN", "ap_effect": "RECEIVABLE_DOWN"},
    "STOCK_TRANSFER":   {"label": "库存调拨", "prefix": "DB", "party": None,
                         "view_roles": ("WAREHOUSE", "ADMIN"), "create_roles": ("WAREHOUSE", "ADMIN"), "post_roles": ("WAREHOUSE", "ADMIN"),
                         "stock_effect": "TRANSFER", "ap_effect": "NONE"},
    "STOCK_COUNT":      {"label": "库存盘点", "prefix": "PD", "party": None,
                         "view_roles": ("WAREHOUSE", "ADMIN"), "create_roles": ("WAREHOUSE", "ADMIN"), "post_roles": ("WAREHOUSE", "ADMIN"),
                         "stock_effect": "COUNT", "ap_effect": "NONE"},
    "STOCK_LOSS":       {"label": "报损", "prefix": "BS", "party": None,
                         "view_roles": ("WAREHOUSE", "ADMIN"), "create_roles": ("WAREHOUSE", "ADMIN"), "post_roles": ("WAREHOUSE", "ADMIN"),
                         "stock_effect": "OUT", "ap_effect": "NONE"},
    "OTHER_IN":         {"label": "其他入库", "prefix": "RK", "party": None,
                         "view_roles": ("WAREHOUSE", "ADMIN"), "create_roles": ("WAREHOUSE", "ADMIN"), "post_roles": ("WAREHOUSE", "ADMIN"),
                         "stock_effect": "IN", "ap_effect": "NONE"},
    "OTHER_OUT":        {"label": "其他出库", "prefix": "CK", "party": None,
                         "view_roles": ("WAREHOUSE", "ADMIN"), "create_roles": ("WAREHOUSE", "ADMIN"), "post_roles": ("WAREHOUSE", "ADMIN"),
                         "stock_effect": "OUT", "ap_effect": "NONE"},
}

GROUP_META: dict[str, dict[str, Any]] = {
    "purchase":  {"label": "采购", "types": ("PURCHASE_ORDER", "PURCHASE_RECEIPT", "PURCHASE_RETURN"),
                  "view_roles": ("WAREHOUSE", "ADMIN", "FINANCE")},
    "sales":     {"label": "销售", "types": ("SALES_ORDER", "SALES_DELIVERY", "SALES_RETURN"),
                  "view_roles": ("SALES", "ADMIN", "WAREHOUSE")},
    "inventory": {"label": "库存单据", "types": ("STOCK_TRANSFER", "STOCK_COUNT", "STOCK_LOSS", "OTHER_IN", "OTHER_OUT"),
                  "view_roles": ("WAREHOUSE", "ADMIN")},
}


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


def require_roles(*roles: str):
    def dependency(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
        if user["role"] not in roles:
            raise HTTPException(status_code=403, detail="无权执行此操作")
        return user
    return dependency


def _csrf(request: Request) -> None:
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    expected = request.cookies.get(CSRF_COOKIE)
    provided = request.headers.get("X-CSRF-Token")
    if not expected or not provided or not hmac.compare_digest(expected, provided):
        raise HTTPException(status_code=403, detail="CSRF token 无效")
    session = request.cookies.get(SESSION_COOKIE)
    if not session:
        raise HTTPException(status_code=403, detail="会话不存在")
    with connection() as conn:
        row = fetch_one(conn, "SELECT csrf_token_hash FROM app_session WHERE token_hash=%s AND revoked_at IS NULL AND expires_at>now()", (token_hash(session),))
    if not row or row["csrf_token_hash"] != token_hash(expected):
        raise HTTPException(status_code=403, detail="CSRF token 已失效")


def _can_post(user: dict[str, Any], doc: dict[str, Any], override_review: bool) -> None:
    """Creator may post with override_review; post_roles may post; ADMIN always."""
    if user["role"] == "ADMIN":
        return
    if int(doc["created_by"]) == int(user["user_id"]) and override_review:
        return
    if user["role"] in DOC_TYPE_META[doc["doc_type"]]["post_roles"]:
        return
    raise HTTPException(status_code=403, detail="无权过账此单据")
