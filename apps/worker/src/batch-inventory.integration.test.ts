import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeInventoryReservationAt,
  attendeeClaimTokens,
  createDatabase,
  events,
  inventoryReservations,
  loadFeishuDigestSnapshot,
  orderItems,
  orders,
  organizations,
  outboxEvents,
  paymentNotificationInbox,
  payments,
  refundItemAllocations,
  refunds,
  registrations,
  tickets,
  ticketTypes,
} from '@conference/database';
import { expireBatchOrder } from './batch-inventory.worker.js';

const persistent = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;

/** Executes the actual deployment SQL after applying its psql capability branch. */
async function paymentActivity(connection: ReturnType<typeof createDatabase>) {
  const script = readFileSync(
    fileURLToPath(new URL('../../../tooling/production-deploy.sh', import.meta.url)),
    'utf8',
  );
  const body = script.match(
    /read_payment_activity\(\) \{[\s\S]*?<<'SQL'\n([\s\S]*?)\nSQL\n\}/,
  )?.[1];
  if (!body) throw new Error('Deployment payment gate SQL was not found');
  const [probePart, branches] = body.split('\\gset');
  if (!probePart || !branches) throw new Error('Deployment schema probe was not found');
  const complete = branches.match(/\\if :batch_complete\n([\s\S]*?)\\elif :batch_present/)?.[1];
  const partial = branches.match(/\\elif :batch_present\n([\s\S]*?)\\else/)?.[1];
  const legacy = branches.match(/\\else\n([\s\S]*?)\\endif/)?.[1];
  if (!complete || !partial || !legacy)
    throw new Error('Deployment schema branches were not found');
  const client = await connection.pool.connect();
  try {
    await client.query('begin read only');
    const probe = await client.query(probePart.replace(/^begin read only;\s*/, ''));
    const capabilities = probe.rows[0];
    if (
      typeof capabilities?.batch_complete !== 'boolean' ||
      typeof capabilities?.batch_present !== 'boolean'
    )
      throw new Error('Schema probe did not return booleans');
    const result = await client.query(
      capabilities.batch_complete ? complete : capabilities.batch_present ? partial : legacy,
    );
    return result.rows[0] as {
      active_attempts: string;
      unsettled_notifications: string;
      paid_without_tickets: string;
    };
  } finally {
    await client.query('rollback');
    client.release();
  }
}

persistent('batch inventory and deployment gates with real PostgreSQL', () => {
  const names = Array.from({ length: 3 }, () => `batch_worker_${randomUUID().replaceAll('-', '')}`);
  let admin: ReturnType<typeof createDatabase>;
  let current: ReturnType<typeof createDatabase>;
  let legacy: ReturnType<typeof createDatabase>;
  let partial: ReturnType<typeof createDatabase>;
  const opened: ReturnType<typeof createDatabase>[] = [];

  beforeAll(async () => {
    const url = new URL(process.env.BATCH_TEST_DATABASE_URL!);
    admin = createDatabase(url.toString());
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../../packages/database/drizzle', import.meta.url),
      ),
    });
    for (const [index, name] of names.entries()) {
      await admin.pool.query(`create database "${name}"`);
      url.pathname = `/${name}`;
      const connection = createDatabase(url.toString());
      opened.push(connection);
      const client = await connection.pool.connect();
      try {
        for (const migration of migrations.slice(0, index === 0 ? 66 : 65)) {
          await client.query('begin');
          for (const statement of migration.sql) await client.query(statement);
          await client.query('commit');
        }
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }
    [current, legacy, partial] = opened as [typeof current, typeof legacy, typeof partial];
  }, 120_000);

  afterAll(async () => {
    for (const connection of opened) await connection.pool.end();
    if (admin) {
      for (const name of names) await admin.pool.query(`drop database if exists "${name}"`);
      await admin.pool.end();
    }
  });

  async function fixture(
    options: {
      quantity?: number;
      review?: boolean;
      expiresAt?: Date;
      modelVersion?: 1 | 2;
      price?: number;
    } = {},
  ) {
    return current.db.transaction(async (db) => {
      const organizationId = randomUUID();
      const modelVersion = options.modelVersion ?? 2;
      const quantity = options.quantity ?? (modelVersion === 1 ? 1 : 5);
      const price = options.price ?? 10000;
      const expiresAt = options.expiresAt ?? new Date(Date.now() - 60_000);
      await db
        .insert(organizations)
        .values({ id: organizationId, slug: organizationId, name: '批量库存测试' });
      const [event] = await db
        .insert(events)
        .values({
          organizationId,
          slug: organizationId,
          name: '测试大会',
          shortName: '测试',
          tagline: '测试',
          description: '测试',
          timezone: 'Asia/Shanghai',
          startsAt: new Date('2027-01-01'),
          endsAt: new Date('2027-01-02'),
          venue: '测试',
          city: '测试',
          address: '测试',
        })
        .returning();
      const [type] = await db
        .insert(ticketTypes)
        .values({
          organizationId,
          eventId: event!.id,
          code: 'GENERAL',
          name: '通票',
          description: '',
          price,
          capacity: 10,
        })
        .returning();
      const rows = await db
        .insert(registrations)
        .values(
          Array.from({ length: quantity }, () => ({
            organizationId,
            eventId: event!.id,
            ticketTypeId: type!.id,
            registrationCode: randomUUID(),
            status: options.review ? ('pending_review' as const) : ('pending_payment' as const),
            attendee: { name: '参会人', mobile: '', email: '', company: '', title: '', city: '' },
          })),
        )
        .returning();
      const [order] = await db
        .insert(orders)
        .values({
          organizationId,
          eventId: event!.id,
          modelVersion,
          quantity,
          registrationId: quantity === 1 ? rows[0]!.id : null,
          purchaseIntentId: randomUUID(),
          orderNo: randomUUID(),
          status: options.review ? 'pending_review' : 'pending_payment',
          amount: quantity * price,
          currency: 'CNY',
          pricingSnapshot: {},
          expiresAt,
          createdAt: options.review ? new Date(Date.now() - 31 * 24 * 60 * 60_000) : new Date(),
        })
        .returning();
      const items = await db
        .insert(orderItems)
        .values(
          rows.map((registration, index) => ({
            orderId: order!.id,
            registrationId: registration.id,
            organizationId,
            eventId: event!.id,
            clientId: randomUUID(),
            position: index + 1,
            ticketTypeId: type!.id,
            unitPrice: price,
            allocatedAmount: price,
            pricingSnapshot: {},
          })),
        )
        .returning();
      await db
        .insert(inventoryReservations)
        .values(
          items.map((item) => ({
            eventId: event!.id,
            ticketTypeId: type!.id,
            orderId: order!.id,
            orderItemId: item.id,
            quantity: 1,
            expiresAt,
          })),
        );
      return { order: order!, event: event!, type: type!, items, registrations: rows };
    });
  }

  async function payment(
    scope: Awaited<ReturnType<typeof fixture>>,
    status: typeof payments.$inferInsert.status,
    succeeded = false,
  ) {
    const [row] = await current.db
      .insert(payments)
      .values({
        orderId: scope.order.id,
        provider: scope.order.amount === 0 ? 'free' : 'wechatpay',
        status,
        amount: scope.order.amount,
        currency: 'CNY',
        externalId: randomUUID(),
        succeededAt: succeeded ? new Date() : null,
      })
      .returning();
    return row!;
  }
  async function notice(scope: Awaited<ReturnType<typeof fixture>>) {
    await current.db
      .insert(paymentNotificationInbox)
      .values({
        organizationId: scope.order.organizationId,
        orderId: scope.order.id,
        notificationId: randomUUID(),
        outTradeNo: randomUUID().replaceAll('-', ''),
        eventType: 'TRANSACTION.SUCCESS',
        status: 'received',
        payload: {},
      });
  }
  async function assertPending(scope: Awaited<ReturnType<typeof fixture>>) {
    const [row] = await current.db.select().from(orders).where(eq(orders.id, scope.order.id));
    expect(row!.status).toBe(scope.order.status);
    const reservations = await current.db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, scope.order.id));
    expect(reservations).toHaveLength(scope.order.quantity);
    expect(reservations.every((row) => row.releasedAt === null)).toBe(true);
    expect(
      (
        await current.db.select().from(orderItems).where(eq(orderItems.orderId, scope.order.id))
      ).every((item) => item.state === 'pending'),
    ).toBe(true);
  }
  async function activeReservations(scope: Awaited<ReturnType<typeof fixture>>) {
    const [row] = await current.db
      .select({ count: sql<number>`coalesce(sum(${inventoryReservations.quantity}),0)::int` })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.orderId, scope.order.id),
          isNull(inventoryReservations.releasedAt),
          isNull(inventoryReservations.convertedAt),
          activeInventoryReservationAt(new Date()),
        ),
      );
    return row!.count;
  }
  async function markPaid(scope: Awaited<ReturnType<typeof fixture>>) {
    const paid = await payment(scope, 'succeeded', true);
    await current.db
      .update(orders)
      .set({ status: 'paid', settledPaymentId: paid.id })
      .where(eq(orders.id, scope.order.id));
    await current.db
      .update(orderItems)
      .set({ state: 'active' })
      .where(eq(orderItems.orderId, scope.order.id));
    await current.db
      .update(registrations)
      .set({ status: 'confirmed' })
      .where(
        inArray(
          registrations.id,
          scope.registrations.map((row) => row.id),
        ),
      );
    await current.db
      .update(inventoryReservations)
      .set({ convertedAt: new Date() })
      .where(eq(inventoryReservations.orderId, scope.order.id));
    await current.db
      .update(ticketTypes)
      .set({ sold: scope.order.quantity })
      .where(eq(ticketTypes.id, scope.type.id));
    const issued = await current.db
      .insert(tickets)
      .values(
        scope.items.map((item) => ({
          eventId: item.eventId,
          ticketTypeId: item.ticketTypeId,
          registrationId: item.registrationId,
          code: randomUUID(),
        })),
      )
      .returning();
    return { paid, tickets: issued };
  }

  it('expires all five items and reservations once under concurrent expiry retries', async () => {
    const scope = await fixture();
    await current.db
      .insert(attendeeClaimTokens)
      .values(
        scope.items.map((item) => ({
          registrationId: item.registrationId,
          tokenHash: randomUUID(),
          mobileDigest: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        })),
      );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => expireBatchOrder(current.db, scope.order.id)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const reservationRows = await current.db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, scope.order.id));
    expect(reservationRows).toHaveLength(5);
    expect(
      reservationRows.every((row) => row.releasedAt !== null && row.convertedAt === null),
    ).toBe(true);
    const items = await current.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, scope.order.id));
    expect(
      items.every(
        (row) => row.state === 'cancelled' && row.inventoryReleasedAt !== null && row.version === 2,
      ),
    ).toBe(true);
    const claims = await current.db
      .select()
      .from(attendeeClaimTokens)
      .where(
        inArray(
          attendeeClaimTokens.registrationId,
          scope.items.map((item) => item.registrationId),
        ),
      );
    expect(claims.every((row) => row.revokedAt !== null)).toBe(true);
    const outbox = await current.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventId, scope.event.id),
          eq(outboxEvents.eventType, 'InventoryReservationExpired'),
        ),
      );
    expect(outbox).toHaveLength(5);
    expect(new Set(outbox.map((row) => row.payload.reservationId)).size).toBe(5);
    expect(outbox.every((row) => row.payload.ticketTypeId === scope.type.id)).toBe(true);
  });
  it('rolls every state back if expiry cannot persist its inventory event', async () => {
    const scope = await fixture();
    await current.pool.query(
      `create function reject_batch_expiry() returns trigger language plpgsql as $$ begin if new.event_id = ${scope.event.id} then raise exception 'injected outbox failure'; end if; return new; end $$; create trigger reject_batch_expiry before insert on outbox_events for each row execute function reject_batch_expiry()`,
    );
    try {
      await expect(expireBatchOrder(current.db, scope.order.id)).rejects.toThrow();
      await assertPending(scope);
    } finally {
      await current.pool.query(
        'drop trigger reject_batch_expiry on outbox_events; drop function reject_batch_expiry()',
      );
    }
  });
  it.each([
    'preparing',
    'pending',
    'processing',
    'query_pending',
    'close_pending',
    'unknown',
  ] as const)('keeps the whole batch for a %s payment attempt', async (status) => {
    const scope = await fixture();
    await payment(scope, status);
    expect(await expireBatchOrder(current.db, scope.order.id)).toBe(false);
    await assertPending(scope);
    expect(await activeReservations(scope)).toBe(5);
  });
  it('keeps received money while all tickets still need recovery', async () => {
    const scope = await fixture();
    await payment(scope, 'succeeded', true);
    expect(await expireBatchOrder(current.db, scope.order.id)).toBe(false);
    await assertPending(scope);
    expect(await activeReservations(scope)).toBe(5);
  });
  it.each(['entitlementsOnHold', 'external_hold'] as const)(
    'keeps an expired batch under %s protection',
    async (protection) => {
      const scope = await fixture();
      await current.db
        .update(orders)
        .set(
          protection === 'entitlementsOnHold'
            ? { entitlementsOnHold: true }
            : { refundExecutionMode: 'external_hold' },
        )
        .where(eq(orders.id, scope.order.id));
      expect(await expireBatchOrder(current.db, scope.order.id)).toBe(false);
      await assertPending(scope);
      expect(await activeReservations(scope)).toBe(5);
    },
  );
  it('keeps inventory counted while a verified payment notification is pending', async () => {
    const scope = await fixture();
    await notice(scope);
    expect(await expireBatchOrder(current.db, scope.order.id)).toBe(false);
    await assertPending(scope);
    expect(await activeReservations(scope)).toBe(5);
  });
  it('expires a batch after its 30-day review deadline', async () => {
    const scope = await fixture({ review: true });
    expect(await expireBatchOrder(current.db, scope.order.id)).toBe(true);
    const [row] = await current.db.select().from(orders).where(eq(orders.id, scope.order.id));
    expect(row!.status).toBe('closed');
    const [pending] = await current.db
      .select({ count: sql<number>`count(*)::int` })
      .from(registrations)
      .where(
        and(eq(registrations.eventId, scope.event.id), eq(registrations.status, 'pending_review')),
      );
    expect(pending!.count).toBe(0);
    const summaries = await current.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventId, scope.event.id),
          eq(outboxEvents.eventType, 'BatchOrderReviewExpired'),
        ),
      );
    expect(summaries).toHaveLength(1);
  });
  it('preserves legacy review reservations beyond their historical expiry', async () => {
    const scope = await fixture({ review: true, modelVersion: 1 });
    expect(await expireBatchOrder(current.db, scope.order.id)).toBe(false);
    await assertPending(scope);
    expect(await activeReservations(scope)).toBe(1);
  });
  it('does not close the renewed payment window when an older reservation is selected', async () => {
    const scope = await fixture();
    await current.db
      .update(orders)
      .set({ expiresAt: new Date(Date.now() + 15 * 60_000) })
      .where(eq(orders.id, scope.order.id));
    expect(await expireBatchOrder(current.db, scope.order.id)).toBe(false);
    await assertPending(scope);
  });
  it('does not expire a batch containing an active item', async () => {
    const scope = await fixture();
    await current.db
      .update(orderItems)
      .set({ state: 'active' })
      .where(eq(orderItems.id, scope.items[0]!.id));
    expect(await expireBatchOrder(current.db, scope.order.id)).toBe(false);
    const [row] = await current.db.select().from(orders).where(eq(orders.id, scope.order.id));
    expect(row!.status).toBe('pending_payment');
  });
  it('executes the actual pre-migration deployment SQL without referencing batch columns', async () => {
    expect(await paymentActivity(legacy)).toEqual({
      active_attempts: '0',
      unsettled_notifications: '0',
      paid_without_tickets: '0',
    });
  });
  it.each([
    ['orders', 'model_version', 'integer not null default 1'],
    ['orders', 'quantity', 'integer not null default 1'],
    ['orders', 'settled_payment_id', 'uuid'],
    ['orders', 'entitlements_on_hold', 'boolean not null default false'],
    ['orders', 'version', 'integer not null default 1'],
    ['inventory_reservations', 'order_item_id', 'uuid'],
    ['refunds', 'protection_scope', "varchar(24) not null default 'order'"],
  ])('rejects a partial migration containing only %s.%s', async (table, column, definition) => {
    await partial.pool.query(`alter table ${table} add column ${column} ${definition}`);
    try {
      await expect(paymentActivity(partial)).rejects.toThrow();
    } finally {
      await partial.pool.query(`alter table ${table} drop column ${column}`);
    }
  });
  it.each(['orders', 'invoice_requests'])(
    'rejects a partial migration containing only nullable %s.registration_id',
    async (table) => {
      await partial.pool.query(`alter table ${table} alter column registration_id drop not null`);
      try {
        await expect(paymentActivity(partial)).rejects.toThrow();
      } finally {
        await partial.pool.query(`alter table ${table} alter column registration_id set not null`);
      }
    },
  );
  it('blocks deployment when one of five paid tickets is missing', async () => {
    const scope = await fixture();
    const completed = await markPaid(scope);
    const before = await paymentActivity(current);
    await current.db.delete(tickets).where(eq(tickets.id, completed.tickets[2]!.id));
    const after = await paymentActivity(current);
    expect(Number(after.paid_without_tickets) - Number(before.paid_without_tickets)).toBe(1);
  });
  it('blocks deployment when an active paid item has a cancelled ticket', async () => {
    const scope = await fixture();
    const completed = await markPaid(scope);
    const before = await paymentActivity(current);
    await current.db
      .update(tickets)
      .set({ status: 'cancelled' })
      .where(eq(tickets.id, completed.tickets[2]!.id));
    const after = await paymentActivity(current);
    expect(Number(after.paid_without_tickets) - Number(before.paid_without_tickets)).toBe(1);
  });
  it('blocks deployment when refunded money still has a local fulfillment failure', async () => {
    const scope = await fixture();
    const completed = await markPaid(scope);
    const before = await paymentActivity(current);
    await current.db
      .insert(refunds)
      .values({
        organizationId: scope.order.organizationId,
        eventId: scope.event.id,
        orderId: scope.order.id,
        paymentId: completed.paid.id,
        refundNo: randomUUID(),
        amount: 10000,
        currency: 'CNY',
        status: 'succeeded',
        reason: '部分名额退款',
        idempotencyKey: randomUUID(),
        fulfillmentAttention: '退款已成功，名额权益尚未同步',
        succeededAt: new Date(),
      });
    await current.db
      .update(orders)
      .set({ status: 'partially_refunded' })
      .where(eq(orders.id, scope.order.id));
    const after = await paymentActivity(current);
    expect(Number(after.paid_without_tickets) - Number(before.paid_without_tickets)).toBe(1);
  });
  it('accepts completed attendance with valid paid tickets', async () => {
    const scope = await fixture();
    await markPaid(scope);
    const before = await paymentActivity(current);
    await current.db
      .update(registrations)
      .set({ status: 'completed' })
      .where(eq(registrations.eventId, scope.event.id));
    expect(await paymentActivity(current)).toEqual(before);
  });
  it('accepts all cancelled free seats with their original tickets and payment retained', async () => {
    const scope = await fixture({ price: 0 });
    await markPaid(scope);
    const before = await paymentActivity(current);
    await current.db.transaction(async (tx) => {
      await tx.update(orders).set({ status: 'closed' }).where(eq(orders.id, scope.order.id));
      await tx
        .update(orderItems)
        .set({ state: 'cancelled', cancelledAt: new Date(), inventoryReleasedAt: new Date() })
        .where(eq(orderItems.orderId, scope.order.id));
      await tx
        .update(registrations)
        .set({ status: 'cancelled' })
        .where(eq(registrations.eventId, scope.event.id));
      await tx
        .update(tickets)
        .set({ status: 'cancelled' })
        .where(eq(tickets.eventId, scope.event.id));
      await tx
        .update(inventoryReservations)
        .set({ releasedAt: new Date() })
        .where(eq(inventoryReservations.orderId, scope.order.id));
      await tx.update(ticketTypes).set({ sold: 0 }).where(eq(ticketTypes.id, scope.type.id));
    });
    expect(await paymentActivity(current)).toEqual(before);
  });
  it('settles a replayed original payment notification after a full compensation refund retaining all rights', async () => {
    const scope = await fixture();
    const completed = await markPaid(scope);
    const before = await paymentActivity(current);
    await current.db.transaction(async (tx) => {
      const [refund] = await tx
        .insert(refunds)
        .values({
          organizationId: scope.order.organizationId,
          eventId: scope.event.id,
          orderId: scope.order.id,
          paymentId: completed.paid.id,
          refundNo: randomUUID(),
          amount: 50000,
          currency: 'CNY',
          status: 'succeeded',
          reason: '保留名额的全额补偿',
          idempotencyKey: randomUUID(),
          succeededAt: new Date(),
        })
        .returning();
      await tx
        .insert(refundItemAllocations)
        .values(
          scope.items.map((item) => ({
            refundId: refund!.id,
            paymentId: completed.paid.id,
            orderId: scope.order.id,
            orderItemId: item.id,
            organizationId: scope.order.organizationId,
            eventId: scope.event.id,
            amount: 10000,
            basis: '已核验全额补偿，保留参会权益',
          })),
        );
      await tx.update(orders).set({ status: 'refunded' }).where(eq(orders.id, scope.order.id));
      await tx
        .update(payments)
        .set({ status: 'refunded' })
        .where(eq(payments.id, completed.paid.id));
      await tx
        .insert(paymentNotificationInbox)
        .values({
          organizationId: scope.order.organizationId,
          orderId: scope.order.id,
          paymentId: completed.paid.id,
          notificationId: randomUUID(),
          outTradeNo: randomUUID().replaceAll('-', ''),
          eventType: 'TRANSACTION.SUCCESS',
          status: 'received',
          payload: { externalId: completed.paid.externalId, amount: 50000, currency: 'CNY' },
        });
    });
    expect(await paymentActivity(current)).toEqual(before);
  });
  it('counts one paid order and five seats without multiplying order money', async () => {
    const scope = await fixture();
    await markPaid(scope);
    const snapshot = await loadFeishuDigestSnapshot(
      current.db,
      scope.order.organizationId,
      scope.event.id,
      { now: new Date(Date.now() + 24 * 60 * 60_000) },
    );
    expect(snapshot.cumulative.paidOrders).toBe(1);
    expect(snapshot.cumulative.paidSeats).toBe(5);
    expect(snapshot.cumulative.confirmedAttendees).toBe(5);
    expect(snapshot.cumulative.netRevenue).toBe(50000);
    expect(snapshot.daily.grossReceipts).toBe(50000);
    expect(snapshot.cumulative.remainingInventory).toBe(5);
  });
});
