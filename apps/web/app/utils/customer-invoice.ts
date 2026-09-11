import type {
  CustomerInvoiceCenterCategory,
  CustomerInvoiceCenterItem,
  InvoiceRequestStatus,
} from '@conference/contracts';

export const customerInvoiceStatusCopy: Record<
  InvoiceRequestStatus,
  { label: string; description: string; tone: 'neutral' | 'info' | 'warning' | 'success' }
> = {
  awaiting_details: {
    label: '待补充资料',
    description: '补充购买方信息后即可提交审核',
    tone: 'warning',
  },
  pending_review: {
    label: '待审核',
    description: '主办方正在核对开票资料',
    tone: 'info',
  },
  issuing: {
    label: '开具中',
    description: '资料已通过审核，电子发票正在开具',
    tone: 'info',
  },
  issue_failed: {
    label: '开票处理中',
    description: '主办方正在处理开票异常',
    tone: 'warning',
  },
  issued: {
    label: '已开具',
    description: '电子发票可以下载或重新发送',
    tone: 'success',
  },
  rejected: {
    label: '待修改',
    description: '请根据驳回原因修改并重新提交',
    tone: 'warning',
  },
  adjustment_required: {
    label: '退款调整中',
    description: '主办方正在处理退款后的发票调整',
    tone: 'warning',
  },
  voided: {
    label: '已作废',
    description: '当前发票文件已经作废',
    tone: 'neutral',
  },
  cancelled: {
    label: '已取消',
    description: '本次发票申请已经取消',
    tone: 'neutral',
  },
};

export const customerInvoiceCategories: Array<{
  value: CustomerInvoiceCenterCategory;
  label: string;
  countKey: 'all' | 'eligible' | 'actionRequired' | 'processing' | 'issued' | 'history';
}> = [
  { value: 'all', label: '全部', countKey: 'all' },
  { value: 'eligible', label: '可申请', countKey: 'eligible' },
  { value: 'action_required', label: '待我处理', countKey: 'actionRequired' },
  { value: 'processing', label: '处理中', countKey: 'processing' },
  { value: 'issued', label: '已开具', countKey: 'issued' },
  { value: 'history', label: '历史记录', countKey: 'history' },
];

export function customerInvoicePrimaryAction(item: CustomerInvoiceCenterItem) {
  if (item.availableActions.includes('apply')) return '申请发票';
  if (item.availableActions.includes('edit')) {
    return item.status === 'pending_review' ? '修改资料' : '继续处理';
  }
  if (item.availableActions.includes('download')) return '查看与下载';
  return '查看详情';
}

export function customerInvoiceDownloadUrl(path: string, apiBase: string) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${String(apiBase).replace(/\/$/u, '')}/${path.replace(/^\//u, '')}`;
}

export function invoiceMoney(amount: number, currency = 'CNY') {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
  }).format(amount / 100);
}

export function invoiceDate(value: string | null, withTime = false) {
  if (!value) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(new Date(value));
}

export function invoiceFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function invoiceDocumentType(value: 'original' | 'adjustment' | 'reissue') {
  if (value === 'adjustment') return '调整文件';
  if (value === 'reissue') return '重开发票';
  return '电子发票';
}
