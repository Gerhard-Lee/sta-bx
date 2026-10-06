export const STATUS = {
  draft: '草稿', finance_pending: '待财委审批', chair_pending: '待主席审批',
  changes_requested: '退回修改', rejected: '已拒绝', payment_info_required: '待补充收款码',
  payment_pending: '待付款', paid: '已付款', cancelled: '已撤回'
};
// 管理员本身不是财委或主席身份；付款登记（cashier）视同财委；只有内置 admin 超级管理员可以跨身份操作。
export const isSuperAdmin = (identity) => identity?.roles?.includes('admin') === true && identity?.profile?.username?.toLowerCase() === 'admin';
export const hasRole = (identity, role) => identity?.roles?.includes(role) === true || (role !== 'admin' && isSuperAdmin(identity)) || (role === 'cashier' && identity?.roles?.includes('finance') === true);
export const isEditable = (application, identity) => application.owner_id === identity.profile.id && ['draft', 'changes_requested', 'cancelled'].includes(application.status);
export const canEditAttachments = (application, identity) => application.owner_id === identity.profile.id && ['draft', 'changes_requested', 'cancelled', 'finance_pending', 'chair_pending', 'payment_info_required', 'payment_pending'].includes(application.status);
export const canEditPaymentInfo = (application, identity) => application.owner_id === identity.profile.id && ['payment_info_required', 'payment_pending'].includes(application.status);
export const canRecordPayment = (application, identity) => hasRole(identity, 'cashier') && ['payment_pending', 'paid'].includes(application.status);
export function validateFile(file, kind = 'attachment') {
  if (file.size === 0) return '不能选择空文件。';
  if (file.size > 5 * 1024 * 1024) return '每个文件不能超过 5 MB。';
  const types = kind === 'qr' ? ['image/png', 'image/jpeg'] : ['image/png', 'image/jpeg', 'application/pdf'];
  return types.includes(file.type) ? '' : kind === 'qr' ? '请选择 PNG 或 JPG 收款码。' : '请选择 PNG、JPG 图片或 PDF 文件。';
}
export function validateStep(kind, value, hasFile, confirmed, submit) {
  if (!hasFile) return kind === 'qr' ? '请选择收款码。' : '请选择付款凭证。';
  if (!submit) return '';
  if (!value.trim()) return kind === 'qr' ? '请填写收款人姓名。' : '请填写支付宝流水号。';
  if (kind === 'receipt' && !confirmed) return '请核对收款人和金额，并确认已完成转账。';
  return '';
}

