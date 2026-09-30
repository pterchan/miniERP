import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Button, DropdownMenu, EmptyState, Link, Skeleton, useRouter } from './ui'
import { stripBasePath, withBasePath } from './app-path'
import { DEFAULT_PAGE_SIZES, normalizeTableState, parseTableState, readTableViews, serializeTableState, tableViewSnapshot, writeTableViews } from './table-state'

const EMPTY_EXTRA = {}
const EMPTY_KEYS = []
const EMPTY_ROWS = []

function cellValue(row, col) {
  if (col.value) return col.value(row)
  return row[col.key] ?? ''
}

export function toServerFilters(filters, columns) {
  return columns.flatMap(col => {
    const value = filters[col.key]
    if (!['text', 'select'].includes(col.filterType) || value == null || value === '') return []
    return [`${col.key}:${col.filterType === 'select' ? 'eq' : 'contains'}:${value}`]
  })
}

// defaultFilters 是列筛选默认值；defaultQuery/queryKeys 声明可分享的业务参数。
// toolbar({query,setQuery}) 可编辑业务参数，filterRows(rows,query) 处理客户端派生条件。
// URL 有任一表格状态时整体优先，不再叠加默认视图或默认条件。
export default function DataTable({
  tableId, columns, rows = EMPTY_ROWS, mode = 'client', fetchData, rowKey, rowHref,
  rowAriaLabel, exportConfig, pageSizeOptions = DEFAULT_PAGE_SIZES, defaultPageSize = 50,
  defaultFilters = EMPTY_EXTRA, defaultQuery = EMPTY_EXTRA, queryKeys = EMPTY_KEYS,
  filterRows, empty = <EmptyState>暂无数据，请调整筛选或新增记录。</EmptyState>, loading = false,
  toolbar, footer, onError, pageExtra = EMPTY_EXTRA, selectable = true,
}) {
  if (!tableId) throw new Error('数据表需要唯一的 tableId')
  const router = useRouter()
  const userId = router.user?.user_id
  const location = router.location || { pathname: stripBasePath(window.location.pathname), search: window.location.search, hash: window.location.hash }
  const options = { columns, defaultPageSize, pageSizeOptions, defaultFilters, defaultQuery, queryKeys }
  const optionsRef = useRef(options); optionsRef.current = options
  const locationRef = useRef(location); locationRef.current = location
  const navigateRef = useRef(router.navigate); navigateRef.current = router.navigate
  const scope = `${userId ?? 'anonymous'}:${tableId}:${location.pathname}`
  const [views, setViews] = useState(() => readTableViews(userId, tableId))
  const [state, setState] = useState(() => {
    const saved = readTableViews(userId, tableId)
    return parseTableState(location.search, options, saved.views.find(view => view.id === saved.defaultId))
  })
  const stateRef = useRef(state); stateRef.current = state
  const pendingRef = useRef(false)
  const lastWrittenRef = useRef('')
  const lastReadRef = useRef(`${scope}|${location.search}`)
  const timerRef = useRef(null)
  const [selected, setSelected] = useState(() => new Set())
  const [serverData, setServerData] = useState(null)
  const [serverLoading, setServerLoading] = useState(mode === 'server')
  const [requestError, setRequestError] = useState(null)
  const [exportError, setExportError] = useState(null)
  const [viewError, setViewError] = useState(null)
  const [viewName, setViewName] = useState('')

  const listUrl = useCallback(() => {
    const current = locationRef.current
    return `${current.pathname}?${serializeTableState(stateRef.current, current.search, optionsRef.current)}${current.hash || ''}`
  }, [])

  const flush = useCallback(() => {
    clearTimeout(timerRef.current)
    if (!pendingRef.current) return
    pendingRef.current = false
    const to = listUrl()
    lastWrittenRef.current = to
    navigateRef.current(to, { replace: true, state: window.history.state })
  }, [listUrl])

  useEffect(() => {
    const source = `${scope}|${location.search}`
    if (lastReadRef.current === source) return
    lastReadRef.current = source
    const full = `${location.pathname}${location.search}${location.hash || ''}`
    if (lastWrittenRef.current === full) { lastWrittenRef.current = ''; return }
    clearTimeout(timerRef.current)
    pendingRef.current = false
    const saved = readTableViews(userId, tableId)
    setViews(saved)
    const next = parseTableState(location.search, optionsRef.current, saved.views.find(view => view.id === saved.defaultId))
    stateRef.current = next
    setState(next)
    setSelected(new Set())
    setServerData(null)
  }, [scope, location.pathname, location.search, tableId, userId])

  useEffect(() => {
    if (!pendingRef.current) return
    timerRef.current = setTimeout(flush, 300)
    return () => clearTimeout(timerRef.current)
  }, [state, flush])

  useEffect(() => {
    window.addEventListener('erp:before-navigate', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      clearTimeout(timerRef.current)
      window.removeEventListener('erp:before-navigate', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }, [flush])

  function updateState(patch, { keepPage = false, keepView = false } = {}) {
    const changes = typeof patch === 'function' ? patch(stateRef.current) : patch
    const next = { ...stateRef.current, ...changes }
    if (!keepPage) next.page = 1
    if (!keepView) next.viewId = ''
    stateRef.current = next
    pendingRef.current = true
    setState(next)
    setSelected(new Set())
  }

  const { q, filters, query, sortKey, sortDir, page, pageSize, hiddenCols, viewId } = state
  const searchCols = useMemo(() => columns.filter(col => col.filterType === 'search'), [columns])
  const searchKeys = useMemo(() => {
    const keys = searchCols.flatMap(col => col.searchKeys || [col.key])
    return keys.length ? keys : columns.map(col => col.key)
  }, [columns, searchCols])
  const deferredQ = useDeferredValue(q)
  const visibleColumns = columns.filter(col => !hiddenCols.includes(col.key))
  const clientRows = useMemo(() => {
    if (mode === 'server') return EMPTY_ROWS
    let list = filterRows ? filterRows([...rows], query) : [...rows]
    if (deferredQ) {
      const needle = deferredQ.toLocaleLowerCase()
      list = list.filter(row => searchKeys.some(key => String(row[key] ?? '').toLocaleLowerCase().includes(needle)))
    }
    for (const col of columns) {
      const value = filters[col.key]
      if (value == null || value === '') continue
      if (col.filter) list = list.filter(row => col.filter(row, value))
      else if (col.filterType === 'select') list = list.filter(row => String(cellValue(row, col)) === String(value))
      else if (col.filterType === 'text') list = list.filter(row => String(cellValue(row, col)).toLocaleLowerCase().includes(String(value).toLocaleLowerCase()))
    }
    const col = columns.find(column => column.key === sortKey)
    if (col) {
      const direction = sortDir === 'asc' ? 1 : -1
      const get = row => col.sortValue ? col.sortValue(row) : cellValue(row, col)
      list.sort((a, b) => {
        const av = get(a); const bv = get(b)
        if (av == null && bv == null) return 0
        if (av == null) return -direction
        if (bv == null) return direction
        return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-Hans-CN')) * direction
      })
    }
    return list
  }, [rows, columns, filters, deferredQ, sortKey, sortDir, mode, searchKeys, query, filterRows])

  const total = mode === 'server' ? Number(serverData?.total || 0) : clientRows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  // 服务端在首个结果到达前不裁剪页码，否则分享的第 2 页会先请求第 1 页。
  const currentPage = mode === 'server' ? page : Math.min(page, pageCount)
  const displayRows = mode === 'server' ? (serverData?.items || []) : clientRows.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const queryParams = useMemo(() => ({ ...query, ...pageExtra, q, f: toServerFilters(filters, columns), sort: sortKey, order: sortDir, page, page_size: pageSize }), [query, pageExtra, q, filters, columns, sortKey, sortDir, page, pageSize])
  const requestToken = useRef(0)
  useEffect(() => {
    if (mode !== 'server' || !fetchData) return undefined
    setServerLoading(true)
    // 新条件生效后清除上次结果，避免请求失败时旧记录和合计冒充当前筛选。
    setServerData(null)
    setRequestError(null)
    const controller = new AbortController()
    const token = ++requestToken.current
    const timer = setTimeout(() => {
      fetchData(queryParams, controller.signal).then(result => {
        if (token !== requestToken.current || controller.signal.aborted) return
        const resultPageCount = Math.max(1, Math.ceil(Number(result.total || 0) / queryParams.page_size))
        setServerData(result)
        setServerLoading(false)
        if (queryParams.page > resultPageCount) updateState({ page: resultPageCount }, { keepPage: true, keepView: true })
      }).catch(error => {
        if (error.name === 'AbortError' || token !== requestToken.current) return
        setServerLoading(false)
        setRequestError(error)
        if (onError) onError(error)
      })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [mode, fetchData, queryParams, onError])

  function setFilter(key, value) { updateState(prev => ({ filters: { ...prev.filters, [key]: value } })) }
  function setQuery(key, value) { updateState(prev => ({ query: { ...prev.query, [key]: value } })) }
  function toggleSort(key) { updateState({ sortKey: key, sortDir: sortKey === key && sortDir === 'asc' ? 'desc' : 'asc' }) }
  function toggleColumn(key) {
    updateState({ hiddenCols: hiddenCols.includes(key) ? hiddenCols.filter(value => value !== key) : [...hiddenCols, key] }, { keepPage: true })
  }
  function toggleRow(key) {
    setSelected(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }
  function togglePage() {
    setSelected(prev => {
      const next = new Set(prev)
      const keys = displayRows.map(rowKey)
      const all = keys.length > 0 && keys.every(key => next.has(key))
      keys.forEach(key => all ? next.delete(key) : next.add(key))
      return next
    })
  }

  function persistViews(next) {
    if (!writeTableViews(userId, tableId, next)) {
      setViewError('当前浏览器无法保存视图，请检查本机存储设置。')
      return false
    }
    setViewError(null)
    setViews(next)
    return true
  }
  function saveView(event) {
    event.preventDefault()
    const name = viewName.trim()
    if (!name) return
    const existing = views.views.find(view => view.name === name)
    const id = existing?.id || `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const saved = { id, name, state: tableViewSnapshot(stateRef.current) }
    if (persistViews({ ...views, views: [...views.views.filter(view => view.id !== id), saved] })) {
      updateState({ viewId: id }, { keepPage: true, keepView: true })
      setViewName('')
    }
  }
  function applyView(view) {
    const next = normalizeTableState({ ...view.state, page: 1, viewId: view.id }, optionsRef.current)
    updateState(next, { keepView: true })
  }
  function resetView() {
    updateState(normalizeTableState({ pageSize: defaultPageSize }, optionsRef.current))
  }

  const selectedKeys = [...selected]
  function doExport(fmt) {
    setExportError(null)
    const params = exportConfig.buildParams?.({ q, filters, sortKey, sortDir, query }, { ...query, ...pageExtra }) || { ...query, ...pageExtra, q, f: toServerFilters(filters, columns), sort: sortKey, order: sortDir }
    const sp = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value == null || value === '' || key === 'page' || key === 'page_size' || key === 'paginated') return
      if (Array.isArray(value)) value.forEach(item => sp.append(key, item)); else sp.set(key, String(value))
    })
    if (selectedKeys.length) sp.set('ids', selectedKeys.join(','))
    else if (exportConfig.allScope !== 'server') {
      const ids = (mode === 'server' ? serverData?.items || [] : clientRows).map(rowKey)
      if (!ids.length) { setExportError('当前没有可导出的行，请先调整筛选。'); return }
      sp.set('ids', ids.join(','))
    }
    sp.set('fmt', fmt)
    const url = `${exportConfig.endpoint}?${sp.toString()}`
    if (url.length > 6500) { setExportError('当前筛选结果过多，请收窄筛选条件，或改勾选部分行后导出。'); return }
    const anchor = document.createElement('a')
    anchor.href = withBasePath(url)
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const activeView = views.views.find(view => view.id === viewId)
  const hiddenFilters = columns.filter(col => hiddenCols.includes(col.key) && filters[col.key])
  const columnCount = visibleColumns.length + (selectable ? 1 : 0)
  return <div className="data-table" data-table-id={tableId}>
    <div className="dt-toolbar">
      <div className="dt-toolbar-main">
        <DropdownMenu label={activeView ? `视图：${activeView.name}` : '视图'}>
          <button type="button" role="menuitem" onClick={resetView}>全部记录</button>
          {views.views.map(view => <div key={view.id} className="dt-view-option">
            <button type="button" role="menuitem" onClick={() => applyView(view)}>{view.name}{views.defaultId === view.id ? '（默认）' : ''}</button>
            <button type="button" role="menuitem" aria-label={`${views.defaultId === view.id ? '取消默认' : '设为默认'}：${view.name}`} onClick={() => persistViews({ ...views, defaultId: views.defaultId === view.id ? '' : view.id })}>{views.defaultId === view.id ? '取消默认' : '设为默认'}</button>
            <button type="button" role="menuitem" aria-label={`删除视图：${view.name}`} onClick={() => { if (persistViews({ ...views, defaultId: views.defaultId === view.id ? '' : views.defaultId, views: views.views.filter(item => item.id !== view.id) }) && viewId === view.id) updateState({ viewId: '' }, { keepPage: true }) }}>删除</button>
          </div>)}
          <form className="dt-view-form" data-menu-keep-open onSubmit={saveView}>
            <label>视图名称<input aria-label="视图名称" value={viewName} maxLength={50} onChange={event => setViewName(event.target.value)} placeholder="例如：本周待审批" /></label>
            <Button type="submit" variant="secondary" size="sm" disabled={!viewName.trim()}>保存当前视图</Button>
          </form>
        </DropdownMenu>
        {selectedKeys.length > 0 && <span className="dt-selected">已选 {selectedKeys.length} 行 <button type="button" className="dt-link" onClick={() => setSelected(new Set())}>清除</button></span>}
        {toolbar && toolbar({ selected: selectedKeys, onClear: () => setSelected(new Set()), query, setQuery, filters, setFilter })}
      </div>
      <div className="dt-toolbar-tools">
        <DropdownMenu label="列">
          {columns.map(col => <label key={col.key} className="dt-column-option"><input type="checkbox" checked={!hiddenCols.includes(col.key)} disabled={!hiddenCols.includes(col.key) && visibleColumns.length === 1} onChange={() => toggleColumn(col.key)} />{col.label}</label>)}
        </DropdownMenu>
        {exportConfig && <DropdownMenu label="导出">{['csv', 'xlsx'].map(fmt => <button type="button" role="menuitem" key={fmt} onClick={() => doExport(fmt)}>{fmt.toUpperCase()} · {selectedKeys.length ? `已选 ${selectedKeys.length} 行` : '当前筛选全部'}</button>)}</DropdownMenu>}
      </div>
    </div>
    {(exportError || viewError || (requestError && !onError)) && <div className="alert error compact">{exportError || viewError || requestError?.message}</div>}
    {hiddenFilters.length > 0 && <div className="dt-filter-summary" aria-label="隐藏列筛选">{hiddenFilters.map(col => <button type="button" className="dt-filter-chip" key={col.key} onClick={() => setFilter(col.key, '')}>{col.label}：{col.filterOptions?.find(option => String(option.value) === filters[col.key])?.label || filters[col.key]} ×</button>)}</div>}
    {searchCols.length === 0 || searchCols.every(col => hiddenCols.includes(col.key)) ? <div className="dt-client-search"><input className="search" aria-label="搜索表格" placeholder="搜索…" value={q} onChange={event => updateState({ q: event.target.value })} /></div> : null}
    <div className="dt-scroll">
      <table className="dt" aria-busy={loading || serverLoading}>
        <thead><tr>
          {selectable && <th className="dt-checkbox-cell"><input type="checkbox" onChange={togglePage} checked={displayRows.length > 0 && displayRows.every(row => selected.has(rowKey(row)))} aria-label="全选本页" /></th>}
          {visibleColumns.map(col => <th key={col.key} className={col.align === 'end' ? 'align-end num' : ''} aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
            <div className="dt-th-inner">{col.sortable !== false ? <button type="button" className={`dt-sort ${sortKey === col.key ? 'active' : ''}`} onClick={() => toggleSort(col.key)}>{col.label}{sortKey === col.key && <span className="dt-sort-ind">{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>}</button> : <span>{col.label}</span>}</div>
            {col.filterType === 'search' && <input className="dt-filter-search" aria-label={`搜索${col.label}`} placeholder="搜索…" value={q} onChange={event => updateState({ q: event.target.value })} />}
            {col.filterType === 'text' && <input className="dt-filter" aria-label={`筛选${col.label}`} value={filters[col.key] || ''} onChange={event => setFilter(col.key, event.target.value)} placeholder="筛选…" />}
            {col.filterType === 'select' && <select className="dt-filter" aria-label={`筛选${col.label}`} value={filters[col.key] || ''} onChange={event => setFilter(col.key, event.target.value)}><option value="">全部</option>{(col.filterOptions || []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
          </th>)}
        </tr></thead>
        <tbody>
          {loading || serverLoading ? Array.from({ length: 5 }, (_, index) => <tr key={index} className="dt-skeleton-row"><td colSpan={columnCount}><Skeleton rows={1} /></td></tr>) : displayRows.length === 0 ? <tr><td colSpan={columnCount}>{empty}</td></tr> : displayRows.map(row => {
            const key = rowKey(row)
            const href = rowHref?.(row)
            return <tr key={key} className={selected.has(key) ? 'selected' : ''} aria-label={rowAriaLabel?.(row)}>
              {selectable && <td className="dt-checkbox-cell"><input type="checkbox" checked={selected.has(key)} onChange={() => toggleRow(key)} aria-label="选择行" /></td>}
              {visibleColumns.map(col => <td key={col.key} className={`${col.className || ''} ${col.align === 'end' ? 'align-end num' : ''}`.trim()} data-label={col.label}>{href && !col.noRowLink ? <Link className="dt-cell-link" to={href} state={{ returnTo: listUrl() }} onClick={flush}>{col.render ? col.render(row, col) : cellValue(row, col)}</Link> : (col.render ? col.render(row, col) : cellValue(row, col))}</td>)}
            </tr>
          })}
        </tbody>
      </table>
    </div>
    <div className="dt-footer">
      <div className="dt-page-size">每页 <select aria-label="每页行数" value={pageSize} onChange={event => updateState({ pageSize: Number(event.target.value) })}>{pageSizeOptions.map(size => <option key={size} value={size}>{size}</option>)}</select> 行</div>
      <div className="dt-pagination"><span className="muted">共 {total} 条</span><button type="button" aria-label="第一页" disabled={currentPage === 1} onClick={() => updateState({ page: 1 }, { keepPage: true, keepView: true })}>«</button><button type="button" aria-label="上一页" disabled={currentPage === 1} onClick={() => updateState({ page: currentPage - 1 }, { keepPage: true, keepView: true })}>‹</button><span className="dt-page-info">{currentPage} / {Math.max(currentPage, pageCount)}</span><button type="button" aria-label="下一页" disabled={currentPage >= pageCount || serverLoading} onClick={() => updateState({ page: currentPage + 1 }, { keepPage: true, keepView: true })}>›</button><button type="button" aria-label="最后一页" disabled={currentPage >= pageCount || serverLoading} onClick={() => updateState({ page: pageCount }, { keepPage: true, keepView: true })}>»</button></div>
    </div>
    {footer && <div className="dt-summary">{footer(mode === 'server' ? serverData : { items: clientRows, total })}</div>}
  </div>
}
