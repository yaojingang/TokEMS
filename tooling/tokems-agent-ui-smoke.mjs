import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '.codex-artifacts', 'tokems-agent-ui');
const adminBase = process.env.ADMIN_BASE_URL ?? 'http://localhost:3200/admin';
const chromePath =
  process.env.CHROMIUM_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const authorizationId = 'b19fdd47-42fe-4d68-bef0-8f29c4728856';
const operationId = '3b46e8eb-cd19-4491-8d3e-8c24808ddcbe';

const identity = {
  user: { id: 101, email: 'admin@tokems.local', username: 'admin', name: '林管理员' },
  organization: {
    id: 'a2bcda5d-6055-463a-a6df-cf82ebc30763',
    slug: 'tokems-demo',
    name: 'TokEMS 演示组织',
    settings: {},
  },
  membership: {
    id: '6609283f-f884-47e3-ab6d-894c1d995da0',
    role: 'owner',
    grants: ['*'],
    status: 'active',
    isSuperAdministrator: true,
  },
  adminPreferences: { lastEventId: null },
};

const authorization = {
  id: authorizationId,
  clientId: 'tokems-admin-skill',
  clientName: '运营团队的 Codex',
  skillVersion: '0.2.0',
  resource: 'https://events.example.com',
  requestedScopes: [
    'tokems:read',
    'tokems:pii',
    'tokems:write',
    'tokems:finance',
    'tokems:communications',
    'tokems:export',
    'tokems:security',
    'tokems:dangerous',
  ],
  dpopThumbprint: 'Mzc_jhKPa4yOdTdvuFvMthPtobAr1z9zLwU7C8iv0pY',
  status: 'pending',
  expiresAt: '2026-08-17T13:20:00+08:00',
};

const operation = {
  id: operationId,
  actionId: 'commerce.refunds.create',
  target: { orderId: 'order_8848', eventId: 101 },
  dataClass: 'pii',
  risk: 'critical',
  reason: '客户重复付款，经财务复核后按当前可退上限退款。',
  requestHash: '7a'.repeat(32),
  beforeFingerprint: 'b4'.repeat(32),
  redactedDiff: {
    before: { refundableAmount: 129900, status: 'paid' },
    after: { amount: 129900, reason: 'duplicate-payment' },
  },
  impactSummary: { finance: true, providerSideEffect: true },
  status: 'approval_required',
  expiresAt: '2026-08-17T13:20:00+08:00',
};

function json(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(value),
  });
}

async function installMocks(page) {
  await page.addInitScript((value) => {
    localStorage.setItem('conference.admin.token', 'visual-smoke-token');
    localStorage.setItem('conference.admin.user', JSON.stringify(value.user));
  }, identity);
  await page.route('http://localhost:4100/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/auth/me') return json(route, identity);
    if (url.pathname.endsWith(`/admin/agent-authorizations/${authorizationId}`)) {
      return json(route, authorization);
    }
    if (url.pathname.endsWith(`/admin/agent-operations/${operationId}`)) {
      return json(route, operation);
    }
    return json(route, { code: 'VISUAL_SMOKE_UNHANDLED', path: url.pathname }, 404);
  });
}

async function inspectPage(page, name, path, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
  await page.locator('.approval-card, .operation-card').waitFor();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  if (dimensions.content > dimensions.viewport + 2) {
    throw new Error(
      `${name} has horizontal overflow: ${dimensions.content} > ${dimensions.viewport}`,
    );
  }
  const unnamed = await page.locator('input, select, button').evaluateAll(
    (elements) =>
      elements.filter((element) => {
        const label = element.closest('label')?.textContent?.trim();
        return !(label || element.getAttribute('aria-label') || element.textContent?.trim());
      }).length,
  );
  if (unnamed) throw new Error(`${name} has ${unnamed} unnamed controls`);
  const file = resolve(output, `${name}-${viewport.width}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  await installMocks(page);
  const screenshots = [];
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 375, height: 812 },
  ]) {
    screenshots.push(
      await inspectPage(
        page,
        'agent-authorization',
        `/agent-authorizations/${authorizationId}`,
        viewport,
      ),
    );
    screenshots.push(
      await inspectPage(page, 'agent-operation', `/agent-operations/${operationId}`, viewport),
    );
  }
  console.log(JSON.stringify({ ok: true, screenshots }, null, 2));
} finally {
  await browser.close();
}
