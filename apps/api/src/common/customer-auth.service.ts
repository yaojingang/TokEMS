import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  CustomerIdentity,
  CustomerSession,
  RequestCustomerOtpResult,
  VerifyCustomerOtp,
} from '@conference/contracts';
import { API_ERROR_CODES, DEMO_IDS } from '@conference/contracts';
import {
  customerAuthChallenges,
  customerConsents,
  customerProfiles,
  customerSessions,
  customerUsers,
  notificationDeliveries,
  organizations,
  outboxEvents,
  publicUserIds,
} from '@conference/database';
import {
  createOpaqueToken,
  createOtpCode,
  csrfToken,
  hmacDigest,
  isLoopbackHostname,
  maskMobile,
  normalizeMainlandMobile,
  sealSecret,
  secureDigestEquals,
  sha256,
} from '@conference/security';
import { and, count, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';

export const CUSTOMER_SESSION_COOKIE = 'conference_customer_session';
export const CUSTOMER_SESSION_LIFETIME_SECONDS = 400 * 24 * 60 * 60;
const SESSION_LIFETIME_MS = CUSTOMER_SESSION_LIFETIME_SECONDS * 1_000;
const OTP_LIFETIME_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const FAKE_OTP_CODE = '123456';

type CustomerOtpMode = 'fake' | 'provider';

export function customerOtpIpHourlyLimit(mode: CustomerOtpMode) {
  return mode === 'fake' ? 10_000 : 20;
}

type CustomerProfileRow = typeof customerProfiles.$inferSelect;
type CustomerUserRow = typeof customerUsers.$inferSelect;

export interface AuthenticatedCustomer {
  sessionId: string;
  customerUserId: string;
  organizationId: string;
  tokenHash: string;
  expiresAt: Date;
  customer: CustomerIdentity;
  csrfToken: string;
}

interface MemoryCustomer {
  user: CustomerUserRow;
  profile: CustomerProfileRow;
  publicUserId: number;
}

interface MemoryChallenge {
  id: string;
  organizationId: string;
  mobile: string;
  digest: string;
  expiresAt: Date;
  attempts: number;
  consumed: boolean;
}

interface MemorySession {
  id: string;
  customerUserId: string;
  organizationId: string;
  tokenHash: string;
  expiresAt: Date;
  revoked: boolean;
}

function isLoopbackUrl(value: string | undefined) {
  if (!value) return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

@Injectable()
export class CustomerAuthService {
  private readonly memoryCustomers = new Map<string, MemoryCustomer>();
  private readonly memoryChallenges = new Map<string, MemoryChallenge>();
  private readonly memorySessions = new Map<string, MemorySession>();
  private nextMemoryPublicUserId = 102;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {
    const otpMode = this.otpMode();
    if (
      otpMode === 'fake' &&
      !(
        process.env.DEPLOYMENT_MODE === 'local' &&
        isLoopbackUrl(process.env.PUBLIC_WEB_URL) &&
        isLoopbackUrl(process.env.ADMIN_WEB_URL)
      )
    ) {
      throw new Error(
        'CUSTOMER_OTP_MODE=fake requires a local deployment with loopback public and admin origins',
      );
    }
    if (process.env.NODE_ENV === 'production' || process.env.DEPLOYMENT_MODE === 'production') {
      if (
        !process.env.CUSTOMER_OTP_PEPPER ||
        process.env.CUSTOMER_OTP_PEPPER.length < 32 ||
        [
          'conference-local-customer-otp-pepper-change-me-2026',
          'replace-with-at-least-32-random-characters',
        ].includes(process.env.CUSTOMER_OTP_PEPPER)
      ) {
        throw new Error(
          'CUSTOMER_OTP_PEPPER with at least 32 characters is required in production',
        );
      }
      if (
        !process.env.CUSTOMER_SESSION_SECRET ||
        process.env.CUSTOMER_SESSION_SECRET.length < 32 ||
        [
          'conference-local-customer-session-secret-2026',
          'replace-with-at-least-32-random-characters',
        ].includes(process.env.CUSTOMER_SESSION_SECRET)
      ) {
        throw new Error(
          'CUSTOMER_SESSION_SECRET with at least 32 characters is required in production',
        );
      }
      if (
        !process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET ||
        process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET.length < 32 ||
        [
          'conference-local-notification-payload-secret-2026',
          'replace-with-at-least-32-random-characters',
        ].includes(process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET)
      ) {
        throw new Error(
          'NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET with at least 32 characters is required in production',
        );
      }
    }
  }

  private otpMode(): CustomerOtpMode {
    const mode =
      process.env.CUSTOMER_OTP_MODE ??
      (process.env.DEPLOYMENT_MODE === 'local' ? 'fake' : 'provider');
    if (mode !== 'fake' && mode !== 'provider') {
      throw new Error('CUSTOMER_OTP_MODE must be fake or provider');
    }
    return mode;
  }

  private otpPepper() {
    return process.env.CUSTOMER_OTP_PEPPER ?? 'conference-customer-otp-development-pepper';
  }

  private sessionSecret() {
    return (
      process.env.CUSTOMER_SESSION_SECRET ??
      process.env.JWT_SECRET ??
      'conference-customer-session-development-secret'
    );
  }

  private notificationSecret() {
    return (
      process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET ??
      process.env.JWT_SECRET ??
      'conference-notification-payload-development-secret'
    );
  }

  private identity(
    user: CustomerUserRow,
    profile: CustomerProfileRow,
    publicUserId: number,
  ): CustomerIdentity {
    return {
      id: publicUserId,
      organizationId: user.organizationId,
      mobile: user.mobileE164,
      maskedMobile: maskMobile(user.mobileE164),
      status: user.status,
      verifiedAt: user.verifiedAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      profile: {
        nickname: profile.nickname,
        realName: profile.realName,
        email: profile.email,
        company: profile.company,
        title: profile.title,
        city: profile.city,
        version: profile.version,
      },
    };
  }

  private organizationSlug(request: FastifyRequest) {
    const header = request.headers['x-organization-slug'];
    return (
      (typeof header === 'string' ? header : undefined) ??
      process.env.PUBLIC_ORGANIZATION_SLUG ??
      'geo-conference'
    );
  }

  private async resolveOrganization(request: FastifyRequest) {
    const slug = this.organizationSlug(request);
    const db = this.database.db;
    if (!db) {
      return {
        id: DEMO_IDS.organization,
        slug,
        settings: {
          customerAccounts: {
            termsVersion: '',
            privacyVersion: '',
          },
        } as Record<string, unknown>,
      };
    }
    const [organization] = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        settings: organizations.settings,
      })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (!organization) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '组织不存在', HttpStatus.NOT_FOUND);
    }
    return organization;
  }

  private ipHash(request: FastifyRequest) {
    return sha256(`${this.otpPepper()}:${request.ip}`);
  }

  private sessionToken(request: FastifyRequest) {
    return request.cookies?.[CUSTOMER_SESSION_COOKIE];
  }

  async requestOtp(
    request: FastifyRequest,
    mobileInput: string,
  ): Promise<RequestCustomerOtpResult> {
    const organization = await this.resolveOrganization(request);
    let mobile: string;
    try {
      mobile = normalizeMainlandMobile(mobileInput);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '请输入有效的中国大陆手机号',
        HttpStatus.BAD_REQUEST,
      );
    }
    const fakeMode = this.otpMode() === 'fake';
    const code = fakeMode ? FAKE_OTP_CODE : createOtpCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OTP_LIFETIME_MS);
    const requestIpHash = this.ipHash(request);
    const db = this.database.db;
    let challengeId: string;

    if (!db) {
      const recentMobile = [...this.memoryChallenges.values()].filter(
        (challenge) =>
          challenge.organizationId === organization.id &&
          challenge.mobile === mobile &&
          challenge.expiresAt.getTime() > now.getTime() - 55 * 60_000,
      ).length;
      if (recentMobile >= 5) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '验证码请求过于频繁，请稍后再试',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      challengeId = crypto.randomUUID();
      this.memoryChallenges.set(challengeId, {
        id: challengeId,
        organizationId: organization.id,
        mobile,
        digest: hmacDigest(this.otpPepper(), `${challengeId}:${mobile}:${code}`),
        expiresAt,
        attempts: 0,
        consumed: false,
      });
    } else {
      challengeId = await db.transaction(async (tx) => {
        const platformMobileKey = hmacDigest(this.otpPepper(), mobile);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`customer-otp-platform:${platformMobileKey}`}, 0))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`customer-otp:${organization.id}:${mobile}`}, 0))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`customer-user:${organization.id}:${mobile}`}, 0))`,
        );
        const oneHourAgo = new Date(now.getTime() - 60 * 60_000);
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
        const [mobileUsage] = await tx
          .select({ value: count() })
          .from(customerAuthChallenges)
          .where(
            and(
              eq(customerAuthChallenges.organizationId, organization.id),
              eq(customerAuthChallenges.mobileE164, mobile),
              gte(customerAuthChallenges.createdAt, oneHourAgo),
            ),
          );
        const [platformMobileUsage] = await tx
          .select({ value: count() })
          .from(customerAuthChallenges)
          .where(
            and(
              eq(customerAuthChallenges.mobileE164, mobile),
              gte(customerAuthChallenges.createdAt, oneHourAgo),
            ),
          );
        const [ipUsage] = await tx
          .select({ value: count() })
          .from(customerAuthChallenges)
          .where(
            and(
              eq(customerAuthChallenges.requestIpHash, requestIpHash),
              gte(customerAuthChallenges.createdAt, oneHourAgo),
            ),
          );
        const [organizationUsage] = await tx
          .select({ value: count() })
          .from(customerAuthChallenges)
          .where(
            and(
              eq(customerAuthChallenges.organizationId, organization.id),
              gte(customerAuthChallenges.createdAt, oneDayAgo),
            ),
          );
        if (
          Number(mobileUsage?.value ?? 0) >= 5 ||
          Number(platformMobileUsage?.value ?? 0) >=
            Number(process.env.CUSTOMER_OTP_PLATFORM_HOURLY_LIMIT ?? 8) ||
          Number(ipUsage?.value ?? 0) >= customerOtpIpHourlyLimit(this.otpMode()) ||
          Number(organizationUsage?.value ?? 0) >=
            Number(process.env.CUSTOMER_OTP_ORG_DAILY_LIMIT ?? 10_000)
        ) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '验证码请求过于频繁，请稍后再试',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        await tx
          .update(customerAuthChallenges)
          .set({ invalidatedAt: now, updatedAt: now })
          .where(
            and(
              eq(customerAuthChallenges.organizationId, organization.id),
              eq(customerAuthChallenges.mobileE164, mobile),
              isNull(customerAuthChallenges.consumedAt),
              isNull(customerAuthChallenges.invalidatedAt),
            ),
          );
        const pendingId = crypto.randomUUID();
        const [challenge] = await tx
          .insert(customerAuthChallenges)
          .values({
            id: pendingId,
            organizationId: organization.id,
            mobileE164: mobile,
            codeDigest: hmacDigest(this.otpPepper(), `${pendingId}:${mobile}:${code}`),
            requestIpHash,
            expiresAt,
          })
          .returning({ id: customerAuthChallenges.id });
        if (!fakeMode) {
          const [delivery] = await tx
            .insert(notificationDeliveries)
            .values({
              organizationId: organization.id,
              channel: 'sms',
              recipient: mobile,
              subject: '登录验证码',
              body: '验证码在发送时解密，正文不保存在运营数据库中。',
            })
            .returning({ id: notificationDeliveries.id });
          await tx
            .update(customerAuthChallenges)
            .set({ deliveryId: delivery!.id, updatedAt: now })
            .where(eq(customerAuthChallenges.id, challenge!.id));
          await tx.insert(outboxEvents).values({
            organizationId: organization.id,
            eventType: 'CustomerOtpRequested',
            correlationId: `customer-otp:${challenge!.id}`,
            payload: {
              challengeId: challenge!.id,
              deliveryId: delivery!.id,
              sealedCode: sealSecret(code, this.notificationSecret()),
            },
          });
        }
        return challenge!.id;
      });
    }

    return {
      challengeId,
      accepted: true,
      retryAfterSeconds: 60,
      expiresAt: expiresAt.toISOString(),
      ...(fakeMode ? { developmentCode: code } : {}),
    };
  }

  async verifyOtp(
    request: FastifyRequest,
    input: VerifyCustomerOtp,
  ): Promise<{ session: CustomerSession; token: string }> {
    const organization = await this.resolveOrganization(request);
    let mobile: string;
    try {
      mobile = normalizeMainlandMobile(input.mobile);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '手机号或验证码不正确',
        HttpStatus.BAD_REQUEST,
      );
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    const rawToken = createOpaqueToken();
    const tokenHash = sha256(rawToken);
    const db = this.database.db;
    let authenticated: AuthenticatedCustomer;

    if (!db) {
      const challenge = this.memoryChallenges.get(input.challengeId);
      const expected = hmacDigest(this.otpPepper(), `${input.challengeId}:${mobile}:${input.code}`);
      if (
        !challenge ||
        challenge.organizationId !== organization.id ||
        challenge.mobile !== mobile ||
        challenge.consumed ||
        challenge.expiresAt <= now ||
        challenge.attempts >= OTP_MAX_ATTEMPTS ||
        !secureDigestEquals(challenge.digest, expected)
      ) {
        if (challenge) challenge.attempts += 1;
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '验证码不正确或已经失效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      challenge.consumed = true;
      const customerKey = `${organization.id}:${mobile}`;
      let customer = this.memoryCustomers.get(customerKey);
      if (!customer) {
        const id = crypto.randomUUID();
        customer = {
          user: {
            id,
            organizationId: organization.id,
            mobileE164: mobile,
            status: 'active',
            verifiedAt: now,
            lastLoginAt: now,
            lastRegistrationAt: null,
            internalNote: '',
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
          profile: {
            customerUserId: id,
            nickname: null,
            realName: null,
            email: null,
            company: null,
            title: null,
            city: null,
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
          publicUserId: this.nextMemoryPublicUserId++,
        };
        this.memoryCustomers.set(customerKey, customer);
      } else {
        customer.user.lastLoginAt = now;
        customer.user.updatedAt = now;
      }
      const memorySession: MemorySession = {
        id: crypto.randomUUID(),
        customerUserId: customer.user.id,
        organizationId: organization.id,
        tokenHash,
        expiresAt,
        revoked: false,
      };
      this.memorySessions.set(tokenHash, memorySession);
      authenticated = {
        sessionId: memorySession.id,
        customerUserId: customer.user.id,
        organizationId: organization.id,
        tokenHash,
        expiresAt,
        customer: this.identity(customer.user, customer.profile, customer.publicUserId),
        csrfToken: csrfToken(memorySession.id, this.sessionSecret()),
      };
    } else {
      const verified = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`customer-user:${organization.id}:${mobile}`}, 0))`,
        );
        const [challenge] = await tx
          .select()
          .from(customerAuthChallenges)
          .where(
            and(
              eq(customerAuthChallenges.id, input.challengeId),
              eq(customerAuthChallenges.organizationId, organization.id),
              eq(customerAuthChallenges.mobileE164, mobile),
            ),
          )
          .for('update')
          .limit(1);
        const expected = hmacDigest(
          this.otpPepper(),
          `${input.challengeId}:${mobile}:${input.code}`,
        );
        if (
          !challenge ||
          challenge.consumedAt ||
          challenge.invalidatedAt ||
          challenge.expiresAt <= now ||
          challenge.attempts >= OTP_MAX_ATTEMPTS ||
          !secureDigestEquals(challenge.codeDigest, expected)
        ) {
          if (challenge) {
            await tx
              .update(customerAuthChallenges)
              .set({
                attempts: challenge.attempts + 1,
                ...(challenge.attempts + 1 >= OTP_MAX_ATTEMPTS ? { invalidatedAt: now } : {}),
                updatedAt: now,
              })
              .where(eq(customerAuthChallenges.id, challenge.id));
          }
          return null;
        }
        await tx
          .update(customerAuthChallenges)
          .set({ consumedAt: now, updatedAt: now })
          .where(eq(customerAuthChallenges.id, challenge.id));

        let [user] = await tx
          .select()
          .from(customerUsers)
          .where(
            and(
              eq(customerUsers.organizationId, organization.id),
              eq(customerUsers.mobileE164, mobile),
            ),
          )
          .for('update')
          .limit(1);
        if (!user) {
          [user] = await tx
            .insert(customerUsers)
            .values({
              organizationId: organization.id,
              mobileE164: mobile,
              verifiedAt: now,
              lastLoginAt: now,
            })
            .returning();
        } else {
          if (user.status !== 'active') {
            throw new DomainError(
              API_ERROR_CODES.FORBIDDEN,
              '账号当前无法登录，请联系大会主办方',
              HttpStatus.FORBIDDEN,
            );
          }
          [user] = await tx
            .update(customerUsers)
            .set({ lastLoginAt: now, updatedAt: now })
            .where(eq(customerUsers.id, user.id))
            .returning();
        }
        await tx
          .insert(customerProfiles)
          .values({ customerUserId: user!.id })
          .onConflictDoNothing();
        const [profile] = await tx
          .select()
          .from(customerProfiles)
          .where(eq(customerProfiles.customerUserId, user!.id))
          .limit(1);
        const [publicIdRow] = await tx
          .select({ publicId: publicUserIds.publicId })
          .from(publicUserIds)
          .where(
            and(
              eq(publicUserIds.subjectType, 'customer'),
              eq(publicUserIds.subjectUuid, user!.id),
              isNull(publicUserIds.retiredAt),
            ),
          )
          .limit(1);
        if (!publicIdRow) throw new Error('用户缺少数字用户 ID');
        const accountSettings =
          organization.settings &&
          typeof organization.settings === 'object' &&
          'customerAccounts' in organization.settings &&
          organization.settings.customerAccounts &&
          typeof organization.settings.customerAccounts === 'object'
            ? (organization.settings.customerAccounts as Record<string, unknown>)
            : {};
        const expectedTerms = String(accountSettings.termsVersion ?? '');
        const expectedPrivacy = String(accountSettings.privacyVersion ?? '');
        if (
          (expectedTerms && input.termsVersion !== expectedTerms) ||
          (expectedPrivacy && input.privacyVersion !== expectedPrivacy)
        ) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '用户协议或隐私政策已经更新，请刷新后重新确认',
            HttpStatus.CONFLICT,
          );
        }
        const consentRows = [
          ...(input.termsVersion
            ? [
                {
                  customerUserId: user!.id,
                  consentType: 'terms',
                  version: input.termsVersion,
                  source: 'customer_login',
                  requestIpHash: this.ipHash(request),
                },
              ]
            : []),
          ...(input.privacyVersion
            ? [
                {
                  customerUserId: user!.id,
                  consentType: 'privacy',
                  version: input.privacyVersion,
                  source: 'customer_login',
                  requestIpHash: this.ipHash(request),
                },
              ]
            : []),
        ];
        if (consentRows.length) {
          await tx.insert(customerConsents).values(consentRows).onConflictDoNothing();
        }
        const [session] = await tx
          .insert(customerSessions)
          .values({
            customerUserId: user!.id,
            organizationId: organization.id,
            tokenHash,
            userAgentHash: request.headers['user-agent']
              ? sha256(String(request.headers['user-agent']))
              : null,
            expiresAt,
          })
          .returning();
        return {
          sessionId: session!.id,
          customerUserId: user!.id,
          organizationId: organization.id,
          tokenHash,
          expiresAt,
          customer: this.identity(user!, profile!, publicIdRow.publicId),
          csrfToken: csrfToken(session!.id, this.sessionSecret()),
        };
      });
      if (!verified) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '验证码不正确或已经失效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      authenticated = verified;
    }

    return {
      token: rawToken,
      session: {
        authenticated: true,
        customer: authenticated.customer,
        csrfToken: authenticated.csrfToken,
        expiresAt: authenticated.expiresAt.toISOString(),
      },
    };
  }

  async optionalSession(request: FastifyRequest): Promise<AuthenticatedCustomer | null> {
    const rawToken = this.sessionToken(request);
    if (!rawToken || rawToken.length < 32 || rawToken.length > 500) return null;
    const tokenHash = sha256(rawToken);
    const db = this.database.db;
    if (!db) {
      const session = this.memorySessions.get(tokenHash);
      if (!session || session.revoked || session.expiresAt <= new Date()) return null;
      const customer = [...this.memoryCustomers.values()].find(
        (item) => item.user.id === session.customerUserId,
      );
      if (!customer || customer.user.status !== 'active') return null;
      return {
        sessionId: session.id,
        customerUserId: customer.user.id,
        organizationId: session.organizationId,
        tokenHash,
        expiresAt: session.expiresAt,
        customer: this.identity(customer.user, customer.profile, customer.publicUserId),
        csrfToken: csrfToken(session.id, this.sessionSecret()),
      };
    }
    const [row] = await db
      .select({
        session: customerSessions,
        user: customerUsers,
        profile: customerProfiles,
        publicUserId: publicUserIds.publicId,
      })
      .from(customerSessions)
      .innerJoin(customerUsers, eq(customerUsers.id, customerSessions.customerUserId))
      .innerJoin(customerProfiles, eq(customerProfiles.customerUserId, customerUsers.id))
      .innerJoin(
        publicUserIds,
        and(
          eq(publicUserIds.subjectType, 'customer'),
          eq(publicUserIds.subjectUuid, customerUsers.id),
          isNull(publicUserIds.retiredAt),
        ),
      )
      .where(
        and(
          eq(customerSessions.tokenHash, tokenHash),
          eq(customerSessions.organizationId, customerUsers.organizationId),
          isNull(customerSessions.revokedAt),
          gte(customerSessions.expiresAt, new Date()),
          eq(customerUsers.status, 'active'),
        ),
      )
      .limit(1);
    if (!row) return null;
    const organization = await this.resolveOrganization(request);
    if (organization.id !== row.session.organizationId) return null;
    if (row.session.lastUsedAt.getTime() < Date.now() - 6 * 60 * 60_000) {
      await db
        .update(customerSessions)
        .set({ lastUsedAt: new Date(), updatedAt: new Date() })
        .where(eq(customerSessions.id, row.session.id));
    }
    return {
      sessionId: row.session.id,
      customerUserId: row.user.id,
      organizationId: row.user.organizationId,
      tokenHash,
      expiresAt: row.session.expiresAt,
      customer: this.identity(row.user, row.profile, row.publicUserId),
      csrfToken: csrfToken(row.session.id, this.sessionSecret()),
    };
  }

  async requireSession(request: FastifyRequest) {
    const session = await this.optionalSession(request);
    if (!session) {
      throw new DomainError(API_ERROR_CODES.UNAUTHORIZED, '请先登录', HttpStatus.UNAUTHORIZED);
    }
    return session;
  }

  validateCsrf(request: FastifyRequest, session: AuthenticatedCustomer) {
    const received = request.headers['x-csrf-token'];
    const supplied = typeof received === 'string' ? received : '';
    if (
      !supplied ||
      !secureDigestEquals(
        hmacDigest(this.sessionSecret(), supplied),
        hmacDigest(this.sessionSecret(), session.csrfToken),
      )
    ) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '页面安全校验已失效，请刷新后重试',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  async revokeSession(session: AuthenticatedCustomer) {
    if (!this.database.db) {
      const value = this.memorySessions.get(session.tokenHash);
      if (value) value.revoked = true;
      return;
    }
    await this.database.db
      .update(customerSessions)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(customerSessions.id, session.sessionId));
  }

  async revokeAllSessions(session: AuthenticatedCustomer) {
    if (!this.database.db) {
      for (const value of this.memorySessions.values()) {
        if (value.customerUserId === session.customerUserId) value.revoked = true;
      }
      return;
    }
    await this.database.db
      .update(customerSessions)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(customerSessions.customerUserId, session.customerUserId),
          isNull(customerSessions.revokedAt),
        ),
      );
  }
}
