import { describe, expect, it } from 'vitest';
import {
  AnalyticsSettingsSchema,
  UpdateOrganizationSettingsSchema,
  analyticsHeadHtml,
  analyticsResourceOrigins,
  analyticsSettingsFromSnippet,
  analyticsSnippetFromSettings,
  isAnalyticsActive,
  parseAnalyticsSnippet,
} from './index.js';

const baiduSnippet = `<script>
var _hmt = _hmt || [];
(function() {
  var hm = document.createElement("script");
  hm.src = "https://hm.baidu.com/hm.js?0123456789abcdef0123456789abcdef";
  var s = document.getElementsByTagName("script")[0];
  s.parentNode.insertBefore(hm, s);
})();
</script>`;

const googleSnippet = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC12345"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-ABC12345');
</script>`;

const umamiSnippet =
  '<script defer src="https://analytics.example.com/script.js" data-website-id="trusted-site-id"></script>';

describe('website analytics contracts', () => {
  it.each([
    ['baidu', baiduSnippet],
    ['google', googleSnippet],
    ['umami', umamiSnippet],
  ] as const)('recognizes and regenerates a supported %s snippet', (provider, snippet) => {
    const settings = analyticsSettingsFromSnippet(snippet, true);

    expect(settings.provider).toBe(provider);
    expect(settings.activationVersion).toBe(2);
    expect(isAnalyticsActive(settings)).toBe(true);
    expect(parseAnalyticsSnippet(analyticsSnippetFromSettings(settings))).toEqual(
      parseAnalyticsSnippet(snippet),
    );
    expect(analyticsHeadHtml(settings)).toContain('data-tok-analytics=');
  });

  it('rejects arbitrary scripts, dangerous tags, insecure resources, and mismatched GA4 ids', () => {
    const invalidSnippets = [
      '<script>window.alert(1)</script>',
      `${umamiSnippet}<img src=x onerror=alert(1)>`,
      '<script defer src="http://analytics.example.com/script.js" data-website-id="trusted-site-id"></script>',
      googleSnippet.replace("gtag('config', 'G-ABC12345')", "gtag('config', 'G-DIFFERENT')"),
    ];

    for (const snippet of invalidSnippets) {
      expect(() => parseAnalyticsSnippet(snippet)).toThrow();
    }
  });

  it('rejects broken token boundaries, missing control semicolons, and lookalike Umami paths', () => {
    expect(() => parseAnalyticsSnippet(baiduSnippet.replace('var _hmt', 'var_hmt'))).toThrow(
      /标准代码不一致/u,
    );
    expect(() => parseAnalyticsSnippet(baiduSnippet.replace('|| [];', '|| []'))).toThrow(
      /标准代码不一致/u,
    );
    expect(() =>
      parseAnalyticsSnippet(umamiSnippet.replace('/script.js', '/payloadscript.js')),
    ).toThrow(/script\.js 或 umami\.js/u);
  });

  it('keeps legacy enabled settings dormant until an administrator confirms them', () => {
    const legacy = AnalyticsSettingsSchema.parse({
      enabled: true,
      provider: 'baidu',
      trackingId: '0123456789abcdef0123456789abcdef',
      scriptUrl: '',
      siteId: '',
    });

    expect(legacy.activationVersion).toBeNull();
    expect(isAnalyticsActive(legacy)).toBe(false);
    expect(analyticsHeadHtml(legacy)).toBe('');
  });

  it('keeps malformed structured settings out of every head output sink', () => {
    const malformed = {
      enabled: true,
      activationVersion: 2 as const,
      provider: 'baidu' as const,
      trackingId: '";window.alert(1);//',
      scriptUrl: '',
      siteId: '',
    };

    expect(AnalyticsSettingsSchema.safeParse(malformed).success).toBe(false);
    expect(analyticsHeadHtml(malformed)).toBe('');
    expect(analyticsResourceOrigins(malformed)).toEqual({ script: [], connect: [], image: [] });
  });

  it('opens only the resource origins required by the active platform', () => {
    expect(analyticsResourceOrigins(analyticsSettingsFromSnippet(googleSnippet, true))).toEqual({
      script: ['https://www.googletagmanager.com'],
      connect: ['https://www.google-analytics.com', 'https://region1.google-analytics.com'],
      image: ['https://www.google-analytics.com'],
    });
  });

  it('prevents the generic organization settings contract from changing analytics', () => {
    expect(
      UpdateOrganizationSettingsSchema.safeParse({
        settings: { analytics: analyticsSettingsFromSnippet(baiduSnippet, true) },
      }).success,
    ).toBe(false);
  });
});
