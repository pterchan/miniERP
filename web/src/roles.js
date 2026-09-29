export const ROLE_LABELS = {
  ADMIN: '管理员',
  WAREHOUSE: '仓管',
  SALES: '销售',
  FINANCE: '财务',
  COLLEAGUE: '同事',
}

/** 页面访问控制：角色 → 可见页面 */
export const PAGE_ACCESS = {
  products: ['ADMIN', 'WAREHOUSE', 'SALES', 'FINANCE', 'COLLEAGUE'],
  count: ['WAREHOUSE', 'ADMIN'],
  serials: ['WAREHOUSE', 'ADMIN'],
  purchase: ['WAREHOUSE', 'ADMIN', 'FINANCE'],
  sales: ['SALES', 'ADMIN', 'WAREHOUSE'],
  inventoryDocs: ['WAREHOUSE', 'ADMIN'],
  reports: ['FINANCE', 'ADMIN'],
  customers: ['SALES', 'FINANCE', 'ADMIN'],
  suppliers: ['WAREHOUSE', 'FINANCE', 'ADMIN'],
  categories: ['ADMIN'],
  conflicts: ['ADMIN'],
  audit: ['ADMIN', 'FINANCE'],
  system: ['ADMIN'],
}

export const canView = (user, page) => !!user && (PAGE_ACCESS[page] || []).includes(user.role)
export const can = (user, ...roles) => !!user && roles.includes(user.role)

/** 写操作权限：角色 → 可执行写操作的资源（与后端 require_roles 对齐）。
 * 页面可见（PAGE_ACCESS）不等于可写；新增写入口时在此登记，避免前端放行后端 403。 */
export const EDIT_ACCESS = {
  uom: ['ADMIN'],                                  // POST /api/uoms 仅 ADMIN
  customers: ['SALES', 'ADMIN'],                   // POST /api/customers
  suppliers: ['WAREHOUSE', 'ADMIN'],               // POST /api/suppliers
}

export const canEdit = (user, resource) => !!user && (EDIT_ACCESS[resource] || []).includes(user.role)
