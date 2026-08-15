import { createHash } from 'node:crypto';
import { publicEventScopedPath } from '@conference/contracts';
import { openSecret } from '@conference/security';

export interface ActiveAttendeeClaimScope {
  organizationId: string;
  eventId: number;
  eventName: string;
  eventSlug: string;
  eventTimezone: string;
  attendeeName: string;
  recipient: string;
  expiresAt: Date;
}

export interface AttendeeClaimDeliveryInput {
  id: string;
  organizationId: string;
  eventId: number;
  registrationId: string;
  channel: 'email' | 'sms';
  recipient: string;
  subject: string;
  body: string;
}

export interface AttendeeClaimSmsContext {
  templateKey: 'registrationSubmitted';
  parameters: {
    eventName: string;
    url: string;
    expiresAt: string;
  };
}

export interface AttendeeClaimNotificationInput {
  deliveryId: string;
  jobId?: string;
  body: string;
  smsContext: AttendeeClaimSmsContext;
}

export interface AttendeeClaimInvitationDependencies {
  encryptionSecret: string;
  publicSiteUrl: string;
  findActiveClaim(
    registrationId: string,
    tokenHash: string,
  ): Promise<ActiveAttendeeClaimScope | null>;
  ensureDelivery(input: AttendeeClaimDeliveryInput): Promise<string>;
  deliverNotification(input: AttendeeClaimNotificationInput): Promise<void>;
}

export interface AttendeeClaimInvitationEvent {
  payload: Record<string, unknown>;
  correlationId: string;
  jobId?: string;
}

function deterministicUuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4]!;
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export async function consumeAttendeeClaimInvitation(
  event: AttendeeClaimInvitationEvent,
  dependencies: AttendeeClaimInvitationDependencies,
) {
  const registrationId = String(event.payload.registrationId ?? '');
  const recipientRole = String(event.payload.recipientRole ?? '');
  const payloadRecipient = String(event.payload.recipient ?? '');
  const sealedClaimToken = String(event.payload.sealedAttendeeClaimToken ?? '');
  if (
    !registrationId ||
    recipientRole !== 'attendee' ||
    !payloadRecipient ||
    !sealedClaimToken ||
    Object.hasOwn(event.payload, 'attendeeClaimToken')
  ) {
    throw new Error(
      'AttendeeClaimInvitationRequested requires attendee recipient and sealedAttendeeClaimToken',
    );
  }

  const claimToken = openSecret(sealedClaimToken, dependencies.encryptionSecret);
  const tokenHash = createHash('sha256').update(claimToken).digest('hex');
  const scope = await dependencies.findActiveClaim(registrationId, tokenHash);
  if (!scope) return { status: 'stale' as const };

  const siteUrl = dependencies.publicSiteUrl.replace(/\/+$/, '');
  const claimPath = publicEventScopedPath('/account/attendee-claim', scope.eventSlug);
  const claimUrl = `${siteUrl}${claimPath}#registration=${encodeURIComponent(
    registrationId,
  )}&claim=${encodeURIComponent(claimToken)}`;
  const deliveryId = deterministicUuid(`attendee-claim-notification:${event.correlationId}`);
  const storedDeliveryId = await dependencies.ensureDelivery({
    id: deliveryId,
    organizationId: scope.organizationId,
    eventId: scope.eventId,
    registrationId,
    channel: scope.recipient.includes('@') ? 'email' : 'sms',
    recipient: scope.recipient,
    subject: `${scope.eventName} 参会名额认领`,
    body: '参会名额认领链接在发送时解密，正文不保存在运营数据库中。',
  });
  const formattedExpiry = scope.expiresAt.toLocaleString('zh-CN', {
    timeZone: scope.eventTimezone,
  });
  await dependencies.deliverNotification({
    deliveryId: storedDeliveryId,
    ...(event.jobId ? { jobId: event.jobId } : {}),
    body: `${scope.attendeeName}，请通过专属链接认领 ${scope.eventName} 的参会名额：${claimUrl}`,
    smsContext: {
      templateKey: 'registrationSubmitted',
      parameters: {
        eventName: scope.eventName,
        url: claimUrl,
        expiresAt: formattedExpiry,
      },
    },
  });
  return { status: 'delivered' as const, deliveryId: storedDeliveryId };
}
