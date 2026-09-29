import { afterEach, describe, expect, it, vi } from 'vitest'
import api, { setUnauthorizedHandler } from './api'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
afterEach(() => { fetchMock.mockReset() })

function lastUrl() {
  const raw = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]
  return new URL(raw, 'http://testserver')
}

describe('401 global handling', () => {
  it('invokes the handler for non-auth paths on 401', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: '登录已失效' }), { status: 401 }))
    await expect(api.request('/uoms')).rejects.toMatchObject({ status: 401 })
    expect(handler).toHaveBeenCalledTimes(1)
    setUnauthorizedHandler(null)
  })

  it('does not invoke the handler for /auth paths (avoids login-page loops)', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'x' }), { status: 401 }))
    await expect(api.request('/auth/me')).rejects.toMatchObject({ status: 401 })
    expect(handler).not.toHaveBeenCalled()
    setUnauthorizedHandler(null)
  })
})

describe('api list query serialization', () => {
  it('serializes repeated filter params individually for /documents', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }))
    await api.documents({ f: ['doc_no:contains:PO', 'party_name:contains:客'], page: 2 })
    const url = lastUrl()
    expect(url.searchParams.getAll('f')).toEqual(['doc_no:contains:PO', 'party_name:contains:客'])
    expect(url.searchParams.get('page')).toBe('2')
  })

  it('keeps extra scalar params like doc_type and drops empty values', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }))
    await api.documents({ doc_type: 'PURCHASE_ORDER', q: '', page: 1 })
    const url = lastUrl()
    expect(url.searchParams.get('doc_type')).toBe('PURCHASE_ORDER')
    expect(url.searchParams.has('q')).toBe(false)
  })

  it('serializes serial-ledger filters the same way', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }))
    await api.serialLedger({ f: ['status_code:eq:active'], page_size: 50 })
    const url = lastUrl()
    expect(url.searchParams.getAll('f')).toEqual(['status_code:eq:active'])
    expect(url.searchParams.get('page_size')).toBe('50')
  })
})
