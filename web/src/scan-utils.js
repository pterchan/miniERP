export const MAX_OCR_CANDIDATES = 4

/** Search OCR terms in priority order and stop at the first non-empty result. */
export async function findProductMatches(searchTerms, searchProducts) {
  for (const term of (searchTerms || []).filter(item => item?.value).slice(0, MAX_OCR_CANDIDATES)) {
    const items = await searchProducts(term.value)
    if (items?.length) return items
  }
  return []
}
