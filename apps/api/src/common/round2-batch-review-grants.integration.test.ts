import { randomUUID } from 'node:crypto';
import { AdminBatchOrdersController } from '../modules/batch-orders.module.js';
import { IdempotencyService } from './idempotency.service.js';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_EVENT, type CreateRegistrationBatch } from '@conference/contracts';
import {
  customerUsers,
  eventReleases,
  events,
  organizations,
  ticketTypes,
  users,
} from '@conference/database';
import { DatabaseService } from './database.service.js';
import { BatchRegistrationService } from './batch-registration.service.js';
import { OrderItemsService } from './order-items.service.js';
import { BatchOrderManagementService } from './batch-order-management.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { AdminRegistrationOperationsService } from './admin-registration-operations.service.js';
import { ConferenceRepository } from './conference.repository.js';
import { InvoiceOperationsService } from './invoice-operations.service.js';
import type { CustomerRegistrationActor } from './conference.repository.js';

const persistent = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;
persistent('round2 batch review grants real PostgreSQL regressions', () => {
  let admin: pg.Pool;
  let database: DatabaseService;
  let batch: BatchRegistrationService;
  let items: OrderItemsService;
  let management: BatchOrderManagementService;
  const name = `round2_batch_review_${randomUUID().replaceAll('-', '')}`;
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
    items = new OrderItemsService(database);
    batch = new BatchRegistrationService(database, items);
    management = new BatchOrderManagementService(items, new WeChatPayService(database));
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
        {
          key: 'attendance_goal',
          label: '原报名目标',
          type: 'text',
          required: false,
          enabled: true,
        },
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
        formAnswers: { attendance_goal: `第 ${index + 1} 位的参会目标` },
      })),
      formVersion: 1,
      termsVersion: 'batch-v1',
      termsAccepted: true,
      proxyAuthorizationAccepted: true,
      quoteFingerprint: quote.quoteFingerprint,
    };
  }

  const operations = () =>
    new AdminRegistrationOperationsService(
      database,
      new ConferenceRepository(database),
      {} as InvoiceOperationsService,
    );
  const operatorGrants = ['event.read', 'event.registration.read', 'event.registration.manage'];

  it('gives a registration operator all review answers without any commerce access', async () => {
    const scope = await fixture(39900, 100, true);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    const detail = await operations().detail(
      scope.eventId,
      checkout.items[2]!.registrationId,
      scope.organizationId,
      operatorGrants,
    );
    expect(detail.commerce).toEqual({ access: 'restricted' });
    expect(detail.invoice).toEqual({ access: 'restricted' });
    expect(detail.batchReview).toMatchObject({
      orderId: checkout.order.id,
      version: checkout.order.version,
      status: 'pending_review',
      quantity: 5,
    });
    expect(detail.batchReview!.items).toHaveLength(5);
    expect(detail.batchReview!.items[4]).toMatchObject({
      position: 5,
      registrationId: checkout.items[4]!.registrationId,
      formAnswers: { attendance_goal: '第 5 位的参会目标' },
    });
    expect(detail.batchReview!.items[4]!.fields).toContainEqual(
      expect.objectContaining({
        key: 'attendance_goal',
        label: '原报名目标',
      }),
    );
    const serialized = JSON.stringify(detail.batchReview);
    for (const forbidden of [
      'amount',
      'currency',
      'allocatedAmount',
      'refundedAmount',
      'invoiceId',
      'ticketCode',
      'orderAccessToken',
    ])
      expect(serialized).not.toContain(`"${forbidden}"`);
  });

  it('does not expose the other attendees to a registration reader without review permission', async () => {
    const scope = await fixture(39900, 100, true);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 2), randomUUID(), actor);
    const detail = await operations().detail(
      scope.eventId,
      checkout.items[0]!.registrationId,
      scope.organizationId,
      ['event.registration.read'],
    );
    expect(detail.batchReview ?? null).toBeNull();
    expect(detail.commerce).toEqual({ access: 'restricted' });
  });

  it('lets an operator approve the whole batch with the displayed version and returns no financial data', async () => {
    const scope = await fixture(39900, 100, true);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    const detail = await operations().detail(
      scope.eventId,
      checkout.items[0]!.registrationId,
      scope.organizationId,
      operatorGrants,
    );
    const [staff] = await database
      .db!.insert(users)
      .values({ name: '现场运营审核员', email: `${randomUUID()}@example.test` })
      .returning();
    const controller = new AdminBatchOrdersController(
      management,
      new IdempotencyService(database),
      items,
    );
    const request = {
      user: { sub: staff!.id, organizationId: scope.organizationId, grants: operatorGrants },
    } as Parameters<AdminBatchOrdersController['review']>[3];
    const result = await controller.review(
      scope.eventId,
      checkout.order.id,
      { expectedVersion: detail.batchReview!.version, decision: 'approve', reason: '' },
      request,
      randomUUID(),
    );
    expect(result).toEqual({ orderId: checkout.order.id, status: 'pending_payment', version: 2 });
    const saved = await items.detail(checkout.order.id, actor);
    expect(saved.items).toHaveLength(5);
    expect(saved.items.every((item) => item.registration.status === 'pending_payment')).toBe(true);
  });

  for (const cached of [false, true])
    it(`returns a minimal batch review result even from an older full checkout replay: cached=${cached}`, async () => {
      const scope = await fixture(39900, 100, true);
      const actor = await customer(scope.organizationId);
      const checkout = await batch.create(await input(scope, actor, 2), randomUUID(), actor);
      const idem = new IdempotencyService(database);
      const key = randomUUID();
      const requestInput = {
        expectedVersion: checkout.order.version!,
        decision: 'approve' as const,
        reason: '',
      };
      const response = {
        ...checkout,
        order: { ...checkout.order, status: 'pending_payment' as const, version: 2 },
      };
      if (cached)
        await idem.execute(
          `batch-order-review:${scope.organizationId}:${checkout.order.id}`,
          key,
          requestInput,
          async () => response,
        );
      const manager = { review: vi.fn().mockResolvedValue(response) };
      const controller = new AdminBatchOrdersController(
        manager as unknown as BatchOrderManagementService,
        idem,
        items,
      );
      const request = {
        user: { organizationId: scope.organizationId, sub: randomUUID(), grants: operatorGrants },
      } as Parameters<AdminBatchOrdersController['review']>[3];
      const actual = await controller.review(
        scope.eventId,
        checkout.order.id,
        requestInput,
        request,
        key,
      );
      expect(actual).toEqual({ orderId: checkout.order.id, status: 'pending_payment', version: 2 });
      expect(manager.review).toHaveBeenCalledTimes(cached ? 0 : 1);
    });
});
