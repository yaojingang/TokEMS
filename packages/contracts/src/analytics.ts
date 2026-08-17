export const CURRENT_ANALYTICS_ACTIVATION_VERSION = 2 as const;
export const MAX_ANALYTICS_SNIPPET_LENGTH = 20_000;

export type AnalyticsProvider = 'baidu' | 'google' | 'umami';

export interface AnalyticsSettingsLike {
  enabled: boolean;
  activationVersion: typeof CURRENT_ANALYTICS_ACTIVATION_VERSION | null;
  provider: AnalyticsProvider;
  trackingId: string;
  scriptUrl: string;
  siteId: string;
}

export const DEFAULT_ANALYTICS_SETTINGS = {
  enabled: false,
  activationVersion: null,
  provider: 'baidu',
  trackingId: '',
  scriptUrl: '',
  siteId: '',
} satisfies AnalyticsSettingsLike;

export interface AnalyticsHeadScript {
  key: string;
  src?: string;
  async?: boolean;
  defer?: boolean;
  type?: string;
  innerHTML?: string;
  'data-website-id'?: string;
  'data-auto-track'?: 'false';
}

export interface ParsedAnalyticsSnippet {
  provider: AnalyticsProvider;
  trackingId: string;
  scriptUrl: string;
  siteId: string;
}

export class AnalyticsSnippetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsSnippetError';
  }
}

type ScriptTag = {
  attributes: Map<string, string>;
  content: string;
};

function parseAttributes(value: string) {
  const attributes = new Map<string, string>();
  const source = value.trim();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/guy;
  let offset = 0;
  while (offset < source.length) {
    while (/\s/u.test(source[offset] ?? '')) offset += 1;
    if (offset >= source.length) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match || match.index !== offset) {
      throw new AnalyticsSnippetError('统计代码包含无法识别的脚本属性');
    }
    const name = match[1]!.toLowerCase();
    if (attributes.has(name)) {
      throw new AnalyticsSnippetError(`统计代码包含重复属性：${name}`);
    }
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    offset = pattern.lastIndex;
  }
  return attributes;
}

function extractScriptTags(value: string): ScriptTag[] {
  const snippet = value.trim();
  if (!snippet) throw new AnalyticsSnippetError('请粘贴统计平台提供的完整代码');
  if (snippet.length > MAX_ANALYTICS_SNIPPET_LENGTH) {
    throw new AnalyticsSnippetError('统计代码不能超过 20000 个字符');
  }
  if (snippet.includes('\0')) throw new AnalyticsSnippetError('统计代码包含无效字符');

  const withoutComments = snippet.replace(/<!--[\s\S]*?-->/gu, '');
  const scripts: ScriptTag[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
  const residual = withoutComments.replace(
    pattern,
    (_match, attributes: string, content: string) => {
      scripts.push({ attributes: parseAttributes(attributes), content });
      return '';
    },
  );
  if (residual.trim()) {
    throw new AnalyticsSnippetError('统计代码只能包含受支持平台的 script 标签');
  }
  if (!scripts.length) throw new AnalyticsSnippetError('没有找到可识别的统计脚本');
  return scripts;
}

function assertAllowedAttributes(attributes: Map<string, string>, allowed: string[]) {
  const unexpected = [...attributes.keys()].filter((name) => !allowed.includes(name));
  if (unexpected.length) {
    throw new AnalyticsSnippetError(`统计代码包含不受支持的属性：${unexpected.join('、')}`);
  }
  const type = attributes.get('type');
  if (type && !['text/javascript', 'application/javascript'].includes(type.toLowerCase())) {
    throw new AnalyticsSnippetError('统计脚本 type 属性不受支持');
  }
}

function javascriptTokens(value: string) {
  const tokens: string[] = [];
  const operators = ['===', '!==', '=>', '==', '!=', '||', '&&', '??', '?.', '++', '--'];
  let offset = 0;
  while (offset < value.length) {
    const character = value[offset]!;
    if (/\s/u.test(character)) {
      offset += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let content = '';
      let closed = false;
      offset += 1;
      while (offset < value.length) {
        const stringCharacter = value[offset]!;
        if (stringCharacter === quote) {
          offset += 1;
          closed = true;
          break;
        }
        if (stringCharacter === '\\') {
          content += `${stringCharacter}${value[offset + 1] ?? ''}`;
          offset += 2;
          continue;
        }
        content += stringCharacter;
        offset += 1;
      }
      if (!closed) throw new AnalyticsSnippetError('统计代码包含未闭合的字符串');
      tokens.push(`string:${content}`);
      continue;
    }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(value.slice(offset))?.[0];
    if (identifier) {
      tokens.push(`identifier:${identifier}`);
      offset += identifier.length;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/u.exec(value.slice(offset))?.[0];
    if (number) {
      tokens.push(`number:${number}`);
      offset += number.length;
      continue;
    }
    const operator = operators.find((candidate) => value.startsWith(candidate, offset));
    if (operator) {
      tokens.push(`operator:${operator}`);
      offset += operator.length;
      continue;
    }
    tokens.push(`punctuation:${character}`);
    offset += 1;
  }
  return tokens;
}

function hasStandardJavascriptStructure(value: string, standard: string) {
  return JSON.stringify(javascriptTokens(value)) === JSON.stringify(javascriptTokens(standard));
}

function httpsUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AnalyticsSnippetError(`${label}不是有效链接`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new AnalyticsSnippetError(`${label}必须使用不含账号信息的 HTTPS 地址`);
  }
  return url;
}

function baiduInlineScript(trackingId: string) {
  return `var _hmt = _hmt || [];
(function() {
  var hm = document.createElement("script");
  hm.src = "https://hm.baidu.com/hm.js?${trackingId}";
  var s = document.getElementsByTagName("script")[0];
  s.parentNode.insertBefore(hm, s);
})();`;
}

function googleInlineScript(trackingId: string, automaticPageView = true) {
  return `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${trackingId}'${automaticPageView ? '' : ', { send_page_view: false }'});`;
}

function parseBaidu(scripts: ScriptTag[]): ParsedAnalyticsSnippet {
  if (scripts.length !== 1) throw new AnalyticsSnippetError('百度统计代码应只包含一个脚本');
  const script = scripts[0]!;
  assertAllowedAttributes(script.attributes, ['type']);
  const trackingId = /https:\/\/hm\.baidu\.com\/hm\.js\?([a-f0-9]{32})/iu.exec(script.content)?.[1];
  if (!trackingId) throw new AnalyticsSnippetError('无法识别百度统计站点 ID');
  if (!hasStandardJavascriptStructure(script.content, baiduInlineScript(trackingId))) {
    throw new AnalyticsSnippetError('百度统计代码结构与官方标准代码不一致');
  }
  return {
    provider: 'baidu',
    trackingId,
    scriptUrl: `https://hm.baidu.com/hm.js?${trackingId}`,
    siteId: '',
  };
}

function parseGoogle(scripts: ScriptTag[]): ParsedAnalyticsSnippet {
  if (scripts.length !== 2) throw new AnalyticsSnippetError('GA4 代码应包含加载和配置两个脚本');
  const external = scripts.find((script) => script.attributes.has('src'));
  const inline = scripts.find((script) => !script.attributes.has('src'));
  if (!external || !inline) throw new AnalyticsSnippetError('GA4 代码缺少加载或配置脚本');
  assertAllowedAttributes(external.attributes, ['src', 'async', 'type']);
  assertAllowedAttributes(inline.attributes, ['type']);
  if (external.content.trim()) throw new AnalyticsSnippetError('GA4 外部脚本不能包含内联代码');
  if (!external.attributes.has('async'))
    throw new AnalyticsSnippetError('GA4 加载脚本必须使用 async');

  const url = httpsUrl(external.attributes.get('src') ?? '', 'GA4 脚本地址');
  if (url.origin !== 'https://www.googletagmanager.com' || url.pathname !== '/gtag/js') {
    throw new AnalyticsSnippetError('GA4 脚本必须来自 www.googletagmanager.com/gtag/js');
  }
  if (
    [...url.searchParams.keys()].some((key) => key !== 'id') ||
    [...url.searchParams.keys()].length !== 1
  ) {
    throw new AnalyticsSnippetError('GA4 脚本地址包含不受支持的参数');
  }
  const trackingId = (url.searchParams.get('id') ?? '').toUpperCase();
  if (!/^G-[A-Z0-9]{4,32}$/u.test(trackingId)) {
    throw new AnalyticsSnippetError('无法识别 GA4 Measurement ID');
  }
  const inlineTrackingId = /gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]{4,32})['"]\s*\)/iu
    .exec(inline.content)?.[1]
    ?.toUpperCase();
  if (inlineTrackingId !== trackingId) {
    throw new AnalyticsSnippetError('GA4 加载脚本与配置脚本使用了不同的 Measurement ID');
  }
  if (!hasStandardJavascriptStructure(inline.content, googleInlineScript(trackingId))) {
    throw new AnalyticsSnippetError('GA4 配置脚本结构与官方标准代码不一致');
  }
  return { provider: 'google', trackingId, scriptUrl: url.toString(), siteId: '' };
}

function parseUmami(scripts: ScriptTag[]): ParsedAnalyticsSnippet {
  if (scripts.length !== 1) throw new AnalyticsSnippetError('Umami 代码应只包含一个脚本');
  const script = scripts[0]!;
  assertAllowedAttributes(script.attributes, ['src', 'async', 'defer', 'type', 'data-website-id']);
  if (script.content.trim()) throw new AnalyticsSnippetError('Umami 外部脚本不能包含内联代码');
  if (!script.attributes.has('async') && !script.attributes.has('defer')) {
    throw new AnalyticsSnippetError('Umami 脚本必须使用 async 或 defer');
  }
  const scriptUrl = httpsUrl(script.attributes.get('src') ?? '', 'Umami 脚本地址');
  if (!/(?:^|\/)(?:script|umami)\.js$/iu.test(scriptUrl.pathname)) {
    throw new AnalyticsSnippetError('Umami 脚本地址必须指向 script.js 或 umami.js');
  }
  const siteId = (script.attributes.get('data-website-id') ?? '').trim();
  if (!/^[a-z0-9_-]{6,200}$/iu.test(siteId)) {
    throw new AnalyticsSnippetError('无法识别 Umami Website ID');
  }
  return {
    provider: 'umami',
    trackingId: '',
    scriptUrl: scriptUrl.toString(),
    siteId,
  };
}

export function parseAnalyticsSnippet(value: string): ParsedAnalyticsSnippet {
  const scripts = extractScriptTags(value);
  const source = value.toLowerCase();
  if (source.includes('hm.baidu.com/hm.js') || source.includes('_hmt')) return parseBaidu(scripts);
  if (source.includes('googletagmanager.com/gtag/js') || source.includes('gtag(')) {
    return parseGoogle(scripts);
  }
  if (scripts.some((script) => script.attributes.has('data-website-id'))) {
    return parseUmami(scripts);
  }
  throw new AnalyticsSnippetError('当前仅支持百度统计、Google Analytics 4 和 Umami');
}

export function analyticsSettingsFromSnippet(
  value: string,
  enabled: boolean,
): AnalyticsSettingsLike {
  const parsed = parseAnalyticsSnippet(value);
  return {
    enabled,
    activationVersion: CURRENT_ANALYTICS_ACTIVATION_VERSION,
    ...parsed,
  };
}

export function isAnalyticsActive(settings: AnalyticsSettingsLike | undefined | null) {
  return Boolean(
    settings?.enabled && settings.activationVersion === CURRENT_ANALYTICS_ACTIVATION_VERSION,
  );
}

export function isAnalyticsConfigurationSafe(settings: AnalyticsSettingsLike | undefined | null) {
  if (!settings) return false;
  if (settings.provider === 'baidu') return /^[a-f0-9]{32}$/iu.test(settings.trackingId);
  if (settings.provider === 'google') return /^G-[A-Z0-9]{4,32}$/iu.test(settings.trackingId);
  if (!/^[a-z0-9_-]{6,200}$/iu.test(settings.siteId)) return false;
  try {
    const scriptUrl = new URL(settings.scriptUrl);
    return Boolean(
      scriptUrl.protocol === 'https:' &&
      !scriptUrl.username &&
      !scriptUrl.password &&
      /(?:^|\/)(?:script|umami)\.js$/iu.test(scriptUrl.pathname),
    );
  } catch {
    return false;
  }
}

export function analyticsHeadScripts(
  settings: AnalyticsSettingsLike | undefined | null,
  options: { spa?: boolean } = {},
): AnalyticsHeadScript[] {
  if (!settings || !isAnalyticsActive(settings) || !isAnalyticsConfigurationSafe(settings)) {
    return [];
  }
  if (settings.provider === 'baidu' && settings.trackingId) {
    return [{ key: 'analytics-baidu', innerHTML: baiduInlineScript(settings.trackingId) }];
  }
  if (settings.provider === 'google' && settings.trackingId) {
    return [
      {
        key: 'analytics-google-loader',
        src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(settings.trackingId)}`,
        async: true,
      },
      {
        key: 'analytics-google-config',
        innerHTML: googleInlineScript(settings.trackingId, !options.spa),
      },
    ];
  }
  if (settings.provider === 'umami' && settings.scriptUrl && settings.siteId) {
    return [
      {
        key: 'analytics-umami',
        src: new URL(settings.scriptUrl).toString(),
        defer: true,
        'data-website-id': settings.siteId,
        ...(options.spa ? { 'data-auto-track': 'false' as const } : {}),
      },
    ];
  }
  return [];
}

function escapeAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function analyticsHeadHtml(settings: AnalyticsSettingsLike | undefined | null) {
  return analyticsHeadScripts(settings)
    .map((script) => {
      const attributes = [
        script.src ? `src="${escapeAttribute(script.src)}"` : '',
        script.async ? 'async' : '',
        script.defer ? 'defer' : '',
        script.type ? `type="${escapeAttribute(script.type)}"` : '',
        script['data-website-id']
          ? `data-website-id="${escapeAttribute(script['data-website-id'])}"`
          : '',
        script['data-auto-track'] ? 'data-auto-track="false"' : '',
        `data-tok-analytics="${escapeAttribute(script.key)}"`,
      ].filter(Boolean);
      return `<script ${attributes.join(' ')}>${script.innerHTML ?? ''}</script>`;
    })
    .join('\n');
}

export function analyticsSnippetFromSettings(settings: AnalyticsSettingsLike | undefined | null) {
  if (!settings) return '';
  const scripts = analyticsHeadScripts({
    ...settings,
    enabled: true,
    activationVersion: CURRENT_ANALYTICS_ACTIVATION_VERSION,
  });
  return scripts
    .map((script) => {
      const attributes = [
        script.src ? `src="${script.src}"` : '',
        script.async ? 'async' : '',
        script.defer ? 'defer' : '',
        script['data-website-id'] ? `data-website-id="${script['data-website-id']}"` : '',
      ].filter(Boolean);
      return `<script${attributes.length ? ` ${attributes.join(' ')}` : ''}>${script.innerHTML ?? ''}</script>`;
    })
    .join('\n');
}

export function analyticsResourceOrigins(settings: AnalyticsSettingsLike | undefined | null) {
  if (!settings || !isAnalyticsActive(settings) || !isAnalyticsConfigurationSafe(settings)) {
    return { script: [] as string[], connect: [] as string[], image: [] as string[] };
  }
  if (settings.provider === 'baidu') {
    return {
      script: ['https://hm.baidu.com'],
      connect: ['https://hm.baidu.com'],
      image: ['https://hm.baidu.com'],
    };
  }
  if (settings.provider === 'google') {
    return {
      script: ['https://www.googletagmanager.com'],
      connect: ['https://www.google-analytics.com', 'https://region1.google-analytics.com'],
      image: ['https://www.google-analytics.com'],
    };
  }
  const origin = new URL(settings.scriptUrl).origin;
  return { script: [origin], connect: [origin], image: [] as string[] };
}

export function analyticsProviderLabel(provider: AnalyticsProvider) {
  return provider === 'baidu' ? '百度统计' : provider === 'google' ? 'Google Analytics 4' : 'Umami';
}
