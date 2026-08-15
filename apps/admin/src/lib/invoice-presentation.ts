import type { InvoiceRequestStatus, OrderStatus } from '@conference/contracts';

export type AdminInvoiceActionCode =
  | 'approve_invoice'
  | 'download_invoice'
  | 'issue_invoice'
  | 'request_invoice_details'
  | 'retry_invoice'
  | 'send_invoice'
  | 'void_invoice';

export interface AdminInvoicePresentationInput {
  access: 'included' | 'restricted';
  invoiceRequired: boolean;
  orderStatus?: OrderStatus;
  request: {
    status: InvoiceRequestStatus;
    deliveryStatus: 'not_sent' | 'queued' | 'sent' | 'failed';
    invoiceNumber?: string | null;
  } | null;
}

export interface AdminInvoicePresentation {
  stage: 'not_requested' | 'pending' | 'issued' | 'terminated' | 'anomaly' | 'restricted';
  stageLabel: string;
  substateLabel: string;
  deliveryLabel: string;
  summary: string;
  tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger';
  attentionLevel: 0 | 1 | 2 | 3;
  primaryActionCode: AdminInvoiceActionCode | null;
}

export function deriveAdminInvoicePresentation(
  input: AdminInvoicePresentationInput,
): AdminInvoicePresentation {
  if (input.access === 'restricted') {
    return {
      stage: 'restricted',
      stageLabel: '无查看权限',
      substateLabel: '权限受限',
      deliveryLabel: '',
      summary: '需要发票查看权限',
      tone: 'neutral',
      attentionLevel: 0,
      primaryActionCode: null,
    };
  }

  if (input.request?.status === 'awaiting_details') {
    const deliveryLabel =
      input.request.deliveryStatus === 'sent'
        ? '填写入口已发送'
        : input.request.deliveryStatus === 'queued'
          ? '填写入口发送中'
          : input.request.deliveryStatus === 'failed'
            ? '填写入口发送失败'
            : '填写入口待发送';
    return {
      stage: 'pending',
      stageLabel: '待开票',
      substateLabel: '待提交资料',
      deliveryLabel,
      summary: deliveryLabel,
      tone: input.request.deliveryStatus === 'failed' ? 'danger' : 'warning',
      attentionLevel: input.request.deliveryStatus === 'failed' ? 3 : 1,
      primaryActionCode: 'request_invoice_details',
    };
  }

  if (input.request?.status === 'issued') {
    const deliveryLabel =
      input.request.deliveryStatus === 'sent'
        ? '已发送'
        : input.request.deliveryStatus === 'queued'
          ? '发送中'
          : input.request.deliveryStatus === 'failed'
            ? '发送失败'
            : '未发送';
    const summary = input.request.invoiceNumber
      ? `${deliveryLabel} · ${input.request.invoiceNumber}`
      : deliveryLabel;
    return {
      stage: 'issued',
      stageLabel: '已开票',
      substateLabel: '已开具',
      deliveryLabel,
      summary,
      tone: input.request.deliveryStatus === 'failed' ? 'danger' : 'success',
      attentionLevel: input.request.deliveryStatus === 'failed' ? 3 : 0,
      primaryActionCode:
        input.request.deliveryStatus === 'failed' ? 'send_invoice' : 'download_invoice',
    };
  }

  if (input.request) {
    const states: Record<
      Exclude<InvoiceRequestStatus, 'awaiting_details' | 'issued'>,
      Omit<AdminInvoicePresentation, 'deliveryLabel' | 'summary'>
    > = {
      pending_review: {
        stage: 'pending',
        stageLabel: '待开票',
        substateLabel: '资料待审核',
        tone: 'warning',
        attentionLevel: 2,
        primaryActionCode: 'approve_invoice',
      },
      issuing: {
        stage: 'pending',
        stageLabel: '待开票',
        substateLabel: '开票中',
        tone: 'info',
        attentionLevel: 1,
        primaryActionCode: 'issue_invoice',
      },
      issue_failed: {
        stage: 'pending',
        stageLabel: '待开票',
        substateLabel: '开票失败',
        tone: 'danger',
        attentionLevel: 3,
        primaryActionCode: 'retry_invoice',
      },
      rejected: {
        stage: 'pending',
        stageLabel: '待开票',
        substateLabel: '资料已驳回',
        tone: 'warning',
        attentionLevel: 2,
        primaryActionCode: 'request_invoice_details',
      },
      adjustment_required: {
        stage: 'issued',
        stageLabel: '已开票',
        substateLabel: '退款待调整',
        tone: 'danger',
        attentionLevel: 3,
        primaryActionCode: 'void_invoice',
      },
      voided: {
        stage: 'terminated',
        stageLabel: '已终止',
        substateLabel: '已作废',
        tone: 'neutral',
        attentionLevel: 1,
        primaryActionCode: 'retry_invoice',
      },
      cancelled: {
        stage: 'terminated',
        stageLabel: '已终止',
        substateLabel: '已取消',
        tone: 'neutral',
        attentionLevel: 0,
        primaryActionCode: null,
      },
    };
    const state = states[input.request.status];
    return {
      ...state,
      deliveryLabel: '',
      summary: state.substateLabel,
    };
  }

  if (
    input.invoiceRequired &&
    ['paid', 'partially_refunded', 'refunded'].includes(input.orderStatus ?? '')
  ) {
    return {
      stage: 'anomaly',
      stageLabel: '数据异常',
      substateLabel: '申请记录缺失',
      deliveryLabel: '',
      summary: '已支付订单缺少发票申请',
      tone: 'danger',
      attentionLevel: 3,
      primaryActionCode: null,
    };
  }

  if (input.invoiceRequired) {
    return {
      stage: 'pending',
      stageLabel: '待开票',
      substateLabel: input.orderStatus ? '待支付' : '等待生成订单',
      deliveryLabel: '',
      summary: input.orderStatus ? '支付后进入开票流程' : '等待订单创建',
      tone: 'warning',
      attentionLevel: 1,
      primaryActionCode: null,
    };
  }

  return {
    stage: 'not_requested',
    stageLabel: '未申请',
    substateLabel: '报名时未选择',
    deliveryLabel: '',
    summary: '报名时未选择发票',
    tone: 'neutral',
    attentionLevel: 0,
    primaryActionCode: null,
  };
}
