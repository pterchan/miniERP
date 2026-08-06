/**
 * Format a quantity for display. Integral values drop the decimal entirely
 * ("12" not "12.000"); fractional values keep only the meaningful digits
 * ("8.5" not "8.500"). Accepts strings from the API and plain numbers.
 */
export function formatQuantity(value, maxScale = 3) {
  if (value === null || value === undefined || value === '' || value === '—') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (Number.isInteger(n)) return String(n)
  return String(parseFloat(n.toFixed(maxScale)))
}

/** Format a money amount: thousands separators, trailing zeros trimmed. */
export function formatMoney(value, maxScale = 2) {
  if (value === null || value === undefined || value === '' || value === '—') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  const fixed = n.toFixed(maxScale)
  const [intPart, decPart] = fixed.split('.')
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const dec = (decPart || '').replace(/0+$/, '')
  return dec ? `${withSep}.${dec}` : withSep
}

export function formatInventorySummary(entries) {
  if (!entries?.length) return '无库存'

  return entries
    .map(({ uom_code, quantity }) => `${formatQuantity(quantity)} ${uom_code || '—'}`)
    .join(' · ')
}
