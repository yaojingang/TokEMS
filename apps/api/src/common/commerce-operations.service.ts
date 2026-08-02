import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  type EventId,
  type Refund,
  type RefundRequest,
} from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  auditLogs,
  events,
  inventoryReservations,
  invoiceRequests,
  invoiceStateLogs,
  orders,
  orderStateLogs,
  outboxEvents,
  payments,
  refunds,
  registrations,
  tickets,
  ticketTypes,
  waitlistEntries,
} from '@conference/database';
import { and, count, eq, gt, inArray, isNull, lt, sql, sum } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';

type Database = NonNullable<DatabaseService['db']>;

@Injectable()
export class CommerceOperationsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private db(): Database {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '此运营能力需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private refundFromRow(row: typeof refunds.$inferSelect): Refund {
    return {
      id: row.id,
      refundNo: row.refundNo,
      orderId: row.orderId,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async refundOrder(
    organizationId: string,
    orderId: string,
    actorId: string,
    idempotencyKey: string,
    input: RefundRequest,
  ): Promise<Refund> {
    const db = this.db();
    const requestHash = this.hash({ orderId, ...input });

    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`refund:${idempotencyKey}`}, 0))`,
      );
      const [cached] = await tx
        .select()
        .from(refunds)
        .where(eq(refunds.idempotencyKey, idempotencyKey))
        .limit(1);
      if (cached) {
        const payload = cached.providerPayload as { requestHash?: string };
        if (payload.requestHash !== requestHash) {
          throw new DomainError(
            API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            '相同幂等键对应了不同的退款内容',
            HttpStatus.CONFLICT,
          );
        }
        return this.refundFromRow(cached);
      }

      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.organizationId, organizationId)))
        .for('update')
        .limit(1);
      if (!order) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '订单不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (!['paid', 'partially_refunded'].includes(order.status)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前订单状态不允许退款',
          HttpStatus.CONFLICT,
        );
      }

      const totals = await tx
        .select({ amount: sum(refunds.amount) })
        .from(refunds)
        .where(and(eq(refunds.orderId, order.id), eq(refunds.status, 'succeeded')));
      const payment = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, order.id), eq(payments.status, 'succeeded')))
        .limit(1);
      const registration = await tx
        .select()
        .from(registrations)
        .where(eq(registrations.id, order.registrationId))
        .limit(1);
      const refunded = Number(totals[0]?.amount ?? 0);
      const remaining = order.amount - refunded;
      if (!payment[0]) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '订单缺少已成功的支付记录，无法发起退款',
          HttpStatus.CONFLICT,
        );
      }
      if (payment[0].provider === 'wechatpay') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '微信支付退款通道尚未接入，订单与资金状态均未修改',
          HttpStatus.CONFLICT,
        );
      }
      if (input.amount > remaining) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `退款金额超过可退余额 ${remaining}`,
          HttpStatus.BAD_REQUEST,
        );
      }

      const fullRefund = input.amount === remaining;
      const now = new Date();
      const [refund] = await tx
        .insert(refunds)
        .values({
          organizationId,
          eventId: order.eventId,
          orderId: order.id,
          paymentId: payment[0].id,
          refundNo: `RF${now.getFullYear()}${nanoid(12).toUpperCase()}`,
          amount: input.amount,
          currency: order.currency,
          reason: input.reason,
          idempotencyKey,
          providerPayload: {
            provider: payment[0].provider,
            requestHash,
            processedAt: now.toISOString(),
          },
          createdBy: actorId,
        })
        .returning();
      const nextStatus = fullRefund ? 'refunded' : 'partially_refunded';
      await tx
        .update(orders)
        .set({ status: nextStatus, updatedAt: now })
        .where(eq(orders.id, order.id));
      await tx.insert(orderStateLogs).values({
        orderId: order.id,
        fromStatus: order.status,
        toStatus: nextStatus,
        reason: input.reason,
        actorId,
        metadata: { refundId: refund!.id, amount: input.amount },
      });

      if (fullRefund) {
        if (payment[0]) {
          await tx
            .update(payments)
            .set({ status: 'refunded', updatedAt: now })
            .where(eq(payments.id, payment[0].id));
        }
        await tx
          .update(tickets)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(tickets.registrationId, order.registrationId));
        await tx
          .update(registrations)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(registrations.id, order.registrationId));
        if (registration[0]) {
          await tx
            .update(ticketTypes)
            .set({ sold: sql`greatest(${ticketTypes.sold} - 1, 0)`, updatedAt: now })
            .where(eq(ticketTypes.id, registration[0].ticketTypeId));
        }
      }

      const [invoice] = await tx
        .select()
        .from(invoiceRequests)
        .where(eq(invoiceRequests.orderId, order.id))
        .for('update')
        .limit(1);
      if (invoice) {
        const nextNetPaidAmount = Math.max(0, remaining - input.amount);
        const nextInvoiceStatus =
          invoice.status === 'issued'
            ? 'adjustment_required'
            : nextNetPaidAmount === 0 &&
                !['voided', 'cancelled', 'adjustment_required'].includes(invoice.status)
              ? 'cancelled'
              : invoice.status;
        await tx
          .update(invoiceRequests)
          .set({
            netPaidAmount: nextNetPaidAmount,
            amount: nextNetPaidAmount > 0 ? Math.min(invoice.amount, nextNetPaidAmount) : 0,
            status: nextInvoiceStatus,
            updatedAt: now,
          })
          .where(eq(invoiceRequests.id, invoice.id));
        if (nextInvoiceStatus !== invoice.status) {
          await tx.insert(invoiceStateLogs).values({
            invoiceRequestId: invoice.id,
            fromStatus: invoice.status,
            toStatus: nextInvoiceStatus,
            reason:
              nextInvoiceStatus === 'adjustment_required'
                ? '订单退款后，已开具发票需要调整'
                : '订单已全额退款，发票申请已取消',
            actorId,
            metadata: { refundId: refund!.id, amount: input.amount },
          });
        }
      }

      await tx.insert(outboxEvents).values({
        organizationId,
        eventId: order.eventId,
        eventType: 'RefundSucceeded',
        correlationId: idempotencyKey,
        payload: {
          refundId: refund!.id,
          orderId: order.id,
          amount: input.amount,
          fullRefund,
        },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: order.eventId,
        actorId,
        action: 'order.refund',
        resourceType: 'refund',
        resourceId: refund!.id,
        before: { orderStatus: order.status, refundableAmount: remaining },
        after: { orderStatus: nextStatus, amount: input.amount, reason: input.reason },
        traceId: idempotencyKey,
      });
      return this.refundFromRow(refund!);
    });
  }

  async listRefunds(organizationId: string, eventId?: EventId): Promise<Refund[]> {
    const conditions = [eq(refunds.organizationId, organizationId)];
    if (eventId) conditions.push(eq(refunds.eventId, eventId));
    return (
      await this.db()
        .select()
        .from(refunds)
        .where(and(...conditions))
    ).map((row) => this.refundFromRow(row));
  }

  async releaseExpiredReservations(limit = 100) {
    const db = this.db();
    const candidates = await db
      .select({ reservation: inventoryReservations, order: orders })
      .from(inventoryReservations)
      .innerJoin(orders, eq(orders.id, inventoryReservations.orderId))
      .leftJoin(
        payments,
        and(
          eq(payments.orderId, orders.id),
          eq(payments.provider, 'wechatpay'),
          inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
        ),
      )
      .where(
        and(
          isNull(inventoryReservations.releasedAt),
          isNull(inventoryReservations.convertedAt),
          isNull(payments.id),
          lt(inventoryReservations.expiresAt, new Date()),
          eq(orders.status, 'pending_payment'),
        ),
      )
      .limit(Math.min(Math.max(limit, 1), 500));
    if (!candidates.length) return { released: 0, orderIds: [] as string[] };

    const releasedOrderIds: string[] = [];
    for (const candidate of candidates) {
      const released = await db.transaction(async (tx) => {
        const [activeWeChatPayment] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(
            and(
              eq(payments.orderId, candidate.order.id),
              eq(payments.provider, 'wechatpay'),
              inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
            ),
          )
          .limit(1);
        if (activeWeChatPayment) return false;

        const [reservation] = await tx
          .update(inventoryReservations)
          .set({ releasedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(inventoryReservations.id, candidate.reservation.id),
              isNull(inventoryReservations.releasedAt),
              isNull(inventoryReservations.convertedAt),
            ),
          )
          .returning();
        if (!reservation) return false;

        const [order] = await tx
          .update(orders)
          .set({ status: 'closed', updatedAt: new Date() })
          .where(and(eq(orders.id, candidate.order.id), eq(orders.status, 'pending_payment')))
          .returning();
        if (!order) return false;
        await tx
          .update(registrations)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(registrations.id, order.registrationId));
        await tx.insert(orderStateLogs).values({
          orderId: order.id,
          fromStatus: 'pending_payment',
          toStatus: 'closed',
          reason: '支付超时，库存占用已释放',
        });
        await tx.insert(outboxEvents).values({
          organizationId: order.organizationId,
          eventId: order.eventId,
          eventType: 'InventoryReservationExpired',
          correlationId: `reservation:expired:${reservation.id}`,
          payload: { reservationId: reservation.id, orderId: order.id },
        });
        return true;
      });
      if (released) releasedOrderIds.push(candidate.order.id);
    }
    return { released: releasedOrderIds.length, orderIds: releasedOrderIds };
  }

  async inventorySummary(organizationId: string, eventId: EventId) {
    const [event] = await this.db()
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!event) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    const rows = await this.db()
      .select()
      .from(ticketTypes)
      .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.active, true)));
    if (rows.length === 0) return [];
    const reservations = await this.db()
      .select({
        ticketTypeId: inventoryReservations.ticketTypeId,
        quantity: sum(inventoryReservations.quantity),
      })
      .from(inventoryReservations)
      .where(
        and(
          inArray(
            inventoryReservations.ticketTypeId,
            rows.map((row) => row.id),
          ),
          isNull(inventoryReservations.releasedAt),
          isNull(inventoryReservations.convertedAt),
          gt(inventoryReservations.expiresAt, new Date()),
        ),
      )
      .groupBy(inventoryReservations.ticketTypeId);
    const waitlistHolds = await this.db()
      .select({ ticketTypeId: waitlistEntries.ticketTypeId, quantity: count() })
      .from(waitlistEntries)
      .where(
        and(
          inArray(
            waitlistEntries.ticketTypeId,
            rows.map((row) => row.id),
          ),
          eq(waitlistEntries.status, 'invited'),
          gt(waitlistEntries.expiresAt, new Date()),
        ),
      )
      .groupBy(waitlistEntries.ticketTypeId);
    const held = new Map(reservations.map((row) => [row.ticketTypeId, Number(row.quantity ?? 0)]));
    const waitlistHeld = new Map(
      waitlistHolds.map((row) => [row.ticketTypeId, Number(row.quantity ?? 0)]),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      capacity: row.capacity,
      sold: row.sold,
      reserved: held.get(row.id) ?? 0,
      waitlistHeld: waitlistHeld.get(row.id) ?? 0,
      available: Math.max(
        0,
        row.capacity - row.sold - (held.get(row.id) ?? 0) - (waitlistHeld.get(row.id) ?? 0),
      ),
    }));
  }
}
