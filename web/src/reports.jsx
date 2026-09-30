import React, { useCallback, useEffect, useMemo, useState } from 'react'
import api from './api'
import DataTable from './data-table'
import { DOC_TYPE_CONFIG } from './documents'
import { formatMoney, formatQuantity } from './list-utils'
import { canView } from './roles'
import { Back, ErrorBox, Field, Forbidden, Link, PageHeading, Tabs, useRouter } from './ui'

const DATE_QUERY = ['start_date', 'end_date']
const PURCHASE_QUERY = ['supplier_id', ...DATE_QUERY]
const LEDGER_QUERY = ['party_id', ...DATE_QUERY]
const moneyColumn = (key, label) => ({ key, label, align: 'end', render: row => `¥ ${formatMoney(row[key])}` })

// 财务可以读取台账，但来源单据的下钻仍遵守对应业务模块权限。
function documentHref(row, user) {
  const cfg = DOC_TYPE_CONFIG[row.doc_type]
  const permission = cfg?.group === 'inventory' ? 'inventoryDocs' : cfg?.group
  return row.document_id && cfg && canView(user, permission) ? `/${cfg.group}/${row.doc_type.toLowerCase()}/${row.document_id}` : undefined
}

function DateFilters({ query, setQuery }) {
  return <><Field label="开始日期"><input type="date" value={query.start_date || ''} onChange={event => setQuery('start_date', event.target.value)} /></Field><Field label="结束日期"><input type="date" value={query.end_date || ''} onChange={event => setQuery('end_date', event.target.value)} /></Field></>
}
function Summary({ data, fields }) {
  if (!data?.summary) return null
  return <div className="actions"><span className="muted">当前筛选全部合计</span>{fields.map(([key, label]) => <strong className="num" key={key}>{label}：¥ {formatMoney(data.summary[key])}</strong>)}</div>
}

function PurchaseReconciliation({ user }) {
  const [suppliers, setSuppliers] = useState([])
  const [error, setError] = useState(null)
  useEffect(() => { let active = true; api.suppliers().then(data => { if (active) setSuppliers(data) }).catch(err => { if (active) setError(err) }); return () => { active = false } }, [])
  const fetchData = useCallback((params, signal) => api.reports.purchase({ ...params, paginated: true, signal }), [])
  const columns = useMemo(() => [
    { key: 'supplier_name', label: '供应商', filterType: 'search', searchKeys: ['supplier_name', 'doc_no'] },
    { key: 'doc_no', label: '单号', filterType: 'text' },
    { key: 'doc_date', label: '单据日期', className: 'nowrap' }, moneyColumn('total_amount', '金额'),
    { key: 'posted_by', label: '过账人', filterType: 'text' },
  ], [])
  return <section><PageHeading eyebrow="财务" title="采购对账" description="按供应商查询已过账采购入库，合计覆盖当前筛选的全部记录。" /><div className="panel"><ErrorBox error={error} /><DataTable tableId="reports.purchase" mode="server" columns={columns} fetchData={fetchData} rowKey={row => String(row.document_id)} rowHref={row => documentHref(row, user)} queryKeys={PURCHASE_QUERY}
    toolbar={({ query, setQuery }) => <div className="actions"><Field label="供应商"><select value={query.supplier_id || ''} onChange={event => setQuery('supplier_id', event.target.value)}><option value="">全部</option>{suppliers.map(supplier => <option key={supplier.supplier_id} value={supplier.supplier_id}>{supplier.name}</option>)}</select></Field><DateFilters query={query} setQuery={setQuery} /></div>}
    exportConfig={{ endpoint: '/api/reports/purchase-reconciliation', allScope: 'server' }} footer={data => <Summary data={data} fields={[[ 'total_amount', '采购金额' ]]} />} /></div></section>
}

function ArApSummary() {
  const { location, currentPath = '' } = useRouter()
  const params = new URLSearchParams(location?.search ?? currentPath.split('?')[1] ?? '')
  const partyType = params.get('party_type') === 'supplier' ? 'supplier' : 'customer'
  const customer = partyType === 'customer'
  const partyKey = customer ? 'customer_id' : 'supplier_id'
  const balanceKey = customer ? 'receivable_balance' : 'payable_balance'
  const balanceLabel = customer ? '应收余额' : '应付余额'
  const fetchData = useCallback((query, signal) => api.reports.arAp({ ...query, party_type: partyType, paginated: true, signal }), [partyType])
  const columns = useMemo(() => [{ key: 'name', label: customer ? '客户' : '供应商', filterType: 'search' }, moneyColumn(balanceKey, balanceLabel)], [customer, balanceKey, balanceLabel])
  return <section><PageHeading eyebrow="财务" title="应收应付汇总" description="按往来方查看余额，点击记录查看档案与最近交易。"><Link className="button-link secondary" to={`/reports/${customer ? 'receivables' : 'payables'}`}>查看{customer ? '应收' : '应付'}明细</Link></PageHeading><Tabs label="应收应付分类" value={partyType} items={[{ id: 'customer', label: '应收（客户）', to: '/reports/arap?party_type=customer' }, { id: 'supplier', label: '应付（供应商）', to: '/reports/arap?party_type=supplier' }]} /><div className="panel"><DataTable key={partyType} tableId={`reports.arap.${partyType}`} mode="server" columns={columns} fetchData={fetchData} rowKey={row => String(row[partyKey])} rowHref={row => `/master/${customer ? 'customers' : 'suppliers'}/${row[partyKey]}`}
    exportConfig={{ endpoint: '/api/reports/ar-ap-summary', allScope: 'server', buildParams: ({ q, sortKey, sortDir }) => ({ q, sort: sortKey, order: sortDir, party_type: partyType }) }} footer={data => <Summary data={data} fields={[[balanceKey, balanceLabel]]} />} /></div></section>
}

function LedgerDetail({ kind, user }) {
  const customer = kind === 'receivables'
  const title = customer ? '应收明细' : '应付明细'
  const partyKey = customer ? 'customer_id' : 'supplier_id'
  const [parties, setParties] = useState([])
  const [error, setError] = useState(null)
  useEffect(() => { let active = true; setParties([]); setError(null); (customer ? api.customers() : api.suppliers()).then(data => { if (active) setParties(data) }).catch(err => { if (active) setError(err) }); return () => { active = false } }, [customer])
  const fetchData = useCallback((params, signal) => api.reports[kind]({ ...params, paginated: true, signal }), [kind])
  const columns = useMemo(() => [
    { key: 'party_name', label: customer ? '客户' : '供应商', filterType: 'search', searchKeys: ['party_name', 'doc_no'] },
    { key: 'doc_no', label: '来源单号', filterType: 'text' },
    { key: 'doc_date', label: '单据日期', className: 'nowrap' },
    { key: 'entry_type', label: '款项', filterType: 'select', filterOptions: [{ value: 'DEPOSIT', label: '定金' }, { value: 'INVOICE', label: '账期' }], render: row => row.entry_type === 'DEPOSIT' ? '定金' : '账期' },
    { key: 'direction', label: '方向', filterType: 'select', filterOptions: [{ value: 'UP', label: '增加' }, { value: 'DOWN', label: '减少' }], render: row => row.direction === 'UP' ? '增加' : '减少' },
    moneyColumn('amount', '金额'), { key: 'created_at', label: '发生日期', render: row => <time dateTime={row.created_at} title={new Date(row.created_at).toLocaleString()}>{String(row.created_at || '').slice(0, 10) || '—'}</time> },
  ], [customer])
  return <section><Back to={`/reports/arap?party_type=${customer ? 'customer' : 'supplier'}`} /><PageHeading eyebrow="财务" title={title} description="应收应付台账包含定金；净发生额为当前筛选内的增加金额减去减少金额。" /><div className="panel"><ErrorBox error={error} /><DataTable key={kind} tableId={`reports.${kind}`} mode="server" columns={columns} fetchData={fetchData} rowKey={row => String(row.ar_ap_entry_id)} rowHref={row => documentHref(row, user)} queryKeys={LEDGER_QUERY}
    toolbar={({ query, setQuery }) => <div className="actions"><Field label={customer ? '客户' : '供应商'}><select value={query.party_id || ''} onChange={event => setQuery('party_id', event.target.value)}><option value="">全部</option>{parties.map(party => <option key={party[partyKey]} value={party[partyKey]}>{party.name}</option>)}</select></Field><DateFilters query={query} setQuery={setQuery} /></div>}
    exportConfig={{ endpoint: `/api/reports/${kind}`, allScope: 'server' }} footer={data => <Summary data={data} fields={[[ 'amount_up', '增加金额' ], [ 'amount_down', '减少金额' ], [ 'balance', '净发生额' ]]} />} /></div></section>
}

function InventoryCost() {
  const fetchData = useCallback((params, signal) => api.reports.inventoryCost({ ...params, paginated: true, signal }), [])
  const columns = useMemo(() => [
    { key: 'product_name', label: '货品', filterType: 'search' }, { key: 'uom_code', label: '单位', filterType: 'text' },
    { key: 'on_hand_quantity', label: '现库存', align: 'end', render: row => formatQuantity(row.on_hand_quantity) },
    moneyColumn('cost_price', '成本单价'), moneyColumn('cost_value', '库存成本'),
  ], [])
  return <section><PageHeading eyebrow="财务" title="库存成本汇总" description="按货品和单位分别计算现库存与采购成本，金额合计覆盖当前筛选全部记录。" /><div className="panel"><DataTable tableId="reports.inventory-cost" mode="server" columns={columns} fetchData={fetchData} rowKey={row => `${row.product_id}:${row.uom_id}`} rowHref={row => `/products/${row.product_id}`} exportConfig={{ endpoint: '/api/reports/inventory-cost', allScope: 'server' }} footer={data => <Summary data={data} fields={[[ 'cost_value', '库存成本' ]]} />} /></div></section>
}

export function reportRoute(first, parts, query, user) {
  if (!canView(user, 'reports')) return <Forbidden />
  const page = parts[1]
  if (page === 'purchase') return <PurchaseReconciliation user={user} />
  if (page === 'arap') return <ArApSummary />
  if (page === 'receivables') return <LedgerDetail kind="receivables" user={user} />
  if (page === 'payables') return <LedgerDetail kind="payables" user={user} />
  if (page === 'inventory-cost') return <InventoryCost />
  return <Forbidden />
}
