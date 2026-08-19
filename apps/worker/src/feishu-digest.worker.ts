import { createHash, randomUUID } from 'node:crypto';
import {
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
  buildFeishuDigestLinks,
} from '@conference/integrations';
import { decryptIntegrationCredentials, resolveDeploymentOrigins } from '@conference/security';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';

const PROVIDER = 'feishu-bot';
const DIGEST_TYPE = 'daily_operations';
const GRACE_WINDOW_MS = 12 * 60 * 60_000;
const MAX_SEND_ATTEMPTS = 5;
const PROCESSING_STALE_MS = 10 * 60_000;
const MAX_CACHED_FEISHU_CLIENTS = 500;
const feishuClients = new Map<string, { credentialsDigest: string; client: FeishuBotClient }>();

class RetryableFeishuDeliveryError extends Error {
  constructor(readonly original: unknown) {
    super(safeError(original));
    this.name = 'RetryableFeishuDeliveryError';
  }
}

class FeishuDeliveryAlreadyProcessingError extends Error {
  constructor() {
    super('飞书日报仍在处理中，稍后重试');
    this.name = 'FeishuDeliveryAlreadyProcessingError';
  }
}

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
) {
  const credentialsDigest = createHash('sha256')
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
  for (let index = 0; index < 100; index += 1) {
    const action = await db.transaction(async (tx) => {
      const [subscription] = await tx
        .select()
        .from(eventFeishuDigestSubscriptions)
        .where(
          and(
            eq(eventFeishuDigestSubscriptions.enabled, true),
            lte(eventFeishuDigestSubscriptions.nextRunAt, now),
          ),
        )
        .orderBy(asc(eventFeishuDigestSubscriptions.nextRunAt))
        .for('update', { skipLocked: true })
        .limit(1);
      if (!subscription?.nextRunAt) return 'done' as const;

      const [event] = await tx
        .select({ status: events.status, timezone: events.timezone })
        .from(events)
        .where(
          and(
            eq(events.organizationId, subscription.organizationId),
            eq(events.id, subscription.eventId),
          ),
        )
        .limit(1);
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
      const [integration] = await tx
        .select({
          status: organizationIntegrations.status,
          config: organizationIntegrations.config,
        })
        .from(organizationIntegrations)
        .where(
          and(
            eq(organizationIntegrations.organizationId, subscription.organizationId),
            eq(organizationIntegrations.provider, PROVIDER),
          ),
        )
        .limit(1);
      if (
        integration?.status !== 'verified' ||
        (integration.config as Record<string, unknown>).enabled !== true
      ) {
        await disable('cancelled', 'integration_not_verified');
        return 'cancelled' as const;
      }
      if (now.valueOf() - subscription.nextRunAt.valueOf() > GRACE_WINDOW_MS) {
        await addTerminalDelivery(tx, subscription, report, 'skipped', 'grace_window_expired');
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            nextRunAt,
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
    if (action === 'done') break;
    if (action === 'queued') result.queued += 1;
    else if (action === 'skipped') result.skipped += 1;
    else if (action === 'cancelled') result.cancelled += 1;
    else if (action === 'disabled') result.disabled += 1;
  }
  return result;
}

export async function processFeishuDigestDelivery(
  db: ConferenceDatabase,
  deliveryId: string,
  options: {
    now?: Date;
    clientFactory?: (credentials: { appId: string; appSecret: string }) => FeishuBotClient;
    adminOrigin?: string;
  } = {},
) {
  const now = options.now ?? new Date();
  const claimed = await db.transaction(async (tx) => {
    const [delivery] = await tx
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.id, deliveryId))
      .for('update')
      .limit(1);
    if (!delivery) return null;
    if (delivery.status === 'sending') {
      await tx
        .update(feishuDigestDeliveries)
        .set({
          status: 'unknown',
          lastErrorCode: 'INTERRUPTED_AFTER_SEND_STARTED',
          lastError: '发送过程曾中断，无法确认飞书是否已经收到消息',
          updatedAt: now,
        })
        .where(eq(feishuDigestDeliveries.id, delivery.id));
      return null;
    }
    if (delivery.status === 'generating') {
      if (feishuGeneratingDeliveryNeedsRetry(delivery.updatedAt, now)) {
        throw new FeishuDeliveryAlreadyProcessingError();
      }
    } else if (!['queued', 'retrying'].includes(delivery.status)) {
      return null;
    }
    const [updated] = await tx
      .update(feishuDigestDeliveries)
      .set({ status: 'generating', updatedAt: now })
      .where(eq(feishuDigestDeliveries.id, delivery.id))
      .returning();
    return updated ?? null;
  });
  if (!claimed) return { handled: false };

  if (claimed.kind === 'scheduled' && feishuDeliveryOutsideGraceWindow(claimed.scheduledAt, now)) {
    await db
      .update(feishuDigestDeliveries)
      .set({
        status: 'skipped',
        lastErrorCode: 'GRACE_WINDOW_EXPIRED_BEFORE_SEND',
        lastError: '发送前已超过 12 小时补发窗口',
        updatedAt: now,
      })
      .where(eq(feishuDigestDeliveries.id, claimed.id));
    return { handled: true, status: 'skipped' as const };
  }

  let acceptedMessageId = '';
  try {
    const [[subscription], [integration], [event]] = await Promise.all([
      db
        .select()
        .from(eventFeishuDigestSubscriptions)
        .where(eq(eventFeishuDigestSubscriptions.id, claimed.subscriptionId ?? ''))
        .limit(1),
      db
        .select()
        .from(organizationIntegrations)
        .where(
          and(
            eq(organizationIntegrations.organizationId, claimed.organizationId),
            eq(organizationIntegrations.provider, PROVIDER),
          ),
        )
        .limit(1),
      db
        .select({ status: events.status, timezone: events.timezone })
        .from(events)
        .where(
          and(eq(events.organizationId, claimed.organizationId), eq(events.id, claimed.eventId)),
        )
        .limit(1),
    ]);
    const integrationConfig = (integration?.config ?? {}) as Record<string, unknown>;
    const configurationIssue =
      subscription && event
        ? feishuScheduledDeliveryConfigurationIssue({
            eventStatus: event.status,
            eventTimezone: event.timezone,
            subscriptionTimezone: subscription.timezoneSnapshot,
            subscriptionEnabled: subscription.enabled,
            subscriptionChatId: subscription.chatId,
            testVerifiedChatId: subscription.testVerifiedChatId,
            testVerifiedAt: subscription.testVerifiedAt,
            deliveryChatId: claimed.chatIdSnapshot,
            reportDate: claimed.reportDate,
            windowStart: claimed.windowStart,
            windowEnd: claimed.windowEnd,
          })
        : 'DELIVERY_CONFIGURATION_CHANGED';
    if (
      configurationIssue ||
      integration?.status !== 'verified' ||
      integrationConfig.enabled !== true ||
      !integration.encryptedCredentials
    ) {
      await db
        .update(feishuDigestDeliveries)
        .set({
          status: 'cancelled',
          lastErrorCode: configurationIssue ?? 'DELIVERY_CONFIGURATION_CHANGED',
          lastError:
            configurationIssue === 'EVENT_NOT_ELIGIBLE'
              ? '发送前大会状态已不允许自动推送'
              : configurationIssue === 'DELIVERY_TIMEZONE_CHANGED'
                ? '发送前大会时区已变化，原统计窗口已取消'
                : '发送前配置已停用、未验证或目标群已变化',
          updatedAt: now,
        })
        .where(eq(feishuDigestDeliveries.id, claimed.id));
      return { handled: true, status: 'cancelled' as const };
    }
    const credentials = decryptIntegrationCredentials(
      claimed.organizationId,
      PROVIDER,
      integration.encryptedCredentials,
    );
    if (!credentials.appId || !credentials.appSecret) {
      throw new Error('飞书机器人凭据不完整');
    }
    const snapshot = await loadFeishuDigestSnapshot(db, claimed.organizationId, claimed.eventId, {
      now,
      reportDate: claimed.reportDate,
    });
    const adminOrigin =
      options.adminOrigin ?? resolveDeploymentOrigins().adminOrigin ?? 'http://localhost:3200';
    const card = buildFeishuDigestCard(
      snapshot,
      buildFeishuDigestLinks(adminOrigin, claimed.eventId, snapshot),
    );
    const cardDigest = createHash('sha256').update(JSON.stringify(card)).digest('hex');
    const attempts = claimed.attempts + 1;
    await db
      .update(feishuDigestDeliveries)
      .set({
        status: 'sending',
        aggregateSnapshot: snapshot,
        cardDigest,
        generatedAt: now,
        attempts,
        lastErrorCode: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(feishuDigestDeliveries.id, claimed.id));

    const client = options.clientFactory
      ? options.clientFactory({ appId: credentials.appId, appSecret: credentials.appSecret })
      : cachedFeishuClientForWorker(claimed.organizationId, {
          appId: credentials.appId,
          appSecret: credentials.appSecret,
        });
    try {
      const provider = await client.sendInteractiveMessage(claimed.chatIdSnapshot, card);
      acceptedMessageId = provider.messageId;
      const sentAt = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(feishuDigestDeliveries)
          .set({
            status: 'sent',
            providerMessageId: provider.messageId,
            sentAt,
            updatedAt: sentAt,
          })
          .where(eq(feishuDigestDeliveries.id, claimed.id));
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            lastSuccessfulAt: sentAt,
            revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
            updatedAt: sentAt,
          })
          .where(eq(eventFeishuDigestSubscriptions.id, subscription!.id));
        await tx.insert(auditLogs).values({
          organizationId: claimed.organizationId,
          eventId: claimed.eventId,
          actorId: null,
          actorType: 'system',
          action: 'digest.feishu.scheduled_send',
          resourceType: 'feishu_digest_delivery',
          resourceId: claimed.id,
          before: null,
          after: {
            status: 'sent',
            reportDate: claimed.reportDate,
            chatDigest: chatDigest(claimed.chatIdSnapshot),
          },
          traceId: randomUUID(),
        });
      });
      return { handled: true, status: 'sent' as const, providerMessageId: provider.messageId };
    } catch (error) {
      if (acceptedMessageId) throw error;
      const status = feishuDeliveryFailureStatus(error, attempts);
      await db
        .update(feishuDigestDeliveries)
        .set({
          status,
          lastErrorCode: error instanceof FeishuApiError ? error.code : 'REQUEST_ERROR',
          lastError: safeError(error),
          updatedAt: new Date(),
        })
        .where(eq(feishuDigestDeliveries.id, claimed.id));
      if (status === 'retrying') throw new RetryableFeishuDeliveryError(error);
      return { handled: true, status };
    }
  } catch (error) {
    if (error instanceof RetryableFeishuDeliveryError) throw error.original;
    const message = safeError(error);
    const attempts = claimed.attempts + 1;
    const status = acceptedMessageId
      ? 'unknown'
      : attempts < MAX_SEND_ATTEMPTS
        ? 'retrying'
        : 'failed';
    await db
      .update(feishuDigestDeliveries)
      .set({
        status,
        attempts,
        providerMessageId: acceptedMessageId || null,
        lastErrorCode: acceptedMessageId
          ? 'PROVIDER_ACCEPTED_FINALIZATION_FAILED'
          : error instanceof FeishuApiError
            ? error.code
            : 'GENERATION_ERROR',
        lastError: message,
        updatedAt: new Date(),
      })
      .where(and(eq(feishuDigestDeliveries.id, claimed.id), isNull(feishuDigestDeliveries.sentAt)));
    throw error;
  }
}
