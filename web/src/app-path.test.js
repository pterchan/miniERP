import { describe, expect, it } from 'vitest'
import { makePathHelpers } from './app-path'

describe('ERP public path helpers', () => {
  it('keeps development root URLs unchanged', () => {
    const { withBasePath, stripBasePath } = makePathHelpers('/')
    expect(withBasePath('/products')).toBe('/products')
    expect(withBasePath('/api/auth/me')).toBe('/api/auth/me')
    expect(stripBasePath('/products?tab=stock')).toBe('/products?tab=stock')
  })

  it('adds and removes the production /erp prefix', () => {
    const { withBasePath, stripBasePath } = makePathHelpers('/erp/')
    expect(withBasePath('/')).toBe('/erp/')
    expect(withBasePath('/products/7')).toBe('/erp/products/7')
    expect(withBasePath('/api/auth/me')).toBe('/erp/api/auth/me')
    expect(stripBasePath('/erp/')).toBe('/')
    expect(stripBasePath('/erp/products/7?tab=stock')).toBe('/products/7?tab=stock')
    expect(stripBasePath('/other')).toBe('/other')
  })
})
