import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { AliyunSmsConfigurationSchema, DEMO_EVENT } from '../packages/contracts/dist/index.js';
import { readAliyunSmsConfiguration } from '../packages/integrations/dist/index.js';
const base = process.env.ADMIN_BASE_URL ?? 'http://127.0.0.1:5197/admin';
if (!['localhost', '127.0.0.1', 'admin.localhost'].includes(new URL(base).hostname))
  throw new Error('Local UI only');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());
let fixtureNumber = 0;
const artifacts = '/tmp/tokems-invoice-ui';
await mkdir(artifacts, { recursive: true });
async function fixture({
  width = 1440,
  canManage = true,
  configured = true,
  testFailure = false,
  requestFailure = false,
  refreshFailure = false,
} = {}) {
  const number = ++fixtureNumber;
  const context = await browser.newContext({ viewport: { width, height: 1100 } });
  await context.addInitScript(() =>
    localStorage.setItem('conference.admin.token', 'invoice-ui-fixture'),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let config = AliyunSmsConfigurationSchema.parse({
    enabled: true,
    signName: '测试签名',
    endpoint: 'dysmsapi.aliyuncs.com',
    status: configured ? 'configured' : 'unconfigured',
    lastVerifiedAt: null,
    lastError: null,
    secretsPresent: { accessKeyId: configured, accessKeySecret: configured },
    templates: readAliyunSmsConfiguration({}).templates,
    invoiceFileOrigin: 'https://invoice.example',
    updatedAt: '2026-09-10T00:00:00.000Z',
  });
  config.templates.customerOtp = {
    ...config.templates.customerOtp,
    templateCode: 'SMS_OTP',
    enabled: true,
  };
  const calls = [];
  const testCalls = [];
  let delivered = false,
    version = 0;
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/auth/me'))
      return route.fulfill({
        json: {
          user: { id: 101, name: '测试管理员', email: 'test@example.com' },
          organization: {
            id: DEMO_EVENT.organizationId,
            slug: 'test',
            name: '测试组织',
            settings: {},
          },
          membership: {
            id: 'test',
            role: 'organization_admin',
            status: 'active',
            grants: [
              'org.settings.read',
              ...(canManage ? ['org.settings.manage'] : []),
              'event.read',
              'org.invoice.manage',
              'org.invoice.read',
            ],
          },
          adminPreferences: { lastEventId: null },
        },
      });
    if (path.endsWith('/admin/event-options'))
      return route.fulfill({ json: [{ ...DEMO_EVENT, organizationName: '测试组织' }] });
    if (path.endsWith('/integrations/aliyun-sms')) {
      if (refreshFailure && testCalls.length && request.method() === 'GET')
        return route.fulfill({ status: 503, json: { message: '配置暂时不可用' } });
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON();
        calls.push(body);
        assert.equal(body.expectedUpdatedAt, config.updatedAt);
        config = {
          ...config,
          ...body,
          invoiceSms: { ...config.invoiceSms, deliveryMode: body.invoiceDeliveryMode },
          updatedAt: `2026-09-10T00:00:0${++version}.000Z`,
        };
      }
      return route.fulfill({ json: config });
    }
    if (path.endsWith('/aliyun-sms/test')) {
      const body = request.postDataJSON();
      testCalls.push({ body, key: request.headers()['idempotency-key'] });
      if (requestFailure)
        return route.fulfill({
          status: 429,
          json: { message: '测试短信发送过于频繁，请稍后再试' },
        });
      if (body.templateKey !== 'invoiceReady')
        return route.fulfill({
          json: {
            ok: !testFailure,
            status: testFailure ? 'error' : 'verified',
            message: testFailure
              ? 'isv.SMS_SIGNATURE_ILLEGAL · 签名未通过审核'
              : '阿里云已受理发往 138****8000 的测试短信；最终送达以回执为准。',
            verifiedAt: '2026-09-10T00:00:00.000Z',
            bizId: testFailure ? '' : 'TEST-BIZ-1001',
            maskedPhone: '138****8000',
          },
        });
      config.invoiceSms.testDeliveryId = '11111111-1111-4111-8111-111111111111';
      return route.fulfill({
        json: {
          ok: false,
          deliveryId: config.invoiceSms.testDeliveryId,
          status: 'pending',
          message: '样例短信已排队',
          bizId: null,
        },
      });
    }
    if (path.includes('/invoice-ready/tests/')) {
      if (delivered) {
        config = {
          ...config,
          updatedAt: `2026-09-10T00:00:0${++version}.000Z`,
          invoiceSms: {
            ...config.invoiceSms,
            verifiedFingerprint: 'test-proof',
            verifiedOrigin: config.invoiceFileOrigin,
          },
        };
      }
      return route.fulfill({
        json: {
          deliveryId: config.invoiceSms.testDeliveryId,
          status: delivered ? 'delivered' : 'accepted',
          maskedPhone: '138****8000',
          error: null,
          configurationMatches: true,
          fileReachable: true,
          ready: delivered,
        },
      });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(`${base}/manage/settings/sms`);
  await page.getByRole('heading', { name: '短信服务', exact: true }).waitFor();
  return {
    number,
    page,
    context,
    errors,
    calls,
    testCalls,
    deliver: () => {
      delivered = true;
    },
  };
}
test('first-time invoice template can be configured while switch stays gated, then tested and enabled', async () => {
  const f = await fixture();
  try {
    const code = f.page.locator('#sms-template-invoiceReady');
    const row = f.page.locator('.sms-template-row').filter({ has: code });
    const toggle = row.getByRole('checkbox');
    assert.equal(await code.isEnabled(), true);
    assert.equal(await toggle.isDisabled(), true);
    await f.page.getByLabel('测试场景', { exact: true }).selectOption('invoiceReady');
    await f.page.getByLabel('接收手机号', { exact: true }).fill('13800138000');
    await f.page.getByLabel('我确认将向上述手机号发送真实短信，并可能产生费用。').check();
    assert.equal(
      await f.page.getByRole('button', { name: '发送并验证', exact: true }).isDisabled(),
      true,
    );
    await code.fill('SMS_INVOICE');
    await f.page.getByRole('button', { name: '保存短信配置', exact: true }).click();
    await f.page.getByText('短信配置已加密保存。', { exact: false }).waitFor();
    assert.equal(f.calls[0].invoiceDeliveryMode, 'direct_file_v1');
    assert.equal(f.calls[0].templates.invoiceReady.enabled, false);
    await f.page.getByLabel('我确认将向上述手机号发送真实短信，并可能产生费用。').check();
    await f.page.getByRole('button', { name: '发送并验证', exact: true }).click();
    await f.page.getByText('样例短信已排队', { exact: true }).waitFor();
    assert.equal(await toggle.isDisabled(), true);
    f.deliver();
    await f.page
      .getByText('测试短信已送达，PDF 可直接打开。现在可以开启发票短信通知。', { exact: true })
      .waitFor();
    assert.equal(await toggle.isEnabled(), true);
    await toggle.check();
    await f.page.getByRole('button', { name: '保存短信配置', exact: true }).click();
    await f.page.getByRole('button', { name: '保存中…', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await f.page.locator('.settings-inline-error').count(), 0);
    assert.equal(f.calls.at(-1).templates.invoiceReady.enabled, true);
    await row.scrollIntoViewIfNeeded();
    await f.page.screenshot({ path: `${artifacts}/invoice-sms-settings.png` });
    assert.deepEqual(f.errors, []);
  } finally {
    await writeFile(
      `${artifacts}/case-${f.number}.txt`,
      JSON.stringify({ errors: f.errors, body: await f.page.locator('body').innerText() }),
    );
    await f.page.screenshot({ path: `${artifacts}/case-${f.number}.png` });
    await f.context.close();
  }
});
test('unsaved form edits after a test have an explicit reload path', async () => {
  const f = await fixture();
  try {
    await f.page.locator('#sms-template-invoiceReady').fill('SMS_INVOICE');
    await f.page.getByRole('button', { name: '保存短信配置', exact: true }).click();
    await f.page.getByLabel('测试场景', { exact: true }).selectOption('invoiceReady');
    await f.page.getByLabel('接收手机号', { exact: true }).fill('13800138000');
    await f.page.getByLabel('我确认将向上述手机号发送真实短信，并可能产生费用。').check();
    await f.page.getByRole('button', { name: '发送并验证', exact: true }).click();
    await f.page.getByText('样例短信已排队', { exact: true }).waitFor();
    await f.page.locator('#sms-template-customerOtp').fill('SMS_EDITED');
    f.deliver();
    await f.page.getByRole('button', { name: '放弃未保存修改并重新载入', exact: true }).click();
    assert.equal(await f.page.locator('#sms-template-customerOtp').inputValue(), 'SMS_OTP');
    assert.deepEqual(f.errors, []);
  } finally {
    await writeFile(
      `${artifacts}/case-${f.number}.txt`,
      JSON.stringify({ errors: f.errors, body: await f.page.locator('body').innerText() }),
    );
    await f.page.screenshot({ path: `${artifacts}/case-${f.number}.png` });
    await f.context.close();
  }
});

test('invoice details expose SMS resend and reasoned revocation with the current version', async () => {
  const f = await fixture();
  try {
    const id = '22222222-2222-4222-8222-222222222222',
      now = new Date().toISOString(),
      calls = [];
    const invoice = {
      id,
      requestNo: 'INV-TEST',
      organizationId: DEMO_EVENT.organizationId,
      eventId: DEMO_EVENT.id,
      eventName: DEMO_EVENT.name,
      orderId: '33333333-3333-4333-8333-333333333333',
      orderNo: 'ORDER-TEST',
      registrationId: null,
      attendeeName: '购票人',
      status: 'issued',
      buyerType: 'enterprise',
      title: '测试企业',
      taxId: 'TEST',
      email: '',
      mobile: '',
      content: '会议费',
      amount: 10000,
      netPaidAmount: 10000,
      currency: 'CNY',
      deliveryStatus: 'sent',
      lastSentAt: now,
      requestedAt: now,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
      documents: [],
      logs: [],
      smsNotification: {
        enabled: true,
        status: 'delivered',
        reason: null,
        maskedRecipient: '138****8000',
        nextMaskedRecipient: '139****9000',
        recipientSource: 'legacy_registration',
        deliveryId: 'delivery-test',
        queuedAt: now,
        attemptedAt: now,
        sentAt: now,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        canSend: true,
        canForceSend: false,
        canRevoke: true,
        retryAfterSeconds: 0,
      },
    };
    await f.context.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path.endsWith(`/invoices/${id}/send`)) {
        calls.push({ type: 'send', body: request.postDataJSON() });
        invoice.smsNotification.status = 'queued';
        invoice.smsNotification.canSend = false;
        invoice.smsNotification.maskedRecipient = '139****9000';
        invoice.smsNotification.nextMaskedRecipient = null;
        invoice.smsNotification.recipientSource = 'purchaser';
        return route.fulfill({
          json: { queued: true, alreadyQueued: false, maskedRecipient: '139****9000' },
        });
      }
      if (path.endsWith(`/invoices/${id}/revoke-access`)) {
        calls.push({ type: 'revoke', body: request.postDataJSON() });
        invoice.smsNotification.canRevoke = false;
        invoice.smsNotification.expiresAt = null;
        invoice.smsNotification.status = 'cancelled';
        invoice.smsNotification.reason = '管理员撤销了领取链接';
        return route.fulfill({ json: { queued: false } });
      }
      if (path.endsWith(`/invoices/${id}`)) return route.fulfill({ json: invoice });
      if (path.endsWith('/invoices'))
        return route.fulfill({ json: { items: [invoice], nextCursor: null } });
      if (path.endsWith(`/admin/events/${DEMO_EVENT.id}`))
        return route.fulfill({ json: DEMO_EVENT });
      return route.fallback();
    });
    await f.page.goto(`${base}/events/${DEMO_EVENT.id}/invoices/${id}`);
    const panel = f.page.getByRole('region', { name: '发票短信通知', exact: true });
    await panel.waitFor();
    await panel.getByText('接收手机：138****8000（历史报名联系人）', { exact: true }).waitFor();
    await panel
      .getByText('当前接收手机号已更新，下次补发将发送至 139****9000。', { exact: true })
      .waitFor();
    await panel.getByRole('button', { name: '补发发票短信', exact: true }).click();
    await panel.getByText('发票短信通知 · 等待发送', { exact: true }).waitFor();
    await panel.getByText('接收手机：139****9000（购票人）', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '撤销领取链接', exact: true }).click();
    assert.equal(
      await panel.getByRole('button', { name: '确认撤销', exact: true }).isDisabled(),
      true,
    );
    await panel.getByLabel('操作原因（至少 4 个字）', { exact: true }).fill('重新确认发票文件');
    await panel.getByRole('button', { name: '确认撤销', exact: true }).click();
    await panel.getByText('管理员撤销了领取链接', { exact: true }).waitFor();
    assert.deepEqual(calls, [
      { type: 'send', body: {} },
      {
        type: 'revoke',
        body: { expectedUpdatedAt: now, reason: '重新确认发票文件', resend: false },
      },
    ]);
    await panel.scrollIntoViewIfNeeded();
    await f.page.screenshot({ path: `${artifacts}/invoice-sms-details.png` });
    assert.deepEqual(f.errors, []);
  } finally {
    await writeFile(
      `${artifacts}/case-${f.number}.txt`,
      JSON.stringify({ errors: f.errors, body: await f.page.locator('body').innerText() }),
    );
    await f.page.screenshot({ path: `${artifacts}/case-${f.number}.png` });
    await f.context.close();
  }
});

for (const width of [1280, 375, 320]) {
  test(`SMS test is discoverable and sends the selected saved template at ${width}px`, async () => {
    const f = await fixture({ width });
    try {
      const phone = f.page.getByLabel('接收手机号', { exact: true });
      const send = f.page.getByRole('button', { name: '发送并验证', exact: true });
      const confirm = f.page.getByLabel('我确认将向上述手机号发送真实短信，并可能产生费用。');
      const geometry = await f.page.evaluate(() => ({
        test: document.querySelector('#sms-test').getBoundingClientRect().top,
        account: document.querySelector('#sms-account').getBoundingClientRect().top,
        width: document.documentElement.scrollWidth,
      }));
      assert(geometry.test < geometry.account, 'Test entry precedes the long configuration form');
      assert(geometry.width <= width, 'Page fits the viewport');
      await phone.fill('123');
      await confirm.check();
      assert.equal(await phone.getAttribute('aria-invalid'), 'true');
      assert.equal(await send.isDisabled(), true);
      await phone.fill('+8613800138000');
      assert.equal(
        await confirm.isChecked(),
        false,
        'Changing recipient requires a fresh confirmation',
      );
      await f.page.getByLabel('测试场景', { exact: true }).selectOption('registrationSubmitted');
      await f.page
        .getByText('请先填写并保存「报名已提交」的模板 CODE。', { exact: true })
        .waitFor();
      assert.equal(await send.isDisabled(), true);
      await f.page.getByRole('button', { name: '测试登录验证码模板', exact: true }).click();
      assert.equal(
        await f.page.getByLabel('测试场景', { exact: true }).inputValue(),
        'customerOtp',
      );
      assert.equal(await phone.evaluate((el) => document.activeElement === el), true);
      await confirm.check();
      await send.click();
      await f.page
        .locator('.sms-test-result')
        .getByText('短信平台已受理', { exact: true })
        .waitFor();
      await f.page
        .locator('.sms-test-result')
        .getByText('TEST-BIZ-1001', { exact: true })
        .waitFor();
      assert.deepEqual(
        f.testCalls.map((x) => x.body),
        [{ phoneNumber: '+8613800138000', templateKey: 'customerOtp' }],
      );
      assert.match(f.testCalls[0].key, /^aliyun-sms-test-/);
      assert.deepEqual(f.calls, [], 'Testing must not overwrite configuration');
      assert.equal(await confirm.isChecked(), false);
      await phone.scrollIntoViewIfNeeded();
      await f.page.screenshot({ path: `${artifacts}/sms-test-${width}.png` });
      await f.page.locator('#sms-sign-name').fill('未保存签名');
      await f.page
        .getByText('当前有未保存修改，请先保存配置再发送测试短信。', { exact: true })
        .waitFor();
      assert.equal(await send.isDisabled(), true);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}

for (const scenario of [
  { testFailure: true, expected: 'isv.SMS_SIGNATURE_ILLEGAL · 签名未通过审核' },
  { requestFailure: true, expected: '测试短信发送过于频繁，请稍后再试' },
  { refreshFailure: true, expected: '测试已提交，配置状态刷新失败。请重新载入后查看。' },
]) {
  test(`SMS test preserves a useful result when ${scenario.testFailure ? 'provider rejects' : scenario.requestFailure ? 'request is rate limited' : 'configuration refresh fails'}`, async () => {
    const f = await fixture(scenario);
    try {
      await f.page.getByLabel('接收手机号', { exact: true }).fill('13800138000');
      await f.page.getByLabel('我确认将向上述手机号发送真实短信，并可能产生费用。').check();
      await f.page.getByRole('button', { name: '发送并验证', exact: true }).click();
      await f.page.getByText(scenario.expected, { exact: true }).waitFor();
      if (scenario.refreshFailure) {
        await f.page.getByText('TEST-BIZ-1001', { exact: true }).waitFor();
        assert.equal(
          await f.page.getByRole('button', { name: '发送并验证', exact: true }).isDisabled(),
          true,
        );
      }
      assert.equal(f.testCalls.length, 1);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}

for (const scenario of [
  { canManage: false, expected: '当前账号没有短信设置管理权限。' },
  { configured: false, expected: '请先在下方保存短信账号与签名，并配置要测试的模板 CODE。' },
]) {
  test(`SMS test explains missing ${scenario.canManage === false ? 'permission' : 'credentials'}`, async () => {
    const f = await fixture(scenario);
    try {
      await f.page.getByText(scenario.expected, { exact: true }).waitFor();
      assert.equal(
        await f.page.getByRole('button', { name: '发送并验证', exact: true }).isDisabled(),
        true,
      );
      assert.deepEqual(f.testCalls, []);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}
