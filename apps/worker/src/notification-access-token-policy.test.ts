import { describe, expect, it } from 'vitest';
import {
  notificationAccessTokenDeliveryKey,
  notificationAccessTokenFailureDisposition,
  planNotificationAccessToken,
} from './notification-access-token-policy.js';

const persistedToken = {
  tokenId: 'token-1',
  sealedToken: 'sealed-token-1',
  expiresAt: new Date('2026-09-01T00:00:00.000Z'),
};

describe('notification access token policy', () => {
  it.each(['queued', 'retrying', 'claimed', 'sending', 'unknown'])(
    'reuses the delivery token while status is %s',
    (status) => {
      expect(
        planNotificationAccessToken({
          deliveryStatus: status,
          hasPayloadToken: false,
          persistedToken,
        }),
      ).toBe('reuse');
    },
  );

  it.each(['sent', 'delivered', 'accepted'])(
    'skips terminal successful delivery status %s without creating a token',
    (status) => {
      expect(
        planNotificationAccessToken({
          deliveryStatus: status,
          hasPayloadToken: false,
          persistedToken: null,
        }),
      ).toBe('skip');
    },
  );

  it.each(['failed', 'cancelled'])('revokes a persisted token for terminal status %s', (status) => {
    expect(
      planNotificationAccessToken({
        deliveryStatus: status,
        hasPayloadToken: false,
        persistedToken,
      }),
    ).toBe('revoke-and-skip');
  });

  it('creates one durable token for a new delivery', () => {
    expect(
      planNotificationAccessToken({
        deliveryStatus: 'queued',
        hasPayloadToken: false,
        persistedToken: null,
      }),
    ).toBe('create');
  });

  it('reuses the token supplied by an event payload', () => {
    expect(
      planNotificationAccessToken({
        deliveryStatus: 'retrying',
        hasPayloadToken: true,
        persistedToken: null,
      }),
    ).toBe('use-payload');
  });

  it('replaces an expired token before a queued delivery starts', () => {
    expect(
      planNotificationAccessToken({
        deliveryStatus: 'queued',
        hasPayloadToken: false,
        persistedToken: { ...persistedToken, expiresAt: new Date('2026-08-01T00:00:00.000Z') },
        now: new Date('2026-08-16T00:00:00.000Z'),
      }),
    ).toBe('replace');
  });

  it('fails an expired token after an ambiguous delivery attempt', () => {
    expect(
      planNotificationAccessToken({
        deliveryStatus: 'retrying',
        hasPayloadToken: false,
        persistedToken: { ...persistedToken, expiresAt: new Date('2026-08-01T00:00:00.000Z') },
        now: new Date('2026-08-16T00:00:00.000Z'),
      }),
    ).toBe('expire-and-skip');
  });

  it('rejects an incomplete persisted credential instead of minting a replacement', () => {
    expect(() =>
      planNotificationAccessToken({
        deliveryStatus: 'retrying',
        hasPayloadToken: false,
        persistedToken: {
          tokenId: 'token-1',
          sealedToken: null,
          expiresAt: persistedToken.expiresAt,
        },
      }),
    ).toThrow(/incomplete persisted notification access token/u);
  });

  it.each([
    ['RegistrationSubmitted', {}, 'order-access-notification:correlation-1'],
    ['OrderAccessLinkRequested', {}, 'order-access-notification:correlation-1'],
    ['OrderAccessLinkRequested', { invoiceId: 'invoice-1' }, 'invoice-notification:correlation-1'],
    ['InvoiceDetailsRequested', {}, 'invoice-notification:correlation-1'],
    ['InvoiceIssued', {}, 'invoice-notification:correlation-1'],
    ['InvoiceDeliveryRequested', {}, 'invoice-notification:correlation-1'],
  ])('maps %s to its durable delivery key', (eventType, payload, expected) => {
    expect(
      notificationAccessTokenDeliveryKey({
        eventType,
        correlationId: 'correlation-1',
        payload,
      }),
    ).toBe(expected);
  });

  it('ignores events that do not create order or invoice access tokens', () => {
    expect(
      notificationAccessTokenDeliveryKey({
        eventType: 'PaymentSucceeded',
        correlationId: 'correlation-1',
        payload: {},
      }),
    ).toBeNull();
  });

  it.each([
    ['notification provider returned 422', 'failed'],
    ['NOTIFICATION_WEBHOOK_URL is required in production', 'failed'],
    ['notification provider returned 409', 'uncertain'],
    ['notification provider returned 429', 'uncertain'],
    ['notification provider returned 500', 'uncertain'],
    ['notification provider returned 504', 'uncertain'],
    ['The operation was aborted due to timeout', 'uncertain'],
    ['fetch failed', 'uncertain'],
  ] as const)('classifies final provider error %s as %s', (message, expected) => {
    expect(notificationAccessTokenFailureDisposition(new Error(message))).toBe(expected);
  });

  it.each([
    'notification provider returned 422',
    'NOTIFICATION_WEBHOOK_URL is required in production',
  ])('preserves an earlier uncertain result when the final error is %s', (message) => {
    expect(notificationAccessTokenFailureDisposition(new Error(message), true)).toBe('uncertain');
  });
});
