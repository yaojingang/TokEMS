import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  events,
  idempotencyKeys,
  organizations,
  users,
  organizationIntegrations,
  eventFeishuDigestSubscriptions,
  feishuDigestDeliveries,
  outboxEvents,
} from '@conference/database';
import { type EventId, feishuDigestReportWindow, DEMO_EVENT } from '@conference/contracts';
import { ConferenceRepository } from './conference.repository.js';
import { IdempotencyService, idempotencyRequestHash } from './idempotency.service.js';
import { DatabaseService } from './database.service.js';
import { RedisService } from './redis.service.js';
import { FeishuDigestService } from './feishu-digest.service.js';
import { encryptIntegrationCredentials } from './integration-credentials.js';

const persistent = process.env.DATABASE_URL ? describe : describe.skip;
persistent('Feishu configuration and queued manual operations in PostgreSQL', () => {
  const database = new DatabaseService();
  const redis = new RedisService();
  const service = new FeishuDigestService(database, redis);
  const db = database.db!;
  let organizationId: string;
  let actorId: string;
  let eventId: EventId;
  let subId: string;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeAll(() => {
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  });
  beforeEach(async () => {
    organizationId = randomUUID();
    actorId = randomUUID();
    await db.insert(organizations).values({
      id: organizationId,
      slug: `feishu-api-${organizationId}`,
      name: '飞书接入验收组织',
    });
    await db
      .insert(users)
      .values({ id: actorId, name: '接入验收管理员', email: `${actorId}@example.test` });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `feishu-${organizationId}`,
        name: '飞书接入验收大会',
        shortName: '接入验收',
        tagline: '验证连接和发送',
        description: '仅用于隔离测试',
        status: 'registration_open',
        startsAt: new Date('2027-01-01T01:00:00Z'),
        endsAt: new Date('2027-01-02T01:00:00Z'),
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
      config: {
        enabled: true,
        appId: 'cli_original',
        appName: '原应用',
        botOpenId: 'ou_fixture',
        connectionVersion: 1,
      },
      encryptedCredentials: encryptIntegrationCredentials(organizationId, 'feishu-bot', {
        appId: 'cli_original',
        appSecret: 'fixture-original-secret',
      }),
      lastVerifiedAt: new Date(),
    });
    const [sub] = await db
      .insert(eventFeishuDigestSubscriptions)
      .values({
        organizationId,
        eventId,
        enabled: false,
        chatId: 'oc_fixture',
        chatNameSnapshot: '接入验收群',
        timezoneSnapshot: 'Asia/Shanghai',
        configVersion: 1,
      })
      .returning();
    subId = sub!.id;
    fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('tenant_access_token'))
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't-fixture', expire: 7200 }),
        );
      if (String(url).includes('/bot/v3/info'))
        return new Response(
          JSON.stringify({
            code: 0,
            bot: { app_name: '接入验收机器人', open_id: 'ou_fixture', activate_status: 2 },
          }),
        );
      if (String(url).includes('/chats'))
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'oc_fixture',
                  name: '接入验收群',
                  external: false,
                  chat_status: 'normal',
                },
              ],
              has_more: false,
            },
          }),
        );
      throw new Error('An API test must never send a message directly');
    });
    vi.stubGlobal('fetch', fetcher);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(users).where(eq(users.id, actorId));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await redis.onModuleDestroy();
    await database.onModuleDestroy();
  });
  const input = () => ({
    chatId: 'oc_fixture',
    dataVisibilityConfirmed: true as const,
    expectedConfigVersion: 1,
    expectedConnectionVersion: 1,
  });

  it.each(['target', 'test'])(
    'preserves concurrent subscription changes while an old group refresh completes (%s)',
    async (change) => {
      let begin!: () => void;
      let finish!: (value: Awaited<ReturnType<typeof service.listChats>>) => void;
      const started = new Promise<void>((resolve) => {
        begin = resolve;
      });
      vi.spyOn(service, 'listChats').mockImplementationOnce(() => {
        begin();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const refreshing = service.refreshChats(organizationId, actorId);
      await started;
      const chatId = change === 'target' ? 'oc_newgroup' : 'oc_fixture';
      await db
        .update(eventFeishuDigestSubscriptions)
        .set({
          chatId,
          enabled: true,
          configVersion: change === 'target' ? 2 : 1,
          revision: 2,
          testVerifiedChatId: chatId,
          testVerifiedConnectionVersion: 1,
          testVerifiedAt: new Date(),
        })
        .where(eq(eventFeishuDigestSubscriptions.id, subId));
      finish({
        items: [],
        connectionVersion: 1,
        refreshedAt: new Date().toISOString(),
        setupHint: '',
      });
      await refreshing;
      expect(await service.getSubscription(organizationId, eventId)).toMatchObject({
        enabled: true,
        chatId,
        targetGroupVerified: true,
      });
    },
  );

  it('keeps the old connection and enabled subscriptions after candidate rejection', async () => {
    await db
      .update(eventFeishuDigestSubscriptions)
      .set({ enabled: true })
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ code: 10014, msg: 'provider-secret-that-must-not-leak' })),
    );
    await expect(
      service.updateConfiguration(organizationId, actorId, {
        appId: 'cli_wrong',
        appSecret: 'wrong-secret',
        enabled: true,
        expectedConnectionVersion: 1,
      }),
    ).rejects.toThrow('当前连接仍保留');
    expect(await service.getConfiguration(organizationId)).toMatchObject({
      appId: 'cli_original',
      connectionVersion: 1,
      status: 'verified',
    });
    expect((await service.getSubscription(organizationId, eventId)).enabled).toBe(true);
  });
  it('requires a corresponding secret when the app ID changes', async () => {
    await expect(
      service.updateConfiguration(organizationId, actorId, {
        appId: 'cli_replacement',
        enabled: true,
        expectedConnectionVersion: 1,
      }),
    ).rejects.toThrow('对应的应用密钥');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('serializes concurrent replacement and leaves only the winning version', async () => {
    const results = await Promise.allSettled([
      service.updateConfiguration(organizationId, actorId, {
        appId: 'cli_newone',
        appSecret: 'fixture-new-one',
        enabled: true,
        expectedConnectionVersion: 1,
      }),
      service.updateConfiguration(organizationId, actorId, {
        appId: 'cli_newtwo',
        appSecret: 'fixture-new-two',
        enabled: true,
        expectedConnectionVersion: 1,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await service.getConfiguration(organizationId)).toMatchObject({ connectionVersion: 2 });
    expect(await service.getSubscription(organizationId, eventId)).toMatchObject({
      enabled: false,
      targetGroupVerified: false,
      configVersion: 2,
    });
  });
  it('does not invalidate a settings version after a diagnostic check', async () => {
    await service.verify(organizationId, actorId);
    const saved = await service.updateSubscription(organizationId, eventId, actorId, {
      enabled: false,
      chatId: 'oc_fixture',
      chatName: '接入验收群',
      sendLocalTime: '10:00',
      expectedConfigVersion: 1,
      expectedConnectionVersion: 1,
    });
    expect(saved).toMatchObject({ connectionVersion: 1, configVersion: 2, sendLocalTime: '10:00' });
  });
  it('persists a test and outbox atomically, preserving a live sending result on replay', async () => {
    const result = await service.sendTest(organizationId, eventId, actorId, input(), 'one-click');
    expect(result.status).toBe('queued');
    const [row] = await db
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.id, result.deliveryId));
    expect(row).toMatchObject({
      aggregateSnapshot: null,
      attempts: 0,
      connectionVersion: 1,
      subscriptionConfigVersion: 1,
    });
    const outbox = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.organizationId, organizationId));
    expect(outbox).toHaveLength(1);
    await db
      .update(feishuDigestDeliveries)
      .set({ status: 'sending', leaseUntil: new Date(Date.now() + 120000) })
      .where(eq(feishuDigestDeliveries.id, result.deliveryId));
    const replay = await service.sendTest(organizationId, eventId, actorId, input(), 'one-click');
    expect(replay).toMatchObject({ deliveryId: result.deliveryId, status: 'sending' });
    await expect(
      service.sendTest(
        organizationId,
        eventId,
        actorId,
        { ...input(), chatId: 'oc_other' },
        'one-click',
      ),
    ).rejects.toThrow('不同请求');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false);
  });
  it('keeps existing group bindings when any group-list page fails', async () => {
    await db
      .update(eventFeishuDigestSubscriptions)
      .set({ enabled: true })
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    fetcher.mockImplementation(async (url) => {
      if (String(url).includes('tenant_access_token'))
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't-fixture', expire: 7200 }),
        );
      if (String(url).includes('page_token')) return new Response('unavailable', { status: 503 });
      return new Response(
        JSON.stringify({ code: 0, data: { items: [], has_more: true, page_token: 'second' } }),
      );
    });
    await expect(service.refreshChats(organizationId, actorId)).rejects.toThrow();
    expect(await service.getSubscription(organizationId, eventId)).toMatchObject({
      enabled: true,
      chatId: 'oc_fixture',
      configVersion: 1,
    });
  });
  it('does not enable before a matching test and a healthy scheduler', async () => {
    vi.spyOn(service, 'serviceHealth').mockResolvedValue({
      ready: true,
      queueReachable: true,
      lastScanAt: new Date().toISOString(),
      buildSha: 'fixture',
    });
    const settings = {
      enabled: true,
      chatId: 'oc_fixture',
      chatName: '接入验收群',
      sendLocalTime: '09:00',
      expectedConfigVersion: 1,
      expectedConnectionVersion: 1,
    };
    await expect(
      service.updateSubscription(organizationId, eventId, actorId, settings),
    ).rejects.toThrow('测试日报');
    await db
      .update(eventFeishuDigestSubscriptions)
      .set({
        testVerifiedAt: new Date(),
        testVerifiedChatId: 'oc_fixture',
        testVerifiedConnectionVersion: 1,
      })
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    expect(
      (await service.updateSubscription(organizationId, eventId, actorId, settings)).enabled,
    ).toBe(true);
    vi.spyOn(service, 'serviceHealth').mockResolvedValue({
      ready: false,
      queueReachable: true,
      lastScanAt: null,
      buildSha: '',
    });
    await expect(
      service.updateSubscription(organizationId, eventId, actorId, {
        ...settings,
        expectedConfigVersion: 2,
      }),
    ).rejects.toThrow('暂未就绪');
  });
  it('records a human acknowledgement while preserving the unknown technical result', async () => {
    const report = feishuDigestReportWindow(new Date(), 'Asia/Shanghai');
    const [row] = await db
      .insert(feishuDigestDeliveries)
      .values({
        organizationId,
        eventId,
        subscriptionId: subId,
        kind: 'manual_test',
        ...report,
        chatIdSnapshot: 'oc_fixture',
        chatNameSnapshot: '接入验收群',
        status: 'unknown',
        dedupKey: randomUUID(),
        scheduledAt: new Date(),
        connectionVersion: 1,
        subscriptionConfigVersion: 1,
      })
      .returning();
    await service.recoverDelivery(
      organizationId,
      eventId,
      row!.id,
      actorId,
      'received',
      'resolve',
      { expectedConfigVersion: 1, expectedConnectionVersion: 1 },
    );
    const detail = await service.deliveryDetail(organizationId, eventId, row!.id);
    expect(detail).toMatchObject({
      status: 'unknown',
      providerMessageId: '',
      resolution: { kind: 'received', actorId },
      availableActions: [],
    });
    await expect(service.deliveryDetail(randomUUID(), eventId, row!.id)).rejects.toThrow(
      '无权访问',
    );
  });
  it('only regenerates a snapshot-free failure before the first send and grace deadline', async () => {
    const test = await service.sendTest(
      organizationId,
      eventId,
      actorId,
      input(),
      'generation-test',
    );
    await db
      .update(feishuDigestDeliveries)
      .set({ status: 'failed', lastErrorCode: 'GENERATION_ERROR' })
      .where(eq(feishuDigestDeliveries.id, test.deliveryId));
    const result = await service.recoverDelivery(
      organizationId,
      eventId,
      test.deliveryId,
      actorId,
      'regenerate',
      'regenerate',
      { expectedConfigVersion: 1, expectedConnectionVersion: 1 },
    );
    expect(result).toMatchObject({ status: 'queued', deliveryId: test.deliveryId });
    await db
      .update(feishuDigestDeliveries)
      .set({ status: 'failed', firstSendStartedAt: new Date() })
      .where(
        and(
          eq(feishuDigestDeliveries.organizationId, organizationId),
          eq(feishuDigestDeliveries.id, test.deliveryId),
        ),
      );
    expect(
      (await service.deliveryDetail(organizationId, eventId, test.deliveryId)).availableActions,
    ).not.toContain('regenerate');
  });
  it.each(['connection', 'event'])(
    'preserves a failed report until its sending context is eligible again (%s)',
    async (issue) => {
      const test = await service.sendTest(
        organizationId,
        eventId,
        actorId,
        input(),
        'recovery-eligibility',
      );
      await db
        .update(feishuDigestDeliveries)
        .set({ status: 'failed', kind: 'scheduled' })
        .where(eq(feishuDigestDeliveries.id, test.deliveryId));
      await db
        .update(eventFeishuDigestSubscriptions)
        .set({
          enabled: true,
          testVerifiedAt: new Date(),
          testVerifiedChatId: 'oc_fixture',
          testVerifiedConnectionVersion: 1,
        })
        .where(eq(eventFeishuDigestSubscriptions.id, subId));
      if (issue === 'connection')
        await db
          .update(organizationIntegrations)
          .set({ status: 'error' })
          .where(eq(organizationIntegrations.organizationId, organizationId));
      else await db.update(events).set({ status: 'configuring' }).where(eq(events.id, eventId));
      const params = { expectedConfigVersion: 1, expectedConnectionVersion: 1 };
      await expect(
        service.recoverDelivery(
          organizationId,
          eventId,
          test.deliveryId,
          actorId,
          'blocked-recovery',
          'regenerate',
          params,
        ),
      ).rejects.toThrow('当前记录无法执行');
      expect(await service.deliveryDetail(organizationId, eventId, test.deliveryId)).toMatchObject({
        status: 'failed',
        availableActions: [],
      });
      await db
        .update(organizationIntegrations)
        .set({ status: 'verified' })
        .where(eq(organizationIntegrations.organizationId, organizationId));
      await db.update(events).set({ status: 'prepublished' }).where(eq(events.id, eventId));
      expect(
        (await service.deliveryDetail(organizationId, eventId, test.deliveryId)).availableActions,
      ).toContain('regenerate');
      await expect(
        service.recoverDelivery(
          organizationId,
          eventId,
          test.deliveryId,
          actorId,
          'valid-recovery',
          'regenerate',
          params,
        ),
      ).resolves.toMatchObject({ status: 'queued', deliveryId: test.deliveryId });
    },
  );

  it('preserves an existing group when its provider status is unknown', async () => {
    await db
      .update(eventFeishuDigestSubscriptions)
      .set({ enabled: true })
      .where(eq(eventFeishuDigestSubscriptions.id, subId));
    fetcher.mockImplementation(async (url) =>
      String(url).includes('tenant_access_token')
        ? new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }))
        : new Response(
            JSON.stringify({
              code: 0,
              data: { items: [{ chat_id: 'oc_fixture', name: '状态暂未知' }], has_more: false },
            }),
          ),
    );
    const result = await service.refreshChats(organizationId, actorId);
    expect(result.items[0]).toMatchObject({ selectable: false, external: null, status: 'unknown' });
    expect(await service.getSubscription(organizationId, eventId)).toMatchObject({
      enabled: true,
      configVersion: 1,
    });
  });
  it('retains a working connection and shows group-specific diagnostic failure', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) =>
      String(url).includes('/chats')
        ? new Response(JSON.stringify({ code: 99991672 }))
        : original(url, init),
    );
    await service.verify(organizationId, actorId);
    expect(await service.getConfiguration(organizationId)).toMatchObject({
      status: 'verified',
      connectionVersion: 1,
      diagnostics: { credentials: 'passed', bot: 'passed', chats: 'failed' },
    });
  });
  it('invalidates old work through the real event timezone update path', async () => {
    await db.update(events).set({ status: 'configuring' }).where(eq(events.id, eventId));
    const test = await service.sendTest(organizationId, eventId, actorId, input(), 'timezone-test');
    const repository = new ConferenceRepository(database);
    vi.spyOn(repository, 'getPublicEvent').mockResolvedValue(DEMO_EVENT);
    await repository.updateEvent(eventId, { timezone: 'UTC' }, actorId, organizationId);
    expect(await service.getSubscription(organizationId, eventId)).toMatchObject({
      timezone: 'UTC',
      configVersion: 2,
    });
    expect(await service.deliveryDetail(organizationId, eventId, test.deliveryId)).toMatchObject({
      status: 'cancelled',
    });
    await expect(
      service.sendTest(organizationId, eventId, actorId, input(), 'stale-timezone'),
    ).rejects.toThrow('配置');
  });
  it('takes over an expired API receipt and returns the already committed delivery', async () => {
    const key = randomUUID();
    const scope = `feishu-fixture:${organizationId}`;
    const accepted = await service.sendTest(organizationId, eventId, actorId, input(), key);
    await db.insert(idempotencyKeys).values({
      scope,
      key,
      requestHash: idempotencyRequestHash(input()),
      responseCode: 202,
      responseBody: { __tokemsIdempotencyPending: true },
      leaseExpiresAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 3600000),
    });
    try {
      const resumed = await new IdempotencyService(database).execute(
        scope,
        key,
        input(),
        () => service.sendTest(organizationId, eventId, actorId, input(), key),
        { allowLeaseTakeover: true },
      );
      expect(resumed.deliveryId).toBe(accepted.deliveryId);
      expect(
        await db
          .select()
          .from(feishuDigestDeliveries)
          .where(eq(feishuDigestDeliveries.organizationId, organizationId)),
      ).toHaveLength(1);
    } finally {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.scope, scope));
    }
  });
  it('replays an accepted regeneration without enqueuing a second job and allows a new explicit attempt', async () => {
    const test = await service.sendTest(organizationId, eventId, actorId, input(), 'regen-receipt');
    await db
      .update(feishuDigestDeliveries)
      .set({ status: 'failed' })
      .where(eq(feishuDigestDeliveries.id, test.deliveryId));
    const params = { expectedConfigVersion: 1, expectedConnectionVersion: 1 };
    await service.recoverDelivery(
      organizationId,
      eventId,
      test.deliveryId,
      actorId,
      'one',
      'regenerate',
      params,
    );
    await service.recoverDelivery(
      organizationId,
      eventId,
      test.deliveryId,
      actorId,
      'one',
      'regenerate',
      params,
    );
    expect(
      await db.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId)),
    ).toHaveLength(2);
    await db
      .update(feishuDigestDeliveries)
      .set({ status: 'failed' })
      .where(eq(feishuDigestDeliveries.id, test.deliveryId));
    await service.recoverDelivery(
      organizationId,
      eventId,
      test.deliveryId,
      actorId,
      'two',
      'regenerate',
      params,
    );
    expect(
      await db.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId)),
    ).toHaveLength(3);
  });
});
