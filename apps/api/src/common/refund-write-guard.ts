import { HttpStatus } from '@nestjs/common';
import { API_ERROR_CODES } from '@conference/contracts';
import { orders, tickets, refundRequests, refunds } from '@conference/database';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import type { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';

type Database = NonNullable<DatabaseService['db']>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Take the order lock before touching invoice or fulfillment rows. */
export async function guardRefundWrite(tx: Tx, orderId: string, allowDuringRefund = false) {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .for('update')
    .limit(1);
  if (!order) throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
  await tx
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.registrationId, order.registrationId))
    .for('update');
  if (allowDuringRefund) return order;
  const [request] = await tx
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.orderId, orderId),
        eq(refundRequests.reviewStatus, 'approved'),
        isNull(refundRequests.terminatedAt),
      ),
    )
    .limit(1);
  const [repair] = await tx
    .select({ id: refunds.id })
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), isNotNull(refunds.fulfillmentAttention)))
    .limit(1);
  if (request || repair || order.refundExecutionMode === 'external_hold')
    throw new DomainError(
      API_ERROR_CODES.INVALID_STATE_TRANSITION,
      '订单正在退款或资金核验，暂不能修改参会权益或开具发票',
      HttpStatus.CONFLICT,
    );
  return order;
}
