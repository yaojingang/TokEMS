import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PARTNER_POSTER_FIELDS,
  DEFAULT_PARTNER_VISIBLE_FIELDS,
  PartnerProgramDraftSchema,
} from '@conference/contracts';
import {
  createDatabase,
  customerMediaAssets,
  eventPartnerProfileVersions,
  eventPartnerProgramVersions,
  eventPartners,
  events,
  organizations,
  partnerReferralLinks,
  partnerReferralVisitDays,
  users,
} from '@conference/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerDistributionService } from './partner-distribution.service.js';
import type { DatabaseService } from './database.service.js';
import type { RedisService } from './redis.service.js';
import type { AuthenticatedCustomer } from './customer-auth.service.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;
persistent('administrator partner promotion materials with PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(() => {
    connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL);
  });
  afterAll(async () => {
    await connection.pool.end();
  });
  async function fixture() {
    const db = connection.db;
    const organizationId = randomUUID();
    const actorId = randomUUID();
    await db.insert(organizations).values({
      id: organizationId,
      slug: `materials-${organizationId}`,
      name: '推广素材验收组织',
    });
    await db
      .insert(users)
      .values({ id: actorId, email: `materials-${actorId}@example.test`, name: '素材管理员' });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `materials-${organizationId}`,
        name: '合作伙伴素材验收大会',
        shortName: '素材验收',
        tagline: '分享大会',
        description: '管理员素材领取验证',
        status: 'registration_open',
        startsAt: new Date('2027-11-01T01:00:00Z'),
        endsAt: new Date('2027-11-01T10:00:00Z'),
        timezone: 'Asia/Shanghai',
        venue: '会场',
        city: '深圳',
        address: '会场地址',
      })
      .returning();
    const service = new PartnerDistributionService({ db } as DatabaseService, {} as RedisService);
    const draft = PartnerProgramDraftSchema.parse({
      termsTitle: '合作规则',
      termsContent: '确认后推广',
      promotionPolicy: '真实推广',
    });
    const program = await service.publishProgram(organizationId, event!.id, actorId, draft);
    const enabled = await service.enablePartner(organizationId, event!.id, actorId, {
      mobile: '13800138000',
      displayName: '林安',
      company: '远见科技',
      personalRateBps: null,
      sortOrder: 0,
      internalNote: 'private-internal-note',
      sendInvitation: false,
    });
    const [partner] = await db.select().from(eventPartners).where(eq(eventPartners.id, enabled.id));
    const session = {
      sessionId: randomUUID(),
      organizationId,
      customerUserId: partner!.customerUserId,
      tokenHash: 'test',
      expiresAt: new Date(Date.now() + 60000),
      customer: {} as AuthenticatedCustomer['customer'],
      csrfToken: 'test',
    } satisfies AuthenticatedCustomer;
    return {
      db,
      organizationId,
      actorId,
      event: event!,
      program: program!,
      service,
      partner: partner!,
      draft,
      session,
    };
  }
  it('provides pending materials without publishing the profile, accepting rules or recording visits', async () => {
    const f = await fixture();
    const result = await f.service.adminPromotion(f.organizationId, f.event.id, f.partner.id);
    expect(result).toMatchObject({
      availability: 'pending_confirmation',
      referralPath: expect.stringMatching(/^\/r\//),
      eventId: f.event.id,
    });
    const [persisted] = await f.db
      .select()
      .from(eventPartners)
      .where(eq(eventPartners.id, f.partner.id));
    expect(persisted).toMatchObject({
      acceptedProgramVersionId: null,
      attributionEnabled: false,
      qualificationStatus: 'pending_confirmation',
    });
    expect(
      await f.db
        .select()
        .from(partnerReferralVisitDays)
        .where(eq(partnerReferralVisitDays.partnerId, f.partner.id)),
    ).toHaveLength(0);
    for (const key of ['loginMobile', 'internalNote', 'balances'])
      expect(result).not.toHaveProperty(key);
    for (const key of ['contactPhone', 'contactEmail', 'wechatId', 'gallery'])
      expect(result.profile).not.toHaveProperty(key);
    await f.service.acceptProgram(
      f.session,
      f.event.id,
      f.program.id,
      f.partner.version,
      '127.0.0.1',
      'test',
    );
    const active = await f.service.adminPromotion(f.organizationId, f.event.id, f.partner.id);
    expect(active.availability).toBe('ready');
    expect(active.referralPath).toBe(result.referralPath);
    await f.service.publishProgram(f.organizationId, f.event.id, f.actorId, f.draft);
    const changed = await f.service.adminPromotion(f.organizationId, f.event.id, f.partner.id);
    expect(changed.availability).toBe('pending_confirmation');
    expect(changed.referralPath).toBe(result.referralPath);
  });
  it('returns the latest administrative fields when a mobile already belongs to a partner', async () => {
    const f = await fixture();
    await f.db
      .update(eventPartners)
      .set({ sortOrder: 17, internalNote: '原合作约定' })
      .where(eq(eventPartners.id, f.partner.id));
    const duplicate = await f.service.enablePartner(f.organizationId, f.event.id, f.actorId, {
      mobile: '13800138000',
      displayName: '本次输入',
      company: '',
      personalRateBps: null,
      sortOrder: 0,
      internalNote: '不得覆盖',
      sendInvitation: false,
    });
    expect(duplicate).toMatchObject({
      id: f.partner.id,
      created: false,
      sortOrder: 17,
      internalNote: '原合作约定',
      loginMobile: '+8613800138000',
    });
    expect(duplicate.profile.displayName).toBe('林安');
  });
  it.each([
    'paused',
    'closed',
    'attribution',
    'expired',
    'disabled',
    'missing',
    'program',
  ] as const)('blocks %s materials', async (kind) => {
    const f = await fixture();
    await f.service.acceptProgram(
      f.session,
      f.event.id,
      f.program.id,
      f.partner.version,
      '127.0.0.1',
      'test',
    );
    if (kind === 'paused' || kind === 'closed')
      await f.db
        .update(eventPartners)
        .set({ qualificationStatus: kind })
        .where(eq(eventPartners.id, f.partner.id));
    if (kind === 'attribution')
      await f.db
        .update(eventPartners)
        .set({ attributionEnabled: false })
        .where(eq(eventPartners.id, f.partner.id));
    if (kind === 'expired')
      await f.db
        .update(partnerReferralLinks)
        .set({ expiresAt: new Date(0) })
        .where(eq(partnerReferralLinks.partnerId, f.partner.id));
    if (kind === 'disabled')
      await f.db
        .update(partnerReferralLinks)
        .set({ status: 'disabled' })
        .where(eq(partnerReferralLinks.partnerId, f.partner.id));
    if (kind === 'missing')
      await f.db
        .delete(partnerReferralLinks)
        .where(eq(partnerReferralLinks.partnerId, f.partner.id));
    if (kind === 'program')
      await f.db
        .update(eventPartnerProgramVersions)
        .set({ status: 'retired' })
        .where(eq(eventPartnerProgramVersions.id, f.program.id));
    const result = await f.service.adminPromotion(f.organizationId, f.event.id, f.partner.id);
    expect(result.availability).toBe('unavailable');
    expect(result.reason).not.toBe('');
  });
  it('binds avatar access to the organization, event, profile version and authorization', async () => {
    const f = await fixture();
    const avatarId = randomUUID();
    await f.db.insert(customerMediaAssets).values({
      id: avatarId,
      organizationId: f.organizationId,
      customerUserId: f.partner.customerUserId,
      kind: 'partner_avatar',
      sourceStorageKey: `private/${avatarId}.png`,
      mediaType: 'image/png',
      size: 100,
      contentDigest: '0'.repeat(64),
      status: 'ready',
    });
    await f.db
      .update(eventPartnerProfileVersions)
      .set({
        avatarAssetId: avatarId,
        visibleFields: DEFAULT_PARTNER_VISIBLE_FIELDS,
        posterFields: DEFAULT_PARTNER_POSTER_FIELDS,
      })
      .where(eq(eventPartnerProfileVersions.partnerId, f.partner.id));
    expect(
      (await f.service.adminPromotion(f.organizationId, f.event.id, f.partner.id)).profile
        .avatarUrl,
    ).toContain('version=1');
    expect(
      await f.service.adminPromotionAvatarScope(f.organizationId, f.event.id, f.partner.id, 1),
    ).toEqual({
      organizationId: f.organizationId,
      customerUserId: f.partner.customerUserId,
      assetId: avatarId,
    });
    await expect(
      f.service.adminPromotion(randomUUID(), f.event.id, f.partner.id),
    ).rejects.toThrow();
    await expect(
      f.service.adminPromotion(f.organizationId, f.event.id + 1, f.partner.id),
    ).rejects.toThrow();
    await expect(
      f.service.adminPromotionAvatarScope(randomUUID(), f.event.id, f.partner.id, 1),
    ).rejects.toThrow();
    await expect(
      f.service.adminPromotionAvatarScope(f.organizationId, f.event.id + 1, f.partner.id, 1),
    ).rejects.toThrow();
    await expect(
      f.service.adminPromotionAvatarScope(f.organizationId, f.event.id, f.partner.id, 2),
    ).rejects.toThrow();
    await f.db
      .update(eventPartnerProfileVersions)
      .set({
        posterFields: { ...DEFAULT_PARTNER_POSTER_FIELDS, avatar: false, displayName: false },
      })
      .where(eq(eventPartnerProfileVersions.partnerId, f.partner.id));
    const hidden = await f.service.adminPromotion(f.organizationId, f.event.id, f.partner.id);
    expect(hidden.profile.avatarUrl).toBeNull();
    expect(hidden.profile.displayName).toBe('');
    await expect(
      f.service.adminPromotionAvatarScope(f.organizationId, f.event.id, f.partner.id, 1),
    ).rejects.toThrow();
  });
});
