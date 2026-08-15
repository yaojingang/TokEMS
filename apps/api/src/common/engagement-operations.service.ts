import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  type AiGenerate,
  type AiRun,
  type CheckInDevice,
  type EventId,
  type NotificationTemplate,
  type OfflineCheckInSync,
  type QueueNotification,
} from '@conference/contracts';
import {
  aiPrompts,
  aiRuns,
  auditLogs,
  checkinDevices,
  checkinSyncBatches,
  customerProfiles,
  events,
  notificationDeliveries,
  notificationTemplates,
  orders,
  outboxEvents,
  publicUserIds,
  registrations,
  users,
} from '@conference/database';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { ConferenceRepository } from './conference.repository.js';
import { requirePublicUserId } from './public-user-id.js';
import { buildRegistrationExportCsv } from './registration-export-csv.js';

type Database = NonNullable<DatabaseService['db']>;

@Injectable()
export class EngagementOperationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConferenceRepository) private readonly conference: ConferenceRepository,
  ) {}

  private db(): Database {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '此运营能力需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private async scopedEvent(organizationId: string, eventId: EventId) {
    const [event] = await this.db()
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
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

  private aiRunFromRow(row: typeof aiRuns.$inferSelect): AiRun {
    return {
      id: row.id,
      eventId: row.eventId,
      task: row.task,
      input: row.input,
      output: row.output,
      status: row.status as 'draft' | 'approved' | 'rejected',
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
      approvedAt: row.approvedAt?.toISOString() ?? null,
    };
  }

  async listAiRuns(organizationId: string, eventId?: EventId): Promise<AiRun[]> {
    const condition = eventId
      ? and(eq(aiRuns.organizationId, organizationId), eq(aiRuns.eventId, eventId))
      : eq(aiRuns.organizationId, organizationId);
    return (
      await this.db()
        .select()
        .from(aiRuns)
        .where(condition)
        .orderBy(desc(aiRuns.createdAt))
        .limit(100)
    ).map((row) => this.aiRunFromRow(row));
  }

  async generateCopy(organizationId: string, actorId: string, input: AiGenerate): Promise<AiRun> {
    const event = await this.scopedEvent(organizationId, input.eventId);
    const [prompt] = await this.db()
      .select()
      .from(aiPrompts)
      .where(and(eq(aiPrompts.organizationId, organizationId), eq(aiPrompts.status, 'active')))
      .orderBy(desc(aiPrompts.version))
      .limit(1);
    const generated = await this.runModel({
      task: input.task,
      brief: input.brief,
      knowledge: input.knowledge,
      event: {
        name: event.name,
        tagline: event.tagline,
        description: event.description,
        city: event.city,
        venue: event.venue,
        startsAt: event.startsAt.toISOString(),
      },
      ...(prompt?.systemPrompt ? { systemPrompt: prompt.systemPrompt } : {}),
    });
    const [row] = await this.db()
      .insert(aiRuns)
      .values({
        organizationId,
        eventId: input.eventId,
        promptId: prompt?.id,
        createdBy: actorId,
        task: input.task,
        input: {
          brief: input.brief,
          knowledge: input.knowledge,
          scope: { organizationId, eventId: input.eventId },
        },
        output: generated.output,
        provider: generated.provider,
        model: generated.model,
        tokenUsage: generated.tokenUsage,
      })
      .returning();
    await this.audit(organizationId, input.eventId, actorId, 'ai.generate', 'ai_run', row!.id, {
      task: input.task,
      provider: generated.provider,
      status: 'draft',
    });
    return this.aiRunFromRow(row!);
  }

  async approveAiRun(organizationId: string, runId: string, actorId: string): Promise<AiRun> {
    const [row] = await this.db()
      .update(aiRuns)
      .set({
        status: 'approved',
        approvedBy: actorId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.organizationId, organizationId)))
      .returning();
    if (!row)
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, 'AI 文案记录不存在', HttpStatus.NOT_FOUND);
    await this.audit(organizationId, row.eventId, actorId, 'ai.approve', 'ai_run', row.id, {
      status: 'approved',
    });
    return this.aiRunFromRow(row);
  }

  private async runModel(context: {
    task: AiGenerate['task'];
    brief: string;
    knowledge: string[];
    event: Record<string, string>;
    systemPrompt?: string;
  }) {
    const apiUrl = process.env.AI_API_URL;
    const apiKey = process.env.AI_API_KEY;
    const model = process.env.AI_MODEL ?? 'conference-copywriter-local-v1';
    if (apiUrl && apiKey) {
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'system',
                content:
                  context.systemPrompt ??
                  '依据提供的大会资料生成准确、可审核的中文运营文案，禁止补充资料中没有的事实。',
              },
              { role: 'user', content: JSON.stringify(context) },
            ],
            temperature: 0.4,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`AI provider returned ${response.status}`);
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
        };
        const output = body.choices?.[0]?.message?.content?.trim();
        if (!output) throw new Error('AI provider returned an empty response');
        return {
          output,
          provider: 'configured-api',
          model,
          tokenUsage: body.usage?.total_tokens ?? 0,
        };
      } catch {
        // The deterministic local generator keeps the draft workflow available during provider outages.
      }
    }

    const eventName = context.event.name;
    const evidence = context.knowledge.filter(Boolean).slice(0, 3).join('；');
    const outputs: Record<AiGenerate['task'], string> = {
      event_tagline: `${eventName}，汇聚行业洞察、增长方法与现场实践`,
      event_description: `${eventName}将在${context.event.city}${context.event.venue}举行。${context.brief}${evidence ? ` 核心资料：${evidence}。` : ''}`,
      notification_subject: `${eventName}参会信息与现场提醒`,
      notification_body: `您好，${eventName}参会安排已经更新。${context.brief}请以大会运营平台内的时间、地点与电子票信息为准。`,
    };
    return { output: outputs[context.task], provider: 'local-deterministic', model, tokenUsage: 0 };
  }

  async listNotificationTemplates(organizationId: string): Promise<NotificationTemplate[]> {
    return (
      await this.db()
        .select()
        .from(notificationTemplates)
        .where(eq(notificationTemplates.organizationId, organizationId))
        .orderBy(asc(notificationTemplates.name), desc(notificationTemplates.version))
    ).map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      channel: row.channel as 'email' | 'sms' | 'wechat',
      subject: row.subject,
      body: row.body,
      status: row.status,
      version: row.version,
    }));
  }

  async listDeliveries(organizationId: string, eventId?: EventId) {
    const condition = eventId
      ? and(
          eq(notificationDeliveries.organizationId, organizationId),
          eq(notificationDeliveries.eventId, eventId),
        )
      : eq(notificationDeliveries.organizationId, organizationId);
    const rows = await this.db()
      .select({
        id: notificationDeliveries.id,
        organizationId: notificationDeliveries.organizationId,
        eventId: notificationDeliveries.eventId,
        templateId: notificationDeliveries.templateId,
        registrationId: notificationDeliveries.registrationId,
        channel: notificationDeliveries.channel,
        recipient: notificationDeliveries.recipient,
        subject: notificationDeliveries.subject,
        status: notificationDeliveries.status,
        providerMessageId: notificationDeliveries.providerMessageId,
        error: notificationDeliveries.error,
        scheduledAt: notificationDeliveries.scheduledAt,
        sentAt: notificationDeliveries.sentAt,
        createdAt: notificationDeliveries.createdAt,
        updatedAt: notificationDeliveries.updatedAt,
      })
      .from(notificationDeliveries)
      .where(condition)
      .orderBy(desc(notificationDeliveries.createdAt))
      .limit(100);
    return rows.map((row) => {
      const [localPart = '', domain = ''] = row.recipient.split('@');
      const maskedRecipient = domain
        ? `${localPart.slice(0, 2)}${'*'.repeat(Math.min(6, Math.max(1, localPart.length - 2)))}@${domain}`
        : `${row.recipient.slice(0, 3)}****${row.recipient.slice(-2)}`;
      return {
        ...row,
        recipient: maskedRecipient,
        body: '通知正文受保护，请在发送渠道中核对实际内容。',
      };
    });
  }

  async queueNotification(organizationId: string, actorId: string, input: QueueNotification) {
    const db = this.db();
    if (input.eventId) await this.scopedEvent(organizationId, input.eventId);
    const [template] = await db
      .select()
      .from(notificationTemplates)
      .where(
        and(
          eq(notificationTemplates.id, input.templateId),
          eq(notificationTemplates.organizationId, organizationId),
          eq(notificationTemplates.status, 'active'),
        ),
      )
      .limit(1);
    if (!template) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '通知模板不存在或未启用',
        HttpStatus.NOT_FOUND,
      );
    }
    if (input.aiRunId) {
      const [approved] = await db
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.id, input.aiRunId),
            eq(aiRuns.organizationId, organizationId),
            eq(aiRuns.status, 'approved'),
          ),
        )
        .limit(1);
      if (!approved) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'AI 文案需要审核通过后才能发送',
          HttpStatus.CONFLICT,
        );
      }
    }
    if (input.registrationId) {
      const [registration] = await db
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.id, input.registrationId),
            eq(registrations.organizationId, organizationId),
            isNull(registrations.supersededAt),
          ),
        )
        .limit(1);
      if (!registration) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
      }
    }

    const render = (value: string) =>
      value.replace(
        /\{\{([a-zA-Z0-9_]+)\}\}/g,
        (_, key: string) => input.variables[key] ?? `{{${key}}}`,
      );
    const [delivery] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(notificationDeliveries)
        .values({
          organizationId,
          eventId: input.eventId,
          templateId: template.id,
          registrationId: input.registrationId,
          channel: template.channel,
          recipient: input.recipient,
          subject: render(template.subject),
          body: render(template.body),
        })
        .returning();
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId: input.eventId,
        eventType: 'NotificationRequested',
        correlationId: `notification:${created!.id}`,
        payload: { deliveryId: created!.id, channel: created!.channel },
      });
      return [created!];
    });
    await this.audit(
      organizationId,
      input.eventId,
      actorId,
      'notification.queue',
      'notification_delivery',
      delivery!.id,
      {
        templateId: template.id,
        recipient: input.recipient,
        aiRunId: input.aiRunId ?? null,
      },
    );
    return delivery;
  }

  async listDevices(organizationId: string, eventId: EventId): Promise<CheckInDevice[]> {
    await this.scopedEvent(organizationId, eventId);
    return (
      await this.db()
        .select()
        .from(checkinDevices)
        .where(eq(checkinDevices.eventId, eventId))
        .orderBy(asc(checkinDevices.name))
    ).map((row) => ({
      id: row.id,
      eventId: row.eventId,
      deviceCode: row.deviceCode,
      name: row.name,
      status: row.status,
      capabilities: row.capabilities,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    }));
  }

  async registerDevice(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: { deviceCode: string; name: string },
  ) {
    await this.scopedEvent(organizationId, eventId);
    const token = randomBytes(32).toString('base64url');
    const [row] = await this.db()
      .insert(checkinDevices)
      .values({
        organizationId,
        eventId,
        deviceCode: input.deviceCode,
        name: input.name,
        tokenHash: createHash('sha256').update(token).digest('hex'),
      })
      .returning();
    await this.audit(
      organizationId,
      eventId,
      actorId,
      'checkin_device.register',
      'checkin_device',
      row!.id,
      {
        deviceCode: input.deviceCode,
        name: input.name,
      },
    );
    return { device: row, token };
  }

  async syncOfflineCheckins(
    organizationId: string,
    input: OfflineCheckInSync,
    deviceToken: string | undefined,
  ) {
    await this.scopedEvent(organizationId, input.eventId);
    const [device] = await this.db()
      .select()
      .from(checkinDevices)
      .where(
        and(
          eq(checkinDevices.organizationId, organizationId),
          eq(checkinDevices.eventId, input.eventId),
          eq(checkinDevices.deviceCode, input.deviceCode),
          eq(checkinDevices.status, 'active'),
        ),
      )
      .limit(1);
    if (!device) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '核销设备未注册或已停用',
        HttpStatus.FORBIDDEN,
      );
    }
    const tokenHash = deviceToken
      ? createHash('sha256').update(deviceToken).digest('hex')
      : undefined;
    if (!tokenHash || tokenHash !== device.tokenHash) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '核销设备令牌无效，请重新登记设备',
        HttpStatus.FORBIDDEN,
      );
    }
    const payloadHash = this.hash(input.records);
    const db = this.db();
    const [claimed] = await db
      .insert(checkinSyncBatches)
      .values({
        eventId: input.eventId,
        deviceId: device.id,
        batchKey: input.batchKey,
        payloadHash,
        recordsCount: input.records.length,
      })
      .onConflictDoNothing({
        target: [checkinSyncBatches.deviceId, checkinSyncBatches.batchKey],
      })
      .returning();

    if (!claimed) {
      const [cached] = await db
        .select()
        .from(checkinSyncBatches)
        .where(
          and(
            eq(checkinSyncBatches.deviceId, device.id),
            eq(checkinSyncBatches.batchKey, input.batchKey),
          ),
        )
        .limit(1);
      if (!cached || cached.payloadHash !== payloadHash) {
        throw new DomainError(
          API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '离线批次号已对应其他核销数据',
          HttpStatus.CONFLICT,
        );
      }
      if (cached.status === 'processing') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '离线批次正在同步，请稍后查询结果',
          HttpStatus.CONFLICT,
        );
      }
      if (cached.status !== 'completed') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '离线批次同步失败，请使用新的批次号重试',
          HttpStatus.CONFLICT,
        );
      }
      return {
        batchId: cached.id,
        cached: true,
        accepted: cached.acceptedCount,
        duplicate: cached.duplicateCount,
        invalid: cached.invalidCount,
        results: cached.results,
      };
    }

    try {
      const results = [] as Array<{
        localId: string;
        result: 'accepted' | 'duplicate' | 'invalid' | 'forbidden' | 'manual_review';
        message: string;
      }>;
      for (const record of input.records) {
        try {
          const result = await this.conference.checkIn(
            {
              eventId: input.eventId,
              ticketCode: record.ticketCode,
              checkInListId: input.checkInListId,
              deviceId: device.deviceCode,
            },
            organizationId,
          );
          results.push({ localId: record.localId, result: result.result, message: result.message });
        } catch (error) {
          results.push({
            localId: record.localId,
            result: 'invalid',
            message: error instanceof Error ? error.message : '核销失败',
          });
        }
      }
      const accepted = results.filter((row) => row.result === 'accepted').length;
      const duplicate = results.filter((row) => row.result === 'duplicate').length;
      const invalid = results.length - accepted - duplicate;
      await db.transaction(async (tx) => {
        await tx
          .update(checkinSyncBatches)
          .set({
            acceptedCount: accepted,
            duplicateCount: duplicate,
            invalidCount: invalid,
            status: 'completed',
            results,
            completedAt: new Date(),
          })
          .where(eq(checkinSyncBatches.id, claimed.id));
        await tx
          .update(checkinDevices)
          .set({ lastSeenAt: new Date(), updatedAt: new Date() })
          .where(eq(checkinDevices.id, device.id));
        await tx.insert(outboxEvents).values({
          organizationId,
          eventId: input.eventId,
          eventType: 'OfflineCheckInBatchSynced',
          correlationId: `offline-checkin:${claimed.id}`,
          payload: { batchId: claimed.id, accepted, duplicate, invalid },
        });
      });
      return { batchId: claimed.id, cached: false, accepted, duplicate, invalid, results };
    } catch (error) {
      await db
        .update(checkinSyncBatches)
        .set({ status: 'failed', completedAt: new Date() })
        .where(eq(checkinSyncBatches.id, claimed.id));
      throw error;
    }
  }

  async listAuditLogs(organizationId: string, eventId: EventId) {
    await this.scopedEvent(organizationId, eventId);
    const rows = await this.db()
      .select({
        audit: auditLogs,
        actorPublicId: publicUserIds.publicId,
        staffUser: users,
        customerProfile: customerProfiles,
      })
      .from(auditLogs)
      .leftJoin(
        publicUserIds,
        and(
          eq(publicUserIds.subjectUuid, auditLogs.actorId),
          sql`${publicUserIds.subjectType} = ${auditLogs.actorType}`,
        ),
      )
      .leftJoin(users, and(eq(users.id, auditLogs.actorId), eq(auditLogs.actorType, 'staff')))
      .leftJoin(
        customerProfiles,
        and(
          eq(customerProfiles.customerUserId, auditLogs.actorId),
          eq(auditLogs.actorType, 'customer'),
        ),
      )
      .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.eventId, eventId)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(300);
    return rows.map(({ audit, actorPublicId, staffUser, customerProfile }) => ({
      ...audit,
      actorId: actorPublicId,
      actorName: staffUser?.name ?? customerProfile?.realName ?? customerProfile?.nickname ?? null,
    }));
  }

  async exportRegistrationsCsv(organizationId: string, eventId: EventId, actorId: string) {
    const event = await this.scopedEvent(organizationId, eventId);
    const db = this.db();
    const actorPublicId = await requirePublicUserId(db, 'staff', actorId);
    const rows = await db
      .select({ registration: registrations, order: orders })
      .from(registrations)
      .leftJoin(orders, eq(orders.registrationId, registrations.id))
      .where(
        and(
          eq(registrations.organizationId, organizationId),
          eq(registrations.eventId, eventId),
          isNull(registrations.supersededAt),
        ),
      )
      .orderBy(asc(registrations.createdAt));
    const exportedAt = new Date().toISOString();
    const csv = buildRegistrationExportCsv(
      {
        eventName: event.name,
        actorPublicId,
        exportedAt,
        scope: `${organizationId}/${eventId}`,
      },
      rows,
    );
    await this.audit(
      organizationId,
      eventId,
      actorId,
      'registration.export',
      'event',
      String(eventId),
      {
        rowCount: rows.length,
        exportedAt,
      },
    );
    return {
      filename: `registrations-${event.slug}-${exportedAt.slice(0, 10)}.csv`,
      csv,
    };
  }

  private async audit(
    organizationId: string,
    eventId: EventId | null | undefined,
    actorId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    after: Record<string, unknown>,
  ) {
    await this.db()
      .insert(auditLogs)
      .values({
        organizationId,
        eventId: eventId ?? null,
        actorId,
        action,
        resourceType,
        resourceId,
        after,
        traceId: crypto.randomUUID(),
      });
  }
}
