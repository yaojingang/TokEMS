import { describe, expect, it } from 'vitest';
import { customerInvoicePaymentEligibility } from './customer-invoice-policy.js';

describe('customer invoice payment eligibility', () => {
  it('uses the net paid amount after successful refunds', () => {
    expect(
      customerInvoicePaymentEligibility({
        orderStatus: 'partially_refunded',
        orderAmount: 39_900,
        refundedAmount: 10_000,
        hasSuccessfulPayment: true,
      }),
    ).toEqual({
      eligibleAmount: 29_900,
      paymentEligible: true,
      canApply: true,
      unavailableReason: null,
    });
  });

  it('rejects unpaid and fully refunded orders with stable user-facing reasons', () => {
    expect(
      customerInvoicePaymentEligibility({
        orderStatus: 'pending_payment',
        orderAmount: 39_900,
        refundedAmount: 0,
        hasSuccessfulPayment: false,
      }),
    ).toMatchObject({
      canApply: false,
      unavailableReason: '订单完成支付后才可以申请发票。',
    });
    expect(
      customerInvoicePaymentEligibility({
        orderStatus: 'partially_refunded',
        orderAmount: 39_900,
        refundedAmount: 39_900,
        hasSuccessfulPayment: true,
      }),
    ).toMatchObject({
      eligibleAmount: 0,
      canApply: false,
      unavailableReason: '订单已无可开票的实际支付金额。',
    });
  });

  it('requires a durable successful-payment fact for a paid order', () => {
    expect(
      customerInvoicePaymentEligibility({
        orderStatus: 'paid',
        orderAmount: 39_900,
        refundedAmount: 0,
        hasSuccessfulPayment: false,
      }),
    ).toMatchObject({
      paymentEligible: false,
      canApply: false,
      unavailableReason: '订单完成支付后才可以申请发票。',
    });
  });
});
