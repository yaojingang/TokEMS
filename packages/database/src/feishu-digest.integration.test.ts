import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type EventId } from '@conference/contracts';
import { createDatabase } from './index.js';
import { loadFeishuDigestSnapshot } from './feishu-digest.js';
import {
  events,
  organizations,
  ticketTypes,
  registrations,
  orders,
  orderItems,
  payments,
  refundRequests,
  refunds,
  invoiceRequests,
  invoiceStateLogs,
} from './schema.js';

const persistent = process.env.DATABASE_URL ? describe : describe.skip;
persistent('Feishu V2 business metrics in PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;
  let organizationId: string;
  let eventId: EventId;
  let ticketTypeId: string;
  const report = new Date('2026-09-09T01:00:00Z');
  const yesterday = new Date('2026-09-08T02:00:00Z');
  const before = new Date('2026-09-07T02:00:00Z');
  beforeAll(() => {
    connection = createDatabase();
  });
  beforeEach(async () => {
    const db = connection.db;
    organizationId = randomUUID();
    await db
      .insert(organizations)
      .values({ id: organizationId, slug: `metrics-${organizationId}`, name: '指标验收组织' });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `metrics-${organizationId}`,
        name: '指标验收大会',
        shortName: '指标验收',
        tagline: '指标验收',
        description: '隔离样本',
        status: 'registration_open',
        startsAt: report,
        endsAt: report,
        timezone: 'Asia/Shanghai',
        city: '上海',
        venue: '验收会场',
        address: '验收地址',
      })
      .returning();
    eventId = event!.id;
    const [ticket] = await db
      .insert(ticketTypes)
      .values({
        organizationId,
        eventId,
        code: 'standard',
        name: '验收票',
        description: '验收',
        price: 10000,
        capacity: 100,
      })
      .returning();
    ticketTypeId = ticket!.id;
  });
  afterEach(async () => {
    await connection.db.delete(refunds).where(eq(refunds.organizationId, organizationId));
    await connection.db
      .delete(refundRequests)
      .where(eq(refundRequests.organizationId, organizationId));
    await connection.db
      .delete(invoiceRequests)
      .where(eq(invoiceRequests.organizationId, organizationId));
    await connection.db.delete(orderItems).where(eq(orderItems.organizationId, organizationId));
    await connection.db.delete(organizations).where(eq(organizations.id, organizationId));
  });
  afterAll(async () => {
    await connection.pool.end();
  });
  async function paid(createdAt = yesterday, currency = 'CNY') {
    const db = connection.db;
    const [registration] = await db
      .insert(registrations)
      .values({
        organizationId,
        eventId,
        ticketTypeId,
        registrationCode: randomUUID(),
        attendee: { name: '验收者', mobile: '', email: '', company: '', title: '', city: '' },
        status: 'confirmed',
        createdAt,
      })
      .returning();
    const [order] = await db
      .insert(orders)
      .values({
        organizationId,
        eventId,
        registrationId: registration!.id,
        orderNo: randomUUID(),
        status: 'paid',
        amount: 10000,
        currency,
        pricingSnapshot: {},
        expiresAt: report,
      })
      .returning();
    await db.insert(orderItems).values({
      orderId: order!.id,
      registrationId: registration!.id,
      organizationId,
      eventId,
      ticketTypeId,
      position: 1,
      unitPrice: order!.amount,
      allocatedAmount: order!.amount,
      pricingSnapshot: order!.pricingSnapshot,
      state: 'active',
    });
    const [payment] = await db
      .insert(payments)
      .values({
        orderId: order!.id,
        provider: 'manual',
        status: 'succeeded',
        amount: 10000,
        currency,
        succeededAt: createdAt,
      })
      .returning();
    return { registration: registration!, order: order!, payment: payment! };
  }
  const snapshot = (reportDate = '2026-09-08') =>
    loadFeishuDigestSnapshot(connection.db, organizationId, eventId, { now: report, reportDate });
  it('separates demand creation, repeated document submission, refund applications and successful refunds', async () => {
    const db = connection.db;
    const first = await paid(before);
    const second = await paid();
    const [invoice] = await db
      .insert(invoiceRequests)
      .values({
        organizationId,
        eventId,
        orderId: first.order.id,
        registrationId: first.registration.id,
        requestNo: randomUUID(),
        amount: 10000,
        netPaidAmount: 10000,
        status: 'issue_failed',
        createdAt: before,
      })
      .returning();
    await db.insert(invoiceRequests).values({
      organizationId,
      eventId,
      orderId: second.order.id,
      registrationId: second.registration.id,
      requestNo: randomUUID(),
      amount: 10000,
      netPaidAmount: 10000,
      status: 'awaiting_details',
      createdAt: yesterday,
    });
    await db.insert(invoiceStateLogs).values(
      ['awaiting_details', 'rejected', 'pending_review'].map((fromStatus) => ({
        invoiceRequestId: invoice!.id,
        fromStatus,
        toStatus: 'pending_review',
        reason: '隔离样本',
        createdAt: yesterday,
      })),
    );
    const [application] = await db
      .insert(refundRequests)
      .values({
        organizationId,
        eventId,
        orderId: second.order.id,
        paymentId: second.payment.id,
        source: 'admin',
        amount: 500,
        currency: 'CNY',
        reservedAmount: 500,
        policySnapshot: {},
        businessSnapshot: {},
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        createdAt: yesterday,
        reviewStatus: 'approved',
        fulfillmentStatus: 'open',
      })
      .returning();
    await db.insert(refunds).values({
      organizationId,
      eventId,
      orderId: second.order.id,
      paymentId: second.payment.id,
      requestId: application!.id,
      refundNo: randomUUID(),
      amount: 500,
      currency: 'CNY',
      status: 'waiting_funds',
      source: 'manual',
      currentAttempt: true,
      reason: '验收',
      idempotencyKey: randomUUID(),
    });
    await db.insert(refunds).values({
      organizationId,
      eventId,
      orderId: first.order.id,
      refundNo: randomUUID(),
      amount: 1000,
      currency: 'CNY',
      status: 'succeeded',
      source: 'manual',
      reason: '验收',
      idempotencyKey: randomUUID(),
      createdAt: before,
      providerPayload: { requestHash: 'b'.repeat(64), processedAt: yesterday.toISOString() },
    });
    const result = await snapshot();
    expect(result.daily).toMatchObject({
      newRegistrations: 1,
      paidOrders: 1,
      grossReceipts: 10000,
      refundRequests: 1,
      successfulRefunds: 1,
      refundAmount: 1000,
      netCash: 9000,
      invoiceDemands: 1,
      invoiceSubmissions: 1,
    });
    expect(result.todos).toMatchObject({
      refundPendingReview: 0,
      refundWaitingFunds: 1,
      invoiceActionable: 1,
    });
    expect(result.monitoring.invoiceAwaitingDetails).toBe(1);
    expect(result.cumulative.netRevenue).toBe(19000);
  });
  it('limits unknown historical refund times to days that could contain the success', async () => {
    const { order } = await paid(before);
    await connection.db.insert(refunds).values({
      organizationId,
      eventId,
      orderId: order.id,
      refundNo: randomUUID(),
      amount: 1000,
      currency: 'CNY',
      status: 'succeeded',
      source: 'legacy',
      reason: '历史导入',
      idempotencyKey: randomUUID(),
      createdAt: before,
      providerPayload: {
        processedAt: yesterday.toISOString(),
        digestSuccessObservedAt: yesterday.toISOString(),
      },
    });
    expect((await snapshot()).daily).toMatchObject({
      successfulRefunds: null,
      refundAmount: null,
      netCash: null,
    });
    expect((await snapshot('2026-09-09')).daily).toMatchObject({
      successfulRefunds: 0,
      refundAmount: 0,
      netCash: 0,
    });
  });
  it.each([yesterday, null])(
    'withholds uncertain external refunds discovered after the report boundary (accepted %s)',
    async (acceptedAt) => {
      const { order, payment } = await paid(before);
      await connection.db.insert(refunds).values({
        organizationId,
        eventId,
        orderId: order.id,
        paymentId: payment.id,
        refundNo: randomUUID(),
        amount: 1000,
        currency: 'CNY',
        status: 'succeeded',
        source: 'external',
        merchantId: 'fixture-merchant',
        outRefundNo: randomUUID(),
        reason: '外部退款核验',
        idempotencyKey: randomUUID(),
        acceptedAt,
        createdAt: report,
        updatedAt: report,
      });
      expect((await snapshot()).daily).toMatchObject({
        successfulRefunds: null,
        refundAmount: null,
        netCash: null,
      });
      expect((await snapshot('2026-09-10')).daily).toMatchObject({
        successfulRefunds: 0,
        refundAmount: 0,
        netCash: 0,
      });
    },
  );

  it('keeps counts while withholding totals across currencies', async () => {
    await paid();
    await paid(yesterday, 'USD');
    const result = await snapshot();
    expect(result.daily).toMatchObject({
      paidOrders: 2,
      newRegistrations: 2,
      grossReceipts: null,
      refundAmount: null,
      netCash: null,
    });
    expect(result.cumulative.netRevenue).toBeNull();
    expect(result.qualityIssues.some((issue) => issue.category === 'money_quality')).toBe(true);
  });
  it('includes records merged after the report boundary and excludes earlier duplicate records', async () => {
    const early = await paid();
    const late = await paid();
    await connection.db
      .update(registrations)
      .set({ supersededAt: new Date('2026-09-08T15:59:59Z') })
      .where(eq(registrations.id, early.registration.id));
    await connection.db
      .update(registrations)
      .set({ supersededAt: new Date('2026-09-08T16:00:00Z') })
      .where(eq(registrations.id, late.registration.id));
    const result = await snapshot();
    expect(result.daily.newRegistrations).toBe(1);
    expect(result.cumulative.validRegistrations).toBe(0);
  });
  it('withholds money for one successful payment whose amount differs from the order', async () => {
    const { payment } = await paid();
    await connection.db.update(payments).set({ amount: 5000 }).where(eq(payments.id, payment.id));
    const result = await snapshot();
    expect(result.daily.paidOrders).toBe(1);
    expect(result.daily.grossReceipts).toBeNull();
    expect(result.cumulative.netRevenue).toBeNull();
  });
});
