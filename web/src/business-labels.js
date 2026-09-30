/** 成色、库存流水与单据类型的业务文案；查询和保存仍使用原始编码。 */
export const CONDITION_LABELS = {
  new: '全新', used: '二手', refurbished: '翻新', damaged: '损坏', scrapped: '报废', unknown: '待确认',
}

export const MOVEMENT_LABELS = {
  OPENING: '期初库存', RECEIPT: '入库', ISSUE_OTHER: '其他出库', ISSUE_SALE: '销售出库',
  ISSUE_CONSUMPTION: '消耗领用', ISSUE_GIFT: '赠送出库', ISSUE_SCRAP: '报废出库',
  TRANSFER: '库存调拨', RETURN: '退回入库', ADJUSTMENT: '库存调整',
  PURCHASE_IN: '采购入库', PURCHASE_RETURN: '采购退货', SALES_OUT: '销售出库',
  SALES_RETURN: '销售退货', STOCK_LOSS: '报损出库', OTHER_IN: '其他入库', OTHER_OUT: '其他出库',
}

export const DOCUMENT_TYPE_LABELS = {
  PURCHASE_ORDER: '采购订单', PURCHASE_RECEIPT: '采购入库', PURCHASE_RETURN: '采购退货',
  SALES_ORDER: '销售订单', SALES_DELIVERY: '销售出库', SALES_RETURN: '销售退货',
  STOCK_TRANSFER: '库存调拨', STOCK_COUNT: '库存盘点', STOCK_LOSS: '报损', OTHER_IN: '其他入库', OTHER_OUT: '其他出库',
}

export const conditionLabel = code => CONDITION_LABELS[code] || (code ? '待确认' : '—')
export const movementLabel = code => MOVEMENT_LABELS[code] || (code ? '其他库存流水' : '—')
export const documentTypeLabel = code => DOCUMENT_TYPE_LABELS[code] || (code ? '业务单据' : '—')
