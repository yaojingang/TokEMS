export type NotificationAccessTokenPlan =
  'create' | 'expire-and-skip' | 'replace' | 'reuse' | 'revoke-and-skip' | 'skip' | 'use-payload';

export interface PersistedNotificationAccessToken {
  tokenId: string | null;
  sealedToken: string | null;
  expiresAt: Date | null;
}

const SUCCESSFUL_DELIVERY_STATUSES = new Set(['sent', 'delivered', 'accepted']);
const FAILED_DELIVERY_STATUSES = new Set(['failed', 'cancelled']);

export function notificationAccessTokenDeliveryKey(input: {
  eventType: unknown;
  correlationId: unknown;
  payload: Record<string, unknown>;
}) {
  const correlationId = String(input.correlationId ?? '');
  if (!correlationId) return null;
  if (
    input.eventType === 'InvoiceDetailsRequested' ||
    input.eventType === 'InvoiceIssued' ||
    input.eventType === 'InvoiceDeliveryRequested' ||
    (input.eventType === 'OrderAccessLinkRequested' && Boolean(input.payload.invoiceId))
  ) {
    return `invoice-notification:${correlationId}`;
  }
  if (
    input.eventType === 'RegistrationSubmitted' ||
    input.eventType === 'OrderAccessLinkRequested'
  ) {
    return `order-access-notification:${correlationId}`;
  }
  return null;
}

export function notificationAccessTokenFailureDisposition(
  error: Error,
  hadUncertainAttempt = false,
): 'failed' | 'uncertain' {
  if (hadUncertainAttempt) return 'uncertain';
  if (error.message === 'NOTIFICATION_WEBHOOK_URL is required in production') return 'failed';
  const status = Number(/^notification provider returned (\d{3})$/u.exec(error.message)?.[1]);
  const definitiveClientRejections = new Set([
    400, 401, 403, 404, 405, 406, 410, 411, 412, 413, 414, 415, 416, 417, 421, 422, 426, 428, 431,
  ]);
  return definitiveClientRejections.has(status) ? 'failed' : 'uncertain';
}

export function planNotificationAccessToken(input: {
  deliveryStatus: string;
  hasPayloadToken: boolean;
  now?: Date;
  persistedToken: PersistedNotificationAccessToken | null;
}): NotificationAccessTokenPlan {
  if (SUCCESSFUL_DELIVERY_STATUSES.has(input.deliveryStatus)) return 'skip';
  if (FAILED_DELIVERY_STATUSES.has(input.deliveryStatus)) {
    return input.persistedToken?.tokenId ? 'revoke-and-skip' : 'skip';
  }
  if (input.hasPayloadToken) return 'use-payload';
  if (!input.persistedToken) return 'create';
  if (
    !input.persistedToken.tokenId ||
    !input.persistedToken.sealedToken ||
    !input.persistedToken.expiresAt
  ) {
    throw new Error('incomplete persisted notification access token');
  }
  if (input.persistedToken.expiresAt <= (input.now ?? new Date())) {
    return input.deliveryStatus === 'queued' || input.deliveryStatus === 'claimed'
      ? 'replace'
      : 'expire-and-skip';
  }
  return 'reuse';
}
