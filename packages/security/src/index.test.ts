import { describe, expect, it } from 'vitest';
import {
  createTicketCode,
  csrfToken,
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  isReadableTicketCode,
  isStrictTicketCode,
  maskMobile,
  normalizeMainlandMobile,
  normalizePaymentBasePath,
  openSecret,
  resolveDeploymentOrigins,
  resolvePaymentPublicUrl,
  sealSecret,
  secureDigestEquals,
  sha256,
} from './index.js';

describe('ticket code security contract', () => {
  it(
    'BLK-01 generates only ticket codes accepted by the strict public contract',
    { timeout: 20_000 },
    () => {
      for (let index = 0; index < 100_000; index += 1) {
        const code = createTicketCode();
        if (!isStrictTicketCode(code)) {
          expect.fail(`Generated ticket code violates the strict contract: ${code}`);
        }
        if (!isReadableTicketCode(code)) {
          expect.fail(`Generated ticket code violates the readable contract: ${code}`);
        }
      }
    },
  );

  it('BLK-01 keeps historical ticket codes readable without accepting unsafe paths', () => {
    expect(isReadableTicketCode('TOK-T-08DPDRLZ_9')).toBe(true);
    expect(isReadableTicketCode('TOK-T-ABC-123_XY')).toBe(true);
    expect(isReadableTicketCode('TOK-T-0000000001')).toBe(true);
    expect(isStrictTicketCode('TOK-T-0000000001')).toBe(false);
    expect(isStrictTicketCode('TOK-T-08DPDRLZ_9')).toBe(false);
    expect(isReadableTicketCode('TOK-T-../../etc/passwd')).toBe(false);
    expect(isReadableTicketCode('tok-t-abcdefghij')).toBe(false);
  });
});

describe('deployment origin security', () => {
  it('keeps source-development origins when no gateway is configured', () => {
    expect(resolveDeploymentOrigins({}).corsOrigins).toEqual([
      'http://localhost:3000',
      'http://localhost:3200',
    ]);
  });

  it('accepts distinct local origins on one gateway port', () => {
    expect(
      resolveDeploymentOrigins({
        DEPLOYMENT_MODE: 'local',
        PUBLIC_ORIGIN: 'http://localhost:8088',
        ADMIN_ORIGIN: 'http://admin.localhost:8088',
        PUBLIC_WEB_URL: 'http://localhost:8088',
        ADMIN_WEB_URL: 'http://admin.localhost:8088',
      }).corsOrigins,
    ).toEqual(['http://localhost:8088', 'http://admin.localhost:8088']);
  });

  it('rejects a shared public and admin browser origin', () => {
    expect(() =>
      resolveDeploymentOrigins({
        PUBLIC_ORIGIN: 'http://localhost:8088',
        ADMIN_ORIGIN: 'http://localhost:8088',
      }),
    ).toThrow('must use distinct browser origins');
  });

  it.each([
    [{ PUBLIC_ORIGIN: 'https://conference.example.com' }, 'ADMIN_ORIGIN is required'],
    [
      {
        PUBLIC_ORIGIN: 'http://conference.example.com',
        ADMIN_ORIGIN: 'https://admin.conference.example.com',
      },
      'PUBLIC_ORIGIN must use HTTPS',
    ],
    [
      {
        PUBLIC_ORIGIN: 'https://127.0.0.2',
        ADMIN_ORIGIN: 'https://admin.example.com',
      },
      'PUBLIC_ORIGIN must not use a loopback host',
    ],
    [
      {
        PUBLIC_ORIGIN: 'https://[::1]',
        ADMIN_ORIGIN: 'https://admin.example.com',
      },
      'PUBLIC_ORIGIN must not use a loopback host',
    ],
    [
      {
        PUBLIC_ORIGIN: 'https://conference.example.com/admin',
        ADMIN_ORIGIN: 'https://admin.conference.example.com',
      },
      'PUBLIC_ORIGIN must contain only scheme, host',
    ],
    [
      {
        PUBLIC_ORIGIN: 'https://conference.example.com',
        ADMIN_ORIGIN: 'https://control.example.com',
      },
      'ADMIN_ORIGIN hostname must be admin.',
    ],
  ])('rejects unsafe production origins %#', (values, message) => {
    expect(() =>
      resolveDeploymentOrigins({
        DEPLOYMENT_MODE: 'production',
        ...values,
      }),
    ).toThrow(message);
  });

  it('accepts canonical HTTPS production origins and linked URLs', () => {
    expect(
      resolveDeploymentOrigins({
        DEPLOYMENT_MODE: 'production',
        PUBLIC_ORIGIN: 'https://conference.example.com',
        ADMIN_ORIGIN: 'https://admin.conference.example.com',
        PUBLIC_WEB_URL: 'https://conference.example.com',
        ADMIN_WEB_URL: 'https://admin.conference.example.com',
        PUBLIC_SITE_URL: 'https://conference.example.com',
        PUBLIC_API_URL: 'https://conference.example.com',
      }),
    ).toMatchObject({
      publicOrigin: 'https://conference.example.com',
      adminOrigin: 'https://admin.conference.example.com',
      corsOrigins: ['https://conference.example.com', 'https://admin.conference.example.com'],
    });
  });

  it('accepts an independent payment origin and base path', () => {
    expect(
      resolveDeploymentOrigins({
        DEPLOYMENT_MODE: 'production',
        PUBLIC_ORIGIN: 'https://hui.ailingdaoli.com',
        ADMIN_ORIGIN: 'https://admin.hui.ailingdaoli.com',
        PAYMENT_PUBLIC_ORIGIN: 'https://www.ailingdaoli.com',
        PAYMENT_PUBLIC_BASE_PATH: '/pay/hui',
      }),
    ).toMatchObject({
      paymentOrigin: 'https://www.ailingdaoli.com',
      paymentBasePath: '/pay/hui',
      paymentPublicUrl: 'https://www.ailingdaoli.com/pay/hui',
      corsOrigins: ['https://hui.ailingdaoli.com', 'https://admin.hui.ailingdaoli.com'],
    });
  });

  it.each(['http://payments.example.com/pay/hui', 'https://localhost/pay/hui'])(
    'rejects an unsafe production PAYMENT_PUBLIC_URL %s',
    (paymentPublicUrl) => {
      expect(() =>
        resolveDeploymentOrigins({
          DEPLOYMENT_MODE: 'production',
          PUBLIC_ORIGIN: 'https://conference.example.com',
          ADMIN_ORIGIN: 'https://admin.conference.example.com',
          PAYMENT_PUBLIC_URL: paymentPublicUrl,
        }),
      ).toThrow(/Payment public origin/);
    },
  );

  it.each([
    ['/pay/hui/', '/pay/hui'],
    ['/pay//hui', '/pay/hui'],
    ['/pay/hui', '/pay/hui'],
  ])('normalizes payment base path %s', (input, expected) => {
    expect(normalizePaymentBasePath(input)).toBe(expected);
  });

  it.each(['pay/hui', '/pay/../hui', '/pay/hui?x=1', '/pay/hui#frag', '/'])(
    'rejects unsafe payment base path %s',
    (input) => {
      expect(() => normalizePaymentBasePath(input)).toThrow(/PAYMENT_PUBLIC_BASE_PATH/);
    },
  );

  it('rejects a payment origin that matches the conference origin', () => {
    expect(() =>
      resolveDeploymentOrigins({
        PUBLIC_ORIGIN: 'https://www.ailingdaoli.com',
        ADMIN_ORIGIN: 'https://admin.www.ailingdaoli.com',
        PAYMENT_PUBLIC_ORIGIN: 'https://www.ailingdaoli.com',
        PAYMENT_PUBLIC_BASE_PATH: '/pay/hui',
        DEPLOYMENT_MODE: 'production',
      }),
    ).toThrow('PAYMENT_PUBLIC_ORIGIN must differ from PUBLIC_ORIGIN');
  });

  it('builds absolute payment URLs under the configured surface', () => {
    expect(
      resolvePaymentPublicUrl('/order/abc', {
        PAYMENT_PUBLIC_ORIGIN: 'https://www.ailingdaoli.com',
        PAYMENT_PUBLIC_BASE_PATH: '/pay/hui',
      }),
    ).toBe('https://www.ailingdaoli.com/pay/hui/order/abc');
  });
});

describe('customer security primitives', () => {
  it('normalizes and masks mainland mobile numbers', () => {
    expect(normalizeMainlandMobile('138 0013 8000')).toBe('+8613800138000');
    expect(maskMobile('+8613800138000')).toBe('138****8000');
    expect(() => normalizeMainlandMobile('1234')).toThrow('有效');
  });

  it('seals transient secrets and compares digests safely', () => {
    const sealed = sealSecret('123456', 'development-secret');
    expect(openSecret(sealed, 'development-secret')).toBe('123456');
    expect(secureDigestEquals(sha256('a'), sha256('a'))).toBe(true);
    expect(secureDigestEquals(sha256('a'), sha256('b'))).toBe(false);
    expect(csrfToken('session-id', 'development-secret')).toHaveLength(43);
  });

  it('binds encrypted integration credentials to their organization and provider', () => {
    const previousKey = process.env.INTEGRATION_ENCRYPTION_KEY;
    const previousVersion = process.env.INTEGRATION_ENCRYPTION_KEY_VERSION;
    const previousKeys = process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS;
    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.from(
      'conference-test-payment-key-2026',
    ).toString('base64');
    process.env.INTEGRATION_ENCRYPTION_KEY_VERSION = '1';
    delete process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS;
    try {
      const encrypted = encryptIntegrationCredentials('org-1', 'aliyun-sms', {
        accessKeySecret: 'secret-value',
      });
      expect(decryptIntegrationCredentials('org-1', 'aliyun-sms', encrypted)).toEqual({
        accessKeySecret: 'secret-value',
      });
      expect(() => decryptIntegrationCredentials('org-2', 'aliyun-sms', encrypted)).toThrow(
        '服务密钥无法解密',
      );
    } finally {
      if (previousKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
      else process.env.INTEGRATION_ENCRYPTION_KEY = previousKey;
      if (previousVersion === undefined) {
        delete process.env.INTEGRATION_ENCRYPTION_KEY_VERSION;
      } else {
        process.env.INTEGRATION_ENCRYPTION_KEY_VERSION = previousVersion;
      }
      if (previousKeys === undefined) {
        delete process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS;
      } else {
        process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS = previousKeys;
      }
    }
  });
});
