import { createHash } from 'node:crypto';
import { publicEventScopedPath } from '@conference/contracts';

type NotificationTemplateKey =
  'registrationApproved' | 'registrationRejected' | 'ticketIssued' | 'refundSucceeded';

interface ReviewScope {
  organizationId: string;
  eventId: number;
  eventName: string;
  eventSlug: string;
  attendeeName: string;
  attendeeRecipient: string;
}

interface TicketScope extends ReviewScope {
  registrationId: string;
  ticketCode: string;
}

interface RefundScope {
  organizationId: string;
  eventId: number;
  eventName: string;
  registrationId: string;
  orderNo: string;
  amount: number;
  payerRefund?: number | null;
  discountRefund?: number | null;
  currency: string;
  purchaserName: string;
  purchaserRecipient: string;
}

interface LifecycleDeliveryInput {
  id: string;
  organizationId: string;
  eventId: number;
  registrationId: string;
  channel: 'email' | 'sms';
  recipient: string;
  subject: string;
  body: string;
}

interface DeliverInput {
  deliveryId: string;
  body: string;
  smsContext: {
    templateKey: NotificationTemplateKey;
    parameters: Record<string, string>;
  };
}

export interface LifecycleNotificationDependencies {
  publicSiteUrl: string;
  findReviewScope(registrationId: string): Promise<ReviewScope | null>;
  findTicketScope(ticketId: string, registrationId: string): Promise<TicketScope | null>;
  findRefundScope(refundId: string, orderId: string): Promise<RefundScope | null>;
  ensureDelivery(input: LifecycleDeliveryInput): Promise<string>;
  deliver(input: DeliverInput): Promise<void>;
}

function deterministicUuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4]!;
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function requireRecipientRole(payload: Record<string, unknown>, role: 'attendee' | 'purchaser') {
  if (payload.recipientRole !== undefined && payload.recipientRole !== role) {
    throw new Error(`notification recipientRole must be ${role}`);
  }
}

function channel(recipient: string): 'email' | 'sms' {
  return recipient.includes('@') ? 'email' : 'sms';
}

export function shouldDeliverRefundWorkflowNotification(
  eventType: string,
  payload: Record<string, unknown>,
  request: {
    reviewStatus: string;
    terminatedAt: Date | null;
    attentionReason: string | null;
  } | null,
  executionMode: string,
) {
  if (eventType === 'RefundReviewed') {
    if (!request) return false;
    return payload.approved === true
      ? request.reviewStatus === 'approved' && request.terminatedAt === null
      : request.reviewStatus === 'rejected';
  }
  if (eventType === 'RefundAttentionRequired') {
    // Successful cash settlement can leave ticket or invoice reconciliation unresolved.
    if (request?.attentionReason || executionMode === 'external_hold') return true;
    return request !== null && request.terminatedAt === null;
  }
  return false;
}

export async function consumeRegistrationReviewNotification(
  event: {
    eventType: 'RegistrationReviewApproved' | 'RegistrationReviewRejected';
    correlationId: string;
    payload: Record<string, unknown>;
  },
  dependencies: LifecycleNotificationDependencies,
) {
  requireRecipientRole(event.payload, 'attendee');
  const registrationId = String(event.payload.registrationId ?? '');
  if (!registrationId) throw new Error(`${event.eventType} is missing registrationId`);
  const scope = await dependencies.findReviewScope(registrationId);
  if (!scope?.attendeeRecipient) return { status: 'stale' as const };

  const approved = event.eventType === 'RegistrationReviewApproved';
  const paymentRequired = event.payload.paymentRequired === true;
  const reason = String(event.payload.reason ?? '').trim();
  const siteUrl = dependencies.publicSiteUrl.replace(/\/+$/, '');
  const helpUrl = `${siteUrl}${publicEventScopedPath('/faq', scope.eventSlug)}`;
  const body = approved
    ? paymentRequired
      ? `${scope.attendeeName}，你的大会报名审核已通过，购票人将收到支付通知。大会信息：${helpUrl}`
      : `${scope.attendeeName}，你的大会报名审核已通过。大会信息：${helpUrl}`
    : `${scope.attendeeName}，你的大会报名审核未通过。${reason ? `原因：${reason}。` : ''}大会信息：${helpUrl}`;
  const deliveryId = deterministicUuid(`registration-review-attendee:${event.correlationId}`);
  const storedDeliveryId = await dependencies.ensureDelivery({
    id: deliveryId,
    organizationId: scope.organizationId,
    eventId: scope.eventId,
    registrationId,
    channel: channel(scope.attendeeRecipient),
    recipient: scope.attendeeRecipient,
    subject: approved ? `${scope.eventName} 报名审核已通过` : `${scope.eventName} 报名审核结果`,
    body: '报名审核结果会通过已配置的通知模板发送。',
  });
  await dependencies.deliver({
    deliveryId: storedDeliveryId,
    body,
    smsContext: {
      templateKey: approved ? 'registrationApproved' : 'registrationRejected',
      parameters: approved
        ? { eventName: scope.eventName, url: helpUrl }
        : { eventName: scope.eventName, reason: reason || '请联系大会主办方了解详情' },
    },
  });
  return { status: 'delivered' as const, deliveryId: storedDeliveryId };
}

export async function consumeTicketIssuedNotification(
  event: { correlationId: string; payload: Record<string, unknown> },
  dependencies: LifecycleNotificationDependencies,
) {
  requireRecipientRole(event.payload, 'attendee');
  const ticketId = String(event.payload.ticketId ?? '');
  const registrationId = String(event.payload.registrationId ?? '');
  if (!ticketId || !registrationId) throw new Error('TicketIssued payload is incomplete');
  const scope = await dependencies.findTicketScope(ticketId, registrationId);
  if (!scope?.attendeeRecipient) return { status: 'stale' as const };

  const siteUrl = dependencies.publicSiteUrl.replace(/\/+$/, '');
  const ticketUrl = `${siteUrl}${publicEventScopedPath(`/ticket/${encodeURIComponent(scope.ticketCode)}`, scope.eventSlug)}`;
  const body = `${scope.attendeeName}，你的 ${scope.eventName} 电子票已签发：${ticketUrl}`;
  const deliveryId = deterministicUuid(`ticket-issued-attendee:${event.correlationId}`);
  const storedDeliveryId = await dependencies.ensureDelivery({
    id: deliveryId,
    organizationId: scope.organizationId,
    eventId: scope.eventId,
    registrationId: scope.registrationId,
    channel: channel(scope.attendeeRecipient),
    recipient: scope.attendeeRecipient,
    subject: `${scope.eventName} 电子票已签发`,
    body: '电子票访问链接会通过已配置的通知模板发送。',
  });
  await dependencies.deliver({
    deliveryId: storedDeliveryId,
    body,
    smsContext: {
      templateKey: 'ticketIssued',
      parameters: { eventName: scope.eventName, url: ticketUrl },
    },
  });
  return { status: 'delivered' as const, deliveryId: storedDeliveryId };
}

export async function consumeRefundSucceededNotification(
  event: { correlationId: string; payload: Record<string, unknown> },
  dependencies: LifecycleNotificationDependencies,
) {
  if (event.payload.suppressNotification === true) return { status: 'stale' as const };
  requireRecipientRole(event.payload, 'purchaser');
  const refundId = String(event.payload.refundId ?? '');
  const orderId = String(event.payload.orderId ?? '');
  if (!refundId || !orderId) throw new Error('RefundSucceeded payload is incomplete');
  const scope = await dependencies.findRefundScope(refundId, orderId);
  if (!scope?.purchaserRecipient) return { status: 'stale' as const };

  const currency = new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: scope.currency,
  });
  const cash =
    scope.payerRefund == null
      ? '现金金额未核验'
      : `现金 ${currency.format(scope.payerRefund / 100)}`;
  const discount =
    scope.discountRefund == null
      ? '优惠金额未核验'
      : `优惠 ${currency.format(scope.discountRefund / 100)}`;
  const amount = `订单退款总额 ${currency.format(scope.amount / 100)}，${cash}，${discount}`;
  const body = `${scope.purchaserName}，订单 ${scope.orderNo} 退款成功。${amount}。`;
  const deliveryId = deterministicUuid(`refund-succeeded-purchaser:${event.correlationId}`);
  const storedDeliveryId = await dependencies.ensureDelivery({
    id: deliveryId,
    organizationId: scope.organizationId,
    eventId: scope.eventId,
    registrationId: scope.registrationId,
    channel: channel(scope.purchaserRecipient),
    recipient: scope.purchaserRecipient,
    subject: `${scope.eventName} 退款成功`,
    body: '退款结果会通过已配置的通知模板发送。',
  });
  await dependencies.deliver({
    deliveryId: storedDeliveryId,
    body,
    smsContext: {
      templateKey: 'refundSucceeded',
      parameters: {
        eventName: scope.eventName,
        orderNo: scope.orderNo,
        amount: currency.format(scope.amount / 100),
      },
    },
  });
  return { status: 'delivered' as const, deliveryId: storedDeliveryId };
}
