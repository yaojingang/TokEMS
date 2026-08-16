import { describe, expect, it } from 'vitest';
import { AdminPreferencesSchema, AuthMeSchema, UpdateAdminPreferencesSchema } from './index.js';

const identity = {
  user: { id: 101, email: 'admin@tokems.local', name: '组织管理员' },
  organization: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    slug: 'geo-conference',
    name: '中国GEO大会组委会',
    settings: {
      brandName: '大会管理中心',
      defaultTimezone: 'Asia/Shanghai',
      defaultCurrency: 'CNY',
      defaultBlueprintId: null,
      defaultTemplateId: null,
      customerAccounts: {
        defaultAccountMode: 'mobile_otp_required',
        termsUrl: '',
        termsVersion: '',
        privacyUrl: '',
        privacyVersion: '',
      },
      website: {
        siteName: '大会报名中心',
        seoTitle: '大会报名中心',
        seoDescription: '',
        faviconUrl: '',
        footerText: '',
        icpNumber: '',
        supportEmail: '',
      },
      analytics: {
        enabled: false,
        provider: 'baidu',
        trackingId: '',
        scriptUrl: '',
        siteId: '',
      },
    },
  },
  membership: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    role: 'organization_admin',
    grants: ['*'],
    status: 'active',
  },
};

describe('administrator navigation preferences contract', () => {
  it('keeps older identity responses compatible with an empty preference', () => {
    expect(AuthMeSchema.parse(identity).adminPreferences).toEqual({ lastEventId: null });
  });

  it('accepts a valid recent event or an explicit clear request', () => {
    expect(AdminPreferencesSchema.parse({ lastEventId: 101 })).toEqual({ lastEventId: 101 });
    expect(UpdateAdminPreferencesSchema.parse({ lastEventId: null })).toEqual({
      lastEventId: null,
    });
    expect(UpdateAdminPreferencesSchema.safeParse({ lastEventId: 100 }).success).toBe(false);
  });
});
