import { HttpStatus } from '@nestjs/common';
import { API_ERROR_CODES } from '@conference/contracts';
import { orders, refundRequests, refunds } from '@conference/database';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import type { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { refundItemLedger, refundRights } from './batch-refund-items.js';

type Database = NonNullable<DatabaseService['db']>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type RefundWriteScope = { purpose: 'rights' | 'admission'; orderItemId?: string; registrationId?: string };

/** Financial writes reserve the order; rights writes use explicit item scope after the order lock. */
export async function guardRefundWrite(
  tx: Tx,
  orderId: string,
  allowDuringRefund = false,
  scope?: RefundWriteScope,
) {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .for('update')
    .limit(1);
  if (!order) throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
  const rights = await refundRights(tx, order, true);
  if (allowDuringRefund) return order;
  const requests = await tx
    .select()
    .from(refundRequests)
    .where(and(eq(refundRequests.orderId, orderId), isNull(refundRequests.terminatedAt)));
  const repairs = await tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), isNotNull(refunds.fulfillmentAttention)));
  const admission = scope?.purpose === 'admission';
  let blocked = order.entitlementsOnHold || ((!admission || order.modelVersion === 1) && order.refundExecutionMode === 'external_hold');
  if (order.modelVersion === 1 || !scope) {
    blocked ||=
      requests.some((row) => order.modelVersion === 2 || row.reviewStatus === 'approved') ||
      repairs.length > 0;
  } else {
    const item = rights.items.find((row) =>
      scope.orderItemId
        ? row.id === scope.orderItemId
        : row.registrationId === scope.registrationId,
    );
    if (!item)
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单名额不存在', HttpStatus.NOT_FOUND);
    const ledger = await refundItemLedger(tx, orderId);
    const requestIds = ledger.requestItems
      .filter((row) => row.orderItemId === item.id && (!admission || row.rightsEffect === 'revoke'))
      .map((row) => row.refundRequestId);
    blocked ||= requests.some(
      (row) =>
        row.reviewStatus === 'approved' &&
        (requestIds.includes(row.id) || row.businessSnapshot.modelVersion !== 2),
    );
    blocked ||= repairs.some(
      (row) =>
        row.protectionScope === 'order' ||
        (row.requestId && requestIds.includes(row.requestId)) ||
        ledger.allocations.some(
          (allocation) => allocation.refundId === row.id && allocation.orderItemId === item.id && (!admission || !allocation.refundRequestItemId || ledger.requestItems.find((target) => target.id === allocation.refundRequestItemId)?.rightsEffect !== 'retain'),
        ),
    );
    blocked ||= Boolean(
      rights.tickets.find((row) => row.registrationId === item.registrationId)?.refundPausedBy,
    );
  }
  if (blocked)
    throw new DomainError(
      API_ERROR_CODES.INVALID_STATE_TRANSITION,
      '订单正在退款或资金核验，暂不能修改参会权益或开具发票',
      HttpStatus.CONFLICT,
    );
  return order;
}
