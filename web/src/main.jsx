import React, { useCallback, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import api from './api'
import { findProductMatches } from './scan-utils'
import { ScanStateHeading } from './scan-ui'
import DataTable, { toServerFilters } from './data-table'
import ProductGallery from './product-gallery'
import { formatInventorySummary, formatMoney, formatQuantity } from './list-utils'
import { isInventoryDocumentPath, isNavigationItemActive, normalizePath } from './navigation-utils'
import { ROLE_LABELS, can, canView } from './roles'
import { DOC_GROUP_TYPES, documentRoute } from './documents'
import { masterRoute } from './master-data'
import { reportRoute } from './reports'
import { prepareImage } from './image-utils'
import { SerialDetail, SerialEntry, SerialLedger } from './serial'

import {
  Back, Badge, Button, Empty, ErrorBoundary, ErrorBox, Field, Link, Loading, NavLink, PageHeading,
  RouterContext, useDirtyLeaveGuard, useIsMobile, useRouter,
} from './ui'

function FuzzyTag({ item }) {
  if (!item || item.match_type !== 'fuzzy') return null
  return <span className="fuzzy-badge">模糊 {Math.round((item.match_score || 0) * 100)}%</span>
}

function Login({ onLogin }) {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  async function submit(e) { e.preventDefault(); setError(''); setBusy(true); try { onLogin(await api.login(username, password)) } catch (err) { setError(err) } finally { setBusy(false) } }
  return <main className="login-shell"><form className="login-card" onSubmit={submit}><div className="brand-mark">miniERP</div><h1>欢迎回来</h1><p className="muted">进销存业务管理 · 采购 / 销售 / 库存</p><Field label="账号"><input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required /></Field><Field label="密码"><input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></Field><ErrorBox error={error} /><Button className="primary wide" disabled={busy}>{busy ? '登录中…' : '登录'}</Button></form></main>
}

function Layout({ user, children, onLogout }) {
  const { currentPath } = useRouter(); const [more, setMore] = useState(false)
  useEffect(() => { setMore(false) }, [currentPath])
  const admin = canView(user, 'system')
  const roleLabel = ROLE_LABELS[user.role] || user.role
  const items = [{ to: '/', icon: '▦', label: '库存总览' }]
  if (canView(user, 'count')) items.push({ to: '/count', icon: '☑', label: '清点库存' })
  items.push({ to: '/products', icon: '⌕', label: '货品搜索' })
  if (can(user, 'COLLEAGUE')) items.push({ to: '/requests', icon: '□', label: '我的申请' })
  if (can(user, 'WAREHOUSE', 'ADMIN')) items.push({ to: '/requests', icon: '□', label: '审批队列' })
  const groups = []
  if (canView(user, 'purchase')) groups.push({ label: '采购', items: [{ to: '/purchase', icon: '⇩', label: '采购单据' }, { to: '/master/suppliers', icon: '◈', label: '供应商档案' }] })
  if (canView(user, 'sales')) groups.push({ label: '销售', items: [{ to: '/sales', icon: '⇧', label: '销售单据' }, { to: '/master/customers', icon: '◈', label: '客户档案' }] })
  if (canView(user, 'inventoryDocs')) groups.push({ label: '库存', items: [{ to: '/inventory', icon: '⇄', label: '库存单据' }, { to: '/serials', icon: '▣', label: '序列台账' }] })
  if (canView(user, 'reports')) groups.push({ label: '财务', items: [{ to: '/reports/purchase', icon: '⌁', label: '采购对账' }, { to: '/reports/arap', icon: '⇅', label: '应收应付' }, { to: '/reports/inventory-cost', icon: '¥', label: '库存成本' }] })
  if (canView(user, 'system')) groups.push({ label: '系统', items: [{ to: '/master/categories', icon: '▤', label: '商品分类' }, { to: '/conflicts', icon: '!', label: '冲突中心' }, { to: '/admin', icon: '⚙', label: '系统管理' }, { to: '/audit', icon: '◷', label: '操作审计' }] })
  const flatItems = [...items, ...groups.flatMap(g => g.items)]
  const moreItems = [{ to: '/profile', icon: '◎', label: '我的信息' }]
  async function logout() { try { await api.logout() } finally { onLogout() } }
  const moreActive = [...flatItems.slice(3), ...moreItems].some(x => isNavigationItemActive(currentPath, x.to))
  const navContents = item => <><span className="nav-icon" aria-hidden="true">{item.icon}</span><span className="nav-label">{item.label}</span></>
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-dot" />miniERP</div>
      <nav aria-label="主导航">{items.map(item => <NavLink className="nav-link" key={item.to} to={item.to}>{navContents(item)}</NavLink>)}{groups.map(group => <div key={group.label}><p className="nav-group">{group.label}</p>{group.items.map(item => <NavLink className="nav-link" key={item.to} to={item.to}>{navContents(item)}</NavLink>)}</div>)}</nav>
      <div className="sidebar-foot"><Badge tone={admin ? 'teal' : 'neutral'}>{roleLabel}</Badge><span className="user-name">{user.display_name || user.username}</span><button className="logout" onClick={logout}>退出</button></div>
    </aside>
    <main className="content">
      <header className="mobile-header"><Link to="/" className="brand"><span className="brand-dot" />miniERP</Link><button className="icon-button" onClick={() => setMore(!more)} aria-label="打开菜单" aria-expanded={more}>☰</button></header>
      {more && <div className="mobile-menu" role="dialog" aria-label="更多导航">{[...flatItems, ...moreItems].map(item => <NavLink className="nav-link" key={item.to} to={item.to} onClick={() => setMore(false)}>{navContents(item)}</NavLink>)}<button className="mobile-logout" onClick={logout}>退出登录</button></div>}
      <ErrorBoundary key={currentPath}>{children}</ErrorBoundary>
    </main>
    <nav className="bottom-nav" aria-label="移动导航">{flatItems.slice(0, 3).map(item => <NavLink key={item.to} to={item.to}><span className="nav-icon" aria-hidden="true">{item.icon}</span><small>{item.label}</small></NavLink>)}<button onClick={() => setMore(!more)} aria-expanded={more} aria-current={moreActive ? 'page' : undefined}><span aria-hidden="true">•••</span><small>更多</small></button></nav>
  </div>
}

function Dashboard() {
  const [rows, setRows] = useState([]); const [error, setError] = useState(null)
  useEffect(() => {
    api.inventory().then(setRows).catch(setError)
  }, [])
  const productCount = useMemo(() => new Set(rows.map(row => row.product_id)).size, [rows])
  const locationCount = useMemo(() => new Set(rows.map(row => row.location_id)).size, [rows])
  const conditionOptions = useMemo(() => [...new Set(rows.map(r => r.condition_code).filter(Boolean))].map(c => ({ value: c, label: c })), [rows])
  const columns = useMemo(() => [
    { key: 'identifier', label: '业务编号', value: r => r.identifier || '—' },
    { key: 'product_name', label: '货品名称', filterType: 'search', searchKeys: ['identifier', 'product_name', 'manufacturer', 'specification', 'location_name', 'condition_code', 'uom_code'] },
    { key: 'location_name', label: '库位', filterType: 'text', value: r => r.location_name || '—' },
    { key: 'condition_code', label: '成色', filterType: 'select', filterOptions: conditionOptions, value: r => r.condition_code || '—' },
    { key: 'on_hand_quantity', label: '现库存', align: 'end', value: r => formatQuantity(r.on_hand_quantity) },
    { key: 'uom_code', label: '单位', value: r => r.uom_code || '—' },
  ], [conditionOptions])
  const inventoryKey = r => `${r.product_id}:${r.location_id}:${r.condition_id}:${r.uom_id}`
  return <section><PageHeading eyebrow="总览" title="库存工作台" description="按编号、货品、库位、成色和单位查看已过账余额。" /><div className="stats"><div className="stat"><span>库存维度</span><strong>{rows.length}</strong></div><div className="stat teal"><span>货品数</span><strong>{productCount}</strong></div><div className="stat"><span>库位数</span><strong>{locationCount}</strong></div></div><div className="panel"><div className="panel-head"><div><h2>库存余额</h2><p className="muted">余额来自已过账流水；不同单位分别展示。</p></div></div><ErrorBox error={error} /><DataTable
    mode="client"
    columns={columns}
    rows={rows}
    rowKey={inventoryKey}
    rowHref={r => `/inventory/${r.product_id}/${r.location_id}/${r.condition_id}/${r.uom_id}`}
    exportConfig={{
      endpoint: '/api/inventory/balance/export',
      filename: '库存余额',
      allScope: 'server',
      buildParams: ({ q, filters, sortKey, sortDir }) => ({ q, f: toServerFilters(filters, columns), sort: sortKey || '', order: sortDir }),
    }}
  /></div></section>
}

function ProductList({ user }) {
  const { navigate } = useRouter(); const [error, setError] = useState(null)
  const fetchProducts = useCallback((p, signal) => api.products({ ...p, signal }), [])
  const columns = useMemo(() => [
    { key: 'identifier', label: '业务编号', value: r => r.identifier || '—' },
    { key: 'display_name', label: '货品名称', filterType: 'search' },
    { key: 'manufacturer', label: '厂家', filterType: 'text', value: r => r.manufacturer || '—' },
    { key: 'specification', label: '规格 / 型号', filterType: 'text', value: r => r.specification || '—' },
    { key: 'stock', label: '现库存', align: 'end', sortable: false, value: r => { const summary = formatInventorySummary(r.stock_summary); return summary === '无库存' ? `无库存 · ${r.uom_code || '—'}` : summary } },
    { key: 'uom_code', label: '默认单位', value: r => r.uom_code || '—' },
  ], [])
  return <section><PageHeading eyebrow="主数据" title="货品" description="搜索并维护编号、名称、厂家、规格、库存和单位。">{user.role === 'ADMIN' && <Button className="primary" onClick={() => navigate('/products/new')}>＋ 新增货品</Button>}</PageHeading><div className="panel"><ErrorBox error={error} /><DataTable
    mode="server"
    columns={columns}
    fetchData={fetchProducts}
    rowKey={r => String(r.product_id)}
    rowHref={r => `/products/${r.product_id}`}
    onError={setError}
    exportConfig={{
      endpoint: '/api/products/export',
      filename: '货品',
      allScope: 'server',
      buildParams: ({ q, filters, sortKey, sortDir }) => ({ q, f: toServerFilters(filters, columns), sort: sortKey || '', order: sortDir }),
    }}
  /></div></section>
}

function ProductForm({ id }) {
  const { navigate } = useRouter(); const [form, setForm] = useState({ display_name: '', manufacturer: '', specification: '', source_uom_raw: '个', default_uom_id: '', primary_identifier: '', category_id: '', purchase_cost_price: '', sales_price: '', serialized: false }); const baseline = useRef(JSON.stringify(form)); const [uoms, setUoms] = useState([]); const [categories, setCategories] = useState([]); const [error, setError] = useState(null); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false)
  const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form])
  useDirtyLeaveGuard(dirty)
  useEffect(() => { api.uoms().then(setUoms).catch(setError); api.categories().then(setCategories).catch(() => {}); if (id) api.product(id).then(p => { const next = { display_name: p.display_name || '', manufacturer: p.manufacturer || '', specification: p.specification || '', source_uom_raw: p.source_uom_raw || '', default_uom_id: p.default_uom_id || '', primary_identifier: p.primary_identifier?.value_raw || '', category_id: p.category_id || '', purchase_cost_price: p.purchase_cost_price != null ? String(p.purchase_cost_price) : '', sales_price: p.sales_price != null ? String(p.sales_price) : '', serialized: !!p.serialized }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id])
  function set(k, v) { setForm(x => ({ ...x, [k]: v })) }
  async function save(e) { e.preventDefault(); setError(null); setMessage(''); setBusy(true); try { const payload = { ...form, serialized: !!form.serialized, default_uom_id: form.default_uom_id ? Number(form.default_uom_id) : null, primary_identifier: form.primary_identifier || null, category_id: form.category_id ? Number(form.category_id) : null, purchase_cost_price: form.purchase_cost_price !== '' ? Number(form.purchase_cost_price) : 0, sales_price: form.sales_price !== '' ? Number(form.sales_price) : 0 }; const result = id ? await api.updateProduct(id, payload) : await api.createProduct(payload); setMessage(result.identifier_conflicts?.length ? '已保存；编号与其他货品冲突，请复核。' : '已保存'); setTimeout(() => navigate(`/products/${result.product_id || id}`), 350) } catch (err) { setError(err) } finally { setBusy(false) } }
  return <section><Back to={id ? `/products/${id}` : '/products'} /><PageHeading eyebrow="主数据" title={id ? '编辑货品' : '新增货品'} description="设置采购成本价、销售售价与分类；重复编号会提示但不会覆盖其他货品。" /><form className="panel form-grid" onSubmit={save}><Field label="货品名"><input required value={form.display_name} onChange={e => set('display_name', e.target.value)} /></Field><Field label="来源/标签编号"><input value={form.primary_identifier} onChange={e => set('primary_identifier', e.target.value)} /></Field><Field label="厂家"><input value={form.manufacturer} onChange={e => set('manufacturer', e.target.value)} /></Field><Field label="规格/型号"><input value={form.specification} onChange={e => set('specification', e.target.value)} /></Field><Field label="商品分类"><select value={form.category_id} onChange={e => set('category_id', e.target.value)}><option value="">未分类</option>{categories.map(c => <option key={c.category_id} value={c.category_id}>{'　'.repeat(c.depth)}{c.name}</option>)}</select></Field><Field label="默认单位"><select required value={form.default_uom_id} onChange={e => set('default_uom_id', e.target.value)}><option value="">请选择</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field><Field label="采购成本价（¥）"><input type="number" min="0" step="0.01" value={form.purchase_cost_price} onChange={e => set('purchase_cost_price', e.target.value)} /></Field><Field label="销售售价（¥）"><input type="number" min="0" step="0.01" value={form.sales_price} onChange={e => set('sales_price', e.target.value)} /></Field><Field label="原始单位"><input value={form.source_uom_raw} onChange={e => set('source_uom_raw', e.target.value)} /></Field><label className="check-field span-2"><input type="checkbox" checked={form.serialized} onChange={e => set('serialized', e.target.checked)} /> 需序列号追踪（该货品单件可登记 SN；登记可选，过账不强制）</label><ErrorBox error={error} /><div className="actions span-2">{message && <span className="success-text">{message}</span>}<Button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/products/${id}` : '/products')}>取消</Button></div></form></section>
}

function ProductDetail({ id, user }) {
  const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null)
  useEffect(() => { api.product(id).then(setData).catch(setError) }, [id])
  if (error) return <section><Back to="/products" /><ErrorBox error={error} /></section>; if (!data) return <Loading />
  const canEdit = user.role === 'ADMIN' || user.role === 'WAREHOUSE'
  return <section><Back to="/products" /><PageHeading eyebrow="货品详情" title={data.display_name} description={data.manufacturer || '未填写厂家'}>{user.role === 'ADMIN' && <Button className="primary" onClick={() => navigate(`/products/${id}/edit`)}>编辑</Button>}</PageHeading><div className="detail-grid"><div className="panel"><h2>主数据</h2><dl className="detail-list"><dt>来源编号</dt><dd>{data.primary_identifier?.value_raw || '—'}</dd><dt>规格/型号</dt><dd>{data.specification || '—'}</dd><dt>默认单位</dt><dd>{data.uom_display_name || data.uom_code || '—'}</dd><dt>原始单位</dt><dd>{data.source_uom_raw || '—'}</dd><dt>序列号追踪</dt><dd>{data.serialized ? <Badge tone="teal">开启</Badge> : '关闭'}</dd><dt>更新时间</dt><dd>{data.updated_at ? new Date(data.updated_at).toLocaleString() : '—'}</dd></dl>{data.identifier_conflicts?.length > 0 && <div className="alert warning">此编号还被 {data.identifier_conflicts.length} 个货品使用，请在冲突中心或详情中复核。</div>}</div><div className="panel"><h2>历史编号</h2>{data.identifiers?.length ? <div className="tag-list">{data.identifiers.map(x => <Badge key={x.product_identifier_id} tone={x.is_primary ? 'teal' : 'neutral'}>{x.value_raw}</Badge>)}</div> : <Empty>暂无编号</Empty>}</div></div><div className="panel"><h2>图片</h2><ProductGallery productId={id} canEdit={canEdit} /></div></section>
}

function ScanPicker({ onAdd }) {
  const [menu, setMenu] = useState(false); const [state, setState] = useState('idle'); const [error, setError] = useState(null); const [warning, setWarning] = useState(''); const [terms, setTerms] = useState([]); const [matches, setMatches] = useState([]); const cameraRef = useRef(null); const galleryRef = useRef(null); const abortRef = useRef(null); const searchToken = useRef(0)
  async function findMatches(searchTerms) {
    const token = ++searchToken.current
    const found = await findProductMatches(searchTerms, async value => (await api.products(value, 1, 30, { signal: abortRef.current?.signal })).items || [])
    if (token === searchToken.current) { setMatches(found); setState('result') }
  }
  async function fileSelected(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setMenu(false); setError(null); setWarning(''); setMatches([]); setState('processing')
    try {
      const image = await prepareImage(file)
      abortRef.current?.abort()
      abortRef.current = new AbortController()
      const result = await api.ocrExtract(image, abortRef.current.signal)
      const searchTerms = result.search_terms || []
      setTerms(searchTerms)
      if (result.status === 'reshoot_required') {
        setWarning((result.warnings || []).join('；') || '图片不够清晰，请重拍')
        setState('reshoot')
        return
      }
      if (result.status === 'partial') {
        setWarning((result.warnings || []).join('；') || '识别结果需要复核，请确认后匹配')
        setState('partial')
        return
      }
      await findMatches(searchTerms)
    } catch (err) {
      if (err.name !== 'AbortError') { setError(err); setState('error') }
    }
  }
  useEffect(() => () => abortRef.current?.abort(), [])
  return <div className="scan-wrap">
    <div className="scan-control"><Button type="button" className="scan-button" onClick={() => setMenu(!menu)} disabled={state === 'processing'} aria-expanded={menu}>⌾ 扫描</Button>{menu && <div className="scan-menu"><button type="button" onClick={() => cameraRef.current?.click()}>拍照</button><button type="button" onClick={() => galleryRef.current?.click()}>从相册选择</button></div>}<input ref={cameraRef} hidden type="file" accept="image/*" capture="environment" onChange={fileSelected} /><input ref={galleryRef} hidden type="file" accept="image/*,.heic,.heif" onChange={fileSelected} /></div>
    {state === 'processing' && <div className="scan-status">图片处理中并识别…</div>}
    {(['result', 'partial', 'reshoot', 'error'].includes(state)) && <div className="scan-result"><div className="scan-result-head"><ScanStateHeading state={state} /><button type="button" className="close-button" onClick={() => setState('idle')} aria-label="关闭扫描结果">×</button></div><ErrorBox error={error} />{warning && <div className="alert warning">{warning}</div>}{state === 'partial' && <Button type="button" className="secondary" onClick={() => findMatches(terms)}>确认并匹配</Button>}{terms.length > 0 && <div className="term-list">{terms.map(t => <button type="button" key={`${t.kind}-${t.normalized}`} onClick={async () => { const token = ++searchToken.current; const r = await api.products(t.value, 1, 30, { signal: abortRef.current?.signal }); if (token === searchToken.current) { setMatches(r.items || []); setState('result') } }}>{t.value}</button>)}</div>}{matches.length > 0 && <div className="match-list"><p className="muted">点击货品加入申请明细</p>{matches.map(p => <button type="button" key={p.product_id} onClick={() => { onAdd(p); setState('idle'); setMatches([]) }}><strong>{p.display_name}<FuzzyTag item={p} /></strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}{state === 'result' && matches.length === 0 && <p className="muted">没有匹配货品，请重拍或手工输入关键词。</p>}</div>}
  </div>
}

function RequestList({ user }) {
  const { navigate } = useRouter(); const [rows, setRows] = useState([]); const [error, setError] = useState(null)
  useEffect(() => { api.requests().then(setRows).catch(setError) }, [])
  const columns = useMemo(() => [
    { key: 'request_no', label: '单号', filterType: 'search' },
    { key: 'request_type', label: '类型', filterType: 'select', filterOptions: [{ value: 'RECEIPT', label: '入库' }, { value: 'ISSUE_OTHER', label: '出库' }, { value: 'TRANSFER', label: '调货' }, { value: 'RETURN', label: '退回' }] },
    { key: 'requester', label: '申请人', value: r => r.requester_display_name || r.requester_username || '—' },
    { key: 'status', label: '状态', filterType: 'select', filterOptions: [{ value: 'DRAFT', label: '草稿' }, { value: 'SUBMITTED', label: '已提交' }, { value: 'APPROVED', label: '已审批' }, { value: 'RELEASED', label: '已放行' }, { value: 'REJECTED', label: '已驳回' }] },
    { key: 'line_count', label: '明细数', value: r => r.line_count || 0 },
    { key: 'created_at', label: '时间', value: r => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
  ], [])
  return <section><PageHeading eyebrow="OA 流程" title={can(user, 'WAREHOUSE', 'ADMIN') ? '审批队列' : '我的申请'} description="每一条申请都可以进入详情；草稿支持继续编辑。"><Button className="primary" onClick={() => navigate('/requests/new')}>＋ 新建申请</Button></PageHeading><div className="panel"><ErrorBox error={error} /><DataTable
    mode="client"
    columns={columns}
    rows={rows}
    rowKey={r => String(r.stock_request_id)}
    rowHref={r => `/requests/${r.stock_request_id}`}
    exportConfig={{ endpoint: '/api/stock-requests/export', filename: '库存申请', allScope: 'ids' }}
  /></div></section>
}

function RequestForm({ id, initial, prefillProductId }) {
  const { navigate } = useRouter(); const [form, setForm] = useState({ request_type: 'ISSUE_OTHER', source_location_id: '', destination_location_id: '', reason: '', lines: [] }); const baseline = useRef(JSON.stringify(form)); const [products, setProducts] = useState([]); const [locations, setLocations] = useState([]); const [q, setQ] = useState(''); const [error, setError] = useState(null); const [busy, setBusy] = useState(false); const [uoms, setUoms] = useState([])
  const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form])
  useDirtyLeaveGuard(dirty)
  useEffect(() => { api.locations().then(setLocations).catch(setError); api.uoms().then(setUoms).catch(setError); if (initial) { const next = { request_type: initial.request_type, source_location_id: initial.source_location_id || '', destination_location_id: initial.destination_location_id || '', reason: initial.reason || '', lines: initial.lines.map(x => ({ product_id: x.product_id, product_name: x.product_name, quantity: x.quantity, uom_id: x.uom_id, uom_code: x.uom_code, source_uom_raw: x.source_uom_raw || '个', notes: x.notes || '', source_location_id: x.source_location_id || '', destination_location_id: x.destination_location_id || '' })) }; baseline.current = JSON.stringify(next); setForm(next) } else if (prefillProductId) api.product(prefillProductId).then(addProduct).catch(setError) }, [initial, prefillProductId])
  useEffect(() => { if (!q) { setProducts([]); return }; const controller = new AbortController(); const t = setTimeout(() => api.products({ q, page: 1, page_size: 30, signal: controller.signal }).then(x => { if (!controller.signal.aborted) setProducts(x.items || []) }).catch(err => { if (err.name !== 'AbortError') setError(err) }), 180); return () => { clearTimeout(t); controller.abort() } }, [q])
  function addProduct(p) { setForm(x => ({ ...x, lines: [...x.lines, { product_id: p.product_id, product_name: p.display_name, quantity: 1, uom_id: p.uom_id || '', uom_code: p.uom_code || '', source_uom_raw: p.source_uom_raw || '个', notes: '', source_location_id: '', destination_location_id: '' }] })); setQ(''); setProducts([]) }
  function updateLine(index, key, value) { setForm(x => ({ ...x, lines: x.lines.map((line, i) => i === index ? { ...line, [key]: value } : line) })) }
  async function save(e) { e.preventDefault(); setError(null); setBusy(true); try { const payload = { request_type: form.request_type, source_location_id: form.source_location_id || null, destination_location_id: form.destination_location_id || null, reason: form.reason || null, lines: form.lines.map(x => ({ product_id: Number(x.product_id), quantity: Number(x.quantity), uom_id: x.uom_id ? Number(x.uom_id) : null, uom_code: x.uom_code || null, source_uom_raw: x.source_uom_raw || '个', source_location_id: x.source_location_id ? Number(x.source_location_id) : null, destination_location_id: x.destination_location_id ? Number(x.destination_location_id) : null, notes: x.notes || null })) }; const result = id ? await api.updateRequest(id, { ...payload, version: initial.version }) : await api.createRequest(payload); navigate(`/requests/${result.stock_request_id}`) } catch (err) { setError(err) } finally { setBusy(false) } }
  const typeLabels = { RECEIPT: '入库', ISSUE_OTHER: '出库', TRANSFER: '调货', RETURN: '退回' }
  return <section><Back to={id ? `/requests/${id}` : '/requests'} /><PageHeading eyebrow="OA 流程" title={id ? '编辑申请' : '新建申请'} description="先保存草稿，再提交给仓管处理。" /><form className="panel form-grid" onSubmit={save}><Field label="申请类型"><select value={form.request_type} onChange={e => setForm({ ...form, request_type: e.target.value })}>{Object.entries(typeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="原因/备注"><input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></Field><Field label="默认来源库位"><select value={form.source_location_id} onChange={e => setForm({ ...form, source_location_id: e.target.value })}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || l.location_type}</option>)}</select></Field><Field label="默认目的库位"><select value={form.destination_location_id} onChange={e => setForm({ ...form, destination_location_id: e.target.value })}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || l.location_type}</option>)}</select></Field><div className="span-2 picker-field"><span className="field-label">添加货品</span><div className="picker-row"><input value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" /><ScanPicker onAdd={addProduct} /></div>{products.length > 0 && <div className="picker-results">{products.map(p => <button type="button" key={p.product_id} onClick={() => addProduct(p)}><strong>{p.display_name}<FuzzyTag item={p} /></strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}</div><div className="span-2 line-editor"><div className="line-editor-head"><h2>申请明细 ({form.lines.length})</h2><span className="muted">可重复添加同一货品</span></div>{form.lines.length ? form.lines.map((line, i) => <article className="line-card" key={`${line.product_id}-${i}`}><div className="line-title"><div><strong>{line.product_name || `货品 ${line.product_id}`}</strong><small>{line.uom_code || line.source_uom_raw || '—'}</small></div><button type="button" className="danger-link" onClick={() => setForm(x => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))}>删除</button></div><div className="line-fields"><Field label="数量"><input type="number" min="0.001" step="0.001" value={line.quantity} onChange={e => updateLine(i, 'quantity', e.target.value)} /></Field><Field label="单位"><select value={line.uom_id || ''} onChange={e => { const value = e.target.value; const u = uoms.find(x => String(x.uom_id) === value); updateLine(i, 'uom_id', value); updateLine(i, 'uom_code', u?.code || line.uom_code) }}><option value="">跟随货品</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field><Field label="单行来源库位"><select value={line.source_location_id || ''} onChange={e => updateLine(i, 'source_location_id', e.target.value)}><option value="">跟随默认</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name}</option>)}</select></Field><Field label="单行目的库位"><select value={line.destination_location_id || ''} onChange={e => updateLine(i, 'destination_location_id', e.target.value)}><option value="">跟随默认</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name}</option>)}</select></Field></div><Field label="明细备注"><input value={line.notes} onChange={e => updateLine(i, 'notes', e.target.value)} /></Field></article>) : <Empty>还没有添加货品</Empty>}</div><ErrorBox error={error} /><div className="span-2 actions"><Button className="primary" disabled={busy}>{busy ? '保存中…' : '保存草稿'}</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/requests/${id}` : '/requests')}>取消</Button></div></form></section>
}

function RequestDetail({ id, user }) {
  const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null); const [busy, setBusy] = useState(false); const [rejectReason, setRejectReason] = useState(''); const [rejecting, setRejecting] = useState(false)
  const reload = () => api.stockRequest(id).then(setData).catch(setError); useEffect(() => { reload() }, [id])
  if (!data) return error ? <section><Back to="/requests" /><ErrorBox error={error} /></section> : <Loading />
  const isWarehouse = can(user, 'WAREHOUSE', 'ADMIN')
  const canEdit = data.status === 'DRAFT' && (isWarehouse || data.requester_user_id === user.user_id) || data.status === 'SUBMITTED' && isWarehouse
  async function action(name, payload) { setBusy(true); setError(null); try { await api.action(id, name, payload); await reload(); if (name === 'reject') { setRejecting(false); setRejectReason('') } } catch (err) { setError(err) } finally { setBusy(false) } }
  return <section><Back to="/requests" /><PageHeading eyebrow="申请详情" title={data.request_no} description={`${data.request_type} · ${data.requester_display_name || data.requester_username || '申请人'}`}><Badge tone={data.status === 'RELEASED' ? 'green' : data.status === 'REJECTED' ? 'red' : 'amber'}>{data.status}</Badge></PageHeading><div className="detail-grid"><div className="panel"><h2>申请信息</h2><dl className="detail-list"><dt>原因</dt><dd>{data.reason || '—'}</dd><dt>来源库位</dt><dd>{data.source_location_id || '默认/明细指定'}</dd><dt>目的库位</dt><dd>{data.destination_location_id || '默认/明细指定'}</dd><dt>版本</dt><dd>{data.version}</dd></dl></div><div className="panel"><h2>明细</h2><div className="detail-lines">{data.lines.map(line => <div className="detail-line" key={line.stock_request_line_id}><div><strong>{line.product_name}</strong><span>{line.specification || '—'} · {line.uom_code || '—'}</span></div><b>{line.quantity}</b></div>)}</div></div></div><div className="panel actions-panel"><div className="actions">{canEdit && <Button className="primary" onClick={() => navigate(`/requests/${id}/edit`)}>编辑</Button>}{data.status === 'DRAFT' && data.requester_user_id === user.user_id && <Button className="secondary" onClick={() => action('submit')} disabled={busy}>提交</Button>}{data.status === 'SUBMITTED' && data.requester_user_id === user.user_id && <Button className="secondary" onClick={() => action('withdraw')} disabled={busy}>撤回到草稿</Button>}{can(user, 'WAREHOUSE', 'ADMIN') && data.status === 'SUBMITTED' && <><Button className="secondary" onClick={() => action('approve')} disabled={busy}>审批</Button><Button className="danger" onClick={() => setRejecting(true)} disabled={busy}>驳回</Button></>}{can(user, 'WAREHOUSE', 'ADMIN') && data.status === 'APPROVED' && <Button className="primary" onClick={() => action('release')} disabled={busy}>放行</Button>}</div>{rejecting && <div className="reject-panel"><Field label="驳回原因"><textarea rows="3" autoFocus value={rejectReason} onChange={event => setRejectReason(event.target.value)} placeholder="请输入明确的驳回原因" /></Field><div className="actions"><Button className="danger" onClick={() => action('reject', { reason: rejectReason.trim() })} disabled={busy || !rejectReason.trim()}>确认驳回</Button><Button className="secondary" onClick={() => { setRejecting(false); setRejectReason('') }} disabled={busy}>取消</Button></div></div>}<h3>操作记录</h3>{data.actions?.map(a => <div className="timeline-row" key={a.stock_request_action_id}><span>{a.action}</span><small>{a.actor_display_name || a.actor_username || '—'} · {new Date(a.created_at).toLocaleString()}</small></div>)}</div></section>
}

function AdminPage() {
  const [users, setUsers] = useState([]); const [locations, setLocations] = useState([]); const [error, setError] = useState(null); const { navigate } = useRouter(); const reload = () => Promise.all([api.users(), api.locations()]).then(([u, l]) => { setUsers(u); setLocations(l) }).catch(setError); useEffect(() => { reload() }, [])
  const userColumns = useMemo(() => [
    { key: 'display_name', label: '显示名', filterType: 'search', searchKeys: ['display_name', 'username'] },
    { key: 'username', label: '用户名' },
    { key: 'role', label: '角色', filterType: 'select', filterOptions: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })) },
    { key: 'is_active', label: '状态', filterType: 'select', filterOptions: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }], value: r => r.is_active, render: r => r.is_active ? '启用' : '停用' },
    { key: 'created_at', label: '创建时间', value: r => r.created_at ? new Date(r.created_at).toLocaleDateString() : '—' },
  ], [])
  const locationColumns = useMemo(() => [
    { key: 'name', label: '名称', filterType: 'search', searchKeys: ['name', 'code'] },
    { key: 'code', label: '编码', value: r => r.code || '无编码' },
    { key: 'location_type', label: '类型', filterType: 'select', filterOptions: [{ value: 'warehouse', label: '仓库' }, { value: 'hospital', label: '医院' }, { value: 'department', label: '科室' }, { value: 'customer', label: '客户' }, { value: 'external', label: '外部' }, { value: 'transit', label: '在途' }, { value: 'other', label: '其他' }] },
    { key: 'is_company_inventory', label: '公司库存', filterType: 'select', filterOptions: [{ value: 'true', label: '是' }, { value: 'false', label: '否' }], value: r => r.is_company_inventory, render: r => r.is_company_inventory ? '是' : '否' },
    { key: 'is_active', label: '状态', filterType: 'select', filterOptions: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }], value: r => r.is_active, render: r => r.is_active ? '启用' : '停用' },
  ], [])
  return <section><PageHeading eyebrow="系统管理" title="用户与库位" description="稳定编码不可改，业务字段修改会留下审计。"><div className="actions"><Button className="primary" onClick={() => navigate('/admin/users/new')}>＋ 用户</Button><Button className="secondary" onClick={() => navigate('/admin/locations/new')}>＋ 库位</Button></div></PageHeading><ErrorBox error={error} /><div className="panel"><h2>用户</h2><DataTable mode="client" columns={userColumns} rows={users} rowKey={u => String(u.user_id)} rowHref={u => `/admin/users/${u.user_id}`} exportConfig={{ endpoint: '/api/admin/users/export', filename: '用户', allScope: 'ids' }} /></div><div className="panel"><h2>库位</h2><DataTable mode="client" columns={locationColumns} rows={locations} rowKey={l => String(l.location_id)} rowHref={l => `/admin/locations/${l.location_id}`} exportConfig={{ endpoint: '/api/locations/export', filename: '库位', allScope: 'ids' }} /></div></section>
}

function UserForm({ id }) {
  const { navigate } = useRouter(); const [form, setForm] = useState({ display_name: '', role: 'COLLEAGUE', is_active: true, password: '' }); const baseline = useRef(JSON.stringify(form)); const [error, setError] = useState(null); const [busy, setBusy] = useState(false)
  const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form])
  useDirtyLeaveGuard(dirty)
  useEffect(() => { if (id) api.user(id).then(x => { const next = { display_name: x.display_name, role: x.role, is_active: x.is_active, password: '' }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id]); async function save(e) { e.preventDefault(); setBusy(true); setError(null); try { const payload = { display_name: form.display_name, role: form.role, is_active: form.is_active }; if (form.password) payload.password = form.password; const result = id ? await api.updateUser(id, payload) : await api.createUser({ username: form.username, ...payload, password: form.password }); navigate(`/admin/users/${result.user_id || id}`) } catch (err) { setError(err) } finally { setBusy(false) } }
  return <section><Back to="/admin" /><PageHeading eyebrow="系统管理" title={id ? '编辑用户' : '新增用户'} /><form className="panel form-grid" onSubmit={save}>{!id && <Field label="用户名"><input required value={form.username || ''} onChange={e => setForm({ ...form, username: e.target.value })} /></Field>}<Field label="显示名"><input required value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} /></Field><Field label="角色"><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label={id ? '新密码（可选）' : '初始密码'}><input type="password" minLength="8" required={!id} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>{id && <label className="check-field"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} /> 启用账号</label>}<ErrorBox error={error} /><div className="span-2 actions"><Button className="primary" disabled={busy}>保存</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/admin/users/${id}` : '/admin')}>取消</Button></div></form></section>
}

function UserDetail({ id }) { const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null); useEffect(() => { api.user(id).then(setData).catch(setError) }, [id]); if (!data) return error ? <section><Back to="/admin" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/admin" /><PageHeading eyebrow="用户详情" title={data.display_name}><Button className="primary" onClick={() => navigate(`/admin/users/${id}/edit`)}>编辑</Button></PageHeading><div className="panel"><dl className="detail-list"><dt>用户名</dt><dd>{data.username}</dd><dt>角色</dt><dd>{data.role}</dd><dt>状态</dt><dd>{data.is_active ? '启用' : '停用'}</dd><dt>创建时间</dt><dd>{new Date(data.created_at).toLocaleString()}</dd></dl></div></section> }

function LocationForm({ id }) { const { navigate } = useRouter(); const [form, setForm] = useState({ code: '', name: '', location_type: 'warehouse', is_company_inventory: true, is_active: true }); const baseline = useRef(JSON.stringify(form)); const [error, setError] = useState(null); const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form]); useDirtyLeaveGuard(dirty); useEffect(() => { if (id) api.location(id).then(x => { const next = { code: x.code || '', name: x.name, location_type: x.location_type, is_company_inventory: x.is_company_inventory, is_active: x.is_active }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id]); async function save(e) { e.preventDefault(); setError(null); try { const result = id ? await api.updateLocation(id, { name: form.name, location_type: form.location_type, is_company_inventory: form.is_company_inventory, is_active: form.is_active }) : await api.createLocation(form); navigate(`/admin/locations/${result.location_id || id}`) } catch (err) { setError(err) } }
  return <section><Back to="/admin" /><PageHeading eyebrow="系统管理" title={id ? '编辑库位' : '新增库位'} /><form className="panel form-grid" onSubmit={save}><Field label="编码"><input required disabled={Boolean(id)} value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} /></Field><Field label="名称"><input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="类型"><select value={form.location_type} onChange={e => setForm({ ...form, location_type: e.target.value })}><option value="warehouse">仓库</option><option value="hospital">医院</option><option value="department">科室</option><option value="customer">客户</option><option value="external">外部</option><option value="transit">在途</option><option value="other">其他</option></select></Field><label className="check-field"><input type="checkbox" checked={form.is_company_inventory} onChange={e => setForm({ ...form, is_company_inventory: e.target.checked })} /> 公司库存</label>{id && <label className="check-field"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} /> 启用</label>}<ErrorBox error={error} /><div className="span-2 actions"><Button className="primary">保存</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/admin/locations/${id}` : '/admin')}>取消</Button></div></form></section> }

function LocationDetail({ id }) { const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null); useEffect(() => { api.location(id).then(setData).catch(setError) }, [id]); if (!data) return error ? <section><Back to="/admin" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/admin" /><PageHeading eyebrow="库位详情" title={data.name}><Button className="primary" onClick={() => navigate(`/admin/locations/${id}/edit`)}>编辑</Button></PageHeading><div className="panel"><dl className="detail-list"><dt>编码</dt><dd>{data.code || '—'}</dd><dt>类型</dt><dd>{data.location_type}</dd><dt>公司库存</dt><dd>{data.is_company_inventory ? '是' : '否'}</dd><dt>状态</dt><dd>{data.is_active ? '启用' : '停用'}</dd></dl></div></section> }

const CONFLICT_TYPE_LABELS = {
  missing_identifier: '缺少编号',
  identifier_collision: '编号冲突',
  name_conflict: '名称冲突',
  invalid_date: '日期无效',
  invalid_quantity: '数量无效',
  ambiguous_location: '库位不明确',
  duplicate: '重复',
  credential_exclusion: '凭据排除',
  other: '待复核',
}

function Conflicts() { const [rows, setRows] = useState([]); const [error, setError] = useState(null); useEffect(() => { api.conflicts().then(setRows).catch(setError) }, []); const columns = useMemo(() => [
  { key: 'case_type', label: '类型', filterType: 'select', filterOptions: Object.entries(CONFLICT_TYPE_LABELS).map(([value, label]) => ({ value, label })), render: r => CONFLICT_TYPE_LABELS[r.case_type] || r.case_type },
  { key: 'summary', label: '摘要', filterType: 'text', value: r => [r.source_identifier || r.source_name, r.movement_type_code ? `历史流水 ${r.movement_type_code}` : '', r.resolution_notes].filter(Boolean).join(' · ') || '需要人工确认' },
  { key: 'status_code', label: '状态', filterType: 'select', filterOptions: [{ value: 'pending_review', label: '待处理' }, { value: 'resolved', label: '已处理' }], render: r => r.status_code === 'pending_review' ? '待处理' : r.status_code },
], []); return <section><PageHeading eyebrow="数据治理" title="冲突中心" description="需要人工确认的编号、名称、流水和主数据问题。" /><div className="panel"><ErrorBox error={error} /><DataTable mode="client" columns={columns} rows={rows} rowKey={c => String(c.resolution_case_id)} rowHref={c => `/conflicts/${c.resolution_case_id}`} exportConfig={{ endpoint: '/api/conflicts/export', filename: '冲突', allScope: 'ids' }} /></div></section> }

function ConflictDetail({ id }) {
  const { navigate } = useRouter()
  const [data, setData] = useState(null); const [note, setNote] = useState(''); const [outcome, setOutcome] = useState('resolved')
  const [uoms, setUoms] = useState([]); const [error, setError] = useState(null); const [busy, setBusy] = useState(false)
  const [action, setAction] = useState(null); const [q, setQ] = useState(''); const [results, setResults] = useState([]); const [form, setForm] = useState({})
  useEffect(() => { api.conflict(id).then(setData).catch(setError); api.uoms().then(setUoms).catch(() => {}) }, [id])
  useEffect(() => { if (!q) { setResults([]); return }; const controller = new AbortController(); const t = setTimeout(() => api.products({ q, page: 1, page_size: 30, signal: controller.signal }).then(x => { if (!controller.signal.aborted) setResults(x.items || []) }).catch(err => { if (err.name !== 'AbortError') setError(err) }), 180); return () => { clearTimeout(t); controller.abort() } }, [q])
  if (!data) return error ? <section><Back to="/conflicts" /><ErrorBox error={error} /></section> : <Loading />
  const observation = data.product_observation || {}
  const product = data.product || null
  const candidate = data.movement_candidate || null
  const source = data.source_record || null
  function patch(k, v) { setForm(x => ({ ...x, [k]: v })) }
  function openCreate() { setForm({ display_name: observation.source_name_raw || '', manufacturer: observation.manufacturer_raw || '', specification: observation.specification_raw || '', primary_identifier: observation.source_identifier_raw || '', default_uom_id: uoms[0]?.uom_id || '' }); setAction('create') }
  function openEdit() { setForm({ display_name: product?.display_name || '', manufacturer: product?.manufacturer || '', specification: product?.specification || '', primary_identifier: product?.primary_identifier_value || '', default_uom_id: product?.default_uom_id || '' }); setAction('edit') }
  async function run(call) { setBusy(true); setError(null); try { const r = await call(); if (r?.identifier_conflicts?.length) setError(new Error(`已保存；编号与其他货品冲突：${r.identifier_conflicts.map(x => x.display_name).join('、')}`)); else navigate('/conflicts') } catch (err) { setError(err) } finally { setBusy(false) } }
  const basePayload = { resolution_notes: note.trim() }
  const title = CONFLICT_TYPE_LABELS[data.case_type] || data.case_type || '冲突'
  const subtitle = [observation.source_name_raw, observation.source_identifier_raw].filter(Boolean).join(' · ') || (source?.display_values?.['品名']) || '需要人工确认'
  const uomSelect = <Field label="默认单位"><select value={form.default_uom_id || ''} onChange={e => patch('default_uom_id', e.target.value)}><option value="">请选择</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field>
  return <section><Back to="/conflicts" /><PageHeading eyebrow="冲突详情" title={title} description={subtitle}><Badge tone={data.status_code === 'pending_review' ? 'amber' : 'red'}>{data.status_code === 'pending_review' ? '待处理' : data.status_code}</Badge></PageHeading><div className="detail-grid"><div className="panel"><h2>来源观测</h2><dl className="detail-list"><dt>编号</dt><dd>{observation.source_identifier_raw || '—'}</dd><dt>名称</dt><dd>{observation.source_name_raw || '—'}</dd><dt>厂家</dt><dd>{observation.manufacturer_raw || '—'}</dd><dt>规格</dt><dd>{observation.specification_raw || '—'}</dd><dt>单位</dt><dd>{observation.uom_raw || '—'}</dd><dt>期初</dt><dd>{observation.opening_quantity != null ? formatQuantity(observation.opening_quantity) : '—'}</dd><dt>现有</dt><dd>{observation.existing_quantity != null ? formatQuantity(observation.existing_quantity) : '—'}</dd></dl></div>{candidate && <div className="panel"><h2>历史流水候选</h2><dl className="detail-list"><dt>类型</dt><dd>{candidate.movement_type_code || '—'}</dd><dt>数量</dt><dd>{candidate.quantity_raw || '—'}</dd><dt>日期</dt><dd>{candidate.movement_date_raw || '—'}</dd><dt>来源</dt><dd>{candidate.source_location_raw || '—'}</dd><dt>目的</dt><dd>{candidate.destination_location_raw || '—'}</dd></dl></div>}<div className="panel"><h2>关联货品</h2>{product ? <dl className="detail-list"><dt>货品</dt><dd><Link className="text-link" to={`/products/${product.product_id}`}>{product.display_name} →</Link></dd><dt>编号</dt><dd>{product.primary_identifier_value || '—'}</dd><dt>厂家</dt><dd>{product.manufacturer || '—'}</dd><dt>规格</dt><dd>{product.specification || '—'}</dd><dt>单位</dt><dd>{product.uom_display_name || product.uom_code || '—'}</dd></dl> : <Empty>尚未关联货品</Empty>}</div><div className="panel"><h2>来源原始数据</h2>{source ? <pre className="json-view">{JSON.stringify({ raw: source.raw_values, display: source.display_values }, null, 2)}</pre> : <Empty>无来源记录</Empty>}</div></div><div className="panel actions-panel"><h2>处理</h2><ErrorBox error={error} />{data.status_code !== 'pending_review' ? <div className="alert">已处理：{data.resolution_notes || '—'}</div> : <><div className="actions"><Button className="secondary" onClick={() => setAction(action === 'link' ? null : 'link')} disabled={busy}>关联现有货品</Button><Button className="secondary" onClick={() => action === 'create' ? setAction(null) : openCreate()} disabled={busy}>按观测新建货品</Button>{product && <Button className="secondary" onClick={() => action === 'edit' ? setAction(null) : openEdit()} disabled={busy}>编辑货品主数据</Button>}</div>{action === 'link' && <div className="picker-field" style={{ marginTop: 10 }}><span className="field-label">搜索并选择货品</span><div className="picker-row"><input value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" /></div>{results.length > 0 && <div className="picker-results">{results.map(p => <button type="button" key={p.product_id} onClick={() => run(() => api.linkConflict(id, { product_id: p.product_id, ...basePayload }))}><strong>{p.display_name}<FuzzyTag item={p} /></strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}</div>}{action === 'create' && <div className="form-grid" style={{ marginTop: 10 }}><Field label="货品名"><input value={form.display_name || ''} onChange={e => patch('display_name', e.target.value)} /></Field><Field label="来源/标签编号"><input value={form.primary_identifier || ''} onChange={e => patch('primary_identifier', e.target.value)} /></Field><Field label="厂家"><input value={form.manufacturer || ''} onChange={e => patch('manufacturer', e.target.value)} /></Field><Field label="规格/型号"><input value={form.specification || ''} onChange={e => patch('specification', e.target.value)} /></Field>{uomSelect}<div className="span-2 actions"><Button className="primary" onClick={() => run(() => api.createConflictProduct(id, { ...form, default_uom_id: form.default_uom_id ? Number(form.default_uom_id) : null, ...basePayload }))} disabled={busy}>新建并处理</Button><Button className="secondary" onClick={() => setAction(null)}>取消</Button></div></div>}{action === 'edit' && <div className="form-grid" style={{ marginTop: 10 }}><Field label="货品名"><input value={form.display_name || ''} onChange={e => patch('display_name', e.target.value)} /></Field><Field label="来源/标签编号"><input value={form.primary_identifier || ''} onChange={e => patch('primary_identifier', e.target.value)} /></Field><Field label="厂家"><input value={form.manufacturer || ''} onChange={e => patch('manufacturer', e.target.value)} /></Field><Field label="规格/型号"><input value={form.specification || ''} onChange={e => patch('specification', e.target.value)} /></Field>{uomSelect}<div className="span-2 actions"><Button className="primary" onClick={() => run(() => api.editConflictProduct(id, { ...form, default_uom_id: form.default_uom_id ? Number(form.default_uom_id) : null, ...basePayload }))} disabled={busy}>保存并处理</Button><Button className="secondary" onClick={() => setAction(null)}>取消</Button></div></div>}<div className="reject-panel" style={{ marginTop: 10 }}><Field label="处理备注"><textarea rows="3" value={note} onChange={e => setNote(e.target.value)} placeholder="填写处理说明后提交" /></Field><div className="actions"><Field label="处理结果"><select value={outcome} onChange={e => setOutcome(e.target.value)}><option value="resolved">已处理</option><option value="duplicate">重复</option><option value="ignored">忽略</option></select></Field><Button className="primary" onClick={() => run(() => api.resolveConflict(id, { resolution_notes: note.trim(), outcome }))} disabled={busy || !note.trim()}>标记已处理</Button></div></div></>}</div></section>
}

function Audit() { const [rows, setRows] = useState([]); const [error, setError] = useState(null); useEffect(() => { api.audit().then(setRows).catch(setError) }, []); const columns = useMemo(() => [
  { key: 'action', label: '动作', filterType: 'search' },
  { key: 'target', label: '目标', filterType: 'text', value: r => `${r.target_table || ''} / ${r.target_id ?? '—'}` },
  { key: 'created_at', label: '时间', value: r => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
  { key: 'request_id', label: '请求 ID', value: r => r.request_id || '—' },
], []); return <section><PageHeading eyebrow="合规" title="操作审计" description="不可变记录，仅管理员可见。" /><div className="panel"><ErrorBox error={error} /><DataTable mode="client" columns={columns} rows={rows} rowKey={a => String(a.audit_event_id)} rowHref={a => `/audit/${a.audit_event_id}`} exportConfig={{ endpoint: '/api/audit/export', filename: '审计日志', allScope: 'ids' }} /></div></section> }
function AuditDetail({ id }) { const [data, setData] = useState(null); const [error, setError] = useState(null); useEffect(() => { api.auditEvent(id).then(setData).catch(setError) }, [id]); if (!data) return error ? <section><Back to="/audit" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/audit" /><PageHeading eyebrow="审计详情" title={data.action}><Badge>{data.target_table}</Badge></PageHeading><div className="panel"><dl className="detail-list"><dt>目标</dt><dd>{data.target_table} / {data.target_id || '—'}</dd><dt>操作者</dt><dd>{data.actor_name || data.actor_user_id || '—'}</dd><dt>时间</dt><dd>{new Date(data.created_at).toLocaleString()}</dd><dt>请求 ID</dt><dd className="mono">{data.request_id || '—'}</dd></dl><pre className="json-view">{JSON.stringify({ before: data.before_data, after: data.after_data, diff: data.field_diff }, null, 2)}</pre></div></section> }

function InventoryDetail({ ids }) { const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null); const [product, setProduct] = useState(null); useEffect(() => { api.inventoryDetail(ids).then(setData).catch(setError); api.product(ids.product_id).then(setProduct).catch(() => {}) }, [ids]); if (!data) return error ? <section><Back to="/" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/" /><PageHeading eyebrow="库存余额详情" title={data.product_name}><Button className="primary" onClick={() => navigate(`/requests/new?product_id=${ids.product_id}`)}>以此货品新建申请</Button></PageHeading><div className="stats"><div className="stat teal"><span>当前数量</span><strong>{formatQuantity(data.on_hand_quantity)} {data.uom_code}</strong></div><div className="stat"><span>库位</span><strong>{data.location_name}</strong></div><div className="stat"><span>成色</span><strong>{data.condition_code}</strong></div></div><div className="panel"><h2>相关流水</h2>{data.movements?.length ? <div className="record-list">{data.movements.map(m => <div className="record-card" key={m.inventory_movement_id}><div><strong>{m.movement_type}</strong><span>{m.source_location_name || '—'} → {m.destination_location_name || '—'}</span></div><div className="record-value"><b>{formatQuantity(m.quantity)}</b><small>{m.movement_date}</small></div></div>)}</div> : <Empty>暂无流水</Empty>}</div>{product && <Link className="text-link" to={`/products/${product.product_id}`}>查看货品主数据 →</Link>}</section> }

function decimalPlaces(value) {
  const match = /\.(\d+)$/.exec(String(value).trim())
  return match ? match[1].length : 0
}

function CountPage() {
  const isMobile = useIsMobile()
  const [q, setQ] = useState(''); const [results, setResults] = useState([])
  const [product, setProduct] = useState(null)
  const [locations, setLocations] = useState([]); const [locationId, setLocationId] = useState('')
  const [uoms, setUoms] = useState([]); const [uomId, setUomId] = useState('')
  const [inventoryRows, setInventoryRows] = useState([])
  const [counted, setCounted] = useState(''); const [notes, setNotes] = useState(''); const [serials, setSerials] = useState('')
  const [changeDefaultUnit, setChangeDefaultUnit] = useState(false)
  const [floatConfirm, setFloatConfirm] = useState(false)
  const [creatingUom, setCreatingUom] = useState(false); const [newUom, setNewUom] = useState({ code: '', display_name: '', decimal_scale: 0 })
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null)

  useEffect(() => { api.locations().then(setLocations).catch(setError); api.uoms().then(setUoms).catch(setError) }, [])
  useEffect(() => {
    if (!product) { setInventoryRows([]); return }
    let active = true
    api.inventoryByProduct(product.product_id).then(rows => { if (active) setInventoryRows(rows) }).catch(() => { if (active) setInventoryRows([]) })
    return () => { active = false }
  }, [product?.product_id])
  useEffect(() => { if (!q) { setResults([]); return }; const controller = new AbortController(); const t = setTimeout(() => api.products({ q, page: 1, page_size: 30, signal: controller.signal }).then(x => { if (!controller.signal.aborted) setResults(x.items || []) }).catch(err => { if (err.name !== 'AbortError') setError(err) }), 180); return () => { clearTimeout(t); controller.abort() } }, [q])
  useEffect(() => { if (!locationId && locations.length) { const main = locations.find(l => l.code === 'MAIN'); setLocationId(String(main ? main.location_id : locations[0].location_id)) } }, [locations, locationId])
  useEffect(() => { if (product && !uomId && uoms.length) setUomId(product.uom_id ? String(product.uom_id) : String(uoms[0].uom_id)) }, [product, uoms, uomId])

  const currentRow = useMemo(() => {
    if (!product || !locationId || !uomId) return null
    return inventoryRows.find(row => row.product_id === product.product_id && Number(row.location_id) === Number(locationId) && row.condition_code === 'new' && Number(row.uom_id) === Number(uomId)) || null
  }, [inventoryRows, product, locationId, uomId])
  const selectedUom = uoms.find(u => String(u.uom_id) === uomId)
  const currentQuantity = currentRow ? formatQuantity(currentRow.on_hand_quantity) : '0'

  function selectProduct(p) { setProduct(p); setQ(''); setResults([]); setCounted(''); setNotes(''); setSerials(''); setChangeDefaultUnit(false); setFloatConfirm(false); setResult(null); setUomId(''); setError(null) }
  function reset() { setProduct(null); setQ(''); setResults([]); setCounted(''); setNotes(''); setSerials(''); setChangeDefaultUnit(false); setFloatConfirm(false); setResult(null); setUomId(''); setCreatingUom(false); setError(null) }
  function patch(field, value) { if (field === 'counted') setCounted(value); if (field === 'notes') setNotes(value); setResult(null); setFloatConfirm(false) }

  async function createUnit(e) { e.preventDefault(); setBusy(true); setError(null); try { const created = await api.createUom({ code: newUom.code, display_name: newUom.display_name, decimal_scale: Number(newUom.decimal_scale) || 0 }); setUoms(x => [...x, created]); setUomId(String(created.uom_id)); setCreatingUom(false); setNewUom({ code: '', display_name: '', decimal_scale: 0 }) } catch (err) { setError(err) } finally { setBusy(false) } }

  async function submit(confirmed = false) {
    setError(null)
    const n = Number(counted)
    if (counted === '' || !Number.isFinite(n)) { setError(new Error('请输入有效数量')); return }
    if (decimalPlaces(counted) > 3) { setError(new Error('数量最多支持 3 位小数')); return }
    if (!Number.isInteger(n) && !confirmed) { setFloatConfirm(true); return }
    setBusy(true)
    try {
      const resp = await api.adjustInventory({ product_id: product.product_id, location_id: Number(locationId), condition_id: null, uom_id: Number(uomId), counted_quantity: n, change_default_unit: changeDefaultUnit, source_uom_raw: product.source_uom_raw || null, notes: notes.trim() || null, serial_numbers: serials.trim() ? serials.split('\n').map(s => s.trim()).filter(Boolean) : null })
      setFloatConfirm(false); setResult(resp)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return <section><PageHeading eyebrow="库存作业" title="清点库存" description="按实盘数量直接覆写某货品在指定库位的现库存，数量可为负数或小数。" /><div className="panel"><ErrorBox error={error} />{!product ? <div className="picker-field"><span className="field-label">选择货品</span><div className="picker-row"><input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" />{isMobile && <ScanPicker onAdd={selectProduct} />}</div>{results.length > 0 && <div className="picker-results">{results.map(p => <button type="button" key={p.product_id} onClick={() => selectProduct(p)}><strong>{p.display_name}<FuzzyTag item={p} /></strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}{q && results.length === 0 && <Empty>没有匹配货品</Empty>}</div> : result ? <div className="alert"><strong>清点完成</strong><p style={{ marginTop: 4 }}>{product.display_name} 在 {result.location_name} 的现库存现为 <b>{formatQuantity(result.on_hand_quantity)} {result.uom_code}</b>{result.movement_posted ? `（调整 ${result.delta > 0 ? '+' : ''}${formatQuantity(result.delta)}）` : '（与清点数一致，无需调整）'}。</p><div className="actions" style={{ marginTop: 8 }}><Button className="secondary" onClick={reset}>清点下一个</Button></div></div> : <><div className="actions" style={{ marginBottom: 12 }}><strong>{product.display_name}</strong><span className="muted">{product.identifier || '无编号'} · {product.specification || '—'}</span><Button type="button" className="secondary" onClick={reset}>更换货品</Button></div><div className="form-grid"><Field label="库位"><select value={locationId} onChange={e => { setLocationId(e.target.value); setResult(null); setFloatConfirm(false) }}>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || l.location_type}</option>)}</select></Field><Field label="单位">{creatingUom ? <span className="picker-row" style={{ width: '100%' }}><input value={newUom.code} placeholder="编码" onChange={e => setNewUom({ ...newUom, code: e.target.value })} /><input value={newUom.display_name} placeholder="名称" onChange={e => setNewUom({ ...newUom, display_name: e.target.value })} /><input type="number" min="0" max="6" value={newUom.decimal_scale} onChange={e => setNewUom({ ...newUom, decimal_scale: e.target.value })} title="小数位" /><Button type="button" className="primary" onClick={createUnit} disabled={busy}>创建</Button><Button type="button" className="secondary" onClick={() => setCreatingUom(false)}>取消</Button></span> : <select value={uomId} onChange={e => { if (e.target.value === '__new__') { setCreatingUom(true) } else { setUomId(e.target.value); setResult(null); setFloatConfirm(false) } }}>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}<option value="__new__">＋ 新建单位…</option></select>}</Field><div className="span-2 stat"><span>当前现库存（{selectedUom?.code || '—'}）</span><strong>{currentQuantity} {selectedUom?.code || '—'}</strong></div><Field label="清点数量（可为负）"><input type="number" step="0.001" value={counted} onChange={e => patch('counted', e.target.value)} placeholder="实盘数量" /></Field>{product.serialized && <div className="span-2"><SerialEntry productId={product.product_id} value={serials} onChange={setSerials} label="序列号登记（可选）" /></div>}<Field label="备注"><input value={notes} onChange={e => patch('notes', e.target.value)} /></Field><label className="check-field span-2"><input type="checkbox" checked={changeDefaultUnit} onChange={e => setChangeDefaultUnit(e.target.checked)} /> 同时把货品默认单位改为所选单位</label>{floatConfirm && <div className="reject-panel span-2"><p>清点数量包含小数（{counted}），请再次确认后提交。</p><div className="actions"><Button className="primary" onClick={() => submit(true)} disabled={busy}>确认提交</Button><Button className="secondary" onClick={() => setFloatConfirm(false)}>返回修改</Button></div></div>}<div className="span-2 actions"><Button className="primary" onClick={() => submit(false)} disabled={busy}>{busy ? '提交中…' : '提交清点'}</Button></div></div></>}</div></section>
}

function NotFound() { return <section><PageHeading eyebrow="404" title="页面不存在" description="请从导航返回业务列表。" /><Link className="primary button-link" to="/">返回总览</Link></section> }

export function routeView(path, user, query) {
  const parts = path.split('/').filter(Boolean); const first = parts[0]; const id = parts[1]; const sub = parts[2]
  if (path === '/') return <Dashboard />
  if (first === 'products') { if (path === '/products') return <ProductList user={user} />; if (id === 'new') return user.role === 'ADMIN' ? <ProductForm /> : <Forbidden />; if (sub === 'edit') return user.role === 'ADMIN' ? <ProductForm id={id} /> : <Forbidden />; return <ProductDetail id={id} user={user} /> }
  if (first === 'requests') { if (path === '/requests') return <RequestList user={user} />; if (id === 'new') return <RequestForm prefillProductId={query?.get('product_id')} />; if (sub === 'edit') return <RequestDetailLoader id={id} user={user} edit />; return <RequestDetail id={id} user={user} /> }
  if (first === 'count') return canView(user, 'count') ? <CountPage /> : <Forbidden />
  if (first === 'purchase' || first === 'sales') return documentRoute(first, parts, user)
  if (first === 'inventory') {
    const isDocument = isInventoryDocumentPath(path, DOC_GROUP_TYPES.inventory)
    return isDocument
      ? documentRoute(first, parts, user)
      : <InventoryDetail ids={{ product_id: parts[1], location_id: parts[2], condition_id: parts[3], uom_id: parts[4] }} />
  }
  if (first === 'master') return masterRoute(first, parts, query, user)
  if (first === 'reports') return reportRoute(first, parts, query, user)
  if (first === 'admin') { if (path === '/admin') return canView(user, 'system') ? <AdminPage /> : <Forbidden />; if (parts[1] === 'users') return canView(user, 'system') ? (parts[2] === 'new' ? <UserForm /> : parts[3] === 'edit' ? <UserForm id={parts[2]} /> : <UserDetail id={parts[2]} />) : <Forbidden />; if (parts[1] === 'locations') return canView(user, 'system') ? (parts[2] === 'new' ? <LocationForm /> : parts[3] === 'edit' ? <LocationForm id={parts[2]} /> : <LocationDetail id={parts[2]} />) : <Forbidden /> }
  if (first === 'conflicts') return canView(user, 'conflicts') ? (path === '/conflicts' ? <Conflicts /> : <ConflictDetail id={id} />) : <Forbidden />
  if (first === 'audit') return canView(user, 'audit') ? (path === '/audit' ? <Audit /> : <AuditDetail id={id} />) : <Forbidden />
  if (first === 'serials') return canView(user, 'serials') ? (path === '/serials' ? <SerialLedger user={user} /> : <SerialDetail id={id} />) : <Forbidden />
  if (first === 'profile') return <Profile user={user} />
  return <NotFound />
}
function RequestDetailLoader({ id, user, edit }) { const [data, setData] = useState(null); const [error, setError] = useState(null); useEffect(() => { api.stockRequest(id).then(setData).catch(setError) }, [id]); if (error) return <section><Back to={`/requests/${id}`} /><ErrorBox error={error} /></section>; return data ? (edit ? <RequestForm id={id} initial={data} /> : <RequestDetail id={id} user={user} />) : <Loading /> }
function Forbidden() { return <section><PageHeading eyebrow="403" title="无权访问" description="当前账号没有执行此操作的权限。" /><Link className="primary button-link" to="/">返回总览</Link></section> }
function Profile({ user }) {
  const [form, setForm] = useState({ current_password: '', new_password: '' })
  const [error, setError] = useState(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function change(e) { e.preventDefault(); setError(null); setMessage(''); setBusy(true); try { await api.changePassword(form); setForm({ current_password: '', new_password: '' }); setMessage('密码已修改') } catch (err) { setError(err) } finally { setBusy(false) } }
  return <section><PageHeading eyebrow="账户" title="我的信息" description="当前登录账号信息。" /><div className="detail-grid"><div className="panel"><dl className="detail-list"><dt>显示名</dt><dd>{user.display_name || '—'}</dd><dt>用户名</dt><dd>{user.username}</dd><dt>角色</dt><dd>{ROLE_LABELS[user.role] || user.role}</dd></dl></div><div className="panel"><h2>修改密码</h2><form className="form-grid" onSubmit={change}><Field label="当前密码"><input type="password" value={form.current_password} onChange={e => setForm({ ...form, current_password: e.target.value })} required /></Field><Field label="新密码"><input type="password" minLength="8" value={form.new_password} onChange={e => setForm({ ...form, new_password: e.target.value })} required /></Field><ErrorBox error={error} />{message && <span className="success-text">{message}</span>}<div className="span-2 actions"><Button className="primary" disabled={busy}>{busy ? '提交中…' : '修改密码'}</Button></div></form></div></div></section>
}

function AppRouter({ user, onLogout }) {
  const [path, setPath] = useState(window.location.pathname + window.location.search)
  useEffect(() => { const fn = () => setPath(window.location.pathname + window.location.search); window.addEventListener('popstate', fn); return () => window.removeEventListener('popstate', fn) }, [])
  const navigate = to => { window.history.pushState({}, '', to); setPath(to) }
  const clean = normalizePath(path.split('?')[0])
  return <RouterContext.Provider value={{ navigate, currentPath: clean }}><Layout user={user} onLogout={onLogout}>{routeView(clean, user, new URLSearchParams(path.split('?')[1] || ''))}</Layout></RouterContext.Provider>
}

export function App() { const [user, setUser] = useState(null); const [loading, setLoading] = useState(true); useEffect(() => { api.me().then(setUser).catch(() => {}).finally(() => setLoading(false)) }, []); if (loading) return <Loading />; return user ? <AppRouter user={user} onLogout={() => setUser(null)} /> : <Login onLogin={setUser} /> }

const mountEl = document.getElementById('root')
if (mountEl) createRoot(mountEl).render(<App />)
