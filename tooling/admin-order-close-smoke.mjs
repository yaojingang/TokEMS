import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { DEMO_EVENT } from '../packages/contracts/dist/index.js';

const base = process.env.ADMIN_BASE_URL ?? 'http://admin.localhost:8088/admin';
if (!['localhost', '127.0.0.1', 'admin.localhost', '[::1]'].includes(new URL(base).hostname))
  throw new Error('Admin closure checks require a local application');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());
async function fixture({ allowed = true, failure = false } = {}) {
  const context = await browser.newContext();
  await context.addInitScript(() =>
    localStorage.setItem('conference.admin.token', 'admin-closure-fixture'),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const event = DEMO_EVENT;
  const registrationId = '22222222-2222-4222-8222-222222222222';
  const orderId = '11111111-1111-4111-8111-111111111111';
  const now = new Date().toISOString();
  const order = {
    id: orderId,
    orderNo: 'TOK-O-TEST',
    registrationId,
    status: 'pending_payment',
    amount: 39900,
    currency: 'CNY',
    paymentMethod: 'wechat',
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    createdAt: now,
  };
  const detail = {
    snapshotAt: now,
    traceId: 'fixture',
    registration: {
      id: registrationId,
      registrationCode: 'TOK-R-TEST',
      eventId: event.id,
      status: 'pending_payment',
      ticketType: { id: '33333333-3333-4333-8333-333333333333', name: '测试票', price: 39900 },
      attendee: {
        name: '测试参会者',
        mobile: '13800138000',
        email: '',
        company: '测试公司',
        title: '',
        city: '',
      },
      purchaserName: '测试参会者',
      purchaserMobile: '13800138000',
      isProxyPurchase: false,
      invoiceRequired: false,
      marketingConsent: false,
      consentSnapshot: {},
      formAnswers: {},
      createdAt: now,
      updatedAt: now,
    },
    customer: { access: 'restricted' },
    fulfillment: { ticket: null, checkins: [] },
    commerce: {
      access: 'included',
      order,
      successfulPayment: null,
      paymentAttempts: [],
      refunds: [],
      totals: {
        paidAmount: 0,
        succeededRefundAmount: 0,
        processingRefundAmount: 0,
        refundableAmount: 0,
      },
    },
    invoice: { access: 'restricted' },
    notes: [],
    capabilities: {
      close_unpaid_order: { allowed },
      review_registration: { allowed },
      refund_order: { allowed: false },
      manage_invoice: { allowed: false },
    },
  };
  const calls = [];
  const errors = [];
  let fails = failure;
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
              ...(allowed ? ['event.registration.manage'] : []),
            ],
          },
          adminPreferences: { lastEventId: null },
        },
      });
    if (path.endsWith('/admin/event-options'))
      return route.fulfill({ json: [{ ...event, organizationName: '测试组织' }] });
    if (path.endsWith('/operations-detail')) return route.fulfill({ json: detail });
    if (path.endsWith('/admin-preferences'))
      return route.fulfill({ json: { lastEventId: event.id } });
    if (path.endsWith(`/orders/${orderId}/close`)) {
      calls.push({ path, method: request.method(), body: request.postDataJSON() });
      if (fails)
        return route.fulfill({
          status: 409,
          json: { message: '用户正在支付中，请稍后查询结果后再操作' },
        });
      order.status = 'closed';
      detail.registration.status = 'cancelled';
      detail.capabilities.close_unpaid_order.allowed = false;
      return route.fulfill({ json: { orderId, status: 'closed' } });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto(`${base}/events/${event.id}/registrations/${registrationId}`);
  await page.getByRole('heading', { name: '测试参会者', exact: true, level: 1 }).waitFor();
  return {
    page,
    context,
    order,
    calls,
    errors,
    allow: () => {
      fails = false;
    },
  };
}

test('admin confirms scoped unpaid closure with a reason, then sees the refreshed closed state', async () => {
  const f = await fixture();
  try {
    await f.page.getByRole('button', { name: '关闭未支付订单', exact: true }).click();
    await f.page.getByLabel('关闭原因', { exact: true }).fill('用户支付异常，申请重新报名');
    f.page.once('dialog', (dialog) => dialog.dismiss());
    await f.page.getByRole('button', { name: '确认关闭未支付订单', exact: true }).click();
    assert.equal(f.calls.length, 0);
    f.page.once('dialog', (dialog) => dialog.accept());
    await f.page.getByRole('button', { name: '确认关闭未支付订单', exact: true }).click();
    await f.page
      .getByText('订单已关闭，名额已释放。用户可返回报名页重新提交并支付。', { exact: true })
      .waitFor();
    assert.deepEqual(f.calls[0].body, {
      reason: '用户支付异常，申请重新报名',
      expectedExpiresAt: f.order.expiresAt,
    });
    assert.equal(f.calls[0].method, 'POST');
    assert.equal(
      await f.page.getByRole('button', { name: '关闭未支付订单', exact: true }).count(),
      0,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});
test('unsettled payment keeps the close form and reason available for retry', async () => {
  const f = await fixture({ failure: true });
  try {
    await f.page.getByRole('button', { name: '关闭未支付订单', exact: true }).click();
    await f.page.getByLabel('关闭原因', { exact: true }).fill('用户申请重新支付');
    f.page.on('dialog', (dialog) => dialog.accept());
    await f.page.getByRole('button', { name: '确认关闭未支付订单', exact: true }).click();
    await f.page.getByText('用户正在支付中，请稍后查询结果后再操作', { exact: true }).waitFor();
    assert.equal(
      await f.page.getByLabel('关闭原因', { exact: true }).inputValue(),
      '用户申请重新支付',
    );
    f.allow();
    await f.page.getByRole('button', { name: '确认关闭未支付订单', exact: true }).click();
    await f.page
      .getByText('订单已关闭，名额已释放。用户可返回报名页重新提交并支付。', { exact: true })
      .waitFor();
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});
test('read-only staff have no unpaid-order closure action', async () => {
  const f = await fixture({ allowed: false });
  try {
    assert.equal(
      await f.page.getByRole('button', { name: '关闭未支付订单', exact: true }).count(),
      0,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.context.close();
  }
});
