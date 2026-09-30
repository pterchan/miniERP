import { afterEach, describe, expect, it } from 'vitest'
import { hasTableQuery, normalizeTableState, parseTableState, readTableViews, serializeTableState, tableViewSnapshot, viewStorageKey, writeTableViews } from './table-state'

const options = {
  columns: [{ key: 'name', filterType: 'search' }, { key: 'status', filterType: 'select' }, { key: 'notes', filterType: 'text' }],
  defaultFilters: { status: 'DRAFT' }, defaultQuery: { mine: 'true' }, queryKeys: ['start_date'],
}
afterEach(() => localStorage.clear())

describe('表格 URL 与默认视图', () => {
  it('无显式表格参数时使用默认条件或默认视图，显式 URL 整体优先', () => {
    const defaultView = { id: 'saved', state: { q: 'saved search', filters: { status: 'POSTED' }, page: 9, pageSize: 100 } }
    expect(parseTableState('?tab=all', options)).toMatchObject({ filters: { status: 'DRAFT' }, query: { mine: 'true' } })
    expect(parseTableState('', options, defaultView)).toMatchObject({ q: 'saved search', page: 1, pageSize: 100, viewId: 'saved' })
    expect(parseTableState('?q=', options, defaultView)).toMatchObject({ q: '', filters: {}, query: {}, viewId: '' })
    expect(parseTableState('?mine=true&page=2', options, defaultView)).toMatchObject({ q: '', page: 2, query: { mine: 'true' }, filters: {} })
    expect(hasTableQuery('?tab=supplier', options)).toBe(false)
  })
  it('序列化保留其他参数并完整还原筛选、隐藏列、排序和业务参数', () => {
    const state = normalizeTableState({ q: '广州 A&B', filters: { status: 'SUBMITTED', notes: '跟进' }, query: { mine: 'true', start_date: '2026-09-30' }, sortKey: 'name', sortDir: 'desc', page: 2, pageSize: 25, hiddenCols: ['notes'], viewId: 'my-view' }, options)
    const serialized = serializeTableState(state, '?tab=supplier&q=old&f.status=DRAFT', options)
    expect(new URLSearchParams(serialized).get('tab')).toBe('supplier')
    expect(new URLSearchParams(serialized).get('cols')).toBe('notes')
    expect(parseTableState(serialized, options)).toEqual(state)
  })
  it('非法值安全回退，并至少保留一个业务列', () => {
    const state = parseTableState('?page=-4&ps=999&sort=missing&order=unsafe&cols=name,status,notes,missing&f.unknown=x', options)
    expect(state).toMatchObject({ page: 1, pageSize: 50, sortKey: '', sortDir: 'asc', filters: {}, hiddenCols: ['status', 'notes'] })
  })
})

describe('按用户隔离的本机视图', () => {
  it('保存过滤条件但不保存页码，账号间不共享视图', () => {
    const state = parseTableState('?q=苹果&page=3&ps=25', options)
    const saved = { version: 1, defaultId: 'fruit', views: [{ id: 'fruit', name: '水果', state: tableViewSnapshot(state) }] }
    expect(writeTableViews(11, 'products', saved)).toBe(true)
    expect(viewStorageKey(11, 'products')).toBe('erp.view.11.products')
    expect(readTableViews(11, 'products')).toEqual(saved)
    expect(saved.views[0].state).not.toHaveProperty('page')
    expect(saved.views[0].state).not.toHaveProperty('viewId')
    expect(readTableViews(12, 'products').views).toEqual([])
    expect(writeTableViews(null, 'products', saved)).toBe(false)
  })
  it('忽略损坏存储', () => {
    localStorage.setItem('erp.view.11.products', '{broken')
    expect(readTableViews(11, 'products')).toEqual({ version: 1, defaultId: '', views: [] })
  })
})
