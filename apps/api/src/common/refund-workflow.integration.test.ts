import { Client } from 'pg';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkinLists,
  checkinRecords,
  customerUsers,
  events,
  invoiceRequests,
  orders,
  organizations,
  organizationIntegrations,
  refundNotificationInbox,
  outboxEvents,
  payments,
  refundMerchantSchedules,
  refundRequests,
  refunds,
  registrations,
  tickets,
  ticketTypes,
  users,
} from '@conference/database';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { ConferenceRepository } from './conference.repository.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { RefundWorkflowService } from './refund-workflow.service.js';
import { WeChatRefundService } from './wechat-refund.service.js';
import { RefundGatewayError, type WeChatRefundOutcome } from './refund-policy.js';
import { guardRefundWrite } from './refund-write-guard.js';
import { encryptIntegrationCredentials } from './integration-credentials.js';

const persistent = process.env.DATABASE_URL ? describe : describe.skip;
persistent('customer refund workflow with real PostgreSQL', () => {
  // The scheduler scans every tenant; keep other suites' fixtures outside its run.
  const fixtureLock = new Client({ connectionString: process.env.DATABASE_URL });
  const database = new DatabaseService();
  const db = database.db!;
  const gateway = new WeChatPayService(database);
  const workflow = new RefundWorkflowService(database, gateway);
  const scheduler = new WeChatRefundService(database, gateway, workflow);
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const customerUserId = randomUUID();
  const customer = { organizationId, customerUserId };
  const merchantId = `test-${randomUUID().slice(0, 16)}`;
  const policy = { enabled: true, version: 'seven-day-v1', windowDays: 7 as const };
  let eventId: number;
  let sequence = 0;
  const submit = vi.spyOn(gateway, 'submitRefund');
  const query = vi.spyOn(gateway, 'queryRefund');

  beforeAll(async () => {
    await fixtureLock.connect();
    await fixtureLock.query(
      "select pg_advisory_lock(hashtextextended('tokems:refund-integration-fixtures', 0))",
    );
    await db
      .insert(organizations)
      .values({ id: organizationId, slug: `refund-${organizationId}`, name: '退款测试组织' });
    await db
      .insert(users)
      .values({ id: actorId, email: `${actorId}@example.test`, name: '退款审核测试员' });
    await db
      .insert(customerUsers)
      .values({ id: customerUserId, organizationId, mobileE164: '+8613900000099' });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `refund-${organizationId}`,
        name: '退款验收',
        shortName: '验收',
        tagline: '验收',
        description: '验收',
        status: 'registration_open',
        startsAt: new Date('2027-11-01T01:00:00Z'),
        endsAt: new Date('2027-11-01T10:00:00Z'),
        timezone: 'Asia/Shanghai',
        venue: '测试',
        city: '深圳',
        address: '测试',
        settings: { refunds: policy },
      })
      .returning();
    eventId = event!.id;
    vi.spyOn(gateway, 'refundConfiguration').mockResolvedValue({
      merchantId,
      funding: 'default',
      notifyUrl: 'https://example.test/refund',
    });
    vi.spyOn(gateway, 'refundMerchantId').mockResolvedValue(merchantId);
    vi.spyOn(gateway, 'verifyRefundPayment').mockImplementation(async (_org, id) => {
      const [payment] = await db.select().from(payments).where(eq(payments.id, id));
      if (!payment?.succeededAt) throw new Error('missing trusted payment time');
      return { merchantId, paidAt: payment.succeededAt };
    });
  }, 60_000);
  beforeEach(async () => {
    submit.mockReset();
    query.mockReset();
    await db
      .update(events)
      .set({ settings: { refunds: policy } })
      .where(eq(events.id, eventId));
    // Other cases keep their evidence but cannot be scheduled by this case.
    await db
      .update(refunds)
      .set({ nextAttemptAt: null })
      .where(eq(refunds.organizationId, organizationId));
    await db
      .update(refundMerchantSchedules)
      .set({ nextSubmitAt: new Date(0) })
      .where(eq(refundMerchantSchedules.merchantId, merchantId));
  });
  afterAll(async () => {
    try {
      scheduler.onModuleDestroy();
      await db.update(tickets).set({ refundPausedBy: null }).where(eq(tickets.eventId, eventId));
      await db.delete(refunds).where(eq(refunds.organizationId, organizationId));
      await db.delete(refundRequests).where(eq(refundRequests.organizationId, organizationId));
      await db
        .delete(refundMerchantSchedules)
        .where(eq(refundMerchantSchedules.merchantId, merchantId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
      await db.delete(users).where(eq(users.id, actorId));
    } finally {
      await fixtureLock.end();
      await database.onModuleDestroy();
    }
  });

  async function fixture(paidAt: Date | null = new Date()) {
    sequence += 1;
    const registrationId = randomUUID(),
      orderId = randomUUID(),
      ticketTypeId = randomUUID();
    await db.insert(ticketTypes).values({
      id: ticketTypeId,
      organizationId,
      eventId,
      code: `R${sequence}`,
      name: '退款票',
      description: '测试退款票',
      price: 39900,
      capacity: 10,
      sold: 1,
    });
    await db.insert(registrations).values({
      id: registrationId,
      organizationId,
      eventId,
      ticketTypeId,
      registrationCode: `R${randomUUID().slice(0, 24)}`,
      status: 'confirmed',
      attendee: {
        name: '退款验收',
        mobile: `1390000${String(sequence).padStart(4, '0')}`,
        email: `${sequence}@example.test`,
        company: '测试',
        title: '测试',
        city: '深圳',
      },
      attendeeMobileE164: `+861390000${String(sequence).padStart(4, '0')}`,
    });
    await db.insert(orders).values({
      id: orderId,
      organizationId,
      eventId,
      registrationId,
      purchaserCustomerUserId: customerUserId,
      orderNo: `T${randomUUID().replaceAll('-', '').slice(0, 25)}`,
      status: 'paid',
      amount: 39900,
      currency: 'CNY',
      pricingSnapshot: { refundPolicy: policy },
      expiresAt: new Date(),
    });
    const [payment] = await db
      .insert(payments)
      .values({
        orderId,
        provider: 'wechatpay',
        channel: 'native',
        merchantId,
        status: 'succeeded',
        succeededAt: paidAt,
        amount: 39900,
        currency: 'CNY',
        outTradeNo: `T${randomUUID().replaceAll('-', '').slice(0, 25)}`,
        externalId: randomUUID(),
      })
      .returning();
    const [ticket] = await db
      .insert(tickets)
      .values({ eventId, registrationId, ticketTypeId, code: `R${randomUUID()}`, status: 'valid' })
      .returning();
    return { orderId, registrationId, ticketTypeId, payment: payment!, ticket: ticket! };
  }
  const apply = (id: string, key = randomUUID()) =>
    workflow.createCustomer(customer, id, key, {
      amount: 39900,
      policyVersion: policy.version,
      reason: '',
    });
  async function approved(f: Awaited<ReturnType<typeof fixture>>) {
    const application = await apply(f.orderId);
    const reviewed = await workflow.review(
      organizationId,
      eventId,
      application.id,
      actorId,
      randomUUID(),
      { version: application.version },
      'approve',
    );
    const [execution] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.requestId, application.id));
    return { application: reviewed, execution: execution! };
  }
  function outcome(
    f: Awaited<ReturnType<typeof fixture>>,
    execution: typeof refunds.$inferSelect,
    status: WeChatRefundOutcome['status'] = 'SUCCESS',
  ): WeChatRefundOutcome {
    return {
      refund_id: `WX${execution.id}`,
      out_refund_no: execution.outRefundNo!,
      transaction_id: f.payment.externalId!,
      out_trade_no: f.payment.outTradeNo!,
      status,
      channel: 'ORIGINAL',
      user_received_account: '支付用户零钱',
      create_time: new Date().toISOString(),
      ...(status === 'SUCCESS' ? { success_time: new Date().toISOString() } : {}),
      amount: {
        total: 39900,
        refund: execution.amount,
        payer_total: 39900,
        payer_refund: execution.amount,
        currency: 'CNY',
      },
    };
  }
  async function due(id: string) {
    await db
      .update(refunds)
      .set({
        nextAttemptAt: new Date(0),
        lastSubmittedAt: new Date(Date.now() - 120000),
        leaseUntil: null,
      })
      .where(eq(refunds.id, id));
    await db
      .update(refundMerchantSchedules)
      .set({ nextSubmitAt: new Date(0) })
      .where(eq(refundMerchantSchedules.merchantId, merchantId));
  }

  it('preserves original merchant credentials for external executions and pending notifications without applications', async () => {
    const f = await fixture();
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const apiV3Key = randomBytes(16).toString('hex');
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY_VERSION', '1');
    const config = {
      enabled: false,
      appId: 'wx-refund-test',
      mchId: merchantId,
      merchantCertificateSerial: 'TEST',
      platformPublicKeyId: 'PUB_KEY_ID_TEST',
      oauthEnabled: false,
      channels: { native: true, jsapi: false, h5: false },
    };
    await db.insert(organizationIntegrations).values({
      organizationId,
      provider: 'wechatpay',
      status: 'verified',
      config,
      encryptedCredentials: encryptIntegrationCredentials(organizationId, 'wechatpay', {
        merchantPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        platformPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        apiV3Key,
      }),
    });
    const external: WeChatRefundOutcome = {
      refund_id: randomUUID(),
      out_refund_no: `EXT${randomUUID()}`,
      transaction_id: f.payment.externalId!,
      out_trade_no: f.payment.outTradeNo!,
      status: 'PROCESSING',
      channel: 'ORIGINAL',
      user_received_account: '支付用户零钱',
      create_time: new Date().toISOString(),
      amount: { total: 39900, refund: 9900, currency: 'CNY' },
    };
    try {
      await workflow.observe(organizationId, merchantId, external);
      const executions = await db.select().from(refunds).where(eq(refunds.orderId, f.orderId));
      expect(executions[0]).toMatchObject({ requestId: null, status: 'processing' });
      expect(
        await db
          .select()
          .from(refundRequests)
          .where(eq(refundRequests.organizationId, organizationId)),
      ).toEqual([]);
      await expect(
        gateway.updateConfiguration(organizationId, actorId, {
          ...config,
          mchId: 'different-merchant',
        }),
      ).rejects.toThrow('存在未结清退款');
      await expect(
        gateway.updateConfiguration(organizationId, actorId, {
          ...config,
          apiV3Key: randomBytes(16).toString('hex'),
        }),
      ).rejects.toThrow('存在未结清退款');
      await db.delete(refunds).where(eq(refunds.orderId, f.orderId));
      await db.insert(refundNotificationInbox).values({
        organizationId,
        merchantId,
        notificationId: randomUUID(),
        outRefundNo: external.out_refund_no,
        status: 'received',
        payload: {},
      });
      await expect(
        gateway.updateConfiguration(organizationId, actorId, {
          ...config,
          mchId: 'different-merchant',
        }),
      ).rejects.toThrow('存在未结清退款');
    } finally {
      await db
        .delete(refundNotificationInbox)
        .where(eq(refundNotificationInbox.organizationId, organizationId));
      await db
        .delete(organizationIntegrations)
        .where(eq(organizationIntegrations.organizationId, organizationId));
      vi.unstubAllEnvs();
    }
  });

  it('completes once, cancels the ticket and releases one seat', async () => {
    const f = await fixture();
    const { application, execution } = await approved(f);
    const [paused] = await db.select().from(tickets).where(eq(tickets.id, f.ticket.id));
    expect(paused?.refundPausedBy).toBe(application.id);
    submit.mockResolvedValue(outcome(f, execution));
    await scheduler.tick();
    await Promise.all([
      workflow.observe(organizationId, merchantId, outcome(f, execution)),
      workflow.observe(organizationId, merchantId, outcome(f, execution)),
    ]);
    expect(submit.mock.calls.map(([org, merchant]) => ({ org, merchant }))).toEqual([
      { org: organizationId, merchant: merchantId },
    ]);
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, f.ticket.id));
    const [stock] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, f.ticketTypeId));
    const context = await workflow.customerContext(customer, f.orderId);
    expect(order?.status).toBe('refunded');
    expect(ticket?.status).toBe('cancelled');
    expect(stock?.sold).toBe(0);
    expect(context.applications[0]).toMatchObject({
      completedAmount: 39900,
      fulfillmentStatus: 'completed',
    });
    const notices = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventType, 'RefundSucceeded'),
          eq(outboxEvents.correlationId, `refund:${execution.id}`),
        ),
      );
    expect(notices).toHaveLength(1);
  });

  it('reserves once across duplicate and concurrent customer requests', async () => {
    const f = await fixture(),
      key = randomUUID();
    const [a, b] = await Promise.all([apply(f.orderId, key), apply(f.orderId, key)]);
    expect(a.id).toBe(b.id);
    await expect(apply(f.orderId)).rejects.toThrow('已有');
    await expect(
      workflow.createCustomer(customer, f.orderId, key, {
        amount: 39900,
        policyVersion: policy.version,
        reason: '不同内容',
      }),
    ).rejects.toThrow('幂等');
    expect((await workflow.customerContext(customer, f.orderId)).refundableAmount).toBe(0);
  });

  it('protects purchaser and tenant scope', async () => {
    const f = await fixture();
    await expect(
      workflow.customerContext({ ...customer, customerUserId: randomUUID() }, f.orderId),
    ).rejects.toThrow('无权');
    await expect(
      workflow.customerContext({ ...customer, organizationId: randomUUID() }, f.orderId),
    ).rejects.toThrow('无权');
    const a = await apply(f.orderId);
    await expect(
      workflow.review(
        organizationId,
        eventId + 1,
        a.id,
        actorId,
        randomUUID(),
        { version: 1 },
        'reject',
      ),
    ).rejects.toThrow('无权');
  });

  it('uses trusted seven-day eligibility and rejects missing payment time', async () => {
    const old = await fixture(new Date(Date.now() - 7 * 86400000 - 1000));
    const fresh = await fixture(new Date(Date.now() - 7 * 86400000 + 60000));
    const missing = await fixture(null);
    expect((await workflow.customerContext(customer, old.orderId)).eligible).toBe(false);
    expect((await workflow.customerContext(customer, fresh.orderId)).eligible).toBe(true);
    expect((await workflow.customerContext(customer, missing.orderId)).eligible).toBe(false);
    await expect(apply(old.orderId)).rejects.toThrow('7 天');
  });

  it('keeps a timely application eligible after the review crosses seven days', async () => {
    const f = await fixture();
    const a = await apply(f.orderId);
    await db
      .update(payments)
      .set({ succeededAt: new Date(Date.now() - 8 * 86400000) })
      .where(eq(payments.id, f.payment.id));
    await expect(
      workflow.review(
        organizationId,
        eventId,
        a.id,
        actorId,
        randomUUID(),
        { version: a.version },
        'approve',
      ),
    ).resolves.toMatchObject({ reviewStatus: 'approved' });
  });

  it('serializes approval against withdrawal and preserves one result', async () => {
    const f = await fixture();
    const a = await apply(f.orderId);
    const results = await Promise.allSettled([
      workflow.review(
        organizationId,
        eventId,
        a.id,
        actorId,
        randomUUID(),
        { version: a.version },
        'approve',
      ),
      workflow.withdraw(customer, a.id, randomUUID(), a.version),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const [current] = await db.select().from(refundRequests).where(eq(refundRequests.id, a.id));
    const executions = await db.select().from(refunds).where(eq(refunds.requestId, a.id));
    expect(executions.length).toBe(current?.reviewStatus === 'approved' ? 1 : 0);
  });

  it('rejects approval after a ticket is checked in', async () => {
    const f = await fixture();
    const a = await apply(f.orderId);
    await db.update(tickets).set({ status: 'used' }).where(eq(tickets.id, f.ticket.id));
    await expect(
      workflow.review(
        organizationId,
        eventId,
        a.id,
        actorId,
        randomUUID(),
        { version: a.version },
        'approve',
      ),
    ).rejects.toThrow('已使用');
  });

  it('waits five minutes on insufficient funds then retries the immutable refund', async () => {
    const f = await fixture();
    const { execution } = await approved(f);
    submit.mockRejectedValueOnce(new RefundGatewayError('NOT_ENOUGH', true));
    await scheduler.tick();
    const [waiting] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
    expect(waiting?.status).toBe('waiting_funds');
    expect(waiting!.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(290000);
    await due(execution.id);
    submit.mockResolvedValueOnce(outcome(f, execution));
    await scheduler.tick();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]![2]).toEqual(submit.mock.calls[1]![2]);
    expect((await workflow.customerContext(customer, f.orderId)).refundedAmount).toBe(39900);
  });

  it('queries after timeout and does not resubmit an accepted refund', async () => {
    const f = await fixture();
    const { execution } = await approved(f);
    submit.mockRejectedValueOnce(new RefundGatewayError('NETWORK_ERROR', false));
    await scheduler.tick();
    const [unknown] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
    expect(unknown?.status).toBe('query_pending');
    await due(execution.id);
    query.mockResolvedValue(outcome(f, execution));
    await scheduler.tick();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('recovers an expired submission lease by querying', async () => {
    const f = await fixture();
    const { execution } = await approved(f);
    await db
      .update(refunds)
      .set({
        status: 'submitting',
        leaseUntil: new Date(0),
        nextAttemptAt: new Date(0),
        lastSubmittedAt: new Date(),
      })
      .where(eq(refunds.id, execution.id));
    query.mockResolvedValue(outcome(f, execution));
    await scheduler.tick();
    expect(submit).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['merchant', 'amount', 'transaction'] as const)(
    'quarantines %s mismatches without settling the customer obligation',
    async (kind) => {
      const f = await fixture();
      const { execution } = await approved(f);
      const result = outcome(f, execution);
      if (kind === 'merchant') {
        result.channel = 'OTHER_BANKCARD';
        result.user_received_account = '商户结算银行账户';
      }
      if (kind === 'amount') result.amount.refund = 1;
      if (kind === 'transaction') result.transaction_id = randomUUID();
      expect(await workflow.observe(organizationId, merchantId, result)).toMatchObject({
        status: 'abnormal',
      });
      const context = await workflow.customerContext(customer, f.orderId);
      expect(context.refundedAmount).toBe(0);
      expect(context.applications[0]?.completedAmount).toBe(0);
      const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
      expect(order?.refundExecutionMode).toBe('external_hold');
    },
  );

  it('requires an explicitly closed original before a new execution', async () => {
    const f = await fixture();
    const { application, execution } = await approved(f);
    query.mockResolvedValue(outcome(f, execution, 'PROCESSING'));
    await expect(
      workflow.schedule(
        organizationId,
        eventId,
        application.id,
        actorId,
        randomUUID(),
        application.version,
        'continue',
      ),
    ).rejects.toThrow('尚未明确关闭');
    query.mockResolvedValue(outcome(f, execution, 'CLOSED'));
    await workflow.schedule(
      organizationId,
      eventId,
      application.id,
      actorId,
      randomUUID(),
      application.version,
      'continue',
    );
    const all = await db.select().from(refunds).where(eq(refunds.requestId, application.id));
    expect(all).toHaveLength(2);
    expect(all.filter((row) => row.currentAttempt)).toHaveLength(1);
    expect(all.find((row) => row.currentAttempt)?.outRefundNo).not.toBe(execution.outRefundNo);
  });

  it('keeps in-flight uncertainty on external hold and refuses unsafe resume', async () => {
    const f = await fixture();
    const { execution } = await approved(f);
    await db
      .update(refunds)
      .set({ status: 'query_pending', lastSubmittedAt: new Date() })
      .where(eq(refunds.id, execution.id));
    const result = await workflow.executionMode(organizationId, f.orderId, actorId, randomUUID(), {
      mode: 'external_hold',
      reason: '财务核验',
    });
    expect(result.externalReady).toBe(false);
    await expect(
      workflow.executionMode(organizationId, f.orderId, actorId, randomUUID(), {
        mode: 'automatic',
        reason: '尝试恢复',
      }),
    ).rejects.toThrow('未核实');
  });

  it('continues approved refunds when the customer feature is disabled', async () => {
    const f = await fixture();
    const { execution } = await approved(f);
    await db
      .update(events)
      .set({ settings: { refunds: { ...policy, enabled: false } } })
      .where(eq(events.id, eventId));
    submit.mockResolvedValue(outcome(f, execution));
    await scheduler.tick();
    expect((await workflow.customerContext(customer, f.orderId)).refundedAmount).toBe(39900);
  });

  it('blocks the original submission when the 365-day channel limit has elapsed', async () => {
    const f = await fixture();
    const { execution } = await approved(f);
    await db
      .update(payments)
      .set({ succeededAt: new Date(Date.now() - 366 * 86400000) })
      .where(eq(payments.id, f.payment.id));
    await scheduler.tick();
    expect(submit).not.toHaveBeenCalled();
    const [row] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
    expect(row?.lastErrorCode).toBe('REFUND_EXPIRED');
  });

  it('blocks invoice/attendee writes while an approved refund is unresolved', async () => {
    const f = await fixture();
    await approved(f);
    await expect(db.transaction((tx) => guardRefundWrite(tx, f.orderId))).rejects.toThrow(
      '正在退款',
    );
  });

  it('keeps verified money when a fulfillment savepoint fails, then repairs without another refund', async () => {
    const f = await fixture();
    const { execution } = await approved(f);
    // A real database trigger faults only this ticket update, after provider success.
    await db.execute(
      sql.raw(
        `CREATE FUNCTION refund_test_fail_${sequence}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${f.ticket.id}' AND NEW.status = 'cancelled' THEN RAISE EXCEPTION 'injected downstream failure'; END IF; RETURN NEW; END $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER refund_test_${sequence} BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION refund_test_fail_${sequence}()`,
      ),
    );
    try {
      await workflow.observe(organizationId, merchantId, outcome(f, execution));
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER refund_test_${sequence} ON tickets`));
      await db.execute(sql.raw(`DROP FUNCTION refund_test_fail_${sequence}()`));
    }
    const [row] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
    expect(row?.status).toBe('succeeded');
    expect(row?.fulfillmentAttention).toBeTruthy();
    await expect(db.transaction((tx) => guardRefundWrite(tx, f.orderId))).rejects.toThrow(
      '正在退款',
    );
    expect(await workflow.repairFulfillment(organizationId, execution.id)).toMatchObject({
      repaired: true,
    });
    const [stock] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, f.ticketTypeId));
    expect(stock?.sold).toBe(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it('blocks check-in after an external full refund during fulfillment repair', async () => {
    const f = await fixture();
    const repository = new ConferenceRepository(database);
    const checkInListId = `refund-repair-${sequence}`;
    await db
      .insert(checkinLists)
      .values({ eventId, code: checkInListId, name: '退款补偿核销验收' });
    const external: WeChatRefundOutcome = {
      refund_id: `WX${randomUUID()}`,
      out_refund_no: `EXT${randomUUID()}`,
      transaction_id: f.payment.externalId!,
      out_trade_no: f.payment.outTradeNo!,
      status: 'SUCCESS',
      channel: 'ORIGINAL',
      user_received_account: '支付用户零钱',
      create_time: new Date().toISOString(),
      success_time: new Date().toISOString(),
      amount: {
        total: 39900,
        refund: 39900,
        payer_total: 39900,
        payer_refund: 39900,
        currency: 'CNY',
      },
    };
    const faultName = `refund_external_fault_${randomUUID().replaceAll('-', '')}`;
    await db.execute(
      sql.raw(
        `CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${f.ticket.id}' AND NEW.status = 'cancelled' THEN RAISE EXCEPTION 'injected external fulfillment failure'; END IF; RETURN NEW; END $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER ${faultName} BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION ${faultName}()`,
      ),
    );
    try {
      await workflow.observe(organizationId, merchantId, external);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${faultName} ON tickets`));
      await db.execute(sql.raw(`DROP FUNCTION ${faultName}()`));
    }
    const [execution] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.outRefundNo, external.out_refund_no));
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const [ticketBeforeRepair] = await db.select().from(tickets).where(eq(tickets.id, f.ticket.id));
    expect(execution).toMatchObject({ status: 'succeeded', source: 'external', requestId: null });
    expect(execution?.fulfillmentAttention).toBeTruthy();
    expect(order).toMatchObject({ status: 'refunded', refundExecutionMode: 'external_hold' });
    expect(ticketBeforeRepair).toMatchObject({ status: 'valid', refundPausedBy: null });
    expect(
      await repository.checkIn(
        { eventId, ticketCode: f.ticket.code, checkInListId, deviceId: 'refund-repair-device' },
        organizationId,
      ),
    ).toMatchObject({ result: 'invalid' });
    expect(
      await db.select().from(checkinRecords).where(eq(checkinRecords.ticketId, f.ticket.id)),
    ).toHaveLength(0);
    expect(await workflow.repairFulfillment(organizationId, execution!.id)).toMatchObject({
      repaired: true,
    });
    const [repaired] = await db.select().from(refunds).where(eq(refunds.id, execution!.id));
    const [ticketAfterRepair] = await db.select().from(tickets).where(eq(tickets.id, f.ticket.id));
    const [registration] = await db
      .select()
      .from(registrations)
      .where(eq(registrations.id, f.registrationId));
    const [stock] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, f.ticketTypeId));
    expect(repaired).toMatchObject({ status: 'succeeded', fulfillmentAttention: null });
    expect(ticketAfterRepair?.status).toBe('cancelled');
    expect(registration?.status).toBe('cancelled');
    expect(stock?.sold).toBe(0);
    expect((await workflow.customerContext(customer, f.orderId)).refundedAmount).toBe(39900);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'NOT_ENOUGH', externalAmount: 39900 },
    { code: 'PARAM_ERROR', externalAmount: 39900 },
    { code: 'NOT_ENOUGH', externalAmount: 9900 },
    { code: 'PARAM_ERROR', externalAmount: 9900 },
  ])(
    'retires late $code after an external refund settles $externalAmount during submission',
    async ({ code, externalAmount }) => {
      const f = await fixture();
      const { application, execution } = await approved(f);
      let submitted!: () => void;
      let releaseResponse!: () => void;
      const enteredSubmission = new Promise<void>((resolve) => {
        submitted = resolve;
      });
      const responseBarrier = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      submit.mockImplementationOnce(async () => {
        submitted();
        await responseBarrier;
        throw new RefundGatewayError(code, true);
      });
      const running = scheduler.tick();
      try {
        await enteredSubmission;
        const [inFlight] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
        expect(inFlight).toMatchObject({ status: 'submitting', currentAttempt: true });
        expect(inFlight?.leaseUntil).toBeInstanceOf(Date);
        const external = {
          ...outcome(f, execution),
          refund_id: randomUUID(),
          out_refund_no: `EXT${randomUUID()}`,
        };
        external.amount.refund = externalAmount;
        external.amount.payer_refund = externalAmount;
        await workflow.observe(organizationId, merchantId, external);
      } finally {
        releaseResponse();
        await running;
      }
      const complete = externalAmount === 39900;
      const remainingAmount = 39900 - externalAmount;
      const [request] = await db
        .select()
        .from(refundRequests)
        .where(eq(refundRequests.id, application.id));
      expect(request).toMatchObject({
        completedAmount: externalAmount,
        reservedAmount: remainingAmount,
        fulfillmentStatus: complete ? 'completed' : 'manual_required',
      });
      expect(request?.terminatedAt).toEqual(complete ? expect.any(Date) : null);
      const [prior] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
      expect(prior).toMatchObject({
        status: 'superseded',
        currentAttempt: !complete,
        nextAttemptAt: null,
        leaseUntil: null,
      });
      expect(submit).toHaveBeenCalledTimes(1);
      if (complete) {
        expect(request?.attentionReason).toBeNull();
        await scheduler.tick();
        expect(submit).toHaveBeenCalledTimes(1);
        return;
      }
      query.mockRejectedValue(new RefundGatewayError('RESOURCE_NOT_EXISTS', false, 404, true));
      await workflow.schedule(
        organizationId,
        eventId,
        application.id,
        actorId,
        randomUUID(),
        request!.version,
        'continue',
      );
      const [remaining] = await db
        .select()
        .from(refunds)
        .where(and(eq(refunds.requestId, application.id), eq(refunds.currentAttempt, true)));
      expect(remaining).toMatchObject({ amount: remainingAmount, status: 'queued' });
      expect(remaining?.outRefundNo).not.toBe(execution.outRefundNo);
      submit.mockResolvedValueOnce(outcome(f, remaining!));
      await db
        .update(refundMerchantSchedules)
        .set({ nextSubmitAt: new Date(0) })
        .where(eq(refundMerchantSchedules.merchantId, merchantId));
      await scheduler.tick();
      const [settled] = await db
        .select()
        .from(refundRequests)
        .where(eq(refundRequests.id, application.id));
      expect(settled).toMatchObject({
        completedAmount: 39900,
        reservedAmount: 0,
        fulfillmentStatus: 'completed',
      });
      expect(submit).toHaveBeenCalledTimes(2);
      expect((await workflow.customerContext(customer, f.orderId)).refundedAmount).toBe(39900);
    },
  );

  it('enforces payment-order scope in the database', async () => {
    const f = await fixture();
    const other = await fixture();
    const a = await apply(f.orderId);
    await expect(
      db
        .update(refundRequests)
        .set({ paymentId: other.payment.id })
        .where(eq(refundRequests.id, a.id)),
    ).rejects.toThrow();
  });
  it('keeps completed applications stable when an older closed execution is observed again', async () => {
    const f = await fixture();
    const { application, execution } = await approved(f);
    query.mockResolvedValue(outcome(f, execution, 'CLOSED'));
    const key = randomUUID();
    await workflow.schedule(
      organizationId,
      eventId,
      application.id,
      actorId,
      key,
      application.version,
      'continue',
    );
    await workflow.schedule(
      organizationId,
      eventId,
      application.id,
      actorId,
      key,
      application.version,
      'continue',
    );
    expect(query).toHaveBeenCalledTimes(1);
    const [current] = await db
      .select()
      .from(refunds)
      .where(and(eq(refunds.requestId, application.id), eq(refunds.currentAttempt, true)));
    await workflow.observe(organizationId, merchantId, outcome(f, current!));
    await workflow.observe(organizationId, merchantId, outcome(f, execution, 'CLOSED'));
    expect(
      (await workflow.customerContext(customer, f.orderId)).applications[0]?.fulfillmentStatus,
    ).toBe('completed');
  });

  it('does not let paused submissions starve another due refund', async () => {
    for (let i = 0; i < 20; i++) {
      const f = await fixture();
      const { execution } = await approved(f);
      await db
        .update(refunds)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(refunds.id, execution.id));
      await workflow.executionMode(organizationId, f.orderId, actorId, randomUUID(), {
        mode: 'external_hold',
        reason: '测试财务暂停',
      });
    }
    const f = await fixture();
    const { execution } = await approved(f);
    submit.mockResolvedValue(outcome(f, execution));
    await scheduler.tick();
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await workflow.customerContext(customer, f.orderId)).refundedAmount).toBe(39900);
  });

  it('adjusts issued invoice net amounts on partial refunds and keeps the ticket valid', async () => {
    const f = await fixture();
    await db.insert(invoiceRequests).values({
      organizationId,
      eventId,
      orderId: f.orderId,
      registrationId: f.registrationId,
      requestNo: `RI${randomUUID()}`,
      buyerType: 'company',
      title: '退款测试公司',
      taxId: '911100001234567801',
      email: 'refund@example.test',
      mobile: '+8613900000099',
      content: '会务费',
      amount: 39900,
      netPaidAmount: 39900,
      currency: 'CNY',
      status: 'issued',
    });
    await workflow.createAdmin(organizationId, f.orderId, actorId, randomUUID(), {
      amount: 9900,
      reason: '协商部分退款',
    });
    const [execution] = await db.select().from(refunds).where(eq(refunds.orderId, f.orderId));
    await workflow.observe(organizationId, merchantId, outcome(f, execution!));
    const [invoice] = await db
      .select()
      .from(invoiceRequests)
      .where(eq(invoiceRequests.orderId, f.orderId));
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, f.ticket.id));
    expect(invoice).toMatchObject({ netPaidAmount: 30000, status: 'adjustment_required' });
    expect(ticket?.status).toBe('valid');
  });

  it('discovers a verified external refund, freezes the order and avoids an extra submission', async () => {
    const f = await fixture();
    const { application, execution } = await approved(f);
    const external = {
      ...outcome(f, execution),
      refund_id: randomUUID(),
      out_refund_no: `EXT${randomUUID()}`,
    };
    external.amount.refund = 9900;
    external.amount.payer_refund = 9900;
    await workflow.observe(organizationId, merchantId, external);
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    expect(order?.refundExecutionMode).toBe('external_hold');
    const [request] = await db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, application.id));
    expect(request).toMatchObject({ amount: 39900, completedAmount: 9900, reservedAmount: 30000 });
    await expect(
      workflow.executionMode(organizationId, f.orderId, actorId, randomUUID(), {
        mode: 'automatic',
        reason: '继续退款',
      }),
    ).rejects.toThrow('金额');
    await scheduler.tick();
    expect(submit).not.toHaveBeenCalled();
  });

  it('blocks automatic resume when an external partial refund changes the approved remainder', async () => {
    const f = await fixture();
    const created = await workflow.createAdmin(organizationId, f.orderId, actorId, randomUUID(), {
      amount: 10000,
      reason: '协商部分退款',
    });
    const [execution] = await db.select().from(refunds).where(eq(refunds.id, created.id));
    await workflow.executionMode(organizationId, f.orderId, actorId, randomUUID(), {
      mode: 'external_hold',
      reason: '财务通过商户平台处理部分退款',
    });
    const external = {
      ...outcome(f, execution!),
      refund_id: randomUUID(),
      out_refund_no: `EXT${randomUUID()}`,
    };
    external.amount.refund = 5000;
    external.amount.payer_refund = 5000;
    await workflow.observe(organizationId, merchantId, external);

    const [request] = await db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, execution!.requestId!));
    expect(request).toMatchObject({ amount: 10000, completedAmount: 5000, reservedAmount: 5000 });
    expect((await workflow.customerContext(customer, f.orderId)).refundedAmount).toBe(5000);
    await expect(
      workflow.executionMode(organizationId, f.orderId, actorId, randomUUID(), {
        mode: 'automatic',
        reason: '继续处理剩余退款',
      }),
    ).rejects.toThrow('金额');
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    expect(order?.refundExecutionMode).toBe('external_hold');
    await scheduler.tick();
    expect(submit).not.toHaveBeenCalled();
    const [superseded] = await db.select().from(refunds).where(eq(refunds.id, execution!.id));
    expect(superseded).toMatchObject({
      status: 'superseded',
      currentAttempt: true,
      nextAttemptAt: null,
    });
    query.mockRejectedValue(new RefundGatewayError('RESOURCE_NOT_EXISTS', false, 404));
    await expect(
      workflow.schedule(
        organizationId,
        eventId,
        request!.id,
        actorId,
        randomUUID(),
        request!.version,
        'continue',
      ),
    ).rejects.toThrow();
    expect(await db.select().from(refunds).where(eq(refunds.requestId, request!.id))).toHaveLength(
      2,
    );
    query.mockRejectedValue(new RefundGatewayError('RESOURCE_NOT_EXISTS', false, 404, true));
    await workflow.schedule(
      organizationId,
      eventId,
      request!.id,
      actorId,
      randomUUID(),
      request!.version,
      'continue',
    );
    const [remaining] = await db
      .select()
      .from(refunds)
      .where(and(eq(refunds.requestId, request!.id), eq(refunds.currentAttempt, true)));
    expect(remaining).toMatchObject({ amount: 5000, status: 'queued' });
    expect(remaining!.outRefundNo).not.toBe(execution!.outRefundNo);
    submit.mockResolvedValue(outcome(f, remaining!));
    await scheduler.tick();
    const [complete] = await db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, request!.id));
    expect(complete).toMatchObject({
      completedAmount: 10000,
      reservedAmount: 0,
      fulfillmentStatus: 'completed',
    });
  });

  it('retires an unsubmitted execution when external cash settles the whole approved obligation', async () => {
    const f = await fixture();
    const { application, execution } = await approved(f);
    const external = {
      ...outcome(f, execution),
      refund_id: randomUUID(),
      out_refund_no: `EXT${randomUUID()}`,
    };
    await workflow.observe(organizationId, merchantId, external);
    const [prior] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
    expect(prior).toMatchObject({
      status: 'superseded',
      currentAttempt: false,
      nextAttemptAt: null,
    });
    const [complete] = await db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, application.id));
    expect(complete).toMatchObject({ fulfillmentStatus: 'completed', reservedAmount: 0 });
    await scheduler.tick();
    expect(submit).not.toHaveBeenCalled();
  });

  it('retires a rejected obsolete execution only after a signed query confirms it is absent', async () => {
    const f = await fixture();
    await workflow.createAdmin(organizationId, f.orderId, actorId, randomUUID(), {
      amount: 10000,
      reason: '部分退款',
    });
    const [execution] = await db.select().from(refunds).where(eq(refunds.orderId, f.orderId));
    submit.mockRejectedValue(new RefundGatewayError('NOT_ENOUGH', true));
    await scheduler.tick();
    const external = {
      ...outcome(f, execution!),
      refund_id: randomUUID(),
      out_refund_no: `EXT${randomUUID()}`,
    };
    external.amount.refund = 5000;
    external.amount.payer_refund = 5000;
    await workflow.observe(organizationId, merchantId, external);
    query.mockRejectedValue(new RefundGatewayError('RESOURCE_NOT_EXISTS', false, 404));
    await scheduler.tick();
    const [unverified] = await db.select().from(refunds).where(eq(refunds.id, execution!.id));
    expect(unverified).toMatchObject({ status: 'query_pending', currentAttempt: true });
    expect(unverified?.nextAttemptAt).toBeInstanceOf(Date);
    await db
      .update(refunds)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(refunds.id, execution!.id));
    query.mockRejectedValue(new RefundGatewayError('RESOURCE_NOT_EXISTS', false, 404, true));
    await scheduler.tick();
    const [prior] = await db.select().from(refunds).where(eq(refunds.id, execution!.id));
    expect(prior).toMatchObject({
      status: 'superseded',
      currentAttempt: true,
      nextAttemptAt: null,
      lastErrorCode: 'RESOURCE_NOT_EXISTS',
    });
    const [application] = await db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, execution!.requestId!));
    await workflow.schedule(
      organizationId,
      eventId,
      application!.id,
      actorId,
      randomUUID(),
      application!.version,
      'continue',
    );
    const [remaining] = await db
      .select()
      .from(refunds)
      .where(and(eq(refunds.requestId, application!.id), eq(refunds.currentAttempt, true)));
    expect(remaining).toMatchObject({ amount: 5000, status: 'queued' });
  });

  it('persists verified cash and promotion amounts without treating missing historical amounts as zero', async () => {
    const f = await fixture();
    const { execution, application } = await approved(f);
    const result = outcome(f, execution);
    result.amount.payer_total = 35000;
    result.amount.payer_refund = 35000;
    result.amount.discount_refund = 4900;
    await workflow.observe(organizationId, merchantId, result);
    const [stored] = await db.select().from(refunds).where(eq(refunds.id, execution.id));
    expect(stored).toMatchObject({ payerTotal: 35000, payerRefund: 35000, discountRefund: 4900 });
    const context = await workflow.customerContext(customer, f.orderId);
    expect(context).toMatchObject({
      payerTotal: 35000,
      applications: [
        expect.objectContaining({ id: application.id, payerRefund: 35000, discountRefund: 4900 }),
      ],
    });
    await db.update(refunds).set({ discountRefund: null }).where(eq(refunds.id, execution.id));
    expect(
      (await workflow.customerContext(customer, f.orderId)).applications[0]!.discountRefund,
    ).toBeNull();
  });

  it('preserves paid fulfillment when an external refund returns a duplicate successful payment', async () => {
    const f = await fixture();
    const [duplicate] = await db
      .insert(payments)
      .values({
        orderId: f.orderId,
        provider: 'wechatpay',
        channel: 'native',
        merchantId,
        status: 'succeeded',
        succeededAt: new Date(),
        amount: 39900,
        currency: 'CNY',
        outTradeNo: `T${randomUUID().replaceAll('-', '').slice(0, 25)}`,
        externalId: randomUUID(),
      })
      .returning();
    await db.insert(invoiceRequests).values({
      organizationId,
      eventId,
      orderId: f.orderId,
      registrationId: f.registrationId,
      requestNo: `RI${randomUUID()}`,
      buyerType: 'company',
      title: '重复支付退款验收',
      taxId: '911100001234567801',
      email: 'refund@example.test',
      mobile: '+8613900000099',
      content: '会务费',
      amount: 39900,
      netPaidAmount: 39900,
      currency: 'CNY',
      status: 'issued',
    });
    const external: WeChatRefundOutcome = {
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
        total: 39900,
        refund: 39900,
        payer_total: 39900,
        payer_refund: 39900,
        currency: 'CNY',
      },
    };
    await workflow.observe(organizationId, merchantId, external);

    const [execution] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.outRefundNo, external.out_refund_no));
    const [originalPayment] = await db.select().from(payments).where(eq(payments.id, f.payment.id));
    const [duplicatePayment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, duplicate!.id));
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, f.ticket.id));
    const [registration] = await db
      .select()
      .from(registrations)
      .where(eq(registrations.id, f.registrationId));
    const [stock] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, f.ticketTypeId));
    const [invoice] = await db
      .select()
      .from(invoiceRequests)
      .where(eq(invoiceRequests.orderId, f.orderId));
    expect(execution?.status).toBe('succeeded');
    expect(duplicatePayment?.status).toBe('refunded');
    expect(originalPayment?.status).toBe('succeeded');
    expect(order).toMatchObject({ status: 'paid', refundExecutionMode: 'external_hold' });
    expect(execution?.fulfillmentAttention).toBeTruthy();
    expect(ticket?.status).toBe('valid');
    expect(registration?.status).toBe('confirmed');
    expect(stock?.sold).toBe(1);
    expect(invoice).toMatchObject({ status: 'issued', amount: 39900, netPaidAmount: 39900 });
    expect(submit).not.toHaveBeenCalled();
  });
});
