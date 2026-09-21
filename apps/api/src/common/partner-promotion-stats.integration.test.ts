import { randomUUID } from 'node:crypto';
import { createDatabase, customerUsers, eventPartners, events, organizations, orders, payments,
  ticketTypes, registrations, orderItems, partnerAttributionRevisions, partnerCommissions,
  partnerCommissionItems, partnerReferralLinks, partnerReferralVisitDays } from '@conference/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPartnerPromotionStats } from './partner-promotion-stats.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;
persistent('partner promotion aggregate PostgreSQL regression', () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(() => { connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL); });
  afterAll(async () => { await connection.pool.end(); });

  it('counts net eligible sales once per order and isolates every reporting scope', async () => {
    const db = connection.db;
    async function scope(organizationId?: string, eventId?: number) {
      const orgId = organizationId ?? randomUUID();
      if (!organizationId) await db.insert(organizations).values({ id: orgId, slug: `stats-${orgId}`, name: '推广统计测试' });
      const userId = randomUUID();
      await db.insert(customerUsers).values({ id: userId, organizationId: orgId,
        mobileE164: `+86139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` });
      let eid = eventId;
      if (!eid) {
        const [event] = await db.insert(events).values({ organizationId: orgId, slug: `stats-${randomUUID()}`, name: '统计测试大会',
          shortName: '统计测试', tagline: '统计测试', description: '真实聚合查询测试', status: 'registration_open',
          startsAt: new Date('2027-11-01T01:00:00Z'), endsAt: new Date('2027-11-01T10:00:00Z'),
          timezone: 'Asia/Shanghai', venue: '测试会场', city: '深圳', address: '测试地址' }).returning();
        eid = event!.id;
      }
      const [ticket] = await db.insert(ticketTypes).values({ organizationId: orgId, eventId: eid, code: `S${randomUUID().slice(0, 8)}`,
        name: '统计票', description: '统计测试', price: 10000, currency: 'CNY', capacity: 100 }).returning();
      const partnerId = randomUUID();
      await db.insert(eventPartners).values({ id: partnerId, organizationId: orgId, eventId: eid,
        customerUserId: userId, publicSlug: `stats-${partnerId.slice(0, 20)}` });
      const [link] = await db.insert(partnerReferralLinks).values({ organizationId: orgId, eventId: eid,
        partnerId, code: `stats-${partnerId}`, destinationPath: '/register' }).returning();
      return { organizationId: orgId, eventId: eid, partnerId, userId, ticketId: ticket!.id, linkId: link!.id };
    }
    type Scope = Awaited<ReturnType<typeof scope>>;
    const sequences = new Map<string, number>();
    async function sale(s: Scope, eligibleAmount: number, refundedAmount: number, quantity = 1, selfPurchase = false) {
      return db.transaction(async (db) => {
      await db.execute(sql`set constraints all deferred`);
      const id = randomUUID();
      const regs = [];
      for (let i = 0; i < quantity; i++) {
        const [reg] = await db.insert(registrations).values({ organizationId: s.organizationId, eventId: s.eventId,
          ticketTypeId: s.ticketId, registrationCode: `S${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          status: 'confirmed', attendee: { name: '统计测试参会人', mobile: '13900000000', email: 'stats@example.test', company: '', title: '', city: '深圳' } }).returning();
        regs.push(reg!);
      }
      await db.insert(orders).values({ id, organizationId: s.organizationId, eventId: s.eventId, registrationId: quantity === 1 ? regs[0]!.id : null,
        modelVersion: 2, quantity, purchaserCustomerUserId: s.userId, purchaseIntentId: randomUUID(),
        orderNo: `S${id.replaceAll('-', '').slice(0, 20)}`, status: 'paid', amount: quantity * 10000,
        currency: 'CNY', pricingSnapshot: {}, expiresAt: new Date(Date.now() + 60000) });
      const [attribution] = await db.insert(partnerAttributionRevisions).values({ organizationId: s.organizationId, eventId: s.eventId,
        orderId: id, orderVersion: 1, partnerId: s.partnerId, referralLinkId: s.linkId, decision: 'attributed',
        decisionReason: '统计测试快照', orderSnapshot: {}, createdBy: 'checkout' }).returning();
      const [payment] = await db.insert(payments).values({ orderId: id, provider: 'stats-test', status: 'succeeded',
        amount: quantity * 10000, currency: 'CNY', succeededAt: new Date() }).returning();
      const sequence = (sequences.get(s.partnerId) ?? 0) + 1;
      sequences.set(s.partnerId, sequence);
      const originalCommission = selfPurchase ? 0 : quantity * 1000;
      const reversedAmount = originalCommission - eligibleAmount / 10;
      const [commission] = await db.insert(partnerCommissions).values({ organizationId: s.organizationId, eventId: s.eventId,
        partnerId: s.partnerId, orderId: id, paymentId: payment!.id, attributionRevisionId: attribution!.id,
        programVersionId: randomUUID(), sequence, rateBps: 1000, eligibleAmount, refundedAmount,
        commissionAmount: originalCommission, reversedAmount, releaseAt: new Date() }).returning();
      for (let i = 0; i < quantity; i++) {
        const [item] = await db.insert(orderItems).values({ organizationId: s.organizationId, eventId: s.eventId, orderId: id,
          registrationId: regs[i]!.id, position: i + 1, ticketTypeId: s.ticketId, unitPrice: 10000,
          allocatedAmount: 10000, pricingSnapshot: {}, state: 'active' }).returning();
        await db.insert(partnerCommissionItems).values({ commissionId: commission!.id, partnerId: s.partnerId,
          organizationId: s.organizationId, eventId: s.eventId, orderId: id, orderItemId: item!.id,
          ticketTypeId: s.ticketId, grossAmount: 10000, eligibleAmount: eligibleAmount / quantity,
          refundedAmount: refundedAmount / quantity, rateBps: 1000, commissionAmount: originalCommission / quantity,
          reversedAmount: reversedAmount / quantity, eligibility: selfPurchase ? 'self_purchase' : eligibleAmount ? 'eligible' : 'refunded', eligibilityReason: '统计回归快照' });
      }
      });
    }
    async function visits(s: Scope, count: number) {
      await db.insert(partnerReferralVisitDays).values({ organizationId: s.organizationId, eventId: s.eventId,
        partnerId: s.partnerId, referralLinkId: s.linkId, localDate: '2026-09-17', visits: count,
        uniqueVisits: count - 1, timezoneSnapshot: 'Asia/Shanghai' });
    }
    const own = await scope();
    const sibling = await scope(own.organizationId, own.eventId);
    const otherEvent = await scope(own.organizationId);
    const otherOrg = await scope();
    await sale(own, 8000, 2000);
    await sale(own, 0, 10000);
    await sale(own, 0, 0, 1, true);
    await sale(own, 50000, 0, 5);
    for (const s of [sibling, otherEvent, otherOrg]) await sale(s, 10000, 0);
    await visits(own, 3);
    await visits(sibling, 5);
    await visits(otherEvent, 7);
    await visits(otherOrg, 9);
    expect(await readPartnerPromotionStats(db, own.organizationId, own.eventId, own.partnerId)).toEqual({
      visits: 3, uniqueDailyVisits: 2, paidOrders: 2, netSalesAmount: 58000, netCommissionAmount: 5800 });
    expect(await readPartnerPromotionStats(db, own.organizationId, own.eventId)).toEqual({
      visits: 8, uniqueDailyVisits: 6, paidOrders: 3, netSalesAmount: 68000, netCommissionAmount: 6800 });
    expect(await readPartnerPromotionStats(db, own.organizationId, otherEvent.eventId)).toMatchObject({
      visits: 7, paidOrders: 1, netSalesAmount: 10000 });
    expect(await readPartnerPromotionStats(db, otherOrg.organizationId, otherOrg.eventId)).toMatchObject({
      visits: 9, paidOrders: 1, netSalesAmount: 10000 });
    expect(await readPartnerPromotionStats(db, otherOrg.organizationId, own.eventId)).toEqual({
      visits: 0, uniqueDailyVisits: 0, paidOrders: 0, netSalesAmount: 0, netCommissionAmount: 0 });
  });
});
