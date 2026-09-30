import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api, { invalidateInventory, invalidateWorkbench, setApiUser, setUnauthorizedHandler } from './api'

const USER_A = { user_id: 10, role: 'ADMIN' }
const USER_B = { user_id: 20, role: 'WAREHOUSE' }
const fetchMock = vi.fn()
let removeListeners = []
function response(value, status = 200) { return new Response(JSON.stringify(value), { status }) }
function deferred() {
  let resolve, reject
  const promise = new Promise((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}
function listen(type, handler) {
  window.addEventListener(type, handler)
  removeListeners.push(() => window.removeEventListener(type, handler))
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  setApiUser(USER_A)
  invalidateInventory()
  invalidateWorkbench()
})
afterEach(() => {
  removeListeners.forEach(remove => remove()); removeListeners = []
  setUnauthorizedHandler(null)
  setApiUser(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('请求与登录会话隔离', () => {
  it('切换账号后，旧 fetch 的迟到 401 不退出新账号或清空新工作台缓存', async () => {
    const pending = deferred()
    const unauthorized = vi.fn()
    setUnauthorizedHandler(unauthorized)
    fetchMock.mockReturnValueOnce(pending.promise)
    const oldRequest = api.request('/uoms')
    const oldResult = expect(oldRequest).rejects.toMatchObject({ status: 401 })
    setApiUser(USER_B)
    fetchMock.mockResolvedValueOnce(response({ my_draft_requests: 2 }))
    const newSummary = api.workbench()
    await newSummary
    pending.resolve(response({ detail: '旧会话已失效' }, 401))
    await oldResult
    expect(unauthorized).not.toHaveBeenCalled()
    expect(api.workbench()).toBe(newSummary)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('退出后用同一账号重新登录，仍忽略上一会话的 401', async () => {
    const pending = deferred()
    const unauthorized = vi.fn()
    setUnauthorizedHandler(unauthorized)
    fetchMock.mockReturnValueOnce(pending.promise)
    const oldRequest = api.request('/products')
    const oldResult = expect(oldRequest).rejects.toMatchObject({ status: 401 })
    setApiUser(null)
    setApiUser(USER_A)
    pending.resolve(response({ detail: '旧会话已失效' }, 401))
    await oldResult
    expect(unauthorized).not.toHaveBeenCalled()
  })

  it('当前会话的并发 401 只触发一次退出处理', async () => {
    const first = deferred(), second = deferred()
    const unauthorized = vi.fn()
    setUnauthorizedHandler(unauthorized)
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const firstResult = expect(api.request('/uoms')).rejects.toMatchObject({ status: 401 })
    const secondResult = expect(api.request('/locations')).rejects.toMatchObject({ status: 401 })
    first.resolve(response({ detail: '登录已失效' }, 401))
    await firstResult
    second.resolve(response({ detail: '登录已失效' }, 401))
    await secondResult
    expect(unauthorized).toHaveBeenCalledTimes(1)
  })

  it('XHR 上传同样隔离旧会话的 401，当前会话 401 仍触发退出', async () => {
    const instances = []
    class MockXHR {
      constructor() { this.upload = {}; instances.push(this) }
      open() {}
      setRequestHeader() {}
      getResponseHeader() { return null }
      send() {}
      reply(status) { this.status = status; this.response = { detail: '登录已失效' }; this.onload() }
    }
    vi.stubGlobal('XMLHttpRequest', MockXHR)
    const unauthorized = vi.fn()
    setUnauthorizedHandler(unauthorized)
    const oldResult = expect(api.requestUpload('/attachments', new FormData())).rejects.toMatchObject({ status: 401 })
    setApiUser(USER_B)
    instances[0].reply(401)
    await oldResult
    expect(unauthorized).not.toHaveBeenCalled()
    const currentResult = expect(api.requestUpload('/attachments', new FormData())).rejects.toMatchObject({ status: 401 })
    instances[1].reply(401)
    await currentResult
    expect(unauthorized).toHaveBeenCalledTimes(1)
  })
})

describe('工作台与库存缓存', () => {
  it('同一账号并发工作台请求去重，60 秒后重新请求', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10000)
    const pending = deferred()
    fetchMock.mockReturnValueOnce(pending.promise)
    const first = api.workbench()
    expect(api.workbench()).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    pending.resolve(response({ my_draft_requests: 4 }))
    await expect(first).resolves.toEqual({ my_draft_requests: 4 })
    now.mockReturnValue(69999)
    expect(api.workbench()).toBe(first)
    now.mockReturnValue(70000)
    fetchMock.mockResolvedValueOnce(response({ my_draft_requests: 5 }))
    const refreshed = api.workbench()
    expect(refreshed).not.toBe(first)
    await expect(refreshed).resolves.toEqual({ my_draft_requests: 5 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('切换账号同时清空两种缓存，同一账号的信息刷新不清空', async () => {
    fetchMock.mockResolvedValueOnce(response({ my_draft_requests: 1 })).mockResolvedValueOnce(response([{ product_id: 1 }]))
    const oldWorkbench = api.workbench(), oldInventory = api.inventory()
    await Promise.all([oldWorkbench, oldInventory])
    setApiUser({ ...USER_A, display_name: '更新姓名' })
    expect(api.workbench()).toBe(oldWorkbench)
    expect(api.inventory()).toBe(oldInventory)
    setApiUser(USER_B)
    fetchMock.mockResolvedValueOnce(response({ my_draft_requests: 2 })).mockResolvedValueOnce(response([{ product_id: 2 }]))
    const newWorkbench = api.workbench(), newInventory = api.inventory()
    expect(newWorkbench).not.toBe(oldWorkbench)
    expect(newInventory).not.toBe(oldInventory)
    await Promise.all([newWorkbench, newInventory])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('库存旧请求失败不会清掉失效后建立的新缓存', async () => {
    const old = deferred()
    fetchMock.mockReturnValueOnce(old.promise)
    const oldResult = expect(api.inventory()).rejects.toThrow('旧请求网络错误')
    invalidateInventory()
    fetchMock.mockResolvedValueOnce(response([{ product_id: 2 }]))
    const latest = api.inventory()
    await latest
    old.reject(new Error('旧请求网络错误'))
    await oldResult
    expect(api.inventory()).toBe(latest)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('工作台旧请求失败不会清掉更新后的缓存', async () => {
    const old = deferred()
    fetchMock.mockReturnValueOnce(old.promise)
    const oldResult = expect(api.workbench()).rejects.toThrow('旧请求网络错误')
    invalidateWorkbench()
    fetchMock.mockResolvedValueOnce(response({ my_draft_requests: 9 }))
    const latest = api.workbench()
    await latest
    old.reject(new Error('旧请求网络错误'))
    await oldResult
    expect(api.workbench()).toBe(latest)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('工作台旧成功响应不会替换更新后的缓存', async () => {
    const old = deferred()
    fetchMock.mockReturnValueOnce(old.promise)
    const oldResult = api.workbench()
    invalidateWorkbench()
    fetchMock.mockResolvedValueOnce(response({ my_draft_requests: 9 }))
    const latest = api.workbench()
    await latest
    old.resolve(response({ my_draft_requests: 1 }))
    await oldResult
    expect(api.workbench()).toBe(latest)
    await expect(api.workbench()).resolves.toEqual({ my_draft_requests: 9 })
  })

  it('当前库存请求失败会清缓存，下一次调用可以重试', async () => {
    fetchMock.mockRejectedValueOnce(new Error('网络错误'))
    await expect(api.inventory()).rejects.toThrow('网络错误')
    fetchMock.mockResolvedValueOnce(response([{ product_id: 3 }]))
    await expect(api.inventory()).resolves.toEqual([{ product_id: 3 }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('业务写入后工作台缓存失效', () => {
  it('成功写入使缓存失效并通知已挂载工作台立即刷新，多个监听者继续共享请求', async () => {
    fetchMock.mockResolvedValueOnce(response({ my_draft_requests: 1 }))
      .mockResolvedValueOnce(response({ document_id: 3 }))
      .mockResolvedValueOnce(response({ my_draft_requests: 2 }))
    const initial = api.workbench()
    await initial
    const refreshed = []
    const onInvalidate = vi.fn(() => { refreshed.push(api.workbench(), api.workbench()) })
    const onMutation = vi.fn()
    listen('erp:workbench-invalidated', onInvalidate)
    listen('erp:mutation', onMutation)
    await api.request('/documents', { method: 'POST', body: '{}' })
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    expect(onMutation).toHaveBeenCalledTimes(1)
    expect(onMutation.mock.calls[0][0].detail).toEqual({ path: '/documents', method: 'POST' })
    expect(refreshed[0]).not.toBe(initial)
    expect(refreshed[0]).toBe(refreshed[1])
    await expect(refreshed[0]).resolves.toEqual({ my_draft_requests: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('失败写入保留缓存且不广播业务变更', async () => {
    fetchMock.mockResolvedValueOnce(response({ my_draft_requests: 1 })).mockResolvedValueOnce(response({ detail: '版本已变化' }, 409))
    const cached = api.workbench()
    await cached
    const onInvalidate = vi.fn(), onMutation = vi.fn()
    listen('erp:workbench-invalidated', onInvalidate)
    listen('erp:mutation', onMutation)
    await expect(api.request('/documents/3', { method: 'PUT', body: '{}' })).rejects.toMatchObject({ status: 409 })
    expect(onInvalidate).not.toHaveBeenCalled()
    expect(onMutation).not.toHaveBeenCalled()
    expect(api.workbench()).toBe(cached)
  })

  it('204 删除成功也失效缓存，认证与 OCR 请求不触发业务刷新', async () => {
    fetchMock.mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({})).mockResolvedValueOnce(new Response(null, { status: 204 }))
    const onInvalidate = vi.fn()
    listen('erp:workbench-invalidated', onInvalidate)
    await api.request('/auth/change-password', { method: 'POST', body: '{}' })
    await api.request('/ocr/extract', { method: 'POST', body: '{}' })
    expect(onInvalidate).not.toHaveBeenCalled()
    await api.request('/products/1/images/3', { method: 'DELETE' })
    expect(onInvalidate).toHaveBeenCalledTimes(1)
  })
})
