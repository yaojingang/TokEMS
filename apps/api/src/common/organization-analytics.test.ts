import { describe, expect, it } from 'vitest';
import { OrganizationSettingsSchema, analyticsSettingsFromSnippet } from '@conference/contracts';
import { analyticsAuditSnapshot } from './organization-admin.service.js';

const umamiSnippet =
  '<script defer src="https://analytics.example.com/script.js" data-website-id="private-site-id"></script>';

describe('organization analytics audit snapshot', () => {
  it('records only state, provider, digest, and script domains', () => {
    const settings = OrganizationSettingsSchema.parse({
      brandName: '大会管理中心',
      analytics: analyticsSettingsFromSnippet(umamiSnippet, true),
    });
    const snapshot = analyticsAuditSnapshot(settings.analytics);

    expect(snapshot).toEqual({
      enabled: true,
      provider: 'umami',
      codeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      scriptDomains: ['analytics.example.com'],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-site-id');
    expect(JSON.stringify(snapshot)).not.toContain('<script');
  });
});
