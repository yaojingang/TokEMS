import { describe, expect, it } from 'vitest';
import { WeChatRefundOutcomeSchema } from './refund-policy.js';

const outcome = {
  refund_id: 'wechat-refund-1',
  out_refund_no: 'merchant-refund-1',
  transaction_id: 'transaction-1',
  out_trade_no: 'order-1',
  status: 'SUCCESS',
  channel: 'ORIGINAL',
  user_received_account: '支付用户零钱',
  create_time: '2026-09-04T10:00:00+08:00',
  success_time: '2026-09-04T10:01:00+08:00',
  amount: { total: 1_000, refund: 500, currency: 'CNY' },
};

describe('WeChat refund amount breakdown', () => {
  it('preserves verified original cash payment, cash refund and promotion refund', () => {
    const parsed = WeChatRefundOutcomeSchema.parse({
      ...outcome,
      amount: { ...outcome.amount, payer_total: 800, payer_refund: 400, discount_refund: 100 },
    });
    expect(parsed.amount).toEqual({
      total: 1_000,
      refund: 500,
      payer_total: 800,
      payer_refund: 400,
      discount_refund: 100,
      currency: 'CNY',
    });
  });

  it('preserves verified zero values without inferring missing historical fields', () => {
    const parsed = WeChatRefundOutcomeSchema.parse({
      ...outcome,
      amount: { ...outcome.amount, payer_total: 0, payer_refund: 0, discount_refund: 500 },
    });
    expect(parsed.amount.payer_total).toBe(0);
    expect(parsed.amount.payer_refund).toBe(0);
    const historical = WeChatRefundOutcomeSchema.parse(outcome);
    expect(historical.amount.payer_total).toBeUndefined();
    expect(historical.amount.payer_refund).toBeUndefined();
    expect(historical.amount.discount_refund).toBeUndefined();
  });
});
