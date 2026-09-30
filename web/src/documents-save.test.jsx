import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from './api'
import { documentRoute } from './documents'
import { RouterContext, ToastProvider } from './ui'

vi.mock('./api', () => ({ default: {
  document: vi.fn(), createDocument: vi.fn(), updateDocument: vi.fn(), submitDocument: vi.fn(), products: vi.fn(),
  locations: vi.fn(), uoms: vi.fn(), customers: vi.fn(), suppliers: vi.fn(), productStocks: vi.fn(),
} }))

const user = { user_id: 1, role: 'WAREHOUSE' }
const line = { product_id: 10, product_name: '测试货品', quantity: 1, uom_id: 1, uom_code: '个', price: 10 }
const draft = { document_id: 7, doc_type: 'PURCHASE_ORDER', status: 'DRAFT', created_by: 1, party_id: 2, version: 4, lines: [line] }
function mount(parts) {
  const navigate = vi.fn()
  render(<RouterContext.Provider value={{ navigate, currentPath: `/${parts.join('/')}` }}><ToastProvider>{documentRoute('purchase', parts, user)}</ToastProvider></RouterContext.Provider>)
  return navigate
}
beforeEach(() => {
  vi.clearAllMocks()
  api.document.mockResolvedValue(draft)
  api.locations.mockResolvedValue([]); api.uoms.mockResolvedValue([{ uom_id: 1, code: '个', display_name: '个' }])
  api.suppliers.mockResolvedValue([{ supplier_id: 2, name: '测试供应商' }]); api.customers.mockResolvedValue([])
  api.productStocks.mockResolvedValue({ items: {} })
  api.products.mockResolvedValue({ items: [{ product_id: 10, display_name: '测试货品', uom_id: 1, uom_code: '个', purchase_cost_price: 10 }] })
})
afterEach(cleanup)

describe('单据保存与提交失败重试', () => {
  it('新建后提交失败，重试更新已保存草稿而不再创建', async () => {
    api.createDocument.mockResolvedValue({ document_id: 21, version: 1 })
    api.updateDocument.mockResolvedValue({ document_id: 21, version: 2 })
    api.submitDocument.mockRejectedValueOnce(new Error('审批服务暂不可用')).mockResolvedValueOnce({})
    const navigate = mount(['purchase', 'purchase_order', 'new'])
    await screen.findByRole('option', { name: '测试供应商' })
    fireEvent.change(screen.getByRole('combobox', { name: '供应商' }), { target: { value: '2' } })
    fireEvent.change(screen.getByPlaceholderText('编号、名称、厂家或型号'), { target: { value: '测试' } })
    fireEvent.click(await screen.findByRole('button', { name: /测试货品/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存并提交' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('草稿已保存，提交未成功')
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /查看已保存草稿/ })).toHaveAttribute('href', expect.stringContaining('/purchase/purchase_order/21'))
    fireEvent.change(screen.getAllByRole('textbox', { name: '备注' })[0], { target: { value: '重试前调整说明' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并提交' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/purchase/purchase_order/21', { skipGuard: true }))
    expect(api.createDocument).toHaveBeenCalledTimes(1)
    expect(api.updateDocument).toHaveBeenCalledWith(21, expect.objectContaining({ version: 1, notes: '重试前调整说明' }))
    expect(api.submitDocument.mock.calls).toEqual([[21], [21]])
    expect(screen.getByRole('status')).toHaveTextContent('单据已保存并提交审批')
  })
  it('编辑后提交失败，下一次保存使用更新后的乐观锁版本', async () => {
    api.updateDocument.mockResolvedValueOnce({ document_id: 7, version: 5 }).mockResolvedValueOnce({ document_id: 7, version: 6 })
    api.submitDocument.mockRejectedValueOnce(new Error('请求失败')).mockResolvedValueOnce({})
    mount(['purchase', 'purchase_order', '7', 'edit'])
    await screen.findByText('测试货品')
    fireEvent.click(screen.getByRole('button', { name: '保存并提交' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '保存并提交' }))
    await waitFor(() => expect(api.submitDocument).toHaveBeenCalledTimes(2))
    expect(api.updateDocument.mock.calls.map(call => call[1].version)).toEqual([4, 5])
    expect(api.createDocument).not.toHaveBeenCalled()
  })
  it('连续触发表单保存只发送一次写入，失败后保留明细', async () => {
    let fail
    api.updateDocument.mockImplementation(() => new Promise((_, reject) => { fail = reject }))
    mount(['purchase', 'purchase_order', '7', 'edit'])
    await screen.findByText('测试货品')
    const form = screen.getByRole('button', { name: '保存草稿' }).closest('form')
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    expect(api.updateDocument).toHaveBeenCalledTimes(1)
    await act(async () => fail(new Error('保存失败')))
    expect(screen.getByText('测试货品')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: '数量' })).toHaveValue(1)
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeEnabled()
  })
})
