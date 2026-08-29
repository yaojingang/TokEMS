import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from './database.service.js';
import { RedisService } from './redis.service.js';
import {
  __wechatPayTestUtils,
  buildJsapiSignMessage,
  isReusablePreparedPaymentCredential,
  resolveTrustedClientIp,
  WeChatPayService,
} from './wechat-pay.service.js';

type RequestMethod = (
  method: string,
  canonicalUrl: string,
  body: Record<string, unknown> | undefined,
  config: {
    enabled: boolean;
    appId: string;
    mchId: string;
    merchantCertificateSerial: string;
    platformPublicKeyId: string;
    oauthEnabled: boolean;
    channels: { native: boolean; jsapi: boolean; h5: boolean };
  },
  credentials: {
    merchantPrivateKey: string;
    apiV3Key: string;
    platformPublicKey: string;
    appSecret?: string;
  },
) => Promise<Record<string, unknown>>;

/**
 * Builds RSA key fixtures for merchant and platform signing tests.
 *
 * @returns PEM key pair material and a platform serial id.
 */
function createRsaFixtures() {
  const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    platformPublicKeyId: 'PUB_KEY_ID_TEST_2026',
    merchantPrivateKey: merchantKeys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    platformPrivateKey: platformKeys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    platformPublicKey: platformKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * Signs a WeChat-style response body with the platform private key.
 *
 * @param body - Response body text.
 * @param platformPrivateKey - Platform PEM private key.
 * @param platformPublicKeyId - Wechatpay-Serial value.
 * @returns Response headers for signature verification.
 */
function signWeChatResponse(body: string, platformPrivateKey: string, platformPublicKeyId: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const signer = createSign('RSA-SHA256');
  signer.update(`${timestamp}\n${nonce}\n${body}\n`);
  signer.end();
  return {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-signature': signer.sign(platformPrivateKey, 'base64'),
    'wechatpay-serial': platformPublicKeyId,
  };
}

/**
 * Encrypts a notification resource with APIv3 AES-256-GCM.
 *
 * @param plaintext - JSON plaintext.
 * @param apiV3Key - 32-byte APIv3 key.
 * @returns Ciphertext fields for a WeChat notification resource.
 */
function encryptNotificationResource(plaintext: string, apiV3Key: string) {
  const nonce = randomBytes(12);
  const associatedData = Buffer.from('transaction');
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), nonce);
  cipher.setAAD(associatedData);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    nonce: nonce.toString('utf8'),
    associated_data: 'transaction',
  };
}

describe('WeChatPayService signed requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TRUST_PROXY;
  });

  it('declares the configured platform public key and verifies the signed response', async () => {
    const fixtures = createRsaFixtures();
    const responseBody = JSON.stringify({ echo_message: 'tokems-test' });
    let requestHeaders: Headers | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(responseBody, {
          status: 200,
          headers: signWeChatResponse(
            responseBody,
            fixtures.platformPrivateKey,
            fixtures.platformPublicKeyId,
          ),
        });
      }),
    );

    const service = new WeChatPayService(new DatabaseService(), new RedisService());
    const request = (service as unknown as { request: RequestMethod }).request.bind(service);
    const result = await request(
      'POST',
      '/v3/security/echo',
      { echo_message: 'tokems-test' },
      {
        enabled: true,
        appId: 'wx-test-app',
        mchId: '1234567890',
        merchantCertificateSerial: 'MERCHANT_SERIAL',
        platformPublicKeyId: fixtures.platformPublicKeyId,
        oauthEnabled: false,
        channels: { native: true, jsapi: false, h5: false },
      },
      {
        merchantPrivateKey: fixtures.merchantPrivateKey,
        apiV3Key: '12345678901234567890123456789012',
        platformPublicKey: fixtures.platformPublicKey,
      },
    );

    expect(result).toEqual({ echo_message: 'tokems-test' });
    expect(requestHeaders?.get('Wechatpay-Serial')).toBe(fixtures.platformPublicKeyId);
    expect(requestHeaders?.get('Authorization')).toContain('WECHATPAY2-SHA256-RSA2048');
  });

  it('requires a verified integration before accepting payment notifications', async () => {
    const service = new WeChatPayService(new DatabaseService(), new RedisService());
    const requiredIntegration = vi.fn(async () => ({
      row: { status: 'configured' },
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
    Reflect.set(service, 'requiredIntegration', requiredIntegration);

    await expect(
      service.parseNotification('organization-test', Buffer.from('{}'), {
        timestamp: Math.floor(Date.now() / 1000).toString(),
        nonce: 'nonce',
        signature: 'signature',
        serial: 'PLATFORM_SERIAL',
      }),
    ).rejects.toBeDefined();
    expect(requiredIntegration).toHaveBeenCalledWith('organization-test', {
      requireVerified: true,
    });
  });

  it('runs payment maintenance as a single flight per API process', async () => {
    const service = new WeChatPayService(new DatabaseService(), new RedisService());
    let releaseInbox!: () => void;
    const inboxPending = new Promise<void>((resolve) => {
      releaseInbox = resolve;
    });
    const reconcileInbox = vi.fn(() => inboxPending);
    const reconcileExpired = vi.fn(async () => ({ closed: 0, paid: 0 }));
    Reflect.set(service, 'reconcilePaymentNotificationInbox', reconcileInbox);
    Reflect.set(service, 'reconcileExpiredPaymentAttempts', reconcileExpired);
    const runMaintenance = Reflect.get(service, 'runPaymentMaintenance').bind(
      service,
    ) as () => Promise<void>;

    const first = runMaintenance();
    await runMaintenance();

    expect(reconcileInbox).toHaveBeenCalledTimes(1);
    expect(reconcileExpired).not.toHaveBeenCalled();
    releaseInbox();
    await first;
    expect(reconcileExpired).toHaveBeenCalledTimes(1);
  });

  it('builds JSAPI RSA paySign message in WeChat canonical order', () => {
    const message = buildJsapiSignMessage(
      'wx-app',
      '1710000000',
      'nonce-abc',
      'prepay_id=wx123',
    );
    expect(message).toBe('wx-app\n1710000000\nnonce-abc\nprepay_id=wx123\n');
  });

  it('signs JSAPI invoke params with the merchant private key', () => {
    const fixtures = createRsaFixtures();
    const service = new WeChatPayService(new DatabaseService(), new RedisService());
    const params = service.buildJsapiParams(
      'wx1234567890',
      {
        enabled: true,
        appId: 'wx-test-app',
        mchId: '1234567890',
        merchantCertificateSerial: 'MERCHANT_SERIAL',
        platformPublicKeyId: fixtures.platformPublicKeyId,
        oauthEnabled: true,
        channels: { native: true, jsapi: true, h5: false },
      },
      {
        merchantPrivateKey: fixtures.merchantPrivateKey,
        apiV3Key: '12345678901234567890123456789012',
        platformPublicKey: fixtures.platformPublicKey,
      },
    );
    expect(params.signType).toBe('RSA');
    expect(params.package).toBe('prepay_id=wx1234567890');
    expect(params.paySign.length).toBeGreaterThan(100);
  });

  it('generates out_trade_no within WeChat 6-32 character limits', () => {
    const value = __wechatPayTestUtils.generateOutTradeNo('ORD-2026-ABCDEFGHIJKLMNOP');
    expect(value.length).toBeGreaterThanOrEqual(6);
    expect(value.length).toBeLessThanOrEqual(32);
    expect(value).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('reuses prepared credentials while a payment query is still pending', () => {
    expect(isReusablePreparedPaymentCredential('pending', true)).toBe(true);
    expect(isReusablePreparedPaymentCredential('query_pending', true)).toBe(true);
    expect(isReusablePreparedPaymentCredential('query_pending', false)).toBe(false);
    expect(isReusablePreparedPaymentCredential('processing', true)).toBe(false);
    expect(isReusablePreparedPaymentCredential('close_pending', true)).toBe(false);
  });

  it('appends redirect_url to H5 URLs only once', () => {
    const first = __wechatPayTestUtils.appendH5RedirectUrl(
      'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=1&package=2',
      'https://www.example.com/pay/hui/order/abc',
    );
    expect(first).toContain('redirect_url=');
    const second = __wechatPayTestUtils.appendH5RedirectUrl(
      first,
      'https://www.example.com/pay/hui/order/other',
    );
    expect(second).toBe(first);
  });

  it('resolves trusted client IP from request.ip when TRUST_PROXY is set', () => {
    process.env.TRUST_PROXY = '10.0.0.0/8';
    expect(resolveTrustedClientIp('203.0.113.10', '198.51.100.1, 10.0.0.1')).toBe('203.0.113.10');
  });

  it('encrypts and decrypts APIv3 notification resources with AES-GCM fixtures', () => {
    const apiV3Key = '12345678901234567890123456789012';
    const plaintext = JSON.stringify({
      appid: 'wx-test-app',
      mchid: '1234567890',
      out_trade_no: 'OUTTRADE001',
      transaction_id: 'TXN001',
      trade_state: 'SUCCESS',
      amount: { total: 100, currency: 'CNY' },
      success_time: '2026-08-01T07:00:00+08:00',
    });
    const resource = encryptNotificationResource(plaintext, apiV3Key);
    expect(resource.algorithm).toBe('AEAD_AES_256_GCM');
    expect(resource.ciphertext.length).toBeGreaterThan(32);
    expect(resource.nonce.length).toBeGreaterThan(0);
  });
});
