import {
  registrationEditableAttendeeFields,
  registrationSnapshotFields,
} from './registration-attendee-validation.js';
import { eraseUnavailableClaimInvitationReplays } from '@conference/database';
import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  type CustomerOrderDetail,
  type Order,
  type PurchasedOrderItem,
  type RegistrationBatchCheckout,
} from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  attendeeClaimTokens,
  events,
  inventoryReservations,
  invoiceRequests,
  orderAccessTokens,
  orderItems,
  orders,
  outboxEvents,
  paymentNotificationInbox,
  payments,
  refundItemAllocations,
  refundRequests,
  registrations,
  tickets,
  ticketTypes,
} from '@conference/database';
import { createTicketCode, sealSecret } from '@conference/security';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { batchConflict } from './batch-purchase-policy.js';
import { customerCanManageOrder } from './customer-order-ownership.js';
import { registrationEditVersion } from './registration-edit-version.js';

export type BatchDatabase = NonNullable<DatabaseService['db']>;
export type BatchTx = Parameters<Parameters<BatchDatabase['transaction']>[0]>[0];
export type BatchReader = BatchDatabase | BatchTx;
export type BatchOrder = typeof orders.$inferSelect;
export type BatchCustomer = { organizationId: string; customerUserId: string };

export const notificationPayloadSecret = () =>
  process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET ??
  process.env.JWT_SECRET ??
  'conference-notification-payload-development-secret';
export const batchTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function batchOrderView(row: BatchOrder): Order {
  return {
    id: row.id,
    orderNo: row.orderNo,
    registrationId: row.registrationId,
    modelVersion: row.modelVersion,
    quantity: row.quantity,
    version: row.version,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    paymentMethod: row.amount === 0 ? 'free' : 'wechat',
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class OrderItemsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  db(): BatchDatabase {
    if (!this.database.db) batchConflict('多人订单需要数据库持久化服务');
    return this.database.db;
  }

  async rows(reader: BatchReader, orderId: string) {
    return reader
      .select({
        item: orderItems,
        registration: registrations,
        ticketType: ticketTypes,
        ticket: tickets,
      })
      .from(orderItems)
      .innerJoin(registrations, eq(registrations.id, orderItems.registrationId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, orderItems.ticketTypeId))
      .leftJoin(tickets, eq(tickets.registrationId, orderItems.registrationId))
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.position));
  }

  async requireOrder(reader: BatchReader, orderId: string, customer: BatchCustomer) {
    const [order] = await reader
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.organizationId, customer.organizationId)))
      .limit(1);
    if (!order)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '订单不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    let legacyCustomer: string | null = null;
    if (
      order.modelVersion === 1 &&
      order.registrationId &&
      !order.purchaseIntentId &&
      !order.purchaserCustomerUserId
    ) {
      const [registration] = await reader
        .select({ customerUserId: registrations.customerUserId })
        .from(registrations)
        .where(eq(registrations.id, order.registrationId))
        .limit(1);
      legacyCustomer = registration?.customerUserId ?? null;
    }
    if (
      !customerCanManageOrder(
        order.purchaserCustomerUserId,
        order.purchaseIntentId,
        legacyCustomer,
        customer.customerUserId,
      )
    )
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '订单不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    return order;
  }

  async checkout(
    reader: BatchReader,
    order: BatchOrder,
    customerUserId: string,
  ): Promise<RegistrationBatchCheckout> {
    const rows = await this.rows(reader, order.id);
    if (rows.length !== order.quantity) batchConflict('订单名额明细需要核验，请联系主办方');
    const allocations = await reader
      .select({
        itemId: refundItemAllocations.orderItemId,
        amount: sql<number>`sum(${refundItemAllocations.amount})::int`,
      })
      .from(refundItemAllocations)
      .where(eq(refundItemAllocations.orderId, order.id))
      .groupBy(refundItemAllocations.orderItemId);
    const refunded = new Map(allocations.map((row) => [row.itemId, row.amount]));
    const manualReview = order.pricingSnapshot.manualReview === true;
    const financialHold = order.refundExecutionMode === 'external_hold' || order.entitlementsOnHold;
    const editFields = new Map(
      await Promise.all(
        rows.map(
          async (row) =>
            [
              row.item.id,
              await registrationEditableAttendeeFields(reader, row.registration),
            ] as const,
        ),
      ),
    );
    const allFields = new Map(
      await Promise.all(
        rows.map(
          async (row) =>
            [row.item.id, await registrationSnapshotFields(reader, row.registration)] as const,
        ),
      ),
    );
    const items: PurchasedOrderItem[] = rows.map(({ item, registration, ticketType, ticket }) => {
      const isSelf =
        registration.customerUserId === customerUserId &&
        registration.consentSnapshot.purchaseFor !== 'other';
      const paid = Boolean(order.settledPaymentId) && item.state === 'active';
      const pendingSelfEdit = isSelf && order.status === 'pending_payment' && !manualReview;
      const editable =
        !financialHold &&
        !ticket?.refundPausedBy &&
        !registration.supersededAt &&
        item.state !== 'cancelled' &&
        ticket?.status !== 'used' &&
        (pendingSelfEdit || !registration.customerUserId) &&
        !manualReview &&
        (paid || (order.status === 'pending_payment' && order.expiresAt > new Date()));
      return {
        id: item.id,
        registrationId: registration.id,
        clientId: item.clientId,
        position: item.position,
        state: item.state as PurchasedOrderItem['state'],
        version: item.version,
        allocatedAmount: item.allocatedAmount,
        unitPrice: item.unitPrice,
        refundedAmount: refunded.get(item.id) ?? 0,
        isSelf,
        attendeeClaimed: Boolean(registration.customerUserId),
        registration: {
          id: registration.id,
          eventId: registration.eventId,
          registrationCode: registration.registrationCode,
          formVersion: registration.formVersion,
          termsVersion: registration.termsVersion,
          status: registration.status,
          attendee: registration.attendee,
          formAnswers: registration.formAnswers,
          ticketType: {
            id: ticketType.id,
            name: String(item.pricingSnapshot.name ?? ticketType.name),
            description: ticketType.description,
            price: item.unitPrice,
            currency: order.currency,
            remaining: Math.max(0, ticketType.capacity - ticketType.sold),
            benefits: ticketType.benefits,
            recommended: ticketType.recommended,
          },
          createdAt: registration.createdAt.toISOString(),
        },
        ticketStatus: ticket?.status ?? null,
        canEditAttendee: editable,
        registrationEditVersion: registrationEditVersion(registration, order),
        registrationEditFields: editFields.get(item.id) ?? [],
        registrationFields: allFields.get(item.id) ?? [],
        canGenerateInvitation:
          paid &&
          !registration.customerUserId &&
          ticket?.status === 'valid' &&
          !ticket.refundPausedBy &&
          !financialHold &&
          !registration.supersededAt,
        canCancelFree:
          paid &&
          order.amount === 0 &&
          ticket?.status === 'valid' &&
          !ticket.refundPausedBy &&
          !financialHold,
        unavailableReason: financialHold
          ? '订单正在核验'
          : ticket?.refundPausedBy
            ? '该名额正在退款'
            : item.state === 'cancelled'
              ? '名额已取消'
              : ticket?.status === 'used'
                ? '票券已使用'
                : manualReview && !editable
                  ? '已审核参会资料请联系主办方修改'
                  : null,
      };
    });
    const self = items.find((item) => item.isSelf);
    return {
      order: batchOrderView(order),
      items,
      myRegistrationId: self?.registrationId ?? null,
      isProxyPurchase: !self,
      ...(order.quantity === 1 ? { registration: items[0]!.registration } : {}),
      nextAction:
        order.status === 'pending_review'
          ? 'review'
          : order.status === 'pending_payment'
            ? 'payment'
            : order.status === 'processing'
              ? 'confirming'
              : ['closed', 'cancelled'].includes(order.status)
                ? 'closed'
                : 'complete',
    };
  }

  async detail(orderId: string, customer: BatchCustomer): Promise<CustomerOrderDetail> {
    return this.db().transaction(async (tx) => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for('share');
      const order = await this.requireOrder(tx, orderId, customer);
      const [event] = await tx.select().from(events).where(eq(events.id, order.eventId)).limit(1);
      const [invoice] = await tx
        .select({ id: invoiceRequests.id })
        .from(invoiceRequests)
        .where(eq(invoiceRequests.orderId, orderId))
        .limit(1);
      const checkout = await this.checkout(tx, order, customer.customerUserId);
      return {
        ...checkout,
        eventId: order.eventId,
        eventName: event!.name,
        eventSlug: event!.slug,
        canCancel: ['pending_review', 'pending_payment', 'processing'].includes(order.status),
        refundedAmount: checkout.items.reduce((total, item) => total + item.refundedAmount, 0),
        invoiceId: invoice?.id ?? null,
      };
    });
  }

  async accessToken(tx: BatchTx, orderId: string) {
    const token = randomBytes(32).toString('base64url');
    await tx.insert(orderAccessTokens).values({
      orderId,
      tokenHash: batchTokenHash(token),
      scopes: ['order:read'],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    });
    return token;
  }

  /** The caller holds the order lock. Row locks always follow item, registration, ticket, type. */
  async lockItems(tx: BatchTx, orderId: string) {
    return this.lockOrderItems(tx, [orderId]);
  }

  async lockOrderItems(tx: BatchTx, orderIds: string[], additionalTicketTypeIds: string[] = []) {
    const items = await tx
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds))
      .orderBy(asc(orderItems.id))
      .for('update');
    if (orderIds.length && !items.length) batchConflict('订单名额明细缺失');
    const registrationIds = items.map((item) => item.registrationId).sort();
    await tx
      .select({ id: registrations.id })
      .from(registrations)
      .where(inArray(registrations.id, registrationIds))
      .orderBy(asc(registrations.id))
      .for('update');
    await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(inArray(tickets.registrationId, registrationIds))
      .orderBy(asc(tickets.id))
      .for('update');
    await tx
      .select({ id: ticketTypes.id })
      .from(ticketTypes)
      .where(
        inArray(
          ticketTypes.id,
          [
            ...new Set([...items.map((item) => item.ticketTypeId), ...additionalTicketTypeIds]),
          ].sort(),
        ),
      )
      .orderBy(asc(ticketTypes.id))
      .for('update');
    return items;
  }

  async issue(tx: BatchTx, order: BatchOrder, settledPaymentId: string, now = new Date()) {
    const rows = await this.rows(tx, order.id);
    if (
      rows.length !== order.quantity ||
      rows.reduce((total, row) => total + row.item.allocatedAmount, 0) !== order.amount
    )
      batchConflict('订单人数或金额需要核验');
    const reservations = await tx
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, order.id));
    for (const { item, registration, ticket } of rows) {
      if (item.state === 'cancelled' || registration.supersededAt)
        batchConflict('已关闭的名额不能重新出票');
      const reservation = reservations.find(
        (row) =>
          row.orderItemId === item.id && row.ticketTypeId === item.ticketTypeId && !row.releasedAt,
      );
      if (!reservation) batchConflict('订单名额预留已经释放，支付需要人工核验');
      if (
        ticket &&
        (ticket.status === 'cancelled' || item.state !== 'active' || !reservation.convertedAt)
      )
        batchConflict('现有票证与名额状态不一致，请核验后补票');
      if (!ticket) {
        const [issued] = await tx
          .insert(tickets)
          .values({
            eventId: order.eventId,
            registrationId: registration.id,
            ticketTypeId: item.ticketTypeId,
            code: createTicketCode(),
          })
          .returning({ id: tickets.id });
        if (!reservation.convertedAt) {
          await tx
            .update(ticketTypes)
            .set({ sold: sql`${ticketTypes.sold} + 1`, updatedAt: now })
            .where(eq(ticketTypes.id, item.ticketTypeId));
          await tx
            .update(inventoryReservations)
            .set({ convertedAt: now, updatedAt: now })
            .where(eq(inventoryReservations.id, reservation.id));
        }
        await tx
          .update(orderItems)
          .set({ state: 'active', version: sql`${orderItems.version} + 1`, updatedAt: now })
          .where(eq(orderItems.id, item.id));
        await tx
          .update(registrations)
          .set({ status: 'confirmed', updatedAt: now })
          .where(eq(registrations.id, registration.id));
        if (!registration.customerUserId)
          await this.createInvitation(tx, order, item, registration, now);
        await tx.insert(outboxEvents).values({
          organizationId: order.organizationId,
          eventId: order.eventId,
          eventType: 'TicketIssued',
          correlationId: `batch:ticket:${item.id}`,
          payload: {
            ticketId: issued!.id,
            orderId: order.id,
            orderItemId: item.id,
            registrationId: registration.id,
            recipientRole: 'attendee',
          },
        });
      }
    }
    await tx
      .update(orders)
      .set({
        settledPaymentId,
        status: 'paid',
        version: sql`${orders.version} + 1`,
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));
    if (!order.settledPaymentId)
      await tx.insert(outboxEvents).values({
        organizationId: order.organizationId,
        eventId: order.eventId,
        eventType: 'PaymentSucceeded',
        correlationId: `batch:paid:${order.id}`,
        payload: {
          orderId: order.id,
          quantity: order.quantity,
          amount: order.amount,
          currency: order.currency,
          recipientRole: 'purchaser',
        },
      });
  }

  async createInvitation(
    tx: BatchTx,
    order: BatchOrder,
    item: typeof orderItems.$inferSelect,
    registration: typeof registrations.$inferSelect,
    now = new Date(),
    notify = true,
  ) {
    await tx
      .update(attendeeClaimTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(attendeeClaimTokens.registrationId, registration.id),
          isNull(attendeeClaimTokens.revokedAt),
          isNull(attendeeClaimTokens.consumedAt),
        ),
      );
    await eraseUnavailableClaimInvitationReplays(tx, now, [registration.id]);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
    const [claim] = await tx
      .insert(attendeeClaimTokens)
      .values({
        registrationId: registration.id,
        tokenHash: batchTokenHash(token),
        mobileDigest: batchTokenHash(registration.attendeeMobileE164),
        expiresAt,
      })
      .returning();
    if (notify)
      await tx.insert(outboxEvents).values({
        organizationId: order.organizationId,
        eventId: order.eventId,
        eventType: 'AttendeeClaimInvitationRequested',
        correlationId: `batch:claim:${claim!.id}`,
        payload: {
          orderId: order.id,
          orderItemId: item.id,
          registrationId: registration.id,
          claimTokenId: claim!.id,
          recipientRole: 'attendee',
          recipient: registration.attendee.email || registration.attendee.mobile,
          sealedAttendeeClaimToken: sealSecret(token, notificationPayloadSecret()),
        },
      });
    return { token, expiresAt, tokenId: claim!.id };
  }

  /** Only call after payment closing is verified, or for an unpaid review decision. */
  async cancelUnpaidItems(tx: BatchTx, order: BatchOrder, now = new Date()) {
    const items = await this.lockItems(tx, order.id);
    const [activeRefund] = await tx
      .select({ id: refundRequests.id })
      .from(refundRequests)
      .where(and(eq(refundRequests.orderId, order.id), isNull(refundRequests.terminatedAt)))
      .limit(1);
    const [paid] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.orderId, order.id),
          sql`(${payments.succeededAt} is not null or ${payments.status} in ('succeeded','refunded'))`,
        ),
      )
      .limit(1);
    const [active] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.orderId, order.id),
          inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
        ),
      )
      .limit(1);
    const [notice] = await tx
      .select({ id: paymentNotificationInbox.id })
      .from(paymentNotificationInbox)
      .where(
        and(
          eq(paymentNotificationInbox.orderId, order.id),
          sql`${paymentNotificationInbox.status} <> 'processed'`,
        ),
      )
      .limit(1);
    if (
      activeRefund ||
      paid ||
      active ||
      notice ||
      order.entitlementsOnHold ||
      order.refundExecutionMode === 'external_hold' ||
      order.settledPaymentId ||
      items.some((item) => item.state === 'active')
    )
      batchConflict('订单支付或售后状态已变化，请刷新');
    const ids = items.map((item) => item.registrationId);
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
      .update(orderItems)
      .set({
        state: 'cancelled',
        cancelledAt: now,
        inventoryReleasedAt: now,
        version: sql`${orderItems.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(orderItems.orderId, order.id), sql`${orderItems.state} <> 'cancelled'`));
    const released = await tx
      .update(inventoryReservations)
      .set({ releasedAt: now, updatedAt: now })
      .where(
        and(
          eq(inventoryReservations.orderId, order.id),
          isNull(inventoryReservations.releasedAt),
          isNull(inventoryReservations.convertedAt),
        ),
      )
      .returning();
    for (const row of released)
      await tx.insert(outboxEvents).values({
        organizationId: order.organizationId,
        eventId: order.eventId,
        eventType: 'InventoryReservationExpired',
        correlationId: `reservation:expired:${row.id}`,
        payload: {
          orderId: order.id,
          orderItemId: row.orderItemId,
          reservationId: row.id,
          ticketTypeId: row.ticketTypeId,
        },
      });
    await tx
      .update(orders)
      .set({ status: 'closed', version: sql`${orders.version} + 1`, updatedAt: now })
      .where(eq(orders.id, order.id));
  }
}
