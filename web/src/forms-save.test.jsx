import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from './api'
import { routeView } from './main'
import { RouterContext, ToastProvider } from './ui'

vi.mock('./api', () => ({
  invalidateInventory: vi.fn(), invalidateWorkbench: vi.fn(), setApiUser: vi.fn(), setUnauthorizedHandler: vi.fn(),
  default: {
    uoms: vi.fn(), categories: vi.fn(), locations: vi.fn(), stockRequest: vi.fn(), product: vi.fn(),
    createProduct: vi.fn(), createRequest: vi.fn(), updateRequest: vi.fn(), createUser: vi.fn(), createLocation: vi.fn(),
  },
}))
const user = { user_id: 1, role: 'ADMIN' }
function mount(path, query = new URLSearchParams()) {
  const navigate = vi.fn()
  render(<RouterContext.Provider value={{ navigate, currentPath: path, location: { pathname: path, search: '', hash: '' }, user }}><ToastProvider>{routeView(path, user, query)}</ToastProvider></RouterContext.Provider>)
  return navigate
}
beforeEach(() => {
  vi.clearAllMocks()
  api.uoms.mockResolvedValue([{ uom_id: 1, code: '个', display_name: '个' }]); api.categories.mockResolvedValue([]); api.locations.mockResolvedValue([])
  api.stockRequest.mockResolvedValue({ stock_request_id: 3, requester_user_id: 1, status: 'DRAFT', version: 2, request_type: 'RECEIPT', reason: '保留申请说明', lines: [] })
})

describe('OA 可选序列号录入', () => {
  const line = {
    stock_request_line_id: 5, product_id: 7, product_name: '追踪货品', serialized: true,
    serial_numbers: ['000123', 'ABC-2'], quantity: '2', uom_id: 1, uom_code: '个', condition_id: 3,
  }
  function loadRequest(lines) {
    api.stockRequest.mockResolvedValue({
      stock_request_id: 3, request_no: 'OA-003', requester_user_id: 1, status: 'DRAFT',
      version: 2, request_type: 'RECEIPT', lines,
    })
  }
  it('重载草稿时保留 SN 和成色，编辑后按字符串数组保存', async () => {
    loadRequest([line])
    api.updateRequest.mockResolvedValue({ stock_request_id: 3 })
    mount('/requests/3/edit')
    const serials = await screen.findByRole('textbox', { name: '序列号登记（可选）' })
    expect(serials).toHaveValue('000123\nABC-2')
    fireEvent.change(serials, { target: { value: '000123\n XYZ-3 \n' } })
    fireEvent.submit(screen.getByRole('button', { name: '保存草稿' }).closest('form'))
    await waitFor(() => expect(api.updateRequest).toHaveBeenCalledWith('3', expect.objectContaining({
      version: 2, lines: [expect.objectContaining({ serial_numbers: ['000123', 'XYZ-3'], condition_id: 3 })],
    })))
  })
  it('从货品新建申请复用登记组件，未填写 SN 时保持可选语义', async () => {
    api.product.mockResolvedValue({ product_id: 7, display_name: '追踪货品', serialized: true, uom_id: 1 })
    api.createRequest.mockResolvedValue({ stock_request_id: 3 })
    mount('/requests/new', new URLSearchParams({ product_id: '7' }))
    expect(await screen.findByRole('textbox', { name: '序列号登记（可选）' })).toHaveValue('')
    fireEvent.submit(screen.getByRole('button', { name: '保存草稿' }).closest('form'))
    await waitFor(() => expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      lines: [expect.objectContaining({ product_id: 7, serial_numbers: null })],
    })))
  })
  it('详情展示草稿 SN，旧记录的空值不产生额外内容', async () => {
    loadRequest([line, { ...line, stock_request_line_id: 6, product_name: '旧货品', serialized: false, serial_numbers: null }])
    mount('/requests/3')
    expect(await screen.findByText('SN：000123、ABC-2')).toBeInTheDocument()
    expect(screen.getByText('旧货品').closest('.detail-line')).not.toHaveTextContent('SN：')
  })
})
afterEach(cleanup)

describe('表单保存反馈与防重复提交', () => {
  it.each([
    { path: '/products/new', method: 'createProduct', button: '保存', result: { product_id: 10 }, toast: '货品已保存', target: '/products/10' },
    { path: '/requests/3/edit', method: 'updateRequest', button: '保存草稿', result: { stock_request_id: 3 }, toast: '申请草稿已保存', target: '/requests/3' },
    { path: '/admin/users/new', method: 'createUser', button: '保存', result: { user_id: 9 }, toast: '账号已保存', target: '/admin/users/9' },
    { path: '/admin/locations/new', method: 'createLocation', button: '保存', result: { location_id: 6 }, toast: '库位已保存', target: '/admin/locations/6' },
  ])('$method 连续提交只写一次并显示保存反馈', async ({ path, method, button, result, toast, target }) => {
    let finish
    api[method].mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const navigate = mount(path)
    const form = (await screen.findByRole('button', { name: button })).closest('form')
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    expect(api[method]).toHaveBeenCalledTimes(1)
    await act(async () => finish(result))
    expect(screen.getByRole('status')).toHaveTextContent(toast)
    expect(navigate).toHaveBeenCalledWith(target, { skipGuard: true })
  })
  it('保存失败时保留申请说明，申请类型在编辑态不可更改', async () => {
    api.updateRequest.mockRejectedValue(new Error('临时失败'))
    mount('/requests/3/edit')
    const input = await screen.findByRole('textbox', { name: '原因/备注' })
    fireEvent.change(input, { target: { value: '未保存的新增说明' } })
    fireEvent.submit(screen.getByRole('button', { name: '保存草稿' }).closest('form'))
    await screen.findByRole('alert')
    expect(input).toHaveValue('未保存的新增说明')
    expect(screen.getByRole('combobox', { name: '申请类型' })).toBeDisabled()
    await waitFor(() => expect(screen.getByRole('button', { name: '保存草稿' })).toBeEnabled())
  })
  it('新增库位的返回和取消落到基础资料库位列表', () => {
    const navigate = mount('/admin/locations/new')
    expect(screen.getByRole('link', { name: /返回/ })).toHaveAttribute('href', expect.stringContaining('/master/locations'))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(navigate).toHaveBeenCalledWith('/master/locations')
  })
})
