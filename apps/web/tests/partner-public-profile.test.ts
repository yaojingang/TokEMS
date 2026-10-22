import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import * as vue from 'vue';
import * as serverRenderer from 'vue/server-renderer';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as contracts from '@conference/contracts';
import type { PublicPartnerDetail } from '@conference/contracts';

const { descriptor } = parse(readFileSync(new URL('../app/pages/partners/[publicSlug].vue', import.meta.url), 'utf8'));
const compiled = compileScript(descriptor, {
  id: 'partner-public-profile-test',
  inlineTemplate: true,
  templateOptions: { ssr: true },
});
const code = ts.transpileModule(compiled.content.replaceAll('import.meta.client', 'false'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const profile: PublicPartnerDetail = {
  publicSlug: 'public-fixture', displayName: '测试伙伴', company: '', title: '', industry: '',
  businessIntro: '', avatarUrl: null, searchIndexingEnabled: false, gallery: [], referralPath: '',
  posterFields: contracts.DEFAULT_PARTNER_POSTER_FIELDS,
  event: { id: 101, slug: 'tokems26', name: '测试大会', city: '深圳', startsAt: '2026-11-21T01:00:00Z', endsAt: '2026-11-22T10:00:00Z' },
};

async function render(overrides: Partial<PublicPartnerDetail> = {}) {
  const partner = { ...profile, ...overrides };
  const imports: Record<string, unknown> = {
    vue,
    'vue/server-renderer': serverRenderer,
    '@conference/contracts': contracts,
    '#imports': {
      useAsyncData: async (_key: unknown, handler: () => Promise<PublicPartnerDetail>) => ({
        data: vue.ref(await handler()), error: vue.ref(null),
      }),
      useRequestURL: () => new URL('https://conference.example/partners/public-fixture?event=tokems26'),
    },
    '~/utils/personal-event-poster': { renderPersonalEventPoster: () => undefined },
    'qrcode.vue': { __esModule: true, default: vue.defineComponent(() => () => vue.h('div')) },
  };
  const module = { exports: {} as { default: vue.Component } };
  // Compile the actual page for server rendering; only its Nuxt and canvas boundaries are stubbed.
  const evaluate = new Function('require', 'module', 'exports', 'computed', 'ref', 'onMounted', 'useRoute', 'useConferenceApi', 'useHead', code);
  evaluate((name: string) => {
    if (!(name in imports)) throw new Error(`Unexpected page dependency: ${name}`);
    return imports[name];
  }, module, module.exports, vue.computed, vue.ref, vue.onMounted,
  () => ({ query: { event: 'tokems26' }, params: { publicSlug: partner.publicSlug } }),
  () => ({ getEventPartner: async () => partner }), () => undefined);
  const app = vue.createSSRApp(module.exports.default);
  app.component('EventPublicNav', vue.defineComponent(() => () => null));
  app.component('NuxtLink', vue.defineComponent({
    props: ['to'], setup: (props, { slots }) => () => vue.h('a', { href: props.to }, slots.default?.()),
  }));
  return serverRenderer.renderToString(app);
}

const fields = (html: string) => html.match(/<dl class="profile-fields"[^>]*>([\s\S]*?)<\/dl>/)?.[1] ?? '';

describe('public partner detail page', () => {
  it('offers event registration when no active referral link exists', async () => {
    const html = await render();
    expect(html).toMatch(/class="primary-action"[^>]*href="\/register\/tokems26"[^>]*>\s*报名参会\s*<\/a>/);
  });

  it('preserves an active referral link and its registration label', async () => {
    const html = await render({ referralPath: '/r/partner-example' });
    expect(html).toMatch(/class="primary-action"[^>]*href="\/r\/partner-example"[^>]*>\s*通过我报名\s*<\/a>/);
  });

  it('renders filled profile fields in the settings order and escapes text', async () => {
    const html = await render({ company: '测试公司', title: '负责人', industry: '企业服务',
      businessIntro: '<script>alert(1)</script>\n第二行介绍', businessUrl: 'https://example.com/project',
      contactPhone: '+12025550123', contactEmail: 'partner@example.com', wechatId: 'example-partner' });
    const body = fields(html);
    expect([...body.matchAll(/<dt[^>]*>(.*?)<\/dt>/g)].map(match => match[1])).toEqual([
      '公司', '职位', '行业', '个人或业务介绍', '项目网址', '联系电话', '联系邮箱', '微信号',
    ]);
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;\n第二行介绍');
    expect(body).not.toContain('<script>');
    expect(body).toContain('rel="nofollow ugc noopener noreferrer"');
    expect(body).toContain('partner@example.com');
  });

  it('hides empty, whitespace and withheld fields without empty sections', async () => {
    const empty = await render({ company: '  ', title: '\n', industry: '\t', businessIntro: ' \n ' });
    expect(fields(empty)).toBe('');
    expect(empty).not.toContain('id="partner-information-title"');
    const partial = fields(await render({ company: '公开公司' }));
    expect(partial).toContain('公开公司');
    for (const label of ['职位', '行业', '个人或业务介绍', '项目网址', '联系电话', '联系邮箱', '微信号']) {
      expect(partial).not.toContain(label);
    }
  });

  it('renders the latest introduction and removes it after it is cleared', async () => {
    expect(fields(await render({ businessIntro: '最新介绍' }))).toContain('最新介绍');
    expect(fields(await render({ businessIntro: '' }))).toBe('');
  });
});
