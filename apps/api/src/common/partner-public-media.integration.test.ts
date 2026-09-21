import { randomUUID } from 'node:crypto';
import { DEFAULT_PARTNER_POSTER_FIELDS, DEFAULT_PARTNER_VISIBLE_FIELDS } from '@conference/contracts';
import { createDatabase, customerMediaAssets, customerUsers, eventPartnerProfileVersions, eventPartnerProgramVersions,
  eventPartners, events, organizations } from '@conference/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerDistributionService } from './partner-distribution.service.js';
import type { DatabaseService } from './database.service.js';
import type { RedisService } from './redis.service.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;
persistent('public partner media URL and authorization PostgreSQL regression', () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(() => { connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL); });
  afterAll(async () => { await connection.pool.end(); });

  it('returns API-relative image paths and removes unapproved media and contacts', async () => {
    const db = connection.db;
    const organizationId = randomUUID();
    const customerUserId = randomUUID();
    const partnerId = randomUUID();
    const avatarId = randomUUID();
    const galleryId = randomUUID();
    const orgSlug = `media-${organizationId}`;
    const publicSlug = `media-${partnerId.slice(0, 20)}`;
    await db.insert(organizations).values({ id: organizationId, slug: orgSlug, name: '公开图片回归组织' });
    await db.insert(customerUsers).values({ id: customerUserId, organizationId, mobileE164: '+8613900000011' });
    const [event] = await db.insert(events).values({ organizationId, slug: `media-${randomUUID()}`, name: '公开图片测试大会',
      shortName: '图片测试', tagline: '图片测试', description: '公开图片路径及授权验证', status: 'registration_open',
      startsAt: new Date('2027-11-01T01:00:00Z'), endsAt: new Date('2027-11-01T10:00:00Z'),
      timezone: 'Asia/Shanghai', venue: '测试会场', city: '深圳', address: '测试地址' }).returning();
    await db.insert(eventPartnerProgramVersions).values({ organizationId, eventId: event!.id, version: 1, status: 'active',
      termsTitle: '测试规则', termsContent: '公开图片测试', promotionPolicy: '测试推广规范', contentHash: '0'.repeat(64), publicDirectoryEnabled: true });
    await db.insert(eventPartners).values({ id: partnerId, organizationId, eventId: event!.id, customerUserId,
      publicSlug, qualificationStatus: 'active' });
    await db.insert(customerMediaAssets).values([avatarId, galleryId].map((id, index) => ({ id, organizationId, customerUserId,
      kind: index === 0 ? 'partner_avatar' : 'partner_gallery', sourceStorageKey: `private-test/${id}.png`, mediaType: 'image/png',
      size: 100, contentDigest: '0'.repeat(64), status: 'ready' })));
    const visibleFields = { ...DEFAULT_PARTNER_VISIBLE_FIELDS, avatar: true, gallery: true, contactPhone: true, contactEmail: true, wechatId: true };
    await db.insert(eventPartnerProfileVersions).values({ partnerId, organizationId, eventId: event!.id, version: 1,
      displayName: '测试合作伙伴', avatarAssetId: avatarId, gallery: [{ assetId: galleryId, alt: '测试图片' }], publicStatus: 'published',
      contactPhone: '13900000011', contactEmail: 'private@example.test', wechatId: 'private-wechat',
      visibleFields, posterFields: DEFAULT_PARTNER_POSTER_FIELDS, actorType: 'system' });
    const service = new PartnerDistributionService({ db } as DatabaseService, {} as RedisService);
    const detail = await service.publicPartner(event!.slug, publicSlug, orgSlug);
    const list = await service.publicPartners(event!.slug, orgSlug, 30, 'directory');
    const apiBase = 'https://example.test/api/v1';
    const expectedPrefix = `/events/${event!.slug}/partners/${publicSlug}`;
    expect(detail.avatarUrl).toBe(`${expectedPrefix}/avatar`);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.avatarUrl).toBe(detail.avatarUrl);
    expect(detail.gallery[0]!.url).toBe(`${expectedPrefix}/media/${galleryId}`);
    for (const path of [detail.avatarUrl!, detail.gallery[0]!.url, list.items[0]!.avatarUrl!]) {
      const rendered = `${apiBase}/${path.replace(/^\//, '')}`;
      expect(new URL(rendered).pathname).toMatch(/^\/api\/v1\/events\//);
      expect(rendered).not.toContain('/api/v1/api/v1/');
      expect(rendered).not.toContain('private-test');
    }
    expect(detail.contactPhone).toBe('13900000011');
    await db.update(eventPartnerProfileVersions).set({ visibleFields: { ...visibleFields, avatar: false, gallery: false,
      contactPhone: false, contactEmail: false, wechatId: false } }).where(eq(eventPartnerProfileVersions.partnerId, partnerId));
    const privateDetail = await service.publicPartner(event!.slug, publicSlug, orgSlug);
    const privateList = await service.publicPartners(event!.slug, orgSlug, 30, 'directory');
    expect(privateDetail.avatarUrl).toBeNull();
    expect(privateDetail.gallery).toEqual([]);
    expect(privateList.items[0]!.avatarUrl).toBeNull();
    for (const field of ['contactPhone', 'contactEmail', 'wechatId', 'avatarAssetId']) expect(privateDetail).not.toHaveProperty(field);
    expect(JSON.stringify(privateDetail)).not.toContain('private@example.test');
  });
});
