import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';
import { createRequire } from 'node:module';
const { unzipSync } = createRequire(new URL('../apps/admin/package.json', import.meta.url))('fflate');
const base = process.env.ADMIN_BASE_URL ?? 'http://localhost:3200/admin';
const frontendBase = process.env.PARTNER_FRONTEND_BASE_URL ?? 'http://localhost:3000';
if (!['localhost', '127.0.0.1', 'admin.localhost', '[::1]'].includes(new URL(base).hostname))
  throw new Error('Material checks require a local app');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());
const output = 'test-results/partner-promotion';
await mkdir(output, { recursive: true });
const fields = {
  avatar: true,
  displayName: true,
  company: true,
  title: true,
  industry: false,
  businessIntro: false,
  businessUrl: false,
  contactPhone: false,
  contactEmail: false,
  wechatId: false,
  gallery: false,
};
const avatarAssetId = 'ead73b17-b02e-431a-a05d-7db3a0918260';
const avatarPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN7sAAAAASUVORK5CYII=', 'base64');
const event = {
  id: 101,
  organizationId: 'org-materials',
  slug: 'tokems26',
  name: '第二届中国GEO大会',
  shortName: 'GEO大会',
  startsAt: '2027-11-01T01:00:00Z',
  endsAt: '2027-11-01T10:00:00Z',
  timezone: 'Asia/Shanghai',
  city: '深圳',
  status: 'registration_open',
  speakers: [],
};
const partner = {
  id: 'a761c83a-143b-4447-b018-a03c238b2be7',
  version: 1,
  eventId: 101,
  eventSlug: event.slug,
  eventName: event.name,
  referralPath: '/r/promotionfixture',
  qualificationStatus: 'active',
  attributionEnabled: true,
  personalRateBps: null,
  loginMobile: '+8613800138000',
  sortOrder: 0,
  internalNote: '内部资料不应出现在海报',
  balances: { available: 0, reserved: 0 },
  profile: {
    version: 1,
    displayName: '林安',
    company: '远见数字科技',
    title: '市场负责人',
    industry: '',
    businessIntro: '',
    businessUrl: '',
    avatarUrl: null,
    publicStatus: 'draft',
    visibleFields: fields,
    posterFields: fields,
  },
};
async function fixture(
  t,
  {
    width = 1440,
    readOnly = false,
    availability = 'ready',
    created = false,
    expectedReferrals = 0,
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  t.after(() => context.close());
  await context.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  await context.addInitScript(() =>
    localStorage.setItem('conference.admin.token', 'material-fixture'),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const state = {
    partner: structuredClone(partner),
    availability,
    fail: false,
    created,
    writes: [],
    referrals: 0,
    late: null,
    avatarStatus: 'ready',
    avatarStatusReads: 0,
    partners: [],
    failedPartnerIds: [],
    promotionReads: {},
    beforePromotion: null,
  };
  state.partners = [state.partner];
  await context.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith('/site-config'))
      return route.fulfill({ json: { website: {}, customerAccounts: {}, analytics: {} } });
    if (path.endsWith('/auth/me'))
      return route.fulfill({
        json: {
          user: { id: 101, name: '素材管理员' },
          organization: {
            id: event.organizationId,
            slug: 'geo-conference',
            name: '大会组织',
            settings: {},
          },
          membership: {
            id: 'membership',
            role: 'owner',
            status: 'active',
            grants: readOnly ? ['event.read', 'event.partner.read'] : ['*'],
          },
          adminPreferences: { lastEventId: 101 },
        },
      });
    if (path.endsWith('/admin/event-options'))
      return route.fulfill({ json: [{ ...event, organizationName: '大会组织' }] });
    if (
      /^\/api\/v1\/r\//.test(path) ||
      path.includes('/partner-referrals') ||
      path.includes('/referrals/')
    )
      state.referrals++;
    if (req.method() !== 'GET') {
      state.writes.push({ path, body: req.postDataJSON() });
      if (path.endsWith('/details')) {
        Object.assign(state.partner.profile, req.postDataJSON());
        state.partner.version++;
        state.partner.profile.version++;
        if (req.postDataJSON().avatarAssetId)
          state.partner.profile.avatarUrl = `/admin/events/101/distribution/partners/${partner.id}/promotion/avatar?version=${state.partner.profile.version}`;
        if (req.postDataJSON().avatarAssetId === null) state.partner.profile.avatarUrl = null;
        return route.fulfill({ json: state.partner });
      }
      if (path.endsWith('/media-uploads'))
        return route.fulfill({ json: { uploadToken: avatarAssetId, uploadUrl: `${new URL(base).origin}/fixture-avatar-upload`, headers: { 'Content-Type': 'image/png' } } });
      if (path.endsWith('/media-confirmations'))
        return route.fulfill({ json: { assetId: avatarAssetId, status: 'processing' } });
      if (path.endsWith('/partners'))
        return route.fulfill({ json: { ...state.partner, created: state.created } });
      return route.fulfill({ json: {} });
    }
    if (path.endsWith(`/media/${avatarAssetId}/status`)) {
      state.avatarStatusReads++;
      return route.fulfill({ json: { assetId: avatarAssetId, status: state.avatarStatus, failureReason: state.avatarStatus === 'failed' ? '图片处理失败，请重新上传。' : null } });
    }
    if (path.endsWith('/promotion/avatar')) return route.fulfill({ contentType: 'image/png', body: avatarPng });
    if (path.endsWith('/promotion')) {
      if (state.late) await state.late;
      const selected = state.partners.find(item => path.includes(`/${item.id}/`)) ?? state.partner;
      state.promotionReads[selected.id] = (state.promotionReads[selected.id] ?? 0) + 1;
      state.beforePromotion?.(selected, state.promotionReads[selected.id]);
      if (state.fail || state.failedPartnerIds.includes(selected.id))
        return route.fulfill({ status: 503, json: { message: '素材暂时无法读取，请重试。' } });
      return route.fulfill({
        json: {
          ...selected,
          availability: state.availability,
          reason:
            state.availability === 'ready'
              ? '推广链接已生效'
              : state.availability === 'pending_confirmation'
                ? '待合作伙伴确认当前规则，确认后原链接和二维码自动生效。'
                : '合作伙伴已暂停，当前推广链接不可用。',
        },
      });
    }
    if (path.endsWith('/overview'))
      return route.fulfill({
        json: {
          program: { mode: 'fixed', fixedRateBps: 1000 },
          partnerCounts: {},
          commissionTotals: {},
          payoutTotals: {},
        },
      });
    if (path.endsWith('/partners')) return route.fulfill({ json: { items: state.partners } });
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
    if (path.endsWith('/events/101') || path.endsWith('/events/tokems26'))
      return route.fulfill({ json: event });
    return route.fulfill({ json: { items: [] } });
  });
  await context.route('**/fixture-avatar-upload', route => route.fulfill({ status: 200, body: '' }));
  await page.goto(`${base}/events/101/distribution`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '合作伙伴列表', exact: true }).waitFor();
  t.after(() => {
    assert.deepEqual(errors, []);
    assert.equal(state.referrals, expectedReferrals, 'preview must not resolve a referral');
  });
  return { page, state, context };
}
async function open(page) {
  const table = page.locator('.partner-directory-table');
  const edit = table.getByRole('button', { name: '编辑', exact: true });
  await (await edit.count() ? edit : table.getByRole('button', { name: '查看素材', exact: true })).click();
  const panel = page.locator('dialog[open]');
  await panel.getByRole('button', { name: '下载分销海报 PNG' }).waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('[aria-label="合作伙伴分销海报预览"]').hidden &&
      document.querySelector('[aria-label="合作伙伴分销海报预览"]').style.display !== 'none',
  );
  return panel;
}
async function imageData(canvas) {
  return canvas.evaluate((el) => {
    const c = el.getContext('2d'),
      p = c.getImageData(0, 0, el.width, el.height);
    return { data: Array.from(p.data), width: p.width, height: p.height };
  });
}
for (const width of [1440, 375, 320])
  test(`promotion exports at ${width}px use the frontend link and exact poster preview`, async (t) => {
    const { page, state } = await fixture(t, { width });
    const panel = await open(page);
    const link = await panel.getByLabel('专属分销链接').inputValue();
    assert.equal(link, `${frontendBase}/r/promotionfixture`);
    const canvas = panel.getByLabel('合作伙伴分销海报预览');
    assert.deepEqual(await canvas.evaluate(el => [el.width, el.height]), [1080, 1440]);
    const png = await canvas.evaluate((el) => el.toDataURL('image/png'));
    const downloadEvent = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载分销海报 PNG' }).click();
    const download = await downloadEvent;
    assert.deepEqual(
      await readFile(await download.path()),
      Buffer.from(png.split(',')[1], 'base64'),
    );
    assert.ok(!download.suggestedFilename().includes('13800138000'));
    await download.saveAs(`${output}/poster-${width}.png`);
    const qrDownloadEvent = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载二维码 PNG' }).click();
    const qrDownload = await qrDownloadEvent;
    await qrDownload.saveAs(`${output}/qr-${width}.png`);
    const encodedQr = (await readFile(await qrDownload.path())).toString('base64');
    const exportedQr = await page.evaluate(async (encoded) => {
      const img = new Image();
      img.src = `data:image/png;base64,${encoded}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const p = ctx.getImageData(0, 0, c.width, c.height);
      return { data: Array.from(p.data), width: p.width, height: p.height };
    }, encodedQr);
    assert.equal(
      jsQR(new Uint8ClampedArray(exportedQr.data), exportedQr.width, exportedQr.height).data,
      link,
    );
    const qrData = await imageData(panel.locator('.material-qr canvas'));
    assert.equal(jsQR(new Uint8ClampedArray(qrData.data), qrData.width, qrData.height).data, link);
    const posterQr = await canvas.evaluate((el) => {
      const p = el.getContext('2d').getImageData(780, 1088, 228, 228);
      return { data: Array.from(p.data), width: p.width, height: p.height };
    });
    assert.equal(
      jsQR(new Uint8ClampedArray(posterQr.data), posterQr.width, posterQr.height).data,
      link,
    );
    await panel.getByRole('button', { name: '复制分销链接' }).click();
    await panel.getByText('分销链接已复制。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
    const box = await panel.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    assert.equal(
      await panel.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
      'no horizontal overflow',
    );
    await panel.locator('.partner-promotion').evaluate((el) => {
      el.scrollTop = 0;
    });
    await panel.screenshot({ path: `${output}/materials-${width}.png` });
    assert.equal(state.writes.filter((item) => item.path.includes('/distribution/')).length, 0);
  });
test('active materials are available to read permission; paused materials are blocked', async (t) => {
  const { page, state } = await fixture(t, {
    readOnly: true,
    availability: 'ready',
  });
  const panel = await open(page);
  assert.equal(await panel.getByRole('button', { name: '基本资料', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '新增合作伙伴', exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: '下载分销海报 PNG' }).isEnabled(), true);
  state.availability = 'unavailable';
  await panel.getByRole('button', { name: '刷新素材', exact: true }).click();
  await panel.getByText('合作伙伴已暂停，当前推广链接不可用。').waitFor();
  assert.equal(await panel.getByRole('button', { name: '复制分销链接' }).isDisabled(), true);
  assert.equal(await panel.getByRole('button', { name: '下载二维码 PNG' }).isDisabled(), true);
  assert.equal(state.writes.filter((item) => item.path.includes('/distribution/')).length, 0);
});
test('new partner creation stays successful through material failure and supports retry', async (t) => {
  const { page, state } = await fixture(t, { created: true });
  state.fail = true;
  await page.getByRole('button', { name: '新增合作伙伴', exact: true }).click();
  const invite = page.getByRole('dialog', { name: '新增合作伙伴', exact: true });
  await invite.locator('input[type=tel]').fill('13800138000');
  await invite.getByRole('button', { name: '邀请并开通' }).click();
  const panel = page.locator('dialog[open]');
  await panel.getByText('素材暂时无法读取，请重试。').waitFor();
  await panel.getByText(/合作伙伴创建成功/).waitFor();
  state.fail = false;
  await panel.getByRole('button', { name: '重新加载素材' }).click();
  await page.waitForFunction(() => !document.querySelector('.material-poster .button').disabled);
  assert.equal(state.writes.filter((x) => x.path.endsWith('/partners')).length, 1);
});
test('saved changes regenerate the poster and unsaved form input survives tab switching', async (t) => {
  const { page, state } = await fixture(t);
  await page
    .locator('.partner-directory-table')
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByLabel('姓名 / 展示名称', { exact: false }).fill('林安更新');
  await dialog.getByRole('button', { name: '海报设置', exact: true }).click();
  await dialog.getByText('资料尚未保存，请先保存修改后领取最新素材。').waitFor();
  assert.equal(await dialog.getByRole('button', { name: '下载分销海报 PNG' }).isDisabled(), true);
  await dialog.getByRole('button', { name: '基本资料', exact: true }).click();
  assert.equal(
    await dialog.getByLabel('姓名 / 展示名称', { exact: false }).inputValue(),
    '林安更新',
  );
  await dialog.getByRole('button', { name: '保存修改' }).click();
  await dialog.getByText('资料已保存，推广素材已按最新资料更新。').waitFor();
  await page.waitForFunction(() => !document.querySelector('.material-poster .button').disabled);
  assert.equal(state.partner.profile.displayName, '林安更新');
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载分销海报 PNG' }).click();
  assert.ok((await downloadEvent).suggestedFilename().startsWith('林安更新-'));
});

test('download refreshes a changed profile and refuses a stale or stopped snapshot', async (t) => {
  const { page, state } = await fixture(t);
  const panel = await open(page);
  state.partner.profile.displayName = '林知远';
  state.partner.profile.version++;
  state.partner.version++;
  const downloadEvent = page.waitForEvent('download');
  await panel.getByRole('button', { name: '下载分销海报 PNG' }).click();
  assert.ok((await downloadEvent).suggestedFilename().startsWith('林知远-'));
  state.fail = true;
  let downloads = 0;
  page.on('download', () => downloads++);
  await panel.getByRole('button', { name: '下载分销海报 PNG' }).click();
  await panel.getByText('素材暂时无法读取，请重试。').waitFor();
  assert.equal(downloads, 0);
  state.fail = false;
  state.availability = 'unavailable';
  await panel.getByRole('button', { name: '刷新素材', exact: true }).click();
  await panel.getByText('合作伙伴已暂停，当前推广链接不可用。').waitFor();
  assert.equal(await panel.getByRole('button', { name: '下载分销海报 PNG' }).isDisabled(), true);
});

test('an authorized avatar failure keeps links usable while blocking an incomplete poster', async (t) => {
  const { page, state } = await fixture(t);
  state.partner.profile.avatarUrl =
    '/admin/events/101/distribution/partners/fixture/promotion/avatar?version=1';
  await page.route('**/promotion/avatar?version=*', (route) =>
    route.fulfill({ status: 503, json: { message: 'avatar unavailable' } }),
  );
  await page
    .locator('.partner-directory-table')
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const panel = page.locator('dialog[open]');
  await panel.getByText('海报头像读取失败，请刷新素材后重试。').waitFor();
  assert.equal(await panel.getByRole('button', { name: '下载分销海报 PNG' }).isDisabled(), true);
  await panel.getByRole('button', { name: '复制分销链接' }).click();
  await panel.getByText('分销链接已复制。').waitFor();
});

test('closing a loading panel discards its late response', async (t) => {
  const { page, state } = await fixture(t);
  let release;
  state.late = new Promise((resolve) => {
    release = resolve;
  });
  await page
    .locator('.partner-directory-table')
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const panel = page.locator('dialog[open]');
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  release();
  state.late = null;
  await open(page);
  assert.equal(await page.locator('dialog[open]').count(), 1);
});

test('saving directly from promotion replaces the visible poster immediately', async (t) => {
  const { page } = await fixture(t);
  await open(page);
  const panel = page.locator('dialog[open]');
  const before = await panel.getByLabel('合作伙伴分销海报预览').evaluate((el) => el.toDataURL());
  await panel.getByRole('button', { name: '基本资料', exact: true }).click();
  await panel.getByLabel('姓名 / 展示名称', { exact: false }).fill('林知远');
  await panel.getByRole('button', { name: '海报设置', exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector('.partner-promotion').getAttribute('aria-busy') ||
      document.querySelector('.partner-promotion').getAttribute('aria-busy') === 'false',
  );
  await panel.getByRole('button', { name: '保存修改' }).click();
  await panel.getByText('资料已保存，推广素材已按最新资料更新。').waitFor();
  await page.waitForFunction(() => !document.querySelector('.material-poster .button').disabled);
  const after = await panel.getByLabel('合作伙伴分销海报预览').evaluate((el) => el.toDataURL());
  assert.notEqual(after, before, 'the visible preview must refresh before download is clicked');
});

test('administrator and partner account render the same saved poster', async (t) => {
  const { page, state, context } = await fixture(t);
  const panel = await open(page);
  const adminPng = await panel.getByLabel('合作伙伴分销海报预览').evaluate((el) => el.toDataURL());
  await context.route('**/api/v1/customer-auth/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrfToken: 'fixture',
        customer: {
          id: 12345,
          organizationId: 'org-materials',
          mobile: '+8613800138000',
          maskedMobile: '138****8000',
          profile: {
            realName: '林安',
            nickname: '林安',
            company: '远见数字科技',
            title: '市场负责人',
            email: '',
            city: '深圳',
            version: 1,
          },
        },
      },
    }),
  );
  await context.route('**/api/v1/customer/partnerships/101', (route) =>
    route.fulfill({
      json: {
        ...state.partner,
        publicSlug: 'fixture',
        currentProgram: {
          id: 'program',
          status: 'active',
          attributionDays: 30,
          termsTitle: '规则',
          termsContent: '规则',
          promotionPolicy: '真实推广',
        },
        acceptedProgramVersionId: 'program',
        settlementHold: false,
        balances: {
          pending: 0,
          available: 0,
          reserved: 0,
          paid: 0,
          recoveryDue: 0,
          currency: 'CNY',
        },
        profile: {
          ...state.partner.profile,
          gallery: [],
          searchIndexingEnabled: false,
          contactPhone: '',
          contactEmail: '',
          wechatId: '',
        },
      },
    }),
  );
  await context.route('**/api/v1/customer/partnerships/101/inquiries', (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
  const front = await context.newPage();
  await front.goto(`${frontendBase}/account/partnerships/101?tab=promotion`, {
    waitUntil: 'networkidle',
  });
  const canvas = front.getByLabel('合作伙伴推广海报预览');
  await canvas.waitFor({ state: 'visible', timeout: 10000 });
  const accountPng = await canvas.evaluate((el) => el.toDataURL());
  assert.equal(
    adminPng === accountPng,
    true,
    'both surfaces must render the same saved fields, defaults, event information and QR',
  );
});

test('slow avatar loading does not block link copying or independent QR download', { timeout: 15_000 }, async (t) => {
  const { page, state } = await fixture(t);
  state.partner.profile.avatarUrl =
    '/admin/events/101/distribution/partners/fixture/promotion/avatar?version=1';
  let releaseAvatar;
  const avatarGate = new Promise((resolve) => {
    releaseAvatar = resolve;
  });
  t.after(() => releaseAvatar());
  let avatarRequested;
  const avatarStarted = new Promise((resolve) => {
    avatarRequested = resolve;
  });
  await page.route('**/promotion/avatar?version=*', async (route) => {
    avatarRequested();
    await avatarGate;
    await route.fulfill({ status: 503, json: { message: 'avatar unavailable' } });
  });
  await page
    .locator('.partner-directory-table')
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await avatarStarted;
  const panel = page.locator('dialog[open]');
  assert.equal(
    await panel.getByRole('button', { name: '复制分销链接', exact: true }).isEnabled(),
    true,
    'copy must depend only on loaded metadata',
  );
  await panel.getByRole('button', { name: '复制分销链接', exact: true }).click();
  await panel.getByText('分销链接已复制。', { exact: true }).waitFor({ timeout: 3000 });
  const downloadEvent = page.waitForEvent('download', { timeout: 3000 });
  await panel.getByRole('button', { name: '下载二维码 PNG', exact: true }).click();
  assert.ok((await downloadEvent).suggestedFilename().endsWith('分销二维码.png'));
  assert.equal(
    await panel.getByRole('button', { name: '下载分销海报 PNG', exact: true }).isDisabled(),
    true,
  );
  releaseAvatar();
});

test('validation from promotion reveals and focuses the invalid profile field', { timeout: 15_000 }, async (t) => {
  const { page } = await fixture(t);
  await page
    .locator('.partner-directory-table')
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const panel = page.locator('dialog[open]');
  await panel.getByLabel('业务链接', { exact: false }).fill('ftp://example.com');
  await panel.getByRole('button', { name: '海报设置', exact: true }).click();
  await panel.getByRole('button', { name: '保存修改', exact: true }).click();
  const input = panel.getByLabel('业务链接', { exact: false });
  assert.equal(await input.isVisible(), true);
  assert.equal(await input.evaluate((el) => el === document.activeElement), true);
});

test('typing during a pending save remains a draft after that save completes', { timeout: 15_000 }, async (t) => {
  const { page, state } = await fixture(t);
  let releaseSave, saveStarted;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const saveSeen = new Promise((resolve) => {
    saveStarted = resolve;
  });
  await page.route('**/partners/*/details', async (route) => {
    const submitted = route.request().postDataJSON();
    saveStarted();
    await saveGate;
    Object.assign(state.partner.profile, submitted);
    state.partner.version++;
    await route.fulfill({ json: state.partner });
  });
  await page
    .locator('.partner-directory-table')
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const panel = page.locator('dialog[open]');
  const input = panel.getByLabel('姓名 / 展示名称', { exact: false });
  await input.fill('本次保存的姓名');
  await panel.getByRole('button', { name: '保存修改', exact: true }).click();
  await saveSeen;
  await input.fill('等待期间的新姓名');
  releaseSave();
  await panel.getByText('本次资料已保存，后续修改尚未保存。', { exact: true }).waitFor();
  assert.equal(await input.isVisible(), true, 'the unsaved edit must remain visible');
  assert.equal(await input.inputValue(), '等待期间的新姓名');
  let confirmation;
  page.once('dialog', async (dialog) => {
    confirmation = dialog.message();
    await dialog.dismiss();
  });
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  assert.ok(confirmation?.includes('尚未保存'));
  assert.equal(await panel.isVisible(), true);
});

// Positive control for the referral counter used by every preview and export test.
test('promotion fixture detects requests to the actual referral resolver route', async (t) => {
  const { page, state } = await fixture(t, { expectedReferrals: 1 });
  await page.evaluate(() => fetch('/api/v1/r/referral-counter-control'));
  assert.equal(state.referrals, 1);
});

test('list downloads the full poster directly without opening an editor', async (t) => {
  const { page, state } = await fixture(t);
  const downloaded = page.waitForEvent('download');
  await page.locator('.partner-directory-table').getByRole('button', { name: '下载海报', exact: true }).click();
  const file = await downloaded;
  assert.ok(file.suggestedFilename().startsWith('林安-'));
  const png = await readFile(await file.path());
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), 1440);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(state.writes.filter(item => item.path.includes('/distribution/')).length, 0);
});

test('list explains a missing link and keeps download failures beside their partner', async (t) => {
  const { page, state } = await fixture(t);
  state.partner.referralPath = '';
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  const row = page.locator('.partner-directory-table tbody tr');
  assert.equal(await row.getByRole('button', { name: '下载海报', exact: true }).isDisabled(), true);
  await row.getByText('尚无推广链接，请启用推广以补全链接。', { exact: true }).waitFor();
  await row.getByRole('button', { name: '启用推广', exact: true }).waitFor();
  state.partner.referralPath = '/r/promotionfixture';
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  state.fail = true;
  await row.getByRole('button', { name: '下载海报', exact: true }).click();
  await row.getByRole('alert').filter({ hasText: '素材暂时无法读取' }).waitFor();
});

test('batch download packages distinct, complete posters and reports skipped and failed partners', async (t) => {
  const { page, state } = await fixture(t, { readOnly: true });
  const copy = (suffix, override = {}) => ({ ...structuredClone(state.partner), id: `partner-${suffix}`, ...override });
  state.partners.push(copy('same-name', { referralPath: '/r/second-fixture' }),
    copy('paused', { qualificationStatus: 'paused', attributionEnabled: false }), copy('failure'));
  state.failedPartnerIds.push('partner-failure');
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByRole('checkbox', { name: '全选合作伙伴', exact: true }).check();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '批量下载海报（4）', exact: true }).click();
  const file = await downloaded;
  assert.ok(file.suggestedFilename().endsWith('.zip'));
  const entries = unzipSync(await readFile(await file.path()));
  assert.equal(Object.keys(entries).length, 2);
  assert.equal(new Set(Object.keys(entries)).size, 2);
  const destinations = [];
  for (const bytes of Object.values(entries)) {
    const png = Buffer.from(bytes);
    assert.equal(png.readUInt32BE(16), 1080);
    assert.equal(png.readUInt32BE(20), 1440);
    const qr = await page.evaluate(async encoded => {
      const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1440;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(780, 1088, 228, 228).data);
    }, png.toString('base64'));
    destinations.push(jsQR(new Uint8ClampedArray(qr), 228, 228).data);
  }
  assert.deepEqual(destinations, [`${frontendBase}/r/promotionfixture`, `${frontendBase}/r/second-fixture`]);
  await page.getByText('已打包 2 张海报，2 位伙伴未能下载，原因见下方列表。', { exact: true }).waitFor();
  assert.equal(await page.locator('.partner-download-feedback[role="alert"]').count(), 2);
  assert.equal(state.writes.filter(item => item.path.includes('/distribution/')).length, 0);
  await file.saveAs(`${output}/batch-posters.zip`);
  await page.screenshot({ path: `${output}/batch-posters-result.png`, fullPage: true });
});

test('cancelling batch generation prevents a late response from downloading', async (t) => {
  const { page, state } = await fixture(t, { width: 375 });
  await page.getByRole('checkbox', { name: '全选合作伙伴', exact: true }).check();
  let resolveLate;
  state.late = new Promise(resolve => { resolveLate = resolve; });
  const downloads = [];
  page.on('download', file => downloads.push(file));
  await page.getByRole('button', { name: '批量下载海报（1）', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '新增合作伙伴', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '取消批量下载', exact: true }).click();
  resolveLate();
  await page.getByText('已取消批量下载。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '新增合作伙伴', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('.partner-promotion.headless').count(), 0);
  assert.equal(downloads.length, 0);
  state.late = null;
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '批量下载海报（1）', exact: true }).click();
  await downloaded;
  assert.equal(downloads.length, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: `${output}/batch-posters-mobile.png`, fullPage: true });
});

test('batch archive excludes a poster changed after rendering while delivering the stable partner', async (t) => {
  const { page, state } = await fixture(t);
  state.partners.push({ ...structuredClone(state.partner), id: 'stable-partner', referralPath: '/r/stable-partner' });
  state.beforePromotion = (item, reads) => {
    if (item.id === partner.id && reads === 4) item.version++;
  };
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByRole('checkbox', { name: '全选合作伙伴', exact: true }).check();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '批量下载海报（2）', exact: true }).click();
  const file = await downloaded;
  assert.equal(Object.keys(unzipSync(await readFile(await file.path()))).length, 1);
  await page.getByText('已打包 1 张海报，1 位伙伴未能下载，原因见下方列表。', { exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: '推广状态或资料已变化' }).waitFor();
});

test('avatar waits for processing and saves with the poster draft in one request', async (t) => {
  const { page, state } = await fixture(t);
  const panel = await open(page);
  state.avatarStatus = 'processing';
  await panel.locator('input[type=file]').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: avatarPng });
  await panel.getByText('头像处理中…', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '保存修改', exact: true }).isDisabled(), true);
  await panel.getByRole('button', { name: '复制分销链接', exact: true }).click();
  await panel.getByText('分销链接已复制。', { exact: true }).waitFor();
  state.avatarStatus = 'ready';
  await panel.getByText('头像已就绪，保存后生效。').waitFor();
  await panel.getByLabel('姓名 / 展示名称', { exact: false }).fill('林安新头像');
  await panel.getByRole('button', { name: '海报设置', exact: true }).click();
  await panel.getByLabel('邀请语', { exact: false }).fill('一起探索新的合作');
  await panel.getByLabel('海报合作介绍', { exact: false }).fill('我们在大会现场交流合作机会。');
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: '保存并下载', exact: true }).click();
  assert.ok((await download).suggestedFilename().startsWith('林安新头像-'));
  const writes = state.writes.filter(item => item.path.endsWith('/details'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.avatarAssetId, avatarAssetId);
  assert.equal(writes[0].body.displayName, '林安新头像');
  assert.equal(writes[0].body.posterCopy.invitation, '一起探索新的合作');
  assert.equal(writes[0].body.posterCopy.introduction, '我们在大会现场交流合作机会。');
  for (const field of ['visibleFields', 'publicStatus', 'gallery', 'contactPhone', 'contactEmail', 'wechatId'])
    assert.equal(field in writes[0].body, false, `${field} must remain untouched`);
  assert.ok(state.avatarStatusReads >= 2);
  await panel.screenshot({ path: `${output}/poster-editor-saved.png` });
});

test('avatar processing failure retains the saved identity and does not bind the failed image', async (t) => {
  const { page, state } = await fixture(t);
  const panel = await open(page);
  state.avatarStatus = 'failed';
  await panel.locator('input[type=file]').setInputFiles({ name: 'failed.png', mimeType: 'image/png', buffer: avatarPng });
  await panel.getByText('图片处理失败，请重新上传。', { exact: true }).waitFor();
  await panel.getByLabel('公司', { exact: false }).first().fill('保留头像的更新');
  await panel.getByRole('button', { name: '保存修改', exact: true }).click();
  await panel.getByText('资料已保存，推广素材已按最新资料更新。').waitFor();
  const write = state.writes.find(item => item.path.endsWith('/details'));
  assert.equal('avatarAssetId' in write.body, false);
});

test('edits during a slow export cancel download and restore the live draft preview', async (t) => {
  const { page, state } = await fixture(t);
  const panel = await open(page);
  const before = await panel.getByLabel('合作伙伴分销海报预览').evaluate(el => el.toDataURL());
  let release;
  state.late = new Promise(resolve => { release = resolve; });
  let downloads = 0;
  page.on('download', () => downloads++);
  await panel.getByRole('button', { name: '下载分销海报 PNG' }).click();
  await panel.getByLabel('姓名 / 展示名称', { exact: false }).fill('导出期间的新草稿');
  release();
  state.late = null;
  await page.waitForFunction(() => {
    const p = document.querySelector('.partner-promotion');
    const c = document.querySelector('[aria-label="合作伙伴分销海报预览"]');
    return p?.getAttribute('aria-busy') === 'false' && c?.style.display !== 'none';
  });
  const after = await panel.getByLabel('合作伙伴分销海报预览').evaluate(el => el.toDataURL());
  assert.notEqual(after, before);
  assert.equal(downloads, 0);
  assert.equal(state.writes.filter(item => item.path.includes('/distribution/')).length, 0);
});

test('closing during avatar processing warns and cancellation discards the old upload result', async (t) => {
  const { page, state } = await fixture(t);
  const panel = await open(page);
  state.avatarStatus = 'processing';
  await panel.locator('input[type=file]').setInputFiles({ name: 'processing.png', mimeType: 'image/png', buffer: avatarPng });
  await panel.getByText('头像处理中…', { exact: true }).waitFor();
  let warned = false;
  page.once('dialog', async dialog => { warned = dialog.message().includes('尚未保存'); await dialog.dismiss(); });
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(warned, true);
  assert.equal(await panel.isVisible(), true);
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  state.avatarStatus = 'ready';
  await open(page);
  assert.equal(await panel.getByText('头像已就绪，保存后生效。', { exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: '保存修改', exact: true }).isDisabled(), true);
});

test('export rechecks a pause that occurs while the avatar is rendering', async (t) => {
  const { page, state } = await fixture(t);
  state.partner.profile.avatarUrl = '/private-avatar';
  let hold = false, release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  await page.route('**/promotion/avatar?version=*', async route => {
    if (hold) { started(); await gate; }
    await route.fulfill({ contentType: 'image/png', body: avatarPng });
  });
  const panel = await open(page);
  hold = true;
  let downloads = 0;
  page.on('download', () => downloads++);
  await panel.getByRole('button', { name: '下载分销海报 PNG', exact: true }).click();
  await seen;
  state.availability = 'unavailable';
  release();
  await panel.getByText('合作伙伴状态或资料已变化，请刷新素材后重新下载。', { exact: true }).waitFor();
  assert.equal(downloads, 0);
});
