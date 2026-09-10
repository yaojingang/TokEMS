import { sha256 } from '@conference/security';
import type { orders, registrations } from '@conference/database';

export function registrationEditVersion(
  registration: typeof registrations.$inferSelect,
  order: typeof orders.$inferSelect,
) {
  return sha256(
    JSON.stringify([
      registration.updatedAt.toISOString(),
      registration.attendee,
      registration.formVersion,
      registration.ticketTypeId,
      order.expiresAt.toISOString(),
      order.purchaseIntentId,
    ]),
  );
}
