import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_EVENT, type CreateRegistrationBatch } from '@conference/contracts';
import {
  attendeeClaimTokens,
  customerUsers,
  eventReleases,
  events,
  inventoryReservations,
  orderItems,
  orders,
  payments,
  organizations,
  registrations,
  tickets,
  ticketTypes,
  users,
  waitlistEntries,
} from '@conference/database';
import { DatabaseService } from './database.service.js';
import { BatchRegistrationService } from './batch-registration.service.js';
import { batchTokenHash, OrderItemsService } from './order-items.service.js';
import { BatchPaymentService } from './batch-payment.service.js';
import { BatchOrderManagementService } from './batch-order-management.service.js';
import { BatchClaimInvitationService } from './batch-claim-invitation.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { claimAttendeeItem } from './attendee-item-claim.js';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import type { CustomerRegistrationActor } from './conference.repository.js';

const persistent = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;
persistent('batch checkout with real PostgreSQL transactions', () => {
  let admin: pg.Pool;
  let database: DatabaseService;
  let batch: BatchRegistrationService;
  let items: OrderItemsService;
  let payment: BatchPaymentService;
  let management: BatchOrderManagementService;
  const name = `batch_api_${randomUUID().replaceAll('-', '')}`;
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

  async function expandPublishedCapacity(
    scope: Awaited<ReturnType<typeof fixture>>,
    capacity: number,
  ) {
    const db = database.db!;
    const [release] = await db
      .insert(eventReleases)
      .values({
        eventId: scope.eventId,
        version: 2,
        templateKey: 'test',
        artifactKey: 'test-expanded',
        snapshot: {
          ...scope.snapshot,
          tickets: scope.snapshot.tickets.map((ticket) => ({ ...ticket, capacity })),
        },
      })
      .returning();
    await db.update(ticketTypes).set({ capacity }).where(eq(ticketTypes.id, scope.ticketTypeId));
    await db
      .update(events)
      .set({
        settings: { currentReleaseId: release!.id },
      })
      .where(eq(events.id, scope.eventId));
  }

  async function invite(
    scope: Awaited<ReturnType<typeof fixture>>,
    actor: CustomerRegistrationActor,
  ) {
    const token = randomUUID();
    const [offer] = await database
      .db!.insert(waitlistEntries)
      .values({
        organizationId: scope.organizationId,
        eventId: scope.eventId,
        ticketTypeId: scope.ticketTypeId,
        customerUserId: actor.customerUserId,
        mobileE164: actor.mobile,
        name: '候补参会人',
        position: 1,
        status: 'invited',
        offerTokenHash: batchTokenHash(token),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    return { id: offer!.id, token };
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
  it('claims one paid invitation only with the attendee mobile and never changes sibling ownership', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const request = await input(scope, actor, 3);
    const checkout = await batch.create(request, randomUUID(), actor);
    const target = checkout.items[1]!;
    const invitation = await new BatchClaimInvitationService(items).generate(
      checkout.order.id,
      target.id,
      { expectedVersion: target.version, notify: false },
      randomUUID(),
      actor,
    );
    const token = new URL(invitation.claimUrl!, 'https://example.com').hash;
    const claimToken = new URLSearchParams(token.slice(1)).get('claim')!;
    await expect(
      claimAttendeeItem(database.db!, items, sessionFor(actor), {
        registrationId: target.registrationId,
        claimToken,
      }),
    ).rejects.toThrow('手机号');
    const mobile = request.attendees[1]!.attendee.mobile;
    const [user] = await database
      .db!.insert(customerUsers)
      .values({ organizationId: scope.organizationId, mobileE164: mobile })
      .returning();
    const attendee = { ...actor, customerUserId: user!.id, mobile };
    await claimAttendeeItem(database.db!, items, sessionFor(attendee), {
      registrationId: target.registrationId,
      claimToken,
    });
    const rows = await items.rows(database.db!, checkout.order.id);
    expect(rows[1]!.registration.customerUserId).toBe(user!.id);
    expect(rows[0]!.registration.customerUserId).toBe(actor.customerUserId);
    expect(rows[2]!.registration.customerUserId).toBeNull();
    await expect(items.detail(checkout.order.id, attendee)).rejects.toThrow('无权访问');
  });
  it('records late verified money without reopening cancelled seats', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 3), randomUUID(), actor);
    await database.db!.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, checkout.order.id))
        .for('update');
      await items.cancelUnpaidItems(tx, order!);
    });
    await expect(
      payment.confirm(checkout.order.id, {
        provider: 'mock-wechat',
        externalId: randomUUID(),
        amount: checkout.order.amount,
        currency: 'CNY',
        payload: {},
        reason: '迟到支付测试',
      }),
    ).rejects.toThrow('不可自动出票');
    const [order] = await database
      .db!.select()
      .from(orders)
      .where(eq(orders.id, checkout.order.id));
    expect(order).toMatchObject({ status: 'closed', entitlementsOnHold: true });
    expect(
      (await database.db!.select().from(payments).where(eq(payments.orderId, checkout.order.id)))[0]
        ?.succeededAt,
    ).toBeTruthy();
    expect(
      (await items.rows(database.db!, checkout.order.id)).every(
        (row) => row.ticket === null && row.item.state === 'cancelled',
      ),
    ).toBe(true);
  });
  it('repairs a missing ticket without selling sibling inventory twice', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 3), randomUUID(), actor);
    const confirmation = {
      provider: 'mock-wechat',
      externalId: randomUUID(),
      amount: checkout.order.amount,
      currency: 'CNY',
      payload: {},
      reason: '补票测试',
    };
    await payment.confirm(checkout.order.id, confirmation);
    await database
      .db!.delete(tickets)
      .where(eq(tickets.registrationId, checkout.items[1]!.registrationId));
    await payment.confirm(checkout.order.id, confirmation);
    expect(
      (await items.rows(database.db!, checkout.order.id)).every((row) => row.ticket !== null),
    ).toBe(true);
    expect(
      (
        await database.db!.select().from(ticketTypes).where(eq(ticketTypes.id, scope.ticketTypeId))
      )[0]!.sold,
    ).toBe(3);
    expect(
      await database.db!.select().from(payments).where(eq(payments.orderId, checkout.order.id)),
    ).toHaveLength(1);
  });

  it('creates five registrations, one immutable order and five exact reservations, replaying intent', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const request = await input(scope, actor, 5);
    const checkout = await batch.create(request, randomUUID(), actor);
    expect(checkout.order).toMatchObject({
      amount: 199500,
      quantity: 5,
      modelVersion: 2,
      registrationId: null,
    });
    expect(checkout.items).toHaveLength(5);
    expect(new Set(checkout.items.map((item) => item.registrationId)).size).toBe(5);
    expect(
      await database
        .db!.select()
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, checkout.order.id)),
    ).toHaveLength(5);
    const replay = await batch.create(request, randomUUID(), actor);
    expect(replay.order.id).toBe(checkout.order.id);
    await expect(
      batch.create(
        {
          ...request,
          attendees: request.attendees.map((row, index) =>
            index ? row : { ...row, attendee: { ...row.attendee, name: '更改内容' } },
          ),
        },
        randomUUID(),
        actor,
      ),
    ).rejects.toThrow();
  });
  it('issues every seat exactly once under repeated and concurrent payment callbacks', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    const confirmation = {
      provider: 'mock-wechat',
      externalId: randomUUID(),
      amount: 199500,
      currency: 'CNY',
      payload: {},
      reason: '测试支付',
    };
    await Promise.all(
      Array.from({ length: 5 }, () => payment.confirm(checkout.order.id, confirmation)),
    );
    const rows = await items.rows(database.db!, checkout.order.id);
    expect(
      rows.every(
        (row) =>
          row.ticket && row.item.state === 'active' && row.registration.status === 'confirmed',
      ),
    ).toBe(true);
    expect(rows).toHaveLength(5);
    const [type] = await database
      .db!.select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, scope.ticketTypeId));
    expect(type!.sold).toBe(5);
    expect(
      await database.db!.select().from(payments).where(eq(payments.orderId, checkout.order.id)),
    ).toHaveLength(1);
    expect(
      await database
        .db!.select()
        .from(attendeeClaimTokens)
        .where(inArrayRegistration(checkout.items.map((row) => row.registrationId))),
    ).toHaveLength(4);
  });
  it('returns the original pending order after the ticket is unpublished', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const request = await input(scope, actor, 5);
    const checkout = await batch.create(request, randomUUID(), actor);
    await database
      .db!.update(eventReleases)
      .set({ snapshot: { ...scope.snapshot, tickets: [] } })
      .where(eq(eventReleases.id, scope.releaseId));
    const replay = await batch.create(request, randomUUID(), actor);
    expect(replay.order.id).toBe(checkout.order.id);
    expect(replay.order.amount).toBe(199500);
  });
  it('admits only whole batches in a race for the final stock', async () => {
    const scope = await fixture(39900, 25);
    const candidates = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const actor = await customer(scope.organizationId);
        return { actor, request: await input(scope, actor, 20) };
      }),
    );
    const results = await Promise.allSettled(
      candidates.map(({ actor, request }) => batch.create(request, randomUUID(), actor)),
    );
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const [count] = await database
      .db!.select({ count: sql<number>`count(*)::int` })
      .from(orderItems)
      .where(eq(orderItems.eventId, scope.eventId));
    expect(count!.count).toBe(20);
  });
  it('protects quota across multiple pending submissions by the same purchaser', async () => {
    const scope = await fixture(39900, 100, false, 5);
    const actor = await customer(scope.organizationId);
    const requests = await Promise.all([
      input(scope, actor, 3, false),
      input(scope, actor, 3, false),
    ]);
    const results = await Promise.allSettled(
      requests.map((request) => batch.create(request, randomUUID(), actor)),
    );
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect((await batch.purchaseCounts(database.db!, scope.eventId, actor)).activeSeatCount).toBe(
      3,
    );
  });
  it('does not reserve a quote and rejects a changed published price atomically', async () => {
    const scope = await fixture();
    const actor = await customer(scope.organizationId);
    const request = await input(scope, actor, 5);
    expect(
      await database.db!.select().from(orders).where(eq(orders.eventId, scope.eventId)),
    ).toHaveLength(0);
    await database
      .db!.update(eventReleases)
      .set({
        snapshot: {
          ...scope.snapshot,
          tickets: scope.snapshot.tickets.map((ticket) => ({ ...ticket, price: 50000 })),
        },
      })
      .where(eq(eventReleases.id, scope.releaseId));
    await expect(batch.create(request, randomUUID(), actor)).rejects.toThrow('更新');
    expect(
      await database
        .db!.select()
        .from(registrations)
        .where(eq(registrations.eventId, scope.eventId)),
    ).toHaveLength(0);
  });
  it('cancels one free seat while retaining siblings and the original free payment', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    const selected = checkout.items[2]!;
    const detail = await management.cancelFree(
      checkout.order.id,
      {
        expectedVersion: checkout.order.version!,
        items: [{ id: selected.id, version: selected.version }],
      },
      actor,
    );
    expect(detail.items.filter((item) => item.state === 'active')).toHaveLength(4);
    expect(detail.items.filter((item) => item.state === 'cancelled')).toHaveLength(1);
    expect(detail.order.status).toBe('paid');
    const [type] = await database
      .db!.select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, scope.ticketTypeId));
    expect(type!.sold).toBe(4);
    expect(
      await database.db!.select().from(payments).where(eq(payments.orderId, checkout.order.id)),
    ).toHaveLength(1);
  });
  it('reviews all five seats together and grants one new payment window', async () => {
    const scope = await fixture(39900, 100, true);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    const [staff] = await database
      .db!.insert(users)
      .values({ name: '测试审核员', email: `${randomUUID()}@example.com` })
      .returning();
    expect(checkout.order.status).toBe('pending_review');
    expect((await items.rows(database.db!, checkout.order.id)).every((row) => !row.ticket)).toBe(
      true,
    );
    const reviewed = await management.review(
      checkout.order.id,
      scope.eventId,
      scope.organizationId,
      staff!.id,
      { expectedVersion: checkout.order.version!, decision: 'approve', reason: '' },
    );
    expect(reviewed.order.status).toBe('pending_payment');
    expect(reviewed.items.every((item) => item.registration.status === 'pending_payment')).toBe(
      true,
    );
    expect(new Date(reviewed.order.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      15 * 60_000,
    );
  });

  it('keeps a whole batch pending when published capacity is rolled back below its seats', async () => {
    const scope = await fixture(0, 1, true);
    await expandPublishedCapacity(scope, 2);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 2), randomUUID(), actor);
    const [staff] = await database
      .db!.insert(users)
      .values({
        name: '测试审核员',
        email: `${randomUUID()}@example.com`,
      })
      .returning();
    // Release rollback changes the publication pointer while the editable ticket keeps its capacity.
    await database
      .db!.update(events)
      .set({ settings: { currentReleaseId: scope.releaseId } })
      .where(eq(events.id, scope.eventId));

    await expect(
      management.review(checkout.order.id, scope.eventId, scope.organizationId, staff!.id, {
        expectedVersion: checkout.order.version!,
        decision: 'approve',
        reason: '',
      }),
    ).rejects.toThrow('可用名额不足');
    const detail = await items.detail(checkout.order.id, actor);
    expect(detail.order.status).toBe('pending_review');
    expect(
      detail.items.every((item) => item.state === 'pending' && item.ticketStatus === null),
    ).toBe(true);
    expect(
      await database.db!.select().from(payments).where(eq(payments.orderId, checkout.order.id)),
    ).toHaveLength(0);
    const [type] = await database
      .db!.select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, scope.ticketTypeId));
    expect(type).toMatchObject({ capacity: 2, sold: 0 });
    const reservations = await database
      .db!.select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, checkout.order.id));
    expect(reservations).toHaveLength(2);
    expect(
      reservations.every((reservation) => !reservation.convertedAt && !reservation.releasedAt),
    ).toBe(true);
  });

  it('exchanges only the purchaser own waitlist hold when ordinary availability is zero', async () => {
    const scope = await fixture(0, 1);
    const actor = await customer(scope.organizationId);
    const offer = await invite(scope, actor);
    const request = { ...(await input(scope, actor, 1)), waitlistOfferToken: offer.token };
    const quote = await batch.quote(request, actor);
    expect(quote.availableQuantity).toBe(0);
    const checkout = await batch.create(request, randomUUID(), actor);
    expect(checkout.order.status).toBe('paid');
    expect(checkout.items[0]!.ticketStatus).toBe('valid');
    const [entry] = await database
      .db!.select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.id, offer.id));
    expect(entry!.status).toBe('claimed');
    const [type] = await database
      .db!.select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, scope.ticketTypeId));
    expect(type!.sold).toBe(1);
  });

  it('rejects a waitlist exchange after published capacity rolls back below sold and held seats', async () => {
    const scope = await fixture(0, 1);
    await expandPublishedCapacity(scope, 2);
    const first = await customer(scope.organizationId);
    await batch.create(await input(scope, first, 1), randomUUID(), first);
    const actor = await customer(scope.organizationId);
    const offer = await invite(scope, actor);
    await database
      .db!.update(events)
      .set({ settings: { currentReleaseId: scope.releaseId } })
      .where(eq(events.id, scope.eventId));
    const request = { ...(await input(scope, actor, 1)), waitlistOfferToken: offer.token };

    await expect(batch.create(request, randomUUID(), actor)).rejects.toThrow('可购买名额不足');
    expect(
      await database.db!.select().from(orders).where(eq(orders.eventId, scope.eventId)),
    ).toHaveLength(1);
    const [entry] = await database
      .db!.select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.id, offer.id));
    expect(entry!.status).toBe('invited');
    const [type] = await database
      .db!.select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, scope.ticketTypeId));
    expect(type).toMatchObject({ capacity: 2, sold: 1 });
  });
  it('keeps attendee accounts out of the purchaser order and never returns sibling ticket codes', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const other = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 5), randomUUID(), actor);
    await expect(items.detail(checkout.order.id, other)).rejects.toThrow('无权访问');
    const detail = await items.detail(checkout.order.id, actor);
    expect(JSON.stringify(detail)).not.toContain('qrPayload');
    expect(JSON.stringify(detail)).not.toContain('claimToken');
  });
  it('replays an invitation only to the authenticated buyer while its token stays active', async () => {
    const scope = await fixture(0);
    const actor = await customer(scope.organizationId);
    const checkout = await batch.create(await input(scope, actor, 2), randomUUID(), actor);
    const selected = checkout.items[1]!;
    const key = randomUUID();
    const invitations = new BatchClaimInvitationService(items);
    const first = await invitations.generate(
      checkout.order.id,
      selected.id,
      { expectedVersion: selected.version, notify: false },
      key,
      actor,
    );
    const replay = await invitations.generate(
      checkout.order.id,
      selected.id,
      { expectedVersion: selected.version, notify: false },
      key,
      actor,
    );
    expect(replay.claimUrl).toBe(first.claimUrl);
    await database
      .db!.update(attendeeClaimTokens)
      .set({ revokedAt: new Date() })
      .where(eq(attendeeClaimTokens.registrationId, selected.registrationId));
    const revoked = await invitations.generate(
      checkout.order.id,
      selected.id,
      { expectedVersion: selected.version, notify: false },
      key,
      actor,
    );
    expect(revoked.claimUrl).toBeNull();
  });
});

function inArrayRegistration(ids: string[]) {
  return sql`${attendeeClaimTokens.registrationId} in (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`,`,
  )})`;
}
