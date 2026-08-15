import { orders, registrations } from '@conference/database';
import { and, eq, isNull, or } from 'drizzle-orm';

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
