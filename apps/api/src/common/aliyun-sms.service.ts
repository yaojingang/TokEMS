import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  type AliyunSmsConfiguration,
  type AliyunSmsConnectionTest,
  type TestAliyunSmsConfiguration,
  type UpdateAliyunSmsConfiguration,
} from '@conference/contracts';
import {
  auditLogs,
  organizationIntegrations,
  notificationDeliveries,
  outboxEvents,
  invoiceSmsIntegration,
  invoiceSmsPolicy,
  invoiceSmsFingerprint,
  invoiceSmsBlockReason,
  invoicePublicOrigin,
  refreshInvoiceSmsVerification,
  InvoiceSmsError,
} from '@conference/database';
import {
  ALIYUN_SMS_ENDPOINT,
  ALIYUN_SMS_TEMPLATE_META,
  AliyunSmsClient,
  readAliyunSmsConfiguration,
  type AliyunSmsCredentials,
  type AliyunSmsTemplateKey,
} from '@conference/integrations';
import { maskMobile, normalizeMainlandMobile } from '@conference/security';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  integrationEncryptionKeyVersion,
} from './integration-credentials.js';

const PROVIDER = 'aliyun-sms';

const TEST_PARAMETERS: Record<AliyunSmsTemplateKey, Record<string, string>> = {
  customerOtp: { code: '000000' },
  registrationSubmitted: {
    eventName: '短信连接测试',
    url: 'https://example.com/test',
    expiresAt: '今天 18:00',
  },
  registrationApproved: {
    eventName: '短信连接测试',
    url: 'https://example.com/test',
  },
  registrationRejected: {
    eventName: '短信连接测试',
    reason: '测试消息，无需处理',
  },
  paymentSucceeded: {
    eventName: '短信连接测试',
    orderNo: 'TEST20260729',
    amount: '0.01元',
  },
  ticketIssued: {
    eventName: '短信连接测试',
    url: 'https://example.com/ticket/test',
  },
  refundReviewed: {
    eventName: '短信连接测试',
    orderNo: 'TEST20260729',
    result: '审核通过，等待退款',
  },
  refundSucceeded: {
    eventName: '短信连接测试',
    orderNo: 'TEST20260729',
    amount: '0.01元',
  },
  waitlistAvailable: {
    name: '测试用户',
    eventName: '短信连接测试',
    expiresAt: '今天 18:00',
    url: 'https://example.com/test',
  },
  invoiceDetailsRequested: {
    eventName: '短信连接测试',
    expiresAt: '今天 18:00',
    url: 'https://example.com/test',
  },
  invoiceReady: {
    eventName: '短信连接测试',
    expiresAt: '今天 18:00',
    fileToken: 'TestFileToken000000000000',
  },
  eventReminder: {
    eventName: '短信连接测试',
    startsAt: '明天 09:00',
    venue: '测试会场',
  },
};

@Injectable()
export class AliyunSmsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private db() {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '短信服务需要 PostgreSQL 持久化模式',
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
  ): AliyunSmsCredentials | undefined {
    if (!encryptedCredentials) return undefined;
    const value = decryptIntegrationCredentials(organizationId, PROVIDER, encryptedCredentials);
    if (!value.accessKeyId || !value.accessKeySecret) return undefined;
    return {
      accessKeyId: value.accessKeyId,
      accessKeySecret: value.accessKeySecret,
    };
  }

  async getConfiguration(organizationId: string): Promise<AliyunSmsConfiguration> {
    await refreshInvoiceSmsVerification(this.db(), organizationId);
    const row = await this.integration(organizationId);
    const config = readAliyunSmsConfiguration(row?.config ?? {});
    const credentials = this.credentials(organizationId, row?.encryptedCredentials ?? null);
    const invoiceVerified = row && (await invoiceSmsBlockReason(this.db(), row, false)) === null;
    const status = invoiceVerified
      ? 'verified'
      : row?.status === 'configured' || row?.status === 'verified' || row?.status === 'error'
        ? row.status
        : 'unconfigured';
    return {
      ...config,
      invoiceFileOrigin: invoicePublicOrigin(),
      updatedAt: row?.updatedAt.toISOString() ?? null,
      status,
      lastVerifiedAt: row?.lastVerifiedAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      secretsPresent: {
        accessKeyId: Boolean(credentials?.accessKeyId),
        accessKeySecret: Boolean(credentials?.accessKeySecret),
      },
    };
  }

  async updateConfiguration(
    organizationId: string,
    actorId: string,
    input: UpdateAliyunSmsConfiguration,
  ): Promise<AliyunSmsConfiguration> {
    await this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`aliyun-sms:config:${organizationId}`}, 0))`,
      );
      const existing = await invoiceSmsIntegration(tx, organizationId, true);
      if (
        input.expectedUpdatedAt !== undefined &&
        input.expectedUpdatedAt !== (existing?.updatedAt.toISOString() ?? null)
      )
        throw new InvoiceSmsError('短信设置已被更新，请刷新后重试');
      if (Boolean(input.accessKeyId) !== Boolean(input.accessKeySecret))
        throw new InvoiceSmsError('AccessKey ID 和 Secret 需要同时更新', 400);
      const previousCredentials = this.credentials(
        organizationId,
        existing?.encryptedCredentials ?? null,
      );
      const credentials = {
        accessKeyId: input.accessKeyId ?? previousCredentials?.accessKeyId ?? '',
        accessKeySecret: input.accessKeySecret ?? previousCredentials?.accessKeySecret ?? '',
      };
      if (!credentials.accessKeyId || !credentials.accessKeySecret)
        throw new InvoiceSmsError('请填写完整短信凭据', 400);
      const encryptedCredentials =
        input.accessKeyId || !existing?.encryptedCredentials
          ? encryptIntegrationCredentials(organizationId, PROVIDER, credentials)
          : existing.encryptedCredentials;
      const previous = readAliyunSmsConfiguration(existing?.config ?? {});
      const identityChanged =
        encryptedCredentials !== existing?.encryptedCredentials ||
        previous.signName !== input.signName;
      const templates = Object.fromEntries(
        Object.entries(previous.templates).map(([key, value]) => {
          const next = input.templates[key as AliyunSmsTemplateKey] ?? value;
          const changed = identityChanged || value.templateCode !== next.templateCode;
          return [
            key,
            {
              ...next,
              status: changed ? 'unverified' : value.status,
              lastVerifiedAt: changed ? null : value.lastVerifiedAt,
              lastError: changed ? null : value.lastError,
            },
          ];
        }),
      ) as typeof previous.templates;
      const policy = {
        ...previous.invoiceSms,
        deliveryMode: input.invoiceDeliveryMode ?? previous.invoiceSms.deliveryMode,
      };
      const config = {
        enabled: input.enabled,
        signName: input.signName,
        endpoint: ALIYUN_SMS_ENDPOINT,
        templates,
        invoiceSms: policy,
      };
      const keyVersion =
        input.accessKeyId || !existing ? integrationEncryptionKeyVersion() : existing.keyVersion;
      const candidate = {
        ...existing,
        organizationId,
        config,
        encryptedCredentials,
        keyVersion,
      } as NonNullable<typeof existing>;
      const changed =
        !existing || invoiceSmsFingerprint(candidate) !== invoiceSmsFingerprint(existing);
      const toggled =
        input.enabled !== previous.enabled ||
        templates.invoiceReady.enabled !== previous.templates.invoiceReady.enabled;
      if (changed) {
        policy.verifiedFingerprint = null;
        policy.verifiedOrigin = null;
        policy.testDeliveryId = null;
        templates.invoiceReady.enabled = false;
      }
      if (changed || toggled) policy.activationRevision++;
      if (templates.invoiceReady.enabled) {
        if (!input.enabled) templates.invoiceReady.enabled = false;
        else {
          const reason = await invoiceSmsBlockReason(tx, candidate, false);
          if (reason) throw new InvoiceSmsError(reason);
        }
      }
      policy.enabledAt = templates.invoiceReady.enabled
        ? (previous.invoiceSms.enabledAt ?? new Date().toISOString())
        : null;
      const status = identityChanged ? 'configured' : (existing?.status ?? 'configured');
      const values = {
        organizationId,
        provider: PROVIDER,
        status,
        config,
        encryptedCredentials,
        keyVersion,
        updatedBy: actorId,
        updatedAt: new Date(),
        lastError: null,
        lastVerifiedAt: identityChanged ? null : (existing?.lastVerifiedAt ?? null),
      };
      await tx
        .insert(organizationIntegrations)
        .values(values)
        .onConflictDoUpdate({
          target: [organizationIntegrations.organizationId, organizationIntegrations.provider],
          set: values,
        });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'integration.aliyun_sms.update',
        resourceType: 'organization_integration',
        resourceId: existing?.id ?? organizationId,
        before: existing ? { config: previous } : null,
        after: { config },
        traceId: crypto.randomUUID(),
      });
    });
    return this.getConfiguration(organizationId);
  }

  async invoiceTestStatus(organizationId: string, deliveryId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId))
      throw new InvoiceSmsError('短信测试记录不存在', 404);
    await refreshInvoiceSmsVerification(this.db(), organizationId);
    const row = await this.integration(organizationId);
    const [delivery] = await this.db()
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.id, deliveryId),
          eq(notificationDeliveries.organizationId, organizationId),
          eq(notificationDeliveries.purpose, 'invoice_test'),
        ),
      );
    if (!delivery) throw new InvoiceSmsError('短信测试记录不存在', 404);
    const configurationMatches = Boolean(
      row &&
      invoiceSmsPolicy(row).testDeliveryId === delivery.id &&
      delivery.configurationFingerprint === invoiceSmsFingerprint(row),
    );
    return {
      deliveryId,
      status: delivery.status,
      maskedPhone: maskMobile(delivery.recipient),
      error: delivery.error,
      configurationMatches,
      fileReachable: delivery.fileReachable,
      ready: configurationMatches && delivery.fileReachable && delivery.status === 'delivered',
    };
  }

  private async queueInvoiceTest(
    organizationId: string,
    actorId: string,
    input: TestAliyunSmsConfiguration,
    attemptId: string,
  ) {
    return this.db().transaction(async (tx) => {
      const row = await invoiceSmsIntegration(tx, organizationId, true);
      if (!row || row.config.enabled !== true || !row.encryptedCredentials)
        throw new InvoiceSmsError('请先启用并保存短信服务');
      const config = readAliyunSmsConfiguration(row.config);
      if (
        config.invoiceSms.deliveryMode !== 'direct_file_v1' ||
        !config.templates.invoiceReady.templateCode
      )
        throw new InvoiceSmsError('请先保存发票文件模板 CODE');
      const phone = normalizeMainlandMobile(input.phoneNumber),
        now = new Date();
      const key = `invoice-sms:test:${organizationId}:${attemptId}`;
      const [existing] = await tx
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.businessKey, key));
      if (existing)
        return {
          ok: true,
          status: 'pending' as const,
          message: '测试短信已排队',
          deliveryId: existing.id,
          verifiedAt: now.toISOString(),
          bizId: '',
          maskedPhone: maskMobile(phone),
        };
      const [orgUsage] = await tx
        .select({ value: count() })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.organizationId, organizationId),
            eq(notificationDeliveries.purpose, 'invoice_test'),
            gte(notificationDeliveries.createdAt, new Date(Date.now() - 3600000)),
          ),
        );
      const [phoneUsage] = await tx
        .select({ value: count() })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.organizationId, organizationId),
            eq(notificationDeliveries.recipient, phone),
            eq(notificationDeliveries.purpose, 'invoice_test'),
            gte(notificationDeliveries.createdAt, new Date(Date.now() - 86400000)),
          ),
        );
      if (Number(orgUsage?.value ?? 0) >= 20 || Number(phoneUsage?.value ?? 0) >= 5)
        throw new InvoiceSmsError('测试短信发送过于频繁，请稍后再试', 429);
      const fingerprint = invoiceSmsFingerprint(row);
      const [delivery] = await tx
        .insert(notificationDeliveries)
        .values({
          organizationId,
          purpose: 'invoice_test',
          businessKey: key,
          channel: 'sms',
          recipient: phone,
          subject: '发票短信测试',
          body: '无业务数据的 PDF 测试文件',
          configurationFingerprint: fingerprint,
          status: 'queued',
        })
        .returning();
      if (!delivery) throw new Error('Unable to create invoice test');
      await tx
        .update(organizationIntegrations)
        .set({
          config: {
            ...row.config,
            invoiceSms: {
              ...config.invoiceSms,
              activationRevision: config.invoiceSms.activationRevision + 1,
              enabledAt: null,
              testDeliveryId: delivery.id,
              verifiedFingerprint: null,
              verifiedOrigin: null,
            },
            templates: {
              ...config.templates,
              invoiceReady: { ...config.templates.invoiceReady, enabled: false },
            },
          },
          updatedAt: now,
        })
        .where(eq(organizationIntegrations.id, row.id));
      await tx.insert(outboxEvents).values({
        organizationId,
        eventType: 'InvoiceSmsDeliveryRequested',
        correlationId: key,
        payload: { deliveryId: delivery.id },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'integration.aliyun_sms.test_attempt',
        resourceType: 'notification_delivery',
        resourceId: delivery.id,
        after: { templateKey: 'invoiceReady', maskedPhone: maskMobile(phone) },
        traceId: crypto.randomUUID(),
      });
      return {
        ok: true,
        status: 'pending' as const,
        message: '测试已排队；确认文件可访问并收到送达回执后可开启。',
        deliveryId: delivery.id,
        verifiedAt: now.toISOString(),
        bizId: '',
        maskedPhone: maskMobile(phone),
      };
    });
  }

  async testConnection(
    organizationId: string,
    actorId: string,
    input: TestAliyunSmsConfiguration,
    attemptId: string,
  ): Promise<AliyunSmsConnectionTest> {
    if (input.templateKey === 'invoiceReady')
      return this.queueInvoiceTest(organizationId, actorId, input, attemptId);
    const row = await this.integration(organizationId);
    const config = readAliyunSmsConfiguration(row?.config ?? {});
    const credentials = this.credentials(organizationId, row?.encryptedCredentials ?? null);
    const template = config.templates[input.templateKey];
    if (!row || !config.enabled || !credentials || !template.enabled || !template.templateCode) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '请先启用短信服务，并保存 AccessKey、短信签名和模板 CODE',
        HttpStatus.CONFLICT,
      );
    }
    const phone = normalizeMainlandMobile(input.phoneNumber);
    const maskedPhone = maskMobile(phone);
    const outId = `tokems-test-${createHash('sha256').update(attemptId).digest('hex').slice(0, 32)}`;
    await this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`aliyun-sms:test:${organizationId}:${maskedPhone}`}, 0))`,
      );
      const [existingAttempt] = await tx
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.action, 'integration.aliyun_sms.test_attempt'),
            sql`${auditLogs.after} ->> 'outId' = ${outId}`,
          ),
        )
        .limit(1);
      if (existingAttempt) {
        throw new DomainError(
          API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '该测试请求已经提交，请勿重复发送',
          HttpStatus.CONFLICT,
        );
      }
      const [organizationUsage, phoneUsage] = await Promise.all([
        tx
          .select({ value: count() })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, organizationId),
              eq(auditLogs.action, 'integration.aliyun_sms.test_attempt'),
              gte(auditLogs.createdAt, new Date(Date.now() - 60 * 60_000)),
            ),
          ),
        tx
          .select({ value: count() })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, organizationId),
              eq(auditLogs.action, 'integration.aliyun_sms.test_attempt'),
              gte(auditLogs.createdAt, new Date(Date.now() - 24 * 60 * 60_000)),
              sql`${auditLogs.after} ->> 'maskedPhone' = ${maskedPhone}`,
            ),
          ),
      ]);
      if (
        Number(organizationUsage[0]?.value ?? 0) >= 20 ||
        Number(phoneUsage[0]?.value ?? 0) >= 5
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '测试短信发送过于频繁，请稍后再试',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'integration.aliyun_sms.test_attempt',
        resourceType: 'organization_integration',
        resourceId: row.id,
        before: null,
        after: {
          status: 'started',
          templateKey: input.templateKey,
          maskedPhone,
          outId,
        },
        traceId: crypto.randomUUID(),
      });
    });
    const attemptedAt = new Date();
    let result: Awaited<ReturnType<AliyunSmsClient['send']>> | undefined;
    let failureMessage = '';
    try {
      result = await new AliyunSmsClient(credentials).send({
        phoneNumber: phone,
        signName: config.signName,
        templateCode: template.templateCode,
        templateParameters: TEST_PARAMETERS[input.templateKey],
        outId,
      });
      if (!result.accepted) {
        failureMessage = `${result.code} · ${result.message}`.slice(0, 500);
      }
    } catch (error) {
      failureMessage = (error instanceof Error ? error.message : '阿里云短信发送请求失败').slice(
        0,
        500,
      );
    }
    const ok = Boolean(result?.accepted);
    const updatedConfig = {
      ...config,
      templates: {
        ...config.templates,
        [input.templateKey]: {
          ...template,
          status: ok ? ('verified' as const) : ('error' as const),
          lastVerifiedAt: ok ? attemptedAt.toISOString() : null,
          lastError: ok ? null : failureMessage,
        },
      },
    };
    const integrationStatus = ok
      ? ('verified' as const)
      : row.status === 'verified'
        ? ('verified' as const)
        : ('error' as const);
    await this.db().transaction(async (tx) => {
      await tx
        .update(organizationIntegrations)
        .set({
          status: integrationStatus,
          config: updatedConfig,
          lastVerifiedAt: ok ? attemptedAt : row.lastVerifiedAt,
          lastError: integrationStatus === 'error' ? failureMessage : null,
          updatedBy: actorId,
          updatedAt: attemptedAt,
        })
        .where(
          and(
            eq(organizationIntegrations.organizationId, organizationId),
            eq(organizationIntegrations.provider, PROVIDER),
            eq(organizationIntegrations.updatedAt, row.updatedAt),
          ),
        );
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'integration.aliyun_sms.test',
        resourceType: 'organization_integration',
        resourceId: row.id,
        before: { status: row.status },
        after: {
          status: integrationStatus,
          templateStatus: ok ? 'verified' : 'error',
          templateKey: input.templateKey,
          templateLabel: ALIYUN_SMS_TEMPLATE_META[input.templateKey].label,
          maskedPhone,
          providerCode: result?.code ?? 'REQUEST_ERROR',
          requestId: result?.requestId ?? '',
          bizId: result?.bizId ?? '',
        },
        traceId: crypto.randomUUID(),
      });
    });
    return {
      ok,
      status: ok ? 'verified' : 'error',
      message: ok
        ? `阿里云已受理发往 ${maskedPhone} 的测试短信，接口与模板验证通过；最终送达以回执为准。`
        : failureMessage || '阿里云短信发送请求失败',
      verifiedAt: attemptedAt.toISOString(),
      bizId: result?.bizId ?? '',
      maskedPhone,
    };
  }
}
