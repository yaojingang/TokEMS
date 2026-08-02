import { createHash, randomUUID } from 'node:crypto';
import { DEMO_EVENT, DEMO_IDS } from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  orderAccessTokens,
  orders,
  organizations,
  organizationIntegrations,
  paymentNotificationInbox,
  payments,
  registrations,
} from '@conference/database';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { WeChatPayService } from './wechat-pay.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

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
