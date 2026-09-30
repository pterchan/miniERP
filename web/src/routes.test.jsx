import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { makeApi } = vi.hoisted(() => {
  const dflt = value => async () => value
  const ADMIN = { user_id: 1, username: 'admin', display_name: '管理员', role: 'ADMIN' }
  const BALANCE_ROW = {
    product_id: 1, location_id: 2, condition_id: 3, uom_id: 4,
    product_name: '货品A', location_name: '仓库1', condition_code: 'new', uom_code: 'EA',
    on_hand_quantity: 10, identifier: 'A-1', manufacturer: '厂家', specification: '规格',
  }
  const PRODUCT_ROW = { ...BALANCE_ROW, display_name: '货品A' }
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
    request: dflt({}), workbench: dflt({ pending_documents: [], my_draft_documents: 0, my_draft_documents_by_group: [], my_draft_requests: 0, pending_requests: 0, approved_requests: 0, zero_stock_products: 0 }), search: dflt({ groups: [] }), documentHistory: dflt([]),
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
      purchase: dflt({ items: [], total: 0, summary: {} }),
      arAp: dflt({ items: [], total: 0, summary: {} }),
      receivables: dflt({ items: [], total: 0, summary: {} }), payables: dflt({ items: [], total: 0, summary: {} }), inventoryCost: dflt({ items: [], total: 0, summary: {} }),
    },
    audit: dflt({ items: [], total: 0 }), auditEvent: dflt(AUDIT_DETAIL),
    ocrExtract: dflt({ status: 'ok', search_terms: [] }),
  })

  return { makeApi }
})

vi.mock('./api', () => ({ default: makeApi(), setUnauthorizedHandler: () => {}, invalidateInventory: () => {}, invalidateWorkbench: () => {}, setApiUser: () => {} }))

import { App, AppRouter } from './main'
import api from './api'
import { withBasePath, stripBasePath } from './app-path'

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

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
      expect(container.querySelector('.app-shell')).not.toBeNull()
      expect(container.textContent).not.toContain('页面渲染出错')
    }, { timeout: 2000 })
    // 白屏的判定：React 在无错误边界时若渲染抛错会卸载整棵树，container 会变为空。
    expect(container.innerHTML).not.toBe('')
    // 不应出现加载态永远卡住的空白
    expect(container.textContent).toMatch(/.+/)
    expect(container.textContent).not.toContain('页面渲染出错')
  })
})

const user = role => ({ user_id: 1, role, username: 'test', display_name: '测试用户' })
function openAs(path, role = 'ADMIN') {
  window.history.replaceState({}, '', path)
  return render(<AppRouter user={user(role)} onLogout={() => {}} />)
}

describe('重设计入口与路由行为', () => {
  it('工作台显示可行动待办，普通员工审批中不计角标', async () => {
    vi.spyOn(api, 'workbench').mockResolvedValue({ pending_documents: [], pending_requests: 3, my_draft_requests: 2, my_draft_documents_by_group: [], zero_stock_products: 0 })
    openAs('/', 'COLLEAGUE')
    await screen.findByRole('link', { name: '待办 2 项' })
    expect(await screen.findByRole('heading', { name: '审批中' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /3 条申请等待审批/ })).toHaveAttribute('href', withBasePath('/requests?f.status=SUBMITTED'))
  })
  it('财务销售模块落到客户，管理落到审计且不请求用户管理数据', async () => {
    const users = vi.spyOn(api, 'users')
    openAs('/sales', 'FINANCE')
    expect(await screen.findByRole('heading', { name: '客户档案' })).toBeInTheDocument()
    const navigation = screen.getByRole('navigation', { name: '主导航' })
    fireEvent.click(within(navigation).getByRole('link', { name: /管理/ }))
    expect(await screen.findByRole('heading', { name: '操作审计' })).toBeInTheDocument()
    expect(users).not.toHaveBeenCalled()
  })
  it('同事可以访问库存余额和基础资料库位，库位不请求账号列表', async () => {
    const users = vi.spyOn(api, 'users')
    openAs('/inventory', 'COLLEAGUE')
    expect(await screen.findByRole('heading', { name: '库存余额', level: 1 })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: /基础资料/ }))
    fireEvent.click(screen.getByRole('tab', { name: '库位' }))
    expect(await screen.findByRole('heading', { name: '库位', level: 1 })).toBeInTheDocument()
    expect(users).not.toHaveBeenCalled()
  })
  it('筛选后进入详情再返回，保留刚输入的搜索条件', async () => {
    openAs('/inventory')
    const input = await screen.findByPlaceholderText('搜索…')
    fireEvent.change(input, { target: { value: '货品A' } })
    const rowLink = await screen.findByRole('link', { name: '货品A' })
    fireEvent.click(rowLink)
    expect(await screen.findByRole('heading', { name: '货品A', level: 1 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: /返回/ }))
    await screen.findByRole('heading', { name: '库存余额', level: 1 })
    expect(new URLSearchParams(window.location.search).get('q')).toBe('货品A')
    expect(screen.getByPlaceholderText('搜索…')).toHaveValue('货品A')
  })
  it('脏表单取消由统一路由守卫保护，只询问一次', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    openAs('/requests/new')
    fireEvent.change(await screen.findByLabelText('原因/备注'), { target: { value: '待保存的申请' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(window.location.pathname).toBe('/requests/new')
    expect(confirm).toHaveBeenCalledTimes(1)
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await screen.findByRole('heading', { name: '审批队列' })
    expect(confirm).toHaveBeenCalledTimes(2)
  })
  it('详情历史表修改筛选与切换分区后仍返回原始列表', async () => {
    const returnTo = '/master/customers?q=客户&f.is_active=true'
    window.history.replaceState({ returnTo }, '', withBasePath('/master/customers/1#history'))
    render(<AppRouter user={user('ADMIN')} onLogout={() => {}} />)
    fireEvent.change(await screen.findByLabelText('筛选单号'), { target: { value: 'SO-1' } })
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('f.doc_no')).toBe('SO-1'))
    expect(window.history.state.returnTo).toBe(returnTo)
    fireEvent.click(screen.getByRole('tab', { name: '档案', exact: true }))
    expect(window.location.hash).toBe('#profile')
    expect(window.history.state.returnTo).toBe(returnTo)
    fireEvent.click(screen.getByRole('link', { name: /返回/ }))
    await screen.findByRole('heading', { name: '客户档案', level: 1 })
    expect(new URLSearchParams(window.location.search).get('q')).toBe('客户')
  })
  it('详情返回来源不会串到其他模块的新建页', async () => {
    window.history.replaceState({ returnTo: '/master/customers?q=客户' }, '', withBasePath('/master/customers/1'))
    render(<AppRouter user={user('ADMIN')} onLogout={() => {}} />)
    await screen.findByRole('heading', { name: '客户A', level: 1 })
    fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: /申请/ }))
    await screen.findByRole('heading', { name: '审批队列' })
    expect(window.history.state.returnTo).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: '＋ 新建申请' }))
    await screen.findByRole('heading', { name: '新建申请', level: 1 })
    expect(screen.getByRole('link', { name: /返回/ })).toHaveAttribute('href', withBasePath('/requests'))
  })
  it('保存成功不再弹出未保存提示，并保留乐观锁字段', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const save = vi.spyOn(api, 'updateRequest').mockResolvedValue({ stock_request_id: 1 })
    openAs('/requests/1/edit')
    const input = await screen.findByLabelText('原因/备注')
    fireEvent.change(input, { target: { value: '修订备注' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(stripBasePath(window.location.pathname)).toBe('/requests/1'))
    expect(save).toHaveBeenCalledWith('1', expect.objectContaining({ version: 1 }))
    expect(confirm).not.toHaveBeenCalled()
  })
})
