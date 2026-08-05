import { describe, expect, it } from 'vitest'
import { isNavigationItemActive, normalizePath } from './navigation-utils'

describe('normalizePath', () => {
  it('normalizes list routes before page dispatch', () => {
    expect(normalizePath('/products/')).toBe('/products')
    expect(normalizePath('/requests/?status=pending')).toBe('/requests')
    expect(normalizePath('/admin///')).toBe('/admin')
  })
})

describe('isNavigationItemActive', () => {
  it('activates the home item only for home and inventory routes', () => {
    expect(isNavigationItemActive('/', '/')).toBe(true)
    expect(isNavigationItemActive('/inventory', '/')).toBe(true)
    expect(isNavigationItemActive('/inventory/stock-42', '/')).toBe(true)
    expect(isNavigationItemActive('/products', '/')).toBe(false)
  })

  it.each([
    ['/products', '/products'],
    ['/products/42', '/products'],
    ['/requests/pending/7', '/requests'],
    ['/admin/users', '/admin'],
  ])('activates %s under its %s navigation item', (currentPath, to) => {
    expect(isNavigationItemActive(currentPath, to)).toBe(true)
  })

  it('does not match similar route prefixes', () => {
    expect(isNavigationItemActive('/products-x', '/products')).toBe(false)
    expect(isNavigationItemActive('/request-status', '/requests')).toBe(false)
    expect(isNavigationItemActive('/administrator', '/admin')).toBe(false)
    expect(isNavigationItemActive('/inventory-old', '/')).toBe(false)
  })

  it('ignores query strings, hashes, and trailing slashes', () => {
    expect(isNavigationItemActive('/products/?page=2#results', '/products/')).toBe(true)
    expect(isNavigationItemActive('/requests/8/?view=compact', '/requests?scope=all')).toBe(true)
    expect(isNavigationItemActive('/inventory/42/#history', '/?from=nav')).toBe(true)
  })
})
