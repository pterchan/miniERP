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
