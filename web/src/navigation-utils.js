export function normalizePath(path) {
  const pathname = String(path || '/').split(/[?#]/, 1)[0] || '/'
  const absolutePath = pathname.startsWith('/') ? pathname : `/${pathname}`
  return absolutePath.replace(/\/+$/, '') || '/'
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
