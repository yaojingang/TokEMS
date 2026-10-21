import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  NavigationItemsSchema,
  TemplateHomeSchema,
  defaultNavigationItems,
  resolveNavigationLinks,
  isSafeNavigationHref,
  type NavigationItem,
} from './index.js';

function home() {
  const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
  if (definition.presentation.kind !== 'structured') throw new Error('Expected structured fixture');
  return definition.presentation.home;
}
function configured(items: unknown) {
  const value = home();
  value.blocks.find((block) => block.nodeKey === 'home.navigation')!.content.items = items;
  return value;
}
const menu: NavigationItem[] = [
  {
    id: 'agenda',
    label: '精彩议程',
    kind: 'section',
    target: 'home.agenda',
    enabled: true,
    newWindow: false,
  },
  {
    id: 'cooperation',
    label: '合作',
    kind: 'page',
    target: 'cooperation',
    enabled: true,
    newWindow: false,
  },
  {
    id: 'history',
    label: '往届回顾',
    kind: 'custom',
    target: 'https://example.com/2025#speakers',
    enabled: true,
    newWindow: true,
  },
];

describe('conference navigation', () => {
  it('preserves the partner directory added to the default public navigation', () => {
    const inherited = home();
    const links = resolveNavigationLinks({ slug: 'event-a' }, inherited, 'home');
    expect(links.find((item) => item.id === 'partners')?.href).toBe('/partners?event=event-a');
    expect(
      resolveNavigationLinks({ slug: 'event-a' }, inherited, 'home', {
        onHome: true,
        partnersVisible: false,
      }).some((item) => item.id === 'partners'),
    ).toBe(false);
    expect(
      resolveNavigationLinks(
        { slug: 'event-a' },
        configured([{ ...menu[0], id: 'partners', kind: 'page', target: 'partners' }]),
        'home',
        { partnersVisible: false },
      )[0]?.href,
    ).toBe('/partners?event=event-a');
  });
  it('keeps inherited menus editable when an optional template section is absent', () => {
    const value = home();
    value.blocks = value.blocks.filter((item) => item.nodeKey !== 'home.upgrade');
    value.blocks.find((item) => item.nodeKey === 'home.agenda')!.enabled = false;
    const items = defaultNavigationItems(value);
    expect(items.some((item) => item.target === 'home.upgrade')).toBe(false);
    expect(items.some((item) => item.target === 'home.agenda')).toBe(true);
    value.blocks.find((item) => item.nodeKey === 'home.navigation')!.content.items = items;
    expect(TemplateHomeSchema.safeParse(value).success).toBe(true);
  });
  it('renders legacy labels without applying new-menu save limits', () => {
    const value = home();
    const copy = value.blocks.find((block) => block.nodeKey === 'home.navigation')!.content;
    copy.whyLabel = '旧'.repeat(17);
    copy.editionLabel = '';
    expect(TemplateHomeSchema.safeParse(value).success).toBe(true);
    expect(
      defaultNavigationItems(value)
        .map((item) => item.label)
        .slice(0, 2),
    ).toEqual(['旧'.repeat(17), '']);
    expect(() => resolveNavigationLinks({ slug: 'event-a' }, value, 'home')).not.toThrow();
  });
  it('routes the member directory to its existing homepage section', () => {
    const value = configured([{ ...menu[0], kind: 'page', target: 'members' }]);
    expect(resolveNavigationLinks({ slug: 'event-a' }, value, 'home')[0]?.href).toBe(
      '/event-a#members',
    );
    expect(
      resolveNavigationLinks({ slug: 'event-a' }, value, 'home', { onHome: true })[0]?.href,
    ).toBe('#members');
  });
  it('keeps inherited destinations and customized legacy labels', () => {
    const value = home();
    value.blocks.find((block) => block.nodeKey === 'home.navigation')!.content.whyLabel =
      '大会背景';
    expect(defaultNavigationItems(value).map((item) => item.label)).toEqual([
      '大会背景',
      '第二届',
      '议程',
      '嘉宾',
      '会员',
      '合作伙伴',
      '门票',
      '合作',
      'FAQ',
    ]);
    expect(
      resolveNavigationLinks({ slug: 'conference-a' }, value, 'home').some(
        (item) => item.href === '/conference-a#agenda',
      ),
    ).toBe(true);
  });
  it('distinguishes an explicitly empty menu from inherited navigation', () => {
    expect(resolveNavigationLinks({ slug: 'conference-a' }, configured([]), 'home')).toEqual([]);
    expect(resolveNavigationLinks({ slug: 'conference-a' }, home(), 'home').length).toBeGreaterThan(
      0,
    );
  });
  it('resolves anchors, feature pages, order, and independent event slugs', () => {
    expect(
      resolveNavigationLinks({ slug: 'event-a' }, configured(menu), 'home', { onHome: true }).map(
        (item) => item.href,
      ),
    ).toEqual(['#agenda', '/apply/cooperation?event=event-a', 'https://example.com/2025#speakers']);
    expect(
      resolveNavigationLinks({ slug: 'event-b' }, configured(menu), 'home').map(
        (item) => item.href,
      ),
    ).toEqual([
      '/event-b#agenda',
      '/apply/cooperation?event=event-b',
      'https://example.com/2025#speakers',
    ]);
  });
  it('suppresses disabled items and unavailable sections without changing stored configuration', () => {
    const value = configured(menu);
    value.blocks.find((block) => block.nodeKey === 'home.agenda')!.enabled = false;
    expect(
      resolveNavigationLinks({ slug: 'event-a' }, value, 'home').map((item) => item.id),
    ).toEqual(['cooperation', 'history']);
    expect(
      (
        value.blocks.find((block) => block.nodeKey === 'home.navigation')!.content
          .items as NavigationItem[]
      )[0]!.enabled,
    ).toBe(true);
    expect(
      resolveNavigationLinks(
        { slug: 'event-a' },
        configured([{ ...menu[0], enabled: false }]),
        'home',
      ),
    ).toEqual([]);
  });
  it('resolves FAQ mode and fills event context in custom local business links', () => {
    const value = configured([
      { ...menu[0], id: 'faq', kind: 'page', target: 'faq' },
      { ...menu[0], id: 'registration', kind: 'custom', target: '/register?ticket=vip' },
      {
        ...menu[0],
        id: 'custom-faq',
        kind: 'custom',
        target: 'https://conference.example/faq#contact',
      },
    ]);
    expect(
      resolveNavigationLinks({ slug: 'event-a' }, value, 'page', {
        origin: 'https://conference.example',
      }).map((item) => item.href),
    ).toEqual(['/faq?event=event-a', '/register/event-a?ticket=vip', '/faq?event=event-a#contact']);
  });
  it.each([
    'javascript:alert(1)',
    'data:text/html,bad',
    '//evil.example',
    '/%2fexample.com',
    '/%5cexample.com',
    'https://user:password@example.com',
    '/order?token=secret',
    'https://example.com/?access_token=secret',
    '/x%0aLocation:evil',
    'https://example.com/\n',
  ])('rejects unsafe public destination %s', (target) => {
    expect(isSafeNavigationHref(target)).toBe(false);
    expect(
      TemplateHomeSchema.safeParse(configured([{ ...menu[0], kind: 'custom', target }])).success,
    ).toBe(false);
  });
  it('rejects duplicate identities, long labels, and menus over the limit', () => {
    expect(NavigationItemsSchema.safeParse([menu[0], menu[0]]).success).toBe(false);
    expect(NavigationItemsSchema.safeParse([{ ...menu[0], label: '长'.repeat(17) }]).success).toBe(
      false,
    );
    expect(
      NavigationItemsSchema.safeParse(
        Array.from({ length: 13 }, (_, index) => ({ ...menu[0], id: String(index) })),
      ).success,
    ).toBe(false);
  });
});
