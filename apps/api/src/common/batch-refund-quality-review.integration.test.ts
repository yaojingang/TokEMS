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
  refundRequests,
  refunds,
  registrations,
  tickets,
  ticketTypes,
  users,
} from '@conference/database';
import { DatabaseService } from './database.service.js';
import { RefundWorkflowService } from './refund-workflow.service.js';
import { guardRefundWrite } from './refund-write-guard.js';
import { WeChatPayService } from './wechat-pay.service.js';
import type { WeChatRefundOutcome } from './refund-policy.js';

const integration = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;
integration('independent refund safety regression review (isolated PostgreSQL)', () => {
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

  it('QUALITY: repairing an allocation write failure also settles application reserves', async () => {
    const f = await fixture();
    const { app, execution } = await approve(f);
    await db.execute(
      sql`create function reject_quality_allocation() returns trigger language plpgsql as $$ begin raise exception 'injected allocation persistence failure'; end $$`,
    );
    await db.execute(
      sql`create trigger reject_quality_allocation before insert on refund_item_allocations for each row execute function reject_quality_allocation()`,
    );
    try {
      await expect(workflow.observe(org, merchant, outcome(f, execution))).resolves.toEqual({
        status: 'succeeded',
      });
    } finally {
      await db.execute(sql`drop trigger reject_quality_allocation on refund_item_allocations`);
      await db.execute(sql`drop function reject_quality_allocation()`);
    }
    const [cash] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
    expect(cash!.fulfillmentAttention).not.toBeNull();
    await expect(workflow.repairFulfillment(org, execution.id)).resolves.toEqual({
      repaired: true,
    });
    const [application] = await db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, app.id));
    expect(application).toMatchObject({
      completedAmount: 1000,
      reservedAmount: 0,
      fulfillmentStatus: 'completed',
    });
    expect(application!.terminatedAt).not.toBeNull();
  });

  it('QUALITY: refund-mode resume cannot clear an unresolved duplicate-payment rights hold', async () => {
    const f = await fixture();
    await db.insert(payments).values({
      orderId: f.orderId,
      provider: 'wechatpay',
      channel: 'native',
      merchantId: merchant,
      outTradeNo: `A2${randomUUID().replaceAll('-', '').slice(0, 28)}`,
      externalId: randomUUID(),
      amount: f.payment.amount,
      currency: 'CNY',
      status: 'succeeded',
      succeededAt: new Date(),
    });
    await db
      .update(orders)
      .set({
        refundExecutionMode: 'external_hold',
        entitlementsOnHold: true,
        refundExecutionReason: '发现额外成功付款，暂停自动处理并核验资金',
      })
      .where(eq(orders.id, f.orderId));
    await expect(
      workflow.executionMode(org, f.orderId, actor, randomUUID(), {
        mode: 'automatic',
        reason: '恢复正常退款',
      }),
    ).rejects.toThrow();
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    expect(order!.entitlementsOnHold).toBe(true);
  });
  it('QUALITY: explicitly retained compensation does not pause ticket rights while cash is processing', async () => {
    const f = await fixture();
    const context = await workflow.adminItemContext(org, eventId, f.orderId);
    await workflow.createAdminItems(org, eventId, f.orderId, actor, randomUUID(), {
      contextVersion: context.contextVersion,
      reason: '保留权益的明确补偿',
      allocations: [
        { orderItemId: f.itemIds[0]!, version: 1, amount: 100, rightsEffect: 'retain' },
      ],
    });
    await expect(
      db.transaction((tx) =>
        guardRefundWrite(tx, f.orderId, false, {
          purpose: 'admission',
          orderItemId: f.itemIds[0]!,
        }),
      ),
    ).resolves.toMatchObject({ id: f.orderId });
  });

  it('QUALITY: a localized verified external refund leaves unrelated ticket rights usable during finance hold', async () => {
    const f = await fixture();
    const execution = await external(f, 500);
    const data = outcome(f, execution);
    await workflow.observe(org, merchant, data);
    vi.spyOn(gateway, 'queryRefund').mockResolvedValue(data);
    await workflow.verifyExternal(org, f.orderId, actor, randomUUID(), execution.outRefundNo!, [
      { orderItemId: f.itemIds[0]!, amount: 500, rightsEffect: 'retain' },
    ]);
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    expect(order).toMatchObject({
      entitlementsOnHold: false,
      refundExecutionMode: 'external_hold',
    });
    await expect(
      db.transaction((tx) =>
        guardRefundWrite(tx, f.orderId, false, {
          purpose: 'admission',
          orderItemId: f.itemIds[1]!,
        }),
      ),
    ).resolves.toMatchObject({ id: f.orderId });
  });

  it('QUALITY: post-migration legacy refund closes its backfilled item and releases its reservation exactly once', async () => {
    const f = await fixture(1);
    await db.update(orders).set({ modelVersion: 1 }).where(eq(orders.id, f.orderId));
    const request = await workflow.createCustomer(customer, f.orderId, randomUUID(), {
      amount: 1000,
      policyVersion: policy.version,
      reason: '历史单退款',
    });
    await workflow.review(
      org,
      eventId,
      request.id,
      actor,
      randomUUID(),
      { version: request.version },
      'approve',
    );
    const [execution] = await db.select().from(refunds).where(eq(refunds.requestId, request.id));
    await workflow.observe(org, merchant, outcome(f, execution!));
    const [item] = await itemRows(f.orderId);
    expect(item).toMatchObject({ state: 'cancelled' });
    expect(item!.inventoryReleasedAt).not.toBeNull();
    const [reservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderItemId, item!.id));
    expect(reservation!.releasedAt).not.toBeNull();
  });

  it('QUALITY: returning an extra payment does not reduce the settled purchase invoice', async () => {
    const f = await fixture();
    const [duplicate] = await db
      .insert(payments)
      .values({
        orderId: f.orderId,
        provider: 'wechatpay',
        channel: 'native',
        merchantId: merchant,
        outTradeNo: `A2${randomUUID().replaceAll('-', '').slice(0, 28)}`,
        externalId: randomUUID(),
        amount: f.payment.amount,
        currency: 'CNY',
        status: 'succeeded',
        succeededAt: new Date(),
      })
      .returning();
    await db.insert(invoiceRequests).values({
      organizationId: org,
      eventId,
      orderId: f.orderId,
      registrationId: null,
      requestNo: `RI${randomUUID()}`,
      buyerType: 'company',
      title: '原成交发票',
      taxId: '911100001234567801',
      email: 'refund@example.test',
      mobile: '+8613900000099',
      content: '会务费',
      amount: f.payment.amount,
      netPaidAmount: f.payment.amount,
      currency: 'CNY',
      status: 'issued',
    });
    const observation: WeChatRefundOutcome = {
      refund_id: `WX${randomUUID()}`,
      out_refund_no: `EXT${randomUUID()}`,
      transaction_id: duplicate!.externalId!,
      out_trade_no: duplicate!.outTradeNo!,
      status: 'SUCCESS',
      channel: 'ORIGINAL',
      user_received_account: '支付用户零钱',
      create_time: new Date().toISOString(),
      success_time: new Date().toISOString(),
      amount: {
        total: duplicate!.amount,
        refund: duplicate!.amount,
        payer_total: duplicate!.amount,
        payer_refund: duplicate!.amount,
        currency: 'CNY',
      },
    };
    await workflow.observe(org, merchant, observation);
    const [invoice] = await db
      .select()
      .from(invoiceRequests)
      .where(eq(invoiceRequests.orderId, f.orderId));
    expect(invoice).toMatchObject({ amount: 3000, netPaidAmount: 3000, status: 'issued' });
    const [originalPayment] = await db.select().from(payments).where(eq(payments.id, f.payment.id));
    expect(originalPayment!.status).toBe('succeeded');
    await expect(
      workflow.executionMode(org, f.orderId, actor, randomUUID(), {
        mode: 'automatic',
        reason: '额外款项已全部原路退回',
      }),
    ).resolves.toMatchObject({ mode: 'automatic' });
    const context = await workflow.customerContext(customer, f.orderId);
    expect(context).toMatchObject({ refundableAmount: 3000, refundedAmount: 0, eligible: true });
    const { execution } = await approve(f);
    await workflow.observe(org, merchant, outcome(f, execution));
    expect(await workflow.customerContext(customer, f.orderId)).toMatchObject({
      refundableAmount: 2000,
      refundedAmount: 1000,
    });
  });

  it('QUALITY: invoice repair does not pause a retained compensation seat', async () => {
    const f = await fixture();
    const context = await workflow.adminItemContext(org, eventId, f.orderId);
    const app = await workflow.createAdminItems(org, eventId, f.orderId, actor, randomUUID(), {
      contextVersion: context.contextVersion,
      reason: '保留权益的明确补偿',
      allocations: [
        { orderItemId: f.itemIds[0]!, version: 1, amount: 100, rightsEffect: 'retain' },
      ],
    });
    const [execution] = await db.select().from(refunds).where(eq(refunds.requestId, app.id));
    await db.insert(invoiceRequests).values({
      organizationId: org,
      eventId,
      orderId: f.orderId,
      registrationId: null,
      requestNo: `RI${randomUUID()}`,
      buyerType: 'company',
      title: '原成交发票',
      taxId: '911100001234567801',
      email: 'refund@example.test',
      mobile: '+8613900000099',
      content: '会务费',
      amount: f.payment.amount,
      netPaidAmount: f.payment.amount,
      currency: 'CNY',
      status: 'issued',
    });
    await db.execute(
      sql`create function reject_quality_invoice() returns trigger language plpgsql as $$ begin raise exception 'injected invoice persistence failure'; end $$`,
    );
    await db.execute(
      sql`create trigger reject_quality_invoice before update on invoice_requests for each row execute function reject_quality_invoice()`,
    );
    try {
      await expect(workflow.observe(org, merchant, outcome(f, execution!))).resolves.toEqual({
        status: 'succeeded',
      });
    } finally {
      await db.execute(sql`drop trigger reject_quality_invoice on invoice_requests`);
      await db.execute(sql`drop function reject_quality_invoice()`);
    }
    await expect(
      db.transaction((tx) =>
        guardRefundWrite(tx, f.orderId, false, {
          purpose: 'admission',
          orderItemId: f.itemIds[0]!,
        }),
      ),
    ).resolves.toMatchObject({ id: f.orderId });
  });

  it('QUALITY: late cash without a settled purchase cannot resume ticket rights', async () => {
    const f = await fixture();
    await db
      .update(orders)
      .set({
        settledPaymentId: null,
        refundExecutionMode: 'external_hold',
        entitlementsOnHold: true,
        refundExecutionReason: '迟到付款需要核验',
        status: 'closed',
      })
      .where(eq(orders.id, f.orderId));
    await expect(
      workflow.executionMode(org, f.orderId, actor, randomUUID(), {
        mode: 'automatic',
        reason: '尝试恢复',
      }),
    ).rejects.toThrow();
  });

  it('QUALITY: a still-unresolved rights repair does not reopen a cash-completed application over a later sibling request', async () => {
    const f = await fixture();
    const { app, execution } = await approve(f);
    const [item] = await itemRows(f.orderId);
    await db
      .update(tickets)
      .set({ status: 'used' })
      .where(eq(tickets.registrationId, item!.registrationId));
    await workflow.observe(org, merchant, outcome(f, execution));
    const other = await apply(f, [f.itemIds[1]!]);
    await expect(workflow.repairFulfillment(org, execution.id)).resolves.toEqual({
      repaired: false,
    });
    const [previous] = await db.select().from(refundRequests).where(eq(refundRequests.id, app.id));
    expect(previous!.terminatedAt).not.toBeNull();
    const [current] = await db.select().from(refundRequests).where(eq(refundRequests.id, other.id));
    expect(current!.terminatedAt).toBeNull();
  });
});
