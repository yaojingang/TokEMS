import { z } from 'zod';
import type { PublicEvent, TemplateHome } from './index.js';

export const NAVIGATION_SECTIONS = [
  { value: 'home.hero', label: '首屏', anchor: 'hero' },
  { value: 'home.value', label: '大会背景', anchor: 'why' },
  { value: 'home.upgrade', label: '本届升级', anchor: 'upgrade' },
  { value: 'home.agenda', label: '议程', anchor: 'agenda' },
  { value: 'home.speakers', label: '嘉宾', anchor: 'speakers' },
  { value: 'home.members', label: '会员', anchor: 'members' },
  { value: 'home.organizer', label: '主办方', anchor: 'hosts' },
  { value: 'home.cooperation', label: '合作介绍', anchor: 'cooperation' },
  { value: 'home.attendee-needs', label: '参会需求', anchor: 'attendee-needs' },
  { value: 'home.tickets', label: '门票', anchor: 'tickets' },
  { value: 'home.faq-summary', label: '常见问题', anchor: 'faq' },
  { value: 'home.registration-cta', label: '报名入口', anchor: 'final' },
] as const;

export const NAVIGATION_PAGES = [
  { value: 'home', label: '大会首页' },
  { value: 'faq', label: '常见问题' },
  { value: 'cooperation', label: '合作申请' },
  { value: 'register', label: '大会报名' },
  { value: 'members', label: '会员目录' },
  { value: 'partners', label: '合作伙伴目录' },
] as const;

export function isSafeNavigationHref(href: string): boolean {
  if (
    !href ||
    href.length > 2000 ||
    [...href].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\',
    )
  )
    return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return false;
  }
  if (
    [...decoded].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '\\',
    )
  )
    return false;
  if (!(href.startsWith('/') && !href.startsWith('//')) && !/^https?:\/\//iu.test(href))
    return false;
  try {
    const url = new URL(href, 'https://navigation.invalid');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (decoded.startsWith('//')) return false;
    return ![...url.searchParams.keys()].some((key) =>
      /(?:token|password|secret|credential|authorization|access.?key|offer)/iu.test(key),
    );
  } catch {
    return false;
  }
}

const NavigationItemBase = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/u),
  label: z.string().trim().min(1).max(16),
  enabled: z.boolean().default(true),
  newWindow: z.boolean().default(false),
});

export const NavigationItemSchema = z.discriminatedUnion('kind', [
  NavigationItemBase.extend({
    kind: z.literal('section'),
    target: z.enum(NAVIGATION_SECTIONS.map((item) => item.value)),
  }).strict(),
  NavigationItemBase.extend({
    kind: z.literal('page'),
    target: z.enum(NAVIGATION_PAGES.map((item) => item.value)),
  }).strict(),
  NavigationItemBase.extend({
    kind: z.literal('custom'),
    target: z
      .string()
      .max(2000)
      .refine(isSafeNavigationHref, '请输入站内路径或不含凭据的 HTTP / HTTPS 网址'),
  }).strict(),
]);

export const NavigationItemsSchema = z
  .array(NavigationItemSchema)
  .max(12)
  .superRefine((items, ctx) => {
    const ids = new Set<string>();
    items.forEach((item, index) => {
      if (ids.has(item.id))
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '菜单标识重复' });
      ids.add(item.id);
    });
  });

export type NavigationItem = z.infer<typeof NavigationItemSchema>;
export type ResolvedNavigationLink = NavigationItem & { href: string; sectionKey?: string };

export function defaultNavigationItems(home: TemplateHome): NavigationItem[] {
  const copy = home.blocks.find((item) => item.nodeKey === 'home.navigation')?.content ?? {};
  return [
    ['why', 'whyLabel', '背景', 'section', 'home.value'],
    ['edition', 'editionLabel', '第二届', 'section', 'home.upgrade'],
    ['agenda', 'agendaLabel', '议程', 'section', 'home.agenda'],
    ['speakers', 'speakersLabel', '嘉宾', 'section', 'home.speakers'],
    ['members', 'membersLabel', '会员', 'section', 'home.members'],
    ['partners', 'partnersLabel', '合作伙伴', 'page', 'partners'],
    ['tickets', 'ticketsLabel', '门票', 'section', 'home.tickets'],
    ['cooperation', 'cooperationLabel', '合作', 'page', 'cooperation'],
    ['faq', 'faqLabel', 'FAQ', 'page', 'faq'],
  ]
    .map(([id, key, label, kind, target]) => ({
      ...NavigationItemSchema.parse({
        id,
        label,
        kind,
        target,
        enabled: true,
        newWindow: false,
      }),
      // Existing copy predates the limits applied when saving explicit menu items.
      label: typeof copy[key!] === 'string' ? (copy[key!] as string) : label!,
    }))
    .filter(
      (item) =>
        item.kind !== 'section' || home.blocks.some((block) => block.nodeKey === item.target),
    );
}

export function navigationItems(home: TemplateHome): NavigationItem[] {
  const items = home.blocks.find((item) => item.nodeKey === 'home.navigation')?.content.items;
  return items === undefined ? defaultNavigationItems(home) : NavigationItemsSchema.parse(items);
}

export function resolveNavigationLinks(
  event: Pick<PublicEvent, 'slug'>,
  home: TemplateHome,
  faqMode: 'home' | 'page',
  options: {
    onHome?: boolean;
    membersVisible?: boolean;
    partnersVisible?: boolean;
    origin?: string;
  } = {},
): ResolvedNavigationLink[] {
  const navigation = home.blocks.find((block) => block.nodeKey === 'home.navigation');
  if (navigation?.enabled === false) return [];
  const homePath = `/${encodeURIComponent(event.slug)}`;
  const scoped = (path: string) => `${path}?event=${encodeURIComponent(event.slug)}`;
  const enabled = (key: string) =>
    home.blocks.some((block) => block.nodeKey === key && block.enabled);
  return navigationItems(home).flatMap((item) => {
    if (!item.enabled) return [];
    let href: string;
    let sectionKey: string | undefined;
    if (item.kind === 'section') {
      sectionKey = item.target;
      if (
        !enabled(sectionKey) ||
        (sectionKey === 'home.members' && options.membersVisible === false)
      )
        return [];
      if (sectionKey === 'home.faq-summary' && faqMode === 'page') href = scoped('/faq');
      else
        href = `${options.onHome ? '' : homePath}#${NAVIGATION_SECTIONS.find((section) => section.value === item.target)!.anchor}`;
    } else if (item.kind === 'page') {
      if (
        item.target === 'partners' &&
        navigation?.content.items === undefined &&
        options.partnersVisible === false
      )
        return [];
      if (item.target === 'cooperation' && !enabled('home.cooperation')) return [];
      if (item.target === 'faq' && !enabled('home.faq-summary')) return [];
      if (
        item.target === 'members' &&
        (!enabled('home.members') || options.membersVisible === false)
      )
        return [];
      href =
        item.target === 'home'
          ? homePath
          : item.target === 'register'
            ? `/register/${encodeURIComponent(event.slug)}`
            : item.target === 'cooperation'
              ? scoped('/apply/cooperation')
              : item.target === 'members'
                ? `${options.onHome ? '' : homePath}#members`
                : item.target === 'faq' && faqMode === 'home'
                  ? `${options.onHome ? '' : homePath}#faq`
                  : scoped(`/${item.target}`);
    } else {
      href = item.target;
      if (!isSafeNavigationHref(href)) return [];
      const base = options.origin ?? 'https://navigation.invalid';
      const url = new URL(href, base);
      if (url.origin === new URL(base).origin) {
        if (
          ['/register', '/faq', '/apply/cooperation', '/members', '/partners'].includes(
            url.pathname.replace(/\/$/u, ''),
          ) &&
          !url.searchParams.has('event')
        ) {
          if (url.pathname.replace(/\/$/u, '') === '/register')
            url.pathname = `/register/${encodeURIComponent(event.slug)}`;
          else url.searchParams.set('event', event.slug);
          href = `${url.pathname}${url.search}${url.hash}`;
        }
      }
    }
    return [{ ...item, href, ...(sectionKey ? { sectionKey } : {}) }];
  });
}
