import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { DEMO_EVENT } from '../packages/contracts/dist/index.js';

const base = process.env.ADMIN_BASE_URL ?? 'http://admin.localhost:8088/admin';
assert(['localhost', '127.0.0.1', 'admin.localhost'].includes(new URL(base).hostname));
const output = process.env.ADMIN_LOADING_OUTPUT ?? '/tmp/tokems-admin-loading';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const event = DEMO_EVENT;
const metrics = {
  registrations: 1250,
  paidSeats: 860,
  purchasers: 790,
  paidOrders: 810,
  confirmedAttendees: 900,
  revenue: 3990000,
  refundedOrders: 2,
  refundedAmount: 10000,
  pendingReview: 30,
  checkedIn: 0,
  conversionRate: 68.8,
};
const row = {
  id: '33333333-3333-4333-8333-000000000001',
  eventId: event.id,
  purchaserName: '测试购票人',
  purchaserMobile: '13800000000',
  isProxyPurchase: false,
  attendee: {
    name: '测试参会人',
    mobile: '13800000000',
    company: '测试公司',
    title: '',
    city: '深圳',
  },
  ticketType: event.tickets[0],
  registrationCode: 'TEST-001',
  status: 'confirmed',
  businessStatus: 'paid',
  paidAmount: 39900,
  refundedAmount: 0,
  invoiceSummary: { status: 'eligible', requestNo: null },
  createdAt: '2026-10-27T01:00:00.000Z',
  lastBusinessAt: '2026-10-27T01:00:00.000Z',
};
const report = [];

async function fixture(width = 1440, reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion });
  await context.addInitScript(() =>
    localStorage.setItem('conference.admin.token', 'loading-fixture'),
  );
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  const state = {
    registrationDelay: 0,
    waitlistDelay: 0,
    invoiceDelay: 0,
    dashboardDelay: 0,
    registrationFails: false,
    waitlistFails: false,
    invoiceFails: false,
    empty: false,
  };
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    requests.push(path);
    const deliver = async (json, delay = 0, failed = false) => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (page.isClosed()) return;
      await route
        .fulfill({
          status: failed ? 503 : 200,
          json: failed ? { message: '测试请求暂时失败' } : json,
        })
        .catch(() => {});
    };
    if (path.endsWith('/auth/me'))
      return deliver({
        user: { id: 101, name: '测试管理员', email: 'test@example.com' },
        organization: { id: event.organizationId, slug: 'test', name: '测试组织', settings: {} },
        membership: { id: 'test', role: 'organization_admin', status: 'active', grants: ['*'] },
        adminPreferences: { lastEventId: event.id },
      });
    if (path.endsWith('/admin/event-options'))
      return deliver([{ ...event, organizationName: '测试组织' }]);
    if (path.endsWith(`/events/${event.id}`)) return deliver(event);
    if (path.endsWith('/auth/preferences/admin')) return deliver({ lastEventId: event.id });
    if (path.endsWith('/registrations'))
      return deliver(
        {
          items: state.empty ? [] : [row],
          total: state.empty ? 0 : 1250,
          page: Number(url.searchParams.get('page') ?? 1),
          pageSize: Number(url.searchParams.get('pageSize') ?? 10),
        },
        state.registrationDelay,
        state.registrationFails,
      );
    if (path.endsWith('/registration-count')) return deliver({ count: 18 });
    if (path.endsWith('/waitlist')) return deliver([], state.waitlistDelay, state.waitlistFails);
    if (path.endsWith('/invoices/pending-count'))
      return deliver({ count: 8 }, state.invoiceDelay, state.invoiceFails);
    if (path.endsWith('/dashboard'))
      return deliver(
        {
          eventId: event.id,
          eventName: event.name,
          updatedAt: '2026-10-27T01:00:00.000Z',
          metrics,
          ticketBreakdown: [{ id: 'test-ticket', name: '大会通票', sold: 860, quota: 1500 }],
          registrationTrend: [
            { date: '2026-10-26', value: 14 },
            { date: '2026-10-27', value: 22 },
          ],
        },
        state.dashboardDelay,
      );
    return deliver({ items: [] });
  });
  return { page, context, state, requests, errors };
}

try {
  // Independent requests: a five-second invoice request cannot hide ready statistics.
  const dash = await fixture();
  dash.state.invoiceDelay = 5000;
  dash.state.dashboardDelay = 1000;
  await dash.page.goto(`${base}/events/${event.id}/overview`);
  await dash.page.getByRole('heading', { name: '票种库存' }).waitFor();
  assert((await dash.page.locator('.admin-metric-value .admin-skeleton').count()) > 0);
  await dash.page.screenshot({ path: `${output}/dashboard-loading.png`, fullPage: true });
  await dash.page.waitForFunction(() =>
    document.querySelector('.admin-metric-value')?.textContent.includes('1,250'),
  );
  assert(
    (await dash.page
      .locator('.admin-metric')
      .filter({ hasText: '发票开具情况' })
      .locator('.admin-skeleton')
      .count()) === 1,
  );
  assert((await dash.page.getByText('测试参会人', { exact: true }).count()) === 1);
  await dash.page.screenshot({ path: `${output}/dashboard-partial.png`, fullPage: true });
  assert.deepEqual(dash.errors, []);
  // Once route resources are loaded, switching back must immediately show the shell.
  await dash.page.locator('.admin-nav a').filter({ hasText: '报名管理' }).click();
  await dash.page.getByRole('heading', { name: '报名管理', exact: true }).waitFor();
  dash.state.dashboardDelay = 5000;
  const started = performance.now();
  await dash.page.locator('.admin-nav a').filter({ hasText: '数据概览' }).click();
  await dash.page.getByRole('heading', { name: '票种库存', exact: true }).waitFor();
  const shellMs = Math.round(performance.now() - started);
  assert(shellMs < 300, `Warm page shell took ${shellMs} ms`);
  report.push({ name: 'dashboard', shellMs, independentInvoice: true });
  await dash.context.close();

  const failedInvoice = await fixture();
  failedInvoice.state.invoiceFails = true;
  await failedInvoice.page.goto(`${base}/events/${event.id}/overview`);
  await failedInvoice.page.getByRole('button', { name: '重试发票数量', exact: true }).waitFor();
  assert(
    (await failedInvoice.page.locator('.admin-metric-value').first().innerText()).includes('1,250'),
  );
  failedInvoice.state.invoiceFails = false;
  await failedInvoice.page.getByRole('button', { name: '重试发票数量', exact: true }).click();
  await failedInvoice.page.waitForFunction(
    () =>
      [...document.querySelectorAll('.admin-metric')]
        .find((element) => element.textContent.includes('发票开具情况'))
        ?.querySelector('strong')?.textContent === '8',
  );
  assert.equal(failedInvoice.requests.filter((path) => path.endsWith('/dashboard')).length, 1);
  assert.deepEqual(failedInvoice.errors, []);
  report.push({ name: 'invoice-failure', localRetry: true, statisticsRemainVisible: true });
  await failedInvoice.context.close();

  for (const width of [1440, 768, 375]) {
    const f = await fixture(width, width === 375 ? 'reduce' : 'no-preference');
    f.state.registrationDelay = 5000;
    f.state.waitlistDelay = 6000;
    await f.page.goto(`${base}/events/${event.id}/registrations`);
    await f.page.locator('.registration-table .admin-skeleton-row').first().waitFor();
    assert.equal(await f.page.locator('.registration-table .admin-skeleton-row').count(), 5);
    assert(!(await f.page.locator('.registration-list-summary').innerText()).includes('0 条'));
    assert(!(await f.page.locator('.admin-empty').count()));
    if (width === 375) {
      const animation = await f.page
        .locator('.admin-skeleton')
        .first()
        .evaluate((element) => getComputedStyle(element).animationName);
      assert.equal(animation, 'none');
    }
    await f.page.screenshot({
      path: `${output}/registrations-loading-${width}.png`,
      fullPage: true,
    });
    await f.page.locator('.registration-table .row-title').first().waitFor();
    assert(await f.page.getByText('正在读取候补名单…', { exact: true }).isVisible());
    const waitingCalls = f.requests.filter((path) => path.endsWith('/waitlist')).length;
    f.state.registrationDelay = 0;
    await f.page.getByRole('combobox', { name: '按业务状态筛选' }).selectOption('paid');
    await f.page.waitForFunction(
      () =>
        document.querySelector('.registration-table-scroll')?.getAttribute('aria-busy') === 'false',
    );
    assert.equal(f.requests.filter((path) => path.endsWith('/waitlist')).length, waitingCalls);
    f.state.registrationDelay = 600;
    f.state.registrationFails = true;
    await f.page.getByRole('button', { name: '刷新数据', exact: true }).click();
    assert(await f.page.locator('.registration-table .row-title').first().isVisible());
    await f.page.getByRole('alert').filter({ hasText: '测试请求暂时失败' }).waitFor();
    assert(await f.page.locator('.registration-table .row-title').first().isVisible());
    f.state.registrationFails = false;
    f.state.registrationDelay = 0;
    await f.page
      .locator('.registration-list-panel')
      .getByRole('button', { name: '重试', exact: true })
      .click();
    await f.page.waitForFunction(
      () =>
        document.querySelector('.registration-table-scroll')?.getAttribute('aria-busy') === 'false',
    );
    assert.equal(await f.page.getByRole('alert').count(), 0);
    const geometry = await f.page.evaluate(() => ({
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    assert(geometry.documentWidth <= width + 1);
    assert.deepEqual(f.errors, []);
    report.push({
      width,
      geometry,
      slowLoading: true,
      independentWaitlist: true,
      refreshFailureRecovery: true,
    });
    await f.context.close();
  }

  const empty = await fixture();
  empty.state.empty = true;
  await empty.page.goto(`${base}/events/${event.id}/registrations`);
  await empty.page.getByText('当前筛选条件下没有报名记录。', { exact: true }).waitFor();
  assert(
    (await empty.page.locator('.registration-list-summary').innerText()).includes('0 条报名记录'),
  );
  await empty.context.close();
  await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checked: report, output }));
} finally {
  await browser.close();
}
