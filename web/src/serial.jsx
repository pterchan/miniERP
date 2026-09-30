// 序列台账（SN 追踪）：列表 / 详情 / 行内 SN 登记组件（扫码·OCR·Excel·校验）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api from './api'
import DataTable, { toServerFilters } from './data-table'
import { prepareImage } from './image-utils'
import { appendSerialCandidates, prepareSerialOcrCandidates } from './serial-utils'
import { conditionLabel, documentTypeLabel } from './business-labels'
import { Back, Badge, StatusBadge, Button, Empty, ErrorBox, Loading, PageHeading, useFetchOne } from './ui'

const EVENT_LABELS = {
  observed: '观测', received: '入库', issued: '出库', transferred: '调拨', returned: '退回',
  component_attached: '挂接组件', component_removed: '移除组件', repaired: '维修',
  retired: '退役', lost: '遗失', adjusted: '调整',
}
const eventLabel = (t) => EVENT_LABELS[t] || (t ? '其他事件' : '—')

// ---------------------------------------------------------------------------
// 行内 SN 登记组件：textarea（扫码/粘贴，回车换行）+ OCR 识别 + Excel 导入 + 预检
// ---------------------------------------------------------------------------
export function SerialEntry({ productId, value = '', onChange, quantity, label = '序列号登记' }) {
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [err, setErr] = useState(null)
  const [candidates, setCandidates] = useState([])
  const ocrRef = useRef(null); const excelRef = useRef(null)
  const latestRef = useRef({ productId, value, onChange })
  latestRef.current = { productId, value, onChange }
  const mountedRef = useRef(false)
  const operationRef = useRef(0)
  const controllerRef = useRef(null)
  const pendingRef = useRef(null)
  const count = value ? value.split('\n').map(s => s.trim()).filter(Boolean).length : 0
  const mismatch = quantity != null && quantity !== '' && count !== 0 && Number(quantity) !== count

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current += 1
      controllerRef.current?.abort()
      pendingRef.current = null
    }
  }, [])
  useEffect(() => {
    operationRef.current += 1
    controllerRef.current?.abort()
    pendingRef.current = null
    setCandidates([]); setHint(''); setErr(null); setBusy(false)
  }, [productId])

  function beginOperation(message) {
    controllerRef.current?.abort()
    const operation = { id: ++operationRef.current, productId: latestRef.current.productId, controller: new AbortController() }
    controllerRef.current = operation.controller
    pendingRef.current = null
    setCandidates([]); setBusy(true); setErr(null); setHint(message)
    return operation
  }
  function isCurrent(operation) {
    return mountedRef.current && operation.id === operationRef.current &&
      operation.productId === latestRef.current.productId
  }

  async function ocrSelected(e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    const operation = beginOperation('识别中…')
    try {
      const image = await prepareImage(file)
      if (!isCurrent(operation)) return
      const result = await api.ocrExtract(image, operation.controller.signal)
      if (!isCurrent(operation)) return
      const prepared = prepareSerialOcrCandidates(result)
      pendingRef.current = prepared.candidates.length ? operation : null
      setCandidates(prepared.candidates)
      setHint(prepared.message)
    } catch (err) {
      if (isCurrent(operation) && err.name !== 'AbortError') { setErr(err); setHint('') }
    } finally {
      if (isCurrent(operation)) setBusy(false)
    }
  }
  function confirmCandidates() {
    const operation = pendingRef.current
    if (!operation || !isCurrent(operation)) return
    const selected = candidates.filter(x => x.selected).map(x => x.value)
    if (!selected.length) return
    const appended = appendSerialCandidates(latestRef.current.value, selected)
    pendingRef.current = null
    setCandidates([])
    if (appended.added) latestRef.current.onChange(appended.text)
    setHint(appended.added
      ? `已添加 ${appended.added} 个 SN${appended.duplicates ? `，跳过 ${appended.duplicates} 个重复项` : ''}`
      : '所选序列号已在输入列表中，无需重复添加')
  }
  function cancelCandidates() {
    operationRef.current += 1
    controllerRef.current?.abort()
    pendingRef.current = null
    setCandidates([]); setHint('已取消本次识别候选')
  }
  async function excelSelected(e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    const operation = beginOperation('解析中…')
    try {
      const r = await api.importSerialsFile(file, { signal: operation.controller.signal })
      if (!isCurrent(operation)) return
      latestRef.current.onChange([latestRef.current.value, (r.items || []).join('\n')].filter(Boolean).join('\n'))
      setHint(`导入 ${r.count || 0} 个 SN`)
    } catch (err) {
      if (isCurrent(operation) && err.name !== 'AbortError') { setErr(err); setHint('') }
    } finally { if (isCurrent(operation)) setBusy(false) }
  }
  async function validate() {
    if (!value.trim()) { setErr(new Error('请先填写序列号')); return }
    const operation = beginOperation('校验中…')
    try {
      const r = await api.parseSerials({ product_id: productId, text: value })
      if (!isCurrent(operation)) return
      const items = r.items || []
      const missing = items.filter(x => !x.exists)
      const active = items.filter(x => x.exists && x.status === 'active')
      if (missing.length) {
        const shown = missing.slice(0, 3).map(x => x.serial_number).join('、')
        setHint(`⚠ ${missing.length} 个未登记（出库将报错）：${shown}${missing.length > 3 ? '…' : ''}`)
      } else if (active.length === items.length) {
        setHint('全部已登记且未出库（入库会提示重复）')
      } else {
        setHint(`全部已登记；其中 ${active.length} 个在库，${items.length - active.length} 个不在库`)
      }
    } catch (err) {
      if (isCurrent(operation) && err.name !== 'AbortError') { setErr(err); setHint('') }
    } finally { if (isCurrent(operation)) setBusy(false) }
  }

  return <div className="line-serial">
    <div className="line-serial-head">
      <span>{label}</span>
      <span className={mismatch ? 'warning-text' : 'muted'}>{quantity != null ? `已填 ${count} 个 / 数量 ${quantity}` : `已填 ${count} 个`}{mismatch && ' ⚠ 数量不一致'}</span>
      <span className="line-serial-actions">
        <Button type="button" className="secondary" disabled={busy} onClick={() => ocrRef.current?.click()}>⌾ OCR 识别</Button>
        <Button type="button" className="secondary" disabled={busy} onClick={() => excelRef.current?.click()}>⇪ Excel</Button>
        <Button type="button" className="secondary" disabled={busy} onClick={validate}>校验</Button>
        <input ref={ocrRef} hidden type="file" accept="image/*" capture="environment" aria-label="OCR 识别图片" onChange={ocrSelected} />
        <input ref={excelRef} hidden type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={excelSelected} />
      </span>
    </div>
    <textarea rows="3" value={value} onChange={e => onChange(e.target.value)} placeholder="扫码/粘贴，一行一个（回车换行）" aria-label={label} disabled={busy} />
    {candidates.length > 0 && <div className="action-confirm" role="region" aria-label="确认 OCR 序列号">
      <strong>请核对序列号后确认添加</strong>
      {candidates.map(candidate => <label className="check-field" key={candidate.key}>
        <input type="checkbox" checked={candidate.selected} onChange={e => { const selected = e.target.checked; setCandidates(items => items.map(item => item.key === candidate.key ? { ...item, selected } : item)) }} />
        <span>{candidate.value} <small>（置信度 {Math.round(candidate.confidence * 100)}%{candidate.reasons.length ? `；${candidate.reasons.join('；')}` : ''}）</small></span>
      </label>)}
      <div className="actions"><Button type="button" className="primary" onClick={confirmCandidates} disabled={!candidates.some(x => x.selected)}>确认添加</Button><Button type="button" className="secondary" onClick={cancelCandidates}>取消本次识别</Button></div>
    </div>}
    {hint && <p className="muted">{hint}</p>}
    {err && <ErrorBox error={err} />}
  </div>
}

// ---------------------------------------------------------------------------
// 序列台账列表
// ---------------------------------------------------------------------------
export function SerialLedger() {
  const [error, setError] = useState(null)
  // 稳定引用：columns/fetchData 是 DataTable 拉取 effect 的依赖，
  // 每次渲染新建会在请求失败（onError→重渲染）时形成无限重试循环。
  const columns = useMemo(() => [
    { key: 'serial_number', label: '序列号', filterType: 'search' },
    { key: 'product_name', label: '货品' },
    { key: 'current_location_name', label: '当前库位' },
    { key: 'status_code', label: '状态', render: r => <StatusBadge domain="serial" value={r.status_code} /> },
    { key: 'latest_event_type', label: '最近事件', render: row => eventLabel(row.latest_event_type) },
    { key: 'latest_event_date', label: '最近日期' },
  ], [])
  const fetchData = useCallback((p, signal) => api.serialLedger({ ...p, signal }), [])
  return <section><PageHeading eyebrow="库存" title="序列台账" description="启用 SN 追踪货品的单件在册状态与流向。" /><div className="panel"><ErrorBox error={error} /><DataTable tableId="inventory.serials"
    mode="server"
    columns={columns}
    fetchData={fetchData}
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
  const { data, error } = useFetchOne(() => api.serialAsset(id), [id])
  if (error) return <section><Back to="/serials" /><ErrorBox error={error} /></section>
  if (!data) return <Loading />
  return <section><Back to="/serials" /><PageHeading eyebrow="序列台账" title={data.primary_identifier || '未设置序列号'} description={data.product_name || '尚未关联货品'}><StatusBadge domain="serial" value={data.status_code} /></PageHeading><div className="detail-grid"><div className="panel"><h2>当前状态</h2><dl className="detail-list"><dt>货品</dt><dd>{data.product_name || '—'}</dd><dt>序列号</dt><dd>{data.primary_identifier || '—'}</dd><dt>当前库位</dt><dd>{data.current_location_name || '—'}</dd><dt>成色</dt><dd>{conditionLabel(data.condition_code)}</dd><dt>最近事件</dt><dd>{eventLabel(data.latest_event_type)}{data.latest_event_date ? ` · ${data.latest_event_date}` : ''}</dd></dl></div><div className="panel"><h2>流向历史</h2>{data.events?.length ? <div className="record-list">{data.events.map(e => <div className="record-card" key={e.asset_event_id}><div><strong>{eventLabel(e.event_type)}</strong><span>{e.from_location_name || '—'} → {e.to_location_name || '—'}</span></div><div className="record-value"><b>{e.event_date}</b><small>{e.doc_no ? `${e.doc_no} · ${documentTypeLabel(e.doc_type)}` : (e.notes || '')}</small></div></div>)}</div> : <Empty>暂无流向记录</Empty>}</div></div><div className="panel"><h2>标识</h2><div className="tag-list">{(data.identifiers || []).map(x => <Badge key={`${x.identifier_type}-${x.value_raw}`} tone="neutral">{x.value_raw}</Badge>)}</div></div></section>
}
