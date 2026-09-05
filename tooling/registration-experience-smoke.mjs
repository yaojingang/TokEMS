import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { DEMO_EVENT } from '../packages/contracts/dist/index.js';

// All API responses are fixtures; this suite never creates real registrations or payments.
const base = process.env.WEB_BASE_URL ?? 'http://localhost:8088';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
  throw new Error('Registration browser checks require a local application');
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());

async function fixture(options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const event = structuredClone(DEMO_EVENT);
  event.registrationForm.fields.forEach((field) => {
    field.enabled = true;
    field.required = field.key === 'mobile';
  });
  const session = {
    authenticated: true,
    csrfToken: 'registration-browser-fixture',
    customer: {
      id: 12345,
      organizationId: event.organizationId,
      mobile: '+8613800138000',
      maskedMobile: '138****8000',
      profile: {
        realName: '测试姓名',
        nickname: '测试昵称',
        email: 'profile@example.com',
        company: '测试公司',
        title: '测试职位',
        city: '深圳',
        version: 1,
      },
    },
  };
  const submissions = [];
  const errors = [];
  let signedIn = options.signedIn !== false;
  let eventRequests = 0;
  let sessionGate;
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/customer-auth/session')) {
      if (sessionGate) await sessionGate;
      return route.fulfill({ json: signedIn ? session : { authenticated: false } });
    }
    if (path.endsWith('/customer-auth/otp'))
      return route.fulfill({
        json: {
          challengeId: 'fixture-challenge',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          retryAfterSeconds: 60,
        },
      });
    if (path.endsWith('/customer-auth/verify')) {
      signedIn = true;
      return route.fulfill({ json: session });
    }
    if (path.endsWith(`/events/${event.slug}`) || path.endsWith('/homepage')) {
      eventRequests += 1;
      if (options.eventGate) await options.eventGate;
      return route.fulfill({ json: event });
    }
    if (path.endsWith('/purchase-context')) {
      return route.fulfill({
        json: {
          eventId: event.id,
          additionalPurchaseEnabled: false,
          maxActiveSeatsPerPurchaser: 1,
          activeSeatCount: 0,
          remainingSeatCount: 1,
          canPurchaseAdditional: false,
          myAttendance: null,
          selfRegistrationState: 'none',
          myPurchases: { paidCount: 0, pendingCount: 0, activeSeatCount: 0 },
          resumePaymentOrderId: null,
          recommendedActions: ['register_self'],
        },
      });
    }
    if (path.endsWith('/registrations') && route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ status: 422, json: { message: 'Fixture submission recorded' } });
    }
    // Unneeded APIs are isolated too, including account reads after leaving registration.
    return route.fulfill({ status: 404, json: { message: 'Fixture API not configured' } });
  });
  if (options.storageFailure) {
    await page.addInitScript((mode) => {
      const originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (mode === 'denied' || key.startsWith('conference.registration')) {
          throw new DOMException('Storage fixture failure', 'QuotaExceededError');
        }
        return originalSet.call(this, key, value);
      };
      if (mode === 'denied') {
        Storage.prototype.getItem = Storage.prototype.removeItem = () => {
          const error = new Error('Storage fixture failure');
          error.name = 'SecurityError';
          throw error;
        };
      }
    }, options.storageFailure);
  }
  async function open() {
    await page.goto(`${base}/register/${event.slug}`, { waitUntil: 'domcontentloaded' });
    await page
      .locator('#registration-email')
      .waitFor()
      .catch((error) => {
        throw new Error(`${error.message}; page errors: ${errors.join('; ')}`);
      });
    await page.waitForFunction(
      () => !document.querySelector('form.flow-card button[type="submit"]')?.disabled,
    );
  }
  async function refreshEvent() {
    const response = page.waitForResponse((item) => item.url().endsWith(`/events/${event.slug}`));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await response;
    // Allow the response body and Vue's dependent watchers to settle.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  async function submit() {
    const response = page.waitForResponse(
      (item) => item.request().method() === 'POST' && item.url().endsWith('/registrations'),
    );
    await page.locator('form.flow-card button[type="submit"]').click();
    await response;
  }
  return {
    context,
    page,
    event,
    submissions,
    errors,
    open,
    refreshEvent,
    submit,
    eventRequests: () => eventRequests,
    setSessionGate: (gate) => {
      sessionGate = gate;
    },
  };
}

test('edits made while the account loads take precedence over an older saved draft', async () => {
  const f = await fixture();
  let release;
  try {
    await f.open();
    await f.page.locator('#registration-name').fill('旧草稿姓名');
    await f.page.locator('#registration-title').fill('旧草稿职位');
    await f.page.locator('#registration-company').fill('旧草稿公司');
    await f.page.waitForFunction(() =>
      Object.entries(localStorage).some(([key, value]) => {
        if (!key.startsWith('conference.registrationDraft.')) return false;
        return JSON.parse(value).answers.company === '旧草稿公司';
      }),
    );
    f.setSessionGate(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await f.page.reload({ waitUntil: 'domcontentloaded' });
    await f.page.locator('#registration-name').fill('当前输入姓名');
    await f.page.locator('#registration-title').fill('临时职位');
    await f.page.locator('#registration-title').fill('');
    assert.equal(await f.page.locator('form.flow-card button[type="submit"]').isDisabled(), true);
    assert.equal(await f.page.locator('#registration-name').inputValue(), '当前输入姓名');
    release();
    await f.page.waitForFunction(
      () => !document.querySelector('form.flow-card button[type="submit"]')?.disabled,
    );
    assert.equal(await f.page.locator('#registration-name').inputValue(), '当前输入姓名');
    assert.equal(await f.page.locator('#registration-title').inputValue(), '');
    assert.equal(await f.page.locator('#registration-company').inputValue(), '旧草稿公司');
    await f.submit();
    assert.equal(f.submissions[0].attendee.name, '当前输入姓名');
    assert.equal(f.submissions[0].attendee.title, '');
    assert.deepEqual(f.errors, []);
  } finally {
    release?.();
    await f.context.close();
  }
});

test('cleared optional profile fields survive reload and a published form update', async () => {
  const f = await fixture();
  try {
    await f.open();
    for (const key of ['name', 'email', 'title'])
      await f.page.locator(`#registration-${key}`).fill('');
    await f.page.waitForFunction(() =>
      Object.entries(localStorage).some(([key, value]) => {
        if (!key.startsWith('conference.registrationDraft.')) return false;
        const answers = JSON.parse(value).answers;
        return answers.name === '' && answers.email === '' && answers.title === '';
      }),
    );
    await f.page.reload({ waitUntil: 'domcontentloaded' });
    await f.page.locator('#registration-email').waitFor();
    await f.page.waitForFunction(
      () => !document.querySelector('form.flow-card button[type="submit"]')?.disabled,
    );
    for (const key of ['name', 'email', 'title'])
      assert.equal(
        await f.page.locator(`#registration-${key}`).inputValue(),
        '',
        `${key} after reload`,
      );
    f.event.registrationForm.version += 1;
    await f.refreshEvent();
    for (const key of ['name', 'email', 'title'])
      assert.equal(
        await f.page.locator(`#registration-${key}`).inputValue(),
        '',
        `${key} after form update`,
      );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('a pending registration load cannot take navigation back from the account page', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture({ eventGate: gate });
  try {
    await f.page.goto(`${base}/register/${f.event.slug}`, { waitUntil: 'domcontentloaded' });
    await f.page.getByRole('link', { name: '前往个人中心' }).click();
    await f.page.waitForURL('**/account');
    release();
    await f.page.waitForLoadState('networkidle');
    assert.equal(new URL(f.page.url()).pathname, '/account');
  } finally {
    release();
    await f.context.close();
  }
});

test('anonymous draft login prefills untouched fields and preserves explicitly cleared fields', async () => {
  const f = await fixture({ signedIn: false });
  try {
    await f.open();
    await f.page.getByRole('button', { name: '关闭登录或注册' }).click();
    await f.page.locator('#registration-name').fill('匿名填写姓名');
    await f.page.locator('#registration-title').fill('临时职位');
    await f.page.locator('#registration-title').fill('');
    await f.page.waitForFunction(() =>
      Object.entries(sessionStorage).some(
        ([key, value]) =>
          key.startsWith('conference.registrationDraft.') &&
          JSON.parse(value).answers.name === '匿名填写姓名',
      ),
    );
    await f.page.reload({ waitUntil: 'domcontentloaded' });
    const dialog = f.page.getByRole('dialog', { name: '手机号登录 / 注册' });
    await dialog.getByPlaceholder('请输入 11 位手机号').fill('13800138000');
    await dialog.getByRole('button', { name: '获取验证码', exact: true }).click();
    await f.page.getByPlaceholder('6 位验证码').fill('123456');
    await f.page.locator('.auth-consent input').check();
    await f.page.getByRole('button', { name: '验证并继续' }).click();
    await f.page.getByRole('link', { name: '前往个人中心' }).waitFor();
    assert.equal(await f.page.locator('#registration-email').inputValue(), 'profile@example.com');
    assert.equal(await f.page.locator('#registration-company').inputValue(), '测试公司');
    assert.equal(await f.page.locator('#registration-title').inputValue(), '');
    assert.equal(await f.page.locator('#registration-name').inputValue(), '匿名填写姓名');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

for (const storageFailure of ['quota', 'denied']) {
  test(`registration keeps its intent and draft through event refresh with ${storageFailure} storage`, async () => {
    const f = await fixture({ storageFailure });
    try {
      await f.open();
      await f.page.locator('#registration-name').fill('当前填写姓名');
      await f.page.locator('#registration-email').fill('');
      await f.submit();
      assert.equal(f.submissions.length, 1);
      await f.refreshEvent();
      await f.submit();
      assert.equal(f.submissions.length, 2);
      assert.equal(f.submissions[1].purchaseIntentId, f.submissions[0].purchaseIntentId);
      assert.equal(f.submissions[1].attendee.name, '当前填写姓名');
      assert.equal(f.submissions[1].attendee.email, '');
      assert.deepEqual(f.errors, []);
    } finally {
      await f.context.close();
    }
  });
}
