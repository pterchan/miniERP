"""工作台与全局搜索：按既有查看、审批及所有权权限提供只读聚合。"""
from __future__ import annotations

import logging
from time import perf_counter
from typing import Any

from fastapi import APIRouter, Depends, Query

from .db import connection, fetch_all, fetch_one
from .list_params import like_escape
from .permissions import DOC_TYPE_META, GROUP_META, require_user
from .search import normalize_search

router = APIRouter(prefix="/api", tags=["workspace"])
_log = logging.getLogger(__name__)
_DOC_GROUP = {kind: group for group, meta in GROUP_META.items() for kind in meta["types"]}


@router.get("/workbench/summary")
def workbench_summary(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    role, user_id = user["role"], user["user_id"]
    reviewer = role in {"ADMIN", "WAREHOUSE"}
    visible = [kind for kind, meta in DOC_TYPE_META.items() if role in meta["view_roles"]]
    postable = [kind for kind, meta in DOC_TYPE_META.items() if role in meta["post_roles"]]
    # 同一 SQL 快照内汇总全部指标，避免卡片之间出现统计时差。
    with connection() as conn:
        result = fetch_one(conn, """WITH document_counts AS (
                       SELECT doc_type,status,created_by,count(*) AS n FROM business_document
                        WHERE doc_type=ANY(%s) AND (status='SUBMITTED' OR (status='DRAFT' AND created_by=%s))
                        GROUP BY doc_type,status,created_by)
                   SELECT
                       COALESCE((SELECT jsonb_agg(x) FROM
                           (SELECT doc_type,SUM(n)::int AS count FROM document_counts
                             WHERE status='SUBMITTED' AND doc_type=ANY(%s) GROUP BY doc_type ORDER BY doc_type) x),'[]'::jsonb) AS pending_documents,
                       COALESCE((SELECT jsonb_agg(x) FROM
                           (SELECT doc_type,SUM(n)::int AS count FROM document_counts WHERE status='DRAFT' GROUP BY doc_type) x),'[]'::jsonb) AS draft_types,
                       (SELECT count(*) FROM stock_request WHERE status='SUBMITTED' AND (%s OR requester_user_id=%s)) AS pending_requests,
                       (SELECT count(*) FROM stock_request WHERE status='APPROVED' AND %s) AS approved_requests,
                       (SELECT count(*) FROM stock_request WHERE status='DRAFT' AND requester_user_id=%s) AS my_draft_requests,
                       (SELECT count(*) FROM resolution_case rc JOIN record_status rs ON rs.status_id=rc.status_id WHERE rs.code='pending_review' AND %s) AS pending_conflicts,
                       (SELECT count(DISTINCT product_id) FROM v_inventory_balance WHERE on_hand_quantity<=0) AS zero_stock_products,
                       (SELECT count(*) FROM v_customer_balance b JOIN customer c USING(customer_id)
                         WHERE c.credit_limit>0 AND b.receivable_balance>c.credit_limit AND %s) AS over_credit_customers""",
                           (visible, user_id, postable, reviewer, user_id, reviewer, user_id, role == "ADMIN", role in {"ADMIN", "FINANCE"}))
    for item in result["pending_documents"]:
        item.update(group=_DOC_GROUP[item["doc_type"]], label=DOC_TYPE_META[item["doc_type"]]["label"])
    groups: dict[str, int] = {}
    for item in result.pop("draft_types"):
        group = _DOC_GROUP[item["doc_type"]]
        groups[group] = groups.get(group, 0) + item["count"]
    result["my_draft_documents"] = sum(groups.values())
    result["my_draft_documents_by_group"] = [{"group": group, "count": groups[group]} for group in GROUP_META if group in groups]
    if role != "ADMIN":
        result.pop("pending_conflicts")
    if role not in {"ADMIN", "FINANCE"}:
        result.pop("over_credit_customers")
    return result


def _normalized(column: str) -> str:
    # column 仅由本模块固定 SQL 片段提供。
    return f"lower(regexp_replace(pg_catalog.normalize(coalesce({column},''),'NFKC'), '[[:space:]]', '', 'g'))"


@router.get("/search")
def global_search(q: str = Query(default="", max_length=200), limit: int = 5,
                  user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    started = perf_counter()
    q, limit = normalize_search(q), min(10, max(1, limit))
    if not q:
        return {"q": q, "groups": []}
    # 惰性导入避免主应用注册路由时的循环依赖，并复用已验证的货品模糊回退。
    from .main import products
    product_rows = products(q=q, page=1, page_size=limit, sort="display_name", order="asc", f=[], user=user)["items"][:limit]
    groups = [{"kind": "product", "label": "货品", "items": [
        {"id": row["product_id"], "title": row["display_name"],
         "subtitle": " · ".join(str(row.get(key) or "") for key in ("identifier", "manufacturer", "specification") if row.get(key)),
         "href": f"/products/{row['product_id']}"} for row in product_rows]}]
    needle, prefix = "%" + like_escape(q) + "%", like_escape(q) + "%"
    role = user["role"]
    visible = [kind for kind, meta in DOC_TYPE_META.items() if role in meta["view_roles"]]
    with connection() as conn:
        if visible:
            doc_no = _normalized("d.doc_no")
            rows = fetch_all(conn, f"""SELECT d.document_id,d.doc_no,d.doc_type,d.status,d.total_amount,
                                              COALESCE(c.name,s.name,'') AS party_name
                                         FROM business_document d
                                         LEFT JOIN customer c ON d.party_type='CUSTOMER' AND c.customer_id=d.party_id
                                         LEFT JOIN supplier s ON d.party_type='SUPPLIER' AND s.supplier_id=d.party_id
                                        WHERE d.doc_type=ANY(%s) AND {doc_no} LIKE %s
                                        ORDER BY ({doc_no} LIKE %s) DESC,d.doc_no,d.document_id LIMIT %s""", (visible, needle, prefix, limit))
            groups.append({"kind": "document", "label": "单据", "items": [
                {"id": row["document_id"], "title": row["doc_no"], "status": row["status"],
                 "subtitle": f"{row['party_name']} · ¥{row['total_amount']:,.2f}",
                 "href": f"/{_DOC_GROUP[row['doc_type']]}/{row['doc_type'].lower()}/{row['document_id']}"} for row in rows]})
        request_no = _normalized("request_no")
        rows = fetch_all(conn, f"""SELECT stock_request_id,request_no,request_type,status,reason FROM stock_request
                                   WHERE {request_no} LIKE %s AND (%s OR requester_user_id=%s)
                                   ORDER BY ({request_no} LIKE %s) DESC,request_no,stock_request_id LIMIT %s""",
                         (needle, role in {"ADMIN", "WAREHOUSE"}, user["user_id"], prefix, limit))
        groups.append({"kind": "request", "label": "申请", "items": [
            {"id": row["stock_request_id"], "title": row["request_no"], "status": row["status"], "subtitle": row["reason"] or "库存申请",
             "href": f"/requests/{row['stock_request_id']}"} for row in rows]})
        for table, label, roles in (("customer", "客户", {"ADMIN", "SALES", "FINANCE"}), ("supplier", "供应商", {"ADMIN", "WAREHOUSE", "FINANCE"})):
            if role not in roles:
                continue
            where = " OR ".join(f"{_normalized(column)} LIKE %s" for column in ("name", "contact_person", "phone"))
            rows = fetch_all(conn, f"SELECT {table}_id AS id,name,contact_person,phone FROM {table} WHERE {where} ORDER BY name,{table}_id LIMIT %s", (needle, needle, needle, limit))
            groups.append({"kind": table, "label": label, "items": [
                {"id": row["id"], "title": row["name"], "subtitle": " · ".join(filter(None, (row["contact_person"], row["phone"]))),
                 "href": f"/master/{table}s/{row['id']}"} for row in rows]})
        if role in {"ADMIN", "WAREHOUSE"}:
            rows = fetch_all(conn, f"""SELECT cs.asset_id,cs.serial_number,cs.product_name,cs.current_location_name,cs.status_code
                                        FROM v_serial_ledger cs
                                       WHERE {_normalized('cs.serial_number')} LIKE %s OR EXISTS
                                            (SELECT 1 FROM asset_identifier ai WHERE ai.asset_id=cs.asset_id AND {_normalized('ai.value_raw')} LIKE %s)
                                       ORDER BY ({_normalized('cs.serial_number')} LIKE %s) DESC,cs.serial_number,cs.asset_id LIMIT %s""", (needle, needle, prefix, limit))
            groups.append({"kind": "serial", "label": "序列号", "items": [
                {"id": row["asset_id"], "title": row["serial_number"], "subtitle": " · ".join(filter(None, (row["product_name"], row["current_location_name"]))),
                 "status": row["status_code"], "href": f"/serials/{row['asset_id']}"} for row in rows]})
    _log.info("全局搜索耗时 %.1fms，角色 %s，查询长度 %d", (perf_counter() - started) * 1000, role, len(q))
    return {"q": q, "groups": groups}
