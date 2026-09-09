import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  FEISHU_DIGEST_GRACE_MS,
  FEISHU_DIGEST_HEARTBEAT_KEY,
  FeishuDigestSnapshotSchema,
  FeishuDigestSendResultSchema,
  FeishuBotConfigurationSchema,
  feishuConnectionVersion,
  feishuDigestReportWindow,
  nextFeishuDigestRun,
  type EventId,
  type FeishuBotConfiguration,
  type FeishuBotVerification,
  type FeishuChatList,
  type FeishuDigestDelivery,
  type FeishuDigestDeliveryDetail,
  type FeishuDigestRecoveryRequest,
  type FeishuDigestSendResult,
  type FeishuDigestServiceHealth,
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
  outboxEvents,
  type ConferenceDatabase,
} from '@conference/database';
import {
  FeishuApiError,
  FeishuBotClient,
  buildFeishuDigestCard,
  serializeFeishuCard,
  buildFeishuDigestLinks,
  type FeishuBotCredentials,
} from '@conference/integrations';
import { resolveDeploymentOrigins } from '@conference/security';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { RedisService } from './redis.service.js';
import { idempotencyRequestHash } from './idempotency.service.js';
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  integrationEncryptionKeyVersion,
} from './integration-credentials.js';

const PROVIDER = 'feishu-bot';
const DIGEST_TYPE = 'daily_operations';
const AUTOMATIC_STATUSES = new Set(['prepublished', 'registration_open', 'in_progress', 'ended']);
type Tx = Parameters<Parameters<ConferenceDatabase['transaction']>[0]>[0];
type DeliveryRow = typeof feishuDigestDeliveries.$inferSelect;
function storedConfig(value: Record<string, unknown>) {
  return {
    enabled: value.enabled === true,
    appId: typeof value.appId === 'string' ? value.appId : '',
    appName: typeof value.appName === 'string' ? value.appName : '',
    botOpenId: typeof value.botOpenId === 'string' ? value.botOpenId : '',
    connectionVersion: feishuConnectionVersion(value),
  };
}
function conflict(message = '配置已被其他管理员更新。请刷新后核对，再保存本次修改。'): never {
  throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION, message, HttpStatus.CONFLICT);
}
function safeError(error: unknown) {
  return error instanceof FeishuApiError
    ? error.message
    : '飞书日报处理失败，请稍后重试或根据投递编号排查';
}
function chatDigest(value: string | null) {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null;
}
export function feishuStatusAfterVerificationFailure(
  current: typeof organizationIntegrations.$inferSelect.status,
  retryable: boolean,
) {
  return retryable ? current : ('error' as const);
}
export function feishuManualDeliveryDedupKey(input: {
  kind: 'test' | 'resend';
  organizationId: string;
  eventId: EventId;
  actorId: string;
  attemptId: string;
  request: unknown;
}) {
  return `feishu-digest:${input.kind}:${createHash('sha256')
    .update(
      [
        input.kind,
        input.organizationId,
        String(input.eventId),
        input.actorId,
        input.attemptId,
      ].join('\0'),
    )
    .digest('hex')}`;
}

@Injectable()
export class FeishuDigestService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}
  private db() {
    if (!this.database.db)
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '飞书机器人需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
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
    encrypted: string | null,
  ): FeishuBotCredentials | undefined {
    if (!encrypted) return undefined;
    const value = decryptIntegrationCredentials(organizationId, PROVIDER, encrypted);
    return value.appId && value.appSecret
      ? { appId: value.appId, appSecret: value.appSecret }
      : undefined;
  }
  private async client(organizationId: string, requireEnabled = true) {
    const row = await this.integration(organizationId);
    const stored = storedConfig(row?.config ?? {});
    const credentials = this.credentials(organizationId, row?.encryptedCredentials ?? null);
    if (!row || !credentials || (requireEnabled && !stored.enabled))
      conflict('请先连接并启用飞书应用');
    return { row, stored, client: new FeishuBotClient(credentials) };
  }
  private audit(
    tx: Tx,
    organizationId: string,
    actorId: string,
    action: string,
    resourceId: string,
    after: Record<string, unknown>,
    eventId?: EventId,
  ) {
    return tx.insert(auditLogs).values({
      organizationId,
      eventId,
      actorId,
      action,
      resourceType: eventId ? 'feishu_digest' : 'organization_integration',
      resourceId,
      after,
      traceId: randomUUID(),
    });
  }
  private async cancelPending(tx: Tx, organizationId: string, eventId?: EventId) {
    await tx
      .update(feishuDigestDeliveries)
      .set({
        status: 'cancelled',
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: 'DELIVERY_CONFIGURATION_CHANGED',
        lastError: '配置已变化，原发送任务已取消',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(feishuDigestDeliveries.organizationId, organizationId),
          eventId ? eq(feishuDigestDeliveries.eventId, eventId) : undefined,
          inArray(feishuDigestDeliveries.status, ['queued', 'generating', 'retrying']),
        ),
      );
  }
  async getConfiguration(
    organizationId: string,
    includeAffectedEvents = false,
  ): Promise<FeishuBotConfiguration> {
    const row = await this.integration(organizationId);
    const stored = storedConfig(row?.config ?? {});
    const status =
      row && ['configured', 'verified', 'error', 'disabled'].includes(row.status)
        ? (row.status as FeishuBotConfiguration['status'])
        : 'unconfigured';
    const passed = row?.lastVerifiedAt && status !== 'error' ? 'passed' : 'pending';
    const savedDiagnostics = FeishuBotConfigurationSchema.shape.diagnostics.safeParse(
      row?.config.diagnostics,
    );
    const affectedEvents = includeAffectedEvents
      ? await this.db()
          .select({
            eventId: events.id,
            eventName: events.name,
            enabled: eventFeishuDigestSubscriptions.enabled,
          })
          .from(eventFeishuDigestSubscriptions)
          .innerJoin(events, eq(events.id, eventFeishuDigestSubscriptions.eventId))
          .where(eq(eventFeishuDigestSubscriptions.organizationId, organizationId))
      : [];
    return {
      ...stored,
      status,
      lastVerifiedAt: row?.lastVerifiedAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      secretsPresent: { appSecret: Boolean(row?.encryptedCredentials) },
      diagnostics: savedDiagnostics.success
        ? savedDiagnostics.data
        : {
            credentials: status === 'error' ? 'failed' : passed,
            bot: passed,
            chats: passed,
            sending: 'verify_by_test',
          },
      affectedEvents,
    };
  }
  async updateConfiguration(
    organizationId: string,
    actorId: string,
    input: UpdateFeishuBotConfiguration,
  ) {
    const existing = await this.integration(organizationId);
    const previous = storedConfig(existing?.config ?? {});
    if (input.expectedConnectionVersion !== previous.connectionVersion) conflict();
    const oldCredentials = this.credentials(organizationId, existing?.encryptedCredentials ?? null);
    const appChanged = input.appId !== previous.appId;
    const appSecret = input.appSecret ?? (!appChanged ? oldCredentials?.appSecret : '') ?? '';
    if (!appSecret) conflict('首次连接或更换应用时，请填写对应的应用密钥。');
    const credentialsChanged = appChanged || appSecret !== oldCredentials?.appSecret;
    const changed = !existing || credentialsChanged || input.enabled !== previous.enabled;
    let bot = { appName: previous.appName, openId: previous.botOpenId };
    if (input.enabled) {
      try {
        const candidate = new FeishuBotClient({ appId: input.appId, appSecret });
        bot = await candidate.getBotInfo();
        await candidate.listChats();
      } catch (error) {
        if (!(error instanceof FeishuApiError)) throw error;
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          `${safeError(error)}${existing ? ' 当前连接仍保留。' : ''}`,
          HttpStatus.BAD_GATEWAY,
        );
      }
    }
    const now = new Date();
    const config = {
      enabled: input.enabled,
      appId: input.appId,
      appName: bot.appName,
      botOpenId: bot.openId,
      connectionVersion: previous.connectionVersion + (changed ? 1 : 0),
      diagnostics: {
        credentials: 'passed',
        bot: 'passed',
        chats: 'passed',
        sending: 'verify_by_test',
      },
    };
    await this.db().transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(organizationIntegrations)
        .where(
          and(
            eq(organizationIntegrations.organizationId, organizationId),
            eq(organizationIntegrations.provider, PROVIDER),
          ),
        )
        .for('update')
        .limit(1);
      if (
        current?.id !== existing?.id ||
        feishuConnectionVersion(current?.config ?? {}) !== input.expectedConnectionVersion
      )
        conflict();
      const values = {
        organizationId,
        provider: PROVIDER,
        status: input.enabled ? 'verified' : 'disabled',
        config,
        encryptedCredentials: encryptIntegrationCredentials(organizationId, PROVIDER, {
          appId: input.appId,
          appSecret,
        }),
        keyVersion: integrationEncryptionKeyVersion(),
        lastVerifiedAt: input.enabled ? now : (current?.lastVerifiedAt ?? null),
        lastError: null,
        updatedBy: actorId,
        updatedAt: now,
      };
      const [saved] = current
        ? await tx
            .update(organizationIntegrations)
            .set({ ...values, revision: sql`${organizationIntegrations.revision} + 1` })
            .where(eq(organizationIntegrations.id, current.id))
            .returning()
        : await tx
            .insert(organizationIntegrations)
            .values(values)
            .onConflictDoNothing()
            .returning();
      if (!saved) conflict();
      if (changed) {
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            enabled: false,
            nextRunAt: null,
            testVerifiedAt: null,
            testVerifiedChatId: null,
            testVerifiedConnectionVersion: null,
            pauseReason: input.enabled ? 'connection_changed' : 'connection_disabled',
            configVersion: sql`${eventFeishuDigestSubscriptions.configVersion} + 1`,
            revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(eventFeishuDigestSubscriptions.organizationId, organizationId));
        await this.cancelPending(tx, organizationId);
      }
      await this.audit(tx, organizationId, actorId, 'integration.feishu.update', saved.id, {
        enabled: config.enabled,
        appId: config.appId,
        connectionVersion: config.connectionVersion,
      });
    });
    return this.getConfiguration(organizationId, true);
  }
  async verify(organizationId: string, actorId: string): Promise<FeishuBotVerification> {
    const { row, stored, client } = await this.client(organizationId, false);
    const now = new Date();
    let bot: { appName: string; openId: string } | null = null;
    let error: FeishuApiError | null = null;
    let chats = 0;
    const diagnostics: FeishuBotConfiguration['diagnostics'] = {
      credentials: 'pending',
      bot: 'pending',
      chats: 'pending',
      sending: 'verify_by_test',
    };
    try {
      bot = await client.getBotInfo();
      diagnostics.credentials = 'passed';
      diagnostics.bot = 'passed';
      chats = (await client.listChats()).filter((chat) => chat.selectable).length;
      diagnostics.chats = 'passed';
    } catch (caught) {
      if (!(caught instanceof FeishuApiError)) throw caught;
      error = caught;
      if (bot) diagnostics.chats = 'failed';
      else if (caught.code === 'FEISHU_BOT_NOT_ACTIVE' || caught.code === '230006') {
        diagnostics.credentials = 'passed';
        diagnostics.bot = 'failed';
      } else diagnostics.credentials = caught.retryable ? 'pending' : 'failed';
    }
    await this.db().transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(organizationIntegrations)
        .where(eq(organizationIntegrations.id, row.id))
        .for('update')
        .limit(1);
      if (!current || feishuConnectionVersion(current.config) !== stored.connectionVersion)
        conflict('校验期间连接已变化，请重新检查。');
      await tx
        .update(organizationIntegrations)
        .set({
          status: error
            ? feishuStatusAfterVerificationFailure(
                current.status,
                ![
                  '10003',
                  '10014',
                  '10015',
                  '10017',
                  '10018',
                  '10019',
                  '10020',
                  'FEISHU_BOT_NOT_ACTIVE',
                  '230006',
                ].includes(error.code),
              )
            : stored.enabled
              ? 'verified'
              : 'disabled',
          config: {
            ...current.config,
            diagnostics,
            ...(bot ? { appName: bot.appName, botOpenId: bot.openId } : {}),
          },
          lastVerifiedAt: error ? current.lastVerifiedAt : now,
          lastError: error ? safeError(error) : null,
          revision: sql`${organizationIntegrations.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(organizationIntegrations.id, row.id));
      await this.audit(tx, organizationId, actorId, 'integration.feishu.verify', row.id, {
        ok: !error,
        errorCode: error?.code ?? '',
        connectionVersion: stored.connectionVersion,
      });
    });
    return {
      ok: !error,
      status: error ? 'error' : 'verified',
      message: error
        ? safeError(error)
        : `连接检查完成，可选择 ${chats} 个群。发送权限将在试发时验证。`,
      verifiedAt: now.toISOString(),
      bot,
    };
  }
  async listChats(organizationId: string): Promise<FeishuChatList> {
    const { stored, client } = await this.client(organizationId);
    try {
      const items = await client.listChats();
      if (
        feishuConnectionVersion((await this.integration(organizationId))?.config ?? {}) !==
        stored.connectionVersion
      )
        conflict();
      return {
        connectionVersion: stored.connectionVersion,
        items,
        refreshedAt: new Date().toISOString(),
        setupHint: '请在飞书目标群的「设置 → 群机器人」中添加当前应用机器人，然后返回刷新。',
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
  async refreshChats(organizationId: string, actorId: string) {
    const initial = await this.db()
      .select({
        id: eventFeishuDigestSubscriptions.id,
        revision: eventFeishuDigestSubscriptions.revision,
        configVersion: eventFeishuDigestSubscriptions.configVersion,
        chatId: eventFeishuDigestSubscriptions.chatId,
      })
      .from(eventFeishuDigestSubscriptions)
      .where(eq(eventFeishuDigestSubscriptions.organizationId, organizationId));
    const baseline = new Map(initial.map((sub) => [sub.id, sub]));
    const result = await this.listChats(organizationId);
    const visible = new Map(result.items.map((chat) => [chat.chatId, chat]));
    await this.db().transaction(async (tx) => {
      const [integration] = await tx
        .select()
        .from(organizationIntegrations)
        .where(
          and(
            eq(organizationIntegrations.organizationId, organizationId),
            eq(organizationIntegrations.provider, PROVIDER),
          ),
        )
        .for('update')
        .limit(1);
      if (feishuConnectionVersion(integration?.config ?? {}) !== result.connectionVersion)
        conflict();
      const subscriptions = await tx
        .select()
        .from(eventFeishuDigestSubscriptions)
        .where(eq(eventFeishuDigestSubscriptions.organizationId, organizationId))
        .for('update');
      for (const sub of subscriptions) {
        const before = baseline.get(sub.id);
        if (
          !sub.chatId ||
          !before ||
          sub.revision !== before.revision ||
          sub.configVersion !== before.configVersion ||
          sub.chatId !== before.chatId
        )
          continue;
        const chat = visible.get(sub.chatId);
        if (
          chat &&
          (chat.selectable ||
            (chat.external !== true && !['dissolved', 'dissolved_save'].includes(chat.status)))
        ) {
          if (chat.name !== sub.chatNameSnapshot)
            await tx
              .update(eventFeishuDigestSubscriptions)
              .set({ chatNameSnapshot: chat.name })
              .where(eq(eventFeishuDigestSubscriptions.id, sub.id));
          continue;
        }
        await tx
          .update(eventFeishuDigestSubscriptions)
          .set({
            enabled: false,
            nextRunAt: null,
            testVerifiedAt: null,
            testVerifiedChatId: null,
            testVerifiedConnectionVersion: null,
            pauseReason: 'chat_unavailable',
            configVersion: sub.configVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(eventFeishuDigestSubscriptions.id, sub.id));
        await this.cancelPending(tx, organizationId, sub.eventId);
        await this.audit(
          tx,
          organizationId,
          actorId,
          'digest.feishu.target_unavailable',
          sub.id,
          { chatDigest: chatDigest(sub.chatId) },
          sub.eventId,
        );
      }
    });
    return result;
  }
  private async event(organizationId: string, eventId: EventId) {
    const [row] = await this.db()
      .select()
      .from(events)
      .where(and(eq(events.organizationId, organizationId), eq(events.id, eventId)))
      .limit(1);
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    return row;
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
  async serviceHealth(): Promise<FeishuDigestServiceHealth> {
    const unavailable = { ready: false, queueReachable: false, lastScanAt: null, buildSha: '' };
    try {
      const client = this.redis.getClient();
      const [pong, raw] = await Promise.all([
        client.ping(),
        client.get(FEISHU_DIGEST_HEARTBEAT_KEY),
      ]);
      if (!raw) return { ...unavailable, queueReachable: pong === 'PONG' };
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object') return unavailable;
      const heartbeat = value as Record<string, unknown>;
      const lastScanAt =
        typeof heartbeat.lastScanAt === 'string' &&
        Number.isFinite(Date.parse(heartbeat.lastScanAt))
          ? heartbeat.lastScanAt
          : null;
      return {
        queueReachable: pong === 'PONG',
        lastScanAt,
        buildSha: typeof heartbeat.buildSha === 'string' ? heartbeat.buildSha : '',
        ready:
          pong === 'PONG' &&
          lastScanAt !== null &&
          Date.now() - Date.parse(lastScanAt) < 180_000 &&
          Date.parse(lastScanAt) <= Date.now() + 5_000,
      };
    } catch {
      return unavailable;
    }
  }
  async getSubscription(
    organizationId: string,
    eventId: EventId,
  ): Promise<FeishuDigestSubscription> {
    const [event, row, configuration, serviceHealth] = await Promise.all([
      this.event(organizationId, eventId),
      this.subscription(organizationId, eventId),
      this.getConfiguration(organizationId),
      this.serviceHealth(),
    ]);
    return {
      eventId,
      eventName: event.name,
      eventStatus: event.status,
      timezone: event.timezone,
      configVersion: row?.configVersion ?? 0,
      connectionVersion: configuration.connectionVersion,
      pauseReason: row?.pauseReason ?? null,
      serviceHealth,
      enabled: row?.enabled ?? false,
      chatId: row?.chatId ?? null,
      chatName: row?.chatNameSnapshot ?? null,
      sendLocalTime: row?.sendLocalTime ?? '09:00',
      nextRunAt: row?.nextRunAt?.toISOString() ?? null,
      lastSuccessfulAt: row?.lastSuccessfulAt?.toISOString() ?? null,
      testVerifiedAt: row?.testVerifiedAt?.toISOString() ?? null,
      targetGroupVerified: Boolean(
        row?.chatId &&
        row.testVerifiedChatId === row.chatId &&
        row.testVerifiedAt &&
        row.testVerifiedConnectionVersion === configuration.connectionVersion,
      ),
      connectionStatus: configuration.status,
    };
  }
  private async lockedContext(tx: Tx, organizationId: string, eventId: EventId) {
    const [integration] = await tx
      .select()
      .from(organizationIntegrations)
      .where(
        and(
          eq(organizationIntegrations.organizationId, organizationId),
          eq(organizationIntegrations.provider, PROVIDER),
        ),
      )
      .for('update')
      .limit(1);
    const [event] = await tx
      .select()
      .from(events)
      .where(and(eq(events.organizationId, organizationId), eq(events.id, eventId)))
      .for('update')
      .limit(1);
    const [subscription] = await tx
      .select()
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
    if (!event)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    return { integration, event, subscription, config: storedConfig(integration?.config ?? {}) };
  }
  private checkVersions(
    context: Awaited<ReturnType<FeishuDigestService['lockedContext']>>,
    input: { expectedConfigVersion: number; expectedConnectionVersion: number },
  ) {
    if (
      (context.subscription?.configVersion ?? 0) !== input.expectedConfigVersion ||
      context.config.connectionVersion !== input.expectedConnectionVersion
    )
      conflict();
  }
  private checkedAdminOrigin() {
    const origin = resolveDeploymentOrigins().adminOrigin;
    if (
      process.env.DEPLOYMENT_MODE === 'production' &&
      (!origin || new URL(origin).protocol !== 'https:')
    )
      conflict('正式开启前需要配置有效的 HTTPS 后台域名。');
    return origin ?? 'http://localhost:3200';
  }
  async updateSubscription(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: UpdateFeishuDigestSubscription,
  ) {
    await this.event(organizationId, eventId);
    const current = await this.subscription(organizationId, eventId);
    let selectedName = current?.chatNameSnapshot ?? input.chatName;
    if (input.chatId && (input.enabled || input.chatId !== current?.chatId)) {
      const chats = await this.listChats(organizationId);
      if (chats.connectionVersion !== input.expectedConnectionVersion) conflict();
      const chat = chats.items.find((item) => item.chatId === input.chatId && item.selectable);
      if (!chat) conflict('请选择机器人已加入的企业内部正常群。');
      selectedName = chat.name;
    }
    if (input.enabled) {
      this.checkedAdminOrigin();
      if (!(await this.serviceHealth()).ready)
        conflict('自动发送服务暂未就绪，配置已保留。恢复后可继续开启。');
    }
    await this.db().transaction(async (tx) => {
      const context = await this.lockedContext(tx, organizationId, eventId);
      this.checkVersions(context, input);
      const { subscription: sub, event, integration, config } = context;
      const targetChanged = input.chatId !== (sub?.chatId ?? null);
      if (event.status === 'archived' && input.enabled) conflict('大会已归档，发送记录仍可查看。');
      if (
        input.enabled &&
        (!AUTOMATIC_STATUSES.has(event.status) ||
          !config.enabled ||
          integration?.status !== 'verified')
      )
        conflict('请先验证应用连接，并核对大会是否已进入可推送阶段。');
      if (
        input.enabled &&
        (targetChanged ||
          !sub?.testVerifiedAt ||
          sub.testVerifiedChatId !== input.chatId ||
          sub.testVerifiedConnectionVersion !== config.connectionVersion)
      )
        conflict('请先向当前目标群发送测试日报，再开启每日推送。');
      const changed =
        !sub ||
        targetChanged ||
        sub.enabled !== input.enabled ||
        sub.sendLocalTime !== input.sendLocalTime ||
        sub.timezoneSnapshot !== event.timezone;
      const now = new Date();
      const values = {
        organizationId,
        eventId,
        digestType: DIGEST_TYPE,
        enabled: input.enabled,
        chatId: input.chatId,
        chatNameSnapshot: selectedName,
        sendLocalTime: input.sendLocalTime,
        timezoneSnapshot: event.timezone,
        nextRunAt: input.enabled
          ? changed
            ? nextFeishuDigestRun(now, event.timezone, input.sendLocalTime)
            : sub?.nextRunAt
          : null,
        testVerifiedAt: targetChanged ? null : (sub?.testVerifiedAt ?? null),
        testVerifiedChatId: targetChanged ? null : (sub?.testVerifiedChatId ?? null),
        testVerifiedConnectionVersion: targetChanged
          ? null
          : (sub?.testVerifiedConnectionVersion ?? null),
        configVersion: (sub?.configVersion ?? 0) + (changed ? 1 : 0),
        pauseReason: input.enabled ? null : targetChanged ? 'target_changed' : 'paused_by_admin',
        updatedAt: now,
      };
      const [saved] = sub
        ? await tx
            .update(eventFeishuDigestSubscriptions)
            .set({ ...values, revision: sql`${eventFeishuDigestSubscriptions.revision} + 1` })
            .where(eq(eventFeishuDigestSubscriptions.id, sub.id))
            .returning()
        : await tx
            .insert(eventFeishuDigestSubscriptions)
            .values(values)
            .onConflictDoNothing()
            .returning();
      if (!saved) conflict();
      if (changed) await this.cancelPending(tx, organizationId, eventId);
      await this.audit(
        tx,
        organizationId,
        actorId,
        'digest.feishu.subscription.update',
        saved.id,
        {
          enabled: input.enabled,
          chatDigest: chatDigest(input.chatId),
          configVersion: values.configVersion,
          sendLocalTime: input.sendLocalTime,
        },
        eventId,
      );
    });
    return this.getSubscription(organizationId, eventId);
  }
  private links(eventId: EventId, snapshot: FeishuDigestSnapshot) {
    return buildFeishuDigestLinks(this.checkedAdminOrigin(), eventId, snapshot);
  }
  async preview(organizationId: string, eventId: EventId) {
    await this.event(organizationId, eventId);
    const snapshot = await loadFeishuDigestSnapshot(this.db(), organizationId, eventId);
    return { snapshot, card: buildFeishuDigestCard(snapshot, this.links(eventId, snapshot)) };
  }
  private result(row: DeliveryRow): FeishuDigestSendResult {
    return {
      ok: row.status === 'sent',
      deliveryId: row.id,
      status: row.status as FeishuDigestSendResult['status'],
      message: row.status === 'sent' ? '日报已发送' : '任务已保存，可在发送记录查看进度',
      providerMessageId: row.providerMessageId ?? '',
      sentAt: row.sentAt?.toISOString() ?? null,
    };
  }
  private async replay(
    dedupKey: string,
    requestHash: string,
    tx: Tx | ConferenceDatabase = this.db(),
  ) {
    const [row] = await tx
      .select()
      .from(feishuDigestDeliveries)
      .where(eq(feishuDigestDeliveries.dedupKey, dedupKey))
      .limit(1);
    if (row && row.requestHash !== requestHash)
      throw new DomainError(
        API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        '同一发送操作已用于不同请求，请刷新后重试。',
        HttpStatus.CONFLICT,
      );
    return row ? this.result(row) : null;
  }
  private outbox(tx: Tx, row: DeliveryRow) {
    return tx.insert(outboxEvents).values({
      organizationId: row.organizationId,
      eventId: row.eventId,
      eventType: 'FeishuDigestDeliveryRequested',
      correlationId: `feishu-digest:${row.id}`,
      payload: { deliveryId: row.id },
    });
  }
  async sendTest(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: FeishuDigestTestMessage,
    attemptId: string,
  ): Promise<FeishuDigestSendResult> {
    await this.event(organizationId, eventId);
    const dedupKey = feishuManualDeliveryDedupKey({
      kind: 'test',
      organizationId,
      eventId,
      actorId,
      attemptId,
      request: input,
    });
    const requestHash = idempotencyRequestHash(input);
    const replay = await this.replay(dedupKey, requestHash);
    if (replay) return replay;
    const chats = await this.listChats(organizationId);
    if (chats.connectionVersion !== input.expectedConnectionVersion) conflict();
    const selected = chats.items.find((chat) => chat.chatId === input.chatId && chat.selectable);
    if (!selected) conflict('请选择机器人已加入的企业内部正常群。');
    this.checkedAdminOrigin();
    return this.db().transaction(async (tx) => {
      const context = await this.lockedContext(tx, organizationId, eventId);
      const existing = await this.replay(dedupKey, requestHash, tx);
      if (existing) return existing;
      this.checkVersions(context, input);
      const { subscription: sub, integration, config, event } = context;
      if (
        !input.dataVisibilityConfirmed ||
        !sub ||
        sub.chatId !== input.chatId ||
        !config.enabled ||
        integration?.status !== 'verified' ||
        event.status === 'archived'
      )
        conflict('请先保存当前接收群并验证应用连接，再发送测试日报。');
      const now = new Date();
      const report = feishuDigestReportWindow(now, event.timezone);
      const [delivery] = await tx
        .insert(feishuDigestDeliveries)
        .values({
          subscriptionId: sub.id,
          organizationId,
          eventId,
          kind: 'manual_test',
          ...report,
          chatIdSnapshot: selected.chatId,
          chatNameSnapshot: selected.name,
          status: 'queued',
          dedupKey,
          requestHash,
          scheduledAt: now,
          connectionVersion: config.connectionVersion,
          subscriptionConfigVersion: sub.configVersion,
        })
        .returning();
      await this.outbox(tx, delivery!);
      await this.audit(
        tx,
        organizationId,
        actorId,
        'integration.feishu.test',
        delivery!.id,
        {
          status: 'queued',
          dataVisibilityConfirmed: true,
          chatDigest: chatDigest(selected.chatId),
        },
        eventId,
      );
      return this.result(delivery!);
    });
  }
  private async delivery(
    organizationId: string,
    eventId: EventId,
    deliveryId: string,
    tx: Tx | ConferenceDatabase = this.db(),
  ) {
    const [row] = await tx
      .select()
      .from(feishuDigestDeliveries)
      .where(
        and(
          eq(feishuDigestDeliveries.organizationId, organizationId),
          eq(feishuDigestDeliveries.eventId, eventId),
          eq(feishuDigestDeliveries.id, deliveryId),
        ),
      )
      .limit(1);
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '发送记录不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    return row;
  }
  private availableActions(
    row: DeliveryRow,
    sub: typeof eventFeishuDigestSubscriptions.$inferSelect | undefined,
    config: ReturnType<typeof storedConfig>,
    eventStatus: string,
    connectionStatus: string | undefined,
  ): FeishuDigestDelivery['availableActions'] {
    const actions: FeishuDigestDelivery['availableActions'] = [];
    if (row.status === 'unknown' && !row.resolution && !row.providerMessageId)
      actions.push('resolve');
    const matches =
      sub &&
      config.enabled &&
      connectionStatus === 'verified' &&
      row.connectionVersion === config.connectionVersion &&
      row.subscriptionConfigVersion === sub.configVersion &&
      row.chatIdSnapshot === sub.chatId &&
      eventStatus !== 'archived';
    if (!matches || row.resolution || row.providerMessageId) return actions;
    if (
      row.status === 'failed' &&
      (row.kind !== 'scheduled' ||
        (AUTOMATIC_STATUSES.has(eventStatus) &&
          sub.enabled &&
          sub.testVerifiedAt &&
          sub.testVerifiedChatId === sub.chatId &&
          sub.testVerifiedConnectionVersion === config.connectionVersion)) &&
      !row.aggregateSnapshot &&
      !row.firstSendStartedAt &&
      row.scheduledAt &&
      Date.now() - row.scheduledAt.valueOf() <= FEISHU_DIGEST_GRACE_MS
    )
      actions.push('regenerate');
    if (
      ['failed', 'unknown'].includes(row.status) &&
      row.aggregateSnapshot &&
      sub.testVerifiedAt &&
      sub.testVerifiedChatId === sub.chatId &&
      sub.testVerifiedConnectionVersion === config.connectionVersion
    )
      actions.push('resend');
    return actions;
  }
  private view(
    row: DeliveryRow,
    availableActions: FeishuDigestDelivery['availableActions'],
  ): FeishuDigestDelivery {
    return {
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
      resolution: row.resolution,
      availableActions,
    };
  }
  async listDeliveries(organizationId: string, eventId: EventId) {
    const [event, sub, integration] = await Promise.all([
      this.event(organizationId, eventId),
      this.subscription(organizationId, eventId),
      this.integration(organizationId),
    ]);
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
    return rows.map((row) =>
      this.view(
        row,
        this.availableActions(
          row,
          sub,
          storedConfig(integration?.config ?? {}),
          event.status,
          integration?.status,
        ),
      ),
    );
  }
  async deliveryDetail(
    organizationId: string,
    eventId: EventId,
    deliveryId: string,
  ): Promise<FeishuDigestDeliveryDetail> {
    const [event, sub, integration, row] = await Promise.all([
      this.event(organizationId, eventId),
      this.subscription(organizationId, eventId),
      this.integration(organizationId),
      this.delivery(organizationId, eventId, deliveryId),
    ]);
    const snapshot = FeishuDigestSnapshotSchema.safeParse(row.aggregateSnapshot);
    return {
      ...this.view(
        row,
        this.availableActions(
          row,
          sub,
          storedConfig(integration?.config ?? {}),
          event.status,
          integration?.status,
        ),
      ),
      snapshot: snapshot.success ? snapshot.data : null,
      card: row.cardPayload,
    };
  }
  private async replayRecovery(
    tx: Tx,
    organizationId: string,
    eventId: EventId,
    actorId: string,
    action: string,
    dedupKey: string,
    requestHash: string,
  ) {
    const [receipt] = await tx
      .select({ after: auditLogs.after })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.eventId, eventId),
          eq(auditLogs.actorId, actorId),
          eq(auditLogs.action, `digest.feishu.${action}`),
          sql`${auditLogs.after}->>'idempotencyKeyHash' = ${dedupKey}`,
        ),
      )
      .limit(1);
    if (!receipt) return null;
    if (receipt.after?.requestHash !== requestHash)
      conflict('同一操作标识已用于不同请求，请刷新后重试。');
    return FeishuDigestSendResultSchema.parse(receipt.after?.response);
  }
  async recoverDelivery(
    organizationId: string,
    eventId: EventId,
    deliveryId: string,
    actorId: string,
    attemptId: string,
    action: 'resend' | 'regenerate' | 'resolve',
    input: FeishuDigestRecoveryRequest,
  ) {
    await this.event(organizationId, eventId);
    const dedupKey = feishuManualDeliveryDedupKey({
      kind: 'resend',
      organizationId,
      eventId,
      actorId,
      attemptId: `${action}:${attemptId}`,
      request: { deliveryId, input },
    });
    const requestHash = idempotencyRequestHash({ deliveryId, input });
    if (action === 'resend') {
      const replay = await this.replay(dedupKey, requestHash);
      if (replay) return replay;
    }
    return this.db().transaction(async (tx) => {
      const context = await this.lockedContext(tx, organizationId, eventId);
      if (action === 'resend') {
        const replay = await this.replay(dedupKey, requestHash, tx);
        if (replay) return replay;
      }
      if (action !== 'resend') {
        const replay = await this.replayRecovery(
          tx,
          organizationId,
          eventId,
          actorId,
          action,
          dedupKey,
          requestHash,
        );
        if (replay) return replay;
      }
      this.checkVersions(context, input);
      const [row] = await tx
        .select()
        .from(feishuDigestDeliveries)
        .where(
          and(
            eq(feishuDigestDeliveries.organizationId, organizationId),
            eq(feishuDigestDeliveries.eventId, eventId),
            eq(feishuDigestDeliveries.id, deliveryId),
          ),
        )
        .for('update')
        .limit(1);
      if (
        !row ||
        !this.availableActions(
          row,
          context.subscription,
          context.config,
          context.event.status,
          context.integration?.status,
        ).includes(action)
      )
        conflict('当前记录无法执行此操作，请刷新后查看可用操作。');
      if (action === 'resolve') {
        await tx
          .update(feishuDigestDeliveries)
          .set({
            resolution: { kind: 'received', actorId, at: new Date().toISOString() },
            updatedAt: new Date(),
          })
          .where(eq(feishuDigestDeliveries.id, row.id));
        await this.audit(
          tx,
          organizationId,
          actorId,
          'digest.feishu.resolve',
          row.id,
          {
            resolution: 'received',
            technicalStatus: row.status,
            idempotencyKeyHash: dedupKey,
            requestHash,
            response: this.result(row),
          },
          eventId,
        );
        return this.result(row);
      }
      if (action === 'regenerate') {
        const [updated] = await tx
          .update(feishuDigestDeliveries)
          .set({
            status: 'queued',
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: null,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(feishuDigestDeliveries.id, row.id))
          .returning();
        await this.outbox(tx, updated!);
        await this.audit(
          tx,
          organizationId,
          actorId,
          'digest.feishu.regenerate',
          row.id,
          {
            status: 'queued',
            idempotencyKeyHash: dedupKey,
            requestHash,
            response: this.result(updated!),
          },
          eventId,
        );
        return this.result(updated!);
      }
      if (!input.confirmResend) conflict('请先在目标群核对消息，并明确确认补发。');
      const snapshot = FeishuDigestSnapshotSchema.parse(row.aggregateSnapshot);
      const card = buildFeishuDigestCard(snapshot, this.links(eventId, snapshot), {
        label: '补发',
      });
      const [child] = await tx
        .insert(feishuDigestDeliveries)
        .values({
          subscriptionId: row.subscriptionId,
          sourceDeliveryId: row.id,
          organizationId,
          eventId,
          kind: 'manual_resend',
          reportDate: row.reportDate,
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
          aggregateSnapshot: snapshot,
          cardPayload: card,
          cardDigest: createHash('sha256').update(serializeFeishuCard(card)).digest('hex'),
          generatedAt: new Date(snapshot.generatedAt),
          chatIdSnapshot: row.chatIdSnapshot,
          chatNameSnapshot: context.subscription!.chatNameSnapshot ?? row.chatNameSnapshot,
          status: 'queued',
          dedupKey,
          requestHash,
          scheduledAt: new Date(),
          connectionVersion: row.connectionVersion,
          subscriptionConfigVersion: row.subscriptionConfigVersion,
        })
        .returning();
      await tx
        .update(feishuDigestDeliveries)
        .set({
          resolution: {
            kind: 'resent',
            actorId,
            at: new Date().toISOString(),
            childDeliveryId: child!.id,
          },
          updatedAt: new Date(),
        })
        .where(eq(feishuDigestDeliveries.id, row.id));
      await this.outbox(tx, child!);
      await this.audit(
        tx,
        organizationId,
        actorId,
        'digest.feishu.manual_send',
        child!.id,
        { sourceDeliveryId: row.id, status: 'queued', confirmResend: true },
        eventId,
      );
      return this.result(child!);
    });
  }
}
