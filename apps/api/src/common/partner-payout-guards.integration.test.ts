import { randomUUID } from 'node:crypto';
import { setTimeout as pollDelay } from 'node:timers/promises';
import { API_ERROR_CODES, PartnerTransferConfigurationSchema } from '@conference/contracts';
import {
  createDatabase,
  auditLogs,
  customerUsers,
  eventPartnerProgramVersions,
  eventPartners,
  events,
  organizations,
  partnerCommissionInquiries,
  partnerLedgerEntries,
  partnerPayoutBatches,
  partnerPayoutExecutions,
  partnerPayoutRecipients,
  partnerPayoutRequests,
  users,
} from '@conference/database';
import { sealSecret } from '@conference/security';
import { eq, sum } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import type { DatabaseService } from './database.service.js';
import { MerchantTransferService } from './merchant-transfer.service.js';
import { PartnerDistributionService } from './partner-distribution.service.js';
import type { RedisService } from './redis.service.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;

function observe<T>(operation: Promise<T>) {
  const observation = { settled: false };
  const result = operation.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
  return {
    observation,
    result: result.then((value) => {
      observation.settled = true;
      return value;
    }),
  };
}

persistent('partner payout guards with real PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;
  const operationConnections: Array<ReturnType<typeof createDatabase>> = [];

  beforeAll(() => {
    connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await Promise.all(operationConnections.map((item) => item.pool.end()));
    await connection.pool.end();
  });

  function serviceFor(db = connection.db) {
    return new PartnerDistributionService({ db } as DatabaseService, {} as RedisService);
  }

  function namedService(name: string) {
    const url = new URL(process.env.PARTNER_TEST_DATABASE_URL!);
    url.searchParams.set('application_name', name);
    const dedicated = createDatabase(url.toString());
    operationConnections.push(dedicated);
    return serviceFor(dedicated.db);
  }

  async function lockWait(name: string, blockerPid?: number) {
    const result = await connection.pool.query<{ query: string }>(
      `select query from pg_stat_activity
       where datname = current_database() and application_name = $1
         and wait_event_type = 'Lock'
         and ($2::integer is null or $2::integer = any(pg_blocking_pids(pid)))`,
      [name, blockerPid ?? null],
    );
    return result.rows[0];
  }

  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline)
        throw new Error('Expected PostgreSQL lock barrier was not reached');
      await pollDelay(10);
    }
  }

  async function fixture() {
    const organizationId = randomUUID();
    const customerUserId = randomUUID();
    const actorId = randomUUID();
    const reviewerId = randomUUID();
    const suffix = organizationId.slice(0, 8);
    await connection.db.insert(organizations).values({
      id: organizationId,
      slug: `partner-payout-guards-${organizationId}`,
      name: '合作伙伴出款门禁测试',
    });
    await connection.db.insert(users).values([
      { id: actorId, email: `payout-guards-${actorId}@example.com`, name: '财务经办人' },
      { id: reviewerId, email: `payout-guards-${reviewerId}@example.com`, name: '财务复核人' },
    ]);
    await connection.db.insert(customerUsers).values({
      id: customerUserId,
      organizationId,
      mobileE164: '+8613800138000',
    });
    const [event] = await connection.db
      .insert(events)
      .values({
        organizationId,
        slug: `payout-guards-${suffix}`,
        name: '出款门禁测试大会',
        shortName: '出款测试',
        tagline: '出款与账务并发验收',
        description: '验证结算暂停、提现驳回与佣金冲减的账本一致性。',
        status: 'registration_open',
        startsAt: new Date('2027-12-01T01:00:00Z'),
        endsAt: new Date('2027-12-01T10:00:00Z'),
        timezone: 'Asia/Shanghai',
        venue: '测试会场',
        city: '深圳',
        address: '测试地址',
      })
      .returning();
    const [program] = await connection.db
      .insert(eventPartnerProgramVersions)
      .values({
        organizationId,
        eventId: event!.id,
        version: 1,
        status: 'active',
        termsTitle: '测试规则',
        termsContent: '按已确认的佣金结算。',
        promotionPolicy: '真实推广。',
        contentHash: 'a'.repeat(64),
      })
      .returning();
    const [partner] = await connection.db
      .insert(eventPartners)
      .values({
        organizationId,
        eventId: event!.id,
        customerUserId,
        publicSlug: `payout-${suffix}`,
        qualificationStatus: 'active',
        attributionEnabled: true,
        currentProgramVersionId: program!.id,
        acceptedProgramVersionId: program!.id,
      })
      .returning();
    const [recipient] = await connection.db
      .insert(partnerPayoutRecipients)
      .values({
        organizationId,
        partnerId: partner!.id,
        customerUserId,
        type: 'individual',
        channel: 'manual_bank',
        status: 'verified',
        displayNameCiphertext: 'test-recipient',
        accountReferenceCiphertext: 'test-account',
        accountFingerprint: randomUUID(),
        verifiedAt: new Date(),
      })
      .returning();
    await connection.db.insert(partnerLedgerEntries).values({
      organizationId,
      eventId: event!.id,
      partnerId: partner!.id,
      entryType: 'manual_adjustment',
      balanceBucket: 'available',
      amount: 10_000,
      businessKey: `payout-guards:${organizationId}:opening-balance`,
      reason: '测试初始可提现余额',
    });
    const session = {
      sessionId: randomUUID(),
      customerUserId,
      organizationId,
      tokenHash: 'test',
      expiresAt: new Date(Date.now() + 60_000),
      customer: {} as AuthenticatedCustomer['customer'],
      csrfToken: 'test',
    } satisfies AuthenticatedCustomer;
    return {
      organizationId,
      customerUserId,
      actorId,
      reviewerId,
      session,
      eventId: event!.id,
      partnerId: partner!.id,
      recipientId: recipient!.id,
      service: serviceFor(),
    };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  it('reports ledger balances before and after withdrawal instead of commission status totals', async () => {
    const f = await fixture();
    const other = await fixture();
    const before = await f.service.adminOverview(f.organizationId, f.eventId);
    expect(before.commissionTotals.available).toBe(10_000);
    await f.service.createPayout(f.session, f.eventId, {
      amount: 5_000,
      recipientId: f.recipientId,
      idempotencyKey: randomUUID(),
    });
    const after = await f.service.adminOverview(f.organizationId, f.eventId);
    expect(after.commissionTotals.available).toBe(5_000);
    expect(after.commissionTotals.reserved).toBe(5_000);
    expect(
      (await other.service.adminOverview(other.organizationId, other.eventId)).commissionTotals
        .available,
    ).toBe(10_000);
  });

  it('reveals manual recipient details only in scope and records a redacted audit', async () => {
    const f = await fixture();
    const secret = randomUUID();
    const previous = process.env.PARTNER_PAYOUT_DATA_SECRET;
    process.env.PARTNER_PAYOUT_DATA_SECRET = secret;
    try {
      await connection.db
        .update(partnerPayoutRecipients)
        .set({
          displayNameCiphertext: sealSecret('测试收款人', secret),
          accountReferenceCiphertext: sealSecret('TEST-ACCOUNT-12345', secret),
        })
        .where(eq(partnerPayoutRecipients.id, f.recipientId));
      const details = await f.service.recipientDetails(
        f.organizationId,
        f.eventId,
        f.recipientId,
        f.actorId,
      );
      expect(details).toMatchObject({
        displayName: '测试收款人',
        accountReference: 'TEST-ACCOUNT-12345',
        channel: 'manual_bank',
      });
      expect(Object.keys(details).sort()).toEqual(
        [
          'id',
          'partnerId',
          'type',
          'channel',
          'status',
          'version',
          'displayName',
          'accountReference',
        ].sort(),
      );
      const logs = await connection.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, f.recipientId));
      const access = logs.filter(
        (log) => log.action === 'partner.payout_recipient.details_accessed',
      );
      expect(access).toHaveLength(1);
      expect(access[0]).toMatchObject({
        actorId: f.actorId,
        organizationId: f.organizationId,
        eventId: f.eventId,
      });
      expect(JSON.stringify(access)).not.toContain('TEST-ACCOUNT-12345');
      expect(JSON.stringify(access)).not.toContain('测试收款人');
      await expect(
        f.service.recipientDetails(randomUUID(), f.eventId, f.recipientId, f.actorId),
      ).rejects.toMatchObject({ code: API_ERROR_CODES.NOT_FOUND });
      await expect(
        f.service.recipientDetails(
          f.organizationId,
          f.eventId + 1_000_000,
          f.recipientId,
          f.actorId,
        ),
      ).rejects.toMatchObject({ code: API_ERROR_CODES.NOT_FOUND });
      await connection.db
        .update(partnerPayoutRecipients)
        .set({ channel: 'wechat_transfer' })
        .where(eq(partnerPayoutRecipients.id, f.recipientId));
      await expect(
        f.service.recipientDetails(f.organizationId, f.eventId, f.recipientId, f.actorId),
      ).rejects.toMatchObject({ code: API_ERROR_CODES.NOT_FOUND });
    } finally {
      if (previous === undefined) delete process.env.PARTNER_PAYOUT_DATA_SECRET;
      else process.env.PARTNER_PAYOUT_DATA_SECRET = previous;
    }
  });

  async function payout(f: Fixture, status: 'submitted' | 'approved' = 'submitted') {
    const request = await f.service.createPayout(f.session, f.eventId, {
      amount: 8_000,
      recipientId: f.recipientId,
      idempotencyKey: randomUUID(),
    });
    if (status === 'submitted') return request;
    const reviewed = await f.service.reviewPayout(
      f.organizationId,
      f.eventId,
      request.id,
      f.actorId,
      {
        expectedVersion: request.version,
        decision: 'approve',
        reason: '测试审核通过',
      },
    );
    await f.service.confirmPayoutSettlement(f.session, f.eventId, request.id, reviewed.version);
    return (
      await connection.db
        .select()
        .from(partnerPayoutRequests)
        .where(eq(partnerPayoutRequests.id, request.id))
    )[0]!;
  }

  async function batch(f: Fixture, requestId: string) {
    return f.service.createPayoutBatch(f.organizationId, f.eventId, f.actorId, {
      requestIds: [requestId],
      channel: 'manual_bank',
      cutoffAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    });
  }

  async function hold(f: Fixture) {
    await connection.db
      .update(eventPartners)
      .set({ settlementHold: true, settlementHoldReason: '测试风控暂停' })
      .where(eq(eventPartners.id, f.partnerId));
  }

  async function balances(f: Fixture) {
    const rows = await connection.db
      .select({
        bucket: partnerLedgerEntries.balanceBucket,
        amount: sum(partnerLedgerEntries.amount),
      })
      .from(partnerLedgerEntries)
      .where(eq(partnerLedgerEntries.partnerId, f.partnerId))
      .groupBy(partnerLedgerEntries.balanceBucket);
    return {
      available: 0,
      reserved: 0,
      recovery_due: 0,
      paid: 0,
      ...Object.fromEntries(rows.map((row) => [row.bucket, Number(row.amount)])),
    };
  }

  const stateError = { code: API_ERROR_CODES.INVALID_STATE_TRANSITION };

  it('blocks approval when settlement is paused after the payout application', async () => {
    const f = await fixture();
    const request = await payout(f);
    await hold(f);
    await expect(
      f.service.reviewPayout(f.organizationId, f.eventId, request.id, f.actorId, {
        expectedVersion: request.version,
        decision: 'approve',
        reason: '检查结算暂停',
      }),
    ).rejects.toMatchObject(stateError);
    expect(
      (
        await connection.db
          .select()
          .from(partnerPayoutRequests)
          .where(eq(partnerPayoutRequests.id, request.id))
      )[0]?.status,
    ).toBe('submitted');
    expect(await balances(f)).toMatchObject({ available: 2_000, reserved: 8_000, paid: 0 });
  });

  it('blocks batching a previously approved payout after settlement is paused', async () => {
    const f = await fixture();
    const request = await payout(f, 'approved');
    await hold(f);
    await expect(batch(f, request.id)).rejects.toMatchObject(stateError);
    expect(
      await connection.db
        .select()
        .from(partnerPayoutBatches)
        .where(eq(partnerPayoutBatches.eventId, f.eventId)),
    ).toHaveLength(0);
  });

  it('blocks batch approval after settlement is paused', async () => {
    const f = await fixture();
    const request = await payout(f, 'approved');
    const created = await batch(f, request.id);
    await hold(f);
    await expect(
      f.service.approvePayoutBatch(f.organizationId, f.eventId, created.id, f.reviewerId, {
        expectedVersion: created.version,
        decision: 'approve',
        reason: '检查结算暂停',
      }),
    ).rejects.toMatchObject(stateError);
    expect(
      (
        await connection.db
          .select()
          .from(partnerPayoutBatches)
          .where(eq(partnerPayoutBatches.id, created.id))
      )[0]?.status,
    ).toBe('draft');
  });

  it('explains manual settlement separation of duties and never books a duplicate payout', async () => {
    const f = await fixture();
    const request = await payout(f, 'approved');
    const created = await batch(f, request.id);
    await f.service.approvePayoutBatch(f.organizationId, f.eventId, created.id, f.reviewerId, {
      expectedVersion: created.version,
      decision: 'approve',
      reason: '测试第二管理员复核',
    });
    const [batched] = await connection.db
      .select()
      .from(partnerPayoutRequests)
      .where(eq(partnerPayoutRequests.id, request.id));
    const input = {
      expectedVersion: batched!.version,
      externalReference: `TEST-${randomUUID()}`,
      paidAt: new Date().toISOString(),
      documentAssetId: null,
    };
    await expect(
      f.service.completeManualPayout(f.organizationId, f.eventId, request.id, f.reviewerId, input),
    ).rejects.toMatchObject({
      code: API_ERROR_CODES.INVALID_STATE_TRANSITION,
      message: '批次复核人与到账登记人需为不同管理员，请交由另一位有出款权限的管理员登记',
    });
    await expect(
      f.service.completeManualPayout(f.organizationId, f.eventId, request.id, f.actorId, {
        ...input,
        expectedVersion: input.expectedVersion - 1,
      }),
    ).rejects.toMatchObject({ message: '提现申请已更新，请刷新后重试' });
    expect(await balances(f)).toMatchObject({ available: 2_000, reserved: 8_000, paid: 0 });
    await f.service.completeManualPayout(f.organizationId, f.eventId, request.id, f.actorId, input);
    await expect(
      f.service.completeManualPayout(f.organizationId, f.eventId, request.id, f.actorId, input),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.INVALID_STATE_TRANSITION });
    expect(await balances(f)).toMatchObject({ available: 2_000, reserved: 0, paid: 8_000 });
    expect(
      await connection.db
        .select()
        .from(partnerPayoutExecutions)
        .where(eq(partnerPayoutExecutions.payoutRequestId, request.id)),
    ).toHaveLength(1);
    expect(
      (
        await connection.db
          .select()
          .from(partnerPayoutBatches)
          .where(eq(partnerPayoutBatches.id, created.id))
      )[0]?.status,
    ).toBe('completed');
  });

  it('blocks manual settlement after an approved batch is paused', async () => {
    const f = await fixture();
    const request = await payout(f, 'approved');
    const created = await batch(f, request.id);
    await f.service.approvePayoutBatch(f.organizationId, f.eventId, created.id, f.reviewerId, {
      expectedVersion: created.version,
      decision: 'approve',
      reason: '测试复核通过',
    });
    const [batched] = await connection.db
      .select()
      .from(partnerPayoutRequests)
      .where(eq(partnerPayoutRequests.id, request.id));
    await hold(f);
    await expect(
      f.service.completeManualPayout(f.organizationId, f.eventId, request.id, f.actorId, {
        expectedVersion: batched!.version,
        externalReference: `TEST-${randomUUID()}`,
        paidAt: new Date().toISOString(),
        documentAssetId: null,
      }),
    ).rejects.toMatchObject(stateError);
    expect(
      await connection.db
        .select()
        .from(partnerPayoutExecutions)
        .where(eq(partnerPayoutExecutions.payoutRequestId, request.id)),
    ).toHaveLength(0);
    expect(await balances(f)).toMatchObject({ available: 2_000, reserved: 8_000, paid: 0 });
  });

  it('blocks new WeChat transfers during a settlement hold and continues querying existing transfers', async () => {
    const f = await fixture();
    const request = await payout(f, 'approved');
    const created = await batch(f, request.id);
    const approved = await f.service.approvePayoutBatch(
      f.organizationId,
      f.eventId,
      created.id,
      f.reviewerId,
      { expectedVersion: created.version, decision: 'approve', reason: '测试微信出款复核' },
    );
    const configuredSecret = process.env.PARTNER_PAYOUT_DATA_SECRET ?? process.env.JWT_SECRET;
    const secret =
      configuredSecret && configuredSecret.length >= 32
        ? configuredSecret
        : 'tokems-partner-payout-local-secret-2026';
    await connection.db
      .update(partnerPayoutRecipients)
      .set({
        channel: 'wechat_transfer',
        appId: 'wx-payout-guards-test',
        displayNameCiphertext: sealSecret('测试收款人', secret),
        accountReferenceCiphertext: sealSecret('test-openid', secret),
        openIdCiphertext: sealSecret('test-openid', secret),
      })
      .where(eq(partnerPayoutRecipients.id, f.recipientId));
    await connection.db
      .update(partnerPayoutBatches)
      .set({ channel: 'wechat_transfer' })
      .where(eq(partnerPayoutBatches.id, created.id));
    const transfers = new MerchantTransferService(
      { db: connection.db } as DatabaseService,
      {} as RedisService,
    );
    const requestSpy = vi.fn(async () => ({ known: true, body: { state: 'ACCEPTED' } }));
    Object.assign(transfers, {
      integration: vi.fn(async () => ({
        row: { revision: 1, keyVersion: 1 },
        config: {
          appId: 'wx-payout-guards-test',
          mchId: 'payout-guards-merchant',
          merchantCertificateSerial: 'test-serial',
          platformPublicKeyId: 'test-public-key',
          oauthEnabled: false,
        },
        transferConfig: PartnerTransferConfigurationSchema.parse({
          enabled: true,
          verifiedAt: new Date().toISOString(),
        }),
        credentials: {
          merchantPrivateKey: 'test-only-private-key',
          apiV3Key: 'test-api-key'.padEnd(32, '0'),
          platformPublicKey: 'test-only-public-key',
          appSecret: undefined,
        },
      })),
      request: requestSpy,
    });
    await hold(f);
    await expect(
      transfers.executeBatch(f.organizationId, f.eventId, created.id, f.actorId, approved!.version),
    ).rejects.toMatchObject({ ...stateError, message: expect.stringContaining('结算暂停') });
    expect(requestSpy).not.toHaveBeenCalled();
    expect(
      await connection.db
        .select()
        .from(partnerPayoutExecutions)
        .where(eq(partnerPayoutExecutions.payoutRequestId, request.id)),
    ).toHaveLength(0);
    expect(
      (
        await connection.db
          .select()
          .from(partnerPayoutBatches)
          .where(eq(partnerPayoutBatches.id, created.id))
      )[0],
    ).toMatchObject({
      status: 'approved',
      version: approved!.version,
    });

    // The same recipient and integration must reach the simulated channel after the hold clears.
    await connection.db
      .update(eventPartners)
      .set({ settlementHold: false })
      .where(eq(eventPartners.id, f.partnerId));
    await transfers.executeBatch(
      f.organizationId,
      f.eventId,
      created.id,
      f.actorId,
      approved!.version,
    );
    expect(requestSpy).toHaveBeenCalledExactlyOnceWith(
      'POST',
      '/v3/fund-app/mch-transfer/transfer-bills',
      expect.objectContaining({ transfer_amount: 8_000 }),
      expect.any(Object),
      expect.any(Object),
    );
    const [execution] = await connection.db
      .select()
      .from(partnerPayoutExecutions)
      .where(eq(partnerPayoutExecutions.payoutRequestId, request.id));
    expect(execution).toMatchObject({ status: 'ACCEPTED' });
    await hold(f);
    await transfers.queryExecution(f.organizationId, f.eventId, execution!.id);
    expect(requestSpy).toHaveBeenLastCalledWith(
      'GET',
      expect.stringContaining('/transfer-bills/out-bill-no/'),
      undefined,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it.each(['submitted', 'approved'] as const)(
    'allows rejecting a %s payout and releasing its reservation while settlement is paused',
    async (status) => {
      const f = await fixture();
      const request = await payout(f, status);
      await hold(f);
      await expect(
        f.service.reviewPayout(f.organizationId, f.eventId, request.id, f.actorId, {
          expectedVersion: request.version,
          decision: 'reject',
          reason: '暂停期间释放提现占用',
        }),
      ).resolves.toMatchObject({ status: 'rejected' });
      expect(await balances(f)).toMatchObject({ available: 10_000, reserved: 0, paid: 0 });
    },
  );

  it('does not resurrect a payout when rejection is queued before batching', async () => {
    const f = await fixture();
    const request = await payout(f, 'approved');
    const rejectionName = `payout-reject-${f.partnerId}`;
    const batchName = `payout-batch-${f.partnerId}`;
    const rejectingService = namedService(rejectionName);
    const batchingService = namedService(batchName);
    const blocker = await connection.pool.connect();
    const operations: Array<Promise<unknown>> = [];
    let rejection: ReturnType<typeof observe> | undefined;
    let batching: ReturnType<typeof observe> | undefined;
    try {
      await blocker.query('begin');
      const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!
        .pid;
      await blocker.query('select id from partner_payout_requests where id = $1 for update', [
        request.id,
      ]);
      rejection = observe(
        rejectingService.reviewPayout(f.organizationId, f.eventId, request.id, f.actorId, {
          expectedVersion: request.version,
          decision: 'reject',
          reason: '并发驳回测试',
        }),
      );
      operations.push(rejection.result);
      // Queue rejection on the request row before batching can read its old status.
      await until(async () => Boolean(await lockWait(rejectionName, pid)));
      batching = observe(
        batchingService.createPayoutBatch(f.organizationId, f.eventId, f.actorId, {
          requestIds: [request.id],
          channel: 'manual_bank',
          cutoffAt: new Date().toISOString(),
          idempotencyKey: randomUUID(),
        }),
      );
      operations.push(batching.result);
      await until(async () => Boolean(await lockWait(batchName)));
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await Promise.all(operations);
    }
    expect(await rejection!.result).toMatchObject({
      status: 'fulfilled',
      value: { status: 'rejected' },
    });
    expect(await batching!.result).toMatchObject({ status: 'rejected', reason: stateError });
    const [finalRequest] = await connection.db
      .select()
      .from(partnerPayoutRequests)
      .where(eq(partnerPayoutRequests.id, request.id));
    expect(finalRequest).toMatchObject({ status: 'rejected', batchId: null });
    expect(await balances(f)).toMatchObject({ available: 10_000, reserved: 0, paid: 0 });
  }, 20_000);

  it('keeps available nonnegative and records recovery during a concurrent debit and payout', async () => {
    const f = await fixture();
    const [inquiry] = await connection.db
      .insert(partnerCommissionInquiries)
      .values({
        organizationId: f.organizationId,
        eventId: f.eventId,
        partnerId: f.partnerId,
        customerUserId: f.customerUserId,
        type: 'amount_dispute',
        orderReference: `TEST-${randomUUID()}`,
        description: '测试并发冲减佣金',
      })
      .returning();
    const payoutName = `payout-reserve-${f.partnerId}`;
    const debitName = `payout-debit-${f.partnerId}`;
    const payoutService = namedService(payoutName);
    const debitService = namedService(debitName);
    const blocker = await connection.pool.connect();
    const operations: Array<Promise<unknown>> = [];
    let withdrawal: ReturnType<typeof observe> | undefined;
    let adjustment: ReturnType<typeof observe> | undefined;
    try {
      await blocker.query('begin');
      const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!
        .pid;
      // SHARE permits balance reads and holds the payout INSERT after its balance check.
      await blocker.query('lock table partner_payout_requests in share mode');
      withdrawal = observe(
        payoutService.createPayout(f.session, f.eventId, {
          amount: 8_000,
          recipientId: f.recipientId,
          idempotencyKey: randomUUID(),
        }),
      );
      operations.push(withdrawal.result);
      await until(async () => Boolean(await lockWait(payoutName, pid)));
      expect((await lockWait(payoutName, pid))?.query).toMatch(
        /insert into "partner_payout_requests"/iu,
      );
      adjustment = observe(
        debitService.resolveInquiry(f.organizationId, f.eventId, inquiry!.id, f.actorId, {
          expectedVersion: inquiry!.version,
          decision: 'debit_adjustment',
          adjustmentAmount: 8_000,
          reason: '确认不应计入的佣金',
        }),
      );
      operations.push(adjustment.result);
      // A serialized debit waits for the payout; the regression commits an uncoordinated debit.
      await until(
        async () => adjustment!.observation.settled || Boolean(await lockWait(debitName)),
      );
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await Promise.all(operations);
    }
    expect(await withdrawal!.result).toMatchObject({ status: 'fulfilled' });
    expect(await adjustment!.result).toMatchObject({ status: 'fulfilled' });
    expect(await balances(f)).toMatchObject({
      available: 0,
      reserved: 8_000,
      recovery_due: 6_000,
      paid: 0,
    });
  }, 20_000);
});
