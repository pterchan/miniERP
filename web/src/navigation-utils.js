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
    return current === '/' || current === '/inventory' || current.startsWith('/inventory/')
  }

  return current === destination || current.startsWith(`${destination}/`)
}
