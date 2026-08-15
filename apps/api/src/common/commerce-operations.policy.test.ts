import { describe, expect, it } from 'vitest';
import {
  REFUND_LOCK_ORDER,
  fullRefundAttendanceConflict,
} from './commerce-operations.service.js';

describe('refund attendance safety policy', () => {
  it('declares one consistent aggregate lock order for refund transactions', () => {
    expect(REFUND_LOCK_ORDER).toEqual(['order', 'ticket', 'registration']);
  });
  it('blocks a full refund after the ticket was used or the attendee checked in', () => {
    expect(
      fullRefundAttendanceConflict({
        refundAmount: 39900,
        refundableAmount: 39900,
        ticketStatus: 'used',
        registrationStatus: 'confirmed',
      }),
    ).toBe(true);
    expect(
      fullRefundAttendanceConflict({
        refundAmount: 39900,
        refundableAmount: 39900,
        ticketStatus: 'valid',
        registrationStatus: 'checked_in',
      }),
    ).toBe(true);
  });

  it('keeps partial refunds available after attendance', () => {
    expect(
      fullRefundAttendanceConflict({
        refundAmount: 10000,
        refundableAmount: 39900,
        ticketStatus: 'used',
        registrationStatus: 'checked_in',
      }),
    ).toBe(false);
  });
});
