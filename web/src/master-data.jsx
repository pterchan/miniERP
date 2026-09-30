import React, { useEffect, useMemo, useRef, useState } from 'react'
import api from './api'
import DataTable from './data-table'
import { formatMoney } from './list-utils'
import { DOC_TYPE_CONFIG } from './documents'
import { canEdit, canView } from './roles'
import {
  Back, Button, Drawer, EmptyState, ErrorBox, Field, Forbidden, FormSection, Link, Loading,
  ObjectHeader, PageHeader, StatusBadge, Tabs, confirmDirtyLeave, useBusy, useDirtyLeaveGuard,
  useFetchOne, useRouter, useToast,
} from './ui'

function CategoryTree({ user }) {
  const { data: rows, error, reload } = useFetchOne(() => api.categories(), [])
  const [adding, setAdding] = useState(null)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [busy, runMutation] = useBusy()
  const toast = useToast()
  const isAdmin = canView(user, 'categories')
  function reset() { setAdding(null); setEditing(null); setName('') }
  function save(event) {
    event.preventDefault()
    runMutation(async () => {
      setSaveError(null)
      try {
        if (editing) await api.updateCategory(editing.category_id, { ...editing, name: name.trim() })
        else await api.createCategory({ name: name.trim(), parent_category_id: adding || null, sort_order: 0, is_active: true })
        reset(); await reload(); toast('分类已保存')
      } catch (err) { setSaveError(err) }
    })
  }
  return <section><PageHeader eyebrow="基础资料 / 分类" title="货品分类" description="按业务分类整理货品，便于查找和统计。">{isAdmin && <Button variant="secondary" onClick={reset}>＋ 新增顶级分类</Button>}</PageHeader><div className="panel"><ErrorBox error={error || saveError} />
    {isAdmin && <form onSubmit={save}><FormSection title={editing ? `重命名：${editing.name}` : adding ? `新增子类：${rows?.find(row => row.category_id === adding)?.name || ''}` : '新增顶级分类'}><Field label="分类名称"><input value={name} onChange={e => setName(e.target.value)} required /></Field><div className="actions"><Button type="submit" variant="primary" disabled={busy || !name.trim()}>{editing ? '保存名称' : '新增分类'}</Button><Button type="button" variant="ghost" onClick={reset} disabled={busy}>取消</Button></div></FormSection></form>}
    {!rows ? <Loading /> : rows.length ? <div className="record-list">{rows.map(category => <div className="record-card" key={category.category_id}><div><strong style={{ paddingLeft: category.depth * 16 }}>{category.name}</strong>{!category.is_active && <StatusBadge domain="active" value={false} />}</div>{isAdmin && <div className="actions"><Button variant="secondary" size="sm" onClick={() => { setEditing(null); setAdding(category.category_id); setName('') }}>＋ 子类</Button><Button variant="ghost" size="sm" onClick={() => { setAdding(null); setEditing(category); setName(category.name) }}>改名</Button></div>}</div>)}</div> : <EmptyState title="暂无分类" description="新增顶级分类后，可以继续添加子类。" />}
  </div></section>
}

const PARTY = {
  customers: { singular: '客户', module: '销售', idKey: 'customer_id', balanceKey: 'receivable_balance', balanceLabel: '应收余额', get: id => api.customer(id), list: () => api.customers(), create: data => api.createCustomer(data), update: (id, data) => api.updateCustomer(id, data) },
  suppliers: { singular: '供应商', module: '采购', idKey: 'supplier_id', balanceKey: 'payable_balance', balanceLabel: '应付余额', get: id => api.supplier(id), list: () => api.suppliers(), create: data => api.createSupplier(data), update: (id, data) => api.updateSupplier(id, data) },
}
const overCreditRows = (rows, query) => query.over_credit === 'true' ? rows.filter(row => Number(row.credit_limit) > 0 && Number(row.receivable_balance) > Number(row.credit_limit)) : rows
const CREDIT_QUERY_KEYS = ['over_credit']

function PartyList({ kind, user }) {
  const cfg = PARTY[kind], customer = kind === 'customers'
  const { navigate } = useRouter()
  const { data: rows, loading, error } = useFetchOne(cfg.list, [kind])
  const columns = useMemo(() => [
    { key: 'name', label: '名称', filterType: 'search', searchKeys: ['name', 'contact_person', 'phone', 'address'] },
    { key: 'contact_person', label: '联系人', filterType: 'text', value: row => row.contact_person || '—' },
    { key: 'phone', label: '电话', value: row => row.phone || '—' },
    ...(customer ? [
      { key: 'settlement_method', label: '结算方式', filterType: 'select', filterOptions: [{ value: '现结', label: '现结' }, { value: '月结', label: '月结' }] },
      { key: 'level', label: '等级', value: row => row.level || '—' },
      { key: 'credit_limit', label: '信用上限', align: 'end', value: row => Number(row.credit_limit || 0), render: row => `¥ ${formatMoney(row.credit_limit)}` },
    ] : [{ key: 'settlement_days', label: '账期（天）', align: 'end', value: row => Number(row.settlement_days || 0) }]),
    { key: cfg.balanceKey, label: cfg.balanceLabel, align: 'end', value: row => Number(row[cfg.balanceKey] || 0), render: row => `¥ ${formatMoney(row[cfg.balanceKey])}` },
    { key: 'is_active', label: '状态', filterType: 'select', filterOptions: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }], value: row => row.is_active, render: row => <StatusBadge domain="active" value={row.is_active} /> },
  ], [kind])
  return <section><PageHeader eyebrow={cfg.module} title={`${cfg.singular}档案`} description={`${cfg.singular}联系方式、结算信息与${cfg.balanceLabel}。`}>{canEdit(user, kind) && <Button variant="primary" onClick={() => navigate(`/master/${kind}/new`)}>＋ 新增{cfg.singular}</Button>}</PageHeader><div className="panel"><ErrorBox error={error} /><DataTable tableId={`master.${kind}`} mode="client" columns={columns} rows={rows || []} loading={loading} rowKey={row => String(row[cfg.idKey])} rowHref={row => `/master/${kind}/${row[cfg.idKey]}`} queryKeys={customer ? CREDIT_QUERY_KEYS : undefined} filterRows={customer ? overCreditRows : undefined} toolbar={customer ? ({ query, setQuery }) => <label className="check-field"><input type="checkbox" checked={query.over_credit === 'true'} onChange={e => setQuery('over_credit', e.target.checked ? 'true' : '')} />仅超信用上限</label> : undefined} exportConfig={{ endpoint: `/api/${kind}/export`, filename: cfg.singular, allScope: 'ids' }} empty={<EmptyState title={`暂无${cfg.singular}`} description="调整筛选条件，或新增档案后开始记录往来业务。" />} /></div></section>
}

function partyFormValue(kind, data = {}) {
  const common = { name: data.name || '', contact_person: data.contact_person || '', phone: data.phone || '', address: data.address || '', notes: data.notes || '', is_active: data.is_active ?? true }
  return kind === 'customers' ? { ...common, settlement_method: data.settlement_method || '现结', level: data.level || '', credit_limit: data.credit_limit != null ? String(data.credit_limit) : '' } : { ...common, settlement_days: data.settlement_days != null ? String(data.settlement_days) : '' }
}

/** 完整编辑页和抽屉使用同一表单、校验与保存逻辑。 */
function PartyEditor({ kind, id, initialData, embedded = false, onSaved, onCancel, onDirtyChange }) {
  const cfg = PARTY[kind], customer = kind === 'customers'
  const [form, setForm] = useState(() => partyFormValue(kind, initialData))
  const baseline = useRef(JSON.stringify(form))
  const dirty = JSON.stringify(form) !== baseline.current
  useDirtyLeaveGuard(!embedded && dirty)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  const [error, setError] = useState(null)
  const [busy, runSave] = useBusy()
  const toast = useToast()
  function patch(key, value) { setForm(current => ({ ...current, [key]: value })) }
  function save(event) {
    event.preventDefault()
    runSave(async () => {
      setError(null)
      try {
        const payload = { ...form, name: form.name.trim(), ...(customer ? { credit_limit: Number(form.credit_limit) || 0 } : { settlement_days: Number(form.settlement_days) || 0 }) }
        if (!payload.name) throw new Error(`请填写${cfg.singular}名称`)
        const result = id ? await cfg.update(id, payload) : await cfg.create(payload)
        baseline.current = JSON.stringify(form)
        onDirtyChange?.(false)
        toast(`${cfg.singular}已保存`)
        await onSaved(result || { [cfg.idKey]: id })
      } catch (err) { setError(err) }
    })
  }
  return <form className={embedded ? 'party-editor' : 'panel party-editor'} onSubmit={save}>
    <FormSection title="基本信息" description="填写名称和常用联系方式。"><Field label={`${cfg.singular}名称`}><input required value={form.name} onChange={e => patch('name', e.target.value)} /></Field><Field label="联系人"><input value={form.contact_person} onChange={e => patch('contact_person', e.target.value)} /></Field><Field label="电话"><input type="tel" value={form.phone} onChange={e => patch('phone', e.target.value)} /></Field><Field label="地址"><input value={form.address} onChange={e => patch('address', e.target.value)} /></Field></FormSection>
    <FormSection title="结算信息" description={customer ? '信用上限用于风险提示，不阻止业务过账。' : '按约定付款周期填写账期。'}>{customer ? <><Field label="结算方式"><select value={form.settlement_method} onChange={e => patch('settlement_method', e.target.value)}><option value="现结">现结</option><option value="月结">月结</option></select></Field><Field label="客户等级"><input value={form.level} onChange={e => patch('level', e.target.value)} placeholder="如：A/B/C" /></Field><Field label="欠款上限（¥）"><input type="number" min="0" step="0.01" value={form.credit_limit} onChange={e => patch('credit_limit', e.target.value)} /></Field></> : <Field label="结算账期（天）"><input type="number" min="0" step="1" value={form.settlement_days} onChange={e => patch('settlement_days', e.target.value)} /></Field>}</FormSection>
    <FormSection title="其他信息"><Field label="备注" className="span-2"><textarea rows="3" value={form.notes} onChange={e => patch('notes', e.target.value)} /></Field>{id && <label className="check-field span-2"><input type="checkbox" checked={form.is_active} onChange={e => patch('is_active', e.target.checked)} />启用</label>}</FormSection>
    <ErrorBox error={error} /><div className="form-actions"><Button type="submit" variant="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { if (!embedded || confirmDirtyLeave()) onCancel() }}>取消</Button></div>
  </form>
}

function PartyForm({ kind, id }) {
  const cfg = PARTY[kind]
  const { navigate } = useRouter()
  const { data, error } = useFetchOne(() => id ? cfg.get(id) : Promise.resolve({}), [kind, id])
  if (!data) return error ? <section><Back to={`/master/${kind}`} /><ErrorBox error={error} /></section> : <Loading />
  return <section><Back to={`/master/${kind}`} /><PageHeader eyebrow={`${cfg.module} / ${cfg.singular}档案`} title={`${id ? '编辑' : '新增'}${cfg.singular}`} /><PartyEditor key={`${kind}:${id || 'new'}`} kind={kind} id={id} initialData={data} onSaved={result => navigate(`/master/${kind}/${result[cfg.idKey] || id}`, { skipGuard: true })} onCancel={() => navigate(`/master/${kind}`)} /></section>
}

function transactionHref(row, user) {
  const cfg = DOC_TYPE_CONFIG[row.doc_type]
  if (!cfg || !row.document_id || !canView(user, cfg.group === 'inventory' ? 'inventoryDocs' : cfg.group)) return undefined
  return `/${cfg.group}/${row.doc_type.toLowerCase()}/${row.document_id}`
}

function PartyDetail({ kind, id, user }) {
  const cfg = PARTY[kind], customer = kind === 'customers'
  const router = useRouter()
  const { data, error, reload } = useFetchOne(() => cfg.get(id), [kind, id])
  const hash = router.location?.hash || ''
  const [tab, setTab] = useState(() => hash.slice(1) || 'profile')
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { setTab(hash.slice(1) || 'profile') }, [hash])
  const columns = useMemo(() => [
    { key: 'doc_no', label: '单号', filterType: 'text' },
    { key: 'doc_type', label: '单据类型', value: row => DOC_TYPE_CONFIG[row.doc_type]?.label || '业务单据' },
    { key: 'doc_date', label: '日期', value: row => row.doc_date?.slice(0, 10) || '—' },
    { key: 'entry_type', label: '交易内容', value: row => row.entry_type === 'DEPOSIT' ? '定金' : customer ? '应收' : '应付' },
    { key: 'amount', label: '金额', align: 'end', value: row => (row.direction === 'UP' ? 1 : -1) * Number(row.amount || 0), render: row => `${row.direction === 'UP' ? '+' : '-'} ¥ ${formatMoney(row.amount)}` },
  ], [customer])
  if (!data) return error ? <section><Back to={`/master/${kind}`} /><ErrorBox error={error} /></section> : <Loading />
  const tabs = [{ id: 'profile', label: '档案' }, { id: 'history', label: '历史交易' }, ...(!customer ? [{ id: 'products', label: '供货货品' }] : [])]
  const activeTab = tabs.some(item => item.id === tab) ? tab : 'profile'
  const close = () => { setEditing(false); setDirty(false) }
  return <section><Back to={`/master/${kind}`} /><PageHeader eyebrow={`${cfg.module} / ${cfg.singular}档案`} title={data.name} status={<StatusBadge domain="active" value={data.is_active} />}>{canEdit(user, kind) && <><Button variant="primary" onClick={() => setEditing(true)}>快速编辑</Button><Link className="button secondary" to={`/master/${kind}/${id}/edit`}>完整编辑</Link></>}</PageHeader><ErrorBox error={error} />
    <ObjectHeader title={data.contact_person || '尚未填写联系人'} subtitle={data.phone || '尚未填写电话'} items={[{ label: cfg.balanceLabel, value: `¥ ${formatMoney(data[cfg.balanceKey])}` }, { label: customer ? '信用上限' : '采购均价', value: `¥ ${formatMoney(customer ? data.credit_limit : data.avg_price)}` }, { label: customer ? '结算方式' : '结算账期', value: customer ? data.settlement_method : `${data.settlement_days || 0} 天` }]} />
    <Tabs items={tabs} value={activeTab} onChange={setTab} syncHash />
    {activeTab === 'profile' && <div className="panel"><h2>档案信息</h2><dl className="detail-list"><dt>联系人</dt><dd>{data.contact_person || '—'}</dd><dt>电话</dt><dd>{data.phone || '—'}</dd><dt>地址</dt><dd>{data.address || '—'}</dd>{customer && <><dt>等级</dt><dd>{data.level || '—'}</dd></>}<dt>备注</dt><dd>{data.notes || '—'}</dd></dl></div>}
    {activeTab === 'history' && <div className="panel"><div className="panel-head"><h2>历史交易</h2><p className="muted">最近 50 条；筛选与排序仅覆盖这些记录。</p></div><DataTable tableId={`master.${kind}.history`} mode="client" columns={columns} rows={data.history || []} rowKey={row => String(row.ar_ap_entry_id)} rowHref={row => transactionHref(row, user)} selectable={false} empty={<EmptyState title="暂无历史交易" description="往来单据过账后，相关交易会显示在这里。" />} /></div>}
    {activeTab === 'products' && <div className="panel"><h2>供货货品</h2>{data.supplied_products?.length ? <div className="record-list">{data.supplied_products.map(product => <Link className="record-card" key={product.product_id} to={`/products/${product.product_id}`}><strong>{product.display_name}</strong><span>查看货品 →</span></Link>)}</div> : <EmptyState title="暂无供货记录" description="采购入库后，这里会显示关联货品。" />}</div>}
    {canEdit(user, kind) && <Drawer open={editing} title={`编辑${cfg.singular}：${data.name}`} onClose={close} dirty={dirty}>{editing && <PartyEditor kind={kind} id={id} initialData={data} embedded onDirtyChange={setDirty} onCancel={close} onSaved={async () => { close(); await reload() }} />}</Drawer>}
  </section>
}

export function masterRoute(first, parts, query, user) {
  const kind = parts[1], id = parts[2], sub = parts[3]
  if (kind === 'categories') return canView(user, 'categories') ? <CategoryTree user={user} /> : <Forbidden />
  if (!PARTY[kind] || !canView(user, kind)) return <Forbidden />
  if (id === 'new') return canEdit(user, kind) ? <PartyForm kind={kind} /> : <Forbidden />
  if (sub === 'edit') return canEdit(user, kind) ? <PartyForm kind={kind} id={id} /> : <Forbidden />
  if (id) return <PartyDetail kind={kind} id={id} user={user} />
  return <PartyList kind={kind} user={user} />
}
