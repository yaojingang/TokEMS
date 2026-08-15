import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS } from '@conference/contracts';
import { events, memberProfiles, memberships, users } from '@conference/database';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { OrganizationAdminService } from './organization-admin.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('administrator navigation preference persistence', () => {
  const database = new DatabaseService();
  const service = new OrganizationAdminService(database);
  const userId = randomUUID();
  const email = `admin-preference-${userId.slice(0, 8)}@tokems.test`;
  let archivedEventId = 0;

  beforeAll(async () => {
    const db = database.db!;
    await db.insert(users).values({ id: userId, email, name: '偏好测试管理员' });
    await db.insert(memberships).values({
      organizationId: DEMO_IDS.organization,
      userId,
      role: 'event_owner',
      grants: ['event.read', 'event.dashboard.read'],
      status: 'active',
    });
    await db.insert(memberProfiles).values({
      organizationId: DEMO_IDS.organization,
      userId,
      company: '保留的公司字段',
      preferences: { locale: 'zh-CN', admin: { density: 'compact' } },
    });
    const [archivedEvent] = await db
      .insert(events)
      .values({
        organizationId: DEMO_IDS.organization,
        slug: `admin-preference-archived-${userId.slice(0, 8)}`,
        name: '管理员偏好归档大会',
        shortName: '偏好归档验收',
        tagline: '用于验证最近大会偏好边界',
        description: '集成测试结束后删除。',
        status: 'archived',
        startsAt: new Date('2025-01-01T01:00:00.000Z'),
        endsAt: new Date('2025-01-01T10:00:00.000Z'),
        timezone: 'Asia/Shanghai',
        venue: '测试会场',
        city: '深圳',
        address: '深圳市测试路 1 号',
      })
      .returning({ id: events.id });
    archivedEventId = archivedEvent!.id;
  });

  afterAll(async () => {
    const db = database.db!;
    if (archivedEventId) await db.delete(events).where(eq(events.id, archivedEventId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('persists and clears the recent event without replacing sibling profile data', async () => {
    await service.updateAdminPreferences(
      DEMO_IDS.organization,
      userId,
      { lastEventId: DEMO_IDS.event },
      ['event.read'],
    );

    const identity = await service.getCurrentIdentity(DEMO_IDS.organization, userId);
    expect(identity.adminPreferences).toEqual({ lastEventId: DEMO_IDS.event });
    const [stored] = await database.db!
      .select({ company: memberProfiles.company, preferences: memberProfiles.preferences })
      .from(memberProfiles)
      .where(
        and(
          eq(memberProfiles.organizationId, DEMO_IDS.organization),
          eq(memberProfiles.userId, userId),
        ),
      )
      .limit(1);
    expect(stored).toMatchObject({
      company: '保留的公司字段',
      preferences: { locale: 'zh-CN', admin: { density: 'compact', lastEventId: DEMO_IDS.event } },
    });

    await service.updateAdminPreferences(
      DEMO_IDS.organization,
      userId,
      { lastEventId: null },
      [],
    );
    await expect(service.getCurrentIdentity(DEMO_IDS.organization, userId)).resolves.toMatchObject({
      adminPreferences: { lastEventId: null },
    });
    const [cleared] = await database.db!
      .select({ preferences: memberProfiles.preferences })
      .from(memberProfiles)
      .where(
        and(
          eq(memberProfiles.organizationId, DEMO_IDS.organization),
          eq(memberProfiles.userId, userId),
        ),
      )
      .limit(1);
    expect(cleared?.preferences).toMatchObject({
      locale: 'zh-CN',
      admin: { density: 'compact' },
    });
  });

  it('rejects missing, archived, and unauthorized event preferences', async () => {
    await expect(
      service.updateAdminPreferences(DEMO_IDS.organization, userId, { lastEventId: 2147483647 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.updateAdminPreferences(DEMO_IDS.organization, userId, {
        lastEventId: archivedEventId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await database.db!
      .update(memberships)
      .set({ grants: [] })
      .where(
        and(
          eq(memberships.organizationId, DEMO_IDS.organization),
          eq(memberships.userId, userId),
        ),
      );
    try {
      await expect(
        service.updateAdminPreferences(DEMO_IDS.organization, userId, {
          lastEventId: DEMO_IDS.event,
        }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await database.db!
        .update(memberships)
        .set({ grants: ['event.read', 'event.dashboard.read'] })
        .where(
          and(
            eq(memberships.organizationId, DEMO_IDS.organization),
            eq(memberships.userId, userId),
          ),
        );
    }
  });

  it('repairs a malformed admin preference object while preserving top-level siblings', async () => {
    await database.db!
      .update(memberProfiles)
      .set({ preferences: { locale: 'zh-CN', admin: 'invalid legacy value' } })
      .where(
        and(
          eq(memberProfiles.organizationId, DEMO_IDS.organization),
          eq(memberProfiles.userId, userId),
        ),
      );

    await service.updateAdminPreferences(DEMO_IDS.organization, userId, {
      lastEventId: DEMO_IDS.event,
    });
    const [stored] = await database.db!
      .select({ preferences: memberProfiles.preferences })
      .from(memberProfiles)
      .where(
        and(
          eq(memberProfiles.organizationId, DEMO_IDS.organization),
          eq(memberProfiles.userId, userId),
        ),
      )
      .limit(1);
    expect(stored?.preferences).toMatchObject({
      locale: 'zh-CN',
      admin: { lastEventId: DEMO_IDS.event },
    });

    await database.db!
      .update(memberProfiles)
      .set({ preferences: 'invalid legacy root' as unknown as Record<string, unknown> })
      .where(
        and(
          eq(memberProfiles.organizationId, DEMO_IDS.organization),
          eq(memberProfiles.userId, userId),
        ),
      );
    await service.updateAdminPreferences(DEMO_IDS.organization, userId, {
      lastEventId: DEMO_IDS.event,
    });
    await expect(
      service.getCurrentIdentity(DEMO_IDS.organization, userId),
    ).resolves.toMatchObject({ adminPreferences: { lastEventId: DEMO_IDS.event } });
  });
});
