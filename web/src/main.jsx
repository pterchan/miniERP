import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { findProductMatches } from './scan-utils'
import { ScanStateHeading } from './scan-ui'
import { BalanceList, ProductRows } from './dense-lists'
import { buildInventoryByProduct, enrichInventoryRows, fetchAllProductPages } from './list-utils'
import { isNavigationItemActive, normalizePath } from './navigation-utils'

class ApiError extends Error {
  constructor(message, status, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter }
}

const api = {
  async request(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    if (options.method && options.method !== 'GET' && options.method !== 'HEAD') {
      const csrf = document.cookie.split('; ').find(x => x.startsWith('erp_csrf='))?.split('=').slice(1).join('=')
      if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf)
    }
    const response = await fetch(`/api${path}`, { credentials: 'include', ...options, headers })
    if (response.status === 204) return null
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = Array.isArray(body.detail) ? body.detail.map(x => x.msg || x.message).join('；') : (body.detail || body.message)
      throw new ApiError(detail || `请求失败 (${response.status})`, response.status, response.headers.get('Retry-After'))
    }
    return body
  },
  login: (username, password) => api.request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => api.request('/auth/logout', { method: 'POST' }),
  me: () => api.request('/auth/me'),
  inventory: () => api.request('/inventory/balance'),
  inventoryDetail: (x) => api.request(`/inventory/balance/${x.product_id}/${x.location_id}/${x.condition_id}/${x.uom_id}`),
  products: (q = '', page = 1, pageSize = 30) => api.request(`/products?q=${encodeURIComponent(q)}&page=${page}&page_size=${pageSize}`),
  productCatalog: () => fetchAllProductPages((page, pageSize) => api.products('', page, pageSize)),
  product: (id) => api.request(`/products/${id}`),
  createProduct: (payload) => api.request('/products', { method: 'POST', body: JSON.stringify(payload) }),
  updateProduct: (id, payload) => api.request(`/products/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  uoms: () => api.request('/uoms'),
  locations: () => api.request('/locations'),
  location: (id) => api.request(`/locations/${id}`),
  createLocation: (payload) => api.request('/locations', { method: 'POST', body: JSON.stringify(payload) }),
  updateLocation: (id, payload) => api.request(`/locations/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  users: () => api.request('/admin/users'),
  user: (id) => api.request(`/admin/users/${id}`),
  createUser: (payload) => api.request('/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (id, payload) => api.request(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  resetPassword: (id, password) => api.request(`/admin/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  requests: () => api.request('/stock-requests'),
  stockRequest: (id) => api.request(`/stock-requests/${id}`),
  createRequest: (payload) => api.request('/stock-requests', { method: 'POST', body: JSON.stringify(payload) }),
  updateRequest: (id, payload) => api.request(`/stock-requests/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  action: (id, action, payload = {}) => api.request(`/stock-requests/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload) }),
  conflicts: () => api.request('/conflicts'),
  conflict: (id) => api.request(`/conflicts/${id}`),
  resolveConflict: (id, payload) => api.request(`/conflicts/${id}/resolve`, { method: 'POST', body: JSON.stringify(payload) }),
  audit: () => api.request('/audit?limit=100'),
  auditEvent: (id) => api.request(`/audit/${id}`),
  ocrExtract: (payload, signal) => api.request('/ocr/extract', { method: 'POST', body: JSON.stringify(payload), signal })
}

const RouterContext = createContext({ navigate: () => {}, currentPath: '/' })
const useRouter = () => useContext(RouterContext)
function Link({ to, children, className = '', onClick, ...props }) {
  const { navigate } = useRouter()
  return <a className={className} href={to} onClick={e => { if (onClick) onClick(e); if (!e.defaultPrevented) { e.preventDefault(); navigate(to) } }} {...props}>{children}</a>
}
function NavLink({ to, children, className = '', onClick }) {
  const { currentPath } = useRouter()
  const active = isNavigationItemActive(currentPath, to)
  return <Link className={className} to={to} onClick={onClick} aria-current={active ? 'page' : undefined}>{children}</Link>
}

function Badge({ children, tone = 'neutral' }) { return <span className={`badge ${tone}`}>{children}</span> }
function Empty({ children = '暂无数据' }) { return <div className="empty">{children}</div> }
function ErrorBox({ error }) { return error ? <div className="alert error">{error.message || String(error)}</div> : null }
function Loading() { return <div className="loading">加载中…</div> }
function Back({ to = '/' }) { return <Link className="back-link" to={to}>‹ 返回</Link> }
function PageHeading({ eyebrow, title, description, children }) { return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>{children}</div> }
function Field({ label, children, className = '' }) { return <label className={`field ${className}`}><span>{label}</span>{children}</label> }
function Button({ children, className = '', ...props }) { return <button className={className} {...props}>{children}</button> }
function useDirtyLeaveGuard(dirty) {
  useEffect(() => {
    if (!dirty) return undefined
    const handler = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
}

function Login({ onLogin }) {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  async function submit(e) { e.preventDefault(); setError(''); setBusy(true); try { onLogin(await api.login(username, password)) } catch (err) { setError(err) } finally { setBusy(false) } }
  return <main className="login-shell"><form className="login-card" onSubmit={submit}><div className="brand-mark">库存 ERP</div><h1>欢迎回来</h1><p className="muted">出入库申请、审批与审计</p><Field label="账号"><input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required /></Field><Field label="密码"><input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></Field><ErrorBox error={error} /><Button className="primary wide" disabled={busy}>{busy ? '登录中…' : '登录'}</Button></form></main>
}

function Layout({ user, children, onLogout }) {
  const { currentPath } = useRouter(); const [more, setMore] = useState(false); const admin = user.role === 'WAREHOUSE_ADMIN'
  useEffect(() => { setMore(false) }, [currentPath])
  const items = [{ to: '/', icon: '▦', label: '库存总览' }, { to: '/products', icon: '⌕', label: '货品搜索' }, { to: '/requests', icon: '□', label: admin ? '审批队列' : '我的申请' }]
  if (admin) items.push({ to: '/conflicts', icon: '!', label: '冲突中心' }, { to: '/admin', icon: '⚙', label: '系统管理' }, { to: '/audit', icon: '◷', label: '操作审计' })
  const moreItems = [{ to: '/profile', icon: '◎', label: '我的信息' }]
  async function logout() { try { await api.logout() } finally { onLogout() } }
  const moreActive = [...items.slice(3), ...moreItems].some(x => isNavigationItemActive(currentPath, x.to))
  const navContents = item => <><span className="nav-icon" aria-hidden="true">{item.icon}</span><span className="nav-label">{item.label}</span></>
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-dot" />库存 ERP</div>
      <nav aria-label="主导航">{items.map(item => <NavLink className="nav-link" key={item.to} to={item.to}>{navContents(item)}</NavLink>)}</nav>
      <div className="sidebar-foot"><Badge tone={admin ? 'teal' : 'neutral'}>{admin ? '仓管' : '申请人'}</Badge><span className="user-name">{user.display_name || user.username}</span><button className="logout" onClick={logout}>退出</button></div>
    </aside>
    <main className="content">
      <header className="mobile-header"><Link to="/" className="brand"><span className="brand-dot" />库存 ERP</Link><button className="icon-button" onClick={() => setMore(!more)} aria-label="打开菜单" aria-expanded={more}>☰</button></header>
      {more && <div className="mobile-menu" role="dialog" aria-label="更多导航">{[...items, ...moreItems].map(item => <NavLink className="nav-link" key={item.to} to={item.to} onClick={() => setMore(false)}>{navContents(item)}</NavLink>)}<button className="mobile-logout" onClick={logout}>退出登录</button></div>}
      {children}
    </main>
    <nav className="bottom-nav" aria-label="移动导航">{items.slice(0, 3).map(item => <NavLink key={item.to} to={item.to}><span className="nav-icon" aria-hidden="true">{item.icon}</span><small>{item.label}</small></NavLink>)}<button onClick={() => setMore(!more)} aria-expanded={more} aria-current={moreActive ? 'page' : undefined}><span aria-hidden="true">•••</span><small>更多</small></button></nav>
  </div>
}

function Dashboard() {
  const [rows, setRows] = useState([]); const [catalog, setCatalog] = useState([]); const [q, setQ] = useState(''); const [error, setError] = useState(null); const [catalogError, setCatalogError] = useState(false)
  useEffect(() => {
    api.inventory().then(setRows).catch(setError)
    api.productCatalog().then(setCatalog).catch(() => setCatalogError(true))
  }, [])
  const enrichedRows = useMemo(() => enrichInventoryRows(rows, catalog), [rows, catalog])
  const normalizedQuery = q.trim().toLowerCase()
  const filtered = enrichedRows.filter(row => !normalizedQuery || [row.identifier, row.product_name, row.manufacturer, row.specification, row.location_name, row.condition_code, row.uom_code].some(value => String(value || '').toLowerCase().includes(normalizedQuery)))
  const productCount = new Set(rows.map(row => row.product_id)).size
  const locationCount = new Set(rows.map(row => row.location_id)).size
  return <section><PageHeading eyebrow="总览" title="库存工作台" description="按编号、货品、库位、成色和单位查看已过账余额。" /><div className="stats"><div className="stat"><span>库存维度</span><strong>{rows.length}</strong></div><div className="stat teal"><span>货品数</span><strong>{productCount}</strong></div><div className="stat"><span>库位数</span><strong>{locationCount}</strong></div></div><div className="panel"><div className="panel-head"><div><h2>库存余额</h2><p className="muted">余额来自已过账流水；不同单位分别展示。</p></div><input className="search" placeholder="搜索编号、货品、厂家、规格或库位" value={q} onChange={e => setQ(e.target.value)} /></div><ErrorBox error={error} />{catalogError && <div className="alert warning compact">货品编号暂未加载，库存余额仍可正常查看。</div>}{filtered.length ? <BalanceList rows={filtered} LinkComponent={Link} /> : <Empty>没有匹配的库存</Empty>}</div></section>
}

function ProductList({ user }) {
  const { navigate } = useRouter(); const [q, setQ] = useState(''); const [rows, setRows] = useState([]); const [inventoryRows, setInventoryRows] = useState([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(null); const [inventoryStatus, setInventoryStatus] = useState('loading')
  useEffect(() => {
    let active = true
    api.inventory().then(result => { if (active) { setInventoryRows(result); setInventoryStatus('ready') } }).catch(() => { if (active) setInventoryStatus('error') })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    const id = setTimeout(() => {
      setLoading(true)
      setError(null)
      api.products(q).then(result => { if (active) setRows(result.items || []) }).catch(err => { if (active) setError(err) }).finally(() => { if (active) setLoading(false) })
    }, 180)
    return () => { active = false; clearTimeout(id) }
  }, [q])
  const inventoryByProduct = useMemo(() => buildInventoryByProduct(inventoryRows), [inventoryRows])
  return <section><PageHeading eyebrow="主数据" title="货品" description="搜索并维护编号、名称、厂家、规格、库存和单位。">{user.role === 'WAREHOUSE_ADMIN' && <Button className="primary" onClick={() => navigate('/products/new')}>＋ 新增货品</Button>}</PageHeading><div className="panel"><input className="search large" placeholder="编号、名称、厂家或型号" value={q} onChange={e => setQ(e.target.value)} />{inventoryStatus === 'error' && <div className="alert warning compact">库存汇总暂未加载，货品主数据仍可正常查看。</div>}{error ? <ErrorBox error={error} /> : loading ? <Empty>搜索中…</Empty> : rows.length ? <ProductRows rows={rows} inventoryByProduct={inventoryByProduct} inventoryAvailable={inventoryStatus === 'ready'} LinkComponent={Link} /> : <Empty>没有匹配的货品</Empty>}</div></section>
}

function ProductForm({ id }) {
  const { navigate } = useRouter(); const [form, setForm] = useState({ display_name: '', manufacturer: '', specification: '', source_uom_raw: '个', default_uom_id: '', primary_identifier: '' }); const baseline = useRef(JSON.stringify(form)); const [uoms, setUoms] = useState([]); const [error, setError] = useState(null); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false)
  useDirtyLeaveGuard(JSON.stringify(form) !== baseline.current)
  useEffect(() => { api.uoms().then(setUoms).catch(setError); if (id) api.product(id).then(p => { const next = { display_name: p.display_name || '', manufacturer: p.manufacturer || '', specification: p.specification || '', source_uom_raw: p.source_uom_raw || '', default_uom_id: p.default_uom_id || '', primary_identifier: p.primary_identifier?.value_raw || '' }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id])
  function set(k, v) { setForm(x => ({ ...x, [k]: v })) }
  async function save(e) { e.preventDefault(); setError(null); setMessage(''); setBusy(true); try { const payload = { ...form, default_uom_id: form.default_uom_id ? Number(form.default_uom_id) : null, primary_identifier: form.primary_identifier || null }; const result = id ? await api.updateProduct(id, payload) : await api.createProduct(payload); setMessage(result.identifier_conflicts?.length ? '已保存；编号与其他货品冲突，请复核。' : '已保存'); setTimeout(() => navigate(`/products/${result.product_id || id}`), 350) } catch (err) { setError(err) } finally { setBusy(false) } }
  return <section><Back to={id ? `/products/${id}` : '/products'} /><PageHeading eyebrow="主数据" title={id ? '编辑货品' : '新增货品'} description="来源编号保留原始文本，重复编号会提示但不会覆盖其他货品。" /><form className="panel form-grid" onSubmit={save}><Field label="货品名"><input required value={form.display_name} onChange={e => set('display_name', e.target.value)} /></Field><Field label="来源/标签编号"><input value={form.primary_identifier} onChange={e => set('primary_identifier', e.target.value)} /></Field><Field label="厂家"><input value={form.manufacturer} onChange={e => set('manufacturer', e.target.value)} /></Field><Field label="规格/型号"><input value={form.specification} onChange={e => set('specification', e.target.value)} /></Field><Field label="默认单位"><select required value={form.default_uom_id} onChange={e => set('default_uom_id', e.target.value)}><option value="">请选择</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field><Field label="原始单位"><input value={form.source_uom_raw} onChange={e => set('source_uom_raw', e.target.value)} /></Field><ErrorBox error={error} /><div className="actions span-2">{message && <span className="success-text">{message}</span>}<Button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/products/${id}` : '/products')}>取消</Button></div></form></section>
}

function ProductDetail({ id, user }) {
  const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null)
  useEffect(() => { api.product(id).then(setData).catch(setError) }, [id])
  if (error) return <section><Back to="/products" /><ErrorBox error={error} /></section>; if (!data) return <Loading />
  return <section><Back to="/products" /><PageHeading eyebrow="货品详情" title={data.display_name} description={data.manufacturer || '未填写厂家'}>{user.role === 'WAREHOUSE_ADMIN' && <Button className="primary" onClick={() => navigate(`/products/${id}/edit`)}>编辑</Button>}</PageHeading><div className="detail-grid"><div className="panel"><h2>主数据</h2><dl className="detail-list"><dt>来源编号</dt><dd>{data.primary_identifier?.value_raw || '—'}</dd><dt>规格/型号</dt><dd>{data.specification || '—'}</dd><dt>默认单位</dt><dd>{data.uom_display_name || data.uom_code || '—'}</dd><dt>原始单位</dt><dd>{data.source_uom_raw || '—'}</dd><dt>更新时间</dt><dd>{data.updated_at ? new Date(data.updated_at).toLocaleString() : '—'}</dd></dl>{data.identifier_conflicts?.length > 0 && <div className="alert warning">此编号还被 {data.identifier_conflicts.length} 个货品使用，请在冲突中心或详情中复核。</div>}</div><div className="panel"><h2>历史编号</h2>{data.identifiers?.length ? <div className="tag-list">{data.identifiers.map(x => <Badge key={x.product_identifier_id} tone={x.is_primary ? 'teal' : 'neutral'}>{x.value_raw}</Badge>)}</div> : <Empty>暂无编号</Empty>}</div></div></section>
}

function ScanPicker({ onAdd }) {
  const [menu, setMenu] = useState(false); const [state, setState] = useState('idle'); const [error, setError] = useState(null); const [warning, setWarning] = useState(''); const [terms, setTerms] = useState([]); const [matches, setMatches] = useState([]); const cameraRef = useRef(null); const galleryRef = useRef(null); const abortRef = useRef(null)
  async function findMatches(searchTerms) {
    const found = await findProductMatches(searchTerms, async value => (await api.products(value)).items || [])
    setMatches(found)
    setState('result')
  }
  async function fileSelected(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setMenu(false); setError(null); setWarning(''); setMatches([]); setState('processing')
    try {
      const image = await prepareImage(file)
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
    {(['result', 'partial', 'reshoot', 'error'].includes(state)) && <div className="scan-result"><div className="scan-result-head"><ScanStateHeading state={state} /><button type="button" className="close-button" onClick={() => setState('idle')} aria-label="关闭扫描结果">×</button></div><ErrorBox error={error} />{warning && <div className="alert warning">{warning}</div>}{state === 'partial' && <Button type="button" className="secondary" onClick={() => findMatches(terms)}>确认并匹配</Button>}{terms.length > 0 && <div className="term-list">{terms.map(t => <button type="button" key={`${t.kind}-${t.normalized}`} onClick={async () => { const r = await api.products(t.value); setMatches(r.items || []); setState('result') }}>{t.value}</button>)}</div>}{matches.length > 0 && <div className="match-list"><p className="muted">点击货品加入申请明细</p>{matches.map(p => <button type="button" key={p.product_id} onClick={() => { onAdd(p); setState('idle'); setMatches([]) }}><strong>{p.display_name}</strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}{state === 'result' && matches.length === 0 && <p className="muted">没有匹配货品，请重拍或手工输入关键词。</p>}</div>}
  </div>
}

async function prepareImage(file) {
  let source = file
  if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) { const mod = await import('heic2any'); const convert = mod.default || mod; source = await convert({ blob: file, toType: 'image/jpeg', quality: 0.86 }); if (Array.isArray(source)) source = source[0] }
  const url = URL.createObjectURL(source); try { const image = await loadImage(url); const maxEdge = 4096; const maxPixels = 16_000_000; const sourceType = source.type || file.type; const canPreserve = /^image\/(jpeg|png|webp)$/i.test(sourceType) && source.size <= 8 * 1024 * 1024 && image.width <= maxEdge && image.height <= maxEdge && image.width * image.height <= maxPixels; if (canPreserve) return { media_type: sourceType, image_base64: await blobToBase64(source) }; let scale = Math.min(1, maxEdge / image.width, Math.sqrt(maxPixels / (image.width * image.height))); const canvas = document.createElement('canvas'); canvas.width = Math.max(64, Math.round(image.width * scale)); canvas.height = Math.max(64, Math.round(image.height * scale)); const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); let quality = 0.86; let blob = await canvasToBlob(canvas, quality); while (blob.size > 8 * 1024 * 1024 && quality > 0.55) { quality -= 0.08; blob = await canvasToBlob(canvas, quality) } while (blob.size > 8 * 1024 * 1024 && canvas.width > 1200) { canvas.width = Math.round(canvas.width * 0.8); canvas.height = Math.round(canvas.height * 0.8); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); blob = await canvasToBlob(canvas, quality) } const base64 = await blobToBase64(blob); return { media_type: 'image/jpeg', image_base64: base64 } } finally { URL.revokeObjectURL(url) }
}
function loadImage(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url }) }
function canvasToBlob(canvas, quality) { return new Promise((resolve, reject) => canvas.toBlob(x => x ? resolve(x) : reject(new Error('图片压缩失败')), 'image/jpeg', quality)) }
function blobToBase64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob) }) }

function RequestList({ user }) {
  const { navigate } = useRouter(); const [rows, setRows] = useState([]); const [error, setError] = useState(null)
  const reload = () => api.requests().then(setRows).catch(setError); useEffect(() => { reload() }, [])
  return <section><PageHeading eyebrow="OA 流程" title={user.role === 'WAREHOUSE_ADMIN' ? '审批队列' : '我的申请'} description="每一条申请都可以进入详情；草稿支持继续编辑。"><Button className="primary" onClick={() => navigate('/requests/new')}>＋ 新建申请</Button></PageHeading><div className="panel"><ErrorBox error={error} />{rows.length ? <div className="record-list">{rows.map(r => <Link className="record-card" key={r.stock_request_id} to={`/requests/${r.stock_request_id}`}><div><strong>{r.request_no}</strong><span>{r.request_type} · {r.requester_display_name || r.requester_username || '—'}</span></div><div className="record-value"><Badge tone={r.status === 'RELEASED' ? 'green' : r.status === 'REJECTED' ? 'red' : 'amber'}>{r.status}</Badge><small>{r.line_count || 0} 条明细</small></div></Link>)}</div> : <Empty>暂无申请</Empty>}</div></section>
}

function RequestForm({ id, initial, prefillProductId }) {
  const { navigate } = useRouter(); const [form, setForm] = useState({ request_type: 'ISSUE_OTHER', source_location_id: '', destination_location_id: '', reason: '', lines: [] }); const baseline = useRef(JSON.stringify(form)); const [products, setProducts] = useState([]); const [locations, setLocations] = useState([]); const [q, setQ] = useState(''); const [error, setError] = useState(null); const [busy, setBusy] = useState(false); const [uoms, setUoms] = useState([])
  useDirtyLeaveGuard(JSON.stringify(form) !== baseline.current)
  useEffect(() => { api.locations().then(setLocations).catch(setError); api.uoms().then(setUoms).catch(setError); if (initial) { const next = { request_type: initial.request_type, source_location_id: initial.source_location_id || '', destination_location_id: initial.destination_location_id || '', reason: initial.reason || '', lines: initial.lines.map(x => ({ product_id: x.product_id, product_name: x.product_name, quantity: x.quantity, uom_id: x.uom_id, uom_code: x.uom_code, source_uom_raw: x.source_uom_raw || '个', notes: x.notes || '', source_location_id: x.source_location_id || '', destination_location_id: x.destination_location_id || '' })) }; baseline.current = JSON.stringify(next); setForm(next) } else if (prefillProductId) api.product(prefillProductId).then(addProduct).catch(setError) }, [initial, prefillProductId])
  useEffect(() => { if (!q) { setProducts([]); return }; const t = setTimeout(() => api.products(q).then(x => setProducts(x.items || [])).catch(setError), 180); return () => clearTimeout(t) }, [q])
  function addProduct(p) { setForm(x => ({ ...x, lines: [...x.lines, { product_id: p.product_id, product_name: p.display_name, quantity: 1, uom_id: p.uom_id || '', uom_code: p.uom_code || '', source_uom_raw: p.source_uom_raw || '个', notes: '', source_location_id: '', destination_location_id: '' }] })); setQ(''); setProducts([]) }
  function updateLine(index, key, value) { setForm(x => ({ ...x, lines: x.lines.map((line, i) => i === index ? { ...line, [key]: value } : line) })) }
  async function save(e) { e.preventDefault(); setError(null); setBusy(true); try { const payload = { request_type: form.request_type, source_location_id: form.source_location_id || null, destination_location_id: form.destination_location_id || null, reason: form.reason || null, lines: form.lines.map(x => ({ product_id: Number(x.product_id), quantity: Number(x.quantity), uom_id: x.uom_id ? Number(x.uom_id) : null, uom_code: x.uom_code || null, source_uom_raw: x.source_uom_raw || '个', source_location_id: x.source_location_id ? Number(x.source_location_id) : null, destination_location_id: x.destination_location_id ? Number(x.destination_location_id) : null, notes: x.notes || null })) }; const result = id ? await api.updateRequest(id, { ...payload, version: initial.version }) : await api.createRequest(payload); navigate(`/requests/${result.stock_request_id}`) } catch (err) { setError(err) } finally { setBusy(false) } }
  const typeLabels = { RECEIPT: '入库', ISSUE_OTHER: '出库', TRANSFER: '调货', RETURN: '退回' }
  return <section><Back to={id ? `/requests/${id}` : '/requests'} /><PageHeading eyebrow="OA 流程" title={id ? '编辑申请' : '新建申请'} description="先保存草稿，再提交给仓管处理。" /><form className="panel form-grid" onSubmit={save}><Field label="申请类型"><select value={form.request_type} onChange={e => setForm({ ...form, request_type: e.target.value })}>{Object.entries(typeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="原因/备注"><input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></Field><Field label="默认来源库位"><select value={form.source_location_id} onChange={e => setForm({ ...form, source_location_id: e.target.value })}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || l.location_type}</option>)}</select></Field><Field label="默认目的库位"><select value={form.destination_location_id} onChange={e => setForm({ ...form, destination_location_id: e.target.value })}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || l.location_type}</option>)}</select></Field><div className="span-2 picker-field"><span className="field-label">添加货品</span><div className="picker-row"><input value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" /><ScanPicker onAdd={addProduct} /></div>{products.length > 0 && <div className="picker-results">{products.map(p => <button type="button" key={p.product_id} onClick={() => addProduct(p)}><strong>{p.display_name}</strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}</div><div className="span-2 line-editor"><div className="line-editor-head"><h2>申请明细 ({form.lines.length})</h2><span className="muted">可重复添加同一货品</span></div>{form.lines.length ? form.lines.map((line, i) => <article className="line-card" key={`${line.product_id}-${i}`}><div className="line-title"><div><strong>{line.product_name || `货品 ${line.product_id}`}</strong><small>{line.uom_code || line.source_uom_raw || '—'}</small></div><button type="button" className="danger-link" onClick={() => setForm(x => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))}>删除</button></div><div className="line-fields"><Field label="数量"><input type="number" min="0.001" step="0.001" value={line.quantity} onChange={e => updateLine(i, 'quantity', e.target.value)} /></Field><Field label="单位"><select value={line.uom_id || ''} onChange={e => { const value = e.target.value; const u = uoms.find(x => String(x.uom_id) === value); updateLine(i, 'uom_id', value); updateLine(i, 'uom_code', u?.code || line.uom_code) }}><option value="">跟随货品</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field><Field label="单行来源库位"><select value={line.source_location_id || ''} onChange={e => updateLine(i, 'source_location_id', e.target.value)}><option value="">跟随默认</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name}</option>)}</select></Field><Field label="单行目的库位"><select value={line.destination_location_id || ''} onChange={e => updateLine(i, 'destination_location_id', e.target.value)}><option value="">跟随默认</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name}</option>)}</select></Field></div><Field label="明细备注"><input value={line.notes} onChange={e => updateLine(i, 'notes', e.target.value)} /></Field></article>) : <Empty>还没有添加货品</Empty>}</div><ErrorBox error={error} /><div className="span-2 actions"><Button className="primary" disabled={busy}>{busy ? '保存中…' : '保存草稿'}</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/requests/${id}` : '/requests')}>取消</Button></div></form></section>
}

function RequestDetail({ id, user }) {
  const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null); const [busy, setBusy] = useState(false); const [rejectReason, setRejectReason] = useState(''); const [rejecting, setRejecting] = useState(false)
  const reload = () => api.stockRequest(id).then(setData).catch(setError); useEffect(() => { reload() }, [id])
  if (!data) return error ? <section><Back to="/requests" /><ErrorBox error={error} /></section> : <Loading />
  const canEdit = data.status === 'DRAFT' && (user.role === 'WAREHOUSE_ADMIN' || data.requester_user_id === user.user_id) || data.status === 'SUBMITTED' && user.role === 'WAREHOUSE_ADMIN'
  async function action(name, payload) { setBusy(true); setError(null); try { await api.action(id, name, payload); await reload(); if (name === 'reject') { setRejecting(false); setRejectReason('') } } catch (err) { setError(err) } finally { setBusy(false) } }
  return <section><Back to="/requests" /><PageHeading eyebrow="申请详情" title={data.request_no} description={`${data.request_type} · ${data.requester_display_name || data.requester_username || '申请人'}`}><Badge tone={data.status === 'RELEASED' ? 'green' : data.status === 'REJECTED' ? 'red' : 'amber'}>{data.status}</Badge></PageHeading><div className="detail-grid"><div className="panel"><h2>申请信息</h2><dl className="detail-list"><dt>原因</dt><dd>{data.reason || '—'}</dd><dt>来源库位</dt><dd>{data.source_location_id || '默认/明细指定'}</dd><dt>目的库位</dt><dd>{data.destination_location_id || '默认/明细指定'}</dd><dt>版本</dt><dd>{data.version}</dd></dl></div><div className="panel"><h2>明细</h2><div className="detail-lines">{data.lines.map(line => <div className="detail-line" key={line.stock_request_line_id}><div><strong>{line.product_name}</strong><span>{line.specification || '—'} · {line.uom_code || '—'}</span></div><b>{line.quantity}</b></div>)}</div></div></div><div className="panel actions-panel"><div className="actions">{canEdit && <Button className="primary" onClick={() => navigate(`/requests/${id}/edit`)}>编辑</Button>}{data.status === 'DRAFT' && data.requester_user_id === user.user_id && <Button className="secondary" onClick={() => action('submit')} disabled={busy}>提交</Button>}{data.status === 'SUBMITTED' && data.requester_user_id === user.user_id && <Button className="secondary" onClick={() => action('withdraw')} disabled={busy}>撤回到草稿</Button>}{user.role === 'WAREHOUSE_ADMIN' && data.status === 'SUBMITTED' && <><Button className="secondary" onClick={() => action('approve')} disabled={busy}>审批</Button><Button className="danger" onClick={() => setRejecting(true)} disabled={busy}>驳回</Button></>}{user.role === 'WAREHOUSE_ADMIN' && data.status === 'APPROVED' && <Button className="primary" onClick={() => action('release')} disabled={busy}>放行</Button>}</div>{rejecting && <div className="reject-panel"><Field label="驳回原因"><textarea rows="3" autoFocus value={rejectReason} onChange={event => setRejectReason(event.target.value)} placeholder="请输入明确的驳回原因" /></Field><div className="actions"><Button className="danger" onClick={() => action('reject', { reason: rejectReason.trim() })} disabled={busy || !rejectReason.trim()}>确认驳回</Button><Button className="secondary" onClick={() => { setRejecting(false); setRejectReason('') }} disabled={busy}>取消</Button></div></div>}<h3>操作记录</h3>{data.actions?.map(a => <div className="timeline-row" key={a.stock_request_action_id}><span>{a.action}</span><small>{a.actor_display_name || a.actor_username || '—'} · {new Date(a.created_at).toLocaleString()}</small></div>)}</div></section>
}

function AdminPage() {
  const [users, setUsers] = useState([]); const [locations, setLocations] = useState([]); const [error, setError] = useState(null); const { navigate } = useRouter(); const reload = () => Promise.all([api.users(), api.locations()]).then(([u, l]) => { setUsers(u); setLocations(l) }).catch(setError); useEffect(() => { reload() }, [])
  return <section><PageHeading eyebrow="系统管理" title="用户与库位" description="稳定编码不可改，业务字段修改会留下审计。"><div className="actions"><Button className="primary" onClick={() => navigate('/admin/users/new')}>＋ 用户</Button><Button className="secondary" onClick={() => navigate('/admin/locations/new')}>＋ 库位</Button></div></PageHeading><ErrorBox error={error} /><div className="panel"><h2>用户</h2><div className="record-list">{users.map(u => <Link className="record-card" key={u.user_id} to={`/admin/users/${u.user_id}`}><div><strong>{u.display_name}</strong><span>{u.username} · {u.role === 'WAREHOUSE_ADMIN' ? '仓管' : '申请人'}</span></div><Badge tone={u.is_active ? 'green' : 'red'}>{u.is_active ? '启用' : '停用'}</Badge></Link>)}</div></div><div className="panel"><h2>库位</h2><div className="record-list">{locations.map(l => <Link className="record-card" key={l.location_id} to={`/admin/locations/${l.location_id}`}><div><strong>{l.name}</strong><span>{l.code || '无编码'} · {l.location_type}</span></div><Badge tone={l.is_active ? 'green' : 'red'}>{l.is_active ? '启用' : '停用'}</Badge></Link>)}</div></div></section>
}

function UserForm({ id }) {
  const { navigate } = useRouter(); const [form, setForm] = useState({ display_name: '', role: 'REQUESTER', is_active: true, password: '' }); const baseline = useRef(JSON.stringify(form)); const [error, setError] = useState(null); const [busy, setBusy] = useState(false)
  useDirtyLeaveGuard(JSON.stringify(form) !== baseline.current)
  useEffect(() => { if (id) api.user(id).then(x => { const next = { display_name: x.display_name, role: x.role, is_active: x.is_active, password: '' }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id]); async function save(e) { e.preventDefault(); setBusy(true); setError(null); try { const payload = { display_name: form.display_name, role: form.role, is_active: form.is_active }; if (form.password) payload.password = form.password; const result = id ? await api.updateUser(id, payload) : await api.createUser({ username: form.username, ...payload, password: form.password }); navigate(`/admin/users/${result.user_id || id}`) } catch (err) { setError(err) } finally { setBusy(false) } }
  return <section><Back to="/admin" /><PageHeading eyebrow="系统管理" title={id ? '编辑用户' : '新增用户'} /><form className="panel form-grid" onSubmit={save}>{!id && <Field label="用户名"><input required value={form.username || ''} onChange={e => setForm({ ...form, username: e.target.value })} /></Field>}<Field label="显示名"><input required value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} /></Field><Field label="角色"><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option value="REQUESTER">申请人</option><option value="WAREHOUSE_ADMIN">仓管</option></select></Field><Field label={id ? '新密码（可选）' : '初始密码'}><input type="password" minLength="8" required={!id} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>{id && <label className="check-field"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} /> 启用账号</label>}<ErrorBox error={error} /><div className="span-2 actions"><Button className="primary" disabled={busy}>保存</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/admin/users/${id}` : '/admin')}>取消</Button></div></form></section>
}

function UserDetail({ id }) { const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null); useEffect(() => { api.user(id).then(setData).catch(setError) }, [id]); if (!data) return error ? <section><Back to="/admin" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/admin" /><PageHeading eyebrow="用户详情" title={data.display_name}><Button className="primary" onClick={() => navigate(`/admin/users/${id}/edit`)}>编辑</Button></PageHeading><div className="panel"><dl className="detail-list"><dt>用户名</dt><dd>{data.username}</dd><dt>角色</dt><dd>{data.role}</dd><dt>状态</dt><dd>{data.is_active ? '启用' : '停用'}</dd><dt>创建时间</dt><dd>{new Date(data.created_at).toLocaleString()}</dd></dl></div></section> }

function LocationForm({ id }) { const { navigate } = useRouter(); const [form, setForm] = useState({ code: '', name: '', location_type: 'warehouse', is_company_inventory: true, is_active: true }); const baseline = useRef(JSON.stringify(form)); const [error, setError] = useState(null); useDirtyLeaveGuard(JSON.stringify(form) !== baseline.current); useEffect(() => { if (id) api.location(id).then(x => { const next = { code: x.code || '', name: x.name, location_type: x.location_type, is_company_inventory: x.is_company_inventory, is_active: x.is_active }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id]); async function save(e) { e.preventDefault(); setError(null); try { const result = id ? await api.updateLocation(id, { name: form.name, location_type: form.location_type, is_company_inventory: form.is_company_inventory, is_active: form.is_active }) : await api.createLocation(form); navigate(`/admin/locations/${result.location_id || id}`) } catch (err) { setError(err) } }
  return <section><Back to="/admin" /><PageHeading eyebrow="系统管理" title={id ? '编辑库位' : '新增库位'} /><form className="panel form-grid" onSubmit={save}><Field label="编码"><input required disabled={Boolean(id)} value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} /></Field><Field label="名称"><input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="类型"><select value={form.location_type} onChange={e => setForm({ ...form, location_type: e.target.value })}><option value="warehouse">仓库</option><option value="hospital">医院</option><option value="department">科室</option><option value="customer">客户</option><option value="external">外部</option><option value="transit">在途</option><option value="other">其他</option></select></Field><label className="check-field"><input type="checkbox" checked={form.is_company_inventory} onChange={e => setForm({ ...form, is_company_inventory: e.target.checked })} /> 公司库存</label>{id && <label className="check-field"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} /> 启用</label>}<ErrorBox error={error} /><div className="span-2 actions"><Button className="primary">保存</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/admin/locations/${id}` : '/admin')}>取消</Button></div></form></section> }

function LocationDetail({ id }) { const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null); useEffect(() => { api.location(id).then(setData).catch(setError) }, [id]); if (!data) return error ? <section><Back to="/admin" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/admin" /><PageHeading eyebrow="库位详情" title={data.name}><Button className="primary" onClick={() => navigate(`/admin/locations/${id}/edit`)}>编辑</Button></PageHeading><div className="panel"><dl className="detail-list"><dt>编码</dt><dd>{data.code || '—'}</dd><dt>类型</dt><dd>{data.location_type}</dd><dt>公司库存</dt><dd>{data.is_company_inventory ? '是' : '否'}</dd><dt>状态</dt><dd>{data.is_active ? '启用' : '停用'}</dd></dl></div></section> }

function Conflicts() { const { navigate } = useRouter(); const [rows, setRows] = useState([]); const [error, setError] = useState(null); useEffect(() => { api.conflicts().then(setRows).catch(setError) }, []); return <section><PageHeading eyebrow="数据治理" title="冲突中心" description="需要人工确认的编号、单位、日期和数量问题。" /><div className="panel"><ErrorBox error={error} />{rows.length ? <div className="record-list">{rows.map(c => <Link className="record-card" key={c.resolution_case_id} to={`/conflicts/${c.resolution_case_id}`}><div><strong>{c.case_type || c.issue_code}</strong><span>{c.message || c.notes || '需要人工确认'}</span></div><Badge tone="red">{c.severity || 'REVIEW'}</Badge></Link>)}</div> : <Empty>没有待处理冲突</Empty>}</div></section> }
function ConflictDetail({ id }) { const { navigate } = useRouter(); const [data, setData] = useState(null); const [note, setNote] = useState(''); const [error, setError] = useState(null); const [busy, setBusy] = useState(false); useEffect(() => { api.conflict(id).then(setData).catch(setError) }, [id]); async function resolve() { if (!note.trim()) return setError(new Error('请填写处理备注')); setBusy(true); try { await api.resolveConflict(id, { resolution_notes: note }); navigate('/conflicts') } catch (err) { setError(err) } finally { setBusy(false) } } if (!data) return error ? <section><Back to="/conflicts" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/conflicts" /><PageHeading eyebrow="冲突详情" title={data.case_type || data.issue_code}><Badge tone="red">{data.status_code || 'pending_review'}</Badge></PageHeading><div className="panel"><ErrorBox error={error} /><p>{data.message || data.notes || '需要人工确认'}</p><dl className="detail-list"><dt>来源记录</dt><dd>{data.source_record_id || '—'}</dd><dt>打开时间</dt><dd>{data.opened_at ? new Date(data.opened_at).toLocaleString() : '—'}</dd></dl>{data.status_code === 'resolved' ? <div className="alert">已处理：{data.resolution_notes || '—'}</div> : <><Field label="处理备注"><textarea rows="4" value={note} onChange={e => setNote(e.target.value)} /></Field><Button className="primary" onClick={resolve} disabled={busy}>标记已处理</Button></>}</div></section> }

function Audit() { const [rows, setRows] = useState([]); const [error, setError] = useState(null); useEffect(() => { api.audit().then(setRows).catch(setError) }, []); return <section><PageHeading eyebrow="合规" title="操作审计" description="不可变记录，仅管理员可见。" /><div className="panel"><ErrorBox error={error} />{rows.length ? <div className="record-list">{rows.map(a => <Link className="record-card" key={a.audit_event_id} to={`/audit/${a.audit_event_id}`}><div><strong>{a.action}</strong><span>{a.target_table} / {a.target_id || '—'} · {a.created_at ? new Date(a.created_at).toLocaleString() : '—'}</span></div><small className="mono">{a.request_id || '—'}</small></Link>)}</div> : <Empty>暂无审计记录</Empty>}</div></section> }
function AuditDetail({ id }) { const [data, setData] = useState(null); const [error, setError] = useState(null); useEffect(() => { api.auditEvent(id).then(setData).catch(setError) }, [id]); if (!data) return error ? <section><Back to="/audit" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/audit" /><PageHeading eyebrow="审计详情" title={data.action}><Badge>{data.target_table}</Badge></PageHeading><div className="panel"><dl className="detail-list"><dt>目标</dt><dd>{data.target_table} / {data.target_id || '—'}</dd><dt>操作者</dt><dd>{data.actor_name || data.actor_user_id || '—'}</dd><dt>时间</dt><dd>{new Date(data.created_at).toLocaleString()}</dd><dt>请求 ID</dt><dd className="mono">{data.request_id || '—'}</dd></dl><pre className="json-view">{JSON.stringify({ before: data.before_data, after: data.after_data, diff: data.field_diff }, null, 2)}</pre></div></section> }

function InventoryDetail({ ids }) { const { navigate } = useRouter(); const [data, setData] = useState(null); const [error, setError] = useState(null); const [product, setProduct] = useState(null); useEffect(() => { api.inventoryDetail(ids).then(setData).catch(setError); api.product(ids.product_id).then(setProduct).catch(() => {}) }, [ids]); if (!data) return error ? <section><Back to="/" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/" /><PageHeading eyebrow="库存余额详情" title={data.product_name}><Button className="primary" onClick={() => navigate(`/requests/new?product_id=${ids.product_id}`)}>以此货品新建申请</Button></PageHeading><div className="stats"><div className="stat teal"><span>当前数量</span><strong>{data.on_hand_quantity} {data.uom_code}</strong></div><div className="stat"><span>库位</span><strong>{data.location_name}</strong></div><div className="stat"><span>成色</span><strong>{data.condition_code}</strong></div></div><div className="panel"><h2>相关流水</h2>{data.movements?.length ? <div className="record-list">{data.movements.map(m => <div className="record-card" key={m.inventory_movement_id}><div><strong>{m.movement_type}</strong><span>{m.source_location_name || '—'} → {m.destination_location_name || '—'}</span></div><div className="record-value"><b>{m.quantity}</b><small>{m.movement_date}</small></div></div>)}</div> : <Empty>暂无流水</Empty>}</div>{product && <Link className="text-link" to={`/products/${product.product_id}`}>查看货品主数据 →</Link>}</section> }

function NotFound() { return <section><PageHeading eyebrow="404" title="页面不存在" description="请从导航返回业务列表。" /><Link className="primary button-link" to="/">返回总览</Link></section> }

function routeView(path, user, query) {
  const parts = path.split('/').filter(Boolean); const first = parts[0]; const id = parts[1]; const sub = parts[2]
  if (path === '/') return <Dashboard />
  if (first === 'products') { if (path === '/products') return <ProductList user={user} />; if (id === 'new') return user.role === 'WAREHOUSE_ADMIN' ? <ProductForm /> : <Forbidden />; if (sub === 'edit') return user.role === 'WAREHOUSE_ADMIN' ? <ProductForm id={id} /> : <Forbidden />; return <ProductDetail id={id} user={user} /> }
  if (first === 'requests') { if (path === '/requests') return <RequestList user={user} />; if (id === 'new') return <RequestForm prefillProductId={query?.get('product_id')} />; if (sub === 'edit') return <RequestDetailLoader id={id} user={user} edit />; return <RequestDetail id={id} user={user} /> }
  if (first === 'inventory') return <InventoryDetail ids={{ product_id: id, location_id: parts[2], condition_id: parts[3], uom_id: parts[4] }} />
  if (first === 'admin') { if (path === '/admin') return user.role === 'WAREHOUSE_ADMIN' ? <AdminPage /> : <Forbidden />; if (parts[1] === 'users') return user.role === 'WAREHOUSE_ADMIN' ? (parts[2] === 'new' ? <UserForm /> : parts[3] === 'edit' ? <UserForm id={parts[2]} /> : <UserDetail id={parts[2]} />) : <Forbidden />; if (parts[1] === 'locations') return user.role === 'WAREHOUSE_ADMIN' ? (parts[2] === 'new' ? <LocationForm /> : parts[3] === 'edit' ? <LocationForm id={parts[2]} /> : <LocationDetail id={parts[2]} />) : <Forbidden /> }
  if (first === 'conflicts') return user.role === 'WAREHOUSE_ADMIN' ? (path === '/conflicts' ? <Conflicts /> : <ConflictDetail id={id} />) : <Forbidden />
  if (first === 'audit') return user.role === 'WAREHOUSE_ADMIN' ? (path === '/audit' ? <Audit /> : <AuditDetail id={id} />) : <Forbidden />
  if (first === 'profile') return <Profile user={user} />
  return <NotFound />
}
function RequestDetailLoader({ id, user, edit }) { const [data, setData] = useState(null); const [error, setError] = useState(null); useEffect(() => { api.stockRequest(id).then(setData).catch(setError) }, [id]); if (error) return <section><Back to={`/requests/${id}`} /><ErrorBox error={error} /></section>; return data ? (edit ? <RequestForm id={id} initial={data} /> : <RequestDetail id={id} user={user} />) : <Loading /> }
function Forbidden() { return <section><PageHeading eyebrow="403" title="无权访问" description="当前账号没有执行此操作的权限。" /><Link className="primary button-link" to="/">返回总览</Link></section> }
function Profile({ user }) { return <section><PageHeading eyebrow="账户" title="我的信息" description="当前登录账号信息。" /><div className="panel"><dl className="detail-list"><dt>显示名</dt><dd>{user.display_name || '—'}</dd><dt>用户名</dt><dd>{user.username}</dd><dt>角色</dt><dd>{user.role === 'WAREHOUSE_ADMIN' ? '仓管' : '申请人'}</dd></dl></div></section> }

function AppRouter({ user, onLogout }) {
  const [path, setPath] = useState(window.location.pathname + window.location.search)
  useEffect(() => { const fn = () => setPath(window.location.pathname + window.location.search); window.addEventListener('popstate', fn); return () => window.removeEventListener('popstate', fn) }, [])
  const navigate = to => { window.history.pushState({}, '', to); setPath(to) }
  const clean = normalizePath(path.split('?')[0])
  return <RouterContext.Provider value={{ navigate, currentPath: clean }}><Layout user={user} onLogout={onLogout}>{routeView(clean, user, new URLSearchParams(path.split('?')[1] || ''))}</Layout></RouterContext.Provider>
}

function App() { const [user, setUser] = useState(null); const [loading, setLoading] = useState(true); useEffect(() => { api.me().then(setUser).catch(() => {}).finally(() => setLoading(false)) }, []); if (loading) return <Loading />; return user ? <AppRouter user={user} onLogout={() => setUser(null)} /> : <Login onLogin={setUser} /> }

createRoot(document.getElementById('root')).render(<App />)
