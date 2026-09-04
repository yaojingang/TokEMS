import { describe, expect, it } from 'vitest';
import {
  RegistrationFormPublishSchema,
  UpdatePurchasedOrderAttendeeSchema,
  publicEventScopedPath,
} from './index.js';

const mobile = { key: 'mobile', label: '手机号', type: 'tel', required: true };
const form = (fields: unknown[]) => ({
  name: '参会报名',
  fields,
  termsVersion: '2026-09-04',
  termsContent: '报名信息用于本场大会的报名和参会服务。',
});

describe('configurable registration fields', () => {
  it('allows editing phone details for an attendee without a collected name', () => {
    expect(
      UpdatePurchasedOrderAttendeeSchema.safeParse({ name: '', mobile: '13800138000' }).success,
    ).toBe(true);
  });
  it('accepts optional names and absent or disabled email fields', () => {
    expect(RegistrationFormPublishSchema.safeParse(form([mobile])).success).toBe(true);
    const parsed = RegistrationFormPublishSchema.parse(
      form([
        mobile,
        { key: 'name', label: '姓名', type: 'text', required: false },
        { key: 'email', label: '邮箱', type: 'email', required: true, enabled: false },
      ]),
    );
    expect(parsed.fields[2]).toMatchObject({ enabled: false });
  });

  it('keeps verified mobile enabled and required and preserves system field types', () => {
    for (const field of [
      { ...mobile, required: false },
      { ...mobile, enabled: false },
    ]) {
      expect(RegistrationFormPublishSchema.safeParse(form([field])).success).toBe(false);
    }
    expect(
      RegistrationFormPublishSchema.safeParse(
        form([mobile, { key: 'email', label: '邮箱', type: 'text', required: false }]),
      ).success,
    ).toBe(false);
  });
});

describe('registration addresses', () => {
  it('puts the event in the path and preserves special purchase context', () => {
    expect(publicEventScopedPath('/register', 'tokems26')).toBe('/register/tokems26');
    expect(
      publicEventScopedPath('/register', 'tokems26', { ticket: 'ticket-2', offer: 'invitation' }),
    ).toBe('/register/tokems26?ticket=ticket-2&offer=invitation');
    expect(publicEventScopedPath('/account', 'tokems26')).toBe('/account?event=tokems26');
  });
});
