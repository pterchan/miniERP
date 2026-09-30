import React, { useEffect, useRef, useState } from 'react'
import api, { invalidateInventory } from './api'
import { can, canView, ROLE_LABELS } from './roles'
import { DOC_TYPE_CONFIG } from './documents'
import { moduleForPath } from './navigation-utils'
import { Badge, Button, Drawer, DropdownMenu, EmptyState, ErrorBoundary, ErrorBox, Link, PageHeading, StatusBadge, Tabs, confirmDirtyLeave, useRouter } from './ui'

export function moduleItems(user) {
  return [
    { id: 'home', label: '工作台', to: '/', icon: '▦', tabs: [] },
    { id: 'requests', label: '申请', to: '/requests', icon: '□', tabs: [] },
    { id: 'sales', label: '销售', to: '/sales', icon: '↗', tabs: [canView(user, 'sales') && { id: 'documents', label: '销售单据', to: '/sales' }, canView(user, 'customers') && { id: 'customers', label: '客户档案', to: '/master/customers' }] },
    { id: 'purchase', label: '采购', to: '/purchase', icon: '↙', tabs: [canView(user, 'purchase') && { id: 'documents', label: '采购单据', to: '/purchase' }, canView(user, 'suppliers') && { id: 'suppliers', label: '供应商档案', to: '/master/suppliers' }] },
    { id: 'inventory', label: '库存', to: '/inventory', icon: '⇄', tabs: [{ id: 'balance', label: '库存余额', to: '/inventory' }, canView(user, 'inventoryDocs') && { id: 'documents', label: '库存单据', to: '/inventory#documents' }, canView(user, 'count') && { id: 'count', label: '清点库存', to: '/count' }, canView(user, 'serials') && { id: 'serials', label: '序列台账', to: '/serials' }] },
    canView(user, 'reports') && { id: 'reports', label: '财务', to: '/reports', icon: '¥', tabs: [{ id: 'purchase', label: '采购对账', to: '/reports/purchase' }, { id: 'arap', label: '应收应付', to: '/reports/arap' }, { id: 'inventory-cost', label: '库存成本', to: '/reports/inventory-cost' }] },
    { id: 'master', label: '基础资料', to: '/master', icon: '▤', tabs: [{ id: 'products', label: '货品', to: '/products' }, canView(user, 'categories') && { id: 'categories', label: '分类', to: '/master/categories' }, { id: 'locations', label: '库位', to: '/master/locations' }, { id: 'uoms', label: '单位', to: '/master/uoms' }] },
    (canView(user, 'system') || canView(user, 'audit')) && { id: 'admin', label: '管理', to: '/admin', icon: '⚙', tabs: [canView(user, 'system') && { id: 'users', label: '用户', to: '/admin' }, canView(user, 'conflicts') && { id: 'conflicts', label: '冲突中心', to: '/conflicts' }, canView(user, 'audit') && { id: 'audit', label: '操作审计', to: '/audit' }] },
  ].filter(Boolean).map(item => {
    const tabs = item.tabs.filter(Boolean)
    return { ...item, tabs, to: ['sales', 'purchase', 'admin'].includes(item.id) ? tabs[0]?.to : item.to }
  }).filter(item => item.to)
}

export function quickActions(user) {
  const actions = [{ label: '新建申请', to: '/requests/new' }]
  for (const type of ['SALES_ORDER', 'PURCHASE_ORDER']) {
    const cfg = DOC_TYPE_CONFIG[type]
    if (cfg.create.includes(user.role)) actions.push({ label: `新建${cfg.label}`, to: `/${cfg.group}/${type.toLowerCase()}/new` })
  }
  if (canView(user, 'count')) actions.push({ label: '清点库存', to: '/count' })
  if (can(user, 'SALES', 'ADMIN')) actions.push({ label: '新增客户', to: '/master/customers/new' })
  if (can(user, 'ADMIN')) actions.push({ label: '新增货品', to: '/products/new' })
  return actions
}

export function todoCount(data, user) {
  if (!data) return 0
  return (data.pending_documents || []).reduce((n, item) => n + item.count, 0)
    + Number(data.my_draft_documents || 0) + Number(data.my_draft_requests || 0)
    + Number(data.pending_conflicts || 0)
    + (can(user, 'WAREHOUSE', 'ADMIN') ? Number(data.pending_requests || 0) + Number(data.approved_requests || 0) : 0)
}

export function useWorkbench(user) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let active = true
    let sequence = 0
    const load = () => {
      const token = ++sequence
      api.workbench().then(value => { if (active && sequence === token) { setData(value); setError(null) } }).catch(err => { if (active && sequence === token) setError(err) })
    }
    load()
    const interval = setInterval(load, 60_000)
    window.addEventListener('erp:workbench-invalidated', load)
    window.addEventListener('focus', load)
    return () => { active = false; clearInterval(interval); window.removeEventListener('erp:workbench-invalidated', load); window.removeEventListener('focus', load) }
  }, [user.user_id, user.role])
  return { data, error }
}

export function GlobalSearch() {
  const { navigate } = useRouter()
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(0)
  const input = useRef(null)
  const root = useRef(null)
  const items = groups.flatMap(group => group.items.map(item => ({ ...item, kind: group.kind })))
  useEffect(() => { if (open && window.matchMedia('(max-width: 760px)').matches) input.current?.focus() }, [open])
  useEffect(() => {
    const keyboard = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); input.current?.focus(); setOpen(true) } }
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('keydown', keyboard)
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('keydown', keyboard); document.removeEventListener('pointerdown', outside) }
  }, [])
  useEffect(() => {
    setGroups([]); setSelected(0); setError(null)
    if (!query.trim()) { setBusy(false); return }
    const controller = new AbortController()
    setBusy(true)
    const timer = setTimeout(() => api.search({ q: query, limit: 5, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setGroups(result.groups || []); setBusy(false) }
    }).catch(err => { if (!controller.signal.aborted) { setError(err); setBusy(false) } }), 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query])
  function go(to) { if (navigate(to) !== false) { setOpen(false); input.current?.blur() } }
  return <div className={`global-search ${open ? 'is-open' : ''}`} ref={root}>
    <Button className="mobile-search-trigger" variant="ghost" aria-label="打开全局搜索" onClick={() => setOpen(value => !value)}>⌕</Button>
    <input ref={input} role="combobox" aria-label="全局搜索" aria-expanded={open} aria-controls="global-search-results" aria-activedescendant={open && items[selected] ? `global-result-${selected}` : undefined} placeholder="搜索货品、单据、申请… ⌘K" value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true) }} onKeyDown={event => {
      if (event.key === 'Escape') { setOpen(false); input.current?.blur() }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); setSelected(index => Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))) }
      if (event.key === 'Enter' && query.trim()) { event.preventDefault(); go(items[selected]?.href || `/products?q=${encodeURIComponent(query)}`) }
    }} />
    {open && <div className="search-panel" id="global-search-results" role="listbox" aria-label="搜索结果">
      <ErrorBox error={error} />
      {!query.trim() ? <p className="muted">输入编号、名称或联系人开始搜索</p> : busy ? <p role="status">搜索中…</p> : <>
        {groups.filter(group => group.items.length).map(group => <div className="search-group" key={group.kind}><h3>{group.label}</h3>{group.items.map(item => {
          const index = items.findIndex(x => x.kind === group.kind && x.id === item.id)
          return <button key={item.id} id={`global-result-${index}`} role="option" aria-selected={selected === index} className={`search-result ${selected === index ? "selected" : ""}`} onMouseEnter={() => setSelected(index)} onClick={() => go(item.href)}><span><strong>{item.title}</strong><small>{item.subtitle}</small></span>{item.status && <StatusBadge domain={group.kind === 'request' ? 'request' : group.kind === 'document' ? 'document' : group.kind === 'serial' ? 'serial' : 'active'} value={item.status} />}</button>
        })}</div>)}
        {!items.length && !error && <p className="muted">没有找到匹配结果</p>}
      </>}
      {query.trim() && <button className="search-fallback" onClick={() => go(`/products?q=${encodeURIComponent(query)}`)}>在货品中搜索「{query}」 →</button>}
    </div>}
  </div>
}

function moduleTabValue(module, location) {
  const path = location.pathname
  if (module.id === 'inventory') return path === '/inventory' ? (location.hash === '#documents' ? 'documents' : 'balance') : path.startsWith('/count') ? 'count' : path.startsWith('/serials') ? 'serials' : /\/inventory\/[a-z]/i.test(path) ? 'documents' : 'balance'
  if (module.id === 'reports' && ['/reports/receivables', '/reports/payables'].includes(path)) return 'arap'
  const found = module.tabs.find(tab => path === tab.to || path.startsWith(`${tab.to}/`))
  return found?.id || module.tabs[0]?.id
}

export function Layout({ user, children, onLogout }) {
  const { currentPath, location, navigate } = useRouter()
  const [more, setMore] = useState(false)
  const modules = moduleItems(user)
  const currentModule = modules.find(item => item.id === moduleForPath(currentPath))
  const { data } = useWorkbench(user)
  const tasks = todoCount(data, user)
  const quick = quickActions(user)
  const third = can(user, 'SALES') ? 'sales' : can(user, 'FINANCE') ? 'reports' : 'inventory'
  const mobile = ['home', 'requests', third].map(id => modules.find(item => item.id === id)).filter(Boolean)
  useEffect(() => { setMore(false) }, [currentPath, location.hash])
  async function logout() { if (!confirmDirtyLeave()) return; try { await api.logout() } finally { invalidateInventory(); onLogout() } }
  const navLink = item => <Link key={item.id} className="nav-link" to={item.to} aria-current={moduleForPath(currentPath) === item.id ? 'page' : undefined}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span className="nav-label">{item.label}</span></Link>
  const topLevel = currentPath === '/' || ['/requests', '/sales', '/purchase', '/inventory', '/master', '/products', '/master/customers', '/master/suppliers', '/master/categories', '/master/locations', '/master/uoms', '/reports', '/reports/purchase', '/reports/arap', '/reports/receivables', '/reports/payables', '/reports/inventory-cost', '/admin', '/audit', '/conflicts', '/count', '/serials'].includes(currentPath) || /^\/(sales|purchase|inventory)\/[a-z_]+$/.test(currentPath)
  return <div className="app-shell">
    <aside className="sidebar"><Link to="/" className="brand"><span className="brand-dot" />miniERP</Link><nav aria-label="主导航">{modules.map(navLink)}</nav><div className="sidebar-foot"><Badge>{ROLE_LABELS[user.role]}</Badge><Link to="/profile" className="user-name">{user.display_name || user.username}</Link><button className="logout" onClick={logout}>退出</button></div></aside>
    <div className="workspace-main"><header className="topbar"><span className="topbar-title">{currentModule?.label || '账户'}</span><Link className="mobile-brand" to="/">miniERP</Link><GlobalSearch /><div className="topbar-create"><DropdownMenu label="＋ 新建">{quick.map(item => <button key={item.to} onClick={() => { navigate(item.to) }}>{item.label}</button>)}</DropdownMenu></div><Link className="todo-badge" to="/#todo" aria-label={`待办 ${tasks} 项`}>待办 <b>{tasks}</b></Link></header>
      <main className="content">{topLevel && currentModule?.tabs.length > 1 && <Tabs items={currentModule.tabs} value={moduleTabValue(currentModule, location)} />}<ErrorBoundary key={currentPath}>{children}</ErrorBoundary></main>
    </div>
    <Drawer open={more} title="更多导航" onClose={() => setMore(false)}><nav className="mobile-drawer-nav" aria-label="全部模块" onClick={() => setMore(false)}>{modules.map(navLink)}</nav><h3>快捷新建</h3><div className="quick-actions">{quick.map(item => <Link key={item.to} to={item.to} className="button secondary" onClick={() => setMore(false)}>{item.label}</Link>)}</div><div className="actions"><Link to="/profile" onClick={() => setMore(false)}>我的信息</Link><Button onClick={logout}>退出登录</Button></div></Drawer>
    <nav className="bottom-nav" aria-label="移动导航">{mobile.map(navLink)}<button onClick={() => setMore(value => !value)} aria-expanded={more}>••• 更多</button></nav>
  </div>
}

export function Workbench({ user, children }) {
  const { data, error } = useWorkbench(user)
  const cards = []
  for (const item of data?.pending_documents || []) cards.push({ label: `待审批 · ${item.label}`, count: item.count, to: `/${item.group}?f.status=SUBMITTED&f.doc_type=${item.doc_type}${item.group === 'inventory' ? '#documents' : ''}` })
  if (can(user, 'WAREHOUSE', 'ADMIN')) {
    cards.push({ label: '待审批 · 申请', count: data?.pending_requests, to: '/requests?f.status=SUBMITTED' }, { label: '待放行 · 申请', count: data?.approved_requests, to: '/requests?f.status=APPROVED' })
  }
  for (const item of data?.my_draft_documents_by_group || []) cards.push({ label: `我的草稿 · ${{ sales: '销售', purchase: '采购', inventory: '库存' }[item.group]}`, count: item.count, to: `/${item.group}?mine=true&f.status=DRAFT${item.group === 'inventory' ? '#documents' : ''}` })
  cards.push({ label: '我的草稿 · 申请', count: data?.my_draft_requests, to: '/requests?mine=true&f.status=DRAFT' }, { label: '待处理冲突', count: data?.pending_conflicts, to: '/conflicts?f.status_code=pending_review' })
  const pending = cards.filter(item => item.count > 0)
  return <section className="workbench"><PageHeading eyebrow="今天" title={`你好，${user.display_name || user.username}`} description="从待办开始，掌握今天的业务进展。" /><ErrorBox error={error} />
    <section id="todo" className="workbench-section"><h2>待办事项</h2>{!data && !error ? <p role="status">正在汇总待办…</p> : pending.length ? <div className="todo-grid">{pending.map(item => <Link className="todo-card" key={item.label} to={item.to}><strong>{item.count}</strong><span>{item.label}</span><small>立即处理 →</small></Link>)}</div> : !error && <EmptyState>今日无待办，可从快捷入口开始新的业务。</EmptyState>}</section>
    {!can(user, 'WAREHOUSE', 'ADMIN') && data?.pending_requests > 0 && <section className="workbench-section"><h2>审批中</h2><Link to="/requests?f.status=SUBMITTED">{data.pending_requests} 条申请等待审批 →</Link></section>}
    {(data?.zero_stock_products > 0 || data?.over_credit_customers > 0) && <section className="workbench-section"><h2>需要关注</h2><div className="exception-list">{data.zero_stock_products > 0 && <Link to="/inventory?stock=nonpositive">零库存或负库存货品 <b>{data.zero_stock_products}</b><small>存在余额不大于零的库位记录，不同单位分别核对。</small></Link>}{data.over_credit_customers > 0 && <Link to="/master/customers?over_credit=true">应收超信用客户 <b>{data.over_credit_customers}</b></Link>}</div></section>}
    <section className="workbench-section"><h2>快捷入口</h2><div className="quick-actions">{quickActions(user).map(item => <Link key={item.to} to={item.to} className="button-link secondary">{item.label}</Link>)}</div></section>
    <section className="workbench-section"><h2>库存概览</h2>{children}</section>
  </section>
}
