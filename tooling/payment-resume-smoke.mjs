import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { DEMO_EVENT } from '../packages/contracts/dist/index.js';

// Fresh browser storage and fixture APIs exercise recovery without real transactions.
const base = process.env.WEB_BASE_URL ?? 'http://localhost:8088';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
  throw new Error('Payment browser checks require a local application');
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());

async function fixture(options = {}) {
  const context = await browser.newContext(
    options.userAgent ? { userAgent: options.userAgent } : {},
  );
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const event = structuredClone(DEMO_EVENT);
  const orderId = '11111111-1111-4111-8111-111111111111';
  const registrationId = '22222222-2222-4222-8222-222222222222';
  const itemId = '55555555-5555-4555-8555-555555555555';
  const now = new Date().toISOString();
  const status = options.status ?? 'pending_payment';
  const canManageOrder = options.canManageOrder !== false;
  const detail = {
    id: registrationId,
    eventId: event.id,
    eventName: event.name,
    eventSlug: event.slug,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    registrationCode: 'TOK-R-TEST',
    registrationStatus: status === 'paid' ? 'confirmed' : 'pending_payment',
    attendeeName: '测试参会者',
    attendee: {
      name: '测试参会者',
      mobile: '+8613800138000',
      email: '',
      company: '原测试公司',
      title: '',
      city: '',
    },
    ticketTypeName: '大会通票',
    ticketCode: status === 'paid' ? 'TICKET-FIXTURE' : null,
    ticketStatus: status === 'paid' ? 'valid' : null,
    createdAt: now,
    canManageOrder,
    canEditRegistrationInfo: canManageOrder && status === 'pending_payment',
    ...(options.orderItem ? { orderItemId: itemId, orderItemVersion: 1 } : {}),
    registrationEditVersion: 'a'.repeat(64),
    registrationEditFields: [
      { key: 'name', label: '姓名', type: 'text', required: true },
      { key: 'company', label: '公司', type: 'text', required: true },
      ...(options.selectCity
        ? [
            {
              key: 'city',
              label: '城市',
              type: 'select',
              required: false,
              options: ['北京', '上海'],
            },
          ]
        : []),
    ],
    orderId: canManageOrder ? orderId : null,
    orderNo: canManageOrder ? 'TOK-O-TEST' : null,
    orderStatus: canManageOrder ? status : null,
    amount: canManageOrder ? 39900 : null,
    currency: canManageOrder ? 'CNY' : null,
    invoiceId: null,
    invoiceStatus: null,
  };
  const order = {
    id: orderId,
    orderNo: 'TOK-O-TEST',
    registrationId,
    status,
    amount: 39900,
    currency: 'CNY',
    paymentMethod: 'wechat',
    isProxyPurchase: options.switchPaid === true || options.isProxyPurchase === true,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    createdAt: now,
  };
  const session = {
    authenticated: true,
    csrfToken: 'payment-fixture-csrf',
    customer: {
      id: 333,
      organizationId: event.organizationId,
      mobile: '+8613800138000',
      maskedMobile: '138****8000',
      profile: {
        realName: '测试参会者',
        nickname: '',
        email: null,
        company: '',
        title: '',
        city: '',
        version: 1,
      },
    },
  };
  const calls = [];
  const errors = [];
  let accessFailure = options.accessFailure === true;
  let prepareFailure = options.prepareFailure === true;
  let activeChannel = options.activeChannel;
  let loadAuthFailure = false;
  let editAuthFailure = options.editAuthFailure === true;
  let editFailure = options.editFailure === true;
  let itemTransientFailure = options.itemTransientFailure === true;
  let loseEditResponse = options.loseEditResponse === true;
  let releaseEditResponse;
  let releasePaymentResponse;
  const paymentResponseGate = options.holdPaymentResponse
    ? new Promise((resolve) => {
        releasePaymentResponse = resolve;
      })
    : Promise.resolve();
  const editResponseGate = options.holdEditResponse
    ? new Promise((resolve) => {
        releaseEditResponse = resolve;
      })
    : Promise.resolve();
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({
      path,
      method: request.method(),
      headers: request.headers(),
      body: request.postData() ? request.postDataJSON() : undefined,
    });
    if (path.endsWith('/customer-auth/otp'))
      return route.fulfill({
        json: {
          challengeId: 'fixture-otp',
          retryAfterSeconds: 60,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      });
    if (path.endsWith('/customer-auth/verify')) {
      session.authenticated = true;
      if (options.loginOther) session.customer.id = 444;
      return route.fulfill({ json: session });
    }
    if (path.endsWith('/customer-auth/session')) return route.fulfill({ json: session });
    if (path.endsWith('/customer-auth/logout')) {
      session.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/customer/registrations'))
      return route.fulfill({ json: { items: [detail], nextCursor: null } });
    if (path.endsWith(`/customer/registrations/${registrationId}`) && loadAuthFailure) {
      loadAuthFailure = false;
      session.authenticated = false;
      return route.fulfill({ status: 401, json: { message: '登录已过期' } });
    }
    if (path.endsWith(`/customer/registrations/${registrationId}`))
      return session.customer.id === 333
        ? route.fulfill({ json: detail })
        : route.fulfill({ status: 404, json: { message: '报名记录不存在' } });
    if (
      (path.endsWith(`/customer/orders/${orderId}/attendee`) ||
        path.endsWith(`/customer/orders/${orderId}/items/${itemId}/attendee`)) &&
      request.method() === 'PATCH'
    ) {
      if (options.lateEditAuthFailure) {
        await editResponseGate;
        return route.fulfill({ status: 401, json: { message: '请先登录' } });
      }
      if (options.orderItem) {
        assert.equal(path.endsWith(`/items/${itemId}/attendee`), true);
        const key = request.headers()['idempotency-key'];
        if (!key || key.length < 8 || key.length > 160)
          return route.fulfill({ status: 400, json: { message: '操作需要有效的请求标识' } });
        assert.equal(request.postDataJSON().expectedVersion, detail.orderItemVersion);
        if (itemTransientFailure) {
          itemTransientFailure = false;
          return route.fulfill({ status: 503, json: { message: '本次修改暂时无法确认' } });
        }
        const allowed = new Set(detail.registrationEditFields.map((field) => field.key));
        for (const field of ['name', 'company', 'email', 'title', 'city'])
          if (Object.hasOwn(request.postDataJSON(), field) && !allowed.has(field))
            return route.fulfill({ status: 400, json: { message: '该字段未开放修改' } });
      }
      if (options.forbiddenEdit)
        return route.fulfill({
          status: 403,
          json: { code: 'FORBIDDEN', message: '无权修改此报名' },
        });
      if (request.headers()['x-csrf-token'] !== session.csrfToken)
        return route.fulfill({
          status: 403,
          json: {
            code: 'FORBIDDEN',
            message: '页面安全校验已失效，请刷新后重试',
            details: { reason: 'customer_csrf_invalid' },
          },
        });
      if (editAuthFailure) {
        editAuthFailure = false;
        session.authenticated = false;
        return route.fulfill({ status: 401, json: { message: '登录已过期' } });
      }
      if (editFailure)
        return route.fulfill({ status: 409, json: { message: '订单状态已更新，请刷新后重试' } });
      const { expectedRegistrationVersion, ...patch } = request.postDataJSON();
      delete patch.expectedVersion;
      if (expectedRegistrationVersion !== detail.registrationEditVersion)
        return route.fulfill({
          status: 409,
          json: {
            code: 'INVALID_STATE_TRANSITION',
            message: '报名信息已发生变化',
            details: { reason: 'registration_version_conflict' },
          },
        });
      Object.assign(detail.attendee, patch);
      detail.registrationEditVersion = 'b'.repeat(64);
      if (options.orderItem) detail.orderItemVersion += 1;
      await editResponseGate;
      if (loseEditResponse) {
        loseEditResponse = false;
        return route.fulfill({ status: 502, json: { message: '保存结果未收到' } });
      }
      return route.fulfill({ json: { id: orderId } });
    }
    if (path.endsWith('/attendee-needs'))
      return route.fulfill({ json: { id: null, canCreate: false } });
    if (path.endsWith('/service-hub'))
      return route.fulfill({
        json: {
          registration: detail,
          latestPaymentStatus: options.latestPaymentStatus ?? null,
          items: [
            {
              code: 'ticket',
              state: 'attention',
              label: '等待完成支付',
              description: '查看支付状态',
            },
          ],
          organizerContact: { enabled: false, eligible: false, qrAvailable: false },
          actionRequiredCount: 1,
          updatedAt: now,
        },
      });
    if (path.endsWith('/customer/orders'))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith('/customer/invoices'))
      return route.fulfill({
        json: {
          items: [],
          counts: {
            all: 0,
            eligible: 0,
            actionRequired: 0,
            processing: 0,
            issued: 0,
            history: 0,
          },
          nextCursor: null,
        },
      });
    if (path.endsWith(`/customer/orders/${orderId}/payment-access`)) {
      await paymentResponseGate;
      if (options.statusAfterAccessFailure) {
        detail.orderStatus = options.statusAfterAccessFailure;
        detail.registrationStatus = detail.orderStatus === 'paid' ? 'confirmed' : 'pending_payment';
        detail.ticketCode = detail.orderStatus === 'paid' ? 'TICKET-FIXTURE' : null;
        detail.ticketStatus = detail.orderStatus === 'paid' ? 'valid' : null;
      }
      if (accessFailure)
        return route.fulfill({
          status: 409,
          json: { message: '订单保留时间已结束，请返回报名页重新提交' },
        });
      return route.fulfill({ json: { orderId, orderAccessToken: 'fresh-payment-fixture-token' } });
    }
    if (path.endsWith(`/orders/${orderId}`)) return route.fulfill({ json: order });
    if (path.endsWith(`/payments/mock/${orderId}/capability`))
      return route.fulfill({ json: { allowed: false } });
    if (path.endsWith(`/payments/wechat/${orderId}/native`)) {
      if (activeChannel && activeChannel !== 'native')
        return route.fulfill({
          status: 409,
          json: {
            code: 'INVALID_STATE_TRANSITION',
            message: '当前订单已有其他支付通道进行中，请先切换通道',
            details: {
              reason: 'payment_channel_conflict',
              activeChannel,
              requestedChannel: 'native',
            },
          },
        });
      if (prepareFailure)
        return route.fulfill({ status: 502, json: { message: '微信支付未返回付款二维码' } });
      return route.fulfill({
        json: {
          orderId,
          channel: 'native',
          attemptId: 'fixture-attempt',
          outTradeNo: 'fixture-trade',
          codeUrl: 'weixin://wxpay/bizpayurl?pr=fixture',
          expiresAt: order.expiresAt,
        },
      });
    }
    if (path.endsWith(`/payments/wechat/${orderId}/switch`)) {
      assert.equal(request.postDataJSON().channel, 'native');
      if (options.switchFailure)
        return route.fulfill({
          status: 409,
          json: { message: '微信支付订单尚未确认关闭，请稍后重试' },
        });
      if (options.switchPaid) {
        order.status = 'paid';
        return route.fulfill({ json: { paid: true, orderId } });
      }
      activeChannel = 'native';
      return route.fulfill({
        json: {
          orderId,
          channel: 'native',
          attemptId: 'switched-attempt',
          outTradeNo: 'switched-trade',
          codeUrl: 'weixin://wxpay/bizpayurl?pr=switched',
          expiresAt: order.expiresAt,
        },
      });
    }
    if (path.endsWith(`/events/${event.slug}`) || path.endsWith('/homepage'))
      return route.fulfill({ json: event });
    return route.fulfill({ status: 404, json: { message: 'Fixture API not configured' } });
  });
  return {
    page,
    context,
    calls,
    errors,
    event,
    orderId,
    registrationId,
    releaseEdit: () => releaseEditResponse?.(),
    releasePayment: () => releasePaymentResponse?.(),
    closeFromAnotherPage: () => {
      detail.orderStatus = 'closed';
      detail.canEditRegistrationInfo = false;
      detail.registrationStatus = 'cancelled';
      detail.registrationEditVersion = 'b'.repeat(64);
    },
    disableCompanyField: () => {
      detail.registrationEditFields = detail.registrationEditFields.filter(
        (field) => field.key !== 'company',
      );
      detail.registrationEditVersion = 'b'.repeat(64);
    },
    updateFromAnotherPage: () => {
      detail.attendee.company = '另一页面更新的公司';
      detail.registrationEditVersion = 'b'.repeat(64);
    },
    reloginInAnotherTab: (other) => {
      session.csrfToken = 'renewed-fixture-csrf';
      if (other) session.customer.id = 444;
    },
    expireBeforeEdit: () => {
      loadAuthFailure = true;
    },
    allowEdit: () => {
      editFailure = false;
    },
    allowAccess: () => {
      accessFailure = false;
    },
    allowPrepare: () => {
      prepareFailure = false;
    },
    async open(detailPage = false) {
      await page.goto(`${base}/account${detailPage ? `/registrations/${registrationId}` : ''}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.locator(detailPage ? '.detail-panel' : '.account-pass__primary').waitFor();
    },
    async assertCheckout() {
      await page.waitForURL(`**/order/${orderId}?event=${event.slug}*`);
      await page.locator('svg[aria-label="微信支付二维码"]').waitFor();
      const accessCalls = calls.filter((call) => call.path.endsWith('/payment-access'));
      assert.equal(accessCalls.length, 1);
      assert.equal(accessCalls[0].method, 'POST');
      assert.equal(accessCalls[0].headers['x-csrf-token'], session.csrfToken);
      const prepare = calls.find((call) => call.path.endsWith('/native'));
      assert.equal(prepare?.headers.authorization, 'Bearer fresh-payment-fixture-token');
      assert.equal(new URL(page.url()).hash, '');
      assert.deepEqual(errors, []);
    },
  };
}

test('registration detail lets the purchaser correct company information and continue paying', async () => {
  const f = await fixture();
  try {
    await f.open(true);
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      await f.page.screenshot({
        path: join(process.env.SCREENSHOT_DIR, 'registration-detail-edit-link.png'),
        fullPage: true,
      });
    }
    await f.page.getByRole('link', { name: '返回修改信息', exact: true }).click();
    await f.page.getByRole('heading', { name: '修改报名信息', exact: true }).waitFor();
    await f.page.getByLabel('公司', { exact: true }).fill('修正后的测试公司');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.locator('.detail-grid').getByText('修正后的测试公司', { exact: true }).waitFor();
    const edit = f.calls.find((call) => call.path.endsWith('/attendee'));
    assert.deepEqual(edit.body, {
      company: '修正后的测试公司',
      expectedRegistrationVersion: 'a'.repeat(64),
    });
    assert.equal(edit.headers['x-csrf-token'], 'payment-fixture-csrf');
    await f.page.getByRole('button', { name: '继续支付', exact: true }).click();
    await f.assertCheckout();
  } finally {
    await f.context.close();
  }
});

test('an editor entered from an expired detail session asks for login and recovers', async () => {
  const f = await fixture();
  try {
    await f.open(true);
    f.expireBeforeEdit();
    await f.page.getByRole('link', { name: '返回修改信息', exact: true }).click();
    const dialog = f.page.getByRole('dialog');
    await dialog.getByPlaceholder('请输入 11 位手机号').fill('13800138000');
    await dialog.getByRole('button', { name: '获取验证码', exact: true }).click();
    await dialog.getByPlaceholder('6 位验证码').fill('123456');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '验证并继续', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await f.page.getByLabel('公司', { exact: true }).inputValue(), '原测试公司');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('the editor preserves the historical dropdown options', async () => {
  const f = await fixture({ selectCity: true });
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    const select = f.page.getByRole('combobox', { name: '城市', exact: true });
    await select.waitFor();
    assert.deepEqual(await select.locator('option').allTextContents(), [
      '请选择城市',
      '北京',
      '上海',
    ]);
    await select.selectOption('上海');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.locator('.detail-panel').waitFor();
    assert.equal(f.calls.find((call) => call.path.endsWith('/attendee')).body.city, '上海');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('a committed edit with a lost response can confirm the saved result without another write', async () => {
  const f = await fixture({ loseEditResponse: true });
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    await f.page.getByLabel('公司', { exact: true }).fill('已保存的更正公司');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.locator('.detail-grid').getByText('已保存的更正公司', { exact: true }).waitFor();
    assert.equal(f.calls.filter((call) => call.path.endsWith('/attendee')).length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('a committed edit with a hanging response times out and confirms without another write', async () => {
  const f = await fixture({ holdEditResponse: true });
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    await f.page.getByLabel('公司', { exact: true }).fill('超时后确认的公司');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.locator('.detail-grid').getByText('超时后确认的公司', { exact: true }).waitFor();
    assert.equal(f.calls.filter((call) => call.path.endsWith('/attendee')).length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    f.releaseEdit();
    await f.context.close();
  }
});

for (const keepDraft of [true, false]) {
  test(`a genuine version conflict lets the user compare values before saving: keepDraft=${keepDraft}`, async () => {
    const f = await fixture();
    try {
      await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
      await f.page.getByLabel('公司', { exact: true }).fill('我填写的草稿公司');
      f.updateFromAnotherPage();
      await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
      await f.page.getByRole('button', { name: '核对最新信息', exact: true }).click();
      const conflict = f.page.getByRole('group', { name: '核对公司', exact: true });
      await conflict.getByText('另一页面更新的公司', { exact: true }).waitFor();
      await conflict.getByText('我填写的草稿公司', { exact: true }).waitFor();
      if (keepDraft && process.env.SCREENSHOT_DIR) {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
        for (const width of [1280, 375]) {
          await f.page.setViewportSize({ width, height: 900 });
          assert.equal(
            await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await f.page.screenshot({
            path: join(process.env.SCREENSHOT_DIR, `registration-review-conflict-${width}.png`),
            fullPage: true,
          });
        }
      }
      assert.equal(
        await f.page.getByRole('button', { name: '保存修改', exact: true }).isDisabled(),
        true,
      );
      await conflict
        .getByRole('button', { name: keepDraft ? '保留我的修改' : '使用最新内容', exact: true })
        .click();
      await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
      await f.page
        .locator('.detail-grid')
        .getByText(keepDraft ? '我填写的草稿公司' : '另一页面更新的公司', { exact: true })
        .waitFor();
      assert.equal(
        f.calls.filter((call) => call.path.endsWith('/attendee')).length,
        keepDraft ? 2 : 1,
      );
      if (keepDraft)
        assert.equal(
          f.calls.filter((call) => call.path.endsWith('/attendee')).at(-1).body
            .expectedRegistrationVersion,
          'b'.repeat(64),
        );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}

for (const other of [false, true]) {
  test(`another tab renews the login while an edit is open: other=${other}`, async () => {
    const f = await fixture();
    try {
      await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
      await f.page.getByLabel('公司', { exact: true }).fill('跨标签保留的草稿');
      f.reloginInAnotherTab(other);
      await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
      if (other) {
        await f.page.getByRole('alert').filter({ hasText: '报名记录不存在' }).waitFor();
        assert.equal(await f.page.getByLabel('公司', { exact: true }).count(), 0);
        assert.equal(f.calls.filter((call) => call.path.endsWith('/attendee')).length, 1);
      } else {
        await f.page.getByRole('alert').filter({ hasText: '登录状态已更新' }).waitFor();
        assert.equal(
          await f.page.getByLabel('公司', { exact: true }).inputValue(),
          '跨标签保留的草稿',
        );
        await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
        await f.page
          .locator('.detail-grid')
          .getByText('跨标签保留的草稿', { exact: true })
          .waitFor();
        assert.equal(
          f.calls.filter((call) => call.path.endsWith('/attendee')).at(-1).headers['x-csrf-token'],
          'renewed-fixture-csrf',
        );
      }
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}

test('the editor updates the selected order item when the registration includes item metadata', async () => {
  const f = await fixture({ orderItem: true });
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    await f.page.getByLabel('公司', { exact: true }).fill('逐名额更正公司');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.locator('.detail-grid').getByText('逐名额更正公司', { exact: true }).waitFor();
    const update = f.calls.find((call) => call.path.endsWith('/attendee'));
    assert.match(update.path, /\/items\/55555555-5555-4555-8555-555555555555\/attendee$/);
    assert.equal(update.body.expectedVersion, 1);
    assert.equal(update.body.expectedRegistrationVersion, 'a'.repeat(64));
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('a new-model self editor renders only fields allowed by the original registration form', async () => {
  const f = await fixture({ orderItem: true });
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    await f.page.getByLabel('公司', { exact: true }).waitFor();
    assert.equal(await f.page.locator('#edit-name').count(), 1);
    assert.equal(await f.page.locator('#edit-company').count(), 1);
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      await f.page
        .locator('.registration-edit-shell')
        .screenshot({ path: join(process.env.SCREENSHOT_DIR, 'round2-self-editor-fields.png') });
    }
    for (const key of ['email', 'title', 'city'])
      assert.equal(
        await f.page.locator(`#edit-${key}`).count(),
        0,
        `${key} is not an editable original field`,
      );
    await f.page.getByLabel('公司', { exact: true }).fill('仅修改允许的公司');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.locator('.detail-grid').getByText('仅修改允许的公司', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('a new-model self edit reuses its request key after an unconfirmed unchanged result', async () => {
  const f = await fixture({ orderItem: true, itemTransientFailure: true });
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    await f.page.getByLabel('公司', { exact: true }).fill('重试同一次名额更正');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.getByRole('button', { name: '核对最新信息', exact: true }).waitFor();
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.locator('.detail-grid').getByText('重试同一次名额更正', { exact: true }).waitFor();
    const updates = f.calls.filter((call) => call.path.endsWith('/attendee'));
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0].body, updates[1].body);
    assert.equal(updates[0].headers['idempotency-key'], updates[1].headers['idempotency-key']);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('an item editor preserves newly unavailable field drafts without sending them again', async () => {
  const f = await fixture({ orderItem: true, editFailure: true });
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    await f.page.getByLabel('公司', { exact: true }).fill('保留关闭字段的草稿');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.getByRole('button', { name: '核对最新信息', exact: true }).waitFor();
    f.disableCompanyField();
    f.allowEdit();
    await f.page.getByRole('button', { name: '核对最新信息', exact: true }).click();
    await f.page.getByText('保留关闭字段的草稿', { exact: true }).waitFor();
    assert.equal(await f.page.locator('#edit-company').count(), 0);
    await f.page.getByLabel('参会人姓名', { exact: true }).fill('只保存允许的姓名');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.locator('.detail-grid').waitFor();
    const updates = f.calls.filter((call) => call.path.endsWith('/attendee'));
    assert.equal(updates.length, 2);
    assert.equal(Object.hasOwn(updates[1].body, 'company'), false);
    assert.equal(updates[1].body.name, '只保存允许的姓名');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('checking a closed registration preserves the unsaved draft without permitting an update', async () => {
  const f = await fixture();
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    await f.page.getByLabel('公司', { exact: true }).fill('关闭前填写的公司');
    f.closeFromAnotherPage();
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.getByRole('button', { name: '核对最新信息', exact: true }).click();
    await f.page.getByText('关闭前填写的公司', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: '保存修改', exact: true }).count(), 0);
    assert.equal(f.calls.filter((call) => call.path.endsWith('/attendee')).length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('ordinary forbidden edits do not trigger session recovery or a retry', async () => {
  const f = await fixture({ forbiddenEdit: true });
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    await f.page.getByLabel('公司', { exact: true }).fill('保留的公司');
    const sessionCalls = f.calls.filter((call) =>
      call.path.endsWith('/customer-auth/session'),
    ).length;
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: '无权修改此报名' }).waitFor();
    assert.equal(
      f.calls.filter((call) => call.path.endsWith('/customer-auth/session')).length,
      sessionCalls,
    );
    assert.equal(f.calls.filter((call) => call.path.endsWith('/attendee')).length, 1);
    assert.equal(await f.page.getByLabel('公司', { exact: true }).inputValue(), '保留的公司');
  } finally {
    await f.context.close();
  }
});

for (const lateEditAuthFailure of [false, true]) {
  test(`a late save cannot navigate or request login after the user leaves: unauthorized=${lateEditAuthFailure}`, async () => {
    const f = await fixture({ holdEditResponse: true, lateEditAuthFailure });
    try {
      await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
      await f.page.getByLabel('公司', { exact: true }).fill('延迟保存的公司');
      const request = f.page.waitForRequest((request) => request.url().endsWith('/attendee'));
      await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
      await request;
      await f.page.getByRole('link', { name: '前往个人中心', exact: true }).click();
      await f.page.locator('.account-pass__primary').waitFor();
      const response = f.page.waitForResponse((response) => response.url().endsWith('/attendee'));
      f.releaseEdit();
      await response;
      await f.page.waitForLoadState('networkidle');
      assert.equal(new URL(f.page.url()).pathname, '/account');
      assert.equal(await f.page.getByRole('dialog').count(), 0);
      assert.deepEqual(f.errors, []);
    } finally {
      f.releaseEdit();
      await f.context.close();
    }
  });
}

for (const scenario of ['account-leave', 'detail-leave', 'detail-editor', 'account-switch']) {
  for (const accessFailure of [false, true]) {
    test(`a late payment response cannot redirect or refresh an old context: ${scenario}, failure=${accessFailure}`, async () => {
      const f = await fixture({ holdPaymentResponse: true, accessFailure, loginOther: true });
      try {
        const detailPage = scenario.startsWith('detail');
        await f.open(detailPage);
        const requested = f.page.waitForRequest((request) => request.url().endsWith('/payment-access'));
        await (detailPage
          ? f.page.getByRole('button', { name: '继续支付', exact: true })
          : f.page.locator('.account-pass__primary')).click();
        await requested;
        if (scenario === 'account-switch') {
          await f.page.getByRole('button', { name: '退出登录', exact: true }).first().click();
          await f.page.getByRole('button', { name: '登录或注册账号', exact: true }).click();
          const dialog = f.page.getByRole('dialog');
          await dialog.getByPlaceholder('请输入 11 位手机号').fill('13900139000');
          await dialog.getByRole('button', { name: '获取验证码', exact: true }).click();
          await dialog.getByPlaceholder('6 位验证码').fill('123456');
          await dialog.getByRole('checkbox').check();
          await dialog.getByRole('button', { name: '验证并继续', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          await f.page.locator('.account-pass__primary').waitFor();
        } else if (scenario === 'account-leave') {
          await f.page.getByRole('link', { name: '报名详情', exact: true }).first().click();
          await f.page.locator('.detail-panel').waitFor();
        } else if (scenario === 'detail-editor') {
          await f.page.getByRole('link', { name: '返回修改信息', exact: true }).click();
          await f.page.getByLabel('公司', { exact: true }).waitFor();
        } else {
          await f.page.getByRole('link', { name: '← 返回用户中心', exact: true }).click();
          await f.page.locator('.account-pass__primary').waitFor();
        }
        await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const destination = f.page.url();
        const previousCalls = f.calls.length;
        const response = f.page.waitForResponse((result) => result.url().endsWith('/payment-access'));
        f.releasePayment();
        await response;
        await f.page.waitForLoadState('networkidle');
        assert.equal(f.page.url(), destination);
        assert.deepEqual(f.calls.slice(previousCalls), [], 'an obsolete payment callback must not load the old order');
        assert.equal(await f.page.getByText('订单保留时间已结束，请返回报名页重新提交', { exact: true }).count(), 0);
        assert.deepEqual(f.errors, []);
      } finally {
        f.releasePayment();
        await f.context.close();
      }
    });
  }
}

test('required company cannot be cleared and cancel leaves the saved registration unchanged', async () => {
  const f = await fixture();
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    const company = f.page.getByLabel('公司', { exact: true });
    await company.fill('');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    assert.equal(await company.evaluate((input) => input.validity.valueMissing), true);
    assert.equal(
      f.calls.some((call) => call.path.endsWith('/attendee')),
      false,
    );
    await f.page.getByRole('link', { name: '取消，返回详情', exact: true }).click();
    await f.page.locator('.detail-grid').getByText('原测试公司', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('a failed edit preserves the draft and permits retry', async () => {
  const f = await fixture({ editFailure: true });
  try {
    await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
    await f.page.getByLabel('公司', { exact: true }).fill('保留的草稿公司');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: '订单状态已更新' }).waitFor();
    assert.equal(await f.page.getByLabel('公司', { exact: true }).inputValue(), '保留的草稿公司');
    f.allowEdit();
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.locator('.detail-grid').getByText('保留的草稿公司', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

for (const loginOther of [false, true]) {
  test(`an expired editor login preserves the draft only for the original account: other=${loginOther}`, async () => {
    const f = await fixture({ editAuthFailure: true, loginOther });
    try {
      await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
      await f.page.getByLabel('公司', { exact: true }).fill('重新登录保留公司');
      await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
      const dialog = f.page.getByRole('dialog');
      await dialog.getByPlaceholder('请输入 11 位手机号').fill('13800138000');
      await dialog.getByRole('button', { name: '获取验证码', exact: true }).click();
      await dialog.getByPlaceholder('6 位验证码').fill('123456');
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: '验证并继续', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      if (loginOther) {
        await f.page.getByRole('alert').filter({ hasText: '报名记录不存在' }).waitFor();
        assert.equal(await f.page.getByLabel('公司', { exact: true }).count(), 0);
        assert.equal(f.calls.filter((call) => call.path.endsWith('/attendee')).length, 1);
      } else {
        assert.equal(
          await f.page.getByLabel('公司', { exact: true }).inputValue(),
          '重新登录保留公司',
        );
        await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
        await f.page
          .locator('.detail-grid')
          .getByText('重新登录保留公司', { exact: true })
          .waitFor();
      }
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}

for (const isProxyPurchase of [false, true]) {
  test(`payment edit link selects the purchaser's available editor: proxy=${isProxyPurchase}`, async () => {
    const f = await fixture({ isProxyPurchase });
    try {
      await f.open(true);
      await f.page.getByRole('button', { name: '继续支付', exact: true }).click();
      await f.assertCheckout();
      const link = f.page.getByRole('link', { name: '返回修改信息', exact: true });
      const url = new URL(await link.getAttribute('href'), f.page.url());
      assert.equal(
        url.pathname,
        isProxyPurchase ? '/account' : `/account/registrations/${f.registrationId}/edit`,
      );
      assert.equal(url.searchParams.get('event'), f.event.slug);
      if (isProxyPurchase) assert.equal(url.hash, '#purchases');
      else {
        await link.click();
        await f.page.getByRole('heading', { name: '修改报名信息', exact: true }).waitFor();
        assert.equal(await f.page.getByLabel('公司', { exact: true }).inputValue(), '原测试公司');
      }
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}

test('registration editor fits desktop and mobile without horizontal overflow', async () => {
  const f = await fixture();
  try {
    for (const width of [1280, 375]) {
      // This is a disposable headless browser context, separate from the user's browser.
      await f.page.setViewportSize({ width, height: 900 });
      await f.page.goto(`${base}/account/registrations/${f.registrationId}/edit`);
      await f.page.getByLabel('公司', { exact: true }).waitFor();
      assert.equal(
        await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (process.env.SCREENSHOT_DIR) {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
        await f.page.screenshot({
          path: join(process.env.SCREENSHOT_DIR, `registration-edit-${width}.png`),
          fullPage: true,
        });
      }
    }
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('closing a failed payment tab and reopening its clean URL offers authenticated recovery', async () => {
  const f = await fixture({ prepareFailure: true });
  try {
    await f.open(true);
    await f.page.getByRole('button', { name: '继续支付', exact: true }).click();
    await f.page.locator('.payment-prepare-error').waitFor();
    const cleanUrl = f.page.url();
    assert.equal(new URL(cleanUrl).hash, '');
    await f.page.close();
    f.allowPrepare();
    const reopened = await f.context.newPage();
    await reopened.goto(cleanUrl);
    await reopened.getByRole('link', { name: '返回个人中心继续支付', exact: true }).click();
    await reopened.locator('button.account-pass__primary').click();
    await reopened.locator('svg[aria-label="微信支付二维码"]').waitFor();
    assert.equal(f.calls.filter((call) => call.path.endsWith('/payment-access')).length, 2);
  } finally {
    await f.context.close();
  }
});

const entries = [
  ['featured registration', '.account-pass__primary', false],
  ['ticket service', 'button.service-hub-card', false],
  ['registration list', '#events .registration-primary-action', false],
  ['registration detail', '.detail-primary', true],
];

test('desktop WeChat displays a QR code without starting mobile OAuth', async () => {
  const f = await fixture({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 MicroMessenger/3.9.10.27 WindowsWechat',
  });
  try {
    await f.open();
    await f.page.locator('.account-pass__primary').click();
    await f.assertCheckout();
    assert.equal(
      f.calls.some((call) => call.path.endsWith('/oauth/start')),
      false,
    );
  } finally {
    await f.context.close();
  }
});

test('a payment started in WeChat can resume with a desktop QR code', async () => {
  const f = await fixture({ activeChannel: 'jsapi' });
  try {
    await f.open();
    await f.page.locator('.account-pass__primary').click();
    await f.assertCheckout();
    assert.equal(f.calls.filter((call) => call.path.endsWith('/switch')).length, 1);
  } finally {
    await f.context.close();
  }
});

test('channel recovery respects an already-paid result without displaying another QR', async () => {
  const f = await fixture({ activeChannel: 'jsapi', switchPaid: true });
  try {
    await f.open();
    await f.page.locator('.account-pass__primary').click();
    await f.page.getByRole('heading', { name: '代购订单已完成' }).waitFor();
    assert.equal(await f.page.locator('svg[aria-label="微信支付二维码"]').count(), 0);
    assert.equal(f.calls.filter((call) => call.path.endsWith('/switch')).length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('an unsettled old payment stops channel recovery with a visible reason', async () => {
  const f = await fixture({ activeChannel: 'jsapi', switchFailure: true });
  try {
    await f.open();
    await f.page.locator('.account-pass__primary').click();
    await f.page
      .locator('.payment-prepare-error')
      .filter({ hasText: '微信支付订单尚未确认关闭' })
      .waitFor();
    assert.equal(await f.page.locator('svg[aria-label="微信支付二维码"]').count(), 0);
    assert.equal(f.calls.filter((call) => call.path.endsWith('/switch')).length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});
for (const [name, selector, detailPage] of entries) {
  test(`${name} restores payment and displays a QR code in a fresh browser`, async () => {
    const f = await fixture();
    try {
      await f.open(detailPage);
      await f.page.locator(selector).first().click();
      await f.assertCheckout();
    } finally {
      await f.context.close();
    }
  });
}

test('payment access errors preserve registration details and allow another attempt', async () => {
  const f = await fixture({ accessFailure: true });
  try {
    await f.open(true);
    await f.page.getByRole('button', { name: '继续支付', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: '订单保留时间已结束' }).waitFor();
    assert.equal(await f.page.locator('.detail-grid').isVisible(), true);
    f.allowAccess();
    await f.page.getByRole('button', { name: '继续支付', exact: true }).click();
    await f.page.locator('svg[aria-label="微信支付二维码"]').waitFor();
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('a failed QR request shows the reason and an explicit retry restores the QR', async () => {
  const f = await fixture({ prepareFailure: true });
  try {
    await f.open();
    await f.page.locator('.account-pass__primary').click();
    await f.page
      .locator('.payment-prepare-error')
      .filter({ hasText: '微信支付未返回付款二维码' })
      .waitFor();
    f.allowPrepare();
    await f.page.getByRole('button', { name: '重新尝试支付' }).click();
    await f.page.locator('svg[aria-label="微信支付二维码"]').waitFor();
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

for (const status of ['paid', 'closed', 'processing']) {
  test(`account updates stale registration actions when payment recovery discovers ${status}`, async () => {
    const f = await fixture({ accessFailure: true, statusAfterAccessFailure: status });
    try {
      await f.open();
      await f.page.locator('.account-pass__primary').click();
      await f.page.getByRole('alert').filter({ hasText: '订单保留时间已结束' }).waitFor();
      const expected =
        status === 'paid' ? '打开电子票' : status === 'processing' ? '查看支付进度' : '查看报名';
      assert.match(
        await f.page.locator('.account-pass__primary').innerText(),
        new RegExp(expected),
      );
      assert.match(
        await f.page.locator('#events .registration-primary-action').innerText(),
        new RegExp(expected),
      );
      assert.match(
        await f.page.locator('.service-hub-card__action').innerText(),
        new RegExp(expected),
      );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}

for (const options of [
  { canManageOrder: false },
  { status: 'paid' },
  { status: 'processing' },
  { status: 'closed' },
]) {
  test(`registration actions respect ownership and order state: ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    try {
      await f.open();
      assert.doesNotMatch(
        await f.page.locator('.account-pass__primary').innerText(),
        /继续支付|重新支付/,
      );
      await f.open(true);
      assert.equal(await f.page.getByRole('button', { name: '继续支付', exact: true }).count(), 0);
      assert.equal(
        f.calls.some((call) => call.path.endsWith('/payment-access')),
        false,
      );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}
