import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SerialLedger } from './serial'
import { RouterContext } from './ui'

const serialLedgerMock = vi.fn(() => Promise.reject(new Error('后端不可用')))
vi.mock('./api', () => ({ default: { serialLedger: (...args) => serialLedgerMock(...args) } }))

afterEach(cleanup)

describe('SerialLedger failure handling', () => {
  it('stops after one failed fetch instead of retrying in a render loop', async () => {
    render(<RouterContext.Provider value={{ navigate: vi.fn(), currentPath: '/serials' }}><SerialLedger user={{ role: 'ADMIN' }} /></RouterContext.Provider>)
    // DataTable 有 200ms 防抖；等待足以触发「失败→重渲染→再拉取」循环的窗口
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(serialLedgerMock.mock.calls.length).toBe(1)
  })
})
