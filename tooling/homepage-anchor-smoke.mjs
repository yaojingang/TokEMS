import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.env.WEB_BASE_URL ?? 'http://localhost:8088';
const output = resolve('test-results/homepage-anchors');
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : { channel: 'chrome' }),
  headless: true,
});
after(() => browser.close());
await mkdir(output, { recursive: true });

async function openHome(viewport, path = '/') {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  // Keep browser checks anonymous and prevent page-view writes in every environment.
  await page.route('**/api/v1/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/customer-auth/session')) {
      return route.fulfill({ json: { authenticated: false } });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      return route.fulfill({ status: 204 });
    }
    return route.continue();
  });
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.goto(new URL(path, base).href);
  await page.getByRole('button', { name: '登录或注册账号', exact: true }).waitFor();
  await page.evaluate(() => {
    window.__anchorDocument = crypto.randomUUID();
    window.__anchorFailures = [];
    document
      .querySelector('#__nuxt')
      .__vue_app__.config.globalProperties.$router.afterEach((to, from, failure) => {
        if (failure)
          window.__anchorFailures.push({
            to: to.fullPath,
            from: from.fullPath,
            type: failure.type,
          });
      });
  });
  return { context, page, errors, documentId: await page.evaluate(() => window.__anchorDocument) };
}

async function assertAnchor(page, hash, documentId) {
  await page.waitForFunction(
    (expected) => {
      const router =
        document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$router;
      return router?.currentRoute.value.hash === expected;
    },
    hash,
    { timeout: 4_000 },
  );
  assert.equal(
    await page.evaluate(() => window.__anchorDocument),
    documentId,
    `${hash}: document replaced`,
  );
  assert.deepEqual(
    await page.evaluate(() => window.__anchorFailures),
    [],
    `${hash}: navigation cancelled`,
  );
  await page.waitForFunction((expected) => {
    const target = document.getElementById(decodeURIComponent(expected.slice(1)));
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
    const padding =
      Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    const destination = Math.min(
      Math.max(0, rect.top + scrollY - margin - padding),
      document.documentElement.scrollHeight - innerHeight,
    );
    return rect.top < innerHeight && rect.bottom > 0 && Math.abs(scrollY - destination) < 3;
  }, hash);
}

test('mobile menu keeps focus while moving between links', { timeout: 20_000 }, async () => {
  const { context, page, documentId } = await openHome({ width: 390, height: 844 });
  try {
    const menu = page.getByRole('button', { name: '菜单', exact: true });
    await menu.click();
    await page.locator('.navigation-panel a').first().press('Tab');
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    assert.equal(await menu.evaluate((element) => element === document.activeElement), true);
    await menu.press('ArrowDown');
    await page.locator('.navigation-panel a[href="#agenda"]').focus();
    await page.keyboard.press('Enter');
    await assertAnchor(page, '#agenda', documentId);
  } finally {
    await context.close();
  }
});

test(
  'root agenda click keeps its document and completes navigation',
  { timeout: 20_000 },
  async () => {
    const { context, page, documentId, errors } = await openHome({ width: 1440, height: 1000 });
    try {
      await page.getByRole('link', { name: '查看两日议程', exact: true }).click();
      await assertAnchor(page, '#agenda', documentId);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`all homepage anchors work at ${viewport.width}px`, { timeout: 90_000 }, async () => {
    const { context, page, documentId, errors } = await openHome(viewport);
    try {
      const anchors = await page.locator('a[href]').evaluateAll((links) =>
        links.flatMap((link, index) => {
          const url = new URL(link.href);
          if (
            url.origin !== location.origin ||
            url.pathname !== location.pathname ||
            url.search !== location.search ||
            url.hash.length < 2 ||
            (link.target && link.target !== '_self') ||
            link.getAttribute('aria-disabled') === 'true'
          )
            return [];
          return [
            {
              index,
              hash: url.hash,
              label: link.textContent.trim(),
              navigation: Boolean(link.closest('.conference-navigation')),
              targetExists: Boolean(document.getElementById(decodeURIComponent(url.hash.slice(1)))),
            },
          ];
        }),
      );
      assert.ok(
        anchors.some((anchor) => anchor.hash === '#agenda'),
        'agenda anchor must be exercised',
      );
      assert.ok(
        anchors.some((anchor) => anchor.hash === '#hero'),
        'home anchor must be exercised',
      );
      for (const anchor of anchors) {
        assert.equal(anchor.targetExists, true, `${anchor.label}: missing ${anchor.hash}`);
        const link = page.locator('a[href]').nth(anchor.index);
        if (anchor.label.includes('跳')) {
          await link.focus();
          await link.press('Enter');
        } else if (await link.isVisible()) {
          await link.click();
        } else {
          // Mobile navigation links are checked through the menu below.
          continue;
        }
        await assertAnchor(page, anchor.hash, documentId);
      }
      const menu = page.getByRole('button', { name: '菜单', exact: true });
      if (await menu.isVisible()) {
        const hashes = [
          ...new Set(anchors.filter((anchor) => anchor.navigation).map((anchor) => anchor.hash)),
        ];
        for (const hash of hashes) {
          await menu.click();
          await page.locator('.navigation-panel').locator(`a[href="${hash}"]`).click();
          await assertAnchor(page, hash, documentId);
        }
      }
      await page.screenshot({ path: resolve(output, `homepage-${viewport.width}.png`) });
      await writeFile(
        resolve(output, `homepage-${viewport.width}.json`),
        JSON.stringify({ viewport, anchors, errors }, null, 2),
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test(
  'root query changes and entry from another page create new documents',
  { timeout: 30_000 },
  async () => {
    const { context, page, documentId } = await openHome({ width: 1440, height: 1000 });
    try {
      await page.evaluate(
        () =>
          void document
            .querySelector('#__nuxt')
            .__vue_app__.config.globalProperties.$router.push('/?preview=1#agenda'),
      );
      await page.waitForFunction(
        () => location.search === '?preview=1' && window.__anchorDocument === undefined,
      );
      await page
        .getByRole('heading', { name: '两天，把 GEO 方法带回业务现场', exact: true })
        .waitFor();
      assert.notEqual(await page.evaluate(() => window.__anchorDocument), documentId);
      await page.goto(new URL('/faq?event=tokems26', base).href);
      await page.getByRole('button', { name: '登录或注册账号', exact: true }).waitFor();
      await page.evaluate(() => {
        window.__anchorDocument = 'faq';
        void document
          .querySelector('#__nuxt')
          .__vue_app__.config.globalProperties.$router.push('/#agenda');
      });
      await page.waitForFunction(
        () => location.pathname === '/' && window.__anchorDocument === undefined,
      );
      await page
        .getByRole('heading', { name: '两天，把 GEO 方法带回业务现场', exact: true })
        .waitFor();
    } finally {
      await context.close();
    }
  },
);
