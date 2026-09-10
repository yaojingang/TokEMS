import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_EVENT, type CreateRegistrationBatch } from '@conference/contracts';
import {
  customerProfiles,
  customerSessions,
  customerUsers,
  eventReleases,
  events,
  inventoryReservations,
  idempotencyKeys,
  orders,
  payments,
  organizations,
  registrations,
  ticketTypes,
  users,
} from '@conference/database';
import { DatabaseService } from './database.service.js';
import { BatchRegistrationService } from './batch-registration.service.js';
import { OrderItemsService } from './order-items.service.js';
import { BatchPaymentService } from './batch-payment.service.js';
import { BatchOrderManagementService } from './batch-order-management.service.js';
import { BatchClaimInvitationService } from './batch-claim-invitation.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { CustomerAuthService, CUSTOMER_SESSION_COOKIE } from './customer-auth.service.js';
import { CustomerAccountService } from './customer-account.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { HttpExceptionFilter } from './http-exception.filter.js';
import {
  AdminBatchOrdersController,
  CustomerBatchOrdersController,
} from '../modules/batch-orders.module.js';
import { RegistrationBatchesController } from '../modules/public.module.js';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { sha256 } from '@conference/security';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from './auth.guard.js';
import type { CustomerRegistrationActor } from './conference.repository.js';

const persistent = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;
persistent('batch adversarial recovery invariants', () => {
  let admin: pg.Pool;
  let app: NestFastifyApplication;
  let auth: CustomerAuthService;
  let database: DatabaseService;
  let batch: BatchRegistrationService;
  let items: OrderItemsService;
  let payment: BatchPaymentService;
  let management: BatchOrderManagementService;
  const name = `batch_adversarial_${randomUUID().replaceAll('-', '')}`;
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
    payment = new BatchPaymentService(items);
    management = new BatchOrderManagementService(items, new WeChatPayService(database));
    auth = new CustomerAuthService(database);
    const module = await Test.createTestingModule({
      controllers: [CustomerBatchOrdersController, RegistrationBatchesController],
      providers: [
        { provide: BatchRegistrationService, useValue: batch },
        { provide: OrderItemsService, useValue: items },
        { provide: BatchOrderManagementService, useValue: management },
        { provide: BatchClaimInvitationService, useValue: new BatchClaimInvitationService(items) },
        { provide: CustomerAccountService, useValue: new CustomerAccountService(database) },
        { provide: CustomerAuthService, useValue: auth },
        { provide: IdempotencyService, useValue: new IdempotencyService(database) },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.register(fastifyCookie);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120000);
  afterAll(async () => {
    await app?.close();
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

  async function login(actor: CustomerRegistrationActor) {
    const token = randomUUID();
    await database
      .db!.insert(customerProfiles)
      .values({ customerUserId: actor.customerUserId, realName: '购票人', company: '公司' })
      .onConflictDoNothing();
    await database.db!.insert(customerSessions).values({
      customerUserId: actor.customerUserId,
      organizationId: actor.organizationId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const headers = { 'x-organization-slug': `batch-${actor.organizationId}` };
    const session = await auth.requireSession({
      headers,
      cookies: { [CUSTOMER_SESSION_COOKIE]: token },
    } as unknown as FastifyRequest);
    return {
      headers: {
        ...headers,
        cookie: `${CUSTOMER_SESSION_COOKIE}=${token}`,
        'x-csrf-token': session.csrfToken,
      },
      session,
    };
  }
  it('requires CSRF and the purchaser before the real item PATCH mutates one attendee', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 3), randomUUID(), actor);
    const selected = checkout.items[1]!;
    const signedIn = await login(actor);
    const targetUrl = `/api/v1/customer/orders/${checkout.order.id}/items/${selected.id}/attendee`;
    const payload = { expectedVersion: selected.version, company: '更新后的公司' };
    const missing = { ...signedIn.headers };
    delete (missing as Partial<typeof missing>)['x-csrf-token'];
    for (const headers of [missing, { ...signedIn.headers, 'x-csrf-token': 'incorrect' }]) {
      const response = await app.inject({
        method: 'PATCH',
        url: targetUrl,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().details.reason).toBe('customer_csrf_invalid');
    }
    const stranger = await login(await customer(scope.organizationId));
    const forbidden = await app.inject({
      method: 'PATCH',
      url: targetUrl,
      headers: { ...stranger.headers, 'idempotency-key': randomUUID() },
      payload,
    });
    expect(forbidden.statusCode).toBe(404);
    const key = randomUUID();
    const response = await app.inject({
      method: 'PATCH',
      url: targetUrl,
      headers: { ...signedIn.headers, 'idempotency-key': key },
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    const detail = response.json();
    expect(detail.items[1].registration.attendee.company).toBe('更新后的公司');
    expect(detail.items[0].registration.attendee.company).toBe('公司');
    expect(detail.items[2].registration.attendee.company).toBe('公司');
    const replay = await app.inject({
      method: 'PATCH',
      url: targetUrl,
      headers: { ...signedIn.headers, 'idempotency-key': key },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().items[1].version).toBe(detail.items[1].version);
    const stale = await app.inject({
      method: 'PATCH',
      url: targetUrl,
      headers: { ...signedIn.headers, 'idempotency-key': randomUUID() },
      payload,
    });
    expect(stale.statusCode).toBe(409);
    const foreign = await fixture();
    const foreignActor = await login(await customer(foreign.organizationId));
    const crossTenant = await app.inject({
      method: 'PATCH',
      url: targetUrl,
      headers: { ...foreignActor.headers, 'idempotency-key': randomUUID() },
      payload,
    });
    expect(crossTenant.statusCode).toBe(404);
  });

  it('rejects missing terms, missing proxy consent, quantity mismatch and cross-event scope through the actual batch route', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const signedIn = await login(actor);
    const valid = await input(scope, actor, 2);
    for (const payload of [
      { ...valid, termsAccepted: false },
      { ...valid, proxyAuthorizationAccepted: false },
      { ...valid, quantity: 1 },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/registration-batches',
        headers: { ...signedIn.headers, 'idempotency-key': randomUUID() },
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(
      await database.db!.select().from(orders).where(eq(orders.eventId, scope.eventId)),
    ).toHaveLength(0);
    expect(
      await database
        .db!.select()
        .from(registrations)
        .where(eq(registrations.eventId, scope.eventId)),
    ).toHaveLength(0);
    const foreign = await fixture();
    const quote = await app.inject({
      method: 'POST',
      url: '/api/v1/registration-batches/quote',
      headers: signedIn.headers,
      payload: { eventId: foreign.eventId, ticketTypeId: foreign.ticketTypeId, quantity: 2 },
    });
    expect(quote.statusCode, quote.body).toBe(404);
    const success = await app.inject({
      method: 'POST',
      url: '/api/v1/registration-batches',
      headers: { ...signedIn.headers, 'idempotency-key': randomUUID() },
      payload: valid,
    });
    expect(success.statusCode, success.body).toBe(201);
    expect(success.json().items).toHaveLength(2);
    expect(success.json().order.amount).toBe(79800);
  });

  it('keeps self identity fixed while permitting a versioned pending self edit', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const signedIn = await login(actor);
    const checkout = await batch.create(await input(scope, actor, 2), randomUUID(), actor);
    const self = checkout.items[0]!;
    const targetUrl = `/api/v1/customer/orders/${checkout.order.id}/items/${self.id}/attendee`;
    const base = {
      expectedVersion: self.version,
      expectedRegistrationVersion: self.registrationEditVersion,
    };
    const rejected = await app.inject({
      method: 'PATCH',
      url: targetUrl,
      headers: { ...signedIn.headers, 'idempotency-key': randomUUID() },
      payload: { ...base, mobile: `+8613900${String(serial++).padStart(6, '0')}` },
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    const response = await app.inject({
      method: 'PATCH',
      url: targetUrl,
      headers: { ...signedIn.headers, 'idempotency-key': randomUUID() },
      payload: { ...base, company: '本人更新公司' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items[0].registration.attendee.company).toBe('本人更新公司');
    expect(response.json().items[0].registration.attendee.mobile).toBe(actor.mobile);
    expect(response.json().items[1].registration.attendee.company).toBe('公司');
  });

  it('rechecks purchaser ownership after a concurrent account deletion before generating an invitation', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 2), randomUUID(), actor);
    const { session } = await login(actor);
    const selected = checkout.items[1]!;
    let authorizeReached!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => {
      authorizeReached = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = items.requireOrder.bind(items);
    const authorization = vi
      .spyOn(items, 'requireOrder')
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        authorizeReached();
        await waiting;
        return result;
      });
    const creating = new BatchClaimInvitationService(items).generate(
      checkout.order.id,
      selected.id,
      { expectedVersion: selected.version, notify: false },
      randomUUID(),
      actor,
    );
    await reached;
    try {
      await new CustomerAccountService(database).adminDelete(
        scope.organizationId,
        randomUUID(),
        session.customer.id,
      );
    } finally {
      resume();
    }
    await expect(creating).rejects.toThrow();
    authorization.mockRestore();
  });

  it('erases expired invitation replay ciphertext while retaining the completed operation', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 2), randomUUID(), actor);
    const selected = checkout.items[1]!;
    const invitations = new BatchClaimInvitationService(items);
    const key = randomUUID();
    const request = { expectedVersion: selected.version, notify: false };
    const generated = await invitations.generate(
      checkout.order.id,
      selected.id,
      request,
      key,
      actor,
    );
    expect(generated.claimUrl).toBeTruthy();
    const [cached] = await database
      .db!.select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key));
    expect(cached!.responseBody.sealedToken).toBeTruthy();
    await database
      .db!.update(idempotencyKeys)
      .set({
        responseBody: {
          ...cached!.responseBody,
          replayUntil: new Date(Date.now() - 1000).toISOString(),
        },
      })
      .where(eq(idempotencyKeys.id, cached!.id));
    const expired = await invitations.generate(checkout.order.id, selected.id, request, key, actor);
    expect(expired).toMatchObject({
      claimUrl: null,
      replayAvailable: false,
      itemId: selected.id,
      version: generated.version,
    });
    const [summary] = await database
      .db!.select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.id, cached!.id));
    expect(summary!.responseBody).not.toHaveProperty('sealedToken');
    expect(summary!.responseBody.tokenId).toBe(cached!.responseBody.tokenId);
  });

  it('rejects replaying an admin review cache through a different event scope', async () => {
    const scope = await fixture(0, 100, true);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 2), randomUUID(), actor);
    const [source] = await database.db!.select().from(events).where(eq(events.id, scope.eventId));
    const [otherEvent] = await database
      .db!.insert(events)
      .values({ ...source!, id: undefined, slug: `other-${randomUUID()}` })
      .returning();
    const [staff] = await database
      .db!.insert(users)
      .values({ name: '审核管理员', email: `${randomUUID()}@example.test` })
      .returning();
    const controller = new AdminBatchOrdersController(
      management,
      new IdempotencyService(database),
      items,
    );
    const request = {
      user: { sub: staff!.id, organizationId: scope.organizationId },
    } as FastifyRequest & { user: AuthenticatedUser };
    const key = randomUUID();
    const body = { expectedVersion: checkout.order.version, decision: 'approve' };
    const reviewed = await controller.review(scope.eventId, checkout.order.id, body, request, key);
    expect(reviewed).toMatchObject({ orderId: checkout.order.id, status: 'paid' });
    expect(reviewed).not.toHaveProperty('items');
    expect((await items.detail(checkout.order.id, actor)).items).toHaveLength(2);
    await expect(
      controller.review(otherEvent!.id, checkout.order.id, body, request, key),
    ).rejects.toThrow();
  });

  it('retains inventory when verified payment commits before ticket issuance retries', async () => {
    const scope = await fixture(39900, 3);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 3), randomUUID(), actor);
    const createdAt = new Date(Date.now() - 30 * 60_000);
    const expiresAt = new Date(Date.now() - 15 * 60_000);
    await database
      .db!.update(orders)
      .set({ createdAt, expiresAt })
      .where(eq(orders.id, checkout.order.id));
    await database
      .db!.update(inventoryReservations)
      .set({ expiresAt })
      .where(eq(inventoryReservations.orderId, checkout.order.id));
    const [attempt] = await database
      .db!.insert(payments)
      .values({
        orderId: checkout.order.id,
        provider: 'wechatpay',
        outTradeNo: randomUUID().replaceAll('-', ''),
        status: 'pending',
        amount: checkout.order.amount,
        currency: 'CNY',
      })
      .returning();
    const confirmation = {
      provider: 'wechatpay',
      paymentId: attempt!.id,
      externalId: randomUUID(),
      occurredAt: new Date(createdAt.getTime() + 60_000).toISOString(),
      amount: checkout.order.amount,
      currency: 'CNY',
      payload: {},
      reason: 'verified recovery test',
    };
    const failure = vi
      .spyOn(items, 'issue')
      .mockRejectedValueOnce(new Error('temporary ticket persistence failure'));
    await expect(payment.confirm(checkout.order.id, confirmation)).rejects.toThrow('出票待重试');
    failure.mockRestore();
    const [cash] = await database.db!.select().from(payments).where(eq(payments.id, attempt!.id));
    expect(cash!.status).toBe('succeeded');
    const other = await customer(scope.organizationId);
    const quote = await batch.quote(
      { eventId: scope.eventId, ticketTypeId: scope.ticketTypeId, quantity: 3 },
      other,
    );
    expect(quote.availableQuantity).toBe(0);
    await expect(batch.create(await input(scope, other, 3), randomUUID(), other)).rejects.toThrow(
      '名额不足',
    );
    await payment.confirm(checkout.order.id, confirmation);
    expect(
      (await items.rows(database.db!, checkout.order.id)).every((row) => row.ticket !== null),
    ).toBe(true);
    expect(
      (
        await database.db!.select().from(ticketTypes).where(eq(ticketTypes.id, scope.ticketTypeId))
      )[0]!.sold,
    ).toBe(3);
  });
});
