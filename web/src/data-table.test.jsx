import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DataTable from './data-table'
import { RouterContext } from './ui'

afterEach(cleanup)

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
    render(<DataTable columns={columns} rows={rows} rowKey={r => String(r.id)} />)
    expect(screen.getByText('名称')).toBeInTheDocument()
    expect(screen.getByText('苹果')).toBeInTheDocument()
    expect(screen.getByText('香蕉')).toBeInTheDocument()
    expect(screen.getByText('橙子')).toBeInTheDocument()
    expect(screen.getByText('共 3 条')).toBeInTheDocument()
  })

  it('filters by the global search box', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={r => String(r.id)} />)
    fireEvent.change(screen.getByPlaceholderText('搜索…'), { target: { value: '苹' } })
    expect(screen.getByText('苹果')).toBeInTheDocument()
    expect(screen.queryByText('香蕉')).not.toBeInTheDocument()
    expect(screen.getByText('共 1 条')).toBeInTheDocument()
  })

  it('filters by a per-column text input', () => {
    const cols = [{ key: 'name', label: '名称', filterType: 'text' }, { key: 'qty', label: '数量' }]
    render(<DataTable columns={cols} rows={rows} rowKey={r => String(r.id)} />)
    fireEvent.change(screen.getByPlaceholderText('筛选…'), { target: { value: '香' } })
    expect(screen.getByText('香蕉')).toBeInTheDocument()
    expect(screen.queryByText('苹果')).not.toBeInTheDocument()
  })

  it('filters by a select column', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={r => String(r.id)} />)
    const comboboxes = screen.getAllByRole('combobox')
    const kindSelect = comboboxes.find(c => within(c).queryByText('B类'))
    fireEvent.change(kindSelect, { target: { value: 'B' } })
    expect(screen.getByText('香蕉')).toBeInTheDocument()
    expect(screen.queryByText('苹果')).not.toBeInTheDocument()
    expect(screen.queryByText('橙子')).not.toBeInTheDocument()
  })

  it('sorts by clicking a header, toggling direction', () => {
    const cols = [{ key: 'qty', label: '数量' }, { key: 'name', label: '名称' }]
    render(<DataTable columns={cols} rows={rows} rowKey={r => String(r.id)} />)
    const sortButton = screen.getByRole('button', { name: /数量/ })
    const names = () => screen.getAllByRole('cell').map(c => c.textContent).filter(t => ['苹果', '香蕉', '橙子'].includes(t))

    fireEvent.click(sortButton) // 升序：香蕉(3) 苹果(5) 橙子(9)
    expect(names()).toEqual(['香蕉', '苹果', '橙子'])

    fireEvent.click(sortButton) // 降序
    expect(names()).toEqual(['橙子', '苹果', '香蕉'])
  })

  it('paginates beyond the page size', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `item${i + 1}`, qty: i }))
    render(<DataTable columns={[{ key: 'name', label: '名称' }]} rows={many} rowKey={r => String(r.id)} defaultPageSize={10} />)
    expect(screen.getByText('共 12 条')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByText('›'))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.getByText('item11')).toBeInTheDocument()
    expect(screen.queryByText('item1')).not.toBeInTheDocument()
  })

  it('offers export toolbar and tracks selected rows', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={r => String(r.id)} exportConfig={{ endpoint: '/x/export', filename: 'x', allScope: 'ids' }} />)
    expect(screen.getByText('导出：')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CSV' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'XLSX' })).toBeInTheDocument()

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
    render(<DataTable mode="server" columns={columns} rows={[]} fetchData={fetchData} rowKey={r => String(r.id)} />)
    // 等待组件内部 200ms 防抖拉取
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(fetchData).toHaveBeenCalled()
    expect(fetchData).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }), expect.any(AbortSignal))
    expect(screen.getByText('苹果')).toBeInTheDocument()
    expect(screen.getByText('共 3 条')).toBeInTheDocument()
  })

  it('aborts an in-flight request when inputs change', async () => {
    const fetchData = vi.fn(() => new Promise(resolve => resolve({ items: rows, total: rows.length })))
    const { rerender } = render(<DataTable mode="server" columns={columns} rows={[]} fetchData={fetchData} rowKey={r => String(r.id)} />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(fetchData).toHaveBeenCalledTimes(1)
    const firstSignal = fetchData.mock.calls[0][1]
    // pageExtra 引用变化 → 触发新一轮拉取，旧请求应被 abort
    rerender(<DataTable mode="server" columns={columns} rows={[]} fetchData={fetchData} rowKey={r => String(r.id)} pageExtra={{ v: 1 }} />)
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
        <DataTable columns={linkColumns} rows={rows} rowKey={r => String(r.id)} rowHref={r => `/products/${r.id}`} {...extra} />
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
        <DataTable columns={linkColumns} rows={rows} rowKey={r => String(r.id)} rowHref={r => `/products/${r.id}`} />
      </RouterContext.Provider>,
    )
    const anchor = screen.getByText('苹果').closest('a')
    fireEvent.click(anchor)
    expect(navigate).toHaveBeenCalledWith('/products/1')
    fireEvent.click(anchor, { ctrlKey: true })
    expect(navigate).toHaveBeenCalledTimes(1)
  })
})

describe('DataTable numeric sorting', () => {
  it('sorts formatted numeric columns by their raw value via sortValue', () => {
    const cols = [{ key: 'qty', label: '数量', align: 'end', value: r => `¥ ${r.qty}`, sortValue: r => Number(r.qty) }]
    render(<DataTable columns={cols} rows={rows} rowKey={r => String(r.id)} />)
    const sortButton = screen.getByRole('button', { name: /数量/ })
    const values = () => screen.getAllByRole('cell').map(c => c.textContent).filter(Boolean)
    fireEvent.click(sortButton) // 升序：3 → 5 → 9（字典序会得到 9 > 5 > 3 的错误顺序）
    expect(values()).toEqual(['¥ 3', '¥ 5', '¥ 9'])
    fireEvent.click(sortButton) // 降序
    expect(values()).toEqual(['¥ 9', '¥ 5', '¥ 3'])
  })
})
