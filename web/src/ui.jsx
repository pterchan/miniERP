import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { isNavigationItemActive } from './navigation-utils'

export const RouterContext = createContext({ navigate: () => {}, currentPath: '/' })
export const useRouter = () => useContext(RouterContext)

export function Link({ to, children, className = '', onClick, ...props }) {
  const { navigate } = useRouter()
  return <a className={className} href={to} onClick={e => { if (onClick) onClick(e); if (!e.defaultPrevented) { e.preventDefault(); navigate(to) } }} {...props}>{children}</a>
}

export function NavLink({ to, children, className = '', onClick }) {
  const { currentPath } = useRouter()
  const active = isNavigationItemActive(currentPath, to)
  return <Link className={className} to={to} onClick={onClick} aria-current={active ? 'page' : undefined}>{children}</Link>
}

export function Badge({ children, tone = 'neutral' }) { return <span className={`badge ${tone}`}>{children}</span> }
export function Empty({ children = '暂无数据' }) { return <div className="empty">{children}</div> }
export function ErrorBox({ error }) { return error ? <div className="alert error">{error.message || String(error)}</div> : null }
export function Loading() { return <div className="loading">加载中…</div> }
export function Back({ to = '/' }) { return <Link className="back-link" to={to}>‹ 返回</Link> }
export function PageHeading({ eyebrow, title, description, children }) { return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>{children}</div> }
export function Field({ label, children, className = '' }) { return <label className={`field ${className}`}><span>{label}</span>{children}</label> }
export function Button({ children, className = '', ...props }) { return <button className={className} {...props}>{children}</button> }
export function Forbidden() { return <section><PageHeading eyebrow="403" title="无权访问" description="当前账号没有执行此操作的权限。" /><Link className="primary button-link" to="/">返回总览</Link></section> }

export function useDirtyLeaveGuard(dirty) {
  useEffect(() => {
    if (!dirty) return undefined
    const handler = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
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
