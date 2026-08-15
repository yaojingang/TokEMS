import { describe, expect, it } from 'vitest';
import { financialNotificationRecipient } from './financial-notification-recipient.js';

describe('financial notification recipient', () => {
  it('uses the purchaser snapshot for a proxy purchase', () => {
    expect(
      financialNotificationRecipient(
        {
          purchaserCustomerUserId: 'purchaser-1',
          purchaseIntentId: 'intent-1',
          purchaserSnapshot: { email: 'buyer@example.com', mobile: '+8613800138000' },
        },
        { email: 'attendee@example.com', mobile: '+8613900139000' },
      ),
    ).toBe('buyer@example.com');
    expect(
      financialNotificationRecipient(
        {
          purchaserCustomerUserId: 'purchaser-1',
          purchaseIntentId: 'intent-1',
          purchaserSnapshot: { email: 'buyer@example.com', mobile: '+8613800138000' },
        },
        { email: 'attendee@example.com', mobile: '+8613900139000' },
        'invoice-recipient@example.com',
      ),
    ).toBe('buyer@example.com');
  });

  it('falls back to attendee contact only for a legacy order without a purchaser', () => {
    expect(
      financialNotificationRecipient(
        { purchaserCustomerUserId: null, purchaseIntentId: null, purchaserSnapshot: null },
        { email: 'legacy@example.com', mobile: '+8613900139000' },
      ),
    ).toBe('legacy@example.com');
    expect(
      financialNotificationRecipient(
        {
          purchaserCustomerUserId: 'purchaser-1',
          purchaseIntentId: 'intent-1',
          purchaserSnapshot: null,
        },
        { email: 'attendee@example.com', mobile: '+8613900139000' },
      ),
    ).toBe('');
    expect(
      financialNotificationRecipient(
        {
          purchaserCustomerUserId: null,
          purchaseIntentId: 'modern-intent-after-account-deletion',
          purchaserSnapshot: null,
        },
        { email: 'claimed-attendee@example.com', mobile: '+8613900139000' },
      ),
    ).toBe('');
  });
});
