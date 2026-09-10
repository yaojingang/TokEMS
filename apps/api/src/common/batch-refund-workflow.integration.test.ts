import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  attendeeClaimTokens,
  customerUsers,
  events,
  inventoryReservations,
  invoiceRequests,
  orderItems,
  orders,
  organizations,
  outboxEvents,
  payments,
  refundItemAllocations,
  refundRequests,
  refunds,
  registrations,
  tickets,
  ticketTypes,
  users,
} from '@conference/database';
import { CustomerRefundApplicationSchema } from '@conference/contracts';
import { DatabaseService } from './database.service.js';
import { RefundWorkflowService } from './refund-workflow.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { guardRefundWrite } from './refund-write-guard.js';
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

  it('requires explicit selection and a current context, rejecting forged sums and duplicate or foreign items', async () => {
    const f = await fixture();
    const context = await workflow.customerContext(customer, f.orderId);
    expect(context.quantity).toBe(3);
    expect(context.items).toHaveLength(3);
    expect(
      CustomerRefundApplicationSchema.safeParse({
        selectedItemIds: [f.itemIds[0], f.itemIds[0]],
        policyVersion: policy.version,
      }).success,
    ).toBe(false);
    await expect(
      workflow.createCustomer(customer, f.orderId, randomUUID(), {
        amount: 3000,
        policyVersion: policy.version,
        reason: '',
      }),
    ).rejects.toThrow('请选择');
    await expect(
      workflow.createCustomer(customer, f.orderId, randomUUID(), {
        amount: 1,
        selectedItemIds: [f.itemIds[0]!],
        contextVersion: context.contextVersion,
        policyVersion: policy.version,
        reason: '',
      }),
    ).rejects.toThrow('不一致');
    await expect(
      workflow.createCustomer(customer, f.orderId, randomUUID(), {
        selectedItemIds: [randomUUID()],
        contextVersion: context.contextVersion,
        policyVersion: policy.version,
        reason: '',
      }),
    ).rejects.toThrow('不属于');
    await db.update(orderItems).set({ version: 2 }).where(eq(orderItems.id, f.itemIds[0]!));
    await expect(
      workflow.createCustomer(customer, f.orderId, randomUUID(), {
        selectedItemIds: [f.itemIds[0]!],
        contextVersion: context.contextVersion,
        policyVersion: policy.version,
        reason: '',
      }),
    ).rejects.toThrow('刷新');
    await expect(
      workflow.createAdmin(org, f.orderId, actor, randomUUID(), {
        amount: 100,
        reason: 'compensation',
      }),
    ).rejects.toThrow('明确名额');
  });
  it('reserves finances at application and pauses only approved selected rights', async () => {
    const f = await fixture();
    const app = await apply(f);
    expect((await ticketRows(f.orderId)).every((row) => row.refundPausedBy === null)).toBe(true);
    await expect(db.transaction((tx) => guardRefundWrite(tx, f.orderId))).rejects.toThrow(
      '正在退款',
    );
    await expect(
      db.transaction((tx) =>
        guardRefundWrite(tx, f.orderId, false, { purpose: 'rights', orderItemId: f.itemIds[0]! }),
      ),
    ).resolves.toMatchObject({ id: f.orderId });
    await workflow.review(
      org,
      eventId,
      app.id,
      actor,
      randomUUID(),
      { version: app.version },
      'approve',
    );
    await expect(
      db.transaction((tx) =>
        guardRefundWrite(tx, f.orderId, false, { purpose: 'rights', orderItemId: f.itemIds[0]! }),
      ),
    ).rejects.toThrow('正在退款');
    await expect(
      db.transaction((tx) =>
        guardRefundWrite(tx, f.orderId, false, { purpose: 'rights', orderItemId: f.itemIds[1]! }),
      ),
    ).resolves.toMatchObject({ id: f.orderId });
    expect(
      (await ticketRows(f.orderId)).filter((row) => row.refundPausedBy === app.id),
    ).toHaveLength(1);
    const [execution] = await db.select().from(refunds).where(eq(refunds.requestId, app.id));
    expect(execution!.requestSnapshot!.amount).toEqual({
      refund: 1000,
      total: 3000,
      currency: 'CNY',
    });
  });
  it('allows a remaining sibling after another used or cancelled item and rechecks approval version/window', async () => {
    const f = await fixture();
    const rows = await itemRows(f.orderId);
    await db
      .update(tickets)
      .set({ status: 'used' })
      .where(eq(tickets.registrationId, rows[1]!.registrationId));
    await db.update(orderItems).set({ state: 'cancelled' }).where(eq(orderItems.id, rows[2]!.id));
    const context = await workflow.customerContext(customer, f.orderId);
    expect(context.eligible).toBe(true);
    expect(context.items.filter((row) => row.eligible)).toHaveLength(1);
    const app = await apply(f);
    await db.update(orderItems).set({ version: 2 }).where(eq(orderItems.id, f.itemIds[0]!));
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
    ).rejects.toThrow('已更新');
    const g = await fixture();
    const gApp = await apply(g);
    await db
      .update(payments)
      .set({ succeededAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(payments.id, g.payment.id));
    await expect(
      workflow.review(
        org,
        eventId,
        gApp.id,
        actor,
        randomUUID(),
        { version: gApp.version },
        'approve',
      ),
    ).rejects.toThrow('期限');
  });
  it('records one allocation, revokes one seat and claim, releases inventory once across duplicate notifications', async () => {
    const f = await fixture();
    const { app, execution } = await approve(f);
    await Promise.all([
      workflow.observe(org, merchant, outcome(f, execution)),
      workflow.observe(org, merchant, outcome(f, execution)),
    ]);
    expect((await itemRows(f.orderId)).map((row) => row.state)).toEqual([
      'cancelled',
      'active',
      'active',
    ]);
    const [type] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, f.typeId));
    expect(type!.sold).toBe(2);
    const allocations = await db
      .select()
      .from(refundItemAllocations)
      .where(eq(refundItemAllocations.refundId, execution.id));
    expect(allocations.map((row) => row.amount)).toEqual([1000]);
    const rows = await itemRows(f.orderId);
    const [claim] = await db
      .select()
      .from(attendeeClaimTokens)
      .where(eq(attendeeClaimTokens.registrationId, rows[0]!.registrationId));
    expect(claim!.revokedAt).not.toBeNull();
    const [application] = await db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, app.id));
    expect(application!.completedAmount).toBe(1000);
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    expect(order!.status).toBe('partially_refunded');
    expect(order!.entitlementsOnHold).toBe(false);
    const releases = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventType, 'RefundItemRevoked'),
          sql`${outboxEvents.payload}->>'orderId' = ${f.orderId}`,
        ),
      );
    expect(releases).toHaveLength(1);
    expect(releases[0]!.payload.quantity).toBe(1);
    expect(
      (await workflow.customerContext(customer, f.orderId)).items.filter((row) => row.eligible),
    ).toHaveLength(2);
    await expect(apply(f, [f.itemIds[1]!])).resolves.toMatchObject({ amount: 1000 });
  });
  it('split known executions satisfy each selected obligation before revoking that item', async () => {
    const f = await fixture();
    const { app, execution } = await approve(f, f.itemIds.slice(0, 2));
    await db.update(refunds).set({ amount: 500 }).where(eq(refunds.id, execution.id));
    await workflow.observe(org, merchant, outcome(f, { ...execution, amount: 500 }));
    expect((await itemRows(f.orderId)).every((row) => row.state === 'active')).toBe(true);
    const second = await external(f, 1500);
    await db
      .update(refunds)
      .set({ requestId: app.id, protectionScope: 'items' })
      .where(eq(refunds.id, second.id));
    await workflow.observe(
      org,
      merchant,
      outcome(f, { ...second, requestId: app.id, protectionScope: 'items' }),
    );
    expect((await itemRows(f.orderId)).map((row) => row.state)).toEqual([
      'cancelled',
      'cancelled',
      'active',
    ]);
    const allocations = await db
      .select()
      .from(refundItemAllocations)
      .where(eq(refundItemAllocations.orderId, f.orderId));
    expect(allocations.reduce((sum, row) => sum + row.amount, 0)).toBe(2000);
  });
  it('records unattributed verified external cash, holds rights, and assigns retain explicitly without more channel money', async () => {
    const f = await fixture(1);
    const execution = await external(f, 1000);
    const result = outcome(f, execution);
    await workflow.observe(org, merchant, result);
    let [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    expect(order!.status).toBe('refunded');
    expect(order!.entitlementsOnHold).toBe(true);
    expect(
      await db
        .select()
        .from(refundItemAllocations)
        .where(eq(refundItemAllocations.orderId, f.orderId)),
    ).toHaveLength(0);
    expect((await itemRows(f.orderId))[0]!.state).toBe('active');
    const submit = vi.spyOn(gateway, 'submitRefund');
    vi.spyOn(gateway, 'queryRefund').mockResolvedValueOnce(result);
    await expect(
      workflow.executionMode(org, f.orderId, actor, randomUUID(), {
        mode: 'automatic',
        reason: 'reviewed',
      }),
    ).rejects.toThrow('尚未归属');
    const key = randomUUID();
    await workflow.verifyExternal(org, f.orderId, actor, key, execution.outRefundNo!, [
      { orderItemId: f.itemIds[0]!, amount: 1000, rightsEffect: 'retain' },
    ]);
    expect(submit).not.toHaveBeenCalled();
    expect((await itemRows(f.orderId))[0]!.state).toBe('active');
    [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    expect(order!.entitlementsOnHold).toBe(false);
    await workflow.executionMode(org, f.orderId, actor, randomUUID(), {
      mode: 'automatic',
      reason: 'reviewed',
    });
    expect((await ticketRows(f.orderId))[0]!.status).toBe('valid');
  });
  it('preserves externally verified over-refund facts with allocation attention', async () => {
    const f = await fixture(1);
    const { execution } = await approve(f);
    await workflow.observe(org, merchant, outcome(f, execution));
    const extra = await external(f, 500);
    await expect(workflow.observe(org, merchant, outcome(f, extra))).resolves.toEqual({
      status: 'succeeded',
    });
    const [row] = await db.select().from(refunds).where(eq(refunds.id, extra.id));
    expect(row!.status).toBe('succeeded');
    expect(row!.fulfillmentAttention).not.toBeNull();
    expect(
      (
        await db
          .select()
          .from(refunds)
          .where(and(eq(refunds.orderId, f.orderId), eq(refunds.status, 'succeeded')))
      ).reduce((sum, row) => sum + row.amount, 0),
    ).toBe(1500);
  });
  it('local fulfillment failure preserves cash and pauses only targets, then repairs the same execution once', async () => {
    const f = await fixture();
    const { execution } = await approve(f);
    const rows = await itemRows(f.orderId);
    await db
      .update(tickets)
      .set({ status: 'used' })
      .where(eq(tickets.registrationId, rows[0]!.registrationId));
    await workflow.observe(org, merchant, outcome(f, execution));
    const [cash] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
    expect(cash!.status).toBe('succeeded');
    expect(cash!.fulfillmentAttention).not.toBeNull();
    await expect(
      db.transaction((tx) =>
        guardRefundWrite(tx, f.orderId, false, { purpose: 'rights', orderItemId: f.itemIds[1]! }),
      ),
    ).resolves.toMatchObject({ id: f.orderId });
    await db
      .update(tickets)
      .set({ status: 'valid' })
      .where(eq(tickets.registrationId, rows[0]!.registrationId));
    await expect(workflow.repairFulfillment(org, execution.id)).resolves.toEqual({
      repaired: true,
    });
    await expect(workflow.repairFulfillment(org, execution.id)).resolves.toEqual({
      repaired: false,
    });
    expect((await itemRows(f.orderId)).map((row) => row.state)).toEqual([
      'cancelled',
      'active',
      'active',
    ]);
    expect(await db.select().from(refunds).where(eq(refunds.orderId, f.orderId))).toHaveLength(1);
  });
  it('assigns successive verified external splits to an approved request through the operator API', async () => {
    const f = await fixture();
    const { app, execution: original } = await approve(f, f.itemIds.slice(0, 2));
    const first = await external(f, 500);
    const firstOutcome = outcome(f, first);
    await workflow.observe(org, merchant, firstOutcome);
    vi.mocked(gateway.queryRefund).mockResolvedValue(firstOutcome);
    const firstKey = randomUUID();
    const firstMapping = [
      { orderItemId: f.itemIds[0]!, amount: 500, rightsEffect: 'revoke' as const },
    ];
    await workflow.verifyExternal(
      org,
      f.orderId,
      actor,
      firstKey,
      first.outRefundNo!,
      firstMapping,
    );
    await workflow.verifyExternal(
      org,
      f.orderId,
      actor,
      firstKey,
      first.outRefundNo!,
      firstMapping,
    );
    expect((await itemRows(f.orderId)).every((row) => row.state === 'active')).toBe(true);
    let [request] = await db.select().from(refundRequests).where(eq(refundRequests.id, app.id));
    expect(request!.completedAmount).toBe(500);
    expect(request!.reservedAmount).toBe(1500);
    const [prior] = await db.select().from(refunds).where(eq(refunds.id, original.id));
    expect(prior!.status).toBe('superseded');
    const second = await external(f, 1500);
    const secondOutcome = outcome(f, second);
    await workflow.observe(org, merchant, secondOutcome);
    vi.mocked(gateway.queryRefund).mockResolvedValue(secondOutcome);
    await workflow.verifyExternal(org, f.orderId, actor, randomUUID(), second.outRefundNo!, [
      { orderItemId: f.itemIds[0]!, amount: 500, rightsEffect: 'revoke' },
      { orderItemId: f.itemIds[1]!, amount: 1000, rightsEffect: 'revoke' },
    ]);
    [request] = await db.select().from(refundRequests).where(eq(refundRequests.id, app.id));
    expect(request!.completedAmount).toBe(2000);
    expect(request!.reservedAmount).toBe(0);
    expect((await itemRows(f.orderId)).map((row) => row.state)).toEqual([
      'cancelled',
      'cancelled',
      'active',
    ]);
  });
  it('keeps actual cash when invoice adjustment fails and repairs without freezing an unrelated sibling', async () => {
    const f = await fixture();
    await db.insert(invoiceRequests).values({
      organizationId: org,
      eventId,
      orderId: f.orderId,
      registrationId: null,
      requestNo: `A2${randomUUID()}`,
      buyerType: 'company',
      title: 'Test invoice',
      taxId: '911100001234567801',
      email: 'refund@example.test',
      mobile: '+8613900000099',
      content: '会务费',
      amount: 3000,
      currency: 'CNY',
      netPaidAmount: 3000,
      status: 'issued',
    });
    const { execution } = await approve(f);
    await db.execute(
      sql`create function a2_fail_invoice() returns trigger language plpgsql as $$ begin raise exception 'controlled invoice failure'; end $$`,
    );
    await db.execute(
      sql`create trigger a2_fail_invoice before update on invoice_requests for each row execute function a2_fail_invoice()`,
    );
    try {
      await expect(workflow.observe(org, merchant, outcome(f, execution))).resolves.toEqual({
        status: 'succeeded',
      });
      const [cash] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
      expect(cash!.fulfillmentAttention).not.toBeNull();
      const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
      expect(order!.status).toBe('partially_refunded');
      expect(order!.entitlementsOnHold).toBe(false);
      expect(order!.refundExecutionMode).toBe('automatic');
      await expect(
        db.transaction((tx) =>
          guardRefundWrite(tx, f.orderId, false, { purpose: 'rights', orderItemId: f.itemIds[1]! }),
        ),
      ).resolves.toMatchObject({ id: f.orderId });
      expect(
        await db
          .select()
          .from(refundItemAllocations)
          .where(eq(refundItemAllocations.refundId, execution.id)),
      ).toHaveLength(1);
    } finally {
      await db.execute(sql`drop trigger a2_fail_invoice on invoice_requests`);
      await db.execute(sql`drop function a2_fail_invoice()`);
    }
    await expect(workflow.repairFulfillment(org, execution.id)).resolves.toEqual({
      repaired: true,
    });
    const [invoice] = await db
      .select()
      .from(invoiceRequests)
      .where(eq(invoiceRequests.orderId, f.orderId));
    expect(invoice!.netPaidAmount).toBe(2000);
    expect(invoice!.status).toBe('adjustment_required');
    expect((await itemRows(f.orderId)).map((row) => row.state)).toEqual([
      'cancelled',
      'active',
      'active',
    ]);
  });
  it('rejects external attribution to foreign or over-cap items without losing verified money', async () => {
    const f = await fixture();
    const other = await fixture();
    const execution = await external(f, 1500);
    const result = outcome(f, execution);
    await workflow.observe(org, merchant, result);
    vi.mocked(gateway.queryRefund).mockResolvedValue(result);
    await expect(
      workflow.verifyExternal(org, f.orderId, actor, randomUUID(), execution.outRefundNo!, [
        { orderItemId: other.itemIds[0]!, amount: 1500, rightsEffect: 'retain' },
      ]),
    ).rejects.toThrow('名额或剩余金额');
    await expect(
      workflow.verifyExternal(org, f.orderId, actor, randomUUID(), execution.outRefundNo!, [
        { orderItemId: f.itemIds[0]!, amount: 1500, rightsEffect: 'retain' },
      ]),
    ).rejects.toThrow('名额或剩余金额');
    const [cash] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
    expect(cash!.status).toBe('succeeded');
    expect(
      await db
        .select()
        .from(refundItemAllocations)
        .where(eq(refundItemAllocations.refundId, execution.id)),
    ).toHaveLength(0);
  });
});
