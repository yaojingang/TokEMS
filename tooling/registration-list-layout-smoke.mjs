import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { DEMO_EVENT } from '../packages/contracts/dist/index.js';

// Local UI regression only. All API traffic uses fixtures, including administrator actions.
const base = process.env.ADMIN_BASE_URL ?? 'http://admin.localhost:8088/admin';
assert(['localhost', '127.0.0.1', 'admin.localhost', '[::1]'].includes(new URL(base).hostname));
const output = process.env.REGISTRATION_LAYOUT_OUTPUT ?? '/tmp/tokems-registration-list-layout';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());
const event = DEMO_EVENT;
const rows = [
  { name: '本地联测参会人', company: 'TokEMS 本地测试', title: '', orderNo: 'TOK2026TL9ZAUR-OU' },
  {
    name: 'LongParticipantNameWithoutSpaces跨地区参会人',
    company: '国际数字营销与人工智能应用研究中心',
    title: '企业增长与市场研究负责人',
    orderNo: 'TOK2026-LONG-ORDER-REFERENCE-1234567890',
  },
].map((person, index) => ({
  id: `33333333-3333-4333-8333-00000000000${index}`,
  purchaserName: index ? person.name : '本地联测购票人',
  purchaserMobile: '+8619900000910',
  isProxyPurchase: !index,
  attendee: { ...person, mobile: `+861990000091${index}`, email: '', city: '' },
  ticketType: { id: event.tickets[0].id, name: index ? 'VIP 圆桌与全天参会组合票' : '大会通票' },
  status: 'confirmed',
  businessStatus: 'paid',
  paidAmount: 39900,
  refundedAmount: 0,
  order: { orderNo: person.orderNo, paymentMethod: 'wechat' },
  invoiceSummary: {
    status: index ? 'issued' : 'eligible',
    requestNo: index ? 'INV20261D816FC645D4' : null,
  },
  lastBusinessAt: '2026-09-10T05:37:00.000Z',
}));

async function fixture(width) {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() =>
    localStorage.setItem('conference.admin.token', 'layout-fixture'),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/auth/me'))
      return route.fulfill({
        json: {
          user: { id: 101, name: '测试管理员', email: 'test@example.com' },
          organization: { id: event.organizationId, slug: 'test', name: '测试组织', settings: {} },
          membership: {
            id: 'test',
            role: 'organization_admin',
            status: 'active',
            grants: [
              'event.read',
              'event.registration.read',
              'event.order.read',
              'event.registration.export',
            ],
          },
          adminPreferences: { lastEventId: event.id },
        },
      });
    if (path.endsWith('/admin/event-options'))
      return route.fulfill({ json: [{ ...event, organizationName: '测试组织' }] });
    if (path.endsWith(`/events/${event.id}`)) return route.fulfill({ json: event });
    if (path.endsWith('/admin-preferences'))
      return route.fulfill({ json: { lastEventId: event.id } });
    if (path.endsWith('/registrations')) {
      const items = url.searchParams.get('q') ? [] : rows;
      return route.fulfill({ json: { items, page: 1, pageSize: 10, total: items.length } });
    }
    if (path.endsWith('/waitlist')) return route.fulfill({ json: [] });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto(`${base}/events/${event.id}/registrations`, { waitUntil: 'networkidle' });
  await page.locator('.registration-table tbody tr').first().waitFor();
  return { page, context, errors };
}

async function measure(page) {
  return page.evaluate(() => {
    const wrap = document.querySelector('.registration-list-panel .data-table-wrap');
    const table = wrap.querySelector('table');
    const box = (element) => {
      const { left, right, width, height } = element.getBoundingClientRect();
      return { left, right, width, height };
    };
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      wrap: { ...box(wrap), scrollWidth: wrap.scrollWidth, scrollLeft: wrap.scrollLeft },
      table: box(table),
      actions: [...table.querySelectorAll('.registration-view-action')].map((action) => {
        const bounds = box(action);
        const clippedBy = wrap.getBoundingClientRect();
        const centerY = action.getBoundingClientRect().top + bounds.height / 2;
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, centerY);
        return {
          ...bounds,
          rightGap: clippedBy.right - bounds.right,
          leftGap: bounds.left - clippedBy.left,
          clickable: action.contains(hit),
        };
      }),
    };
  });
}

for (const width of [1920, 1440, 1280, 1024, 768, 375]) {
  test(`registration list keeps actions visible and content readable at ${width}px`, async () => {
    const f = await fixture(width);
    try {
      await f.page.locator('.registration-table tbody tr').first().scrollIntoViewIfNeeded();
      const initial = await measure(f.page);
      await writeFile(`${output}/geometry-${width}.json`, JSON.stringify({ initial }, null, 2));
      await f.page.screenshot({ path: `${output}/registrations-${width}.png`, fullPage: true });
      assert(initial.documentWidth <= width + 1, 'The document must not scroll horizontally');
      for (const action of initial.actions) {
        assert(
          action.rightGap >= 12 && action.leftGap >= 0,
          `Action clipped: right gap ${action.rightGap}px`,
        );
        assert(action.width >= 56 && action.height >= 32, 'Action keeps its usable target size');
        assert(action.clickable, 'Sticky action must remain reachable above the scrolled columns');
      }
      if (width >= 1440)
        assert(initial.table.width <= initial.wrap.width + 1, 'All columns fit on a wide desktop');
      await f.page.locator('.registration-list-panel .data-table-wrap').evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      const scrolled = await measure(f.page);
      for (const action of scrolled.actions) assert(action.rightGap >= 12 && action.clickable);
      await writeFile(
        `${output}/geometry-${width}.json`,
        JSON.stringify({ initial, scrolled }, null, 2),
      );
      assert(await f.page.getByText(rows[1].order.orderNo, { exact: true }).count());
      assert(
        await f.page
          .locator('.registration-invoice-reference')
          .evaluate(
            (element) =>
              element.clientHeight <= Number.parseFloat(getComputedStyle(element).lineHeight) + 1,
          ),
        'A standard invoice reference fits without leaving an isolated suffix',
      );
      assert(
        await f.page
          .getByText(rows[1].attendee.company + ' · ' + rows[1].attendee.title, { exact: true })
          .count(),
      );
      const href = await f.page.locator('.registration-view-action').first().getAttribute('href');
      assert(href.endsWith(`/registrations/${rows[0].id}`));
      await f.page.getByRole('searchbox', { name: '搜索报名' }).fill('无匹配');
      await f.page.getByRole('button', { name: '查询', exact: true }).click();
      await f.page.getByText('当前筛选条件下没有报名记录。', { exact: true }).waitFor();
      assert.equal(await f.page.locator('.registration-table tbody tr').count(), 0);
      await f.page.getByRole('button', { name: '重置', exact: true }).click();
      await f.page.locator('.registration-table tbody tr').first().waitFor();
      assert.equal(await f.page.locator('.registration-table tbody tr').count(), rows.length);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}
