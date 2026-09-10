import { createHash, randomInt, randomUUID } from 'node:crypto';
import { InvoiceSmsPolicySchema, type InvoiceSmsNotification } from '@conference/contracts';
import { openSecret, sealSecret } from '@conference/security';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { ConferenceDatabase } from './index.js';
import {
  customerUsers,
  events,
  invoiceDocumentAccessLinks,
  invoiceDocuments,
  invoiceRequests,
  notificationDeliveries,
  orders,
  organizationIntegrations,
  outboxEvents,
  refundRequests,
  refunds,
  registrations,
  tickets,
  orderItems,
} from './schema.js';

export type InvoiceSmsTx = Parameters<Parameters<ConferenceDatabase['transaction']>[0]>[0];
export type InvoiceSmsDb = ConferenceDatabase | InvoiceSmsTx;
export type InvoiceSmsIntegration = typeof organizationIntegrations.$inferSelect;
export const INVOICE_SMS_PENDING = [
  'queued',
  'retrying',
  'claimed',
  'sending',
  'unknown',
  'accepted',
];
export const INVOICE_SMS_UNCERTAIN = ['sending', 'unknown', 'accepted'];
export const INVOICE_SMS_COOLDOWN_MS = 10 * 60_000;
export class InvoiceSmsError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export function invoiceFileIdentity(
  document: Pick<
    typeof invoiceDocuments.$inferSelect,
    'id' | 'storageKey' | 'contentDigest' | 'issuedAt'
  >,
) {
  return JSON.stringify([
    document.id,
    document.storageKey,
    document.contentDigest.toLowerCase(),
    document.issuedAt.toISOString(),
  ]);
}
export function invoiceTokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function newInvoiceFileToken() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const alphabet = `${letters}0123456789`;
  return (
    letters[randomInt(letters.length)]! +
    Array.from({ length: 23 }, () => alphabet[randomInt(alphabet.length)]!).join('')
  );
}
export function invoiceFileSecret() {
  const value = process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET;
  if (!value || value.length < 32) throw new InvoiceSmsError('发票通知加密密钥尚未配置', 503);
  return value;
}
export function invoicePublicOrigin() {
  const value = process.env.PUBLIC_ORIGIN ?? process.env.PUBLIC_SITE_URL ?? 'http://localhost:8088';
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (process.env.DEPLOYMENT_MODE === 'production' && url.protocol !== 'https:')
  ) {
    throw new InvoiceSmsError('发票领取域名配置无效', 503);
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new InvoiceSmsError('发票领取域名配置无效', 503);
  return url.origin;
}
export function invoiceSmsPolicy(integration?: Pick<InvoiceSmsIntegration, 'config'> | null) {
  return InvoiceSmsPolicySchema.parse(integration?.config.invoiceSms ?? {});
}
export function invoiceSmsTemplate(integration?: Pick<InvoiceSmsIntegration, 'config'> | null) {
  const templates = integration?.config.templates as
    Record<string, Record<string, unknown>> | undefined;
  const template = templates?.invoiceReady;
  return {
    enabled: template?.enabled === true,
    templateCode: String(template?.templateCode ?? ''),
  };
}
export function invoiceSmsFingerprint(
  integration: Pick<InvoiceSmsIntegration, 'config' | 'encryptedCredentials' | 'keyVersion'>,
  origin = invoicePublicOrigin(),
) {
  return invoiceTokenHash(
    JSON.stringify([
      integration.encryptedCredentials,
      integration.keyVersion,
      integration.config.signName,
      invoiceSmsTemplate(integration).templateCode,
      invoiceSmsPolicy(integration).deliveryMode,
      origin,
    ]),
  );
}
export function maskedInvoiceMobile(value: string) {
  return value.replace(/(\d{3})\d{4}(\d{4})$/, '$1****$2');
}
function domesticPhone(value: string) {
  const phone = value.replace(/^\+?86/, '');
  return /^1[3-9]\d{9}$/.test(phone) ? `+86${phone}` : '';
}
export function resolveInvoiceSmsRecipient(input: {
  purchaserId: string | null;
  purchaseIntentId: string | null;
  snapshot: { customerUserId?: string | null; mobile?: string } | null;
  customer: {
    organizationId: string;
    status: string;
    verifiedAt: Date | null;
    mobileE164: string;
  } | null;
  organizationId: string;
  attendeeMobile: string;
}) {
  if (input.customer) {
    if (
      input.customer.organizationId !== input.organizationId ||
      input.customer.status !== 'active' ||
      !input.customer.verifiedAt
    )
      return { mobile: '', source: 'purchaser', reason: '购票账号未验证、已停用或身份范围不一致' };
    const mobile = domesticPhone(input.customer.mobileE164);
    return { mobile, source: 'purchaser', reason: mobile ? null : '购票人手机号不支持国内短信' };
  }
  const modern = Boolean(
    input.purchaserId || input.purchaseIntentId || input.snapshot?.customerUserId,
  );
  if (modern) {
    if (
      !input.snapshot?.customerUserId ||
      (input.purchaserId && input.snapshot.customerUserId !== input.purchaserId)
    )
      return { mobile: '', source: 'purchaser_snapshot', reason: '缺少可确认归属的购票人手机号' };
    const mobile = domesticPhone(input.snapshot.mobile ?? '');
    return {
      mobile,
      source: 'purchaser_snapshot',
      reason: mobile ? null : '缺少有效的购票人手机号',
    };
  }
  const mobile = domesticPhone(input.attendeeMobile);
  return {
    mobile,
    source: 'legacy_registration',
    reason: mobile ? null : '历史订单缺少有效手机号',
  };
}
export async function invoiceSmsScope(db: InvoiceSmsDb, invoiceId: string) {
  const [scope] = await db
    .select({
      invoice: invoiceRequests,
      order: orders,
      event: events,
      registration: registrations,
      customer: customerUsers,
    })
    .from(invoiceRequests)
    .innerJoin(orders, eq(orders.id, invoiceRequests.orderId))
    .innerJoin(events, eq(events.id, invoiceRequests.eventId))
    .leftJoin(registrations, eq(registrations.id, invoiceRequests.registrationId))
    .leftJoin(customerUsers, eq(customerUsers.id, orders.purchaserCustomerUserId))
    .where(eq(invoiceRequests.id, invoiceId))
    .limit(1);
  if (!scope) throw new InvoiceSmsError('发票申请不存在', 404);
  const [document] = await db
    .select()
    .from(invoiceDocuments)
    .where(and(eq(invoiceDocuments.invoiceRequestId, invoiceId), isNull(invoiceDocuments.voidedAt)))
    .limit(1);
  const recipient = resolveInvoiceSmsRecipient({
    purchaserId: scope.order.purchaserCustomerUserId,
    purchaseIntentId: scope.order.purchaseIntentId,
    snapshot: scope.order.purchaserSnapshot,
    customer: scope.customer,
    organizationId: scope.invoice.organizationId,
    attendeeMobile: scope.registration?.attendeeMobileE164 ?? '',
  });
  return { ...scope, document, recipient };
}
export async function invoiceRefundPending(
  db: InvoiceSmsDb,
  orderId: string,
  purpose: 'application' | 'delivery' = 'delivery',
) {
  const [order] = await db
    .select({ mode: orders.refundExecutionMode })
    .from(orders)
    .where(eq(orders.id, orderId));
  const [request] = await db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.orderId, orderId),
        inArray(
          refundRequests.reviewStatus,
          purpose === 'application' ? ['pending_review', 'approved'] : ['approved'],
        ),
        isNull(refundRequests.terminatedAt),
      ),
    )
    .limit(1);
  const [repair] = await db
    .select({ id: refunds.id })
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), isNotNull(refunds.fulfillmentAttention)))
    .limit(1);
  return Boolean(request || repair || order?.mode === 'external_hold');
}
export async function invoiceSmsIntegration(
  db: InvoiceSmsDb,
  organizationId: string,
  lock = false,
) {
  const query = db
    .select()
    .from(organizationIntegrations)
    .where(
      and(
        eq(organizationIntegrations.organizationId, organizationId),
        eq(organizationIntegrations.provider, 'aliyun-sms'),
      ),
    )
    .limit(1);
  const [integration] = await (lock ? query.for('update') : query);
  return integration;
}
export async function invoiceSmsBlockReason(
  db: InvoiceSmsDb,
  integration: InvoiceSmsIntegration | undefined,
  requireEnabled = true,
) {
  if (!integration || !integration.encryptedCredentials) return '短信服务尚未配置';
  const policy = invoiceSmsPolicy(integration),
    template = invoiceSmsTemplate(integration);
  if (requireEnabled && (integration.config.enabled !== true || !template.enabled))
    return '发票短信通知已关闭';
  if (policy.deliveryMode !== 'direct_file_v1' || !template.templateCode)
    return '请配置并验证发票文件短信模板';
  if (
    policy.verifiedOrigin !== invoicePublicOrigin() ||
    policy.verifiedFingerprint !== invoiceSmsFingerprint(integration)
  )
    return '发票模板或领取域名已变化，请重新验证';
  const [test] = policy.testDeliveryId
    ? await db
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.id, policy.testDeliveryId),
            eq(notificationDeliveries.organizationId, integration.organizationId),
            eq(notificationDeliveries.purpose, 'invoice_test'),
          ),
        )
        .limit(1)
    : [];
  if (
    !test ||
    test.status !== 'delivered' ||
    !test.fileReachable ||
    test.configurationFingerprint !== policy.verifiedFingerprint
  )
    return '发票短信测试尚未确认送达';
  return null;
}
export async function invalidateInvoiceFileAccess(
  db: InvoiceSmsDb,
  invoiceId: string,
  reason = '发票状态或文件版本已变化',
) {
  await db
    .update(invoiceDocumentAccessLinks)
    .set({ revokedAt: new Date(), sealedToken: null })
    .where(
      and(
        eq(invoiceDocumentAccessLinks.invoiceRequestId, invoiceId),
        isNull(invoiceDocumentAccessLinks.revokedAt),
      ),
    );
  await db
    .update(notificationDeliveries)
    .set({ status: 'cancelled', error: reason, updatedAt: new Date() })
    .where(
      and(
        eq(notificationDeliveries.invoiceRequestId, invoiceId),
        inArray(notificationDeliveries.status, ['queued', 'retrying', 'claimed']),
      ),
    );
}
/** Access creation and explicit revocation invalidate stale finance confirmations. */
export async function advanceInvoiceAccessVersion(db: InvoiceSmsDb, invoiceId: string) {
  await db
    .update(invoiceRequests)
    .set({
      updatedAt: sql`greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', ${invoiceRequests.updatedAt}) + interval '1 millisecond')`,
    })
    .where(eq(invoiceRequests.id, invoiceId));
}
export async function lockInvoiceSmsScope(tx: InvoiceSmsTx, invoiceId: string) {
  const [invoice] = await tx
    .select({ orderId: invoiceRequests.orderId })
    .from(invoiceRequests)
    .where(eq(invoiceRequests.id, invoiceId))
    .limit(1);
  if (!invoice) throw new InvoiceSmsError('发票申请不存在', 404);
  const [order] = await tx
    .select({ registrationId: orders.registrationId })
    .from(orders)
    .where(eq(orders.id, invoice.orderId))
    .for('update');
  if (!order) throw new InvoiceSmsError('订单不存在', 404);
  await tx
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      sql`exists (select 1 from ${orderItems} item where item.order_id=${invoice.orderId} and item.registration_id=${tickets.registrationId}) or ${tickets.registrationId}=${order.registrationId}`,
    )
    .orderBy(tickets.id)
    .for('update');
  await tx
    .select({ id: invoiceRequests.id })
    .from(invoiceRequests)
    .where(eq(invoiceRequests.id, invoiceId))
    .for('update');
  await tx
    .select({ id: invoiceDocuments.id })
    .from(invoiceDocuments)
    .where(eq(invoiceDocuments.invoiceRequestId, invoiceId))
    .for('update');
}
export async function invoiceSmsSummary(
  db: InvoiceSmsDb,
  invoiceId: string,
): Promise<InvoiceSmsNotification> {
  const scope = await invoiceSmsScope(db, invoiceId);
  const integration = await invoiceSmsIntegration(db, scope.invoice.organizationId);
  const configReason = await invoiceSmsBlockReason(db, integration);
  const identity = scope.document ? invoiceFileIdentity(scope.document) : '';
  const [last] = await db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.invoiceRequestId, invoiceId),
        eq(notificationDeliveries.documentIdentity, identity),
      ),
    )
    .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
    .limit(1);
  const [link] = await db
    .select()
    .from(invoiceDocumentAccessLinks)
    .where(
      and(
        eq(invoiceDocumentAccessLinks.organizationId, scope.invoice.organizationId),
        eq(invoiceDocumentAccessLinks.invoiceRequestId, invoiceId),
        eq(invoiceDocumentAccessLinks.documentIdentity, identity),
        isNull(invoiceDocumentAccessLinks.revokedAt),
        gt(invoiceDocumentAccessLinks.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invoiceDocumentAccessLinks.createdAt), desc(invoiceDocumentAccessLinks.id))
    .limit(1);
  const manual = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.invoiceRequestId, invoiceId),
        eq(notificationDeliveries.purpose, 'invoice_manual'),
        gte(notificationDeliveries.createdAt, new Date(Date.now() - 86400_000)),
        ne(notificationDeliveries.status, 'not_sent'),
      ),
    );
  const [lastQueued] = await db
    .select({ createdAt: notificationDeliveries.createdAt })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.invoiceRequestId, invoiceId),
        ne(notificationDeliveries.status, 'not_sent'),
      ),
    )
    .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
    .limit(1);
  const pending = Boolean(last && INVOICE_SMS_PENDING.includes(last.status));
  const stale = Boolean(
    last &&
    last.activationRevision !== invoiceSmsPolicy(integration).activationRevision &&
    ['queued', 'retrying', 'claimed'].includes(last.status),
  );
  const cooldown = lastQueued
    ? Math.max(
        0,
        Math.ceil((lastQueued.createdAt.getTime() + INVOICE_SMS_COOLDOWN_MS - Date.now()) / 1000),
      )
    : 0;
  const businessReason =
    scope.invoice.status !== 'issued' || !scope.document
      ? '当前发票尚无有效文件'
      : (await invoiceRefundPending(db, scope.invoice.orderId))
        ? '订单正在退款或资金核验'
        : scope.recipient.reason;
  const reason =
    configReason ?? businessReason ?? (manual.length >= 5 ? '24 小时内最多补发 5 次' : null);
  const canForce = Boolean(
    !reason &&
    !cooldown &&
    last &&
    INVOICE_SMS_UNCERTAIN.includes(last.status) &&
    (last.attemptedAt ?? last.createdAt).getTime() < Date.now() - 30 * 60_000,
  );
  return {
    enabled: !configReason,
    status: stale ? 'cancelled' : (last?.status ?? 'not_sent'),
    reason: reason ?? (stale ? '启用批次已变化' : (last?.error ?? null)),
    maskedRecipient: (last ? last.recipient : scope.recipient.mobile)
      ? maskedInvoiceMobile(last ? last.recipient : scope.recipient.mobile)
      : null,
    nextMaskedRecipient:
      last && scope.recipient.mobile && last.recipient !== scope.recipient.mobile
        ? maskedInvoiceMobile(scope.recipient.mobile)
        : null,
    recipientSource: last?.recipientSource ?? scope.recipient.source,
    deliveryId: last?.id ?? null,
    queuedAt: last?.createdAt.toISOString() ?? null,
    attemptedAt: last?.attemptedAt?.toISOString() ?? null,
    sentAt: last?.sentAt?.toISOString() ?? null,
    expiresAt: link && !link.revokedAt ? link.expiresAt.toISOString() : null,
    canSend: !reason && !cooldown && (!pending || stale),
    canForceSend: canForce,
    canRevoke: Boolean(link && !link.revokedAt && link.expiresAt > new Date()),
    retryAfterSeconds: cooldown,
  };
}
export async function queueInvoiceSms(
  tx: InvoiceSmsTx,
  invoiceId: string,
  options: {
    manual?: boolean;
    requestKey?: string;
    forceAfterUncertain?: boolean;
    reason?: string;
  } = {},
) {
  await lockInvoiceSmsScope(tx, invoiceId);
  const scope = await invoiceSmsScope(tx, invoiceId);
  if (!scope.document) throw new InvoiceSmsError('当前发票尚无有效文件');
  const integration = await invoiceSmsIntegration(tx, scope.invoice.organizationId, true);
  const summary = await invoiceSmsSummary(tx, invoiceId);
  const maskedRecipient = scope.recipient.mobile ? maskedInvoiceMobile(scope.recipient.mobile) : '';
  if (options.manual) {
    if (!summary.enabled) throw new InvoiceSmsError(summary.reason ?? '发票短信通知已关闭');
    if (
      summary.deliveryId &&
      ['queued', 'retrying', 'claimed', 'sending', 'accepted', 'unknown'].includes(
        summary.status,
      ) &&
      !options.forceAfterUncertain
    )
      return {
        queued: true,
        alreadyQueued: true,
        deliveryId: summary.deliveryId,
        maskedRecipient,
        retryAfterSeconds: summary.retryAfterSeconds,
      };
    if (
      options.forceAfterUncertain
        ? !summary.canForceSend || (options.reason?.trim().length ?? 0) < 4
        : !summary.canSend
    )
      throw new InvoiceSmsError(
        summary.reason ??
          (summary.retryAfterSeconds ? '短信刚刚发送过，请稍后再试' : '当前短信任务尚未结束'),
        summary.retryAfterSeconds ? 429 : 409,
        { retryAfterSeconds: summary.retryAfterSeconds },
      );
  }
  const identity = invoiceFileIdentity(scope.document);
  const key = options.manual
    ? `invoice-sms:manual:${invoiceId}:${options.requestKey ?? randomUUID()}`
    : `invoice-sms:auto:${invoiceId}:${invoiceTokenHash(identity)}`;
  const [existing] = await tx
    .select({ id: notificationDeliveries.id, status: notificationDeliveries.status })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.businessKey, key));
  if (existing)
    return {
      queued: existing.status !== 'not_sent',
      alreadyQueued: true,
      deliveryId: existing.id,
      maskedRecipient,
      retryAfterSeconds: 0,
    };
  const reason = options.manual
    ? null
    : ((await invoiceSmsBlockReason(tx, integration)) ??
      (scope.invoice.status !== 'issued'
        ? '当前发票尚无有效文件'
        : (await invoiceRefundPending(tx, scope.order.id))
          ? '订单正在退款或资金核验'
          : scope.recipient.reason));
  if (scope.recipient.mobile)
    await tx
      .update(invoiceDocumentAccessLinks)
      .set({ revokedAt: new Date(), sealedToken: null })
      .where(
        and(
          eq(invoiceDocumentAccessLinks.invoiceRequestId, invoiceId),
          ne(invoiceDocumentAccessLinks.recipientHash, invoiceTokenHash(scope.recipient.mobile)),
          isNull(invoiceDocumentAccessLinks.revokedAt),
        ),
      );
  const [delivery] = await tx
    .insert(notificationDeliveries)
    .values({
      organizationId: scope.invoice.organizationId,
      eventId: scope.invoice.eventId,
      registrationId: scope.invoice.registrationId,
      invoiceRequestId: invoiceId,
      invoiceDocumentId: scope.document.id,
      documentIdentity: identity,
      purpose: options.manual ? 'invoice_manual' : 'invoice_auto',
      businessKey: key,
      activationRevision: invoiceSmsPolicy(integration).activationRevision,
      channel: 'sms',
      recipient: scope.recipient.mobile,
      recipientSource: scope.recipient.source,
      subject: '电子发票已开具',
      body: '发票领取链接在发送时生成。',
      status: reason ? 'not_sent' : 'queued',
      error: reason,
    })
    .returning();
  if (!delivery) throw new Error('Invoice SMS delivery was not created');
  if (!reason)
    await tx.insert(outboxEvents).values({
      organizationId: scope.invoice.organizationId,
      eventId: scope.invoice.eventId,
      eventType: 'InvoiceSmsDeliveryRequested',
      correlationId: key,
      payload: { deliveryId: delivery.id },
    });
  await tx
    .update(invoiceRequests)
    .set({ deliveryStatus: reason ? 'not_sent' : 'queued' })
    .where(eq(invoiceRequests.id, invoiceId));
  return {
    queued: !reason,
    alreadyQueued: false,
    deliveryId: delivery.id,
    maskedRecipient,
    retryAfterSeconds: 0,
  };
}

/** Merge verification fields only; a late receipt must never restore a disabled switch. */
export async function refreshInvoiceSmsVerification(
  db: ConferenceDatabase,
  organizationId: string,
) {
  await db.transaction(async (tx) => {
    const row = await invoiceSmsIntegration(tx, organizationId, true);
    if (!row) return;
    const policy = invoiceSmsPolicy(row);
    if (!policy.testDeliveryId) return;
    const [test] = await tx
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.id, policy.testDeliveryId),
          eq(notificationDeliveries.organizationId, organizationId),
          eq(notificationDeliveries.purpose, 'invoice_test'),
        ),
      );
    if (
      !test ||
      test.status !== 'delivered' ||
      !test.fileReachable ||
      test.configurationFingerprint !== invoiceSmsFingerprint(row)
    )
      return;
    if (
      policy.verifiedFingerprint === test.configurationFingerprint &&
      policy.verifiedOrigin === invoicePublicOrigin()
    )
      return;
    await tx
      .update(organizationIntegrations)
      .set({
        config: {
          ...row.config,
          invoiceSms: {
            ...policy,
            verifiedFingerprint: test.configurationFingerprint,
            verifiedOrigin: invoicePublicOrigin(),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(organizationIntegrations.id, row.id));
  });
}
export async function prepareInvoiceFileLink(
  tx: InvoiceSmsTx,
  delivery: typeof notificationDeliveries.$inferSelect,
) {
  const purpose = delivery.purpose === 'invoice_test' ? 'test' : 'invoice';
  const [existing] = delivery.fileAccessLinkId
    ? await tx
        .select()
        .from(invoiceDocumentAccessLinks)
        .where(
          and(
            eq(invoiceDocumentAccessLinks.id, delivery.fileAccessLinkId),
            isNull(invoiceDocumentAccessLinks.revokedAt),
            gt(invoiceDocumentAccessLinks.expiresAt, new Date()),
          ),
        )
        .limit(1)
    : await tx
        .select()
        .from(invoiceDocumentAccessLinks)
        .where(
          and(
            eq(invoiceDocumentAccessLinks.organizationId, delivery.organizationId),
            eq(invoiceDocumentAccessLinks.purpose, purpose),
            delivery.invoiceRequestId
              ? eq(invoiceDocumentAccessLinks.invoiceRequestId, delivery.invoiceRequestId)
              : sql`false`,
            eq(invoiceDocumentAccessLinks.documentIdentity, delivery.documentIdentity ?? ''),
            eq(invoiceDocumentAccessLinks.recipientHash, invoiceTokenHash(delivery.recipient)),
            isNull(invoiceDocumentAccessLinks.revokedAt),
            gt(invoiceDocumentAccessLinks.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(invoiceDocumentAccessLinks.createdAt))
        .limit(1);
  if (existing?.sealedToken) {
    await tx
      .update(notificationDeliveries)
      .set({ fileAccessLinkId: existing.id })
      .where(eq(notificationDeliveries.id, delivery.id));
    return { link: existing, token: openSecret(existing.sealedToken, invoiceFileSecret()) };
  }
  if (delivery.attemptedAt) throw new InvoiceSmsError('领取凭证已过期，须确认短信结果后重新发送');
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newInvoiceFileToken();
    const [link] = await tx
      .insert(invoiceDocumentAccessLinks)
      .values({
        organizationId: delivery.organizationId,
        eventId: purpose === 'test' ? null : delivery.eventId,
        orderId: null,
        invoiceRequestId: delivery.invoiceRequestId,
        invoiceDocumentId: delivery.invoiceDocumentId,
        documentIdentity: delivery.documentIdentity,
        purpose,
        recipientHash: invoiceTokenHash(delivery.recipient),
        tokenHash: invoiceTokenHash(token),
        sealedToken: sealSecret(token, invoiceFileSecret()),
        expiresAt: new Date(Date.now() + (purpose === 'test' ? 1 : 30) * 86400_000),
        ...(delivery.invoiceRequestId
          ? { orderId: (await invoiceSmsScope(tx, delivery.invoiceRequestId)).invoice.orderId }
          : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (link) {
      await tx
        .update(notificationDeliveries)
        .set({ fileAccessLinkId: link.id })
        .where(eq(notificationDeliveries.id, delivery.id));
      if (purpose === 'invoice' && delivery.invoiceRequestId)
        await advanceInvoiceAccessVersion(tx, delivery.invoiceRequestId);
      return { link, token };
    }
  }
  throw new Error('Unable to allocate invoice file access token');
}
