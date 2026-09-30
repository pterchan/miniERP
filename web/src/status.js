/** 业务状态的唯一显示来源；actions 只表达状态允许的动作，权限仍由角色矩阵判断。 */
export const STATUS_REGISTRY = {
  document: {
    DRAFT: { label: '草稿', tone: 'neutral', actions: ['edit', 'submit'] },
    SUBMITTED: { label: '待审批', tone: 'info', actions: ['post', 'reject', 'withdraw'] },
    POSTED: { label: '已过账', tone: 'success', actions: ['reverse'] },
    WITHDRAWN: { label: '已撤回', tone: 'neutral', actions: [] },
    REVERSED: { label: '已红冲', tone: 'danger', actions: [] },
  },
  request: {
    DRAFT: { label: '草稿', tone: 'neutral', actions: ['edit', 'submit'] },
    SUBMITTED: { label: '待审批', tone: 'warning', actions: ['approve', 'reject', 'withdraw'] },
    APPROVED: { label: '已批准', tone: 'info', actions: ['release'] },
    WITHDRAWN: { label: '已撤回', tone: 'neutral', actions: [] },
    REJECTED: { label: '已驳回', tone: 'danger', actions: [] },
    RELEASED: { label: '已放行', tone: 'success', actions: [] },
  },
  conflict: {
    pending_review: { label: '待处理', tone: 'warning', actions: ['link', 'create', 'edit', 'ignore'] },
    resolved: { label: '已处理', tone: 'neutral', actions: [] },
    duplicate: { label: '重复', tone: 'neutral', actions: [] },
    ignored: { label: '已忽略', tone: 'neutral', actions: [] },
  },
  serial: {
    active: { label: '在库', tone: 'success', actions: [] },
    retired: { label: '已出库', tone: 'neutral', actions: [] },
    lost: { label: '遗失', tone: 'danger', actions: [] },
  },
  active: {
    active: { label: '启用', tone: 'success', actions: [] },
    inactive: { label: '停用', tone: 'neutral', actions: [] },
  },
}
STATUS_REGISTRY.account = STATUS_REGISTRY.active
STATUS_REGISTRY.location = STATUS_REGISTRY.active

export function getStatus(domain, value) {
  const key = typeof value === 'boolean' ? (value ? 'active' : 'inactive') : value
  return STATUS_REGISTRY[domain]?.[key] || { label: value == null || value === '' ? '—' : '未知状态', tone: 'neutral', actions: [] }
}
export function statusLabel(domain, value) { return getStatus(domain, value).label }

export const ACTION_LABELS = {
  CREATE: '创建', EDIT: '编辑', UPDATE: '更新', DELETE: '删除', SUBMIT: '提交', SUBMITTED: '提交',
  POST: '过账', REVERSE: '红冲', REJECT: '驳回', REJECTED: '驳回', WITHDRAW: '撤回',
  APPROVE: '审批', APPROVED: '审批', RELEASE: '放行', RELEASED: '放行', DRAFT: '撤回',
  ATTACH: '上传附件', UPLOAD: '上传附件', RESOLVE: '处理', LINK: '关联', LOGIN: '登录', LOGOUT: '退出',
  COUNT: '清点库存', ADJUST: '调整库存', COUNT_BOOK: '记录盘点账面', CHANGE_PASSWORD: '修改密码', RESET_PASSWORD: '重置密码', REORDER: '调整顺序', DEACTIVATE: '停用', ACTIVATE: '启用',
}
export function actionLabel(action) { return ACTION_LABELS[action] || '更新记录' }
