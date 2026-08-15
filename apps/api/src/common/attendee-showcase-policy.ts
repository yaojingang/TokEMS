import { PUBLIC_EVENT_STATUSES, isPublicEventStatus } from '@conference/contracts';
import {
  attendeeShowcaseProfiles,
  customerUsers,
  events,
  orders,
  payments,
  registrations,
  tickets,
} from '@conference/database';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

export const PUBLIC_REGISTRATION_STATUSES = ['confirmed', 'checked_in', 'completed'] as const;
export const PUBLIC_ORDER_STATUSES = ['paid', 'partially_refunded'] as const;
export const PUBLIC_TICKET_STATUSES = ['valid', 'used'] as const;

export type AttendeeShowcaseQualificationInput = {
  eventStatus: string;
  customerStatus: string;
  registrationStatus: string;
  orderStatus: string;
  paymentSatisfied: boolean;
  ticketStatus: string | null;
  isPublic: boolean;
  adminHiddenAt: Date | null;
};

export function attendeeAvatarInitial(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim();
  return normalized ? (Array.from(normalized)[0] ?? null) : null;
}

export function attendeeShowcaseVersionMatches(
  clientVersion: number,
  storedVersion: number,
  createdForThisUpdate: boolean,
) {
  return clientVersion === storedVersion || (createdForThisUpdate && clientVersion === 0);
}

export function attendeeShowcaseConsentMetadata(input: {
  nextIsPublic: boolean;
  currentIsPublic: boolean;
  currentVersion: string | null;
  currentConsentAt: Date | null;
  requiredVersion: string;
  now: Date;
}) {
  const requiresAcceptance =
    input.nextIsPublic &&
    (!input.currentIsPublic ||
      input.currentVersion !== input.requiredVersion ||
      !input.currentConsentAt);
  return {
    consentVersion: requiresAcceptance ? input.requiredVersion : input.currentVersion,
    consentAt: requiresAcceptance ? input.now : input.currentConsentAt,
  };
}

export function attendeeShowcaseQualification(row: AttendeeShowcaseQualificationInput) {
  if (!isPublicEventStatus(row.eventStatus as never)) {
    return { qualified: false, reason: '大会当前未公开' };
  }
  if (row.customerStatus !== 'active') return { qualified: false, reason: '账号状态不可公开' };
  if (!PUBLIC_REGISTRATION_STATUSES.includes(row.registrationStatus as never)) {
    return { qualified: false, reason: '报名状态不可公开' };
  }
  if (!PUBLIC_ORDER_STATUSES.includes(row.orderStatus as never)) {
    return { qualified: false, reason: '订单尚未完成或已经全额退款' };
  }
  if (!row.paymentSatisfied) return { qualified: false, reason: '支付结果尚未确认' };
  if (!row.ticketStatus || !PUBLIC_TICKET_STATUSES.includes(row.ticketStatus as never)) {
    return { qualified: false, reason: '票券状态不可公开' };
  }
  if (!row.isPublic) return { qualified: false, reason: '尚未开启大会主页展示' };
  if (row.adminHiddenAt) return { qualified: false, reason: '名片已由管理员下架' };
  return { qualified: true, reason: null };
}

export function attendeeShowcasePublicEligibilitySql(
  options: { eventAlreadyValidated?: boolean } = {},
) {
  return and(
    eq(attendeeShowcaseProfiles.isPublic, true),
    isNotNull(attendeeShowcaseProfiles.qualifiedAt),
    isNull(attendeeShowcaseProfiles.adminHiddenAt),
    eq(customerUsers.status, 'active'),
    ...(options.eventAlreadyValidated ? [] : [inArray(events.status, [...PUBLIC_EVENT_STATUSES])]),
    inArray(registrations.status, [...PUBLIC_REGISTRATION_STATUSES]),
    inArray(orders.status, [...PUBLIC_ORDER_STATUSES]),
    sql`(${orders.amount} = 0 or exists (
      select 1 from ${payments} attendee_showcase_payment
      where attendee_showcase_payment.order_id = ${orders.id}
        and attendee_showcase_payment.status = 'succeeded'
    ))`,
    inArray(tickets.status, [...PUBLIC_TICKET_STATUSES]),
  )!;
}
