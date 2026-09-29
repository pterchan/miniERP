import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentRoute } from './documents'

const documentMock = vi.fn()
vi.mock('./api', () => ({
  default: {
    document: (...a) => documentMock(...a),
    locations: async () => [], uoms: async () => [], customers: async () => [], suppliers: async () => [],
    products: async () => ({ items: [] }), productStocks: async () => ({ items: {} }),
  },
}))

afterEach(cleanup)

const WAREHOUSE_USER = { user_id: 1, role: 'WAREHOUSE' }

function renderEdit(doc) {
  documentMock.mockResolvedValue(doc)
  return render(documentRoute('purchase', ['purchase', 'purchase_order', '7', 'edit'], WAREHOUSE_USER))
}

describe('document edit route guard', () => {
  it('shows Forbidden for a document that is not editable by this user', async () => {
    renderEdit({ document_id: 7, doc_type: 'PURCHASE_ORDER', status: 'POSTED', created_by: 1 })
    await waitFor(() => expect(screen.getByText('无权访问')).toBeInTheDocument())
  })

  it('shows the form for the draft creator', async () => {
    renderEdit({ document_id: 7, doc_type: 'PURCHASE_ORDER', status: 'DRAFT', created_by: 1, lines: [] })
    await waitFor(() => expect(screen.getByText(/编辑采购订单/)).toBeInTheDocument())
  })

  it('shows Forbidden for a non-creator on someone else\'s draft', async () => {
    documentMock.mockResolvedValue({ document_id: 7, doc_type: 'PURCHASE_ORDER', status: 'DRAFT', created_by: 99, lines: [] })
    render(documentRoute('purchase', ['purchase', 'purchase_order', '7', 'edit'], WAREHOUSE_USER))
    await waitFor(() => expect(screen.getByText('无权访问')).toBeInTheDocument())
  })
})
