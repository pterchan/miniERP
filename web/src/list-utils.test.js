import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PRODUCT_PAGES,
  buildInventoryByProduct,
  enrichInventoryRows,
  fetchAllProductPages,
  formatInventorySummary,
  formatMoney,
  formatQuantity,
} from './list-utils'

describe('fetchAllProductPages', () => {
  it('starts at page one and stops as soon as the reported total is reached', async () => {
    const fetchPage = vi.fn(async page => page === 1
      ? { items: [{ product_id: 1 }, { product_id: 2 }], total: 3 }
      : { items: [{ product_id: 3 }], total: 3 })

    await expect(fetchAllProductPages(fetchPage)).resolves.toEqual([
      { product_id: 1 },
      { product_id: 2 },
      { product_id: 3 },
    ])
    expect(fetchPage.mock.calls).toEqual([[1, 100], [2, 100]])
  })

  it('stops on an empty page even when total has not been reached', async () => {
    const fetchPage = vi.fn(async page => page === 1
      ? { items: [{ product_id: 1 }], total: 20 }
      : { items: [], total: 20 })

    await expect(fetchAllProductPages(fetchPage, 7)).resolves.toEqual([{ product_id: 1 }])
    expect(fetchPage.mock.calls).toEqual([[1, 7], [2, 7]])
  })

  it('uses a safety limit when a server never returns an end condition', async () => {
    const fetchPage = vi.fn(async page => ({ items: [{ product_id: page }] }))

    const products = await fetchAllProductPages(fetchPage)

    expect(products).toHaveLength(MAX_PRODUCT_PAGES)
    expect(fetchPage).toHaveBeenCalledTimes(MAX_PRODUCT_PAGES)
  })

  it('propagates page request failures', async () => {
    const failure = new Error('catalogue unavailable')
    const fetchPage = vi.fn().mockRejectedValue(failure)

    await expect(fetchAllProductPages(fetchPage)).rejects.toBe(failure)
  })
})

describe('inventory list helpers', () => {
  it('aggregates quantities within a unit, never across units, and sorts unit codes', () => {
    const result = buildInventoryByProduct([
      { product_id: 7, uom_code: 'EA', on_hand_quantity: '10.000' },
      { product_id: 7, uom_code: 'BOX', on_hand_quantity: '3.000' },
      { product_id: 7, uom_code: 'EA', on_hand_quantity: '2.000' },
      { product_id: 8, uom_code: 'EA', on_hand_quantity: '4.500' },
    ])

    expect(result).toEqual(new Map([
      ['7', [
        { uom_code: 'BOX', quantity: 3 },
        { uom_code: 'EA', quantity: 12 },
      ]],
      ['8', [{ uom_code: 'EA', quantity: 4.5 }]],
    ]))
  })

  it('formats quantities without meaningless trailing zeroes', () => {
    expect(formatInventorySummary([
      { uom_code: 'EA', quantity: 12.000 },
      { uom_code: 'BOX', quantity: 3.500 },
    ])).toBe('12 EA · 3.5 BOX')
    expect(formatInventorySummary([])).toBe('无库存')
    expect(formatInventorySummary()).toBe('无库存')
  })

  it('aggregates NUMERIC(18,3) values without floating-point display noise', () => {
    const result = buildInventoryByProduct([
      { product_id: 9, uom_code: 'EA', on_hand_quantity: '0.100' },
      { product_id: 9, uom_code: 'EA', on_hand_quantity: '0.200' },
    ])

    expect(result.get('9')).toEqual([{ uom_code: 'EA', quantity: 0.3 }])
    expect(formatInventorySummary(result.get('9'))).toBe('0.3 EA')
  })

  it('enriches balance rows and supplies placeholders for missing catalogue data', () => {
    const rows = [
      { product_id: 1, product_name: '扭力扳手' },
      { product_id: 2, product_name: '螺丝刀' },
    ]
    const products = [{
      product_id: 1,
      identifier: '',
      manufacturer: '金工厂',
      specification: null,
    }]

    expect(enrichInventoryRows(rows, products)).toEqual([
      {
        product_id: 1,
        product_name: '扭力扳手',
        identifier: '—',
        manufacturer: '金工厂',
        specification: '—',
      },
      {
        product_id: 2,
        product_name: '螺丝刀',
        identifier: '—',
        manufacturer: '—',
        specification: '—',
      },
    ])
    expect(rows[0]).not.toHaveProperty('identifier')
  })
})

describe('formatQuantity', () => {
  it('drops the decimal for integral values and trims trailing zeros otherwise', () => {
    expect(formatQuantity('8.500')).toBe('8.5')
    expect(formatQuantity('12.000')).toBe('12')
    expect(formatQuantity(8.5)).toBe('8.5')
    expect(formatQuantity(12)).toBe('12')
    expect(formatQuantity('0')).toBe('0')
    expect(formatQuantity('0.100')).toBe('0.1')
    expect(formatQuantity('-7')).toBe('-7')
  })

  it('keeps placeholders and preserves unparsable values', () => {
    expect(formatQuantity(null)).toBe('—')
    expect(formatQuantity(undefined)).toBe('—')
    expect(formatQuantity('')).toBe('—')
    expect(formatQuantity('—')).toBe('—')
    expect(formatQuantity('待复核')).toBe('待复核')
  })

  it('respects the max scale', () => {
    expect(formatQuantity('8.12345', 3)).toBe('8.123')
    expect(formatQuantity('3.50', 2)).toBe('3.5')
  })
})

describe('formatMoney', () => {
  it('adds thousands separators and trims trailing zeros', () => {
    expect(formatMoney('1200')).toBe('1,200')
    expect(formatMoney(1200.5)).toBe('1,200.5')
    expect(formatMoney('1200.55')).toBe('1,200.55')
    expect(formatMoney(0)).toBe('0')
  })

  it('keeps placeholders', () => {
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney('')).toBe('—')
    expect(formatMoney('—')).toBe('—')
  })
})
