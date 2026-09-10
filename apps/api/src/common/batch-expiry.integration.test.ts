import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  events,
  inventoryReservations,
  orderItems,
  orders,
  organizations,
  outboxEvents,
  paymentNotificationInbox,
  payments,
  registrations,
  ticketTypes,
} from '@conference/database';
import { DatabaseService } from './database.service.js';
import { CommerceOperationsService } from './commerce-operations.service.js';

const persistent = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;
persistent('administrative batch expiry with real PostgreSQL', () => {
  const name = `batch_expiry_${randomUUID().replaceAll('-', '')}`;
  let admin: ReturnType<typeof createDatabase>;
  let database: DatabaseService;
  let commerce: CommerceOperationsService;
  const savedUrl = process.env.DATABASE_URL;
  beforeAll(async () => {
    const url = new URL(process.env.BATCH_TEST_DATABASE_URL!);
    admin = createDatabase(url.toString());
    await admin.pool.query(`create database "${name}"`);
    url.pathname = `/${name}`;
    const migrationDb = createDatabase(url.toString());
    const client = await migrationDb.pool.connect();
    try {
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL('../../../../packages/database/drizzle', import.meta.url),
        ),
      });
      for (const migration of migrations.slice(0, 66)) {
        await client.query('begin');
        for (const statement of migration.sql) await client.query(statement);
        await client.query('commit');
      }
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
      await migrationDb.pool.end();
    }
    process.env.DATABASE_URL = url.toString();
    database = new DatabaseService();
    commerce = new CommerceOperationsService(database);
  }, 120_000);
  afterAll(async () => {
    await database?.onModuleDestroy();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    if (admin) {
      await admin.pool.query(`drop database if exists "${name}"`);
      await admin.pool.end();
    }
  });
  afterEach(async () => {
    await database.db!.update(orders).set({ expiresAt: new Date(Date.now() + 60_000) });
  });

  async function fixture(review = false) {
    return database.db!.transaction(async (db) => {
      const organizationId = randomUUID();
      await db
        .insert(organizations)
        .values({ id: organizationId, slug: organizationId, name: '批量清理测试' });
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
          price: 10000,
          capacity: 10,
        })
        .returning();
      const rows = await db
        .insert(registrations)
        .values(
          Array.from({ length: 5 }, () => ({
            organizationId,
            eventId: event!.id,
            ticketTypeId: type!.id,
            registrationCode: randomUUID(),
            status: review ? ('pending_review' as const) : ('pending_payment' as const),
            attendee: { name: '参会人', mobile: '', email: '', company: '', title: '', city: '' },
          })),
        )
        .returning();
      const expiresAt = new Date(Date.now() - 60_000);
      const [order] = await db
        .insert(orders)
        .values({
          organizationId,
          eventId: event!.id,
          modelVersion: 2,
          quantity: 5,
          registrationId: null,
          purchaseIntentId: randomUUID(),
          orderNo: randomUUID(),
          status: review ? 'pending_review' : 'pending_payment',
          amount: 50000,
          currency: 'CNY',
          pricingSnapshot: {},
          expiresAt,
          createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000),
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
            unitPrice: 10000,
            allocatedAmount: 10000,
            pricingSnapshot: {},
          })),
        )
        .returning();
      await db.insert(inventoryReservations).values(
        items.map((item) => ({
          eventId: event!.id,
          ticketTypeId: type!.id,
          orderId: order!.id,
          orderItemId: item.id,
          quantity: 1,
          expiresAt,
        })),
      );
      return { order: order!, items };
    });
  }
  async function assertPending(scope: Awaited<ReturnType<typeof fixture>>) {
    const [order] = await database.db!.select().from(orders).where(eq(orders.id, scope.order.id));
    expect(order!.status).toBe(scope.order.status);
    const rows = await database
      .db!.select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, scope.order.id));
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.releasedAt === null)).toBe(true);
  }
  it.each(['entitlementsOnHold', 'external_hold'] as const)(
    'preserves an expired batch under %s protection',
    async (protection) => {
      const scope = await fixture();
      await database
        .db!.update(orders)
        .set(
          protection === 'entitlementsOnHold'
            ? { entitlementsOnHold: true }
            : { refundExecutionMode: 'external_hold' },
        )
        .where(eq(orders.id, scope.order.id));
      await commerce.releaseExpiredReservations();
      await assertPending(scope);
    },
  );
  it('preserves the complete batch while a payment success notification is unprocessed', async () => {
    const scope = await fixture();
    await database.db!.insert(paymentNotificationInbox).values({
      organizationId: scope.order.organizationId,
      orderId: scope.order.id,
      notificationId: randomUUID(),
      outTradeNo: randomUUID().replaceAll('-', ''),
      eventType: 'TRANSACTION.SUCCESS',
      status: 'received',
      payload: {},
    });
    await commerce.releaseExpiredReservations();
    await assertPending(scope);
  });
  it.each(['unknown', 'succeeded'] as const)(
    'preserves a %s payment without interrupting other expiry work',
    async (status) => {
      const scope = await fixture();
      await database.db!.insert(payments).values({
        orderId: scope.order.id,
        provider: 'wechatpay',
        status,
        amount: 50000,
        currency: 'CNY',
        succeededAt: status === 'succeeded' ? new Date() : null,
      });
      const another = await fixture();
      await commerce.releaseExpiredReservations();
      await assertPending(scope);
      const [closed] = await database
        .db!.select()
        .from(orders)
        .where(eq(orders.id, another.order.id));
      expect(closed!.status).toBe('closed');
    },
  );
  it('rechecks the current payment deadline before closing an older reservation', async () => {
    const scope = await fixture();
    await database
      .db!.update(orders)
      .set({ expiresAt: new Date(Date.now() + 15 * 60_000) })
      .where(eq(orders.id, scope.order.id));
    await commerce.releaseExpiredReservations();
    await assertPending(scope);
  });
  it('expires all five review items and emits exactly five release events', async () => {
    const scope = await fixture(true);
    await commerce.releaseExpiredReservations();
    await commerce.releaseExpiredReservations();
    const items = await database
      .db!.select()
      .from(orderItems)
      .where(eq(orderItems.orderId, scope.order.id));
    expect(items).toHaveLength(5);
    expect(
      items.every((item) => item.state === 'cancelled' && item.inventoryReleasedAt !== null),
    ).toBe(true);
    const [count] = await database
      .db!.select({ count: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventId, scope.order.eventId),
          eq(outboxEvents.eventType, 'InventoryReservationExpired'),
        ),
      );
    expect(count!.count).toBe(5);
  });
});
