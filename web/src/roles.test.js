import { describe, expect, it } from 'vitest'
import { canEdit, canView } from './roles'

describe('write-permission map', () => {
  it('only ADMIN may create units (backend POST /api/uoms is ADMIN-only)', () => {
    expect(canEdit({ role: 'ADMIN' }, 'uom')).toBe(true)
    expect(canEdit({ role: 'WAREHOUSE' }, 'uom')).toBe(false)
    expect(canEdit({ role: 'SALES' }, 'uom')).toBe(false)
  })

  it('degrades safely for unknown resources and missing user', () => {
    expect(canEdit(null, 'uom')).toBe(false)
    expect(canEdit({ role: 'ADMIN' }, 'no-such-resource')).toBe(false)
  })

  it('keeps view access unchanged', () => {
    expect(canView({ role: 'COLLEAGUE' }, 'products')).toBe(true)
    expect(canView({ role: 'COLLEAGUE' }, 'system')).toBe(false)
  })
})
