import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, isNotNull } from 'drizzle-orm';
import {
  type ConferenceDatabase,
  type InvoiceSmsIntegration,
  invoiceDocumentAccessLinks,
  notificationDeliveries,
  invoiceRequests,
  organizationIntegrations,
  outboxEvents,
  invoiceSmsScope,
  invoiceSmsIntegration,
  invoiceSmsPolicy,
  invoiceSmsFingerprint,
  invoiceSmsTemplate,
  invoiceSmsBlockReason,
  invoiceFileIdentity,
  invoicePublicOrigin,
  invoiceRefundPending,
  lockInvoiceSmsScope,
  prepareInvoiceFileLink,
  refreshInvoiceSmsVerification,
} from '@conference/database';
import type { AliyunSmsClient } from '@conference/integrations';

type SmsClient = Pick<AliyunSmsClient, 'send'>;
type Delivery = typeof notificationDeliveries.$inferSelect;
type Tx = Parameters<Parameters<ConferenceDatabase['transaction']>[0]>[0];
export type InvoiceSmsClientFactory = (integration: InvoiceSmsIntegration) => SmsClient;
async function defer(tx: Tx, delivery: Delivery, milliseconds: number) {
  await tx
    .update(notificationDeliveries)
    .set({ scheduledAt: new Date(Date.now() + milliseconds) })
    .where(eq(notificationDeliveries.id, delivery.id));
  await tx.insert(outboxEvents).values({
    organizationId: delivery.organizationId,
    eventId: delivery.eventId,
    eventType: 'InvoiceSmsDeliveryRequested',
    correlationId: `invoice-sms:deferred:${randomUUID()}`,
    payload: { deliveryId: delivery.id },
  });
}
export async function synchronizeInvoiceSmsStatus(db: ConferenceDatabase, deliveryId: string) {
  const [delivery] = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, deliveryId));
  if (!delivery?.purpose?.startsWith('invoice_')) return;
  if (delivery.purpose === 'invoice_test') {
    await refreshInvoiceSmsVerification(db, delivery.organizationId);
    return;
  }
  const invoiceRequestId = delivery.invoiceRequestId;
  if (!invoiceRequestId) return;
  await db.transaction(async (tx) => {
    await lockInvoiceSmsScope(tx, invoiceRequestId);
    const [currentDelivery] = await tx
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId));
    if (!currentDelivery) return;
    const scope = await invoiceSmsScope(tx, invoiceRequestId);
    if (!scope.document || invoiceFileIdentity(scope.document) !== delivery.documentIdentity)
      return;
    const [latest] = await tx
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.invoiceRequestId, invoiceRequestId),
          eq(notificationDeliveries.documentIdentity, delivery.documentIdentity!),
        ),
      )
      .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
      .limit(1);
    if (latest?.id !== deliveryId) return;
    await tx
      .update(invoiceRequests)
      .set({
        deliveryStatus:
          currentDelivery.status === 'delivered'
            ? 'sent'
            : ['queued', 'retrying', 'claimed', 'sending', 'accepted', 'unknown'].includes(
                  currentDelivery.status,
                )
              ? 'queued'
              : currentDelivery.status === 'not_sent' || currentDelivery.status === 'cancelled'
                ? 'not_sent'
                : 'failed',
        ...(currentDelivery.status === 'delivered' ? { lastSentAt: currentDelivery.sentAt } : {}),
      })
      .where(and(eq(invoiceRequests.id, invoiceRequestId), eq(invoiceRequests.status, 'issued')));
  });
}

/** Persist the send boundary before calling Alibaba; ambiguous submissions are receipt-only. */
export async function deliverInvoiceSms(
  db: ConferenceDatabase,
  deliveryId: string,
  clientFactory: InvoiceSmsClientFactory,
) {
  const prepared = await db.transaction(async (tx) => {
    const [initial] = await tx
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId));
    if (!initial?.purpose?.startsWith('invoice_')) return null;
    if (initial.invoiceRequestId) await lockInvoiceSmsScope(tx, initial.invoiceRequestId);
    const integration = await invoiceSmsIntegration(tx, initial.organizationId, true);
    const [delivery] = await tx
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .for('update');
    if (!delivery || !['queued', 'retrying', 'claimed'].includes(delivery.status)) return null;
    // A duplicate job can wait for a lock while another attempt schedules its retry.
    if (delivery.scheduledAt.getTime() > Date.now()) return null;
    const test = delivery.purpose === 'invoice_test';
    let reason: string | null = null;
    if (!integration || !integration.encryptedCredentials || integration.config.enabled !== true)
      reason = '短信服务已关闭';
    else if (test) {
      if (
        delivery.configurationFingerprint !== invoiceSmsFingerprint(integration) ||
        invoiceSmsPolicy(integration).testDeliveryId !== delivery.id
      )
        reason = '测试配置已变化';
    } else {
      reason = await invoiceSmsBlockReason(tx, integration);
      if (
        !reason &&
        delivery.activationRevision !== invoiceSmsPolicy(integration).activationRevision
      )
        reason = '发票短信启用批次已变化';
    }
    let eventName = '短信连接测试';
    let timezone = 'Asia/Shanghai';
    if (!test && delivery.invoiceRequestId) {
      const scope = await invoiceSmsScope(tx, delivery.invoiceRequestId);
      eventName = scope.event.shortName || scope.event.name;
      timezone = scope.event.timezone;
      if (
        scope.invoice.organizationId !== delivery.organizationId ||
        scope.invoice.eventId !== delivery.eventId ||
        scope.invoice.status !== 'issued' ||
        !scope.document ||
        scope.document.id !== delivery.invoiceDocumentId ||
        invoiceFileIdentity(scope.document) !== delivery.documentIdentity
      )
        reason = '发票文件或状态已变化';
      else if (scope.recipient.reason || scope.recipient.mobile !== delivery.recipient)
        reason = '购票人手机号或账号状态已变化';
      else if (await invoiceRefundPending(tx, scope.order.id)) reason = '订单正在退款或资金核验';
    } else if (!test) reason = '缺少发票范围';
    if (
      delivery.purpose === 'invoice_auto' &&
      delivery.createdAt.getTime() < Date.now() - 86400_000
    )
      reason = '自动通知已超过 24 小时，请按需手动补发';
    if (reason || !integration) {
      await tx
        .update(notificationDeliveries)
        .set({ status: 'cancelled', error: reason ?? '短信未配置', updatedAt: new Date() })
        .where(eq(notificationDeliveries.id, delivery.id));
      return null;
    }
    const { link, token } = await prepareInvoiceFileLink(tx, delivery);
    const client = clientFactory(integration);
    // Construct the client before crossing the persisted external-send boundary.
    const attemptedAt = new Date();
    await tx
      .update(notificationDeliveries)
      .set({
        status: 'sending',
        attemptedAt,
        sendAttempts: delivery.sendAttempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(notificationDeliveries.id, delivery.id));
    return {
      delivery,
      attemptedAt,
      client,
      test,
      token,
      link,
      eventName,
      timezone,
      signName: String(integration.config.signName),
      templateCode: invoiceSmsTemplate(integration).templateCode,
    };
  });
  if (!prepared) {
    await synchronizeInvoiceSmsStatus(db, deliveryId);
    return;
  }
  const {
    delivery,
    attemptedAt,
    client,
    test,
    token,
    link,
    eventName,
    timezone,
    signName,
    templateCode,
  } = prepared;
  if (test) {
    let reachable = false;
    try {
      const sampleUrl = `${invoicePublicOrigin()}/invoice/file/${token}`;
      const head = await fetch(sampleUrl, {
        method: 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (
        !head.ok ||
        !head.headers.get('content-type')?.startsWith('application/pdf') ||
        Number(head.headers.get('content-length')) > 10000
      )
        throw new Error('sample metadata');
      const response = await fetch(sampleUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      const sample = await response.text();
      reachable =
        response.ok &&
        response.headers.get('content-type')?.startsWith('application/pdf') === true &&
        sample.startsWith('%PDF-') &&
        sample.length < 10000;
    } catch {
      /* Only the safe status is persisted; network errors may contain the token. */
    }
    if (!reachable) {
      await db
        .update(notificationDeliveries)
        .set({
          status: 'failed',
          error: '公开 PDF 测试链接无法直接读取，尚未调用短信接口',
          updatedAt: new Date(),
        })
        .where(eq(notificationDeliveries.id, deliveryId));
      return;
    }
    await db
      .update(notificationDeliveries)
      .set({ fileReachable: true })
      .where(eq(notificationDeliveries.id, deliveryId));
  }
  try {
    const result = await client.send({
      phoneNumber: delivery.recipient,
      signName,
      templateCode,
      outId: deliveryId,
      templateParameters: {
        eventName,
        expiresAt: new Intl.DateTimeFormat('zh-CN', {
          timeZone: timezone,
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          month: '2-digit',
          day: '2-digit',
        }).format(link.expiresAt),
        fileToken: token,
      },
    });
    const retryable = ['isv.BUSINESS_LIMIT_CONTROL', 'isp.SYSTEM_ERROR'].includes(result.code);
    await db.transaction(async (tx) => {
      const retry = !result.accepted && retryable && delivery.sendAttempts + 1 < 5;
      const updated = await tx
        .update(notificationDeliveries)
        .set({
          status: result.accepted ? 'accepted' : retry ? 'retrying' : 'failed',
          providerMessageId: result.bizId || null,
          error: result.accepted
            ? null
            : `短信服务返回 ${/^[A-Za-z0-9_.-]{1,100}$/.test(result.code) ? result.code : 'SEND_REJECTED'}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(notificationDeliveries.id, deliveryId),
            inArray(notificationDeliveries.status, ['sending', 'unknown']),
            eq(notificationDeliveries.attemptedAt, attemptedAt),
          ),
        )
        .returning({ id: notificationDeliveries.id });
      if (retry && updated.length)
        await defer(
          tx,
          delivery,
          [30_000, 60_000, 120_000, 240_000][delivery.sendAttempts] ?? 240_000,
        );
    });
  } catch {
    await db
      .update(notificationDeliveries)
      .set({
        status: 'unknown',
        uncertainAt: new Date(),
        error: '短信请求结果待确认，系统将查询回执',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(notificationDeliveries.id, deliveryId),
          eq(notificationDeliveries.status, 'sending'),
        ),
      );
  }
  await synchronizeInvoiceSmsStatus(db, deliveryId);
}

export async function maintainInvoiceSms(db: ConferenceDatabase) {
  const expired = await db
    .select({ id: invoiceDocumentAccessLinks.id })
    .from(invoiceDocumentAccessLinks)
    .where(
      and(
        lt(invoiceDocumentAccessLinks.expiresAt, new Date()),
        isNotNull(invoiceDocumentAccessLinks.sealedToken),
      ),
    )
    .limit(500);
  if (expired.length)
    await db
      .update(invoiceDocumentAccessLinks)
      .set({ sealedToken: null })
      .where(
        inArray(
          invoiceDocumentAccessLinks.id,
          expired.map((link) => link.id),
        ),
      );
  const integrations = await db
    .select()
    .from(organizationIntegrations)
    .where(eq(organizationIntegrations.provider, 'aliyun-sms'));
  for (const current of integrations) {
    if (!invoiceSmsTemplate(current).enabled) continue;
    if (invoiceSmsPolicy(current).verifiedOrigin === invoicePublicOrigin()) continue;
    await db.transaction(async (tx) => {
      const row = await invoiceSmsIntegration(tx, current.organizationId, true);
      if (!row || invoiceSmsPolicy(row).verifiedOrigin === invoicePublicOrigin()) return;
      const policy = invoiceSmsPolicy(row),
        templates = row.config.templates as Record<string, Record<string, unknown>>;
      await tx
        .update(organizationIntegrations)
        .set({
          config: {
            ...row.config,
            invoiceSms: {
              ...policy,
              activationRevision: policy.activationRevision + 1,
              enabledAt: null,
            },
            templates: {
              ...templates,
              invoiceReady: { ...templates.invoiceReady, enabled: false },
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(organizationIntegrations.id, row.id));
    });
  }
}

export async function finalizeInvoiceSmsFailure(db: ConferenceDatabase, deliveryId: string) {
  await db
    .update(notificationDeliveries)
    .set({
      status: 'failed',
      error: '短信准备失败，重试已结束。请检查配置后补发。',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notificationDeliveries.id, deliveryId),
        inArray(notificationDeliveries.purpose, ['invoice_auto', 'invoice_manual', 'invoice_test']),
        inArray(notificationDeliveries.status, ['queued', 'retrying', 'claimed']),
      ),
    );
  await synchronizeInvoiceSmsStatus(db, deliveryId);
}
export type InvoiceSmsRateGate = (organizationId: string) => Promise<number>;
export function createInvoiceSmsRateGate(redis: {
  defineCommand: (name: string, definition: { numberOfKeys: number; lua: string }) => void;
  runCommand: (name: string, args: string[]) => Promise<unknown>;
}): InvoiceSmsRateGate {
  redis.defineCommand('tokemsInvoiceSmsRateSlot', {
    numberOfKeys: 1,
    lua: `
    if redis.call('SET',KEYS[1],'1','PX',1000,'NX') then return 0 end
    return math.max(redis.call('PTTL',KEYS[1]),1)
  `,
  });
  return async (organizationId) =>
    Number(
      await redis.runCommand('tokemsInvoiceSmsRateSlot', [`invoice-sms:rate:${organizationId}`]),
    );
}
