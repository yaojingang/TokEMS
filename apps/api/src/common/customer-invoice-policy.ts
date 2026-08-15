import type { OrderStatus } from '@conference/contracts';

export const CUSTOMER_INVOICE_PAYMENT_ELIGIBLE_ORDER_STATUSES = [
  'paid',
  'partially_refunded',
] as const satisfies readonly OrderStatus[];

export function customerInvoicePaymentEligibility(input: {
  orderStatus: OrderStatus;
  orderAmount: number;
  refundedAmount: number;
  hasSuccessfulPayment: boolean;
}) {
  const eligibleAmount = Math.max(input.orderAmount - input.refundedAmount, 0);
  const paymentEligible =
    input.hasSuccessfulPayment &&
    (CUSTOMER_INVOICE_PAYMENT_ELIGIBLE_ORDER_STATUSES as readonly string[]).includes(
      input.orderStatus,
    );
  return {
    eligibleAmount,
    paymentEligible,
    canApply: paymentEligible && input.orderAmount > 0 && eligibleAmount > 0,
    unavailableReason: !paymentEligible
      ? '订单完成支付后才可以申请发票。'
      : eligibleAmount <= 0
        ? '订单已无可开票的实际支付金额。'
        : null,
  };
}
