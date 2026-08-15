import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { DatabaseService } from './database.service.js';
import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_LIFETIME_SECONDS,
  CustomerAuthService,
  customerOtpIpHourlyLimit,
} from './customer-auth.service.js';

function request(cookies: Record<string, string> = {}) {
  return {
    headers: {
      'x-organization-slug': 'tokems-demo',
      'user-agent': 'customer-auth-test',
    },
    cookies,
    ip: '127.0.0.1',
    method: 'GET',
  } as unknown as FastifyRequest;
}

describe('CustomerAuthService memory flow', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    process.env.DEPLOYMENT_MODE = 'local';
    process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
    process.env.ADMIN_WEB_URL = 'http://localhost:3200';
    process.env.CUSTOMER_OTP_MODE = 'fake';
  });

  afterEach(() => {
    delete process.env.CUSTOMER_OTP_MODE;
    delete process.env.CUSTOMER_OTP_PEPPER;
    delete process.env.CUSTOMER_SESSION_SECRET;
    delete process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET;
    delete process.env.DEPLOYMENT_MODE;
    delete process.env.PUBLIC_WEB_URL;
    delete process.env.ADMIN_WEB_URL;
    delete process.env.NODE_ENV;
  });

  it('refuses fake codes in a production deployment', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEPLOYMENT_MODE = 'production';
    process.env.CUSTOMER_OTP_PEPPER = 'production-otp-pepper-at-least-32-characters';
    process.env.CUSTOMER_SESSION_SECRET = 'production-session-secret-at-least-32-characters';
    process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET =
      'production-notification-secret-at-least-32-characters';

    expect(() => new CustomerAuthService({} as DatabaseService)).toThrow(
      'CUSTOMER_OTP_MODE=fake requires a local deployment',
    );
  });

  it('keeps provider IP throttling strict while allowing repeatable loopback smoke checks', () => {
    expect(customerOtpIpHourlyLimit('provider')).toBe(20);
    expect(customerOtpIpHourlyLimit('fake')).toBe(10_000);
  });

  it('refuses fake codes when the deployment mode is production without NODE_ENV', () => {
    delete process.env.NODE_ENV;
    process.env.DEPLOYMENT_MODE = 'production';

    expect(() => new CustomerAuthService({} as DatabaseService)).toThrow(
      'CUSTOMER_OTP_MODE=fake requires a local deployment',
    );
  });

  it('rejects published placeholder secrets in production', () => {
    delete process.env.NODE_ENV;
    process.env.DEPLOYMENT_MODE = 'production';
    process.env.CUSTOMER_OTP_MODE = 'provider';
    process.env.CUSTOMER_OTP_PEPPER = 'conference-local-customer-otp-pepper-change-me-2026';
    process.env.CUSTOMER_SESSION_SECRET = 'production-session-secret-at-least-32-characters';
    process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET =
      'production-notification-secret-at-least-32-characters';

    expect(() => new CustomerAuthService({} as DatabaseService)).toThrow(
      'CUSTOMER_OTP_PEPPER with at least 32 characters is required in production',
    );
  });

  it('creates an opaque session after a valid one-time code', async () => {
    const service = new CustomerAuthService({ db: null } as unknown as DatabaseService);
    const challenge = await service.requestOtp(request(), '138 0013 8000');
    expect(challenge.developmentCode).toBe('123456');

    const verified = await service.verifyOtp(request(), {
      challengeId: challenge.challengeId,
      mobile: '13800138000',
      code: challenge.developmentCode!,
      consentAccepted: true,
      termsVersion: '',
      privacyVersion: '',
    });
    expect(verified.token.length).toBeGreaterThanOrEqual(32);
    expect(verified.session.customer.mobile).toBe('+8613800138000');
    expect(verified.session.csrfToken.length).toBeGreaterThanOrEqual(32);

    const active = await service.optionalSession(
      request({ [CUSTOMER_SESSION_COOKIE]: verified.token }),
    );
    expect(verified.session.customer.id).toBe(102);
    expect(active?.customerUserId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps a verified browser session for 400 days', async () => {
    const service = new CustomerAuthService({ db: null } as unknown as DatabaseService);
    const startedAt = Date.now();
    const challenge = await service.requestOtp(request(), '13800138003');
    const verified = await service.verifyOtp(request(), {
      challengeId: challenge.challengeId,
      mobile: '13800138003',
      code: challenge.developmentCode!,
      consentAccepted: true,
      termsVersion: '',
      privacyVersion: '',
    });
    const lifetime = new Date(verified.session.expiresAt).getTime() - startedAt;

    expect(lifetime).toBeGreaterThanOrEqual(CUSTOMER_SESSION_LIFETIME_SECONDS * 1_000);
    expect(lifetime).toBeLessThan(CUSTOMER_SESSION_LIFETIME_SECONDS * 1_000 + 1_000);
  });

  it('rejects an unsupported OTP mode', () => {
    process.env.CUSTOMER_OTP_MODE = 'preview';
    expect(() => new CustomerAuthService(new DatabaseService())).toThrow(
      'CUSTOMER_OTP_MODE must be fake or provider',
    );
  });

  it('keeps provider codes out of the API response', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CUSTOMER_OTP_MODE = 'provider';
    process.env.CUSTOMER_OTP_PEPPER = 'production-otp-pepper-at-least-32-characters';
    process.env.CUSTOMER_SESSION_SECRET = 'production-session-secret-at-least-32-characters';
    process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET =
      'production-notification-secret-at-least-32-characters';
    const service = new CustomerAuthService({ db: null } as unknown as DatabaseService);
    const challenge = await service.requestOtp(request(), '13800138001');

    expect(challenge.developmentCode).toBeUndefined();
  });

  it('allows the fixed fake code in loopback Docker mode', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CUSTOMER_OTP_MODE = 'fake';
    process.env.CUSTOMER_OTP_PEPPER = 'production-otp-pepper-at-least-32-characters';
    process.env.CUSTOMER_SESSION_SECRET = 'production-session-secret-at-least-32-characters';
    process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET =
      'production-notification-secret-at-least-32-characters';
    process.env.DEPLOYMENT_MODE = 'local';
    process.env.PUBLIC_WEB_URL = 'http://localhost:8088';
    process.env.ADMIN_WEB_URL = 'http://admin.localhost:8088';
    const service = new CustomerAuthService({ db: null } as unknown as DatabaseService);
    const challenge = await service.requestOtp(request(), '13800138002');

    expect(challenge.developmentCode).toBe('123456');
    await expect(
      service.verifyOtp(request(), {
        challengeId: challenge.challengeId,
        mobile: '13800138002',
        code: '123456',
        consentAccepted: true,
        termsVersion: '',
        privacyVersion: '',
      }),
    ).resolves.toMatchObject({
      session: { customer: { mobile: '+8613800138002' } },
    });
  });

  it('consumes a code once and revokes the active session', async () => {
    const service = new CustomerAuthService(new DatabaseService());
    const challenge = await service.requestOtp(request(), '13800138000');
    const input = {
      challengeId: challenge.challengeId,
      mobile: '13800138000',
      code: challenge.developmentCode!,
      consentAccepted: true as const,
      termsVersion: '',
      privacyVersion: '',
    };
    const verified = await service.verifyOtp(request(), input);
    await expect(service.verifyOtp(request(), input)).rejects.toMatchObject({
      status: 401,
    });

    const authenticated = await service.requireSession(
      request({ [CUSTOMER_SESSION_COOKIE]: verified.token }),
    );
    await service.revokeSession(authenticated);
    expect(
      await service.optionalSession(request({ [CUSTOMER_SESSION_COOKIE]: verified.token })),
    ).toBeNull();
  });
});
