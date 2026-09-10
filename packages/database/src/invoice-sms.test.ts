import { describe, expect, it } from 'vitest';
import { newInvoiceFileToken, resolveInvoiceSmsRecipient } from './invoice-sms.js';

describe('invoice SMS recipient boundary', () => {
  const base = {
    purchaserId: 'purchaser',
    purchaseIntentId: 'intent',
    snapshot: { customerUserId: 'purchaser', mobile: '13800138000' },
    customer: null,
    organizationId: 'org',
    attendeeMobile: '13900139000',
  };
  it('uses the active verified account before its purchase snapshot', () => {
    expect(
      resolveInvoiceSmsRecipient({
        ...base,
        customer: {
          organizationId: 'org',
          status: 'active',
          verifiedAt: new Date(),
          mobileE164: '+8613600136000',
        },
      }),
    ).toEqual({ mobile: '+8613600136000', source: 'purchaser', reason: null });
  });
  it.each(['disabled', 'suspended'])(
    'does not fall back to attendee for %s purchaser',
    (status) => {
      expect(
        resolveInvoiceSmsRecipient({
          ...base,
          customer: {
            organizationId: 'org',
            status,
            verifiedAt: new Date(),
            mobileE164: '+8613800138000',
          },
        }).mobile,
      ).toBe('');
    },
  );
  it('uses proven snapshot only when the account is absent', () => {
    expect(resolveInvoiceSmsRecipient(base).mobile).toBe('+8613800138000');
    expect(
      resolveInvoiceSmsRecipient({
        ...base,
        snapshot: { customerUserId: 'other', mobile: '13800138000' },
      }).mobile,
    ).toBe('');
    expect(resolveInvoiceSmsRecipient({ ...base, snapshot: null }).mobile).toBe('');
  });
  it('uses attendee only for records without a purchaser, intent or purchaser snapshot identity', () => {
    expect(
      resolveInvoiceSmsRecipient({
        ...base,
        purchaserId: null,
        purchaseIntentId: null,
        snapshot: null,
      }),
    ).toEqual({ mobile: '+8613900139000', source: 'legacy_registration', reason: null });
    expect(
      resolveInvoiceSmsRecipient({
        ...base,
        purchaserId: null,
        purchaseIntentId: 'modern',
        snapshot: null,
      }).mobile,
    ).toBe('');
  });
  it('blocks unverified, foreign-organization and unsupported numbers', () => {
    for (const customer of [
      { organizationId: 'org', status: 'active', verifiedAt: null, mobileE164: '+8613800138000' },
      {
        organizationId: 'another',
        status: 'active',
        verifiedAt: new Date(),
        mobileE164: '+8613800138000',
      },
      {
        organizationId: 'org',
        status: 'active',
        verifiedAt: new Date(),
        mobileE164: '+12025550100',
      },
    ])
      expect(resolveInvoiceSmsRecipient({ ...base, customer }).mobile).toBe('');
  });
  it('generates fixed-size unguessable tokens using the approved alphabet', () => {
    const tokens = Array.from({ length: 1000 }, newInvoiceFileToken);
    expect(new Set(tokens).size).toBe(1000);
    expect(tokens.every((token) => /^[A-Za-z][A-Za-z0-9]{23}$/.test(token))).toBe(true);
  });
});
