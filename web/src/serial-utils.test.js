import { describe, expect, it } from 'vitest'
import { appendSerialCandidates, prepareSerialOcrCandidates } from './serial-utils'

const sn = (value_raw, status = 'confirmed', confidence = 0.99) => ({ value_raw, status, confidence })
const extraction = (items, status = 'ok') => ({ status, fields: { serial_number: items } })

describe('SN 识别候选', () => {
  it('仅采用序列号，不把批号作为 SN', () => {
    const result = prepareSerialOcrCandidates({ status: 'ok', fields: { serial_number: [sn('000123')], lot_number: [sn('LOT-01')] } })
    expect(result.candidates.map(x => x.value)).toEqual(['000123'])
    const lotOnly = prepareSerialOcrCandidates({ status: 'ok', fields: { lot_number: [sn('LOT-01')] } })
    expect(lotOnly.candidates).toEqual([])
    expect(lotOnly.message).toContain('仅识别到批号')
  })

  it('重拍状态禁止任何候选添加，并保留服务警告', () => {
    const result = prepareSerialOcrCandidates({ ...extraction([sn('000123')], 'reshoot_required'), warnings: ['文字过小，请重拍'] })
    expect(result).toEqual({ candidates: [], message: '文字过小，请重拍' })
  })

  it('只有整图可靠且字段确认、置信度达标的候选默认勾选', () => {
    const result = prepareSerialOcrCandidates(extraction([
      sn('0001', 'confirmed', 0.75), sn('0002', 'confirmed', 0.74),
      sn('0003', 'candidate'), sn('0004', 'ambiguous'),
    ]))
    expect(result.candidates.map(x => x.selected)).toEqual([true, false, false, false])
    const partial = prepareSerialOcrCandidates(extraction([sn('0001')], 'partial'))
    expect(partial.candidates[0].selected).toBe(false)
  })

  it.each([
    { status: 'future_status' },
    extraction(null),
    extraction([sn(123)]),
    extraction([sn('   ')]),
    extraction([sn('123', 'unknown')]),
    extraction([sn('123', 'confirmed', '0.99')]),
    extraction([{ ...sn('123'), confidence: undefined }]),
    extraction([sn('123', 'confirmed', NaN)]),
    extraction([sn('123', 'confirmed', -0.01)]),
    extraction([sn('123', 'confirmed', 1.01)]),
  ])('无效响应不生成候选：%j', result => {
    expect(() => prepareSerialOcrCandidates(result)).toThrow('OCR 返回的')
  })

  it('同批重复读数保序合并，有冲突的重复项不会默认勾选', () => {
    const result = prepareSerialOcrCandidates(extraction([
      sn('０００１２３'), sn('000123', 'ambiguous', 0.6), sn('000124'),
    ]))
    expect(result.candidates.map(x => x.value)).toEqual(['０００１２３', '000124'])
    expect(result.candidates[0].selected).toBe(false)
    expect(result.candidates[0].reasons).toContain('存在多个可能值，请逐项核对')
  })
})

describe('确认 SN 后追加', () => {
  it('对已有列表和新增候选去重，保留前导零、原文本及首次显示形式', () => {
    const original = '000123\n AbC-01 \n重复项\n重复项\n'
    expect(appendSerialCandidates(original, ['０００１２３', 'abc-01', '000124', '000124', ' XyZ '])).toEqual({
      text: `${original}000124\nXyZ`, added: 2, duplicates: 3,
    })
  })

  it('候选内部换行折叠为同一条 SN，不向列表注入额外条目', () => {
    expect(appendSerialCandidates('', ['  A\n  B  '])).toEqual({ text: 'A B', added: 1, duplicates: 0 })
  })

  it('全部已存在时保留输入，不重复追加或删除用户已有内容', () => {
    const original = ' AbC  001 \n'
    expect(appendSerialCandidates(original, ['ABC 001'])).toEqual({ text: original, added: 0, duplicates: 1 })
  })
})
