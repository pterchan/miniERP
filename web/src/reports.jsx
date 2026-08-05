import React, { useEffect, useState } from 'react'
import api from './api'
import { formatMoney, formatQuantity } from './list-utils'
import { canView } from './roles'
import { Back, Empty, ErrorBox, Field, Forbidden, Loading, PageHeading } from './ui'

function PurchaseReconciliation() {
  const [rows, setRows] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [supplierId, setSupplierId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [error, setError] = useState(null)
  const load = () => api.reports.purchase({ supplier_id: supplierId, start_date: startDate, end_date: endDate }).then(r => setRows(r.rows || [])).catch(setError)
  useEffect(() => { api.suppliers().then(setSuppliers).catch(() => {}); load() }, [])
  const total = rows.reduce((sum, r) => sum + Number(r.total_amount || 0), 0)
  return <section><PageHeading eyebrow="财务" title="采购对账" description="按供应商汇总本期已过账采购入库金额。" /><div className="panel"><div className="actions"><Field label="供应商"><select value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">全部</option>{suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.name}</option>)}</select></Field><Field label="开始日期"><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></Field><Field label="结束日期"><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></Field><button className="primary" onClick={load}>查询</button></div><ErrorBox error={error} />{rows.length ? <div className="record-list">{rows.map(r => <div className="record-card" key={`${r.doc_no}-${r.document_id || r.doc_date}`}><div><strong>{r.supplier_name}</strong><span>{r.doc_no} · {r.doc_date} · 过账 {r.posted_by || '—'}</span></div><div className="record-value"><b>¥ {formatMoney(r.total_amount)}</b></div></div>)}</div> : <Empty>暂无数据</Empty>}<div className="actions" style={{ marginTop: 8 }}><strong>合计：¥ {formatMoney(total)}</strong></div></div></section>
}

function ArApSummary() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => { api.reports.arAp().then(setData).catch(setError) }, [])
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />
  return <section><PageHeading eyebrow="财务" title="应收应付汇总" description="各客户应收余额、各供应商应付余额。" /><div className="detail-grid"><div className="panel"><h2>应收（客户）</h2>{data.customers?.length ? <div className="record-list">{data.customers.map(c => <div className="record-card" key={c.customer_id}><div><strong>{c.name}</strong></div><div className="record-value"><b>¥ {formatMoney(c.receivable_balance)}</b></div></div>)}</div> : <Empty>暂无客户</Empty>}</div><div className="panel"><h2>应付（供应商）</h2>{data.suppliers?.length ? <div className="record-list">{data.suppliers.map(s => <div className="record-card" key={s.supplier_id}><div><strong>{s.name}</strong></div><div className="record-value"><b>¥ {formatMoney(s.payable_balance)}</b></div></div>)}</div> : <Empty>暂无供应商</Empty>}</div></div></section>
}

function LedgerDetail({ kind }) {
  const [rows, setRows] = useState([])
  const [parties, setParties] = useState([])
  const [partyId, setPartyId] = useState('')
  const [error, setError] = useState(null)
  const load = () => (kind === 'receivables' ? api.reports.receivables(partyId || undefined) : api.reports.payables(partyId || undefined)).then(setRows).catch(setError)
  useEffect(() => { (kind === 'receivables' ? api.customers() : api.suppliers()).then(setParties).catch(() => {}); load() }, [kind])
  const title = kind === 'receivables' ? '应收明细' : '应付明细'
  const partyKey = kind === 'receivables' ? 'customer_id' : 'supplier_id'
  return <section><Back to="/reports/arap" /><PageHeading eyebrow="财务" title={title} description="应收/应付台账明细（含定金）。" /><div className="panel"><div className="actions"><Field label={kind === 'receivables' ? '客户' : '供应商'}><select value={partyId} onChange={e => setPartyId(e.target.value)}><option value="">全部</option>{parties.map(p => <option key={p[partyKey]} value={p[partyKey]}>{p.name}</option>)}</select></Field><button className="primary" onClick={load}>查询</button></div><ErrorBox error={error} />{rows.length ? <div className="record-list">{rows.map(r => <div className="record-card" key={r.ar_ap_entry_id}><div><strong>{r.party_name || '—'}</strong><span>{r.doc_no} · {r.doc_date || '—'} · {r.entry_type === 'DEPOSIT' ? '定金' : '账期'} · {new Date(r.created_at).toLocaleString()}</span></div><div className="record-value"><b>{r.direction === 'UP' ? '+' : '-'} ¥ {formatMoney(r.amount)}</b></div></div>)}</div> : <Empty>暂无明细</Empty>}</div></section>
}

function InventoryCost() {
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  useEffect(() => { api.reports.inventoryCost().then(setRows).catch(setError) }, [])
  const total = rows.reduce((sum, r) => sum + Number(r.cost_value || 0), 0)
  return <section><PageHeading eyebrow="财务" title="库存成本汇总" description="按货品×单位：现库存 × 采购成本价 = 库存成本。" /><div className="panel"><ErrorBox error={error} />{rows.length ? <div className="record-list">{rows.map(r => <div className="record-card" key={`${r.product_id}-${r.uom_id}`}><div><strong>{r.product_name}</strong><span>{r.uom_code} · 现库存 {formatQuantity(r.on_hand_quantity)}</span></div><div className="record-value"><b>¥ {formatMoney(r.cost_value)}</b><small>单价 ¥ {formatMoney(r.cost_price)}</small></div></div>)}</div> : <Empty>暂无库存</Empty>}<div className="actions" style={{ marginTop: 8 }}><strong>合计：¥ {formatMoney(total)}</strong></div></div></section>
}

export function reportRoute(first, parts, query, user) {
  if (!canView(user, 'reports')) return <Forbidden />
  const page = parts[1]
  if (page === 'purchase') return <PurchaseReconciliation />
  if (page === 'arap') return <ArApSummary />
  if (page === 'receivables') return <LedgerDetail kind="receivables" />
  if (page === 'payables') return <LedgerDetail kind="payables" />
  if (page === 'inventory-cost') return <InventoryCost />
  return <Forbidden />
}
