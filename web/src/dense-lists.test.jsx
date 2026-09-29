import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BalanceList, ProductRows } from './dense-lists'

afterEach(cleanup)

describe('dense business lists', () => {
  it('renders the inventory columns and accurate fallback identifier', () => {
    render(<BalanceList rows={[{ product_id: 1, location_id: 2, condition_id: 3, uom_id: 4, product_name: '无菌敷料', location_name: '一号库', condition_code: 'NEW', on_hand_quantity: '8.5', uom_code: 'EA', identifier: '—' }]} />)

    const list = screen.getByLabelText('库存余额列表')
    expect(within(list).getByText('业务编号')).toBeInTheDocument()
    expect(within(list).getByText('现库存')).toBeInTheDocument()
    expect(within(list).getByText('无菌敷料')).toBeInTheDocument()
    expect(within(list).getByText('—')).toBeInTheDocument()
    expect(within(list).getByRole('link')).toHaveAccessibleName(/业务编号 —.*成色 NEW.*现库存 8.5 EA/)
  })

  it('renders integral stock without a decimal point or decimals', () => {
    render(<BalanceList rows={[{ product_id: 1, location_id: 2, condition_id: 3, uom_id: 4, product_name: '测试货品', location_name: '主仓库', condition_code: 'NEW', on_hand_quantity: '12.000', uom_code: 'EA', identifier: 'MED-1' }]} />)

    const list = screen.getByLabelText('库存余额列表')
    expect(within(list).getByText('12')).toBeInTheDocument()
    expect(within(list).getByRole('link')).toHaveAccessibleName(/现库存 12 EA/)
  })

  it('renders product columns and keeps multiple units separate', () => {
    const inventoryByProduct = new Map([['7', [{ uom_code: 'BOX', quantity: 3 }, { uom_code: 'EA', quantity: 12 }]]])
    render(<ProductRows inventoryByProduct={inventoryByProduct} rows={[{ product_id: 7, identifier: 'MED-7', display_name: '手术器械', manufacturer: '厂家 A', specification: 'XL', uom_code: 'EA' }]} />)

    const list = screen.getByLabelText('货品列表')
    expect(within(list).getByText('规格 / 型号')).toBeInTheDocument()
    expect(within(list).getByText('3 BOX · 12 EA')).toBeInTheDocument()
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/erp/products/7')
  })

  it('uses a placeholder while supplementary inventory is unavailable', () => {
    render(<ProductRows inventoryAvailable={false} inventoryByProduct={new Map()} rows={[{ product_id: 8, identifier: 'MED-8', display_name: '耗材', uom_code: 'EA' }]} />)

    const list = screen.getByLabelText('货品列表')
    expect(within(list).getByText('—', { selector: '.stock-cell' })).toBeInTheDocument()
    expect(within(list).queryByText(/无库存/)).not.toBeInTheDocument()
  })
})
