class ApiError extends Error {
  constructor(message, status, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter }
}

// 会话级库存余额缓存：多个页面（Dashboard/清点/单据）避免各自重复下载全量余额。
// 只在真正写入 inventory_movement 的操作后失效（调整库存 / 过账 / 红冲 / 放行）。
let inventoryPromise = null
const invalidateInventory = () => { inventoryPromise = null }
const cachedInventory = () => {
  if (!inventoryPromise) inventoryPromise = api.request('/inventory/balance').catch(err => { invalidateInventory(); throw err })
  return inventoryPromise
}

function csrfToken() {
  const m = document.cookie.split('; ').find(x => x.startsWith('erp_csrf='))?.split('=').slice(1).join('=')
  return m ? decodeURIComponent(m) : ''
}

const api = {
  async request(path, options = {}) {
    const { timeoutMs = 15000, signal, ...rest } = options
    // FormData 由浏览器自动带 multipart boundary，不能再设 JSON Content-Type。
    const isFormData = typeof FormData !== 'undefined' && rest.body instanceof FormData
    const headers = { ...(rest.body && !isFormData ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers || {}) }
    if (rest.method && rest.method !== 'GET' && rest.method !== 'HEAD') {
      const csrf = csrfToken()
      if (csrf) headers['X-CSRF-Token'] = csrf
    }
    // 默认超时 + 透传调用方 AbortSignal（picker/DataTable 的取消语义保留为 AbortError）。
    const controller = new AbortController()
    const onExternalAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(`/api${path}`, { credentials: 'include', ...rest, headers, signal: controller.signal })
    } catch (err) {
      if (err.name === 'AbortError' && !signal?.aborted) {
        throw new ApiError(`请求超时（${Math.round(timeoutMs / 1000)}s 无响应），请重试`, 408)
      }
      throw err
    } finally {
      clearTimeout(timeoutId)
      if (signal) signal.removeEventListener('abort', onExternalAbort)
    }
    if (response.status === 204) return null
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = Array.isArray(body.detail) ? body.detail.map(x => x.msg || x.message).join('；') : (body.detail || body.message)
      throw new ApiError(detail || `请求失败 (${response.status})`, response.status, response.headers.get('Retry-After'))
    }
    return body
  },
  // multipart 上传专用：fetch 没有上传进度，慢水管（2Mbps）下改用 XHR + onprogress。
  // 外部 signal abort 以 AbortError 拒绝，沿用调用方 err.name !== 'AbortError' 守卫。
  requestUpload(path, formData, { onProgress, timeoutMs = 120000, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api${path}`)
      xhr.responseType = 'json'
      xhr.withCredentials = true
      const csrf = csrfToken()
      if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf)
      xhr.timeout = timeoutMs
      const onExternalAbort = () => xhr.abort()
      const cleanup = () => { if (signal) signal.removeEventListener('abort', onExternalAbort) }
      if (signal) {
        if (signal.aborted) xhr.abort()
        else signal.addEventListener('abort', onExternalAbort, { once: true })
      }
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded, e.total) }
      }
      xhr.onload = () => {
        cleanup()
        if (xhr.status === 204) { resolve(null); return }
        const body = xhr.response || {}
        if (xhr.status >= 200 && xhr.status < 300) { resolve(body); return }
        const detail = Array.isArray(body.detail) ? body.detail.map(x => x.msg || x.message).join('；') : (body.detail || body.message)
        reject(new ApiError(detail || `请求失败 (${xhr.status})`, xhr.status, xhr.getResponseHeader('Retry-After')))
      }
      xhr.onerror = () => { cleanup(); reject(new ApiError('网络错误，上传失败', 0)) }
      xhr.ontimeout = () => { cleanup(); reject(new ApiError(`上传超时（${Math.round(timeoutMs / 1000)}s），请重试`, 408)) }
      xhr.onabort = () => {
        cleanup()
        if (signal?.aborted) reject(new DOMException('The operation was aborted.', 'AbortError'))
        else reject(new ApiError('上传已中止', 0))
      }
      // FormData 由浏览器自动生成 multipart boundary，不手动设 Content-Type。
      xhr.send(formData)
    })
  },
  login: (username, password) => api.request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => api.request('/auth/logout', { method: 'POST' }),
  me: () => api.request('/auth/me'),
  changePassword: (payload) => api.request('/auth/change-password', { method: 'POST', body: JSON.stringify(payload) }),
  inventory: cachedInventory,
  inventoryByProduct: (productId) => api.request(`/inventory/balance?product_id=${encodeURIComponent(productId)}`),
  inventoryDetail: (x) => api.request(`/inventory/balance/${x.product_id}/${x.location_id}/${x.condition_id}/${x.uom_id}`),
  adjustInventory: async (payload) => { const r = await api.request('/inventory/adjust', { method: 'POST', body: JSON.stringify(payload) }); invalidateInventory(); return r },
  products: (q = '', page = 1, pageSize = 30, options = {}) => {
    // 兼容旧调用 products(q)/products(q,page,size)；传对象时按 DataTable 参数构造。
    if (typeof q === 'object' && q !== null) {
      const p = q
      const sp = new URLSearchParams()
      if (p.q) sp.set('q', p.q)
      if (p.page) sp.set('page', p.page)
      if (p.page_size) sp.set('page_size', p.page_size)
      if (p.sort) sp.set('sort', p.sort)
      if (p.order) sp.set('order', p.order)
      ;(p.f || []).forEach(x => sp.append('f', x))
      return api.request(`/products?${sp.toString()}`, { signal: p.signal })
    }
    return api.request(`/products?q=${encodeURIComponent(q)}&page=${page}&page_size=${pageSize}`, options)
  },
  productStocks: (ids) => api.request(`/products/stock?ids=${encodeURIComponent(ids)}`),
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
  action: async (id, action, payload = {}) => { const r = await api.request(`/stock-requests/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload) }); if (action === 'release') invalidateInventory(); return r },
  conflicts: () => api.request('/conflicts'),
  conflict: (id) => api.request(`/conflicts/${id}`),
  resolveConflict: (id, payload) => api.request(`/conflicts/${id}/resolve`, { method: 'POST', body: JSON.stringify(payload) }),
  linkConflict: (id, payload) => api.request(`/conflicts/${id}/link-product`, { method: 'POST', body: JSON.stringify(payload) }),
  createConflictProduct: (id, payload) => api.request(`/conflicts/${id}/create-product`, { method: 'POST', body: JSON.stringify(payload) }),
  editConflictProduct: (id, payload) => api.request(`/conflicts/${id}/edit-product`, { method: 'POST', body: JSON.stringify(payload) }),
  // 进销存单据
  documents: (params = {}) => {
    const { signal, timeoutMs, ...query } = params
    return api.request(`/documents?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString()}`, { signal, timeoutMs })
  },
  document: (id) => api.request(`/documents/${id}`),
  createDocument: (payload) => api.request('/documents', { method: 'POST', body: JSON.stringify(payload) }),
  updateDocument: (id, payload) => api.request(`/documents/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  submitDocument: (id) => api.request(`/documents/${id}/submit`, { method: 'POST', body: '{}' }),
  postDocument: async (id, payload) => { const r = await api.request(`/documents/${id}/post`, { method: 'POST', body: JSON.stringify(payload) }); invalidateInventory(); return r },
  reverseDocument: async (id) => { const r = await api.request(`/documents/${id}/reverse`, { method: 'POST', body: '{}' }); invalidateInventory(); return r },
  addAttachment: (id, file, options = {}) => { const form = new FormData(); form.append('file', file); return api.requestUpload(`/documents/${id}/attachments`, form, options) },
  attachmentUrl: (attachmentId) => `/api/attachments/${attachmentId}`,
  // 货品附图（MinIO）
  productImages: (productId) => api.request(`/products/${productId}/images`),
  uploadProductImages: (productId, files, options = {}) => {
    const form = new FormData()
    files.forEach(file => form.append('files', file))
    return api.requestUpload(`/products/${productId}/images`, form, options)
  },
  productImageContent: (imageId, size = '') => size ? `/api/product-images/${imageId}/content?size=${size}` : `/api/product-images/${imageId}/content`,
  updateProductImage: (imageId, payload) => api.request(`/product-images/${imageId}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteProductImage: (imageId) => api.request(`/product-images/${imageId}`, { method: 'DELETE' }),
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
  ocrExtract: (payload, signal) => api.request('/ocr/extract', { method: 'POST', body: JSON.stringify(payload), signal, timeoutMs: 60000 }),
}

export default api
export { ApiError }
