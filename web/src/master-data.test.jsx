import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from './api'
import { masterRoute } from './master-data'
import { withBasePath } from './app-path'
import { RouterContext, ToastProvider } from './ui'

vi.mock('./api', () => ({ default: {
  customer: vi.fn(), customers: vi.fn(), createCustomer: vi.fn(), updateCustomer: vi.fn(),
  supplier: vi.fn(), suppliers: vi.fn(), createSupplier: vi.fn(), updateSupplier: vi.fn(),
} }))

const customer = {
  customer_id: 7, name: '测试客户', contact_person: '张三', phone: '123456', address: '上海',
  settlement_method: '月结', credit_limit: 100, receivable_balance: 120, is_active: true,
  history: [{ ar_ap_entry_id: 1, document_id: 12, doc_no: 'SO-测试', doc_type: 'SALES_ORDER', doc_date: '2026-09-30', entry_type: 'AR', amount: 120, direction: 'UP' }],
}
const supplier = { supplier_id: 8, name: '测试供应商', settlement_days: 30, payable_balance: 90, is_active: true, history: [] }

function mount(kind, path, role = 'ADMIN', hash = '', search = '') {
  const user = { user_id: 1, role }, navigate = vi.fn()
  const parts = ['master', kind, ...path]
  const location = { pathname: `/${parts.join('/')}`, hash, search }
  render(<RouterContext.Provider value={{ user, navigate, currentPath: `${location.pathname}${search}${hash}`, location }}><ToastProvider>{masterRoute('master', parts, new URLSearchParams(search), user)}</ToastProvider></RouterContext.Provider>)
  return navigate
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear()
  api.customer.mockResolvedValue(customer); api.customers.mockResolvedValue([customer]); api.updateCustomer.mockResolvedValue({ customer_id: 7 })
  api.supplier.mockResolvedValue(supplier); api.suppliers.mockResolvedValue([supplier]); api.updateSupplier.mockResolvedValue({ supplier_id: 8 })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('往来方档案', () => {
  it('财务可查客户历史，但没有编辑和销售单据下钻入口', async () => {
    mount('customers', ['7'], 'FINANCE', '#history')
    await screen.findByText('SO-测试')
    expect(screen.getByText('最近 50 条；筛选与排序仅覆盖这些记录。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '快速编辑' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'SO-测试' })).not.toBeInTheDocument()
    expect(screen.getByText('销售订单')).toBeInTheDocument()
  })
  it('销售可从客户历史进入获授权的销售单据', async () => {
    mount('customers', ['7'], 'SALES', '#history')
    const link = await screen.findByRole('link', { name: 'SO-测试' })
    expect(link).toHaveAttribute('href', withBasePath('/sales/sales_order/12'))
  })
  it('客户快速编辑保存后刷新对象，并不触发离开确认', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mount('customers', ['7'], 'SALES')
    fireEvent.click(await screen.findByRole('button', { name: '快速编辑' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: '客户名称' }), { target: { value: '更新客户' } })
    api.customer.mockResolvedValue({ ...customer, name: '更新客户' })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.updateCustomer).toHaveBeenCalledWith('7', expect.objectContaining({ name: '更新客户', credit_limit: 100 }))
    await screen.findByRole('heading', { name: '更新客户' })
    expect(confirm).not.toHaveBeenCalled()
  })
  it('快速编辑取消会保护未保存修改', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mount('suppliers', ['8'], 'WAREHOUSE')
    fireEvent.click(await screen.findByRole('button', { name: '快速编辑' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: '供应商名称' }), { target: { value: '修改供应商' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(api.updateSupplier).not.toHaveBeenCalled()
  })
  it('完整编辑与抽屉复用数值转换并在保存后跳过过期dirty闭包', async () => {
    const navigate = mount('suppliers', ['8', 'edit'], 'WAREHOUSE')
    fireEvent.change(await screen.findByRole('spinbutton', { name: '结算账期（天）' }), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/master/suppliers/8', { skipGuard: true }))
    expect(api.updateSupplier).toHaveBeenCalledWith('8', expect.objectContaining({ settlement_days: 60 }))
  })
  it('超信用深链只展示超过正信用额度的客户', async () => {
    api.customers.mockResolvedValue([customer, { ...customer, customer_id: 8, name: '正常客户', receivable_balance: 10 }, { ...customer, customer_id: 9, name: '无额度客户', credit_limit: 0 }])
    mount('customers', [], 'FINANCE', '', '?over_credit=true')
    await screen.findByRole('link', { name: '测试客户' })
    expect(screen.queryByText('正常客户')).not.toBeInTheDocument(); expect(screen.queryByText('无额度客户')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '仅超信用上限' })).toBeChecked()
  })
})
