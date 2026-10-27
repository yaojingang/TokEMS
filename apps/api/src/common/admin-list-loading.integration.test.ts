import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { QueryConfig, QueryResult } from 'pg';
import { eq } from 'drizzle-orm';
import {
  events,
  organizations,
  orders,
  orderItems,
  payments,
  registrations,
  ticketTypes,
} from '@conference/database';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';

const persistent = process.env.DATABASE_URL ? describe : describe.skip;
persistent('admin registration query pagination and counts', () => {
  const database = new DatabaseService();
  const db = database.db!;
  const repository = new ConferenceRepository(database);
  const organizationId = randomUUID();
  const ticketTypeId = randomUUID();
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const legacyOrderId = randomUUID();
  const batchOrderId = randomUUID();
  let eventId: number;

  beforeAll(async () => {
    await db.transaction(async (db) => {
      await db
        .insert(organizations)
        .values({ id: organizationId, slug: `loading-${organizationId}`, name: '加载测试组织' });
      const [event] = await db
        .insert(events)
        .values({
          organizationId,
          slug: `loading-${organizationId}`,
          name: '加载测试大会',
          shortName: '加载测试',
          tagline: '测试',
          description: '测试',
          startsAt: new Date('2027-01-01'),
          endsAt: new Date('2027-01-02'),
          timezone: 'Asia/Shanghai',
          venue: '深圳',
          city: '深圳',
          address: '深圳',
        })
        .returning();
      eventId = event!.id;
      await db.insert(ticketTypes).values({
        id: ticketTypeId,
        organizationId,
        eventId,
        code: 'TEST',
        name: '测试票',
        description: '',
        price: 100,
        capacity: 100,
      });
      const statuses = [
        'pending_payment',
        'confirmed',
        'confirmed',
        'confirmed',
        'pending_payment',
        'pending_review',
      ] as const;
      await db.insert(registrations).values(
        ids.map((id, index) => ({
          id,
          organizationId,
          eventId,
          ticketTypeId,
          registrationCode: `TEST-${id.slice(0, 8)}`,
          status: statuses[index]!,
          supersededAt: index === 4 ? new Date() : null,
          createdAt: new Date(Date.UTC(2026, 9, 20, 0, index)),
          attendee: {
            name: `加载参会人${index}`,
            mobile: `1380000000${index}`,
            email: '',
            company: '测试公司',
            title: '',
            city: '深圳',
          },
        })),
      );
      await db.insert(orders).values([
        {
          id: legacyOrderId,
          organizationId,
          eventId,
          registrationId: ids[0]!,
          orderNo: `LEGACY-${organizationId.slice(0, 8)}`,
          amount: 100,
          currency: 'CNY',
          pricingSnapshot: {},
          expiresAt: new Date('2027-01-01'),
        },
        {
          id: batchOrderId,
          organizationId,
          eventId,
          registrationId: null,
          modelVersion: 2,
          quantity: 2,
          purchaseIntentId: randomUUID(),
          status: 'paid',
          orderNo: `BATCH-${organizationId.slice(0, 8)}`,
          amount: 200,
          currency: 'CNY',
          pricingSnapshot: {},
          expiresAt: new Date('2027-01-01'),
        },
      ]);
      await db.insert(orderItems).values(
        [2, 3].map((index, position) => ({
          orderId: batchOrderId,
          registrationId: ids[index]!,
          organizationId,
          eventId,
          ticketTypeId,
          position: position + 1,
          unitPrice: 100,
          allocatedAmount: 100,
          pricingSnapshot: {},
          state: 'active' as const,
        })),
      );
      const [payment] = await db
        .insert(payments)
        .values({
          orderId: batchOrderId,
          provider: 'wechat',
          externalId: `LOADING-${organizationId}`,
          status: 'succeeded',
          amount: 200,
          currency: 'CNY',
        })
        .returning();
      await db
        .update(orders)
        .set({ settledPaymentId: payment!.id })
        .where(eq(orders.id, batchOrderId));
    });
  });
  afterAll(async () => {
    if (eventId) {
      await db.transaction(async (db) => {
        await db
          .update(orders)
          .set({ settledPaymentId: null })
          .where(eq(orders.organizationId, organizationId));
        await db.delete(orderItems).where(eq(orderItems.organizationId, organizationId));
        await db.delete(payments).where(eq(payments.orderId, batchOrderId));
        await db.delete(orders).where(eq(orders.organizationId, organizationId));
        await db.delete(registrations).where(eq(registrations.organizationId, organizationId));
        await db.delete(organizations).where(eq(organizations.id, organizationId));
      });
    }
    await database.onModuleDestroy();
  });

  it('counts only current registrations inside the authenticated scope', async () => {
    expect(await repository.countRegistrations(eventId, organizationId)).toEqual({ count: 5 });
    expect(await repository.countRegistrations(eventId, organizationId, 'pending_payment')).toEqual(
      { count: 1 },
    );
    expect(await repository.countRegistrations(eventId, randomUUID())).toEqual({ count: 0 });
  });
  it('paginates before enrichment without dropping legacy, batch or orderless registrations', async () => {
    const first = await repository.listRegistrations(eventId, { pageSize: 2 }, organizationId);
    const second = await repository.listRegistrations(
      eventId,
      { pageSize: 2, page: 2 },
      organizationId,
    );
    const last = await repository.listRegistrations(
      eventId,
      { pageSize: 2, page: 99 },
      organizationId,
    );
    expect(first).toMatchObject({ total: 5, page: 1 });
    expect(first.items.map((row) => row.id)).toEqual([ids[5], ids[3]]);
    expect(second.items.map((row) => row.id)).toEqual([ids[2], ids[1]]);
    expect(last).toMatchObject({ page: 3, total: 5 });
    expect(last.items[0]?.order?.id).toBe(legacyOrderId);
    expect(second.items[0]).toMatchObject({
      paidAmount: 100,
      businessStatus: 'paid',
      order: { id: batchOrderId },
    });
    expect(second.items[1]?.order).toBeUndefined();
  });
  it('applies related filters to the full matching set before paging', async () => {
    const paid = await repository.listRegistrations(
      eventId,
      { businessStatus: 'paid', pageSize: 1 },
      organizationId,
    );
    expect(paid.total).toBe(2);
    expect(paid.items).toHaveLength(1);
    const query = await repository.listRegistrations(
      eventId,
      { q: `BATCH-${organizationId.slice(0, 8)}` },
      organizationId,
    );
    expect(query.total).toBe(2);
    const status = await repository.listRegistrations(
      eventId,
      { status: 'pending_payment' },
      organizationId,
    );
    expect(status.total).toBe(1);
    expect(status.items[0]?.id).toBe(ids[0]);
    const invoices = await repository.listRegistrations(
      eventId,
      { invoiceStatus: 'not_eligible' },
      organizationId,
    );
    expect(invoices.items.every((row) => row.invoiceSummary.status === 'not_eligible')).toBe(true);
    expect(invoices.total).toBe(3);
  });

  it('rechecks status when a registration changes after selecting page IDs', async () => {
    const pool = db.$client;
    const originalQuery = pool.query.bind(pool) as (
      query: QueryConfig,
      values?: unknown[],
    ) => Promise<QueryResult>;
    let changed = false;
    const hook = async (query: QueryConfig, values?: unknown[]) => {
      const result = await originalQuery(query, values);
      if (!changed && /^select "id" from "registrations"/.test(query.text)) {
        changed = true;
        await originalQuery({ text: 'update registrations set status = $1 where id = $2' }, [
          'confirmed',
          ids[0],
        ]);
      }
      return result;
    };
    const spy = vi.spyOn(pool, 'query').mockImplementation(hook as typeof pool.query);
    try {
      const page = await repository.listRegistrations(
        eventId,
        { status: 'pending_payment' },
        organizationId,
      );
      expect(changed).toBe(true);
      expect(page.items).toEqual([]);
    } finally {
      spy.mockRestore();
      await db
        .update(registrations)
        .set({ status: 'pending_payment' })
        .where(eq(registrations.id, ids[0]!));
    }
  });
});
