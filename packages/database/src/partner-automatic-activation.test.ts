import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from './index.js';
import { auditLogs, customerUsers, eventPartnerProgramVersions, eventPartners, events, organizations, partnerReferralLinks } from './schema.js';
import { partnerAutomaticActivationExclusions, upgradePartnerAutomaticActivation } from './partner-automatic-activation.js';

const candidate = {
  id: randomUUID(), organizationId: randomUUID(), eventId: 1,
  qualificationStatus: 'pending_confirmation', attributionEnabled: false, settlementHold: false,
  currentProgramVersionId: randomUUID(), acceptedProgramVersionId: null, activatedAt: null,
  version: 1, customerStatus: 'active', programId: randomUUID(), linkId: randomUUID(), latestAction: null, latestAfter: null,
};

describe('historical partner activation exclusions', () => {
  it('accepts only ordinary pending relationships with an active owner, program and link', () => {
    expect(partnerAutomaticActivationExclusions(candidate)).toEqual([]);
    for (const patch of [{ qualificationStatus: 'paused' }, { qualificationStatus: 'closed' },
      { qualificationStatus: 'active', attributionEnabled: false }, { settlementHold: true },
      { customerStatus: 'disabled' }, { programId: null }, { linkId: null },
      { latestAction: 'partner.updated', latestAfter: { attributionEnabled: false } },
      { latestAction: 'partner.updated', latestAfter: {} },
      { latestAction: 'partner.restricted', latestAfter: {} }]) {
      expect(partnerAutomaticActivationExclusions({ ...candidate, ...patch }).length).toBeGreaterThan(0);
    }
  });
});

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;
persistent('historical automatic partner activation with real PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(() => { connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL); });
  afterAll(async () => { await connection.pool.end(); });
  it('reports without writing, conservatively converts once and preserves restrictions and consent history', async () => {
    const { db, pool } = connection;
    const organizationId = randomUUID();
    await db.insert(organizations).values({ id: organizationId, slug: `upgrade-${organizationId}`, name: '历史升级测试' });
    const [event] = await db.insert(events).values({ organizationId, slug: `upgrade-${organizationId}`, name: '历史升级大会',
      shortName: '升级', tagline: '升级测试', description: '升级验收', status: 'registration_open',
      startsAt: new Date('2027-11-01T01:00:00Z'), endsAt: new Date('2027-11-01T10:00:00Z'),
      timezone: 'Asia/Shanghai', venue: '会场', city: '深圳', address: '会场' }).returning();
    const [program] = await db.insert(eventPartnerProgramVersions).values({ organizationId, eventId: event!.id, version: 1, status: 'active',
      termsTitle: '规则', termsContent: '规则正文', promotionPolicy: '推广规范', contentHash: '0'.repeat(64) }).returning();
    const records = [];
    for (const [index, kind] of ['normal', 'accepted', 'paused', 'closed', 'independent', 'hold', 'expired', 'disabled', 'missing', 'restricted'].entries()) {
      const customerUserId = randomUUID();
      await db.insert(customerUsers).values({ id: customerUserId, organizationId, mobileE164: `+861390001${String(index).padStart(4, '0')}` });
      const [partner] = await db.insert(eventPartners).values({ organizationId, eventId: event!.id, customerUserId,
        publicSlug: `u-${randomUUID().slice(0, 12)}`, currentProgramVersionId: program!.id,
        acceptedProgramVersionId: kind === 'accepted' ? program!.id : null,
        qualificationStatus: kind === 'paused' ? 'paused' : kind === 'closed' ? 'closed' : kind === 'independent' ? 'active' : 'pending_confirmation',
        attributionEnabled: false, settlementHold: kind === 'hold' }).returning();
      if (kind !== 'missing') await db.insert(partnerReferralLinks).values({ organizationId, eventId: event!.id, partnerId: partner!.id,
        code: randomUUID(), destinationPath: '/register', status: kind === 'disabled' ? 'disabled' : 'active',
        expiresAt: kind === 'expired' ? new Date(0) : null });
      if (kind === 'restricted') {
        await db.insert(auditLogs).values({ organizationId, eventId: event!.id, actorType: 'system', action: 'partner.updated',
          resourceType: 'event_partner', resourceId: partner!.id, before: {}, after: { attributionEnabled: false }, traceId: randomUUID() });
        // A later details edit cannot erase the restriction evidence.
        await db.insert(auditLogs).values({ organizationId, eventId: event!.id, actorType: 'system', action: 'partner.details.updated',
          resourceType: 'event_partner', resourceId: partner!.id, before: {}, after: { changedFields: ['displayName'] }, traceId: randomUUID() });
      }
      records.push({ kind, partner: partner! });
    }
    const report = await upgradePartnerAutomaticActivation(pool);
    const included = report.candidates.filter(row => records.some(record => record.partner.id === row.partnerId));
    expect(included).toHaveLength(2);
    expect(report.converted).toBe(0);
    for (const { partner } of records) {
      const [stored] = await db.select().from(eventPartners).where(eq(eventPartners.id, partner.id));
      expect(stored?.version).toBe(partner.version);
    }
    await upgradePartnerAutomaticActivation(pool, true);
    for (const { kind, partner } of records) {
      const [stored] = await db.select().from(eventPartners).where(eq(eventPartners.id, partner.id));
      const converted = ['normal', 'accepted'].includes(kind);
      expect(stored).toMatchObject({ qualificationStatus: converted ? 'active' : partner.qualificationStatus,
        attributionEnabled: converted, settlementHold: partner.settlementHold,
        acceptedProgramVersionId: partner.acceptedProgramVersionId, version: partner.version + Number(converted) });
    }
    const again = await upgradePartnerAutomaticActivation(pool, true);
    expect(again.candidates.some(row => records.some(record => record.partner.id === row.partnerId))).toBe(false);
    const [normal] = records;
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, normal!.partner.id));
    expect(audits).toEqual([expect.objectContaining({ action: 'partner.activation.upgraded',
      before: expect.objectContaining({ qualificationStatus: 'pending_confirmation', acceptedProgramVersionId: null }),
      after: expect.objectContaining({ conversionVersion: 'automatic-activation-v1', version: 2, acceptedProgramVersionId: null }) })]);
  });
});
