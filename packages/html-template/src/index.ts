import { createHash } from 'node:crypto';
import {
  HtmlTemplateBindingManifestSchema,
  HtmlTemplateBindingProposalSchema,
  type HtmlTemplateBindingManifest,
  type HtmlTemplateBindingProposal,
  type HtmlTemplateTextSegment,
  type HtmlTemplateVariablePath,
} from '@conference/contracts';
import createDOMPurify from 'dompurify';
import ipaddr from 'ipaddr.js';
import { JSDOM } from 'jsdom';
import { Liquid } from 'liquidjs';
import { parse, serialize } from 'parse5';
import postcss from 'postcss';

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SANITIZED_BYTES = 2 * 1024 * 1024;
const MAX_DOM_NODES = 10_000;
const MAX_CANDIDATES = 5_000;
const MAX_CSS_RULES = 5_000;
const MAX_CSS_SELECTORS = 10_000;
const LITERAL_LIQUID_OUTPUT_OPEN = '__TOKEMS_LITERAL_LIQUID_OUTPUT_OPEN_7F31C9__';
const LITERAL_LIQUID_TAG_OPEN = '__TOKEMS_LITERAL_LIQUID_TAG_OPEN_7F31C9__';

export function isForbiddenNetworkAddress(address: string) {
  const candidate =
    address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (!ipaddr.isValid(candidate)) return true;
  const parsed = ipaddr.parse(candidate);
  if (parsed.kind() === 'ipv6') {
    const ipv6 = ipaddr.IPv6.parse(candidate);
    if (ipv6.zoneId) return true;
    if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address().range() !== 'unicast';
  }
  return parsed.range() !== 'unicast';
}

export interface HtmlTemplateVariableCatalogItem {
  path: string;
  label: string;
  category: '大会' | '时间地点' | '数据' | '票种' | '嘉宾议程' | '链接' | '站点';
  type: 'text' | 'number' | 'boolean' | 'datetime' | 'collection' | 'url';
  description: string;
  formats: string[];
  required: boolean;
}

export const HTML_TEMPLATE_VARIABLE_CATALOG_VERSION = 2;
export const HTML_TEMPLATE_VARIABLE_CATALOG: HtmlTemplateVariableCatalogItem[] = [
  {
    path: 'event.name',
    label: '大会名称',
    category: '大会',
    type: 'text',
    description: '大会完整名称',
    formats: ['plain'],
    required: true,
  },
  {
    path: 'event.shortName',
    label: '大会简称',
    category: '大会',
    type: 'text',
    description: '导航与紧凑区域使用的大会简称',
    formats: ['plain'],
    required: true,
  },
  {
    path: 'event.tagline',
    label: '大会主张',
    category: '大会',
    type: 'text',
    description: '大会对外传播主张',
    formats: ['plain'],
    required: false,
  },
  {
    path: 'event.description',
    label: '大会介绍',
    category: '大会',
    type: 'text',
    description: '大会公开介绍',
    formats: ['plain'],
    required: false,
  },
  ...(
    [
      ['event.startsAt', '开始时间', '大会开始日期与时间'],
      ['event.endsAt', '结束时间', '大会结束日期与时间'],
    ] as const
  ).map(([path, label, description]) => ({
    path,
    label,
    category: '时间地点' as const,
    type: 'datetime' as const,
    description,
    formats: ['date-long', 'date-short', 'time', 'datetime'],
    required: true,
  })),
  ...(
    [
      ['event.venue', '会场名称', '大会举办场馆'],
      ['event.city', '举办城市', '大会举办城市'],
      ['event.address', '会场地址', '大会详细地址'],
    ] as const
  ).map(([path, label, description]) => ({
    path,
    label,
    category: '时间地点' as const,
    type: 'text' as const,
    description,
    formats: ['plain'],
    required: false,
  })),
  ...(
    [
      ['event.stats.seats', '参会席位'],
      ['event.stats.speakers', '嘉宾数量'],
      ['event.stats.days', '大会天数'],
      ['event.stats.attendeeSatisfaction', '满意度'],
    ] as const
  ).map(([path, label]) => ({
    path,
    label,
    category: '数据' as const,
    type: 'number' as const,
    description: label,
    formats: ['integer', 'decimal'],
    required: false,
  })),
  ...(
    [
      ['tickets', '票种列表', '公开票种集合'],
      ['speakers', '嘉宾列表', '公开嘉宾集合'],
      ['sessions', '议程列表', '公开议程集合'],
      ['faqs', '常见问题', '公开常见问题集合'],
    ] as const
  ).map(([path, label, description]) => ({
    path,
    label,
    category: path === 'tickets' ? ('票种' as const) : ('嘉宾议程' as const),
    type: 'collection' as const,
    description,
    formats: ['plain'],
    required: false,
  })),
  ...(
    [
      ['routes.registration', '报名页链接', 'TokEMS 同源报名路径'],
      ['routes.cooperation', '合作申请链接', 'TokEMS 同源合作申请路径'],
      ['routes.faq', '常见问题链接', 'TokEMS 同源常见问题路径'],
      ['routes.account', '个人中心链接', 'TokEMS 同源个人中心路径'],
    ] as const
  ).map(([path, label, description]) => ({
    path,
    label,
    category: '链接' as const,
    type: 'url' as const,
    description,
    formats: ['plain'],
    required: true,
  })),
  ...(
    [
      ['site.footerText', '页脚文案'],
      ['site.supportEmail', '支持邮箱'],
      ['site.icpNumber', '备案号'],
    ] as const
  ).map(([path, label]) => ({
    path,
    label,
    category: '站点' as const,
    type: 'text' as const,
    description: label,
    formats: ['plain'],
    required: false,
  })),
];

const FORBIDDEN_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'base',
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'svg',
  'math',
] as const;

const NON_BINDABLE_TAGS = new Set([
  'html',
  'head',
  'body',
  'title',
  'meta',
  'link',
  'style',
  'noscript',
]);

export interface HtmlTemplateNode {
  id: string;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  bindable: boolean;
}

export interface HtmlTemplateResource {
  nodeId: string | null;
  attribute: 'src' | 'srcset' | 'style';
  url: string;
  kind: 'data-image' | 'remote-image' | 'relative-image' | 'css-url';
}

export interface HtmlTemplateSecurityReport {
  removedTags: string[];
  removedAttributes: string[];
  warnings: string[];
  blockers: string[];
}

export interface SanitizedHtmlTemplate {
  sanitizedHtml: string;
  sanitizedDigest: string;
  sourceDigest: string;
  nodeManifest: HtmlTemplateNode[];
  resourceManifest: HtmlTemplateResource[];
  securityReport: HtmlTemplateSecurityReport;
  metadata: {
    title: string;
    description: string;
    faviconUrl: string;
  };
}

export interface HtmlTemplateResourceReplacement {
  sourceUrl: string;
  targetUrl: string;
  assetId: string;
  mediaType: string;
  size: number;
  contentDigest: string;
}

export interface CompiledHtmlTemplate {
  compilerVersion: 1;
  liquidSource: string;
  compiledDigest: string;
  bindingDigest: string;
  bindings: HtmlTemplateBindingManifest;
}

export class HtmlTemplateCompileError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'SOURCE_TOO_LARGE'
      | 'INVALID_SOURCE'
      | 'DOM_TOO_LARGE'
      | 'CSS_INVALID'
      | 'SANITIZED_TOO_LARGE'
      | 'INVALID_BINDING'
      | 'RENDER_FAILED',
  ) {
    super(message);
    this.name = 'HtmlTemplateCompileError';
  }
}

export function sha256Digest(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function templateAssetIdFromUrl(value: string): string | null {
  return (
    /^\/api\/v1\/assets\/templates\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu
      .exec(value)?.[1]
      ?.toLowerCase() ?? null
  );
}

function normalizeSource(source: string): string {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new HtmlTemplateCompileError('HTML 源文件不能超过 5 MiB', 'SOURCE_TOO_LARGE');
  }
  if (source.includes('\0')) {
    throw new HtmlTemplateCompileError('HTML 源文件包含 NUL 字节', 'INVALID_SOURCE');
  }
  const trimmed = source.trim();
  if (!trimmed) {
    throw new HtmlTemplateCompileError('HTML 源文件不能为空', 'INVALID_SOURCE');
  }
  return serialize(parse(trimmed));
}

function ownVisibleText(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function sortedAttributes(element: Element): Record<string, string> {
  return Object.fromEntries(
    Array.from(element.attributes)
      .map((attribute) => [attribute.name, attribute.value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function encodeTemplateDelimiters(html: string): string {
  return html
    .replaceAll('{{', LITERAL_LIQUID_OUTPUT_OPEN)
    .replaceAll('{%', LITERAL_LIQUID_TAG_OPEN);
}

function restoreTemplateDelimiters(html: string): string {
  return html
    .replaceAll(LITERAL_LIQUID_OUTPUT_OPEN, '&#123;&#123;')
    .replaceAll(LITERAL_LIQUID_TAG_OPEN, '&#123;%');
}

function collectCssEvidence(
  document: Document,
  resources: HtmlTemplateResource[],
  warnings: string[],
  blockers: string[],
): void {
  for (const style of Array.from(document.querySelectorAll('style'))) {
    try {
      const root = postcss.parse(style.textContent ?? '', { from: undefined });
      let ruleCount = 0;
      let selectorCount = 0;
      root.walkRules((rule) => {
        ruleCount += 1;
        selectorCount += rule.selectors.length;
      });
      if (ruleCount > MAX_CSS_RULES || selectorCount > MAX_CSS_SELECTORS) {
        throw new HtmlTemplateCompileError(
          `CSS 复杂度超过限制（规则 ${ruleCount}，选择器 ${selectorCount}）`,
          'CSS_INVALID',
        );
      }
      root.walkComments((comment) => {
        if (/sourceMappingURL/iu.test(comment.text)) {
          comment.remove();
          warnings.push('CSS source map 声明已移除');
        }
      });
      root.walkAtRules('import', (rule) => {
        blockers.push(`外部 CSS 导入已禁止：${rule.params.slice(0, 160)}`);
        rule.remove();
      });
      root.walkDecls((declaration) => {
        if (
          ['behavior', '-moz-binding'].includes(declaration.prop.toLowerCase()) ||
          /(?:expression\s*\(|javascript\s*:)/iu.test(declaration.value)
        ) {
          blockers.push(`危险 CSS 声明已移除：${declaration.prop}`);
          declaration.remove();
          return;
        }
        for (const match of declaration.value.matchAll(/url\((['"]?)(.*?)\1\)/giu)) {
          const url = match[2]?.trim();
          if (!url || url.startsWith('#')) continue;
          if (/^(?:javascript|vbscript):/iu.test(url)) {
            blockers.push('CSS 中的危险资源协议已移除');
            declaration.remove();
            break;
          }
          resources.push({ nodeId: null, attribute: 'style', url, kind: 'css-url' });
        }
      });
      style.textContent = root.toResult({ map: false }).css;
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知 CSS 错误';
      blockers.push(`CSS 解析失败：${message}`);
    }
  }

  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[style]'))) {
    try {
      const root = postcss.parse(`x{${element.getAttribute('style') ?? ''}}`, {
        from: undefined,
      });
      root.walkDecls((declaration) => {
        if (
          ['behavior', '-moz-binding'].includes(declaration.prop.toLowerCase()) ||
          /(?:expression\s*\(|javascript\s*:)/iu.test(declaration.value)
        ) {
          blockers.push(`危险 style 声明已移除：${declaration.prop}`);
          declaration.remove();
          return;
        }
        for (const match of declaration.value.matchAll(/url\((['"]?)(.*?)\1\)/giu)) {
          const url = match[2]?.trim();
          if (!url || url.startsWith('#')) continue;
          if (/^(?:javascript|vbscript):/iu.test(url)) {
            blockers.push('style 属性中的危险资源协议已移除');
            declaration.remove();
            break;
          }
          resources.push({
            nodeId: element.getAttribute('data-tok-node'),
            attribute: 'style',
            url,
            kind: 'css-url',
          });
        }
      });
      const wrapper = root.first;
      if (wrapper?.type === 'rule') {
        element.setAttribute('style', wrapper.nodes.map((node) => node.toString()).join(''));
      }
    } catch {
      warnings.push('一个 style 属性无法解析，已经由净化器移除危险内容');
      element.removeAttribute('style');
    }
  }
}

function resourceKind(url: string): HtmlTemplateResource['kind'] {
  if (url.startsWith('data:image/')) return 'data-image';
  if (/^https:\/\//iu.test(url)) return 'remote-image';
  return 'relative-image';
}

function srcsetUrls(value: string): string[] {
  return Array.from(
    value.matchAll(
      /(?:^|,\s*)((?:data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+)|(?:[^,\s]+))(?:\s+(?:\d+(?:\.\d+)?[wx]))?(?=\s*(?:,|$))/giu,
    ),
    (match) => match[1] ?? '',
  ).filter(Boolean);
}

const CREDENTIAL_PATTERNS = [
  {
    label: '私钥',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
  {
    label: 'Bearer 访问令牌',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/u,
  },
  {
    label: '云访问密钥',
    pattern: /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,})\b/u,
  },
  {
    label: '代码托管访问令牌',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  },
] as const;

function credentialKind(value: string, attributeName = '') {
  for (const candidate of CREDENTIAL_PATTERNS) {
    if (candidate.pattern.test(value)) return candidate.label;
  }
  const sensitiveName =
    /(?:^|[-_:])(?:api[-_]?key|access[-_]?key|secret|token|authorization|auth)(?:$|[-_:])/iu.test(
      attributeName,
    );
  const looksLikeCredential =
    value.length >= 16 &&
    /[a-z]/iu.test(value) &&
    /\d/u.test(value) &&
    !/(?:example|placeholder|replace|your[-_]|\{\{|\$\{)/iu.test(value);
  return sensitiveName && looksLikeCredential ? '访问凭据' : null;
}

function credentialEvidence(document: Document) {
  const evidence = new Set<string>();
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.pattern.test(document.documentElement.outerHTML)) evidence.add(pattern.label);
  }
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const kind = credentialKind(attribute.value, attribute.name);
      if (kind)
        evidence.add(`${kind}（${element.tagName.toLowerCase()} 的 ${attribute.name} 属性）`);
    }
  }
  return [...evidence].slice(0, 20).map((item) => `检测到疑似${item}，请移除后重新导入`);
}

function allowedAnchorHref(value: string) {
  const href = value.trim();
  if (!href || href.startsWith('#')) return true;
  if (/^(?:https:|mailto:|tel:)/iu.test(href)) return true;
  if (href.startsWith('//')) return false;
  if (href.startsWith('/')) return true;
  return !/^[a-z][a-z0-9+.-]*:/iu.test(href);
}

export function sanitizeHtmlTemplate(source: string): SanitizedHtmlTemplate {
  const normalizedSource = normalizeSource(source);
  const sourceDigest = sha256Digest(source);
  const sourceDom = new JSDOM(normalizedSource, { contentType: 'text/html' });
  const sourceDocument = sourceDom.window.document;
  const credentialBlockers = credentialEvidence(sourceDocument);

  const metadata = {
    title: (sourceDocument.title || '').trim().slice(0, 120),
    description: (
      sourceDocument.querySelector('meta[name="description"]')?.getAttribute('content') || ''
    )
      .trim()
      .slice(0, 300),
    faviconUrl: (sourceDocument.querySelector('link[rel~="icon"]')?.getAttribute('href') || '')
      .trim()
      .slice(0, 500),
  };

  const removedTags: string[] = FORBIDDEN_TAGS.filter(
    (tagName) => sourceDocument.querySelector(tagName) !== null,
  );
  if (sourceDocument.querySelector('meta[http-equiv]')) removedTags.push('meta[http-equiv]');

  const removedAttributes = Array.from(sourceDocument.querySelectorAll('*'))
    .flatMap((element) =>
      Array.from(element.attributes)
        .filter(
          (attribute) =>
            attribute.name.toLowerCase().startsWith('on') ||
            attribute.name === 'srcdoc' ||
            attribute.name.toLowerCase().startsWith('data-tok-'),
        )
        .map((attribute) => attribute.name.toLowerCase()),
    )
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();

  const purifier = createDOMPurify(sourceDom.window);
  const purified = purifier.sanitize(normalizedSource, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: [...FORBIDDEN_TAGS],
    FORBID_ATTR: ['srcdoc'],
    ALLOW_DATA_ATTR: true,
  });
  const dom = new JSDOM(purified, { contentType: 'text/html' });
  const document = dom.window.document;
  const warnings: string[] = [];
  const blockers: string[] = [...credentialBlockers];

  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith('data-tok-')) {
        element.removeAttribute(attribute.name);
      } else if (credentialKind(attribute.value, attribute.name)) {
        element.removeAttribute(attribute.name);
        if (!removedAttributes.includes(attribute.name.toLowerCase())) {
          removedAttributes.push(attribute.name.toLowerCase());
        }
      }
    }
  }

  document
    .querySelectorAll('meta[http-equiv], meta[name="description"], link[rel~="icon"]')
    .forEach((node) => node.remove());
  document.documentElement.setAttribute('lang', 'zh-CN');
  document.head.querySelector('meta[charset]')?.remove();
  document.head.insertAdjacentHTML('afterbegin', '<meta charset="utf-8">');
  document.head.querySelector('meta[name="viewport"]')?.remove();
  document.head.insertAdjacentHTML(
    'beforeend',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );

  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = anchor.getAttribute('href')?.trim() ?? '';
    if (!allowedAnchorHref(href)) {
      anchor.removeAttribute('href');
      if (!removedAttributes.includes('href')) removedAttributes.push('href');
      blockers.push('检测到不受支持的链接协议，仅允许 HTTPS、mailto、tel 或同源相对地址');
      continue;
    }
    if (/^https:\/\//iu.test(href)) {
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  }

  const allElements = Array.from(document.querySelectorAll('*'));
  if (allElements.length > MAX_DOM_NODES) {
    throw new HtmlTemplateCompileError(
      `HTML 节点数不能超过 ${MAX_DOM_NODES.toLocaleString('en-US')}`,
      'DOM_TOO_LARGE',
    );
  }

  const nodeManifest: HtmlTemplateNode[] = [];
  let nodeCounter = 0;
  for (const element of allElements) {
    const tagName = element.tagName.toLowerCase();
    if (NON_BINDABLE_TAGS.has(tagName)) continue;
    nodeCounter += 1;
    const id = `tok-${String(nodeCounter).padStart(5, '0')}`;
    element.setAttribute('data-tok-node', id);
    const text = ownVisibleText(element);
    nodeManifest.push({
      id,
      tagName,
      text,
      attributes: sortedAttributes(element),
      bindable: text.length > 0 || ['a', 'img', 'li'].includes(tagName),
    });
  }
  if (nodeManifest.filter((node) => node.bindable).length > MAX_CANDIDATES) {
    throw new HtmlTemplateCompileError(
      `可绑定节点不能超过 ${MAX_CANDIDATES.toLocaleString('en-US')}`,
      'DOM_TOO_LARGE',
    );
  }

  const resourceManifest: HtmlTemplateResource[] = [];
  for (const image of Array.from(
    document.querySelectorAll<HTMLImageElement | HTMLSourceElement>('img, source[srcset]'),
  )) {
    for (const attribute of ['src', 'srcset'] as const) {
      if (attribute === 'src' && image.tagName.toLowerCase() !== 'img') continue;
      const raw = image.getAttribute(attribute)?.trim();
      if (!raw) continue;
      const urls = attribute === 'srcset' ? srcsetUrls(raw) : [raw];
      urls.filter(Boolean).forEach((url) => {
        resourceManifest.push({
          nodeId: image.getAttribute('data-tok-node'),
          attribute,
          url,
          kind: resourceKind(url),
        });
      });
    }
  }

  if (!/^\s*(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/iu.test(source)) {
    warnings.push('导入内容是 HTML 片段，系统已补齐标准文档结构');
  }
  const missingAltCount = document.querySelectorAll('img:not([alt])').length;
  if (missingAltCount) warnings.push(`${missingAltCount} 张图片缺少 alt 文本，建议发布前补充`);
  if (!document.querySelector('main')) warnings.push('页面缺少 main 主内容区域');
  if (!document.querySelector('h1')) warnings.push('页面缺少 h1 主标题');
  collectCssEvidence(document, resourceManifest, warnings, blockers);
  if (resourceManifest.some((resource) => resource.kind === 'relative-image')) {
    warnings.push('模板包含相对图片地址，提交前需要提供来源地址或重新上传图片');
  }

  const withDoctype = `<!doctype html>${document.documentElement.outerHTML}`;
  const sanitizedHtml = encodeTemplateDelimiters(withDoctype);
  if (Buffer.byteLength(sanitizedHtml, 'utf8') > MAX_SANITIZED_BYTES) {
    throw new HtmlTemplateCompileError('净化后的 HTML 不能超过 2 MiB', 'SANITIZED_TOO_LARGE');
  }

  return {
    sanitizedHtml,
    sanitizedDigest: sha256Digest(sanitizedHtml),
    sourceDigest,
    nodeManifest,
    resourceManifest,
    securityReport: {
      removedTags: [...new Set(removedTags)].sort(),
      removedAttributes: [...new Set(removedAttributes)].sort(),
      warnings,
      blockers: [...new Set(blockers)],
    },
    metadata,
  };
}

export function rewriteHtmlTemplateResources(
  result: SanitizedHtmlTemplate,
  replacements: Array<Pick<HtmlTemplateResourceReplacement, 'sourceUrl' | 'targetUrl'>>,
): SanitizedHtmlTemplate {
  const replacementMap = new Map(
    replacements.map((replacement) => [replacement.sourceUrl, replacement.targetUrl]),
  );
  let sanitizedHtml = result.sanitizedHtml;
  for (const [sourceUrl, targetUrl] of replacementMap) {
    sanitizedHtml = sanitizedHtml.replaceAll(sourceUrl, targetUrl);
  }
  const nodeManifest = result.nodeManifest.map((node) => ({
    ...node,
    attributes: Object.fromEntries(
      Object.entries(node.attributes).map(([name, value]) => {
        let rewritten = value;
        for (const [sourceUrl, targetUrl] of replacementMap) {
          rewritten = rewritten.replaceAll(sourceUrl, targetUrl);
        }
        return [name, rewritten];
      }),
    ),
  }));
  return {
    ...result,
    sanitizedHtml,
    sanitizedDigest: sha256Digest(sanitizedHtml),
    nodeManifest,
    resourceManifest: result.resourceManifest.map((resource) => ({
      ...resource,
      url: replacementMap.get(resource.url) ?? resource.url,
    })),
  };
}

function proposalId(nodeId: string, operation: string, variablePath: string): string {
  return `rules-${sha256Digest(`${nodeId}:${operation}:${variablePath}`).slice(7, 23)}`;
}

export function suggestTemplateBindings(nodes: HtmlTemplateNode[]): HtmlTemplateBindingProposal[] {
  const proposals: HtmlTemplateBindingProposal[] = [];
  const titleNode = nodes.find((node) => node.tagName === 'h1' && node.text.length > 1);
  if (titleNode) {
    proposals.push({
      proposalId: proposalId(titleNode.id, 'text', 'event.name'),
      nodeId: titleNode.id,
      operation: 'text',
      binding: {
        id: `event-name-${titleNode.id}`,
        kind: 'text',
        nodeId: titleNode.id,
        missingPolicy: 'error',
        segments: [{ kind: 'variable', path: 'event.name', format: 'plain' }],
      },
      originalValue: titleNode.text,
      confidence: 0.96,
      reason: '页面主标题通常对应大会名称',
      source: 'rules',
    });
  }

  for (const node of nodes) {
    const className = node.attributes.class ?? '';
    if (
      node.text &&
      /(tagline|slogan|subtitle|sub-title|hero-copy)/iu.test(className) &&
      node.id !== titleNode?.id
    ) {
      proposals.push({
        proposalId: proposalId(node.id, 'text', 'event.tagline'),
        nodeId: node.id,
        operation: 'text',
        binding: {
          id: `event-tagline-${node.id}`,
          kind: 'text',
          nodeId: node.id,
          missingPolicy: 'fallback',
          segments: [
            { kind: 'variable', path: 'event.tagline', format: 'plain', fallback: node.text },
          ],
        },
        originalValue: node.text,
        confidence: 0.84,
        reason: '节点类名和位置表明它是大会副标题或主张',
        source: 'rules',
      });
    }

    if (node.tagName !== 'a') continue;
    const normalizedText = node.text.replace(/\s+/gu, '');
    const route = /合作|赞助|媒体支持|团队购票/iu.test(normalizedText)
      ? ('routes.cooperation' as const)
      : /报名|注册|购票|参会/iu.test(normalizedText)
        ? ('routes.registration' as const)
        : /常见问题|FAQ/iu.test(normalizedText)
          ? ('routes.faq' as const)
          : /账户|个人中心|我的订单/iu.test(normalizedText)
            ? ('routes.account' as const)
            : null;
    if (!route) continue;
    proposals.push({
      proposalId: proposalId(node.id, 'attribute', route),
      nodeId: node.id,
      operation: 'attribute',
      binding: {
        id: `${route.replaceAll('.', '-')}-${node.id}`,
        kind: 'attribute',
        nodeId: node.id,
        attributeName: 'href',
        variablePath: route,
        missingPolicy: 'error',
      },
      originalValue: node.attributes.href ?? '',
      confidence: 0.99,
      reason: `业务动作文字与系统路由 ${route} 匹配`,
      source: 'rules',
    });
  }

  return proposals.slice(0, 400);
}

export function buildAiTemplateBindingProposals(
  decoded: unknown,
  nodes: HtmlTemplateNode[],
  runId: string,
): HtmlTemplateBindingProposal[] {
  if (!decoded || typeof decoded !== 'object') return [];
  const rawProposals = (decoded as { proposals?: unknown }).proposals;
  if (!Array.isArray(rawProposals)) return [];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  return rawProposals.slice(0, 400).flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const nodeId = typeof item.nodeId === 'string' ? item.nodeId : '';
    const node = nodeMap.get(nodeId);
    const variablePath = typeof item.variablePath === 'string' ? item.variablePath : '';
    if (!node) return [];
    const catalog = HTML_TEMPLATE_VARIABLE_CATALOG.find((entry) => entry.path === variablePath);
    if (!catalog) return [];
    const kind = item.kind === 'attribute' ? 'attribute' : 'text';
    const binding =
      kind === 'attribute' &&
      node.tagName === 'a' &&
      ['routes.registration', 'routes.cooperation', 'routes.faq', 'routes.account'].includes(
        variablePath,
      )
        ? {
            id: `ai-${runId.slice(0, 8)}-${index}`,
            kind: 'attribute' as const,
            nodeId,
            attributeName: 'href' as const,
            variablePath: variablePath as
              'routes.registration' | 'routes.cooperation' | 'routes.faq' | 'routes.account',
            missingPolicy: 'error' as const,
          }
        : {
            id: `ai-${runId.slice(0, 8)}-${index}`,
            kind: 'text' as const,
            nodeId,
            missingPolicy: 'fallback' as const,
            segments: [
              {
                kind: 'variable' as const,
                path: variablePath as HtmlTemplateVariablePath,
                format: catalog.type === 'datetime' ? ('date-long' as const) : ('plain' as const),
                fallback: node.text,
              },
            ],
          };
    const parsed = HtmlTemplateBindingProposalSchema.safeParse({
      proposalId: `ai-${runId.slice(0, 8)}-${index}`,
      nodeId,
      operation: binding.kind,
      binding,
      originalValue: binding.kind === 'attribute' ? (node.attributes.href ?? '') : node.text,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
      reason:
        typeof item.reason === 'string' && item.reason.trim()
          ? item.reason.trim().slice(0, 500)
          : 'AI 识别的变量候选',
      source: 'ai',
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function liquidString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function segmentSource(segment: HtmlTemplateTextSegment): string {
  if (segment.kind === 'static') return encodeTemplateDelimiters(segment.value);
  const filters: string[] = [];
  if (segment.format !== 'plain') {
    filters.push(`tok_${segment.format.replaceAll('-', '_')}`);
  }
  if (segment.fallback !== undefined) {
    filters.push(`default: ${liquidString(segment.fallback)}`);
  }
  return `{{ ${segment.path}${filters.length ? ` | ${filters.join(' | ')}` : ''} }}`;
}

function setTextBinding(element: Element, segments: HtmlTemplateTextSegment[]): void {
  element.textContent = segments.map(segmentSource).join('');
}

function validateRouteContext(context: Record<string, unknown>): void {
  const routes = context.routes;
  if (!routes || typeof routes !== 'object') return;
  Object.entries(routes).forEach(([key, value]) => {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
      throw new HtmlTemplateCompileError(`路由变量 ${key} 必须是同源绝对路径`, 'RENDER_FAILED');
    }
  });
  for (const collection of ['tickets', 'speakers', 'sessions', 'faqs']) {
    const value = context[collection];
    if (Array.isArray(value) && value.length > 500) {
      throw new HtmlTemplateCompileError(`集合 ${collection} 不能超过 500 项`, 'RENDER_FAILED');
    }
  }
}

function compileRepeatBinding(
  element: Element,
  binding: Extract<HtmlTemplateBindingManifest['bindings'][number], { kind: 'repeat' }>,
): string {
  const clone = element.cloneNode(true) as Element;
  for (const childBinding of binding.children) {
    const child = clone.matches(`[data-tok-node="${childBinding.nodeId}"]`)
      ? clone
      : clone.querySelector(`[data-tok-node="${childBinding.nodeId}"]`);
    if (!child) {
      throw new HtmlTemplateCompileError(
        `循环子绑定 ${childBinding.nodeId} 不在循环根 ${binding.nodeId} 内`,
        'INVALID_BINDING',
      );
    }
    const prefix = `${binding.collectionPath}[].`;
    if (!childBinding.variablePath.startsWith(prefix)) {
      throw new HtmlTemplateCompileError(
        `循环子变量 ${childBinding.variablePath} 与集合 ${binding.collectionPath} 不匹配`,
        'INVALID_BINDING',
      );
    }
    if (childBinding.kind !== 'text') {
      throw new HtmlTemplateCompileError('第一版循环子绑定只支持文本字段', 'INVALID_BINDING');
    }
    const itemPath = `${binding.itemAlias}.${childBinding.variablePath.slice(prefix.length)}`;
    const filter =
      childBinding.format === 'plain' ? '' : ` | tok_${childBinding.format.replaceAll('-', '_')}`;
    const fallback =
      childBinding.fallback === undefined
        ? ''
        : ` | default: ${liquidString(childBinding.fallback)}`;
    child.textContent = `{{ ${itemPath}${filter}${fallback} }}`;
  }
  const repeated = `{% for ${binding.itemAlias} in ${binding.collectionPath} %}${clone.outerHTML}{% endfor %}`;
  if (binding.emptyPolicy === 'keep-sample') {
    return `{% if ${binding.collectionPath}.size > 0 %}${repeated}{% else %}${element.outerHTML}{% endif %}`;
  }
  return repeated;
}

export function compileHtmlTemplate(
  sanitizedHtml: string,
  manifestInput: HtmlTemplateBindingManifest,
): CompiledHtmlTemplate {
  const manifest = HtmlTemplateBindingManifestSchema.parse(manifestInput);
  const dom = new JSDOM(sanitizedHtml, { contentType: 'text/html' });
  const document = dom.window.document;

  for (const binding of manifest.bindings) {
    const element = document.querySelector(`[data-tok-node="${binding.nodeId}"]`);
    if (!element) {
      throw new HtmlTemplateCompileError(`绑定目标不存在：${binding.nodeId}`, 'INVALID_BINDING');
    }
    if (binding.kind === 'text') {
      setTextBinding(element, binding.segments);
      continue;
    }
    if (binding.kind === 'attribute') {
      element.setAttribute(binding.attributeName, `{{ ${binding.variablePath} }}`);
      continue;
    }
    if (binding.kind === 'conditional') {
      const operator = binding.truthyWhen === 'nonzero' ? ' != 0' : '';
      element.outerHTML = `{% if ${binding.variablePath}${operator} %}${element.outerHTML}{% endif %}`;
      continue;
    }
    element.outerHTML = compileRepeatBinding(element, binding);
  }

  const liquidSource = `<!doctype html>${document.documentElement.outerHTML}`;
  const bindingDigest = sha256Digest(JSON.stringify(manifest));
  return {
    compilerVersion: 1,
    liquidSource,
    compiledDigest: sha256Digest(`${liquidSource}\n${bindingDigest}\n1`),
    bindingDigest,
    bindings: manifest,
  };
}

function createLiquidEngine(): Liquid {
  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true,
    outputEscape: 'escape',
    parseLimit: 2_000_000,
    renderLimit: 100_000,
    memoryLimit: 16_000_000,
  });
  engine.registerFilter('tok_date_long', (value) =>
    new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: 'Asia/Shanghai' }).format(
      new Date(String(value)),
    ),
  );
  engine.registerFilter('tok_date_short', (value) =>
    new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(
      new Date(String(value)),
    ),
  );
  engine.registerFilter('tok_time', (value) =>
    new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Shanghai',
    }).format(new Date(String(value))),
  );
  engine.registerFilter('tok_datetime', (value) =>
    new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Asia/Shanghai',
    }).format(new Date(String(value))),
  );
  engine.registerFilter('tok_currency', (value, currency = 'CNY') =>
    new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: String(currency),
      minimumFractionDigits: 0,
    }).format(Number(value) / 100),
  );
  engine.registerFilter('tok_integer', (value) =>
    new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Number(value)),
  );
  engine.registerFilter('tok_decimal', (value) =>
    new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value)),
  );
  return engine;
}

function assertRenderedInvariants(html: string): void {
  const tags = html.match(/<[^>]+>/gu) ?? [];
  for (const tag of tags) {
    if (/<\s*script\b/iu.test(tag) || /\son[a-z]+\s*=/iu.test(tag)) {
      throw new HtmlTemplateCompileError('渲染结果违反脚本安全约束', 'RENDER_FAILED');
    }
    if (/<\s*(iframe|object|embed|form)\b/iu.test(tag)) {
      throw new HtmlTemplateCompileError('渲染结果包含禁止的交互节点', 'RENDER_FAILED');
    }
  }
}

export async function renderHtmlTemplate(
  compiled: CompiledHtmlTemplate,
  context: Record<string, unknown>,
): Promise<string> {
  validateRouteContext(context);
  try {
    const engine = createLiquidEngine();
    const html = await engine.parseAndRender(compiled.liquidSource, context);
    assertRenderedInvariants(html);
    return restoreTemplateDelimiters(html);
  } catch (error) {
    if (error instanceof HtmlTemplateCompileError) throw error;
    const message = error instanceof Error ? error.message : '未知渲染错误';
    throw new HtmlTemplateCompileError(`HTML 模板渲染失败：${message}`, 'RENDER_FAILED');
  }
}
