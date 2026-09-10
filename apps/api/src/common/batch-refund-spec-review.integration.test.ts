import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  attendeeClaimTokens,
  customerUsers,
  events,
  inventoryReservations,
  invoiceRequests,
  orderItems,
  orders,
  organizations,
  payments,
  refundItemAllocations,
  refundRequestItems,
  refundRequests,
  refunds,
  registrations,
  tickets,
  ticketTypes,
  users,
} from '@conference/database';
import { AdminItemRefundSchema } from '@conference/contracts';
import { DatabaseService } from './database.service.js';
import { RefundWorkflowService } from './refund-workflow.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import type { WeChatRefundOutcome } from './refund-policy.js';

const integration = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;
integration('batch refund cash allocation and independent rights (isolated PostgreSQL)', () => {
  const databaseName = `refund_items_${randomUUID().replaceAll('-', '')}`;
  const org = randomUUID(),
    customerId = randomUUID(),
    actor = randomUUID();
  const merchant = `refund-${randomUUID().slice(0, 12)}`;
  const policy = { enabled: true, version: 'batch-seven-v1', windowDays: 7 as const };
  let admin: Pool,
    database: DatabaseService,
    db: NonNullable<DatabaseService['db']>,
    workflow: RefundWorkflowService,
    gateway: WeChatPayService;
  let created = false,
    eventId: number,
    registrationSequence = 1000;

  beforeAll(async () => {
    const url = new URL(process.env.BATCH_TEST_DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Loopback test PostgreSQL required');
    admin = new Pool({ connectionString: url.toString() });
    await admin.query(`create database "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    const migrationDb = new Pool({ connectionString: url.toString() });
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../../../packages/database/drizzle', import.meta.url),
      ),
    });
    for (const migration of migrations) {
      const connection = await migrationDb.connect();
      try {
        await connection.query('BEGIN');
        for (const statement of migration.sql)
          if (statement.trim()) await connection.query(statement);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }
    await migrationDb.end();
    const prior = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    database = new DatabaseService();
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
    db = database.db!;
    gateway = new WeChatPayService(database);
    workflow = new RefundWorkflowService(database, gateway);
    await db.insert(organizations).values({ id: org, slug: `a2-${org}`, name: 'A2 tests' });
    await db
      .insert(customerUsers)
      .values({ id: customerId, organizationId: org, mobileE164: '+8613900000999' });
    await db
      .insert(users)
      .values({ id: actor, name: 'A2 reviewer', email: `${actor}@example.test` });
    const [event] = await db
      .insert(events)
      .values({
        organizationId: org,
        slug: `a2-${org}`,
        name: 'Batch refunds',
        shortName: 'A2',
        tagline: '',
        description: '',
        startsAt: new Date('2027-11-01'),
        endsAt: new Date('2027-11-02'),
        timezone: 'Asia/Shanghai',
        venue: 'Test',
        city: 'Test',
        address: 'Test',
        settings: { refunds: policy },
      })
      .returning();
    eventId = event!.id;
    vi.spyOn(gateway, 'refundConfiguration').mockResolvedValue({
      merchantId: merchant,
      funding: 'default',
      notifyUrl: 'https://example.test/refund',
    });
    vi.spyOn(gateway, 'refundMerchantId').mockResolvedValue(merchant);
    vi.spyOn(gateway, 'verifyRefundPayment').mockResolvedValue({
      merchantId: merchant,
      paidAt: new Date(),
    });
  }, 60_000);
  afterAll(async () => {
    await database?.onModuleDestroy();
    if (created) await admin.query(`drop database "${databaseName}"`);
    await admin?.end();
  });
  const customer = { organizationId: org, customerUserId: customerId };

  async function fixture(quantity = 3) {
    const orderId = randomUUID(),
      typeId = randomUUID();
    await db.insert(ticketTypes).values({
      id: typeId,
      organizationId: org,
      eventId,
      code: typeId,
      name: 'Batch ticket',
      description: 'Test',
      price: 1000,
      capacity: 100,
      sold: quantity,
    });
    const itemIds: string[] = [];
    await db.transaction(async (tx) => {
      const registrationIds = Array.from({ length: quantity }, () => randomUUID());
      for (let index = 0; index < quantity; index++) {
        const registrationId = registrationIds[index]!,
          position = index + 1;
        await tx.insert(registrations).values({
          id: registrationId,
          organizationId: org,
          eventId,
          ticketTypeId: typeId,
          registrationCode: `A2${randomUUID().replaceAll('-', '')}`,
          status: 'confirmed',
          attendeeMobileE164: `+86139${String(++registrationSequence).padStart(8, '0')}`,
          attendee: {
            name: `Attendee ${position}`,
            mobile: '13900000000',
            email: `${registrationId}@example.test`,
            company: 'Test',
            title: 'Test',
            city: 'Test',
          },
        });
      }
      await tx.insert(orders).values({
        id: orderId,
        organizationId: org,
        eventId,
        registrationId: quantity === 1 ? registrationIds[0] : null,
        purchaseIntentId: randomUUID(),
        modelVersion: 2,
        quantity,
        purchaserCustomerUserId: customerId,
        orderNo: `A2${randomUUID().replaceAll('-', '')}`,
        amount: 1000 * quantity,
        currency: 'CNY',
        status: 'paid',
        pricingSnapshot: { refundPolicy: policy },
        expiresAt: new Date(),
      });
      for (let position = 1; position <= quantity; position++) {
        const registrationId = registrationIds[position - 1]!,
          itemId = randomUUID();
        itemIds.push(itemId);
        await tx.insert(orderItems).values({
          id: itemId,
          orderId,
          organizationId: org,
          eventId,
          registrationId,
          position,
          ticketTypeId: typeId,
          unitPrice: 1000,
          allocatedAmount: 1000,
          pricingSnapshot: {},
          state: 'active',
        });
        await tx.insert(tickets).values({
          eventId,
          registrationId,
          ticketTypeId: typeId,
          code: `A2${randomUUID()}`,
          status: 'valid',
        });
        await tx.insert(inventoryReservations).values({
          orderId,
          orderItemId: itemId,
          eventId,
          ticketTypeId: typeId,
          quantity: 1,
          expiresAt: new Date(),
          convertedAt: new Date(),
        });
        await tx.insert(attendeeClaimTokens).values({
          registrationId,
          tokenHash: randomUUID(),
          mobileDigest: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        });
      }
      const [payment] = await tx
        .insert(payments)
        .values({
          orderId,
          provider: 'wechatpay',
          channel: 'native',
          merchantId: merchant,
          outTradeNo: `A2${randomUUID().replaceAll('-', '').slice(0, 28)}`,
          externalId: randomUUID(),
          amount: quantity * 1000,
          currency: 'CNY',
          status: 'succeeded',
          succeededAt: new Date(),
        })
        .returning();
      const [first] = await tx.select().from(orderItems).where(eq(orderItems.id, itemIds[0]!));
      await tx
        .update(orders)
        .set({
          settledPaymentId: payment!.id,
          ...(quantity === 1 ? { registrationId: first!.registrationId } : {}),
        })
        .where(eq(orders.id, orderId));
    });
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, orderId));
    return { orderId, typeId, itemIds, payment: payment! };
  }
  const itemRows = (id: string) =>
    db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, id))
      .orderBy(asc(orderItems.position));
  async function ticketRows(id: string) {
    const rows = await itemRows(id);
    return db
      .select()
      .from(tickets)
      .where(
        sql`${tickets.registrationId} in (${sql.join(
          rows.map((item) => sql`${item.registrationId}`),
          sql`,`,
        )})`,
      )
      .orderBy(asc(tickets.id));
  }
  async function apply(f: Awaited<ReturnType<typeof fixture>>, ids = [f.itemIds[0]!]) {
    const context = await workflow.customerContext(customer, f.orderId);
    return workflow.createCustomer(customer, f.orderId, randomUUID(), {
      policyVersion: context.policyVersion,
      contextVersion: context.contextVersion,
      selectedItemIds: ids,
      reason: '',
    });
  }
  async function approve(f: Awaited<ReturnType<typeof fixture>>, ids = [f.itemIds[0]!]) {
    const app = await apply(f, ids);
    const reviewed = await workflow.review(
      org,
      eventId,
      app.id,
      actor,
      randomUUID(),
      { version: app.version },
      'approve',
    );
    const [execution] = await db.select().from(refunds).where(eq(refunds.requestId, app.id));
    return { app: reviewed, execution: execution! };
  }
  function outcome(
    f: Awaited<ReturnType<typeof fixture>>,
    execution: typeof refunds.$inferSelect,
  ): WeChatRefundOutcome {
    return {
      refund_id: `wx-${execution.id}`,
      out_refund_no: execution.outRefundNo!,
      transaction_id: f.payment.externalId!,
      out_trade_no: f.payment.outTradeNo!,
      channel: 'ORIGINAL',
      user_received_account: '原支付账户',
      status: 'SUCCESS',
      create_time: new Date().toISOString(),
      success_time: new Date().toISOString(),
      amount: {
        total: f.payment.amount,
        refund: execution.amount,
        payer_total: f.payment.amount,
        payer_refund: execution.amount,
        currency: 'CNY',
      },
    };
  }
  async function external(f: Awaited<ReturnType<typeof fixture>>, amount: number) {
    const [execution] = await db
      .insert(refunds)
      .values({
        organizationId: org,
        eventId,
        orderId: f.orderId,
        paymentId: f.payment.id,
        source: 'external',
        refundNo: randomUUID(),
        outRefundNo: `EXT${randomUUID().replaceAll('-', '')}`,
        merchantId: merchant,
        amount,
        currency: 'CNY',
        status: 'query_pending',
        reason: 'external',
        idempotencyKey: randomUUID(),
      })
      .returning();
    return execution!;
  }

  it('SPEC: preserves the accepted policy deadline when approval is delayed', async () => {
    const f = await fixture();
    await db
      .update(payments)
      .set({ succeededAt: new Date(Date.now() - 6 * 86_400_000) })
      .where(eq(payments.id, f.payment.id));
    const app = await apply(f);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86_400_000);
    try {
      await expect(
        workflow.review(
          org,
          eventId,
          app.id,
          actor,
          randomUUID(),
          { version: app.version },
          'approve',
        ),
      ).resolves.toMatchObject({ reviewStatus: 'approved' });
    } finally {
      clock.mockRestore();
    }
  });
  it('SPEC: an originally disabled refund policy remains disabled after current settings enable it', async () => {
    const f = await fixture();
    await db
      .update(orders)
      .set({ pricingSnapshot: { refundPolicy: { ...policy, enabled: false } } })
      .where(eq(orders.id, f.orderId));
    expect((await workflow.customerContext(customer, f.orderId)).eligible).toBe(false);
  });
  it('SPEC: issued invoice keeps its original amount after partial refund', async () => {
    const f = await fixture();
    await db.insert(invoiceRequests).values({
      organizationId: org,
      eventId,
      orderId: f.orderId,
      registrationId: null,
      requestNo: `REV${randomUUID()}`,
      buyerType: 'company',
      title: 'Review invoice',
      taxId: '911100001234567801',
      email: 'review@example.test',
      mobile: '+8613900000099',
      content: '会务费',
      amount: 3000,
      currency: 'CNY',
      netPaidAmount: 3000,
      status: 'issued',
    });
    const { execution } = await approve(f);
    await workflow.observe(org, merchant, outcome(f, execution));
    const [invoice] = await db
      .select()
      .from(invoiceRequests)
      .where(eq(invoiceRequests.orderId, f.orderId));
    expect(invoice!.status).toBe('adjustment_required');
    expect(invoice!.amount).toBe(3000);
  });
  it('SPEC: unattributed external cash survives failed invoice synchronization', async () => {
    const f = await fixture();
    await db.insert(invoiceRequests).values({
      organizationId: org,
      eventId,
      orderId: f.orderId,
      registrationId: null,
      requestNo: `REV${randomUUID()}`,
      buyerType: 'company',
      title: 'Review invoice',
      taxId: '911100001234567801',
      email: 'review@example.test',
      mobile: '+8613900000099',
      content: '会务费',
      amount: 3000,
      currency: 'CNY',
      netPaidAmount: 3000,
      status: 'issued',
    });
    const execution = await external(f, 1000);
    await db.execute(
      sql`create function spec_fail_invoice() returns trigger language plpgsql as $$ begin raise exception 'controlled invoice failure'; end $$`,
    );
    await db.execute(
      sql`create trigger spec_fail_invoice before update on invoice_requests for each row execute function spec_fail_invoice()`,
    );
    try {
      await expect(workflow.observe(org, merchant, outcome(f, execution))).resolves.toEqual({
        status: 'succeeded',
      });
      const [cash] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
      expect(cash!.status).toBe('succeeded');
    } finally {
      await db.execute(sql`drop trigger spec_fail_invoice on invoice_requests`);
      await db.execute(sql`drop function spec_fail_invoice()`);
    }
  });

  async function adminInput(
    f: Awaited<ReturnType<typeof fixture>>,
    allocations: Array<{
      orderItemId: string;
      amount: number;
      rightsEffect: 'retain' | 'revoke';
      version?: number;
    }>,
  ) {
    const context = await workflow.adminItemContext(org, eventId, f.orderId);
    return {
      contextVersion: context.contextVersion,
      reason: '明确按名额补偿',
      allocations: allocations.map((allocation) => ({
        ...allocation,
        version:
          allocation.version ??
          context.items.find((item) => item.id === allocation.orderItemId)?.version ??
          1,
      })),
    };
  }
  it('SPEC: admin contracts reject malformed amounts, duplicate items and missing choices', () => {
    const base = {
      contextVersion: 'test',
      reason: 'refund',
      allocations: [{ orderItemId: randomUUID(), version: 1, amount: 100, rightsEffect: 'retain' }],
    };
    expect(AdminItemRefundSchema.safeParse(base).success).toBe(true);
    for (const amount of [0, -100, 0.5])
      expect(
        AdminItemRefundSchema.safeParse({
          ...base,
          allocations: [{ ...base.allocations[0], amount }],
        }).success,
      ).toBe(false);
    expect(
      AdminItemRefundSchema.safeParse({
        ...base,
        allocations: [base.allocations[0], base.allocations[0]],
      }).success,
    ).toBe(false);
    expect(
      AdminItemRefundSchema.safeParse({
        ...base,
        allocations: [{ ...base.allocations[0], rightsEffect: undefined }],
      }).success,
    ).toBe(false);
  });
  it('SPEC: admin mixed compensation retains a used ticket and revokes only the specified unused sibling', async () => {
    const f = await fixture();
    const initialItems = await itemRows(f.orderId);
    await db
      .update(tickets)
      .set({ status: 'used' })
      .where(eq(tickets.registrationId, initialItems[0]!.registrationId));
    const input = await adminInput(f, [
      { orderItemId: f.itemIds[0]!, amount: 300, rightsEffect: 'retain' },
      { orderItemId: f.itemIds[1]!, amount: 500, rightsEffect: 'revoke' },
    ]);
    const app = await workflow.createAdminItems(
      org,
      eventId,
      f.orderId,
      actor,
      randomUUID(),
      input,
    );
    expect(app.amount).toBe(800);
    expect(app.reviewStatus).toBe('approved');
    const requests = await db
      .select()
      .from(refundRequestItems)
      .where(eq(refundRequestItems.refundRequestId, app.id));
    expect(requests).toHaveLength(2);
    expect(requests.find((row) => row.orderItemId === f.itemIds[0])!).toMatchObject({
      approvedAmount: 300,
      rightsEffect: 'retain',
    });
    expect(requests.find((row) => row.orderItemId === f.itemIds[1])!).toMatchObject({
      approvedAmount: 500,
      rightsEffect: 'revoke',
    });
    const [execution] = await db.select().from(refunds).where(eq(refunds.requestId, app.id));
    expect(execution!.requestSnapshot!.amount).toEqual({
      refund: 800,
      total: 3000,
      currency: 'CNY',
    });
    await workflow.observe(org, merchant, outcome(f, execution!));
    const currentTickets = await ticketRows(f.orderId);
    expect(
      currentTickets.find((row) => row.registrationId === initialItems[0]!.registrationId)!.status,
    ).toBe('used');
    expect(
      currentTickets.find((row) => row.registrationId === initialItems[1]!.registrationId)!.status,
    ).toBe('cancelled');
    expect(
      currentTickets.find((row) => row.registrationId === initialItems[2]!.registrationId)!.status,
    ).toBe('valid');
    expect((await itemRows(f.orderId)).map((item) => item.state)).toEqual([
      'active',
      'cancelled',
      'active',
    ]);
    const [type] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, f.typeId));
    expect(type!.sold).toBe(2);
  });
  it('SPEC: admin full cash compensation preserves explicit retained rights and seat capacity', async () => {
    const f = await fixture(1);
    const input = await adminInput(f, [
      { orderItemId: f.itemIds[0]!, amount: 1000, rightsEffect: 'retain' },
    ]);
    const app = await workflow.createAdminItems(
      org,
      eventId,
      f.orderId,
      actor,
      randomUUID(),
      input,
    );
    const [execution] = await db.select().from(refunds).where(eq(refunds.requestId, app.id));
    await workflow.observe(org, merchant, outcome(f, execution!));
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const [type] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, f.typeId));
    expect(order!.status).toBe('refunded');
    expect(order!.entitlementsOnHold).toBe(false);
    expect((await itemRows(f.orderId))[0]!).toMatchObject({
      state: 'active',
      inventoryReleasedAt: null,
    });
    expect((await ticketRows(f.orderId))[0]!).toMatchObject({
      status: 'valid',
      refundPausedBy: null,
    });
    expect(type!.sold).toBe(1);
  });
  it('SPEC: admin scope/version/item balances are checked atomically before creating money requests', async () => {
    const f = await fixture();
    const g = await fixture();
    await expect(workflow.adminItemContext(org, eventId + 1, f.orderId)).rejects.toThrow('不存在');
    await expect(workflow.adminItemContext(randomUUID(), eventId, f.orderId)).rejects.toThrow(
      '不存在',
    );
    for (const allocations of [
      [{ orderItemId: g.itemIds[0]!, amount: 100, rightsEffect: 'retain' as const }],
      [{ orderItemId: f.itemIds[0]!, version: 999, amount: 100, rightsEffect: 'retain' as const }],
      [{ orderItemId: f.itemIds[0]!, amount: 1001, rightsEffect: 'retain' as const }],
    ]) {
      const input = await adminInput(f, allocations);
      await expect(
        workflow.createAdminItems(org, eventId, f.orderId, actor, randomUUID(), input),
      ).rejects.toThrow();
    }
    const stale = await adminInput(f, [
      { orderItemId: f.itemIds[0]!, amount: 100, rightsEffect: 'retain' },
    ]);
    await db.update(orderItems).set({ version: 2 }).where(eq(orderItems.id, f.itemIds[0]!));
    await expect(
      workflow.createAdminItems(org, eventId, f.orderId, actor, randomUUID(), stale),
    ).rejects.toThrow('刷新');
    const rows = await itemRows(f.orderId);
    await db
      .update(tickets)
      .set({ status: 'used' })
      .where(eq(tickets.registrationId, rows[1]!.registrationId));
    const revoke = await adminInput(f, [
      { orderItemId: f.itemIds[1]!, amount: 1000, rightsEffect: 'revoke' },
    ]);
    await expect(
      workflow.createAdminItems(org, eventId, f.orderId, actor, randomUUID(), revoke),
    ).rejects.toThrow('已使用');
    expect(
      await db.select().from(refundRequests).where(eq(refundRequests.orderId, f.orderId)),
    ).toHaveLength(0);
    expect(await db.select().from(refunds).where(eq(refunds.orderId, f.orderId))).toHaveLength(0);
  });
  it('SPEC: admin repeated submissions share one execution and changed reuse is rejected', async () => {
    const f = await fixture();
    const input = await adminInput(f, [
      { orderItemId: f.itemIds[0]!, amount: 1000, rightsEffect: 'revoke' },
    ]);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        workflow.createAdminItems(org, eventId, f.orderId, actor, key, input),
      ),
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    const [execution] = await db.select().from(refunds).where(eq(refunds.orderId, f.orderId));
    await workflow.observe(org, merchant, outcome(f, execution!));
    expect((await workflow.createAdminItems(org, eventId, f.orderId, actor, key, input)).id).toBe(
      results[0]!.id,
    );
    await expect(
      workflow.createAdminItems(org, eventId, f.orderId, actor, key, {
        ...input,
        reason: 'changed reason',
      }),
    ).rejects.toThrow('幂等键');
    expect(await db.select().from(refunds).where(eq(refunds.orderId, f.orderId))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(refundItemAllocations)
        .where(eq(refundItemAllocations.orderId, f.orderId)),
    ).toHaveLength(1);
  });
  it('SPEC: remaining amount after retained compensation limits later customer refunds', async () => {
    const f = await fixture();
    const input = await adminInput(f, [
      { orderItemId: f.itemIds[0]!, amount: 300, rightsEffect: 'retain' },
    ]);
    const app = await workflow.createAdminItems(
      org,
      eventId,
      f.orderId,
      actor,
      randomUUID(),
      input,
    );
    const [execution] = await db.select().from(refunds).where(eq(refunds.requestId, app.id));
    await workflow.observe(org, merchant, outcome(f, execution!));
    const excess = await adminInput(f, [
      { orderItemId: f.itemIds[0]!, amount: 701, rightsEffect: 'retain' },
    ]);
    await expect(
      workflow.createAdminItems(org, eventId, f.orderId, actor, randomUUID(), excess),
    ).rejects.toThrow('可退金额');
    expect((await apply(f, [f.itemIds[0]!])).amount).toBe(700);
  });
  it('SPEC: parallel distinct admin requests respect one active application per order', async () => {
    const f = await fixture();
    const a = await adminInput(f, [
      { orderItemId: f.itemIds[0]!, amount: 300, rightsEffect: 'retain' },
    ]);
    const b = await adminInput(f, [
      { orderItemId: f.itemIds[1]!, amount: 300, rightsEffect: 'retain' },
    ]);
    const results = await Promise.allSettled([
      workflow.createAdminItems(org, eventId, f.orderId, actor, randomUUID(), a),
      workflow.createAdminItems(org, eventId, f.orderId, actor, randomUUID(), b),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.select().from(refundRequests).where(eq(refundRequests.orderId, f.orderId)),
    ).toHaveLength(1);
    expect(await db.select().from(refunds).where(eq(refunds.orderId, f.orderId))).toHaveLength(1);
  });
});
