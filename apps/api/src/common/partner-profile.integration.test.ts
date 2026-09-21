import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PARTNER_POSTER_FIELDS,
  DEFAULT_PARTNER_VISIBLE_FIELDS,
} from '@conference/contracts';
import {
  createDatabase,
  customerUsers,
  eventPartnerProfileVersions,
  eventPartners,
  events,
  organizations,
} from '@conference/database';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import type { DatabaseService } from './database.service.js';
import { PartnerDistributionService } from './partner-distribution.service.js';
import type { RedisService } from './redis.service.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;

persistent('partner profile versioning with real PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;

  beforeAll(() => {
    connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it('creates a new immutable row for every profile and privacy update', async () => {
    const db = connection.db;
    const organizationId = randomUUID();
    const customerUserId = randomUUID();
    const partnerId = randomUUID();
    const originalProfileId = randomUUID();

    await db.insert(organizations).values({
      id: organizationId,
      slug: `partner-profile-${organizationId}`,
      name: '合作伙伴资料版本测试',
    });
    await db.insert(customerUsers).values({
      id: customerUserId,
      organizationId,
      mobileE164: `+86139${organizationId.replaceAll('-', '').slice(0, 8)}`,
    });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `partner-profile-event-${organizationId}`,
        name: '合作伙伴资料测试大会',
        shortName: '资料测试',
        tagline: '资料版本链验收',
        description: '验证合作伙伴资料使用不可变版本记录。',
        status: 'registration_open',
        startsAt: new Date('2027-11-01T01:00:00Z'),
        endsAt: new Date('2027-11-01T10:00:00Z'),
        timezone: 'Asia/Shanghai',
        venue: '测试会场',
        city: '深圳',
        address: '测试地址',
      })
      .returning();
    await db.insert(eventPartners).values({
      id: partnerId,
      organizationId,
      eventId: event!.id,
      customerUserId,
      publicSlug: `profile-${organizationId.slice(0, 8)}`,
    });
    await db.insert(eventPartnerProfileVersions).values({
      id: originalProfileId,
      partnerId,
      organizationId,
      eventId: event!.id,
      version: 1,
      displayName: '原始名称',
      visibleFields: DEFAULT_PARTNER_VISIBLE_FIELDS,
      posterFields: DEFAULT_PARTNER_POSTER_FIELDS,
      actorType: 'system',
    });

    const service = new PartnerDistributionService({ db } as DatabaseService, {} as RedisService);
    const session = {
      sessionId: randomUUID(),
      customerUserId,
      organizationId,
      tokenHash: 'test',
      expiresAt: new Date(Date.now() + 60_000),
      customer: {} as AuthenticatedCustomer['customer'],
      csrfToken: 'test',
    } satisfies AuthenticatedCustomer;

    const profileUpdated = await service.updateOwnProfile(session, event!.id, {
      expectedVersion: 1,
      displayName: '林知远',
      company: '远见增长实验室',
      title: '创始人',
      industry: '品牌增长与 GEO',
      businessIntro: '专注生成式搜索时代的品牌内容与增长策略。',
      businessUrl: 'https://example.com',
      contactPhone: '13800000000',
      contactEmail: 'partner@example.com',
      wechatId: 'tokems-partner',
      gallery: [],
    });
    const privacyUpdated = await service.updateOwnPrivacy(session, event!.id, {
      expectedVersion: profileUpdated.version,
      publicStatus: 'published',
      visibleFields: {
        ...DEFAULT_PARTNER_VISIBLE_FIELDS,
        businessUrl: true,
        contactPhone: true,
        contactEmail: true,
        wechatId: true,
      },
      posterFields: DEFAULT_PARTNER_POSTER_FIELDS,
      searchIndexingEnabled: false,
    });

    const versions = await db
      .select({ id: eventPartnerProfileVersions.id, version: eventPartnerProfileVersions.version })
      .from(eventPartnerProfileVersions)
      .where(eq(eventPartnerProfileVersions.partnerId, partnerId))
      .orderBy(asc(eventPartnerProfileVersions.version));

    expect(profileUpdated.profile.version).toBe(2);
    expect(privacyUpdated.profile.version).toBe(3);
    expect(privacyUpdated.profile.publicStatus).toBe('published');
    expect(versions.map((item) => item.version)).toEqual([1, 2, 3]);
    expect(new Set(versions.map((item) => item.id)).size).toBe(3);
    expect(versions[0]?.id).toBe(originalProfileId);

    const concurrentResults = await Promise.allSettled([
      service.updateOwnProfile(session, event!.id, {
        expectedVersion: privacyUpdated.version,
        displayName: '合作伙伴本人修改',
        company: '远见增长实验室',
        title: '创始人',
        industry: '品牌增长与 GEO',
        businessIntro: '本人提交的新介绍。',
        businessUrl: 'https://example.com/self',
        contactPhone: '13800000000',
        contactEmail: 'partner@example.com',
        wechatId: 'tokems-partner',
        gallery: [],
      }),
      service.updatePartnerDetails(organizationId, event!.id, partnerId, randomUUID(), {
        expectedVersion: privacyUpdated.version,
        displayName: '后台修改名称',
        company: '大会合作公司',
        title: '渠道负责人',
        industry: '人工智能',
        businessIntro: '后台提交的新介绍。',
        businessUrl: 'https://example.com/admin',
        personalRateBps: 0,
        sortOrder: 2,
        internalNote: '并发编辑测试',
      }),
    ]);
    expect(concurrentResults.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = concurrentResults.find((item) => item.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('请刷新后重试') }),
    });

    const concurrentVersions = await db
      .select({ id: eventPartnerProfileVersions.id, version: eventPartnerProfileVersions.version })
      .from(eventPartnerProfileVersions)
      .where(eq(eventPartnerProfileVersions.partnerId, partnerId))
      .orderBy(asc(eventPartnerProfileVersions.version));
    expect(concurrentVersions.map((item) => item.version)).toEqual([1, 2, 3, 4]);
    expect(new Set(concurrentVersions.map((item) => item.id)).size).toBe(4);
    const [current] = await db.select().from(eventPartners).where(eq(eventPartners.id, partnerId));
    const copy = { invitation: '期待见面', introduction: '合作介绍', callToAction: '扫码参加大会', scanHint: '期待相聚深圳' };
    const updatedCopy = await service.updateOwnPosterCopy(session, event!.id, { expectedVersion: current!.version, posterCopy: copy });
    expect(updatedCopy.profile.posterCopy).toEqual(copy);
    await expect(service.updateOwnPosterCopy(session, event!.id, { expectedVersion: current!.version, posterCopy: copy })).rejects.toMatchObject({ message: expect.stringContaining('请刷新后重试') });
    const preserved = await service.updateOwnPrivacy(session, event!.id, { expectedVersion: updatedCopy.version, publicStatus: 'published', visibleFields: DEFAULT_PARTNER_VISIBLE_FIELDS, posterFields: DEFAULT_PARTNER_POSTER_FIELDS, searchIndexingEnabled: false });
    expect(preserved.profile.posterCopy).toEqual(copy);

  });
});
