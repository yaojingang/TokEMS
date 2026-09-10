import { and, eq, ne, sql } from 'drizzle-orm';
import type { ConferenceDatabase } from './index.js';
import { orderItems, type orders } from './schema.js';

/** Keep migration-backed single-seat items aligned with the existing order lifecycle. */
export async function syncLegacyOrderItemState(
  db: Pick<ConferenceDatabase, 'update'>,
  order: Pick<typeof orders.$inferSelect, 'id' | 'modelVersion'>,
  state: 'pending' | 'active' | 'cancelled',
  now: Date,
) {
  if (order.modelVersion !== 1) return;
  await db
    .update(orderItems)
    .set({
      state,
      ...(state === 'cancelled' ? { cancelledAt: now, inventoryReleasedAt: now } : {}),
      version: sql`${orderItems.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(orderItems.orderId, order.id), ne(orderItems.state, state)));
}
