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
  organizationIntegrations,
  organizations,
  refundNotificationInbox,
} from '@conference/database';
import { eq } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { encryptIntegrationCredentials } from './integration-credentials.js';
import {
  RefundGatewayError,
  channelReason,
  refundDeadline,
  refundRecipient,
  type WeChatRefundOutcome,
} from './refund-policy.js';

const persistent = process.env.DATABASE_URL ? describe : describe.skip;
persistent('signed WeChat refunds and durable notifications', () => {
  // The scheduler scans every tenant; keep other suites' fixtures outside its run.
  const fixtureLock = new Client({ connectionString: process.env.DATABASE_URL });
  const database = new DatabaseService();
  const db = database.db!;
  const service = new WeChatPayService(database);
  const organizationId = randomUUID();
  const currentKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const oldKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const apiV3Key = randomBytes(16).toString('hex');
  const platformPublicKeyId = 'PUB_KEY_ID_REFUND_TEST';
  const merchantId = 'test-refund-merchant';
  const result: WeChatRefundOutcome = {
    refund_id: 'WX123',
    out_refund_no: 'RF123',
    transaction_id: 'PAY123',
    out_trade_no: 'TRADE123',
    status: 'SUCCESS',
    channel: 'ORIGINAL',
    user_received_account: '支付用户零钱',
    create_time: new Date().toISOString(),
    success_time: new Date().toISOString(),
    amount: { total: 39900, refund: 39900, currency: 'CNY' },
  };
  beforeAll(async () => {
    await fixtureLock.connect();
    await fixtureLock.query(
      "select pg_advisory_lock(hashtextextended('tokems:refund-integration-fixtures', 0))",
    );
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY_VERSION', '1');
    await db.insert(organizations).values({
      id: organizationId,
      slug: `refund-crypto-${organizationId}`,
      name: '退款密码学验收',
    });
    await db.insert(organizationIntegrations).values({
      organizationId,
      provider: 'wechatpay',
      status: 'verified',
      config: {
        enabled: false,
        appId: 'wx-test',
        mchId: merchantId,
        merchantCertificateSerial: 'TEST_SERIAL',
        platformPublicKeyId,
        refundFunding: 'default',
        oauthEnabled: false,
        channels: { native: true, jsapi: false, h5: false },
      },
      encryptedCredentials: encryptIntegrationCredentials(organizationId, 'wechatpay', {
        merchantPrivateKey: currentKeys.privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
        platformPublicKey: currentKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        apiV3Key,
        refundPublicKeys: JSON.stringify([
          {
            serial: 'PUB_KEY_ID_OLD',
            key: oldKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          },
        ]),
      }),
    });
  }, 60_000);
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    try {
      await db
        .delete(refundNotificationInbox)
        .where(eq(refundNotificationInbox.organizationId, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
      vi.unstubAllEnvs();
    } finally {
      await fixtureLock.end();
      await database.onModuleDestroy();
    }
  });
  it('rejects unsigned callbacks before looking up merchant configuration', async () => {
    await expect(
      service.receiveRefundNotification(randomUUID(), Buffer.from('{}'), {}),
    ).rejects.toMatchObject({ response: { code: 'UNAUTHORIZED' } });
    await expect(service.refundConfiguration(randomUUID())).rejects.toMatchObject({
      code: 'REFUND_NOT_CONFIGURED',
      knownRejected: true,
      status: 409,
    });
  });
  function sign(body: string, old = false) {
    const timestamp = String(Math.floor(Date.now() / 1000)),
      nonce = randomBytes(8).toString('hex');
    const signer = createSign('RSA-SHA256');
    signer.update(`${timestamp}\n${nonce}\n${body}\n`);
    signer.end();
    return {
      timestamp,
      nonce,
      serial: old ? 'PUB_KEY_ID_OLD' : platformPublicKeyId,
      signature: signer.sign(old ? oldKeys.privateKey : currentKeys.privateKey, 'base64'),
    };
  }
  function notification(
    options: { merchant?: string; id?: string; old?: boolean; brokenTag?: boolean } = {},
  ) {
    const nonce = randomBytes(6).toString('hex');
    const associated = 'refund';
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
    cipher.setAAD(Buffer.from(associated));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ ...result, mchid: options.merchant ?? merchantId })),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    if (options.brokenTag) ciphertext[ciphertext.length - 1]! ^= 1;
    const body = JSON.stringify({
      id: options.id ?? randomUUID(),
      event_type: 'REFUND.SUCCESS',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        nonce,
        associated_data: associated,
        ciphertext: ciphertext.toString('base64'),
      },
    });
    return { body: Buffer.from(body), headers: sign(body, options.old) };
  }
  it('accepts verified AES-GCM notifications once even after collection is disabled', async () => {
    const n = notification();
    await service.receiveRefundNotification(organizationId, n.body, n.headers);
    await service.receiveRefundNotification(organizationId, n.body, n.headers);
    const rows = await db
      .select()
      .from(refundNotificationInbox)
      .where(eq(refundNotificationInbox.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('支付用户零钱');
  });
  it('supports the previous verification key during key rotation', async () => {
    const n = notification({ old: true });
    await expect(
      service.receiveRefundNotification(organizationId, n.body, n.headers),
    ).resolves.toBeUndefined();
  });
  it.each(['signature', 'merchant', 'tag', 'age', 'serial'] as const)(
    'rejects invalid %s before storing a notification',
    async (kind) => {
      const n = notification({
        merchant: kind === 'merchant' ? 'other-merchant' : merchantId,
        brokenTag: kind === 'tag',
      });
      if (kind === 'signature') n.headers.signature = 'invalid';
      if (kind === 'age') n.headers.timestamp = '1';
      if (kind === 'serial') n.headers.serial = 'PUB_KEY_ID_UNKNOWN';
      const before = await db
        .select()
        .from(refundNotificationInbox)
        .where(eq(refundNotificationInbox.organizationId, organizationId));
      await expect(
        service.receiveRefundNotification(organizationId, n.body, n.headers),
      ).rejects.toThrow();
      const after = await db
        .select()
        .from(refundNotificationInbox)
        .where(eq(refundNotificationInbox.organizationId, organizationId));
      expect(after.length).toBe(before.length);
    },
  );
  it('checks signed query results and keeps the original merchant route', async () => {
    const body = JSON.stringify(result);
    const h = sign(body);
    const fetch = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          'wechatpay-timestamp': h.timestamp,
          'wechatpay-nonce': h.nonce,
          'wechatpay-serial': h.serial,
          'wechatpay-signature': h.signature,
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(service.queryRefund(organizationId, merchantId, 'RF123')).resolves.toMatchObject({
      status: 'SUCCESS',
    });
    await expect(
      service.queryRefund(organizationId, 'different-merchant', 'RF123'),
    ).rejects.toMatchObject({ code: 'MERCHANT_MISMATCH' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('distinguishes a signed insufficient-funds rejection from an unsigned error', async () => {
    const body = JSON.stringify({ code: 'NOT_ENOUGH', message: 'sensitive raw provider error' });
    const h = sign(body);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 403,
          headers: {
            'wechatpay-timestamp': h.timestamp,
            'wechatpay-nonce': h.nonce,
            'wechatpay-serial': h.serial,
            'wechatpay-signature': h.signature,
          },
        }),
      ),
    );
    await expect(service.submitRefund(organizationId, merchantId, {})).rejects.toMatchObject({
      code: 'NOT_ENOUGH',
      knownRejected: true,
      verifiedResponse: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 403 })));
    await expect(service.submitRefund(organizationId, merchantId, {})).rejects.toMatchObject({
      code: 'NOT_ENOUGH',
      knownRejected: false,
      verifiedResponse: false,
    });
  });
  it.each([true, false])(
    'preserves verified absence separately from rejection when the query signature is present: %s',
    async (signed) => {
      const body = JSON.stringify({ code: 'RESOURCE_NOT_EXISTS' });
      const h = sign(body);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(body, {
            status: 404,
            ...(signed
              ? {
                  headers: {
                    'wechatpay-timestamp': h.timestamp,
                    'wechatpay-nonce': h.nonce,
                    'wechatpay-serial': h.serial,
                    'wechatpay-signature': h.signature,
                  },
                }
              : {}),
          }),
        ),
      );
      await expect(service.queryRefund(organizationId, merchantId, 'RF123')).rejects.toMatchObject({
        code: 'RESOURCE_NOT_EXISTS',
        knownRejected: false,
        verifiedResponse: signed,
        httpStatus: 404,
      });
    },
  );
});

describe('refund policy boundaries', () => {
  it('uses an exact 7x24h deadline and byte-limits channel reasons', () => {
    expect(refundDeadline(new Date('2026-09-01T12:00:00Z'))?.toISOString()).toBe(
      '2026-09-08T12:00:00.000Z',
    );
    expect(Buffer.byteLength(channelReason('退'.repeat(100)))).toBeLessThanOrEqual(80);
    expect(channelReason('')).toBe('用户申请退款');
    expect(new RefundGatewayError('NOT_ENOUGH', true).message).not.toContain('sensitive');
  });
  it('does not classify a merchant refund as customer settlement', () => {
    const base: WeChatRefundOutcome = {
      refund_id: 'x',
      out_refund_no: 'x',
      transaction_id: 'x',
      out_trade_no: 'x',
      status: 'SUCCESS',
      channel: 'OTHER_BANKCARD',
      user_received_account: '商户结算银行账户',
      create_time: new Date().toISOString(),
      amount: { total: 100, refund: 100, currency: 'CNY' },
    };
    expect(refundRecipient(base)).toBe('merchant');
    expect(refundRecipient({ ...base, user_received_account: '未知账户' })).toBe('unknown');
  });
});
