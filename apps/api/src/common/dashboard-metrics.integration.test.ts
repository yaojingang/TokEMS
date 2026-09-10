import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  customerUsers,
  events,
  orders,
  organizations,
  refunds,
  registrations,
  ticketTypes,
} from '@conference/database';
import { eq } from 'drizzle-orm';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('PostgreSQL dashboard metric semantics', () => {
  const database = new DatabaseService();
  const repository = new ConferenceRepository(database);
  const organizationId = randomUUID();
  const purchaserOne = randomUUID();
  const purchaserTwo = randomUUID();
  const ticketTypeId = randomUUID();
  let eventId = 0;
  let emptyEventId = 0;

  beforeAll(async () => {
    const db = database.db!;
    await db.insert(organizations).values({
      id: organizationId,
      slug: `dashboard-metrics-${randomUUID().slice(0, 8)}`,
      name: '指标口径测试组织',
    });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `dashboard-metrics-event-${randomUUID().slice(0, 8)}`,
        name: '指标口径测试大会',
        shortName: '指标测试',
        tagline: '验证管理后台指标口径',
        description: '验证订单、席位、参会人、购票人与净收入分别统计。',
        status: 'registration_open',
        startsAt: new Date('2027-09-01T01:00:00.000Z'),
        endsAt: new Date('2027-09-01T10:00:00.000Z'),
        timezone: 'Asia/Shanghai',
        venue: '深圳测试会场',
        city: '深圳',
        address: '深圳测试地址',
        settings: {},
      })
      .returning();
    eventId = event!.id;
    const [emptyEvent] = await db
      .insert(events)
      .values({ ...event!, id: undefined, slug: `${event!.slug}-empty` })
      .returning({ id: events.id });
    emptyEventId = emptyEvent!.id;
    await db.insert(ticketTypes).values({
      id: ticketTypeId,
      organizationId,
      eventId,
      code: 'STANDARD',
      name: '标准票',
      description: '指标测试标准票',
      price: 39_900,
      capacity: 20,
    });
    await db.insert(customerUsers).values([
      { id: purchaserOne, organizationId, mobileE164: '+8613800138001' },
      { id: purchaserTwo, organizationId, mobileE164: '+8613800138002' },
    ]);

    const statuses = [
      'confirmed',
      'confirmed',
      'cancelled',
      'checked_in',
      'pending_review',
      'completed',
    ] as const;
    const registrationIds = statuses.map(() => randomUUID());
    await db.insert(registrations).values(
      statuses.map((status, index) => ({
        id: registrationIds[index]!,
        organizationId,
        eventId,
        ticketTypeId,
        registrationCode: `METRIC-${index}-${randomUUID().slice(0, 8)}`,
        status,
        attendee: {
          name: `参会人 ${index + 1}`,
          mobile: `1380013800${index}`,
          email: `metric-${index}@example.com`,
          company: '指标测试公司',
          title: '负责人',
          city: '深圳',
        },
      })),
    );

    const orderStatuses = [
      'paid',
      'partially_refunded',
      'partially_refunded',
      'refunded',
      'pending_review',
    ] as const;
    const orderIds = orderStatuses.map(() => randomUUID());
    await db.insert(orders).values(
      orderStatuses.map((status, index) => {
        const purchaserCustomerUserId = index < 2 ? purchaserOne : purchaserTwo;
        return {
          id: orderIds[index]!,
          organizationId,
          eventId,
          registrationId: registrationIds[index]!,
          purchaserCustomerUserId,
          purchaserSnapshot: {
            customerUserId: purchaserCustomerUserId,
            mobile: index < 2 ? '+8613800138001' : '+8613800138002',
            name: index < 2 ? '购票人一' : '购票人二',
            email: index < 2 ? 'buyer-1@example.com' : 'buyer-2@example.com',
            company: '指标测试公司',
            title: '负责人',
            city: '深圳',
          },
          purchaseIntentId: randomUUID(),
          orderNo: `METRIC-ORDER-${index}-${randomUUID().slice(0, 8)}`,
          status,
          amount: 39_900,
          currency: 'CNY',
          pricingSnapshot: {},
          expiresAt: new Date('2027-09-01T00:00:00.000Z'),
        };
      }),
    );
    await db.insert(refunds).values([
      {
        organizationId,
        eventId,
        orderId: orderIds[1]!,
        refundNo: `METRIC-REFUND-1-${randomUUID().slice(0, 8)}`,
        amount: 6_001,
        currency: 'CNY',
        status: 'succeeded',
        reason: '部分退款测试',
        idempotencyKey: randomUUID(),
      },
      {
        organizationId,
        eventId,
        orderId: orderIds[1]!,
        refundNo: `METRIC-REFUND-REPEAT-${randomUUID().slice(0, 8)}`,
        amount: 4_000,
        currency: 'CNY',
        status: 'succeeded',
        reason: '同一订单再次部分退款',
        idempotencyKey: randomUUID(),
      },
      {
        organizationId,
        eventId,
        orderId: orderIds[2]!,
        refundNo: `METRIC-REFUND-2-${randomUUID().slice(0, 8)}`,
        amount: 5_000,
        currency: 'CNY',
        status: 'succeeded',
        reason: '取消参会人部分退款测试',
        idempotencyKey: randomUUID(),
      },
      {
        organizationId,
        eventId,
        orderId: orderIds[3]!,
        refundNo: `METRIC-REFUND-3-${randomUUID().slice(0, 8)}`,
        amount: 39_900,
        currency: 'CNY',
        status: 'succeeded',
        reason: '全额退款测试',
        idempotencyKey: randomUUID(),
      },
    ]);
    await db.insert(refunds).values(
      ['pending', 'processing', 'failed', 'closed'].map((status) => ({
        organizationId,
        eventId,
        orderId: orderIds[0]!,
        refundNo: `METRIC-${status}-${randomUUID().slice(0, 8)}`,
        amount: 8_888,
        currency: 'CNY',
        status,
        reason: '未成功的退款应排除',
        idempotencyKey: randomUUID(),
      })),
    );
  });

  afterAll(async () => {
    if (database.db)
      await database.db.delete(organizations).where(eq(organizations.id, organizationId));
    await database.onModuleDestroy();
  });

  it('retains refunded orders in cumulative paid orders while counting active seats and net revenue separately', async () => {
    const dashboard = await repository.getDashboard(eventId, organizationId);

    expect(dashboard.metrics).toEqual({
      registrations: 6,
      paidOrders: 4,
      paidSeats: 2,
      confirmedAttendees: 4,
      purchasers: 2,
      revenue: 104_699,
      refundedOrders: 3,
      refundedAmount: 54_901,
      checkedIn: 0,
      conversionRate: 40,
      pendingReview: 1,
    });
  });

  it('returns zero refund metrics for another event with no refunds', async () => {
    const dashboard = await repository.getDashboard(emptyEventId, organizationId);

    expect(dashboard.metrics.refundedOrders).toBe(0);
    expect(dashboard.metrics.refundedAmount).toBe(0);
  });

  it('keeps cumulative refunds independent of the registration trend date range', async () => {
    const dashboard = await repository.getDashboard(eventId, organizationId, {
      from: '2020-01-01',
      to: '2020-01-02',
    });

    expect(dashboard.metrics.refundedOrders).toBe(3);
    expect(dashboard.metrics.refundedAmount).toBe(54_901);
    expect(dashboard.registrationTrend.every((day) => day.value === 0)).toBe(true);
  });
});
