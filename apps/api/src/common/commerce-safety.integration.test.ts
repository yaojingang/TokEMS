import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventId } from '@conference/contracts';
import {
  events,
  inventoryReservations,
  orders,
  organizations,
  outboxEvents,
  payments,
  refunds,
  registrations,
  tickets,
  ticketTypes,
  users,
} from '@conference/database';
import { and, eq } from 'drizzle-orm';
import { CommerceOperationsService } from './commerce-operations.service.js';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('durable commerce safety boundaries', () => {
  const database = new DatabaseService();
  const commerce = new CommerceOperationsService(database);
  const repository = new ConferenceRepository(database);
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const ticketTypeIds = {
    refunds: randomUUID(),
    reviewPaid: randomUUID(),
    reviewFree: randomUUID(),
    reviewFull: randomUUID(),
  };
  let eventId: EventId;
  let mobileSequence = 0;

  async function seedOrder(input: {
    ticketTypeId: string;
    orderStatus: 'paid' | 'pending_review';
    registrationStatus: 'confirmed' | 'checked_in' | 'pending_review' | 'cancelled';
    amount: number;
    ticketStatus?: 'valid' | 'used' | 'cancelled';
    reservation?: boolean;
    supersededAt?: Date;
  }) {
    mobileSequence += 1;
    const registrationId = randomUUID();
    const orderId = randomUUID();
    await database.db!.insert(registrations).values({
      id: registrationId,
      organizationId,
      eventId,
      ticketTypeId: input.ticketTypeId,
      registrationCode: `SAFE-${randomUUID().slice(0, 8)}`,
      status: input.registrationStatus,
      attendee: {
        name: '安全验收参会人',
        mobile: `1398000${String(mobileSequence).padStart(4, '0')}`,
        email: `safety-${mobileSequence}@example.test`,
        company: '验收公司',
        title: '负责人',
        city: '深圳',
      },
      attendeeMobileE164: `+861398000${String(mobileSequence).padStart(4, '0')}`,
      attendeeEmailNormalized: `safety-${mobileSequence}@example.test`,
      ...(input.supersededAt ? { supersededAt: input.supersededAt } : {}),
    });
    await database.db!.insert(orders).values({
      id: orderId,
      organizationId,
      eventId,
      registrationId,
      orderNo: `SAFE${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      status: input.orderStatus,
      amount: input.amount,
      currency: 'CNY',
      pricingSnapshot: { source: 'commerce-safety-integration' },
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    if (input.orderStatus === 'paid') {
      await database.db!.insert(payments).values({
        orderId,
        provider: 'free',
        status: 'succeeded',
        succeededAt: new Date(),
        amount: input.amount,
        currency: 'CNY',
      });
    }
    if (input.ticketStatus) {
      await database.db!.insert(tickets).values({
        eventId,
        registrationId,
        ticketTypeId: input.ticketTypeId,
        code: `SAFE-T-${randomUUID()}`,
        status: input.ticketStatus,
      });
    }
    if (input.reservation) {
      await database.db!.insert(inventoryReservations).values({
        eventId,
        ticketTypeId: input.ticketTypeId,
        orderId,
        quantity: 1,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
    }
    return { registrationId, orderId };
  }

  beforeAll(async () => {
    await database.db!.insert(organizations).values({
      id: organizationId,
      slug: `commerce-safety-${organizationId.slice(0, 8)}`,
      name: '交易安全验收组织',
    });
    await database.db!.insert(users).values({
      id: actorId,
      email: `commerce-safety-${actorId.slice(0, 8)}@example.test`,
      name: '交易安全验收员',
    });
    const [event] = await database.db!
      .insert(events)
      .values({
        organizationId,
        slug: `commerce-safety-event-${organizationId.slice(0, 8)}`,
        name: '交易安全验收大会',
        shortName: '交易安全',
        tagline: '验证退款和审核库存原子性',
        description: '持久化交易安全回归测试。',
        status: 'registration_open',
        startsAt: new Date('2027-11-01T01:00:00.000Z'),
        endsAt: new Date('2027-11-01T10:00:00.000Z'),
        timezone: 'Asia/Shanghai',
        venue: '深圳验收会场',
        city: '深圳',
        address: '深圳市南山区验收路 1 号',
      })
      .returning({ id: events.id });
    eventId = event!.id;
    await database.db!.insert(ticketTypes).values([
      {
        id: ticketTypeIds.refunds,
        organizationId,
        eventId,
        code: 'SAFE-REFUND',
        name: '退款安全票',
        description: '验证签到后退款',
        price: 10_000,
        capacity: 20,
        sold: 3,
      },
      {
        id: ticketTypeIds.reviewPaid,
        organizationId,
        eventId,
        code: 'SAFE-REVIEW-PAID',
        name: '付费审核票',
        description: '验证当前订单 reservation 排除',
        price: 10_000,
        capacity: 2,
        sold: 1,
      },
      {
        id: ticketTypeIds.reviewFree,
        organizationId,
        eventId,
        code: 'SAFE-REVIEW-FREE',
        name: '免费审核票',
        description: '验证免费订单审核',
        price: 0,
        capacity: 1,
        sold: 0,
      },
      {
        id: ticketTypeIds.reviewFull,
        organizationId,
        eventId,
        code: 'SAFE-REVIEW-FULL',
        name: '已满审核票',
        description: '验证有效 reservation 占用',
        price: 10_000,
        capacity: 1,
        sold: 0,
      },
    ]);
  });

  afterAll(async () => {
    if (eventId) await database.db!.delete(organizations).where(eq(organizations.id, organizationId));
    await database.db!.delete(users).where(eq(users.id, actorId));
    await database.onModuleDestroy();
  });

  it.each([
    { ticketStatus: 'used' as const, registrationStatus: 'confirmed' as const },
    { ticketStatus: 'valid' as const, registrationStatus: 'checked_in' as const },
  ])('keeps every durable aggregate unchanged when a full refund conflicts with attendance', async (state) => {
    const seeded = await seedOrder({
      ticketTypeId: ticketTypeIds.refunds,
      orderStatus: 'paid',
      registrationStatus: state.registrationStatus,
      amount: 10_000,
      ticketStatus: state.ticketStatus,
    });
    const beforeOutbox = await database.db!
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.organizationId, organizationId), eq(outboxEvents.eventId, eventId)));

    await expect(
      commerce.refundOrder(
        organizationId,
        seeded.orderId,
        actorId,
        randomUUID(),
        { amount: 10_000, reason: '全额退款安全验收' },
      ),
    ).rejects.toMatchObject({ status: 409 });

    const [[order], [ticket], [ticketType], createdRefunds, afterOutbox] = await Promise.all([
      database.db!.select().from(orders).where(eq(orders.id, seeded.orderId)).limit(1),
      database.db!.select().from(tickets).where(eq(tickets.registrationId, seeded.registrationId)).limit(1),
      database.db!.select().from(ticketTypes).where(eq(ticketTypes.id, ticketTypeIds.refunds)).limit(1),
      database.db!.select().from(refunds).where(eq(refunds.orderId, seeded.orderId)),
      database.db!
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.organizationId, organizationId), eq(outboxEvents.eventId, eventId))),
    ]);
    expect(order?.status).toBe('paid');
    expect(ticket?.status).toBe(state.ticketStatus);
    expect(ticketType?.sold).toBe(3);
    expect(createdRefunds).toHaveLength(0);
    expect(afterOutbox).toHaveLength(beforeOutbox.length);
  });

  it('still permits a partial refund after attendance without cancelling the ticket or seat', async () => {
    const seeded = await seedOrder({
      ticketTypeId: ticketTypeIds.refunds,
      orderStatus: 'paid',
      registrationStatus: 'checked_in',
      amount: 10_000,
      ticketStatus: 'used',
    });
    await expect(
      commerce.refundOrder(
        organizationId,
        seeded.orderId,
        actorId,
        randomUUID(),
        { amount: 1_000, reason: '部分退款安全验收' },
      ),
    ).resolves.toMatchObject({ amount: 1_000, status: 'succeeded' });
    const [[order], [ticket], [ticketType]] = await Promise.all([
      database.db!.select().from(orders).where(eq(orders.id, seeded.orderId)).limit(1),
      database.db!.select().from(tickets).where(eq(tickets.registrationId, seeded.registrationId)).limit(1),
      database.db!.select().from(ticketTypes).where(eq(ticketTypes.id, ticketTypeIds.refunds)).limit(1),
    ]);
    expect(order?.status).toBe('partially_refunded');
    expect(ticket?.status).toBe('used');
    expect(ticketType?.sold).toBe(3);
  });

  it('loads a superseded paid registration by order scope and releases its valid ticket seat', async () => {
    const seeded = await seedOrder({
      ticketTypeId: ticketTypeIds.refunds,
      orderStatus: 'paid',
      registrationStatus: 'confirmed',
      amount: 10_000,
      ticketStatus: 'valid',
      supersededAt: new Date(),
    });
    const [before] = await database.db!
      .select({ sold: ticketTypes.sold })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticketTypeIds.refunds))
      .limit(1);
    await expect(
      commerce.refundOrder(
        organizationId,
        seeded.orderId,
        actorId,
        randomUUID(),
        { amount: 10_000, reason: '已合并报名全额退款' },
      ),
    ).resolves.toMatchObject({ status: 'succeeded' });
    const [after] = await database.db!
      .select({ sold: ticketTypes.sold })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticketTypeIds.refunds))
      .limit(1);
    expect(after?.sold).toBe((before?.sold ?? 0) - 1);
  });

  it('does not release inventory twice for an already-cancelled registration and ticket', async () => {
    const seeded = await seedOrder({
      ticketTypeId: ticketTypeIds.refunds,
      orderStatus: 'paid',
      registrationStatus: 'cancelled',
      amount: 10_000,
      ticketStatus: 'cancelled',
    });
    const [before] = await database.db!
      .select({ sold: ticketTypes.sold })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticketTypeIds.refunds))
      .limit(1);
    await expect(
      commerce.refundOrder(
        organizationId,
        seeded.orderId,
        actorId,
        randomUUID(),
        { amount: 10_000, reason: '已取消票全额退款' },
      ),
    ).resolves.toMatchObject({ status: 'succeeded' });
    const [after] = await database.db!
      .select({ sold: ticketTypes.sold })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticketTypeIds.refunds))
      .limit(1);
    expect(after?.sold).toBe(before?.sold);
  });

  it('recalculates review inventory under lock for paid and free orders and excludes the current reservation', async () => {
    const paid = await seedOrder({
      ticketTypeId: ticketTypeIds.reviewPaid,
      orderStatus: 'pending_review',
      registrationStatus: 'pending_review',
      amount: 10_000,
      reservation: true,
    });
    const free = await seedOrder({
      ticketTypeId: ticketTypeIds.reviewFree,
      orderStatus: 'pending_review',
      registrationStatus: 'pending_review',
      amount: 0,
      reservation: true,
    });
    await expect(
      repository.reviewRegistration(
        eventId,
        paid.registrationId,
        organizationId,
        actorId,
        { decision: 'approve', reason: '付费票审核验收' },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ order: { status: 'pending_payment' } });
    await expect(
      repository.reviewRegistration(
        eventId,
        free.registrationId,
        organizationId,
        actorId,
        { decision: 'approve', reason: '免费票审核验收' },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ order: { status: 'paid' }, registration: { status: 'confirmed' } });
    const [freeType] = await database.db!
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticketTypeIds.reviewFree))
      .limit(1);
    expect(freeType?.sold).toBe(1);
  });

  it('keeps review pending when another valid reservation consumes the final seat', async () => {
    const current = await seedOrder({
      ticketTypeId: ticketTypeIds.reviewFull,
      orderStatus: 'pending_review',
      registrationStatus: 'pending_review',
      amount: 10_000,
      reservation: true,
    });
    await seedOrder({
      ticketTypeId: ticketTypeIds.reviewFull,
      orderStatus: 'pending_review',
      registrationStatus: 'pending_review',
      amount: 10_000,
      reservation: true,
    });
    await expect(
      repository.reviewRegistration(
        eventId,
        current.registrationId,
        organizationId,
        actorId,
        { decision: 'approve', reason: '最后名额已被占用' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const [[registration], [order]] = await Promise.all([
      database.db!.select().from(registrations).where(eq(registrations.id, current.registrationId)).limit(1),
      database.db!.select().from(orders).where(eq(orders.id, current.orderId)).limit(1),
    ]);
    expect(registration?.status).toBe('pending_review');
    expect(order?.status).toBe('pending_review');
  });
});
