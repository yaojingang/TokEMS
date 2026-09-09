import { createHash, randomUUID } from 'node:crypto';
import {
  FEISHU_DIGEST_LEASE_MS,
  FEISHU_DIGEST_DEDUP_MS,
  FeishuDigestSnapshotSchema,
  feishuConnectionVersion,
  feishuDigestReportWindow,
  nextFeishuDigestRun,
  type FeishuDigestDeliveryStatus,
} from '@conference/contracts';
import {
  auditLogs,
  eventFeishuDigestSubscriptions,
  events,
  feishuDigestDeliveries,
  loadFeishuDigestSnapshot,
  organizationIntegrations,
  outboxEvents,
  type ConferenceDatabase,
} from '@conference/database';
import {
  FeishuApiError,
  FeishuBotClient,
  buildFeishuDigestCard,
  serializeFeishuCard,
  buildFeishuDigestLinks,
} from '@conference/integrations';
import { decryptIntegrationCredentials, resolveDeploymentOrigins } from '@conference/security';
import { and, gt, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

const PROVIDER = 'feishu-bot';
const DIGEST_TYPE = 'daily_operations';
const GRACE_WINDOW_MS = 12 * 60 * 60_000;
const MAX_SEND_ATTEMPTS = 5;
const PROCESSING_STALE_MS = FEISHU_DIGEST_LEASE_MS;
const MAX_CACHED_FEISHU_CLIENTS = 500;
const feishuClients = new Map<string, { credentialsDigest: string; client: FeishuBotClient }>();

function safeError(error: unknown) {
  return (error instanceof FeishuApiError ? error.message : '飞书日报处理失败')
    .replaceAll(/(?:t-|u-)[A-Za-z0-9_-]{12,}/gu, '[token]')
    .slice(0, 500);
}

function chatDigest(chatId: string) {
  return createHash('sha256').update(chatId).digest('hex').slice(0, 16);
}

export function cachedFeishuClientForWorker(
  organizationId: string,
  credentials: { appId: string; appSecret: string },
  connectionVersion = 0,
) {
  const credentialsDigest = createHash('sha256')
    .update(String(connectionVersion))
    .update('\0')
    .update(credentials.appId)
    .update('\0')
    .update(credentials.appSecret)
    .digest('hex');
  const cached = feishuClients.get(organizationId);
  if (cached?.credentialsDigest === credentialsDigest) {
    feishuClients.delete(organizationId);
    feishuClients.set(organizationId, cached);
    return cached.client;
  }
  if (!cached && feishuClients.size >= MAX_CACHED_FEISHU_CLIENTS) {
    const oldestOrganizationId = feishuClients.keys().next().value;
    if (oldestOrganizationId) feishuClients.delete(oldestOrganizationId);
  }
  const client = new FeishuBotClient(credentials);
  feishuClients.set(organizationId, { credentialsDigest, client });
  return client;
}

function scheduledRunAfter(scheduledAt: Date, timeZone: string, sendLocalTime: string) {
  return nextFeishuDigestRun(new Date(scheduledAt.valueOf() + 1_000), timeZone, sendLocalTime);
}

export function feishuGeneratingDeliveryNeedsRetry(updatedAt: Date, now: Date) {
  return updatedAt.valueOf() > now.valueOf() - PROCESSING_STALE_MS;
}

export function feishuDeliveryOutsideGraceWindow(scheduledAt: Date | null, now: Date) {
  return Boolean(scheduledAt && now.valueOf() - scheduledAt.valueOf() > GRACE_WINDOW_MS);
}

export function feishuScheduledDeliveryConfigurationIssue(input: {
  eventStatus: string;
  eventTimezone: string;
  subscriptionTimezone: string;
  subscriptionEnabled: boolean;
  subscriptionChatId: string | null;
  testVerifiedChatId: string | null;
  testVerifiedAt: Date | null;
  deliveryChatId: string;
  reportDate: string;
  windowStart: Date;
  windowEnd: Date;
}) {
  if (!['prepublished', 'registration_open', 'in_progress', 'ended'].includes(input.eventStatus)) {
    return 'EVENT_NOT_ELIGIBLE';
  }
  if (
    !input.subscriptionEnabled ||
    input.subscriptionChatId !== input.deliveryChatId ||
    input.testVerifiedChatId !== input.deliveryChatId ||
    !input.testVerifiedAt
  ) {
    return 'DELIVERY_CONFIGURATION_CHANGED';
  }
  if (input.subscriptionTimezone !== input.eventTimezone) {
    return 'DELIVERY_TIMEZONE_CHANGED';
  }
  const currentWindow = feishuDigestReportWindow(
    input.windowEnd,
    input.eventTimezone,
    input.reportDate,
  );
  if (
    currentWindow.windowStart.valueOf() !== input.windowStart.valueOf() ||
    currentWindow.windowEnd.valueOf() !== input.windowEnd.valueOf()
  ) {
    return 'DELIVERY_TIMEZONE_CHANGED';
  }
  return null;
}

export function feishuDeliveryFailureStatus(
  error: unknown,
  attempts: number,
): FeishuDigestDeliveryStatus {
  if (error instanceof FeishuApiError && error.outcomeUnknown) return 'unknown';
  if (error instanceof FeishuApiError && error.retryable && attempts < MAX_SEND_ATTEMPTS) {
    return 'retrying';
  }
  return 'failed';
}

async function addTerminalDelivery(
  tx: Parameters<Parameters<ConferenceDatabase['transaction']>[0]>[0],
  subscription: typeof eventFeishuDigestSubscriptions.$inferSelect,
  report: ReturnType<typeof feishuDigestReportWindow>,
  status: 'skipped' | 'cancelled',
  reason: string,
) {
  await tx
    .insert(feishuDigestDeliveries)
    .values({
      subscriptionId: subscription.id,
      organizationId: subscription.organizationId,
      eventId: subscription.eventId,
      kind: 'scheduled',
      reportDate: report.reportDate,
      windowStart: report.windowStart,
      windowEnd: report.windowEnd,
      chatIdSnapshot: subscription.chatId ?? '',
      chatNameSnapshot: subscription.chatNameSnapshot ?? '',
      status,
      attempts: 0,
      lastErrorCode: reason,
      lastError: reason,
      dedupKey: `feishu-digest:${subscription.organizationId}:${subscription.eventId}:${DIGEST_TYPE}:${report.reportDate}`,
      scheduledAt: subscription.nextRunAt,
    })
    .onConflictDoNothing();
}

export async function enqueueDueFeishuDigests(
  db: ConferenceDatabase,
  now = new Date(),
): Promise<{ queued: number; skipped: number; cancelled: number; disabled: number }> {
  const result = { queued: 0, skipped: 0, cancelled: 0, disabled: 0 };
  const candidates = await db
    .select({
      id: eventFeishuDigestSubscriptions.id,
      eventId: eventFeishuDigestSubscriptions.eventId,
      organizationId: eventFeishuDigestSubscriptions.organizationId,
      integrationId: organizationIntegrations.id,
    })
    .from(eventFeishuDigestSubscriptions)
    .leftJoin(
      organizationIntegrations,
      and(
        eq(organizationIntegrations.organizationId, eventFeishuDigestSubscriptions.organizationId),
        eq(organizationIntegrations.provider, PROVIDER),
      ),
    )
    .where(
      and(
        eq(eventFeishuDigestSubscriptions.enabled, true),
        lte(eventFeishuDigestSubscriptions.nextRunAt, now),
      ),
    )
    .orderBy(asc(eventFeishuDigestSubscriptions.nextRunAt))
    .limit(100);
  for (const candidate of candidates) {
    const action = await db.transaction(async (tx) => {
      // Use the same integration → event → subscription order as configuration and delivery.
      const [integration] = await tx
        .select()
        .from(organizationIntegrations)
        .where(
          and(
            eq(organizationIntegrations.organizationId, candidate.organizationId),
            eq(organizationIntegrations.provider, PROVIDER),
          ),
        )
        .for('update', { skipLocked: true })
        .limit(1);
      if (!integration && candidate.integrationId) return 'deferred' as const;
      const [event] = await tx
        .select({ status: events.status, timezone: events.timezone })
        .from(events)
        .where(
          and(
            eq(events.organizationId, candidate.organizationId),
            eq(events.id, candidate.eventId),
          ),
        )
        .for('update', { skipLocked: true })
        .limit(1);
      if (!event) return 'deferred' as const;
      const [subscription] = await tx
        .select()
        .from(eventFeishuDigestSubscriptions)
        .where(eq(eventFeishuDigestSubscriptions.id, candidate.id))
        .for('update', { skipLocked: true })
        .limit(1);
      if (!subscription?.enabled || !subscription.nextRunAt || subscription.nextRunAt > now)
        return 'duplicate' as const;
      if (!event) {
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            enabled: false,
            nextRunAt: null,
            revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(eventFeishuDigestSubscriptions.id, subscription.id));
        return 'disabled' as const;
      }
      if (event.timezone !== subscription.timezoneSnapshot) {
        let nextRunAt: Date;
        try {
          nextRunAt = nextFeishuDigestRun(now, event.timezone, subscription.sendLocalTime);
        } catch {
          await tx
            .update(eventFeishuDigestSubscriptions)
            .set({
              enabled: false,
              nextRunAt: null,
              revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
              updatedAt: now,
            })
            .where(eq(eventFeishuDigestSubscriptions.id, subscription.id));
          return 'disabled' as const;
        }
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            timezoneSnapshot: event.timezone,
            configVersion: sql`${eventFeishuDigestSubscriptions.configVersion} + 1`,
            nextRunAt,
            revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(eventFeishuDigestSubscriptions.id, subscription.id));
        return 'disabled' as const;
      }

      let report: ReturnType<typeof feishuDigestReportWindow>;
      let nextRunAt: Date;
      try {
        report = feishuDigestReportWindow(subscription.nextRunAt, event.timezone);
        nextRunAt = scheduledRunAfter(
          subscription.nextRunAt,
          event.timezone,
          subscription.sendLocalTime,
        );
      } catch {
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            enabled: false,
            nextRunAt: null,
            revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(eventFeishuDigestSubscriptions.id, subscription.id));
        return 'disabled' as const;
      }
      const disable = async (status: 'skipped' | 'cancelled', reason: string) => {
        await addTerminalDelivery(tx, subscription, report, status, reason);
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            enabled: false,
            nextRunAt: null,
            revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(eventFeishuDigestSubscriptions.id, subscription.id));
      };

      if (event.status === 'archived') {
        await disable('skipped', 'event_archived');
        return 'disabled' as const;
      }
      if (!['prepublished', 'registration_open', 'in_progress', 'ended'].includes(event.status)) {
        await disable('skipped', 'event_status_not_eligible');
        return 'disabled' as const;
      }
      if (
        !subscription.chatId ||
        subscription.testVerifiedChatId !== subscription.chatId ||
        !subscription.testVerifiedAt
      ) {
        await disable('cancelled', 'target_chat_not_verified');
        return 'cancelled' as const;
      }
      if (
        integration?.status !== 'verified' ||
        (integration.config as Record<string, unknown>).enabled !== true ||
        subscription.testVerifiedConnectionVersion !== feishuConnectionVersion(integration.config)
      ) {
        await disable('cancelled', 'integration_not_verified');
        return 'cancelled' as const;
      }
      if (now.valueOf() - subscription.nextRunAt.valueOf() > GRACE_WINDOW_MS) {
        await addTerminalDelivery(tx, subscription, report, 'skipped', 'grace_window_expired');
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            nextRunAt: nextFeishuDigestRun(now, event.timezone, subscription.sendLocalTime),
            revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(eventFeishuDigestSubscriptions.id, subscription.id));
        return 'skipped' as const;
      }

      const [delivery] = await tx
        .insert(feishuDigestDeliveries)
        .values({
          subscriptionId: subscription.id,
          organizationId: subscription.organizationId,
          eventId: subscription.eventId,
          kind: 'scheduled',
          reportDate: report.reportDate,
          windowStart: report.windowStart,
          windowEnd: report.windowEnd,
          chatIdSnapshot: subscription.chatId,
          chatNameSnapshot: subscription.chatNameSnapshot ?? '未命名群聊',
          status: 'queued',
          connectionVersion: feishuConnectionVersion(integration.config),
          subscriptionConfigVersion: subscription.configVersion,
          attempts: 0,
          dedupKey: `feishu-digest:${subscription.organizationId}:${subscription.eventId}:${DIGEST_TYPE}:${report.reportDate}`,
          scheduledAt: subscription.nextRunAt,
        })
        .onConflictDoNothing()
        .returning({ id: feishuDigestDeliveries.id });
      if (delivery) {
        await tx.insert(outboxEvents).values({
          organizationId: subscription.organizationId,
          eventId: subscription.eventId,
          eventType: 'FeishuDigestDeliveryRequested',
          correlationId: `feishu-digest:${delivery.id}`,
          payload: { deliveryId: delivery.id },
        });
      }
      await tx
        .update(eventFeishuDigestSubscriptions)
        .set({
          nextRunAt,
          revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(eventFeishuDigestSubscriptions.id, subscription.id));
      return delivery ? ('queued' as const) : ('duplicate' as const);
    });
    if (action === 'queued') result.queued += 1;
    else if (action === 'skipped') result.skipped += 1;
    else if (action === 'cancelled') result.cancelled += 1;
    else if (action === 'disabled') result.disabled += 1;
  }
  return result;
}

type DeliveryRow = typeof feishuDigestDeliveries.$inferSelect;
type Tx = Parameters<Parameters<ConferenceDatabase['transaction']>[0]>[0];
export type FeishuRateGate = (appId: string, chatId: string) => Promise<number>;

export function createFeishuRateGate(redis: {
  defineCommand: (name: string, definition: { numberOfKeys: number; lua: string }) => void;
  runCommand: (name: string, args: string[]) => Promise<unknown>;
}): FeishuRateGate {
  redis.defineCommand('tokemsFeishuRateSlot', {
    numberOfKeys: 2,
    lua: `
    local app = tonumber(redis.call('GET', KEYS[1]) or '0')
    if app >= 10 or redis.call('EXISTS', KEYS[2]) == 1 then
      return math.max(redis.call('PTTL', KEYS[1]), redis.call('PTTL', KEYS[2]), 1)
    end
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('PEXPIRE', KEYS[1], 1000) end
    redis.call('SET', KEYS[2], '1', 'PX', 1000)
    return 0
  `,
  });
  return async (appId, chatId) =>
    Number(
      await redis.runCommand('tokemsFeishuRateSlot', [
        `feishu-digest:rate:app:${chatDigest(appId)}`,
        `feishu-digest:rate:chat:${chatDigest(chatId)}`,
      ]),
    );
}

async function lockSendingContext(tx: Tx, delivery: DeliveryRow) {
  const [integration] = await tx
    .select()
    .from(organizationIntegrations)
    .where(
      and(
        eq(organizationIntegrations.organizationId, delivery.organizationId),
        eq(organizationIntegrations.provider, PROVIDER),
      ),
    )
    .for('update')
    .limit(1);
  const [event] = await tx
    .select({ status: events.status, timezone: events.timezone })
    .from(events)
    .where(and(eq(events.organizationId, delivery.organizationId), eq(events.id, delivery.eventId)))
    .for('update')
    .limit(1);
  const [subscription] = delivery.subscriptionId
    ? await tx
        .select()
        .from(eventFeishuDigestSubscriptions)
        .where(
          and(
            eq(eventFeishuDigestSubscriptions.id, delivery.subscriptionId),
            eq(eventFeishuDigestSubscriptions.organizationId, delivery.organizationId),
            eq(eventFeishuDigestSubscriptions.eventId, delivery.eventId),
          ),
        )
        .for('update')
        .limit(1)
    : [];
  return { integration, event, subscription };
}
function contextIssue(
  delivery: DeliveryRow,
  context: Awaited<ReturnType<typeof lockSendingContext>>,
) {
  const { integration, event, subscription } = context;
  if (
    !integration ||
    integration.status !== 'verified' ||
    integration.config.enabled !== true ||
    !integration.encryptedCredentials ||
    delivery.connectionVersion !== feishuConnectionVersion(integration.config) ||
    !subscription ||
    subscription.configVersion !== delivery.subscriptionConfigVersion ||
    subscription.chatId !== delivery.chatIdSnapshot
  )
    return 'DELIVERY_CONFIGURATION_CHANGED';
  if (!event || event.status === 'archived') return 'EVENT_NOT_ELIGIBLE';
  if (event.timezone !== subscription.timezoneSnapshot) return 'DELIVERY_TIMEZONE_CHANGED';
  if (delivery.kind === 'scheduled')
    return (
      feishuScheduledDeliveryConfigurationIssue({
        eventStatus: event.status,
        eventTimezone: event.timezone,
        subscriptionTimezone: subscription.timezoneSnapshot,
        subscriptionEnabled: subscription.enabled,
        subscriptionChatId: subscription.chatId,
        testVerifiedChatId: subscription.testVerifiedChatId,
        testVerifiedAt: subscription.testVerifiedAt,
        deliveryChatId: delivery.chatIdSnapshot,
        reportDate: delivery.reportDate,
        windowStart: delivery.windowStart,
        windowEnd: delivery.windowEnd,
      }) ??
      (subscription.testVerifiedConnectionVersion !== delivery.connectionVersion
        ? 'DELIVERY_CONFIGURATION_CHANGED'
        : null)
    );
  if (
    delivery.kind === 'manual_resend' &&
    (!subscription.testVerifiedAt ||
      subscription.testVerifiedChatId !== delivery.chatIdSnapshot ||
      subscription.testVerifiedConnectionVersion !== delivery.connectionVersion)
  )
    return 'DELIVERY_CONFIGURATION_CHANGED';
  return null;
}
async function finalizeAccepted(
  db: ConferenceDatabase,
  row: DeliveryRow,
  messageId: string,
  sentAt: Date,
) {
  await db.transaction(async (tx) => {
    const context = await lockSendingContext(tx, row);
    const [delivery] = await tx
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.id, row.id))
      .for('update')
      .limit(1);
    if (!delivery || delivery.status === 'sent') return;
    await tx
      .update(feishuDigestDeliveries)
      .set({
        status: 'sent',
        providerMessageId: messageId,
        sentAt,
        leaseToken: null,
        leaseUntil: null,
        lastError: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(feishuDigestDeliveries.id, row.id));
    if (!contextIssue(row, context) && context.subscription) {
      await tx
        .update(eventFeishuDigestSubscriptions)
        .set({
          ...(row.kind === 'manual_test'
            ? {
                testVerifiedAt: sentAt,
                testVerifiedChatId: row.chatIdSnapshot,
                testVerifiedConnectionVersion: row.connectionVersion,
              }
            : { lastSuccessfulAt: sentAt }),
          revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(eventFeishuDigestSubscriptions.id, context.subscription.id));
    }
    await tx.insert(auditLogs).values({
      organizationId: row.organizationId,
      eventId: row.eventId,
      actorId: null,
      actorType: 'system',
      action: `digest.feishu.${row.kind}_send`,
      resourceType: 'feishu_digest_delivery',
      resourceId: row.id,
      after: {
        status: 'sent',
        chatDigest: chatDigest(row.chatIdSnapshot),
        reportDate: row.reportDate,
      },
      traceId: randomUUID(),
    });
  });
}
async function pauseRejectedTarget(
  db: ConferenceDatabase,
  row: DeliveryRow,
  error: FeishuApiError,
) {
  const credentialsRejected = [
    '10003',
    '10014',
    '10015',
    '10017',
    '10018',
    '10019',
    '10020',
  ].includes(error.code);
  const targetRejected = ['230002', '230018', '230035'].includes(error.code);
  if (!credentialsRejected && !targetRejected) return;
  await db.transaction(async (tx) => {
    const context = await lockSendingContext(tx, row);
    if (
      !context.integration ||
      feishuConnectionVersion(context.integration.config) !== row.connectionVersion
    )
      return;
    if (credentialsRejected)
      await tx
        .update(organizationIntegrations)
        .set({ status: 'error', lastError: error.message, updatedAt: new Date() })
        .where(eq(organizationIntegrations.id, context.integration.id));
    if (
      targetRejected &&
      (context.subscription?.configVersion !== row.subscriptionConfigVersion ||
        context.subscription?.chatId !== row.chatIdSnapshot)
    )
      return;
    await tx
      .update(eventFeishuDigestSubscriptions)
      .set({
        enabled: false,
        nextRunAt: null,
        pauseReason: credentialsRejected ? 'credentials_invalid' : 'chat_unavailable',
        testVerifiedAt: null,
        testVerifiedChatId: null,
        testVerifiedConnectionVersion: null,
        configVersion: sql`${eventFeishuDigestSubscriptions.configVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(eventFeishuDigestSubscriptions.organizationId, row.organizationId),
          credentialsRejected
            ? undefined
            : eq(eventFeishuDigestSubscriptions.id, row.subscriptionId!),
        ),
      );
  });
}

export async function processFeishuDigestDelivery(
  db: ConferenceDatabase,
  deliveryId: string,
  options: {
    now?: Date;
    clientFactory?: (credentials: { appId: string; appSecret: string }) => FeishuBotClient;
    adminOrigin?: string;
    acquireRateSlot?: FeishuRateGate | undefined;
  } = {},
) {
  const now = options.now ?? new Date();
  const token = randomUUID();
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.id, deliveryId))
      .for('update')
      .limit(1);
    if (!row) return null;
    if (row.providerMessageId && row.status !== 'sent') return row;
    if (row.status === 'sending') {
      if (row.leaseUntil && row.leaseUntil > now) return null;
      await tx
        .update(feishuDigestDeliveries)
        .set({
          status: 'unknown',
          lastErrorCode: 'INTERRUPTED_AFTER_SEND_STARTED',
          lastError: '发送过程已中断，暂时无法确认消息是否到达，请先查看目标群。',
          updatedAt: now,
        })
        .where(eq(feishuDigestDeliveries.id, row.id));
      return null;
    }
    if (!['queued', 'retrying', 'generating'].includes(row.status)) return null;
    if (row.leaseUntil && row.leaseUntil > now) return null;
    const [updated] = await tx
      .update(feishuDigestDeliveries)
      .set({
        status: 'generating',
        leaseToken: token,
        leaseUntil: new Date(now.valueOf() + FEISHU_DIGEST_LEASE_MS),
        updatedAt: now,
      })
      .where(eq(feishuDigestDeliveries.id, row.id))
      .returning();
    return updated ?? null;
  });
  if (!claimed) return { handled: false };
  if (claimed.providerMessageId) {
    await finalizeAccepted(db, claimed, claimed.providerMessageId, claimed.sentAt ?? now);
    return { handled: true, status: 'sent' as const };
  }
  const owns = () =>
    and(eq(feishuDigestDeliveries.id, claimed.id), eq(feishuDigestDeliveries.leaseToken, token));
  const terminal = async (
    status: 'failed' | 'cancelled' | 'skipped' | 'unknown',
    code: string,
    message: string,
  ) => {
    await db
      .update(feishuDigestDeliveries)
      .set({
        status,
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: code,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(owns());
    return { handled: true, status };
  };
  if (feishuDeliveryOutsideGraceWindow(claimed.scheduledAt, now))
    return terminal('skipped', 'GRACE_WINDOW_EXPIRED_BEFORE_SEND', '发送前已超过 12 小时窗口');
  if (
    claimed.firstSendStartedAt &&
    now.valueOf() - claimed.firstSendStartedAt.valueOf() >= FEISHU_DIGEST_DEDUP_MS
  )
    return terminal('failed', 'DEDUP_WINDOW_EXPIRED', '已超过自动重试窗口，请查看目标群后处理');
  let networkStarted = false;
  let acceptedMessageId = '';
  let attempts = claimed.attempts;
  const renewal = setInterval(() => {
    void db
      .update(feishuDigestDeliveries)
      .set({ leaseUntil: new Date(Date.now() + FEISHU_DIGEST_LEASE_MS) })
      .where(
        and(
          owns(),
          eq(feishuDigestDeliveries.status, 'generating'),
          gt(feishuDigestDeliveries.leaseUntil, new Date()),
        ),
      )
      .catch(() => undefined);
  }, 30_000);
  renewal.unref();
  try {
    const context = await db.transaction((tx) => lockSendingContext(tx, claimed));
    const issue = contextIssue(claimed, context);
    if (issue)
      return await terminal('cancelled', issue, '大会、连接或接收群已变化，原发送任务已取消');
    const credentials = decryptIntegrationCredentials(
      claimed.organizationId,
      PROVIDER,
      context.integration!.encryptedCredentials!,
    );
    if (!credentials.appId || !credentials.appSecret) throw new Error('飞书应用凭据不完整');
    const snapshot = claimed.aggregateSnapshot
      ? FeishuDigestSnapshotSchema.parse(claimed.aggregateSnapshot)
      : await loadFeishuDigestSnapshot(db, claimed.organizationId, claimed.eventId, {
          now,
          reportDate: claimed.reportDate,
        });
    const adminOrigin =
      options.adminOrigin ??
      resolveDeploymentOrigins().adminOrigin ??
      (process.env.DEPLOYMENT_MODE === 'production' ? '' : 'http://localhost:3200');
    if (
      !adminOrigin ||
      (process.env.DEPLOYMENT_MODE === 'production' && new URL(adminOrigin).protocol !== 'https:')
    )
      throw new Error('后台域名配置无效');
    const delayed =
      claimed.kind === 'scheduled' &&
      claimed.scheduledAt &&
      now.valueOf() - claimed.scheduledAt.valueOf() > 120_000;
    const card =
      claimed.cardPayload ??
      buildFeishuDigestCard(
        snapshot,
        buildFeishuDigestLinks(adminOrigin, claimed.eventId, snapshot),
        {
          test: claimed.kind === 'manual_test',
          ...(claimed.kind === 'manual_resend'
            ? { label: '补发' }
            : delayed
              ? { label: '延迟' }
              : {}),
        },
      );
    await db
      .update(feishuDigestDeliveries)
      .set({
        aggregateSnapshot: snapshot,
        cardPayload: card,
        cardDigest: createHash('sha256').update(serializeFeishuCard(card)).digest('hex'),
        generatedAt: new Date(snapshot.generatedAt),
      })
      .where(and(owns(), eq(feishuDigestDeliveries.status, 'generating')));
    let rateDelay = 0;
    if (options.acquireRateSlot) {
      try {
        rateDelay = await options.acquireRateSlot(credentials.appId, claimed.chatIdSnapshot);
      } catch {
        throw new FeishuApiError('发送服务暂时不可用，系统将在恢复后重试', {
          code: 'RATE_GATE_UNAVAILABLE',
          retryable: true,
        });
      }
    }
    if (rateDelay > 0) {
      await db
        .update(feishuDigestDeliveries)
        .set({
          status: 'retrying',
          leaseToken: null,
          leaseUntil: new Date(Date.now() + rateDelay),
          updatedAt: new Date(),
        })
        .where(owns());
      return { handled: true, status: 'retrying' as const };
    }
    const permit = await db.transaction(async (tx) => {
      const fresh = await lockSendingContext(tx, claimed);
      const freshIssue = contextIssue(claimed, fresh);
      const [row] = await tx
        .select()
        .from(feishuDigestDeliveries)
        .where(eq(feishuDigestDeliveries.id, claimed.id))
        .for('update')
        .limit(1);
      if (
        !row ||
        row.status !== 'generating' ||
        row.leaseToken !== token ||
        !row.leaseUntil ||
        row.leaseUntil <= new Date()
      )
        return false;
      if (freshIssue) {
        await tx
          .update(feishuDigestDeliveries)
          .set({
            status: 'cancelled',
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: freshIssue,
            lastError: '发送前配置已变化',
            updatedAt: new Date(),
          })
          .where(owns());
        return false;
      }
      const permitNow = new Date();
      const expiredGrace = feishuDeliveryOutsideGraceWindow(row.scheduledAt, permitNow);
      const expiredDedup =
        row.firstSendStartedAt &&
        permitNow.valueOf() - row.firstSendStartedAt.valueOf() >= FEISHU_DIGEST_DEDUP_MS;
      if (expiredGrace || expiredDedup || row.attempts >= MAX_SEND_ATTEMPTS) {
        await tx
          .update(feishuDigestDeliveries)
          .set({
            status: expiredGrace ? 'skipped' : 'failed',
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: expiredGrace
              ? 'GRACE_WINDOW_EXPIRED_BEFORE_SEND'
              : expiredDedup
                ? 'DEDUP_WINDOW_EXPIRED'
                : 'ATTEMPT_LIMIT_REACHED',
            lastError: '已超过发送或重试窗口，请查看发送记录后处理',
            updatedAt: permitNow,
          })
          .where(owns());
        return false;
      }
      attempts = row.attempts + 1;
      await tx
        .update(feishuDigestDeliveries)
        .set({
          status: 'sending',
          attempts,
          firstSendStartedAt: row.firstSendStartedAt ?? new Date(),
          leaseUntil: new Date(Date.now() + FEISHU_DIGEST_LEASE_MS),
          lastErrorCode: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(owns());
      return true;
    });
    if (!permit) return { handled: false };
    clearInterval(renewal);
    const client = options.clientFactory
      ? options.clientFactory({ appId: credentials.appId, appSecret: credentials.appSecret })
      : cachedFeishuClientForWorker(
          claimed.organizationId,
          { appId: credentials.appId, appSecret: credentials.appSecret },
          claimed.connectionVersion!,
        );
    // Recheck the sending lease immediately before handing the request to the provider.
    const [liveLease] = await db
      .select({ until: feishuDigestDeliveries.leaseUntil })
      .from(feishuDigestDeliveries)
      .where(and(owns(), eq(feishuDigestDeliveries.status, 'sending')))
      .limit(1);
    if (!liveLease?.until || liveLease.until <= new Date()) return { handled: false };
    networkStarted = true;
    const provider = await client.sendInteractiveMessage(claimed.chatIdSnapshot, card, claimed.id);
    acceptedMessageId = provider.messageId;
    const sentAt = new Date();
    await db
      .update(feishuDigestDeliveries)
      .set({ providerMessageId: provider.messageId, sentAt, updatedAt: sentAt })
      .where(owns());
    await finalizeAccepted(db, claimed, provider.messageId, sentAt);
    return { handled: true, status: 'sent' as const, providerMessageId: provider.messageId };
  } catch (error) {
    if (acceptedMessageId) {
      await db
        .update(feishuDigestDeliveries)
        .set({
          providerMessageId: acceptedMessageId,
          status: 'unknown',
          lastErrorCode: 'PROVIDER_ACCEPTED_FINALIZATION_FAILED',
          lastError: '飞书已接收，正在恢复发送记录',
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(owns());
      return { handled: true, status: 'unknown' as const };
    }
    if (networkStarted && (!(error instanceof FeishuApiError) || error.outcomeUnknown))
      return await terminal(
        'unknown',
        error instanceof FeishuApiError ? error.code : 'SEND_OUTCOME_UNKNOWN',
        safeError(error),
      );
    if (error instanceof FeishuApiError && error.retryable && attempts < MAX_SEND_ATTEMPTS) {
      const delay = Math.max(error.retryAfterMs, 30_000 * 2 ** Math.max(0, attempts - 1));
      await db
        .update(feishuDigestDeliveries)
        .set({
          status: 'retrying',
          leaseToken: null,
          leaseUntil: new Date(Date.now() + delay),
          lastErrorCode: error.code,
          lastError: safeError(error),
          updatedAt: new Date(),
        })
        .where(owns());
      return { handled: true, status: 'retrying' as const };
    }
    const result = await terminal(
      'failed',
      error instanceof FeishuApiError ? error.code : 'GENERATION_ERROR',
      safeError(error),
    );
    if (error instanceof FeishuApiError) await pauseRejectedTarget(db, claimed, error);
    return result;
  } finally {
    clearInterval(renewal);
  }
}

export async function recoverFeishuDigestDeliveries(db: ConferenceDatabase, now = new Date()) {
  const rows = await db
    .select()
    .from(feishuDigestDeliveries)
    .where(
      or(
        and(
          inArray(feishuDigestDeliveries.status, ['queued', 'retrying', 'generating', 'sending']),
          or(
            isNull(feishuDigestDeliveries.leaseUntil),
            lte(feishuDigestDeliveries.leaseUntil, now),
          ),
          lte(feishuDigestDeliveries.updatedAt, new Date(now.valueOf() - 60_000)),
        ),
        and(
          eq(feishuDigestDeliveries.status, 'unknown'),
          sql`${feishuDigestDeliveries.providerMessageId} is not null`,
        ),
      ),
    )
    .orderBy(asc(feishuDigestDeliveries.updatedAt))
    .limit(100);
  let recovered = 0;
  for (const row of rows) {
    if (row.providerMessageId) {
      await finalizeAccepted(db, row, row.providerMessageId, row.sentAt ?? now);
      recovered++;
      continue;
    }
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(feishuDigestDeliveries)
        .where(eq(feishuDigestDeliveries.id, row.id))
        .for('update', { skipLocked: true })
        .limit(1);
      if (
        !current ||
        current.updatedAt.valueOf() !== row.updatedAt.valueOf() ||
        (current.leaseUntil && current.leaseUntil > now)
      )
        return;
      if (current.status === 'sending') {
        await tx
          .update(feishuDigestDeliveries)
          .set({
            status: 'unknown',
            lastErrorCode: 'INTERRUPTED_AFTER_SEND_STARTED',
            lastError: '发送过程已中断，请先查看目标群，再确认是否补发。',
            updatedAt: now,
          })
          .where(eq(feishuDigestDeliveries.id, row.id));
      } else if (['queued', 'retrying', 'generating'].includes(current.status)) {
        await tx
          .update(feishuDigestDeliveries)
          .set({ status: 'queued', leaseToken: null, leaseUntil: null, updatedAt: now })
          .where(eq(feishuDigestDeliveries.id, row.id));
        await tx.insert(outboxEvents).values({
          organizationId: row.organizationId,
          eventId: row.eventId,
          eventType: 'FeishuDigestDeliveryRequested',
          correlationId: `feishu-digest:${row.id}`,
          payload: { deliveryId: row.id },
        });
      }
      recovered++;
    });
  }
  return {
    recovered,
    backlog: rows.length,
    oldestWaitingAt: rows[0]?.createdAt.toISOString() ?? null,
  };
}
