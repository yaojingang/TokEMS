import { Client } from 'pg';
import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  customerUsers,
  events,
  orders,
  organizations,
  organizationIntegrations,
  payments,
  refundNotificationInbox,
  refundRequests,
  refunds,
  registrations,
  tickets,
  ticketTypes,
  users,
} from '@conference/database';
import type { UpdateWeChatPayConfiguration } from '@conference/contracts';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { RefundWorkflowService } from './refund-workflow.service.js';
import { encryptIntegrationCredentials } from './integration-credentials.js';
import { lockWeChatConfiguration } from './wechat-configuration-lock.js';

const persistent = process.env.DATABASE_URL ? describe : describe.skip;

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

persistent('WeChat configuration changes and refund creation serialize in PostgreSQL', () => {
  // The scheduler scans every tenant; keep other suites' fixtures outside its run.
  const fixtureLock = new Client({ connectionString: process.env.DATABASE_URL });
  const database = new DatabaseService();
  const db = database.db!;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const merchantPrivateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const platformPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const owners: Array<{ organizationId: string; actorId: string; eventId: number }> = [];

  beforeAll(async () => {
    await fixtureLock.connect();
    await fixtureLock.query(
      "select pg_advisory_lock(hashtextextended('tokems:refund-integration-fixtures', 0))",
    );
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY_VERSION', '1');
  }, 60_000);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    try {
      for (const owner of owners) {
        await db
          .update(tickets)
          .set({ refundPausedBy: null })
          .where(eq(tickets.eventId, owner.eventId));
        await db
          .delete(refundNotificationInbox)
          .where(eq(refundNotificationInbox.organizationId, owner.organizationId));
        await db.delete(refunds).where(eq(refunds.organizationId, owner.organizationId));
        await db
          .delete(refundRequests)
          .where(eq(refundRequests.organizationId, owner.organizationId));
        await db.delete(organizations).where(eq(organizations.id, owner.organizationId));
        await db.delete(users).where(eq(users.id, owner.actorId));
      }
      vi.unstubAllEnvs();
    } finally {
      await fixtureLock.end();
      await database.onModuleDestroy();
    }
  });

  async function fixture() {
    const organizationId = randomUUID(),
      actorId = randomUUID(),
      customerUserId = randomUUID();
    const orderId = randomUUID(),
      registrationId = randomUUID(),
      ticketTypeId = randomUUID();
    const apiV3Key = randomBytes(16).toString('hex');
    const config: UpdateWeChatPayConfiguration = {
      enabled: true,
      appId: 'wx-refund-race',
      mchId: '1900000109',
      merchantCertificateSerial: 'TEST_SERIAL',
      platformPublicKeyId: 'PUB_KEY_ID_REFUND_RACE',
      refundFunding: 'default',
      oauthEnabled: false,
      channels: { native: true, jsapi: false, h5: false },
    };
    const policy = { enabled: true, version: 'seven-day-v1', windowDays: 7 as const };
    await db.insert(organizations).values({
      id: organizationId,
      slug: `refund-race-${organizationId}`,
      name: '退款配置并发验收',
    });
    await db
      .insert(users)
      .values({ id: actorId, email: `${actorId}@example.test`, name: '并发验收' });
    await db
      .insert(customerUsers)
      .values({ id: customerUserId, organizationId, mobileE164: '+8613900000042' });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `refund-race-${organizationId}`,
        name: '退款配置验收',
        shortName: '验收',
        tagline: '验收',
        description: '验收',
        status: 'registration_open',
        startsAt: new Date('2027-11-01T01:00:00Z'),
        endsAt: new Date('2027-11-01T10:00:00Z'),
        timezone: 'Asia/Shanghai',
        venue: '测试',
        city: '深圳',
        address: '测试',
        settings: { refunds: policy },
      })
      .returning();
    const eventId = event!.id;
    owners.push({ organizationId, actorId, eventId });
    await db.insert(ticketTypes).values({
      id: ticketTypeId,
      organizationId,
      eventId,
      code: 'RACE',
      name: '测试票',
      description: '测试',
      price: 39900,
      capacity: 10,
      sold: 1,
    });
    await db.insert(registrations).values({
      id: registrationId,
      organizationId,
      eventId,
      ticketTypeId,
      registrationCode: `R${randomUUID().slice(0, 24)}`,
      status: 'confirmed',
      attendee: {
        name: '测试',
        mobile: '13900000042',
        email: 'race@example.test',
        company: '测试',
        title: '测试',
        city: '深圳',
      },
      attendeeMobileE164: '+8613900000042',
    });
    await db.insert(orders).values({
      id: orderId,
      organizationId,
      eventId,
      registrationId,
      purchaserCustomerUserId: customerUserId,
      orderNo: `T${randomUUID().replaceAll('-', '').slice(0, 25)}`,
      status: 'paid',
      amount: 39900,
      currency: 'CNY',
      pricingSnapshot: { refundPolicy: policy },
      expiresAt: new Date(),
    });
    const [payment] = await db
      .insert(payments)
      .values({
        orderId,
        provider: 'wechatpay',
        channel: 'native',
        merchantId: config.mchId,
        status: 'succeeded',
        succeededAt: new Date(),
        amount: 39900,
        currency: 'CNY',
        outTradeNo: `T${randomUUID().replaceAll('-', '').slice(0, 25)}`,
        externalId: randomUUID(),
      })
      .returning();
    await db
      .insert(tickets)
      .values({ eventId, registrationId, ticketTypeId, code: `R${randomUUID()}`, status: 'valid' });
    await db.insert(organizationIntegrations).values({
      organizationId,
      provider: 'wechatpay',
      status: 'verified',
      config,
      encryptedCredentials: encryptIntegrationCredentials(organizationId, 'wechatpay', {
        merchantPrivateKey,
        apiV3Key,
        platformPublicKey,
      }),
    });
    const gateway = new WeChatPayService(database);
    vi.spyOn(gateway, 'verifyRefundPayment').mockResolvedValue({
      merchantId: config.mchId,
      paidAt: payment!.succeededAt!,
    });
    return {
      organizationId,
      actorId,
      eventId,
      orderId,
      config,
      apiV3Key,
      payment: payment!,
      gateway,
      workflow: new RefundWorkflowService(database, gateway),
      customer: { organizationId, customerUserId },
      policy,
    };
  }

  async function waitForBlockedConfigurationTransactions(organizationId: string, count: number) {
    await expect
      .poll(
        async () => {
          const result = await db.execute(sql`select count(*)::int as blocked from pg_locks
        where locktype = 'advisory' and not granted
          and classid = ((hashtextextended(${`wechat-configuration:${organizationId}`}, 0) >> 32) & 4294967295)::oid
          and objid = (hashtextextended(${`wechat-configuration:${organizationId}`}, 0) & 4294967295)::oid`);
          return Number(result.rows[0]?.blocked);
        },
        { timeout: 5000 },
      )
      .toBe(count);
  }

  const changes = ['merchant', 'apiV3Key'] as const;
  function changedConfig(f: Awaited<ReturnType<typeof fixture>>, kind: (typeof changes)[number]) {
    return {
      ...f.config,
      ...(kind === 'merchant'
        ? { mchId: '1900000110' }
        : { apiV3Key: randomBytes(16).toString('hex') }),
    };
  }

  it.each(changes)(
    'rejects a concurrent %s change after an approved refund acquires the lock',
    async (kind) => {
      const f = await fixture();
      const inside = latch(),
        release = latch();
      const original = f.gateway.refundConfiguration.bind(f.gateway);
      vi.spyOn(f.gateway, 'refundConfiguration').mockImplementation(
        async (organizationId, reader) => {
          const result = await original(organizationId, reader);
          if (reader) {
            inside.resolve();
            await release.promise;
          }
          return result;
        },
      );
      const creating = f.workflow.createAdmin(
        f.organizationId,
        f.orderId,
        f.actorId,
        randomUUID(),
        { amount: 39900, reason: '测试退款' },
      );
      let changing: Promise<unknown> | undefined;
      try {
        await inside.promise;
        changing = f.gateway
          .updateConfiguration(f.organizationId, f.actorId, changedConfig(f, kind))
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        await waitForBlockedConfigurationTransactions(f.organizationId, 1);
      } finally {
        release.resolve();
      }
      expect(await creating).toMatchObject({ status: 'queued' });
      expect(await changing).toMatchObject({
        error: { message: expect.stringContaining('未结清退款') },
      });
      expect(await f.gateway.refundConfiguration(f.organizationId)).toMatchObject({
        merchantId: f.config.mchId,
      });
    },
  );

  it.each(changes)(
    'rechecks a stale refund preflight when %s configuration commits first',
    async (kind) => {
      const f = await fixture();
      const held = latch(),
        release = latch();
      const gate = db.transaction(async (tx) => {
        await lockWeChatConfiguration(tx, f.organizationId);
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const changing = f.gateway.updateConfiguration(
        f.organizationId,
        f.actorId,
        changedConfig(f, kind),
      );
      let creating: Promise<unknown> | undefined;
      try {
        await waitForBlockedConfigurationTransactions(f.organizationId, 1);
        creating = f.workflow
          .createAdmin(f.organizationId, f.orderId, f.actorId, randomUUID(), {
            amount: 39900,
            reason: '测试退款',
          })
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        await waitForBlockedConfigurationTransactions(f.organizationId, 2);
      } finally {
        release.resolve();
        await gate;
      }
      await changing;
      expect(await creating).toMatchObject({ error: { code: 'REFUND_NOT_CONFIGURED' } });
      expect(
        await db.select().from(refundRequests).where(eq(refundRequests.orderId, f.orderId)),
      ).toHaveLength(0);
      expect(await db.select().from(refunds).where(eq(refunds.orderId, f.orderId))).toHaveLength(0);
    },
  );

  it('rejects an old merchant preflight even after the new merchant has been verified', async () => {
    const f = await fixture(),
      preflight = latch(),
      release = latch();
    const original = f.gateway.refundConfiguration.bind(f.gateway);
    vi.spyOn(f.gateway, 'refundConfiguration').mockImplementationOnce(
      async (organizationId, reader) => {
        const result = await original(organizationId, reader);
        preflight.resolve();
        await release.promise;
        return result;
      },
    );
    const creating = f.workflow
      .createAdmin(f.organizationId, f.orderId, f.actorId, randomUUID(), {
        amount: 39900,
        reason: '旧配置预读',
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      await preflight.promise;
      await f.gateway.updateConfiguration(
        f.organizationId,
        f.actorId,
        changedConfig(f, 'merchant'),
      );
      await db
        .update(organizationIntegrations)
        .set({ status: 'verified' })
        .where(eq(organizationIntegrations.organizationId, f.organizationId));
    } finally {
      release.resolve();
    }
    expect(await creating).toMatchObject({
      error: { message: expect.stringContaining('微信支付配置已变化') },
    });
    expect(await db.select().from(refunds).where(eq(refunds.orderId, f.orderId))).toHaveLength(0);
  });

  it('also serializes a customer application before a merchant update', async () => {
    const f = await fixture(),
      inside = latch(),
      release = latch();
    const original = f.gateway.refundConfiguration.bind(f.gateway);
    vi.spyOn(f.gateway, 'refundConfiguration').mockImplementationOnce(
      async (organizationId, reader) => {
        const result = await original(organizationId, reader);
        inside.resolve();
        await release.promise;
        return result;
      },
    );
    const creating = f.workflow.createCustomer(f.customer, f.orderId, randomUUID(), {
      amount: 39900,
      policyVersion: f.policy.version,
      reason: '',
    });
    let changing: Promise<unknown> | undefined;
    try {
      await inside.promise;
      changing = f.gateway
        .updateConfiguration(f.organizationId, f.actorId, changedConfig(f, 'merchant'))
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await waitForBlockedConfigurationTransactions(f.organizationId, 1);
    } finally {
      release.resolve();
    }
    expect(await creating).toMatchObject({ reviewStatus: 'pending_review' });
    expect(await changing).toMatchObject({
      error: { message: expect.stringContaining('未结清退款') },
    });
  });

  function signed(body: string, f: Awaited<ReturnType<typeof fixture>>) {
    const timestamp = String(Math.floor(Date.now() / 1000)),
      nonce = randomBytes(8).toString('hex');
    const signer = createSign('RSA-SHA256');
    signer.update(`${timestamp}\n${nonce}\n${body}\n`);
    signer.end();
    return {
      timestamp,
      nonce,
      serial: f.config.platformPublicKeyId,
      signature: signer.sign(keys.privateKey, 'base64'),
    };
  }
  function callback(f: Awaited<ReturnType<typeof fixture>>) {
    const nonce = randomBytes(6).toString('hex'),
      associated = 'refund';
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(f.apiV3Key), Buffer.from(nonce));
    cipher.setAAD(Buffer.from(associated));
    const ciphertext = Buffer.concat([
      cipher.update(
        JSON.stringify({
          mchid: f.config.mchId,
          out_refund_no: `RF${randomUUID().replaceAll('-', '')}`,
        }),
      ),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const body = JSON.stringify({
      id: randomUUID(),
      event_type: 'REFUND.SUCCESS',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        nonce,
        associated_data: associated,
        ciphertext: ciphertext.toString('base64'),
      },
    });
    return { body: Buffer.from(body), headers: signed(body, f) };
  }

  it.each(changes)(
    'keeps a newly received callback durable before a concurrent %s change',
    async (kind) => {
      const f = await fixture(),
        n = callback(f),
        held = latch(),
        release = latch();
      const gate = db.transaction(async (tx) => {
        await lockWeChatConfiguration(tx, f.organizationId);
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const receiving = f.gateway.receiveRefundNotification(f.organizationId, n.body, n.headers);
      let changing: Promise<unknown> | undefined;
      try {
        await waitForBlockedConfigurationTransactions(f.organizationId, 1);
        changing = f.gateway
          .updateConfiguration(f.organizationId, f.actorId, changedConfig(f, kind))
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        await waitForBlockedConfigurationTransactions(f.organizationId, 2);
      } finally {
        release.resolve();
        await gate;
      }
      await receiving;
      expect(await changing).toMatchObject({
        error: { message: expect.stringContaining('未结清退款') },
      });
      expect(
        await db
          .select()
          .from(refundNotificationInbox)
          .where(eq(refundNotificationInbox.organizationId, f.organizationId)),
      ).toHaveLength(1);
    },
  );

  it('keeps signed historical queries available while a configuration lock is held and collection is disabled', async () => {
    const f = await fixture();
    await f.gateway.updateConfiguration(f.organizationId, f.actorId, {
      ...f.config,
      enabled: false,
      apiV3Key: randomBytes(16).toString('hex'),
    });
    const body = JSON.stringify({
      refund_id: 'WX_RACE_HISTORY',
      out_refund_no: 'RF_RACE_HISTORY',
      transaction_id: f.payment.externalId,
      out_trade_no: f.payment.outTradeNo,
      status: 'SUCCESS',
      channel: 'ORIGINAL',
      user_received_account: '支付用户零钱',
      create_time: new Date().toISOString(),
      success_time: new Date().toISOString(),
      amount: { total: 39900, refund: 39900, currency: 'CNY' },
    });
    const headers = signed(body, f);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: {
            'wechatpay-timestamp': headers.timestamp,
            'wechatpay-nonce': headers.nonce,
            'wechatpay-serial': headers.serial,
            'wechatpay-signature': headers.signature,
          },
        }),
      ),
    );
    const held = latch(),
      release = latch();
    const gate = db.transaction(async (tx) => {
      await lockWeChatConfiguration(tx, f.organizationId);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    let settled = false;
    const query = f.gateway
      .queryRefund(f.organizationId, f.config.mchId, 'RF_RACE_HISTORY')
      .finally(() => {
        settled = true;
      });
    try {
      await expect.poll(() => settled, { timeout: 2000 }).toBe(true);
      expect(await query).toMatchObject({ status: 'SUCCESS' });
    } finally {
      release.resolve();
      await gate;
    }
  });
});
