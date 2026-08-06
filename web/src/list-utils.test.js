import { describe, expect, it } from 'vitest'
import {
  formatInventorySummary,
  formatMoney,
  formatQuantity,
} from './list-utils'

describe('inventory list helpers', () => {
  it('formats quantities without meaningless trailing zeroes', () => {
    expect(formatInventorySummary([
      { uom_code: 'EA', quantity: 12.000 },
      { uom_code: 'BOX', quantity: 3.500 },
    ])).toBe('12 EA · 3.5 BOX')
    expect(formatInventorySummary([])).toBe('无库存')
    expect(formatInventorySummary()).toBe('无库存')
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
