import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const base = process.env.ADMIN_BASE_URL ?? 'http://admin.localhost:8088/admin';
if (!['localhost', 'admin.localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
  throw new Error('Partner dialog checks require a local application');
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());
const output = 'test-results/partner-dialogs';
await mkdir(output, { recursive: true });
const program = { mode: 'fixed', fixedRateBps: 1000, attributionDays: 30 };
const partner = {
  id: 'a761c83a-143b-4447-b018-a03c238b2be7',
  version: 1,
  loginMobile: '+8613800138000',
  personalRateBps: null,
  sortOrder: 0,
  internalNote: '',
  qualificationStatus: 'pending_confirmation',
  profile: {
    displayName: '测试伙伴',
    company: '',
    title: '',
    industry: '',
    businessIntro: '',
    businessUrl: '',
    publicStatus: 'draft',
  },
  balances: { available: 0, reserved: 0 },
  currentProgram: program,
};

async function fixture(t, width = 1440, height = 1000) {
  const context = await browser.newContext({ viewport: { width, height } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const writes = [];
  const errors = [];
  const server = { reject: false };
  page.on('pageerror', (error) => errors.push(error.message));
  // Only login reaches the real write API. All partner mutations use fixtures.
  await page.route('**/api/v1/admin/events/101/distribution/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push(request.postDataJSON());
      if (server.reject)
        return route.fulfill({
          status: 400,
          json: {
            message: '合作伙伴资料校验失败',
            details: { issues: [{ path: ['businessUrl'], code: 'invalid_union' }] },
          },
        });
      return route.fulfill({ json: { ...partner, created: false } });
    }
    if (path.endsWith('/overview'))
      return route.fulfill({
        json: { program, partnerCounts: {}, commissionTotals: {}, payoutTotals: {} },
      });
    if (path.endsWith('/partners')) return route.fulfill({ json: { items: [partner] } });
    if (path.endsWith('/payouts'))
      return route.fulfill({
        json: {
          requests: [],
          batches: [],
          inquiries: [],
          recipients: [],
          documents: [],
          reconciliations: [],
        },
      });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(`${base}/events/101/distribution`, { waitUntil: 'networkidle' });
  if (await page.getByRole('button', { name: '进入运营台' }).count()) {
    await page.getByLabel('用户名').fill(process.env.ADMIN_USERNAME ?? 'admin');
    await page.getByLabel('密码').fill(process.env.ADMIN_PASSWORD ?? 'admin');
    await page.getByRole('button', { name: '进入运营台' }).click();
    await page.waitForURL((url) => !url.pathname.includes('/login'));
    await page.goto(`${base}/events/101/distribution`, { waitUntil: 'networkidle' });
  }
  await page.getByRole('heading', { name: '合作伙伴列表', exact: true }).waitFor();
  t.after(() => assert.deepEqual(errors, []));
  return { page, writes, server, width, height };
}

async function assertCentered(dialog, width, height) {
  await dialog.waitFor({ state: 'visible' });
  const box = await dialog.boundingBox();
  assert.ok(box);
  assert.ok(
    Math.abs(box.x + box.width / 2 - width / 2) < 2,
    `dialog center x=${box.x + box.width / 2}, viewport center=${width / 2}`,
  );
  assert.ok(
    Math.abs(box.y + box.height / 2 - height / 2) < 2,
    'dialog remains vertically centered',
  );
  assert.ok(box.x >= 14 && box.y >= 14, 'dialog keeps a viewport gutter');
  return box;
}

for (const [width, height] of [
  [1440, 1000],
  [375, 812],
]) {
  test(`duplicate invitation and failed edit remain centered at ${width}px`, async (t) => {
    const { page } = await fixture(t, width, height);
    await page.getByRole('button', { name: '新增合作伙伴', exact: true }).click();
    const invitation = page.locator('.partner-invite-dialog');
    await assertCentered(invitation, width, height);
    await invitation.locator('input[type=tel]').fill('13800138000');
    await invitation.getByRole('button', { name: '邀请并开通' }).click();
    const editor = page.getByRole('dialog', { name: '编辑合作伙伴', exact: true });
    await assertCentered(editor, width, height);
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await editor
      .getByText('该手机号已是本大会的合作伙伴，已打开已有资料供你编辑。', { exact: true })
      .waitFor();
    await editor.getByLabel('姓名 / 展示名称').fill('');
    await editor.getByRole('button', { name: '保存修改' }).click();
    const feedback = editor.locator('.partner-form-feedback');
    await feedback.waitFor();
    assert.match(await feedback.innerText(), /姓名 \/ 展示名称/);
    assert.equal(await editor.getByLabel('姓名 / 展示名称').getAttribute('aria-invalid'), 'true');
    assert.equal(
      await editor.getByLabel('姓名 / 展示名称').evaluate((el) => el === document.activeElement),
      true,
    );
    await assertCentered(editor, width, height);
    const box = await feedback.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= height, 'error summary stays visible');
    await page.screenshot({ path: `${output}/edit-error-${width}.png` });
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '新增合作伙伴', exact: true }).click();
    await invitation.getByRole('button', { name: '邀请并开通' }).click();
    await invitation.locator('.partner-form-feedback').waitFor();
    assert.equal(await invitation.locator('input[type=tel]').getAttribute('aria-invalid'), 'true');
    await assertCentered(invitation, width, height);
    await page.screenshot({ path: `${output}/invite-error-${width}.png` });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(), 0);
  });
}

test('business URL, server field errors and retries identify the affected input', async (t) => {
  const { page, writes, server, width, height } = await fixture(t);
  await page
    .locator('.partner-directory-table')
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const editor = page.getByRole('dialog', { name: '编辑合作伙伴', exact: true });
  await editor.getByLabel('业务链接').fill('ftp://example.com');
  await editor.getByRole('button', { name: '保存修改' }).click();
  await editor.locator('.partner-form-feedback').waitFor();
  assert.match(await editor.locator('.partner-form-feedback').innerText(), /业务链接.*http/i);
  assert.equal(writes.length, 0, 'invalid URL is rejected before submission');
  await editor.getByLabel('业务链接').fill('https://example.com');
  server.reject = true;
  await editor.getByRole('button', { name: '保存修改' }).click();
  await page.waitForFunction(
    () => document.querySelector('[name="businessUrl"]')?.getAttribute('aria-invalid') === 'true',
  );
  assert.equal(writes.length, 1);
  await assertCentered(editor, width, height);
  assert.equal(await editor.getByLabel('业务链接').inputValue(), 'https://example.com');
  server.reject = false;
  await editor.getByRole('button', { name: '保存修改' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(writes.length, 2);
});
