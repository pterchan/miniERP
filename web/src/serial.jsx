// 序列台账（SN 追踪）：列表 / 详情 / 行内 SN 登记组件（扫码·OCR·Excel·校验）。
import React, { useEffect, useRef, useState } from 'react'
import api from './api'
import DataTable, { toServerFilters } from './data-table'
import { prepareImage } from './image-utils'
import { Back, Badge, Button, Empty, ErrorBox, Loading, PageHeading, useRouter } from './ui'

const EVENT_LABELS = {
  observed: '观测', received: '入库', issued: '出库', transferred: '调拨', returned: '退回',
  component_attached: '挂接组件', component_removed: '移除组件', repaired: '维修',
  retired: '退役', lost: '遗失', adjusted: '调整',
}
const eventLabel = (t) => EVENT_LABELS[t] || t || '—'

const STATUS_TONE = { active: 'teal', retired: 'neutral', lost: 'red' }

// ---------------------------------------------------------------------------
// 行内 SN 登记组件：textarea（扫码/粘贴，回车换行）+ OCR 识别 + Excel 导入 + 预检
// ---------------------------------------------------------------------------
export function SerialEntry({ productId, value = '', onChange, quantity, label = '序列号登记' }) {
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [err, setErr] = useState(null)
  const ocrRef = useRef(null); const excelRef = useRef(null)
  const count = value ? value.split('\n').map(s => s.trim()).filter(Boolean).length : 0
  const mismatch = quantity != null && quantity !== '' && count !== 0 && Number(quantity) !== count

  async function ocrSelected(e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    setBusy(true); setErr(null); setHint('识别中…')
    try {
      const image = await prepareImage(file)
      const result = await api.ocrExtract(image)
      const serials = [...(result.fields?.serial_number || []), ...(result.fields?.lot_number || [])]
        .map(x => x.value_raw).filter(Boolean)
      if (!serials.length) { setHint('未识别到序列号，请重拍或手工输入'); return }
      onChange([value, serials.join('\n')].filter(Boolean).join('\n'))
      setHint(`识别到 ${serials.length} 个 SN`)
    } catch (err) { setErr(err) } finally { setBusy(false) }
  }
  async function excelSelected(e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    setBusy(true); setErr(null); setHint('解析中…')
    try {
      const r = await api.importSerialsFile(file)
      onChange([value, (r.items || []).join('\n')].filter(Boolean).join('\n'))
      setHint(`导入 ${r.count || 0} 个 SN`)
    } catch (err) { setErr(err) } finally { setBusy(false) }
  }
  async function validate() {
    if (!value.trim()) { setErr(new Error('请先填写序列号')); return }
    setBusy(true); setErr(null); setHint('校验中…')
    try {
      const r = await api.parseSerials({ product_id: productId, text: value })
      const items = r.items || []
      const missing = items.filter(x => !x.exists)
      const active = items.filter(x => x.exists && x.status === 'active')
      if (missing.length) {
        const shown = missing.slice(0, 3).map(x => x.serial_number).join('、')
        setHint(`⚠ ${missing.length} 个未登记（出库将报错）：${shown}${missing.length > 3 ? '…' : ''}`)
      } else if (active.length === items.length) {
        setHint('全部已登记且未出库（入库会提示重复）')
      } else {
        setHint(`全部已登记；其中 ${items.length - active.length} 个可出库/调拨`)
      }
    } catch (err) { setErr(err) } finally { setBusy(false) }
  }

  return <div className="line-serial">
    <div className="line-serial-head">
      <span>{label}</span>
      <span className={mismatch ? 'warning-text' : 'muted'}>{quantity != null ? `已填 ${count} 个 / 数量 ${quantity}` : `已填 ${count} 个`}{mismatch && ' ⚠ 数量不一致'}</span>
      <span className="line-serial-actions">
        <Button type="button" className="secondary" disabled={busy} onClick={() => ocrRef.current?.click()}>⌾ OCR 识别</Button>
        <Button type="button" className="secondary" disabled={busy} onClick={() => excelRef.current?.click()}>⇪ Excel</Button>
        <Button type="button" className="secondary" disabled={busy} onClick={validate}>校验</Button>
        <input ref={ocrRef} hidden type="file" accept="image/*" capture="environment" onChange={ocrSelected} />
        <input ref={excelRef} hidden type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={excelSelected} />
      </span>
    </div>
    <textarea rows="3" value={value} onChange={e => onChange(e.target.value)} placeholder="扫码/粘贴，一行一个（回车换行）" disabled={busy} />
    {hint && <p className="muted">{hint}</p>}
    {err && <ErrorBox error={err} />}
  </div>
}

// ---------------------------------------------------------------------------
// 序列台账列表
// ---------------------------------------------------------------------------
export function SerialLedger() {
  const [error, setError] = useState(null)
  const columns = [
    { key: 'serial_number', label: '序列号', filterType: 'search' },
    { key: 'product_name', label: '货品' },
    { key: 'current_location_name', label: '当前库位' },
    { key: 'status_code', label: '状态' },
    { key: 'latest_event_type', label: '最近事件' },
    { key: 'latest_event_date', label: '最近日期' },
  ]
  return <section><PageHeading eyebrow="库存" title="序列台账" description="启用 SN 追踪货品的单件在册状态与流向。" /><div className="panel"><ErrorBox error={error} /><DataTable
    mode="server"
    columns={columns}
    fetchData={(p, signal) => api.serialLedger({ ...p, signal })}
    rowKey={r => String(r.asset_id)}
    rowHref={r => `/serials/${r.asset_id}`}
    onError={setError}
    exportConfig={{
      endpoint: '/api/serial-ledger/export',
      filename: '序列台账',
      allScope: 'server',
      buildParams: ({ q, filters, sortKey, sortDir }) => ({ f: toServerFilters(filters, columns), sort: sortKey || '', order: sortDir, q: q || '' }),
    }}
  /></div></section>
}

// ---------------------------------------------------------------------------
// 序列详情：当前状态 + 流向历史
// ---------------------------------------------------------------------------
export function SerialDetail({ id }) {
  const { navigate } = useRouter()
  const [data, setData] = useState(null); const [error, setError] = useState(null)
  useEffect(() => { api.serialAsset(id).then(setData).catch(setError) }, [id])
  if (error) return <section><Back to="/serials" /><ErrorBox error={error} /></section>
  if (!data) return <Loading />
  return <section><Back to="/serials" /><PageHeading eyebrow="序列台账" title={data.primary_identifier || `资产 ${data.asset_id}`} description={data.product_name ? `${data.product_name} · ${data.status_code || '—'}` : data.status_code || '—'}><Badge tone={STATUS_TONE[data.status_code] || 'neutral'}>{data.status_code || '—'}</Badge></PageHeading><div className="detail-grid"><div className="panel"><h2>当前状态</h2><dl className="detail-list"><dt>货品</dt><dd>{data.product_name || '—'}</dd><dt>序列号</dt><dd>{data.primary_identifier || '—'}</dd><dt>当前库位</dt><dd>{data.current_location_name || '—'}</dd><dt>成色</dt><dd>{data.condition_code || '—'}</dd><dt>最近事件</dt><dd>{eventLabel(data.latest_event_type)}{data.latest_event_date ? ` · ${data.latest_event_date}` : ''}</dd></dl></div><div className="panel"><h2>流向历史</h2>{data.events?.length ? <div className="record-list">{data.events.map(e => <div className="record-card" key={e.asset_event_id}><div><strong>{eventLabel(e.event_type)}</strong><span>{e.from_location_name || '—'} → {e.to_location_name || '—'}</span></div><div className="record-value"><b>{e.event_date}</b><small>{e.doc_no ? `${e.doc_no} · ${e.doc_type || ''}` : (e.notes || '')}</small></div></div>)}</div> : <Empty>暂无流向记录</Empty>}</div></div><div className="panel"><h2>标识</h2><div className="tag-list">{(data.identifiers || []).map(x => <Badge key={`${x.identifier_type}-${x.value_raw}`} tone="neutral">{x.value_raw}</Badge>)}</div></div></section>
}
