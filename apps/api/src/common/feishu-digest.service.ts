import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  FeishuDigestSnapshotSchema,
  nextFeishuDigestRun,
  type EventId,
  type FeishuBotConfiguration,
  type FeishuBotVerification,
  type FeishuChatList,
  type FeishuDigestDelivery,
  type FeishuDigestSendResult,
  type FeishuDigestSnapshot,
  type FeishuDigestSubscription,
  type FeishuDigestTestMessage,
  type UpdateFeishuBotConfiguration,
  type UpdateFeishuDigestSubscription,
} from '@conference/contracts';
import {
  auditLogs,
  eventFeishuDigestSubscriptions,
  events,
  feishuDigestDeliveries,
  loadFeishuDigestSnapshot,
  organizationIntegrations,
} from '@conference/database';
import {
  FeishuApiError,
  FeishuBotClient,
  buildFeishuDigestCard,
  buildFeishuDigestLinks,
  type FeishuBotCredentials,
} from '@conference/integrations';
import { resolveDeploymentOrigins } from '@conference/security';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  integrationEncryptionKeyVersion,
} from './integration-credentials.js';

const PROVIDER = 'feishu-bot';
const DIGEST_TYPE = 'daily_operations';
const ALLOWED_AUTOMATIC_EVENT_STATUSES = new Set([
  'prepublished',
  'registration_open',
  'in_progress',
  'ended',
]);

type FeishuStoredConfiguration = {
  enabled: boolean;
  appId: string;
  appName: string;
  botOpenId: string;
};

function readStoredConfiguration(value: Record<string, unknown>): FeishuStoredConfiguration {
  return {
    enabled: value.enabled === true,
    appId: typeof value.appId === 'string' ? value.appId : '',
    appName: typeof value.appName === 'string' ? value.appName : '',
    botOpenId: typeof value.botOpenId === 'string' ? value.botOpenId : '',
  };
}

function safeError(error: unknown) {
  return (
    error instanceof FeishuApiError
      ? error.message
      : '飞书日报处理失败，请稍后重试或根据投递编号排查'
  )
    .replaceAll(/(?:t-|u-)[A-Za-z0-9_-]{12,}/gu, '[token]')
    .slice(0, 500);
}

export function feishuStatusAfterVerificationFailure(
  currentStatus: typeof organizationIntegrations.$inferSelect.status,
  retryable: boolean,
) {
  return retryable ? currentStatus : ('error' as const);
}

function chatDigest(chatId: string | null) {
  return chatId ? createHash('sha256').update(chatId).digest('hex').slice(0, 16) : null;
}

export function feishuManualDeliveryDedupKey(input: {
  kind: 'test' | 'resend';
  organizationId: string;
  eventId: EventId;
  actorId: string;
  attemptId: string;
  request: unknown;
}) {
  const digest = createHash('sha256')
    .update(input.kind)
    .update('\0')
    .update(input.organizationId)
    .update('\0')
    .update(String(input.eventId))
    .update('\0')
    .update(input.actorId)
    .update('\0')
    .update(input.attemptId)
    .update('\0')
    .update(JSON.stringify(input.request))
    .digest('hex');
  return `feishu-digest:${input.kind}:${digest}`;
}

@Injectable()
export class FeishuDigestService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private db() {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '飞书机器人需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private async integration(organizationId: string) {
    const [row] = await this.db()
      .select()
      .from(organizationIntegrations)
      .where(
        and(
          eq(organizationIntegrations.organizationId, organizationId),
          eq(organizationIntegrations.provider, PROVIDER),
        ),
      )
      .limit(1);
    return row;
  }

  private credentials(
    organizationId: string,
    encryptedCredentials: string | null,
  ): FeishuBotCredentials | undefined {
    if (!encryptedCredentials) return undefined;
    const value = decryptIntegrationCredentials(organizationId, PROVIDER, encryptedCredentials);
    if (!value.appId || !value.appSecret) return undefined;
    return { appId: value.appId, appSecret: value.appSecret };
  }

  private async client(organizationId: string, requireEnabled = true) {
    const row = await this.integration(organizationId);
    const stored = readStoredConfiguration(row?.config ?? {});
    const credentials = this.credentials(organizationId, row?.encryptedCredentials ?? null);
    if (!row || !credentials || (requireEnabled && !stored.enabled)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        requireEnabled ? '请先启用并保存飞书机器人配置' : '请先保存飞书机器人配置',
        HttpStatus.CONFLICT,
      );
    }
    return { row, stored, client: new FeishuBotClient(credentials) };
  }

  async getConfiguration(organizationId: string): Promise<FeishuBotConfiguration> {
    const row = await this.integration(organizationId);
    const stored = readStoredConfiguration(row?.config ?? {});
    const credentials = this.credentials(organizationId, row?.encryptedCredentials ?? null);
    const status =
      row?.status === 'configured' ||
      row?.status === 'verified' ||
      row?.status === 'error' ||
      row?.status === 'disabled'
        ? row.status
        : 'unconfigured';
    return {
      ...stored,
      status,
      lastVerifiedAt: row?.lastVerifiedAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      secretsPresent: { appSecret: Boolean(credentials?.appSecret) },
    };
  }

  async updateConfiguration(
    organizationId: string,
    actorId: string,
    input: UpdateFeishuBotConfiguration,
  ): Promise<FeishuBotConfiguration> {
    const existing = await this.integration(organizationId);
    const previous = readStoredConfiguration(existing?.config ?? {});
    const previousCredentials = this.credentials(
      organizationId,
      existing?.encryptedCredentials ?? null,
    );
    const appSecret = input.appSecret ?? previousCredentials?.appSecret ?? '';
    if (!appSecret) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '首次配置需要填写 App Secret',
        HttpStatus.BAD_REQUEST,
      );
    }
    const appIdChanged = input.appId !== previous.appId;
    const credentialsChanged = appIdChanged || Boolean(input.appSecret);
    const status = input.enabled
      ? !credentialsChanged && existing?.status === 'verified'
        ? 'verified'
        : 'configured'
      : 'disabled';
    const config: FeishuStoredConfiguration = {
      enabled: input.enabled,
      appId: input.appId,
      appName: appIdChanged ? '' : previous.appName,
      botOpenId: appIdChanged ? '' : previous.botOpenId,
    };
    const encryptedCredentials = encryptIntegrationCredentials(organizationId, PROVIDER, {
      appId: input.appId,
      appSecret,
    });
    const now = new Date();
    await this.db().transaction(async (tx) => {
      const values = {
        organizationId,
        provider: PROVIDER,
        status,
        config,
        encryptedCredentials,
        keyVersion: integrationEncryptionKeyVersion(),
        lastVerifiedAt: status === 'verified' ? (existing?.lastVerifiedAt ?? null) : null,
        lastError: null,
        updatedBy: actorId,
        updatedAt: now,
      };
      const [saved] = existing
        ? await tx
            .update(organizationIntegrations)
            .set({
              ...values,
              revision: sql`${organizationIntegrations.revision} + 1`,
            })
            .where(
              and(
                eq(organizationIntegrations.id, existing.id),
                eq(organizationIntegrations.revision, existing.revision),
              ),
            )
            .returning({ id: organizationIntegrations.id })
        : await tx
            .insert(organizationIntegrations)
            .values(values)
            .onConflictDoNothing()
            .returning({ id: organizationIntegrations.id });
      if (!saved) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '飞书配置已被其他管理员更新，请刷新后重试',
          HttpStatus.CONFLICT,
        );
      }
      if (!input.enabled || credentialsChanged) {
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            enabled: false,
            nextRunAt: null,
            ...(appIdChanged ? { testVerifiedAt: null, testVerifiedChatId: null } : {}),
            revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(eventFeishuDigestSubscriptions.organizationId, organizationId));
      }
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'integration.feishu.update',
        resourceType: 'organization_integration',
        resourceId: saved.id,
        before: existing
          ? { status: existing.status, appId: previous.appId, enabled: previous.enabled }
          : null,
        after: { status, appId: config.appId, enabled: config.enabled },
        traceId: randomUUID(),
      });
    });
    return this.getConfiguration(organizationId);
  }

  async verify(organizationId: string, actorId: string): Promise<FeishuBotVerification> {
    const { row, stored, client } = await this.client(organizationId, false);
    const verifiedAt = new Date();
    try {
      const bot = await client.getBotInfo();
      const chats = await client.listChats();
      const config = { ...stored, appName: bot.appName, botOpenId: bot.openId };
      await this.db().transaction(async (tx) => {
        const [updated] = await tx
          .update(organizationIntegrations)
          .set({
            status: stored.enabled ? 'verified' : 'disabled',
            config,
            lastVerifiedAt: verifiedAt,
            lastError: null,
            updatedBy: actorId,
            updatedAt: verifiedAt,
            revision: sql`${organizationIntegrations.revision} + 1`,
          })
          .where(
            and(
              eq(organizationIntegrations.id, row.id),
              eq(organizationIntegrations.revision, row.revision),
            ),
          )
          .returning({ id: organizationIntegrations.id });
        if (!updated) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '飞书配置在校验期间已变化，请使用最新配置重新校验',
            HttpStatus.CONFLICT,
          );
        }
        await tx.insert(auditLogs).values({
          organizationId,
          actorId,
          action: 'integration.feishu.verify',
          resourceType: 'organization_integration',
          resourceId: row.id,
          before: { status: row.status },
          after: {
            status: stored.enabled ? 'verified' : 'disabled',
            botOpenId: bot.openId,
            availableChatCount: chats.length,
          },
          traceId: randomUUID(),
        });
      });
      return {
        ok: true,
        status: 'verified',
        message:
          chats.length > 0
            ? `机器人连接成功，当前可选择 ${chats.length} 个已加入的群。`
            : '机器人连接成功。请由飞书群管理员将该应用机器人加入目标群，再刷新群列表。',
        verifiedAt: verifiedAt.toISOString(),
        bot,
      };
    } catch (error) {
      if (!(error instanceof FeishuApiError)) throw error;
      const message = safeError(error);
      const persistedStatus = feishuStatusAfterVerificationFailure(row.status, error.retryable);
      await this.db().transaction(async (tx) => {
        const [updated] = await tx
          .update(organizationIntegrations)
          .set({
            status: persistedStatus,
            lastError: message,
            updatedBy: actorId,
            updatedAt: verifiedAt,
            revision: sql`${organizationIntegrations.revision} + 1`,
          })
          .where(
            and(
              eq(organizationIntegrations.id, row.id),
              eq(organizationIntegrations.revision, row.revision),
            ),
          )
          .returning({ id: organizationIntegrations.id });
        if (!updated) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '飞书配置在校验期间已变化，本次失败结果未覆盖新配置',
            HttpStatus.CONFLICT,
          );
        }
        await tx.insert(auditLogs).values({
          organizationId,
          actorId,
          action: 'integration.feishu.verify',
          resourceType: 'organization_integration',
          resourceId: row.id,
          before: { status: row.status },
          after: {
            status: persistedStatus,
            attemptStatus: 'error',
            transient: error.retryable,
            errorCode: error.code,
          },
          traceId: randomUUID(),
        });
      });
      return {
        ok: false,
        status: 'error',
        message,
        verifiedAt: verifiedAt.toISOString(),
        bot: null,
      };
    }
  }

  private async reconcileUnavailableChats(
    organizationId: string,
    actorId: string,
    activeSubscriptions: Array<{
      id: string;
      eventId: EventId;
      chatId: string | null;
      revision: number;
    }>,
    visibleChatIds: Set<string>,
  ) {
    const unavailable = activeSubscriptions.filter(
      (subscription) => !subscription.chatId || !visibleChatIds.has(subscription.chatId),
    );
    if (!unavailable.length) return;
    const now = new Date();
    await this.db().transaction(async (tx) => {
      for (const subscription of unavailable) {
        const [updated] = await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            enabled: false,
            nextRunAt: null,
            testVerifiedAt: null,
            testVerifiedChatId: null,
            revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(eventFeishuDigestSubscriptions.id, subscription.id),
              eq(eventFeishuDigestSubscriptions.enabled, true),
              eq(eventFeishuDigestSubscriptions.revision, subscription.revision),
            ),
          )
          .returning({ id: eventFeishuDigestSubscriptions.id });
        if (!updated) continue;
        await tx.insert(auditLogs).values({
          organizationId,
          eventId: subscription.eventId,
          actorId,
          action: 'digest.feishu.target_unavailable',
          resourceType: 'event_feishu_digest_subscription',
          resourceId: subscription.id,
          before: {
            enabled: true,
            chatDigest: chatDigest(subscription.chatId),
          },
          after: { enabled: false, reason: 'chat_not_visible_after_refresh' },
          traceId: randomUUID(),
        });
      }
    });
  }

  async listChats(organizationId: string): Promise<FeishuChatList> {
    const { client } = await this.client(organizationId);
    try {
      const items = await client.listChats();
      return {
        items,
        refreshedAt: new Date().toISOString(),
        setupHint:
          '若目标群未出现，请由飞书组织或群管理员在群设置的“群机器人”中添加当前应用机器人，然后返回本页刷新。',
      };
    } catch (error) {
      if (!(error instanceof FeishuApiError)) throw error;
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        safeError(error),
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async refreshChats(organizationId: string, actorId: string): Promise<FeishuChatList> {
    const activeSubscriptions = await this.db()
      .select({
        id: eventFeishuDigestSubscriptions.id,
        eventId: eventFeishuDigestSubscriptions.eventId,
        chatId: eventFeishuDigestSubscriptions.chatId,
        revision: eventFeishuDigestSubscriptions.revision,
      })
      .from(eventFeishuDigestSubscriptions)
      .where(
        and(
          eq(eventFeishuDigestSubscriptions.organizationId, organizationId),
          eq(eventFeishuDigestSubscriptions.enabled, true),
        ),
      );
    const result = await this.listChats(organizationId);
    await this.reconcileUnavailableChats(
      organizationId,
      actorId,
      activeSubscriptions,
      new Set(result.items.map((item) => item.chatId)),
    );
    return result;
  }

  private async event(organizationId: string, eventId: EventId) {
    const [event] = await this.db()
      .select({
        id: events.id,
        name: events.name,
        status: events.status,
        timezone: events.timezone,
      })
      .from(events)
      .where(and(eq(events.organizationId, organizationId), eq(events.id, eventId)))
      .limit(1);
    if (!event) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    return event;
  }

  private async replayManualDelivery(dedupKey: string): Promise<FeishuDigestSendResult> {
    let [delivery] = await this.db()
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.dedupKey, dedupKey))
      .limit(1);
    if (!delivery) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '投递幂等记录读取失败',
        HttpStatus.CONFLICT,
      );
    }
    if (delivery.status === 'sending') {
      const recoveredAt = new Date();
      const [recovered] = await this.db()
        .update(feishuDigestDeliveries)
        .set({
          status: 'unknown',
          lastErrorCode: 'IDEMPOTENCY_REPLAY_AFTER_SEND_STARTED',
          lastError: '相同请求曾进入发送阶段，当前无法确认飞书是否已收到消息',
          updatedAt: recoveredAt,
        })
        .where(
          and(
            eq(feishuDigestDeliveries.id, delivery.id),
            eq(feishuDigestDeliveries.status, 'sending'),
          ),
        )
        .returning();
      if (recovered) {
        delivery = recovered;
      } else {
        [delivery] = await this.db()
          .select()
          .from(feishuDigestDeliveries)
          .where(eq(feishuDigestDeliveries.id, delivery.id))
          .limit(1);
      }
    }
    if (!delivery) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '投递幂等记录已变更，请查询投递历史',
        HttpStatus.CONFLICT,
      );
    }
    const status = delivery.status as FeishuDigestSendResult['status'];
    return {
      ok: status === 'sent',
      deliveryId: delivery.id,
      status,
      message:
        status === 'sent'
          ? '相同幂等请求已完成，已返回原投递结果'
          : '相同幂等请求已经处理，请根据当前状态查看投递详情',
      providerMessageId: delivery.providerMessageId ?? '',
      sentAt: delivery.sentAt?.toISOString() ?? null,
    };
  }

  private async subscription(organizationId: string, eventId: EventId) {
    const [row] = await this.db()
      .select()
      .from(eventFeishuDigestSubscriptions)
      .where(
        and(
          eq(eventFeishuDigestSubscriptions.organizationId, organizationId),
          eq(eventFeishuDigestSubscriptions.eventId, eventId),
          eq(eventFeishuDigestSubscriptions.digestType, DIGEST_TYPE),
        ),
      )
      .limit(1);
    return row;
  }

  async getSubscription(
    organizationId: string,
    eventId: EventId,
  ): Promise<FeishuDigestSubscription> {
    const [event, row, configuration] = await Promise.all([
      this.event(organizationId, eventId),
      this.subscription(organizationId, eventId),
      this.getConfiguration(organizationId),
    ]);
    const chatId = row?.chatId ?? null;
    return {
      eventId,
      eventName: event.name,
      eventStatus: event.status,
      timezone: event.timezone,
      enabled: row?.enabled ?? false,
      chatId,
      chatName: row?.chatNameSnapshot ?? null,
      sendLocalTime: row?.sendLocalTime ?? '09:00',
      nextRunAt: row?.nextRunAt?.toISOString() ?? null,
      lastSuccessfulAt: row?.lastSuccessfulAt?.toISOString() ?? null,
      testVerifiedAt: row?.testVerifiedAt?.toISOString() ?? null,
      targetGroupVerified: Boolean(chatId && row?.testVerifiedChatId === chatId),
      connectionStatus: configuration.status,
    };
  }

  async updateSubscription(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: UpdateFeishuDigestSubscription,
  ): Promise<FeishuDigestSubscription> {
    const [event, existing, integration] = await Promise.all([
      this.event(organizationId, eventId),
      this.subscription(organizationId, eventId),
      this.integration(organizationId),
    ]);
    const integrationConfig = readStoredConfiguration(integration?.config ?? {});
    if (input.enabled) {
      if (!integrationConfig.enabled || integration?.status !== 'verified') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '开启自动推送前需要启用并验证飞书机器人',
          HttpStatus.CONFLICT,
        );
      }
      if (!ALLOWED_AUTOMATIC_EVENT_STATUSES.has(event.status)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前大会状态暂不允许自动推送',
          HttpStatus.CONFLICT,
        );
      }
    }

    const targetChanged = input.chatId !== (existing?.chatId ?? null);
    let chatName = targetChanged ? input.chatName : (existing?.chatNameSnapshot ?? input.chatName);
    if (input.chatId && (input.enabled || targetChanged)) {
      const chats = await this.listChats(organizationId);
      const selected = chats.items.find((chat) => chat.chatId === input.chatId);
      if (!selected) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '机器人尚未加入该群。请先由飞书管理员将机器人添加到目标群，再刷新群列表。',
          HttpStatus.BAD_REQUEST,
        );
      }
      chatName = selected.name;
    }
    const targetVerified = Boolean(
      input.chatId &&
      !targetChanged &&
      existing?.testVerifiedChatId === input.chatId &&
      existing.testVerifiedAt,
    );
    if (input.enabled && !targetVerified) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '请先向当前目标群发送测试消息，确认群内可见后再开启自动推送',
        HttpStatus.CONFLICT,
      );
    }

    const now = new Date();
    const nextRunAt = input.enabled
      ? nextFeishuDigestRun(now, event.timezone, input.sendLocalTime)
      : null;
    await this.db().transaction(async (tx) => {
      const [currentIntegration] = await tx
        .select({
          id: organizationIntegrations.id,
          status: organizationIntegrations.status,
          config: organizationIntegrations.config,
          revision: organizationIntegrations.revision,
        })
        .from(organizationIntegrations)
        .where(
          and(
            eq(organizationIntegrations.organizationId, organizationId),
            eq(organizationIntegrations.provider, PROVIDER),
          ),
        )
        .for('update')
        .limit(1);
      const [currentEvent] = await tx
        .select({ status: events.status, timezone: events.timezone })
        .from(events)
        .where(and(eq(events.organizationId, organizationId), eq(events.id, eventId)))
        .for('update')
        .limit(1);
      const [currentSubscription] = await tx
        .select({
          id: eventFeishuDigestSubscriptions.id,
          revision: eventFeishuDigestSubscriptions.revision,
        })
        .from(eventFeishuDigestSubscriptions)
        .where(
          and(
            eq(eventFeishuDigestSubscriptions.organizationId, organizationId),
            eq(eventFeishuDigestSubscriptions.eventId, eventId),
            eq(eventFeishuDigestSubscriptions.digestType, DIGEST_TYPE),
          ),
        )
        .for('update')
        .limit(1);
      const currentIntegrationConfig = readStoredConfiguration(currentIntegration?.config ?? {});
      const configurationChanged =
        currentIntegration?.id !== integration?.id ||
        currentIntegration?.revision !== integration?.revision ||
        currentEvent?.status !== event.status ||
        currentEvent?.timezone !== event.timezone ||
        (existing
          ? currentSubscription?.id !== existing.id ||
            currentSubscription.revision !== existing.revision
          : Boolean(currentSubscription));
      const currentConfigurationCannotEnable =
        input.enabled &&
        (!currentIntegrationConfig.enabled || currentIntegration?.status !== 'verified');
      if (configurationChanged || currentConfigurationCannotEnable) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '大会或飞书订阅配置已变化，请刷新后重试',
          HttpStatus.CONFLICT,
        );
      }

      const values = {
        organizationId,
        eventId,
        digestType: DIGEST_TYPE,
        enabled: input.enabled,
        chatId: input.chatId,
        chatNameSnapshot: chatName,
        sendLocalTime: input.sendLocalTime,
        timezoneSnapshot: event.timezone,
        nextRunAt,
        lastSuccessfulAt: existing?.lastSuccessfulAt ?? null,
        testVerifiedAt: targetChanged ? null : (existing?.testVerifiedAt ?? null),
        testVerifiedChatId: targetChanged ? null : (existing?.testVerifiedChatId ?? null),
        updatedAt: now,
      };
      const [saved] = existing
        ? await tx
            .update(eventFeishuDigestSubscriptions)
            .set({
              enabled: values.enabled,
              chatId: values.chatId,
              chatNameSnapshot: values.chatNameSnapshot,
              sendLocalTime: values.sendLocalTime,
              timezoneSnapshot: values.timezoneSnapshot,
              nextRunAt: values.nextRunAt,
              testVerifiedAt: values.testVerifiedAt,
              testVerifiedChatId: values.testVerifiedChatId,
              revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
              updatedAt: values.updatedAt,
            })
            .where(
              and(
                eq(eventFeishuDigestSubscriptions.id, existing.id),
                eq(eventFeishuDigestSubscriptions.revision, existing.revision),
              ),
            )
            .returning({ id: eventFeishuDigestSubscriptions.id })
        : await tx
            .insert(eventFeishuDigestSubscriptions)
            .values(values)
            .onConflictDoNothing()
            .returning({ id: eventFeishuDigestSubscriptions.id });
      if (!saved) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '飞书订阅配置已变化，请刷新后重试',
          HttpStatus.CONFLICT,
        );
      }
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: 'digest.feishu.subscription.update',
        resourceType: 'event_feishu_digest_subscription',
        resourceId: saved.id,
        before: existing
          ? {
              enabled: existing.enabled,
              chatDigest: chatDigest(existing.chatId),
              sendLocalTime: existing.sendLocalTime,
            }
          : null,
        after: {
          enabled: input.enabled,
          chatDigest: chatDigest(input.chatId),
          chatName,
          sendLocalTime: input.sendLocalTime,
          nextRunAt: nextRunAt?.toISOString() ?? null,
        },
        traceId: randomUUID(),
      });
    });
    return this.getSubscription(organizationId, eventId);
  }

  async preview(organizationId: string, eventId: EventId) {
    await this.event(organizationId, eventId);
    const snapshot = await loadFeishuDigestSnapshot(this.db(), organizationId, eventId);
    return {
      snapshot,
      card: buildFeishuDigestCard(snapshot, this.links(eventId, snapshot)),
    };
  }

  private links(eventId: EventId, snapshot: FeishuDigestSnapshot) {
    return buildFeishuDigestLinks(
      resolveDeploymentOrigins().adminOrigin ?? 'http://localhost:3200',
      eventId,
      snapshot,
    );
  }

  async sendTest(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: FeishuDigestTestMessage,
    attemptId: string,
  ): Promise<FeishuDigestSendResult> {
    await this.event(organizationId, eventId);
    const [{ client }, subscription] = await Promise.all([
      this.client(organizationId),
      this.subscription(organizationId, eventId),
    ]);
    const selected = (await client.listChats()).find((chat) => chat.chatId === input.chatId);
    if (!selected) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '机器人尚未加入该群。请由飞书管理员添加机器人后刷新群列表。',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (subscription?.enabled && subscription.chatId !== selected.chatId) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '更换目标群前请先关闭当前大会的自动推送',
        HttpStatus.CONFLICT,
      );
    }
    const snapshot = await loadFeishuDigestSnapshot(this.db(), organizationId, eventId);
    const card = buildFeishuDigestCard(snapshot, this.links(eventId, snapshot), { test: true });
    const cardDigest = createHash('sha256').update(JSON.stringify(card)).digest('hex');
    const now = new Date();
    const dedupKey = feishuManualDeliveryDedupKey({
      kind: 'test',
      organizationId,
      eventId,
      actorId,
      attemptId,
      request: input,
    });
    const [delivery] = await this.db()
      .insert(feishuDigestDeliveries)
      .values({
        subscriptionId: subscription?.id ?? null,
        organizationId,
        eventId,
        kind: 'manual_test',
        reportDate: snapshot.reportDate,
        windowStart: new Date(snapshot.windowStart),
        windowEnd: new Date(snapshot.windowEnd),
        generatedAt: now,
        aggregateSnapshot: snapshot,
        cardDigest,
        chatIdSnapshot: selected.chatId,
        chatNameSnapshot: selected.name,
        status: 'sending',
        attempts: 1,
        dedupKey,
        scheduledAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: feishuDigestDeliveries.id });
    if (!delivery) {
      return this.replayManualDelivery(dedupKey);
    }

    let acceptedMessageId = '';
    try {
      const result = await client.sendInteractiveMessage(selected.chatId, card);
      acceptedMessageId = result.messageId;
      const sentAt = new Date();
      const subscriptionUpdated = await this.db().transaction(async (tx) => {
        await tx
          .update(feishuDigestDeliveries)
          .set({
            status: 'sent',
            providerMessageId: result.messageId,
            sentAt,
            updatedAt: sentAt,
          })
          .where(eq(feishuDigestDeliveries.id, delivery.id));
        const [savedSubscription] = subscription
          ? await tx
              .update(eventFeishuDigestSubscriptions)
              .set({
                chatId: selected.chatId,
                chatNameSnapshot: selected.name,
                testVerifiedAt: sentAt,
                testVerifiedChatId: selected.chatId,
                timezoneSnapshot: snapshot.event.timezone,
                revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
                updatedAt: sentAt,
              })
              .where(
                and(
                  eq(eventFeishuDigestSubscriptions.id, subscription.id),
                  eq(eventFeishuDigestSubscriptions.revision, subscription.revision),
                ),
              )
              .returning({ id: eventFeishuDigestSubscriptions.id })
          : await tx
              .insert(eventFeishuDigestSubscriptions)
              .values({
                organizationId,
                eventId,
                digestType: DIGEST_TYPE,
                enabled: false,
                chatId: selected.chatId,
                chatNameSnapshot: selected.name,
                sendLocalTime: '09:00',
                timezoneSnapshot: snapshot.event.timezone,
                nextRunAt: null,
                lastSuccessfulAt: null,
                testVerifiedAt: sentAt,
                testVerifiedChatId: selected.chatId,
                updatedAt: sentAt,
              })
              .onConflictDoNothing()
              .returning({ id: eventFeishuDigestSubscriptions.id });
        if (savedSubscription && !subscription) {
          await tx
            .update(feishuDigestDeliveries)
            .set({ subscriptionId: savedSubscription.id, updatedAt: sentAt })
            .where(eq(feishuDigestDeliveries.id, delivery.id));
        }
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'integration.feishu.test',
          resourceType: 'event_feishu_digest_subscription',
          resourceId: savedSubscription?.id ?? String(eventId),
          before: null,
          after: {
            status: 'sent',
            deliveryId: delivery.id,
            chatDigest: chatDigest(selected.chatId),
            chatName: selected.name,
            subscriptionUpdated: Boolean(savedSubscription),
          },
          traceId: randomUUID(),
        });
        return Boolean(savedSubscription);
      });
      return {
        ok: true,
        deliveryId: delivery.id,
        status: 'sent',
        message: subscriptionUpdated
          ? `测试日报已发送到“${selected.name}”`
          : `测试日报已发送到“${selected.name}”，发送期间订阅配置已变化，本次结果未更新当前目标群`,
        providerMessageId: result.messageId,
        sentAt: sentAt.toISOString(),
      };
    } catch (error) {
      const status =
        acceptedMessageId || (error instanceof FeishuApiError && error.outcomeUnknown)
          ? 'unknown'
          : 'failed';
      const message = safeError(error);
      await this.db()
        .update(feishuDigestDeliveries)
        .set({
          status,
          lastErrorCode: acceptedMessageId
            ? 'PROVIDER_ACCEPTED_FINALIZATION_FAILED'
            : error instanceof FeishuApiError
              ? error.code
              : 'REQUEST_ERROR',
          lastError: message,
          providerMessageId: acceptedMessageId || null,
          updatedAt: new Date(),
        })
        .where(eq(feishuDigestDeliveries.id, delivery.id));
      return {
        ok: false,
        deliveryId: delivery.id,
        status,
        message,
        providerMessageId: acceptedMessageId,
        sentAt: null,
      };
    }
  }

  async listDeliveries(organizationId: string, eventId: EventId): Promise<FeishuDigestDelivery[]> {
    await this.event(organizationId, eventId);
    const rows = await this.db()
      .select()
      .from(feishuDigestDeliveries)
      .where(
        and(
          eq(feishuDigestDeliveries.organizationId, organizationId),
          eq(feishuDigestDeliveries.eventId, eventId),
        ),
      )
      .orderBy(desc(feishuDigestDeliveries.createdAt))
      .limit(100);
    return rows.map((row) => ({
      id: row.id,
      sourceDeliveryId: row.sourceDeliveryId,
      kind: row.kind as FeishuDigestDelivery['kind'],
      reportDate: row.reportDate,
      chatName: row.chatNameSnapshot,
      status: row.status as FeishuDigestDelivery['status'],
      attempts: row.attempts,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      generatedAt: row.generatedAt?.toISOString() ?? null,
      sentAt: row.sentAt?.toISOString() ?? null,
      providerMessageId: row.providerMessageId ?? '',
      lastErrorCode: row.lastErrorCode ?? '',
      lastError: row.lastError ?? '',
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async resendDelivery(
    organizationId: string,
    eventId: EventId,
    deliveryId: string,
    actorId: string,
    attemptId: string,
  ): Promise<FeishuDigestSendResult> {
    await this.event(organizationId, eventId);
    const [original] = await this.db()
      .select()
      .from(feishuDigestDeliveries)
      .where(
        and(
          eq(feishuDigestDeliveries.id, deliveryId),
          eq(feishuDigestDeliveries.organizationId, organizationId),
          eq(feishuDigestDeliveries.eventId, eventId),
        ),
      )
      .limit(1);
    if (!original || !['unknown', 'failed'].includes(original.status)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '仅失败或结果不确定的投递可以人工重发',
        HttpStatus.CONFLICT,
      );
    }
    const parsedSnapshot = FeishuDigestSnapshotSchema.safeParse(original.aggregateSnapshot);
    if (!parsedSnapshot.success) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '原投递缺少可复用的聚合快照',
        HttpStatus.CONFLICT,
      );
    }
    const { client } = await this.client(organizationId);
    const target = (await client.listChats()).find(
      (chat) => chat.chatId === original.chatIdSnapshot,
    );
    if (!target) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '机器人已不在原目标群，请重新选择群并发送测试消息',
        HttpStatus.CONFLICT,
      );
    }
    const snapshot = parsedSnapshot.data;
    const card = buildFeishuDigestCard(snapshot, this.links(eventId, snapshot), { label: '补发' });
    const now = new Date();
    const dedupKey = feishuManualDeliveryDedupKey({
      kind: 'resend',
      organizationId,
      eventId,
      actorId,
      attemptId,
      request: { deliveryId },
    });
    const [delivery] = await this.db()
      .insert(feishuDigestDeliveries)
      .values({
        subscriptionId: original.subscriptionId,
        sourceDeliveryId: original.id,
        organizationId,
        eventId,
        kind: 'manual_resend',
        reportDate: original.reportDate,
        windowStart: original.windowStart,
        windowEnd: original.windowEnd,
        generatedAt: now,
        aggregateSnapshot: snapshot,
        cardDigest: createHash('sha256').update(JSON.stringify(card)).digest('hex'),
        chatIdSnapshot: original.chatIdSnapshot,
        chatNameSnapshot: target.name,
        status: 'sending',
        attempts: 1,
        dedupKey,
        scheduledAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: feishuDigestDeliveries.id });
    if (!delivery) {
      return this.replayManualDelivery(dedupKey);
    }
    let acceptedMessageId = '';
    try {
      const provider = await client.sendInteractiveMessage(original.chatIdSnapshot, card);
      acceptedMessageId = provider.messageId;
      const sentAt = new Date();
      await this.db().transaction(async (tx) => {
        await tx
          .update(feishuDigestDeliveries)
          .set({
            status: 'sent',
            providerMessageId: provider.messageId,
            sentAt,
            lastErrorCode: null,
            updatedAt: sentAt,
          })
          .where(eq(feishuDigestDeliveries.id, delivery.id));
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'digest.feishu.manual_send',
          resourceType: 'feishu_digest_delivery',
          resourceId: delivery.id,
          before: { sourceDeliveryId: original.id, sourceStatus: original.status },
          after: { status: 'sent', chatDigest: chatDigest(original.chatIdSnapshot) },
          traceId: randomUUID(),
        });
      });
      return {
        ok: true,
        deliveryId: delivery.id,
        status: 'sent',
        message: `日报已补发到“${target.name}”`,
        providerMessageId: provider.messageId,
        sentAt: sentAt.toISOString(),
      };
    } catch (error) {
      const status =
        acceptedMessageId || (error instanceof FeishuApiError && error.outcomeUnknown)
          ? 'unknown'
          : 'failed';
      const message = safeError(error);
      await this.db()
        .update(feishuDigestDeliveries)
        .set({
          status,
          lastErrorCode: acceptedMessageId
            ? 'PROVIDER_ACCEPTED_FINALIZATION_FAILED'
            : error instanceof FeishuApiError
              ? error.code
              : 'REQUEST_ERROR',
          lastError: message,
          providerMessageId: acceptedMessageId || null,
          updatedAt: new Date(),
        })
        .where(eq(feishuDigestDeliveries.id, delivery.id));
      return {
        ok: false,
        deliveryId: delivery.id,
        status,
        message,
        providerMessageId: acceptedMessageId,
        sentAt: null,
      };
    }
  }
}
