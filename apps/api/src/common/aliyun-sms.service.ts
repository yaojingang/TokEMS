import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  type AliyunSmsConfiguration,
  type AliyunSmsConnectionTest,
  type TestAliyunSmsConfiguration,
  type UpdateAliyunSmsConfiguration,
} from '@conference/contracts';
import { auditLogs, organizationIntegrations } from '@conference/database';
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
    url: 'https://example.com/test',
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
    const row = await this.integration(organizationId);
    const config = readAliyunSmsConfiguration(row?.config ?? {});
    const credentials = this.credentials(organizationId, row?.encryptedCredentials ?? null);
    const status =
      row?.status === 'configured' || row?.status === 'verified' || row?.status === 'error'
        ? row.status
        : 'unconfigured';
    return {
      ...config,
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
    const existing = await this.integration(organizationId);
    const previousCredentials = this.credentials(
      organizationId,
      existing?.encryptedCredentials ?? null,
    );
    if (Boolean(input.accessKeyId) !== Boolean(input.accessKeySecret)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'AccessKey ID 和 AccessKey Secret 需要同时更新',
        HttpStatus.BAD_REQUEST,
      );
    }
    const credentials: AliyunSmsCredentials = {
      accessKeyId: input.accessKeyId ?? previousCredentials?.accessKeyId ?? '',
      accessKeySecret: input.accessKeySecret ?? previousCredentials?.accessKeySecret ?? '',
    };
    if (!credentials.accessKeyId || !credentials.accessKeySecret) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '首次配置需要填写完整的 AccessKey ID 和 AccessKey Secret',
        HttpStatus.BAD_REQUEST,
      );
    }
    const previousConfig = readAliyunSmsConfiguration(existing?.config ?? {});
    const credentialsChanged = Boolean(input.accessKeyId && input.accessKeySecret);
    const identityChanged =
      credentialsChanged || (Boolean(existing) && previousConfig.signName !== input.signName);
    const templates = Object.fromEntries(
      Object.entries(input.templates).map(([key, next]) => {
        const templateKey = key as AliyunSmsTemplateKey;
        const previous = previousConfig.templates[templateKey];
        const unchanged =
          !identityChanged &&
          previous.enabled === next.enabled &&
          previous.templateCode === next.templateCode;
        return [
          templateKey,
          {
            ...next,
            status: unchanged ? previous.status : 'unverified',
            lastVerifiedAt: unchanged ? previous.lastVerifiedAt : null,
            lastError: unchanged ? previous.lastError : null,
          },
        ];
      }),
    ) as ReturnType<typeof readAliyunSmsConfiguration>['templates'];
    const preservedStatus =
      !identityChanged && (existing?.status === 'verified' || existing?.status === 'error')
        ? existing.status
        : 'configured';
    const config = {
      enabled: input.enabled,
      signName: input.signName,
      endpoint: ALIYUN_SMS_ENDPOINT,
      templates,
    };
    const encryptedCredentials = encryptIntegrationCredentials(
      organizationId,
      PROVIDER,
      credentials,
    );
    const now = new Date();
    await this.db().transaction(async (tx) => {
      await tx
        .insert(organizationIntegrations)
        .values({
          organizationId,
          provider: PROVIDER,
          status: preservedStatus,
          config,
          encryptedCredentials,
          keyVersion: integrationEncryptionKeyVersion(),
          lastVerifiedAt:
            preservedStatus === 'verified' ? (existing?.lastVerifiedAt ?? null) : null,
          lastError: preservedStatus === 'error' ? (existing?.lastError ?? null) : null,
          updatedBy: actorId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [organizationIntegrations.organizationId, organizationIntegrations.provider],
          set: {
            status: preservedStatus,
            config,
            encryptedCredentials,
            keyVersion: integrationEncryptionKeyVersion(),
            lastVerifiedAt:
              preservedStatus === 'verified' ? (existing?.lastVerifiedAt ?? null) : null,
            lastError: preservedStatus === 'error' ? (existing?.lastError ?? null) : null,
            updatedBy: actorId,
            updatedAt: now,
          },
        });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'integration.aliyun_sms.update',
        resourceType: 'organization_integration',
        resourceId: existing?.id ?? organizationId,
        before: existing
          ? { status: existing.status, config: readAliyunSmsConfiguration(existing.config) }
          : null,
        after: { status: preservedStatus, config },
        traceId: crypto.randomUUID(),
      });
    });
    return this.getConfiguration(organizationId);
  }

  async testConnection(
    organizationId: string,
    actorId: string,
    input: TestAliyunSmsConfiguration,
    attemptId: string,
  ): Promise<AliyunSmsConnectionTest> {
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
