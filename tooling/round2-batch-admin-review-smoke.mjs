import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { DEMO_EVENT } from '../packages/contracts/dist/index.js';

const base = process.env.ADMIN_BASE_URL ?? 'http://admin.localhost:8088/admin';
if (!['localhost', '127.0.0.1', 'admin.localhost', '[::1]'].includes(new URL(base).hostname))
  throw new Error('Admin closure checks require a local application');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());
async function fixture({
  allowed = true,
  failure = false,
  review = false,
  commerce = true,
  width = 1280,
} = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
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
    registrationId: null,
    modelVersion: 2,
    quantity: 5,
    version: 1,
    status: review ? 'pending_review' : 'paid',
    amount: 199500,
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
      status: review ? 'pending_review' : 'pending_payment',
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
  const items = Array.from({ length: 5 }, (_, i) => ({
    id: `aaaaaaa${i}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    registrationId: `bbbbbbb${i}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
    position: i + 1,
    version: 2,
    state: review ? 'pending' : 'active',
    allocatedAmount: 39900,
    refundedAmount: 0,
    ticketStatus: review ? null : 'valid',
    attendeeClaimed: i === 0,
    registration: {
      ...detail.registration,
      attendee: {
        ...detail.registration.attendee,
        name: `批量参会人${i + 1}`,
        mobile: `1380013800${i}`,
      },
    },
  }));
  if (!commerce) detail.commerce = { access: 'restricted' };
  if (allowed)
    detail.batchReview = {
      orderId,
      version: order.version,
      status: order.status,
      quantity: 5,
      items: items.map((item, index) => ({
        registrationId: item.registrationId,
        position: index + 1,
        registrationCode: `R-${index + 1}`,
        attendee: item.registration.attendee,
        fields: [
          { key: 'name', label: '姓名', type: 'text', required: true },
          { key: 'mobile', label: '手机号', type: 'tel', required: true },
          { key: 'attendance_goal', label: '原报名参会目标', type: 'text', required: true },
        ],
        formAnswers: { attendance_goal: `第 ${index + 1} 位的完整审核资料` },
      })),
    };
  const refundContext = {
    contextVersion: 'context-1',
    remaining: 199500,
    items: items.map((item) => ({
      id: item.id,
      name: item.registration.attendee.name,
      version: item.version,
      refundableAmount: 39900,
      canRetain: true,
      canRevoke: true,
    })),
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
            role: commerce ? 'organization_admin' : 'operator',
            status: 'active',
            grants: [
              'event.read',
              'event.registration.read',
              ...(commerce ? ['event.order.read', 'event.order.refund'] : []),
              ...(allowed ? ['event.registration.manage'] : []),
            ],
          },
          adminPreferences: { lastEventId: null },
        },
      });
    if (path.endsWith('/admin/event-options'))
      return route.fulfill({ json: [{ ...event, organizationName: '测试组织' }] });
    if (path.endsWith(`/orders/${orderId}/items`) && !commerce)
      throw new Error('Operator must not request financial order details');
    if (path.endsWith(`/orders/${orderId}/items`))
      return route.fulfill({
        json: { order, items, myRegistrationId: null, nextAction: review ? 'review' : 'complete' },
      });
    if (path.endsWith(`/orders/${orderId}/item-refund-context`))
      return route.fulfill({ json: refundContext });
    if (path.endsWith(`/orders/${orderId}/review`)) {
      calls.push({ path, method: request.method(), body: request.postDataJSON() });
      order.status = 'pending_payment';
      order.version++;
      detail.registration.status = 'pending_payment';
      if (detail.batchReview) {
        detail.batchReview.status = order.status;
        detail.batchReview.version = order.version;
      }
      return route.fulfill({ json: { orderId, status: order.status, version: order.version } });
    }
    if (path.endsWith(`/orders/${orderId}/item-refunds`)) {
      calls.push({ path, method: request.method(), body: request.postDataJSON() });
      refundContext.remaining = 0;
      return route.fulfill({ json: { status: 'processing' } });
    }
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

test('batch admin reviews all five with current order version', async () => {
  const f = await fixture({ review: true });
  try {
    await f.page.getByRole('heading', { name: /本订单共 5 个名额/ }).waitFor();
    assert.equal(await f.page.locator('.batch-order-panel tbody tr').count(), 5);
    assert.equal(await f.page.getByLabel('审核说明').getAttribute('maxlength'), '500');
    f.page.once('dialog', (dialog) => dialog.accept());
    await f.page.getByRole('button', { name: '整单通过', exact: true }).click();
    await f.page.getByText('整单审核结果已保存', { exact: true }).waitFor();
    assert.deepEqual(f.calls[0].body, { expectedVersion: 1, decision: 'approve', reason: '' });
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});
test('batch admin refunds only two selected seats with distinct rights', async () => {
  const f = await fixture();
  try {
    const panel = f.page.locator('.batch-order-panel');
    await panel.getByRole('heading', { name: '指定名额补偿退款' }).waitFor();
    assert.equal(await panel.getByLabel('补偿原因').getAttribute('maxlength'), '1000');
    const rows = panel.locator('.batch-refund-row');
    await rows.nth(1).getByRole('checkbox').check();
    await rows.nth(3).getByRole('checkbox').check();
    await rows.nth(1).getByRole('combobox').selectOption('revoke');
    await panel.getByLabel('补偿原因').fill('按约定处理两位参会人补偿');
    f.page.once('dialog', (dialog) => dialog.accept());
    await panel.getByRole('button', { name: '确认指定名额退款' }).click();
    await f.page.getByText('退款已受理，请在退款申请中查看渠道处理结果', { exact: true }).waitFor();
    assert.equal(f.calls[0].body.allocations.length, 2);
    assert.equal(
      f.calls[0].body.allocations.reduce((sum, item) => sum + item.amount, 0),
      79800,
    );
    assert.deepEqual(
      f.calls[0].body.allocations.map((item) => item.rightsEffect),
      ['revoke', 'retain'],
    );
    assert.equal(f.calls[0].body.contextVersion, 'context-1');
    assert.deepEqual(f.errors, []);
    await panel.screenshot({ path: '/tmp/tokems-batch-ui/round2-batch-admin-finance.png' });
  } finally {
    await f.context.close();
  }
});

for (const width of [1280, 375])
  test(`an operator reviews all attendees without financial permissions at width ${width}`, async () => {
    const f = await fixture({ commerce: false, review: true, width });
    try {
      const panel = f.page.locator('.batch-review-panel');
      await panel.getByRole('heading', { name: '整批报名 · 5 位', exact: true }).waitFor();
      assert.equal(await panel.locator('.batch-review-person').count(), 5);
      assert.equal(await panel.getByLabel('审核说明').getAttribute('maxlength'), '500');
      for (let index = 1; index <= 5; index += 1)
        await panel.getByText(`第 ${index} 位的完整审核资料`, { exact: true }).waitFor();
      assert.equal(await f.page.locator('.batch-order-panel').count(), 0);
      assert.equal(await panel.getByText('订单金额', { exact: true }).count(), 0);
      assert.equal(await panel.getByText('退款合计', { exact: true }).count(), 0);
      assert.equal(
        await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      if (process.env.SCREENSHOT_DIR) {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
        await panel.screenshot({
          path: join(process.env.SCREENSHOT_DIR, `round2-operator-review-${width}.png`),
        });
      }
      f.page.once('dialog', (dialog) => dialog.accept());
      await panel.getByRole('button', { name: '整批通过', exact: true }).click();
      await panel.getByText('当前状态：待支付', { exact: true }).waitFor();
      assert.equal(
        await panel.getByText('整批审核结果已保存', { exact: true }).count(),
        1,
        `Successful review response must survive the detail refresh: ${JSON.stringify({ calls: f.calls, errors: f.errors, panel: await panel.innerText() })}`,
      );
      assert.deepEqual(f.calls[0].body, { expectedVersion: 1, decision: 'approve', reason: '' });
      assert.equal(await panel.getByRole('button', { name: '整批通过', exact: true }).count(), 0);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });

test('a registration reader sees no batch review controls or attendee group', async () => {
  const f = await fixture({ commerce: false, review: true, allowed: false });
  try {
    assert.equal(await f.page.locator('.batch-review-panel').count(), 0);
    assert.equal(await f.page.getByRole('button', { name: '整批通过', exact: true }).count(), 0);
    assert.equal(await f.page.locator('.batch-order-panel').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});
