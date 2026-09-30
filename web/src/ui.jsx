import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { isNavigationItemActive } from './navigation-utils'
import { withBasePath } from './app-path'
import { actionLabel, getStatus } from './status'

export const RouterContext = createContext({ navigate: () => {}, currentPath: '/' })
export const useRouter = () => useContext(RouterContext)

// SPA 站内导航的脏表单守卫：beforeunload 只覆盖刷新/关闭，navigate() 走这里。
const dirtyLeaveHandlers = new Set()

/** 注册脏离开判定（返回 false 拦截导航）；返回反注册函数。 */
export function registerDirtyLeave(handler) {
  dirtyLeaveHandlers.add(handler)
  return () => dirtyLeaveHandlers.delete(handler)
}

export function confirmDirtyLeave() {
  return [...dirtyLeaveHandlers].every(handler => handler() !== false)
}

export function Link({ to, children, className = '', onClick, state, ...props }) {
  const { navigate } = useRouter()
  return <a className={className} href={withBasePath(to)} onClick={e => {
    if (onClick) onClick(e)
    // 修饰键/非左键点击（新标签、下载等）交给浏览器原生行为
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    // 统一交给路由处理脏表单与历史记录，避免重复确认。
    e.preventDefault()
    state === undefined ? navigate(to) : navigate(to, { state })
  }} {...props}>{children}</a>
}

export function NavLink({ to, children, className = '', onClick }) {
  const { currentPath } = useRouter()
  const active = isNavigationItemActive(currentPath, to)
  return <Link className={className} to={to} onClick={onClick} aria-current={active ? 'page' : undefined}>{children}</Link>
}

export function Badge({ children, tone = 'neutral', className = '', ...props }) { return <span className={`badge ${tone} ${className}`} {...props}>{children}</span> }
export function StatusBadge({ domain, value, ...props }) { const status = getStatus(domain, value); return <Badge tone={status.tone} {...props}>{status.label}</Badge> }
export function EmptyState({ title, description = '可以调整筛选条件，或新增一条记录开始。', children, action, actions }) { return <div className="empty empty-state"><p>{title || children || '暂无数据'}</p>{description && <p className="muted">{description}</p>}{(action || actions) && <div className="actions">{action || actions}</div>}</div> }
export const Empty = EmptyState
export function ErrorBox({ error }) { return error ? <div className="alert error" role="alert">{error.message || String(error)}</div> : null }
export function Skeleton({ rows = 5, className = '' }) { return <div className={`skeleton ${className}`} role="status" aria-label="加载中">{Array.from({ length: rows }, (_, i) => <div className="skeleton-row" key={i} />)}</div> }
export function Loading() { return <Skeleton /> }
export function Back({ to = '/' }) {
  const router = useRouter()
  const returnTo = router.returnTo || window.history.state?.returnTo
  const target = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : to
  return <Link className="back-link" to={target}>‹ 返回</Link>
}
export function PageHeader({ eyebrow, title, description, status, actions, children }) { return <div className="page-heading"><div>{eyebrow && <p className="eyebrow" aria-label="当前位置">{eyebrow}</p>}<div className="page-title"><h1>{title}</h1>{status}</div>{description && <p className="muted">{description}</p>}</div>{(actions || children) && <div className="actions page-actions">{actions || children}</div>}</div> }
export const PageHeading = PageHeader
export function Field({ label, children, className = '' }) { return <label className={`field ${className}`}><span>{label}</span>{children}</label> }
export function Button({ children, className = '', variant, size = 'md', ...props }) {
  const legacyVariant = className.split(/\s+/).find(value => ['primary', 'secondary', 'ghost', 'danger', 'danger-quiet'].includes(value))
  return <button className={`button ${variant || legacyVariant || 'secondary'} button-${size} ${className}`} {...props}>{children}</button>
}
export function Forbidden() { return <section><PageHeading eyebrow="403" title="无权访问" description="当前账号没有执行此操作的权限。" /><Link className="primary button-link" to="/">返回工作台</Link></section> }

export function ActionConfirm({ title, description, reasonRequired = false, reasonLabel = '原因', onConfirm, onCancel, busy = false, confirmLabel = '确认', variant = 'danger', children }) {
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState(null)
  const confirmRef = useRef(null)
  const pending = busy || working
  async function confirm() {
    if (pending || (reasonRequired && !reason.trim())) return
    setWorking(true); setError(null)
    try { await onConfirm(reason.trim()) } catch (err) { setError(err) } finally { setWorking(false) }
  }
  useEffect(() => { confirmRef.current?.focus() }, [])
  return <div className={`action-confirm ${variant === 'danger' ? 'action-confirm-danger' : ''}`} role="region" aria-label={title || '操作确认'}>
    {title && <strong>{title}</strong>}{description && <p>{description}</p>}{children}
    {reasonRequired && <Field label={reasonLabel}><textarea ref={confirmRef} rows="2" value={reason} onChange={e => setReason(e.target.value)} placeholder={`请填写${reasonLabel}`} disabled={pending} /></Field>}
    <ErrorBox error={error} /><div className="actions"><Button ref={reasonRequired ? undefined : confirmRef} type="button" variant={variant} onClick={confirm} disabled={pending || (reasonRequired && !reason.trim())}>{pending ? '处理中…' : confirmLabel}</Button><Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>取消</Button></div>
  </div>
}

const focusableSelector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
function focusableElements(container) { return [...(container?.querySelectorAll(focusableSelector) || [])].filter(el => !el.hidden && el.getAttribute('aria-hidden') !== 'true') }

export function DropdownMenu({ label, children, align = 'end', className = '', variant = 'ghost', disabled = false }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null), trigger = useRef(null), menu = useRef(null)
  const menuId = useId()
  const close = useCallback((restoreFocus = true) => { setOpen(false); if (restoreFocus) trigger.current?.focus() }, [])
  useEffect(() => {
    if (!open) return undefined
    focusableElements(menu.current)[0]?.focus()
    const outside = event => { if (!root.current?.contains(event.target)) close(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, close])
  function onKeyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { close(false); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = focusableElements(menu.current), index = items.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  return <div className={`dropdown ${className}`} ref={root}>
    <Button ref={trigger} type="button" variant={variant} size="sm" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(value => !value)} onKeyDown={e => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setOpen(true) } }}>{label}<span aria-hidden="true">⌄</span></Button>
    {open && <div ref={menu} id={menuId} className={`dropdown-menu dropdown-${align}`} role="menu" aria-label={typeof label === 'string' ? label : undefined} onKeyDown={onKeyDown} onClick={event => { const control = event.target.closest('button, a'); if (control && !control.closest('[data-menu-keep-open]')) close(control.tagName !== 'A') }}>{typeof children === 'function' ? children({ close }) : children}</div>}
  </div>
}

export function Tabs({ items, value, onChange, label = '分区导航', syncHash = false, className = '' }) {
  const { navigate } = useRouter()
  const root = useRef(null)
  function select(item) {
    if (item.disabled) return
    if (syncHash && !item.to && navigate(`#${encodeURIComponent(item.id)}`) === false) return
    onChange?.(item.id)
  }
  return <div ref={root} className={`tabs ${className}`} role="tablist" aria-label={label} onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tabs = [...root.current.querySelectorAll('[role="tab"]')].filter(tab => !tab.disabled)
    const index = tabs.indexOf(document.activeElement)
    tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]?.focus()
  }}>{items.map(item => item.to ? <Link key={item.id} to={item.to} role="tab" aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1} className="tab">{item.label}</Link> : <button type="button" key={item.id} role="tab" className="tab" disabled={item.disabled} aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1} onClick={() => select(item)}>{item.label}</button>)}</div>
}

export function Drawer({ open, title, onClose, children, actions, dirty = false }) {
  const dialog = useRef(null), previousFocus = useRef(null)
  const titleId = useId(), closeRef = useRef(onClose), dirtyRef = useRef(dirty)
  closeRef.current = onClose; dirtyRef.current = dirty
  useDirtyLeaveGuard(open && dirty)
  const requestClose = useCallback(() => { if (!dirtyRef.current || window.confirm('有未保存的修改，确定离开？')) closeRef.current?.() }, [])
  useEffect(() => {
    if (!open) return undefined
    previousFocus.current = document.activeElement
    const scroll = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    focusableElements(dialog.current)[0]?.focus()
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); requestClose() }
      if (event.key === 'Tab') {
        const elements = focusableElements(dialog.current), first = elements[0], last = elements[elements.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.body.style.overflow = scroll; document.removeEventListener('keydown', keydown); previousFocus.current?.focus() }
  }, [open, requestClose])
  if (!open) return null
  return <div className="drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) requestClose() }}><aside ref={dialog} className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}><header className="drawer-header"><h2 id={titleId}>{title}</h2><Button type="button" variant="ghost" onClick={requestClose} aria-label="关闭抽屉">×</Button></header><div className="drawer-content">{children}</div>{actions && <footer className="drawer-actions actions">{actions}</footer>}</aside></div>
}

const ToastContext = createContext(() => {})
export function ToastProvider({ children }) {
  const [messages, setMessages] = useState([])
  const nextId = useRef(0), timers = useRef(new Set())
  const toast = useCallback(message => {
    const id = ++nextId.current
    setMessages(current => [...current, { id, message: typeof message === 'string' ? message : message?.message || message?.title }])
    const timer = setTimeout(() => { setMessages(current => current.filter(item => item.id !== id)); timers.current.delete(timer) }, 3000)
    timers.current.add(timer)
  }, [])
  toast.success = toast
  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])
  return <ToastContext.Provider value={toast}>{children}<div className="toast-region" aria-live="polite" aria-atomic="false">{messages.map(item => <div className="toast" role="status" key={item.id}><span aria-hidden="true">✓</span>{item.message}<button type="button" aria-label="关闭提示" onClick={() => setMessages(current => current.filter(message => message.id !== item.id))}>×</button></div>)}</div></ToastContext.Provider>
}
export const useToast = () => useContext(ToastContext)
export function FormSection({ title, description, children, className = '' }) { return <section className={`form-section ${className}`}><header><h2>{title}</h2>{description && <p className="muted">{description}</p>}</header><div className="form-grid">{children}</div></section> }
export function ObjectHeader({ title, subtitle, description, items = [], children }) { return <div className="object-header">{title && <strong>{title}</strong>}{(subtitle || description) && <p className="muted">{subtitle || description}</p>}{items.length > 0 && <dl>{items.map((item, index) => <div key={item.label || index}>{item.label && <dt>{item.label}</dt>}<dd>{typeof item === 'object' ? item.value ?? '—' : item}</dd></div>)}</dl>}{children}</div> }

const FIELD_LABELS = { display_name: '名称', name: '名称', code: '编码', manufacturer: '厂家', specification: '规格', primary_identifier: '编号', primary_identifier_value: '编号', status: '状态', status_code: '状态', reason: '原因', notes: '备注', remark: '备注', contact_name: '联系人', contact_person: '联系人', contact: '联系人', phone: '电话', email: '邮箱', address: '地址', total_amount: '金额', amount: '金额', quantity: '数量', counted_quantity: '实盘数量', price: '单价', credit_limit: '信用额度', doc_date: '单据日期', doc_no: '单号', settlement_method: '结算方式', settlement_days: '结算账期', level: '等级', payment_terms: '结算条件', payment_term: '结算条件', deposit_amount: '定金', purchase_price: '采购价', sales_price: '售价', default_purchase_price: '采购价', default_sales_price: '售价', is_active: '启用状态', is_primary: '主编号', is_company_inventory: '计入公司库存', serialized: '序列号追踪', role: '角色', username: '用户名', location_type: '库位类型', resolution_notes: '处理说明', filename: '附件名称' }
const VALUE_LABELS = { ADMIN: '管理员', WAREHOUSE: '仓管', SALES: '销售', FINANCE: '财务', COLLEAGUE: '同事', WAREHOUSE_INTERNAL: '内部仓库', EMPLOYEE: '员工', CUSTOMER: '客户', SUPPLIER: '供应商' }
function displayChange(value, field, domain) {
  if (value == null || value === '') return '未填写'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return value.display_name || value.name || value.label || '已更新'
  if (field === 'status' || field === 'status_code') return getStatus(domain || (field === 'status_code' ? 'conflict' : 'document'), value).label
  return VALUE_LABELS[value] || String(value)
}
export function FieldDiff({ diff, domain }) {
  if (!diff || typeof diff !== 'object') return null
  // 旧审计只记录版本或内部关联键时，不能据此还原业务字段变化。
  const entries = Object.entries(diff).filter(([key]) => FIELD_LABELS[key])
  if (!entries.length) return null
  return <dl className="field-diff">{entries.map(([key, change]) => {
    const before = Array.isArray(change) ? change[0] : change?.before ?? change?.old
    const after = Array.isArray(change) ? change[1] : change?.after ?? change?.new
    return <div key={key}><dt>{FIELD_LABELS[key]}</dt><dd><span>{displayChange(before, key, domain)}</span><span aria-label="变更为">→</span><strong>{displayChange(after, key, domain)}</strong></dd></div>
  })}</dl>
}
function relativeTime(value) {
  const date = new Date(value), elapsed = Math.max(0, Date.now() - date.getTime())
  if (Number.isNaN(date.getTime())) return '时间未知'
  if (elapsed < 60000) return '刚刚'
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} 小时前`
  return date.toLocaleDateString('zh-CN')
}
export function Timeline({ events, items, domain = 'document' }) {
  const rows = events || items || []
  if (!rows.length) return <EmptyState title="暂无操作记录" description="后续业务操作会显示在这里。" />
  return <ol className="timeline">{rows.map((event, index) => <li key={event.audit_event_id || event.stock_request_action_id || index}><div className="timeline-heading"><strong>{event.label || actionLabel(event.action)}</strong><span>{event.actor_name || event.actor_display_name || event.actor_username || '系统'}</span><time dateTime={event.created_at} title={event.created_at ? new Date(event.created_at).toLocaleString('zh-CN') : ''}>{relativeTime(event.created_at)}</time></div>{(event.reason || event.comment || event.notes) && <p className="muted">{event.reason || event.comment || event.notes}</p>}<FieldDiff diff={event.field_diff || (event.from_status && event.to_status ? { status: [event.from_status, event.to_status] } : null)} domain={domain} /></li>)}</ol>
}

/** 兜底错误边界：任一页面渲染抛错时显示可恢复的提示，而不是整棵应用白屏。 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('页面渲染错误', error, info)
  }
  render() {
    if (this.state.error) {
      return <section><PageHeading eyebrow="出错" title="页面渲染出错" description="遇到一个意外错误。你的数据不会被影响，可以返回总览或重试。" /><div className="actions"><Link className="primary button-link" to="/">返回总览</Link><button type="button" className="secondary" onClick={() => this.setState({ error: null })}>重试</button></div></section>
    }
    return this.props.children
  }
}

export function useDirtyLeaveGuard(dirty) {
  // 浏览器刷新/关闭 + SPA 站内导航（navigate/Link）双通道拦截
  useEffect(() => {
    if (!dirty) return undefined
    const handler = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
  useEffect(() => registerDirtyLeave(() => (dirty ? window.confirm('有未保存的修改，确定离开？') : true)), [dirty])
}

/** 详情页统一数据拉取：竞态守卫（慢响应后到不覆盖新数据）+ 卸载不写入。 */
export function useFetchOne(fetch, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const fetchRef = useRef(fetch), sequence = useRef(0), mounted = useRef(false)
  fetchRef.current = fetch
  const reload = useCallback(async () => {
    const request = ++sequence.current
    setError(null); setLoading(true)
    try {
      const result = await fetchRef.current()
      if (mounted.current && request === sequence.current) { setData(result); setLoading(false) }
      return result
    } catch (err) {
      if (mounted.current && request === sequence.current) { setError(err); setLoading(false) }
      return undefined
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    setData(null)
    reload()
    return () => { mounted.current = false; sequence.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error, loading, reload, setData }
}

/** 表单防重复提交：连点只发一次；返回 [busy, wrap]，wrap 包裹 async 保存函数。 */
export function useBusy() {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)  // ref 判重：同一渲染帧内二次调用也能挡住
  const wrap = useCallback(async fn => {
    if (busyRef.current) return undefined
    busyRef.current = true
    setBusy(true)
    try { return await fn() } finally { busyRef.current = false; setBusy(false) }
  }, [])
  return [busy, wrap]
}

export function useIsMobile(query = '(max-width: 760px)') {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = event => setIsMobile(event.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return isMobile
}
