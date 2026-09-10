import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import {
  DEMO_EVENT,
  UpdatePurchasedOrderAttendeeSchema,
} from '../packages/contracts/dist/index.js';

// All API traffic is intercepted. This suite never creates real orders or payments.
const base = process.env.WEB_BASE_URL ?? 'http://localhost:3095';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
  throw new Error('Batch browser tests require a local preview');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());
const screenshots = process.env.BATCH_SCREENSHOT_DIR ?? '/tmp/tokems-batch-ui';
await mkdir(screenshots, { recursive: true });
const orderId = '14113e61-9b12-4c0a-a481-c48e6b9adfe2';
const id = (index) => `35567ec2-1a95-4d7b-aa36-${String(index).padStart(12, '0')}`;

async function fixture(options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const event = structuredClone(DEMO_EVENT);
  event.status = 'registration_open';
  event.registration.registrationOpen = true;
  event.registration.additionalPurchaseEnabled = true;
  event.registration.maxActiveSeatsPerPurchaser = 5;
  event.tickets = [event.tickets[0]];
  event.tickets[0].price = options.free ? 0 : 39_900;
  event.tickets[0].remaining = 30;
  for (const field of event.registrationForm.fields) {
    field.enabled = true;
    field.required = ['name', 'mobile'].includes(field.key);
  }
  event.registrationForm.fields.push(...(options.extraFields ?? []));
  const session = {
    authenticated: true,
    csrfToken: 'batch-browser-csrf',
    customer: {
      id: 12345,
      organizationId: event.organizationId,
      mobile: '+8613800138000',
      maskedMobile: '138****8000',
      profile: {
        realName: '郝明辰',
        nickname: '',
        email: 'buyer@example.com',
        company: '移山科技',
        title: '运营负责人',
        city: '深圳',
        version: 1,
      },
    },
  };
  const submissions = [];
  const mutations = [];
  const errors = [];
  let signedIn = options.signedIn !== false;
  let unitPrice = event.tickets[0].price;
  let latestDraft;
  let detail = makeDetail(options.people ?? 5);
  let refundContext = makeRefund();
  if (options.storageFailure)
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('conference.batch'))
          throw new DOMException('Fixture quota failure', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
  function makeDetail(count) {
    const createdAt = new Date().toISOString();
    return {
      eventId: event.id,
      eventName: event.name,
      eventSlug: event.slug,
      order: {
        id: orderId,
        orderNo: 'TOK20260910BATCH001',
        registrationId: null,
        modelVersion: 2,
        quantity: count,
        version: 1,
        status: options.pending ? 'pending_payment' : 'paid',
        amount: count * unitPrice,
        currency: 'CNY',
        paymentMethod: options.free ? 'free' : 'wechat',
        createdAt,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
      items: Array.from({ length: count }, (_, index) => ({
        id: id(index + 1),
        registrationId: id(index + 101),
        clientId: id(index + 201),
        position: index + 1,
        state: options.pending ? 'pending' : 'active',
        version: 1,
        allocatedAmount: unitPrice,
        unitPrice,
        refundedAmount: 0,
        isSelf: index === 0,
        attendeeClaimed: index === 0,
        registration: {
          id: id(index + 101),
          eventId: event.id,
          registrationCode: `TOKR-${index}`,
          status: options.pending ? 'pending_payment' : 'confirmed',
          attendee: {
            name: ['郝明辰', '陆苇宁', '程沛然', '唐文竹', '林远澄'][index],
            mobile: `1380013800${index}`,
            email: `attendee${index}@example.com`,
            company: '移山科技',
            title: '市场负责人',
            city: '深圳',
          },
          ticketType: event.tickets[0],
          createdAt,
        },
        registrationEditVersion: 'a'.repeat(64),
        registrationFields: event.registrationForm.fields,
        registrationEditFields: event.registrationForm.fields.filter(
          (field) => field.key !== 'mobile',
        ),
        ticketStatus: options.pending ? null : 'valid',
        canEditAttendee: options.pending || index > 0,
        canGenerateInvitation: !options.pending && index > 0,
        canCancelFree: Boolean(options.free),
        unavailableReason: null,
      })),
      myRegistrationId: id(101),
      nextAction: options.pending ? 'payment' : 'complete',
      isProxyPurchase: true,
      canCancel: Boolean(options.pending),
      refundedAmount: 0,
      invoiceId: null,
    };
  }
  function makeRefund() {
    return {
      quantity: detail.items.length,
      contextVersion: 'refund-context-v1',
      items: detail.items.map((item) => ({
        id: item.id,
        registrationId: item.registrationId,
        name: item.registration.attendee.name,
        ticketName: event.tickets[0].name,
        refundableAmount: unitPrice,
        eligible: true,
        blockedReason: null,
        version: item.version,
      })),
      orderId,
      orderNo: detail.order.orderNo,
      eventId: event.id,
      eventName: event.name,
      ticketName: event.tickets[0].name,
      attendeeName: '郝明辰等5位',
      paymentMethod: 'wechat',
      paidAmount: detail.order.amount,
      payerTotal: detail.order.amount,
      refundedAmount: 0,
      refundableAmount: detail.order.amount,
      currency: 'CNY',
      eligible: true,
      blockedReason: null,
      policyVersion: 'seven-day-v1',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      applications: [],
    };
  }
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/customer-auth/session'))
      return route.fulfill({ json: signedIn ? session : { authenticated: false } });
    if (path.endsWith('/customer-auth/otp'))
      return route.fulfill({
        json: {
          challengeId: 'batch-otp',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          retryAfterSeconds: 60,
        },
      });
    if (path.endsWith('/customer-auth/verify')) {
      signedIn = true;
      return route.fulfill({ json: session });
    }
    if (path.endsWith(`/events/${event.slug}`) || path.endsWith('/homepage'))
      return route.fulfill({ json: event });
    if (path.endsWith('/site-config'))
      return route.fulfill({
        json: {
          website: { siteName: event.name },
          analytics: { enabled: false },
          customerAccounts: {
            termsUrl: '/terms',
            termsVersion: 'v1',
            privacyUrl: '/privacy',
            privacyVersion: 'v1',
          },
        },
      });
    if (path.endsWith('/purchase-context'))
      return route.fulfill({
        json: {
          eventId: event.id,
          additionalPurchaseEnabled: event.registration.additionalPurchaseEnabled,
          maxActiveSeatsPerPurchaser: 5,
          activeSeatCount: 0,
          remainingSeatCount: 5,
          canPurchaseAdditional: true,
          myAttendance: null,
          selfRegistrationState: 'none',
          myPurchases: { paidCount: 0, pendingCount: 0, activeSeatCount: 0 },
          resumePaymentOrderId: null,
          recommendedActions: ['register_self', 'purchase_additional'],
        },
      });
    if (path.endsWith('/registration-batches/quote')) {
      if (!signedIn) return route.fulfill({ status: 401, json: { message: '请重新登录' } });
      const input = request.postDataJSON();
      return route.fulfill({
        json: {
          ...input,
          ticketTypeName: event.tickets[0].name,
          unitPrice,
          amount: unitPrice * input.quantity,
          currency: 'CNY',
          availableQuantity: 30,
          activeSeatCount: 0,
          remainingSeatCount: 5,
          maxActiveSeatsPerPurchaser: 5,
          additionalPurchaseEnabled: event.registration.additionalPurchaseEnabled,
          manualReview: Boolean(options.manualReview),
          formVersion: event.registrationForm.version,
          termsVersion: event.registrationForm.termsVersion,
          quoteFingerprint: unitPrice.toString(16).padStart(64, '0'),
          blockedReason: null,
          pendingOrderId: null,
        },
      });
    }
    if (path.endsWith('/registration-batches') && request.method() === 'POST') {
      submissions.push({ body: request.postDataJSON(), headers: request.headers() });
      latestDraft = request.postDataJSON();
      if (options.fieldIssue)
        return route.fulfill({
          status: 400,
          json: {
            message: '请检查每位参会人的报名信息',
            details: {
              issues: [
                { path: ['attendees', 1, 'formAnswers', 'company'], message: '公司信息需要更新' },
              ],
            },
          },
        });
      if (!options.success)
        return route.fulfill({ status: 422, json: { message: '已记录模拟报名请求' } });
      detail = makeDetail(latestDraft.quantity);
      return route.fulfill({ json: detail });
    }
    if (path.endsWith(`/customer/orders/${orderId}`)) return route.fulfill({ json: detail });
    if (path.endsWith('/refund-context')) return route.fulfill({ json: refundContext });
    if (path.endsWith('/refund-requests') && request.method() === 'POST') {
      const body = request.postDataJSON();
      mutations.push({ kind: 'refund', body, headers: request.headers() });
      const application = {
        selectedItemIds: body.selectedItemIds,
        id: id(999),
        orderId,
        eventId: event.id,
        amount: body.selectedItemIds.length * unitPrice,
        completedAmount: 0,
        currency: 'CNY',
        reviewStatus: 'pending_review',
        fulfillmentStatus: 'open',
        executionStatus: null,
        reason: body.reason,
        reviewReason: null,
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        completedAt: null,
        version: 1,
        fullRefund: false,
        payerTotal: detail.order.amount,
        payerRefund: null,
        discountRefund: null,
      };
      refundContext = { ...refundContext, eligible: false, applications: [application] };
      return route.fulfill({ json: application });
    }
    if (path.endsWith('/items/cancel-free')) {
      const body = request.postDataJSON();
      mutations.push({ kind: 'free', body });
      detail = {
        ...detail,
        order: { ...detail.order, version: 2 },
        items: detail.items.map((item) =>
          body.items.some((selected) => selected.id === item.id)
            ? {
                ...item,
                state: 'cancelled',
                ticketStatus: 'cancelled',
                canCancelFree: false,
                canGenerateInvitation: false,
                canEditAttendee: false,
              }
            : item,
        ),
      };
      return route.fulfill({ json: detail });
    }
    if (path.endsWith('/attendee') && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      assert.equal(UpdatePurchasedOrderAttendeeSchema.safeParse(body).success, true);
      const itemId = path.split('/').at(-2);
      const previousEdits = mutations.filter((mutation) => mutation.kind === 'edit').length;
      mutations.push({ kind: 'edit', body, itemId, headers: request.headers() });
      if (options.editCsrf && previousEdits === 0) {
        session.csrfToken = 'batch-renewed-csrf';
        return route.fulfill({
          status: 403,
          json: { message: '请刷新登录验证后重试', details: { reason: 'customer_csrf_invalid' } },
        });
      }
      if (options.editConflict && previousEdits === 0) {
        detail = {
          ...detail,
          items: detail.items.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  version: 2,
                  registrationEditVersion: 'b'.repeat(64),
                  registration: {
                    ...item.registration,
                    attendee: {
                      ...item.registration.attendee,
                      name: '另一处已改姓名',
                      company: '新公司',
                    },
                  },
                }
              : item,
          ),
        };
        return route.fulfill({ status: 409, json: { message: '资料已更新，请重新核对' } });
      }
      const patch = Object.fromEntries(
        Object.entries(body).filter(([key]) =>
          ['name', 'mobile', 'email', 'company', 'title', 'city'].includes(key),
        ),
      );
      detail = {
        ...detail,
        order: { ...detail.order, version: detail.order.version + 1 },
        items: detail.items.map((item) =>
          item.id === itemId
            ? {
                ...item,
                version: item.version + 1,
                registration: {
                  ...item.registration,
                  attendee: { ...item.registration.attendee, ...patch },
                },
              }
            : item,
        ),
      };
      return route.fulfill({ json: detail });
    }
    if (path.endsWith('/claim-invitation')) {
      const body = request.postDataJSON();
      const itemId = path.split('/').at(-2);
      mutations.push({ kind: 'invitation', body, headers: request.headers() });
      return route.fulfill({
        json: {
          itemId,
          version: 2,
          claimUrl: `/account/attendee-claim#registration=${id(102)}&claim=${'browser-test-secret-'.repeat(3)}`,
          expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          replayAvailable: true,
        },
      });
    }
    if (path.endsWith('/cancel')) {
      mutations.push({ kind: 'cancel', body: request.postDataJSON() });
      detail = {
        ...detail,
        nextAction: 'closed',
        canCancel: false,
        order: { ...detail.order, status: 'closed', version: 2 },
        items: detail.items.map((item) => ({
          ...item,
          state: 'cancelled',
          canEditAttendee: false,
        })),
      };
      return route.fulfill({ json: detail });
    }
    return route.fulfill({ status: 404, json: { message: 'Unconfigured fixture API' } });
  });
  async function open(path = `/register/${event.slug}`) {
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page
      .locator(path.includes('/register') ? '#batch-quantity' : '#order-attendees-title')
      .waitFor();
    if (path.includes('/register'))
      await page.waitForFunction(() => document.querySelectorAll('.attendee-card').length === 1);
  }
  async function fill(count) {
    if (count !== 1) await page.getByRole('button', { name: `${count} 位`, exact: true }).click();
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.attendee-card').length === expected,
      count,
    );
    for (let index = 0; index < count; index += 1) {
      const card = page.locator('.attendee-card').nth(index);
      await card
        .locator('input[id$="-name"]')
        .fill(['郝明辰', '陆苇宁', '程沛然', '唐文竹', '林远澄'][index]);
      if (index > 0) await card.locator('input[id$="-mobile"]').fill(`1380013800${index}`);
    }
  }
  return {
    context,
    page,
    event,
    session,
    errors,
    submissions,
    mutations,
    open,
    fill,
    setPrice: (price) => {
      unitPrice = price;
    },
    getDetail: () => detail,
    expireSession: () => {
      signedIn = false;
    },
  };
}

test('default terms can be unchecked to block a five-person order while preserving attendee IDs', async () => {
  const f = await fixture();
  try {
    await f.open();
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), true);
    await f.fill(5);
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), true);
    assert.match(await f.page.locator('.batch-submit').innerText(), /1,995/);
    await f.page.locator('#batch-terms-accepted').uncheck();
    await f.page.locator('.batch-submit button').click();
    await f.page.getByRole('alert').filter({ hasText: '请阅读并同意报名条款后继续' }).waitFor();
    assert.equal(f.submissions.length, 0);
    await f.page.locator('#batch-terms-accepted').check();
    await f.page.locator('.batch-submit button').click();
    await f.page.getByRole('alert').filter({ hasText: '已记录模拟报名请求' }).waitFor();
    assert.equal(f.submissions.length, 1);
    const { body, headers } = f.submissions[0];
    assert.equal(body.quantity, 5);
    assert.equal(body.attendees.length, 5);
    assert.equal(new Set(body.attendees.map((item) => item.clientId)).size, 5);
    assert.equal(body.attendees.filter((item) => item.isSelf).length, 1);
    assert.equal(body.proxyAuthorizationAccepted, true);
    assert.ok(body.attendees.every((item) => item.marketingConsent === false));
    assert.equal(headers['x-csrf-token'], 'batch-browser-csrf');
    assert.deepEqual(f.errors, []);
    await f.page.screenshot({
      path: `${screenshots}/batch-registration-desktop.png`,
      fullPage: true,
    });
  } finally {
    await f.context.close();
  }
});

test('decreasing five filled cards lets the buyer choose people and undo without identity mixing', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.fill(5);
    const ids = await f.page
      .locator('.attendee-card')
      .evaluateAll((cards) => cards.map((card) => card.dataset.cardId));
    await f.page.getByRole('button', { name: '3 位', exact: true }).click();
    await f.page.locator('.remove-selection label').nth(3).locator('input').check();
    await f.page.locator('.remove-selection label').nth(4).locator('input').check();
    await f.page.getByRole('button', { name: '确认移除 2 位', exact: true }).click();
    assert.equal(await f.page.locator('.attendee-card').count(), 3);
    assert.match(await f.page.locator('.batch-submit').innerText(), /1,197/);
    await f.page.getByRole('button', { name: '撤销移除' }).click();
    assert.deepEqual(
      await f.page
        .locator('.attendee-card')
        .evaluateAll((cards) => cards.map((card) => card.dataset.cardId)),
      ids,
    );
    assert.equal(
      await f.page.locator('.attendee-card').nth(4).locator('input[id$="-name"]').inputValue(),
      '林远澄',
    );
  } finally {
    await f.context.close();
  }
});

test('duplicate normalized mobiles block the whole order and focus the affected person', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.fill(2);
    await f.page
      .locator('.attendee-card')
      .nth(1)
      .locator('input[id$="-mobile"]')
      .fill('+86 13800138000');
    await f.page.locator('#batch-terms-accepted').check();
    await f.page.locator('.batch-submit button').click();
    await f.page.getByRole('alert').filter({ hasText: '请完善标记' }).waitFor();
    assert.equal(f.submissions.length, 0);
    assert.equal(await f.page.evaluate(() => document.activeElement?.id.endsWith('-mobile')), true);
  } finally {
    await f.context.close();
  }
});

test('a price update requires explicit fresh confirmation and preserves attendee details', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.fill(2);
    await f.page.waitForFunction(
      () => !document.querySelector('.batch-summary')?.textContent.includes('正在核对'),
    );
    f.setPrice(49_900);
    await f.page.locator('#batch-terms-accepted').check();
    await f.page.locator('.batch-submit button').click();
    await f.page.getByRole('button', { name: '我已核对当前金额和报名规则' }).waitFor();
    assert.equal(f.submissions.length, 0);
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), false);
    assert.equal(
      await f.page.locator('.attendee-card').nth(1).locator('input[id$="-name"]').inputValue(),
      '陆苇宁',
    );
    assert.match(await f.page.locator('.batch-submit').innerText(), /998/);
  } finally {
    await f.context.close();
  }
});

test('five-person draft restores after refresh with terms checked by default', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.fill(5);
    await f.page.locator('#batch-terms-accepted').check();
    await f.page.waitForFunction(() =>
      Object.keys(localStorage).some(
        (key) =>
          key.startsWith('conference.batchRegistrationDraft.') &&
          JSON.parse(localStorage.getItem(key)).cards.length === 5,
      ),
    );
    const ids = await f.page
      .locator('.attendee-card')
      .evaluateAll((cards) => cards.map((card) => card.dataset.cardId));
    await f.page.reload({ waitUntil: 'domcontentloaded' });
    await f.page.waitForFunction(() => document.querySelectorAll('.attendee-card').length === 5);
    assert.deepEqual(
      await f.page
        .locator('.attendee-card')
        .evaluateAll((cards) => cards.map((card) => card.dataset.cardId)),
      ids,
    );
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), true);
    assert.equal(
      await f.page.locator('.attendee-card').nth(4).locator('input[id$="-name"]').inputValue(),
      '林远澄',
    );
  } finally {
    await f.context.close();
  }
});

test('mobile form keeps five attendees and payment controls within 375px', async () => {
  const f = await fixture({ width: 375 });
  try {
    await f.open();
    await f.fill(5);
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), true);
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await f.page.screenshot({
      path: `${screenshots}/batch-registration-mobile.png`,
      fullPage: true,
    });
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('the purchaser can refund two of five items with the server context version', async () => {
  const f = await fixture();
  try {
    await f.open(`/account/orders/${orderId}`);
    await f.page.locator('.refund-selection > label').nth(1).locator('input').check();
    await f.page.locator('.refund-selection > label').nth(2).locator('input').check();
    await f.page.locator('.refund-ack input').check();
    await f.page.getByRole('button', { name: '提交 ¥798 退款申请', exact: true }).click();
    await f.page.getByRole('heading', { name: '等待退款审核' }).waitFor();
    const mutation = f.mutations.find((item) => item.kind === 'refund');
    assert.deepEqual(mutation.body.selectedItemIds, [id(2), id(3)]);
    assert.equal(mutation.body.contextVersion, 'refund-context-v1');
    assert.equal(mutation.body.amount, undefined);
    assert.equal(await f.page.locator('.order-person').count(), 5);
    await f.page.screenshot({ path: `${screenshots}/batch-order-desktop.png`, fullPage: true });
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('free cancellation selects only one item and leaves four names active', async () => {
  const f = await fixture({ free: true, width: 375 });
  try {
    f.page.on('dialog', (dialog) => dialog.accept());
    await f.open(`/account/orders/${orderId}`);
    await f.page.locator('.select-seat input').nth(1).check();
    await f.page.getByRole('button', { name: '取消所选 1 位免费名额', exact: true }).click();
    await f.page.getByText('当前有效 4 位，已取消 1 位。').waitFor();
    const mutation = f.mutations.find((item) => item.kind === 'free');
    assert.deepEqual(mutation.body.items, [{ id: id(2), version: 1 }]);
    assert.equal(mutation.body.expectedVersion, 1);
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await f.page.screenshot({ path: `${screenshots}/batch-order-mobile.png`, fullPage: true });
  } finally {
    await f.context.close();
  }
});

test('claim invitation remains in memory and never appears in storage or the address bar', async () => {
  const f = await fixture();
  try {
    f.page.on('dialog', (dialog) => dialog.accept());
    await f.open(`/account/orders/${orderId}`);
    await f.page.getByRole('button', { name: '重新生成认领链接', exact: true }).first().click();
    await f.page.locator('.invitation-result input').waitFor();
    assert.match(
      await f.page.locator('.invitation-result input').inputValue(),
      /#registration=.*&claim=/,
    );
    assert.equal(
      await f.page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          href: location.href,
        }).includes('browser-test-secret'),
      ),
      false,
    );
    assert.equal(
      f.mutations.find((item) => item.kind === 'invitation').headers['x-csrf-token'],
      'batch-browser-csrf',
    );
  } finally {
    await f.context.close();
  }
});

test('closing a pending order carries five people into a new purchase intent', async () => {
  const f = await fixture({ pending: true });
  try {
    f.page.on('dialog', (dialog) => dialog.accept());
    await f.open(`/account/orders/${orderId}`);
    await f.page.getByRole('button', { name: '取消原单并调整人数', exact: true }).click();
    await f.page.waitForURL(`**/register/${f.event.slug}*`);
    await f.page.waitForFunction(() => document.querySelectorAll('.attendee-card').length === 5);
    assert.equal(f.mutations.filter((item) => item.kind === 'cancel').length, 1);
    assert.equal(
      await f.page.locator('.attendee-card').nth(4).locator('input[id$="-name"]').inputValue(),
      '林远澄',
    );
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), true);
  } finally {
    await f.context.close();
  }
});

test('anonymous edits survive mobile login without copying another customer draft', async () => {
  const f = await fixture({ signedIn: false });
  try {
    await f.open();
    await f.page.getByRole('button', { name: '关闭登录或注册' }).click();
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), true);
    await f.page.locator('#batch-terms-accepted').uncheck();
    await f.page.getByRole('button', { name: '2 位', exact: true }).click();
    await f.page
      .locator('.attendee-card')
      .first()
      .locator('input[id$="-name"]')
      .fill('保留本人草稿');
    await f.page
      .locator('.attendee-card')
      .nth(1)
      .locator('input[id$="-name"]')
      .fill('保留代购草稿');
    await f.page
      .locator('.attendee-card')
      .nth(1)
      .locator('input[id$="-mobile"]')
      .fill('13800138001');
    const ids = await f.page
      .locator('.attendee-card')
      .evaluateAll((cards) => cards.map((card) => card.dataset.cardId));
    await f.page.locator('.batch-auth button').click();
    await f.page.getByPlaceholder('请输入 11 位手机号').fill('13800138000');
    await f.page.getByRole('button', { name: '获取验证码', exact: true }).click();
    await f.page.getByPlaceholder('6 位验证码').fill('123456');
    await f.page.locator('.auth-consent input').check();
    await f.page.getByRole('button', { name: '验证并继续', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('.auth-dialog'));
    assert.deepEqual(
      await f.page
        .locator('.attendee-card')
        .evaluateAll((cards) => cards.map((card) => card.dataset.cardId)),
      ids,
    );
    assert.equal(
      await f.page.locator('.attendee-card').first().locator('input[id$="-name"]').inputValue(),
      '保留本人草稿',
    );
    assert.equal(
      await f.page.locator('.attendee-card').first().locator('input[id$="-mobile"]').inputValue(),
      '+8613800138000',
    );
    assert.equal(
      await f.page.locator('.attendee-card').nth(1).locator('input[id$="-name"]').inputValue(),
      '保留代购草稿',
    );
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), false);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('restricted browser storage keeps the current form usable and warns before refresh', async () => {
  const f = await fixture({ storageFailure: true, width: 320 });
  try {
    await f.open();
    await f.fill(2);
    await f.page.getByText('浏览器暂不支持保存，刷新后将无法恢复本次填写。').waitFor();
    await f.page.locator('#batch-terms-accepted').check();
    await f.page.locator('.batch-submit button').click();
    await f.page.getByRole('alert').filter({ hasText: '已记录模拟报名请求' }).waitFor();
    assert.equal(f.submissions[0].body.quantity, 2);
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('an old one-person draft is upgraded before editing and keeps its intentional blanks', async () => {
  const f = await fixture();
  try {
    await f.page.addInitScript(
      ({ event, customer }) => {
        const intent = '3dbff3bc-1b12-4d63-b427-3b7a773c42b6';
        const owner = `customer:${customer.id}`;
        const prefix = [event.organizationId, event.id, owner, 'self']
          .map((part) => encodeURIComponent(String(part)))
          .join('.');
        sessionStorage.setItem(
          `conference.registrationIntent.${prefix}`,
          JSON.stringify({ id: intent, savedAt: Date.now() }),
        );
        localStorage.setItem(
          `conference.registrationDraft.${prefix}.${intent}.v${event.registrationForm.version}`,
          JSON.stringify({
            version: 1,
            formVersion: event.registrationForm.version,
            savedAt: Date.now(),
            answers: {
              name: '旧草稿姓名',
              email: '',
              mobile: customer.mobile,
              company: '旧草稿公司',
            },
            editedKeys: ['name', 'email', 'company'],
          }),
        );
      },
      { event: f.event, customer: f.session.customer },
    );
    await f.open();
    await f.page.waitForFunction(
      () => document.querySelector('.attendee-card input[id$="-name"]')?.value === '旧草稿姓名',
    );
    assert.equal(await f.page.locator('.attendee-card').count(), 1);
    assert.equal(await f.page.locator('input[id$="-email"]').inputValue(), '');
    assert.equal(await f.page.locator('input[id$="-company"]').inputValue(), '旧草稿公司');
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), true);
  } finally {
    await f.context.close();
  }
});

test('proxy-only purchase leaves all participant identities separate from the purchaser', async () => {
  const f = await fixture();
  try {
    await f.open(`/register/${f.event.slug}?purchaseFor=other`);
    await f.fill(3);
    await f.page
      .locator('.attendee-card')
      .first()
      .locator('input[id$="-mobile"]')
      .fill('13900139000');
    assert.equal(await f.page.locator('.batch-self input').isChecked(), false);
    await f.page.locator('#batch-terms-accepted').check();
    await f.page.locator('.batch-submit button').click();
    await f.page.getByRole('alert').filter({ hasText: '已记录模拟报名请求' }).waitFor();
    assert.equal(f.submissions[0].body.attendees.filter((item) => item.isSelf).length, 0);
    assert.ok(f.submissions[0].body.attendees.every((item) => item.marketingConsent === false));
  } finally {
    await f.context.close();
  }
});

test('company shortcut only copies the organization field', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.fill(2);
    await f.page.getByRole('button', { name: '沿用上一位的公司 / 机构' }).click();
    const card = f.page.locator('.attendee-card').nth(1);
    assert.equal(await card.locator('input[id$="-company"]').inputValue(), '移山科技');
    assert.equal(await card.locator('input[id$="-name"]').inputValue(), '陆苇宁');
    assert.equal(await card.locator('input[id$="-mobile"]').inputValue(), '13800138001');
  } finally {
    await f.context.close();
  }
});

test('closing additional purchases preserves five-person input and blocks new submission', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.fill(5);
    f.event.registration.additionalPurchaseEnabled = false;
    const refreshed = f.page.waitForResponse((response) =>
      response.url().endsWith(`/events/${f.event.slug}`),
    );
    await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await refreshed;
    await f.page
      .getByText('主办方已关闭多人和代报名。本次资料已保留，当前仅可提交本人一个名额。')
      .first()
      .waitFor();
    assert.equal(f.submissions.length, 0);
    assert.equal(await f.page.locator('.batch-submit button').isDisabled(), true);
    assert.equal(await f.page.locator('.attendee-card').count(), 5);
    assert.equal(
      await f.page.locator('.attendee-card').nth(4).locator('input[id$="-name"]').inputValue(),
      '林远澄',
    );
  } finally {
    await f.context.close();
  }
});

test('an unclaimed paid attendee is edited within its own order item', async () => {
  const f = await fixture({ width: 375 });
  try {
    await f.open(`/account/orders/${orderId}`);
    await f.page
      .locator('.order-person')
      .nth(1)
      .getByRole('button', { name: '修改参会资料', exact: true })
      .click();
    await f.page.locator('.attendee-editor input[id$="-name"]').fill('陆苇宁新资料');
    await f.page.locator('.attendee-editor input[id$="-mobile"]').fill('13900139001');
    await f.page.screenshot({
      path: `${screenshots}/batch-attendee-editor-mobile.png`,
      fullPage: true,
    });
    await f.page.getByRole('button', { name: '保存此名额资料', exact: true }).click();
    await f.page.getByRole('heading', { name: '陆苇宁新资料', exact: true }).waitFor();
    const mutation = f.mutations.find((item) => item.kind === 'edit');
    assert.equal(mutation.itemId, id(2));
    assert.equal(mutation.body.expectedVersion, 1);
    assert.equal(mutation.body.expectedRegistrationVersion, 'a'.repeat(64));
    assert.equal(mutation.body.mobile, '13900139001');
    assert.equal(mutation.body.company, undefined);
    assert.equal(f.getDetail().items[2].registration.attendee.name, '程沛然');
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('attendee edit conflict preserves untouched newer fields and requires an explicit choice', async () => {
  const f = await fixture({ editConflict: true });
  try {
    await f.open(`/account/orders/${orderId}`);
    await f.page
      .locator('.order-person')
      .nth(1)
      .getByRole('button', { name: '修改参会资料', exact: true })
      .click();
    await f.page.locator('.attendee-editor input[id$="-name"]').fill('陆苇宁本次填写');
    await f.page.getByRole('button', { name: '保存此名额资料', exact: true }).click();
    await f.page.getByRole('button', { name: '保留本次填写', exact: true }).waitFor();
    assert.equal(
      await f.page.getByRole('button', { name: '保存此名额资料', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await f.page.locator('.attendee-editor input[id$="-company"]').inputValue(),
      '新公司',
    );
    await f.page.getByRole('button', { name: '保留本次填写', exact: true }).click();
    await f.page.getByRole('button', { name: '保存此名额资料', exact: true }).click();
    await f.page.getByRole('heading', { name: '陆苇宁本次填写', exact: true }).waitFor();
    const mutations = f.mutations.filter((item) => item.kind === 'edit');
    assert.equal(mutations.length, 2);
    assert.equal(mutations[1].body.expectedVersion, 2);
    assert.equal(mutations[1].body.expectedRegistrationVersion, 'b'.repeat(64));
    assert.equal(mutations[1].body.company, undefined);
    assert.notEqual(
      mutations[0].headers['idempotency-key'],
      mutations[1].headers['idempotency-key'],
    );
    assert.equal(f.getDetail().items[1].registration.attendee.company, '新公司');
  } finally {
    await f.context.close();
  }
});

test('custom telephone accepts office numbers and core name limits stay aligned with the API', async () => {
  const f = await fixture({
    extraFields: [
      { key: 'office_phone', label: '办公电话', type: 'tel', enabled: true, required: true },
    ],
  });
  try {
    await f.open();
    await f.fill(2);
    for (const input of await f.page.locator('input[id$="-office_phone"]').all())
      await input.fill('010-88888888');
    const name = f.page.locator('.attendee-card').nth(1).locator('input[id$="-name"]');
    assert.equal(await name.getAttribute('maxlength'), '80');
    await name.evaluate((input) => {
      input.value = '名'.repeat(81);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await f.page.locator('#batch-terms-accepted').check();
    await f.page.locator('.batch-submit button').click();
    await f.page.getByText('姓名最多填写 80 个字符', { exact: true }).waitFor();
    assert.equal(f.submissions.length, 0);
    assert.equal(await name.getAttribute('aria-invalid'), 'true');
    await name.fill('陆苇宁');
    await f.page.locator('.batch-submit button').click();
    await f.page.getByRole('alert').filter({ hasText: '已记录模拟报名请求' }).waitFor();
    assert.equal(f.submissions[0].body.attendees[1].formAnswers.office_phone, '010-88888888');
  } finally {
    await f.context.close();
  }
});

test('server schema issues expand and focus the correct stable attendee card', async () => {
  const f = await fixture({ fieldIssue: true });
  try {
    await f.open();
    await f.fill(2);
    const card = f.page.locator('.attendee-card').nth(1);
    await card.getByRole('button', { name: /收起/ }).click();
    await f.page.locator('#batch-terms-accepted').check();
    await f.page.locator('.batch-submit button').click();
    const company = card.locator('input[id$="-company"]');
    await card.getByText('公司信息需要更新', { exact: true }).waitFor();
    assert.equal(await company.getAttribute('aria-invalid'), 'true');
    assert.equal(await company.evaluate((input) => document.activeElement === input), true);
    assert.equal(
      await f.page.locator('.attendee-card').first().locator('[aria-invalid="true"]').count(),
      0,
    );
  } finally {
    await f.context.close();
  }
});

test('mobile review registrations explain the whole batch approval before paid or free submission', async () => {
  for (const free of [false, true]) {
    const f = await fixture({ manualReview: true, free, width: 375 });
    try {
      await f.open();
      await f.fill(2);
      await f.page
        .locator('.batch-submit button')
        .filter({ hasText: '提交 2 位整批审核' })
        .waitFor();
      assert.equal(await f.page.locator('.batch-review-note').isVisible(), true);
      assert.match(
        await f.page.locator('.batch-review-note').innerText(),
        free ? /审核通过后统一出票/ : /审核通过后再统一支付/,
      );
    } finally {
      await f.context.close();
    }
  }
});

test('purchaser detail displays the original complete form using historical field labels', async () => {
  const f = await fixture({ width: 375 });
  try {
    const person = f.getDetail().items[1];
    person.attendeeClaimed = true;
    person.canEditAttendee = false;
    person.registration.formAnswers = {
      office_phone: '010-88888888',
      attendance_goal: '<script>历史的参会目标</script>',
    };
    person.registrationFields = [
      ...person.registrationFields,
      { key: 'office_phone', label: '原报名办公电话', type: 'tel' },
      { key: 'attendance_goal', label: '原报名参会目标', type: 'text' },
    ];
    await f.open(`/account/orders/${orderId}`);
    const card = f.page.locator('.order-person').nth(1);
    for (const text of [
      '市场负责人',
      '深圳',
      '原报名办公电话',
      '010-88888888',
      '原报名参会目标',
      '<script>历史的参会目标</script>',
    ])
      assert.match(await card.innerText(), new RegExp(text));
    assert.equal(await card.locator('.person-data script').count(), 0);
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('an expired quote session asks for login and restores that buyer draft after verification', async () => {
  const f = await fixture();
  try {
    await f.open();
    const settledQuote = f.page.waitForResponse(
      (response) =>
        response.url().endsWith('/registration-batches/quote') &&
        response.request().postDataJSON().quantity === 2 &&
        response.status() === 200,
    );
    await f.fill(2);
    await (await settledQuote).finished();
    await f.page.waitForFunction(
      () => !document.querySelector('.batch-summary')?.textContent.includes('正在核对'),
    );
    const ids = await f.page
      .locator('.attendee-card')
      .evaluateAll((cards) => cards.map((card) => card.dataset.cardId));
    await f.page.locator('#batch-terms-accepted').check();
    f.expireSession();
    await f.page.locator('.batch-submit button').click();
    await f.page.getByRole('dialog').waitFor();
    assert.equal(f.submissions.length, 0);
    await f.page.getByPlaceholder('请输入 11 位手机号').fill('13800138000');
    await f.page.getByRole('button', { name: '获取验证码', exact: true }).click();
    await f.page.getByPlaceholder('6 位验证码').fill('123456');
    await f.page.locator('.auth-consent input').check();
    await f.page.getByRole('button', { name: '验证并继续', exact: true }).click();
    await f.page.waitForFunction(
      () =>
        document.querySelectorAll('.attendee-card').length === 2 &&
        !document.querySelector('.auth-dialog'),
    );
    assert.deepEqual(
      await f.page
        .locator('.attendee-card')
        .evaluateAll((cards) => cards.map((card) => card.dataset.cardId)),
      ids,
    );
    assert.equal(
      await f.page.locator('.attendee-card').nth(1).locator('input[id$="-name"]').inputValue(),
      '陆苇宁',
    );
    assert.equal(await f.page.locator('#batch-terms-accepted').isChecked(), true);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('an attendee edit refreshes expired CSRF and preserves the inputs for a manual retry', async () => {
  const f = await fixture({ editCsrf: true });
  try {
    await f.open(`/account/orders/${orderId}`);
    const card = f.page.locator('.order-person').nth(1);
    await card.getByRole('button', { name: '修改参会资料', exact: true }).click();
    const input = card.locator('input[id$="-name"]');
    await input.fill('保留的修改姓名');
    await card.getByRole('button', { name: '保存此名额资料', exact: true }).click();
    await f.page
      .getByRole('alert')
      .filter({ hasText: '登录验证已更新，当前填写已保留，请重新操作。' })
      .waitFor();
    assert.equal(await input.inputValue(), '保留的修改姓名');
    assert.equal(f.mutations.filter((mutation) => mutation.kind === 'edit').length, 1);
    await card.getByRole('button', { name: '保存此名额资料', exact: true }).click();
    await f.page
      .getByText('参会资料已保存。联系方式变化时，原邀请失效，请使用新的认领邀请。', {
        exact: true,
      })
      .waitFor();
    const edits = f.mutations.filter((mutation) => mutation.kind === 'edit');
    assert.equal(edits[1].headers['x-csrf-token'], 'batch-renewed-csrf');
    assert.deepEqual(edits[1].body, edits[0].body);
    assert.equal(f.getDetail().items[1].registration.attendee.name, '保留的修改姓名');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.context.close();
  }
});

test('a free order awaiting batch approval describes ticket issuance without a payment step', async () => {
  const f = await fixture({ free: true, width: 375 });
  try {
    f.getDetail().nextAction = 'review';
    f.getDetail().order.status = 'pending_review';
    await f.open(`/account/orders/${orderId}`);
    assert.match(
      await f.page.locator('.order-overview').innerText(),
      /整批资料一起审核，审核通过后统一出票/,
    );
    assert.equal(
      await f.page.locator('.order-overview').getByText('统一支付', { exact: true }).count(),
      0,
    );
  } finally {
    await f.context.close();
  }
});
