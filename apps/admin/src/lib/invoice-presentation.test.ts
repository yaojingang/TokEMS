import { describe, expect, it } from 'vitest';
import { deriveAdminInvoicePresentation } from './invoice-presentation';

describe('deriveAdminInvoicePresentation', () => {
  it('shows an issued and delivered invoice as a completed business stage', () => {
    expect(
      deriveAdminInvoicePresentation({
        access: 'included',
        invoiceRequired: true,
        orderStatus: 'paid',
        request: {
          status: 'issued',
          deliveryStatus: 'sent',
          invoiceNumber: 'INV-30e04a3a',
        },
      }),
    ).toEqual({
      stage: 'issued',
      stageLabel: '已开票',
      substateLabel: '已开具',
      deliveryLabel: '已发送',
      summary: '已发送 · INV-30e04a3a',
      tone: 'success',
      attentionLevel: 0,
      primaryActionCode: 'download_invoice',
    });
  });

  it('keeps an awaiting-details request in the pending stage with a clear next action', () => {
    expect(
      deriveAdminInvoicePresentation({
        access: 'included',
        invoiceRequired: true,
        orderStatus: 'paid',
        request: {
          status: 'awaiting_details',
          deliveryStatus: 'sent',
        },
      }),
    ).toMatchObject({
      stage: 'pending',
      stageLabel: '待开票',
      substateLabel: '待提交资料',
      summary: '填写入口已发送',
      tone: 'warning',
      attentionLevel: 1,
      primaryActionCode: 'request_invoice_details',
    });
  });

  it('does not expose invoice state when invoice access is restricted', () => {
    expect(
      deriveAdminInvoicePresentation({
        access: 'restricted',
        invoiceRequired: true,
        orderStatus: 'paid',
        request: {
          status: 'issued',
          deliveryStatus: 'sent',
          invoiceNumber: 'SENSITIVE-INVOICE-NUMBER',
        },
      }),
    ).toMatchObject({
      stage: 'restricted',
      stageLabel: '无查看权限',
      summary: '需要发票查看权限',
      primaryActionCode: null,
    });
  });

  it.each([
    ['pending_review', 'pending', '资料待审核', 'approve_invoice'],
    ['issuing', 'pending', '开票中', 'issue_invoice'],
    ['issue_failed', 'pending', '开票失败', 'retry_invoice'],
    ['rejected', 'pending', '资料已驳回', 'request_invoice_details'],
    ['adjustment_required', 'issued', '退款待调整', 'void_invoice'],
    ['voided', 'terminated', '已作废', 'retry_invoice'],
    ['cancelled', 'terminated', '已取消', null],
  ] as const)(
    'maps %s to its operational stage and next action',
    (status, stage, substateLabel, primaryActionCode) => {
      expect(
        deriveAdminInvoicePresentation({
          access: 'included',
          invoiceRequired: true,
          orderStatus: 'paid',
          request: { status, deliveryStatus: 'not_sent' },
        }),
      ).toMatchObject({ stage, substateLabel, primaryActionCode });
    },
  );

  it('distinguishes a genuine non-request from a missing paid-order request', () => {
    expect(
      deriveAdminInvoicePresentation({
        access: 'included',
        invoiceRequired: false,
        orderStatus: 'paid',
        request: null,
      }),
    ).toMatchObject({ stage: 'not_requested', stageLabel: '未申请' });

    expect(
      deriveAdminInvoicePresentation({
        access: 'included',
        invoiceRequired: true,
        orderStatus: 'paid',
        request: null,
      }),
    ).toMatchObject({
      stage: 'anomaly',
      stageLabel: '数据异常',
      substateLabel: '申请记录缺失',
      attentionLevel: 3,
    });
  });
});
