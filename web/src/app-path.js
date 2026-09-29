/**
 * Browser-visible application path. Vite replaces BASE_URL at build time;
 * development keeps the historical root path while production is mounted at
 * /erp/ by the host gateway.
 */
export function makePathHelpers(configuredBase = '/') {
  const basePath = configuredBase === '/'
    ? ''
    : `/${configuredBase.replace(/^\/+|\/+$/g, '')}`

  function withBasePath(path = '/') {
    const value = String(path || '/')
    const match = value.match(/^([^?#]*)(.*)$/s)
    const pathname = match?.[1] || '/'
    const suffix = match?.[2] || ''
    const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`
    return `${basePath}${normalized === '/' ? '/' : normalized}${suffix}`
  }

  function stripBasePath(path = '/') {
    const value = String(path || '/')
    if (!basePath) return value
    const match = value.match(/^([^?#]*)(.*)$/s)
    const pathname = match?.[1] || '/'
    const suffix = match?.[2] || ''
    if (pathname === basePath) return `/${suffix}`
    if (pathname.startsWith(`${basePath}/`)) {
      return `${pathname.slice(basePath.length) || '/'}${suffix}`
    }
    return value
  }

  return { basePath, withBasePath, stripBasePath }
}

const helpers = makePathHelpers(import.meta.env.BASE_URL || '/')
export const APP_BASE_PATH = helpers.basePath
export const { withBasePath, stripBasePath } = helpers
