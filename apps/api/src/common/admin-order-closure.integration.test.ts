import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  auditLogs,
  events,
  inventoryReservations,
  orders,
  orderStateLogs,
  organizations,
  outboxEvents,
  paymentNotificationInbox,
  payments,
  registrations,
  tickets,
  ticketTypes,
  users,
  releasedInventoryReservationScope,
} from '@conference/database';
import { DatabaseService } from './database.service.js';
import { ConferenceRepository } from './conference.repository.js';
import { WeChatPayService } from './wechat-pay.service.js';

// Real PostgreSQL transactions and payment orchestration; only the external gateway is replaced.
const persistent = process.env.DATABASE_URL ? describe : describe.skip;
persistent('admin unpaid order closure', () => {
  const database = new DatabaseService();
  const db = database.db!;
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const ticketTypeId = randomUUID();
  let eventId: number;
  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: organizationId, slug: `close-${organizationId}`, name: '关单测试组织' });
    await db
      .insert(users)
      .values({ id: actorId, name: '关单测试管理员', email: `${actorId}@example.com` });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `close-${organizationId}`,
        name: '关单测试大会',
        shortName: '关单测试',
        tagline: '测试',
        description: '测试',
        status: 'registration_open',
        startsAt: new Date('2027-01-01'),
        endsAt: new Date('2027-01-02'),
        timezone: 'Asia/Shanghai',
        venue: '测试',
        city: '测试',
        address: '测试',
      })
      .returning();
    eventId = event!.id;
    await db.insert(ticketTypes).values({
      id: ticketTypeId,
      organizationId,
      eventId,
      code: 'CLOSE',
      name: '测试票',
      description: '测试票',
      price: 39900,
      capacity: 100,
    });
  });
  afterAll(async () => {
    await db
      .delete(paymentNotificationInbox)
      .where(eq(paymentNotificationInbox.organizationId, organizationId));
    await db.delete(tickets).where(eq(tickets.eventId, eventId));
    const rows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.organizationId, organizationId));
    await db.update(orders).set({ settledPaymentId: null }).where(eq(orders.organizationId, organizationId));
    for (const row of rows) await db.delete(payments).where(eq(payments.orderId, row.id));
    await db.delete(orders).where(eq(orders.organizationId, organizationId));
    await db.delete(registrations).where(eq(registrations.organizationId, organizationId));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(users).where(eq(users.id, actorId));
    await database.onModuleDestroy();
  });

  async function fixture(
    withAttempt = true,
    status: 'pending_payment' | 'processing' | 'paid' = 'pending_payment',
  ) {
    const registrationId = randomUUID();
    const orderId = randomUUID();
    const expiresAt = new Date(Date.now() + 900000);
    await db.insert(registrations).values({
      id: registrationId,
      organizationId,
      eventId,
      ticketTypeId,
      registrationCode: `C-${registrationId}`,
      status: 'pending_payment',
      attendee: {
        name: '测试参会者',
        mobile: '13800138000',
        email: '',
        company: '',
        title: '',
        city: '',
      },
    });
    const [order] = await db
      .insert(orders)
      .values({
        id: orderId,
        organizationId,
        eventId,
        registrationId,
        orderNo: `C-${orderId}`,
        amount: 39900,
        currency: 'CNY',
        status,
        pricingSnapshot: {},
        expiresAt,
        createdAt: new Date(Date.now() - 60000),
      })
      .returning();
    const [reservation] = await db
      .insert(inventoryReservations)
      .values({ eventId, ticketTypeId, orderId, expiresAt })
      .returning();
    const attemptId = randomUUID();
    const outTradeNo = attemptId.replaceAll('-', '');
    if (withAttempt)
      await db.insert(payments).values({
        id: attemptId,
        orderId,
        provider: 'wechatpay',
        channel: 'native',
        outTradeNo,
        status: 'pending',
        amount: 39900,
        currency: 'CNY',
        merchantId: 'test-merchant',
        prepayExpiresAt: expiresAt,
      });
    const service = new WeChatPayService(database, undefined, new ConferenceRepository(database));
    const internals = service as unknown as {
      queryWeChatTransaction: () => Promise<Record<string, unknown>>;
      closeWeChatOrder: () => Promise<void>;
      requiredIntegration: () => Promise<Record<string, unknown>>;
      finalizeAttemptStatus: (...args: unknown[]) => Promise<void>;
      beginCloseAttempt: (...args: unknown[]) => Promise<unknown>;
    };
    const query = vi
      .spyOn(internals, 'queryWeChatTransaction')
      .mockResolvedValueOnce({ trade_state: 'NOTPAY' })
      .mockResolvedValue({ trade_state: 'CLOSED' });
    const gatewayClose = vi.spyOn(internals, 'closeWeChatOrder').mockResolvedValue();
    vi.spyOn(internals, 'requiredIntegration').mockResolvedValue({ config: {}, credentials: {} });
    const close = (expected = expiresAt.toISOString(), actor = actorId) =>
      service.closeUnpaidOrder(
        orderId,
        eventId,
        organizationId,
        actor,
        '用户支付失败申请重新报名',
        expected,
      );
    const state = async () => {
      const [latest] = await db.select().from(orders).where(eq(orders.id, orderId));
      const [reg] = await db
        .select()
        .from(registrations)
        .where(eq(registrations.id, registrationId));
      const [held] = await db
        .select()
        .from(inventoryReservations)
        .where(eq(inventoryReservations.id, reservation!.id));
      return { order: latest!, registration: reg!, reservation: held! };
    };
    return {
      close,
      service,
      internals,
      query,
      gatewayClose,
      state,
      order: order!,
      orderId,
      registrationId,
      attemptId,
      outTradeNo,
    };
  }

  it.each([false, true])(
    'closes an unpaid order atomically and remains idempotent (attempt=%s)',
    async (attempt) => {
      const f = await fixture(attempt);
      await expect(f.close()).resolves.toEqual({ orderId: f.orderId, status: 'closed' });
      await expect(f.close()).resolves.toEqual({ orderId: f.orderId, status: 'closed' });
      const state = await f.state();
      expect(state.order.status).toBe('closed');
      expect(state.registration.status).toBe('cancelled');
      expect(state.reservation.releasedAt).not.toBeNull();
      expect(state.reservation.convertedAt).toBeNull();
      expect(
        await db.select().from(orderStateLogs).where(eq(orderStateLogs.orderId, f.orderId)),
      ).toHaveLength(1);
      expect(
        await db.select().from(auditLogs).where(eq(auditLogs.resourceId, f.orderId)),
      ).toHaveLength(1);
      const notices = await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.organizationId, organizationId),
            eq(outboxEvents.correlationId, `reservation:expired:${state.reservation.id}`),
          ),
        );
      expect(notices).toHaveLength(1);
      expect(f.gatewayClose).toHaveBeenCalledTimes(attempt ? 1 : 0);
    },
  );
  it('closes a processing order only after confirmed provider closure', async () => {
    const f = await fixture(true, 'processing');
    await f.close();
    expect((await f.state()).order.status).toBe('closed');
  });
  it.each(['USERPAYING', 'unknown-close', 'query-failed', 'preparing'])(
    'preserves inventory when payment is %s',
    async (mode) => {
      const f = await fixture();
      if (mode === 'USERPAYING')
        f.query.mockReset().mockResolvedValue({ trade_state: 'USERPAYING' });
      if (mode === 'unknown-close')
        f.query.mockReset().mockResolvedValue({ trade_state: 'NOTPAY' });
      if (mode === 'query-failed')
        f.query.mockReset().mockRejectedValue(new Error('gateway unavailable'));
      if (mode === 'preparing')
        await db
          .update(payments)
          .set({ status: 'preparing', updatedAt: new Date() })
          .where(eq(payments.id, f.attemptId));
      await expect(f.close()).rejects.toMatchObject({ status: 409 });
      expect((await f.state()).reservation.releasedAt).toBeNull();
      expect((await f.state()).order.status).toBe('pending_payment');
    },
  );
  it('synchronizes a provider success into a paid order and ticket instead of closing', async () => {
    const f = await fixture();
    f.query.mockReset().mockResolvedValue({
      trade_state: 'SUCCESS',
      transaction_id: randomUUID(),
      success_time: new Date().toISOString(),
      amount: { total: 39900, currency: 'CNY' },
    });
    await expect(f.close()).rejects.toMatchObject({ status: 409 });
    expect(f.gatewayClose).not.toHaveBeenCalled();
    const state = await f.state();
    expect(state.order.status).toBe('paid');
    expect(state.reservation.releasedAt).toBeNull();
    expect(state.reservation.convertedAt).not.toBeNull();
    expect(
      await db.select().from(tickets).where(eq(tickets.registrationId, f.registrationId)),
    ).toHaveLength(1);
  });
  it('rejects a stale admin snapshot and cross-organization/event order IDs before contacting WeChat', async () => {
    const f = await fixture();
    await expect(f.close(new Date(0).toISOString())).rejects.toMatchObject({ status: 409 });
    await expect(
      f.service.closeUnpaidOrder(
        f.orderId,
        eventId,
        randomUUID(),
        actorId,
        'scope test',
        f.order.expiresAt.toISOString(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.service.closeUnpaidOrder(
        f.orderId,
        eventId + 1,
        organizationId,
        actorId,
        'scope test',
        f.order.expiresAt.toISOString(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each(['new-attempt', 'new-registration'])(
    'rejects a concurrent %s after the old provider payment closes',
    async (mode) => {
      const f = await fixture();
      const finalize = f.internals.finalizeAttemptStatus.bind(f.internals);
      vi.spyOn(f.internals, 'finalizeAttemptStatus').mockImplementation(async (...args) => {
        await finalize(...args);
        if (mode === 'new-attempt')
          await db.insert(payments).values({
            orderId: f.orderId,
            provider: 'wechatpay',
            channel: 'native',
            outTradeNo: randomUUID().replaceAll('-', ''),
            status: 'pending',
            amount: 39900,
            currency: 'CNY',
          });
        else
          await db
            .update(orders)
            .set({
              purchaseIntentId: randomUUID(),
              expiresAt: new Date(Date.now() + 1800000),
              updatedAt: new Date(),
            })
            .where(eq(orders.id, f.orderId));
      });
      await expect(f.close()).rejects.toMatchObject({ status: 409 });
      expect((await f.state()).order.status).toBe('pending_payment');
      expect((await f.state()).reservation.releasedAt).toBeNull();
    },
  );
  it('rolls back local closure and inventory if audit persistence fails', async () => {
    const f = await fixture(false);
    await expect(f.close(undefined, randomUUID())).rejects.toThrow();
    const state = await f.state();
    expect(state.order.status).toBe('pending_payment');
    expect(state.registration.status).toBe('pending_payment');
    expect(state.reservation.releasedAt).toBeNull();
    await expect(f.close()).resolves.toMatchObject({ status: 'closed' });
  });
  it('does not touch a new payment created by re-registration before the close lease is claimed', async () => {
    const f = await fixture(false);
    const claim = f.internals.beginCloseAttempt.bind(f.internals);
    let newPaymentId: string;
    vi.spyOn(f.internals, 'beginCloseAttempt').mockImplementation(async (...args) => {
      await db
        .update(orders)
        .set({
          purchaseIntentId: randomUUID(),
          expiresAt: new Date(Date.now() + 1800000),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, f.orderId));
      const [newPayment] = await db
        .insert(payments)
        .values({
          orderId: f.orderId,
          provider: 'wechatpay',
          channel: 'native',
          outTradeNo: randomUUID().replaceAll('-', ''),
          status: 'pending',
          amount: 39900,
          currency: 'CNY',
        })
        .returning();
      newPaymentId = newPayment!.id;
      return claim(...args);
    });
    await expect(f.close()).rejects.toMatchObject({ status: 409 });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.gatewayClose).not.toHaveBeenCalled();
    const [untouched] = await db.select().from(payments).where(eq(payments.id, newPaymentId!));
    expect(untouched?.status).toBe('pending');
    expect((await f.state()).reservation.releasedAt).toBeNull();
  });
  it('preserves the original released ticket scope after re-registration and later conversion of historical reservations', async () => {
    const f = await fixture(false);
    await f.close();
    const { reservation } = await f.state();
    const [secondTicket] = await db
      .insert(ticketTypes)
      .values({
        organizationId,
        eventId,
        code: `B-${f.orderId}`,
        name: '新票种',
        description: '新票种',
        price: 39900,
        capacity: 100,
      })
      .returning();
    await db
      .update(registrations)
      .set({ ticketTypeId: secondTicket!.id })
      .where(eq(registrations.id, f.registrationId));
    await db
      .update(inventoryReservations)
      .set({ convertedAt: new Date() })
      .where(eq(inventoryReservations.orderId, f.orderId));
    await expect(releasedInventoryReservationScope(db, f.orderId, reservation.id)).resolves.toEqual(
      { eventId, ticketTypeId },
    );
    await expect(
      releasedInventoryReservationScope(db, randomUUID(), reservation.id),
    ).resolves.toBeUndefined();
  });
  it.each([false, true])(
    'can retry processing-order closure after business rollback (legacy=%s)',
    async (legacy) => {
      const f = await fixture(true, 'processing');
      if (legacy)
        await db
          .update(payments)
          .set({ merchantId: null, prepayExpiresAt: null })
          .where(eq(payments.id, f.attemptId));
      await expect(f.close(undefined, randomUUID())).rejects.toThrow();
      expect((await f.state()).order.status).toBe('processing');
      expect((await f.state()).reservation.releasedAt).toBeNull();
      await expect(f.close()).resolves.toMatchObject({ status: 'closed' });
      expect(f.gatewayClose).toHaveBeenCalledOnce();
    },
  );
  it.each(['paid', 'processing-without-attempt', 'success-notification', 'converted'])(
    'keeps payment evidence safe (%s)',
    async (mode) => {
      const f = await fixture(
        false,
        mode === 'paid'
          ? 'paid'
          : mode === 'processing-without-attempt'
            ? 'processing'
            : 'pending_payment',
      );
      if (mode === 'success-notification')
        await db.insert(paymentNotificationInbox).values({
          organizationId,
          notificationId: randomUUID(),
          outTradeNo: f.outTradeNo,
          orderId: f.orderId,
          eventType: 'TRANSACTION.SUCCESS',
          status: 'dead',
        });
      if (mode === 'converted')
        await db
          .update(inventoryReservations)
          .set({ convertedAt: new Date() })
          .where(eq(inventoryReservations.orderId, f.orderId));
      await expect(f.close()).rejects.toMatchObject({ status: 409 });
      expect((await f.state()).reservation.releasedAt).toBeNull();
    },
  );
});
