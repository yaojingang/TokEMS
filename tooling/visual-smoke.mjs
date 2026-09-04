import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { DEMO_EVENT, DEMO_IDS } from '../packages/contracts/dist/index.js';
import { captureVisualFailure, redactVisualDiagnostic } from './lib/visual-evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'test-results/visual');
const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:8088';
const adminBase = process.env.ADMIN_BASE_URL ?? 'http://admin.localhost:8088/admin';
const visualScope = process.env.VISUAL_SCOPE ?? 'all';
const includeWeb = visualScope !== 'admin';
const adminApiBase =
  process.env.ADMIN_API_BASE_URL ??
  process.env.API_BASE_URL ??
  process.env.API_BASE ??
  new URL('/api/v1', adminBase).toString().replace(/\/$/u, '');
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

  async function mockNativePaymentPreparation(page) {
    await page.route('**/payments/wechat/*/native', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const pathname = new URL(route.request().url()).pathname;
      const orderId = pathname.match(/\/payments\/wechat\/([^/]+)\/native$/u)?.[1];
      if (!orderId) {
        await route.continue();
        return;
      }
      const attemptId = `visual-${Date.now()}`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          orderId,
          channel: 'native',
          attemptId,
          outTradeNo: attemptId,
          codeUrl: 'weixin://wxpay/bizpayurl?pr=tokems-visual-smoke',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }),
      });
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
        if (element.classList.contains('sr-only')) return false;
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

  async function settleScroll(page, locator) {
    await locator.scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
        ),
    );
  }

  async function loginAdmin(page) {
    await page.getByLabel('用户名').fill(adminUsername);
    await page.getByLabel('密码').fill(adminPassword);
    await page.getByRole('button', { name: '进入运营台' }).click();
    await page.waitForURL(
      (url) => /\/events\/\d+\//.test(url.pathname) || url.pathname.endsWith('/manage/events'),
    );
  }

  async function assertSettingsWorkflow(page, label) {
    await page.goto(`${adminBase}/manage/settings/customers`, { waitUntil: 'networkidle' });
    const policyVersion = page.locator('#customer-privacy-version');
    const originalVersion = await policyVersion.inputValue();
    const changedVersion =
      originalVersion === 'visual-review' ? 'visual-review-2' : 'visual-review';
    const saveBar = page.locator('form[data-settings-form] > .settings-form-actions');

    await policyVersion.fill(changedVersion);
    await saveBar.waitFor();
    await saveBar.getByRole('button', { name: '放弃更改' }).click();
    await saveBar.waitFor({ state: 'hidden' });
    if ((await policyVersion.inputValue()) !== originalVersion) {
      issues.push(`${label}: 放弃更改后没有恢复隐私政策版本`);
    }
    if (await saveBar.isVisible()) {
      issues.push(`${label}: 放弃更改后保存条仍然可见`);
    }

    await policyVersion.fill(changedVersion);
    const cancelDialogPromise = page.waitForEvent('dialog');
    const cancelledNavigation = page.getByRole('link', { name: /短信服务/ }).click();
    const cancelDialog = await cancelDialogPromise;
    if (cancelDialog.type() !== 'confirm') {
      issues.push(`${label}: 未保存离页提示类型为 ${cancelDialog.type()}`);
    }
    await cancelDialog.dismiss();
    await cancelledNavigation;
    if (!new URL(page.url()).pathname.endsWith('/manage/settings/customers')) {
      issues.push(`${label}: 取消离页后仍切换了设置模块`);
    }
    if ((await policyVersion.inputValue()) !== changedVersion || !(await saveBar.isVisible())) {
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
    await saveBar.getByRole('button', { name: '保存账号与合规设置' }).click();
    await saveBar.getByText('正在保存设置').waitFor();
    const busyDialogPromise = page.waitForEvent('dialog');
    const busyNavigation = page.getByRole('link', { name: /短信服务/ }).click();
    const busyDialog = await busyDialogPromise;
    if (busyDialog.type() !== 'alert' || !busyDialog.message().includes('正在保存')) {
      issues.push(`${label}: 保存期间没有给出明确的离页阻止提示`);
    }
    await busyDialog.accept();
    await busyNavigation;
    if (!new URL(page.url()).pathname.endsWith('/manage/settings/customers')) {
      issues.push(`${label}: 保存请求进行中仍切换了设置模块`);
    }
    await page.locator('.save-status.error').waitFor();
    await page.unroute('**/admin/organization/settings', delaySettingsPatch);
    await saveBar.getByRole('button', { name: '放弃更改' }).click();

    await page.goto(`${adminBase}/manage/settings/team`, { waitUntil: 'networkidle' });
    const invitationEmail = page.locator('#invite-member-email');
    if (await invitationEmail.count()) {
      await invitationEmail.fill('draft-review@example.com');
      const teamDialogPromise = page.waitForEvent('dialog');
      const teamNavigation = page.getByRole('link', { name: /支付服务/ }).click();
      const teamDialog = await teamDialogPromise;
      await teamDialog.dismiss();
      await teamNavigation;
      if (!new URL(page.url()).pathname.endsWith('/manage/settings/team')) {
        issues.push(`${label}: 取消离页后团队邀请草稿仍被丢弃`);
      }
      const acceptDialogPromise = page.waitForEvent('dialog');
      const acceptedNavigation = page.getByRole('link', { name: /支付服务/ }).click();
      const acceptDialog = await acceptDialogPromise;
      await acceptDialog.accept();
      await acceptedNavigation;
      await page.waitForURL(/\/manage\/settings\/payment$/);
    }

    checked.push(label);
  }

  async function assertLiveSettingsConfirmDialog(page, eventPath, label) {
    await page.goto(`${adminBase}${eventPath}/settings/general`, { waitUntil: 'networkidle' });
    const address = page.locator('#event-address');
    const originalAddress = await address.inputValue();
    await address.fill(`${originalAddress} · 交互验收`);
    const saveButton = page.getByRole('button', { name: '保存修改' });
    await saveButton.click();
    const dialog = page.locator('.admin-confirm-dialog[open]');
    await dialog.waitFor();
    await assertCenteredDialog(page, '.admin-confirm-dialog[open]', label);
    await dialog.getByRole('button', { name: '返回检查' }).click();
    await dialog.waitFor({ state: 'hidden' });
    if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) !== '保存修改') {
      issues.push(`${label}: 关闭确认弹窗后没有恢复保存按钮焦点`);
    }
    await address.fill(originalAddress);
    checked.push(label);
  }

  async function assertEventSlugDialog(page, file, label) {
    await page.goto(`${adminBase}/manage/events`, { waitUntil: 'networkidle' });
    const editButton = page.getByRole('button', { name: '修改短地址' }).first();
    if (!(await editButton.count())) {
      issues.push(`${label}: 没有可用于短地址弹窗验收的大会`);
      return;
    }
    await editButton.click();
    const dialog = page.locator('.admin-confirm-dialog[open]');
    await dialog.waitFor();
    await assertCenteredDialog(page, '.admin-confirm-dialog[open]', label);
    await dialog.getByRole('heading', { name: '修改大会短地址' }).waitFor();
    await screenshot(page, file, label);
    await dialog.getByRole('button', { name: '返回检查' }).click();
    await dialog.waitFor({ state: 'hidden' });
  }

  async function assertEventSwitcher(page, eventPath, file, label) {
    await page.goto(`${adminBase}${eventPath}/overview`, { waitUntil: 'networkidle' });
    const trigger = page.locator('.event-context-switcher__trigger');
    const panel = page.locator('.event-switcher-panel[role="dialog"]');
    if (await page.getByText('CURRENT EVENT', { exact: true }).count()) {
      issues.push(`${label}: 大会切换器仍显示 CURRENT EVENT 冗余标题`);
    }
    await trigger.click();
    if (!(await panel.isVisible())) {
      issues.push(`${label}: 当前大会按钮不能打开切换器`);
    }
    await panel.waitFor();
    const sidebarScrollLeft = await page
      .locator('.admin-sidebar')
      .evaluate((element) => element.scrollLeft);
    if (sidebarScrollLeft > 0) {
      issues.push(`${label}: 打开切换器后侧栏发生了横向滚动`);
    }
    await panel.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const listbox = page.locator('.event-switcher-options[role="listbox"]');
    if (await listbox.count()) {
      const beforeArrow = await page.evaluate(() => document.activeElement?.textContent?.trim());
      await page.keyboard.press('ArrowDown');
      const afterArrow = await page.evaluate(() => document.activeElement?.textContent?.trim());
      if (beforeArrow === afterArrow) {
        issues.push(`${label}: listbox 语义缺少方向键焦点行为`);
      }
    }
    await screenshot(page, file, label);
    await page.keyboard.press('Escape');
    await page.locator('.event-switcher-panel').waitFor({ state: 'hidden' });
    if (!(await trigger.evaluate((element) => element === document.activeElement))) {
      issues.push(`${label}: Escape 关闭后没有恢复大会切换按钮焦点`);
    }
  }

  async function assertInvalidRecentEventNotice(page, label) {
    await page.evaluate(async (apiBase) => {
      const token = localStorage.getItem('conference.admin.token');
      if (!token) throw new Error('管理员登录令牌不存在');
      const response = await fetch(`${apiBase}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !contentType.includes('application/json')) {
        throw new Error(`管理员身份读取失败（HTTP ${response.status}）`);
      }
      const identity = await response.json();
      const key = `conference.admin.lastEventId.${identity.organization.id}.${identity.user.id}`;
      localStorage.setItem(key, '2147483647');
    }, adminApiBase);
    await page.goto(`${adminBase}/login`, { waitUntil: 'networkidle' });
    await page.waitForURL(
      (url) => /\/events\/\d+\//.test(url.pathname) || url.pathname.endsWith('/manage/events'),
    );
    const notice = page.locator('.admin-context-notice');
    await notice.waitFor();
    const closeButton = notice.getByRole('button', { name: '关闭提示' });
    const size = await closeButton.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    if (size.width < 40 || size.height < 40) {
      issues.push(
        `${label}: 关闭提示按钮触控区域不足 40px（${Math.round(size.width)}×${Math.round(size.height)}）`,
      );
    }
    await closeButton.click();
    if (await notice.isVisible()) issues.push(`${label}: 关闭提示后提示仍然可见`);
    checked.push(label);
  }

  async function assertRegistrationToolbarLayout(page, label) {
    const layout = await page.locator('.registration-toolbar').evaluate((toolbar) => {
      const toolbarRect = toolbar.getBoundingClientRect();
      const titlebar = document.querySelector('.registration-page-titlebar');
      const titlebarRect = titlebar?.getBoundingClientRect();
      const searchStyle = getComputedStyle(toolbar.querySelector('.admin-search'));
      const controls = [...toolbar.querySelectorAll('.registration-toolbar-filters > *')].map(
        (element) => {
          const rect = element.getBoundingClientRect();
          return {
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            left: Math.round(rect.left),
          };
        },
      );
      const actions = [...document.querySelectorAll('.registration-page-actions > *')].map(
        (element) => {
          const rect = element.getBoundingClientRect();
          return {
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            backgroundColor: getComputedStyle(element).backgroundColor,
          };
        },
      );
      return {
        viewportWidth: window.innerWidth,
        titlebar: titlebarRect
          ? {
              right: Math.round(titlebarRect.right),
            }
          : null,
        toolbar: {
          top: Math.round(toolbarRect.top),
          right: Math.round(toolbarRect.right),
          bottom: Math.round(toolbarRect.bottom),
          left: Math.round(toolbarRect.left),
        },
        searchBorder: {
          color: searchStyle.borderTopColor,
          style: searchStyle.borderTopStyle,
          width: searchStyle.borderTopWidth,
        },
        controls,
        actions,
      };
    });
    if (layout.controls.length !== 6) {
      issues.push(`${label}: 预期 6 个筛选控件，实际为 ${layout.controls.length} 个`);
      return;
    }
    if (layout.viewportWidth > 860) {
      const controlTops = layout.controls.map((control) => control.top);
      if (Math.max(...controlTops) - Math.min(...controlTops) > 1) {
        issues.push(`${label}: 桌面端筛选控件没有保持同一基线`);
      }
      if (
        !layout.titlebar ||
        !layout.actions.length ||
        layout.actions.some((action) => action.bottom > layout.toolbar.top) ||
        Math.abs(layout.actions.at(-1).right - layout.titlebar.right) > 1
      ) {
        issues.push(`${label}: 页面操作没有保持在标题区右上角`);
      }
    }
    if (layout.actions.some((action) => action.backgroundColor !== 'rgba(0, 0, 0, 0)')) {
      issues.push(`${label}: 标题区操作按钮仍带有背景色`);
    }
    if (
      layout.searchBorder.width !== '1px' ||
      layout.searchBorder.style !== 'solid' ||
      layout.searchBorder.color === 'rgba(0, 0, 0, 0)'
    ) {
      issues.push(`${label}: 搜索框缺少 1px 浅灰色实线边框`);
    }
    const escaped = layout.controls.some(
      (control) =>
        control.left < layout.toolbar.left ||
        control.right > layout.toolbar.right ||
        control.top < layout.toolbar.top ||
        control.bottom > layout.toolbar.bottom,
    );
    if (escaped) issues.push(`${label}: 筛选控件超出工具栏边界`);
    checked.push(label);
  }

  async function assertRegistrationTableLayout(page, label) {
    const firstRow = page.locator('.registration-table tbody tr').first();
    if (!(await firstRow.count())) {
      issues.push(`${label}: 没有可用于排版验收的报名记录`);
      return;
    }
    const layout = await firstRow.evaluate((row) => {
      const statusCell = row.querySelector('.registration-status-column');
      const statusDetail = row.querySelector('.registration-status-detail');
      const actionCell = row.querySelector('.registration-action-column');
      const action = row.querySelector('.registration-view-action');
      const textLines = (element) => {
        if (!element) return 0;
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      };
      return {
        statusCellWidth: statusCell?.getBoundingClientRect().width ?? 0,
        statusDetailLines: textLines(statusDetail),
        statusDetailWhiteSpace: statusDetail ? getComputedStyle(statusDetail).whiteSpace : '',
        actionCellWidth: actionCell?.getBoundingClientRect().width ?? 0,
        actionWidth: action?.getBoundingClientRect().width ?? 0,
        actionTextLines: textLines(action),
        actionWhiteSpace: action ? getComputedStyle(action).whiteSpace : '',
      };
    });
    if (layout.statusCellWidth < 132 || layout.statusDetailWhiteSpace !== 'nowrap') {
      issues.push(`${label}: 业务状态列宽度或单行约束失效`);
    }
    if (layout.statusDetailLines !== 1) {
      issues.push(`${label}: 业务状态详情断成 ${layout.statusDetailLines} 行`);
    }
    if (
      layout.actionCellWidth < 84 ||
      layout.actionWidth < 56 ||
      layout.actionWhiteSpace !== 'nowrap'
    ) {
      issues.push(`${label}: 查看操作列宽度或单行约束失效`);
    }
    if (layout.actionTextLines !== 1) {
      issues.push(`${label}: 查看按钮文字断成 ${layout.actionTextLines} 行`);
    }
    checked.push(label);
  }

  async function loginCustomer(page, mobileNumber) {
    await page.goto(`${webBase}/account`, { waitUntil: 'networkidle' });
    const loginButton = page.getByRole('button', { name: '登录个人中心' });
    if (!(await loginButton.count())) return;
    await loginButton.click();
    const authPanel = page.locator('.auth-dialog__panel');
    await authPanel.waitFor();
    await page.getByPlaceholder('请输入 11 位手机号').fill(mobileNumber);
    await page.getByRole('button', { name: '获取验证码' }).click();
    const codeText = await page.locator('.auth-development-code strong').textContent();
    const code = codeText?.match(/\d{6}/u)?.[0];
    if (!code) throw new Error('个人中心手机端: 演示环境未返回可用验证码');
    await page.getByPlaceholder('6 位验证码').fill(code);
    await page.locator('.auth-consent input').check();
    await page.getByRole('button', { name: '验证并继续' }).click();
    await page.locator('.auth-dialog').waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: '个人中心', level: 1 }).waitFor();
  }

  async function captureCustomerLoginMobile(page) {
    await page.goto(`${webBase}/account`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '登录个人中心' }).click();
    await page.locator('.auth-dialog__panel').waitFor();
    await page.waitForTimeout(220);
    const authMetrics = await page.evaluate(() => {
      const panel = document.querySelector('.auth-dialog__panel');
      const close = document.querySelector('.auth-dialog__close');
      const input = document.querySelector('.auth-mobile-input input');
      const panelRect = panel?.getBoundingClientRect();
      const closeRect = close?.getBoundingClientRect();
      return {
        panelTop: panelRect?.top ?? -1,
        panelBottom: panelRect?.bottom ?? Number.POSITIVE_INFINITY,
        closeSize: closeRect ? Math.min(closeRect.width, closeRect.height) : 0,
        inputFontSize: input ? Number.parseFloat(getComputedStyle(input).fontSize) : 0,
        viewportHeight: window.innerHeight,
      };
    });
    if (authMetrics.panelTop < 0 || authMetrics.panelBottom > authMetrics.viewportHeight) {
      issues.push('个人中心登录手机端: 登录面板超出可视区域');
    }
    if (authMetrics.closeSize < 44) {
      issues.push(`个人中心登录手机端: 关闭按钮触控尺寸仅 ${authMetrics.closeSize}px`);
    }
    if (authMetrics.inputFontSize < 16) {
      issues.push(`个人中心登录手机端: 手机号输入字号仅 ${authMetrics.inputFontSize}px`);
    }
    await page.screenshot({
      path: resolve(output, 'web-account-login-mobile.png'),
      fullPage: false,
    });
    await page.locator('.auth-dialog__close').click();
    await page.locator('.auth-dialog').waitFor({ state: 'detached' });
  }

  async function assertAccountMobileBaseline(page, label) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#overview').waitFor();
    await assertNoHorizontalOverflow(page, label);
    const layout = await page.evaluate(() => {
      const trigger = document.querySelector('.account-mobile-navigation__trigger');
      const desktopNavigation = document.querySelector('.account-nav--desktop');
      const mobileIdentity = document.querySelector('.account-rail__identity');
      const primary = document.querySelector('.account-pass__primary');
      const rect = (element) => {
        const value = element?.getBoundingClientRect();
        return value
          ? {
              top: Math.round(value.top),
              bottom: Math.round(value.bottom),
              height: Math.round(value.height),
            }
          : null;
      };
      return {
        viewportHeight: window.innerHeight,
        trigger: rect(trigger),
        primary: rect(primary),
        mobileIdentityDisplay: mobileIdentity ? getComputedStyle(mobileIdentity).display : null,
        desktopNavigationDisplay: desktopNavigation
          ? getComputedStyle(desktopNavigation).display
          : null,
        zoomProneControlCount: [
          ...document.querySelectorAll(
            'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea',
          ),
        ].filter((element) => {
          const style = getComputedStyle(element);
          const rectValue = element.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rectValue.width > 0 &&
            rectValue.height > 0 &&
            Number.parseFloat(style.fontSize) < 16
          );
        }).length,
      };
    });
    if (!layout.trigger || layout.trigger.height < 44) {
      issues.push(`${label}: 模块导航触控高度不足 44px`);
    }
    if (layout.desktopNavigationDisplay !== 'none') {
      issues.push(`${label}: 桌面账户导航仍在移动端显示`);
    }
    if (page.viewportSize()?.width <= 760 && layout.mobileIdentityDisplay !== 'none') {
      issues.push(`${label}: 重复的账户身份卡仍在手机端显示`);
    }
    if (layout.zoomProneControlCount) {
      issues.push(`${label}: 存在 ${layout.zoomProneControlCount} 个小于 16px 的表单控件`);
    }
    if (!layout.primary || layout.primary.bottom > layout.viewportHeight) {
      issues.push(
        `${label}: 大会主操作未进入首屏（按钮底部 ${layout.primary?.bottom ?? '缺失'}px，视口 ${layout.viewportHeight}px）`,
      );
    }

    const trigger = page.locator('.account-mobile-navigation__trigger');
    await trigger.click();
    const links = page.locator('.account-mobile-navigation__links a');
    if ((await links.count()) !== 7) {
      issues.push(`${label}: 模块导航预期 7 个入口，实际为 ${await links.count()} 个`);
    }
    const undersizedLinks = await links.evaluateAll((elements) =>
      elements
        .map((element) => Math.round(element.getBoundingClientRect().height))
        .filter((height) => height < 44),
    );
    if (undersizedLinks.length) {
      issues.push(`${label}: 模块导航存在小于 44px 的入口`);
    }
    const logoutButton = page.locator('.account-mobile-navigation__meta button');
    if (
      (await logoutButton.count()) &&
      (await logoutButton.evaluate((element) => element.offsetHeight)) < 44
    ) {
      issues.push(`${label}: 导航内退出按钮触控高度不足 44px`);
    }
    await page.keyboard.press('Escape');
    if (await page.locator('#account-mobile-navigation-panel').isVisible()) {
      issues.push(`${label}: Escape 后模块导航仍然展开`);
    }
    if (!(await trigger.evaluate((element) => document.activeElement === element))) {
      issues.push(`${label}: Escape 关闭导航后焦点没有回到触发按钮`);
    }
    await trigger.click();
    await links.first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const panel = document.querySelector('#account-mobile-navigation-panel');
      return panel && getComputedStyle(panel).display === 'none';
    });
    const navigationFocusRestored = await page
      .waitForFunction(
        () => document.activeElement?.classList.contains('account-mobile-navigation__trigger'),
        undefined,
        { timeout: 2500 },
      )
      .then(() => true)
      .catch(() => false);
    if (!navigationFocusRestored) {
      issues.push(`${label}: 选择模块后焦点没有回到导航触发按钮`);
    }
    checked.push(label);
  }

  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await desktop.newPage();
  await mockNativePaymentPreparation(page);
  watch(page, 'desktop');
  let speakerDetailUrl;
  let visualCustomerMobile = '';
  let visualTicketUrl = '';
  let visualCustomerStorageState;

  if (includeWeb) {
    await page.goto(webBase, { waitUntil: 'networkidle' });
    await page.locator('h1.hero-h').waitFor();
    await screenshot(page, 'web-home-desktop.png', '前台首页桌面端');
    const firstSpeakerHref = await page.locator('.spk-card').first().getAttribute('href');
    if (!firstSpeakerHref?.match(/^\/speakers\/[a-z]{4}$/u)) {
      issues.push(`前台首页桌面端: 嘉宾卡片没有使用短地址，实际为 ${firstSpeakerHref ?? '空'}`);
    }
    speakerDetailUrl = new URL(firstSpeakerHref ?? '/', webBase).toString();
    await page.goto(speakerDetailUrl, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: DEMO_EVENT.speakers[0].name, level: 1 }).waitFor();
    await screenshot(page, 'web-speaker-detail-desktop.png', '嘉宾详情页桌面端');

    await page.goto(`${webBase}/register`, { waitUntil: 'networkidle' });
    await screenshot(page, 'web-register-desktop.png', '报名页桌面端');
    await page.goto(`${webBase}/faq`, { waitUntil: 'networkidle' });
    await page.locator('.faq-page').waitFor();
    await screenshot(page, 'web-faq-desktop.png', 'FAQ 独立页桌面端');
    await page.goto(`${webBase}/register`, { waitUntil: 'networkidle' });
    const registrationSubmitButton = page.locator('form.flow-card button[type="submit"]');
    if (
      (await page.locator('#registration-mobile').count()) &&
      (await registrationSubmitButton.count())
    ) {
      const visualRunId = Date.now().toString();
      visualCustomerMobile = `139${visualRunId.slice(-8)}`;
      const registrationMobile = page.locator('#registration-mobile');
      if (!(await registrationMobile.isEditable())) {
        await loginCustomer(page, visualCustomerMobile);
        await page.goto(`${webBase}/register`, { waitUntil: 'networkidle' });
      }
      const verifiedMobile = await page.locator('#registration-mobile').inputValue();
      if (await page.locator('#registration-mobile').isEditable()) {
        await page.locator('#registration-mobile').fill(visualCustomerMobile);
      } else if (!verifiedMobile.endsWith(visualCustomerMobile)) {
        throw new Error(`报名页登录手机号未正确回填，实际为 ${verifiedMobile || '空'}`);
      }
      for (const [field, value] of Object.entries({
        name: '视觉测试员',
        email: `visual-${visualRunId}@example.com`,
        city: '深圳',
        company: '大会视觉实验室',
        title: '质量负责人',
      })) {
        const input = page.locator(`#registration-${field}`);
        if (await input.isVisible()) await input.fill(value);
      }
      await page.locator('#registration-terms-accepted').check();
      await page.locator('form.flow-card button[type="submit"]').click();
      await page.waitForURL(/\/(order|ticket)\//);
      visualCustomerStorageState = await desktop.storageState();
      if (new URL(page.url()).pathname.includes('/order/')) {
        await screenshot(page, 'web-order-desktop.png', '订单页桌面端');
      } else {
        await page.getByText('现场扫码签到').waitFor();
        await screenshot(page, 'web-ticket-desktop.png', '电子票桌面端');
      }
    }
  }

  const admin = await desktop.newPage();
  watch(admin, 'admin-desktop');
  await admin.goto(`${adminBase}/login`, { waitUntil: 'networkidle' });
  await screenshot(admin, 'admin-login-desktop.png', '后台登录桌面端');
  await loginAdmin(admin);
  if (/\/events\/\d+\//.test(new URL(admin.url()).pathname)) {
    await admin.locator('.event-context-switcher').waitFor();
    await screenshot(admin, 'admin-default-event-desktop.png', '登录默认大会桌面端');
  }
  await admin.goto(`${adminBase}/manage/events`, { waitUntil: 'networkidle' });
  await admin.getByRole('heading', { name: '大会管理' }).waitFor();
  await screenshot(admin, 'admin-events-desktop.png', '管理中心大会列表桌面端');
  await assertEventSlugDialog(admin, 'admin-event-slug-dialog-desktop.png', '大会短地址弹窗桌面端');

  const standaloneAdminSurfaces = [
    ['/accept-invitation', '接受组织邀请', 'admin-invitation-desktop.png', '邀请接受桌面端'],
    ['/403', '当前账号无权访问此页面', 'admin-forbidden-desktop.png', '无权限页桌面端'],
    [
      '/route-not-found',
      '这个页面已移动或不存在',
      'admin-not-found-desktop.png',
      '页面不存在桌面端',
    ],
  ];
  for (const [path, heading, file, label] of standaloneAdminSurfaces) {
    await admin.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
    await admin.getByRole('heading', { name: heading }).waitFor();
    await screenshot(admin, file, label);
  }

  const managementSurfaces = [
    ['/manage/users', '用户管理', 'admin-users-desktop.png', '用户管理桌面端'],
    ['/manage/templates', '模板管理', 'admin-templates-desktop.png', '模板管理桌面端'],
    ['/manage/settings', '支付服务', 'admin-system-settings-desktop.png', '管理中心设置桌面端'],
    ['/manage/settings/sms', '短信服务', 'admin-sms-settings-desktop.png', '短信服务设置桌面端'],
    [
      '/manage/settings/customers',
      '账号与合规',
      'admin-customer-settings-desktop.png',
      '账号与合规设置桌面端',
    ],
    [
      '/manage/settings/team',
      '管理员与权限',
      'admin-team-settings-desktop.png',
      '管理员权限设置桌面端',
    ],
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
    await admin.waitForFunction(() =>
      /^(编辑|查看)$/.test(document.activeElement?.textContent?.trim() ?? ''),
    );
    const desktopCustomerMore = admin.getByRole('button', { name: '更多' }).first();
    await settleScroll(admin, desktopCustomerMore);
    await desktopCustomerMore.click();
    const desktopCustomerDelete = admin.getByRole('button', { name: '删除用户' }).first();
    await desktopCustomerDelete.waitFor();
    await desktopCustomerDelete.dispatchEvent('click');
    await admin.locator('.customer-delete-dialog[open]').waitFor();
    await assertCenteredDialog(admin, '.customer-delete-dialog[open]', '用户删除确认桌面端');
    await screenshot(admin, 'admin-user-delete-desktop.png', '用户删除确认桌面端');
    await admin.getByRole('button', { name: '取消' }).click();
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
    [
      `${eventBase}/overview`,
      '第二届中国 GEO & AI 营销大会',
      'admin-dashboard-desktop.png',
      '大会概览桌面端',
    ],
    [
      `${eventBase}/settings/general`,
      '基本信息',
      'admin-event-settings-desktop.png',
      '大会基本设置桌面端',
    ],
    [
      `${eventBase}/settings/general#public-page`,
      '公开页面展示',
      'admin-publishing-desktop.png',
      '公开页面设置桌面端',
    ],
    [
      `${eventBase}/settings/registration`,
      '报名设置',
      'admin-registration-settings-desktop.png',
      '报名设置桌面端',
    ],
    [`${eventBase}/settings/form`, '报名表与条款', 'admin-forms-desktop.png', '表单条款桌面端'],
    [`${eventBase}/speakers`, '嘉宾管理', 'admin-speakers-desktop.png', '嘉宾管理桌面端'],
    [
      `${eventBase}/speakers/${DEMO_EVENT.speakers[0].id}`,
      '编辑嘉宾资料',
      'admin-speaker-editor-desktop.png',
      '嘉宾编辑页桌面端',
    ],
    [
      `${eventBase}/settings/changes`,
      '修改记录',
      'admin-change-history-desktop.png',
      '修改记录桌面端',
    ],
    [`${eventBase}/registrations`, '报名管理', 'admin-registrations-desktop.png', '报名管理桌面端'],
    [`${eventBase}/invoices`, '发票管理', 'admin-invoices-desktop.png', '发票管理桌面端'],
    [`${eventBase}/notifications`, '通知中心', 'admin-notifications-desktop.png', '通知中心桌面端'],
    [`${eventBase}/activity`, '审计日志与数据导出', 'admin-audit-desktop.png', '操作记录桌面端'],
  ];
  for (const [path, heading, file, label] of adminSurfaces) {
    await admin.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
    await admin.getByRole('heading', { name: heading }).waitFor();
    await screenshot(admin, file, label);
  }
  await admin.goto(`${adminBase}${eventBase}/orders`, { waitUntil: 'networkidle' });
  await admin.waitForURL((url) => url.pathname.endsWith(`${eventBase}/registrations`));
  await admin.getByRole('heading', { name: '报名管理' }).waitFor();

  await assertEventSwitcher(
    admin,
    eventBase,
    'admin-event-switcher-desktop.png',
    '大会切换器桌面端',
  );

  await assertLiveSettingsConfirmDialog(admin, eventBase, '保存生效确认弹窗桌面端');

  const eventUnavailablePath = '/events/2147483647/overview';
  await admin.goto(`${adminBase}${eventUnavailablePath}`, { waitUntil: 'networkidle' });
  await admin.getByRole('heading', { name: '未找到这场大会' }).waitFor();
  await screenshot(admin, 'admin-event-unavailable-desktop.png', '大会上下文不可用状态桌面端');

  await admin.goto(`${adminBase}${eventBase}/registrations`, { waitUntil: 'networkidle' });
  await assertRegistrationToolbarLayout(admin, '报名管理筛选栏桌面端');
  await assertRegistrationTableLayout(admin, '报名管理列表桌面端');
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
  const registrationView = admin.getByRole('link', { name: '查看' }).first();
  if (await registrationView.count()) {
    await registrationView.click();
    await admin.waitForURL(/\/registrations\/[^/]+/);
    await admin.locator('.registration-detail-page .registration-hero').waitFor();
    await screenshot(admin, 'admin-registration-detail-desktop.png', '报名详情页桌面端');
  } else {
    issues.push('报名管理桌面端: 没有可用于详情页验收的报名');
  }

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const mobile = await mobileContext.newPage();
  watch(mobile, 'mobile');
  if (includeWeb) {
    await mobile.goto(webBase, { waitUntil: 'networkidle' });
    await screenshot(mobile, 'web-home-mobile.png', '前台首页手机端');
    await mobile.goto(speakerDetailUrl, { waitUntil: 'networkidle' });
    await mobile.getByRole('heading', { name: DEMO_EVENT.speakers[0].name, level: 1 }).waitFor();
    await screenshot(mobile, 'web-speaker-detail-mobile.png', '嘉宾详情页手机端');
    await mobile.goto(`${webBase}/register`, { waitUntil: 'networkidle' });
    await screenshot(mobile, 'web-register-mobile.png', '报名页手机端');
    await mobile.goto(`${webBase}/faq`, { waitUntil: 'networkidle' });
    await mobile.locator('.faq-page').waitFor();
    await screenshot(mobile, 'web-faq-mobile.png', 'FAQ 独立页手机端');

    if (visualCustomerMobile) {
      await captureCustomerLoginMobile(mobile);
      if (visualCustomerStorageState?.cookies.length) {
        await mobileContext.addCookies(visualCustomerStorageState.cookies);
      }
      await mobile.goto(`${webBase}/account`, { waitUntil: 'networkidle' });
      await mobile.getByRole('heading', { name: '个人中心', level: 1 }).waitFor();
      await assertAccountMobileBaseline(mobile, '个人中心手机端');
      const ticketHref = await mobile.locator('.account-pass__primary').getAttribute('href');
      if (ticketHref?.startsWith('/ticket/')) {
        visualTicketUrl = new URL(ticketHref, webBase).toString();
      }
      await screenshot(mobile, 'web-account-mobile.png', '个人中心手机端');

      await mobile.setViewportSize({ width: 430, height: 932 });
      await mobile.goto(`${webBase}/account`, { waitUntil: 'networkidle' });
      await assertAccountMobileBaseline(mobile, '个人中心 430px 手机端');
      await screenshot(mobile, 'web-account-mobile-430.png', '个人中心 430px 手机端');
      await mobile.setViewportSize({ width: 375, height: 667 });
      await mobile.goto(`${webBase}/account`, { waitUntil: 'networkidle' });
      await assertAccountMobileBaseline(mobile, '个人中心 375px 紧凑手机端');
      await screenshot(mobile, 'web-account-mobile-375.png', '个人中心 375px 紧凑手机端');
      await mobile.setViewportSize({ width: 768, height: 1024 });
      await mobile.goto(`${webBase}/account`, { waitUntil: 'networkidle' });
      await assertAccountMobileBaseline(mobile, '个人中心 768px 平板端');
      await screenshot(mobile, 'web-account-tablet-768.png', '个人中心 768px 平板端');
      await mobile.setViewportSize({ width: 390, height: 844 });
      await mobile.goto(`${webBase}/account`, { waitUntil: 'networkidle' });

      const registrationDetailHref = await mobile
        .getByRole('link', { name: '报名详情' })
        .first()
        .getAttribute('href');
      if (registrationDetailHref) {
        await mobile.goto(new URL(registrationDetailHref, webBase).toString(), {
          waitUntil: 'networkidle',
        });
        await mobile.locator('.detail-panel').waitFor();
        const emptyDetailFooter = await mobile
          .locator('.detail-panel footer')
          .evaluateAll((elements) =>
            elements.some(
              (element) =>
                getComputedStyle(element).display !== 'none' && element.children.length === 0,
            ),
          );
        if (emptyDetailFooter) {
          issues.push('报名详情手机端: 无可用操作时仍显示空白操作栏');
        }
        await screenshot(mobile, 'web-account-registration-mobile.png', '报名详情手机端');

        const showcaseLink = mobile.getByRole('link', { name: '完善参会名片' });
        const showcaseHref = (await showcaseLink.count())
          ? await showcaseLink.getAttribute('href')
          : null;
        if (showcaseHref) {
          await mobile.goto(new URL(showcaseHref, webBase).toString(), {
            waitUntil: 'domcontentloaded',
          });
          await mobile.locator('.profile-editor').waitFor();
          await screenshot(mobile, 'web-account-showcase-mobile.png', '参会名片手机端');
        }

        await mobile.goto(new URL(registrationDetailHref, webBase).toString(), {
          waitUntil: 'networkidle',
        });
        const needsLink = mobile.getByRole('link', { name: '编辑参会需求' });
        const needsHref = (await needsLink.count()) ? await needsLink.getAttribute('href') : null;
        if (needsHref) {
          await mobile.goto(new URL(needsHref, webBase).toString(), {
            waitUntil: 'networkidle',
          });
          await mobile.locator('.needs-editor').waitFor();
          await screenshot(mobile, 'web-account-needs-mobile.png', '参会需求手机端');
        }
      } else {
        issues.push('个人中心手机端: 缺少可用于二级页面验收的报名详情入口');
      }

      await mobile.goto(`${webBase}/account/attendee-claim`, { waitUntil: 'networkidle' });
      await mobile.getByRole('heading', { name: '认领链接不完整', level: 2 }).waitFor();
      await screenshot(mobile, 'web-account-claim-mobile.png', '参会名额认领手机端');

      await mobile.goto(`${webBase}/account/invoices`, { waitUntil: 'networkidle' });
      await mobile.getByRole('heading', { name: '发票中心', level: 1 }).waitFor();
      await screenshot(mobile, 'web-account-invoices-mobile.png', '发票中心手机端');

      if (visualTicketUrl) {
        await mobile.goto(visualTicketUrl, { waitUntil: 'networkidle' });
        await mobile.getByText('现场扫码签到').waitFor();
        await screenshot(mobile, 'web-ticket-mobile.png', '电子票手机端');
      }
    } else {
      issues.push('个人中心手机端: 免费报名流程没有生成可登录的演示账号');
    }
  }

  const mobileAdmin = await mobileContext.newPage();
  watch(mobileAdmin, 'admin-mobile');
  await mobileAdmin.goto(`${adminBase}/login`, { waitUntil: 'networkidle' });
  await screenshot(mobileAdmin, 'admin-login-mobile.png', '后台登录手机端');
  await loginAdmin(mobileAdmin);
  if (/\/events\/\d+\//.test(new URL(mobileAdmin.url()).pathname)) {
    await mobileAdmin.getByRole('button', { name: '打开导航' }).click();
    await mobileAdmin.locator('.event-context-switcher').waitFor();
    await screenshot(mobileAdmin, 'admin-default-event-mobile.png', '登录默认大会手机端');
    await mobileAdmin.keyboard.press('Escape');
  }
  await assertInvalidRecentEventNotice(mobileAdmin, '失效大会偏好提示手机端');
  await mobileAdmin.goto(`${adminBase}/manage/events`, { waitUntil: 'networkidle' });
  await screenshot(mobileAdmin, 'admin-events-mobile.png', '管理中心大会列表手机端');
  await assertEventSlugDialog(
    mobileAdmin,
    'admin-event-slug-dialog-mobile.png',
    '大会短地址弹窗手机端',
  );

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
    await mobileAdmin.waitForFunction(() =>
      /^(编辑|查看)$/.test(document.activeElement?.textContent?.trim() ?? ''),
    );
    const mobileCustomerMore = mobileAdmin.getByRole('button', { name: '更多' }).first();
    await settleScroll(mobileAdmin, mobileCustomerMore);
    await mobileCustomerMore.click();
    const mobileCustomerDelete = mobileAdmin.getByRole('button', { name: '删除用户' }).first();
    await mobileCustomerDelete.waitFor();
    await mobileCustomerDelete.dispatchEvent('click');
    await mobileAdmin.locator('.customer-delete-dialog[open]').waitFor();
    await assertCenteredDialog(mobileAdmin, '.customer-delete-dialog[open]', '用户删除确认手机端');
    await screenshot(mobileAdmin, 'admin-user-delete-mobile.png', '用户删除确认手机端');
    await mobileAdmin.getByRole('button', { name: '取消' }).click();
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
  await mobileAdmin.goto(`${adminBase}${eventBase}/orders`, { waitUntil: 'networkidle' });
  await mobileAdmin.waitForURL((url) => url.pathname.endsWith(`${eventBase}/registrations`));
  await mobileAdmin.getByRole('heading', { name: '报名管理' }).waitFor();

  await assertEventSwitcher(
    mobileAdmin,
    eventBase,
    'admin-event-switcher-mobile.png',
    '大会切换器手机端',
  );

  await assertLiveSettingsConfirmDialog(mobileAdmin, eventBase, '保存生效确认弹窗手机端');

  await mobileAdmin.goto(`${adminBase}${eventUnavailablePath}`, { waitUntil: 'networkidle' });
  await mobileAdmin.getByRole('heading', { name: '未找到这场大会' }).waitFor();
  await screenshot(mobileAdmin, 'admin-event-unavailable-mobile.png', '大会上下文不可用状态手机端');

  await mobileAdmin.goto(`${adminBase}${eventBase}/registrations`, { waitUntil: 'networkidle' });
  await assertRegistrationToolbarLayout(mobileAdmin, '报名管理筛选栏手机端');
  await assertRegistrationTableLayout(mobileAdmin, '报名管理列表手机端');
  const mobileRegistrationView = mobileAdmin.getByRole('link', { name: '查看' }).first();
  if (await mobileRegistrationView.count()) {
    await mobileRegistrationView.click();
    await mobileAdmin.waitForURL(/\/registrations\/[^/]+/);
    await mobileAdmin.locator('.registration-detail-page .registration-hero').waitFor();
    await screenshot(mobileAdmin, 'admin-registration-detail-mobile.png', '报名详情页手机端');
  } else {
    issues.push('报名管理手机端: 没有可用于详情页验收的报名');
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
