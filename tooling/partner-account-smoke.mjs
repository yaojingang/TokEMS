import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';
const base = process.env.PARTNER_ACCOUNT_BASE_URL ?? 'http://localhost:8088';
const partner = {
  id: 'partner-fixture',
  eventId: 101,
  eventSlug: 'tokems26',
  eventName: '第二届中国 GEO & AI 营销大会',
  publicSlug: 'test-partner',
  referralCode: 'fixture',
  referralPath: '/r/fixture',
  qualificationStatus: 'active',
  attributionEnabled: true,
  settlementHold: false,
  currentProgram: {
    id: 'program-fixture',
    termsTitle: '大会合作伙伴推广规则',
    termsContent: '佣金按有效订单计算。请确认公开资料和推广规则。',
    promotionPolicy: '请真实、准确地介绍大会内容。',
    attributionDays: 30,
  },
  acceptedProgramVersionId: 'program-fixture',
  personalRateBps: null,
  balances: {
    pending: 24800,
    available: 128600,
    reserved: 30000,
    paid: 360000,
    recoveryDue: 0,
    currency: 'CNY',
  },
  profile: {
    version: 1,
    displayName: '林安',
    company: '远见数字科技',
    title: '市场负责人',
    industry: '企业服务',
    businessIntro: '关注品牌增长与 AI 应用，期待在大会与同行交流实践经验。',
    businessUrl: 'https://example.com',
    contactPhone: '',
    contactEmail: '',
    wechatId: '',
    avatarUrl: null,
    gallery: [],
    publicStatus: 'draft',
    visibleFields: {
      avatar: true,
      displayName: true,
      company: true,
      title: true,
      industry: true,
      businessIntro: true,
      businessUrl: false,
      contactPhone: false,
      contactEmail: false,
      wechatId: false,
      gallery: false,
    },
    posterFields: {
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
    },
    searchIndexingEnabled: true,
  },
  version: 1,
};
const session = {
  authenticated: true,
  csrfToken: 'fixture',
  customer: {
    id: 12345,
    organizationId: 1,
    mobile: '+8613800138000',
    maskedMobile: '138****8000',
    lastLoginAt: '2026-09-13T08:00:00Z',
    profile: {
      realName: '林安',
      nickname: '林安',
      email: 'fixture@example.com',
      company: '远见数字科技',
      title: '市场负责人',
      city: '深圳',
      version: 1,
    },
  },
};
async function fixtures(page, { empty = false, unauthenticated = false, profile = {}, directoryEnabled = false } = {}) {
  const writes = [];
  const state = { partner: { ...structuredClone(partner), directoryEnabled }, reject: false };
  Object.assign(state.partner.profile, profile);
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.includes('/customer-auth/session'))
      return route.fulfill({ json: unauthenticated ? { authenticated: false } : session });
    if (req.method() !== 'GET') {
      writes.push({ path, body: req.postDataJSON() });
      if (state.reject)
        return route.fulfill({ status: 400, json: { message: '资料保存失败，请检查姓名后重试' } });
      if (path.endsWith('/poster-copy')) { state.partner.profile.posterCopy = req.postDataJSON().posterCopy; return route.fulfill({ json: state.partner }); }
      if (path.endsWith('/profile')) {
        Object.assign(state.partner.profile, req.postDataJSON());
        return route.fulfill({ json: state.partner });
      }
      if (path.endsWith('/privacy')) {
        Object.assign(state.partner.profile, req.postDataJSON());
        return route.fulfill({ json: state.partner });
      }
      return route.fulfill({ json: {} });
    }
    if (path.endsWith('/customer/partnerships/101')) return route.fulfill({ json: state.partner });
    if (path.endsWith('/commissions'))
      return route.fulfill({
        json: {
          items: empty
            ? []
            : [
                {
                  id: 'c1',
                  orderId: 'ORDER202609130001',
                  createdAt: '2026-09-13T08:00:00Z',
                  commissionAmount: 12800,
                  status: 'available',
                },
                {
                  id: 'c2',
                  orderId: 'ORDER202609120002',
                  createdAt: '2026-09-12T08:00:00Z',
                  commissionAmount: 6800,
                  status: 'pending',
                },
              ],
        },
      });
    if (path.endsWith('/payouts'))
      return route.fulfill({
        json: {
          requests: empty
            ? []
            : [
                {
                  id: 'p1',
                  version: 1,
                  grossAmount: 30000,
                  taxAmount: 0,
                  netAmount: 30000,
                  status: 'under_review',
                  createdAt: '2026-09-12T08:00:00Z',
                },
              ],
          recipients: empty
            ? []
            : [{ id: 'r1', status: 'verified', channel: 'wechat_transfer', displayName: '林安' }],
          documents: [],
        },
      });
    if (path.endsWith('/customer/partnerships'))
      return route.fulfill({ json: { items: [state.partner] } });
    if (path.startsWith('/api/v1/customer/'))
      return route.fulfill({
        json: {
          items: [],
          nextCursor: null,
          counts: { all: 0, eligible: 0, actionRequired: 0, processing: 0, issued: 0, history: 0 },
        },
      });
    return route.continue();
  });
  return { writes, state };
}

if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
  throw new Error('Partner account checks require a local application');
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
after(() => browser.close());
const output = 'test-results/partner-account';
await mkdir(output, { recursive: true });
async function setup(t, width = 1440, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const data = await fixtures(page, options);
  await page.addInitScript(() => {
    window.__posterText = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (this.canvas.width === 1080) window.__posterText.push(String(text));
      return fillText.call(this, text, ...args);
    };
  });
  await page.goto(`${base}/account/partnerships/101?tab=profile`, { waitUntil: 'networkidle' });
  await page.getByRole('textbox', { name: /^公开姓名/ }).waitFor();
  t.after(() => assert.deepEqual(errors, []));
  return { page, ...data };
}
async function selectModule(page, label) {
  if (page.viewportSize().width <= 1000) {
    await page.locator('.account-mobile-trigger').click();
    await page.locator('.account-mobile-panel').getByRole('button', { name: label }).click();
    assert.equal(
      await page.locator('.account-mobile-trigger').getAttribute('aria-expanded'),
      'false',
    );
  } else {
    await page.locator('.account-nav--desktop').getByRole('button', { name: label }).click();
  }
  await page.waitForFunction(expected => document.querySelector('#partner-module-title')?.textContent?.trim() === expected, label);
  assert.equal(await page.locator('#partner-module-title').innerText(), label);
}
async function assertFits(page) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.scroll <= dimensions.width, 'page has no horizontal overflow');
}
function accountAppearance(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.account-page');
    const heading = document.querySelector('h1');
    const surface = document.querySelector('.account-surface');
    const rail = document.querySelector('.account-rail');
    return {
      canvas: getComputedStyle(root ?? document.querySelector('.partner-account-page'))
        .backgroundColor,
      headingSize: getComputedStyle(heading).fontSize,
      headingWeight: getComputedStyle(heading).fontWeight,
      surfaceRadius: surface ? getComputedStyle(surface).borderRadius : null,
      railWidth: rail?.getBoundingClientRect().width ?? null,
      shellWidth: (
        document.querySelector('.account-shell') ?? document.querySelector('.partner-account-shell')
      ).getBoundingClientRect().width,
    };
  });
}

test('partner workspace follows the personal account design tokens and dimensions', async (t) => {
  const { page } = await setup(t);
  const actual = await accountAppearance(page);
  await page.goto(`${base}/account`, { waitUntil: 'networkidle' });
  await page.locator('.account-rail').waitFor();
  assert.deepEqual(actual, await accountAppearance(page));
});

for (const width of [1440, 1024, 375, 320]) {
  test(`five partner modules remain usable at ${width}px`, async (t) => {
    const { page, writes } = await setup(t, width);
    assert.equal(await page.locator('.mobile-partner-status').isVisible(), width <= 1000);
    await page.getByLabel('公司', { exact: true }).fill('尚未保存的公司');
    for (const [id, label] of [
      ['profile', '资料设置'],
      ['promotion', '推广素材'],
      ['earnings', '推广收益'],
      ['payouts', '提现与结算'],
      ['inquiries', '佣金申诉'],
    ]) {
      await selectModule(page, label);
      await assertFits(page);
      await page.screenshot({ path: `${output}/${id}-${width}.png`, fullPage: true });
    }
    await selectModule(page, '资料设置');
    assert.equal(await page.getByLabel('公司', { exact: true }).inputValue(), '尚未保存的公司');
    if (width <= 1000) {
      await page.locator('.account-mobile-trigger').click();
      await page.keyboard.press('Escape');
      assert.equal(
        await page.locator('.account-mobile-trigger').getAttribute('aria-expanded'),
        'false',
      );
      assert.equal(
        await page
          .locator('.account-mobile-trigger')
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.locator('.account-mobile-trigger').click();
      await page.mouse.click(4, 420);
      assert.equal(
        await page.locator('.account-mobile-trigger').getAttribute('aria-expanded'),
        'false',
      );
    }
    assert.equal(writes.length, 0, 'navigation does not mutate account data');
  });
}

test('profile validation, save feedback and privacy controls preserve their behavior', async (t) => {
  const { page, state, writes } = await setup(t);
  await page.getByRole('textbox', { name: /^公开姓名/ }).fill('');
  await page.getByRole('button', { name: '保存资料' }).click();
  assert.equal(writes.length, 0);
  assert.equal(
    await page
      .getByRole('textbox', { name: /^公开姓名/ })
      .evaluate((el) => el.validity.valueMissing),
    true,
  );
  await page.getByRole('textbox', { name: /^公开姓名/ }).fill('测试伙伴新名称');
  state.reject = true;
  await page.getByRole('button', { name: '保存资料' }).click();
  await page.getByRole('alert').filter({ hasText: '资料保存失败' }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: /^公开姓名/ }).inputValue(),
    '测试伙伴新名称',
  );
  state.reject = false;
  await page.getByRole('button', { name: '保存资料' }).click();
  await page.getByRole('status').filter({ hasText: '合作伙伴资料已保存' }).waitFor();
  assert.equal(writes.at(-1).body.displayName, '测试伙伴新名称');
  const publicCompany = page.getByLabel('详情页公开公司', { exact: true });
  const posterCompany = page.getByLabel('允许海报使用公司', { exact: true });
  assert.equal(await posterCompany.isChecked(), true);
  await publicCompany.uncheck();
  assert.equal(await posterCompany.isChecked(), false);
  assert.equal(await posterCompany.isDisabled(), true);
  await page.getByRole('button', { name: '保存公开设置' }).click();
  await page.getByRole('status').filter({ hasText: '公开范围已更新' }).waitFor();
  assert.equal(writes.at(-1).body.visibleFields.company, false);
  assert.equal(writes.at(-1).body.posterFields.company, false);
});

test('payouts, inquiries and empty records retain usable entry points', async (t) => {
  const { page, writes } = await setup(t, 375, { empty: true });
  await selectModule(page, '推广收益');
  await page.getByRole('heading', { name: '还没有佣金记录' }).waitFor();
  await page.getByRole('button', { name: '查看推广素材' }).click();
  await page.getByRole('heading', { name: '专属推广链接' }).waitFor();
  await selectModule(page, '提现与结算');
  assert.equal(await page.getByRole('button', { name: '提交提现申请' }).isDisabled(), true);
  await page.getByRole('combobox', { name: /^收款主体/ }).selectOption('organization');
  assert.equal(await page.getByRole('combobox', { name: /^结算渠道/ }).inputValue(), 'manual_bank');
  await page.getByLabel('收款账户信息', { exact: true }).waitFor();
  await selectModule(page, '佣金申诉');
  await page.getByLabel('订单编号', { exact: true }).fill('ORDER-FIXTURE-001');
  await page
    .getByLabel('问题说明', { exact: false })
    .fill('测试订单的佣金金额需要核对，请协助检查。');
  await page.getByRole('button', { name: '提交佣金申诉' }).click();
  await page.getByRole('status').filter({ hasText: '佣金申诉已提交' }).waitFor();
  assert.equal(writes.at(-1).body.orderReference, 'ORDER-FIXTURE-001');
  assert.equal(writes.at(-1).body.type, 'missing_order');
});

test('public partner preview crosses the account boundary with a new document', async (t) => {
  const { page } = await setup(t, 1440, { directoryEnabled: true, profile: { publicStatus: 'published' } });
  await selectModule(page, '推广素材');
  await page.route('**/partners/test-partner?event=tokems26', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>公开详情测试页</h1>' }),
  );
  await page.evaluate(() => {
    window.__partnerAccountSentinel = true;
  });
  await page.getByRole('link', { name: '预览公开详情' }).click();
  await page.getByRole('heading', { name: '公开详情测试页' }).waitFor();
  assert.equal(await page.evaluate(() => window.__partnerAccountSentinel), undefined);
});

test('partner poster shares member composition and exports the exact preview with referral QR', async (t) => {
  const { page } = await setup(t, 1440, {
    profile: {
      industry: '企业服务',
      posterFields: { ...partner.profile.posterFields, industry: true, businessIntro: true },
    },
  });
  await selectModule(page, '推广素材');
  const canvas = page.getByLabel('合作伙伴推广海报预览');
  await canvas.waitFor({ state: 'visible' });
  const poster = await canvas.evaluate((canvas) => {
    const ctx = canvas.getContext('2d');
    return {
      width: canvas.width,
      height: canvas.height,
      background: Array.from(ctx.getImageData(1, 1, 1, 1).data),
      accent: Array.from(ctx.getImageData(75, 75, 1, 1).data),
      png: canvas.toDataURL('image/png'),
    };
  });
  assert.equal(poster.width, 1080);
  assert.equal(poster.height, 1440);
  assert.deepEqual(poster.background, [7, 17, 31, 255]);
  assert.deepEqual(poster.accent, [201, 255, 90, 255]);
  const text = await page.evaluate(() => window.__posterText.join('\n'));
  for (const copy of [
    'EVENT PARTNER',
    'INVITATION  /  大会合作伙伴',
    '林安',
    '企业服务',
    'LOOKING TO CONNECT  /  我在做的事',
    '现场见，一起聊聊',
    '扫码查看大会信息，通过我报名',
  ])
    assert.ok(text.includes(copy), copy);
  assert.equal(
    text.includes('已确认参会'),
    false,
    'partner status does not claim a ticket purchase',
  );
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 1080 × 1440 海报' }).click();
  const download = await downloadPromise;
  const png = await readFile(await download.path());
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), 1440);
  assert.deepEqual(png, Buffer.from(poster.png.split(',')[1], 'base64'));
  await download.saveAs(`${output}/partner-poster.png`);
  const qrImage = await canvas.evaluate((canvas) => {
    const image = canvas.getContext('2d').getImageData(780, 1088, 228, 228);
    return { data: Array.from(image.data), width: image.width, height: image.height };
  });
  const qr = jsQR(new Uint8ClampedArray(qrImage.data), qrImage.width, qrImage.height);
  assert.ok(qr, 'the exported poster contains a readable QR code');
  assert.equal(qr.data, `${base}/r/fixture`);
});

test('poster uses authorized saved fields and keeps hidden names out of image and filename', async (t) => {
  const { page } = await setup(t, 375, {
    profile: {
      displayName: '保密姓名',
      company: '保密公司',
      title: '保密职位',
      businessIntro: '保密业务介绍',
      visibleFields: {
        ...partner.profile.visibleFields,
        displayName: false,
        company: false,
        title: false,
        businessIntro: false,
        avatar: false,
      },
      posterFields: { ...partner.profile.posterFields, businessIntro: true },
    },
  });
  await selectModule(page, '推广素材');
  await page.getByLabel('合作伙伴推广海报预览').waitFor({ state: 'visible' });
  assert.equal((await page.evaluate(() => window.__posterText.join(''))).includes('保密'), false);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 1080 × 1440 海报' }).click();
  const download = await downloadPromise;
  assert.ok(download.suggestedFilename().startsWith('大会合作伙伴-'));
  await assertFits(page);
});

test('poster renders uploaded avatars, tolerates long copy and refreshes after a saved profile', async (t) => {
  const { page } = await setup(t, 375, {
    profile: {
      avatarUrl:
        'data:image/svg+xml,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#dc2626"/></svg>',
        ),
      displayName: '跨行业增长研究与市场合作伙伴团队',
      company: '数字营销与企业增长技术研究有限公司',
      title: '品牌与市场业务合作负责人',
      industry: '企业服务与数字营销'.repeat(5),
      businessIntro: '持续探索企业增长、数字营销和行业合作的新机会。'.repeat(12),
      posterFields: { ...partner.profile.posterFields, industry: true, businessIntro: true },
    },
  });
  await selectModule(page, '推广素材');
  const canvas = page.getByLabel('合作伙伴推广海报预览');
  await canvas.waitFor({ state: 'visible' });
  assert.deepEqual(
    await canvas.evaluate((c) => Array.from(c.getContext('2d').getImageData(872, 548, 1, 1).data)),
    [220, 38, 38, 255],
  );
  await assertFits(page);
  await page.locator('.poster-preview').screenshot({ path: `${output}/poster-long-copy.png` });
  await selectModule(page, '资料设置');
  await page.getByRole('textbox', { name: /^公开姓名/ }).fill('更新后的伙伴');
  await page.getByRole('button', { name: '保存资料' }).click();
  await page.getByRole('status').filter({ hasText: '合作伙伴资料已保存' }).waitFor();
  await page.evaluate(() => {
    window.__posterText = [];
  });
  await selectModule(page, '推广素材');
  await canvas.waitFor({ state: 'visible' });
  assert.ok((await page.evaluate(() => window.__posterText.join(''))).includes('更新后的伙伴'));
});


test('unpublished partner profiles and disabled directories do not offer a broken public preview', async (t) => {
  const { page } = await setup(t, 375, { profile: { publicStatus: 'published' } });
  await selectModule(page, '推广素材');
  assert.equal(await page.getByRole('link', { name: '预览公开详情' }).count(), 0);
  await page.getByText(/主办方尚未开放公开目录/).waitFor();
  await selectModule(page, '提现与结算');
  assert.equal(await page.getByRole('combobox', { name: /^结算渠道/ }).inputValue(), 'manual_bank');
  assert.equal(await page.getByRole('combobox', { name: /^结算渠道/ }).getByRole('option', { name: '微信商家转账', exact: true }).count(), 0);
});


test('earnings is the default homepage and summary appears only there', async (t) => {
  const { page } = await setup(t);
  await page.goto(`${base}/account/partnerships/101`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#partner-module-title').innerText(), '推广收益');
  assert.equal(await page.locator('.balance-strip').count(), 1);
  assert.equal(await page.getByRole('heading', { name: '推广效果', exact: true }).count(), 1);
  await selectModule(page, '推广素材');
  assert.equal(await page.locator('.balance-strip').count(), 0);
  assert.equal(await page.getByRole('heading', { name: '推广效果', exact: true }).count(), 0);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#partner-module-title').innerText(), '推广素材');
});

test('poster draft survives avatar navigation and saved copy survives reload', async (t) => {
  const { page, writes } = await setup(t);
  await selectModule(page, '推广素材');
  await page.getByLabel(/^邀请语/).fill('期待与你交流');
  await page.getByRole('button', { name: '修改头像', exact: true }).click();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByRole('heading', { name: '推广素材', exact: true }).waitFor();
  assert.equal(await page.getByLabel(/^邀请语/).inputValue(), '期待与你交流');
  await page.getByRole('button', { name: '保存文案', exact: true }).click();
  await page.getByText('海报文案已保存', { exact: true }).waitFor();
  assert.ok(writes.some(w => w.path.endsWith('/poster-copy') && w.body.posterCopy.invitation === '期待与你交流'));
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByLabel(/^邀请语/).inputValue(), '期待与你交流');
});

test('partner default invitation stays visible alongside company and title', async (t) => {
  const { page } = await setup(t, 375, {
    profile: { company: '合作公司', title: '负责人', posterCopy: { invitation: '', introduction: '' } },
  });
  await selectModule(page, '推广素材');
  await page.getByLabel('合作伙伴推广海报预览').waitFor({ state: 'visible' });
  assert.ok((await page.evaluate(() => window.__posterText.join(''))).includes('期待在大会现场与你见面'));
});

test('poster controls stay locked while a save is pending', async (t) => {
  const { page } = await setup(t);
  await selectModule(page, '推广素材');
  await page.getByLabel(/^邀请语/).fill('保存中的邀请语');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/poster-copy', async route => { await gate; await route.fallback(); });
  try {
    await page.getByRole('button', { name: '保存文案', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.promotion-tip input')?.disabled);
    assert.equal(await page.getByLabel(/^邀请语/).isDisabled(), true);
    assert.equal(await page.getByLabel(/^合作介绍/).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '恢复默认文案' }).isDisabled(), true);
  } finally { release(); }
  await page.getByText('海报文案已保存', { exact: true }).waitFor();
  assert.equal(await page.getByLabel(/^邀请语/).inputValue(), '保存中的邀请语');
});


test('all three poster areas have defaults and custom scan copy survives reload', async (t) => {
  const { page, writes } = await setup(t, 375);
  await selectModule(page, '推广素材');
  assert.equal(await page.getByLabel(/^邀请语/).inputValue(), '期待在大会现场与你见面');
  assert.equal(await page.getByLabel(/^合作介绍/).inputValue(), '正在寻找行业伙伴、业务交流与新的合作机会。');
  assert.equal(await page.getByLabel(/^扫码引导标题/).inputValue(), '现场见，一起聊聊');
  await page.getByLabel(/^合作介绍/).fill('欢迎共同探索新的合作机会');
  await page.getByLabel(/^扫码引导标题/).fill('扫码一起参加大会');
  await page.getByLabel(/^扫码引导说明/).fill('期待与你相聚深圳');
  await page.getByRole('button', { name: '保存文案', exact: true }).click();
  await page.getByText('海报文案已保存', { exact: true }).waitFor();
  assert.ok(writes.some(w => w.body?.posterCopy?.callToAction === '扫码一起参加大会'));
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByLabel(/^扫码引导说明/).inputValue(), '期待与你相聚深圳');
  await page.getByLabel('合作伙伴推广海报预览').waitFor({ state: 'visible' });
  const text = await page.evaluate(() => window.__posterText.join(''));
  assert.ok(text.includes('欢迎共同探索新的合作机会'));
  assert.ok(text.includes('扫码一起参加大会'));
  assert.ok(text.includes('期待与你相聚深圳'));
  await page.getByRole('button', { name: '恢复默认文案' }).click();
  assert.equal(await page.getByLabel(/^扫码引导标题/).inputValue(), '现场见，一起聊聊');
  await assertFits(page);
  await page.screenshot({ path: `${output}/poster-three-defaults-375.png`, fullPage: true });
});
