import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { customerAuthChallenges, customerConsents, customerUsers, organizations } from '@conference/database';
import { and, eq } from 'drizzle-orm';
import { CustomerAuthService } from './customer-auth.service.js';
import { DatabaseService } from './database.service.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;
persistent('customer consent continuation with PostgreSQL', () => {
  let database: DatabaseService;
  let service: CustomerAuthService;
  const organizationId = randomUUID();
  const slug = `consent-${organizationId}`;
  const policy = { defaultAccountMode: 'mobile_otp_required' as const, termsVersion: 'v1', privacyVersion: 'v1', termsUrl: 'https://example.org/terms', privacyUrl: 'https://example.org/privacy' };
  const request = (org = slug) => ({ headers: { 'x-organization-slug': org }, cookies: {}, ip: '127.0.0.1' }) as unknown as FastifyRequest;
  let nextMobile = 13900003000;
  async function verify(mobile = String(nextMobile++)) {
    const code = await service.requestOtp(request(), mobile);
    return { mobile, result: await service.verifyOtp(request(), { challengeId: code.challengeId, mobile, code: code.developmentCode!, consentAccepted: false, termsVersion: '', privacyVersion: '' }) };
  }
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', process.env.PARTNER_TEST_DATABASE_URL!);
    vi.stubEnv('PUBLIC_WEB_URL', 'http://localhost:3107'); vi.stubEnv('ADMIN_WEB_URL', 'http://localhost:3207');
    vi.stubEnv('DEPLOYMENT_MODE', 'local'); vi.stubEnv('CUSTOMER_OTP_MODE', 'fake');
    database = new DatabaseService(); service = new CustomerAuthService(database);
    await database.db!.insert(organizations).values({ id: organizationId, slug, name: '协议确认测试', settings: { customerAccounts: policy } });
  });
  afterAll(async () => { await database?.onModuleDestroy(); vi.unstubAllEnvs(); });
  it('creates no user before consent, records consent once, and skips confirmation on later login', async () => {
    const { mobile, result } = await verify();
    if (!('consentRequired' in result)) throw new Error('Expected consent');
    expect(await database.db!.select().from(customerUsers).where(and(eq(customerUsers.organizationId, organizationId), eq(customerUsers.mobileE164, `+86${mobile}`)))).toHaveLength(0);
    const completed = await service.completeConsent(request(), result.consentToken, { ...policy, consentAccepted: true });
    if (!('session' in completed)) throw new Error('Expected login');
    const [user] = await database.db!.select().from(customerUsers).where(and(eq(customerUsers.organizationId, organizationId), eq(customerUsers.mobileE164, `+86${mobile}`)));
    expect(await database.db!.select().from(customerConsents).where(eq(customerConsents.customerUserId, user!.id))).toHaveLength(2);
    await expect(service.completeConsent(request(), result.consentToken, { ...policy, consentAccepted: true })).rejects.toMatchObject({ status: 401 });
    expect('session' in (await verify(mobile)).result).toBe(true);
    expect(await database.db!.select().from(customerConsents).where(eq(customerConsents.customerUserId, user!.id))).toHaveLength(2);
  });
  it('requires new consent when the published version changes during confirmation', async () => {
    const { result } = await verify(); if (!('consentRequired' in result)) throw new Error('Expected consent');
    await database.db!.update(organizations).set({ settings: { customerAccounts: { ...policy, termsVersion: 'v2' } } }).where(eq(organizations.id, organizationId));
    const refreshed = await service.completeConsent(request(), result.consentToken, { ...policy, consentAccepted: true });
    expect('consentRequired' in refreshed).toBe(true);
    if (!('consentRequired' in refreshed)) throw new Error('Expected updated policy');
    expect(refreshed.policy.termsVersion).toBe('v2');
    expect('session' in await service.completeConsent(request(), refreshed.consentToken, { ...refreshed.policy, consentAccepted: true })).toBe(true);
    await database.db!.update(organizations).set({ settings: { customerAccounts: policy } }).where(eq(organizations.id, organizationId));
  });
  it('expires pending confirmation and rejects duplicate concurrent submission', async () => {
    const first = await verify(); if (!('consentRequired' in first.result)) throw new Error('Expected consent');
    await database.db!.update(customerAuthChallenges).set({ consentExpiresAt: new Date(0) }).where(and(eq(customerAuthChallenges.organizationId, organizationId), eq(customerAuthChallenges.mobileE164, `+86${first.mobile}`)));
    await expect(service.completeConsent(request(), first.result.consentToken, { ...policy, consentAccepted: true })).rejects.toMatchObject({ status: 401 });
    const second = await verify(); if (!('consentRequired' in second.result)) throw new Error('Expected consent');
    const token = second.result.consentToken;
    const outcomes = await Promise.allSettled([service.completeConsent(request(), token, { ...policy, consentAccepted: true }), service.completeConsent(request(), token, { ...policy, consentAccepted: true })]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
});
