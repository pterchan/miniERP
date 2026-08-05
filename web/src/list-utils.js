export const MAX_PRODUCT_PAGES = 1000

/**
 * Read the complete product catalogue without assuming that every page is full.
 * Errors from fetchPage intentionally propagate so callers can show a degraded UI.
 */
export async function fetchAllProductPages(fetchPage, pageSize = 100) {
  const products = []

  for (let page = 1; page <= MAX_PRODUCT_PAGES; page += 1) {
    const response = await fetchPage(page, pageSize)
    const items = Array.isArray(response?.items) ? response.items : []

    if (items.length === 0) break

    products.push(...items)
    const total = Number(response?.total)
    if (Number.isFinite(total) && products.length >= total) break
  }

  return products
}

/**
 * Group balances by product and then unit. Product keys are strings so API ids
 * can be looked up consistently from React props and route parameters.
 */
export function buildInventoryByProduct(rows) {
  const quantitiesByProduct = new Map()

  for (const row of rows || []) {
    if (row?.product_id == null) continue

    const productId = String(row.product_id)
    const uomCode = row.uom_code || '—'
    const parsedQuantity = Number(row.on_hand_quantity)
    const quantity = Number.isFinite(parsedQuantity) ? parsedQuantity : 0

    if (!quantitiesByProduct.has(productId)) {
      quantitiesByProduct.set(productId, new Map())
    }

    const quantitiesByUom = quantitiesByProduct.get(productId)
    const previousMilliunits = Math.round((quantitiesByUom.get(uomCode) || 0) * 1000)
    const nextMilliunits = Math.round(quantity * 1000)
    quantitiesByUom.set(uomCode, (previousMilliunits + nextMilliunits) / 1000)
  }

  return new Map(
    Array.from(quantitiesByProduct, ([productId, quantitiesByUom]) => [
      productId,
      Array.from(quantitiesByUom, ([uom_code, quantity]) => ({ uom_code, quantity }))
        .sort((left, right) => left.uom_code.localeCompare(right.uom_code, 'en')),
    ]),
  )
}

export function formatInventorySummary(entries) {
  if (!entries?.length) return '无库存'

  return entries
    .map(({ uom_code, quantity }) => `${Number(quantity)} ${uom_code || '—'}`)
    .join(' · ')
}

/** Join catalogue-only fields onto balance rows while keeping base rows usable. */
export function enrichInventoryRows(rows, products) {
  const productsById = new Map(
    (products || [])
      .filter(product => product?.product_id != null)
      .map(product => [String(product.product_id), product]),
  )

  return (rows || []).map(row => {
    const product = productsById.get(String(row?.product_id))

    return {
      ...row,
      identifier: product?.identifier || '—',
      manufacturer: product?.manufacturer || '—',
      specification: product?.specification || '—',
    }
  })
}
