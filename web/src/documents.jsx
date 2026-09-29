import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api from './api'
import DataTable, { toServerFilters } from './data-table'
import { formatMoney, formatQuantity } from './list-utils'
import { prepareUploadFile } from './image-utils'
import { can, canEdit, canView } from './roles'
import { SerialEntry } from './serial'
import {
  Back, Badge, Button, Empty, ErrorBox, Field, Forbidden, Link, Loading,
  PageHeading, useDirtyLeaveGuard, useFetchOne, useRouter,
} from './ui'

export const DOC_TYPE_CONFIG = {
  PURCHASE_ORDER: { label: '采购订单', group: 'purchase', party: 'supplier', price: 'cost', deposit: false, source: false, dest: false, count: false, create: ['WAREHOUSE', 'ADMIN'], post: ['WAREHOUSE', 'ADMIN'] },
  PURCHASE_RECEIPT: { label: '采购入库', group: 'purchase', party: 'supplier', price: 'cost', deposit: false, source: false, dest: true, count: false, create: ['WAREHOUSE', 'ADMIN'], post: ['WAREHOUSE', 'ADMIN'] },
  PURCHASE_RETURN: { label: '采购退货', group: 'purchase', party: 'supplier', price: 'cost', deposit: false, source: true, dest: false, count: false, create: ['WAREHOUSE', 'ADMIN'], post: ['WAREHOUSE', 'ADMIN'] },
  SALES_ORDER: { label: '销售订单', group: 'sales', party: 'customer', price: 'sales', deposit: true, source: false, dest: false, count: false, create: ['SALES', 'ADMIN'], post: ['SALES', 'ADMIN'] },
  SALES_DELIVERY: { label: '销售出库', group: 'sales', party: 'customer', price: 'sales', deposit: false, source: true, dest: false, count: false, create: ['SALES', 'ADMIN'], post: ['SALES', 'ADMIN', 'WAREHOUSE'] },
  SALES_RETURN: { label: '销售退货', group: 'sales', party: 'customer', price: 'sales', deposit: false, source: false, dest: true, count: false, create: ['SALES', 'ADMIN'], post: ['SALES', 'ADMIN', 'WAREHOUSE'] },
  STOCK_TRANSFER: { label: '库存调拨', group: 'inventory', party: null, price: null, deposit: false, source: true, dest: true, count: false, create: ['WAREHOUSE', 'ADMIN'], post: ['WAREHOUSE', 'ADMIN'] },
  STOCK_COUNT: { label: '库存盘点', group: 'inventory', party: null, price: null, deposit: false, source: true, dest: false, count: true, create: ['WAREHOUSE', 'ADMIN'], post: ['WAREHOUSE', 'ADMIN'] },
  STOCK_LOSS: { label: '报损', group: 'inventory', party: null, price: null, deposit: false, source: true, dest: false, count: false, create: ['WAREHOUSE', 'ADMIN'], post: ['WAREHOUSE', 'ADMIN'] },
  OTHER_IN: { label: '其他入库', group: 'inventory', party: null, price: null, deposit: false, source: false, dest: true, count: false, create: ['WAREHOUSE', 'ADMIN'], post: ['WAREHOUSE', 'ADMIN'] },
  OTHER_OUT: { label: '其他出库', group: 'inventory', party: null, price: null, deposit: false, source: true, dest: false, count: false, create: ['WAREHOUSE', 'ADMIN'], post: ['WAREHOUSE', 'ADMIN'] },
}

export const DOC_GROUP_LABELS = { purchase: '采购', sales: '销售', inventory: '库存' }
export const DOC_GROUP_TYPES = {
  purchase: ['PURCHASE_ORDER', 'PURCHASE_RECEIPT', 'PURCHASE_RETURN'],
  sales: ['SALES_ORDER', 'SALES_DELIVERY', 'SALES_RETURN'],
  inventory: ['STOCK_TRANSFER', 'STOCK_COUNT', 'STOCK_LOSS', 'OTHER_IN', 'OTHER_OUT'],
}

export const canCreateDoc = (user, type) => can(user, ...(DOC_TYPE_CONFIG[type]?.create || []))
export const canPostThis = (user, doc) => user?.role === 'ADMIN' || can(user, ...(DOC_TYPE_CONFIG[doc?.doc_type]?.post || [])) || user?.user_id === doc?.created_by

const badgeTone = status => (status === 'POSTED' ? 'green' : status === 'REVERSED' ? 'red' : 'amber')
const statusLabel = status => (status === 'REVERSED' ? '已红冲' : status === 'POSTED' ? '已过账' : status === 'SUBMITTED' ? '已提交' : '草稿')

function GroupHub({ group, user }) {
  return <section><PageHeading eyebrow={DOC_GROUP_LABELS[group]} title={`${DOC_GROUP_LABELS[group]}单据`} description="选择单据类型：自动编号、草稿保存、过账生效库存与应收应付。" /><div className="panel"><div className="record-list">{DOC_GROUP_TYPES[group].map(type => { const cfg = DOC_TYPE_CONFIG[type]; return <Link className="record-card" key={type} to={`/${cfg.group}/${type.toLowerCase()}`}><div><strong>{cfg.label}</strong><span>{type}</span></div><small>进入 →</small></Link> })}</div></div></section>
}

function DocumentList({ docType, user }) {
  const { navigate } = useRouter()
  const cfg = DOC_TYPE_CONFIG[docType]
  const [error, setError] = useState(null)
  const fetchDocuments = useCallback((p, signal) => api.documents({ ...p, doc_type: docType, signal }), [docType])
  const pageExtra = useMemo(() => ({ docType }), [docType])
  const columns = useMemo(() => [
    { key: 'doc_no', label: '单号', filterType: 'text' },
    { key: 'doc_type_label', label: '类型' },
    { key: 'doc_date', label: '日期' },
    { key: 'party_name', label: '往来方', filterType: 'text', value: r => r.party_name || '—' },
    { key: 'total_amount', label: '金额', align: 'end', value: r => r.total_amount != null ? `¥ ${formatMoney(r.total_amount)}` : '—', sortValue: r => Number(r.total_amount || 0) },
    { key: 'status', label: '状态', filterType: 'select', filterOptions: [{ value: 'DRAFT', label: '草稿' }, { value: 'SUBMITTED', label: '已提交' }, { value: 'POSTED', label: '已过账' }, { value: 'REVERSED', label: '已红冲' }], render: r => statusLabel(r.status) },
    { key: 'line_count', label: '明细数', value: r => r.line_count || 0 },
    { key: 'posted_by', label: '过账人', value: r => r.posted_by || '—' },
  ], [])
  return <section><PageHeading eyebrow={DOC_GROUP_LABELS[cfg.group]} title={cfg.label} description="自动编号、草稿保存；过账后仅可红冲作废。">{canCreateDoc(user, docType) && <Button className="primary" onClick={() => navigate(`/${cfg.group}/${docType.toLowerCase()}/new`)}>＋ 新建</Button>}</PageHeading><div className="panel"><ErrorBox error={error} /><DataTable
    mode="server"
    columns={columns}
    fetchData={fetchDocuments}
    pageExtra={pageExtra}
    rowKey={d => String(d.document_id)}
    rowHref={d => `/${cfg.group}/${docType.toLowerCase()}/${d.document_id}`}
    onError={setError}
    exportConfig={{
      endpoint: '/api/documents/export',
      filename: cfg.label,
      allScope: 'server',
      buildParams: ({ q, filters, sortKey, sortDir }, extra) => ({ doc_type: extra.docType, f: toServerFilters(filters, columns), sort: sortKey || '', order: sortDir }),
    }}
  /></div></section>
}

function DocumentForm({ docType, id, user }) {
  const { navigate } = useRouter()
  const cfg = DOC_TYPE_CONFIG[docType]
  const isEdit = Boolean(id)
  const [form, setForm] = useState({ party_id: '', doc_date: '', source_location_id: '', destination_location_id: '', deposit_amount: '', notes: '', version: 1, lines: [] })
  const baseline = useRef(JSON.stringify(form))
  const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form])
  useDirtyLeaveGuard(dirty)
  const [parties, setParties] = useState([])
  const [locations, setLocations] = useState([])
  const [uoms, setUoms] = useState([])
  const [stockByProduct, setStockByProduct] = useState({})
  const [products, setProducts] = useState([])
  const [q, setQ] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.locations().then(setLocations).catch(setError)
    api.uoms().then(setUoms).catch(setError)
    if (cfg.party === 'customer') api.customers().then(setParties).catch(setError)
    if (cfg.party === 'supplier') api.suppliers().then(setParties).catch(setError)
    if (id) api.document(id).then(d => {
      const next = {
        party_id: d.party_id || '', doc_date: d.doc_date || '', source_location_id: d.source_location_id || '', destination_location_id: d.destination_location_id || '',
        deposit_amount: d.deposit_amount ? String(d.deposit_amount) : '', notes: d.notes || '', version: d.version,
        lines: d.lines.map(l => ({ product_id: l.product_id, product_name: l.product_name, quantity: String(l.quantity), uom_id: l.uom_id, uom_code: l.uom_code, price: l.price != null ? String(l.price) : '', counted_quantity: l.counted_quantity != null ? String(l.counted_quantity) : '', serialized: !!l.serialized, serial_numbers: l.serial_numbers?.length ? l.serial_numbers.join('\n') : '', notes: l.notes || '' })),
      }
      baseline.current = JSON.stringify(next)
      setForm(next)
      const ids = (d.lines || []).map(l => l.product_id)
      if (ids.length) api.productStocks(ids.join(',')).then(x => setStockByProduct(x.items || {})).catch(() => {})
    }).catch(setError)
  }, [id, docType, cfg.party])

  useEffect(() => { if (!q) { setProducts([]); return }; const controller = new AbortController(); const t = setTimeout(() => api.products({ q, page: 1, page_size: 30, signal: controller.signal }).then(x => { if (!controller.signal.aborted) setProducts(x.items || []) }).catch(err => { if (err.name !== 'AbortError') setError(err) }), 180); return () => { clearTimeout(t); controller.abort() } }, [q])

  function patch(k, v) { setForm(x => ({ ...x, [k]: v })) }
  function addLine(p) {
    const price = cfg.price === 'sales' ? p.sales_price : cfg.price === 'cost' ? p.purchase_cost_price : 0
    setStockByProduct(prev => ({ ...prev, [String(p.product_id)]: p.stock_summary || [] }))
    setForm(x => ({ ...x, lines: [...x.lines, { product_id: p.product_id, product_name: p.display_name, quantity: '1', uom_id: p.uom_id || '', uom_code: p.uom_code || '', price: price != null ? String(price) : '', counted_quantity: '', serialized: !!p.serialized, serial_numbers: '', notes: '' }] }))
    setQ(''); setProducts([])
  }
  function updateLine(i, k, v) { setForm(x => ({ ...x, lines: x.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) })) }
  function lineStock(p) {
    const entries = p?.stock_summary || stockByProduct[String(p?.product_id)]
    return entries && entries.length ? entries.map(e => `${formatQuantity(e.quantity)} ${e.uom_code || ''}`).join(' · ') : '0'
  }

  async function save(submit) {
    setBusy(true); setError(null)
    try {
      const payload = {
        party_id: form.party_id ? Number(form.party_id) : null,
        doc_date: form.doc_date || null,
        source_location_id: form.source_location_id ? Number(form.source_location_id) : null,
        destination_location_id: form.destination_location_id ? Number(form.destination_location_id) : null,
        deposit_amount: form.deposit_amount ? Number(form.deposit_amount) : null,
        notes: form.notes || null,
        lines: form.lines.map(l => ({
          product_id: Number(l.product_id), quantity: Number(l.quantity) || 1,
          uom_id: l.uom_id ? Number(l.uom_id) : null, uom_code: l.uom_code || null,
          price: l.price !== '' && l.price != null ? Number(l.price) : null,
          counted_quantity: l.counted_quantity !== '' && l.counted_quantity != null ? Number(l.counted_quantity) : null,
          serial_numbers: l.serial_numbers?.trim() ? l.serial_numbers.split('\n').map(s => s.trim()).filter(Boolean) : null,
          notes: l.notes || null,
        })),
      }
      const result = isEdit ? await api.updateDocument(id, { ...payload, version: form.version }) : await api.createDocument({ doc_type: docType, ...payload })
      if (submit) await api.submitDocument(result.document_id)
      navigate(`/${cfg.group}/${docType.toLowerCase()}/${result.document_id}`)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const title = isEdit ? `编辑${cfg.label}` : `新建${cfg.label}`
  return <section><Back to={`/${cfg.group}/${docType.toLowerCase()}`} /><PageHeading eyebrow={DOC_GROUP_LABELS[cfg.group]} title={title} description="保存草稿后可继续编辑；提交后锁定，过账生效库存与应收应付。" /><form className="panel form-grid" onSubmit={e => { e.preventDefault(); save(false) }}>{cfg.party && <Field label={cfg.party === 'customer' ? '客户' : '供应商'}><select required value={form.party_id} onChange={e => patch('party_id', e.target.value)}><option value="">请选择</option>{parties.map(p => <option key={p[cfg.party === 'customer' ? 'customer_id' : 'supplier_id']} value={p[cfg.party === 'customer' ? 'customer_id' : 'supplier_id']}>{p.name}</option>)}</select></Field>}<Field label="单据日期"><input type="date" value={form.doc_date} onChange={e => patch('doc_date', e.target.value)} /></Field>{cfg.source && <Field label="来源库位"><select value={form.source_location_id} onChange={e => patch('source_location_id', e.target.value)}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || l.location_type}</option>)}</select></Field>}{cfg.dest && <Field label="目的库位"><select value={form.destination_location_id} onChange={e => patch('destination_location_id', e.target.value)}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || l.location_type}</option>)}</select></Field>}{cfg.deposit && <Field label="预收定金（¥）"><input type="number" min="0" step="0.01" value={form.deposit_amount} onChange={e => patch('deposit_amount', e.target.value)} /></Field>}<Field label="备注"><input value={form.notes} onChange={e => patch('notes', e.target.value)} /></Field><div className="span-2 picker-field"><span className="field-label">添加货品</span><div className="picker-row"><input value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" /></div>{products.length > 0 && <div className="picker-results">{products.map(p => <button type="button" key={p.product_id} onClick={() => addLine(p)}><strong>{p.display_name}</strong><span>{p.identifier || '无编号'} · 现库存 {lineStock(p)}</span></button>)}</div>}</div><div className="span-2 line-editor"><div className="line-editor-head"><h2>明细 ({form.lines.length})</h2><span className="muted">现库存实时显示，价格自动带出</span></div>{form.lines.length ? form.lines.map((line, i) => <article className="line-card" key={`${line.product_id}-${i}`}><div className="line-title"><div><strong>{line.product_name || `货品 ${line.product_id}`}</strong><small>现库存 {lineStock(line)} {line.uom_code || ''}</small></div><button type="button" className="danger-link" onClick={() => setForm(x => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))}>删除</button></div><div className="line-fields"><Field label={cfg.count ? '实盘数量' : '数量'}><input type="number" step="0.001" value={cfg.count ? line.counted_quantity : line.quantity} onChange={e => updateLine(i, cfg.count ? 'counted_quantity' : 'quantity', e.target.value)} /></Field>{cfg.price && <Field label="单价"><input type="number" min="0" step="0.01" value={line.price} onChange={e => updateLine(i, 'price', e.target.value)} /></Field>}<Field label="单位"><select value={line.uom_id || ''} onChange={e => { const v = e.target.value; const u = uoms.find(x => String(x.uom_id) === v); updateLine(i, 'uom_id', v); updateLine(i, 'uom_code', u?.code || '') }}><option value="">跟随货品</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field><Field label="备注"><input value={line.notes} onChange={e => updateLine(i, 'notes', e.target.value)} /></Field></div>{line.serialized && <SerialEntry productId={line.product_id} value={line.serial_numbers || ''} onChange={v => updateLine(i, 'serial_numbers', v)} quantity={cfg.count ? line.counted_quantity : line.quantity} />}</article>) : <Empty>还没有添加货品</Empty>}</div><ErrorBox error={error} /><div className="span-2 actions"><Button className="primary" disabled={busy || !form.lines.length}>{busy ? '保存中…' : '保存草稿'}</Button><Button type="button" className="secondary" onClick={() => save(true)} disabled={busy || !form.lines.length}>保存并提交</Button><Button type="button" className="secondary" onClick={() => navigate(`/${cfg.group}/${docType.toLowerCase()}`)}>取消</Button></div></form></section>
}

function DocumentEditLoader({ id, user }) {
  // 编辑表单前置校验：与详情页同一判定（创建人/ADMIN 且 DRAFT），无权直接 403
  const { data, error } = useFetchOne(() => api.document(id), [id])
  if (error) return <section><Back to="/" /><ErrorBox error={error} /></section>
  if (!data) return <Loading />
  const editable = data.status === 'DRAFT' && (user.user_id === data.created_by || user.role === 'ADMIN')
  return editable ? <DocumentForm docType={data.doc_type} id={id} user={user} /> : <Forbidden />
}

function DocumentDetail({ id, user }) {
  const { navigate } = useRouter()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const reload = () => api.document(id).then(setData).catch(setError)
  useEffect(() => { reload() }, [id])
  if (!data) return error ? <section><Back to="/" /><ErrorBox error={error} /></section> : <Loading />
  const cfg = DOC_TYPE_CONFIG[data.doc_type]
  const isOwner = user.user_id === data.created_by
  const inPostRoles = can(user, ...(cfg.post || []))
  const canPost = user.role === 'ADMIN' || inPostRoles || isOwner
  const canEdit = data.status === 'DRAFT' && (isOwner || user.role === 'ADMIN')

  async function run(call) { setBusy(true); setError(null); try { await call(); } catch (err) { setError(err) } finally { setBusy(false) } }
  async function postDoc() { setConfirm(null); await run(async () => { const override = isOwner && !inPostRoles; await api.postDocument(id, { override_review: override }); reload() }) }
  async function reverseDoc() { setConfirm(null); await run(async () => { await api.reverseDocument(id); reload() }) }
  async function onFile(e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { setError(new Error('附件不能超过 10MB')); return }
    setUploading(true); setError(null); setUploadProgress(null)
    try {
      // 图片附件端侧压缩到 ≤400KB/1280px；PDF 等原样透传（10MB 上限不变）。
      const isImage = /^image\/(jpeg|png|webp|gif|heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
      const prepared = isImage ? await prepareUploadFile(file) : file
      await api.addAttachment(id, prepared, {
        onProgress: (loaded, total) => setUploadProgress(total ? Math.round((loaded / total) * 100) : 0),
      })
      await reload()
    } catch (err) { setError(err) } finally { setUploading(false); setUploadProgress(null) }
  }
  const listPath = `/${cfg.group}/${data.doc_type.toLowerCase()}`
  return <section><Back to={listPath} /><PageHeading eyebrow={cfg.label} title={data.doc_no} description={`${data.doc_date} · ${data.party_name || '—'} · 制单 ${data.creator_name || '—'}`}><Badge tone={badgeTone(data.status)}>{statusLabel(data.status)}</Badge></PageHeading><ErrorBox error={error} /><div className="stats"><div className="stat teal"><span>单据金额</span><strong>{data.total_amount != null ? `¥ ${formatMoney(data.total_amount)}` : '—'}</strong></div>{data.deposit_amount > 0 && <div className="stat"><span>预收定金</span><strong>¥ {formatMoney(data.deposit_amount)}</strong></div>}<div className="stat"><span>明细</span><strong>{data.lines?.length || 0} 行</strong></div></div><div className="panel"><h2>明细</h2><div className="detail-lines">{data.lines?.map(l => <div className="detail-line" key={l.document_line_id}><div><strong>{l.product_name}</strong><span>{l.specification || '—'} · {l.uom_code || '—'}{l.source_location_name && ` · 从 ${l.source_location_name}`}{l.destination_location_name && ` · 到 ${l.destination_location_name}`}</span></div><b>{formatQuantity(l.quantity)} {l.uom_code}{cfg.count && l.counted_quantity != null && ` → 实盘 ${formatQuantity(l.counted_quantity)}`}{l.book_quantity != null && `（账面 ${formatQuantity(l.book_quantity)}）`}{l.price != null && l.price > 0 && <small> ¥ {formatMoney(l.price)} × {formatQuantity(l.quantity)}</small>}</b>{l.serial_numbers?.length > 0 && <span className="serial-tag">SN：{l.serial_numbers.join('，')}</span>}</div>)}</div></div><div className="panel"><h2>附件</h2><div className="actions"><input type="file" onChange={onFile} disabled={uploading || data.status === 'REVERSED'} /><span className="muted">{uploadProgress !== null ? `上传中 ${uploadProgress}%` : uploading ? '上传中…' : '支持送货单 / 发票照片（≤10MB）'}</span>{uploadProgress !== null && <progress value={uploadProgress} max="100" aria-label="上传进度" />}</div>{data.attachments?.length ? <div className="record-list">{data.attachments.map(a => <a className="record-card" key={a.attachment_id} href={api.attachmentUrl(a.attachment_id)} download><div><strong>{a.filename}</strong><span>{a.content_type}</span></div><small>{Math.round(a.size / 1024)} KB</small></a>)}</div> : <Empty>暂无附件</Empty>}</div><div className="panel actions-panel"><h2>操作</h2><div className="actions">{data.status === 'DRAFT' && canEdit && <Button className="primary" onClick={() => navigate(`${listPath}/${id}/edit`)}>编辑</Button>}{data.status === 'DRAFT' && (isOwner || can(user, ...(cfg.create || []))) && <Button className="secondary" onClick={() => run(() => api.submitDocument(id).then(reload))} disabled={busy}>提交</Button>}{data.status === 'SUBMITTED' && isOwner && <Button className="secondary" onClick={() => run(() => api.withdrawDocument(id).then(reload))} disabled={busy}>撤回</Button>}
{data.status === 'SUBMITTED' && (inPostRoles || user.role === 'ADMIN') && <Button className="secondary" onClick={() => { const reason = window.prompt('驳回原因（必填）'); if (reason && reason.trim()) run(() => api.rejectDocument(id, reason.trim()).then(reload)) }} disabled={busy}>驳回</Button>}
{(data.status === 'DRAFT' || data.status === 'SUBMITTED') && canPost && <Button className="primary" onClick={() => setConfirm('post')} disabled={busy}>过账</Button>}{data.status === 'POSTED' && canPost && <Button className="danger" onClick={() => setConfirm('reverse')} disabled={busy}>红冲作废</Button>}</div>{confirm === 'post' && <div className="reject-panel"><p>过账将生效库存与应收应付。{isOwner && !inPostRoles ? '（你将跳过复核直接过账）' : ''}</p><div className="actions"><Button className="primary" onClick={postDoc} disabled={busy}>确认过账</Button><Button className="secondary" onClick={() => setConfirm(null)}>取消</Button></div></div>}{confirm === 'reverse' && <div className="reject-panel"><p>红冲将生成反向单据并冲回库存与应收应付，此操作不可逆。</p><div className="actions"><Button className="danger" onClick={reverseDoc} disabled={busy}>确认红冲</Button><Button className="secondary" onClick={() => setConfirm(null)}>取消</Button></div></div>}{data.status === 'REVERSED' && data.reversal_document && <div className="alert">本单已被红冲，反向单据：{data.reversal_document.doc_no}</div>}{data.ar_ap_entries?.length > 0 && <h3>应收应付流水</h3>}{data.ar_ap_entries?.length > 0 && <div className="record-list">{data.ar_ap_entries.map(e => <div className="record-card" key={e.ar_ap_entry_id}><div><strong>{e.entry_type === 'DEPOSIT' ? '定金' : '应收/应付'}</strong><span>{e.direction === 'UP' ? '增加' : '冲减'} · {new Date(e.created_at).toLocaleString()}</span></div><div className="record-value"><b>{e.direction === 'UP' ? '+' : '-'} ¥ {formatMoney(e.amount)}</b></div></div>)}</div>}</div></section>
}

export function documentRoute(first, parts, user) {
  const group = first
  if (!canView(user, group === 'inventory' ? 'inventoryDocs' : group)) return <Forbidden />
  const type = (parts[1] || '').toUpperCase()
  if (parts.length === 1) return <GroupHub group={group} user={user} />
  if (!DOC_TYPE_CONFIG[type]) return <Forbidden />
  const sub = parts[2]
  const id = sub && !['new', 'edit'].includes(sub) ? Number(sub) : parts.length > 2 && sub === 'new' ? null : parts[2] ? Number(parts[2]) : null
  const isNew = sub === 'new'
  const isEdit = parts[3] === 'edit'
  if (isNew) return canCreateDoc(user, type) ? <DocumentForm docType={type} user={user} /> : <Forbidden />
  if (isEdit) return <DocumentEditLoader id={id} user={user} />
  if (id) return <DocumentDetail id={id} user={user} />
  return <DocumentList docType={type} user={user} />
}
