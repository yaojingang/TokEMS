import { randomUUID } from 'node:crypto';
import {
  createDatabase,
  customerUsers,
  eventPartnerProgramVersions,
  eventPartners,
  events,
  organizations,
} from '@conference/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activateScheduledPartnerPrograms } from './partner-financial.worker.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;

persistent('scheduled partner program qualification with real PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(() => {
    connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL);
  });
  afterAll(async () => {
    await connection.pool.end();
  });

  it('preserves administrator restrictions and acceptance history when current rules change', async () => {
    const db = connection.db;
    const organizationId = randomUUID();
    await db.insert(organizations).values({
      id: organizationId,
      slug: `scheduled-qualification-${organizationId}`,
      name: '规则定时生效资格测试',
    });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `scheduled-qualification-${organizationId}`,
        name: '规则定时生效测试大会',
        shortName: '资格测试',
        tagline: '保留管理员资格控制',
        description: '验证新规则定时生效时保留暂停、关闭与独立归因暂停。',
        status: 'registration_open',
        startsAt: new Date('2027-11-01T01:00:00Z'),
        endsAt: new Date('2027-11-01T10:00:00Z'),
        timezone: 'Asia/Shanghai',
        venue: '测试会场',
        city: '深圳',
        address: '测试地址',
      })
      .returning();
    const [current, scheduled] = await db
      .insert(eventPartnerProgramVersions)
      .values([
        {
          organizationId,
          eventId: event!.id,
          version: 1,
          status: 'active',
          termsTitle: '当前合作规则',
          termsContent: '确认合作规则后推广大会。',
          promotionPolicy: '推广内容需真实准确。',
          contentHash: '1'.repeat(64),
        },
        {
          organizationId,
          eventId: event!.id,
          version: 2,
          status: 'scheduled',
          effectiveAt: new Date(Date.now() - 60_000),
          termsTitle: '新版合作规则',
          termsContent: '确认新版合作规则后推广大会。',
          promotionPolicy: '推广内容需真实准确。',
          contentHash: '2'.repeat(64),
        },
      ])
      .returning();
    const partners = [];
    const states = [
      ['paused', false],
      ['closed', false],
      ['active', false],
      ['active', true],
      ['pending_confirmation', false],
    ] as const;
    for (const [index, [qualificationStatus, attributionEnabled]] of states.entries()) {
      const customerUserId = randomUUID();
      const partnerId = randomUUID();
      await db.insert(customerUsers).values({
        id: customerUserId,
        organizationId,
        mobileE164: `+861390000${String(index).padStart(4, '0')}`,
      });
      const [partner] = await db
        .insert(eventPartners)
        .values({
          id: partnerId,
          organizationId,
          eventId: event!.id,
          customerUserId,
          publicSlug: `scheduled-${partnerId.slice(0, 12)}`,
          qualificationStatus,
          attributionEnabled,
          settlementHold: index === 0 || index === 3,
          currentProgramVersionId: current!.id,
          acceptedProgramVersionId:
            qualificationStatus === 'pending_confirmation' ? null : current!.id,
        })
        .returning();
      partners.push(partner!);
    }

    await activateScheduledPartnerPrograms(db);

    for (const partner of partners.slice(0, 3)) {
      const [stored] = await db
        .select()
        .from(eventPartners)
        .where(eq(eventPartners.id, partner.id));
      expect(stored).toMatchObject({
        qualificationStatus: partner.qualificationStatus,
        settlementHold: partner.settlementHold,
        attributionEnabled: false,
        currentProgramVersionId: scheduled!.id,
        acceptedProgramVersionId: current!.id,
        version: partner.version + 1,
      });
    }
    for (const partner of partners.slice(3)) {
      const [stored] = await db
        .select()
        .from(eventPartners)
        .where(eq(eventPartners.id, partner.id));
      expect(stored).toMatchObject({
        qualificationStatus: partner.qualificationStatus,
        settlementHold: partner.settlementHold,
        attributionEnabled: partner.attributionEnabled,
        currentProgramVersionId: scheduled!.id,
        acceptedProgramVersionId: partner.acceptedProgramVersionId,
        version: partner.version + 1,
      });
    }
    const [activeProgram] = await db
      .select()
      .from(eventPartnerProgramVersions)
      .where(eq(eventPartnerProgramVersions.id, scheduled!.id));
    expect(activeProgram?.status).toBe('active');
  });
});
