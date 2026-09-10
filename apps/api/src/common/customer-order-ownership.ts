import { orderItems, orders, registrations } from '@conference/database';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

/** Resolve a registration's order while old single-seat records retain their compatibility link. */
export function registrationOrderJoin() {
  return or(eq(orders.registrationId, registrations.id), sql`exists (select 1 from ${orderItems} related_item where related_item.order_id = ${orders.id} and related_item.registration_id = ${registrations.id})`)!;
}

export function customerCanManageOrder(
  purchaserCustomerUserId: string | null,
  purchaseIntentId: string | null,
  registrationCustomerUserId: string | null,
  customerUserId: string,
) {
  return (
    purchaserCustomerUserId === customerUserId ||
    (purchaserCustomerUserId === null &&
      purchaseIntentId === null &&
      registrationCustomerUserId === customerUserId)
  );
}

export function purchaserCanAccessTicket(
  purchaserCustomerUserId: string | null,
  purchaseIntentId: string | null,
  registrationCustomerUserId: string | null,
  purchaseFor: unknown,
) {
  if (purchaseFor === 'other') return false;
  if (purchaserCustomerUserId !== null) {
    return purchaserCustomerUserId === registrationCustomerUserId;
  }
  return purchaseIntentId === null && registrationCustomerUserId !== null;
}

export function customerPurchaserScopeSql(customerUserId: string) {
  return or(
    eq(orders.purchaserCustomerUserId, customerUserId),
    and(
      isNull(orders.purchaserCustomerUserId),
      isNull(orders.purchaseIntentId),
      eq(registrations.customerUserId, customerUserId),
    ),
  )!;
}
