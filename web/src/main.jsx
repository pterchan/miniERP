import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

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
    if (!response.ok) throw new Error(body.detail || body.message || `请求失败 (${response.status})`)
    return body
  },
  login: (username, password) => api.request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => api.request('/auth/logout', { method: 'POST' }),
  me: () => api.request('/auth/me'),
  inventory: (q = '') => api.request(`/inventory/balance${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  products: (q = '') => api.request(`/products?q=${encodeURIComponent(q)}&page=1&page_size=30`),
  uoms: () => api.request('/uoms'),
  locations: () => api.request('/locations'),
  users: () => api.request('/admin/users'),
  createUser: (payload) => api.request('/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
  createLocation: (payload) => api.request('/locations', { method: 'POST', body: JSON.stringify(payload) }),
  createProduct: (payload) => api.request('/products', { method: 'POST', body: JSON.stringify(payload) }),
  requests: (mine = false) => api.request(`/stock-requests${mine ? '?mine=true' : ''}`),
  createRequest: (payload) => api.request('/stock-requests', { method: 'POST', body: JSON.stringify(payload) }),
  action: (id, action, payload = {}) => api.request(`/stock-requests/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload) }),
  conflicts: () => api.request('/conflicts'),
  resolveConflict: (id, payload) => api.request(`/conflicts/${id}/resolve`, { method: 'POST', body: JSON.stringify(payload) }),
  audit: () => api.request('/audit?page=1&page_size=100')
}

function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); setError('')
    try { const user = await api.login(username, password); onLogin(user) } catch (err) { setError(err.message) }
  }
  return <main className="login-shell"><form className="login-card" onSubmit={submit}>
    <div className="brand-mark">库存 ERP</div><h1>欢迎回来</h1><p className="muted">出入库申请、审批与审计</p>
    <label>账号<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required /></label>
    <label>密码<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
    {error && <div className="alert error">{error}</div>}<button className="primary wide">登录</button>
  </form></main>
}

function Badge({ children, tone = 'neutral' }) { return <span className={`badge ${tone}`}>{children}</span> }
function Empty({ children = '暂无数据' }) { return <div className="empty">{children}</div> }
function Stat({ label, value, accent = '' }) { return <div className={`stat ${accent}`}><span>{label}</span><strong>{value ?? '—'}</strong></div> }

function Dashboard({ user }) {
  const [items, setItems] = useState([]); const [q, setQ] = useState(''); const [error, setError] = useState('')
  useEffect(() => { api.inventory().then(x => setItems(x.items || x || [])).catch(e => setError(e.message)) }, [])
  const total = useMemo(() => items.reduce((sum, row) => sum + Number(row.on_hand_quantity || row.quantity || 0), 0), [items])
  const filtered = items.filter(x => !q || JSON.stringify(x).toLowerCase().includes(q.toLowerCase())).slice(0, 80)
  return <section><div className="page-heading"><div><p className="eyebrow">总览</p><h1>库存工作台</h1><p className="muted">欢迎，{user.display_name || user.username}。今天需要处理什么？</p></div></div>
    <div className="stats"><Stat label="货品/库位行" value={items.length} /><Stat label="当前数量" value={total.toFixed(3)} accent="teal" /><Stat label="角色" value={user.role === 'WAREHOUSE_ADMIN' ? '仓管' : '非仓管'} /></div>
    <div className="panel"><div className="panel-head"><div><h2>库存余额</h2><p className="muted">按货品、库位、成色和单位聚合</p></div><input className="search" placeholder="搜索编号、名称、厂家、型号" value={q} onChange={e => setQ(e.target.value)} /></div>
      {error ? <div className="alert error">{error}</div> : filtered.length ? <InventoryTable rows={filtered} /> : <Empty>没有匹配的货品</Empty>}</div></section>
}

function InventoryTable({ rows }) { return <div className="table-wrap"><table><thead><tr><th>货品</th><th>编号</th><th>库位</th><th>数量</th><th>单位</th><th>状态</th></tr></thead><tbody>{rows.map((x, i) => <tr key={x.product_id || i}><td><strong>{x.product_name || x.display_name || '未命名'}</strong><small>{x.manufacturer || ''}</small></td><td>{x.identifier || x.source_number || '—'}</td><td>{x.location_name || '主仓库'}</td><td className="number">{x.on_hand_quantity ?? x.quantity ?? '—'}</td><td>{x.uom_code || x.unit || '—'}</td><td><Badge tone={Number(x.on_hand_quantity || 0) < 0 ? 'red' : 'green'}>{Number(x.on_hand_quantity || 0) < 0 ? '需关注' : '正常'}</Badge></td></tr>)}</tbody></table></div> }

function Products({ user }) {
  const [q, setQ] = useState(''); const [rows, setRows] = useState([]); const [loading, setLoading] = useState(false)
  const [newProduct, setNewProduct] = useState({ display_name: '', manufacturer: '', specification: '', source_uom_raw: '个' }); const [message, setMessage] = useState('')
  useEffect(() => { const t = setTimeout(() => { setLoading(true); api.products(q).then(x => setRows(x.items || x || [])).finally(() => setLoading(false)) }, 220); return () => clearTimeout(t) }, [q])
  async function create() { setMessage(''); try { await api.createProduct(newProduct); setMessage('货品已创建'); setNewProduct({ display_name: '', manufacturer: '', specification: '', source_uom_raw: '个' }); api.products(q).then(x => setRows(x.items || x || [])) } catch (e) { setMessage(e.message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">主数据</p><h1>货品搜索</h1><p className="muted">支持中文、英文、数字，以及编号/名称/厂家/型号模糊匹配。</p></div></div>{user?.role === 'WAREHOUSE_ADMIN' && <div className="panel form-grid"><div className="panel-head span-2"><div><h2>新增货品</h2><p className="muted">仓管操作会写入审计。</p></div></div><label>货品名<input value={newProduct.display_name} onChange={e => setNewProduct({ ...newProduct, display_name: e.target.value })} /></label><label>厂家<input value={newProduct.manufacturer} onChange={e => setNewProduct({ ...newProduct, manufacturer: e.target.value })} /></label><label>规格/型号<input value={newProduct.specification} onChange={e => setNewProduct({ ...newProduct, specification: e.target.value })} /></label><label>原始单位<input value={newProduct.source_uom_raw} onChange={e => setNewProduct({ ...newProduct, source_uom_raw: e.target.value })} /></label><div className="span-2 actions"><button className="primary" disabled={!newProduct.display_name} onClick={create}>创建</button>{message && <span className="muted">{message}</span>}</div></div>}<div className="panel"><input autoFocus className="search large" placeholder="例如：DV54、鼻罩、equipment model" value={q} onChange={e => setQ(e.target.value)} />{loading ? <Empty>搜索中…</Empty> : rows.length ? <InventoryTable rows={rows} /> : <Empty>输入关键词开始搜索</Empty>}</div></section>
}

function AdminManage() {
  const [users, setUsers] = useState([]); const [locations, setLocations] = useState([]); const [message, setMessage] = useState('')
  const [userForm, setUserForm] = useState({ username: '', display_name: '', role: 'REQUESTER', password: '' }); const [locationForm, setLocationForm] = useState({ code: '', name: '', location_type: 'warehouse', is_company_inventory: true })
  const reload = () => Promise.all([api.users(), api.locations()]).then(([u, l]) => { setUsers(u.items || u); setLocations(l.items || l) }).catch(e => setMessage(e.message))
  useEffect(() => { reload() }, [])
  async function addUser() { try { await api.createUser(userForm); setMessage('用户已创建'); setUserForm({ username: '', display_name: '', role: 'REQUESTER', password: '' }); reload() } catch (e) { setMessage(e.message) } }
  async function addLocation() { try { await api.createLocation(locationForm); setMessage('库位已创建'); setLocationForm({ code: '', name: '', location_type: 'warehouse', is_company_inventory: true }); reload() } catch (e) { setMessage(e.message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">仓管设置</p><h1>用户与库位</h1><p className="muted">新增账号、库位和公司库存点，操作均可追溯。</p></div></div>{message && <div className="alert">{message}</div>}<div className="panel form-grid"><h2 className="span-2">新增用户</h2><label>用户名<input value={userForm.username} onChange={e => setUserForm({ ...userForm, username: e.target.value })} /></label><label>显示名<input value={userForm.display_name} onChange={e => setUserForm({ ...userForm, display_name: e.target.value })} /></label><label>角色<select value={userForm.role} onChange={e => setUserForm({ ...userForm, role: e.target.value })}><option value="REQUESTER">非仓管</option><option value="WAREHOUSE_ADMIN">仓管</option></select></label><label>初始密码<input type="password" value={userForm.password} onChange={e => setUserForm({ ...userForm, password: e.target.value })} /></label><div className="span-2"><button className="primary" onClick={addUser}>创建用户</button></div></div><div className="panel form-grid"><h2 className="span-2">新增库位</h2><label>编码<input value={locationForm.code} onChange={e => setLocationForm({ ...locationForm, code: e.target.value })} /></label><label>名称<input value={locationForm.name} onChange={e => setLocationForm({ ...locationForm, name: e.target.value })} /></label><label>类型<select value={locationForm.location_type} onChange={e => setLocationForm({ ...locationForm, location_type: e.target.value })}><option value="warehouse">仓库</option><option value="hospital">医院</option><option value="department">科室</option><option value="external">外部</option></select></label><div className="span-2"><button className="primary" onClick={addLocation}>创建库位</button></div></div><div className="panel"><h2>用户</h2><div className="table-wrap"><table><thead><tr><th>账号</th><th>显示名</th><th>角色</th><th>状态</th></tr></thead><tbody>{users.map(u => <tr key={u.user_id}><td>{u.username}</td><td>{u.display_name}</td><td>{u.role === 'WAREHOUSE_ADMIN' ? '仓管' : '非仓管'}</td><td>{u.is_active ? '启用' : '停用'}</td></tr>)}</tbody></table></div><h2 className="section-title">库位</h2><div className="table-wrap"><table><thead><tr><th>编码</th><th>名称</th><th>类型</th><th>公司库存</th></tr></thead><tbody>{locations.map(l => <tr key={l.location_id}><td>{l.code || '—'}</td><td>{l.name}</td><td>{l.location_type}</td><td>{l.is_company_inventory ? '是' : '否'}</td></tr>)}</tbody></table></div></div></section>
}

function RequestForm({ onCreated }) {
  const [form, setForm] = useState({ request_type: 'ISSUE_OTHER', product_id: '', quantity: 1, uom_id: '', source_location_id: '', destination_location_id: '', notes: '' }); const [products, setProducts] = useState([]); const [locations, setLocations] = useState([]); const [q, setQ] = useState(''); const [message, setMessage] = useState('')
  useEffect(() => { if (q.length > 0) api.products(q).then(x => setProducts(x.items || x || [])) }, [q])
  useEffect(() => { api.locations().then(x => setLocations(x.items || x || [])) }, [])
  async function submit(e) { e.preventDefault(); setMessage(''); try { await api.createRequest({ request_type: form.request_type, source_location_id: form.source_location_id || null, destination_location_id: form.destination_location_id || null, reason: form.notes || null, lines: [{ product_id: Number(form.product_id), quantity: Number(form.quantity), uom_code: form.uom_id || null, source_uom_raw: form.uom_id ? ({ EA: '个', BOX: '盒', SET: '套', M: '米' }[form.uom_id] || form.uom_id) : '个', source_location_id: form.source_location_id || null, destination_location_id: form.destination_location_id || null, notes: form.notes || null }] }); setMessage('草稿已保存'); onCreated?.() } catch (err) { setMessage(err.message) } }
  return <form className="panel form-grid" onSubmit={submit}><div className="panel-head"><div><h2>新建申请</h2><p className="muted">提交后由仓管审批并放行。</p></div></div><label>类型<select value={form.request_type} onChange={e => setForm({ ...form, request_type: e.target.value })}><option value="RECEIPT">入库</option><option value="ISSUE_OTHER">出库</option><option value="TRANSFER">调货</option></select></label><label className="span-2">货品搜索<input value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" required />{products.length > 0 && <select className="suggestions" value={form.product_id} onChange={e => setForm({ ...form, product_id: e.target.value })}><option value="">选择匹配货品</option>{products.map(p => <option key={p.product_id} value={p.product_id}>{p.display_name} · {p.identifier || '无编号'}</option>)}</select>}</label><label>数量<input type="number" step="0.001" min="0.001" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} required /></label><label>单位<select value={form.uom_id} onChange={e => setForm({ ...form, uom_id: e.target.value })}><option value="">跟随货品单位</option><option value="EA">个</option><option value="BOX">盒</option><option value="SET">套</option><option value="M">米</option><option value="UNKNOWN">其他</option></select></label><label>来源库位<select value={form.source_location_id} onChange={e => setForm({ ...form, source_location_id: e.target.value })}><option value="">默认主仓库</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || l.location_type}</option>)}</select></label><label>目的库位<select value={form.destination_location_id} onChange={e => setForm({ ...form, destination_location_id: e.target.value })}><option value="">默认主仓库</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || l.location_type}</option>)}</select></label><label className="span-2">备注<textarea rows="3" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>{message && <div className="alert span-2">{message}</div>}<div className="span-2 actions"><button className="primary">保存草稿</button></div></form>
}

function Requests({ user }) {
  const [rows, setRows] = useState([]); const [showForm, setShowForm] = useState(false); const [error, setError] = useState(''); const isAdmin = user.role === 'WAREHOUSE_ADMIN'
  const reload = () => api.requests(!isAdmin).then(x => setRows(x.items || x || [])).catch(e => setError(e.message))
  useEffect(reload, [isAdmin])
  async function action(id, name) { try { await api.action(id, name); reload() } catch (e) { setError(e.message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">OA 流程</p><h1>{isAdmin ? '审批队列' : '我的申请'}</h1><p className="muted">{isAdmin ? '审核、修正并放行出入库单。' : '提交后由仓管处理，草稿可撤回。'}</p></div><button className="primary" onClick={() => setShowForm(!showForm)}>＋ 新建申请</button></div>{showForm && <RequestForm onCreated={() => { setShowForm(false); reload() }} />}{error && <div className="alert error">{error}</div>}<div className="panel"><div className="table-wrap"><table><thead><tr><th>单号</th><th>类型</th><th>申请人</th><th>数量</th><th>状态</th><th>时间</th><th /></tr></thead><tbody>{rows.length ? rows.map(r => <tr key={r.stock_request_id || r.id}><td><strong>{r.request_no || r.stock_request_id || r.id}</strong></td><td>{r.request_type}</td><td>{r.requester_username || r.requester_name || r.created_by || '—'}</td><td className="number">{r.total_quantity ?? r.quantity ?? '—'}</td><td><Badge tone={r.status === 'RELEASED' ? 'green' : r.status === 'REJECTED' ? 'red' : 'amber'}>{r.status || r.status_code}</Badge></td><td>{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td><td className="actions">{isAdmin && r.status === 'SUBMITTED' && <button className="small" onClick={() => action(r.stock_request_id || r.id, 'approve')}>审批</button>}{isAdmin && r.status === 'APPROVED' && <button className="small primary" onClick={() => action(r.stock_request_id || r.id, 'release')}>放行</button>}{!isAdmin && r.status === 'DRAFT' && <><button className="small" onClick={() => action(r.stock_request_id || r.id, 'submit')}>提交</button><button className="small" onClick={() => action(r.stock_request_id || r.id, 'withdraw')}>撤回</button></>}</td></tr>) : <tr><td colSpan="7"><Empty>暂无申请</Empty></td></tr>}</tbody></table></div></div></section>
}

function Conflicts() { const [rows, setRows] = useState([]); useEffect(() => { api.conflicts().then(x => setRows(x.items || x || [])) }, []); return <section><div className="page-heading"><div><p className="eyebrow">数据治理</p><h1>冲突中心</h1><p className="muted">编号冲突、单位、日期和数量异常必须先处理。</p></div></div><div className="panel">{rows.length ? <div className="conflict-list">{rows.map(c => <article className="conflict" key={c.resolution_case_id || c.id}><div><Badge tone="red">{c.severity || 'REVIEW'}</Badge><h3>{c.case_type || c.issue_code}</h3><p>{c.message || c.notes || '需要人工确认'}</p></div><button className="small" onClick={() => api.resolveConflict(c.resolution_case_id || c.id, { resolution_notes: '仓管已确认并标记处理' }).then(() => api.conflicts().then(x => setRows(x.items || x || [])))}>标记已处理</button></article>)}</div> : <Empty>没有待处理冲突</Empty>}</div></section> }

function Audit() { const [rows, setRows] = useState([]); useEffect(() => { api.audit().then(x => setRows(x.items || x || [])) }, []); return <section><div className="page-heading"><div><p className="eyebrow">合规</p><h1>操作审计</h1><p className="muted">所有生产域变更均留下不可变记录。</p></div></div><div className="panel table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>请求 ID</th></tr></thead><tbody>{rows.length ? rows.map((a, i) => <tr key={a.audit_event_id || i}><td>{a.created_at ? new Date(a.created_at).toLocaleString() : '—'}</td><td>{a.actor_name || a.actor_id || '—'}</td><td><Badge>{a.action}</Badge></td><td>{a.target_table} / {a.target_id || '—'}</td><td className="mono">{a.request_id || '—'}</td></tr>) : <tr><td colSpan="5"><Empty>暂无审计记录</Empty></td></tr>}</tbody></table></div></section> }

function App() {
  const [user, setUser] = useState(null); const [page, setPage] = useState('dashboard'); const [loading, setLoading] = useState(true)
  useEffect(() => { api.me().then(setUser).catch(() => {}).finally(() => setLoading(false)) }, [])
  if (loading) return <div className="loading">加载中…</div>
  if (!user) return <Login onLogin={setUser} />
  const isAdmin = user.role === 'WAREHOUSE_ADMIN'
  const pageView = page === 'dashboard' ? <Dashboard user={user} /> : page === 'products' ? <Products user={user} /> : page === 'requests' ? <Requests user={user} /> : page === 'conflicts' ? <Conflicts /> : page === 'admin' ? <AdminManage /> : <Audit />
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-dot" />库存 ERP</div><nav><button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>▦ <span>库存总览</span></button><button className={page === 'products' ? 'active' : ''} onClick={() => setPage('products')}>⌕ <span>货品搜索</span></button><button className={page === 'requests' ? 'active' : ''} onClick={() => setPage('requests')}>□ <span>{isAdmin ? '审批队列' : '我的申请'}</span></button>{isAdmin && <><button className={page === 'conflicts' ? 'active' : ''} onClick={() => setPage('conflicts')}>! <span>冲突中心</span></button><button className={page === 'admin' ? 'active' : ''} onClick={() => setPage('admin')}>⚙ <span>系统管理</span></button></>}<button className={page === 'audit' ? 'active' : ''} onClick={() => setPage('audit')}>◷ <span>操作审计</span></button></nav><div className="sidebar-foot"><Badge tone={isAdmin ? 'teal' : 'neutral'}>{isAdmin ? '仓管' : '非仓管'}</Badge><span className="user-name">{user.display_name || user.username}</span><button className="logout" onClick={() => api.logout().then(() => setUser(null))}>退出</button></div></aside><main className="content"><header className="mobile-header"><div className="brand"><span className="brand-dot" />库存 ERP</div><button onClick={() => setPage('requests')}>＋</button></header>{pageView}</main></div>
}

createRoot(document.getElementById('root')).render(<App />)
