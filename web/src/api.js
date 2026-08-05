import { fetchAllProductPages } from './list-utils'

class ApiError extends Error {
  constructor(message, status, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter }
}

const api = {
  async request(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    if (options.method && options.method !== 'GET' && options.method !== 'HEAD') {
      const csrf = document.cookie.split('; ').find(x => x.startsWith('erp_csrf='))?.split('=').slice(1).join('=')
      if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf)
    }
    const response = await fetch(`/api${path}`, { credentials: 'include', ...options, headers })
    if (response.status === 204) return null
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = Array.isArray(body.detail) ? body.detail.map(x => x.msg || x.message).join('；') : (body.detail || body.message)
      throw new ApiError(detail || `请求失败 (${response.status})`, response.status, response.headers.get('Retry-After'))
    }
    return body
  },
  login: (username, password) => api.request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => api.request('/auth/logout', { method: 'POST' }),
  me: () => api.request('/auth/me'),
  changePassword: (payload) => api.request('/auth/change-password', { method: 'POST', body: JSON.stringify(payload) }),
  inventory: () => api.request('/inventory/balance'),
  inventoryDetail: (x) => api.request(`/inventory/balance/${x.product_id}/${x.location_id}/${x.condition_id}/${x.uom_id}`),
  adjustInventory: (payload) => api.request('/inventory/adjust', { method: 'POST', body: JSON.stringify(payload) }),
  products: (q = '', page = 1, pageSize = 30) => api.request(`/products?q=${encodeURIComponent(q)}&page=${page}&page_size=${pageSize}`),
  productCatalog: () => fetchAllProductPages((page, pageSize) => api.products('', page, pageSize)),
  product: (id) => api.request(`/products/${id}`),
  createProduct: (payload) => api.request('/products', { method: 'POST', body: JSON.stringify(payload) }),
  updateProduct: (id, payload) => api.request(`/products/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  uoms: () => api.request('/uoms'),
  createUom: (payload) => api.request('/uoms', { method: 'POST', body: JSON.stringify(payload) }),
  locations: () => api.request('/locations'),
  location: (id) => api.request(`/locations/${id}`),
  createLocation: (payload) => api.request('/locations', { method: 'POST', body: JSON.stringify(payload) }),
  updateLocation: (id, payload) => api.request(`/locations/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  users: () => api.request('/admin/users'),
  user: (id) => api.request(`/admin/users/${id}`),
  createUser: (payload) => api.request('/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (id, payload) => api.request(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  resetPassword: (id, password) => api.request(`/admin/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  requests: () => api.request('/stock-requests'),
  stockRequest: (id) => api.request(`/stock-requests/${id}`),
  createRequest: (payload) => api.request('/stock-requests', { method: 'POST', body: JSON.stringify(payload) }),
  updateRequest: (id, payload) => api.request(`/stock-requests/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  action: (id, action, payload = {}) => api.request(`/stock-requests/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload) }),
  conflicts: () => api.request('/conflicts'),
  conflict: (id) => api.request(`/conflicts/${id}`),
  resolveConflict: (id, payload) => api.request(`/conflicts/${id}/resolve`, { method: 'POST', body: JSON.stringify(payload) }),
  linkConflict: (id, payload) => api.request(`/conflicts/${id}/link-product`, { method: 'POST', body: JSON.stringify(payload) }),
  createConflictProduct: (id, payload) => api.request(`/conflicts/${id}/create-product`, { method: 'POST', body: JSON.stringify(payload) }),
  editConflictProduct: (id, payload) => api.request(`/conflicts/${id}/edit-product`, { method: 'POST', body: JSON.stringify(payload) }),
  // 进销存单据
  documents: (params = {}) => api.request(`/documents?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString()}`),
  document: (id) => api.request(`/documents/${id}`),
  createDocument: (payload) => api.request('/documents', { method: 'POST', body: JSON.stringify(payload) }),
  updateDocument: (id, payload) => api.request(`/documents/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  submitDocument: (id) => api.request(`/documents/${id}/submit`, { method: 'POST', body: '{}' }),
  postDocument: (id, payload) => api.request(`/documents/${id}/post`, { method: 'POST', body: JSON.stringify(payload) }),
  reverseDocument: (id) => api.request(`/documents/${id}/reverse`, { method: 'POST', body: '{}' }),
  addAttachment: (id, payload) => api.request(`/documents/${id}/attachments`, { method: 'POST', body: JSON.stringify(payload) }),
  attachmentUrl: (attachmentId) => `/api/attachments/${attachmentId}`,
  // 主数据
  categories: () => api.request('/categories'),
  createCategory: (payload) => api.request('/categories', { method: 'POST', body: JSON.stringify(payload) }),
  updateCategory: (id, payload) => api.request(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  customers: () => api.request('/customers'),
  customer: (id) => api.request(`/customers/${id}`),
  createCustomer: (payload) => api.request('/customers', { method: 'POST', body: JSON.stringify(payload) }),
  updateCustomer: (id, payload) => api.request(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  suppliers: () => api.request('/suppliers'),
  supplier: (id) => api.request(`/suppliers/${id}`),
  createSupplier: (payload) => api.request('/suppliers', { method: 'POST', body: JSON.stringify(payload) }),
  updateSupplier: (id, payload) => api.request(`/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  priceTiers: (productId) => api.request(`/products/${productId}/price-tiers`),
  createPriceTier: (productId, payload) => api.request(`/products/${productId}/price-tiers`, { method: 'POST', body: JSON.stringify(payload) }),
  updatePriceTier: (productId, tierId, payload) => api.request(`/products/${productId}/price-tiers/${tierId}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deletePriceTier: (productId, tierId) => api.request(`/products/${productId}/price-tiers/${tierId}`, { method: 'DELETE' }),
  departments: () => api.request('/departments'),
  createDepartment: (payload) => api.request('/departments', { method: 'POST', body: JSON.stringify(payload) }),
  // 报表
  reports: {
    purchase: (params = {}) => api.request(`/reports/purchase-reconciliation?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString()}`),
    arAp: () => api.request('/reports/ar-ap-summary'),
    receivables: (partyId) => api.request(`/reports/receivables?${partyId ? `party_id=${partyId}` : ''}`),
    payables: (partyId) => api.request(`/reports/payables?${partyId ? `party_id=${partyId}` : ''}`),
    inventoryCost: () => api.request('/reports/inventory-cost'),
  },
  audit: () => api.request('/audit?limit=100'),
  auditEvent: (id) => api.request(`/audit/${id}`),
  ocrExtract: (payload, signal) => api.request('/ocr/extract', { method: 'POST', body: JSON.stringify(payload), signal }),
}

export default api
export { ApiError }
