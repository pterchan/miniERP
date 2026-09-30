import { describe, expect, it } from 'vitest'
import { getStatus, statusLabel } from './status'

describe('业务状态注册表', () => {
  it('单据和申请使用相同中文文案，保留各自提醒语义', () => {
    expect(statusLabel('document', 'SUBMITTED')).toBe('待审批')
    expect(statusLabel('request', 'SUBMITTED')).toBe('待审批')
    expect(getStatus('document', 'SUBMITTED').tone).toBe('info')
    expect(getStatus('request', 'SUBMITTED').tone).toBe('warning')
  })
  it('账号布尔值和序列状态使用业务语言', () => {
    expect(statusLabel('account', false)).toBe('停用')
    expect(statusLabel('serial', 'active')).toBe('在库')
    expect(statusLabel('serial', 'retired')).toBe('已出库')
  })
})
