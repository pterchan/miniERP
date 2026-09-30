export function normalizePath(path) {
  const pathname = String(path || '/').split(/[?#]/, 1)[0] || '/'
  const absolutePath = pathname.startsWith('/') ? pathname : `/${pathname}`
  // 折叠重复斜杠（手输 //products 这类路径），否则严格相等匹配会落错路由
  return absolutePath.replace(/\/+/g, '/').replace(/\/+$/, '') || '/'
}

/** Return whether a path under /inventory belongs to the inventory document group.
 *
 * `/inventory` and `/inventory/{docType}[…]` are document-group routes (dispatch to
 * documentRoute); `/inventory/{product_id}/{location_id}/{condition_id}/{uom_id}` is an
 * inventory-balance detail page. `docSlugs` are the lowercase doc-type segments, e.g.
 * `['stock_transfer', 'stock_count', 'stock_loss', 'other_in', 'other_out']`.
 */
export function isInventoryDocumentPath(path, docSlugs = []) {
  const parts = normalizePath(path).split('/').filter(Boolean)
  if (parts[0] !== 'inventory') return false
  if (parts.length === 1) return true
  const slugs = docSlugs.map(slug => String(slug).toLowerCase())
  return slugs.includes(String(parts[1]).toLowerCase())
}

/** Return whether a navigation destination owns the current route. */
export function isNavigationItemActive(currentPath, to) {
  const current = normalizePath(currentPath)
  const destination = normalizePath(to)

  if (destination === '/') {
    return current === '/'
  }

  return current === destination || current.startsWith(`${destination}/`)
}

/** 旧路径保留，模块归属不依赖共同路径前缀。 */
export function moduleForPath(path) {
  const p = normalizePath(path)
  if (p === '/') return 'home'
  if (p.startsWith('/master/customers')) return 'sales'
  if (p.startsWith('/master/suppliers')) return 'purchase'
  if (p.startsWith('/admin/locations') || p.startsWith('/products') || p.startsWith('/master')) return 'master'
  if (p.startsWith('/count') || p.startsWith('/serials') || p.startsWith('/inventory')) return 'inventory'
  if (p.startsWith('/conflicts') || p.startsWith('/audit') || p.startsWith('/admin')) return 'admin'
  return p.split('/')[1]
}
