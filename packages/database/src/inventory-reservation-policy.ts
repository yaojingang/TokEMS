import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, not, or, sql } from 'drizzle-orm';
import type { ConferenceDatabase } from './index.js';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  inventoryReservations,
  payments,
  orders,
  paymentNotificationInbox,
} from './schema.js';

/** Payment evidence protects pending seats until their order is reconciled. */
export function paymentProtectedOrderSql(orderId: import('drizzle-orm').SQLWrapper) {
  return or(
    sql<boolean>`exists (
      select 1 from ${payments}
      where ${payments.orderId} = ${orderId}
        and ((${payments.provider} = 'wechatpay' and ${inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES])})
          or ${payments.succeededAt} is not null or ${payments.status} in ('succeeded', 'refunded'))
    )`,
    sql<boolean>`exists (select 1 from ${orders} protected_order
      where protected_order.id = ${orderId}
        and (protected_order.entitlements_on_hold or protected_order.refund_execution_mode = 'external_hold' or protected_order.settled_payment_id is not null))`,
    sql<boolean>`exists (select 1 from ${paymentNotificationInbox}
      where ${paymentNotificationInbox.orderId} = ${orderId}
        and ${paymentNotificationInbox.status} <> 'processed')`,
  )!;
}

export function activeInventoryReservationAt(evaluatedAt: Date) {
  return or(
    gt(inventoryReservations.expiresAt, evaluatedAt),
    paymentProtectedOrderSql(inventoryReservations.orderId),
    sql<boolean>`exists (select 1 from ${orders} review_order
      where review_order.id = ${inventoryReservations.orderId}
        and review_order.model_version = 1 and review_order.status = 'pending_review')`,
  );
}

/** Select whole orders after excluding protected payments, so holds cannot starve expiry. */
export async function findExpiredInventoryOrders(
  db: ConferenceDatabase,
  evaluatedAt: Date,
  limit = 100,
) {
  return db
    .selectDistinctOn([orders.id], { reservation: inventoryReservations, order: orders })
    .from(inventoryReservations)
    .innerJoin(orders, eq(orders.id, inventoryReservations.orderId))
    .where(
      and(
        isNull(inventoryReservations.releasedAt),
        isNull(inventoryReservations.convertedAt),
        lt(inventoryReservations.expiresAt, evaluatedAt),
        lt(orders.expiresAt, evaluatedAt),
        not(paymentProtectedOrderSql(orders.id)),
        or(
          eq(orders.status, 'pending_payment'),
          and(eq(orders.modelVersion, 2), eq(orders.status, 'pending_review')),
        ),
      ),
    )
    .orderBy(asc(orders.id), asc(inventoryReservations.id))
    .limit(Math.min(Math.max(limit, 1), 500));
}

/** Finds the original released ticket scope even after the order is reused for another ticket. */
export async function releasedInventoryReservationScope(
  db: ConferenceDatabase,
  orderId: string,
  reservationId: string,
) {
  const [released] = await db
    .select({
      eventId: inventoryReservations.eventId,
      ticketTypeId: inventoryReservations.ticketTypeId,
    })
    .from(inventoryReservations)
    .where(
      and(
        eq(inventoryReservations.id, reservationId),
        eq(inventoryReservations.orderId, orderId),
        isNotNull(inventoryReservations.releasedAt),
      ),
    )
    .limit(1);
  return released;
}
