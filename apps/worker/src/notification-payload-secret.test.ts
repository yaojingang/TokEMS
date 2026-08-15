import { describe, expect, it } from 'vitest';
import { notificationPayloadEncryptionSecret } from './notification-payload-secret.js';

describe('worker notification payload encryption secret', () => {
  it('fails fast in production when the dedicated secret is missing or too short', () => {
    expect(() => notificationPayloadEncryptionSecret({ NODE_ENV: 'production' })).toThrow(
      'NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET',
    );
    expect(() =>
      notificationPayloadEncryptionSecret({
        NODE_ENV: 'production',
        NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET: 'short',
        JWT_SECRET: 'jwt-fallback-that-production-must-not-use',
      }),
    ).toThrow('NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET');
  });

  it('accepts a dedicated production secret and keeps development fallback compatibility', () => {
    const secret = 'dedicated-notification-secret-at-least-32-chars';
    expect(
      notificationPayloadEncryptionSecret({
        NODE_ENV: 'production',
        NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET: secret,
      }),
    ).toBe(secret);
    expect(notificationPayloadEncryptionSecret({ NODE_ENV: 'test' })).toContain('development');
  });
});
