import React from 'react'
import { formatInventorySummary, formatQuantity } from './list-utils'
import { withBasePath } from './app-path'

function RowLink({ LinkComponent, to, children, ...props }) {
  if (LinkComponent) return <LinkComponent to={to} {...props}>{children}</LinkComponent>
  return <a href={withBasePath(to)} {...props}>{children}</a>
}

export function BalanceList({ rows, LinkComponent }) {
  return <div className="data-list inventory-data-list" aria-label="库存余额列表">
    <div className="data-list-head"><span>业务编号</span><span>货品名称</span><span>库位</span><span>成色</span><span className="align-end">现库存</span><span>单位</span></div>
    {rows.map((row, index) => {
      const secondary = [row.manufacturer, row.specification].filter(value => value && value !== '—')
      const identifier = row.identifier || '—'
      const productName = row.product_name || '未命名货品'
      const location = row.location_name || '—'
      const condition = row.condition_code || '—'
      const quantity = formatQuantity(row.on_hand_quantity)
      const unit = row.uom_code || '—'
      const accessibleName = `业务编号 ${identifier}，货品名称 ${productName}，库位 ${location}，成色 ${condition}，现库存 ${quantity} ${unit}`
      return <RowLink LinkComponent={LinkComponent} key={`${row.product_id}-${row.location_id}-${row.condition_id}-${row.uom_id}-${index}`} className="data-row" to={`/inventory/${row.product_id}/${row.location_id}/${row.condition_id}/${row.uom_id}`} aria-label={accessibleName}><span className="data-cell code-cell" data-label="业务编号">{identifier}</span><span className="data-cell name-cell" data-label="货品名称"><strong>{productName}</strong>{secondary.length > 0 && <small>{secondary.join(' · ')}</small>}</span><span className="data-cell" data-label="库位">{location}<small className="medium-condition-meta">成色 {condition}</small></span><span className="data-cell" data-label="成色">{condition}</span><span className="data-cell quantity-cell" data-label="现库存">{quantity}<span className="mobile-unit"> {unit}</span></span><span className="data-cell unit-cell" data-label="单位">{unit}</span></RowLink>
    })}
  </div>
}

export function ProductRows({ rows, inventoryByProduct, inventoryAvailable = true, LinkComponent }) {
  return <div className="data-list product-data-list" aria-label="货品列表">
    <div className="data-list-head"><span>业务编号</span><span>货品名称</span><span>厂家</span><span>规格 / 型号</span><span>现库存</span><span>默认单位</span></div>
    {rows.map(row => {
      const identifier = row.identifier || '—'
      const productName = row.display_name || '未命名'
      const manufacturer = row.manufacturer || '—'
      const specification = row.specification || '—'
      const defaultUnit = row.uom_code || '—'
      const summary = inventoryAvailable ? formatInventorySummary(inventoryByProduct.get(String(row.product_id))) : '—'
      const stock = summary === '无库存' ? `无库存 · ${defaultUnit}` : summary
      const accessibleName = `业务编号 ${identifier}，货品名称 ${productName}，厂家 ${manufacturer}，规格或型号 ${specification}，现库存 ${stock}，默认单位 ${defaultUnit}`
      return <RowLink LinkComponent={LinkComponent} className="data-row" key={row.product_id} to={`/products/${row.product_id}`} aria-label={accessibleName}><span className="data-cell code-cell" data-label="业务编号">{identifier}</span><span className="data-cell name-cell" data-label="货品名称"><strong>{productName}</strong><small className="medium-product-meta">{manufacturer}</small></span><span className="data-cell" data-label="厂家">{manufacturer}</span><span className="data-cell" data-label="规格 / 型号">{specification}</span><span className="data-cell stock-cell" data-label="现库存">{stock}<small className="compact-default-unit">默认 {defaultUnit}</small></span><span className="data-cell unit-cell" data-label="默认单位">{defaultUnit}</span></RowLink>
    })}
  </div>
}
