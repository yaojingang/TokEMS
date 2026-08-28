import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventId } from '@conference/contracts';
import {
  createDatabase,
  eventFeishuDigestSubscriptions,
  events,
  feishuDigestDeliveries,
  organizationIntegrations,
  organizations,
  outboxEvents,
} from '@conference/database';
import { FeishuApiError } from '@conference/integrations';
import { and, count, eq } from 'drizzle-orm';
import {
  cachedFeishuClientForWorker,
  enqueueDueFeishuDigests,
  feishuDeliveryOutsideGraceWindow,
  feishuDeliveryFailureStatus,
  feishuGeneratingDeliveryNeedsRetry,
  feishuScheduledDeliveryConfigurationIssue,
} from './feishu-digest.worker.js';

describe('Feishu digest delivery policy', () => {
  it('reuses one client per organization and rotates it with the credentials', () => {
    const organizationId = randomUUID();
    const first = cachedFeishuClientForWorker(organizationId, {
      appId: 'cli_tokems',
      appSecret: 'secret-v1',
    });
    const second = cachedFeishuClientForWorker(organizationId, {
      appId: 'cli_tokems',
      appSecret: 'secret-v1',
    });
    const rotated = cachedFeishuClientForWorker(organizationId, {
      appId: 'cli_tokems',
      appSecret: 'secret-v2',
    });

    expect(second).toBe(first);
    expect(rotated).not.toBe(first);
  });

  it('cancels a queued delivery when the event leaves an eligible state or changes timezone', () => {
    const base = {
      eventStatus: 'registration_open',
      eventTimezone: 'Asia/Shanghai',
      subscriptionTimezone: 'Asia/Shanghai',
      subscriptionEnabled: true,
      subscriptionChatId: 'oc_test',
      testVerifiedChatId: 'oc_test',
      testVerifiedAt: new Date('2026-08-19T00:00:00.000Z'),
      deliveryChatId: 'oc_test',
      reportDate: '2026-08-19',
      windowStart: new Date('2026-08-18T16:00:00.000Z'),
      windowEnd: new Date('2026-08-19T16:00:00.000Z'),
    };

    expect(feishuScheduledDeliveryConfigurationIssue(base)).toBeNull();
    expect(feishuScheduledDeliveryConfigurationIssue({ ...base, eventStatus: 'configuring' })).toBe(
      'EVENT_NOT_ELIGIBLE',
    );
    expect(
      feishuScheduledDeliveryConfigurationIssue({
        ...base,
        eventTimezone: 'UTC',
        subscriptionTimezone: 'UTC',
      }),
    ).toBe('DELIVERY_TIMEZONE_CHANGED');
  });

  it('does not retry a send with an unknown outcome', () => {
    expect(
      feishuDeliveryFailureStatus(
        new FeishuApiError('socket reset', {
          code: 'FEISHU_SEND_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        }),
        1,
      ),
    ).toBe('unknown');
  });

  it('retries explicit transient failures at most five times', () => {
    const error = new FeishuApiError('rate limited', {
      code: 'HTTP_429',
      retryable: true,
      httpStatus: 429,
    });
    expect(feishuDeliveryFailureStatus(error, 1)).toBe('retrying');
    expect(feishuDeliveryFailureStatus(error, 4)).toBe('retrying');
    expect(feishuDeliveryFailureStatus(error, 5)).toBe('failed');
  });

  it('fails permanent provider errors immediately', () => {
    expect(
      feishuDeliveryFailureStatus(
        new FeishuApiError('bot is not in the chat', { code: '230013' }),
        1,
      ),
    ).toBe('failed');
  });

  it('keeps a fresh generating delivery retryable after a worker interruption', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');

    expect(feishuGeneratingDeliveryNeedsRetry(new Date('2026-08-19T11:55:00.000Z'), now)).toBe(
      true,
    );
    expect(feishuGeneratingDeliveryNeedsRetry(new Date('2026-08-19T11:49:59.999Z'), now)).toBe(
      false,
    );
  });

  it('checks the twelve-hour grace window again immediately before sending', () => {
    const scheduledAt = new Date('2026-08-19T00:00:00.000Z');

    expect(
      feishuDeliveryOutsideGraceWindow(scheduledAt, new Date('2026-08-19T12:00:00.000Z')),
    ).toBe(false);
    expect(
      feishuDeliveryOutsideGraceWindow(scheduledAt, new Date('2026-08-19T12:00:00.001Z')),
    ).toBe(true);
  });
});

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('Feishu digest durable scheduler', () => {
  const organizationId = randomUUID();
  let eventId: EventId;
  let connection: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    connection = createDatabase(process.env.DATABASE_URL!);
    await connection.db.insert(organizations).values({
      id: organizationId,
      slug: `feishu-digest-${randomUUID().slice(0, 8)}`,
      name: '飞书日报调度测试组织',
    });
    const [event] = await connection.db
      .insert(events)
      .values({
        organizationId,
        slug: `feishu-digest-event-${randomUUID().slice(0, 8)}`,
        name: '飞书日报调度测试大会',
        shortName: '日报测试',
        tagline: '验证定时调度',
        description: '验证数据库抢占和同日报去重。',
        status: 'registration_open',
        startsAt: new Date('2027-10-01T01:00:00.000Z'),
        endsAt: new Date('2027-10-01T10:00:00.000Z'),
        timezone: 'Asia/Shanghai',
        venue: '测试会场',
        city: '上海',
        address: '测试地址',
        settings: {},
      })
      .returning({ id: events.id });
    eventId = event!.id;
    await connection.db.insert(organizationIntegrations).values({
      organizationId,
      provider: 'feishu-bot',
      status: 'verified',
      config: { enabled: true, appId: 'cli_test' },
    });
    await connection.db.insert(eventFeishuDigestSubscriptions).values({
      organizationId,
      eventId,
      enabled: true,
      chatId: 'oc_test',
      chatNameSnapshot: '调度测试群',
      sendLocalTime: '09:00',
      timezoneSnapshot: 'Asia/Shanghai',
      nextRunAt: new Date('2026-08-20T01:00:00.000Z'),
      testVerifiedAt: new Date('2026-08-19T01:00:00.000Z'),
      testVerifiedChatId: 'oc_test',
    });
  });

  afterAll(async () => {
    if (!connection) return;
    await connection.db.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await connection.db.delete(organizations).where(eq(organizations.id, organizationId));
    await connection.pool.end();
  });

  it('creates one delivery and one outbox event for a due event day', async () => {
    const now = new Date('2026-08-20T01:05:00.000Z');
    await expect(enqueueDueFeishuDigests(connection.db, now)).resolves.toMatchObject({ queued: 1 });
    await expect(enqueueDueFeishuDigests(connection.db, now)).resolves.toMatchObject({ queued: 0 });

    const [[deliveryCount], [outboxCount], [subscription]] = await Promise.all([
      connection.db
        .select({ value: count() })
        .from(feishuDigestDeliveries)
        .where(
          and(
            eq(feishuDigestDeliveries.organizationId, organizationId),
            eq(feishuDigestDeliveries.eventId, eventId),
          ),
        ),
      connection.db
        .select({ value: count() })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.organizationId, organizationId),
            eq(outboxEvents.eventType, 'FeishuDigestDeliveryRequested'),
          ),
        ),
      connection.db
        .select({ nextRunAt: eventFeishuDigestSubscriptions.nextRunAt })
        .from(eventFeishuDigestSubscriptions)
        .where(
          and(
            eq(eventFeishuDigestSubscriptions.organizationId, organizationId),
            eq(eventFeishuDigestSubscriptions.eventId, eventId),
          ),
        ),
    ]);
    expect(Number(deliveryCount?.value)).toBe(1);
    expect(Number(outboxCount?.value)).toBe(1);
    expect(subscription?.nextRunAt?.toISOString()).toBe('2026-08-21T01:00:00.000Z');
  });
});
