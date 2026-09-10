import { eraseUnavailableClaimInvitationReplays } from '@conference/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  type CancelCustomerOrder,
  type ReviewBatchOrder,
  type SelectedOrderItems,
} from '@conference/contracts';
import {
  activeInventoryReservationAt,
  attendeeClaimTokens,
  auditLogs,
  eventReleases,
  events,
  inventoryReservations,
  orderItems,
  orders,
  orderStateLogs,
  outboxEvents,
  payments,
  registrations,
  refundRequests,
  tickets,
  ticketTypes,
  waitlistEntries,
} from '@conference/database';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { batchConflict, BATCH_PAYMENT_WINDOW_MS } from './batch-purchase-policy.js';
import { OrderItemsService, type BatchCustomer } from './order-items.service.js';
import { WeChatPayService } from './wechat-pay.service.js';

@Injectable()
export class BatchOrderManagementService {
  constructor(
    @Inject(OrderItemsService) private readonly items: OrderItemsService,
    @Inject(WeChatPayService) private readonly wechat: WeChatPayService,
  ) {}

  async cancel(orderId: string, input: CancelCustomerOrder, customer: BatchCustomer) {
    const db = this.items.db();
    const observed = await this.items.requireOrder(db, orderId, customer);
    if (observed.version !== input.expectedVersion) batchConflict('订单已经更新，请刷新后操作');
    if (observed.status === 'closed') return this.items.detail(orderId, customer);
    if (observed.status === 'pending_review') {
      await db.transaction(async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
        if (!order || order.version !== input.expectedVersion || order.status !== 'pending_review')
          batchConflict('订单状态已经更新，请刷新');
        await this.items.requireOrder(tx, orderId, customer);
        await this.items.cancelUnpaidItems(tx, order);
        await tx.insert(orderStateLogs).values({
          orderId,
          fromStatus: 'pending_review',
          toStatus: 'closed',
          reason: '购票人取消待审核订单',
          metadata: { customerUserId: customer.customerUserId },
        });
      });
    } else if (['pending_payment', 'processing'].includes(observed.status)) {
      try {
        await this.wechat.closeUnpaidOrder(
          orderId,
          observed.eventId,
          observed.organizationId,
          customer.customerUserId,
          '购票人取消待支付订单',
          observed.expiresAt.toISOString(),
          { actorType: 'customer', expectedVersion: input.expectedVersion },
        );
      } catch (error) {
        const current = await this.items.requireOrder(db, orderId, customer);
        if (!current.settledPaymentId) throw error;
      }
    } else batchConflict('当前订单已经付款，请选择名额申请退款');
    return this.items.detail(orderId, customer);
  }

  async cancelFree(orderId: string, input: SelectedOrderItems, customer: BatchCustomer) {
    const db = this.items.db();
    await db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      await this.items.requireOrder(tx, orderId, customer);
      if (!order || order.modelVersion !== 2 || order.version !== input.expectedVersion)
        batchConflict('订单已经更新，请刷新');
      if (
        order.amount !== 0 ||
        !order.settledPaymentId ||
        order.entitlementsOnHold ||
        order.refundExecutionMode === 'external_hold'
      )
        batchConflict('该订单不支持免费名额取消');
      const locked = await this.items.lockItems(tx, orderId);
      const chosen = input.items.map((selection) => {
        const item = locked.find((row) => row.id === selection.id);
        if (!item || item.version !== selection.version || item.state !== 'active')
          batchConflict('选中名额已更新，请刷新');
        return item;
      });
      const ticketRows = await tx
        .select()
        .from(tickets)
        .where(
          inArray(
            tickets.registrationId,
            chosen.map((item) => item.registrationId),
          ),
        );
      if (
        ticketRows.length !== chosen.length ||
        ticketRows.some((ticket) => ticket.status !== 'valid' || ticket.refundPausedBy)
      )
        batchConflict('请仅选择未使用、未在售后的名额');
      const [activeRefund] = await tx
        .select({ id: refundRequests.id })
        .from(refundRequests)
        .where(and(eq(refundRequests.orderId, orderId), isNull(refundRequests.terminatedAt)))
        .limit(1);
      if (activeRefund) batchConflict('该订单正在处理售后');
      const now = new Date();
      for (const item of chosen) {
        await tx
          .update(tickets)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(tickets.registrationId, item.registrationId));
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
        const released = await tx
          .update(inventoryReservations)
          .set({ releasedAt: now, updatedAt: now })
          .where(
            and(
              eq(inventoryReservations.orderItemId, item.id),
              isNull(inventoryReservations.releasedAt),
            ),
          )
          .returning();
        if (!item.inventoryReleasedAt) {
          await tx
            .update(ticketTypes)
            .set({ sold: sql`greatest(0,${ticketTypes.sold}-1)`, updatedAt: now })
            .where(eq(ticketTypes.id, item.ticketTypeId));
          for (const reservation of released)
            await tx.insert(outboxEvents).values({
              organizationId: order.organizationId,
              eventId: order.eventId,
              eventType: 'FreeOrderItemCancelled',
              correlationId: `free:cancelled:${item.id}`,
              payload: {
                orderId,
                orderItemId: item.id,
                reservationId: reservation.id,
                ticketTypeId: item.ticketTypeId,
                quantity: 1,
              },
            });
        }
        await tx
          .update(orderItems)
          .set({
            state: 'cancelled',
            cancelledAt: now,
            inventoryReleasedAt: now,
            version: item.version + 1,
            updatedAt: now,
          })
          .where(eq(orderItems.id, item.id));
      }
      const remaining = locked.filter(
        (item) => item.state === 'active' && !chosen.some((row) => row.id === item.id),
      );
      await tx
        .update(orders)
        .set({
          status: remaining.length ? 'paid' : 'closed',
          version: order.version + 1,
          updatedAt: now,
        })
        .where(eq(orders.id, orderId));
      await tx.insert(auditLogs).values({
        organizationId: order.organizationId,
        eventId: order.eventId,
        actorId: customer.customerUserId,
        actorType: 'customer',
        action: 'order.free_items.cancelled',
        resourceType: 'order',
        resourceId: orderId,
        after: { itemIds: chosen.map((item) => item.id) },
        traceId: `free:cancel:${orderId}:${order.version}`,
      });
    });
    return this.items.detail(orderId, customer);
  }

  async review(
    orderId: string,
    eventId: number,
    organizationId: string,
    actorId: string,
    input: ReviewBatchOrder,
  ) {
    const db = this.items.db();
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`wechatpay:prepare:${orderId}`},0))`,
      );
      const [order] = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.eventId, eventId),
            eq(orders.organizationId, organizationId),
          ),
        )
        .for('update');
      if (
        !order ||
        order.modelVersion !== 2 ||
        order.version !== input.expectedVersion ||
        order.status !== 'pending_review'
      )
        batchConflict('待审核订单已经更新，请刷新');
      await this.items.lockItems(tx, orderId);
      const now = new Date();
      if (order.expiresAt <= now) batchConflict('审核期限已结束，请关闭原单后重新报名');
      if (input.decision === 'reject') {
        await this.items.cancelUnpaidItems(tx, order, now);
      } else {
        const rows = await this.items.rows(tx, orderId);
        const [event] = await tx
          .select({ settings: events.settings })
          .from(events)
          .where(eq(events.id, order.eventId))
          .limit(1);
        const releaseId = event?.settings.currentReleaseId;
        const [release] =
          typeof releaseId === 'string'
            ? await tx
                .select({ snapshot: eventReleases.snapshot })
                .from(eventReleases)
                .where(
                  and(eq(eventReleases.id, releaseId), eq(eventReleases.eventId, order.eventId)),
                )
                .limit(1)
            : [];
        const snapshot = release?.snapshot as
          { tickets?: Array<{ id: string; capacity?: number }> } | undefined;
        for (const ticketTypeId of [...new Set(rows.map((row) => row.item.ticketTypeId))]) {
          const type = rows.find((row) => row.item.ticketTypeId === ticketTypeId)!.ticketType;
          const capacity =
            snapshot?.tickets?.find((ticket) => ticket.id === ticketTypeId)?.capacity ??
            type.capacity;
          const [held] = await tx
            .select({ count: sql<number>`coalesce(sum(${inventoryReservations.quantity}),0)::int` })
            .from(inventoryReservations)
            .where(
              and(
                eq(inventoryReservations.ticketTypeId, ticketTypeId),
                sql`${inventoryReservations.orderId} <> ${orderId}`,
                isNull(inventoryReservations.releasedAt),
                isNull(inventoryReservations.convertedAt),
                activeInventoryReservationAt(now),
              ),
            );
          const [waitlist] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(waitlistEntries)
            .where(
              and(
                eq(waitlistEntries.ticketTypeId, ticketTypeId),
                eq(waitlistEntries.status, 'invited'),
                gt(waitlistEntries.expiresAt, now),
              ),
            );
          if (
            capacity - type.sold - (held?.count ?? 0) - (waitlist?.count ?? 0) <
            rows.filter((row) => row.item.ticketTypeId === ticketTypeId).length
          )
            batchConflict('可用名额不足，无法整单通过审核');
        }
        const expiresAt = new Date(now.getTime() + BATCH_PAYMENT_WINDOW_MS);
        await tx
          .update(orders)
          .set({ status: 'pending_payment', expiresAt, version: order.version + 1, updatedAt: now })
          .where(eq(orders.id, orderId));
        await tx
          .update(registrations)
          .set({ status: 'pending_payment', updatedAt: now })
          .where(
            inArray(
              registrations.id,
              rows.map((row) => row.registration.id),
            ),
          );
        await tx
          .update(inventoryReservations)
          .set({ expiresAt, updatedAt: now })
          .where(
            and(
              eq(inventoryReservations.orderId, orderId),
              isNull(inventoryReservations.releasedAt),
              isNull(inventoryReservations.convertedAt),
            ),
          );
        if (order.amount === 0) {
          const [payment] = await tx
            .insert(payments)
            .values({
              orderId,
              provider: 'free',
              externalId: `free:${orderId}`,
              status: 'succeeded',
              succeededAt: now,
              amount: 0,
              currency: order.currency,
              payload: { reviewApproved: true },
            })
            .returning();
          await this.items.issue(tx, order, payment!.id, now);
        }
      }
      await tx.insert(orderStateLogs).values({
        orderId,
        fromStatus: order.status,
        toStatus:
          input.decision === 'reject' ? 'closed' : order.amount === 0 ? 'paid' : 'pending_payment',
        actorId,
        reason: input.reason || '整单审核通过',
        metadata: { quantity: order.quantity },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        actorType: 'staff',
        action: 'order.batch.reviewed',
        resourceType: 'order',
        resourceId: orderId,
        after: { decision: input.decision, quantity: order.quantity },
        traceId: `batch:review:${orderId}:${order.version}`,
      });
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId,
        eventType:
          input.decision === 'approve' ? 'BatchOrderReviewApproved' : 'BatchOrderReviewRejected',
        correlationId: `batch:review:${orderId}:${order.version}`,
        payload: {
          orderId,
          quantity: order.quantity,
          recipientRole: 'purchaser',
          reason: input.reason,
        },
      });
      const [current] = await tx.select().from(orders).where(eq(orders.id, orderId));
      return this.items.checkout(tx, current!, order.purchaserCustomerUserId ?? '');
    });
  }
}
