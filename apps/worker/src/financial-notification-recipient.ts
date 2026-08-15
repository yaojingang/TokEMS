interface FinancialNotificationOrder {
  purchaserCustomerUserId: string | null;
  purchaseIntentId: string | null;
  purchaserSnapshot: { email?: string; mobile?: string } | null;
}

interface FinancialNotificationAttendee {
  email: string;
  mobile: string;
}

export function financialNotificationRecipient(
  order: FinancialNotificationOrder,
  attendee: FinancialNotificationAttendee,
  _requestedRecipient?: unknown,
) {
  return (
    order.purchaserSnapshot?.email ||
    order.purchaserSnapshot?.mobile ||
    (order.purchaserCustomerUserId === null && order.purchaseIntentId === null
      ? attendee.email || attendee.mobile
      : '')
  );
}
