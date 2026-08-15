import { describe, expect, it } from 'vitest';
import {
  CreateRegistrationSchema,
  CustomerAccountModeSchema,
  EventRegistrationSettingsSchema,
  OrganizationSettingsSchema,
  REGISTRATION_PREFERENCE_DEFAULTS,
} from './index.js';

describe('registration preference defaults', () => {
  it('defaults optional preferences after the attendee explicitly accepts the terms', () => {
    const registration = CreateRegistrationSchema.parse({
      eventId: 101,
      ticketTypeId: 'ticket-standard',
      attendee: { mobile: '13800138000' },
      termsAccepted: true,
    });

    expect(registration).toMatchObject({
      invoiceRequired: REGISTRATION_PREFERENCE_DEFAULTS.invoiceRequired,
      marketingConsent: REGISTRATION_PREFERENCE_DEFAULTS.marketingConsent,
      termsAccepted: true,
    });
  });

  it('keeps mobile verification as the only customer account mode', () => {
    expect(CustomerAccountModeSchema.options).toEqual(['mobile_otp_required']);
    expect(() => EventRegistrationSettingsSchema.parse({ accountMode: 'guest_allowed' })).toThrow();
  });

  it('keeps a stored legacy organization default readable during migration', () => {
    const settings = OrganizationSettingsSchema.parse({
      brandName: '历史组织',
      customerAccounts: { defaultAccountMode: 'guest_allowed' },
    });

    expect(settings.customerAccounts.defaultAccountMode).toBe('guest_allowed');
  });
});
