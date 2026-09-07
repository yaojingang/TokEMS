import { describe, expect, it } from 'vitest';
import { ADMIN_EVENT_READ_GRANTS, assertEventUpdateGrants } from './admin.module.js';

describe('admin event read permissions', () => {
  it('allows the public-site reader to load the event workspace shell', () => {
    expect(ADMIN_EVENT_READ_GRANTS).toContain('event.site.read');
  });

  it('allows refund reviewers to open refund settings in the event workspace', () => {
    expect(ADMIN_EVENT_READ_GRANTS).toContain('event.order.refund');
  });
});

describe('admin event update permissions', () => {
  const refunds = {
    settings: {
      refunds: { enabled: true, version: 'seven-day-v1' as const, windowDays: 7 as const },
    },
  };
  const registration = { settings: { registration: { registrationOpen: false } } };

  it('lets refund reviewers change only the refund policy', () => {
    expect(() => assertEventUpdateGrants(['event.order.refund'], refunds)).not.toThrow();
    expect(() => assertEventUpdateGrants(['event.order.refund'], registration)).toThrow(
      '报名设置需要大会管理或报名运营权限',
    );
  });

  it('keeps refund policy changes unavailable to registration-only managers', () => {
    expect(() => assertEventUpdateGrants(['event.registration.manage'], registration)).not.toThrow();
    expect(() => assertEventUpdateGrants(['event.registration.manage'], refunds)).toThrow(
      '退款规则需要大会管理或财务退款权限',
    );
  });
});
