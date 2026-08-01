import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { DEMO_IDS } from '../packages/contracts/dist/index.js';
import { captureVisualFailure, redactVisualDiagnostic } from './lib/visual-evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'test-results/visual');
const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:8088';
const adminBase = process.env.ADMIN_BASE_URL ?? 'http://admin.localhost:8088/admin';
const adminUsername = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminUsername || !adminPassword) {
  throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD are required for the visual smoke test');
}
await mkdir(output, { recursive: true });

let browser;

async function runVisualSmoke() {
browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

const issues = [];
const checked = [];

function watch(page, label) {
  page.on('pageerror', (error) => issues.push(`${label}: page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(`${label}: console error: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500)
      issues.push(`${label}: HTTP ${response.status()} ${response.url()}`);
  });
}

async function assertNoHorizontalOverflow(page, label) {
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  if (sizes.content > sizes.viewport + 2) {
    issues.push(`${label}: horizontal overflow ${sizes.content}px > ${sizes.viewport}px`);
  }
}

async function assertAdminUiBaseline(page, label) {
  if (!(await page.locator('body.admin-body').count())) return;
  const findings = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const description = (element) =>
      (
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.textContent ||
        element.tagName
      )
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 80);
    const undersizedText = [...document.querySelectorAll('body *')]
      .filter(
        (element) =>
          visible(element) &&
          element.childElementCount === 0 &&
          element.textContent?.trim() &&
          Number.parseFloat(getComputedStyle(element).fontSize) < 10,
      )
      .map((element) => `${description(element)} (${getComputedStyle(element).fontSize})`)
      .slice(0, 8);
    const unsafeBlankLinks = [...document.querySelectorAll('a[target="_blank"]')]
      .filter(
        (element) =>
          visible(element) &&
          !element.rel
            .split(/\s+/)
            .map((value) => value.toLowerCase())
            .includes('noopener'),
      )
      .map(description)
      .slice(0, 8);
    const unnamedControls = [...document.querySelectorAll('input, select, textarea, button')]
      .filter((element) => {
        if (!visible(element) || element.getAttribute('type') === 'hidden') return false;
        const id = element.getAttribute('id');
        const labelledBy = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const wrappingLabel = element.closest('label');
        return !(
          element.getAttribute('aria-label') ||
          element.getAttribute('aria-labelledby') ||
          element.getAttribute('title') ||
          labelledBy?.textContent?.trim() ||
          wrappingLabel?.textContent?.trim() ||
          element.textContent?.trim()
        );
      })
      .map(description)
      .slice(0, 8);
    const undersizedTargets =
      window.innerWidth <= 390
        ? [
            ...document.querySelectorAll(
              'button, a.button, a.tool-button, a.text-link, summary, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea',
            ),
          ]
            .filter((element) => {
              if (!visible(element)) return false;
              if (element.matches('input') && element.closest('.admin-search')) return false;
              const rect = element.getBoundingClientRect();
              return rect.width < 40 || rect.height < 40;
            })
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return `${description(element)} (${Math.round(rect.width)}×${Math.round(rect.height)})`;
            })
            .slice(0, 8)
        : [];
    return { undersizedText, unsafeBlankLinks, unnamedControls, undersizedTargets };
  });
  for (const [kind, values] of Object.entries(findings)) {
    if (values.length) issues.push(`${label}: ${kind}: ${values.join(' | ')}`);
  }
}

async function assertAdminWhiteSurfaces(page, label) {
  if (!(await page.locator('body.admin-body').count())) return;
  const tintedSurfaces = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const selectors = [
      'body.admin-body',
      '.admin-workspace',
      '.admin-content',
      '.login-form-wrap',
      '.admin-standalone-state',
      '.data-table th',
      '.settings-panel-note',
      '.settings-form-actions',
      '.settings-summary',
      '.sms-test-panel',
      '.choice-card',
      '.advanced-permissions',
      '.invitation-link',
      '.scan-frame',
      '.field-empty-value',
      '.template-option-row',
      '.creation-confirmation > section',
      '.template-node-panel',
      '.template-property-panel',
      '.template-preview-panel',
      '.template-preview-stage',
      '.invoice-detail-scroll',
      '.invoice-detail-empty',
      '.event-faq-editor article',
      '.template-asset-list li',
      '.customer-dialog-loading',
      '.customer-dialog-error',
      '.customer-detail-scroll',
      '.customer-delete-target',
      '.registration-detail-scroll',
    ];
    if (window.innerWidth <= 820) selectors.push('.field-builder-row');
    return selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)]
        .filter(visible)
        .map((element) => ({
          selector,
          background: getComputedStyle(element).backgroundColor,
        }))
        .filter(({ background }) => background !== 'rgb(255, 255, 255)'),
    );
  });
  if (tintedSurfaces.length) {
    issues.push(
      `${label}: non-white admin surfaces: ${tintedSurfaces
        .slice(0, 12)
        .map(({ selector, background }) => `${selector} (${background})`)
        .join(' | ')}`,
    );
  }
}

async function assertCenteredDialog(page, selector, label) {
  const metrics = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      open: element instanceof HTMLDialogElement && element.open,
      horizontalOffset: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2),
      verticalOffset: Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2),
    };
  });
  if (!metrics.open) issues.push(`${label}: dialog is not open`);
  if (metrics.horizontalOffset > 2 || metrics.verticalOffset > 2) {
    issues.push(
      `${label}: dialog is not centered (${metrics.horizontalOffset}px, ${metrics.verticalOffset}px)`,
    );
  }
}

async function screenshot(page, file, label) {
  await page.evaluate(async () => {
    const step = Math.max(320, Math.floor(window.innerHeight * 0.7));
    for (let offset = 0; offset < document.documentElement.scrollHeight; offset += step) {
      window.scrollTo(0, offset);
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    window.scrollTo(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  await page.screenshot({ path: resolve(output, file), fullPage: true });
  await assertNoHorizontalOverflow(page, label);
  await assertAdminUiBaseline(page, label);
  await assertAdminWhiteSurfaces(page, label);
  checked.push(label);
}

async function loginAdmin(page) {
  await page.getByLabel('用户名').fill(adminUsername);
  await page.getByLabel('密码').fill(adminPassword);
  await page.getByRole('button', { name: '进入运营台' }).click();
  await page.waitForURL(/\/manage\/events/);
}

async function assertSettingsWorkflow(page, label) {
  await page.goto(`${adminBase}/manage/settings/website`, { waitUntil: 'networkidle' });
  const siteName = page.locator('#site-name');
  const originalName = await siteName.inputValue();
  const changedName = `${originalName} · 交互验收`;
  const saveBar = page.locator('form[data-settings-form] > .settings-form-actions');

  await siteName.fill(changedName);
  await saveBar.waitFor();
  await saveBar.getByRole('button', { name: '放弃更改' }).click();
  await saveBar.waitFor({ state: 'hidden' });
  if ((await siteName.inputValue()) !== originalName) {
    issues.push(`${label}: 放弃更改后没有恢复网站名称`);
  }
  if (await saveBar.isVisible()) {
    issues.push(`${label}: 放弃更改后保存条仍然可见`);
  }

  await siteName.fill(changedName);
  const cancelDialogPromise = page.waitForEvent('dialog');
  const cancelledNavigation = page.getByRole('link', { name: /统计与数据/ }).click();
  const cancelDialog = await cancelDialogPromise;
  if (cancelDialog.type() !== 'confirm') {
    issues.push(`${label}: 未保存离页提示类型为 ${cancelDialog.type()}`);
  }
  await cancelDialog.dismiss();
  await cancelledNavigation;
  if (!new URL(page.url()).pathname.endsWith('/manage/settings/website')) {
    issues.push(`${label}: 取消离页后仍切换了设置模块`);
  }
  if ((await siteName.inputValue()) !== changedName || !(await saveBar.isVisible())) {
    issues.push(`${label}: 取消离页后草稿或未保存状态丢失`);
  }

  const delaySettingsPatch = async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  };
  await page.route('**/admin/organization/settings', delaySettingsPatch);
  await saveBar.getByRole('button', { name: '保存并发布' }).click();
  await saveBar.getByText('正在保存设置').waitFor();
  const busyDialogPromise = page.waitForEvent('dialog');
  const busyNavigation = page.getByRole('link', { name: /统计与数据/ }).click();
  const busyDialog = await busyDialogPromise;
  if (busyDialog.type() !== 'alert' || !busyDialog.message().includes('正在保存')) {
    issues.push(`${label}: 保存期间没有给出明确的离页阻止提示`);
  }
  await busyDialog.accept();
  await busyNavigation;
  if (!new URL(page.url()).pathname.endsWith('/manage/settings/website')) {
    issues.push(`${label}: 保存请求进行中仍切换了设置模块`);
  }
  await page.locator('.admin-error').waitFor();
  await page.unroute('**/admin/organization/settings', delaySettingsPatch);
  await saveBar.getByRole('button', { name: '放弃更改' }).click();

  await page.goto(`${adminBase}/manage/settings/team`, { waitUntil: 'networkidle' });
  const invitationEmail = page.locator('#invite-member-email');
  if (await invitationEmail.count()) {
    await invitationEmail.fill('draft-review@example.com');
    const teamDialogPromise = page.waitForEvent('dialog');
    const teamNavigation = page.getByRole('link', { name: /组织与默认项/ }).click();
    const teamDialog = await teamDialogPromise;
    await teamDialog.dismiss();
    await teamNavigation;
    if (!new URL(page.url()).pathname.endsWith('/manage/settings/team')) {
      issues.push(`${label}: 取消离页后团队邀请草稿仍被丢弃`);
    }
    const acceptDialogPromise = page.waitForEvent('dialog');
    const acceptedNavigation = page.getByRole('link', { name: /组织与默认项/ }).click();
    const acceptDialog = await acceptDialogPromise;
    await acceptDialog.accept();
    await acceptedNavigation;
    await page.waitForURL(/\/manage\/settings\/general$/);
  }

  checked.push(label);
}

const desktop = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
});
const page = await desktop.newPage();
watch(page, 'desktop');

await page.goto(webBase, { waitUntil: 'networkidle' });
await page.locator('h1.hero-h').waitFor();
await screenshot(page, 'web-home-desktop.png', '前台首页桌面端');

await page.goto(`${webBase}/register`, { waitUntil: 'networkidle' });
await screenshot(page, 'web-register-desktop.png', '报名页桌面端');
await page.goto(`${webBase}/faq`, { waitUntil: 'networkidle' });
await page.locator('.faq-page').waitFor();
await screenshot(page, 'web-faq-desktop.png', 'FAQ 独立页桌面端');
await page.goto(`${webBase}/register`, { waitUntil: 'networkidle' });
const freeRegistrationButton = page.getByRole('button', { name: '免费报名并领取电子票' });
if ((await page.locator('#registration-name').count()) && (await freeRegistrationButton.count())) {
  await page.locator('#registration-name').fill('视觉测试员');
  const visualRunId = Date.now().toString();
  await page.locator('#registration-mobile').fill(`139${visualRunId.slice(-8)}`);
  await page.locator('#registration-email').fill(`visual-${visualRunId}@example.com`);
  await page.locator('#registration-city').fill('深圳');
  await page.locator('#registration-company').fill('大会视觉实验室');
  await page.locator('#registration-title').fill('质量负责人');
  await page.getByText('我已阅读并同意').click();
  await freeRegistrationButton.click();
  await page.waitForURL(/\/(order|ticket)\//);
  if (new URL(page.url()).pathname.startsWith('/order/')) {
    await screenshot(page, 'web-order-desktop.png', '订单页桌面端');
  } else {
    await page.getByText('现场扫码签到').waitFor();
    await screenshot(page, 'web-ticket-desktop.png', '电子票桌面端');
  }
}

const admin = await desktop.newPage();
watch(admin, 'admin-desktop');
await admin.goto(`${adminBase}/login`, { waitUntil: 'networkidle' });
await screenshot(admin, 'admin-login-desktop.png', '后台登录桌面端');
await loginAdmin(admin);
await admin.getByRole('heading', { name: '大会管理' }).waitFor();
await screenshot(admin, 'admin-events-desktop.png', '管理中心大会列表桌面端');

const standaloneAdminSurfaces = [
  ['/accept-invitation', '接受组织邀请', 'admin-invitation-desktop.png', '邀请接受桌面端'],
  ['/403', '当前账号无权访问此页面', 'admin-forbidden-desktop.png', '无权限页桌面端'],
  ['/route-not-found', '这个页面已移动或不存在', 'admin-not-found-desktop.png', '页面不存在桌面端'],
];
for (const [path, heading, file, label] of standaloneAdminSurfaces) {
  await admin.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
  await admin.getByRole('heading', { name: heading }).waitFor();
  await screenshot(admin, file, label);
}

const managementSurfaces = [
  ['/manage/users', '用户管理', 'admin-users-desktop.png', '用户管理桌面端'],
  ['/manage/invoices', '发票管理', 'admin-invoices-desktop.png', '发票管理桌面端'],
  ['/manage/templates', '模板管理', 'admin-templates-desktop.png', '模板管理桌面端'],
  [
    '/manage/settings',
    '组织与建会默认项',
    'admin-system-settings-desktop.png',
    '管理中心设置桌面端',
  ],
  ['/manage/settings/website', '公开网站', 'admin-website-settings-desktop.png', '网站设置桌面端'],
  ['/manage/settings/payment', '支付服务', 'admin-payment-settings-desktop.png', '支付设置桌面端'],
  ['/manage/settings/sms', '短信服务', 'admin-sms-settings-desktop.png', '短信服务设置桌面端'],
  [
    '/manage/settings/analytics',
    '统计与数据',
    'admin-analytics-settings-desktop.png',
    '统计设置桌面端',
  ],
  [
    '/manage/settings/integrations',
    '集成状态',
    'admin-integrations-settings-desktop.png',
    '服务集成桌面端',
  ],
  [
    '/manage/settings/customers',
    '用户账号',
    'admin-customer-settings-desktop.png',
    '用户账号设置桌面端',
  ],
  ['/manage/settings/team', '团队与权限', 'admin-team-settings-desktop.png', '团队权限设置桌面端'],
  ['/account', '个人中心', 'admin-account-desktop.png', '个人中心桌面端'],
];
for (const [path, heading, file, label] of managementSurfaces) {
  await admin.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
  await admin.getByRole('heading', { name: heading }).waitFor();
  await screenshot(admin, file, label);
}

await assertSettingsWorkflow(admin, '设置中心草稿与离页保护桌面端');

await admin.goto(`${adminBase}/manage/users`, { waitUntil: 'networkidle' });
const desktopCustomerView = admin.getByRole('button', { name: /^(编辑|查看)$/ }).first();
if (await desktopCustomerView.count()) {
  await desktopCustomerView.click();
  await admin.locator('.customer-detail-dialog[open]').waitFor();
  await assertCenteredDialog(admin, '.customer-detail-dialog[open]', '用户详情弹窗桌面端');
  await screenshot(admin, 'admin-user-detail-desktop.png', '用户详情弹窗桌面端');
  await admin.getByRole('button', { name: '关闭用户详情' }).click();
  await admin.locator('.customer-detail-dialog').waitFor({ state: 'detached' });
  const desktopCustomerMore = admin.getByRole('button', { name: '更多' }).first();
  await desktopCustomerMore.click();
  const desktopCustomerDelete = admin.getByRole('button', { name: '删除用户' }).first();
  if (await desktopCustomerDelete.count()) {
    await desktopCustomerDelete.dispatchEvent('click');
    await admin.locator('.customer-delete-dialog[open]').waitFor();
    await assertCenteredDialog(admin, '.customer-delete-dialog[open]', '用户删除确认桌面端');
    await screenshot(admin, 'admin-user-delete-desktop.png', '用户删除确认桌面端');
    await admin.getByRole('button', { name: '取消' }).click();
  }
} else {
  issues.push('用户管理桌面端: 没有可用于弹窗验收的用户');
}

await admin.goto(`${adminBase}/manage/templates`, { waitUntil: 'networkidle' });
const templateEditorPath = `/manage/templates/${DEMO_IDS.template.root}`;
await admin.goto(`${adminBase}${templateEditorPath}`, { waitUntil: 'networkidle' });
await admin.locator('.template-editor-layout').waitFor();
await screenshot(admin, 'admin-template-editor-desktop.png', '模板编辑器桌面端');
await admin.getByRole('button', { name: /图片资源/ }).click();
await screenshot(admin, 'admin-template-assets-desktop.png', '模板图片资源桌面端');

await admin.goto(`${adminBase}/manage/events`, { waitUntil: 'networkidle' });
const eventBase = `/events/${DEMO_IDS.event}`;
const adminSurfaces = [
  [`${eventBase}/overview`, '今天的大会运营状态', 'admin-dashboard-desktop.png', '大会概览桌面端'],
  [
    `${eventBase}/settings/general`,
    '基本信息',
    'admin-event-settings-desktop.png',
    '大会基本设置桌面端',
  ],
  [
    `${eventBase}/settings/site`,
    '大会模板与前台体验',
    'admin-publishing-desktop.png',
    '站点发布桌面端',
  ],
  [
    `${eventBase}/settings/registration`,
    '报名与票务',
    'admin-registration-settings-desktop.png',
    '报名票务设置桌面端',
  ],
  [`${eventBase}/settings/form`, '报名表与条款版本', 'admin-forms-desktop.png', '表单条款桌面端'],
  [`${eventBase}/content`, '嘉宾与两日议程', 'admin-content-desktop.png', '内容管理桌面端'],
  [`${eventBase}/content/ai`, '大会运营文案助手', 'admin-ai-desktop.png', 'AI 文案桌面端'],
  [
    `${eventBase}/registrations`,
    '报名与参会人',
    'admin-registrations-desktop.png',
    '报名管理桌面端',
  ],
  [`${eventBase}/orders`, '订单与支付流水', 'admin-orders-desktop.png', '订单支付桌面端'],
  [
    `${eventBase}/notifications`,
    '模板通知与投递记录',
    'admin-notifications-desktop.png',
    '通知中心桌面端',
  ],
  [`${eventBase}/check-in`, '主入口扫码核销', 'admin-checkin-desktop.png', '现场签到桌面端'],
  [`${eventBase}/activity`, '审计日志与数据导出', 'admin-audit-desktop.png', '操作记录桌面端'],
];
for (const [path, heading, file, label] of adminSurfaces) {
  await admin.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
  await admin.getByRole('heading', { name: heading }).waitFor();
  await screenshot(admin, file, label);
}

const eventUnavailablePath = '/events/2147483647/overview';
await admin.goto(`${adminBase}${eventUnavailablePath}`, { waitUntil: 'networkidle' });
await admin.getByRole('heading', { name: '未找到这场大会' }).waitFor();
await screenshot(admin, 'admin-event-unavailable-desktop.png', '大会上下文不可用状态桌面端');

await admin.goto(`${adminBase}${eventBase}/registrations`, { waitUntil: 'networkidle' });
const registrationPageSize = admin.getByLabel('每页显示条数');
await registrationPageSize.fill('3');
await registrationPageSize.press('Enter');
await admin.waitForFunction(() => {
  const loading = [...document.querySelectorAll('.status-badge')].some(
    (element) => element.textContent?.trim() === 'LOADING',
  );
  return !loading && document.querySelectorAll('.data-table tbody tr').length <= 3;
});
const pagedRegistrationRows = await admin
  .locator('.data-table tbody')
  .first()
  .locator('tr')
  .count();
if (pagedRegistrationRows > 3) {
  issues.push(`报名管理桌面端: 自定义每页 3 条后仍显示 ${pagedRegistrationRows} 条`);
}
const registrationView = admin.getByRole('button', { name: '查看' }).first();
if (await registrationView.count()) {
  await registrationView.click();
  await admin.locator('.registration-detail-dialog[open]').waitFor();
  await assertCenteredDialog(admin, '.registration-detail-dialog[open]', '报名详情弹窗桌面端');
  await admin.getByRole('heading', { name: /的报名详情$/ }).waitFor();
  await screenshot(admin, 'admin-registration-detail-desktop.png', '报名详情弹窗桌面端');
  await admin.getByRole('button', { name: '关闭报名详情' }).click();
} else {
  issues.push('报名管理桌面端: 没有可用于详情弹窗验收的报名');
}

const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
});
const mobile = await mobileContext.newPage();
watch(mobile, 'mobile');
await mobile.goto(webBase, { waitUntil: 'networkidle' });
await screenshot(mobile, 'web-home-mobile.png', '前台首页手机端');
await mobile.goto(`${webBase}/register`, { waitUntil: 'networkidle' });
await screenshot(mobile, 'web-register-mobile.png', '报名页手机端');
await mobile.goto(`${webBase}/faq`, { waitUntil: 'networkidle' });
await mobile.locator('.faq-page').waitFor();
await screenshot(mobile, 'web-faq-mobile.png', 'FAQ 独立页手机端');

const mobileAdmin = await mobileContext.newPage();
watch(mobileAdmin, 'admin-mobile');
await mobileAdmin.goto(`${adminBase}/login`, { waitUntil: 'networkidle' });
await screenshot(mobileAdmin, 'admin-login-mobile.png', '后台登录手机端');
await loginAdmin(mobileAdmin);
await screenshot(mobileAdmin, 'admin-events-mobile.png', '管理中心大会列表手机端');

for (const [path, heading, file, label] of managementSurfaces) {
  await mobileAdmin.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
  await mobileAdmin.getByRole('heading', { name: heading }).waitFor();
  await screenshot(
    mobileAdmin,
    file.replace('-desktop', '-mobile'),
    label.replace('桌面端', '手机端'),
  );
}

await mobileAdmin.goto(`${adminBase}/manage/users`, { waitUntil: 'networkidle' });
const mobileCustomerView = mobileAdmin.getByRole('button', { name: /^(编辑|查看)$/ }).first();
if (await mobileCustomerView.count()) {
  await mobileCustomerView.click();
  await mobileAdmin.locator('.customer-detail-dialog[open]').waitFor();
  await assertCenteredDialog(mobileAdmin, '.customer-detail-dialog[open]', '用户详情弹窗手机端');
  await screenshot(mobileAdmin, 'admin-user-detail-mobile.png', '用户详情弹窗手机端');
  await mobileAdmin.getByRole('button', { name: '关闭用户详情' }).click();
  await mobileAdmin.locator('.customer-detail-dialog').waitFor({ state: 'detached' });
  const mobileCustomerMore = mobileAdmin.getByRole('button', { name: '更多' }).first();
  await mobileCustomerMore.click();
  const mobileCustomerDelete = mobileAdmin.getByRole('button', { name: '删除用户' }).first();
  if (await mobileCustomerDelete.count()) {
    await mobileCustomerDelete.dispatchEvent('click');
    await mobileAdmin.locator('.customer-delete-dialog[open]').waitFor();
    await assertCenteredDialog(mobileAdmin, '.customer-delete-dialog[open]', '用户删除确认手机端');
    await screenshot(mobileAdmin, 'admin-user-delete-mobile.png', '用户删除确认手机端');
    await mobileAdmin.getByRole('button', { name: '取消' }).click();
  }
} else {
  issues.push('用户管理手机端: 没有可用于弹窗验收的用户');
}

await mobileAdmin.goto(`${adminBase}${templateEditorPath}`, { waitUntil: 'networkidle' });
await mobileAdmin.locator('.template-editor-layout').waitFor();
await screenshot(mobileAdmin, 'admin-template-editor-mobile.png', '模板编辑器手机端');
await mobileAdmin.getByRole('button', { name: /图片资源/ }).click();
await screenshot(mobileAdmin, 'admin-template-assets-mobile.png', '模板图片资源手机端');

for (const [path, heading, file, label] of adminSurfaces) {
  await mobileAdmin.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
  await mobileAdmin.getByRole('heading', { name: heading }).waitFor();
  await screenshot(
    mobileAdmin,
    file.replace('-desktop', '-mobile'),
    label.replace('桌面端', '手机端'),
  );
}

await mobileAdmin.goto(`${adminBase}${eventUnavailablePath}`, { waitUntil: 'networkidle' });
await mobileAdmin.getByRole('heading', { name: '未找到这场大会' }).waitFor();
await screenshot(mobileAdmin, 'admin-event-unavailable-mobile.png', '大会上下文不可用状态手机端');

await mobileAdmin.goto(`${adminBase}${eventBase}/registrations`, { waitUntil: 'networkidle' });
const mobileRegistrationView = mobileAdmin.getByRole('button', { name: '查看' }).first();
if (await mobileRegistrationView.count()) {
  await mobileRegistrationView.click();
  await mobileAdmin.locator('.registration-detail-dialog[open]').waitFor();
  await assertCenteredDialog(
    mobileAdmin,
    '.registration-detail-dialog[open]',
    '报名详情弹窗手机端',
  );
  await mobileAdmin.getByRole('heading', { name: /的报名详情$/ }).waitFor();
  await screenshot(mobileAdmin, 'admin-registration-detail-mobile.png', '报名详情弹窗手机端');
  await mobileAdmin.getByRole('button', { name: '关闭报名详情' }).click();
} else {
  issues.push('报名管理手机端: 没有可用于详情弹窗验收的报名');
}

for (const [path, heading, file, label] of standaloneAdminSurfaces) {
  await mobileAdmin.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
  await mobileAdmin.getByRole('heading', { name: heading }).waitFor();
  await screenshot(
    mobileAdmin,
    file.replace('-desktop', '-mobile'),
    label.replace('桌面端', '手机端'),
  );
}

await mobileContext.close();
await desktop.close();

const reportedIssues = issues.map((issue) => redactVisualDiagnostic(issue));
console.info(JSON.stringify({ checked, issues: reportedIssues, output }, null, 2));
if (reportedIssues.length) {
  throw new Error(`Visual assertions failed: ${reportedIssues.join(' | ')}`);
}
}

try {
  await runVisualSmoke();
} catch (error) {
  const report = await captureVisualFailure({ browser, output, error });
  console.error(JSON.stringify({ visualFailure: report, output }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser?.isConnected()) await browser.close().catch(() => undefined);
}
