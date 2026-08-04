import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventId } from '@conference/contracts';
import {
  auditLogs,
  customerProfiles,
  customerSessions,
  customerUsers,
  events,
  invoiceDocuments,
  invoiceRequests,
  invoiceStateLogs,
  orders,
  organizations,
  outboxEvents,
  publicUserIds,
  refunds,
  registrations,
  ticketTypes,
  users,
  waitlistEntries,
} from '@conference/database';
import { and, eq, sql } from 'drizzle-orm';
import { CustomerAccountService } from './customer-account.service.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { InvoiceOperationsService } from './invoice-operations.service.js';
import type { FastifyRequest } from 'fastify';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

async function publicIdFor(
  database: DatabaseService,
  subjectType: 'staff' | 'customer',
  subjectUuid: string,
) {
  const [row] = await database
    .db!.select({ publicId: publicUserIds.publicId })
    .from(publicUserIds)
    .where(
      and(eq(publicUserIds.subjectType, subjectType), eq(publicUserIds.subjectUuid, subjectUuid)),
    )
    .limit(1);
  if (!row) throw new Error(`missing public ID for ${subjectType}:${subjectUuid}`);
  return row.publicId;
}

describePersistent('customer account deletion', () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  let eventId: EventId;
  const eventSlug = `customer-delete-event-${randomUUID().slice(0, 8)}`;
  const ticketTypeId = randomUUID();
  const customerUserId = randomUUID();
  const registrationId = randomUUID();
  const waitlistEntryId = randomUUID();
  const sessionId = randomUUID();
  const paginationCustomerIds = Array.from({ length: 24 }, () => randomUUID());
  const database = new DatabaseService();
  const service = new CustomerAccountService(database);
  const auth = new CustomerAuthService(database);
  const repository = new ConferenceRepository(database);
  const previousOtpMode = process.env.CUSTOMER_OTP_MODE;
  let customerPublicId: number;
  let paginationPublicIds: number[] = [];

  function customerRequest() {
    return {
      headers: {
        'x-organization-slug': `customer-delete-${organizationId.slice(0, 8)}`,
        'user-agent': 'customer-delete-integration-test',
      },
      cookies: {},
      ip: '127.0.0.1',
      method: 'POST',
    } as unknown as FastifyRequest;
  }

  beforeAll(async () => {
    process.env.CUSTOMER_OTP_MODE = 'fake';
    const db = database.db!;
    await db.insert(organizations).values([
      {
        id: organizationId,
        slug: `customer-delete-${organizationId.slice(0, 8)}`,
        name: '用户删除验收组织',
      },
      {
        id: otherOrganizationId,
        slug: `customer-delete-other-${otherOrganizationId.slice(0, 8)}`,
        name: '用户删除验收组织 B',
      },
    ]);
    const [createdEvent] = await db
      .insert(events)
      .values({
        organizationId,
        slug: eventSlug,
        name: '用户删除验收大会',
        shortName: '删除验收',
        tagline: '验证历史记录保留',
        description: '验证删除用户账号后保留大会业务历史。',
        status: 'registration_open',
        startsAt: new Date('2027-11-01T01:00:00.000Z'),
        endsAt: new Date('2027-11-01T10:00:00.000Z'),
        timezone: 'Asia/Shanghai',
        venue: '深圳验收会场',
        city: '深圳',
        address: '深圳验收地址',
        settings: {
          stats: { seats: 20, speakers: 0, days: 1, attendeeSatisfaction: 0 },
          faqs: [],
        },
      })
      .returning({ id: events.id });
    eventId = createdEvent!.id;
    await db.insert(ticketTypes).values({
      id: ticketTypeId,
      organizationId,
      eventId,
      code: 'DELETE-TEST',
      name: '删除验收门票',
      description: '用于验证用户删除的数据保留。',
      price: 0,
      capacity: 20,
    });
    await db.insert(customerUsers).values({
      id: customerUserId,
      organizationId,
      mobileE164: '+8613980000001',
      lastLoginAt: new Date(),
    });
    await db.insert(customerProfiles).values({
      customerUserId,
      nickname: '待删除验收用户',
      realName: '删除验收',
    });
    customerPublicId = await publicIdFor(database, 'customer', customerUserId);
    await db.insert(customerUsers).values(
      paginationCustomerIds.map((id, index) => ({
        id,
        organizationId,
        mobileE164: `+86139700000${String(index + 1).padStart(2, '0')}`,
        createdAt: new Date(`2026-05-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
      })),
    );
    paginationPublicIds = await Promise.all(
      paginationCustomerIds.map((id) => publicIdFor(database, 'customer', id)),
    );
    await db.insert(customerSessions).values({
      id: sessionId,
      customerUserId,
      organizationId,
      tokenHash: customerUserId.replaceAll('-', ''),
      expiresAt: new Date('2028-01-01T00:00:00.000Z'),
    });
    await db.insert(registrations).values({
      id: registrationId,
      organizationId,
      eventId,
      ticketTypeId,
      customerUserId,
      registrationCode: `DELETE-${registrationId.slice(0, 8)}`,
      status: 'confirmed',
      attendee: {
        name: '删除验收',
        mobile: '13800138000',
        email: 'delete-test@example.com',
        company: '=验收公司',
        title: '测试负责人',
        city: '深圳',
      },
      attendeeMobileE164: '+8613800138000',
      attendeeEmailNormalized: 'delete-test@example.com',
    });
    await db.insert(waitlistEntries).values({
      id: waitlistEntryId,
      organizationId,
      eventId,
      ticketTypeId,
      customerUserId,
      mobileE164: '+8613800138001',
      name: '候补验收用户',
      status: 'waiting',
      position: 1,
    });
  });

  afterAll(async () => {
    const db = database.db!;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await db
      .delete(organizations)
      .where(
        and(
          eq(organizations.id, organizationId),
          eq(organizations.slug, `customer-delete-${organizationId.slice(0, 8)}`),
        ),
      );
    await db.delete(organizations).where(eq(organizations.id, otherOrganizationId));
    await database.onModuleDestroy();
    if (previousOtpMode === undefined) {
      delete process.env.CUSTOMER_OTP_MODE;
    } else {
      process.env.CUSTOMER_OTP_MODE = previousOtpMode;
    }
  });

  it('returns complete directory data and exports the full filtered result safely', async () => {
    const list = await service.adminList(organizationId, {
      q: String(customerPublicId),
      page: 1,
    });
    expect(list.total).toBe(1);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: customerPublicId,
      mobile: '+8613980000001',
      displayName: '删除验收',
      displayNameSource: 'profile',
      displayCompany: '=验收公司',
      displayCompanySource: 'registration',
      registrationsCount: 1,
      eventCount: 1,
      latestRegistration: {
        id: registrationId,
        eventId,
        eventName: '用户删除验收大会',
        ticketTypeName: '删除验收门票',
        registrationStatus: 'confirmed',
      },
    });
    for (const literalSearch of ['%', '_', '\\']) {
      await expect(
        service.adminList(organizationId, { q: literalSearch, page: 1 }),
      ).resolves.toMatchObject({ total: 0, items: [] });
    }

    const actorId = randomUUID();
    const exported = await service.adminExportCsv(organizationId, actorId, {
      q: '+8613980000001',
    });
    expect(exported.count).toBe(1);
    expect(exported.csv.startsWith('\uFEFF用户 ID,手机号')).toBe(true);
    expect(exported.csv).toContain('13980000001');
    expect(exported.csv).toContain("'=验收公司");

    const [log] = await database
      .db!.select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.action, 'customer.export'),
          eq(auditLogs.actorId, actorId),
        ),
      )
      .limit(1);
    expect(log?.after).toMatchObject({ hasSearch: true, count: 1 });
    expect(JSON.stringify(log?.after)).not.toContain('+8613980000001');
  });

  it('returns stable numbered pages with exactly 20 users per full page', async () => {
    const first = await service.adminList(organizationId, { page: 1 });
    const second = await service.adminList(organizationId, { page: 2 });
    const clamped = await service.adminList(organizationId, { page: 999 });

    expect(first).toMatchObject({ total: 25, page: 1, pageSize: 20, totalPages: 2 });
    expect(first.items).toHaveLength(20);
    expect(second).toMatchObject({ total: 25, page: 2, pageSize: 20, totalPages: 2 });
    expect(second.items).toHaveLength(5);
    expect(clamped.page).toBe(2);
    expect(clamped.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(25);

    const byNumericId = await service.adminList(organizationId, {
      q: String(paginationPublicIds[0]),
      page: 1,
    });
    expect(byNumericId.items.map((item) => item.id)).toEqual([paginationPublicIds[0]]);
  });

  it('enforces organization scope and preserves business history while removing the account', async () => {
    const challenge = await auth.requestOtp(customerRequest(), '13980000001');
    expect(challenge.developmentCode).toBe('123456');
    const restrictedRegistration = await repository.getRegistrationDetail(
      eventId,
      registrationId,
      organizationId,
      false,
    );
    const includedRegistration = await repository.getRegistrationDetail(
      eventId,
      registrationId,
      organizationId,
      true,
    );
    expect(restrictedRegistration.customerRelation).toBe('restricted');
    expect(restrictedRegistration.customer).toBeUndefined();
    expect(includedRegistration.customerRelation).toBe('included');
    expect(includedRegistration.customer?.id).toBe(customerPublicId);
    const customer = (await service.adminDetail(organizationId, customerPublicId)).customer;
    const staleSession = {
      sessionId,
      customerUserId,
      organizationId,
      tokenHash: customerUserId.replaceAll('-', ''),
      expiresAt: new Date('2028-01-01T00:00:00.000Z'),
      customer,
      csrfToken: 'test-csrf-token',
    };
    await expect(service.adminDetail(otherOrganizationId, customerPublicId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.adminDelete(otherOrganizationId, randomUUID(), customerPublicId),
    ).resolves.toEqual({
      deleted: true,
      detachedRegistrations: 0,
      detachedWaitlistEntries: 0,
    });
    await expect(
      database
        .db!.select()
        .from(customerUsers)
        .where(eq(customerUsers.id, customerUserId))
        .limit(1),
    ).resolves.toHaveLength(1);

    const result = await service.adminDelete(organizationId, randomUUID(), customerPublicId);
    expect(result).toEqual({
      deleted: true,
      detachedRegistrations: 1,
      detachedWaitlistEntries: 1,
    });

    const db = database.db!;
    const [
      deletedUser,
      deletedProfile,
      deletedSession,
      retainedRegistration,
      retainedWaitlist,
      log,
    ] = await Promise.all([
      db.select().from(customerUsers).where(eq(customerUsers.id, customerUserId)).limit(1),
      db
        .select()
        .from(customerProfiles)
        .where(eq(customerProfiles.customerUserId, customerUserId))
        .limit(1),
      db
        .select()
        .from(customerSessions)
        .where(eq(customerSessions.customerUserId, customerUserId))
        .limit(1),
      db.select().from(registrations).where(eq(registrations.id, registrationId)).limit(1),
      db.select().from(waitlistEntries).where(eq(waitlistEntries.id, waitlistEntryId)).limit(1),
      db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.action, 'customer.admin.delete'),
            eq(auditLogs.resourceId, String(customerPublicId)),
          ),
        )
        .limit(1),
    ]);

    expect(deletedUser).toHaveLength(0);
    expect(deletedProfile).toHaveLength(0);
    expect(deletedSession).toHaveLength(0);
    expect(retainedRegistration[0]?.customerUserId).toBeNull();
    expect(retainedWaitlist[0]?.customerUserId).toBeNull();
    expect(log[0]?.after).toMatchObject({
      deleted: true,
      detachedRegistrations: 1,
      detachedWaitlistEntries: 1,
    });
    await expect(
      service.claimRegistration(staleSession, {
        orderId: randomUUID(),
        accessToken: 'stale-order-access-token',
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      auth.verifyOtp(customerRequest(), {
        challengeId: challenge.challengeId,
        mobile: '13980000001',
        code: challenge.developmentCode!,
        consentAccepted: true,
        termsVersion: '',
        privacyVersion: '',
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.adminDelete(organizationId, randomUUID(), customerPublicId),
    ).resolves.toEqual({
      deleted: true,
      detachedRegistrations: 0,
      detachedWaitlistEntries: 0,
    });
  });
});

describePersistent('administrator-created customer accounts', () => {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const database = new DatabaseService();
  const service = new CustomerAccountService(database);

  beforeAll(async () => {
    await database.db!.insert(organizations).values({
      id: organizationId,
      slug: `customer-create-${organizationId.slice(0, 8)}`,
      name: '管理员新增用户验收组织',
    });
  });

  afterAll(async () => {
    await database.db!.delete(organizations).where(eq(organizations.id, organizationId));
    await database.onModuleDestroy();
  });

  it('normalizes the mobile, creates the profile and records an audit event', async () => {
    const created = await service.adminCreate(organizationId, actorId, {
      mobile: '13800138000',
      realName: '林晓',
      email: 'linxiao@example.com',
      company: '灵犀会务',
    });
    const detail = await service.adminDetail(organizationId, created.customerId);

    expect(detail.customer).toMatchObject({
      mobile: '+8613800138000',
      status: 'active',
      lastLoginAt: null,
      profile: {
        realName: '林晓',
        email: 'linxiao@example.com',
        company: '灵犀会务',
      },
    });
    expect(created.customerId).toBeGreaterThanOrEqual(101);
    await expect(
      service.adminCreate(organizationId, actorId, { mobile: '+8613800138000' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.adminCreate(organizationId, actorId, { mobile: '12345' }),
    ).rejects.toMatchObject({ status: 400 });

    const [log] = await database
      .db!.select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.action, 'customer.admin.create'),
          eq(auditLogs.resourceId, String(created.customerId)),
        ),
      )
      .limit(1);
    expect(log?.after).toMatchObject({
      status: 'active',
      hasEmail: true,
      profileFields: ['realName', 'email', 'company'],
    });
  });
});

describePersistent('customer invoice center', () => {
  const organizationId = randomUUID();
  const customerUserId = randomUUID();
  const adminUserId = randomUUID();
  const database = new DatabaseService();
  const account = new CustomerAccountService(database);
  const invoices = new InvoiceOperationsService(database);
  const registrationIds = Array.from({ length: 4 }, () => randomUUID());
  const orderIds = Array.from({ length: 4 }, () => randomUUID());
  const ticketTypeIds = Array.from({ length: 4 }, () => randomUUID());
  let eventIds: EventId[] = [];
  let session: Awaited<ReturnType<CustomerAuthService['requireSession']>>;
  let customerPublicId: number;

  beforeAll(async () => {
    const db = database.db!;
    await db.insert(organizations).values({
      id: organizationId,
      slug: `invoice-center-${organizationId.slice(0, 8)}`,
      name: '发票中心验收组织',
    });
    await db.insert(customerUsers).values({
      id: customerUserId,
      organizationId,
      mobileE164: '+8613980000021',
      lastLoginAt: new Date(),
    });
    await db.insert(customerProfiles).values({
      customerUserId,
      realName: '发票验收用户',
      email: 'invoice-center@example.com',
      company: '发票验收公司',
    });
    customerPublicId = await publicIdFor(database, 'customer', customerUserId);
    await db.insert(users).values({
      id: adminUserId,
      email: `invoice-admin-${adminUserId.slice(0, 8)}@example.com`,
      name: '发票审核员',
    });
    const createdEvents = await db
      .insert(events)
      .values(
        Array.from({ length: 4 }, (_, index) => ({
          organizationId,
          slug: `invoice-center-event-${index}-${organizationId.slice(0, 8)}`,
          name: `发票中心验收大会 ${index + 1}`,
          shortName: `发票验收 ${index + 1}`,
          tagline: '验证用户发票中心状态汇总',
          description: '验证可申请、待处理、已开具和退款后的发票记录。',
          status: 'registration_open' as const,
          startsAt: new Date(`2027-11-${String(index + 1).padStart(2, '0')}T01:00:00.000Z`),
          endsAt: new Date(`2027-11-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`),
          timezone: 'Asia/Shanghai',
          venue: '深圳验收会场',
          city: '深圳',
          address: '深圳验收地址',
          settings: {
            stats: { seats: 30, speakers: 0, days: 1, attendeeSatisfaction: 0 },
            faqs: [],
          },
        })),
      )
      .returning({ id: events.id });
    eventIds = createdEvents.map((event) => event.id);
    await db.insert(ticketTypes).values(
      eventIds.map((eventId, index) => ({
        id: ticketTypeIds[index]!,
        organizationId,
        eventId,
        code: `INVOICE-${index + 1}-${organizationId.slice(0, 6)}`,
        name: '发票验收门票',
        description: '用于验证发票中心。',
        price: 39900,
        capacity: 30,
      })),
    );
    await db.insert(registrations).values(
      eventIds.map((eventId, index) => ({
        id: registrationIds[index]!,
        organizationId,
        eventId,
        ticketTypeId: ticketTypeIds[index]!,
        customerUserId,
        registrationCode: `INV-REG-${index + 1}-${organizationId.slice(0, 8)}`,
        status: 'confirmed' as const,
        attendee: {
          name: '发票验收用户',
          mobile: '13980000021',
          email: 'invoice-center@example.com',
          company: '发票验收公司',
          title: '财务负责人',
          city: '深圳',
        },
        attendeeMobileE164: '+8613980000021',
        attendeeEmailNormalized: 'invoice-center@example.com',
        invoiceRequired: index > 0,
      })),
    );
    await db.insert(orders).values(
      eventIds.map((eventId, index) => ({
        id: orderIds[index]!,
        organizationId,
        eventId,
        registrationId: registrationIds[index]!,
        orderNo: `INV-ORDER-${index + 1}-${organizationId.slice(0, 8)}`,
        status: index === 3 ? ('partially_refunded' as const) : ('paid' as const),
        amount: 39900,
        currency: 'CNY',
        pricingSnapshot: { source: 'invoice-center-test' },
        expiresAt: new Date('2028-01-01T00:00:00.000Z'),
        createdAt: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.123Z`),
        updatedAt: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.123Z`),
      })),
    );
    const [awaitingInvoice, issuedInvoice] = await db
      .insert(invoiceRequests)
      .values([
        {
          requestNo: `INV-AWAIT-${organizationId.slice(0, 8)}`,
          organizationId,
          eventId: eventIds[1]!,
          orderId: orderIds[1]!,
          registrationId: registrationIds[1]!,
          amount: 39900,
          netPaidAmount: 39900,
          currency: 'CNY',
          status: 'awaiting_details',
          createdAt: new Date('2026-06-01T00:00:00.123Z'),
          updatedAt: new Date('2026-06-01T00:00:00.123Z'),
        },
        {
          requestNo: `INV-ISSUED-${organizationId.slice(0, 8)}`,
          organizationId,
          eventId: eventIds[2]!,
          orderId: orderIds[2]!,
          registrationId: registrationIds[2]!,
          buyerType: 'company',
          title: '发票验收公司',
          taxId: '911100001234567801',
          email: 'invoice-center@example.com',
          mobile: '13980000021',
          content: '会务费',
          amount: 39900,
          netPaidAmount: 39900,
          currency: 'CNY',
          status: 'issued',
          deliveryStatus: 'sent',
          lastSentAt: new Date(Date.now() - 20 * 60_000),
          createdAt: new Date('2026-06-02T00:00:00.123Z'),
          updatedAt: new Date('2026-06-02T00:00:00.123Z'),
        },
      ])
      .returning();
    await db.insert(invoiceStateLogs).values({
      invoiceRequestId: awaitingInvoice!.id,
      fromStatus: null,
      toStatus: 'awaiting_details',
      reason: '支付完成后创建发票申请',
    });
    await db.insert(invoiceDocuments).values({
      invoiceRequestId: issuedInvoice!.id,
      documentType: 'original',
      invoiceNumber: `DOC-${organizationId.slice(0, 8)}`,
      storageKey: `invoice-center/${organizationId}/invoice.pdf`,
      mediaType: 'application/pdf',
      size: 2048,
      contentDigest: 'a'.repeat(64),
    });
    await db.insert(refunds).values({
      organizationId,
      eventId: eventIds[3]!,
      orderId: orderIds[3]!,
      refundNo: `REFUND-${organizationId.slice(0, 8)}`,
      amount: 39900,
      currency: 'CNY',
      status: 'succeeded',
      reason: '验证全额退款订单不可申请',
      idempotencyKey: `invoice-center-refund-${organizationId}`,
    });

    const customer = (await account.adminDetail(organizationId, customerPublicId)).customer;
    session = {
      sessionId: randomUUID(),
      customerUserId,
      organizationId,
      tokenHash: 'invoice-center-test-session',
      expiresAt: new Date('2028-01-01T00:00:00.000Z'),
      customer,
      csrfToken: 'invoice-center-test-csrf',
    };
  });

  afterAll(async () => {
    const db = database.db!;
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(users).where(eq(users.id, adminUserId));
    await database.onModuleDestroy();
  });

  it('returns accurate categories, actions and net-paid eligibility', async () => {
    const result = await account.invoices(session, { category: 'all', limit: 20 });
    expect(result.counts).toMatchObject({
      all: 3,
      eligible: 1,
      actionRequired: 1,
      processing: 0,
      issued: 1,
      history: 0,
    });
    expect(result.items.find((item) => item.orderId === orderIds[0])?.availableActions).toEqual([
      'apply',
    ]);
    expect(result.items.find((item) => item.orderId === orderIds[2])?.availableActions).toEqual([
      'view',
      'download',
      'resend',
    ]);
    await database
      .db!.update(invoiceRequests)
      .set({ email: '' })
      .where(eq(invoiceRequests.orderId, orderIds[2]!));
    const withoutRecipient = await account.invoices(session, { category: 'issued', limit: 20 });
    expect(withoutRecipient.items[0]?.availableActions).toEqual(['view', 'download']);
    await database
      .db!.update(invoiceRequests)
      .set({ email: 'invoice-center@example.com' })
      .where(eq(invoiceRequests.orderId, orderIds[2]!));
    expect(result.items.some((item) => item.orderId === orderIds[3])).toBe(false);
    await expect(
      invoices.customerOrderInvoiceContext(organizationId, customerUserId, orderIds[0]!),
    ).resolves.toMatchObject({
      orderNo: expect.stringContaining('INV-ORDER-1'),
      eventName: '发票中心验收大会 1',
      eligibleAmount: 39900,
      currency: 'CNY',
      canApply: true,
      unavailableReason: null,
    });
    await expect(
      invoices.customerOrderInvoiceContext(organizationId, customerUserId, orderIds[3]!),
    ).resolves.toMatchObject({
      eligibleAmount: 0,
      canApply: false,
      unavailableReason: '订单已无可开票的实际支付金额。',
    });

    const firstPage = await account.invoices(session, { category: 'all', limit: 1 });
    expect(firstPage.items[0]?.orderId).not.toBe(orderIds[0]);
    await invoices.createCustomerOrderInvoice(organizationId, customerUserId, orderIds[0]!, {
      buyerType: 'company',
      title: '分页期间新申请公司',
      taxId: '911100001234567801',
      email: 'invoice-center@example.com',
      mobile: '13980000021',
      content: '会务费',
    });
    const pagedOrderIds = new Set(firstPage.items.map((item) => item.orderId));
    let cursor = firstPage.nextCursor;
    while (cursor) {
      const page = await account.invoices(session, { category: 'all', cursor, limit: 1 });
      page.items.forEach((item) => pagedOrderIds.add(item.orderId));
      cursor = page.nextCursor;
    }
    expect(pagedOrderIds).toEqual(new Set([orderIds[0], orderIds[1], orderIds[2]]));
  });

  it('isolates administrator invoice reads by conference inside one organization', async () => {
    const page = await invoices.page(organizationId, { eventId: eventIds[1], limit: 20 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.eventId === eventIds[1])).toBe(true);

    await expect(
      invoices.detail(organizationId, page.items[0]!.id, true, eventIds[0]),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('protects concurrent edits and keeps pending-review revisions out of the state timeline', async () => {
    const before = await account.invoices(session, { category: 'action_required', limit: 20 });
    const awaiting = before.items[0]!;
    const submitted = await invoices.updateCustomerOrderInvoice(
      organizationId,
      customerUserId,
      awaiting.orderId,
      {
        buyerType: 'company',
        title: '发票验收公司',
        taxId: '911100001234567801',
        email: 'invoice-center@example.com',
        mobile: '13980000021',
        content: '会务费',
        expectedUpdatedAt: awaiting.updatedAt,
      },
    );
    expect(submitted.status).toBe('pending_review');
    expect(submitted).not.toHaveProperty('logs');
    expect(submitted.timeline.at(0)?.description).not.toContain('customerUserId');

    await expect(
      invoices.updateCustomerOrderInvoice(organizationId, customerUserId, awaiting.orderId, {
        buyerType: 'company',
        title: '旧页面提交的公司名称',
        taxId: '911100001234567801',
        email: 'invoice-center@example.com',
        mobile: '13980000021',
        content: '会务费',
        expectedUpdatedAt: awaiting.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const [beforeRevisionCount] = await database
      .db!.select({ value: sql<number>`count(*)::int` })
      .from(invoiceStateLogs)
      .where(eq(invoiceStateLogs.invoiceRequestId, submitted.id));
    const revised = await invoices.updateCustomerOrderInvoice(
      organizationId,
      customerUserId,
      awaiting.orderId,
      {
        buyerType: 'company',
        title: '发票验收公司最新名称',
        taxId: '911100001234567801',
        email: 'invoice-center@example.com',
        mobile: '13980000021',
        content: '会务费',
        expectedUpdatedAt: submitted.updatedAt,
      },
    );
    const [afterRevisionCount] = await database
      .db!.select({ value: sql<number>`count(*)::int` })
      .from(invoiceStateLogs)
      .where(eq(invoiceStateLogs.invoiceRequestId, submitted.id));
    expect(afterRevisionCount?.value).toBe(beforeRevisionCount?.value);

    await expect(
      invoices.approve(organizationId, submitted.id, adminUserId, {
        expectedUpdatedAt: submitted.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      invoices.approve(organizationId, revised.id, adminUserId, {
        expectedUpdatedAt: revised.updatedAt,
      }),
    ).resolves.toMatchObject({ status: 'issuing' });
  });

  it('atomically replaces and restores an invoice file for the customer frontend', async () => {
    const before = await invoices.readCustomerOrderInvoice(
      organizationId,
      customerUserId,
      orderIds[2]!,
    );
    const document = before.documents[0]!;
    const previousStorage = {
      endpoint: process.env.S3_ENDPOINT,
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
      accessKey: process.env.S3_ACCESS_KEY,
      secretKey: process.env.S3_SECRET_KEY,
      bucket: process.env.S3_BUCKET,
    };
    process.env.S3_ENDPOINT = 'http://invoice-storage.test';
    process.env.S3_PUBLIC_ENDPOINT = 'http://invoice-storage.test';
    process.env.S3_ACCESS_KEY = 'invoice-test-access';
    process.env.S3_SECRET_KEY = 'invoice-test-secret';
    process.env.S3_BUCKET = 'invoice-test-bucket';
    const replacement = new TextEncoder().encode('%PDF-1.7\nreplacement-one');
    const replacementDigest = createHash('sha256').update(replacement).digest('hex');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(replacement, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );
    try {
      const replaced = await invoices.replaceDocumentFile(
        organizationId,
        before.id,
        document.id,
        adminUserId,
        {
          storageKey: `invoices/${organizationId}/${eventIds[2]}/${before.id}/replacement-one.pdf`,
          mediaType: 'application/pdf',
          size: replacement.byteLength,
          contentDigest: replacementDigest,
          reason: '修正电子发票文件内容',
          expectedUpdatedAt: before.updatedAt,
        },
        eventIds[2],
      );
      expect(replaced).toMatchObject({ status: 'issued', deliveryStatus: 'not_sent' });
      expect(replaced.documents[0]).toMatchObject({
        id: document.id,
        contentDigest: replacementDigest,
        voidedAt: null,
      });
      const customerAfterReplace = await invoices.readCustomerOrderInvoice(
        organizationId,
        customerUserId,
        orderIds[2]!,
      );
      expect(customerAfterReplace.documents[0]).toMatchObject({
        id: document.id,
        contentDigest: replacementDigest,
        downloadUrl: expect.stringContaining(`/invoice-documents/${document.id}/download`),
      });
      const replacementDownload = new URL(
        customerAfterReplace.documents[0]!.downloadUrl!,
        'http://customer.test',
      );
      const replacementExpires = Number(replacementDownload.searchParams.get('expires'));
      const replacementSignature = replacementDownload.searchParams.get('signature')!;
      const resolvedReplacement = await invoices.resolveInvoiceDownload(
        orderIds[2]!,
        document.id,
        replacementExpires,
        replacementSignature,
      );
      expect(decodeURIComponent(new URL(resolvedReplacement).pathname)).toContain(
        '/replacement-one.pdf',
      );

      const deleted = await invoices.voidDocument(
        organizationId,
        before.id,
        document.id,
        adminUserId,
        {
          reason: '删除错误的发票文件',
          expectedUpdatedAt: replaced.updatedAt,
        },
        eventIds[2],
      );
      const customerAfterDelete = await invoices.readCustomerOrderInvoice(
        organizationId,
        customerUserId,
        orderIds[2]!,
      );
      expect(customerAfterDelete.status).toBe('voided');
      expect(customerAfterDelete.documents[0]).toMatchObject({
        id: document.id,
        downloadUrl: null,
      });
      await expect(
        invoices.resolveInvoiceDownload(
          orderIds[2]!,
          document.id,
          replacementExpires,
          replacementSignature,
        ),
      ).rejects.toMatchObject({ status: 404 });

      const restoredFile = new TextEncoder().encode('%PDF-1.7\nreplacement-two');
      const restoredDigest = createHash('sha256').update(restoredFile).digest('hex');
      fetchSpy.mockResolvedValueOnce(
        new Response(restoredFile, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
      );
      const restored = await invoices.replaceDocumentFile(
        organizationId,
        before.id,
        document.id,
        adminUserId,
        {
          storageKey: `invoices/${organizationId}/${eventIds[2]}/${before.id}/replacement-two.pdf`,
          mediaType: 'application/pdf',
          size: restoredFile.byteLength,
          contentDigest: restoredDigest,
          reason: '重新上传正确的发票文件',
          expectedUpdatedAt: deleted.updatedAt,
        },
        eventIds[2],
      );
      expect(restored).toMatchObject({ status: 'issued', deliveryStatus: 'not_sent' });
      expect(restored.documents[0]).toMatchObject({
        id: document.id,
        contentDigest: restoredDigest,
        voidedAt: null,
      });
      const customerAfterRestore = await invoices.readCustomerOrderInvoice(
        organizationId,
        customerUserId,
        orderIds[2]!,
      );
      expect(customerAfterRestore.documents[0]?.downloadUrl).toContain(
        `/invoice-documents/${document.id}/download`,
      );
      const resolvedRestore = await invoices.resolveInvoiceDownload(
        orderIds[2]!,
        document.id,
        replacementExpires,
        replacementSignature,
      );
      expect(decodeURIComponent(new URL(resolvedRestore).pathname)).toContain(
        '/replacement-two.pdf',
      );
    } finally {
      fetchSpy.mockRestore();
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore('S3_ENDPOINT', previousStorage.endpoint);
      restore('S3_PUBLIC_ENDPOINT', previousStorage.publicEndpoint);
      restore('S3_ACCESS_KEY', previousStorage.accessKey);
      restore('S3_SECRET_KEY', previousStorage.secretKey);
      restore('S3_BUCKET', previousStorage.bucket);
    }
  });

  it('queues one customer resend request and treats a repeated click as idempotent', async () => {
    const beforeSend = await invoices.readCustomerOrderInvoice(
      organizationId,
      customerUserId,
      orderIds[2]!,
    );
    const first = await invoices.sendCustomerOrderInvoice(
      organizationId,
      customerUserId,
      orderIds[2]!,
    );
    expect(first).toEqual({ queued: true, alreadyQueued: false, retryAfterSeconds: 0 });
    const repeated = await invoices.sendCustomerOrderInvoice(
      organizationId,
      customerUserId,
      orderIds[2]!,
    );
    expect(repeated).toEqual({ queued: true, alreadyQueued: true, retryAfterSeconds: 0 });
    const [eventsCount] = await database
      .db!.select({ value: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, organizationId),
          eq(outboxEvents.eventType, 'InvoiceDeliveryRequested'),
        ),
      );
    expect(eventsCount?.value).toBe(1);
    await expect(
      invoices.voidDocument(
        organizationId,
        beforeSend.id,
        beforeSend.documents[0]!.id,
        adminUserId,
        {
          reason: '旧页面尝试作废发票',
          expectedUpdatedAt: beforeSend.updatedAt,
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
