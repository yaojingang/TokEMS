import { randomUUID } from 'node:crypto';
import { PartnerProgramDraftSchema } from '@conference/contracts';
import {
  createDatabase,
  customerProfiles,
  customerUsers,
  eventPartnerProfileVersions,
  eventPartnerProgramVersions,
  eventPartners,
  events,
  notificationDeliveries,
  organizations,
  partnerReferralLinks,
  publicUserIds,
  users,
} from '@conference/database';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from './database.service.js';
import { PartnerDistributionService } from './partner-distribution.service.js';
import type { RedisService } from './redis.service.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;

persistent('partner mobile invitations with real PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;
  const organizationIds: string[] = [];
  const actorIds: string[] = [];

  beforeAll(async () => {
    connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL);
    const staleOrganizations = await connection.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(like(organizations.slug, 'partner-invite-%'));
    const staleOrganizationIds = staleOrganizations.map((item) => item.id);
    if (staleOrganizationIds.length) {
      const staleCustomers = await connection.db
        .select({ id: customerUsers.id })
        .from(customerUsers)
        .where(inArray(customerUsers.organizationId, staleOrganizationIds));
      await connection.db
        .delete(partnerReferralLinks)
        .where(inArray(partnerReferralLinks.organizationId, staleOrganizationIds));
      await connection.db
        .delete(eventPartnerProfileVersions)
        .where(inArray(eventPartnerProfileVersions.organizationId, staleOrganizationIds));
      await connection.db
        .delete(eventPartners)
        .where(inArray(eventPartners.organizationId, staleOrganizationIds));
      if (staleCustomers.length) {
        await connection.db.delete(publicUserIds).where(
          and(
            eq(publicUserIds.subjectType, 'customer'),
            inArray(
              publicUserIds.subjectUuid,
              staleCustomers.map((item) => item.id),
            ),
          ),
        );
      }
      await connection.db
        .delete(organizations)
        .where(inArray(organizations.id, staleOrganizationIds));
    }
    await connection.db.delete(users).where(like(users.email, 'partner-invite-%@example.com'));
  });

  afterEach(async () => {
    for (const organizationId of organizationIds.splice(0)) {
      const customers = await connection.db
        .select({ id: customerUsers.id })
        .from(customerUsers)
        .where(eq(customerUsers.organizationId, organizationId));
      await connection.db
        .delete(partnerReferralLinks)
        .where(eq(partnerReferralLinks.organizationId, organizationId));
      await connection.db
        .delete(eventPartnerProfileVersions)
        .where(eq(eventPartnerProfileVersions.organizationId, organizationId));
      await connection.db
        .delete(eventPartners)
        .where(eq(eventPartners.organizationId, organizationId));
      if (customers.length) {
        await connection.db.delete(publicUserIds).where(
          and(
            eq(publicUserIds.subjectType, 'customer'),
            inArray(
              publicUserIds.subjectUuid,
              customers.map((item) => item.id),
            ),
          ),
        );
      }
      await connection.db.delete(organizations).where(eq(organizations.id, organizationId));
    }
    for (const actorId of actorIds.splice(0)) {
      await connection.db.delete(users).where(eq(users.id, actorId));
    }
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  async function fixture(options: { publishProgram?: boolean } = {}) {
    const organizationId = randomUUID();
    const actorId = randomUUID();
    const suffix = organizationId.replaceAll('-', '').slice(0, 12);
    organizationIds.push(organizationId);
    actorIds.push(actorId);
    await connection.db.insert(organizations).values({
      id: organizationId,
      slug: `partner-invite-${suffix}`,
      name: '合作伙伴手机号邀请测试',
    });
    await connection.db.insert(users).values({
      id: actorId,
      email: `partner-invite-${suffix}@example.com`,
      name: '伙伴管理员',
    });
    const [event] = await connection.db
      .insert(events)
      .values({
        organizationId,
        slug: `partner-invite-event-${suffix}`,
        name: '手机号邀请测试大会',
        shortName: '邀请测试',
        tagline: '验证合作伙伴手机号邀请',
        description: '验证按手机号创建或复用普通用户并开通合作伙伴。',
        status: 'registration_open',
        startsAt: new Date('2027-12-01T01:00:00Z'),
        endsAt: new Date('2027-12-01T10:00:00Z'),
        timezone: 'Asia/Shanghai',
        venue: '测试会场',
        city: '深圳',
        address: '测试地址',
      })
      .returning();
    const service = new PartnerDistributionService(
      { db: connection.db } as DatabaseService,
      {} as RedisService,
    );
    if (options.publishProgram !== false) {
      await service.publishProgram(
        organizationId,
        event!.id,
        actorId,
        PartnerProgramDraftSchema.parse({
          termsTitle: '合作伙伴规则',
          termsContent: '确认后可以使用大会专属推广链接。',
          promotionPolicy: '推广内容需真实、清晰。',
        }),
      );
    }
    return { actorId, event: event!, organizationId, service };
  }

  it('atomically provisions one customer and one partner for concurrent mobile invitations', async () => {
    const f = await fixture();
    const mobile = '13800138000';
    const input = {
      mobile,
      displayName: '张三',
      company: '山海科技',
      title: '市场副总裁',
      personalRateBps: null,
      sortOrder: 0,
      internalNote: '重点渠道伙伴',
      sendInvitation: true,
    };

    const [first, second] = await Promise.all([
      f.service.enablePartner(f.organizationId, f.event.id, f.actorId, input),
      f.service.enablePartner(f.organizationId, f.event.id, f.actorId, input),
    ]);

    const customers = await connection.db
      .select()
      .from(customerUsers)
      .where(
        and(
          eq(customerUsers.organizationId, f.organizationId),
          eq(customerUsers.mobileE164, '+8613800138000'),
        ),
      );
    const partners = await connection.db
      .select()
      .from(eventPartners)
      .where(eq(eventPartners.eventId, f.event.id));
    const profiles = await connection.db
      .select()
      .from(customerProfiles)
      .where(eq(customerProfiles.customerUserId, customers[0]!.id));
    const partnerProfiles = await connection.db
      .select()
      .from(eventPartnerProfileVersions)
      .where(eq(eventPartnerProfileVersions.partnerId, partners[0]!.id));
    const publicIdentities = await connection.db
      .select()
      .from(publicUserIds)
      .where(
        and(
          eq(publicUserIds.subjectType, 'customer'),
          eq(publicUserIds.subjectUuid, customers[0]!.id),
        ),
      );
    const deliveries = await connection.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventId, f.event.id));

    expect(first.id).toBe(second.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(customers).toHaveLength(1);
    expect(customers[0]?.lastLoginAt).toBeNull();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      realName: '张三',
      company: '山海科技',
      title: '市场副总裁',
    });
    expect(partnerProfiles).toHaveLength(1);
    expect(partnerProfiles[0]).toMatchObject({
      displayName: '张三',
      company: '山海科技',
      title: '市场副总裁',
    });
    expect(publicIdentities).toHaveLength(1);
    expect(partners).toHaveLength(1);
    expect(partners[0]).toMatchObject({
      qualificationStatus: 'active',
      attributionEnabled: true,
      acceptedProgramVersionId: null,
      activatedAt: expect.any(Date),
      personalRateBps: null,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      channel: 'sms',
      recipient: '+8613800138000',
      purpose: 'partner-invitation',
      status: 'queued',
    });
  });

  it('requires an explicitly published distribution program before creating a customer', async () => {
    const f = await fixture({ publishProgram: false });

    await expect(
      f.service.enablePartner(f.organizationId, f.event.id, f.actorId, {
        mobile: '13900139000',
        personalRateBps: null,
        sortOrder: 0,
        internalNote: '',
        sendInvitation: true,
      }),
    ).rejects.toThrow('请先开启当前大会的分销功能');

    const customers = await connection.db
      .select()
      .from(customerUsers)
      .where(eq(customerUsers.organizationId, f.organizationId));
    const programs = await connection.db
      .select()
      .from(eventPartnerProgramVersions)
      .where(eq(eventPartnerProgramVersions.eventId, f.event.id));
    expect(customers).toHaveLength(0);
    expect(programs).toHaveLength(0);
  });

  it('reuses an active customer, preserves its global profile, and edits a paused partner', async () => {
    const f = await fixture();
    const [customer] = await connection.db
      .insert(customerUsers)
      .values({ organizationId: f.organizationId, mobileE164: '+8613700137000' })
      .returning();
    await connection.db.insert(customerProfiles).values({
      customerUserId: customer!.id,
      nickname: '已有普通用户',
      company: '原公司',
      title: '原职务',
    });
    const input = {
      mobile: '13700137000',
      displayName: '大会展示名',
      company: '大会合作公司',
      title: '大会合作职务',
      personalRateBps: null,
      sortOrder: 0,
      internalNote: '',
      sendInvitation: true,
    };

    const relationship = await f.service.enablePartner(
      f.organizationId,
      f.event.id,
      f.actorId,
      input,
    );
    const paused = await f.service.updatePartner(
      f.organizationId,
      f.event.id,
      relationship.id,
      f.actorId,
      {
        expectedVersion: relationship.version,
        qualificationStatus: 'paused',
        attributionEnabled: false,
      },
    );

    const duplicate = await f.service.enablePartner(f.organizationId, f.event.id, f.actorId, input);
    const edited = await f.service.updatePartnerDetails(
      f.organizationId,
      f.event.id,
      relationship.id,
      f.actorId,
      {
        expectedVersion: paused.version,
        displayName: '张三',
        company: '远山科技',
        title: '渠道负责人',
        industry: '人工智能',
        businessIntro: '负责企业智能化合作。',
        businessUrl: 'https://example.com',
        personalRateBps: 0,
        sortOrder: 3,
        internalNote: '线下签约',
      },
    );
    const customers = await connection.db
      .select()
      .from(customerUsers)
      .where(eq(customerUsers.organizationId, f.organizationId));
    const globalProfiles = await connection.db
      .select()
      .from(customerProfiles)
      .where(eq(customerProfiles.customerUserId, customer!.id));
    const partnerProfiles = await connection.db
      .select()
      .from(eventPartnerProfileVersions)
      .where(eq(eventPartnerProfileVersions.partnerId, relationship.id))
      .orderBy(eventPartnerProfileVersions.version);
    const deliveries = await connection.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventId, f.event.id));
    expect(customers).toHaveLength(1);
    expect(globalProfiles[0]).toMatchObject({
      nickname: '已有普通用户',
      company: '原公司',
      title: '原职务',
    });
    expect(relationship.profile).toMatchObject({
      displayName: '大会展示名',
      company: '大会合作公司',
      title: '大会合作职务',
    });
    expect(duplicate).toMatchObject({ created: false, qualificationStatus: 'paused' });
    expect(edited).toMatchObject({
      qualificationStatus: 'paused',
      personalRateBps: 0,
      version: paused.version + 1,
      profile: {
        version: 2,
        displayName: '张三',
        company: '远山科技',
        title: '渠道负责人',
        industry: '人工智能',
        businessIntro: '负责企业智能化合作。',
        businessUrl: 'https://example.com',
      },
    });
    expect(partnerProfiles).toHaveLength(2);
    expect(deliveries).toHaveLength(1);
  });

  it('does not create a duplicate for a disabled customer', async () => {
    const f = await fixture();
    await connection.db.insert(customerUsers).values({
      organizationId: f.organizationId,
      mobileE164: '+8613600136000',
      status: 'blocked',
    });

    await expect(
      f.service.enablePartner(f.organizationId, f.event.id, f.actorId, {
        mobile: '13600136000',
        personalRateBps: null,
        sortOrder: 0,
        internalNote: '',
        sendInvitation: true,
      }),
    ).rejects.toThrow('该手机号对应的用户已停用');
    const customers = await connection.db
      .select()
      .from(customerUsers)
      .where(eq(customerUsers.organizationId, f.organizationId));
    const partners = await connection.db
      .select()
      .from(eventPartners)
      .where(eq(eventPartners.eventId, f.event.id));
    expect(customers).toHaveLength(1);
    expect(partners).toHaveLength(0);
  });
});
