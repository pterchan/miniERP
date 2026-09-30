import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SerialEntry, SerialLedger } from './serial'
import { RouterContext } from './ui'

const mocks = vi.hoisted(() => ({
  serialLedger: vi.fn(), ocrExtract: vi.fn(), importSerialsFile: vi.fn(), parseSerials: vi.fn(), prepareImage: vi.fn(),
}))
vi.mock('./api', () => ({ default: mocks }))
vi.mock('./image-utils', () => ({ prepareImage: (...args) => mocks.prepareImage(...args) }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.serialLedger.mockImplementation(() => Promise.reject(new Error('后端不可用')))
  mocks.prepareImage.mockResolvedValue({ media_type: 'image/jpeg', image_base64: 'encoded-image' })
})

afterEach(cleanup)

describe('SerialLedger failure handling', () => {
  it('stops after one failed fetch instead of retrying in a render loop', async () => {
    render(<RouterContext.Provider value={{ navigate: vi.fn(), currentPath: '/serials' }}><SerialLedger user={{ role: 'ADMIN' }} /></RouterContext.Provider>)
    // DataTable 有 200ms 防抖；等待足以触发「失败→重渲染→再拉取」循环的窗口
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(mocks.serialLedger.mock.calls.length).toBe(1)
  })
})

const sn = (value_raw, status = 'confirmed', confidence = 0.99) => ({ value_raw, status, confidence })
const extraction = (items, status = 'ok') => ({ status, fields: { serial_number: items } })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function selectPhoto(name = 'photo.jpg') {
  fireEvent.change(screen.getByLabelText('OCR 识别图片'), { target: { files: [new File(['photo'], name, { type: 'image/jpeg' })] } })
}
function entry(props = {}) {
  const onChange = props.onChange || vi.fn()
  const view = render(<SerialEntry productId={1} value="" onChange={onChange} {...props} />)
  return { ...view, onChange }
}

describe('SerialEntry OCR 确认流程', () => {
  it('高置信度 SN 也必须确认，LOT 不进入候选或输入文本', async () => {
    mocks.ocrExtract.mockResolvedValue({ ...extraction([sn('000123')]), fields: { serial_number: [sn('000123')], lot_number: [sn('LOT-01')] } })
    const { onChange } = entry({ value: '原有SN' })
    selectPhoto()
    const region = await screen.findByRole('region', { name: '确认 OCR 序列号' })
    expect(within(region).getByRole('checkbox', { name: /000123/ })).toBeChecked()
    expect(within(region).queryByText(/LOT-01/)).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(within(region).getByRole('button', { name: '确认添加' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('原有SN\n000123')
    expect(screen.queryByRole('region', { name: '确认 OCR 序列号' })).not.toBeInTheDocument()
  })

  it.each([
    ['partial', 'confirmed', 0.99], ['ok', 'confirmed', 0.6],
    ['ok', 'candidate', 0.99], ['ok', 'ambiguous', 0.99],
  ])('%s / %s / %s 必须逐项勾选确认', async (status, fieldStatus, confidence) => {
    mocks.ocrExtract.mockResolvedValue(extraction([sn('000123', fieldStatus, confidence)], status))
    const { onChange } = entry()
    selectPhoto()
    const checkbox = await screen.findByRole('checkbox', { name: /000123/ })
    expect(checkbox).not.toBeChecked()
    expect(screen.getByRole('button', { name: '确认添加' })).toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('000123')
  })

  it('多个 ambiguous 候选只添加用户选中的一项', async () => {
    mocks.ocrExtract.mockResolvedValue(extraction([sn('000123', 'ambiguous'), sn('000124', 'ambiguous')]))
    const { onChange } = entry()
    selectPhoto()
    const first = await screen.findByRole('checkbox', { name: /000123/ })
    expect(screen.getByRole('checkbox', { name: /000124/ })).not.toBeChecked()
    fireEvent.click(first)
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('000123')
  })

  it('重拍状态即使包含高置信度 SN 也不给出添加入口', async () => {
    mocks.ocrExtract.mockResolvedValue({ ...extraction([sn('000123')], 'reshoot_required'), warnings: ['文字过小，请重拍'] })
    const { onChange } = entry()
    selectPhoto()
    expect(await screen.findByText('文字过小，请重拍')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '确认 OCR 序列号' })).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('只有 LOT 时给出说明，不调用 SN 变更回调', async () => {
    mocks.ocrExtract.mockResolvedValue({ status: 'ok', fields: { lot_number: [sn('LOT-01')] } })
    const { onChange } = entry()
    selectPhoto()
    expect(await screen.findByText(/仅识别到批号/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([{ status: 'unknown' }, extraction([sn('000123', 'confirmed', '0.99')])])('无效响应显示错误且不开放添加', async result => {
    mocks.ocrExtract.mockResolvedValue(result)
    const { onChange } = entry()
    selectPhoto()
    expect(await screen.findByRole('alert')).toHaveTextContent('OCR 返回的')
    expect(screen.queryByRole('region', { name: '确认 OCR 序列号' })).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('取消候选不改变原有 SN 文本', async () => {
    mocks.ocrExtract.mockResolvedValue(extraction([sn('000123')]))
    const { onChange } = entry({ value: '已有SN' })
    selectPhoto()
    fireEvent.click(await screen.findByRole('button', { name: '取消本次识别' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('已有SN')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('确认时对已有列表和同批候选去重，并保留前导零', async () => {
    mocks.ocrExtract.mockResolvedValue(extraction([sn('０００１２３'), sn('000123'), sn('ABC'), sn('000124')]))
    const { onChange } = entry({ value: '000123\nabc\n' })
    selectPhoto()
    const confirm = await screen.findByRole('button', { name: '确认添加' })
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    fireEvent.click(confirm)
    expect(onChange).toHaveBeenCalledExactlyOnceWith('000123\nabc\n000124')
    expect(screen.getByText('已添加 1 个 SN，跳过 2 个重复项')).toBeInTheDocument()
  })

  it('所选 SN 全部已存在时不重复触发变更', async () => {
    mocks.ocrExtract.mockResolvedValue(extraction([sn('000123')]))
    const { onChange } = entry({ value: '000123' })
    selectPhoto()
    fireEvent.click(await screen.findByRole('button', { name: '确认添加' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('所选序列号已在输入列表中，无需重复添加')).toBeInTheDocument()
  })

  it('确认追加使用最新输入和最新回调，不覆盖扫描期间的修改', async () => {
    mocks.ocrExtract.mockResolvedValue(extraction([sn('000124')]))
    const { onChange, rerender } = entry({ value: '旧文本' })
    selectPhoto()
    await screen.findByRole('button', { name: '确认添加' })
    const latestChange = vi.fn()
    rerender(<SerialEntry productId={1} value={'最新文本\n000123'} onChange={latestChange} />)
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(latestChange).toHaveBeenCalledExactlyOnceWith('最新文本\n000123\n000124')
  })

  it('请求失败后解除忙碌状态，可重新扫描', async () => {
    mocks.ocrExtract.mockRejectedValueOnce(new Error('OCR 服务不可用')).mockResolvedValueOnce(extraction([sn('000123')]))
    entry()
    selectPhoto()
    expect(await screen.findByRole('alert')).toHaveTextContent('OCR 服务不可用')
    expect(screen.getByRole('button', { name: /OCR 识别/ })).toBeEnabled()
    selectPhoto('retry.jpg')
    await screen.findByRole('checkbox', { name: /000123/ })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('SerialEntry OCR 过期结果保护', () => {
  it('新照片替换旧请求，倒序响应只保留最新候选', async () => {
    const first = deferred(), second = deferred()
    mocks.ocrExtract.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { onChange } = entry()
    selectPhoto('first.jpg')
    await waitFor(() => expect(mocks.ocrExtract).toHaveBeenCalledTimes(1))
    const firstSignal = mocks.ocrExtract.mock.calls[0][1]
    selectPhoto('second.jpg')
    await waitFor(() => expect(mocks.ocrExtract).toHaveBeenCalledTimes(2))
    expect(firstSignal.aborted).toBe(true)
    await act(async () => { second.resolve(extraction([sn('NEW-001')])) })
    await screen.findByRole('checkbox', { name: /NEW-001/ })
    await act(async () => { first.resolve(extraction([sn('OLD-001')])) })
    expect(screen.queryByRole('checkbox', { name: /OLD-001/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('NEW-001')
  })

  it('旧请求失败不会显示错误或提前解除最新请求的忙碌状态', async () => {
    const first = deferred(), second = deferred()
    mocks.ocrExtract.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    entry()
    selectPhoto('first.jpg')
    await waitFor(() => expect(mocks.ocrExtract).toHaveBeenCalledTimes(1))
    selectPhoto('second.jpg')
    await waitFor(() => expect(mocks.ocrExtract).toHaveBeenCalledTimes(2))
    await act(async () => { first.reject(new Error('过期错误')) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /OCR 识别/ })).toBeDisabled()
    await act(async () => { second.resolve(extraction([sn('NEW-001')])) })
    await screen.findByRole('checkbox', { name: /NEW-001/ })
  })

  it('预处理期间选新照片，旧图片不再发起 OCR', async () => {
    const prepared = deferred()
    mocks.prepareImage.mockReturnValueOnce(prepared.promise).mockResolvedValueOnce({ image_base64: 'new', media_type: 'image/jpeg' })
    mocks.ocrExtract.mockResolvedValue(extraction([sn('NEW-001')]))
    entry()
    selectPhoto('first.jpg')
    selectPhoto('second.jpg')
    await screen.findByRole('checkbox', { name: /NEW-001/ })
    await act(async () => { prepared.resolve({ image_base64: 'old', media_type: 'image/jpeg' }) })
    expect(mocks.ocrExtract).toHaveBeenCalledTimes(1)
    expect(mocks.ocrExtract.mock.calls[0][0].image_base64).toBe('new')
  })

  it('切换货品会取消请求，不让旧结果进入新货品', async () => {
    const pending = deferred()
    mocks.ocrExtract.mockReturnValue(pending.promise)
    const { onChange, rerender } = entry()
    selectPhoto()
    await waitFor(() => expect(mocks.ocrExtract).toHaveBeenCalledTimes(1))
    const signal = mocks.ocrExtract.mock.calls[0][1]
    rerender(<SerialEntry productId={2} value="新货品已有SN" onChange={onChange} />)
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(extraction([sn('OLD-001')])) })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('新货品已有SN')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('已有候选随货品切换作废，不能给新货品确认', async () => {
    mocks.ocrExtract.mockResolvedValue(extraction([sn('OLD-001')]))
    const { onChange, rerender } = entry()
    selectPhoto()
    await screen.findByRole('button', { name: '确认添加' })
    rerender(<SerialEntry productId={2} value="" onChange={onChange} />)
    expect(screen.queryByRole('button', { name: '确认添加' })).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('卸载会取消请求，迟到响应不会追加', async () => {
    const pending = deferred()
    mocks.ocrExtract.mockReturnValue(pending.promise)
    const { onChange, unmount } = entry()
    selectPhoto()
    await waitFor(() => expect(mocks.ocrExtract).toHaveBeenCalledTimes(1))
    const signal = mocks.ocrExtract.mock.calls[0][1]
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(extraction([sn('OLD-001')])) })
    expect(onChange).not.toHaveBeenCalled()
  })
})
