import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const databaseUrl = new URL(process.env.DATABASE_URL ?? 'http://missing.invalid');
assert.ok(
  ['127.0.0.1', 'localhost'].includes(databaseUrl.hostname) &&
    databaseUrl.pathname.startsWith('/tokems_home_nav_test_'),
  'Use an isolated homepage-navigation test database',
);
const web = process.env.WEB_BASE_URL ?? 'http://localhost:18088';
const admin = process.env.ADMIN_BASE_URL ?? 'http://admin.localhost:18088/admin';
const api = `${web}/api/v1`;
const output = resolve(root, 'test-results/homepage-navigation');
await mkdir(output, { recursive: true });
const requireDatabase = createRequire(resolve(root, 'packages/database/package.json'));
const { Pool } = requireDatabase('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const protectedTables = [
  'registrations',
  'orders',
  'order_items',
  'tickets',
  'customers',
  'invoice_requests',
];
async function counts() {
  const result = {};
  for (const table of protectedTables) {
    const exists = await pool.query('select to_regclass($1) as name', [table]);
    if (exists.rows[0].name)
      result[table] = Number(
        (await pool.query(`select count(*) as total from "${table}"`)).rows[0].total,
      );
  }
  return result;
}
const before = await counts();
const login = await fetch(`${api}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? 'admin',
  }),
});
assert.equal(login.status, 201, 'Administrator login failed');
const credentials = await login.json();
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected, `${method} ${path} returned an unexpected status`);
  return response.json();
}
const originalHome = await request('/admin/organization/homepage');
const event = await request('/homepage');
const eventId = event.id;
const experiencePath = `/admin/events/${eventId}/experience`;
const originalExperience = await request(experiencePath);
const originalOverride = structuredClone(originalExperience.overrides.home.document);
const checked = [];
const errors = [];
let browser;
async function setHome(mode) {
  const current = await request('/admin/organization/homepage');
  return request('/admin/organization/homepage', 'PUT', {
    mode,
    eventId,
    revision: current.revision,
  });
}
async function setMenu(items) {
  const current = await request(experiencePath);
  const document = structuredClone(current.overrides.home.document);
  document['home.navigation'] = {
    ...document['home.navigation'],
    content: { ...document['home.navigation']?.content, items },
  };
  return request(`${experiencePath}/home`, 'PUT', {
    revision: current.overrides.home.revision,
    document,
  });
}
try {
  await setHome('empty');
  const blank = await fetch(`${web}/`);
  const blankHtml = await blank.text();
  assert.equal(blank.status, 200);
  assert.match(blankHtml, /data-tokems-homepage="empty"/u);
  assert.doesNotMatch(blankHtml, /<(?:script|iframe|link)\b/iu);
  assert.match(blankHtml, /<body><\/body>/u);
  const head = await fetch(`${web}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const key of [
    'cache-control',
    'content-security-policy',
    'x-robots-tag',
    'x-tokems-homepage',
  ])
    assert.equal(head.headers.get(key), blank.headers.get(key));
  assert.equal((await request('/homepage')).id, eventId);
  assert.equal((await fetch(`${web}/${event.slug}`)).status, 200);
  const legacy = await fetch(`${web}/?event=${event.slug}&utm_source=legacy`, {
    redirect: 'manual',
  });
  assert.equal(legacy.status, 308);
  assert.equal(legacy.headers.get('location'), `/${event.slug}?utm_source=legacy`);
  assert.equal((await fetch(`${api}/admin/organization/homepage`)).status, 401);
  const currentHome = await request('/admin/organization/homepage');
  await request(
    '/admin/organization/homepage',
    'PUT',
    { mode: 'event', revision: currentHome.revision - 1 },
    409,
  );
  await request(
    '/admin/organization/settings',
    'PATCH',
    { settings: { homepage: { mode: 'event', revision: 0 } } },
    400,
  );
  checked.push(
    'blank GET/HEAD, default business context, independent event, legacy URLs, authentication and stale writes',
  );

  const menu = [
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
      label: '合作申请',
      kind: 'page',
      target: 'cooperation',
      enabled: true,
      newWindow: false,
    },
    {
      id: 'external',
      label: '往届回顾',
      kind: 'custom',
      target: 'https://example.com/history#conference',
      enabled: true,
      newWindow: true,
    },
  ];
  await setMenu(menu);
  const fresh = await request(experiencePath);
  const invalid = structuredClone(fresh.overrides.home.document);
  invalid['home.navigation'].content.items = [{ ...menu[2], target: 'javascript:alert(1)' }];
  await request(
    `${experiencePath}/home`,
    'PUT',
    { revision: fresh.overrides.home.revision, document: invalid },
    422,
  );
  assert.deepEqual(
    (await request(experiencePath)).overrides.home.document,
    fresh.overrides.home.document,
  );
  checked.push('published menu overrides and server-side unsafe-link rejection');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await desktop.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${web}/${event.slug}`, { waitUntil: 'networkidle' });
  assert.deepEqual(await page.locator('.nav-links:visible a').allTextContents(), [
    '精彩议程',
    '合作申请',
    '往届回顾 ↗',
  ]);
  assert.equal(await page.getByRole('link', { name: '精彩议程' }).getAttribute('href'), '#agenda');
  assert.equal(
    await page.getByRole('link', { name: /往届回顾/u }).getAttribute('rel'),
    'noopener noreferrer',
  );
  await page.screenshot({ path: resolve(output, 'custom-menu-desktop.png') });
  await page.goto(`${web}/apply/cooperation?event=${event.slug}`, { waitUntil: 'networkidle' });
  assert.equal(
    await page.getByRole('link', { name: '精彩议程' }).getAttribute('href'),
    `/${event.slug}#agenda`,
  );
  await page.goto(`${web}/partners?event=${event.slug}`, { waitUntil: 'networkidle' });
  assert.equal(
    await page.getByRole('link', { name: '精彩议程' }).getAttribute('href'),
    `/${event.slug}#agenda`,
  );
  await page.evaluate(() => {
    const router = document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router;
    void router.push('/');
  });
  await page.waitForURL(`${web}/`);
  assert.equal(await page.locator('body').innerText(), '');
  assert.equal(await page.locator('script').count(), 0);
  checked.push(
    'shared navigation across home, cooperation and partner pages; blank-root document boundary',
  );

  for (const width of [320, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const phone = await context.newPage();
    phone.on('pageerror', (error) => errors.push(error.message));
    await phone.goto(`${web}/${event.slug}`, { waitUntil: 'networkidle' });
    const toggle = phone.locator('.navigation-toggle');
    const brandBox = await phone.locator('#nav .logo').boundingBox();
    const menuBox = await toggle.boundingBox();
    const actionsBox = await phone.locator('#nav .nav-cta').boundingBox();
    assert.ok(brandBox.x + brandBox.width <= menuBox.x + 1, 'Phone brand overlaps the menu');
    assert.ok(
      menuBox.x + menuBox.width <= actionsBox.x + 1,
      'Phone menu overlaps account or registration',
    );
    await toggle.click();
    await phone.locator('.navigation-panel').waitFor();
    assert.equal(await phone.locator('.navigation-panel a').count(), 3);
    assert.equal(
      await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await phone.screenshot({ path: resolve(output, `custom-menu-${width}.png`) });
    await phone.locator('.navigation-panel a').last().focus();
    await phone.keyboard.press('Tab');
    await phone.locator('.navigation-panel').waitFor({ state: 'hidden' });
    await toggle.click();
    await phone.keyboard.press('Escape');
    await toggle.waitFor();
    assert.equal(await toggle.evaluate((element) => document.activeElement === element), true);
    await toggle.click();
    await phone.setViewportSize({ width: width === 320 ? 375 : 320, height: 850 });
    await phone.locator('.navigation-panel').waitFor({ state: 'hidden' });
    await toggle.click();
    const panelBox = await phone.locator('.navigation-panel').boundingBox();
    assert.ok(
      panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= (width === 320 ? 375 : 320),
      'Resized menu must fit inside the viewport',
    );
    await context.close();
  }
  await setMenu(
    Array.from({ length: 12 }, (_, index) => ({
      ...menu[0],
      id: `long-${index}`,
      label: '长'.repeat(16),
    })),
  );
  await page.goto(`${web}/${event.slug}`, { waitUntil: 'networkidle' });
  await page.locator('.navigation-toggle').click();
  assert.equal(await page.locator('.navigation-panel a').count(), 12);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.keyboard.press('Escape');
  await setMenu([]);
  await page.goto(`${web}/${event.slug}`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.conference-navigation').count(), 0);
  assert.equal(await page.locator('.nav-cta').count(), 1);
  checked.push('phone menu, Escape focus restoration, no overflow, and explicit empty menu');

  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const management = await adminContext.newPage();
  management.on('pageerror', (error) => errors.push(error.message));
  await management.goto(`${admin}/manage/settings/website`, { waitUntil: 'networkidle' });
  if (management.url().includes('/login')) {
    await management.getByLabel('用户名').fill(process.env.ADMIN_USERNAME ?? 'admin');
    await management
      .getByLabel('密码', { exact: true })
      .fill(process.env.ADMIN_PASSWORD ?? 'admin');
    await management.getByRole('button', { name: '进入运营台' }).click();
  }
  await management.locator('#homepage-mode').waitFor();
  await management.locator('#homepage-mode').selectOption('event');
  await management
    .locator('.homepage-settings')
    .getByRole('button', { name: '保存首页设置', exact: true })
    .click();
  await management.locator('.homepage-settings .admin-success').waitFor();
  assert.equal((await request('/admin/organization/homepage')).mode, 'event');
  await management.screenshot({ path: resolve(output, 'homepage-settings-desktop.png') });
  await management.locator('#homepage-mode').selectOption('empty');
  await management.getByRole('button', { name: '保存网站设置', exact: true }).click();
  await management.getByText('已保存，公开网站实时生效', { exact: false }).waitFor();
  const leavePrompt = management.waitForEvent('dialog');
  const leaveClick = management
    .locator('.settings-tabs')
    .getByRole('link', { name: '飞书机器人', exact: true })
    .click();
  const prompt = await leavePrompt;
  assert.match(prompt.message(), /未保存/u);
  await prompt.dismiss();
  await leaveClick;
  assert.ok(management.url().endsWith('/manage/settings/website'));
  await management.locator('#homepage-mode').selectOption('event');
  await management.goto(`${admin}/events/${eventId}/settings/general`, {
    waitUntil: 'networkidle',
  });
  await management.getByRole('heading', { name: '顶部导航', exact: true }).waitFor();
  await management.getByRole('button', { name: '恢复模板默认菜单', exact: true }).click();
  await management.getByRole('button', { name: '保存首页设置', exact: true }).click();
  await management.getByText('首页设置已保存', { exact: false }).waitFor();
  assert.ok(
    (await request(experiencePath)).definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.navigation',
    ).content.items.length > 0,
  );
  await management
    .locator('.navigation-editor')
    .screenshot({ path: resolve(output, 'navigation-editor.png') });
  checked.push('real admin forms save root display and restore template menus');

  const legacyDocument = structuredClone(originalOverride);
  legacyDocument['home.navigation'] = {
    ...legacyDocument['home.navigation'],
    content: { ...legacyDocument['home.navigation']?.content, editionLabel: '' },
  };
  delete legacyDocument['home.navigation'].content.items;
  const beforeLegacy = await request(experiencePath);
  await request(`${experiencePath}/home`, 'PUT', {
    revision: beforeLegacy.overrides.home.revision,
    document: legacyDocument,
  });
  await management.reload({ waitUntil: 'networkidle' });
  await management.locator('#nav-label-edition').waitFor();
  assert.equal(await management.locator('#nav-label-edition').inputValue(), '');
  await management.getByLabel('首屏主按钮', { exact: true }).fill('立即报名验收');
  assert.equal(
    await management
      .getByLabel('首屏主按钮', { exact: true })
      .evaluate((input) => input.closest('form').checkValidity()),
    true,
    'Untouched legacy navigation must not block other homepage fields',
  );
  await Promise.all([
    management.waitForResponse(
      (response) =>
        response.url().endsWith(`${experiencePath}/home`) && response.request().method() === 'PUT',
    ),
    management.getByRole('button', { name: '保存首页设置', exact: true }).click(),
  ]);
  const afterLegacy = await request(experiencePath);
  assert.equal(
    afterLegacy.overrides.home.document['home.hero'].content.primaryAction,
    '立即报名验收',
  );
  assert.equal(afterLegacy.overrides.home.document['home.navigation'].content.items, undefined);
  await management.locator('#nav-label-why').fill('大会介绍');
  assert.equal(
    await management
      .locator('#nav-label-edition')
      .evaluate((input) => input.closest('form').checkValidity()),
    false,
    'Editing a menu must enforce nonempty labels',
  );
  await management.locator('#nav-label-edition').fill('本届升级');
  await Promise.all([
    management.waitForResponse(
      (response) =>
        response.url().endsWith(`${experiencePath}/home`) && response.request().method() === 'PUT',
    ),
    management.getByRole('button', { name: '保存首页设置', exact: true }).click(),
  ]);
  assert.equal(
    (await request(experiencePath)).overrides.home.document['home.navigation'].content.items[0]
      .label,
    '大会介绍',
  );
  await management.locator('#nav-kind-why').selectOption('page');
  await management.locator('#nav-target-why').selectOption('register');
  const firstRow = management.locator('.navigation-rows > li').first();
  await firstRow.getByLabel('启用', { exact: true }).uncheck();
  await firstRow.getByLabel('新窗口打开', { exact: true }).check();
  await Promise.all([
    management.waitForResponse(
      (response) =>
        response.url().endsWith(`${experiencePath}/home`) && response.request().method() === 'PUT',
    ),
    management.getByRole('button', { name: '保存首页设置', exact: true }).click(),
  ]);
  const savedItem = (await request(experiencePath)).overrides.home.document['home.navigation']
    .content.items[0];
  assert.equal(savedItem.kind, 'page');
  assert.equal(savedItem.target, 'register');
  assert.equal(savedItem.enabled, false);
  assert.equal(savedItem.newWindow, true);
  await management.getByRole('button', { name: '恢复模板默认菜单', exact: true }).click();
  await Promise.all([
    management.waitForResponse(
      (response) =>
        response.url().endsWith(`${experiencePath}/home`) && response.request().method() === 'PUT',
    ),
    management.getByRole('button', { name: '保存首页设置', exact: true }).click(),
  ]);
  checked.push(
    'legacy blank menu labels preserve unrelated saves; direct label, type, target and checkbox edits persist',
  );
  for (const width of [320, 375]) {
    const context = await browser.newContext({
      storageState: await adminContext.storageState(),
      viewport: { width, height: 850 },
    });
    const phone = await context.newPage();
    phone.on('pageerror', (error) => errors.push(error.message));
    await phone.goto(`${admin}/events/${eventId}/settings/general`, { waitUntil: 'networkidle' });
    await phone.locator('.navigation-editor').waitFor();
    assert.equal(
      await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await phone
      .locator('.navigation-editor')
      .screenshot({ path: resolve(output, `navigation-editor-${width}.png`) });
    await phone.goto(`${admin}/manage/settings/website`, { waitUntil: 'networkidle' });
    await phone.locator('#homepage-mode').waitFor();
    assert.equal(
      await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await phone
      .locator('.homepage-settings')
      .screenshot({ path: resolve(output, `homepage-settings-${width}.png`) });
    await context.close();
  }
  checked.push(
    'twelve long menu labels, Tab focus, independent unsaved-change protection and phone admin forms',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(await counts(), before, 'Business row counts changed');
  await writeFile(
    resolve(output, 'receipt.json'),
    `${JSON.stringify({ checked, businessCounts: before, pageErrors: errors }, null, 2)}\n`,
  );
  console.info(
    JSON.stringify({
      checked: checked.length,
      pageErrors: errors.length,
      businessCountsPreserved: true,
      evidence: output,
    }),
  );
} finally {
  try {
    const current = await request(experiencePath);
    await request(`${experiencePath}/home`, 'PUT', {
      revision: current.overrides.home.revision,
      document: originalOverride,
    });
    const configuration = await request('/admin/organization/homepage');
    await request('/admin/organization/homepage', 'PUT', {
      mode: originalHome.mode,
      ...(originalHome.eventId ? { eventId: originalHome.eventId } : {}),
      revision: configuration.revision,
    });
  } finally {
    await browser?.close();
    await pool.end();
  }
}
