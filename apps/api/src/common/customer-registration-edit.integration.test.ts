import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  attendeeClaimTokens,
  auditLogs,
  customerProfiles,
  customerUsers,
  events,
  inventoryReservations,
  orders,
  organizations,
  outboxEvents,
  payments,
  registrationForms,
  registrations,
  ticketTypes,
} from '@conference/database';
import type { UpdatePurchasedOrderAttendee } from '@conference/contracts';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import { CustomerAccountService } from './customer-account.service.js';
import { DatabaseService } from './database.service.js';

const persistent = process.env.DATABASE_URL ? describe : describe.skip;
persistent('customer pending registration edits', () => {
  const database = new DatabaseService();
  const db = database.db!;
  const account = new CustomerAccountService(database);
  const organizationId = randomUUID();
  const ticketTypeId = randomUUID();
  let eventId: number;
  let customerSequence = 0;
  const fields = [
    { key: 'name', label: '姓名', type: 'text' as const, required: true },
    { key: 'company', label: '公司', type: 'text' as const, required: true },
    { key: 'title', label: '职位', type: 'text' as const, required: false },
  ];
  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: organizationId, slug: `edit-${organizationId}`, name: '修改报名验收组织' });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `edit-${organizationId}`,
        name: '修改报名验收大会',
        shortName: '修改验收',
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
      code: 'EDIT',
      name: '测试票',
      description: '测试',
      price: 39900,
      capacity: 100,
    });
    await db.insert(registrationForms).values({
      eventId,
      version: 1,
      name: '历史报名表',
      fields,
      termsVersion: '1',
      termsContent: '测试条款',
    });
  });
  afterAll(async () => {
    const rows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.organizationId, organizationId));
    for (const row of rows) await db.delete(payments).where(eq(payments.orderId, row.id));
    await db.delete(orders).where(eq(orders.organizationId, organizationId));
    await db.delete(registrations).where(eq(registrations.organizationId, organizationId));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await database.onModuleDestroy();
  });
  async function fixture() {
    const customerUserId = randomUUID();
    const mobile = `+86138001${String(++customerSequence).padStart(5, '0')}`;
    await db
      .insert(customerUsers)
      .values({ id: customerUserId, organizationId, mobileE164: mobile });
    await db.insert(customerProfiles).values({ customerUserId, company: '会员资料原公司' });
    const attendee = {
      name: '测试参会人',
      mobile,
      email: '',
      company: '原公司',
      title: '经理',
      city: '',
    };
    const [registration] = await db
      .insert(registrations)
      .values({
        organizationId,
        eventId,
        ticketTypeId,
        customerUserId,
        registrationCode: `E-${randomUUID()}`,
        status: 'pending_payment',
        attendee,
        attendeeMobileE164: mobile,
        formAnswers: { ...attendee, custom_topic: '保留自定义回答' },
        consentSnapshot: { fieldDefinitions: fields },
      })
      .returning();
    const expiresAt = new Date(Date.now() + 900000);
    const [order] = await db
      .insert(orders)
      .values({
        organizationId,
        eventId,
        registrationId: registration!.id,
        purchaserCustomerUserId: customerUserId,
        orderNo: `E-${randomUUID()}`,
        amount: 39900,
        currency: 'CNY',
        status: 'pending_payment',
        pricingSnapshot: {},
        expiresAt,
      })
      .returning();
    await db
      .insert(inventoryReservations)
      .values({ eventId, ticketTypeId, orderId: order!.id, expiresAt });
    await db.insert(payments).values({
      orderId: order!.id,
      provider: 'wechatpay',
      channel: 'native',
      outTradeNo: randomUUID().replaceAll('-', ''),
      status: 'pending',
      amount: 39900,
      currency: 'CNY',
      payload: { code_url: 'weixin://fixture' },
      prepayExpiresAt: expiresAt,
    });
    const session: AuthenticatedCustomer = {
      sessionId: randomUUID(),
      customerUserId,
      organizationId,
      tokenHash: 'test',
      expiresAt,
      csrfToken: 'test',
      customer: {
        id: 101 + customerSequence,
        organizationId,
        mobile,
        maskedMobile: '138****0000',
        status: 'active',
        verifiedAt: new Date().toISOString(),
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
        profile: {
          realName: null,
          nickname: null,
          email: null,
          company: null,
          title: null,
          city: null,
          version: 1,
        },
      },
    };
    const detail = await account.registration(session, registration!.id);
    if (!detail.canManageOrder) throw new Error('Fixture requires purchaser access');
    const save = (patch: UpdatePurchasedOrderAttendee, version = detail.registrationEditVersion!) =>
      account.updatePurchasedOrderAttendee(session, order!.id, {
        ...patch,
        expectedRegistrationVersion: version,
      });
    const state = async () => ({
      registration: (
        await db.select().from(registrations).where(eq(registrations.id, registration!.id))
      )[0]!,
      order: (await db.select().from(orders).where(eq(orders.id, order!.id)))[0]!,
      payments: await db.select().from(payments).where(eq(payments.orderId, order!.id)),
      reservations: await db
        .select()
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, order!.id)),
    });
    return { session, registration: registration!, order: order!, detail, save, state };
  }
  it('updates the same registration and export answers while preserving the order, QR attempt, reservation and member profile', async () => {
    const f = await fixture();
    const before = await f.state();
    expect(f.detail.canEditRegistrationInfo).toBe(true);
    expect(
      f.detail.registrationEditFields.filter((field) => field.required).map((field) => field.key),
    ).toEqual(['name', 'company']);
    await f.save({ company: '更正公司', email: 'attendee@example.com' });
    const after = await f.state();
    expect(after.registration.attendee).toMatchObject({
      company: '更正公司',
      email: 'attendee@example.com',
    });
    expect(after.registration.formAnswers).toMatchObject({
      company: '更正公司',
      email: 'attendee@example.com',
      custom_topic: '保留自定义回答',
    });
    expect(after.order).toEqual(before.order);
    expect(after.payments).toEqual(before.payments);
    expect(after.reservations).toEqual(before.reservations);
    expect(
      await db
        .select()
        .from(attendeeClaimTokens)
        .where(eq(attendeeClaimTokens.registrationId, f.registration.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(outboxEvents).where(eq(outboxEvents.eventId, eventId)),
    ).toHaveLength(0);
    const [profile] = await db
      .select()
      .from(customerProfiles)
      .where(eq(customerProfiles.customerUserId, f.session.customerUserId));
    expect(profile?.company).toBe('会员资料原公司');
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, f.registration.id));
    expect(audit?.action).toBe('customer.order.attendee.update');
    expect(await account.createOrderPaymentAccess(f.session, f.order.id)).toHaveProperty(
      'orderId',
      f.order.id,
    );
  });
  it.each(['company', 'name'] as const)('rejects clearing required %s', async (key) => {
    const f = await fixture();
    await expect(f.save({ [key]: '' })).rejects.toThrow('必填项');
    expect((await f.state()).registration.attendee[key]).toBe(f.registration.attendee[key]);
  });
  it('uses the historical form when the consent snapshot has no field definitions', async () => {
    const f = await fixture();
    await db
      .update(registrations)
      .set({ consentSnapshot: {} })
      .where(eq(registrations.id, f.registration.id));
    await expect(f.save({ company: '' })).rejects.toThrow('必填项');
  });
  it('allows clearing an optional field and synchronizes its existing form answer', async () => {
    const f = await fixture();
    await f.save({ title: '' });
    expect((await f.state()).registration.formAnswers.title).toBe('');
  });
  it('does not permit changing the bound phone number', async () => {
    const f = await fixture();
    await expect(f.save({ mobile: '+8613900139000' })).rejects.toThrow('登录身份绑定');
  });
  it('enforces historical dropdown choices and saves a valid choice', async () => {
    const f = await fixture();
    await db
      .update(registrations)
      .set({
        consentSnapshot: {
          fieldDefinitions: [
            ...fields,
            {
              key: 'city',
              label: '城市',
              type: 'select',
              required: false,
              options: ['北京', '上海'],
            },
          ],
        },
      })
      .where(eq(registrations.id, f.registration.id));
    await expect(f.save({ city: '任意城市' })).rejects.toThrow('选项中选择');
    await f.save({ city: '上海' });
    expect((await f.state()).registration.formAnswers.city).toBe('上海');
  });
  it.each(['paid', 'processing', 'closed'] as const)(
    'rejects self edits after order becomes %s',
    async (status) => {
      const f = await fixture();
      await db.update(orders).set({ status }).where(eq(orders.id, f.order.id));
      await expect(f.save({ company: '不可保存' })).rejects.toThrow('当前订单状态无法修改');
      expect(
        (await account.registration(f.session, f.registration.id)).canEditRegistrationInfo,
      ).toBe(false);
    },
  );
  it('rejects a stale editor after re-registration reuses the same order and registration IDs', async () => {
    const f = await fixture();
    await db
      .update(orders)
      .set({ expiresAt: new Date(f.order.expiresAt.getTime() + 900000) })
      .where(eq(orders.id, f.order.id));
    await db
      .update(registrations)
      .set({ attendee: { ...f.registration.attendee, company: '重新报名公司' } })
      .where(eq(registrations.id, f.registration.id));
    await expect(f.save({ company: '旧页面公司' })).rejects.toThrow('报名信息已发生变化');
    await expect(f.save({ company: '旧页面公司' })).rejects.toMatchObject({
      details: { reason: 'registration_version_conflict' },
    });
    expect((await f.state()).registration.attendee.company).toBe('重新报名公司');
  });
  it('rejects self edits without the version from the loaded registration', async () => {
    const f = await fixture();
    await expect(
      account.updatePurchasedOrderAttendee(f.session, f.order.id, { company: '缺失版本' }),
    ).rejects.toThrow('报名信息已发生变化');
  });
  it('denies both cross-account and cross-organization reads and writes', async () => {
    const f = await fixture();
    for (const session of [
      { ...f.session, customerUserId: randomUUID() },
      { ...f.session, organizationId: randomUUID() },
    ]) {
      await expect(account.registration(session, f.registration.id)).rejects.toThrow(
        '报名记录不存在',
      );
      await expect(
        account.updatePurchasedOrderAttendee(session, f.order.id, { company: '无权修改' }),
      ).rejects.toThrow('订单不存在');
    }
  });
  it('retains purchaser editing for an unclaimed proxy registration', async () => {
    const f = await fixture();
    await db
      .update(registrations)
      .set({ customerUserId: null })
      .where(eq(registrations.id, f.registration.id));
    await account.updatePurchasedOrderAttendee(f.session, f.order.id, { name: '代理更正姓名' });
    expect((await f.state()).registration.attendee.name).toBe('代理更正姓名');
    await expect(account.registration(f.session, f.registration.id)).rejects.toThrow(
      '报名记录不存在',
    );
  });
});
