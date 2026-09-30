import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api from './api'
import DataTable, { toServerFilters } from './data-table'
import { formatMoney, formatQuantity } from './list-utils'
import { prepareUploadFile } from './image-utils'
import { can, canView } from './roles'
import { SerialEntry } from './serial'
import { STATUS_REGISTRY } from './status'
import {
  Back, Badge, Button, Empty, ErrorBox, Field, Forbidden, Link, Loading,
  PageHeading, useDirtyLeaveGuard, useFetchOne, useRouter,
  StatusBadge, ActionConfirm, DropdownMenu, Tabs, ObjectHeader, Timeline, FormSection, useToast, useBusy,
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

function DocumentList({ docType, group, user }) {
  const { navigate } = useRouter()
  const activeGroup = group || DOC_TYPE_CONFIG[docType].group
  const cfg = docType ? DOC_TYPE_CONFIG[docType] : { group: activeGroup, label: `${DOC_GROUP_LABELS[activeGroup]}单据` }
  const [error, setError] = useState(null)
  const fetchDocuments = useCallback((params, signal) => api.documents({ ...params, ...(docType ? { doc_type: docType } : { group: activeGroup }), signal }), [docType, activeGroup])
  const pageExtra = useMemo(() => docType ? { doc_type: docType } : { group: activeGroup }, [docType, activeGroup])
  const types = DOC_GROUP_TYPES[activeGroup]
  const columns = useMemo(() => [
    { key: 'doc_no', label: '单号', filterType: 'text' },
    { key: 'doc_type', label: '类型', filterType: 'select', filterOptions: types.map(value => ({ value, label: DOC_TYPE_CONFIG[value].label })), render: row => DOC_TYPE_CONFIG[row.doc_type]?.label || '业务单据' },
    { key: 'doc_date', label: '日期', render: row => <time title={row.doc_date}>{row.doc_date?.slice(0, 10) || '—'}</time> },
    { key: 'party_name', label: '往来方', filterType: 'text', value: row => row.party_name || '—' },
    { key: 'total_amount', label: '金额', align: 'end', value: row => row.total_amount != null ? `¥ ${formatMoney(row.total_amount)}` : '—', sortValue: row => Number(row.total_amount || 0) },
    { key: 'status', label: '状态', filterType: 'select', filterOptions: Object.entries(STATUS_REGISTRY.document).map(([value, status]) => ({ value, label: status.label })), render: row => <StatusBadge domain="document" value={row.status} /> },
    { key: 'line_count', label: '明细数', align: 'end', sortable: false, value: row => row.line_count || 0 },
    { key: 'posted_by', label: '过账人', sortable: false, value: row => row.posted_by || '—' },
  ], [types])
  const creatable = types.filter(type => canCreateDoc(user, type))
  const allPath = activeGroup === 'inventory' ? '/inventory#documents' : `/${activeGroup}`
  return <section><PageHeading eyebrow={DOC_GROUP_LABELS[activeGroup]} title={cfg.label} description="筛选、视图与分页会保留在当前链接中。">
    {docType && canCreateDoc(user, docType) ? <Button variant="primary" onClick={() => navigate(`/${activeGroup}/${docType.toLowerCase()}/new`)}>＋ 新建</Button> : !docType && creatable.length > 0 && <DropdownMenu label="＋ 新建单据" variant="primary">{creatable.map(type => <button key={type} onClick={() => navigate(`/${activeGroup}/${type.toLowerCase()}/new`)}>{DOC_TYPE_CONFIG[type].label}</button>)}</DropdownMenu>}
  </PageHeading><Tabs label="单据类型" value={docType || 'all'} items={[{ id: 'all', label: '全部', to: allPath }, ...types.map(type => ({ id: type, label: DOC_TYPE_CONFIG[type].label, to: `/${activeGroup}/${type.toLowerCase()}` }))]} /><div className="panel"><ErrorBox error={error} /><DataTable
    tableId={`${activeGroup}.documents${docType ? `.${docType.toLowerCase()}` : ''}`} mode="server" columns={columns} fetchData={fetchDocuments} pageExtra={pageExtra} queryKeys={['mine']}
    rowKey={row => String(row.document_id)} rowHref={row => `/${DOC_TYPE_CONFIG[row.doc_type].group}/${row.doc_type.toLowerCase()}/${row.document_id}`} onError={setError}
    exportConfig={{ endpoint: '/api/documents/export', filename: cfg.label, allScope: 'server', buildParams: ({ q, filters, sortKey, sortDir }, extra) => ({ ...extra, q, f: toServerFilters(filters, columns), sort: sortKey || '', order: sortDir }) }}
  /></div></section>
}

function DocumentForm({ docType, id, user }) {
  const { navigate } = useRouter()
  const cfg = DOC_TYPE_CONFIG[docType]
  const isEdit = Boolean(id)
  const [form, setForm] = useState({ party_id: '', doc_date: '', source_location_id: '', destination_location_id: '', deposit_amount: '', notes: '', version: 1, lines: [] })
  // 行身份不依赖货品或序号，删除其他行不会转移 OCR 请求与待确认候选。
  const nextLineId = useRef(0)
  const baseline = useRef(JSON.stringify(form))
  const dirty = JSON.stringify(form) !== baseline.current
  useDirtyLeaveGuard(dirty)
  const [parties, setParties] = useState([])
  const [locations, setLocations] = useState([])
  const [uoms, setUoms] = useState([])
  const [stockByProduct, setStockByProduct] = useState({})
  const [products, setProducts] = useState([])
  const [q, setQ] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const savedDocument = useRef(null)
  const toast = useToast()

  useEffect(() => {
    api.locations().then(setLocations).catch(setError)
    api.uoms().then(setUoms).catch(setError)
    if (cfg.party === 'customer') api.customers().then(setParties).catch(setError)
    if (cfg.party === 'supplier') api.suppliers().then(setParties).catch(setError)
    if (id) api.document(id).then(d => {
      const next = {
        party_id: d.party_id || '', doc_date: d.doc_date || '', source_location_id: d.source_location_id || '', destination_location_id: d.destination_location_id || '',
        deposit_amount: d.deposit_amount ? String(d.deposit_amount) : '', notes: d.notes || '', version: d.version,
        lines: d.lines.map(l => ({ clientLineId: ++nextLineId.current, product_id: l.product_id, product_name: l.product_name, quantity: String(l.quantity), uom_id: l.uom_id, uom_code: l.uom_code, price: l.price != null ? String(l.price) : '', counted_quantity: l.counted_quantity != null ? String(l.counted_quantity) : '', serialized: !!l.serialized, serial_numbers: l.serial_numbers?.length ? l.serial_numbers.join('\n') : '', notes: l.notes || '' })),
      }
      baseline.current = JSON.stringify(next)
      savedDocument.current = { document_id: d.document_id, version: d.version }
      setForm(next)
      const ids = (d.lines || []).map(l => l.product_id)
      if (ids.length) api.productStocks(ids.join(',')).then(x => setStockByProduct(x.items || {})).catch(() => {})
    }).catch(setError)
  }, [id, docType, cfg.party])

  useEffect(() => { if (!q) { setProducts([]); return }; const controller = new AbortController(); const t = setTimeout(() => api.products({ q, page: 1, page_size: 30, signal: controller.signal }).then(x => { if (!controller.signal.aborted) setProducts(x.items || []) }).catch(err => { if (err.name !== 'AbortError') setError(err) }), 180); return () => { clearTimeout(t); controller.abort() } }, [q])

  function patch(k, v) { setForm(x => ({ ...x, [k]: v })) }
  function addLine(p) {
    const price = cfg.price === 'sales' ? p.sales_price : cfg.price === 'cost' ? p.purchase_cost_price : 0
    const line = { clientLineId: ++nextLineId.current, product_id: p.product_id, product_name: p.display_name, quantity: '1', uom_id: p.uom_id || '', uom_code: p.uom_code || '', price: price != null ? String(price) : '', counted_quantity: '', serialized: !!p.serialized, serial_numbers: '', notes: '' }
    setStockByProduct(prev => ({ ...prev, [String(p.product_id)]: p.stock_summary || [] }))
    setForm(x => ({ ...x, lines: [...x.lines, line] }))
    setQ(''); setProducts([])
  }
  function updateLine(i, k, v) { setForm(x => ({ ...x, lines: x.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) })) }
  function lineStock(p) {
    const entries = p?.stock_summary || stockByProduct[String(p?.product_id)]
    return entries && entries.length ? entries.map(e => `${formatQuantity(e.quantity)} ${e.uom_code || ''}`).join(' · ') : '0'
  }

  async function save(submit) {
    if (busyRef.current) return
    busyRef.current = true
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
      const draft = savedDocument.current
      const savedId = draft?.document_id || id
      const result = savedId
        ? await api.updateDocument(savedId, { ...payload, version: draft?.version ?? form.version })
        : await api.createDocument({ doc_type: docType, ...payload })
      // 创建成功但提交失败时，重试必须编辑同一草稿，并使用保存返回的最新版本。
      savedDocument.current = { document_id: result.document_id, version: result.version }
      baseline.current = JSON.stringify(form)
      if (submit) {
        try { await api.submitDocument(result.document_id) }
        catch (err) {
          setError(new Error(`草稿已保存，提交未成功：${err.message || '请稍后重试'}。再次保存并提交会更新同一张草稿。`))
          return
        }
      }
      toast(submit ? '单据已保存并提交审批' : '单据草稿已保存')
      navigate(`/${cfg.group}/${docType.toLowerCase()}/${result.document_id}`, { skipGuard: true })
    } catch (err) { setError(err) } finally { busyRef.current = false; setBusy(false) }
  }

  const title = isEdit ? `编辑${cfg.label}` : `新建${cfg.label}`
  return <section><Back to={`/${cfg.group}/${docType.toLowerCase()}`} /><PageHeading eyebrow={DOC_GROUP_LABELS[cfg.group]} title={title} description="保存草稿后可继续编辑；提交后锁定，过账生效库存与应收应付。" /><form className="panel form-layout" onSubmit={e => { e.preventDefault(); save(e.nativeEvent.submitter?.value === "submit") }}><FormSection title="单据信息" description="先核对往来方与业务日期，再添加明细。">{cfg.party && <Field label={cfg.party === 'customer' ? '客户' : '供应商'}><select required value={form.party_id} onChange={e => patch('party_id', e.target.value)}><option value="">请选择</option>{parties.map(p => <option key={p[cfg.party === 'customer' ? 'customer_id' : 'supplier_id']} value={p[cfg.party === 'customer' ? 'customer_id' : 'supplier_id']}>{p.name}</option>)}</select></Field>}<Field label="单据日期"><input type="date" value={form.doc_date} onChange={e => patch('doc_date', e.target.value)} /></Field>{cfg.source && <Field label="来源库位"><select value={form.source_location_id} onChange={e => patch('source_location_id', e.target.value)}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || '无编码'}</option>)}</select></Field>}{cfg.dest && <Field label="目的库位"><select value={form.destination_location_id} onChange={e => patch('destination_location_id', e.target.value)}><option value="">未指定</option>{locations.map(l => <option key={l.location_id} value={l.location_id}>{l.name} · {l.code || '无编码'}</option>)}</select></Field>}{cfg.deposit && <Field label="预收定金（¥）"><input type="number" min="0" step="0.01" value={form.deposit_amount} onChange={e => patch('deposit_amount', e.target.value)} /></Field>}<Field label="备注"><input value={form.notes} onChange={e => patch('notes', e.target.value)} /></Field></FormSection><FormSection title="货品明细" description="价格与单位根据货品资料带出，可按实际业务调整。"><div className="span-2 picker-field"><span className="field-label">添加货品</span><div className="picker-row"><input value={q} onChange={e => setQ(e.target.value)} placeholder="编号、名称、厂家或型号" /></div>{products.length > 0 && <div className="picker-results">{products.map(p => <button type="button" key={p.product_id} onClick={() => addLine(p)}><strong>{p.display_name}</strong><span>{p.identifier || '无编号'} · 现库存 {lineStock(p)}</span></button>)}</div>}</div><div className="span-2 line-editor"><div className="line-editor-head"><h2>明细 ({form.lines.length})</h2><span className="muted">现库存实时显示，价格自动带出</span></div>{form.lines.length ? form.lines.map((line, i) => <article className="line-card" key={line.clientLineId}><div className="line-title"><div><strong>{line.product_name || '未命名货品'}</strong><small>现库存 {lineStock(line)} {line.uom_code || ''}</small></div><button type="button" className="danger-link" onClick={() => setForm(x => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))}>删除</button></div><div className="line-fields"><Field label={cfg.count ? '实盘数量' : '数量'}><input type="number" step="0.001" value={cfg.count ? line.counted_quantity : line.quantity} onChange={e => updateLine(i, cfg.count ? 'counted_quantity' : 'quantity', e.target.value)} /></Field>{cfg.price && <Field label="单价"><input type="number" min="0" step="0.01" value={line.price} onChange={e => updateLine(i, 'price', e.target.value)} /></Field>}<Field label="单位"><select value={line.uom_id || ''} onChange={e => { const v = e.target.value; const u = uoms.find(x => String(x.uom_id) === v); updateLine(i, 'uom_id', v); updateLine(i, 'uom_code', u?.code || '') }}><option value="">跟随货品</option>{uoms.map(u => <option key={u.uom_id} value={u.uom_id}>{u.display_name} ({u.code})</option>)}</select></Field><Field label="备注"><input value={line.notes} onChange={e => updateLine(i, 'notes', e.target.value)} /></Field></div>{line.serialized && <SerialEntry productId={line.product_id} value={line.serial_numbers || ''} onChange={v => updateLine(i, 'serial_numbers', v)} quantity={cfg.count ? line.counted_quantity : line.quantity} />}</article>) : <Empty>还没有添加货品</Empty>}</div></FormSection><ErrorBox error={error} />{error && savedDocument.current?.document_id && <p><Link className="text-link" to={`/${cfg.group}/${docType.toLowerCase()}/${savedDocument.current.document_id}`}>查看已保存草稿 →</Link></p>}<div className="form-actions"><Button className="primary" disabled={busy || !form.lines.length}>{busy ? '保存中…' : '保存草稿'}</Button><Button type="submit" value="submit" className="secondary" disabled={busy || !form.lines.length}>保存并提交</Button><Button type="button" className="secondary" onClick={() => navigate(`/${cfg.group}/${docType.toLowerCase()}`)}>取消</Button></div></form></section>
}

function DocumentEditLoader({ id, user }) {
  // 编辑表单前置校验：与详情页同一判定（创建人/ADMIN 且 DRAFT），无权直接 403
  const { data, error } = useFetchOne(() => api.document(id), [id])
  if (error) return <section><Back to="/" /><ErrorBox error={error} /></section>
  if (!data) return <Loading />
  const editable = data.status === 'DRAFT' && (user.user_id === data.created_by || user.role === 'ADMIN')
  return editable ? <DocumentForm docType={data.doc_type} id={id} user={user} /> : <Forbidden />
}

function DocumentHistory({ id, version }) {
  const { data, error } = useFetchOne(() => api.documentHistory(id), [id, version])
  return <div className="panel"><ErrorBox error={error} />{data ? <Timeline events={data} domain="document" /> : !error && <Loading />}</div>
}

function DocumentDetail({ id, user }) {
  const { navigate, location } = useRouter()
  const { data, error, reload } = useFetchOne(() => api.document(id), [id])
  const [actionError, setActionError] = useState(null)
  const [busy, runBusy] = useBusy()
  const [confirm, setConfirm] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const toast = useToast()
  if (!data) return error ? <section><Back to="/" /><ErrorBox error={error} /></section> : <Loading />
  const cfg = DOC_TYPE_CONFIG[data.doc_type]
  if (!cfg) return <Forbidden />
  const isOwner = user.user_id === data.created_by
  const inPostRoles = can(user, ...cfg.post)
  const canPost = inPostRoles || isOwner
  const canEditThis = data.status === 'DRAFT' && (isOwner || user.role === 'ADMIN')
  const canSubmit = data.status === 'DRAFT' && (isOwner || canCreateDoc(user, data.doc_type))
  const listPath = `/${cfg.group}/${data.doc_type.toLowerCase()}`
  const tab = ['lines', 'attachments', 'ledger', 'history'].includes(location?.hash?.slice(1)) ? location.hash.slice(1) : 'lines'
  const attachAllowed = ['DRAFT', 'SUBMITTED'].includes(data.status) && (isOwner || user.role === 'ADMIN')
  async function run(call, message) {
    return runBusy(async () => { setActionError(null); try { await call(); setConfirm(null); await reload(); toast(message || '操作已完成') } catch (err) { setActionError(err) } })
  }
  async function onFile(event) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { setActionError(new Error('附件不能超过 10MB')); return }
    setUploading(true); setActionError(null); setUploadProgress(null)
    try {
      const isImage = /^image\/(jpeg|png|webp|gif|heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
      const prepared = isImage ? await prepareUploadFile(file) : file
      await api.addAttachment(id, prepared, { onProgress: (loaded, total) => setUploadProgress(total ? Math.round(loaded / total * 100) : 0) })
      await reload(); toast('附件已上传')
    } catch (err) { setActionError(err) } finally { setUploading(false); setUploadProgress(null) }
  }
  return <section><Back to={listPath} /><PageHeading eyebrow={`${DOC_GROUP_LABELS[cfg.group]} / ${cfg.label}`} title={data.doc_no}><div className="actions"><StatusBadge domain="document" value={data.status} />
    {canSubmit && <Button variant="primary" disabled={busy} onClick={() => run(() => api.submitDocument(id), '已提交审批')}>提交审批</Button>}
    {data.status === 'SUBMITTED' && <Button variant={confirm ? 'secondary' : 'primary'} disabled={busy || !canPost} title={!canPost ? '当前角色没有过账权限' : undefined} onClick={() => setConfirm('post')}>过账</Button>}
    {canEditThis && <Button variant="secondary" onClick={() => navigate(`${listPath}/${id}/edit`)}>编辑</Button>}
    {data.status === 'DRAFT' && canPost && <DropdownMenu label="更多"><button onClick={() => setConfirm('post')}>直接过账</button></DropdownMenu>}
    {data.status === 'SUBMITTED' && isOwner && <Button variant="secondary" disabled={busy} onClick={() => run(() => api.withdrawDocument(id), '已撤回草稿')}>撤回</Button>}
    {data.status === 'SUBMITTED' && inPostRoles && <Button variant="danger-quiet" disabled={busy} onClick={() => setConfirm('reject')}>驳回</Button>}
    {data.status === 'POSTED' && inPostRoles && !data.reversal_of_document_id && <Button variant="danger-quiet" disabled={busy} onClick={() => setConfirm('reverse')}>红冲</Button>}
  </div></PageHeading><ErrorBox error={actionError || error} />
  {confirm === 'post' && <ActionConfirm title="确认过账" description={`过账将生效库存与应收应付，之后只能通过红冲纠错。${isOwner && !inPostRoles ? '本次将跳过复核直接过账。' : ''}`} confirmLabel="确认过账" busy={busy} onConfirm={() => run(() => api.postDocument(id, { override_review: isOwner && !inPostRoles }), '单据已过账')} onCancel={() => setConfirm(null)} />}
  {confirm === 'reject' && <ActionConfirm title="驳回单据" description="单据将退回草稿，制单人可根据驳回原因修改后重新提交。" reasonRequired variant="danger" confirmLabel="确认驳回" busy={busy} onConfirm={reason => run(() => api.rejectDocument(id, reason), '已驳回至草稿')} onCancel={() => setConfirm(null)} />}
  {confirm === 'reverse' && <ActionConfirm title="红冲单据" description="红冲将生成反向单据并冲回库存与应收应付，此操作不可逆。" variant="danger" confirmLabel="确认红冲" busy={busy} onConfirm={() => run(() => api.reverseDocument(id), '单据已红冲')} onCancel={() => setConfirm(null)} />}
  <ObjectHeader items={[data.party_name || cfg.label, `¥ ${formatMoney(data.total_amount || 0)}`, `${data.doc_date || '未指定日期'}`, `制单：${data.creator_name || '—'}`]} />
  <div className="stats"><div className="stat"><span>明细</span><strong>{data.lines?.length || 0} 行</strong></div>{Number(data.deposit_amount) > 0 && <div className="stat"><span>预收定金</span><strong>¥ {formatMoney(data.deposit_amount)}</strong></div>}</div>
  <Tabs items={[{ id: 'lines', label: '明细' }, { id: 'attachments', label: '附件' }, { id: 'ledger', label: '应收应付流水' }, { id: 'history', label: '操作历史' }]} value={tab} syncHash />
  {tab === 'lines' && <div className="panel"><div className="detail-lines">{data.lines?.map(line => <div className="detail-line" key={line.document_line_id}><div><strong>{line.product_name}</strong><span>{line.specification || '—'} · {line.uom_display_name || line.uom_code || '—'}{line.source_location_name && ` · 从 ${line.source_location_name}`}{line.destination_location_name && ` · 到 ${line.destination_location_name}`}</span>{line.serial_numbers?.length > 0 && <small>SN：{line.serial_numbers.join('，')}</small>}</div><b className="num">{formatQuantity(line.quantity)} {line.uom_code}{cfg.count && line.counted_quantity != null && ` → 实盘 ${formatQuantity(line.counted_quantity)}`}{line.book_quantity != null && `（账面 ${formatQuantity(line.book_quantity)}）`}{Number(line.price) > 0 && <small>¥ {formatMoney(line.price)} × {formatQuantity(line.quantity)}</small>}</b></div>)}</div>{!data.lines?.length && <Empty>暂无明细，请编辑草稿添加货品。</Empty>}</div>}
  {tab === 'attachments' && <div className="panel">{attachAllowed && <div className="actions"><Field label="上传送货单或发票"><input type="file" onChange={onFile} disabled={uploading} /></Field><span className="muted">{uploading ? '上传中…' : '支持图片和 PDF，最大 10MB'}</span>{uploadProgress !== null && <progress value={uploadProgress} max="100" aria-label="上传进度" />}</div>}{data.attachments?.length ? <div className="record-list">{data.attachments.map(item => <a className="record-card" key={item.attachment_id} href={api.attachmentUrl(item.attachment_id)} download><strong>{item.filename}</strong><small>{Math.round(item.size / 1024)} KB</small></a>)}</div> : <Empty>暂无附件，可在草稿或待审批阶段上传。</Empty>}</div>}
  {tab === 'ledger' && <div className="panel">{data.ar_ap_entries?.length ? <div className="record-list">{data.ar_ap_entries.map(entry => <div className="record-card" key={entry.ar_ap_entry_id}><div><strong>{entry.entry_type === 'DEPOSIT' ? '定金' : '应收 / 应付'}</strong><span>{entry.direction === 'UP' ? '增加' : '冲减'} · {new Date(entry.created_at).toLocaleString()}</span></div><b className="num">{entry.direction === 'UP' ? '+' : '-'} ¥ {formatMoney(entry.amount)}</b></div>)}</div> : <Empty>暂无应收应付流水，相关单据过账后生成。</Empty>}</div>}
  {tab === 'history' && <DocumentHistory id={id} version={data.updated_at || data.status} />}
  {data.status === 'REVERSED' && data.reversal_document && <div className="alert">本单已红冲，反向单据：<Link to={`${listPath}/${data.reversal_document.document_id}`}>{data.reversal_document.doc_no}</Link></div>}
  </section>
}

export function documentRoute(first, parts, user) {
  const group = first
  if (!canView(user, group === 'inventory' ? 'inventoryDocs' : group)) return <Forbidden />
  if (parts.length === 1) return <DocumentList group={group} user={user} />
  const type = (parts[1] || '').toUpperCase()
  if (!DOC_GROUP_TYPES[group]?.includes(type)) return <Forbidden />
  if (parts.length === 2) return <DocumentList docType={type} user={user} />
  if (parts[2] === 'new') return parts.length === 3 && canCreateDoc(user, type) ? <DocumentForm docType={type} user={user} /> : <Forbidden />
  const id = Number(parts[2])
  if (!Number.isSafeInteger(id) || id <= 0) return <Forbidden />
  if (parts.length === 4 && parts[3] === 'edit') return <DocumentEditLoader id={id} user={user} />
  if (parts.length !== 3) return <Forbidden />
  return <DocumentDetail id={id} user={user} />
}
