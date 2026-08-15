export function money(amount: number) {
  return `¥${(amount / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`;
}

export function dateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

const statusLabels: Record<string, string> = {
  draft: '草稿',
  configuring: '配置中',
  prepublished: '预发布',
  registration_open: '报名开放',
  in_progress: '进行中',
  ended: '已结束',
  archived: '已归档',
  pending_review: '待审核',
  pending_payment: '待支付',
  payment_processing: '支付中',
  payment_failed: '支付失败',
  processing: '处理中',
  confirmed: '已确认',
  paid: '已支付',
  checked_in: '已签到',
  completed: '已完成',
  cancelled: '已取消',
  closed: '已关闭',
  refunded: '已退款',
  partially_refunded: '部分退款',
  waiting: '候补中',
  invited: '已邀请',
  claimed: '已使用资格',
  expired: '邀请过期',
  published: '已发布',
  approved: '已审核',
  rejected: '已拒绝',
  sent: '已发送',
  failed: '失败',
  succeeded: '已完成',
  queued: '等待处理',
  active: '已启用',
  valid: '有效',
  used: '已使用',
  awaiting_details: '待提交资料',
  issuing: '开票中',
  issue_failed: '开票失败',
  issued: '已开具',
  eligible: '可申请',
  not_eligible: '不可开票',
  adjustment_required: '待调整',
  voided: '已作废',
  not_sent: '未发送',
  preparing: '准备中',
  query_pending: '查询中',
  close_pending: '关闭中',
  unknown: '状态未知',
};

export function statusLabel(status: string) {
  return statusLabels[status] ?? status;
}

export function statusClass(status: string) {
  if (['pending_review', 'processing', 'payment_processing', 'prepublished', 'queued'].includes(status)) return 'pending';
  if (['cancelled', 'closed', 'refunded', 'rejected', 'failed', 'payment_failed'].includes(status)) return 'issue';
  if (['pending_payment', 'draft', 'configuring'].includes(status)) return 'draft';
  if (['ended', 'archived'].includes(status)) return 'muted';
  return '';
}
