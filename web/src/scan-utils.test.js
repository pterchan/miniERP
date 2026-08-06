import { describe, expect, it, vi } from 'vitest'
import { findProductMatches, MAX_OCR_CANDIDATES } from './scan-utils'

describe('findProductMatches', () => {
  it('falls back through at most four OCR terms in priority order', async () => {
    const search = vi.fn(async value => value === '第五候选' ? [{ product_id: 5 }] : [])
    const terms = Array.from({ length: 6 }, (_, index) => ({ value: `${index + 1}候选` }))
    terms[4].value = '第五候选'
    const result = await findProductMatches(terms, search)
    expect(result).toEqual([])
    expect(search).toHaveBeenCalledTimes(MAX_OCR_CANDIDATES)
  })

  it('returns the first non-empty candidate result', async () => {
    const search = vi.fn(async value => value === '型号' ? [{ product_id: 42 }] : [])
    await expect(findProductMatches([{ value: '编号' }, { value: '型号' }], search)).resolves.toEqual([{ product_id: 42 }])
    expect(search).toHaveBeenCalledWith('编号')
    expect(search).toHaveBeenCalledWith('型号')
  })

  it('passes fuzzy items through unchanged', async () => {
    const search = vi.fn(async () => [{ product_id: 7, display_name: 'X', match_type: 'fuzzy', match_score: 0.9 }])
    const out = await findProductMatches([{ value: 'X' }], search)
    expect(out[0].match_type).toBe('fuzzy')
    expect(out[0].match_score).toBe(0.9)
  })
})
