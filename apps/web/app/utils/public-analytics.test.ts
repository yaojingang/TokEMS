import { describe, expect, it } from 'vitest';
import {
  analyticsNavigationContext,
  isPublicAnalyticsErrorPath,
  isPublicAnalyticsPath,
  localAnalyticsBoundaryTarget,
  publicAnalyticsHeadEntries,
  requiresAnalyticsDocumentBoundary,
  shouldSendAnalyticsPageView,
} from './public-analytics.js';

const googleSettings = {
  enabled: true,
  activationVersion: 2 as const,
  provider: 'google' as const,
  trackingId: 'G-ABC12345',
  scriptUrl: '',
  siteId: '',
};

describe('public analytics route scope', () => {
  it.each([
    '/',
    '/tokems26',
    '/faq',
    '/faq/',
    '/members/member-1',
    '/speakers/0d647797-fc67-43f5-9257-e2b4a9212646',
    '/speakers/tyzb',
    '/s/tyzb',
    '/apply/cooperation',
    '/apply/cooperation/',
  ])('loads analytics on %s', (path) => {
    expect(isPublicAnalyticsPath(path)).toBe(true);
  });

  it.each([
    '/register',
    '/register/tokems26',
    '/register/tokems26?ticket=one',
    '/account/profile',
    '/order/123',
    '/invoice/123',
    '/ticket/123',
    '/pay/hui/123',
    '/REGISTER',
    '/Account/profile',
    '/admin',
    '/api/v1/events',
  ])('keeps analytics out of %s', (path) => {
    expect(isPublicAnalyticsPath(path)).toBe(false);
  });

  it('disables analytics across the independent payment surface', () => {
    expect(isPublicAnalyticsPath('/tokems26', true)).toBe(false);
  });

  it('uses a new document whenever navigation crosses the sensitive-page boundary', () => {
    expect(requiresAnalyticsDocumentBoundary(googleSettings, '/faq', '/register')).toBe(true);
    expect(
      requiresAnalyticsDocumentBoundary(googleSettings, '/tokems26', '/register/tokems26'),
    ).toBe(true);
    expect(
      requiresAnalyticsDocumentBoundary(googleSettings, '/register/tokems26', '/tokems26'),
    ).toBe(true);
    expect(requiresAnalyticsDocumentBoundary(googleSettings, '/account', '/tokems26')).toBe(true);
    expect(requiresAnalyticsDocumentBoundary(googleSettings, '/account', '/order/123')).toBe(false);
    expect(requiresAnalyticsDocumentBoundary(googleSettings, '/faq', '/speakers/123')).toBe(false);
    expect(requiresAnalyticsDocumentBoundary(googleSettings, '/faq', '/s/tyzb')).toBe(false);
    expect(
      requiresAnalyticsDocumentBoundary({ ...googleSettings, enabled: false }, '/faq', '/register'),
    ).toBe(false);
    expect(
      requiresAnalyticsDocumentBoundary(
        { ...googleSettings, enabled: false },
        '/faq',
        '/register',
        { analyticsWasActiveInDocument: true },
      ),
    ).toBe(true);
  });

  it('derives every Nuxt head entry from the normalized contract scripts', () => {
    const entries = publicAnalyticsHeadEntries(googleSettings);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry['data-tok-analytics'])).toBe(true);
    expect(entries.every((entry) => entry.tagPosition === 'head')).toBe(true);
  });

  it('keeps document-boundary destinations on the current origin', () => {
    expect(localAnalyticsBoundaryTarget('/register?event=tokems26')).toBe(
      '/register?event=tokems26',
    );
    expect(localAnalyticsBoundaryTarget('//outside.example/register')).toBe(
      '/outside.example/register',
    );
    expect(localAnalyticsBoundaryTarget('\\outside.example/register')).toBe(
      '/%5Coutside.example/register',
    );
  });

  it('loads analytics on ordinary public errors and keeps sensitive errors isolated', () => {
    expect(isPublicAnalyticsErrorPath('/missing/public/page')).toBe(true);
    expect(isPublicAnalyticsErrorPath('/account/missing')).toBe(false);
    expect(isPublicAnalyticsErrorPath('/pay/hui/missing')).toBe(false);
    expect(isPublicAnalyticsErrorPath('/missing/public/page', true)).toBe(false);

    const publicError = analyticsNavigationContext(
      googleSettings,
      '/missing/public/page',
      false,
      true,
    );
    expect(shouldSendAnalyticsPageView(null, publicError)).toBe(true);
  });

  it('sends one manual initial view for GA4 and skips duplicates on the same route', () => {
    const initial = analyticsNavigationContext(googleSettings, '/tokems26');
    expect(shouldSendAnalyticsPageView(null, initial)).toBe(true);
    expect(shouldSendAnalyticsPageView(initial, initial)).toBe(false);

    const next = analyticsNavigationContext(googleSettings, '/faq');
    expect(shouldSendAnalyticsPageView(initial, next)).toBe(true);
  });

  it('does not report a transition into a sensitive route', () => {
    const previous = analyticsNavigationContext(googleSettings, '/tokems26');
    const sensitive = analyticsNavigationContext(googleSettings, '/register');
    expect(shouldSendAnalyticsPageView(previous, sensitive)).toBe(false);
  });

  it('keeps an unconfirmed legacy configuration inactive', () => {
    const legacy = analyticsNavigationContext(
      { ...googleSettings, activationVersion: null },
      '/tokems26',
    );
    expect(legacy.eligible).toBe(false);
    expect(shouldSendAnalyticsPageView(null, legacy)).toBe(false);
  });
});
