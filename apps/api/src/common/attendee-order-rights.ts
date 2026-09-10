import { orderItems, orders, registrations, tickets } from '@conference/database';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

/** Financial refund status and a participant's retained admission are evaluated separately. */
export function attendeeOrderEligibleSql() {
  return and(
    eq(orders.entitlementsOnHold, false),
    sql`(${orders.modelVersion} = 2 or ${orders.refundExecutionMode} <> 'external_hold')`,
    isNull(tickets.refundPausedBy),
    or(
      and(eq(orders.modelVersion, 1), inArray(orders.status, ['paid', 'partially_refunded'])),
      and(
        eq(orders.modelVersion, 2),
        sql`${orders.settledPaymentId} is not null`,
        sql`exists (
        select 1 from ${orderItems} attendee_item where attendee_item.order_id = ${orders.id}
        and attendee_item.registration_id = ${registrations.id} and attendee_item.state = 'active'
      )`,
      ),
    ),
  )!;
}

export function attendeeOrderIsEligible(
  order: typeof orders.$inferSelect,
  ticket: typeof tickets.$inferSelect | null,
) {
  return (
    !order.entitlementsOnHold &&
    (order.modelVersion === 2 || order.refundExecutionMode !== 'external_hold') &&
    !ticket?.refundPausedBy &&
    (order.modelVersion === 2
      ? Boolean(order.settledPaymentId) &&
        Boolean(ticket && ['valid', 'used'].includes(ticket.status))
      : ['paid', 'partially_refunded'].includes(order.status))
  );
}
