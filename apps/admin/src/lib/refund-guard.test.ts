import { describe, expect, it } from 'vitest';
import { fullRefundBlockedReason, isBlockedFullRefund } from './refund-guard';

describe('registration refund guard', () => {
  it('blocks only the full remaining amount after check-in or ticket use', () => {
    expect(fullRefundBlockedReason('checked_in', 'used')).toBe(
      '参会人已签到，无法整单退款',
    );
    expect(fullRefundBlockedReason('confirmed', 'used')).toBe('电子票已使用，无法整单退款');
    expect(fullRefundBlockedReason('confirmed', 'valid')).toBeNull();

    expect(isBlockedFullRefund('电子票已使用，无法整单退款', 39900, 39900)).toBe(true);
    expect(isBlockedFullRefund('电子票已使用，无法整单退款', 10000, 39900)).toBe(false);
  });
});
