import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { DEMO_EVENT, DEMO_IDS } from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  events,
  ticketTypes,
  tickets,
  inventoryReservations,
  memberships,
  users,
  notificationDeliveries,
  outboxEvents,
  orderAccessTokens,
  orders,
  organizations,
  organizationIntegrations,
  paymentNotificationInbox,
  payments,
  refunds,
  registrations,
} from '@conference/database';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { __wechatPayTestUtils, WeChatPayService } from './wechat-pay.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;
const fixtureLock = process.env.DATABASE_URL
  ? new Client({ connectionString: process.env.DATABASE_URL })
  : undefined;
beforeAll(async () => {
  if (!fixtureLock) return;
  await fixtureLock.connect();
  await fixtureLock.query(
    "select pg_advisory_lock(hashtextextended('tokems:refund-integration-fixtures', 0))",
  );
}, 60_000);
afterAll(async () => {
  await fixtureLock?.end();
});

describePersistent('WeChat payment maintenance', () => {
  const database = new DatabaseService();
  const repository = {
    confirmPayment: vi.fn(),
  } as unknown as ConferenceRepository;
  const service = new WeChatPayService(database, undefined, repository);
  const organizationIds: string[] = [];
  const orderIds: string[] = [];
  const registrationIds: string[] = [];

  afterAll(async () => {
    for (const orderId of orderIds) {
      await database.db!.delete(orders).where(eq(orders.id, orderId));
    }
    for (const registrationId of registrationIds) {
      await database.db!.delete(registrations).where(eq(registrations.id, registrationId));
    }
    for (const organizationId of organizationIds) {
      await database.db!.delete(organizations).where(eq(organizations.id, organizationId));
    }
    await database.onModuleDestroy();
  });

  it('keeps the database active-attempt index aligned with the canonical state set', async () => {
    const result = await database.db!.execute(sql<{ indexdef: string }>`
      select indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'payments_active_attempt_unique'
    `);
    const indexDefinition = result.rows[0]?.indexdef ?? '';
    expect(indexDefinition).toContain('CREATE UNIQUE INDEX');
    for (const status of ACTIVE_WECHAT_PAYMENT_STATUSES) {
      expect(indexDefinition).toContain(`'${status}'`);
    }
  });

  it('reclaims a stale processing inbox lease while preserving a live lease', async () => {
    const [organization] = await database
      .db!.insert(organizations)
      .values({
        slug: `payment-maintenance-${randomUUID()}`,
        name: 'Payment maintenance test',
      })
      .returning({ id: organizations.id });
    organizationIds.push(organization!.id);

    const [stale] = await database
      .db!.insert(paymentNotificationInbox)
      .values({
        organizationId: organization!.id,
        notificationId: `stale-${randomUUID()}`,
        outTradeNo: 'STALEPAYMENT01',
        eventType: 'TRANSACTION.SUCCESS',
        status: 'processing',
        payload: { externalId: 'transaction-stale' },
        updatedAt: new Date(Date.now() - 120_000),
      })
      .returning({ id: paymentNotificationInbox.id });
    const [live] = await database
      .db!.insert(paymentNotificationInbox)
      .values({
        organizationId: organization!.id,
        notificationId: `live-${randomUUID()}`,
        outTradeNo: 'LIVEPAYMENT001',
        eventType: 'TRANSACTION.SUCCESS',
        status: 'processing',
        payload: { externalId: 'transaction-live' },
        updatedAt: new Date(),
      })
      .returning({ id: paymentNotificationInbox.id });

    await service.processPaymentNotificationAsync(stale!.id);
    await service.processPaymentNotificationAsync(live!.id);

    const [staleResult] = await database
      .db!.select()
      .from(paymentNotificationInbox)
      .where(eq(paymentNotificationInbox.id, stale!.id));
    const [liveResult] = await database
      .db!.select()
      .from(paymentNotificationInbox)
      .where(eq(paymentNotificationInbox.id, live!.id));

    expect(staleResult).toMatchObject({
      status: 'dead',
      attemptCount: 1,
      lastError: 'Missing orderId or externalId',
    });
    expect(liveResult).toMatchObject({ status: 'processing', attemptCount: 0 });
    expect(repository.confirmPayment).not.toHaveBeenCalled();
  });

  it('backs off failed notification inbox rows before consuming another attempt', async () => {
    const [organization] = await database
      .db!.insert(organizations)
      .values({
        slug: `payment-backoff-${randomUUID()}`,
        name: 'Payment backoff test',
      })
      .returning({ id: organizations.id });
    organizationIds.push(organization!.id);
    const [failed] = await database
      .db!.insert(paymentNotificationInbox)
      .values({
        organizationId: organization!.id,
        notificationId: `failed-${randomUUID()}`,
        outTradeNo: 'FAILEDRETRY001',
        eventType: 'TRANSACTION.SUCCESS',
        status: 'failed',
        attemptCount: 1,
        payload: { externalId: 'transaction-failed' },
        updatedAt: new Date(),
      })
      .returning();

    await service.processPaymentNotificationAsync(failed!.id);
    const [deferred] = await database
      .db!.select()
      .from(paymentNotificationInbox)
      .where(eq(paymentNotificationInbox.id, failed!.id));
    expect(deferred).toMatchObject({ status: 'failed', attemptCount: 1 });

    await database
      .db!.update(paymentNotificationInbox)
      .set({ updatedAt: new Date(Date.now() - 20_000) })
      .where(eq(paymentNotificationInbox.id, failed!.id));
    await service.processPaymentNotificationAsync(failed!.id);
    const [retried] = await database
      .db!.select()
      .from(paymentNotificationInbox)
      .where(eq(paymentNotificationInbox.id, failed!.id));
    expect(retried).toMatchObject({
      status: 'dead',
      attemptCount: 2,
      lastError: 'Missing orderId or externalId',
    });
  });

  it('marks an unchanged integration snapshot verified after a successful connection test', async () => {
    const [organization] = await database
      .db!.insert(organizations)
      .values({
        slug: `payment-config-verify-${randomUUID()}`,
        name: 'Payment config verification test',
      })
      .returning({ id: organizations.id });
    organizationIds.push(organization!.id);
    const [integration] = await database
      .db!.insert(organizationIntegrations)
      .values({
        organizationId: organization!.id,
        provider: 'wechatpay',
        status: 'configured',
        config: { revision: 1 },
      })
      .returning();
    const originalRequiredIntegration = Reflect.get(service, 'requiredIntegration');
    const originalRequest = Reflect.get(service, 'request');
    Reflect.set(service, 'requiredIntegration', async () => ({
      row: integration,
      config: {
        enabled: true,
        appId: 'wx-test-app',
        mchId: '1234567890',
        merchantCertificateSerial: 'MERCHANT_SERIAL',
        platformPublicKeyId: 'PLATFORM_SERIAL',
        oauthEnabled: false,
        channels: { native: true, jsapi: false, h5: false },
      },
      credentials: {
        merchantPrivateKey: 'unused',
        apiV3Key: '12345678901234567890123456789012',
        platformPublicKey: 'unused',
      },
    }));
    Reflect.set(
      service,
      'request',
      async (_method: string, _url: string, body: Record<string, unknown>) => ({
        echo_message: body.echo_message,
      }),
    );

    try {
      await expect(
        service.testConnection(organization!.id, DEMO_IDS.adminUser),
      ).resolves.toMatchObject({ ok: true, status: 'verified' });
      const [current] = await database
        .db!.select()
        .from(organizationIntegrations)
        .where(eq(organizationIntegrations.id, integration!.id));
      expect(current?.status).toBe('verified');
    } finally {
      Reflect.set(service, 'requiredIntegration', originalRequiredIntegration);
      Reflect.set(service, 'request', originalRequest);
    }
  });

  it('does not verify a newer integration revision with an older connection test', async () => {
    const [organization] = await database
      .db!.insert(organizations)
      .values({
        slug: `payment-config-race-${randomUUID()}`,
        name: 'Payment config race test',
      })
      .returning({ id: organizations.id });
    organizationIds.push(organization!.id);
    const [integration] = await database
      .db!.insert(organizationIntegrations)
      .values({
        organizationId: organization!.id,
        provider: 'wechatpay',
        status: 'configured',
        config: { revision: 1 },
      })
      .returning();

    let requestEcho = '';
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let releaseRequest!: () => void;
    const providerResponse = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const originalRequiredIntegration = Reflect.get(service, 'requiredIntegration');
    const originalRequest = Reflect.get(service, 'request');
    Reflect.set(service, 'requiredIntegration', async () => ({
      row: integration,
      config: {
        enabled: true,
        appId: 'wx-test-app',
        mchId: '1234567890',
        merchantCertificateSerial: 'MERCHANT_SERIAL',
        platformPublicKeyId: 'PLATFORM_SERIAL',
        oauthEnabled: false,
        channels: { native: true, jsapi: false, h5: false },
      },
      credentials: {
        merchantPrivateKey: 'unused',
        apiV3Key: '12345678901234567890123456789012',
        platformPublicKey: 'unused',
      },
    }));
    Reflect.set(
      service,
      'request',
      async (_method: string, _url: string, body: Record<string, unknown>) => {
        requestEcho = String(body.echo_message ?? '');
        markRequestStarted();
        await providerResponse;
        return { echo_message: requestEcho };
      },
    );

    try {
      const connectionTest = service.testConnection(organization!.id, DEMO_IDS.adminUser);
      await requestStarted;
      await database
        .db!.update(organizationIntegrations)
        .set({
          status: 'configured',
          config: { revision: 2 },
          updatedAt: new Date(integration!.updatedAt.getTime() + 1_000),
        })
        .where(eq(organizationIntegrations.id, integration!.id));
      releaseRequest();

      await expect(connectionTest).resolves.toMatchObject({
        ok: false,
        status: 'error',
        message: '验证期间支付配置已经变化，请重新测试最新配置',
      });
      const [current] = await database
        .db!.select()
        .from(organizationIntegrations)
        .where(eq(organizationIntegrations.id, integration!.id));
      expect(current).toMatchObject({ status: 'configured', config: { revision: 2 } });
    } finally {
      Reflect.set(service, 'requiredIntegration', originalRequiredIntegration);
      Reflect.set(service, 'request', originalRequest);
    }
  });

  it('does not let a stale provider query revive an attempt closed by channel switching', async () => {
    const suffix = randomUUID().replace(/-/gu, '').slice(0, 12).toUpperCase();
    const accessToken = randomUUID();
    const [registration] = await database
      .db!.insert(registrations)
      .values({
        organizationId: DEMO_EVENT.organizationId,
        eventId: DEMO_EVENT.id,
        ticketTypeId: DEMO_EVENT.tickets[0]!.id,
        registrationCode: `RACE-${suffix}`,
        status: 'pending_payment',
        attendee: {
          name: 'Payment race test',
          mobile: `+86139${suffix.replace(/\D/gu, '0').padEnd(8, '0').slice(0, 8)}`,
          email: `payment-race-${suffix.toLowerCase()}@example.com`,
          company: '',
          title: '',
          city: '',
        },
        attendeeMobileE164: `+86138${Date.now().toString().slice(-8)}`,
        attendeeEmailNormalized: `payment-race-${suffix.toLowerCase()}@example.com`,
      })
      .returning({ id: registrations.id });
    registrationIds.push(registration!.id);
    const [order] = await database
      .db!.insert(orders)
      .values({
        organizationId: DEMO_EVENT.organizationId,
        eventId: DEMO_EVENT.id,
        registrationId: registration!.id,
        orderNo: `RACE${suffix}`,
        status: 'pending_payment',
        amount: 39900,
        currency: 'CNY',
        pricingSnapshot: { source: 'payment-race-test' },
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: orders.id });
    orderIds.push(order!.id);
    await database.db!.insert(orderAccessTokens).values({
      orderId: order!.id,
      tokenHash: createHash('sha256').update(accessToken).digest('hex'),
      scopes: ['order:read'],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [attempt] = await database
      .db!.insert(payments)
      .values({
        orderId: order!.id,
        provider: 'wechatpay',
        channel: 'native',
        outTradeNo: `PAY${suffix}`,
        status: 'pending',
        amount: 39900,
        currency: 'CNY',
      })
      .returning({ id: payments.id });

    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let releaseRequest!: (value: Record<string, unknown>) => void;
    const providerResponse = new Promise<Record<string, unknown>>((resolve) => {
      releaseRequest = resolve;
    });
    const originalRequiredIntegration = Reflect.get(service, 'requiredIntegration');
    const originalRequest = Reflect.get(service, 'request');
    Reflect.set(service, 'requiredIntegration', async () => ({
      row: { status: 'verified' },
      config: {
        enabled: true,
        appId: 'wx-test-app',
        mchId: '1234567890',
        merchantCertificateSerial: 'MERCHANT_SERIAL',
        platformPublicKeyId: 'PLATFORM_SERIAL',
        oauthEnabled: false,
        channels: { native: true, jsapi: false, h5: false },
      },
      credentials: {
        merchantPrivateKey: 'unused',
        apiV3Key: '12345678901234567890123456789012',
        platformPublicKey: 'unused',
      },
    }));
    Reflect.set(service, 'request', async () => {
      markRequestStarted();
      return providerResponse;
    });

    try {
      const query = service.queryPayment(order!.id, accessToken, { force: true });
      await requestStarted;
      await database
        .db!.update(payments)
        .set({ status: 'closed', closedAt: new Date(), updatedAt: new Date() })
        .where(eq(payments.id, attempt!.id));
      releaseRequest({ trade_state: 'NOTPAY' });
      await query;

      const [result] = await database
        .db!.select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, attempt!.id));
      expect(result?.status).toBe('closed');
    } finally {
      Reflect.set(service, 'requiredIntegration', originalRequiredIntegration);
      Reflect.set(service, 'request', originalRequest);
    }
  });
});

describePersistent('payment recovery across deployments', () => {
  const database = new DatabaseService();
  const db = database.db!;
  const repository = new ConferenceRepository(database);
  const auditOrganizationIds: string[] = [];
  afterAll(async () => {
    for (const organizationId of auditOrganizationIds) {
      // Organizations own every synthetic fixture; remove dependent business records first.
      await db.execute(
        sql`delete from payment_notification_inbox where organization_id = ${organizationId}`,
      );
      await db.execute(
        sql`delete from tickets where event_id in (select id from events where organization_id = ${organizationId})`,
      );
      await db.execute(
        sql`delete from inventory_reservations where order_id in (select id from orders where organization_id = ${organizationId})`,
      );
      await db.execute(sql`delete from orders where organization_id = ${organizationId}`);
      await db.execute(sql`delete from registrations where organization_id = ${organizationId}`);
      await db.execute(sql`delete from outbox_events where organization_id = ${organizationId}`);
      await db.execute(sql`delete from audit_logs where organization_id = ${organizationId}`);
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
    await database.onModuleDestroy();
  });

  async function fixture(expired = false) {
    const id = randomUUID();
    const createdAt = new Date(Date.now() - 600000);
    const occurredAt = new Date(Date.now() - 540000).toISOString();
    const expiresAt = new Date(Date.now() + (expired ? -300000 : 1200000));
    const [org] = await db
      .insert(organizations)
      .values({ slug: id, name: 'Isolated payment audit' })
      .returning();
    if (!org) throw new Error('Missing synthetic org');
    auditOrganizationIds.push(org.id);
    const [event] = await db
      .insert(events)
      .values({
        organizationId: org.id,
        slug: id,
        name: 'Payment audit',
        shortName: 'Audit',
        tagline: 'Test',
        description: 'Test',
        status: 'registration_open',
        startsAt: new Date('2027-01-01'),
        endsAt: new Date('2027-01-02'),
        timezone: 'Asia/Shanghai',
        venue: 'Test',
        city: 'Test',
        address: 'Test',
      })
      .returning();
    if (!event) throw new Error('Missing synthetic event');
    const [type] = await db
      .insert(ticketTypes)
      .values({
        organizationId: org.id,
        eventId: event.id,
        code: 'TEST',
        name: 'Test',
        description: 'Test',
        price: 100,
        capacity: 10,
        sold: 0,
      })
      .returning();
    if (!type) throw new Error('Missing synthetic type');
    const [reg] = await db
      .insert(registrations)
      .values({
        organizationId: org.id,
        eventId: event.id,
        ticketTypeId: type.id,
        registrationCode: id,
        status: 'pending_payment',
        attendee: {
          name: 'Synthetic user',
          mobile: '13800000000',
          email: 'audit@example.test',
          company: 'Test',
          title: 'Test',
          city: 'Test',
        },
      })
      .returning();
    if (!reg) throw new Error('Missing synthetic reg');
    const [order] = await db
      .insert(orders)
      .values({
        organizationId: org.id,
        eventId: event.id,
        registrationId: reg.id,
        orderNo: id,
        status: 'pending_payment',
        amount: 100,
        currency: 'CNY',
        pricingSnapshot: {},
        createdAt,
        expiresAt,
      })
      .returning();
    if (!order) throw new Error('Missing synthetic order');
    const [payment] = await db
      .insert(payments)
      .values({
        orderId: order.id,
        provider: 'wechatpay',
        outTradeNo: id.replaceAll('-', ''),
        status: 'pending',
        merchantId: 'audit-merchant',
        amount: 100,
        currency: 'CNY',
        prepayExpiresAt: expiresAt,
      })
      .returning();
    if (!payment) throw new Error('Missing synthetic payment');
    await db.insert(inventoryReservations).values({
      eventId: event.id,
      ticketTypeId: type.id,
      orderId: order.id,
      quantity: 1,
      expiresAt,
    });
    const externalId = `transaction-${id}`;
    return { org, event, type, reg, order, payment, externalId, occurredAt };
  }
  async function inbox(
    f: Awaited<ReturnType<typeof fixture>>,
    status = 'received',
    updatedAt = new Date(),
  ) {
    const [row] = await db
      .insert(paymentNotificationInbox)
      .values({
        organizationId: f.org.id,
        notificationId: randomUUID(),
        outTradeNo: f.payment.outTradeNo!,
        paymentId: f.payment.id,
        orderId: f.order.id,
        eventType: 'TRANSACTION.SUCCESS',
        status,
        updatedAt,
        payload: {
          externalId: f.externalId,
          amount: 100,
          currency: 'CNY',
          occurredAt: f.occurredAt,
        },
      })
      .returning();
    if (!row) throw new Error('Missing synthetic inbox');
    return row;
  }
  async function state(f: Awaited<ReturnType<typeof fixture>>) {
    const [order] = await db.select().from(orders).where(eq(orders.id, f.order.id));
    const issued = await db.select().from(tickets).where(eq(tickets.registrationId, f.reg.id));
    const [payment] = await db.select().from(payments).where(eq(payments.id, f.payment.id));
    const [type] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, f.type.id));
    if (!order || !payment || !type) throw new Error('Missing synthetic payment state');
    return {
      order: order.status,
      payment: payment.status,
      tickets: issued.length,
      sold: type.sold,
    };
  }

  function mockProvider(service: WeChatPayService, f: Awaited<ReturnType<typeof fixture>>) {
    Reflect.set(service, 'requiredIntegration', async () => ({
      config: { appId: 'wx-audit', mchId: 'audit-merchant' },
      credentials: {},
    }));
    const request = vi.fn(async () => ({
      appid: 'wx-audit',
      mchid: 'audit-merchant',
      trade_state: 'SUCCESS',
      out_trade_no: f.payment.outTradeNo,
      transaction_id: f.externalId,
      success_time: f.occurredAt,
      amount: { total: 100, currency: 'CNY' },
    }));
    Reflect.set(service, 'request', request);
    return request;
  }
  async function maintain(service: WeChatPayService) {
    await Reflect.get(service, 'runPaymentMaintenance').call(service);
  }
  it('recovers a paid-at-provider unexpired order without a callback or customer refresh', async () => {
    const f = await fixture();
    const service = new WeChatPayService(database, undefined, repository);
    const query = mockProvider(service, f);
    await maintain(service);
    expect(query).toHaveBeenCalledTimes(1);
    expect(await state(f)).toEqual({ order: 'paid', payment: 'succeeded', tickets: 1, sold: 1 });
  });
  it('confirms a missed payment after its window expires using the actual payment time', async () => {
    const f = await fixture(true);
    const service = new WeChatPayService(database, undefined, repository);
    mockProvider(service, f);
    await maintain(service);
    expect(await state(f)).toEqual({ order: 'paid', payment: 'succeeded', tickets: 1, sold: 1 });
  });

  it('resumes a durably received notification with a new service instance', async () => {
    const f = await fixture();
    const row = await inbox(f);
    const restarted = new WeChatPayService(database, undefined, new ConferenceRepository(database));
    await restarted.processPaymentNotificationAsync(row.id);
    expect(await state(f)).toEqual({ order: 'paid', payment: 'succeeded', tickets: 1, sold: 1 });
  });

  it('reclaims an interrupted processing lease and tolerates duplicate concurrent callbacks', async () => {
    const f = await fixture();
    const row = await inbox(f, 'processing', new Date(Date.now() - 120000));
    const duplicate = await inbox(f);
    const restarted = new WeChatPayService(database, undefined, new ConferenceRepository(database));
    await Promise.all([
      restarted.processPaymentNotificationAsync(row.id),
      restarted.processPaymentNotificationAsync(duplicate.id),
    ]);
    expect(await state(f)).toEqual({ order: 'paid', payment: 'succeeded', tickets: 1, sold: 1 });
  });

  it('rolls back payment, order and inventory if ticket insertion fails, then recovers from the inbox', async () => {
    const f = await fixture();
    const row = await inbox(f);
    const service = new WeChatPayService(database, undefined, repository);
    const functionName = `audit_fail_${f.order.id.replaceAll('-', '')}`;
    await db.execute(
      sql.raw(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.registration_id = '${f.reg.id}'::uuid THEN RAISE EXCEPTION 'audit injected ticket failure'; END IF; RETURN NEW; END $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER ${functionName} BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      ),
    );
    try {
      await expect(service.processPaymentNotificationAsync(row.id)).rejects.toThrow();
      expect(await state(f)).toEqual({
        order: 'pending_payment',
        payment: 'pending',
        tickets: 0,
        sold: 0,
      });
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${functionName} ON tickets`));
      await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    }
    await db
      .update(paymentNotificationInbox)
      .set({ updatedAt: new Date(Date.now() - 20000) })
      .where(eq(paymentNotificationInbox.id, row.id));
    await service.processPaymentNotificationAsync(row.id);
    expect(await state(f)).toEqual({ order: 'paid', payment: 'succeeded', tickets: 1, sold: 1 });
  });

  it('coalesces concurrent background queries and keeps an unpaid order open', async () => {
    const f = await fixture();
    const first = new WeChatPayService(database, undefined, repository);
    const second = new WeChatPayService(database, undefined, repository);
    const query = mockProvider(first, f);
    mockProvider(second, f);
    query.mockResolvedValue({
      appid: 'wx-audit',
      mchid: 'audit-merchant',
      trade_state: 'NOTPAY',
      out_trade_no: f.payment.outTradeNo,
      transaction_id: '',
      success_time: f.occurredAt,
      amount: { total: 100, currency: 'CNY' },
    });
    Reflect.set(second, 'request', query);
    await Promise.all([maintain(first), maintain(second)]);
    await maintain(first);
    expect(query).toHaveBeenCalledTimes(1);
    expect(await state(f)).toEqual({
      order: 'pending_payment',
      payment: 'pending',
      tickets: 0,
      sold: 0,
    });
    await db.update(payments).set({ status: 'closed' }).where(eq(payments.id, f.payment.id));
  });

  it('recovers confirmed query evidence after fulfillment failed and the provider becomes unavailable', async () => {
    const f = await fixture();
    const service = new WeChatPayService(database, undefined, repository);
    const query = mockProvider(service, f);
    const confirmation = vi
      .spyOn(repository, 'confirmPayment')
      .mockRejectedValueOnce(new Error('simulated interrupted fulfillment'));
    await maintain(service);
    confirmation.mockRestore();
    const [saved] = await db
      .select()
      .from(paymentNotificationInbox)
      .where(eq(paymentNotificationInbox.orderId, f.order.id));
    expect(saved).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      payload: { source: 'transaction-query' },
    });
    await db
      .update(paymentNotificationInbox)
      .set({ updatedAt: new Date(Date.now() - 20000) })
      .where(eq(paymentNotificationInbox.id, saved!.id));
    query.mockRejectedValue(new Error('simulated provider outage'));
    const restarted = new WeChatPayService(database, undefined, new ConferenceRepository(database));
    Reflect.set(restarted, 'request', query);
    await maintain(restarted);
    expect(query).toHaveBeenCalledTimes(1);
    expect(await state(f)).toEqual({ order: 'paid', payment: 'succeeded', tickets: 1, sold: 1 });
  });

  it('queues one financial alert when durable confirmation retries are exhausted', async () => {
    const f = await fixture();
    const [admin] = await db
      .insert(users)
      .values({ email: `audit-${randomUUID()}@example.test`, name: 'Synthetic finance' })
      .returning();
    if (!admin) throw new Error('Missing synthetic finance user');
    await db
      .insert(memberships)
      .values({ organizationId: f.org.id, userId: admin.id, role: 'finance' });
    const row = await inbox(f, 'failed', new Date(Date.now() - 600000));
    await db
      .update(paymentNotificationInbox)
      .set({ attemptCount: 9 })
      .where(eq(paymentNotificationInbox.id, row.id));
    const failing = new ConferenceRepository(database);
    vi.spyOn(failing, 'confirmPayment').mockRejectedValue(
      new Error('simulated persistent fulfillment failure'),
    );
    const service = new WeChatPayService(database, undefined, failing);
    await expect(service.processPaymentNotificationAsync(row.id)).rejects.toThrow();
    await Promise.all([
      service.alertPaymentRecoveryFailures(),
      service.alertPaymentRecoveryFailures(),
    ]);
    const notifications = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.organizationId, f.org.id));
    const queued = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.organizationId, f.org.id));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      recipient: admin.email,
      subject: '支付成功后的出票需要核验',
    });
    expect(queued.filter((event) => event.eventType === 'NotificationRequested')).toHaveLength(1);
    // The test administrator is independent from customer fixtures.
    await db.delete(memberships).where(eq(memberships.userId, admin.id));
    await db.delete(users).where(eq(users.id, admin.id));
  });
  it.each(['success', 'failure'])(
    'preserves a reconciled payment after a late prepare response (%s)',
    async (outcome) => {
      const f = await fixture();
      const accessToken = randomUUID();
      await db.insert(orderAccessTokens).values({
        orderId: f.order.id,
        tokenHash: createHash('sha256').update(accessToken).digest('hex'),
        scopes: ['order:read'],
        expiresAt: f.order.expiresAt,
      });
      const [attempt] = await db
        .update(payments)
        .set({ status: 'unknown', payload: { codeUrl: 'weixin://previous-qr' } })
        .where(eq(payments.id, f.payment.id))
        .returning();
      const recovering = new WeChatPayService(database, undefined, repository);
      const provider = mockProvider(recovering, f);
      const success = await provider();
      let startQuery!: () => void;
      const querying = new Promise<void>((resolve) => {
        startQuery = resolve;
      });
      let releaseQuery!: () => void;
      const queryResponse = new Promise<void>((resolve) => {
        releaseQuery = resolve;
      });
      Reflect.set(recovering, 'request', async () => {
        startQuery();
        await queryResponse;
        return success;
      });
      const recovery = Reflect.get(recovering, 'queryPaymentAttempt').call(
        recovering,
        f.order,
        attempt,
      );
      await querying;
      const preparing = new WeChatPayService(database, undefined, repository);
      Reflect.set(preparing, 'requiredIntegration', async () => ({
        row: { keyVersion: 1 },
        config: {
          appId: 'wx-audit',
          mchId: 'audit-merchant',
          channels: { native: true, jsapi: false, h5: false },
        },
        credentials: {},
      }));
      let startPrepare!: () => void;
      const preparingStarted = new Promise<void>((resolve) => {
        startPrepare = resolve;
      });
      let releasePrepare!: () => void;
      const prepareResponse = new Promise<void>((resolve) => {
        releasePrepare = resolve;
      });
      Reflect.set(preparing, 'request', async () => {
        startPrepare();
        await prepareResponse;
        if (outcome === 'failure')
          throw new __wechatPayTestUtils.PaymentGatewayError('ORDER_PAID', true, 400, 'ORDER_PAID');
        return { code_url: 'weixin://late-qr' };
      });
      const prepared = preparing
        .prepareNativePayment(f.order.id, accessToken)
        .catch((error) => error);
      try {
        await preparingStarted;
        releaseQuery();
        const payment = await recovery;
        expect(payment).toBeDefined();
        await Reflect.get(recovering, 'confirmQueriedPayment').call(recovering, f.order, payment);
        expect((await state(f)).payment).toBe('succeeded');
      } finally {
        releaseQuery();
        releasePrepare();
      }
      await prepared;
      expect(await state(f)).toEqual({ order: 'paid', payment: 'succeeded', tickets: 1, sold: 1 });
    },
  );

  it('keeps an ambiguous prepare response eligible for a later verified query', async () => {
    const f = await fixture();
    const service = new WeChatPayService(database, undefined, repository);
    const accessToken = randomUUID();
    await db.insert(orderAccessTokens).values({
      orderId: f.order.id,
      tokenHash: createHash('sha256').update(accessToken).digest('hex'),
      scopes: ['order:read'],
      expiresAt: f.order.expiresAt,
    });
    Reflect.set(service, 'requiredIntegration', async () => ({
      row: { keyVersion: 1 },
      config: {
        appId: 'wx-audit',
        mchId: 'audit-merchant',
        channels: { native: true, jsapi: false, h5: false },
      },
      credentials: {},
    }));
    Reflect.set(service, 'request', async () => {
      throw new __wechatPayTestUtils.PaymentGatewayError('ORDER_PAID', true, 400, 'ORDER_PAID');
    });
    await expect(service.prepareNativePayment(f.order.id, accessToken)).rejects.toThrow(
      'ORDER_PAID',
    );
    expect((await state(f)).payment).toBe('unknown');
    mockProvider(service, f);
    await maintain(service);
    expect(await state(f)).toEqual({ order: 'paid', payment: 'succeeded', tickets: 1, sold: 1 });
  });

  it('reconciles existing payments when accepting new payments is disabled', async () => {
    const f = await fixture();
    const service = new WeChatPayService(database, undefined, repository);
    const integration = Reflect.get(service, 'requiredIntegration');
    mockProvider(service, f);
    Reflect.set(service, 'requiredIntegration', integration);
    Reflect.set(service, 'integration', async () => ({
      status: 'verified',
      config: {
        enabled: false,
        appId: 'wx-audit',
        mchId: 'audit-merchant',
      },
      encryptedCredentials: 'test',
    }));
    Reflect.set(service, 'credentials', () => ({}));
    await expect(integration.call(service, f.org.id, { requireVerified: true })).rejects.toThrow();
    await expect(
      integration.call(service, f.org.id, {
        reconcileExisting: true,
        merchantId: 'wrong-merchant',
      }),
    ).rejects.toThrow();
    await maintain(service);
    expect(await state(f)).toEqual({ order: 'paid', payment: 'succeeded', tickets: 1, sold: 1 });
  });

  it('does not replace a closing lease refreshed after background candidate selection', async () => {
    const f = await fixture();
    const service = new WeChatPayService(database, undefined, repository);
    const query = mockProvider(service, f);
    const [stale] = await db
      .update(payments)
      .set({ status: 'close_pending', updatedAt: new Date(Date.now() - 120000) })
      .where(eq(payments.id, f.payment.id))
      .returning();
    const freshTime = new Date();
    await db.update(payments).set({ updatedAt: freshTime }).where(eq(payments.id, f.payment.id));
    await Reflect.get(service, 'queryPaymentAttempt').call(service, f.order, stale);
    expect(query).not.toHaveBeenCalled();
    const [live] = await db.select().from(payments).where(eq(payments.id, f.payment.id));
    expect(live?.updatedAt).toEqual(freshTime);
    await db.update(payments).set({ status: 'closed' }).where(eq(payments.id, f.payment.id));
  });

  it('ends an expired orphan attempt only with signed absence under its original merchant', async () => {
    const f = await fixture(true);
    const service = new WeChatPayService(database, undefined, repository);
    mockProvider(service, f);
    const absent = new __wechatPayTestUtils.PaymentGatewayError(
      'ORDER_NOT_EXIST',
      true,
      404,
      'order absent',
    );
    Reflect.set(
      service,
      'request',
      vi.fn(async () => {
        throw absent;
      }),
    );
    await db
      .update(payments)
      .set({ status: 'preparing', updatedAt: new Date(Date.now() - 120000) })
      .where(eq(payments.id, f.payment.id));
    await maintain(service);
    expect(await state(f)).toEqual({
      order: 'pending_payment',
      payment: 'closed',
      tickets: 0,
      sold: 0,
    });
    const audit = await db.execute(
      sql`select id from audit_logs where organization_id = ${f.org.id} and action = 'payment.absent-after-expiry'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('keeps unsigned absence, unknown merchant and a live prepare lease unsettled', async () => {
    const f = await fixture(true);
    const service = new WeChatPayService(database, undefined, repository);
    mockProvider(service, f);
    const request = vi.fn(async () => {
      throw new __wechatPayTestUtils.PaymentGatewayError('ORDER_NOT_EXIST', false, 404, 'absent');
    });
    Reflect.set(service, 'request', request);
    await maintain(service);
    expect((await state(f)).payment).toBe('unknown');
    request.mockImplementation(async () => {
      throw new __wechatPayTestUtils.PaymentGatewayError('ORDER_NOT_EXIST', true, 404, 'absent');
    });
    await db.update(payments).set({ merchantId: null }).where(eq(payments.id, f.payment.id));
    await maintain(service);
    expect((await state(f)).payment).toBe('unknown');
    await db
      .update(payments)
      .set({ status: 'preparing', updatedAt: new Date(), merchantId: 'audit-merchant' })
      .where(eq(payments.id, f.payment.id));
    request.mockClear();
    await maintain(service);
    expect(request).not.toHaveBeenCalled();
    expect((await state(f)).payment).toBe('preparing');
    await db.update(payments).set({ status: 'closed' }).where(eq(payments.id, f.payment.id));
  });

  it('rejects a queried success with a mismatched amount before changing fulfillment state', async () => {
    const f = await fixture(true);
    const service = new WeChatPayService(database, undefined, repository);
    const query = mockProvider(service, f);
    const response = await query();
    query.mockResolvedValue({ ...response, amount: { total: 101, currency: 'CNY' } });
    await maintain(service);
    expect(await state(f)).toEqual({
      order: 'pending_payment',
      payment: 'close_pending',
      tickets: 0,
      sold: 0,
    });
    expect(
      await db
        .select()
        .from(paymentNotificationInbox)
        .where(eq(paymentNotificationInbox.orderId, f.order.id)),
    ).toHaveLength(0);
    await db.update(payments).set({ status: 'closed' }).where(eq(payments.id, f.payment.id));
  });

  it('allows the first release when a historical dead notification already has matching paid tickets', async () => {
    const f = await fixture();
    const source = readFileSync(
      new URL('../../../../tooling/production-deploy.sh', import.meta.url),
      'utf8',
    );
    const query = source
      .slice(source.indexOf('read_payment_activity() {'))
      .match(/begin read only;\n([\s\S]*?)\ncommit;/)?.[1];
    if (!query) throw new Error('Missing actual deployment SQL');
    // Run the unchanged deployment SQL against this organization's real fixture rows.
    // Temporary tables prevent other concurrently running suites from changing the evidence.
    const readCounts = () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local search_path = pg_temp, public`);
        await tx.execute(
          sql`create temporary table orders on commit drop as select * from public.orders where organization_id = ${f.org.id}`,
        );
        await tx.execute(
          sql`create temporary table payments on commit drop as select * from public.payments where order_id = ${f.order.id}`,
        );
        await tx.execute(
          sql`create temporary table tickets on commit drop as select * from public.tickets where registration_id = ${f.reg.id}`,
        );
        await tx.execute(
          sql`create temporary table refunds on commit drop as select * from public.refunds where organization_id = ${f.org.id}`,
        );
        await tx.execute(
          sql`create temporary table payment_notification_inbox on commit drop as select * from public.payment_notification_inbox where organization_id = ${f.org.id}`,
        );
        return (await tx.execute(sql.raw(query))).rows[0];
      });
    const baseline = {
      active_attempts: '0',
      unsettled_notifications: '0',
      paid_without_tickets: '0',
    };
    expect(await readCounts()).toEqual({ ...baseline, active_attempts: '1' });
    const service = new WeChatPayService(database, undefined, repository);
    mockProvider(service, f);
    const historical = await inbox(f, 'dead');
    // The old API confirms directly, leaving the exhausted notification behind.
    await repository.confirmPayment(f.order.id, randomUUID(), {
      provider: 'wechatpay',
      externalId: f.externalId,
      amount: 100,
      currency: 'CNY',
      payload: {},
      reason: 'Synthetic historical recovery',
      paymentId: f.payment.id,
      outTradeNo: f.payment.outTradeNo!,
      occurredAt: f.occurredAt,
    });
    const counts = await readCounts();
    expect(counts).toEqual(baseline);
    const mismatch = await inbox(f, 'dead');
    await db
      .update(paymentNotificationInbox)
      .set({ payload: { ...mismatch.payload, externalId: 'wrong-transaction' } })
      .where(eq(paymentNotificationInbox.id, mismatch.id));
    expect(Number((await readCounts())?.unsettled_notifications)).toBe(
      Number(baseline?.unsettled_notifications) + 1,
    );
    await db.delete(paymentNotificationInbox).where(eq(paymentNotificationInbox.id, mismatch.id));
    await service.reconcilePaymentNotificationInbox();
    const [settled] = await db
      .select()
      .from(paymentNotificationInbox)
      .where(eq(paymentNotificationInbox.id, historical.id));
    expect(settled?.status).toBe('processed');
    await db
      .update(paymentNotificationInbox)
      .set({ status: 'dead' })
      .where(eq(paymentNotificationInbox.id, historical.id));
    await db.update(orders).set({ status: 'partially_refunded' }).where(eq(orders.id, f.order.id));
    const [refund] = await db
      .insert(refunds)
      .values({
        organizationId: f.org.id,
        eventId: f.event.id,
        orderId: f.order.id,
        paymentId: f.payment.id,
        refundNo: randomUUID(),
        amount: 50,
        currency: 'CNY',
        status: 'processing',
        reason: 'Synthetic refund',
        idempotencyKey: randomUUID(),
      })
      .returning();
    if (!refund) throw new Error('Missing synthetic refund');
    expect(Number((await readCounts())?.unsettled_notifications)).toBe(
      Number(baseline?.unsettled_notifications) + 1,
    );
    await service.reconcilePaymentNotificationInbox();
    expect(
      (
        await db
          .select()
          .from(paymentNotificationInbox)
          .where(eq(paymentNotificationInbox.id, historical.id))
      )[0]?.status,
    ).toBe('dead');
    await db.update(refunds).set({ status: 'succeeded' }).where(eq(refunds.id, refund.id));
    expect(await readCounts()).toEqual(baseline);
    await service.reconcilePaymentNotificationInbox();
    expect(
      (
        await db
          .select()
          .from(paymentNotificationInbox)
          .where(eq(paymentNotificationInbox.id, historical.id))
      )[0]?.status,
    ).toBe('processed');
    await db
      .update(paymentNotificationInbox)
      .set({ status: 'dead' })
      .where(eq(paymentNotificationInbox.id, historical.id));
    await db.update(orders).set({ status: 'refunded' }).where(eq(orders.id, f.order.id));
    await db.update(payments).set({ status: 'refunded' }).where(eq(payments.id, f.payment.id));
    await db.update(refunds).set({ amount: 100, currency: 'USD' }).where(eq(refunds.id, refund.id));
    expect(Number((await readCounts())?.unsettled_notifications)).toBe(
      Number(baseline?.unsettled_notifications) + 1,
    );
    await db.update(refunds).set({ currency: 'CNY' }).where(eq(refunds.id, refund.id));
    expect(await readCounts()).toEqual(baseline);
    await service.reconcilePaymentNotificationInbox();
    expect(
      (
        await db
          .select()
          .from(paymentNotificationInbox)
          .where(eq(paymentNotificationInbox.id, historical.id))
      )[0]?.status,
    ).toBe('processed');
  });
});
