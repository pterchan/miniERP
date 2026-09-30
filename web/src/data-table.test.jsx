import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DataTable from './data-table'
import { RouterContext } from './ui'

afterEach(() => { cleanup(); localStorage.clear(); window.history.replaceState(null, "", "/"); vi.useRealTimers(); vi.restoreAllMocks() })

const rows = [
  { id: 1, name: '苹果', qty: 5, kind: 'A' },
  { id: 2, name: '香蕉', qty: 3, kind: 'B' },
  { id: 3, name: '橙子', qty: 9, kind: 'A' },
]

const columns = [
  { key: 'name', label: '名称', filterType: 'search' },
  { key: 'qty', label: '数量', align: 'end' },
  { key: 'kind', label: '类型', filterType: 'select', filterOptions: [{ value: 'A', label: 'A类' }, { value: 'B', label: 'B类' }] },
]

describe('DataTable client mode', () => {
  it('renders headers, all rows and the total', () => {
    render(<DataTable tableId="test.table" columns={columns} rows={rows} rowKey={r => String(r.id)} />)
    expect(screen.getByText('名称')).toBeInTheDocument()
    expect(screen.getByText('苹果')).toBeInTheDocument()
    expect(screen.getByText('香蕉')).toBeInTheDocument()
    expect(screen.getByText('橙子')).toBeInTheDocument()
    expect(screen.getByText('共 3 条')).toBeInTheDocument()
  })

  it('filters by the global search box', () => {
    render(<DataTable tableId="test.table" columns={columns} rows={rows} rowKey={r => String(r.id)} />)
    fireEvent.change(screen.getByPlaceholderText('搜索…'), { target: { value: '苹' } })
    expect(screen.getByText('苹果')).toBeInTheDocument()
    expect(screen.queryByText('香蕉')).not.toBeInTheDocument()
    expect(screen.getByText('共 1 条')).toBeInTheDocument()
  })

  it('filters by a per-column text input', () => {
    const cols = [{ key: 'name', label: '名称', filterType: 'text' }, { key: 'qty', label: '数量' }]
    render(<DataTable tableId="test.table" columns={cols} rows={rows} rowKey={r => String(r.id)} />)
    fireEvent.change(screen.getByPlaceholderText('筛选…'), { target: { value: '香' } })
    expect(screen.getByText('香蕉')).toBeInTheDocument()
    expect(screen.queryByText('苹果')).not.toBeInTheDocument()
  })

  it('filters by a select column', () => {
    render(<DataTable tableId="test.table" columns={columns} rows={rows} rowKey={r => String(r.id)} />)
    const comboboxes = screen.getAllByRole('combobox')
    const kindSelect = comboboxes.find(c => within(c).queryByText('B类'))
    fireEvent.change(kindSelect, { target: { value: 'B' } })
    expect(screen.getByText('香蕉')).toBeInTheDocument()
    expect(screen.queryByText('苹果')).not.toBeInTheDocument()
    expect(screen.queryByText('橙子')).not.toBeInTheDocument()
  })

  it('sorts by clicking a header, toggling direction', () => {
    const cols = [{ key: 'qty', label: '数量' }, { key: 'name', label: '名称' }]
    render(<DataTable tableId="test.table" columns={cols} rows={rows} rowKey={r => String(r.id)} />)
    const sortButton = screen.getByRole('button', { name: /数量/ })
    const names = () => screen.getAllByRole('cell').map(c => c.textContent).filter(t => ['苹果', '香蕉', '橙子'].includes(t))

    fireEvent.click(sortButton) // 升序：香蕉(3) 苹果(5) 橙子(9)
    expect(names()).toEqual(['香蕉', '苹果', '橙子'])

    fireEvent.click(sortButton) // 降序
    expect(names()).toEqual(['橙子', '苹果', '香蕉'])
  })

  it('paginates beyond the page size', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `item${i + 1}`, qty: i }))
    render(<DataTable tableId="test.table" columns={[{ key: 'name', label: '名称' }]} rows={many} rowKey={r => String(r.id)} defaultPageSize={10} />)
    expect(screen.getByText('共 12 条')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByText('›'))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.getByText('item11')).toBeInTheDocument()
    expect(screen.queryByText('item1')).not.toBeInTheDocument()
  })

  it('offers export toolbar and tracks selected rows', () => {
    render(<DataTable tableId="test.table" columns={columns} rows={rows} rowKey={r => String(r.id)} exportConfig={{ endpoint: '/x/export', filename: 'x', allScope: 'ids' }} />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    expect(screen.getByRole('menuitem', { name: 'CSV · 当前筛选全部' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'XLSX · 当前筛选全部' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[1]) // 选择第一行
    expect(screen.getByText(/已选 1 行/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('清除'))
    expect(screen.queryByText(/已选/)).not.toBeInTheDocument()
  })
})

describe('DataTable server mode', () => {
  it('fetches pages through fetchData and renders them', async () => {
    const fetchData = vi.fn(async (params, signal) => ({ items: rows, total: rows.length }))
    render(<DataTable tableId="test.table" mode="server" columns={columns} rows={[]} fetchData={fetchData} rowKey={r => String(r.id)} />)
    // 等待组件内部 200ms 防抖拉取
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(fetchData).toHaveBeenCalled()
    expect(fetchData).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }), expect.any(AbortSignal))
    expect(screen.getByText('苹果')).toBeInTheDocument()
    expect(screen.getByText('共 3 条')).toBeInTheDocument()
  })

  it('aborts an in-flight request when inputs change', async () => {
    const fetchData = vi.fn(() => new Promise(resolve => resolve({ items: rows, total: rows.length })))
    const { rerender } = render(<DataTable tableId="test.table" mode="server" columns={columns} rows={[]} fetchData={fetchData} rowKey={r => String(r.id)} />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(fetchData).toHaveBeenCalledTimes(1)
    const firstSignal = fetchData.mock.calls[0][1]
    // pageExtra 引用变化 → 触发新一轮拉取，旧请求应被 abort
    rerender(<DataTable tableId="test.table" mode="server" columns={columns} rows={[]} fetchData={fetchData} rowKey={r => String(r.id)} pageExtra={{ v: 1 }} />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(fetchData).toHaveBeenCalledTimes(2)
    expect(firstSignal.aborted).toBe(true)
  })
})

describe('DataTable row links', () => {
  const linkColumns = [{ key: 'name', label: '名称' }]

  function renderTable(extra = {}) {
    return render(
      <RouterContext.Provider value={{ navigate: vi.fn(), currentPath: '/' }}>
        <DataTable tableId="test.table" columns={linkColumns} rows={rows} rowKey={r => String(r.id)} rowHref={r => `/products/${r.id}`} {...extra} />
      </RouterContext.Provider>,
    )
  }

  it('anchors rows under the app base path so gateway deployments stay inside /erp/', () => {
    renderTable()
    expect(screen.getByText('苹果').closest('a')).toHaveAttribute('href', '/erp/products/1')
  })

  it('navigates via the router on plain click and leaves modified clicks to the browser', () => {
    const navigate = vi.fn()
    render(
      <RouterContext.Provider value={{ navigate, currentPath: '/' }}>
        <DataTable tableId="test.table" columns={linkColumns} rows={rows} rowKey={r => String(r.id)} rowHref={r => `/products/${r.id}`} />
      </RouterContext.Provider>,
    )
    const anchor = screen.getByText('苹果').closest('a')
    fireEvent.click(anchor)
    expect(navigate).toHaveBeenCalledWith('/products/1', { state: { returnTo: expect.stringContaining('/?q=') } })
    fireEvent.click(anchor, { ctrlKey: true })
    expect(navigate).toHaveBeenCalledTimes(1)
  })
})

describe('DataTable numeric sorting', () => {
  it('sorts formatted numeric columns by their raw value via sortValue', () => {
    const cols = [{ key: 'qty', label: '数量', align: 'end', value: r => `¥ ${r.qty}`, sortValue: r => Number(r.qty) }]
    render(<DataTable tableId="test.table" columns={cols} rows={rows} rowKey={r => String(r.id)} />)
    const sortButton = screen.getByRole('button', { name: /数量/ })
    const values = () => screen.getAllByRole('cell').map(c => c.textContent).filter(Boolean)
    fireEvent.click(sortButton) // 升序：3 → 5 → 9（字典序会得到 9 > 5 > 3 的错误顺序）
    expect(values()).toEqual(['¥ 3', '¥ 5', '¥ 9'])
    fireEvent.click(sortButton) // 降序
    expect(values()).toEqual(['¥ 9', '¥ 5', '¥ 3'])
  })
})

const defaultUser = { user_id: 10, role: 'ADMIN' }
function statefulTable(props = {}, router = {}) {
  const context = { user: defaultUser, currentPath: '/products', location: { pathname: '/products', search: '', hash: '#all' }, navigate: vi.fn(), ...router }
  return { context, node: <RouterContext.Provider value={context}><DataTable tableId="products" columns={columns} rows={rows} rowKey={row => String(row.id)} {...props} /></RouterContext.Provider> }
}
const waitForTable = () => act(async () => { await vi.advanceTimersByTimeAsync(210) })

describe('DataTable URL, views and full-filter exports', () => {
  it('debounces a replace to the URL and keeps unrelated query and hash', async () => {
    vi.useFakeTimers()
    const { node, context } = statefulTable({}, { location: { pathname: '/products', search: '?tab=all', hash: '#list' } })
    render(node)
    fireEvent.change(screen.getByLabelText('搜索名称'), { target: { value: '苹果' } })
    expect(context.navigate).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    const [url, navigation] = context.navigate.mock.calls[0]
    expect(navigation.replace).toBe(true)
    expect(url).toContain('tab=all')
    expect(new URLSearchParams(url.split('?')[1].split('#')[0]).get('q')).toBe('苹果')
    expect(url).toMatch(/#list$/)
  })
  it('restores initial and history navigation states without dropping filters for hidden columns', () => {
    const initial = statefulTable({}, { location: { pathname: '/products', search: '?f.kind=B&cols=kind', hash: '' } })
    const { rerender } = render(initial.node)
    expect(screen.getByText('香蕉')).toBeInTheDocument()
    expect(screen.queryByText('苹果')).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /类型/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '类型：B类 ×' })).toBeInTheDocument()
    rerender(statefulTable({}, { location: { pathname: '/products', search: '?q=橙', hash: '' } }).node)
    expect(screen.getByText('橙子')).toBeInTheDocument()
    expect(screen.queryByText('香蕉')).not.toBeInTheDocument()
    expect(screen.getByLabelText('搜索名称')).toHaveValue('橙')
  })
  it('starts at a shared server page and only corrects it after the server reports total', async () => {
    vi.useFakeTimers()
    const fetchData = vi.fn(async () => ({ items: [rows[1]], total: 25 }))
    render(statefulTable({ mode: 'server', fetchData }, { location: { pathname: '/products', search: '?page=3&ps=10', hash: '' } }).node)
    await waitForTable()
    expect(fetchData.mock.calls.map(([params]) => params.page)).toEqual([3])
    expect(screen.getByText('3 / 3')).toBeInTheDocument()
  })
  it('corrects an out-of-range shared page after loading and refetches the last page', async () => {
    vi.useFakeTimers()
    const fetchData = vi.fn(async () => ({ items: [rows[1]], total: 15 }))
    render(statefulTable({ mode: 'server', fetchData }, { location: { pathname: '/products', search: '?page=8&ps=10', hash: '' } }).node)
    await waitForTable()
    await waitForTable()
    expect(fetchData.mock.calls.map(([params]) => params.page)).toEqual([8, 2])
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
  })
  it('saves a named view from its button, assigns a default and keeps users isolated', () => {
    const { node } = statefulTable()
    const { rerender } = render(node)
    fireEvent.change(screen.getByLabelText('搜索名称'), { target: { value: '苹果' } })
    fireEvent.click(screen.getByRole('button', { name: /视图/ }))
    fireEvent.change(screen.getByLabelText('视图名称'), { target: { value: '苹果清单' } })
    fireEvent.click(screen.getByRole('button', { name: '保存当前视图' }))
    const stored = JSON.parse(localStorage.getItem('erp.view.10.products'))
    expect(stored.views).toHaveLength(1)
    expect(stored.views[0].state.q).toBe('苹果')
    expect(stored.views[0].state).not.toHaveProperty('page')
    fireEvent.click(screen.getByRole('menuitem', { name: '设为默认：苹果清单' }))
    expect(JSON.parse(localStorage.getItem('erp.view.10.products')).defaultId).toBe(stored.views[0].id)
    rerender(statefulTable({}, { user: { user_id: 11, role: 'SALES' } }).node)
    expect(screen.getByLabelText('搜索名称')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: /视图/ }))
    expect(screen.queryByRole('menuitem', { name: '苹果清单（默认）' })).not.toBeInTheDocument()
  })
  it('keeps query business filters in exports and omits pagination for all-filter export', async () => {
    vi.useFakeTimers()
    const urls = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { urls.push(this.href) })
    const fetchData = vi.fn(async () => ({ items: rows, total: 205, summary: { total_amount: 9000 } }))
    render(statefulTable({ mode: 'server', fetchData, queryKeys: ['mine'], exportConfig: { endpoint: '/api/products/export', allScope: 'server' }, footer: data => data?.summary && `全部金额：${data.summary.total_amount}` }, { location: { pathname: '/products', search: '?mine=true&f.kind=A&page=2&ps=10', hash: '' } }).node)
    await waitForTable()
    expect(screen.getByText('全部金额：9000')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'CSV · 当前筛选全部' }))
    const url = new URL(urls[0])
    expect(url.pathname).toBe('/erp/api/products/export')
    expect(url.searchParams.get('mine')).toBe('true')
    expect(url.searchParams.getAll('f')).toEqual(['kind:eq:A'])
    expect(url.searchParams.has('ids')).toBe(false)
    expect(url.searchParams.has('page')).toBe(false)
    expect(url.searchParams.has('page_size')).toBe(false)
  })
  it('applies defaults and client business filters only when the URL has no table state', () => {
    const filterRows = (items, query) => query.mine === 'true' ? items.filter(row => row.id === 1) : items
    const props = { defaultQuery: { mine: 'true' }, filterRows }
    const { rerender } = render(statefulTable(props).node)
    expect(screen.getByText('共 1 条')).toBeInTheDocument()
    rerender(statefulTable(props, { location: { pathname: '/products', search: '?q=', hash: '' } }).node)
    expect(screen.getByText('共 3 条')).toBeInTheDocument()
  })
})

describe('DataTable request ordering and navigation', () => {
  it('ignores an older response even when a transport does not honor cancellation', async () => {
    vi.useFakeTimers()
    let resolveFirst, resolveSecond
    const fetchData = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve })).mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve }))
    render(statefulTable({ mode: 'server', fetchData }).node)
    await waitForTable()
    fireEvent.change(screen.getByLabelText('搜索名称'), { target: { value: '香蕉' } })
    await waitForTable()
    await act(async () => { resolveSecond({ items: [rows[1]], total: 1 }) })
    expect(screen.getByText('香蕉')).toBeInTheDocument()
    await act(async () => { resolveFirst({ items: [rows[0]], total: 1 }) })
    expect(screen.getByText('香蕉')).toBeInTheDocument()
    expect(screen.queryByText('苹果')).not.toBeInTheDocument()
  })

  it('flushes pending state before navigation and includes it in row returnTo', () => {
    vi.useFakeTimers()
    const { node, context } = statefulTable({ rowHref: row => `/products/${row.id}` })
    render(node)
    fireEvent.change(screen.getByLabelText('搜索名称'), { target: { value: '苹果' } })
    fireEvent.click(screen.getByText('苹果'))
    expect(context.navigate).toHaveBeenCalledTimes(2)
    expect(context.navigate.mock.calls[0][1]).toMatchObject({ replace: true })
    const [, navigation] = context.navigate.mock.calls[1]
    expect(new URLSearchParams(navigation.state.returnTo.split('?')[1].split('#')[0]).get('q')).toBe('苹果')
  })
})


describe('DataTable failed filter requests', () => {
  it('does not present the previous query rows and summary as the failed query result', async () => {
    vi.useFakeTimers()
    const fetchData = vi.fn().mockResolvedValueOnce({ items: [rows[0]], total: 1, summary: { amount: 25 } }).mockRejectedValueOnce(new Error('查询失败，请重试'))
    render(statefulTable({ mode: 'server', fetchData, footer: data => data?.summary && `筛选合计：${data.summary.amount}` }).node)
    await waitForTable()
    expect(screen.getByText('苹果')).toBeInTheDocument()
    expect(screen.getByText('筛选合计：25')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('搜索名称'), { target: { value: '香蕉' } })
    await waitForTable()
    expect(screen.getByText('查询失败，请重试')).toBeInTheDocument()
    expect(screen.queryByText('苹果')).not.toBeInTheDocument()
    expect(screen.queryByText('筛选合计：25')).not.toBeInTheDocument()
  })
})
