import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from './api'
import { reportRoute } from './reports'
import { RouterContext } from './ui'

vi.mock('./api', () => ({ default: {
  suppliers: vi.fn(), customers: vi.fn(),
  reports: { purchase: vi.fn(), arAp: vi.fn(), receivables: vi.fn(), payables: vi.fn(), inventoryCost: vi.fn() },
} }))

beforeEach(() => {
  vi.useFakeTimers()
  api.suppliers.mockResolvedValue([{ supplier_id: 7, name: '广州供应商' }])
  api.customers.mockResolvedValue([{ customer_id: 3, name: '广州客户' }])
})
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks() })

function report(page, search = '', role = 'FINANCE') {
  const user = { user_id: 1, role }
  return <RouterContext.Provider value={{ user, currentPath: `/reports/${page}${search}`, location: { pathname: `/reports/${page}`, search, hash: '' }, navigate: vi.fn() }}>{reportRoute('reports', ['reports', page], new URLSearchParams(search), user)}</RouterContext.Provider>
}
async function loadReport() { await act(async () => { await vi.advanceTimersByTimeAsync(250) }) }

describe('报表服务端表格', () => {
  it('采购对账恢复日期和供应商，使用完整筛选合计并按相同条件导出', async () => {
    const urls = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { urls.push(this.href) })
    api.reports.purchase.mockResolvedValue({ items: [{ document_id: 91, doc_type: 'PURCHASE_RECEIPT', supplier_name: '广州供应商', doc_no: 'CG-91', doc_date: '2026-09-30', total_amount: 25, posted_by: '张三' }], total: 35, summary: { total_amount: 8000 } })
    render(report('purchase', '?supplier_id=7&start_date=2026-09-01&end_date=2026-09-30&page=2&ps=10&sort=total_amount&order=desc'))
    await loadReport()
    expect(api.reports.purchase).toHaveBeenCalledWith(expect.objectContaining({ paginated: true, page: 2, page_size: 10, supplier_id: '7', start_date: '2026-09-01', end_date: '2026-09-30', sort: 'total_amount', order: 'desc', signal: expect.any(AbortSignal) }))
    expect(screen.getByText('采购金额：¥ 8,000')).toBeInTheDocument()
    expect(screen.getByLabelText('开始日期')).toHaveValue('2026-09-01')
    expect(screen.getByText('CG-91').closest('a')).toHaveAttribute('href', '/erp/purchase/purchase_receipt/91')
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'CSV · 当前筛选全部' }))
    const exported = new URL(urls[0])
    expect(exported.pathname).toBe('/erp/api/reports/purchase-reconciliation')
    expect(exported.searchParams.get('supplier_id')).toBe('7')
    expect(exported.searchParams.get('start_date')).toBe('2026-09-01')
    expect(exported.searchParams.get('sort')).toBe('total_amount')
    expect(exported.searchParams.has('page')).toBe(false)
    expect(exported.searchParams.has('ids')).toBe(false)
  })

  it('应收应付每次只加载一个分类，分类切换和汇总下钻准确', async () => {
    api.reports.arAp.mockImplementation(async params => params.party_type === 'supplier'
      ? { items: [{ supplier_id: 7, name: '广州供应商', payable_balance: 100 }], total: 1, summary: { payable_balance: 100 } }
      : { items: [{ customer_id: 3, name: '广州客户', receivable_balance: 50 }], total: 1, summary: { receivable_balance: 50 } })
    const { rerender } = render(report('arap', '?party_type=customer'))
    await loadReport()
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: '应收（客户）' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('广州客户').closest('a')).toHaveAttribute('href', '/erp/master/customers/3')
    rerender(report('arap', '?party_type=supplier'))
    await loadReport()
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: '应付（供应商）' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('广州供应商').closest('a')).toHaveAttribute('href', '/erp/master/suppliers/7')
    expect(screen.queryByText('广州客户')).not.toBeInTheDocument()
    expect(api.reports.arAp.mock.calls.map(([params]) => params.party_type)).toEqual(['customer', 'supplier'])
  })

  it('财务台账不显示无权查看的销售单链接，管理员可下钻', async () => {
    api.reports.receivables.mockResolvedValue({ items: [{ ar_ap_entry_id: 13, document_id: 23, doc_type: 'SALES_DELIVERY', party_name: '广州客户', doc_no: 'XS-23', doc_date: '2026-09-30', entry_type: 'INVOICE', direction: 'UP', amount: 20, created_at: '2026-09-30T10:00:00Z' }], total: 100, summary: { amount_up: 900, amount_down: 400, balance: 500 } })
    const { rerender } = render(report('receivables', '?party_id=3&f.entry_type=INVOICE', 'FINANCE'))
    await loadReport()
    expect(api.reports.receivables).toHaveBeenCalledWith(expect.objectContaining({ party_id: '3', f: ['entry_type:eq:INVOICE'], paginated: true }))
    expect(screen.getByText('XS-23').closest('a')).toBeNull()
    expect(screen.getByText('增加金额：¥ 900')).toBeInTheDocument()
    expect(screen.getByText('减少金额：¥ 400')).toBeInTheDocument()
    expect(screen.getByText('净发生额：¥ 500')).toBeInTheDocument()
    rerender(report('receivables', '?party_id=3&f.entry_type=INVOICE', 'ADMIN'))
    expect(screen.getByText('XS-23').closest('a')).toHaveAttribute('href', '/erp/sales/sales_delivery/23')
  })

  it('库存成本保留货品单位复合键，勾选导出当前单位并显示完整金额合计', async () => {
    const urls = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { urls.push(this.href) })
    api.reports.inventoryCost.mockResolvedValue({ items: [{ product_id: 5, uom_id: 2, product_name: '测试货品', uom_code: 'BOX', on_hand_quantity: 3, cost_price: 5, cost_value: 15 }], total: 12, summary: { cost_value: 1000 } })
    render(report('inventory-cost'))
    await loadReport()
    expect(screen.getByText('库存成本：¥ 1,000')).toBeInTheDocument()
    expect(screen.getByText('测试货品').closest('a')).toHaveAttribute('href', '/erp/products/5')
    fireEvent.click(screen.getByLabelText('选择行'))
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'XLSX · 已选 1 行' }))
    const exported = new URL(urls[0])
    expect(exported.searchParams.get('ids')).toBe('5:2')
    expect(exported.searchParams.get('fmt')).toBe('xlsx')
  })

  it('无报表权限的角色不发起数据请求', async () => {
    render(report('purchase', '', 'WAREHOUSE'))
    await loadReport()
    expect(screen.getByRole('heading', { name: '无权访问' })).toBeInTheDocument()
    expect(api.reports.purchase).not.toHaveBeenCalled()
  })
})
