import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionConfirm, Back, Drawer, DropdownMenu, FieldDiff, Link, RouterContext, StatusBadge, Tabs, ToastProvider, confirmDirtyLeave, registerDirtyLeave, useFetchOne, useToast } from './ui'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('导航与并存表单守卫', () => {
  it('路由统一读取全部守卫，移除一个不会丢失另一个', () => {
    const first = registerDirtyLeave(() => false)
    const second = registerDirtyLeave(() => true)
    expect(confirmDirtyLeave()).toBe(false)
    second(); expect(confirmDirtyLeave()).toBe(false)
    first(); expect(confirmDirtyLeave()).toBe(true)
  })
  it('Link 把站内导航和来源状态交给路由', () => {
    const navigate = vi.fn()
    render(<RouterContext.Provider value={{ navigate }}><Link to="/products/2" state={{ returnTo: '/products?q=测试' }}>货品</Link></RouterContext.Provider>)
    fireEvent.click(screen.getByText('货品'))
    expect(navigate).toHaveBeenCalledWith('/products/2', { state: { returnTo: '/products?q=测试' } })
  })
  it('Back 恢复完整来源筛选地址', () => {
    render(<RouterContext.Provider value={{ returnTo: '/products?q=测试&page=2#balance' }}><Back to="/products" /></RouterContext.Provider>)
    expect(screen.getByRole('link').getAttribute('href')).toContain('/products?q=测试&page=2#balance')
  })
})

describe('共享交互组件', () => {
  it('确认条要求原因，异步执行时不能重复确认', async () => {
    let done
    const onConfirm = vi.fn(() => new Promise(resolve => { done = resolve }))
    render(<ActionConfirm title="驳回申请" reasonRequired onConfirm={onConfirm} onCancel={() => {}} confirmLabel="确认驳回" />)
    expect(screen.getByRole('button', { name: '确认驳回' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  数量有误  ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
    expect(onConfirm).toHaveBeenCalledWith('数量有误')
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled()
    await act(async () => done())
  })
  it('菜单支持方向键选择、Esc关闭并还原焦点', () => {
    render(<DropdownMenu label="操作"><button>新增客户</button><button>新增供应商</button></DropdownMenu>)
    const trigger = screen.getByRole('button', { name: /操作/ })
    fireEvent.click(trigger)
    expect(screen.getByText('新增客户')).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(screen.getByText('新增供应商')).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
  it('Tab 到输入框后不会自动关闭菜单', () => {
    render(<DropdownMenu label="列"><label><input type="checkbox" />名称</label><label><input type="checkbox" />地址</label></DropdownMenu>)
    fireEvent.click(screen.getByRole('button', { name: /列/ }))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
  it('抽屉关闭与路由共享脏保护，关闭后恢复焦点', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    function Demo() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>编辑</button><Drawer open={open} title="编辑客户" dirty onClose={() => setOpen(false)}><input aria-label="客户名称" /></Drawer></> }
    render(<Demo />)
    const trigger = screen.getByText('编辑'); trigger.focus(); fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(confirmDirtyLeave()).toBe(false)
    confirm.mockReturnValue(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(confirmDirtyLeave()).toBe(true)
  })
  it('Tabs 使用方向键定位并通过回调切换', () => {
    const onChange = vi.fn()
    render(<Tabs value="lines" items={[{ id: 'lines', label: '明细' }, { id: 'history', label: '操作历史' }]} onChange={onChange} />)
    screen.getByRole('tab', { name: '明细' }).focus()
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: '操作历史' })).toHaveFocus()
    fireEvent.click(screen.getByRole('tab', { name: '操作历史' }))
    expect(onChange).toHaveBeenCalledWith('history')
  })
  it('详情tab使用相对hash推进历史，不覆盖查询参数', () => {
    const navigate = vi.fn()
    render(<RouterContext.Provider value={{ navigate, currentPath: '/products/2', location: { pathname: '/products/2', search: '?q=测试', hash: '' } }}><Tabs items={[{ id: 'details', label: '资料' }, { id: 'history', label: '历史' }]} value="details" syncHash /></RouterContext.Provider>)
    fireEvent.click(screen.getByRole('tab', { name: '历史' }))
    expect(navigate).toHaveBeenCalledExactlyOnceWith('#history')
  })
  it('链接tab只触发一次路由导航', () => {
    const navigate = vi.fn(), onChange = vi.fn()
    render(<RouterContext.Provider value={{ navigate }}><Tabs items={[{ id: 'products', label: '货品', to: '/products' }]} value="products" onChange={onChange} /></RouterContext.Provider>)
    fireEvent.click(screen.getByRole('tab', { name: '货品' }))
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/products')
    expect(onChange).not.toHaveBeenCalled()
  })
  it('Toast 在三秒后消失', () => {
    vi.useFakeTimers()
    function Demo() { const toast = useToast(); return <button onClick={() => toast('保存成功')}>保存</button> }
    render(<ToastProvider><Demo /></ToastProvider>)
    fireEvent.click(screen.getByText('保存')); expect(screen.getByRole('status')).toHaveTextContent('保存成功')
    act(() => vi.advanceTimersByTime(3000)); expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('业务字段变化翻译状态并隐藏内部键', () => {
    render(<FieldDiff domain="request" diff={{ status: ['DRAFT', 'SUBMITTED'], notes: ['原备注', '新备注'], version: [1, 2], source_location_id: [2, 3] }} />)
    expect(screen.getByText('待审批')).toBeInTheDocument(); expect(screen.getByText('新备注')).toBeInTheDocument()
    expect(screen.queryByText('version')).not.toBeInTheDocument(); expect(screen.queryByText('source_location_id')).not.toBeInTheDocument()
  })
  it('未知状态不泄露技术代码', () => {
    render(<StatusBadge domain="document" value="UNKNOWN_STATUS" />)
    expect(screen.getByText('未知状态')).toHaveClass('neutral')
  })
})

describe('useFetchOne', () => {
  it('过期详情响应不覆盖新对象，reload可刷新最新对象', async () => {
    const pending = {}
    const fetch = vi.fn(id => new Promise(resolve => { pending[id] = resolve }))
    const { result, rerender } = renderHook(({ id }) => useFetchOne(() => fetch(id), [id]), { initialProps: { id: 1 } })
    rerender({ id: 2 })
    await act(async () => pending[2]({ name: '新客户' }))
    await act(async () => pending[1]({ name: '旧客户' }))
    expect(result.current.data.name).toBe('新客户'); expect(result.current.loading).toBe(false)
    act(() => { result.current.reload() })
    await act(async () => pending[2]({ name: '修改后的客户' }))
    expect(result.current.data.name).toBe('修改后的客户')
  })
  it('详情加载失败就地返回错误', async () => {
    const { result } = renderHook(() => useFetchOne(() => Promise.reject(new Error('读取失败')), []))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error.message).toBe('读取失败')
  })
})
