"""单据、OA 和快速清点共用的库存过账入口。

调用方在同一事务内先按货品 ID 排序加锁，再读取余额、计算盘点差值并调用本模块。
权限、单据状态和库位默认值仍由各业务入口负责；本模块不提交事务。
"""

from __future__ import annotations

import os
from decimal import Decimal
from typing import Any

from fastapi import HTTPException

from .db import audit, fetch_one
from .helpers import _condition_id, _movement_id, _status_id
from .serial_tracking import (
    apply_adjustment_serials,
    apply_line_serials,
    reverse_movement_serials,
    validate_reverse_movement_serials,
)


def forbid_negative_stock() -> bool:
    """默认允许负库存；显式开启后所有来源侧移动都检查余额。"""
    return os.environ.get("ERP_FORBID_NEGATIVE_STOCK", "0") == "1"


def require_sufficient_stock(conn: Any, *, product_id: int, uom_id: int,
                             condition_id: int, location_id: int | None,
                             quantity: Decimal) -> None:
    if not forbid_negative_stock() or location_id is None:
        return
    row = fetch_one(conn, """SELECT on_hand_quantity FROM v_inventory_balance
                              WHERE product_id=%s AND location_id=%s AND condition_id=%s AND uom_id=%s""",
                    (product_id, location_id, condition_id, uom_id))
    on_hand = Decimal(row["on_hand_quantity"]) if row else Decimal(0)
    if on_hand < quantity:
        raise HTTPException(status_code=422,
                            detail=f"库存不足：货品在库位 {location_id} 现存量 {on_hand}，本次需要 {quantity}（已启用禁止超卖）")


def post_inventory_movement(
    conn: Any, user: dict[str, Any], req_meta: dict[str, Any], *,
    movement_code: str, product_id: int, quantity: Decimal, uom_id: int,
    condition_id: int | None, source_location_id: int | None,
    destination_location_id: int | None, stock_effect: str,
    source_uom_raw: str | None = None, notes: str | None = None,
    document_id: int | None = None, reversal_of_movement: dict[str, Any] | None = None,
    audit_action: str = "POST", audit_after: dict[str, Any] | None = None,
    serial_numbers: list[str] | None = None, adjustment_delta: Decimal | None = None,
) -> int:
    """检查本条移动并原子写入数量账和 SN 账，返回流水 ID。

    多行调用必须先锁住全部货品；逐条检查余额会看到本事务前面已写的移动。
    红冲 SN 先校验、后插入反向流水，防止新反向流水把待校验的原事件排除。
    """
    if quantity <= 0:
        raise HTTPException(status_code=422, detail="库存流水数量必须大于零")
    if stock_effect not in ("IN", "OUT", "TRANSFER"):
        raise ValueError("不支持的库存效果")
    if stock_effect in ("OUT", "TRANSFER") and source_location_id is None:
        raise HTTPException(status_code=422, detail="出库或调拨必须指定来源库位")
    if stock_effect in ("IN", "TRANSFER") and destination_location_id is None:
        raise HTTPException(status_code=422, detail="入库或调拨必须指定目的库位")
    if stock_effect == "IN" and source_location_id is not None:
        raise HTTPException(status_code=422, detail="入库仅允许目的库位；移库请使用调拨")
    if stock_effect == "OUT" and destination_location_id is not None:
        raise HTTPException(status_code=422, detail="出库仅允许来源库位；移库请使用调拨")
    if source_location_id is not None and source_location_id == destination_location_id:
        raise HTTPException(status_code=422, detail="来源和目的库位不能相同")
    if adjustment_delta is not None and (adjustment_delta == 0 or abs(adjustment_delta) != quantity):
        raise ValueError("清点差值与库存流水数量不一致")
    if adjustment_delta is not None and stock_effect != ("IN" if adjustment_delta > 0 else "OUT"):
        raise ValueError("清点差值与库存移动方向不一致")
    condition_id = _condition_id(conn, condition_id)
    reverse_assets = None
    if reversal_of_movement is not None:
        reverse_assets = validate_reverse_movement_serials(conn, reversal_of_movement)
    require_sufficient_stock(conn, product_id=product_id, uom_id=uom_id,
                             condition_id=condition_id, location_id=source_location_id,
                             quantity=quantity)
    reversal_id = int(reversal_of_movement["inventory_movement_id"]) if reversal_of_movement else None
    after = dict(audit_after or {})
    after.update({"product_id": product_id, "quantity": str(quantity), "movement_type": movement_code,
                  "reversal_of": reversal_id, "uom_id": uom_id, "condition_id": condition_id,
                  "source_location_id": source_location_id, "destination_location_id": destination_location_id})
    if document_id is not None:
        after.setdefault("document_id", document_id)
    audit(conn, user, audit_action, "inventory_movement", after=after,
          request_id=req_meta.get("request_id"), ip_address=req_meta.get("ip_address"),
          user_agent=req_meta.get("user_agent"))
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO inventory_movement(movement_type_id,status_id,movement_date,product_id,quantity,uom_id,condition_id,
                           source_location_id,destination_location_id,source_uom_raw,document_id,reversal_of_movement_id,notes,
                           posted_at,posted_by,posted_by_user_id)
                       VALUES (%s,%s,current_date,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s,%s)
                       RETURNING inventory_movement_id""",
                    (_movement_id(conn, movement_code), _status_id(conn, "posted"), product_id, quantity,
                     uom_id, condition_id, source_location_id, destination_location_id, source_uom_raw,
                     document_id, reversal_id, notes, user["username"], user["user_id"]))
        movement_id = int(cur.fetchone()[0])
    if reversal_of_movement is not None:
        reverse_movement_serials(conn, user, req_meta, reversal_of_movement, movement_id,
                                 validated_assets=reverse_assets)
    elif adjustment_delta is not None:
        product = fetch_one(conn, "SELECT product_id,display_name,serialized FROM product WHERE product_id=%s", (product_id,))
        apply_adjustment_serials(conn, user, req_meta, movement_id, product, serial_numbers,
                                 adjustment_delta, condition_id,
                                 destination_location_id if adjustment_delta > 0 else source_location_id, uom_id=uom_id)
    else:
        apply_line_serials(conn, user, req_meta, movement_id, product_id, serial_numbers,
                           stock_effect, source_location_id, destination_location_id, quantity, condition_id, uom_id=uom_id)
    return movement_id
