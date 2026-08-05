import React, { useEffect, useMemo, useState } from 'react'
import { Empty } from './ui'

const EMPTY_EXTRA = {} // 稳定引用，避免默认对象每次渲染都改变、触发拉取 effect 重置

// 统一数据表组件：客户端/服务端双模式。
// - 客户端模式（mode='client'）：rows 全量在内存，排序/筛选/分页在浏览器完成；
// - 服务端模式（mode='server'）：fetchData(params) 拉页，排序/筛选/分页交给后端。
// 均支持按列筛选、排序、每页行数（最大 500）、行多选，以及 CSV/XLSX 导出
// （导出「当前筛选全部」或「已选行」）。

function cellValue(row, col) {
  if (col.value) return col.value(row)
  const v = row[col.key]
  return v == null ? '' : v
}

export function toServerFilters(filters, columns) {
  const f = []
  for (const col of columns) {
    if (col.filterType !== 'text' && col.filterType !== 'select') continue
    const val = filters[col.key]
    if (val == null || val === '') continue
    f.push(`${col.key}:${col.filterType === 'select' ? 'eq' : 'contains'}:${val}`)
  }
  return f
}

export default function DataTable({
  columns,
  rows = [],
  mode = 'client',
  fetchData,
  rowKey,
  rowHref,
  rowAriaLabel,
  exportConfig,
  pageSizeOptions = [10, 25, 50, 100, 200, 500],
  defaultPageSize = 50,
  empty = <Empty>暂无数据</Empty>,
  loading = false,
  toolbar,
  onError,
  pageExtra = EMPTY_EXTRA,
}) {
  const [sortKey, setSortKey] = useState('')
  const [sortDir, setSortDir] = useState('asc')
  const [filters, setFilters] = useState({})
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [selected, setSelected] = useState(() => new Set())
  const [serverData, setServerData] = useState(null)
  const [serverLoading, setServerLoading] = useState(false)
  const [exportError, setExportError] = useState(null)

  const searchCols = columns.filter(c => c.filterType === 'search')
  const searchKeys = useMemo(() => {
    const keys = searchCols.flatMap(c => c.searchKeys || [c.key])
    return keys.length ? keys : columns.map(c => c.key)
  }, [columns, searchCols])

  const clientRows = useMemo(() => {
    if (mode === 'server') return []
    let list = [...rows]
    if (q) {
      const needle = q.toLowerCase()
      list = list.filter(row => searchKeys.some(key => String(cellValue(row, { key }) ?? '').toLowerCase().includes(needle)))
    }
    for (const col of columns) {
      const val = filters[col.key]
      if (!val || val === '') continue
      if (col.filterType === 'select') {
        list = list.filter(row => String(cellValue(row, col)) === String(val))
      } else if (col.filterType === 'text') {
        const needle = String(val).toLowerCase()
        list = list.filter(row => String(cellValue(row, col) ?? '').toLowerCase().includes(needle))
      }
    }
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1
      const col = columns.find(c => c.key === sortKey)
      list = [...list].sort((a, b) => {
        const av = cellValue(a, col)
        const bv = cellValue(b, col)
        if (av == null && bv == null) return 0
        if (av == null) return -dir
        if (bv == null) return dir
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av).localeCompare(String(bv), 'zh-Hans-CN') * dir
      })
    }
    return list
  }, [rows, columns, filters, q, sortKey, sortDir, mode, searchKeys])

  const total = mode === 'server' ? (serverData?.total ?? 0) : clientRows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const displayRows = mode === 'server'
    ? (serverData?.items ?? [])
    : clientRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  useEffect(() => {
    if (mode !== 'server' || !fetchData) return
    setServerLoading(true)
    const timer = setTimeout(() => {
      fetchData({
        q,
        f: toServerFilters(filters, columns),
        sort: sortKey || '',
        order: sortDir,
        page: currentPage + 1,
        page_size: pageSize,
        ...pageExtra,
      }).then(res => {
        setServerData(res)
        setServerLoading(false)
      }).catch(err => {
        setServerLoading(false)
        if (onError) onError(err)
      })
    }, 200)
    return () => clearTimeout(timer)
  }, [mode, fetchData, q, filters, sortKey, sortDir, currentPage, pageSize, columns, pageExtra, onError])

  function setFilter(key, value) {
    setFilters(prev => ({ ...prev, [key]: value }))
    setPage(0)
  }

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  function toggleRow(key) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function togglePage() {
    setSelected(prev => {
      const next = new Set(prev)
      const keys = displayRows.map(rowKey)
      const allOnPage = keys.length > 0 && keys.every(k => next.has(k))
      keys.forEach(k => (allOnPage ? next.delete(k) : next.add(k)))
      return next
    })
  }

  const selectedKeys = [...selected]

  async function doExport(fmt) {
    setExportError(null)
    let url
    if (selectedKeys.length) {
      url = `${exportConfig.endpoint}?ids=${selectedKeys.join(',')}&fmt=${fmt}`
    } else if (exportConfig.allScope === 'server') {
      const params = exportConfig.buildParams({ q, filters, sortKey, sortDir }, pageExtra) || {}
      const sp = new URLSearchParams()
      Object.entries(params).forEach(([k, v]) => {
        if (v == null || v === '') return
        if (Array.isArray(v)) v.forEach(x => sp.append(k, x))
        else sp.set(k, v)
      })
      sp.set('fmt', fmt)
      url = `${exportConfig.endpoint}?${sp.toString()}`
    } else {
      const allKeys = (mode === 'server' ? (serverData?.items ?? []) : clientRows).map(rowKey)
      if (allKeys.length === 0) { setExportError('当前没有可导出的行，请先调整筛选。'); return }
      url = `${exportConfig.endpoint}?ids=${allKeys.join(',')}&fmt=${fmt}`
    }
    if (url.length > 6500) {
      setExportError('当前筛选结果过多，请收窄筛选条件，或改勾选部分行后导出。')
      return
    }
    const a = document.createElement('a')
    a.href = url
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return <div className="data-table">
    {(exportConfig || toolbar) && <div className="dt-toolbar">
      {toolbar && toolbar({ selected: selectedKeys, onClear: () => setSelected(new Set()) })}
      {selectedKeys.length > 0 && <span className="dt-selected">已选 {selectedKeys.length} 行 <button type="button" className="dt-link" onClick={() => setSelected(new Set())}>清除</button></span>}
      {exportConfig && <span className="dt-export">
        <span className="muted">导出：</span>
        <button type="button" onClick={() => doExport('csv')}>CSV</button>
        <button type="button" onClick={() => doExport('xlsx')}>XLSX</button>
        <span className="muted">（{selectedKeys.length ? `当前所选 ${selectedKeys.length} 行` : '当前筛选全部'}）</span>
      </span>}
      {exportError && <span className="alert error compact dt-export-error">{exportError}</span>}
    </div>}

    <div className="dt-scroll">
      <table className="dt">
        <thead>
          <tr>
            <th className="dt-checkbox-cell"><input type="checkbox" onChange={togglePage} checked={displayRows.length > 0 && displayRows.every(r => selected.has(rowKey(r)))} aria-label="全选本页" /></th>
            {columns.map(col => (
              <th key={col.key} className={col.align === 'end' ? 'align-end' : ''}>
                <div className="dt-th-inner">
                  {col.sortable !== false
                    ? <button type="button" className={`dt-sort ${sortKey === col.key ? 'active' : ''}`} onClick={() => toggleSort(col.key)}>
                        {col.label}{sortKey === col.key && <span className="dt-sort-ind">{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>}
                      </button>
                    : <span>{col.label}</span>}
                </div>
                {col.filterType === 'search' && <input className="dt-filter-search" placeholder="搜索…" value={q} onChange={e => { setQ(e.target.value); setPage(0) }} />}
                {col.filterType === 'text' && <input className="dt-filter" value={filters[col.key] || ''} onChange={e => setFilter(col.key, e.target.value)} placeholder="筛选…" />}
                {col.filterType === 'select' && <select className="dt-filter" value={filters[col.key] || ''} onChange={e => setFilter(col.key, e.target.value)}>
                  <option value="">全部</option>
                  {(col.filterOptions || []).map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(loading || serverLoading) ? <tr><td colSpan={columns.length + 1}><Empty>加载中…</Empty></td></tr>
            : displayRows.length === 0 ? <tr><td colSpan={columns.length + 1}>{empty}</td></tr>
              : displayRows.map(row => {
                  const key = rowKey(row)
                  const link = rowHref ? rowHref(row) : null
                  return <tr key={key} className={selected.has(key) ? 'selected' : ''} aria-label={rowAriaLabel ? rowAriaLabel(row) : undefined}>
                    <td className="dt-checkbox-cell"><input type="checkbox" checked={selected.has(key)} onChange={() => toggleRow(key)} aria-label="选择行" /></td>
                    {columns.map(col => <td key={col.key} className={col.className || ''} data-label={col.label}>
                      {link ? <a className="dt-cell-link" href={link}>{col.render ? col.render(row, col) : cellValue(row, col)}</a> : (col.render ? col.render(row, col) : cellValue(row, col))}
                    </td>)}
                  </tr>
                })}
        </tbody>
      </table>
    </div>

    {mode === 'client' && searchCols.length === 0 && clientRows.length > 0 && <div className="dt-client-search">
      <input className="search" placeholder="搜索…" value={q} onChange={e => { setQ(e.target.value); setPage(0) }} />
    </div>}

    <div className="dt-footer">
      <div className="dt-page-size">
        每页 <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(0) }}>
          {pageSizeOptions.map(n => <option key={n} value={n}>{n}</option>)}
        </select> 行
      </div>
      <div className="dt-pagination">
        <span className="muted">共 {total} 条</span>
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(0)}>«</button>
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹</button>
        <span className="dt-page-info">{currentPage + 1} / {pageCount}</span>
        <button type="button" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>›</button>
        <button type="button" disabled={currentPage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>»</button>
      </div>
    </div>
  </div>
}
