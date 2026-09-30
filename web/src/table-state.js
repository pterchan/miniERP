// 表格地址状态与本机视图：URL 是分享和返回时的完整来源，视图按账号隔离。
const TABLE_KEYS = ['q', 'sort', 'order', 'page', 'ps', 'cols', 'view']
export const DEFAULT_PAGE_SIZES = [10, 25, 50, 100, 200, 500]

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function normalizeTableState(value, options = {}) {
  const { columns = [], defaultPageSize = 50, pageSizeOptions = DEFAULT_PAGE_SIZES, defaultFilters = {}, defaultQuery = {}, queryKeys = [] } = options
  const source = safeObject(value)
  const allowedQueryKeys = [...new Set([...Object.keys(defaultQuery), ...queryKeys])]
  const columnKeys = new Set(columns.map(col => col.key))
  const filterColumns = columns.filter(col => ['text', 'select'].includes(col.filterType))
  const filters = {}
  const sourceFilters = safeObject(source.filters)
  for (const col of filterColumns) {
    const raw = sourceFilters[col.key]
    if (raw != null && String(raw) !== '') filters[col.key] = String(raw)
  }
  const query = {}
  const sourceQuery = safeObject(source.query)
  for (const key of allowedQueryKeys) {
    if (sourceQuery[key] != null) query[key] = String(sourceQuery[key])
  }
  const hiddenCols = [...new Set(Array.isArray(source.hiddenCols) ? source.hiddenCols : [])].filter(key => columnKeys.has(key))
  // 至少保留一个可阅读的业务列；选择列不能成为唯一可见内容。
  if (columns.length && hiddenCols.length === columns.length) hiddenCols.splice(hiddenCols.indexOf(columns[0].key), 1)
  const pageSize = Number(source.pageSize)
  const page = Number(source.page)
  return {
    q: typeof source.q === 'string' ? source.q : '',
    filters,
    sortKey: columns.some(col => col.key === source.sortKey && col.sortable !== false) ? source.sortKey : '',
    sortDir: source.sortDir === 'desc' ? 'desc' : 'asc',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: pageSizeOptions.includes(pageSize) ? pageSize : defaultPageSize,
    hiddenCols,
    query,
    viewId: typeof source.viewId === 'string' ? source.viewId : '',
  }
}

export function hasTableQuery(search, options = {}) {
  const params = new URLSearchParams(search)
  const extra = [...Object.keys(options.defaultQuery || {}), ...(options.queryKeys || [])]
  return [...params.keys()].some(key => TABLE_KEYS.includes(key) || key.startsWith('f.') || extra.includes(key))
}

export function parseTableState(search, options = {}, defaultView = null) {
  const params = new URLSearchParams(search)
  if (!hasTableQuery(search, options)) {
    return normalizeTableState(defaultView ? { ...defaultView.state, page: 1, viewId: defaultView.id } : {
      filters: options.defaultFilters,
      query: options.defaultQuery,
      pageSize: options.defaultPageSize,
    }, options)
  }
  const filters = {}
  for (const [key, value] of params) if (key.startsWith('f.')) filters[key.slice(2)] = value
  const query = {}
  for (const key of [...Object.keys(options.defaultQuery || {}), ...(options.queryKeys || [])]) {
    if (params.has(key)) query[key] = params.get(key)
  }
  return normalizeTableState({
    q: params.get('q') || '', filters, query,
    sortKey: params.get('sort') || '', sortDir: params.get('order'),
    page: params.get('page'), pageSize: params.get('ps'),
    hiddenCols: (params.get('cols') || '').split(',').filter(Boolean),
    viewId: params.get('view') || '',
  }, options)
}

export function serializeTableState(state, search = '', options = {}) {
  const params = new URLSearchParams(search)
  const extra = [...Object.keys(options.defaultQuery || {}), ...(options.queryKeys || [])]
  for (const key of [...params.keys()]) {
    if (TABLE_KEYS.includes(key) || key.startsWith('f.') || extra.includes(key)) params.delete(key)
  }
  // 显式空值同样保留，防止分享链接在另一台电脑被其默认视图覆盖。
  params.set('q', state.q)
  params.set('sort', state.sortKey)
  params.set('order', state.sortDir)
  params.set('page', String(state.page))
  params.set('ps', String(state.pageSize))
  params.set('cols', state.hiddenCols.join(','))
  for (const key of Object.keys(state.filters).sort()) if (state.filters[key] !== '') params.set(`f.${key}`, state.filters[key])
  for (const key of Object.keys(state.query).sort()) if (state.query[key] !== '') params.set(key, state.query[key])
  if (state.viewId) params.set('view', state.viewId)
  return params.toString()
}

export function viewStorageKey(userId, tableId) {
  return `erp.view.${userId}.${tableId}`
}

export function readTableViews(userId, tableId) {
  if (userId == null) return { version: 1, defaultId: '', views: [] }
  try {
    const saved = JSON.parse(localStorage.getItem(viewStorageKey(userId, tableId)) || 'null')
    if (saved?.version !== 1 || !Array.isArray(saved.views)) throw new Error('视图格式无效')
    return { version: 1, defaultId: typeof saved.defaultId === 'string' ? saved.defaultId : '', views: saved.views.filter(view => view && typeof view.id === 'string' && typeof view.name === 'string' && view.state && typeof view.state === 'object') }
  } catch {
    return { version: 1, defaultId: '', views: [] }
  }
}

export function writeTableViews(userId, tableId, value) {
  if (userId == null) return false
  try { localStorage.setItem(viewStorageKey(userId, tableId), JSON.stringify(value)); return true } catch { return false }
}

export function tableViewSnapshot(state) {
  const { page, viewId, ...snapshot } = state
  return snapshot
}
