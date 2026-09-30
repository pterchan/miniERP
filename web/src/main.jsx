import React, { useCallback, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import api, { invalidateInventory, setApiUser, setUnauthorizedHandler } from './api'
import { findProductMatches } from './scan-utils'
import { ScanStateHeading } from './scan-ui'
import DataTable, { toServerFilters } from './data-table'
import ProductGallery from './product-gallery'
import { formatInventorySummary, formatMoney, formatQuantity } from './list-utils'
import { isInventoryDocumentPath, isNavigationItemActive, normalizePath } from './navigation-utils'
import { ROLE_LABELS, can, canEdit, canView } from './roles'
import { Layout, Workbench } from './workspace'
import { STATUS_REGISTRY, ACTION_LABELS, statusLabel, actionLabel } from './status'
import { conditionLabel, movementLabel } from './business-labels'

const REQUEST_TYPE_LABELS = {
  RECEIPT: '入库', ISSUE_OTHER: '其他出库', ISSUE_SALE: '销售出库', ISSUE_CONSUMPTION: '消耗领用',
  ISSUE_GIFT: '赠送', ISSUE_SCRAP: '报废', TRANSFER: '调拨', RETURN: '退回',
}
const REQUEST_STATUS_LABELS = Object.fromEntries(Object.entries(STATUS_REGISTRY.request).map(([key, value]) => [key, value.label]))
const LOCATION_TYPE_LABELS = { warehouse: '仓库', hospital: '医院', department: '科室', customer: '客户处', external: '外部', transit: '在途', other: '其他' }
const requestTypeLabel = t => REQUEST_TYPE_LABELS[t] || t || '—'
const requestStatusLabel = t => REQUEST_STATUS_LABELS[t] || t || '—'
const locationTypeLabel = t => LOCATION_TYPE_LABELS[t] || t || '—'
import { DOC_GROUP_TYPES, documentRoute } from './documents'
import { masterRoute } from './master-data'
import { reportRoute } from './reports'
import { prepareImage } from './image-utils'
import { stripBasePath, withBasePath } from './app-path'
import { SerialDetail, SerialEntry, SerialLedger } from './serial'

import {
  Back, Badge, Button, Empty, ErrorBoundary, ErrorBox, Field, Link, Loading, NavLink, PageHeading,
  Forbidden, StatusBadge, Tabs, ObjectHeader, Timeline, FieldDiff, ActionConfirm, FormSection, ToastProvider, useToast, useBusy,
  RouterContext, confirmDirtyLeave, useDirtyLeaveGuard, useFetchOne, useIsMobile, useRouter,
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

function Dashboard({ compact = false }) {
  const [rows, setRows] = useState([]); const [error, setError] = useState(null)
  useEffect(() => {
    api.inventory().then(setRows).catch(setError)
  }, [])
  const productCount = useMemo(() => new Set(rows.map(row => row.product_id)).size, [rows])
  const locationCount = useMemo(() => new Set(rows.map(row => row.location_id)).size, [rows])
  const conditionOptions = useMemo(() => [...new Set(rows.map(r => r.condition_code).filter(Boolean))].map(c => ({ value: c, label: conditionLabel(c) })), [rows])
  const columns = useMemo(() => [
    { key: 'identifier', label: '业务编号', value: r => r.identifier || '—' },
    { key: 'product_name', label: '货品名称', filterType: 'search', searchKeys: ['identifier', 'product_name', 'manufacturer', 'specification', 'location_name', 'condition_code', 'uom_code'] },
    { key: 'location_name', label: '库位', filterType: 'text', value: r => r.location_name || '—' },
    { key: 'condition_code', label: '成色', filterType: 'select', filterOptions: conditionOptions, value: r => r.condition_code || '', render: r => conditionLabel(r.condition_code) },
    { key: 'on_hand_quantity', label: '现库存', align: 'end', value: r => formatQuantity(r.on_hand_quantity), sortValue: r => Number(r.on_hand_quantity || 0) },
    { key: 'uom_code', label: '单位', value: r => r.uom_code || '—' },
  ], [conditionOptions])
  const inventoryKey = r => `${r.product_id}:${r.location_id}:${r.condition_id}:${r.uom_id}`
  return <section>{!compact && <PageHeading eyebrow="库存" title="库存余额" description="按编号、货品、库位、成色和单位查看已过账余额。" />}<div className="stats"><div className="stat"><span>库存维度</span><strong>{rows.length}</strong></div><div className="stat teal"><span>货品数</span><strong>{productCount}</strong></div><div className="stat"><span>库位数</span><strong>{locationCount}</strong></div></div><div className="panel"><div className="panel-head"><div><h2>库存余额</h2><p className="muted">余额来自已过账流水；不同单位分别展示。</p></div></div><ErrorBox error={error} /><DataTable tableId={compact ? "workbench.inventory" : "inventory.balance"} queryKeys={["stock"]} filterRows={(items, query) => query.stock === "nonpositive" ? items.filter(row => Number(row.on_hand_quantity) <= 0) : items}
    mode="client"
    columns={columns}
    rows={rows}
    rowKey={inventoryKey}
    rowHref={r => `/inventory/${r.product_id}/${r.location_id}/${r.condition_id}/${r.uom_id}`}
    exportConfig={{ endpoint: '/api/inventory/balance/export', filename: '库存余额', allScope: 'ids' }}
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
  return <section><PageHeading eyebrow="主数据" title="货品" description="搜索并维护编号、名称、厂家、规格、库存和单位。">{user.role === 'ADMIN' && <Button className="primary" onClick={() => navigate('/products/new')}>＋ 新增货品</Button>}</PageHeading><div className="panel"><ErrorBox error={error} /><DataTable tableId="master.products"
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
  const toast = useToast(); const busyRef = useRef(false)
  const { navigate } = useRouter(); const [form, setForm] = useState({ display_name: '', manufacturer: '', specification: '', source_uom_raw: '个', default_uom_id: '', primary_identifier: '', category_id: '', purchase_cost_price: '', sales_price: '', serialized: false }); const baseline = useRef(JSON.stringify(form)); const [uoms, setUoms] = useState([]); const [categories, setCategories] = useState([]); const [error, setError] = useState(null); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false)
  const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form])
  useDirtyLeaveGuard(dirty)
  useEffect(() => { api.uoms().then(setUoms).catch(setError); api.categories().then(setCategories).catch(() => {}); if (id) api.product(id).then(p => { const next = { display_name: p.display_name || '', manufacturer: p.manufacturer || '', specification: p.specification || '', source_uom_raw: p.source_uom_raw || '', default_uom_id: p.default_uom_id || '', primary_identifier: p.primary_identifier?.value_raw || '', category_id: p.category_id || '', purchase_cost_price: p.purchase_cost_price != null ? String(p.purchase_cost_price) : '', sales_price: p.sales_price != null ? String(p.sales_price) : '', serialized: !!p.serialized }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id])
  function set(k, v) { setForm(x => ({ ...x, [k]: v })) }
  async function save(e) { e.preventDefault(); if (busyRef.current) return; busyRef.current = true; setError(null); setMessage(''); setBusy(true); try { const payload = { ...form, serialized: !!form.serialized, default_uom_id: form.default_uom_id ? Number(form.default_uom_id) : null, primary_identifier: form.primary_identifier || null, category_id: form.category_id ? Number(form.category_id) : null, purchase_cost_price: form.purchase_cost_price !== '' ? Number(form.purchase_cost_price) : 0, sales_price: form.sales_price !== '' ? Number(form.sales_price) : 0 }; const result = id ? await api.updateProduct(id, payload) : await api.createProduct(payload); baseline.current = JSON.stringify(form); setMessage(result.identifier_conflicts?.length ? '已保存；编号与其他货品冲突，请复核。' : '已保存'); toast(result.identifier_conflicts?.length ? '货品已保存；编号存在冲突，请复核。' : '货品已保存'); navigate(`/products/${result.product_id || id}`, { skipGuard: true }) } catch (err) { setError(err) } finally { busyRef.current = false; setBusy(false) } }
  return <section><Back to={id ? `/products/${id}` : '/products'} /><PageHeading eyebrow="主数据" title={id ? '编辑货品' : '新增货品'} description="设置采购成本价、销售售价与分类；重复编号会提示但不会覆盖其他货品。" /><form className="panel form-layout" onSubmit={save}><FormSection title="货品资料"><Field label="货品名"><input required value={form.display_name} onChange={e => set('display_name', e.target.value)} /></Field><Field label="来源/标签编号"><input value={form.primary_identifier} onChange={e => set('primary_identifier', e.target.value)} /></Field><Field label="厂家"><input value={form.manufacturer} onChange={e => set('manufacturer', e.target.value)} /></Field><Field label="规格/型号"><input value={form.specification} onChange={e => set('specification', e.target.value)} /></Field><Field label="商品分类"><select value={form.category_id} onChange={e => set('category_id', e.target.value)}><option value="">未分类</option>{categories.map(c => <option key={c.category_id} value={c.category_id}>{'　'.repeat(c.depth)}{c.name}</option>)}</select></Field><Field label="默认单位"><select required value={form.default_uom_id} onChange={e => set('default_uom_id', e.target.value)}><option value="">请选择</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field></FormSection><FormSection title="价格与追踪" description="不同单位分别核算，金额保留两位小数。"><Field label="采购成本价（¥）"><input type="number" min="0" step="0.01" value={form.purchase_cost_price} onChange={e => set('purchase_cost_price', e.target.value)} /></Field><Field label="销售售价（¥）"><input type="number" min="0" step="0.01" value={form.sales_price} onChange={e => set('sales_price', e.target.value)} /></Field><Field label="原始单位"><input value={form.source_uom_raw} onChange={e => set('source_uom_raw', e.target.value)} /></Field><label className="check-field span-2"><input type="checkbox" checked={form.serialized} onChange={e => set('serialized', e.target.checked)} /> 需序列号追踪（该货品单件可登记 SN；登记可选，过账不强制）</label></FormSection><ErrorBox error={error} /><div className="form-actions">{message && <span className="success-text">{message}</span>}<Button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/products/${id}` : '/products')}>取消</Button></div></form></section>
}

function ProductDetail({ id, user }) {
  const { navigate, location } = useRouter()
  const { data, error } = useFetchOne(() => api.product(id), [id])
  if (error) return <section><Back to="/products" /><ErrorBox error={error} /></section>
  if (!data) return <Loading />
  const canEditThis = can(user, 'ADMIN', 'WAREHOUSE')
  const tab = location?.hash === '#images' ? 'images' : 'details'
  return <section><Back to="/products" /><PageHeading eyebrow="基础资料 / 货品" title={data.display_name}>{user.role === 'ADMIN' && <Button variant="primary" onClick={() => navigate(`/products/${id}/edit`)}>编辑货品</Button>}</PageHeading>
    <ObjectHeader items={[data.primary_identifier?.value_raw || '未设置业务编号', data.manufacturer || '未填写厂家', data.specification || '未填写规格', data.uom_display_name || data.uom_code || '未设置默认单位']} />
    <Tabs items={[{ id: 'details', label: '货品资料' }, { id: 'images', label: '图片' }]} value={tab} syncHash />
    {tab === 'images' ? <div className="panel"><ProductGallery productId={id} canEdit={canEditThis} /></div> : <div className="detail-grid"><div className="panel"><h2>基本信息</h2><dl className="detail-list"><dt>业务编号</dt><dd>{data.primary_identifier?.value_raw || '—'}</dd><dt>规格 / 型号</dt><dd>{data.specification || '—'}</dd><dt>默认单位</dt><dd>{data.uom_display_name || data.uom_code || '—'}</dd><dt>序列号追踪</dt><dd>{data.serialized ? '开启' : '关闭'}</dd><dt>更新时间</dt><dd>{data.updated_at ? new Date(data.updated_at).toLocaleString() : '—'}</dd></dl>{data.identifier_conflicts?.length > 0 && <div className="alert warning">此编号还被 {data.identifier_conflicts.length} 个货品使用，请在冲突中心复核。</div>}</div><div className="panel"><h2>历史编号</h2>{data.identifiers?.length ? <div className="tag-list">{data.identifiers.map(item => <Badge key={item.product_identifier_id}>{item.value_raw}</Badge>)}</div> : <Empty>暂无历史编号。</Empty>}</div></div>}
  </section>
}

function ScanPicker({ onAdd }) {
  const [menu, setMenu] = useState(false); const [state, setState] = useState('idle'); const [error, setError] = useState(null); const [warning, setWarning] = useState(''); const [terms, setTerms] = useState([]); const [matches, setMatches] = useState([]); const cameraRef = useRef(null); const galleryRef = useRef(null); const abortRef = useRef(null); const searchToken = useRef(0)
  async function findMatches(searchTerms) {
    const token = ++searchToken.current
    const found = await findProductMatches(searchTerms, async value => (await api.products({ q: value, page: 1, page_size: 30, signal: abortRef.current?.signal })).items || [])
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
    {(['result', 'partial', 'reshoot', 'error'].includes(state)) && <div className="scan-result"><div className="scan-result-head"><ScanStateHeading state={state} /><button type="button" className="close-button" onClick={() => setState('idle')} aria-label="关闭扫描结果">×</button></div><ErrorBox error={error} />{warning && <div className="alert warning">{warning}</div>}{state === 'partial' && <Button type="button" className="secondary" onClick={() => findMatches(terms)}>确认并匹配</Button>}{terms.length > 0 && <div className="term-list">{terms.map(t => <button type="button" key={`${t.kind}-${t.normalized}`} onClick={async () => { const token = ++searchToken.current; const r = await api.products({ q: t.value, page: 1, page_size: 30, signal: abortRef.current?.signal }); if (token === searchToken.current) { setMatches(r.items || []); setState('result') } }}>{t.value}</button>)}</div>}{matches.length > 0 && <div className="match-list"><p className="muted">点击货品加入申请明细</p>{matches.map(p => <button type="button" key={p.product_id} onClick={() => { onAdd(p); setState('idle'); setMatches([]) }}><strong>{p.display_name}<FuzzyTag item={p} /></strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}{state === 'result' && matches.length === 0 && <p className="muted">没有匹配货品，请重拍或手工输入关键词。</p>}</div>}
  </div>
}

function RequestList({ user }) {
  const { navigate } = useRouter(); const [rows, setRows] = useState([]); const [error, setError] = useState(null)
  useEffect(() => { api.requests().then(setRows).catch(setError) }, [])
  const columns = useMemo(() => [
    { key: 'request_no', label: '单号', filterType: 'search' },
    { key: 'request_type', label: '类型', filterType: 'select', filterOptions: Object.entries(REQUEST_TYPE_LABELS).map(([value, label]) => ({ value, label })), render: r => requestTypeLabel(r.request_type) },
    { key: 'requester', label: '申请人', value: r => r.requester_display_name || r.requester_username || '—' },
    { key: 'status', label: '状态', filterType: 'select', filterOptions: Object.entries(REQUEST_STATUS_LABELS).map(([value, label]) => ({ value, label })), render: r => <StatusBadge domain="request" value={r.status} /> },
    { key: 'line_count', label: '明细数', value: r => r.line_count || 0 },
    { key: 'created_at', label: '时间', value: r => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
  ], [])
  return <section><PageHeading eyebrow="OA 流程" title={can(user, 'WAREHOUSE', 'ADMIN') ? '审批队列' : '我的申请'} description="每一条申请都可以进入详情；草稿支持继续编辑。"><Button className="primary" onClick={() => navigate('/requests/new')}>＋ 新建申请</Button></PageHeading><div className="panel"><ErrorBox error={error} /><DataTable tableId="requests" defaultFilters={can(user, "WAREHOUSE", "ADMIN") ? { status: "SUBMITTED" } : {}} queryKeys={["mine"]} filterRows={(items, query) => query.mine === "true" ? items.filter(row => row.requester_user_id === user.user_id) : items}
    mode="client"
    columns={columns}
    rows={rows}
    rowKey={r => String(r.stock_request_id)}
    rowHref={r => `/requests/${r.stock_request_id}`}
    exportConfig={{ endpoint: '/api/stock-requests/export', filename: '库存申请', allScope: 'ids' }}
  /></div></section>
}

function RequestForm({ id, initial, prefillProductId }) {
  const toast = useToast(); const busyRef = useRef(false)
  // 行身份不依赖货品或序号，删除其他行不会转移 OCR 请求与待确认候选。
  const nextLineId = useRef(0)
  const { navigate } = useRouter(); const [form, setForm] = useState({ request_type: 'ISSUE_OTHER', source_location_id: '', destination_location_id: '', reason: '', lines: [] }); const baseline = useRef(JSON.stringify(form)); const [products, setProducts] = useState([]); const [locations, setLocations] = useState([]); const [q, setQ] = useState(''); const [error, setError] = useState(null); const [busy, setBusy] = useState(false); const [uoms, setUoms] = useState([])
  const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form])
  useDirtyLeaveGuard(dirty)
  useEffect(() => { api.locations().then(setLocations).catch(setError); api.uoms().then(setUoms).catch(setError); if (initial) { const next = { request_type: initial.request_type, source_location_id: initial.source_location_id || '', destination_location_id: initial.destination_location_id || '', reason: initial.reason || '', lines: initial.lines.map(x => ({ clientLineId: ++nextLineId.current, product_id: x.product_id, product_name: x.product_name, serialized: !!x.serialized, serial_numbers: x.serial_numbers?.join('\n') || '', condition_id: x.condition_id ?? null, quantity: x.quantity, uom_id: x.uom_id, uom_code: x.uom_code, source_uom_raw: x.source_uom_raw || '个', notes: x.notes || '', source_location_id: x.source_location_id || '', destination_location_id: x.destination_location_id || '' })) }; baseline.current = JSON.stringify(next); setForm(next) } else if (prefillProductId) api.product(prefillProductId).then(addProduct).catch(setError) }, [initial, prefillProductId])
  useEffect(() => { if (!q) { setProducts([]); return }; const controller = new AbortController(); const t = setTimeout(() => api.products({ q, page: 1, page_size: 30, signal: controller.signal }).then(x => { if (!controller.signal.aborted) setProducts(x.items || []) }).catch(err => { if (err.name !== 'AbortError') setError(err) }), 180); return () => { clearTimeout(t); controller.abort() } }, [q])
  function addProduct(p) { const line = { clientLineId: ++nextLineId.current, product_id: p.product_id, product_name: p.display_name, serialized: !!p.serialized, serial_numbers: '', condition_id: null, quantity: 1, uom_id: p.uom_id || '', uom_code: p.uom_code || '', source_uom_raw: p.source_uom_raw || '个', notes: '', source_location_id: '', destination_location_id: '' }; setForm(x => ({ ...x, lines: [...x.lines, line] })); setQ(''); setProducts([]) }
  function updateLine(index, key, value) { setForm(x => ({ ...x, lines: x.lines.map((line, i) => i === index ? { ...line, [key]: value } : line) })) }
  async function save(e) { e.preventDefault(); if (busyRef.current) return; busyRef.current = true; setError(null); setBusy(true); try { const payload = { request_type: form.request_type, source_location_id: form.source_location_id || null, destination_location_id: form.destination_location_id || null, reason: form.reason || null, lines: form.lines.map(x => ({ product_id: Number(x.product_id), quantity: Number(x.quantity), uom_id: x.uom_id ? Number(x.uom_id) : null, uom_code: x.uom_code || null, source_uom_raw: x.source_uom_raw || '个', source_location_id: x.source_location_id ? Number(x.source_location_id) : null, destination_location_id: x.destination_location_id ? Number(x.destination_location_id) : null, notes: x.notes || null, condition_id: x.condition_id ?? null, serial_numbers: x.serial_numbers?.trim() ? x.serial_numbers.split('\n').map(s => s.trim()).filter(Boolean) : null })) }; const result = id ? await api.updateRequest(id, { ...payload, version: initial.version }) : await api.createRequest(payload); baseline.current = JSON.stringify(form); toast('申请草稿已保存'); navigate(`/requests/${result.stock_request_id}`, { skipGuard: true }) } catch (err) { setError(err) } finally { busyRef.current = false; setBusy(false) } }
  const typeLabels = REQUEST_TYPE_LABELS
  return <section><Back to={id ? `/requests/${id}` : '/requests'} /><PageHeading eyebrow="OA 流程" title={id ? '编辑申请' : '新建申请'} description="先保存草稿，再提交给仓管处理。" /><form className="panel form-layout" onSubmit={save}><FormSection title="申请信息"><Field label="申请类型"><select disabled={Boolean(id)} value={form.request_type} onChange={e => setForm({ ...form, request_type: e.target.value })}>{Object.entries(typeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="原因/备注"><input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></Field><Field label="默认来源库位"><select value={form.source_location_id} onChange={e => setForm({ ...form, source_location_id: e.target.value })}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || '无编码'}</option>)}</select></Field><Field label="默认目的库位"><select value={form.destination_location_id} onChange={e => setForm({ ...form, destination_location_id: e.target.value })}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || '无编码'}</option>)}</select></Field></FormSection><FormSection title="申请明细" description="核对货品、数量、单位和库位。"><div className="span-2 picker-field"><span className="field-label">添加货品</span><div className="picker-row"><input value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" /><ScanPicker onAdd={addProduct} /></div>{products.length > 0 && <div className="picker-results">{products.map(p => <button type="button" key={p.product_id} onClick={() => addProduct(p)}><strong>{p.display_name}<FuzzyTag item={p} /></strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}</div><div className="span-2 line-editor"><div className="line-editor-head"><h2>申请明细 ({form.lines.length})</h2><span className="muted">可重复添加同一货品</span></div>{form.lines.length ? form.lines.map((line, i) => <article className="line-card" key={line.clientLineId}><div className="line-title"><div><strong>{line.product_name || '未命名货品'}</strong><small>{line.uom_code || line.source_uom_raw || '—'}</small></div><button type="button" className="danger-link" onClick={() => setForm(x => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))}>删除</button></div><div className="line-fields"><Field label="数量"><input type="number" min="0.001" step="0.001" value={line.quantity} onChange={e => updateLine(i, 'quantity', e.target.value)} /></Field><Field label="单位"><select value={line.uom_id || ''} onChange={e => { const value = e.target.value; const u = uoms.find(x => String(x.uom_id) === value); updateLine(i, 'uom_id', value); updateLine(i, 'uom_code', u?.code || line.uom_code) }}><option value="">跟随货品</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field><Field label="单行来源库位"><select value={line.source_location_id || ''} onChange={e => updateLine(i, 'source_location_id', e.target.value)}><option value="">跟随默认</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name}</option>)}</select></Field><Field label="单行目的库位"><select value={line.destination_location_id || ''} onChange={e => updateLine(i, 'destination_location_id', e.target.value)}><option value="">跟随默认</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name}</option>)}</select></Field></div>{line.serialized && <SerialEntry productId={line.product_id} value={line.serial_numbers || ''} quantity={line.quantity} onChange={value => updateLine(i, 'serial_numbers', value)} label="序列号登记（可选）" />}<Field label="明细备注"><input value={line.notes} onChange={e => updateLine(i, 'notes', e.target.value)} /></Field></article>) : <Empty>还没有添加货品</Empty>}</div></FormSection><ErrorBox error={error} /><div className="form-actions"><Button className="primary" disabled={busy}>{busy ? '保存中…' : '保存草稿'}</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/requests/${id}` : '/requests')}>取消</Button></div></form></section>
}

function RequestDetail({ id, user }) {
  const { navigate, location } = useRouter()
  const { data, error, reload } = useFetchOne(() => api.stockRequest(id), [id])
  const [actionError, setActionError] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [busy, runBusy] = useBusy()
  const toast = useToast()
  if (!data) return error ? <section><Back to="/requests" /><ErrorBox error={error} /></section> : <Loading />
  const isWarehouse = can(user, 'WAREHOUSE', 'ADMIN')
  const isOwner = data.requester_user_id === user.user_id
  const canEditThis = data.status === 'DRAFT' && (isWarehouse || isOwner) || data.status === 'SUBMITTED' && isWarehouse
  const tab = location?.hash === '#history' ? 'history' : 'lines'
  async function action(name, payload) {
    return runBusy(async () => {
      setActionError(null)
      try { await api.action(id, name, payload); setConfirm(null); await reload(); toast('操作已完成') }
      catch (err) { setActionError(err) }
    })
  }
  return <section><Back to="/requests" /><PageHeading eyebrow="申请 / 详情" title={data.request_no} description={requestTypeLabel(data.request_type)}><div className="actions"><StatusBadge domain="request" value={data.status} />
    {data.status === 'DRAFT' && isOwner && <Button variant="primary" disabled={busy} onClick={() => action('submit')}>提交审批</Button>}
    {data.status === 'SUBMITTED' && <Button variant="primary" disabled={busy || !isWarehouse} title={!isWarehouse ? '等待仓管审批' : undefined} onClick={() => action('approve')}>审批</Button>}
    {data.status === 'APPROVED' && <Button variant={confirm ? 'secondary' : 'primary'} disabled={busy || !isWarehouse} title={!isWarehouse ? '仅仓管或管理员可放行' : undefined} onClick={() => setConfirm('release')}>放行</Button>}
    {canEditThis && <Button variant="secondary" onClick={() => navigate(`/requests/${id}/edit`)}>编辑</Button>}
    {data.status === 'SUBMITTED' && isOwner && <Button variant="secondary" disabled={busy} onClick={() => action('withdraw')}>撤回</Button>}
    {data.status === 'SUBMITTED' && isWarehouse && <Button variant="danger-quiet" disabled={busy} onClick={() => setConfirm('reject')}>驳回</Button>}
  </div></PageHeading><ErrorBox error={actionError || error} />
  {confirm === 'reject' && <ActionConfirm title="驳回申请" description="驳回后本次申请终止，申请人可根据原因重新发起申请。" reasonRequired confirmLabel="确认驳回" variant="danger" busy={busy} onConfirm={reason => action('reject', { reason })} onCancel={() => setConfirm(null)} />}
  {confirm === 'release' && <ActionConfirm title="放行申请" description="放行将生成库存流水并更新余额，请核对明细与库位。" confirmLabel="确认放行" busy={busy} onConfirm={() => action('release')} onCancel={() => setConfirm(null)} />}
  <ObjectHeader items={[`申请人：${data.requester_display_name || data.requester_username || '—'}`, `来源：${data.source_location_name || '按明细指定'}`, `目的：${data.destination_location_name || '按明细指定'}`]}><p>{data.reason || '未填写申请说明'}</p></ObjectHeader>
  <Tabs items={[{ id: 'lines', label: '申请明细' }, { id: 'history', label: '操作历史' }]} value={tab} syncHash />
  {tab === 'history' ? <div className="panel"><Timeline events={data.actions || []} domain="request" /></div> : <div className="panel"><h2>明细</h2>{data.lines?.length ? <div className="detail-lines">{data.lines.map(line => <div className="detail-line" key={line.stock_request_line_id}><div><strong>{line.product_name || '未命名货品'}</strong><span>{line.specification || '—'} · {line.uom_display_name || line.uom_code || '—'}</span><small>{line.source_location_name || data.source_location_name || '按默认来源'} → {line.destination_location_name || data.destination_location_name || '按默认目的'}</small>{line.serial_numbers?.length > 0 && <small>SN：{line.serial_numbers.join('、')}</small>}</div><b className="num">{formatQuantity(line.quantity)}</b></div>)}</div> : <Empty>暂无明细，请编辑草稿添加货品。</Empty>}</div>}</section>
}

function AdminPage({ locationsOnly = false, user }) {
  const [users, setUsers] = useState([]); const [locations, setLocations] = useState([]); const [error, setError] = useState(null); const { navigate } = useRouter(); const reload = () => (locationsOnly ? api.locations().then(setLocations) : api.users().then(setUsers)).catch(setError); useEffect(() => { reload() }, [locationsOnly])
  const userColumns = useMemo(() => [
    { key: 'display_name', label: '显示名', filterType: 'search', searchKeys: ['display_name', 'username'] },
    { key: 'username', label: '用户名' },
    { key: 'role', label: '角色', filterType: 'select', filterOptions: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })), render: row => ROLE_LABELS[row.role] || '未分配角色' },
    { key: 'is_active', label: '状态', filterType: 'select', filterOptions: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }], value: r => r.is_active, render: r => <StatusBadge domain="active" value={r.is_active} /> },
    { key: 'created_at', label: '创建时间', value: r => r.created_at ? new Date(r.created_at).toLocaleDateString() : '—' },
  ], [])
  const locationColumns = useMemo(() => [
    { key: 'name', label: '名称', filterType: 'search', searchKeys: ['name', 'code'] },
    { key: 'code', label: '编码', value: r => r.code || '无编码' },
    { key: 'location_type', label: '类型', render: row => locationTypeLabel(row.location_type), filterType: 'select', filterOptions: [{ value: 'warehouse', label: '仓库' }, { value: 'hospital', label: '医院' }, { value: 'department', label: '科室' }, { value: 'customer', label: '客户' }, { value: 'external', label: '外部' }, { value: 'transit', label: '在途' }, { value: 'other', label: '其他' }] },
    { key: 'is_company_inventory', label: '公司库存', filterType: 'select', filterOptions: [{ value: 'true', label: '是' }, { value: 'false', label: '否' }], value: r => r.is_company_inventory, render: r => r.is_company_inventory ? '是' : '否' },
    { key: 'is_active', label: '状态', filterType: 'select', filterOptions: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }], value: r => r.is_active, render: r => <StatusBadge domain="active" value={r.is_active} /> },
  ], [])
  return <section><PageHeading eyebrow={locationsOnly ? '基础资料' : '管理'} title={locationsOnly ? '库位' : '用户'} description="业务字段修改会留下审计。">{canView(user, 'system') && <Button className="primary" onClick={() => navigate(locationsOnly ? '/admin/locations/new' : '/admin/users/new')}>＋ {locationsOnly ? '新增库位' : '新增用户'}</Button>}</PageHeading><ErrorBox error={error} /><div className="panel">{locationsOnly ? <DataTable tableId="master.locations" mode="client" columns={locationColumns} rows={locations} rowKey={l => String(l.location_id)} rowHref={canView(user, 'system') ? l => `/admin/locations/${l.location_id}` : undefined} exportConfig={{ endpoint: '/api/locations/export', allScope: 'ids' }} /> : <DataTable tableId="admin.users" mode="client" columns={userColumns} rows={users} rowKey={u => String(u.user_id)} rowHref={u => `/admin/users/${u.user_id}`} exportConfig={{ endpoint: '/api/admin/users/export', allScope: 'ids' }} />}</div></section>
}

function UserForm({ id }) {
  const toast = useToast(); const busyRef = useRef(false)
  const { navigate } = useRouter(); const [form, setForm] = useState({ display_name: '', role: 'COLLEAGUE', is_active: true, password: '' }); const baseline = useRef(JSON.stringify(form)); const [error, setError] = useState(null); const [busy, setBusy] = useState(false)
  const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form])
  useDirtyLeaveGuard(dirty)
  useEffect(() => { if (id) api.user(id).then(x => { const next = { display_name: x.display_name, role: x.role, is_active: x.is_active, password: '' }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id]); async function save(e) { e.preventDefault(); if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(null); try { const payload = { display_name: form.display_name, role: form.role, is_active: form.is_active }; if (form.password) payload.password = form.password; const result = id ? await api.updateUser(id, payload) : await api.createUser({ username: form.username, ...payload, password: form.password }); baseline.current = JSON.stringify(form); toast('账号已保存'); navigate(`/admin/users/${result.user_id || id}`, { skipGuard: true }) } catch (err) { setError(err) } finally { busyRef.current = false; setBusy(false) } }
  return <section><Back to="/admin" /><PageHeading eyebrow="系统管理" title={id ? '编辑用户' : '新增用户'} /><form className="panel form-layout" onSubmit={save}><FormSection title="账号信息">{!id && <Field label="用户名"><input required value={form.username || ''} onChange={e => setForm({ ...form, username: e.target.value })} /></Field>}<Field label="显示名"><input required value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} /></Field><Field label="角色"><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label={id ? '新密码（可选）' : '初始密码'}><input type="password" minLength="8" required={!id} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>{id && <label className="check-field"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} /> 启用账号</label>}</FormSection><ErrorBox error={error} /><div className="form-actions"><Button className="primary" disabled={busy}>保存</Button><Button type="button" className="secondary" onClick={() => navigate(id ? `/admin/users/${id}` : '/admin')}>取消</Button></div></form></section>
}

function UserDetail({ id }) { const { navigate } = useRouter(); const { data, error } = useFetchOne(() => api.user(id), [id]); if (!data) return error ? <section><Back to="/admin" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/admin" /><PageHeading eyebrow="用户详情" title={data.display_name}><Button className="primary" onClick={() => navigate(`/admin/users/${id}/edit`)}>编辑</Button></PageHeading><div className="panel"><dl className="detail-list"><dt>用户名</dt><dd>{data.username}</dd><dt>角色</dt><dd>{ROLE_LABELS[data.role] || data.role}</dd><dt>状态</dt><dd><StatusBadge domain="active" value={data.is_active} /></dd><dt>创建时间</dt><dd>{new Date(data.created_at).toLocaleString()}</dd></dl></div></section> }

function LocationForm({ id }) { const toast = useToast(); const { navigate } = useRouter(); const [form, setForm] = useState({ code: '', name: '', location_type: 'warehouse', is_company_inventory: true, is_active: true }); const baseline = useRef(JSON.stringify(form)); const [error, setError] = useState(null); const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form]); useDirtyLeaveGuard(dirty); useEffect(() => { if (id) api.location(id).then(x => { const next = { code: x.code || '', name: x.name, location_type: x.location_type, is_company_inventory: x.is_company_inventory, is_active: x.is_active }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id]); const [busy, runSave] = useBusy(); function save(e) { e.preventDefault(); runSave(async () => { setError(null); try { const result = id ? await api.updateLocation(id, { name: form.name, location_type: form.location_type, is_company_inventory: form.is_company_inventory, is_active: form.is_active }) : await api.createLocation(form); baseline.current = JSON.stringify(form); toast('库位已保存'); navigate(`/admin/locations/${result.location_id || id}`, { skipGuard: true }) } catch (err) { setError(err) } }) }
  return <section><Back to="/master/locations" /><PageHeading eyebrow="基础资料 / 库位" title={id ? '编辑库位' : '新增库位'} /><form className="panel form-layout" onSubmit={save}><FormSection title="库位资料"><Field label="编码"><input required disabled={Boolean(id)} value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} /></Field><Field label="名称"><input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="类型"><select value={form.location_type} onChange={e => setForm({ ...form, location_type: e.target.value })}><option value="warehouse">仓库</option><option value="hospital">医院</option><option value="department">科室</option><option value="customer">客户</option><option value="external">外部</option><option value="transit">在途</option><option value="other">其他</option></select></Field><label className="check-field"><input type="checkbox" checked={form.is_company_inventory} onChange={e => setForm({ ...form, is_company_inventory: e.target.checked })} /> 公司库存</label>{id && <label className="check-field"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} /> 启用</label>}</FormSection><ErrorBox error={error} /><div className="form-actions"><Button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</Button><Button type="button" className="secondary" disabled={busy} onClick={() => navigate(id ? `/admin/locations/${id}` : '/master/locations')}>取消</Button></div></form></section> }

function LocationDetail({ id }) { const { navigate } = useRouter(); const { data, error } = useFetchOne(() => api.location(id), [id]); if (!data) return error ? <section><Back to="/master/locations" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/master/locations" /><PageHeading eyebrow="基础资料 / 库位" title={data.name}><Button className="primary" onClick={() => navigate(`/admin/locations/${id}/edit`)}>编辑</Button></PageHeading><div className="panel"><dl className="detail-list"><dt>编码</dt><dd>{data.code || '—'}</dd><dt>类型</dt><dd>{locationTypeLabel(data.location_type)}</dd><dt>公司库存</dt><dd>{data.is_company_inventory ? '是' : '否'}</dd><dt>状态</dt><dd><StatusBadge domain="active" value={data.is_active} /></dd></dl></div></section> }

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
  { key: 'case_type', label: '类型', filterType: 'select', filterOptions: Object.entries(CONFLICT_TYPE_LABELS).map(([value, label]) => ({ value, label })), render: r => CONFLICT_TYPE_LABELS[r.case_type] || '其他待复核问题' },
  { key: 'summary', label: '摘要', filterType: 'text', value: r => [r.source_identifier || r.source_name, r.movement_type_code ? `历史流水 · ${movementLabel(r.movement_type_code)}` : '', r.resolution_notes].filter(Boolean).join(' · ') || '需要人工确认' },
  { key: 'status_code', label: '状态', filterType: 'select', filterOptions: [{ value: 'pending_review', label: '待处理' }, { value: 'resolved', label: '已处理' }], render: r => <StatusBadge domain="conflict" value={r.status_code} /> },
], []); return <section><PageHeading eyebrow="数据治理" title="冲突中心" description="需要人工确认的编号、名称、流水和主数据问题。" /><div className="panel"><ErrorBox error={error} /><DataTable tableId="admin.conflicts" mode="client" columns={columns} rows={rows} rowKey={c => String(c.resolution_case_id)} rowHref={c => `/conflicts/${c.resolution_case_id}`} exportConfig={{ endpoint: '/api/conflicts/export', filename: '冲突', allScope: 'ids' }} /></div></section> }

function ConflictDetail({ id }) {
  const { navigate } = useRouter()
  const { data, error: loadError } = useFetchOne(() => api.conflict(id), [id]); const [note, setNote] = useState(''); const [outcome, setOutcome] = useState('resolved')
  const [uoms, setUoms] = useState([]); const [error, setError] = useState(null); const [busy, setBusy] = useState(false)
  const [action, setAction] = useState(null); const [q, setQ] = useState(''); const [results, setResults] = useState([]); const [form, setForm] = useState({})
  useEffect(() => { api.uoms().then(setUoms).catch(setError) }, [])
  useEffect(() => { if (!q) { setResults([]); return }; const controller = new AbortController(); const t = setTimeout(() => api.products({ q, page: 1, page_size: 30, signal: controller.signal }).then(x => { if (!controller.signal.aborted) setResults(x.items || []) }).catch(err => { if (err.name !== 'AbortError') setError(err) }), 180); return () => { clearTimeout(t); controller.abort() } }, [q])
  if (!data) return (error || loadError) ? <section><Back to="/conflicts" /><ErrorBox error={error || loadError} /></section> : <Loading />
  const observation = data.product_observation || {}
  const product = data.product || null
  const candidate = data.movement_candidate || null
  const source = data.source_record || null
  function patch(k, v) { setForm(x => ({ ...x, [k]: v })) }
  function openCreate() { setForm({ display_name: observation.source_name_raw || '', manufacturer: observation.manufacturer_raw || '', specification: observation.specification_raw || '', primary_identifier: observation.source_identifier_raw || '', default_uom_id: uoms[0]?.uom_id || '' }); setAction('create') }
  function openEdit() { setForm({ display_name: product?.display_name || '', manufacturer: product?.manufacturer || '', specification: product?.specification || '', primary_identifier: product?.primary_identifier_value || '', default_uom_id: product?.default_uom_id || '' }); setAction('edit') }
  async function run(call) { setBusy(true); setError(null); try { const r = await call(); if (r?.identifier_conflicts?.length) setError(new Error(`已保存；编号与其他货品冲突：${r.identifier_conflicts.map(x => x.display_name).join('、')}`)); else navigate('/conflicts') } catch (err) { setError(err) } finally { setBusy(false) } }
  const basePayload = { resolution_notes: note.trim() }
  const title = CONFLICT_TYPE_LABELS[data.case_type] || '待复核问题'
  const subtitle = [observation.source_name_raw, observation.source_identifier_raw].filter(Boolean).join(' · ') || (source?.display_values?.['品名']) || '需要人工确认'
  const uomSelect = <Field label="默认单位"><select value={form.default_uom_id || ''} onChange={e => patch('default_uom_id', e.target.value)}><option value="">请选择</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field>
  return <section><Back to="/conflicts" /><PageHeading eyebrow="冲突详情" title={title} description={subtitle}><StatusBadge domain="conflict" value={data.status_code} /></PageHeading><div className="detail-grid"><div className="panel"><h2>来源观测</h2><dl className="detail-list"><dt>编号</dt><dd>{observation.source_identifier_raw || '—'}</dd><dt>名称</dt><dd>{observation.source_name_raw || '—'}</dd><dt>厂家</dt><dd>{observation.manufacturer_raw || '—'}</dd><dt>规格</dt><dd>{observation.specification_raw || '—'}</dd><dt>单位</dt><dd>{observation.uom_raw || '—'}</dd><dt>期初</dt><dd>{observation.opening_quantity != null ? formatQuantity(observation.opening_quantity) : '—'}</dd><dt>现有</dt><dd>{observation.existing_quantity != null ? formatQuantity(observation.existing_quantity) : '—'}</dd></dl></div>{candidate && <div className="panel"><h2>历史流水候选</h2><dl className="detail-list"><dt>类型</dt><dd>{movementLabel(candidate.movement_type_code)}</dd><dt>数量</dt><dd>{candidate.quantity_raw || '—'}</dd><dt>日期</dt><dd>{candidate.movement_date_raw || '—'}</dd><dt>来源</dt><dd>{candidate.source_location_raw || '—'}</dd><dt>目的</dt><dd>{candidate.destination_location_raw || '—'}</dd></dl></div>}<div className="panel"><h2>关联货品</h2>{product ? <dl className="detail-list"><dt>货品</dt><dd><Link className="text-link" to={`/products/${product.product_id}`}>{product.display_name} →</Link></dd><dt>编号</dt><dd>{product.primary_identifier_value || '—'}</dd><dt>厂家</dt><dd>{product.manufacturer || '—'}</dd><dt>规格</dt><dd>{product.specification || '—'}</dd><dt>单位</dt><dd>{product.uom_display_name || product.uom_code || '—'}</dd></dl> : <Empty>尚未关联货品</Empty>}</div><div className="panel"><h2>来源原始数据</h2>{source ? <dl className="detail-list">{Object.entries(source.display_values || {}).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value == null ? "—" : String(value)}</dd></React.Fragment>)}</dl> : <Empty>无来源记录</Empty>}</div></div><div className="panel actions-panel"><h2>处理</h2><ErrorBox error={error} />{data.status_code !== 'pending_review' ? <div className="alert">已处理：{data.resolution_notes || '—'}</div> : <><div className="actions"><Button className="secondary" onClick={() => setAction(action === 'link' ? null : 'link')} disabled={busy}>关联现有货品</Button><Button className="secondary" onClick={() => action === 'create' ? setAction(null) : openCreate()} disabled={busy}>按观测新建货品</Button>{product && <Button className="secondary" onClick={() => action === 'edit' ? setAction(null) : openEdit()} disabled={busy}>编辑货品主数据</Button>}</div>{action === 'link' && <div className="picker-field" style={{ marginTop: 10 }}><span className="field-label">搜索并选择货品</span><div className="picker-row"><input value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" /></div>{results.length > 0 && <div className="picker-results">{results.map(p => <button type="button" key={p.product_id} onClick={() => run(() => api.linkConflict(id, { product_id: p.product_id, ...basePayload }))}><strong>{p.display_name}<FuzzyTag item={p} /></strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}</div>}{action === 'create' && <div className="form-grid" style={{ marginTop: 10 }}><Field label="货品名"><input value={form.display_name || ''} onChange={e => patch('display_name', e.target.value)} /></Field><Field label="来源/标签编号"><input value={form.primary_identifier || ''} onChange={e => patch('primary_identifier', e.target.value)} /></Field><Field label="厂家"><input value={form.manufacturer || ''} onChange={e => patch('manufacturer', e.target.value)} /></Field><Field label="规格/型号"><input value={form.specification || ''} onChange={e => patch('specification', e.target.value)} /></Field>{uomSelect}<div className="span-2 actions"><Button className="primary" onClick={() => run(() => api.createConflictProduct(id, { ...form, default_uom_id: form.default_uom_id ? Number(form.default_uom_id) : null, ...basePayload }))} disabled={busy}>新建并处理</Button><Button className="secondary" onClick={() => setAction(null)}>取消</Button></div></div>}{action === 'edit' && <div className="form-grid" style={{ marginTop: 10 }}><Field label="货品名"><input value={form.display_name || ''} onChange={e => patch('display_name', e.target.value)} /></Field><Field label="来源/标签编号"><input value={form.primary_identifier || ''} onChange={e => patch('primary_identifier', e.target.value)} /></Field><Field label="厂家"><input value={form.manufacturer || ''} onChange={e => patch('manufacturer', e.target.value)} /></Field><Field label="规格/型号"><input value={form.specification || ''} onChange={e => patch('specification', e.target.value)} /></Field>{uomSelect}<div className="span-2 actions"><Button className="primary" onClick={() => run(() => api.editConflictProduct(id, { ...form, default_uom_id: form.default_uom_id ? Number(form.default_uom_id) : null, ...basePayload }))} disabled={busy}>保存并处理</Button><Button className="secondary" onClick={() => setAction(null)}>取消</Button></div></div>}<div className="reject-panel" style={{ marginTop: 10 }}><Field label="处理备注"><textarea rows="3" value={note} onChange={e => setNote(e.target.value)} placeholder="填写处理说明后提交" /></Field><div className="actions"><Field label="处理结果"><select value={outcome} onChange={e => setOutcome(e.target.value)}><option value="resolved">已处理</option><option value="duplicate">重复</option><option value="ignored">忽略</option></select></Field><Button variant={action === 'create' || action === 'edit' ? 'secondary' : 'primary'} onClick={() => run(() => api.resolveConflict(id, { resolution_notes: note.trim(), outcome }))} disabled={busy || !note.trim()}>标记已处理</Button></div></div></>}</div></section>
}

const AUDIT_TARGET_LABELS = { business_document: '业务单据', business_document_line: '单据明细', document_attachment: '单据附件', app_user: '账号', stock_request: '库存申请', stock_request_line: '申请明细', inventory_movement: '库存流水', ar_ap_entry: '往来流水', product: '货品', customer: '客户', supplier: '供应商', location: '库位', product_identifier: '货品编号', product_image: '货品图片', resolution_case: '待处理冲突', uom: '单位', product_category: '货品分类', asset: '序列资产' }
function Audit() {
  const [error, setError] = useState(null)
  const fetchAudit = useCallback((params, signal) => api.audit({ ...params, paginated: true, signal }), [])
  const columns = useMemo(() => [
    { key: 'action', label: '动作', filterType: 'select', filterOptions: Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })), render: row => actionLabel(row.action) },
    { key: 'target_table', label: '业务对象', filterType: 'select', filterOptions: Object.entries(AUDIT_TARGET_LABELS).map(([value, label]) => ({ value, label })), render: row => AUDIT_TARGET_LABELS[row.target_table] || '业务记录' },
    { key: 'actor_name', label: '操作人', filterType: 'search', value: row => row.actor_name || '系统' },
    { key: 'created_at', label: '时间', render: row => <time title={new Date(row.created_at).toLocaleString()}>{row.created_at?.slice(0, 10)}</time> },
  ], [])
  return <section><PageHeading eyebrow="管理" title="操作审计" description="供管理员与财务追溯业务操作。" /><ErrorBox error={error} /><div className="panel"><DataTable tableId="admin.audit" mode="server" columns={columns} fetchData={fetchAudit} rowKey={row => String(row.audit_event_id)} rowHref={row => `/audit/${row.audit_event_id}`} onError={setError} exportConfig={{ endpoint: '/api/audit/export', allScope: 'server', buildParams: ({ q, filters, sortKey, sortDir }) => ({ q, f: toServerFilters(filters, columns), sort: sortKey, order: sortDir }) }} /></div></section>
}
function AuditDetail({ id }) {
  const { data, error } = useFetchOne(() => api.auditEvent(id), [id])
  if (!data) return error ? <section><Back to="/audit" /><ErrorBox error={error} /></section> : <Loading />
  const diff = data.field_diff || Object.fromEntries(Object.keys(data.after_data || {}).filter(key => JSON.stringify(data.before_data?.[key]) !== JSON.stringify(data.after_data[key])).map(key => [key, { before: data.before_data?.[key], after: data.after_data[key] }]))
  return <section><Back to="/audit" /><PageHeading eyebrow="管理 / 操作审计" title={actionLabel(data.action)} /><ObjectHeader items={[AUDIT_TARGET_LABELS[data.target_table] || '业务记录', data.actor_name || '系统', new Date(data.created_at).toLocaleString()]} /><div className="panel"><h2>变更内容</h2><FieldDiff diff={diff} /><details><summary>原始审计数据</summary><pre className="json-view">{JSON.stringify({ before: data.before_data, after: data.after_data, diff: data.field_diff }, null, 2)}</pre></details></div></section>
}

function UnitsPage({ user }) {
  const { data, error, reload } = useFetchOne(() => api.uoms(), [])
  const [form, setForm] = useState({ code: '', display_name: '', decimal_scale: 0 })
  const [editing, setEditing] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [busy, runSave] = useBusy()
  const toast = useToast()
  useDirtyLeaveGuard(editing && Boolean(form.code || form.display_name))
  const columns = useMemo(() => [{ key: 'display_name', label: '单位名称', filterType: 'search', searchKeys: ['display_name', 'code'] }, { key: 'code', label: '业务编码' }, { key: 'decimal_scale', label: '小数位', align: 'end' }], [])
  async function save(event) { event.preventDefault(); await runSave(async () => { try { setSaveError(null); await api.createUom(form); setEditing(false); setForm({ code: '', display_name: '', decimal_scale: 0 }); await reload(); toast('单位已保存') } catch (err) { setSaveError(err) } }) }
  return <section><PageHeading eyebrow="基础资料" title="单位">{canEdit(user, 'uom') && !editing && <Button variant="primary" onClick={() => setEditing(true)}>＋ 新增单位</Button>}</PageHeading><ErrorBox error={error || saveError} />{editing && <form className="panel" onSubmit={save}><FormSection title="单位信息" description="单位独立核算，不做隐式换算。"><Field label="业务编码"><input required value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} /></Field><Field label="名称"><input required value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} /></Field><Field label="小数位"><input type="number" min="0" max="6" value={form.decimal_scale} onChange={e => setForm({ ...form, decimal_scale: Number(e.target.value) })} /></Field></FormSection><div className="form-actions"><Button variant="primary" disabled={busy}>保存</Button><Button type="button" variant="ghost" onClick={() => { if (confirmDirtyLeave()) setEditing(false) }}>取消</Button></div></form>}<div className="panel"><DataTable tableId="master.uoms" columns={columns} rows={data || []} loading={!data && !error} rowKey={row => String(row.uom_id)} /></div></section>
}

function InventoryDetail({ ids }) { const { navigate } = useRouter(); const { data, error } = useFetchOne(() => api.inventoryDetail(ids), [ids.product_id, ids.location_id, ids.condition_id, ids.uom_id]); const { data: product } = useFetchOne(() => api.product(ids.product_id), [ids.product_id]); if (!data) return error ? <section><Back to="/inventory" /><ErrorBox error={error} /></section> : <Loading />; return <section><Back to="/inventory" /><PageHeading eyebrow="库存余额详情" title={data.product_name}><Button className="primary" onClick={() => navigate(`/requests/new?product_id=${ids.product_id}`)}>以此货品新建申请</Button></PageHeading><div className="stats"><div className="stat teal"><span>当前数量</span><strong>{formatQuantity(data.on_hand_quantity)} {data.uom_code}</strong></div><div className="stat"><span>库位</span><strong>{data.location_name}</strong></div><div className="stat"><span>成色</span><strong>{conditionLabel(data.condition_code)}</strong></div></div><div className="panel"><h2>相关流水</h2>{data.movements?.length ? <div className="record-list">{data.movements.map(m => <div className="record-card" key={m.inventory_movement_id}><div><strong>{movementLabel(m.movement_type)}</strong><span>{m.source_location_name || '—'} → {m.destination_location_name || '—'}</span></div><div className="record-value"><b>{formatQuantity(m.quantity)}</b><small>{m.movement_date}</small></div></div>)}</div> : <Empty>暂无流水</Empty>}</div>{product && <Link className="text-link" to={`/products/${product.product_id}`}>查看货品主数据 →</Link>}</section> }

function decimalPlaces(value) {
  const match = /\.(\d+)$/.exec(String(value).trim())
  return match ? match[1].length : 0
}

function CountPage({ user }) {
  const toast = useToast()
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
      setFloatConfirm(false); setResult(resp); toast('清点已完成')
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return <section><PageHeading eyebrow="库存作业" title="清点库存" description="按实盘数量直接覆写某货品在指定库位的现库存，数量可为负数或小数。" /><div className="panel"><ErrorBox error={error} />{!product ? <div className="picker-field"><span className="field-label">选择货品</span><div className="picker-row"><input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" /><ScanPicker onAdd={selectProduct} /></div>{results.length > 0 && <div className="picker-results">{results.map(p => <button type="button" key={p.product_id} onClick={() => selectProduct(p)}><strong>{p.display_name}<FuzzyTag item={p} /></strong><span>{p.identifier || '无编号'} · {p.specification || '—'}</span></button>)}</div>}{q && results.length === 0 && <Empty>没有匹配货品</Empty>}</div> : result ? <div className="alert"><strong>清点完成</strong><p style={{ marginTop: 4 }}>{product.display_name} 在 {result.location_name} 的现库存现为 <b>{formatQuantity(result.on_hand_quantity)} {result.uom_code}</b>{result.movement_posted ? `（调整 ${result.delta > 0 ? '+' : ''}${formatQuantity(result.delta)}）` : '（与清点数一致，无需调整）'}。</p><div className="actions" style={{ marginTop: 8 }}><Button className="secondary" onClick={reset}>清点下一个</Button></div></div> : <><div className="actions" style={{ marginBottom: 12 }}><strong>{product.display_name}</strong><span className="muted">{product.identifier || '无编号'} · {product.specification || '—'}</span><Button type="button" className="secondary" onClick={reset}>更换货品</Button></div><div className="form-grid"><Field label="库位"><select value={locationId} onChange={e => { setLocationId(e.target.value); setResult(null); setFloatConfirm(false) }}>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || '无编码'}</option>)}</select></Field><Field label="单位">{creatingUom && canEdit(user, 'uom') ? <span className="picker-row" style={{ width: '100%' }}><input value={newUom.code} placeholder="编码" onChange={e => setNewUom({ ...newUom, code: e.target.value })} /><input value={newUom.display_name} placeholder="名称" onChange={e => setNewUom({ ...newUom, display_name: e.target.value })} /><input type="number" min="0" max="6" value={newUom.decimal_scale} onChange={e => setNewUom({ ...newUom, decimal_scale: e.target.value })} title="小数位" /><Button type="button" className="primary" onClick={createUnit} disabled={busy}>创建</Button><Button type="button" className="secondary" onClick={() => setCreatingUom(false)}>取消</Button></span> : <select value={uomId} onChange={e => { if (e.target.value === '__new__') { setCreatingUom(true) } else { setUomId(e.target.value); setResult(null); setFloatConfirm(false) } }}>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}{canEdit(user, 'uom') && <option value="__new__">＋ 新建单位…</option>}</select>}</Field><div className="span-2 stat"><span>当前现库存（{selectedUom?.code || '—'}）</span><strong>{currentQuantity} {selectedUom?.code || '—'}</strong></div><Field label="清点数量（可为负）"><input type="number" step="0.001" value={counted} onChange={e => patch('counted', e.target.value)} placeholder="实盘数量" /></Field>{product.serialized && <div className="span-2"><SerialEntry productId={product.product_id} value={serials} onChange={setSerials} label="序列号登记（可选）" /></div>}<Field label="备注"><input value={notes} onChange={e => patch('notes', e.target.value)} /></Field><label className="check-field span-2"><input type="checkbox" checked={changeDefaultUnit} onChange={e => setChangeDefaultUnit(e.target.checked)} /> 同时把货品默认单位改为所选单位</label>{floatConfirm && !creatingUom && <div className="reject-panel span-2"><p>清点数量包含小数（{counted}），请再次确认后提交。</p><div className="actions"><Button className="primary" onClick={() => submit(true)} disabled={busy}>确认提交</Button><Button className="secondary" onClick={() => setFloatConfirm(false)}>返回修改</Button></div></div>}{!floatConfirm && !creatingUom && <div className="span-2 actions"><Button className="primary" onClick={() => submit(false)} disabled={busy}>{busy ? '提交中…' : '提交清点'}</Button></div>}</div></>}</div></section>
}

function NotFound() { return <section><PageHeading eyebrow="404" title="页面不存在" description="请从导航返回业务列表。" /><Link className="primary button-link" to="/">返回总览</Link></section> }

export function routeView(path, user, query, hash = '') {
  const parts = path.split('/').filter(Boolean); const first = parts[0]; const id = parts[1]; const sub = parts[2]
  if (path === '/') return <Workbench user={user}><Dashboard compact /></Workbench>
  if (path === '/master') return <ProductList user={user} />
  if (path === '/master/locations') return <AdminPage locationsOnly user={user} />
  if (path === '/master/uoms') return <UnitsPage user={user} />
  if (path === '/inventory' && hash !== '#documents') return <Dashboard />
  if (path === '/sales' && !canView(user, 'sales') && canView(user, 'customers')) return masterRoute('master', ['master', 'customers'], query, user)
  if (first === 'products') { if (path === '/products') return <ProductList user={user} />; if (id === 'new') return user.role === 'ADMIN' ? <ProductForm /> : <Forbidden />; if (sub === 'edit') return user.role === 'ADMIN' ? <ProductForm id={id} /> : <Forbidden />; return <ProductDetail id={id} user={user} /> }
  if (first === 'requests') { if (path === '/requests') return <RequestList user={user} />; if (id === 'new') return <RequestForm prefillProductId={query?.get('product_id')} />; if (sub === 'edit') return <RequestDetailLoader id={id} user={user} edit />; return <RequestDetail id={id} user={user} /> }
  if (first === 'count') return canView(user, 'count') ? <CountPage user={user} /> : <Forbidden />
  if (first === 'purchase' || first === 'sales') return documentRoute(first, parts, user)
  if (first === 'inventory') {
    const isDocument = isInventoryDocumentPath(path, DOC_GROUP_TYPES.inventory)
    return isDocument
      ? documentRoute(first, parts, user)
      : <InventoryDetail ids={{ product_id: parts[1], location_id: parts[2], condition_id: parts[3], uom_id: parts[4] }} />
  }
  if (first === 'master') return masterRoute(first, parts, query, user)
  if (first === 'reports') return reportRoute(first, parts.length === 1 ? ['reports', 'purchase'] : parts, query, user)
  if (first === 'admin') { if (path === '/admin') return canView(user, 'system') ? <AdminPage user={user} /> : canView(user, 'audit') ? <Audit /> : <Forbidden />; if (parts[1] === 'users') return canView(user, 'system') ? (parts[2] === 'new' ? <UserForm /> : parts[3] === 'edit' ? <UserForm id={parts[2]} /> : <UserDetail id={parts[2]} />) : <Forbidden />; if (parts[1] === 'locations') return canView(user, 'system') ? (parts[2] === 'new' ? <LocationForm /> : parts[3] === 'edit' ? <LocationForm id={parts[2]} /> : <LocationDetail id={parts[2]} />) : <Forbidden /> }
  if (first === 'conflicts') return canView(user, 'conflicts') ? (path === '/conflicts' ? <Conflicts /> : <ConflictDetail id={id} />) : <Forbidden />
  if (first === 'audit') return canView(user, 'audit') ? (path === '/audit' ? <Audit /> : <AuditDetail id={id} />) : <Forbidden />
  if (first === 'serials') return canView(user, 'serials') ? (path === '/serials' ? <SerialLedger /> : <SerialDetail id={id} />) : <Forbidden />
  if (first === 'profile') return <Profile user={user} />
  return <NotFound />
}
function RequestDetailLoader({ id, user, edit }) {
  const { data, error } = useFetchOne(() => api.stockRequest(id), [id])
  if (error) return <section><Back to={`/requests/${id}`} /><ErrorBox error={error} /></section>
  if (!data) return <Loading />
  const reviewer = can(user, 'WAREHOUSE', 'ADMIN')
  const canEditThis = data.status === 'DRAFT' && (reviewer || data.requester_user_id === user.user_id) || data.status === 'SUBMITTED' && reviewer
  if (edit) return canEditThis ? <RequestForm id={id} initial={data} /> : <Forbidden />
  return <RequestDetail id={id} user={user} />
}
function Profile({ user }) {
  const [form, setForm] = useState({ current_password: '', new_password: '' })
  const [error, setError] = useState(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function change(e) { e.preventDefault(); setError(null); setMessage(''); setBusy(true); try { await api.changePassword(form); setForm({ current_password: '', new_password: '' }); setMessage('密码已修改') } catch (err) { setError(err) } finally { setBusy(false) } }
  return <section><PageHeading eyebrow="账户" title="我的信息" description="当前登录账号信息。" /><div className="detail-grid"><div className="panel"><dl className="detail-list"><dt>显示名</dt><dd>{user.display_name || '—'}</dd><dt>用户名</dt><dd>{user.username}</dd><dt>角色</dt><dd>{ROLE_LABELS[user.role] || user.role}</dd></dl></div><div className="panel"><h2>修改密码</h2><form className="form-grid" onSubmit={change}><Field label="当前密码"><input type="password" value={form.current_password} onChange={e => setForm({ ...form, current_password: e.target.value })} required /></Field><Field label="新密码"><input type="password" minLength="8" value={form.new_password} onChange={e => setForm({ ...form, new_password: e.target.value })} required /></Field><ErrorBox error={error} />{message && <span className="success-text">{message}</span>}<div className="span-2 actions"><Button className="primary" disabled={busy}>{busy ? '提交中…' : '修改密码'}</Button></div></form></div></div></section>
}

export function AppRouter({ user, onLogout }) {
  const currentLocation = () => ({ pathname: normalizePath(stripBasePath(window.location.pathname)), search: window.location.search, hash: window.location.hash, state: window.history.state || {} })
  const [location, setLocation] = useState(currentLocation)
  const lastLocation = useRef(location)
  const fullPath = loc => loc.pathname + loc.search + loc.hash
  useEffect(() => {
    const changed = () => {
      const next = currentLocation()
      if (fullPath(next) === fullPath(lastLocation.current)) return
      if (!confirmDirtyLeave()) { window.history.pushState(lastLocation.current.state, '', withBasePath(fullPath(lastLocation.current))); return }
      lastLocation.current = next
      setLocation(next)
    }
    window.addEventListener('popstate', changed)
    window.addEventListener('hashchange', changed)
    return () => { window.removeEventListener('popstate', changed); window.removeEventListener('hashchange', changed) }
  }, [])
  const navigate = useCallback((to, options = {}) => {
    const { replace = false, state, skipGuard = false } = options
    if (!replace && !skipGuard && !confirmDirtyLeave()) return false
    if (!replace) window.dispatchEvent(new Event('erp:before-navigate'))
    const previous = lastLocation.current
    const target = new URL(to, `http://erp.local${fullPath(previous)}`)
    if (target.origin !== 'http://erp.local') return false
    const samePage = target.pathname === previous.pathname
    const editingSameObject = target.pathname === `${previous.pathname}/edit` || previous.pathname === `${target.pathname}/edit`
    const nextState = state ?? ((replace || samePage || editingSameObject) ? previous.state : {})
    window.history[replace ? 'replaceState' : 'pushState'](nextState, '', withBasePath(target.pathname + target.search + target.hash))
    const next = currentLocation()
    lastLocation.current = next
    setLocation(next)
    if (!replace && target.hash) requestAnimationFrame(() => document.getElementById(target.hash.slice(1))?.scrollIntoView?.({ block: 'start' }))
    return true
  }, [])
  return <RouterContext.Provider value={{ navigate, currentPath: location.pathname, location, state: location.state, returnTo: location.state.returnTo, user }}><ToastProvider><Layout user={user} onLogout={onLogout}>{routeView(location.pathname, user, new URLSearchParams(location.search), location.hash)}</Layout></ToastProvider></RouterContext.Provider>
}

export function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  function updateUser(value) { setApiUser(value); setUser(value) }
  useEffect(() => { setUnauthorizedHandler(() => updateUser(null)); api.me().then(updateUser).catch(() => {}).finally(() => setLoading(false)); return () => setUnauthorizedHandler(null) }, [])
  if (loading) return <Loading />
  return user ? <AppRouter key={`${user.user_id}:${user.role}`} user={user} onLogout={() => updateUser(null)} /> : <Login onLogin={updateUser} />
}

const mountEl = document.getElementById('root')
if (mountEl) {
  // 热更新重跑入口时复用根节点，避免重复挂载和卸载错误。
  const appRoot = import.meta.hot?.data.root || createRoot(mountEl)
  if (import.meta.hot) import.meta.hot.data.root = appRoot
  appRoot.render(<App />)
}
