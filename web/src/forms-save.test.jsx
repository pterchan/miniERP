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
    createProduct: vi.fn(), updateRequest: vi.fn(), createUser: vi.fn(), createLocation: vi.fn(),
  },
}))
const user = { user_id: 1, role: 'ADMIN' }
function mount(path) {
  const navigate = vi.fn()
  render(<RouterContext.Provider value={{ navigate, currentPath: path, location: { pathname: path, search: '', hash: '' }, user }}><ToastProvider>{routeView(path, user, new URLSearchParams())}</ToastProvider></RouterContext.Provider>)
  return navigate
}
beforeEach(() => {
  vi.clearAllMocks()
  api.uoms.mockResolvedValue([{ uom_id: 1, code: '个', display_name: '个' }]); api.categories.mockResolvedValue([]); api.locations.mockResolvedValue([])
  api.stockRequest.mockResolvedValue({ stock_request_id: 3, requester_user_id: 1, status: 'DRAFT', version: 2, request_type: 'RECEIPT', reason: '保留申请说明', lines: [] })
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
