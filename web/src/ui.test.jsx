import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Link, RouterContext, registerDirtyLeave } from './ui'

afterEach(cleanup)

describe('SPA dirty-leave guard', () => {
  it('blocks in-app navigation when a dirty form is registered, proceeds after confirm', () => {
    const navigate = vi.fn()
    let dirty = true
    const unregister = registerDirtyLeave(() => (dirty ? window.confirm('有未保存的修改，确定离开？') : true))
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<RouterContext.Provider value={{ navigate, currentPath: '/' }}><Link to="/products">货品</Link></RouterContext.Provider>)
    fireEvent.click(screen.getByText('货品'))
    expect(navigate).not.toHaveBeenCalled('脏表单未确认时站内导航应被拦截')

    window.confirm.mockReturnValue(true)
    fireEvent.click(screen.getByText('货品'))
    expect(navigate).toHaveBeenCalledWith('/products')

    dirty = false
    unregister()
  })
})
