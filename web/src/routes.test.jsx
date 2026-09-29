import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

const { makeApi } = vi.hoisted(() => {
  const dflt = value => async () => value
  const ADMIN = { user_id: 1, username: 'admin', display_name: '管理员', role: 'ADMIN' }
  const BALANCE_ROW = {
    product_id: 1, location_id: 2, condition_id: 3, uom_id: 4,
    product_name: '货品A', location_name: '仓库1', condition_code: 'new', uom_code: 'EA',
    on_hand_quantity: 10, identifier: 'A-1', manufacturer: '厂家', specification: '规格',
  }
  const PRODUCT_ROW = { ...BALANCE_ROW }
  const PRODUCT_DETAIL = {
    product_id: 1, display_name: '货品A', manufacturer: '厂家', specification: '规格',
    default_uom_id: 1, uom_code: 'EA', uom_display_name: '个', source_uom_raw: '个',
    primary_identifier: { value_raw: 'A-1' }, identifiers: [], identifier_conflicts: [], aliases: [], price_tiers: [],
    category_id: null, purchase_cost_price: 10, sales_price: 20, updated_at: '2026-08-06T00:00:00',
  }
  const REQUEST_DETAIL = {
    stock_request_id: 1, request_no: 'REQ-1', request_type: 'RECEIPT', requester_user_id: 1,
    requester_display_name: '张三', requester_username: 'zhangsan', reason: '备货',
    source_location_id: null, destination_location_id: null, version: 1, status: 'DRAFT',
    lines: [], actions: [],
  }
  const CONFLICT_DETAIL = {
    case_type: 'other', status_code: 'pending_review', resolution_notes: '',
    product_observation: {}, product: null, movement_candidate: null, source_record: null,
  }
  const CUSTOMER_DETAIL = { customer_id: 1, name: '客户A', receivable_balance: 0, credit_limit: 0, settlement_method: '现结', contact_person: '', phone: '', address: '', level: '', notes: '', history: [] }
  const SUPPLIER_DETAIL = { supplier_id: 1, name: '供应商A', payable_balance: 0, avg_price: 0, settlement_days: 30, contact_person: '', phone: '', address: '', notes: '', supplied_products: [], history: [] }
  const AUDIT_DETAIL = { audit_event_id: 1, action: 'LOGIN', target_table: 'app_user', target_id: 1, actor_name: '管理员', created_at: '2026-08-06T00:00:00', request_id: 'req-1', before_data: {}, after_data: {}, field_diff: {} }
  const DOCUMENT_DETAIL = { document_id: 1, doc_no: 'CG-1', doc_type: 'PURCHASE_RECEIPT', status: 'DRAFT', doc_date: '2026-08-06', party_name: '供应商A', creator_name: '张三', total_amount: 100, deposit_amount: 0, lines: [], attachments: [], ar_ap_entries: [], created_by: 1 }

  const makeApi = () => ({
    request: dflt({}),
    login: dflt({}), logout: dflt({}), me: dflt(ADMIN), changePassword: dflt({}),
    inventory: dflt([BALANCE_ROW]),
    inventoryByProduct: dflt([BALANCE_ROW]),
    inventoryDetail: dflt({ ...BALANCE_ROW, on_hand_quantity: 10, movements: [] }),
    adjustInventory: dflt({}),
    products: dflt({ items: [PRODUCT_ROW], total: 1 }),
    productStocks: dflt({ items: {} }),
    product: dflt(PRODUCT_DETAIL),
    createProduct: dflt({}), updateProduct: dflt({}),
    uoms: dflt([{ uom_id: 1, code: 'EA', display_name: '个', decimal_scale: 0 }]),
    createUom: dflt({}),
    locations: dflt([{ location_id: 2, code: 'W', name: '仓库1', location_type: 'warehouse', is_company_inventory: true, is_active: true }]),
    location: dflt({ location_id: 2, code: 'W', name: '仓库1', location_type: 'warehouse', is_company_inventory: true, is_active: true }),
    createLocation: dflt({}), updateLocation: dflt({}),
    users: dflt([{ ...ADMIN, is_active: true, created_at: '2026-08-06T00:00:00' }]),
    user: dflt({ ...ADMIN, is_active: true, created_at: '2026-08-06T00:00:00' }),
    createUser: dflt({}), updateUser: dflt({}), resetPassword: dflt({}),
    requests: dflt([]), stockRequest: dflt(REQUEST_DETAIL),
    createRequest: dflt({}), updateRequest: dflt({}), action: dflt({}),
    conflicts: dflt([]), conflict: dflt(CONFLICT_DETAIL),
    resolveConflict: dflt({}), linkConflict: dflt({}), createConflictProduct: dflt({}), editConflictProduct: dflt({}),
    documents: dflt({ items: [], total: 0 }), document: dflt(DOCUMENT_DETAIL),
    createDocument: dflt({}), updateDocument: dflt({}), submitDocument: dflt({}), postDocument: dflt({}), reverseDocument: dflt({}), addAttachment: dflt({}),
    attachmentUrl: () => '/api/attachments/1',
    productImages: dflt([]), uploadProductImages: dflt({}), productImageContent: () => '/api/product-images/1/content',
    updateProductImage: dflt({}), deleteProductImage: dflt({}),
    categories: dflt([]), createCategory: dflt({}), updateCategory: dflt({}),
    customers: dflt([]), customer: dflt(CUSTOMER_DETAIL), createCustomer: dflt({}), updateCustomer: dflt({}),
    suppliers: dflt([]), supplier: dflt(SUPPLIER_DETAIL), createSupplier: dflt({}), updateSupplier: dflt({}),
    priceTiers: dflt([]), createPriceTier: dflt({}), updatePriceTier: dflt({}), deletePriceTier: dflt({}),
    departments: dflt([]), createDepartment: dflt({}),
    reports: {
      purchase: dflt({ rows: [] }),
      arAp: dflt({ customers: [], suppliers: [] }),
      receivables: dflt([]), payables: dflt([]), inventoryCost: dflt([]),
    },
    audit: dflt([]), auditEvent: dflt(AUDIT_DETAIL),
    ocrExtract: dflt({ status: 'ok', search_terms: [] }),
  })

  return { makeApi }
})

vi.mock('./api', () => ({ default: makeApi(), setUnauthorizedHandler: () => {}, invalidateInventory: () => {} }))

import { App } from './main'

afterEach(cleanup)

const ROUTES = [
  ['/ 库存总览', '/'],
  ['/products 货品列表', '/products'],
  ['/products/1 货品详情', '/products/1'],
  ['/requests 申请列表', '/requests'],
  ['/requests/1 申请详情', '/requests/1'],
  ['/count 清点库存', '/count'],
  ['/purchase 采购单据分组', '/purchase'],
  ['/purchase/purchase_order 采购订单列表', '/purchase/purchase_order'],
  ['/purchase/purchase_order/1 单据详情', '/purchase/purchase_order/1'],
  ['/sales 销售单据分组', '/sales'],
  ['/inventory 库存单据分组', '/inventory'],
  ['/inventory/stock_transfer 调拨列表', '/inventory/stock_transfer'],
  ['/inventory/stock_transfer/1 调拨详情', '/inventory/stock_transfer/1'],
  ['/inventory/1/2/3/4 库存余额详情', '/inventory/1/2/3/4'],
  ['/master/categories 商品分类', '/master/categories'],
  ['/master/customers 客户列表', '/master/customers'],
  ['/master/customers/1 客户详情', '/master/customers/1'],
  ['/master/suppliers 供应商列表', '/master/suppliers'],
  ['/master/suppliers/1 供应商详情', '/master/suppliers/1'],
  ['/reports/purchase 采购对账', '/reports/purchase'],
  ['/reports/arap 应收应付', '/reports/arap'],
  ['/reports/receivables 应收明细', '/reports/receivables'],
  ['/reports/payables 应付明细', '/reports/payables'],
  ['/reports/inventory-cost 库存成本', '/reports/inventory-cost'],
  ['/admin 系统管理', '/admin'],
  ['/admin/users/1 用户详情', '/admin/users/1'],
  ['/conflicts 冲突中心', '/conflicts'],
  ['/conflicts/1 冲突详情', '/conflicts/1'],
  ['/audit 操作审计', '/audit'],
  ['/audit/1 审计详情', '/audit/1'],
  ['/profile 我的信息', '/profile'],
  ['/purchase/stock_count 非法单据类型', '/purchase/stock_count'],
  ['/nonexistent 不存在的路由', '/nonexistent'],
]

describe('所有路由渲染不应白屏', () => {
  it.each(ROUTES)('%s 渲染出内容（无崩溃）', async (_label, route) => {
    window.history.replaceState({}, '', route)
    const { container } = render(<App />)
    // 等待 api.me() 与页面数据请求 resolve 后的最终渲染完成。
    await waitFor(() => {
      expect(container.innerHTML).not.toBe('')
    }, { timeout: 2000 })
    // 白屏的判定：React 在无错误边界时若渲染抛错会卸载整棵树，container 会变为空。
    expect(container.innerHTML).not.toBe('')
    // 不应出现加载态永远卡住的空白
    expect(container.textContent).toMatch(/.+/)
  })
})
