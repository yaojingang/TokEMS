import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDatabase,
  loadFeishuDigestSnapshot,
  events,
  organizations,
  organizationIntegrations,
  eventFeishuDigestSubscriptions,
  feishuDigestDeliveries,
  outboxEvents,
} from '@conference/database';
import { feishuDigestReportWindow, type EventId } from '@conference/contracts';
import { encryptIntegrationCredentials } from '@conference/security';
import { FeishuBotClient } from '@conference/integrations';
import {
  enqueueDueFeishuDigests,
  processFeishuDigestDelivery,
  recoverFeishuDigestDeliveries,
} from './feishu-digest.worker.js';

const persistent = process.env.DATABASE_URL ? describe : describe.skip;
persistent('Feishu unified Worker delivery and recovery', () => {
  let connection: ReturnType<typeof createDatabase>;
  let organizationId: string;
  let eventId: EventId;
  let subId: string;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeAll(() => {
    connection = createDatabase();
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  });
  beforeEach(async () => {
    const db = connection.db;
    organizationId = randomUUID();
    await db.insert(organizations).values({
      id: organizationId,
      slug: `feishu-worker-${organizationId}`,
      name: '日报发送验收组织',
    });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `feishu-${organizationId}`,
        name: '日报发送验收大会',
        shortName: '发送验收',
        tagline: '发送验证',
        description: '隔离测试数据',
        status: 'registration_open',
        startsAt: new Date('2027-01-01T00:00:00Z'),
        endsAt: new Date('2027-01-02T00:00:00Z'),
        timezone: 'Asia/Shanghai',
        city: '上海',
        venue: '验收会场',
        address: '验收地址',
      })
      .returning();
    eventId = event!.id;
    await db.insert(organizationIntegrations).values({
      organizationId,
      provider: 'feishu-bot',
      status: 'verified',
      config: { enabled: true, appId: 'cli_workerfixture', connectionVersion: 1 },
      encryptedCredentials: encryptIntegrationCredentials(organizationId, 'feishu-bot', {
        appId: 'cli_workerfixture',
        appSecret: 'worker-fixture-secret',
      }),
    });
    const [sub] = await db
      .insert(eventFeishuDigestSubscriptions)
      .values({
        organizationId,
        eventId,
        chatId: 'oc_workerfixture',
        chatNameSnapshot: '发送验收群',
        enabled: false,
        timezoneSnapshot: 'Asia/Shanghai',
        configVersion: 1,
      })
      .returning();
    subId = sub!.id;
    fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('tenant_access_token')
        ? new Response(JSON.stringify({ code: 0, tenant_access_token: 't-fixture', expire: 7200 }))
        : new Response(JSON.stringify({ code: 0, data: { message_id: 'om_fixture' } })),
    );
  });
  afterEach(async () => {
    await connection.db.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await connection.db.delete(organizations).where(eq(organizations.id, organizationId));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await connection.pool.end();
  });
  const options = () => ({
    adminOrigin: 'https://admin.example.test',
    clientFactory: (credentials: { appId: string; appSecret: string }) =>
      new FeishuBotClient(credentials, fetcher),
  });
  async function delivery(kind: 'manual_test' | 'scheduled' = 'manual_test') {
    const [row] = await connection.db
      .insert(feishuDigestDeliveries)
      .values({
        organizationId,
        eventId,
        subscriptionId: subId,
        kind,
        ...feishuDigestReportWindow(new Date(), 'Asia/Shanghai'),
        chatIdSnapshot: 'oc_workerfixture',
        chatNameSnapshot: '发送验收群',
        dedupKey: randomUUID(),
        scheduledAt: new Date(),
        connectionVersion: 1,
        subscriptionConfigVersion: 1,
      })
      .returning();
    return row!;
  }
  async function read(id: string) {
    const [row] = await connection.db
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.id, id));
    return row!;
  }
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  it('generates a real V2 aggregate and validates the saved group only after Worker success', async () => {
    const row = await delivery();
    expect(
      (await loadFeishuDigestSnapshot(connection.db, organizationId, eventId)).metricVersion,
    ).toBe(2);
    expect(await processFeishuDigestDelivery(connection.db, row.id, options())).toMatchObject({
      status: 'sent',
    });
    expect(await read(row.id)).toMatchObject({
      status: 'sent',
      attempts: 1,
      providerMessageId: 'om_fixture',
      aggregateSnapshot: {
        metricVersion: 2,
        daily: { refundRequests: 0, invoiceDemands: 0, invoiceSubmissions: 0, pageViews: null },
      },
    });
    const [sub] = await connection.db
      .select()
      .from(eventFeishuDigestSubscriptions)
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    expect(sub).toMatchObject({
      enabled: false,
      testVerifiedConnectionVersion: 1,
      testVerifiedChatId: 'oc_workerfixture',
      configVersion: 1,
    });
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body.uuid).toBe(row.id);
    expect(body.content).toContain('【测试】');
  });
  it('creates and sends one scheduled report through the same Worker', async () => {
    const due = new Date(Date.now() - 60_000);
    await connection.db
      .update(eventFeishuDigestSubscriptions)
      .set({
        enabled: true,
        nextRunAt: due,
        testVerifiedAt: new Date(),
        testVerifiedChatId: 'oc_workerfixture',
        testVerifiedConnectionVersion: 1,
      })
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    await enqueueDueFeishuDigests(connection.db);
    await enqueueDueFeishuDigests(connection.db);
    const rows = await connection.db
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'scheduled',
      connectionVersion: 1,
      subscriptionConfigVersion: 1,
    });
    expect(await processFeishuDigestDelivery(connection.db, rows[0]!.id, options())).toMatchObject({
      status: 'sent',
    });
  });
  it('does not take over an active sending lease or duplicate the provider request', async () => {
    const row = await delivery();
    const entered = gate();
    const finish = gate();
    fetcher.mockImplementation(async (url) => {
      if (String(url).includes('tenant_access_token'))
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't-fixture', expire: 7200 }),
        );
      entered.release();
      await finish.promise;
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_once' } }));
    });
    const first = processFeishuDigestDelivery(connection.db, row.id, options());
    await entered.promise;
    expect(await processFeishuDigestDelivery(connection.db, row.id, options())).toMatchObject({
      handled: false,
    });
    expect((await read(row.id)).status).toBe('sending');
    finish.release();
    await first;
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/messages'))).toHaveLength(1);
  });
  it('records a late old test without verifying a replacement connection', async () => {
    const row = await delivery();
    const entered = gate();
    const finish = gate();
    fetcher.mockImplementation(async (url) => {
      if (String(url).includes('tenant_access_token'))
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't-fixture', expire: 7200 }),
        );
      entered.release();
      await finish.promise;
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_old' } }));
    });
    const run = processFeishuDigestDelivery(connection.db, row.id, options());
    await entered.promise;
    await connection.db
      .update(organizationIntegrations)
      .set({ config: { enabled: true, appId: 'cli_workerfixture', connectionVersion: 2 } })
      .where(eq(organizationIntegrations.organizationId, organizationId));
    await connection.db
      .update(eventFeishuDigestSubscriptions)
      .set({ configVersion: 2, testVerifiedAt: null, testVerifiedConnectionVersion: null })
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    finish.release();
    await run;
    expect((await read(row.id)).status).toBe('sent');
    const [sub] = await connection.db
      .select()
      .from(eventFeishuDigestSubscriptions)
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    expect(sub?.testVerifiedAt).toBeNull();
  });
  it('freezes the card and UUID for a known rate-limit retry', async () => {
    const row = await delivery();
    let sends = 0;
    fetcher.mockImplementation(async (url) => {
      if (String(url).includes('tenant_access_token'))
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't-fixture', expire: 7200 }),
        );
      sends++;
      return sends === 1
        ? new Response(JSON.stringify({ code: 230020 }))
        : new Response(JSON.stringify({ code: 0, data: { message_id: 'om_retry' } }));
    });
    expect(await processFeishuDigestDelivery(connection.db, row.id, options())).toMatchObject({
      status: 'retrying',
    });
    const first = await read(row.id);
    await connection.db
      .update(events)
      .set({ name: '生成之后修改的大会名' })
      .where(eq(events.id, eventId));
    await connection.db
      .update(feishuDigestDeliveries)
      .set({ leaseUntil: null })
      .where(eq(feishuDigestDeliveries.id, row.id));
    expect(await processFeishuDigestDelivery(connection.db, row.id, options())).toMatchObject({
      status: 'sent',
    });
    const second = await read(row.id);
    expect(second.aggregateSnapshot).toEqual(first.aggregateSnapshot);
    expect(second.cardPayload).toEqual(first.cardPayload);
    const bodies = fetcher.mock.calls
      .filter(([url]) => String(url).includes('/messages'))
      .map(([, init]) => init?.body);
    expect(bodies[0]).toBe(bodies[1]);
  });
  it('cancels when settings change between aggregation and the network permit', async () => {
    const row = await delivery();
    const result = await processFeishuDigestDelivery(connection.db, row.id, {
      ...options(),
      acquireRateSlot: async () => {
        await connection.db
          .update(eventFeishuDigestSubscriptions)
          .set({ configVersion: 2 })
          .where(eq(eventFeishuDigestSubscriptions.id, subId));
        return 0;
      },
    });
    expect(result.handled).toBe(false);
    expect((await read(row.id)).status).toBe('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('recovers expired sending to unknown without sending, and known acceptance by finalizing only', async () => {
    const unknown = await delivery();
    const accepted = await delivery();
    await connection.db
      .update(feishuDigestDeliveries)
      .set({
        status: 'sending',
        leaseUntil: new Date(Date.now() - 60000),
        updatedAt: new Date(Date.now() - 180000),
      })
      .where(eq(feishuDigestDeliveries.id, unknown.id));
    await connection.db
      .update(feishuDigestDeliveries)
      .set({ status: 'unknown', providerMessageId: 'om_already_accepted' })
      .where(eq(feishuDigestDeliveries.id, accepted.id));
    await recoverFeishuDigestDeliveries(connection.db);
    expect((await read(unknown.id)).status).toBe('unknown');
    expect((await read(accepted.id)).status).toBe('sent');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never sends an uncertain response again on queue replay', async () => {
    const row = await delivery();
    fetcher.mockImplementation(async (url) => {
      if (String(url).includes('tenant_access_token'))
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't-fixture', expire: 7200 }),
        );
      throw new Error('socket interrupted');
    });
    expect(await processFeishuDigestDelivery(connection.db, row.id, options())).toMatchObject({
      status: 'unknown',
    });
    await processFeishuDigestDelivery(connection.db, row.id, options());
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/messages'))).toHaveLength(1);
  });
  it('retries a temporary rate-gate outage before any provider request', async () => {
    const row = await delivery();
    expect(
      await processFeishuDigestDelivery(connection.db, row.id, {
        ...options(),
        acquireRateSlot: async () => {
          throw new Error('Redis disconnected');
        },
      }),
    ).toMatchObject({ status: 'retrying' });
    const waiting = await read(row.id);
    expect(waiting.attempts).toBe(0);
    expect(waiting.aggregateSnapshot).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    await connection.db
      .update(feishuDigestDeliveries)
      .set({ leaseUntil: null })
      .where(eq(feishuDigestDeliveries.id, row.id));
    expect(
      await processFeishuDigestDelivery(connection.db, row.id, {
        ...options(),
        acquireRateSlot: async () => 0,
      }),
    ).toMatchObject({ status: 'sent' });
    expect((await read(row.id)).aggregateSnapshot).toEqual(waiting.aggregateSnapshot);
  });
  it('serializes simultaneous scheduling and manual delivery without deadlock or duplicates', async () => {
    const row = await delivery();
    await connection.db
      .update(eventFeishuDigestSubscriptions)
      .set({
        enabled: true,
        nextRunAt: new Date(Date.now() - 1000),
        testVerifiedAt: new Date(),
        testVerifiedChatId: 'oc_workerfixture',
        testVerifiedConnectionVersion: 1,
      })
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    const results = await Promise.all([
      enqueueDueFeishuDigests(connection.db),
      enqueueDueFeishuDigests(connection.db),
      processFeishuDigestDelivery(connection.db, row.id, options()),
    ]);
    expect(results[2]).toMatchObject({ status: 'sent' });
    // A scan may defer while the manual delivery owns the conference lock.
    await enqueueDueFeishuDigests(connection.db);
    const rows = await connection.db
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.organizationId, organizationId));
    expect(rows.filter((item) => item.kind === 'scheduled')).toHaveLength(1);
  });
  it('skips a locked conference and schedules another due conference', async () => {
    const [other] = await connection.db
      .insert(events)
      .values({
        organizationId,
        slug: `unlocked-${randomUUID()}`,
        name: '另一大会',
        shortName: '另一大会',
        tagline: '验收',
        description: '验收',
        status: 'registration_open',
        startsAt: new Date('2027-01-01'),
        endsAt: new Date('2027-01-02'),
        timezone: 'Asia/Shanghai',
        city: '上海',
        venue: '验收',
        address: '验收',
      })
      .returning();
    const verified = {
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000),
      testVerifiedAt: new Date(),
      testVerifiedChatId: 'oc_workerfixture',
      testVerifiedConnectionVersion: 1,
    };
    await connection.db
      .update(eventFeishuDigestSubscriptions)
      .set({ ...verified, nextRunAt: new Date(Date.now() - 2000) })
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    await connection.db
      .insert(eventFeishuDigestSubscriptions)
      .values({
        organizationId,
        eventId: other!.id,
        chatId: 'oc_workerfixture',
        chatNameSnapshot: '验收群',
        timezoneSnapshot: 'Asia/Shanghai',
        configVersion: 1,
        ...verified,
      });
    const entered = gate();
    const finish = gate();
    const locked = connection.db.transaction(async (tx) => {
      await tx.select().from(events).where(eq(events.id, eventId)).for('update');
      entered.release();
      await finish.promise;
    });
    await entered.promise;
    try {
      expect(await enqueueDueFeishuDigests(connection.db)).toMatchObject({ queued: 1 });
    } finally {
      finish.release();
      await locked;
    }
    const rows = await connection.db
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventId).toBe(other!.id);
  });
});
