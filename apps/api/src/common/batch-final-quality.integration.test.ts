import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_EVENT, type CreateRegistrationBatch } from '@conference/contracts';
import {
  attendeeClaimTokens,
  attendeeShowcaseProfiles,
  customerUsers,
  eventReleases,
  events,
  invoiceRequests,
  orderItems,
  orders,
  payments,
  refunds,
  refundItemAllocations,
  organizations,
  registrations,
  tickets,
  ticketTypes,
  users,
} from '@conference/database';
import { DatabaseService } from './database.service.js';
import { BatchRegistrationService } from './batch-registration.service.js';
import { OrderItemsService } from './order-items.service.js';
import { BatchPaymentService } from './batch-payment.service.js';
import { BatchOrderManagementService } from './batch-order-management.service.js';
import { BatchClaimInvitationService } from './batch-claim-invitation.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { AdminRegistrationOperationsService } from './admin-registration-operations.service.js';
import { CustomerAccountService } from './customer-account.service.js';
import { registrationEditVersion } from './registration-edit-version.js';
import { ConferenceRepository } from './conference.repository.js';
import { InvoiceOperationsService } from './invoice-operations.service.js';
import { EngagementOperationsService } from './engagement-operations.service.js';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import type { CustomerRegistrationActor } from './conference.repository.js';

const persistent = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;
persistent('batch final quality real PostgreSQL regressions', () => {
  let admin: pg.Pool;
  let database: DatabaseService;
  let batch: BatchRegistrationService;
  let items: OrderItemsService;
  let payment: BatchPaymentService;
  let management: BatchOrderManagementService;
  const name = `batch_final_quality_${randomUUID().replaceAll('-', '')}`;
  const savedDatabaseUrl = process.env.DATABASE_URL;
  let serial = 100;
  beforeAll(async () => {
    const url = new URL(process.env.BATCH_TEST_DATABASE_URL!);
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`create database "${name}"`);
    url.pathname = `/${name}`;
    const connection = new pg.Pool({ connectionString: url.toString() });
    try {
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL('../../../../packages/database/drizzle', import.meta.url),
        ),
      });
      for (const migration of migrations.slice(0, 66)) {
        const client = await connection.connect();
        try {
          await client.query('begin');
          for (const statement of migration.sql) await client.query(statement);
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        } finally {
          client.release();
        }
      }
    } finally {
      await connection.end();
    }
    process.env.DATABASE_URL = url.toString();
    database = new DatabaseService();
    items = new OrderItemsService(database);
    batch = new BatchRegistrationService(database, items);
    payment = new BatchPaymentService(items);
    management = new BatchOrderManagementService(items, new WeChatPayService(database));
  }, 120000);
  afterAll(async () => {
    await database?.onModuleDestroy();
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (admin) {
      await admin.query(`drop database if exists "${name}"`);
      await admin.end();
    }
  });

  async function fixture(price = 39900, capacity = 100, manualReview = false, max = 20) {
    const db = database.db!;
    const organizationId = randomUUID();
    await db
      .insert(organizations)
      .values({ id: organizationId, slug: `batch-${organizationId}`, name: '多人购票测试' });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `batch-${organizationId}`,
        name: '测试大会',
        shortName: '测试',
        tagline: '测试',
        description: '测试',
        status: 'registration_open',
        startsAt: new Date('2027-01-01'),
        endsAt: new Date('2027-01-02'),
        timezone: 'Asia/Shanghai',
        venue: '测试',
        city: '测试',
        address: '测试',
        settings: { refundPolicy: { enabled: true, version: 'seven-day-v1', windowDays: 7 } },
      })
      .returning();
    const [ticket] = await db
      .insert(ticketTypes)
      .values({
        organizationId,
        eventId: event!.id,
        code: 'GENERAL',
        name: '大会通票',
        description: '',
        price,
        capacity,
      })
      .returning();
    const form = {
      id: randomUUID(),
      eventId: event!.id,
      name: '报名表',
      version: 1,
      termsVersion: 'batch-v1',
      termsContent: '参会报名条款',
      fields: [
        { key: 'name', label: '姓名', type: 'text', required: true, enabled: true },
        { key: 'mobile', label: '手机号', type: 'tel', required: true, enabled: true },
        { key: 'company', label: '公司', type: 'text', required: true, enabled: true },
      ],
    };
    const snapshot = {
      event: {
        settings: {
          registration: {
            ...DEMO_EVENT.registration,
            paymentMode: price === 0 ? 'free' : 'ticketed',
            additionalPurchaseEnabled: true,
            maxActiveSeatsPerPurchaser: max,
          },
        },
      },
      tickets: [{ ...DEMO_EVENT.tickets[0], id: ticket!.id, price, capacity, name: '大会通票' }],
      registrationForm: form,
      experience: { registrationFlow: { branches: { manualReview } } },
    };
    const [release] = await db
      .insert(eventReleases)
      .values({
        eventId: event!.id,
        version: 1,
        templateKey: 'test',
        artifactKey: 'test',
        snapshot,
      })
      .returning();
    await db
      .update(events)
      .set({ settings: { ...event!.settings, currentReleaseId: release!.id } })
      .where(eq(events.id, event!.id));
    return {
      organizationId,
      eventId: event!.id,
      ticketTypeId: ticket!.id,
      releaseId: release!.id,
      snapshot,
    };
  }
  async function customer(organizationId: string): Promise<CustomerRegistrationActor> {
    const mobile = `+8613800${String(serial++).padStart(6, '0')}`;
    const [user] = await database
      .db!.insert(customerUsers)
      .values({ organizationId, mobileE164: mobile })
      .returning();
    return {
      organizationId,
      customerUserId: user!.id,
      mobile,
      profile: {
        nickname: null,
        realName: '购票人',
        email: null,
        company: '公司',
        title: null,
        city: null,
      },
    };
  }
  async function input(
    scope: Awaited<ReturnType<typeof fixture>>,
    actor: CustomerRegistrationActor,
    quantity: number,
    self = true,
  ): Promise<CreateRegistrationBatch> {
    const quote = await batch.quote(
      { eventId: scope.eventId, ticketTypeId: scope.ticketTypeId, quantity },
      actor,
    );
    return {
      eventId: scope.eventId,
      ticketTypeId: scope.ticketTypeId,
      quantity,
      purchaseIntentId: randomUUID(),
      attendees: Array.from({ length: quantity }, (_, index) => ({
        clientId: randomUUID(),
        isSelf: self && index === 0,
        attendee: {
          name: `参会人 ${index + 1}`,
          mobile:
            self && index === 0 ? actor.mobile : `+8613900${String(serial++).padStart(6, '0')}`,
          email: '',
          company: '公司',
          title: '',
          city: '',
        },
        marketingConsent: false,
      })),
      formVersion: 1,
      termsVersion: 'batch-v1',
      termsAccepted: true,
      proxyAuthorizationAccepted: true,
      quoteFingerprint: quote.quoteFingerprint,
    };
  }

  function sessionFor(actor: CustomerRegistrationActor): AuthenticatedCustomer {
    return {
      sessionId: randomUUID(),
      customerUserId: actor.customerUserId,
      organizationId: actor.organizationId,
      tokenHash: 'test',
      expiresAt: new Date(Date.now() + 60_000),
      csrfToken: 'test',
      customer: {
        id: 101,
        organizationId: actor.organizationId,
        mobile: actor.mobile,
        maskedMobile: '138****0000',
        status: 'active',
        verifiedAt: new Date().toISOString(),
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
        profile: { ...actor.profile, email: actor.profile.email ?? '', version: 1 },
      },
    };
  }

  const adminOperations = () =>
    new AdminRegistrationOperationsService(
      database,
      {} as ConferenceRepository,
      {} as InvoiceOperationsService,
    );

  it('counts batch invoices once for the purchaser in the admin customer summary', async () => {
    const scope = await fixture(39900);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    await payment.confirm(checkout.order.id, {
      provider: 'mock-wechat',
      externalId: randomUUID(),
      amount: checkout.order.amount,
      currency: 'CNY',
      payload: {},
      reason: '测试整单付款',
    });
    await database.db!.insert(invoiceRequests).values({
      organizationId: scope.organizationId,
      eventId: scope.eventId,
      orderId: checkout.order.id,
      registrationId: null,
      requestNo: `I${randomUUID()}`,
      buyerType: 'company',
      title: '购票公司',
      taxId: '911100001234567801',
      email: 'invoice@example.test',
      mobile: actor.mobile,
      content: '会务费',
      amount: checkout.order.amount,
      netPaidAmount: checkout.order.amount,
      currency: 'CNY',
      status: 'issued',
    });
    const accounts = new CustomerAccountService(database);
    const list = await accounts.adminList(scope.organizationId, { page: 1 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.invoiceCount).toBe(1);
    expect(
      (await accounts.adminInvoices(scope.organizationId, list.items[0]!.id)).items,
    ).toHaveLength(1);
  });

  it('counts the published card of an active batch attendee in the admin customer summary', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    await database.db!.insert(attendeeShowcaseProfiles).values({
      organizationId: scope.organizationId,
      eventId: scope.eventId,
      registrationId: checkout.items[0]!.registrationId,
      customerUserId: actor.customerUserId,
      publicSlug: randomUUID().replaceAll('-', ''),
      sequence: 1,
      qualifiedAt: new Date(),
      isPublic: true,
    });
    const accounts = new CustomerAccountService(database);
    const list = await accounts.adminList(scope.organizationId, { page: 1 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      registrationsCount: 1,
      showcaseCount: 1,
      publicShowcaseCount: 1,
    });
    await database
      .db!.update(tickets)
      .set({ status: 'cancelled' })
      .where(eq(tickets.registrationId, checkout.items[0]!.registrationId));
    const cancelled = await accounts.adminList(scope.organizationId, { page: 1 });
    expect(cancelled.items[0]!.publicShowcaseCount).toBe(0);
  });

  it('requires a version when the legacy attendee endpoint edits a new single proxy order', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 1, false), randomUUID(), actor);
    await expect(
      new CustomerAccountService(database).updatePurchasedOrderAttendee(
        sessionFor(actor),
        checkout.order.id,
        { company: '无版本覆盖' },
      ),
    ).rejects.toThrow('报名信息已发生变化');
  });

  it('rejects stale proxy edits through the legacy endpoint and accepts the current registration version', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 1, false), randomUUID(), actor);
    const [order] = await database
      .db!.select()
      .from(orders)
      .where(eq(orders.id, checkout.order.id));
    const [before] = await items.rows(database.db!, checkout.order.id);
    const version = registrationEditVersion(before!.registration, order!);
    const accounts = new CustomerAccountService(database);
    await accounts.updatePurchasedOrderAttendee(
      sessionFor(actor),
      checkout.order.id,
      { company: '最新公司' },
      { id: before!.item.id, version: before!.item.version },
    );
    await expect(
      accounts.updatePurchasedOrderAttendee(sessionFor(actor), checkout.order.id, {
        company: '过期页面覆盖',
        expectedRegistrationVersion: version,
      }),
    ).rejects.toThrow('报名信息已发生变化');
    const [latestOrder] = await database
      .db!.select()
      .from(orders)
      .where(eq(orders.id, checkout.order.id));
    const [latest] = await items.rows(database.db!, checkout.order.id);
    await accounts.updatePurchasedOrderAttendee(sessionFor(actor), checkout.order.id, {
      company: '当前版本修改',
      expectedRegistrationVersion: registrationEditVersion(latest!.registration, latestOrder!),
    });
    expect(
      (await items.rows(database.db!, checkout.order.id))[0]!.registration.attendee.company,
    ).toBe('当前版本修改');
  });

  it('edits only the selected paid attendee, rotates the invitation and rejects the stale admin snapshot', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    const before = await items.rows(database.db!, checkout.order.id);
    const chosen = before[2]!;
    const previousClaims = await database
      .db!.select()
      .from(attendeeClaimTokens)
      .where(eq(attendeeClaimTokens.registrationId, chosen.registration.id));
    const patch = {
      attendee: {
        ...chosen.registration.attendee,
        mobile: '+8613900999999',
        company: '修改后公司',
      },
      expectedUpdatedAt: chosen.registration.updatedAt.toISOString(),
      reason: '参会人申请变更',
    };
    await adminOperations().updateAttendee(
      scope.eventId,
      chosen.registration.id,
      scope.organizationId,
      randomUUID(),
      patch,
    );
    const after = await items.rows(database.db!, checkout.order.id);
    expect(after[2]!.registration.attendee).toMatchObject({
      mobile: patch.attendee.mobile,
      company: patch.attendee.company,
    });
    expect(after[2]!.item.version).toBe(chosen.item.version + 1);
    expect(after.filter((_, index) => index !== 2)).toEqual(
      before.filter((_, index) => index !== 2),
    );
    const tokens = await database
      .db!.select()
      .from(attendeeClaimTokens)
      .where(eq(attendeeClaimTokens.registrationId, chosen.registration.id));
    expect(tokens.filter((token) => !token.revokedAt && !token.consumedAt)).toHaveLength(1);
    expect(
      tokens
        .filter((token) => previousClaims.some((old) => old.id === token.id))
        .every((token) => token.revokedAt),
    ).toBe(true);
    expect((await items.detail(checkout.order.id, actor)).order.version).toBe(
      checkout.order.version! + 1,
    );
    await expect(
      adminOperations().updateAttendee(
        scope.eventId,
        chosen.registration.id,
        scope.organizationId,
        randomUUID(),
        patch,
      ),
    ).rejects.toThrow('参会资料已经更新');
  });

  it('invalidates a whole-order review when an administrator changes one member of the reviewed list', async () => {
    const scope = await fixture(39900, 100, true);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    const chosen = (await items.rows(database.db!, checkout.order.id))[4]!;
    const [staff] = await database
      .db!.insert(users)
      .values({ name: '测试审核员', email: `${randomUUID()}@example.com` })
      .returning();
    await adminOperations().updateAttendee(
      scope.eventId,
      chosen.registration.id,
      scope.organizationId,
      staff!.id,
      {
        attendee: { ...chosen.registration.attendee, company: '待重新审核公司' },
        expectedUpdatedAt: chosen.registration.updatedAt.toISOString(),
        reason: '修正参会资料',
      },
    );
    await expect(
      management.review(checkout.order.id, scope.eventId, scope.organizationId, staff!.id, {
        expectedVersion: checkout.order.version!,
        decision: 'approve',
        reason: '',
      }),
    ).rejects.toThrow('更新');
    const current = await items.detail(checkout.order.id, actor);
    const approved = await management.review(
      checkout.order.id,
      scope.eventId,
      scope.organizationId,
      staff!.id,
      { expectedVersion: current.order.version!, decision: 'approve', reason: '' },
    );
    expect(approved.items).toHaveLength(5);
    expect(approved.items.every((item) => item.registration.status === 'pending_payment')).toBe(
      true,
    );
  });

  it('persists the exact quoted source when a new published snapshot arrives after quote validation', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const request = await input(scope, actor, 3);
    const quote = batch.quote.bind(batch);
    const intercepted = vi
      .spyOn(batch, 'quote')
      .mockImplementation(async (value, buyer, reader, source) => {
        const result = await quote(value, buyer, reader, source);
        if (source) {
          const [release] = await database
            .db!.insert(eventReleases)
            .values({
              eventId: scope.eventId,
              version: 2,
              templateKey: 'test',
              artifactKey: 'test',
              snapshot: {
                ...scope.snapshot,
                tickets: scope.snapshot.tickets.map((ticket) => ({ ...ticket, price: 49900 })),
                registrationForm: {
                  ...scope.snapshot.registrationForm,
                  version: 2,
                  termsVersion: 'batch-v2',
                  termsContent: '新条款',
                },
              },
            })
            .returning();
          await database
            .db!.update(events)
            .set({ settings: { currentReleaseId: release!.id } })
            .where(eq(events.id, scope.eventId));
        }
        return result;
      });
    try {
      const checkout = await batch.create(request, randomUUID(), actor);
      const [order] = await database
        .db!.select()
        .from(orders)
        .where(eq(orders.id, checkout.order.id));
      expect(order!.pricingSnapshot).toMatchObject({
        releaseId: scope.releaseId,
        quoteFingerprint: request.quoteFingerprint,
        unitPrice: 39900,
      });
      expect(checkout.order.amount).toBe(119700);
      const rows = await items.rows(database.db!, checkout.order.id);
      expect(
        rows.every(
          (row) =>
            row.registration.formVersion === 1 &&
            row.registration.termsVersion === 'batch-v1' &&
            row.registration.consentSnapshot.termsContent === '参会报名条款',
        ),
      ).toBe(true);
    } finally {
      intercepted.mockRestore();
    }
  });

  it('disables new multi-seat creation while continuing payment, invitation and free cancellation of existing five-seat orders', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const request = await input(scope, actor, 5);
    const checkout = await batch.create(request, randomUUID(), actor);
    const freeScope = await fixture(0);
    const freeActor = await customer(freeScope.organizationId);
    const free = await batch.create(await input(freeScope, freeActor, 5), randomUUID(), freeActor);
    const previous = process.env.BATCH_PURCHASE_CREATION_ENABLED;
    process.env.BATCH_PURCHASE_CREATION_ENABLED = 'false';
    try {
      const newActor = await customer(scope.organizationId);
      const quote = await batch.quote(
        { eventId: scope.eventId, ticketTypeId: scope.ticketTypeId, quantity: 5 },
        newActor,
      );
      expect(quote.availableQuantity).toBe(1);
      await expect(
        batch.create(await input(scope, newActor, 5), randomUUID(), newActor),
      ).rejects.toThrow('名额不足');
      const single = await batch.create(await input(scope, newActor, 1), randomUUID(), newActor);
      expect(single.items).toHaveLength(1);
      const replay = await batch.create(request, randomUUID(), actor);
      expect(replay.items).toHaveLength(5);
      await payment.confirm(checkout.order.id, {
        provider: 'mock-wechat',
        externalId: randomUUID(),
        amount: checkout.order.amount,
        currency: 'CNY',
        payload: {},
        reason: '阶段 A 履约回归',
      });
      const paid = await items.detail(checkout.order.id, actor);
      expect(paid.items.filter((item) => item.ticketStatus === 'valid')).toHaveLength(5);
      const chosen = paid.items[2]!;
      expect(
        (
          await new BatchClaimInvitationService(items).generate(
            checkout.order.id,
            chosen.id,
            { expectedVersion: chosen.version, notify: false },
            randomUUID(),
            actor,
          )
        ).claimUrl,
      ).toBeTruthy();
      const cancelled = await management.cancelFree(
        free.order.id,
        {
          expectedVersion: free.order.version!,
          items: free.items.slice(0, 2).map((item) => ({ id: item.id, version: item.version })),
        },
        freeActor,
      );
      expect(cancelled.items.filter((item) => item.state === 'cancelled')).toHaveLength(2);
      expect(cancelled.items.filter((item) => item.ticketStatus === 'valid')).toHaveLength(3);
    } finally {
      if (previous === undefined) delete process.env.BATCH_PURCHASE_CREATION_ENABLED;
      else process.env.BATCH_PURCHASE_CREATION_ENABLED = previous;
    }
  });

  it('rejects an unpublished attendee field without changing the selected seat or sibling records', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 3), randomUUID(), actor);
    const before = await items.rows(database.db!, checkout.order.id);
    const selected = checkout.items[1]!;
    await expect(
      new CustomerAccountService(database).updatePurchasedOrderAttendee(
        sessionFor(actor),
        checkout.order.id,
        { title: '未开放职位' },
        { id: selected.id, version: selected.version },
      ),
    ).rejects.toThrow('字段未开放');
    expect(await items.rows(database.db!, checkout.order.id)).toEqual(before);
  });

  async function returnedExtraPayment() {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    await payment.confirm(checkout.order.id, {
      provider: 'mock-wechat',
      externalId: randomUUID(),
      amount: checkout.order.amount,
      currency: 'CNY',
      payload: {},
      reason: '主支付入账',
    });
    const [extra] = await database
      .db!.insert(payments)
      .values({
        orderId: checkout.order.id,
        provider: 'mock-wechat',
        externalId: randomUUID(),
        amount: checkout.order.amount,
        currency: 'CNY',
        status: 'refunded',
        succeededAt: new Date(),
      })
      .returning();
    await database.db!.insert(refunds).values({
      organizationId: scope.organizationId,
      eventId: scope.eventId,
      orderId: checkout.order.id,
      paymentId: extra!.id,
      refundNo: `R${randomUUID()}`,
      amount: checkout.order.amount,
      currency: 'CNY',
      status: 'succeeded',
      reason: '多付资金已退回',
      idempotencyKey: randomUUID(),
      succeededAt: new Date(),
    });
    return { scope, checkout, actor };
  }

  it('keeps admin registration detail totals on the settled purchase after returning an extra payment', async () => {
    const { scope, checkout } = await returnedExtraPayment();
    const [order] = await database
      .db!.select()
      .from(orders)
      .where(eq(orders.id, checkout.order.id));
    await database.db!.insert(payments).values(
      Array.from({ length: 11 }, () => ({
        orderId: checkout.order.id,
        provider: 'mock-wechat',
        externalId: randomUUID(),
        amount: checkout.order.amount,
        currency: 'CNY',
        status: 'failed' as const,
      })),
    );
    const operations = new AdminRegistrationOperationsService(
      database,
      new ConferenceRepository(database),
      {} as InvoiceOperationsService,
    );
    const detail = await operations.detail(
      scope.eventId,
      checkout.items[2]!.registrationId,
      scope.organizationId,
      ['event.order.read'],
    );
    expect(detail.commerce.access).toBe('included');
    if (detail.commerce.access !== 'included') throw new Error('commerce must be included');
    expect(detail.commerce.totals).toMatchObject({
      paidAmount: checkout.order.amount,
      succeededRefundAmount: 0,
      refundableAmount: checkout.order.amount,
    });
    expect(detail.commerce.successfulPayment?.id).toBe(order!.settledPaymentId);
  });

  it('keeps active registrations paid in the admin list after returning an extra payment', async () => {
    const { scope, checkout } = await returnedExtraPayment();
    const list = await new ConferenceRepository(database).listRegistrations(
      scope.eventId,
      {},
      scope.organizationId,
    );
    expect(list.items).toHaveLength(5);
    expect(
      list.items.every(
        (row) =>
          row.businessStatus === 'paid' && row.refundedAmount === 0 && row.paidAmount === 39900,
      ),
    ).toBe(true);
    expect(list.items.reduce((sum, row) => sum + row.paidAmount, 0)).toBe(checkout.order.amount);
    expect(list.items.every((row) => row.invoiceSummary.status === 'eligible')).toBe(true);
  });

  it('attributes one refunded seat to its registration and keeps siblings paid with the shared invoice', async () => {
    const { scope, checkout } = await returnedExtraPayment();
    const chosen = checkout.items[2]!;
    const [order] = await database
      .db!.select()
      .from(orders)
      .where(eq(orders.id, checkout.order.id));
    await database.db!.transaction(async (tx) => {
      const [refund] = await tx
        .insert(refunds)
        .values({
          organizationId: scope.organizationId,
          eventId: scope.eventId,
          orderId: checkout.order.id,
          paymentId: order!.settledPaymentId!,
          refundNo: `R${randomUUID()}`,
          amount: 39900,
          currency: 'CNY',
          status: 'succeeded',
          reason: '第三位参会人退票',
          idempotencyKey: randomUUID(),
          succeededAt: new Date(),
        })
        .returning();
      await tx.insert(refundItemAllocations).values({
        refundId: refund!.id,
        paymentId: order!.settledPaymentId!,
        orderId: checkout.order.id,
        orderItemId: chosen.id,
        organizationId: scope.organizationId,
        eventId: scope.eventId,
        amount: 39900,
        basis: '独立测试已确认的名额退款分配',
      });
      await tx
        .update(orders)
        .set({ status: 'partially_refunded' })
        .where(eq(orders.id, checkout.order.id));
      await tx.update(orderItems).set({ state: 'cancelled' }).where(eq(orderItems.id, chosen.id));
      await tx
        .update(registrations)
        .set({ status: 'cancelled' })
        .where(eq(registrations.id, chosen.registrationId));
      await tx
        .update(tickets)
        .set({ status: 'cancelled' })
        .where(eq(tickets.registrationId, chosen.registrationId));
    });
    const repository = new ConferenceRepository(database);
    const list = await repository.listRegistrations(scope.eventId, {}, scope.organizationId);
    expect(list.items).toHaveLength(5);
    expect(list.items.find((row) => row.id === chosen.registrationId)).toMatchObject({
      paidAmount: 39900,
      refundedAmount: 39900,
      businessStatus: 'refunded',
    });
    const siblings = list.items.filter((row) => row.id !== chosen.registrationId);
    expect(siblings).toHaveLength(4);
    expect(
      siblings.every(
        (row) =>
          row.paidAmount === 39900 && row.refundedAmount === 0 && row.businessStatus === 'paid',
      ),
    ).toBe(true);
    expect(list.items.reduce((sum, row) => sum + row.paidAmount, 0)).toBe(199500);
    expect(list.items.reduce((sum, row) => sum + row.refundedAmount, 0)).toBe(39900);
    expect(list.items.every((row) => row.invoiceSummary.status === 'eligible')).toBe(true);
    const invoiceNo = `I${randomUUID()}`;
    await database.db!.insert(invoiceRequests).values({
      organizationId: scope.organizationId,
      eventId: scope.eventId,
      orderId: checkout.order.id,
      registrationId: null,
      requestNo: invoiceNo,
      buyerType: 'company',
      title: '整单剩余名额发票',
      taxId: '911100001234567801',
      email: 'invoice@example.test',
      mobile: '+8613900000099',
      content: '会务费',
      amount: 159600,
      netPaidAmount: 159600,
      currency: 'CNY',
      status: 'issued',
    });
    const invoiced = await repository.listRegistrations(
      scope.eventId,
      { invoiceStatus: 'issued' },
      scope.organizationId,
    );
    expect(invoiced.items).toHaveLength(5);
    expect(
      invoiced.items.every(
        (row) =>
          row.invoiceSummary.status === 'issued' && row.invoiceSummary.requestNo === invoiceNo,
      ),
    ).toBe(true);
  });

  it('exports five attendee CSV rows whose allocated amounts sum to the one purchase total', async () => {
    const { scope, checkout } = await returnedExtraPayment();
    const [staff] = await database
      .db!.insert(users)
      .values({ name: '导出审核员', email: `${randomUUID()}@example.com` })
      .returning();
    const exported = await new EngagementOperationsService(
      database,
      new ConferenceRepository(database),
    ).exportRegistrationsCsv(scope.organizationId, scope.eventId, staff!.id);
    const lines = exported.csv
      .replace(/^\uFEFF/, '')
      .split('\n')
      .filter((line) => !line.startsWith('#'));
    const parse = (line: string) =>
      [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) =>
        match[1]!.replaceAll('""', '"'),
      );
    const headers = parse(lines[0]!);
    const amountIndex = headers.indexOf('名额金额（分）');
    const orderIndex = headers.indexOf('订单号');
    const registrationIndex = headers.indexOf('报名编号');
    expect(amountIndex).toBeGreaterThanOrEqual(0);
    expect(orderIndex).toBeGreaterThanOrEqual(0);
    expect(registrationIndex).toBeGreaterThanOrEqual(0);
    const rows = lines.slice(1).map(parse);
    expect(rows).toHaveLength(5);
    expect(
      rows.every(
        (row) => Number(row[amountIndex]) === 39900 && row[orderIndex] === checkout.order.orderNo,
      ),
    ).toBe(true);
    expect(rows.reduce((sum, row) => sum + Number(row[amountIndex]), 0)).toBe(199500);
    expect(new Set(rows.map((row) => row[registrationIndex])).size).toBe(5);
  });

  it.each(['processing', 'expired'] as const)(
    'rejects a purchaser mutation when the pending order is %s',
    async (state) => {
      const scope = await fixture();
      const actor = await customer(scope.organizationId);
      const checkout = await batch.create(await input(scope, actor, 3), randomUUID(), actor);
      await database
        .db!.update(orders)
        .set(
          state === 'processing'
            ? { status: 'processing' }
            : { expiresAt: new Date(Date.now() - 1_000) },
        )
        .where(eq(orders.id, checkout.order.id));
      const current = await items.detail(checkout.order.id, actor);
      const chosen = current.items[1]!;
      expect(chosen.canEditAttendee).toBe(false);
      const before = await items.rows(database.db!, checkout.order.id);
      await expect(
        new CustomerAccountService(database).updatePurchasedOrderAttendee(
          sessionFor(actor),
          checkout.order.id,
          { company: '订单不可编辑时的变更' },
          { id: chosen.id, version: chosen.version },
        ),
      ).rejects.toThrow();
      expect(await items.rows(database.db!, checkout.order.id)).toEqual(before);
    },
  );
});
