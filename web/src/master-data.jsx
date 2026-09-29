import React, { useEffect, useMemo, useRef, useState } from 'react'
import api from './api'
import DataTable from './data-table'
import { formatMoney, formatQuantity } from './list-utils'
import { canEdit, canView } from './roles'
import { useBusy } from './ui'
import {
  Back, Badge, Button, Empty, ErrorBox, Field, Forbidden, Link, Loading,
  PageHeading, useDirtyLeaveGuard, useRouter,
} from './ui'

function CategoryTree({ user }) {
  const { navigate } = useRouter()
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(null)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState(null)
  const reload = () => api.categories().then(setRows).catch(setError)
  useEffect(() => { reload() }, [])
  const isAdmin = canView(user, 'categories')
  const [busy, runMutation] = useBusy()
  function create(e) { e.preventDefault(); runMutation(async () => { setError(null); try { await api.createCategory({ name, parent_category_id: adding || null, sort_order: 0, is_active: true }); setName(''); setAdding(null); reload() } catch (err) { setError(err) } }) }
  function update(category) { runMutation(async () => { setError(null); try { await api.updateCategory(category.category_id, { ...category, name }); setEditing(null); setName(''); reload() } catch (err) { setError(err) } }) }
  return <section><PageHeading eyebrow="主数据" title="商品分类" description="树形分类管理，用于货品归类和报表筛选。">{isAdmin && <Button className="primary" onClick={() => setAdding(null)}>＋ 新增顶级分类</Button>}</PageHeading><div className="panel"><ErrorBox error={error} />{isAdmin && <form className="picker-row" style={{ marginBottom: 10 }} onSubmit={create}><input value={name} onChange={e => setName(e.target.value)} placeholder="分类名称" required /><Button className="primary" disabled={busy}>新增</Button><Button type="button" className="secondary" onClick={() => { setAdding(null); setName('') }}>取消</Button></form>}{rows.length ? <div className="record-list">{rows.map(c => <div className="record-card" key={c.category_id}><div><strong style={{ paddingLeft: c.depth * 16 }}>{c.name}</strong><span>深度 {c.depth}{c.is_active ? '' : ' · 停用'}</span></div><div className="actions">{isAdmin && <Button className="secondary" onClick={() => setAdding(c.category_id)}>＋ 子类</Button>}{isAdmin && <Button className="secondary" onClick={() => { setEditing(c); setName(c.name) }}>改名</Button>}</div></div>)}</div> : <Empty>暂无分类</Empty>}{editing && <form className="picker-row" style={{ marginTop: 10 }} onSubmit={e => { e.preventDefault(); update(editing) }}><input value={name} onChange={e => setName(e.target.value)} placeholder="新名称" required /><Button className="primary" disabled={busy}>保存</Button><Button type="button" className="secondary" onClick={() => setEditing(null)}>取消</Button></form>}</div></section>
}

function CustomerList({ user }) {
  const { navigate } = useRouter()
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  useEffect(() => { api.customers().then(setRows).catch(setError) }, [])
  const columns = useMemo(() => [
    { key: 'name', label: '名称', filterType: 'search', searchKeys: ['name', 'contact_person', 'phone', 'address'] },
    { key: 'contact_person', label: '联系人', filterType: 'text', value: r => r.contact_person || '—' },
    { key: 'phone', label: '电话', value: r => r.phone || '—' },
    { key: 'settlement_method', label: '结算方式', filterType: 'select', filterOptions: [{ value: '现结', label: '现结' }, { value: '月结', label: '月结' }] },
    { key: 'level', label: '等级', value: r => r.level || '—' },
    { key: 'credit_limit', label: '信用上限', align: 'end', value: r => `¥ ${formatMoney(r.credit_limit)}` },
    { key: 'receivable_balance', label: '应收', align: 'end', value: r => `¥ ${formatMoney(r.receivable_balance)}` },
    { key: 'is_active', label: '状态', filterType: 'select', filterOptions: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }], value: r => r.is_active, render: r => r.is_active ? '启用' : '停用' },
  ], [])
  return <section><PageHeading eyebrow="销售" title="客户档案" description="客户名称、联系人、结算方式、等级、欠款上限与应收余额。">{canEdit(user, 'customers') && <Button className="primary" onClick={() => navigate('/master/customers/new')}>＋ 新增客户</Button>}</PageHeading><div className="panel"><ErrorBox error={error} /><DataTable mode="client" columns={columns} rows={rows} rowKey={c => String(c.customer_id)} rowHref={c => `/master/customers/${c.customer_id}`} exportConfig={{ endpoint: '/api/customers/export', filename: '客户', allScope: 'ids' }} /></div></section>
}

function CustomerForm({ id, user }) {
  const { navigate } = useRouter()
  const [form, setForm] = useState({ name: '', contact_person: '', phone: '', address: '', settlement_method: '现结', level: '', credit_limit: '', notes: '', is_active: true })
  const baseline = useRef(JSON.stringify(form))
  const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form])
  useDirtyLeaveGuard(dirty)
  const [error, setError] = useState(null)
  useEffect(() => { if (id) api.customer(id).then(x => { const next = { name: x.name, contact_person: x.contact_person || '', phone: x.phone || '', address: x.address || '', settlement_method: x.settlement_method, level: x.level || '', credit_limit: x.credit_limit != null ? String(x.credit_limit) : '', notes: x.notes || '', is_active: x.is_active }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id])
  function patch(k, v) { setForm(x => ({ ...x, [k]: v })) }
  const [busy, runSave] = useBusy()
  function save(e) { e.preventDefault(); runSave(async () => { setError(null); try { const payload = { ...form, credit_limit: Number(form.credit_limit) || 0 }; const r = id ? await api.updateCustomer(id, payload) : await api.createCustomer(payload); navigate(`/master/customers/${r.customer_id || id}`) } catch (err) { setError(err) } }) }
  return <section><Back to="/master/customers" /><PageHeading eyebrow="销售" title={id ? '编辑客户' : '新增客户'} description="结算方式：现结 / 月结；欠款上限用于风险提示。" /><form className="panel form-grid" onSubmit={save}><Field label="客户名称"><input required value={form.name} onChange={e => patch('name', e.target.value)} /></Field><Field label="联系人"><input value={form.contact_person} onChange={e => patch('contact_person', e.target.value)} /></Field><Field label="电话"><input value={form.phone} onChange={e => patch('phone', e.target.value)} /></Field><Field label="地址"><input value={form.address} onChange={e => patch('address', e.target.value)} /></Field><Field label="结算方式"><select value={form.settlement_method} onChange={e => patch('settlement_method', e.target.value)}><option value="现结">现结</option><option value="月结">月结</option></select></Field><Field label="客户等级"><input value={form.level} onChange={e => patch('level', e.target.value)} placeholder="如：A/B/C" /></Field><Field label="欠款上限（¥）"><input type="number" min="0" step="0.01" value={form.credit_limit} onChange={e => patch('credit_limit', e.target.value)} /></Field><Field label="备注"><input value={form.notes} onChange={e => patch('notes', e.target.value)} /></Field>{id && <label className="check-field span-2"><input type="checkbox" checked={form.is_active} onChange={e => patch('is_active', e.target.checked)} /> 启用</label>}<ErrorBox error={error} /><div className="span-2 actions"><Button className="primary">保存</Button><Button type="button" className="secondary" onClick={() => navigate('/master/customers')}>取消</Button></div></form></section>
}

function CustomerDetail({ id, user }) {
  const { navigate } = useRouter()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => { api.customer(id).then(setData).catch(setError) }, [id])
  if (!data) return error ? <section><Back to="/master/customers" /><ErrorBox error={error} /></section> : <Loading />
  return <section><Back to="/master/customers" /><PageHeading eyebrow="销售" title={data.name}><Button className="primary" onClick={() => navigate(`/master/customers/${id}/edit`)}>编辑</Button></PageHeading><div className="stats"><div className="stat teal"><span>应收余额</span><strong>¥ {formatMoney(data.receivable_balance)}</strong></div><div className="stat"><span>欠款上限</span><strong>¥ {formatMoney(data.credit_limit)}</strong></div><div className="stat"><span>结算方式</span><strong>{data.settlement_method}</strong></div></div><div className="panel"><h2>档案</h2><dl className="detail-list"><dt>联系人</dt><dd>{data.contact_person || '—'}</dd><dt>电话</dt><dd>{data.phone || '—'}</dd><dt>地址</dt><dd>{data.address || '—'}</dd><dt>等级</dt><dd>{data.level || '—'}</dd><dt>备注</dt><dd>{data.notes || '—'}</dd></dl></div><div className="panel"><h2>历史交易</h2>{data.history?.length ? <div className="record-list">{data.history.map(h => <div className="record-card" key={h.ar_ap_entry_id}><div><strong>{h.doc_no}</strong><span>{h.doc_type} · {h.entry_type === 'DEPOSIT' ? '定金' : '应收'} · {h.doc_date || '—'}</span></div><div className="record-value"><b>{h.direction === 'UP' ? '+' : '-'} ¥ {formatMoney(h.amount)}</b></div></div>)}</div> : <Empty>暂无交易</Empty>}</div></section>
}

function SupplierList({ user }) {
  const { navigate } = useRouter()
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  useEffect(() => { api.suppliers().then(setRows).catch(setError) }, [])
  const columns = useMemo(() => [
    { key: 'name', label: '名称', filterType: 'search', searchKeys: ['name', 'contact_person', 'phone', 'address'] },
    { key: 'contact_person', label: '联系人', filterType: 'text', value: r => r.contact_person || '—' },
    { key: 'phone', label: '电话', value: r => r.phone || '—' },
    { key: 'settlement_days', label: '账期（天）', align: 'end', value: r => r.settlement_days != null ? r.settlement_days : '—' },
    { key: 'payable_balance', label: '应付', align: 'end', value: r => `¥ ${formatMoney(r.payable_balance)}` },
    { key: 'is_active', label: '状态', filterType: 'select', filterOptions: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }], value: r => r.is_active, render: r => r.is_active ? '启用' : '停用' },
  ], [])
  return <section><PageHeading eyebrow="采购" title="供应商档案" description="供应商联系方式、账期、采购均价与应付余额。">{canEdit(user, 'suppliers') && <Button className="primary" onClick={() => navigate('/master/suppliers/new')}>＋ 新增供应商</Button>}</PageHeading><div className="panel"><ErrorBox error={error} /><DataTable mode="client" columns={columns} rows={rows} rowKey={s => String(s.supplier_id)} rowHref={s => `/master/suppliers/${s.supplier_id}`} exportConfig={{ endpoint: '/api/suppliers/export', filename: '供应商', allScope: 'ids' }} /></div></section>
}

function SupplierForm({ id, user }) {
  const { navigate } = useRouter()
  const [form, setForm] = useState({ name: '', contact_person: '', phone: '', address: '', settlement_days: '', notes: '', is_active: true })
  const baseline = useRef(JSON.stringify(form))
  const dirty = useMemo(() => JSON.stringify(form) !== baseline.current, [form])
  useDirtyLeaveGuard(dirty)
  const [error, setError] = useState(null)
  useEffect(() => { if (id) api.supplier(id).then(x => { const next = { name: x.name, contact_person: x.contact_person || '', phone: x.phone || '', address: x.address || '', settlement_days: x.settlement_days != null ? String(x.settlement_days) : '', notes: x.notes || '', is_active: x.is_active }; baseline.current = JSON.stringify(next); setForm(next) }).catch(setError) }, [id])
  function patch(k, v) { setForm(x => ({ ...x, [k]: v })) }
  const [busy, runSave] = useBusy()
  function save(e) { e.preventDefault(); runSave(async () => { setError(null); try { const payload = { ...form, settlement_days: Number(form.settlement_days) || 0 }; const r = id ? await api.updateSupplier(id, payload) : await api.createSupplier(payload); navigate(`/master/suppliers/${r.supplier_id || id}`) } catch (err) { setError(err) } }) }
  return <section><Back to="/master/suppliers" /><PageHeading eyebrow="采购" title={id ? '编辑供应商' : '新增供应商'} description="结算账期：付款周期天数（天）。" /><form className="panel form-grid" onSubmit={save}><Field label="供应商名称"><input required value={form.name} onChange={e => patch('name', e.target.value)} /></Field><Field label="联系人"><input value={form.contact_person} onChange={e => patch('contact_person', e.target.value)} /></Field><Field label="电话"><input value={form.phone} onChange={e => patch('phone', e.target.value)} /></Field><Field label="地址"><input value={form.address} onChange={e => patch('address', e.target.value)} /></Field><Field label="结算账期（天）"><input type="number" min="0" value={form.settlement_days} onChange={e => patch('settlement_days', e.target.value)} /></Field><Field label="备注"><input value={form.notes} onChange={e => patch('notes', e.target.value)} /></Field>{id && <label className="check-field span-2"><input type="checkbox" checked={form.is_active} onChange={e => patch('is_active', e.target.checked)} /> 启用</label>}<ErrorBox error={error} /><div className="span-2 actions"><Button className="primary">保存</Button><Button type="button" className="secondary" onClick={() => navigate('/master/suppliers')}>取消</Button></div></form></section>
}

function SupplierDetail({ id, user }) {
  const { navigate } = useRouter()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => { api.supplier(id).then(setData).catch(setError) }, [id])
  if (!data) return error ? <section><Back to="/master/suppliers" /><ErrorBox error={error} /></section> : <Loading />
  return <section><Back to="/master/suppliers" /><PageHeading eyebrow="采购" title={data.name}><Button className="primary" onClick={() => navigate(`/master/suppliers/${id}/edit`)}>编辑</Button></PageHeading><div className="stats"><div className="stat teal"><span>应付余额</span><strong>¥ {formatMoney(data.payable_balance)}</strong></div><div className="stat"><span>采购均价</span><strong>¥ {formatMoney(data.avg_price)}</strong></div><div className="stat"><span>账期</span><strong>{data.settlement_days} 天</strong></div></div><div className="panel"><h2>档案</h2><dl className="detail-list"><dt>联系人</dt><dd>{data.contact_person || '—'}</dd><dt>电话</dt><dd>{data.phone || '—'}</dd><dt>地址</dt><dd>{data.address || '—'}</dd><dt>备注</dt><dd>{data.notes || '—'}</dd></dl></div><div className="panel"><h2>供货商品</h2>{data.supplied_products?.length ? <div className="tag-list">{data.supplied_products.map(p => <Badge key={p.product_id}>{p.display_name}</Badge>)}</div> : <Empty>暂无供货记录</Empty>}</div><div className="panel"><h2>历史交易</h2>{data.history?.length ? <div className="record-list">{data.history.map(h => <div className="record-card" key={h.ar_ap_entry_id}><div><strong>{h.doc_no}</strong><span>{h.doc_type} · {h.entry_type === 'DEPOSIT' ? '定金' : '应付'} · {h.doc_date || '—'}</span></div><div className="record-value"><b>{h.direction === 'UP' ? '+' : '-'} ¥ {formatMoney(h.amount)}</b></div></div>)}</div> : <Empty>暂无交易</Empty>}</div></section>
}

export function masterRoute(first, parts, query, user) {
  const kind = parts[1]
  const id = parts[2]
  const sub = parts[3]
  if (kind === 'categories') return canView(user, 'categories') ? <CategoryTree user={user} /> : <Forbidden />
  if (kind === 'customers') {
    if (!canView(user, 'customers')) return <Forbidden />
    if (id === 'new') return canEdit(user, 'customers') ? <CustomerForm user={user} /> : <Forbidden />
    if (sub === 'edit') return canEdit(user, 'customers') ? <CustomerForm id={id} user={user} /> : <Forbidden />
    if (id) return <CustomerDetail id={id} user={user} />
    return <CustomerList user={user} />
  }
  if (kind === 'suppliers') {
    if (!canView(user, 'suppliers')) return <Forbidden />
    if (id === 'new') return canEdit(user, 'suppliers') ? <SupplierForm user={user} /> : <Forbidden />
    if (sub === 'edit') return canEdit(user, 'suppliers') ? <SupplierForm id={id} user={user} /> : <Forbidden />
    if (id) return <SupplierDetail id={id} user={user} />
    return <SupplierList user={user} />
  }
  return <Forbidden />
}
