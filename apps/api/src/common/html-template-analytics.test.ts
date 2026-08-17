import { describe, expect, it } from 'vitest';
import { OrganizationSettingsSchema, analyticsSettingsFromSnippet } from '@conference/contracts';
import {
  injectPublishedAnalyticsHead,
  publishedAnalyticsCspSources,
  publishedHtmlEtag,
} from './html-template-operations.service.js';

const html = '<!doctype html><html><head><title>大会</title></head><body>内容</body></html>';
const googleSnippet = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC12345"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-ABC12345');
</script>`;

function organizationAnalytics(enabled: boolean) {
  return OrganizationSettingsSchema.parse({
    brandName: '大会管理中心',
    analytics: analyticsSettingsFromSnippet(googleSnippet, enabled),
  }).analytics;
}

describe('published HTML analytics injection', () => {
  it('places one normalized GA4 loader and one config script inside head', () => {
    const once = injectPublishedAnalyticsHead(html, organizationAnalytics(true));
    const twice = injectPublishedAnalyticsHead(once, organizationAnalytics(true));

    expect(twice.match(/data-tok-analytics=/gu)).toHaveLength(2);
    expect(twice.indexOf('data-tok-analytics=')).toBeLessThan(twice.indexOf('</head>'));
    expect(twice).toContain('https://www.googletagmanager.com/gtag/js?id=G-ABC12345');
  });

  it('allows only the active provider resources and exact inline script hash', () => {
    const sources = publishedAnalyticsCspSources(organizationAnalytics(true));

    expect(sources.script).toContain('https://www.googletagmanager.com');
    expect(sources.script.filter((source) => source.startsWith("'sha256-"))).toHaveLength(1);
    expect(sources.connect).toEqual([
      'https://www.google-analytics.com',
      'https://region1.google-analytics.com',
    ]);
  });

  it('removes analytics immediately when disabled and changes the document etag', () => {
    const enabled = injectPublishedAnalyticsHead(html, organizationAnalytics(true));
    const disabled = injectPublishedAnalyticsHead(enabled, organizationAnalytics(false));

    expect(disabled).not.toContain('data-tok-analytics=');
    expect(publishedAnalyticsCspSources(organizationAnalytics(false))).toEqual({
      script: [],
      connect: [],
      image: [],
    });
    expect(publishedHtmlEtag(enabled)).not.toBe(publishedHtmlEtag(disabled));
  });
});
