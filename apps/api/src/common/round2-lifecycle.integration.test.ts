import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_EVENT, type CreateRegistrationBatch } from '@conference/contracts';
import {
  paymentNotificationInbox,
  customerUsers,
  eventReleases,
  events,
  inventoryReservations,
  orders,
  payments,
  organizations,
  ticketTypes,
} from '@conference/database';
import { DatabaseService } from './database.service.js';
import { BatchRegistrationService } from './batch-registration.service.js';
import { OrderItemsService } from './order-items.service.js';
import type { CustomerRegistrationActor } from './conference.repository.js';

const persistent = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;
persistent('round2 lifecycle quota preservation', () => {
  let admin: pg.Pool;
  let database: DatabaseService;
  let batch: BatchRegistrationService;
  const name = `batch_round2_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const savedDatabaseUrl = process.env.DATABASE_URL;
  let serial = 100;
  beforeAll(async () => {
    const url = new URL(process.env.BATCH_TEST_DATABASE_URL!);
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`create database "${name}"`);
    url.pathname = `/${name}`;
    const connection = new pg.Pool({ connectionString: url.toString() });
    try {
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL('../../../../packages/database/drizzle', import.meta.url),
        ),
      });
      for (const migration of migrations.slice(0, 66)) {
        const client = await connection.connect();
        try {
          await client.query('begin');
          for (const statement of migration.sql) await client.query(statement);
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        } finally {
          client.release();
        }
      }
    } finally {
      await connection.end();
    }
    process.env.DATABASE_URL = url.toString();
    database = new DatabaseService();
    const items = new OrderItemsService(database);
    batch = new BatchRegistrationService(database, items);
  }, 120000);
  afterAll(async () => {
    await database?.onModuleDestroy();
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (admin) {
      await admin.query(`drop database if exists "${name}"`);
      await admin.end();
    }
  });

  async function fixture(price = 39900, capacity = 100, manualReview = false, max = 20) {
    const db = database.db!;
    const organizationId = randomUUID();
    await db
      .insert(organizations)
      .values({ id: organizationId, slug: `batch-${organizationId}`, name: '多人购票测试' });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `batch-${organizationId}`,
        name: '测试大会',
        shortName: '测试',
        tagline: '测试',
        description: '测试',
        status: 'registration_open',
        startsAt: new Date('2027-01-01'),
        endsAt: new Date('2027-01-02'),
        timezone: 'Asia/Shanghai',
        venue: '测试',
        city: '测试',
        address: '测试',
        settings: { refundPolicy: { enabled: true, version: 'seven-day-v1', windowDays: 7 } },
      })
      .returning();
    const [ticket] = await db
      .insert(ticketTypes)
      .values({
        organizationId,
        eventId: event!.id,
        code: 'GENERAL',
        name: '大会通票',
        description: '',
        price,
        capacity,
      })
      .returning();
    const form = {
      id: randomUUID(),
      eventId: event!.id,
      name: '报名表',
      version: 1,
      termsVersion: 'batch-v1',
      termsContent: '参会报名条款',
      fields: [
        { key: 'name', label: '姓名', type: 'text', required: true, enabled: true },
        { key: 'mobile', label: '手机号', type: 'tel', required: true, enabled: true },
        { key: 'company', label: '公司', type: 'text', required: true, enabled: true },
      ],
    };
    const snapshot = {
      event: {
        settings: {
          registration: {
            ...DEMO_EVENT.registration,
            paymentMode: price === 0 ? 'free' : 'ticketed',
            additionalPurchaseEnabled: true,
            maxActiveSeatsPerPurchaser: max,
          },
        },
      },
      tickets: [{ ...DEMO_EVENT.tickets[0], id: ticket!.id, price, capacity, name: '大会通票' }],
      registrationForm: form,
      experience: { registrationFlow: { branches: { manualReview } } },
    };
    const [release] = await db
      .insert(eventReleases)
      .values({
        eventId: event!.id,
        version: 1,
        templateKey: 'test',
        artifactKey: 'test',
        snapshot,
      })
      .returning();
    await db
      .update(events)
      .set({ settings: { ...event!.settings, currentReleaseId: release!.id } })
      .where(eq(events.id, event!.id));
    return {
      organizationId,
      eventId: event!.id,
      ticketTypeId: ticket!.id,
      releaseId: release!.id,
      snapshot,
    };
  }
  async function customer(organizationId: string): Promise<CustomerRegistrationActor> {
    const mobile = `+8613800${String(serial++).padStart(6, '0')}`;
    const [user] = await database
      .db!.insert(customerUsers)
      .values({ organizationId, mobileE164: mobile })
      .returning();
    return {
      organizationId,
      customerUserId: user!.id,
      mobile,
      profile: {
        nickname: null,
        realName: '购票人',
        email: null,
        company: '公司',
        title: null,
        city: null,
      },
    };
  }
  async function input(
    scope: Awaited<ReturnType<typeof fixture>>,
    actor: CustomerRegistrationActor,
    quantity: number,
    self = true,
  ): Promise<CreateRegistrationBatch> {
    const quote = await batch.quote(
      { eventId: scope.eventId, ticketTypeId: scope.ticketTypeId, quantity },
      actor,
    );
    return {
      eventId: scope.eventId,
      ticketTypeId: scope.ticketTypeId,
      quantity,
      purchaseIntentId: randomUUID(),
      attendees: Array.from({ length: quantity }, (_, index) => ({
        clientId: randomUUID(),
        isSelf: self && index === 0,
        attendee: {
          name: `参会人 ${index + 1}`,
          mobile:
            self && index === 0 ? actor.mobile : `+8613900${String(serial++).padStart(6, '0')}`,
          email: '',
          company: '公司',
          title: '',
          city: '',
        },
        marketingConsent: false,
      })),
      formVersion: 1,
      termsVersion: 'batch-v1',
      termsAccepted: true,
      proxyAuthorizationAccepted: true,
      quoteFingerprint: quote.quoteFingerprint,
    };
  }

  async function expiredPending(kind: 'notice' | 'success' | 'financial_hold' | 'none') {
    const scope = await fixture(39900, 100, false, 5);
    const actor = await customer(scope.organizationId);
    const old = await batch.create(await input(scope, actor, 5, false), randomUUID(), actor);
    const createdAt = new Date(Date.now() - 20 * 60_000);
    const expiresAt = new Date(Date.now() - 5 * 60_000);
    await database
      .db!.update(orders)
      .set({
        createdAt,
        expiresAt,
        ...(kind === 'financial_hold' ? { refundExecutionMode: 'external_hold' as const } : {}),
      })
      .where(eq(orders.id, old.order.id));
    await database
      .db!.update(inventoryReservations)
      .set({ expiresAt })
      .where(eq(inventoryReservations.orderId, old.order.id));
    if (kind === 'success')
      await database.db!.insert(payments).values({
        orderId: old.order.id,
        provider: 'wechatpay',
        status: 'succeeded',
        amount: old.order.amount,
        currency: 'CNY',
        succeededAt: new Date(createdAt.getTime() + 60_000),
        externalId: randomUUID(),
      });
    if (kind === 'notice')
      await database.db!.insert(paymentNotificationInbox).values({
        organizationId: scope.organizationId,
        orderId: old.order.id,
        notificationId: randomUUID(),
        outTradeNo: old.order.orderNo,
        eventType: 'TRANSACTION.SUCCESS',
        status: 'received',
        payload: {
          amount: old.order.amount,
          currency: 'CNY',
          occurredAt: new Date(createdAt.getTime() + 60_000).toISOString(),
        },
      });
    return { scope, actor, old };
  }

  it.each(['notice', 'success', 'financial_hold'] as const)(
    'keeps expired pending seats and the resumable order while %s evidence protects them',
    async (kind) => {
      const { scope, actor, old } = await expiredPending(kind);
      const quote = await batch.quote(
        { eventId: scope.eventId, ticketTypeId: scope.ticketTypeId, quantity: 1 },
        actor,
      );
      expect(quote.activeSeatCount).toBe(5);
      expect(quote.pendingOrderId).toBe(old.order.id);
      expect(quote.remainingSeatCount).toBe(0);
      expect(quote.blockedReason).toBeTruthy();
    },
  );

  it.each(['notice', 'success', 'financial_hold'] as const)(
    'rejects a new purchase while expired pending seats have %s evidence',
    async (kind) => {
      const { scope, actor } = await expiredPending(kind);
      await expect(
        batch.create(await input(scope, actor, 1, false), randomUUID(), actor),
      ).rejects.toThrow();
    },
  );

  it('releases buyer quota for expired pending orders with no unresolved evidence', async () => {
    const { scope, actor } = await expiredPending('none');
    const quote = await batch.quote(
      { eventId: scope.eventId, ticketTypeId: scope.ticketTypeId, quantity: 1 },
      actor,
    );
    expect(quote.activeSeatCount).toBe(0);
    expect(quote.pendingOrderId).toBeNull();
    expect(quote.remainingSeatCount).toBe(5);
    const created = await batch.create(await input(scope, actor, 1, false), randomUUID(), actor);
    expect(created.order.quantity).toBe(1);
  });
});
