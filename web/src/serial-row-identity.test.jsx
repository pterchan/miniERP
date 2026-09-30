import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from './api'
import { routeView } from './main'
import { RouterContext, ToastProvider } from './ui'

vi.mock('./api', () => ({
  invalidateInventory: vi.fn(), setApiUser: vi.fn(), setUnauthorizedHandler: vi.fn(),
  default: {
    locations: vi.fn(), uoms: vi.fn(), products: vi.fn(), productStocks: vi.fn(),
    stockRequest: vi.fn(), document: vi.fn(), ocrExtract: vi.fn(),
    createRequest: vi.fn(), updateRequest: vi.fn(), createDocument: vi.fn(), updateDocument: vi.fn(),
  },
}))
vi.mock('./image-utils', () => ({
  prepareImage: vi.fn().mockResolvedValue({ media_type: 'image/jpeg', image_base64: 'photo' }),
  prepareUploadFile: vi.fn(),
}))

const user = { user_id: 1, role: 'ADMIN' }
const product = { product_id: 7, display_name: '追踪货品', serialized: true, uom_id: 1, uom_code: 'EA' }
const extraction = {
  status: 'ok', fields: { serial_number: [{ value_raw: '000123', status: 'confirmed', confidence: 0.99 }] },
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function lines() { return [...document.querySelectorAll('.line-card')] }
function serialInput(line) { return within(line).getByRole('textbox', { name: /序列号登记/ }) }
function selectPhoto(line) {
  fireEvent.change(within(line).getByLabelText('OCR 识别图片'), {
    target: { files: [new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })] },
  })
}
function removeLine(line) { fireEvent.click(within(line).getByRole('button', { name: '删除' })) }

beforeEach(() => {
  vi.clearAllMocks()
  api.locations.mockResolvedValue([])
  api.uoms.mockResolvedValue([{ uom_id: 1, code: 'EA', display_name: '个' }])
  api.products.mockResolvedValue({ items: [product] })
  api.productStocks.mockResolvedValue({ items: {} })
  api.ocrExtract.mockResolvedValue(extraction)
  api.createRequest.mockResolvedValue({ stock_request_id: 3 })
  api.updateRequest.mockResolvedValue({ stock_request_id: 3 })
  api.createDocument.mockResolvedValue({ document_id: 3, version: 3 })
  api.updateDocument.mockResolvedValue({ document_id: 3, version: 3 })
})
afterEach(cleanup)

async function mountTwoRows(kind, mode) {
  const existing = ['ROW-A', 'ROW-B'].map((sn, index) => ({
    product_id: 7, product_name: product.display_name, serialized: true, serial_numbers: [sn],
    stock_request_line_id: index + 1, document_line_id: index + 1,
    quantity: '1', uom_id: 1, uom_code: 'EA', notes: '',
  }))
  api.stockRequest.mockResolvedValue({
    stock_request_id: 3, requester_user_id: 1, status: 'DRAFT', request_type: 'RECEIPT',
    version: 2, lines: existing,
  })
  api.document.mockResolvedValue({
    document_id: 3, created_by: 1, status: 'DRAFT', doc_type: 'OTHER_IN', version: 2, lines: existing,
  })
  const path = kind === 'OA'
    ? mode === '草稿明细' ? '/requests/3/edit' : '/requests/new'
    : mode === '草稿明细' ? '/inventory/other_in/3/edit' : '/inventory/other_in/new'
  render(<RouterContext.Provider value={{ navigate: vi.fn(), currentPath: path, location: { pathname: path, search: '', hash: '' }, user }}>
    <ToastProvider>{routeView(path, user, new URLSearchParams())}</ToastProvider>
  </RouterContext.Provider>)
  if (mode === '新添明细') {
    const picker = await screen.findByPlaceholderText('编号、名称、厂家或型号')
    for (let index = 0; index < 2; index += 1) {
      fireEvent.change(picker, { target: { value: '追踪' } })
      fireEvent.click(await screen.findByRole('button', { name: /追踪货品/ }))
    }
    lines().forEach((line, index) => fireEvent.change(serialInput(line), { target: { value: index === 0 ? 'ROW-A' : 'ROW-B' } }))
  }
  await waitFor(() => expect(lines()).toHaveLength(2))
  return kind === 'OA'
    ? mode === '草稿明细' ? api.updateRequest : api.createRequest
    : mode === '草稿明细' ? api.updateDocument : api.createDocument
}

describe.each(['OA', '业务单据'])('%s 同货品明细的 OCR 归属', kind => {
  it.each(['草稿明细', '新添明细'])('%s：删除已识别的行，不把候选交给后一行', async mode => {
    await mountTwoRows(kind, mode)
    selectPhoto(lines()[0])
    await screen.findByRole('region', { name: '确认 OCR 序列号' })
    removeLine(lines()[0])
    expect(lines()).toHaveLength(1)
    expect(screen.queryByRole('region', { name: '确认 OCR 序列号' })).not.toBeInTheDocument()
    expect(serialInput(lines()[0])).toHaveValue('ROW-B')
  })

  it.each(['草稿明细', '新添明细'])('%s：删除请求中的行，取消请求并丢弃迟到响应', async mode => {
    const pending = deferred()
    api.ocrExtract.mockReturnValueOnce(pending.promise)
    await mountTwoRows(kind, mode)
    selectPhoto(lines()[0])
    await waitFor(() => expect(api.ocrExtract).toHaveBeenCalledTimes(1))
    const signal = api.ocrExtract.mock.calls[0][1]
    removeLine(lines()[0])
    await act(async () => { pending.resolve(extraction) })
    expect(screen.queryByRole('region', { name: '确认 OCR 序列号' })).not.toBeInTheDocument()
    expect(serialInput(lines()[0])).toHaveValue('ROW-B')
    expect(signal.aborted).toBe(true)
  })

  it.each(['草稿明细', '新添明细'])('%s：删除前一行，存活行继续确认并保存自己的候选', async mode => {
    const save = await mountTwoRows(kind, mode)
    const surviving = lines()[1]
    selectPhoto(surviving)
    await within(surviving).findByRole('region', { name: '确认 OCR 序列号' })
    removeLine(lines()[0])
    expect(lines()[0]).toBe(surviving)
    fireEvent.click(within(surviving).getByRole('button', { name: '确认添加' }))
    expect(serialInput(surviving)).toHaveValue('ROW-B\n000123')
    fireEvent.submit(screen.getByRole('button', { name: '保存草稿' }).closest('form'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const payload = save.mock.calls[0].at(-1)
    expect(payload.lines).toHaveLength(1)
    expect(payload.lines[0].serial_numbers).toEqual(['ROW-B', '000123'])
    expect(payload.lines[0]).not.toHaveProperty('clientLineId')
  })
})
