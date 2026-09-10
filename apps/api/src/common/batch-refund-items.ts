import { eraseUnavailableClaimInvitationReplays } from '@conference/database';
import { createHash } from 'node:crypto';
import {
  attendeeClaimTokens,
  inventoryReservations,
  orderItems,
  outboxEvents,
  refundItemAllocations,
  refundRequestItems,
  refundRequests,
  refunds,
  registrations,
  tickets,
  ticketTypes,
  type orders,
} from '@conference/database';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DatabaseService } from './database.service.js';

type Database = NonNullable<DatabaseService['db']>;
export type RefundTx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Reader = Database | RefundTx;
type Order = typeof orders.$inferSelect;
type Execution = typeof refunds.$inferSelect;

/** Caller holds order lock; all refund operations use the same sorted rights lock sequence. */
export async function refundRights(db: Reader, order: Order, lock: boolean) {
  const itemQuery = db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id));
  const items = await (lock ? itemQuery.for('update') : itemQuery);
  const ids =
    order.modelVersion === 2
      ? items.map((item) => item.registrationId).sort()
      : order.registrationId
        ? [order.registrationId]
        : [];
  if (!ids.length) return { items, registrations: [], tickets: [], ticketTypes: [] };
  const registrationQuery = db
    .select()
    .from(registrations)
    .where(
      and(inArray(registrations.id, ids), eq(registrations.organizationId, order.organizationId)),
    )
    .orderBy(asc(registrations.id));
  const registrationRows = await (lock ? registrationQuery.for('update') : registrationQuery);
  const ticketQuery = db
    .select()
    .from(tickets)
    .where(and(inArray(tickets.registrationId, ids), eq(tickets.eventId, order.eventId)))
    .orderBy(asc(tickets.id));
  const ticketRows = await (lock ? ticketQuery.for('update') : ticketQuery);
  const typeIds = [
    ...new Set([
      ...items.map((item) => item.ticketTypeId),
      ...registrationRows.map((row) => row.ticketTypeId),
      ...ticketRows.map((row) => row.ticketTypeId),
    ]),
  ].sort();
  const typeQuery = db
    .select()
    .from(ticketTypes)
    .where(inArray(ticketTypes.id, typeIds))
    .orderBy(asc(ticketTypes.id));
  const types = typeIds.length ? await (lock ? typeQuery.for('update') : typeQuery) : [];
  return { items, registrations: registrationRows, tickets: ticketRows, ticketTypes: types };
}
export type RefundRights = Awaited<ReturnType<typeof refundRights>>;

export async function refundItemLedger(db: Reader, orderId: string, lock = false) {
  const requestQuery = db
    .select()
    .from(refundRequestItems)
    .where(eq(refundRequestItems.orderId, orderId))
    .orderBy(asc(refundRequestItems.id));
  const requestItems = await (lock ? requestQuery.for('update') : requestQuery);
  const allocationQuery = db
    .select()
    .from(refundItemAllocations)
    .where(eq(refundItemAllocations.orderId, orderId))
    .orderBy(asc(refundItemAllocations.id));
  const allocations = await (lock ? allocationQuery.for('update') : allocationQuery);
  return { requestItems, allocations };
}
export type RefundItemLedger = Awaited<ReturnType<typeof refundItemLedger>>;

export function itemRefundReason(
  rights: RefundRights,
  item: RefundRights['items'][number],
  allowPause?: string,
): string | null {
  const registration = rights.registrations.find((row) => row.id === item.registrationId);
  const ticket = rights.tickets.find((row) => row.registrationId === item.registrationId);
  if (
    !registration ||
    !ticket ||
    item.state !== 'active' ||
    registration.status === 'cancelled' ||
    ticket.status === 'cancelled'
  )
    return '该名额已取消或尚未出票';
  if (registration.status === 'checked_in' || ticket.status === 'used') return '该票券已使用';
  if (
    registration.supersededAt ||
    ticket.ticketTypeId !== item.ticketTypeId ||
    registration.ticketTypeId !== item.ticketTypeId
  )
    return '参会资格已变更，需要人工核验';
  if (ticket.refundPausedBy && ticket.refundPausedBy !== allowPause) return '该名额正在退款';
  return null;
}
export const itemRefunded = (ledger: RefundItemLedger, itemId: string) =>
  ledger.allocations
    .filter((row) => row.orderItemId === itemId)
    .reduce((total, row) => total + row.amount, 0);
export const refundFingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Cash has already been recorded. Incomplete attribution is attention, never a rollback of money. */
export async function allocateApprovedRefund(
  tx: RefundTx,
  order: Order,
  rights: RefundRights,
  execution: Execution,
) {
  const ledger = await refundItemLedger(tx, order.id, true);
  const already = ledger.allocations
    .filter((row) => row.refundId === execution.id)
    .reduce((sum, row) => sum + row.amount, 0);
  if (already === execution.amount) return null;
  if (order.modelVersion === 1 && rights.items.length === 1 && execution.paymentId) {
    const item = rights.items[0]!;
    if (
      execution.currency !== order.currency ||
      execution.amount > item.allocatedAmount - itemRefunded(ledger, item.id)
    )
      return '退款资金已确认，单人订单的名额金额需要人工核验';
    await tx.insert(refundItemAllocations).values({
      refundId: execution.id,
      paymentId: execution.paymentId,
      orderId: order.id,
      orderItemId: item.id,
      organizationId: order.organizationId,
      eventId: order.eventId,
      amount: execution.amount,
      basis: 'legacy_single_item_verified',
    });
    return null;
  }

  if (
    execution.protectionScope !== 'items' ||
    !execution.requestId ||
    !execution.paymentId ||
    execution.paymentId !== order.settledPaymentId ||
    execution.currency !== order.currency
  )
    return '退款资金已确认，请财务指定退款归属名额与权益处理方式';
  const targets = ledger.requestItems
    .filter(
      (row) =>
        row.refundRequestId === execution.requestId &&
        row.paymentId === execution.paymentId &&
        row.approvedAmount !== null,
    )
    .sort(
      (a, b) =>
        (rights.items.find((item) => item.id === a.orderItemId)?.position ?? 0) -
        (rights.items.find((item) => item.id === b.orderItemId)?.position ?? 0),
    );
  let available = execution.amount - already;
  for (const target of targets) {
    if (available <= 0) break;
    if (
      ledger.allocations.some(
        (row) => row.refundId === execution.id && row.orderItemId === target.orderItemId,
      )
    )
      continue;
    const item = rights.items.find((row) => row.id === target.orderItemId);
    if (!item) continue;
    const obligation =
      target.approvedAmount! -
      ledger.allocations
        .filter((row) => row.refundRequestItemId === target.id)
        .reduce((sum, row) => sum + row.amount, 0);
    const amount = Math.min(
      available,
      obligation,
      Math.max(0, item.allocatedAmount - itemRefunded(ledger, item.id)),
    );
    if (amount <= 0) continue;
    await tx.insert(refundItemAllocations).values({
      refundId: execution.id,
      paymentId: execution.paymentId,
      orderId: order.id,
      orderItemId: item.id,
      refundRequestItemId: target.id,
      organizationId: order.organizationId,
      eventId: order.eventId,
      amount,
      basis: 'approved_request_item',
    });
    available -= amount;
  }
  return available ? '退款资金已确认，超出已批准名额的金额需要人工归属核验' : null;
}

/** Revoke each explicitly approved target only once its own money obligation is satisfied. */
export async function fulfillRefundItems(
  tx: RefundTx,
  order: Order,
  rights: RefundRights,
  execution: Execution,
) {
  const ledger = await refundItemLedger(tx, order.id, true);
  const allocationTotal = ledger.allocations
    .filter((row) => row.refundId === execution.id)
    .reduce((sum, row) => sum + row.amount, 0);
  if (allocationTotal !== execution.amount) return '退款资金已确认，请财务完成名额归属核验';
  const [application] = execution.requestId
    ? await tx.select().from(refundRequests).where(eq(refundRequests.id, execution.requestId))
    : [];
  const targets = ledger.requestItems.filter(
    (target) =>
      target.refundRequestId === execution.requestId &&
      target.rightsEffect === 'revoke' &&
      target.approvedAmount !== null,
  );
  let attention: string | null = null;
  for (const target of targets) {
    const item = rights.items.find((row) => row.id === target.orderItemId);
    if (!item) {
      attention = '退款名额已变更，需要人工核对权益';
      continue;
    }
    if (item.state === 'cancelled' && item.inventoryReleasedAt) continue;
    const satisfied =
      ledger.allocations
        .filter((row) => row.refundRequestItemId === target.id)
        .reduce((sum, row) => sum + row.amount, 0) >= target.approvedAmount!;
    if (!satisfied) continue;
    const reason = itemRefundReason(rights, item, execution.requestId ?? undefined);
    const snapshot = (
      application?.businessSnapshot.items as Array<{ id: string; ticketId: string }> | undefined
    )?.find((row) => row.id === item.id);
    const ticket = rights.tickets.find((row) => row.registrationId === item.registrationId);
    if (item.version !== target.version || (snapshot && snapshot.ticketId !== ticket?.id)) {
      attention = '退款已确认，所选名额版本或原票券已变更，需要人工核验';
      continue;
    }
    if (reason) {
      attention = `退款已确认，${reason}，需要人工处理权益`;
      continue;
    }
    const now = new Date();
    const reservations = await tx
      .select()
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.orderItemId, item.id),
          eq(inventoryReservations.orderId, order.id),
        ),
      )
      .orderBy(asc(inventoryReservations.id))
      .for('update');
    const reservation = reservations.find(
      (row) => row.convertedAt && row.ticketTypeId === item.ticketTypeId,
    );
    if (!reservation || (!item.inventoryReleasedAt && reservation.releasedAt)) {
      attention = '退款已确认，原名额库存预留需要人工核验';
      continue;
    }
    if (!item.inventoryReleasedAt) {
      await tx
        .update(ticketTypes)
        .set({ sold: sql`greatest(${ticketTypes.sold} - 1, 0)`, updatedAt: now })
        .where(eq(ticketTypes.id, item.ticketTypeId));
      await tx
        .update(inventoryReservations)
        .set({ releasedAt: now, updatedAt: now })
        .where(
          and(
            eq(inventoryReservations.id, reservation.id),
            isNull(inventoryReservations.releasedAt),
          ),
        );
    }
    await tx
      .update(tickets)
      .set({ status: 'cancelled', refundPausedBy: null, updatedAt: now })
      .where(eq(tickets.id, ticket!.id));
    await tx
      .update(registrations)
      .set({ status: 'cancelled', updatedAt: now })
      .where(eq(registrations.id, item.registrationId));
    await tx
      .update(attendeeClaimTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(attendeeClaimTokens.registrationId, item.registrationId),
          isNull(attendeeClaimTokens.revokedAt),
        ),
      );
    await eraseUnavailableClaimInvitationReplays(tx, now, [item.registrationId]);
    await tx
      .update(orderItems)
      .set({
        state: 'cancelled',
        cancelledAt: now,
        inventoryReleasedAt: now,
        version: sql`${orderItems.version} + 1`,
        updatedAt: now,
      })
      .where(eq(orderItems.id, item.id));
    await tx.insert(outboxEvents).values({
      organizationId: order.organizationId,
      eventId: order.eventId,
      eventType: 'RefundItemRevoked',
      correlationId: `refund-item:${target.id}`,
      payload: {
        refundId: execution.id,
        requestId: execution.requestId,
        orderId: order.id,
        orderItemId: item.id,
        registrationId: item.registrationId,
        ticketId: ticket!.id,
        ticketTypeId: item.ticketTypeId,
        reservationId: reservation.id,
        quantity: 1,
      },
    });
  }
  return attention;
}
