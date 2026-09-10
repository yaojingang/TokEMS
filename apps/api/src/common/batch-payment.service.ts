import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { API_ERROR_CODES } from '@conference/contracts';
import { orders, payments, tickets, orderItems, orderStateLogs } from '@conference/database';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError } from './domain-error.js';
import { batchConflict } from './batch-purchase-policy.js';
import { batchOrderView, OrderItemsService } from './order-items.service.js';
import { withPostgresTransactionRetry } from './transaction-retry.js';
import type { PaymentCompletion, PaymentConfirmation } from './conference.repository.js';

@Injectable()
export class BatchPaymentService {
  constructor(@Inject(OrderItemsService) private readonly items: OrderItemsService) {}

  async confirm(orderId: string, confirmation: PaymentConfirmation): Promise<PaymentCompletion> {
    const result = await withPostgresTransactionRetry(() =>
      this.items.db().transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`wechatpay:prepare:${orderId}`},0))`,
        );
        const [order] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .for('update')
          .limit(1);
        if (!order || order.modelVersion !== 2) batchConflict('订单模型不匹配');
        await this.items.lockItems(tx, orderId);
        if (
          (confirmation.amount !== undefined && confirmation.amount !== order.amount) ||
          (confirmation.currency !== undefined && confirmation.currency !== order.currency)
        )
          throw new DomainError(
            API_ERROR_CODES.VALIDATION_ERROR,
            '支付回调金额或币种与订单不一致',
            HttpStatus.BAD_REQUEST,
          );
        const [external] = await tx
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.provider, confirmation.provider),
              eq(payments.externalId, confirmation.externalId),
            ),
          )
          .limit(1);
        if (external && external.orderId !== orderId) batchConflict('支付结果已关联其他订单');
        const [prepared] = confirmation.paymentId
          ? await tx
              .select()
              .from(payments)
              .where(
                and(
                  eq(payments.id, confirmation.paymentId),
                  eq(payments.orderId, orderId),
                  eq(payments.provider, confirmation.provider),
                ),
              )
              .limit(1)
          : confirmation.outTradeNo
            ? await tx
                .select()
                .from(payments)
                .where(
                  and(
                    eq(payments.outTradeNo, confirmation.outTradeNo),
                    eq(payments.orderId, orderId),
                    eq(payments.provider, confirmation.provider),
                  ),
                )
                .limit(1)
            : [];
        if (
          confirmation.provider === 'wechatpay' &&
          (!prepared || prepared.amount !== order.amount || prepared.currency !== order.currency)
        )
          batchConflict('原支付尝试需要核验');
        if (external && prepared && external.id !== prepared.id)
          batchConflict('支付结果与原支付尝试不一致');
        const occurredAt = confirmation.occurredAt ? new Date(confirmation.occurredAt) : new Date();
        if (Number.isNaN(occurredAt.getTime())) batchConflict('付款时间无效');
        const now = new Date();
        let payment = external ?? prepared;
        if (!payment) {
          [payment] = await tx
            .insert(payments)
            .values({
              orderId,
              provider: confirmation.provider,
              externalId: confirmation.externalId,
              status: 'succeeded',
              succeededAt: occurredAt,
              amount: order.amount,
              currency: order.currency,
              payload: confirmation.payload,
            })
            .returning();
        } else if (!payment.succeededAt) {
          [payment] = await tx
            .update(payments)
            .set({
              externalId: confirmation.externalId,
              status: 'succeeded',
              succeededAt: occurredAt,
              wechatTradeState: confirmation.provider === 'wechatpay' ? 'SUCCESS' : null,
              payload: { ...payment.payload, ...confirmation.payload },
              updatedAt: now,
            })
            .where(eq(payments.id, payment.id))
            .returning();
        }
        const [evidence] = await tx
          .select({
            expected: sql<number>`count(*)::int`,
            issued: sql<number>`count(${tickets.id})::int`,
          })
          .from(orderItems)
          .leftJoin(tickets, eq(tickets.registrationId, orderItems.registrationId))
          .where(eq(orderItems.orderId, orderId));
        let attention: string | null = null;
        let requiresManualReview = true;
        if (order.settledPaymentId && order.settledPaymentId !== payment!.id)
          attention = '同一订单收到不同的成功付款，请核验多付资金';
        else if (
          order.settledPaymentId === payment!.id &&
          evidence?.expected === order.quantity &&
          evidence.issued === order.quantity
        )
          return { order: batchOrderView(order), attention: null };
        else if (
          !['pending_payment', 'processing', 'paid'].includes(order.status) ||
          occurredAt < order.createdAt ||
          occurredAt > order.expiresAt
        )
          attention = '支付发生于不可自动出票的订单状态，请核验付款及名额';
        else if (order.entitlementsOnHold)
          attention = order.refundExecutionReason || '订单资金或权益正在人工核验';
        if (!attention) {
          try {
            await tx.transaction(async (savepoint) =>
              this.items.issue(savepoint, order, payment!.id, now),
            );
            await tx
              .insert(orderStateLogs)
              .values({
                orderId,
                fromStatus: order.status,
                toStatus: 'paid',
                reason: confirmation.reason,
                metadata: { quantity: order.quantity, paymentId: payment!.id },
              });
          } catch (error) {
            attention = error instanceof DomainError ? error.message : '已收款，全部名额出票待重试';
            requiresManualReview = error instanceof DomainError;
          }
        }
        if (attention)
          await tx
            .update(orders)
            .set(
              requiresManualReview
                ? {
                    refundExecutionMode: 'external_hold',
                    refundExecutionReason: attention,
                    entitlementsOnHold: true,
                    updatedAt: now,
                  }
                : { status: 'processing', updatedAt: now },
            )
            .where(eq(orders.id, orderId));
        const [current] = await tx.select().from(orders).where(eq(orders.id, orderId));
        return { order: batchOrderView(current!), attention };
      }),
    );
    // Money evidence commits before the inbox retries an incomplete fulfillment.
    if (result.attention) batchConflict(result.attention);
    return { order: result.order };
  }
}
