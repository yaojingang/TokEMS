import { randomUUID } from 'node:crypto';
import { createDatabase, customerUsers, eventPartners, events, organizations, partnerCommissionInquiries } from '@conference/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCustomerPartnerInquiries } from './partner-customer-views.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;

persistent('customer inquiry history with real PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(() => { connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL); });
  afterAll(async () => { await connection.pool.end(); });

  it('isolates users, events and organizations and hides decisions awaiting second review', async () => {
    const db = connection.db;
    async function createScope(organizationId?: string, eventId?: number) {
      const orgId = organizationId ?? randomUUID();
      if (!organizationId) await db.insert(organizations).values({ id: orgId, slug: `inquiry-${orgId}`, name: '申诉隔离测试组织' });
      const customerUserId = randomUUID();
      await db.insert(customerUsers).values({ id: customerUserId, organizationId: orgId,
        mobileE164: `+86139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` });
      let actualEventId = eventId;
      if (!actualEventId) {
        const [event] = await db.insert(events).values({ organizationId: orgId, slug: `inquiry-${randomUUID()}`,
          name: '申诉隔离测试大会', shortName: '测试', tagline: '申诉测试', description: '申诉真实数据库隔离测试',
          status: 'registration_open', startsAt: new Date('2027-11-01T01:00:00Z'), endsAt: new Date('2027-11-01T10:00:00Z'),
          timezone: 'Asia/Shanghai', venue: '测试会场', city: '深圳', address: '测试地址' }).returning();
        actualEventId = event!.id;
      }
      const partnerId = randomUUID();
      await db.insert(eventPartners).values({ id: partnerId, organizationId: orgId, eventId: actualEventId,
        customerUserId, publicSlug: `inquiry-${partnerId.slice(0, 20)}` });
      return { organizationId: orgId, eventId: actualEventId, partnerId, customerUserId };
    }
    const own = await createScope();
    const sameEventOtherUser = await createScope(own.organizationId, own.eventId);
    const otherEvent = await createScope(own.organizationId);
    const otherOrganization = await createScope();
    const ownId = randomUUID();
    await db.insert(partnerCommissionInquiries).values([
      { ...own, id: ownId, type: 'amount_dispute', status: 'under_review', orderReference: 'OWN-ORDER',
        description: '等待二次复核的金额申诉', decision: 'credit_adjustment', decisionReason: '未审批的调整草案', adjustmentAmount: 100_000 },
      ...[sameEventOtherUser, otherEvent, otherOrganization].map((scope) => ({ ...scope, type: 'missing_order' as const,
        orderReference: 'OTHER-PRIVATE-ORDER', description: '其他用户的申诉内容不可泄露' })),
    ]);
    const result = await readCustomerPartnerInquiries(db, own);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: ownId, status: 'under_review', orderReference: 'OWN-ORDER',
      decision: null, decisionReason: null, adjustmentAmount: null });
    expect(result.hasMore).toBe(false);
    expect(result.items[0]).not.toHaveProperty('customerUserId');
    expect(result.items[0]).not.toHaveProperty('adjustmentProposedBy');
    for (const invalid of [
      { ...own, customerUserId: sameEventOtherUser.customerUserId },
      { ...own, partnerId: sameEventOtherUser.partnerId },
      { ...own, eventId: otherEvent.eventId },
      { ...own, organizationId: otherOrganization.organizationId },
    ]) {
      expect((await readCustomerPartnerInquiries(db, invalid)).items).toEqual([]);
    }
    expect((await readCustomerPartnerInquiries(db, otherOrganization)).items).toHaveLength(1);
  });
});
