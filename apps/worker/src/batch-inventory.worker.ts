import { eraseUnavailableClaimInvitationReplays } from '@conference/database';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  attendeeClaimTokens,
  inventoryReservations,
  orderItems,
  orders,
  orderStateLogs,
  outboxEvents,
  paymentNotificationInbox,
  payments,
  registrations,
  tickets,
  ticketTypes,
  type ConferenceDatabase,
} from '@conference/database';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

/** Expiry closes a whole batch only after its payment evidence is settled. */
export async function expireBatchOrder(db: ConferenceDatabase, orderId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`wechatpay:prepare:${orderId}`},0))`,
    );
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update')
      .limit(1);
    const now = new Date();
    if (
      !order ||
      order.modelVersion !== 2 ||
      !['pending_review', 'pending_payment'].includes(order.status) ||
      order.expiresAt > now ||
      order.settledPaymentId ||
      order.entitlementsOnHold ||
      order.refundExecutionMode === 'external_hold'
    )
      return false;
    const [payment] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.orderId, orderId),
          sql`(${payments.succeededAt} is not null or ${inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES, 'succeeded', 'refunded'])})`,
        ),
      )
      .limit(1);
    const [notice] = await tx
      .select({ id: paymentNotificationInbox.id })
      .from(paymentNotificationInbox)
      .where(
        and(
          eq(paymentNotificationInbox.orderId, orderId),
          sql`${paymentNotificationInbox.status} <> 'processed'`,
        ),
      )
      .limit(1);
    if (payment || notice) return false;
    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.id))
      .for('update');
    if (items.length !== order.quantity || items.some((item) => item.state !== 'pending'))
      return false;
    const ids = items.map((item) => item.registrationId).sort();
    await tx
      .select({ id: registrations.id })
      .from(registrations)
      .where(inArray(registrations.id, ids))
      .orderBy(asc(registrations.id))
      .for('update');
    const issued = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(inArray(tickets.registrationId, ids))
      .orderBy(asc(tickets.id))
      .for('update');
    if (issued.length) return false;
    await tx
      .select({ id: ticketTypes.id })
      .from(ticketTypes)
      .where(inArray(ticketTypes.id, [...new Set(items.map((item) => item.ticketTypeId))].sort()))
      .orderBy(asc(ticketTypes.id))
      .for('update');
    const released = await tx
      .update(inventoryReservations)
      .set({ releasedAt: now, updatedAt: now })
      .where(
        and(
          eq(inventoryReservations.orderId, orderId),
          isNull(inventoryReservations.convertedAt),
          isNull(inventoryReservations.releasedAt),
        ),
      )
      .returning();
    await tx
      .update(orderItems)
      .set({
        state: 'cancelled',
        cancelledAt: now,
        inventoryReleasedAt: now,
        version: sql`${orderItems.version}+1`,
        updatedAt: now,
      })
      .where(eq(orderItems.orderId, orderId));
    await tx
      .update(registrations)
      .set({ status: 'cancelled', updatedAt: now })
      .where(inArray(registrations.id, ids));
    await tx
      .update(attendeeClaimTokens)
      .set({ revokedAt: now })
      .where(
        and(
          inArray(attendeeClaimTokens.registrationId, ids),
          isNull(attendeeClaimTokens.revokedAt),
        ),
      );
    await eraseUnavailableClaimInvitationReplays(tx, now, ids);
    await tx
      .update(orders)
      .set({ status: 'closed', version: sql`${orders.version}+1`, updatedAt: now })
      .where(eq(orders.id, orderId));
    await tx
      .insert(orderStateLogs)
      .values({
        orderId,
        fromStatus: order.status,
        toStatus: 'closed',
        reason:
          order.status === 'pending_review'
            ? '审核期限结束，全部名额已释放'
            : '支付超时，全部名额已释放',
      });
    if (order.status === 'pending_review')
      await tx
        .insert(outboxEvents)
        .values({
          organizationId: order.organizationId,
          eventId: order.eventId,
          eventType: 'BatchOrderReviewExpired',
          correlationId: `batch:review-expired:${orderId}`,
          payload: { orderId, quantity: order.quantity, recipientRole: 'purchaser' },
        });
    if (released.length)
      await tx
        .insert(outboxEvents)
        .values(
          released.map((reservation) => ({
            organizationId: order.organizationId,
            eventId: order.eventId,
            eventType: 'InventoryReservationExpired',
            correlationId: `reservation:expired:${reservation.id}`,
            payload: {
              orderId,
              orderItemId: reservation.orderItemId,
              reservationId: reservation.id,
              ticketTypeId: reservation.ticketTypeId,
            },
          })),
        );
    return true;
  });
}
