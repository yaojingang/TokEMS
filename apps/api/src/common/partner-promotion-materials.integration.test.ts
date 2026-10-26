import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_PARTNER_POSTER_FIELDS,
  DEFAULT_PARTNER_VISIBLE_FIELDS,
  PartnerProgramDraftSchema,
} from '@conference/contracts';
import {
  createDatabase,
  auditLogs,
  customerUsers,
  orders, orderItems, registrations, ticketTypes, payments,
  partnerAttributionRevisions, partnerCommissions, partnerFinancialEventInbox, partnerLedgerEntries,
  eventPartnerRuleAcceptances,
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PartnerDistributionService } from './partner-distribution.service.js';
import type { DatabaseService } from './database.service.js';
import type { RedisService } from './redis.service.js';
import type { AuthenticatedCustomer } from './customer-auth.service.js';

import { AttendeeShowcaseService } from './attendee-showcase.service.js';
import { lockPartnerAttribution } from './partner-attribution.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;
persistent('administrator partner promotion materials with PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(() => {
    connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL);
  });
  afterAll(async () => {
    await connection.pool.end();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
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
  it('provides ready materials immediately without accepting rules or recording visits', async () => {
    const f = await fixture();
    const result = await f.service.adminPromotion(f.organizationId, f.event.id, f.partner.id);
    expect(result).toMatchObject({
      availability: 'ready',
      referralPath: expect.stringMatching(/^\/r\//),
      eventId: f.event.id,
    });
    const [persisted] = await f.db
      .select()
      .from(eventPartners)
      .where(eq(eventPartners.id, f.partner.id));
    expect(persisted).toMatchObject({
      acceptedProgramVersionId: null,
      attributionEnabled: true,
      qualificationStatus: 'active',
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
    expect(changed.availability).toBe('ready');
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
    const preservedAvatar = await f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId, {
      expectedVersion: f.partner.version, displayName: '林安', company: '远见科技', title: '', industry: '',
      businessIntro: '', businessUrl: '', personalRateBps: null, sortOrder: 0, internalNote: 'private-internal-note', avatarAssetId: avatarId,
    });
    expect(preservedAvatar.version).toBe(f.partner.version);
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
  it('creates a paid commission without acceptance and keeps locked program and personal rates after changes', async () => {
    const f = await fixture();
    const buyerId = randomUUID();
    await f.db.insert(customerUsers).values({ id: buyerId, organizationId: f.organizationId, mobileE164: '+8613800138001' });
    const [ticket] = await f.db.insert(ticketTypes).values({ organizationId: f.organizationId, eventId: f.event.id,
      code: 'PARTNER', name: '测试票', description: '', price: 10000, currency: 'CNY', capacity: 100 }).returning();
    const [registration] = await f.db.insert(registrations).values({ organizationId: f.organizationId, eventId: f.event.id,
      ticketTypeId: ticket!.id, registrationCode: `R${randomUUID().slice(0, 20)}`, status: 'confirmed',
      attendee: { name: '购买人', mobile: '13800138001', email: 'buyer@example.test', company: '', title: '', city: '深圳' },
      attendeeMobileE164: '+8613800138001', attendeeEmailNormalized: 'buyer@example.test' }).returning();
    const [link] = await f.db.select().from(partnerReferralLinks).where(eq(partnerReferralLinks.partnerId, f.partner.id));
    const context = { organizationId: f.organizationId, eventId: f.event.id, partnerId: f.partner.id,
      referralLinkId: link!.id, expiresAt: new Date(Date.now() + 60000).toISOString() };
    const { order, revisionId } = await f.db.transaction(async tx => {
      const [order] = await tx.insert(orders).values({ organizationId: f.organizationId, eventId: f.event.id,
        registrationId: registration!.id, modelVersion: 2, quantity: 1, purchaserCustomerUserId: buyerId,
        purchaseIntentId: randomUUID(), orderNo: `P${randomUUID().slice(0, 20)}`, status: 'paid', amount: 10000,
        currency: 'CNY', pricingSnapshot: { refundPolicy: { enabled: false } }, expiresAt: new Date(Date.now() + 60000) }).returning();
      await tx.insert(orderItems).values({ orderId: order!.id, registrationId: registration!.id,
        organizationId: f.organizationId, eventId: f.event.id, position: 1, ticketTypeId: ticket!.id,
        unitPrice: 10000, allocatedAmount: 10000, pricingSnapshot: { unitPrice: 10000 }, state: 'active' });
      const revisionId = await lockPartnerAttribution(tx, order!, context);
      const [payment] = await tx.insert(payments).values({ orderId: order!.id, partnerAttributionRevisionId: revisionId,
        provider: 'partner-test', status: 'succeeded', amount: 10000, currency: 'CNY', succeededAt: new Date() }).returning();
      await tx.update(orders).set({ settledPaymentId: payment!.id }).where(eq(orders.id, order!.id));
      await tx.insert(partnerFinancialEventInbox).values({ organizationId: f.organizationId, eventId: f.event.id,
        eventType: 'PaymentSucceeded', eventKey: `automatic:${payment!.id}`, payload: { orderId: order!.id } });
      return { order: order!, revisionId };
    });
    await f.service.publishProgram(f.organizationId, f.event.id, f.actorId, { ...f.draft, fixedRateBps: 2500 });
    const current = await f.service.accountPartnership(f.session, f.event.id);
    await f.service.updatePartner(f.organizationId, f.event.id, f.partner.id, f.actorId, { expectedVersion: current.version, personalRateBps: 5000 });
    const workerPath = new URL('../../../worker/src/partner-financial.worker.ts', import.meta.url).href;
    const worker = await import(workerPath);
    await worker.processPartnerFinancialInbox(f.db);
    const [revision] = await f.db.select().from(partnerAttributionRevisions).where(eq(partnerAttributionRevisions.id, revisionId!));
    const [commission] = await f.db.select().from(partnerCommissions).where(eq(partnerCommissions.orderId, order.id));
    expect(revision).toMatchObject({ decision: 'attributed', programVersionId: f.program.id, personalRateBps: null });
    expect(commission).toMatchObject({ programVersionId: f.program.id, commissionAmount: 1000 });
    expect(await f.db.select().from(partnerLedgerEntries).where(eq(partnerLedgerEntries.partnerId, f.partner.id))).toEqual(expect.arrayContaining([expect.objectContaining({ amount: 1000, balanceBucket: 'pending' })]));
    expect(await f.db.select().from(eventPartnerRuleAcceptances).where(eq(eventPartnerRuleAcceptances.partnerId, f.partner.id))).toHaveLength(0);
  });

  it('confirms scoped staff uploads, exposes processing/ready/failed status, and saves one atomic details version', async () => {
    const f = await fixture();
    vi.stubEnv('S3_ENDPOINT', 'https://storage.example.test');
    vi.stubEnv('S3_BUCKET', 'partners'); vi.stubEnv('S3_ACCESS_KEY', 'test'); vi.stubEnv('S3_SECRET_KEY', 'test');
    const showcase = new AttendeeShowcaseService({ db: f.db } as DatabaseService, {} as never);
    const image = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const digest = createHash('sha256').update(image).digest('hex');
    const scope = await f.service.adminPartnerMediaScope(f.organizationId, f.event.id, f.partner.id);
    const upload = await showcase.preparePartnerMediaUpload(scope, f.event.id,
      { kind: 'avatar', fileName: 'avatar.png', mediaType: 'image/png', size: image.length, contentDigest: digest }, { actorId: f.actorId, partnerId: f.partner.id });
    expect(await f.service.adminPartnerMediaStatus(f.organizationId, f.event.id, f.partner.id, upload.uploadToken)).toMatchObject({ status: 'processing' });
    const base = { expectedVersion: f.partner.version, displayName: '统一修改', company: '公司', title: '职位', industry: '',
      businessIntro: '', businessUrl: '', personalRateBps: 500, sortOrder: 8, internalNote: '内部备注', avatarAssetId: upload.uploadToken,
      posterCopy: { invitation: '现场见', introduction: '认识更多同行' }, posterFields: DEFAULT_PARTNER_POSTER_FIELDS };
    await expect(f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId, base)).rejects.toThrow('头像尚未处理完成');
    await f.db.update(customerMediaAssets).set({ status: 'ready', outputStorageKey: `ready/${upload.uploadToken}` }).where(eq(customerMediaAssets.id, upload.uploadToken));
    await expect(f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId, base)).rejects.toThrow('头像尚未处理完成');
    await f.db.update(customerMediaAssets).set({ status: 'processing', outputStorageKey: null }).where(eq(customerMediaAssets.id, upload.uploadToken));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(image)));
    await showcase.confirmPartnerMedia(scope, f.event.id, { uploadToken: upload.uploadToken, contentDigest: digest }, { actorId: f.actorId, partnerId: f.partner.id });
    await expect(f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId, base)).rejects.toThrow('头像尚未处理完成');
    await f.db.update(customerMediaAssets).set({ status: 'ready', outputStorageKey: `ready/${upload.uploadToken}` }).where(eq(customerMediaAssets.id, upload.uploadToken));
    expect(await f.service.adminPartnerMediaStatus(f.organizationId, f.event.id, f.partner.id, upload.uploadToken)).toMatchObject({ status: 'ready' });
    const result = await f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId, base);
    expect(result).toMatchObject({ version: f.partner.version + 1, personalRateBps: 500,
      profile: { version: 2, displayName: '统一修改', posterCopy: base.posterCopy, visibleFields: DEFAULT_PARTNER_VISIBLE_FIELDS,
        publicStatus: 'draft', contactPhone: '+8613800138000', gallery: [] } });
    await expect(f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId, base)).rejects.toThrow('请刷新后重试');
    await expect(f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId,
      { ...base, expectedVersion: result.version, posterFields: { ...DEFAULT_PARTNER_POSTER_FIELDS, contactPhone: true } })).rejects.toThrow('公开展示授权');
    await expect(f.service.adminPartnerMediaStatus(f.organizationId, f.event.id + 1, f.partner.id, upload.uploadToken)).rejects.toThrow();
    await expect(f.service.adminPartnerMediaStatus(randomUUID(), f.event.id, f.partner.id, upload.uploadToken)).rejects.toThrow();
    const attempts = [
      { ...base, expectedVersion: result.version, displayName: '并发甲', posterCopy: { invitation: '甲邀请', introduction: '甲介绍' }, personalRateBps: 700 },
      { ...base, expectedVersion: result.version, displayName: '并发乙', posterCopy: { invitation: '乙邀请', introduction: '乙介绍' }, personalRateBps: 800 },
    ];
    const concurrent = await Promise.allSettled(attempts.map(input => f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId, input)));
    expect(concurrent.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const winner = attempts[concurrent.findIndex(item => item.status === 'fulfilled')]!;
    const afterConcurrent = await f.service.accountPartnership(f.session, f.event.id);
    expect(afterConcurrent).toMatchObject({ personalRateBps: winner.personalRateBps,
      profile: { displayName: winner.displayName, posterCopy: winner.posterCopy, version: 3 } });
    const unchanged = await f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId,
      { ...winner, expectedVersion: afterConcurrent.version });
    expect(unchanged.version).toBe(afterConcurrent.version);
    const otherOwner = randomUUID();
    await f.db.insert(customerUsers).values({ id: otherOwner, organizationId: f.organizationId, mobileE164: '+8613800138002' });
    for (const [customerUserId, kind] of [[otherOwner, 'avatar'], [f.partner.customerUserId, 'gallery']] as const) {
      const invalid = await showcase.preparePartnerMediaUpload({ organizationId: f.organizationId, customerUserId }, f.event.id,
        { kind, fileName: 'invalid.png', mediaType: 'image/png', size: image.length, contentDigest: digest }, { actorId: f.actorId, partnerId: f.partner.id });
      await f.db.update(customerMediaAssets).set({ status: 'ready', confirmedAt: new Date(), outputStorageKey: `ready/${invalid.uploadToken}` }).where(eq(customerMediaAssets.id, invalid.uploadToken));
      await expect(f.service.adminPartnerMediaStatus(f.organizationId, f.event.id, f.partner.id, invalid.uploadToken)).rejects.toThrow('图片不存在');
      await expect(f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId,
        { ...base, expectedVersion: afterConcurrent.version, avatarAssetId: invalid.uploadToken })).rejects.toThrow('头像尚未处理完成');
    }
    const [otherEvent] = await f.db.insert(events).values({ organizationId: f.organizationId,
      slug: `other-event-${randomUUID()}`, name: '另一大会', shortName: '另一大会', tagline: '测试', description: '范围测试',
      status: 'registration_open', startsAt: f.event.startsAt, endsAt: f.event.endsAt, timezone: 'Asia/Shanghai',
      venue: '会场', city: '深圳', address: '会场' }).returning();
    const [otherProgram] = await f.db.insert(eventPartnerProgramVersions).values({ organizationId: f.organizationId, eventId: otherEvent!.id,
      version: 1, status: 'active', termsTitle: '规则', termsContent: '规则正文', promotionPolicy: '推广规范', contentHash: '1'.repeat(64) }).returning();
    const [otherPartner] = await f.db.insert(eventPartners).values({ organizationId: f.organizationId, eventId: otherEvent!.id,
      customerUserId: f.partner.customerUserId, publicSlug: `same-owner-${randomUUID().slice(0, 12)}`,
      qualificationStatus: 'active', attributionEnabled: true, currentProgramVersionId: otherProgram!.id }).returning();
    const foreignEventUpload = await showcase.preparePartnerMediaUpload(scope, otherEvent!.id,
      { kind: 'avatar', fileName: 'another-event.png', mediaType: 'image/png', size: image.length, contentDigest: digest },
      { actorId: f.actorId, partnerId: otherPartner!.id });
    await f.db.update(customerMediaAssets).set({ status: 'ready', confirmedAt: new Date(), outputStorageKey: `ready/${foreignEventUpload.uploadToken}` })
      .where(eq(customerMediaAssets.id, foreignEventUpload.uploadToken));
    expect(await f.service.adminPartnerMediaStatus(f.organizationId, otherEvent!.id, otherPartner!.id, foreignEventUpload.uploadToken)).toMatchObject({ status: 'ready' });
    await expect(f.service.adminPartnerMediaStatus(f.organizationId, f.event.id, f.partner.id, foreignEventUpload.uploadToken)).rejects.toThrow('图片不存在');
    await expect(f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId,
      { ...winner, expectedVersion: afterConcurrent.version, avatarAssetId: foreignEventUpload.uploadToken })).rejects.toThrow('头像尚未处理完成');
    await f.service.updatePartnerDetails(f.organizationId, f.event.id, f.partner.id, f.actorId,
      { ...winner, expectedVersion: afterConcurrent.version, avatarAssetId: null });
    const [retained] = await f.db.select().from(customerMediaAssets).where(eq(customerMediaAssets.id, upload.uploadToken));
    expect(retained).toMatchObject({ status: 'ready', outputStorageKey: `ready/${upload.uploadToken}` });
    expect((await f.db.select().from(eventPartnerProfileVersions).where(eq(eventPartnerProfileVersions.avatarAssetId, upload.uploadToken))).length).toBeGreaterThan(0);
    await f.db.update(customerMediaAssets).set({ status: 'failed', failureReason: '处理失败' }).where(eq(customerMediaAssets.id, upload.uploadToken));
    expect(await f.service.adminPartnerMediaStatus(f.organizationId, f.event.id, f.partner.id, upload.uploadToken)).toMatchObject({ status: 'failed', failureReason: '处理失败' });
    expect(await f.db.select().from(auditLogs).where(eq(auditLogs.resourceId, upload.uploadToken))).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorType: 'staff', actorId: f.actorId, action: 'partner.media.upload_prepared' }),
      expect.objectContaining({ actorType: 'staff', actorId: f.actorId, action: 'partner.media.confirmed' }),
    ]));
  });

});
