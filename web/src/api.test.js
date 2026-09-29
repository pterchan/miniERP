import { afterEach, describe, expect, it, vi } from 'vitest'
import api from './api'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
afterEach(() => { fetchMock.mockReset() })

function lastUrl() {
  const raw = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]
  return new URL(raw, 'http://testserver')
}

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
