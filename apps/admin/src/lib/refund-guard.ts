import type { RegistrationStatus } from '@conference/contracts';

export function fullRefundBlockedReason(
  registrationStatus: RegistrationStatus | undefined,
  ticketStatus: 'valid' | 'used' | 'cancelled' | null | undefined,
) {
  if (registrationStatus === 'checked_in') return '参会人已签到，无法整单退款';
  if (ticketStatus === 'used') return '电子票已使用，无法整单退款';
  return null;
}

export function isBlockedFullRefund(
  reason: string | null | undefined,
  refundAmount: number,
  refundableAmount: number,
) {
  return Boolean(reason) && refundAmount === refundableAmount;
}
