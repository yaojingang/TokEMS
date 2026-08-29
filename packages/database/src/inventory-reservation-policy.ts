import { gt, inArray, or, sql } from 'drizzle-orm';
import { ACTIVE_WECHAT_PAYMENT_STATUSES, inventoryReservations, payments } from './schema.js';

export function activeInventoryReservationAt(evaluatedAt: Date) {
  return or(
    gt(inventoryReservations.expiresAt, evaluatedAt),
    sql<boolean>`exists (
      select 1
      from ${payments}
      where ${payments.orderId} = ${inventoryReservations.orderId}
        and ${payments.provider} = 'wechatpay'
        and ${inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES])}
    )`,
  );
}
