<script setup lang="ts">
import { navigateTo } from '#app';
import { definePageMeta } from '#imports';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { PartnerPosterCopySchema } from '@conference/contracts';
import type {
  PartnerRelationshipView,
  CustomerPartnerInquiryView,
  PartnerPayoutChannelAvailability,
  PartnerVisibleFields,
  PublicEvent,
} from '@conference/contracts';
import QRCode from 'qrcode.vue';
import { renderPersonalEventPoster } from '~/utils/personal-event-poster';
import { partnerPosterFilename, resolvePartnerPosterContent, resolvePartnerPosterCopy } from '~/utils/partner-poster';
import { nextTick, watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';
import { copyPlainText } from '~/utils/copy-text';

type Tab = 'profile' | 'promotion' | 'earnings' | 'payouts' | 'inquiries';
type FinanceRow = Record<string, unknown> & { id?: string; status?: string; version?: number };

definePageMeta({ key: route => String(route.params.eventId) });
const route = useRoute();
const customer = useCustomerSession();
const conferenceApi = useConferenceApi();
const posterEvent = ref<PublicEvent | null>(null);
const posterCanvas = ref<HTMLCanvasElement | null>(null);
const posterQrHolder = ref<HTMLElement | null>(null);
const posterReady = ref(false);
const posterRendering = ref(false);
const posterError = ref('');
let posterRenderVersion = 0;
const eventId = computed(() => Number(route.params.eventId));
const partner = ref<PartnerRelationshipView | null>(null);
const commissions = ref<FinanceRow[]>([]);
const payouts = ref<FinanceRow[]>([]);
const inquiryHistory = ref<CustomerPartnerInquiryView[]>([]);
const inquiriesHasMore = ref(false);
const payoutChannels = ref<PartnerPayoutChannelAvailability[]>([]);
const wechatPayoutEnabled = computed(() =>
  payoutChannels.value.some((item) => item.channel === 'wechat_transfer' && item.enabled),
);
const minimumPayout = computed(
  () => (partner.value?.currentProgram?.minimumPayoutAmount ?? 1000) / 100,
);
const recipients = ref<FinanceRow[]>([]);
const payoutDocuments = ref<FinanceRow[]>([]);
const activeTab = computed<Tab>({
  get: () =>
    ['profile', 'promotion', 'earnings', 'payouts', 'inquiries'].includes(String(route.query.tab))
      ? (route.query.tab as Tab)
      : 'earnings',
  set: (tab) => {
    void navigateTo({ query: { ...route.query, tab } });
  },
});
const mobileNavOpen = ref(false);
const mobileNav = ref<HTMLElement | null>(null);
const mobileNavTrigger = ref<HTMLButtonElement | null>(null);
const moduleSection = ref<HTMLElement | null>(null);
const loading = ref(true);
const pending = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const pendingAvatarAssetId = ref<string | undefined>();
const avatarPreview = ref('');
const profileForm = reactive({
  displayName: '',
  company: '',
  title: '',
  industry: '',
  businessIntro: '',
  businessUrl: '',
  contactPhone: '',
  contactEmail: '',
  wechatId: '',
});
const visibility = reactive<PartnerVisibleFields>({
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
});
const posterVisibility = reactive<PartnerVisibleFields>({
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
});
const privacyForm = reactive({
  publicStatus: 'draft' as 'draft' | 'published' | 'hidden',
  searchIndexingEnabled: true,
});
const gallery = ref<Array<{ assetId: string; url: string; alt: string }>>([]);
const recipientForm = reactive({
  type: 'individual',
  channel: 'manual_bank',
  displayName: '',
  accountReference: '',
});
const payoutForm = reactive({ recipientId: '', amountYuan: '10' });
const inquiryForm = reactive({ type: 'missing_order', orderReference: '', description: '' });

const tabs: Array<{ id: Tab; label: string; caption: string; description: string }> = [
  {
    id: 'earnings',
    label: '推广收益',
    caption: 'EARNINGS',
    description: '查看每笔订单的佣金和结算进度。',
  },
  {
    id: 'promotion',
    label: '推广素材',
    caption: 'PROMOTION',
    description: '分享专属链接与海报，邀请朋友通过你报名。',
  },
  {
    id: 'profile',
    label: '资料设置',
    caption: 'PROFILE & PRIVACY',
    description: '完善大会名片，选择你愿意公开的信息。',
  },
  {
    id: 'payouts',
    label: '提现与结算',
    caption: 'PAYOUTS',
    description: '管理收款信息、申请提现并查看结算记录。',
  },
  {
    id: 'inquiries',
    label: '佣金申诉',
    caption: 'INQUIRIES',
    description: '提供订单信息，申请核对佣金。',
  },
];
const currentTab = computed(() => tabs.find((tab) => tab.id === activeTab.value)!);
const currentTabNumber = computed(() =>
  String(tabs.findIndex((tab) => tab.id === activeTab.value) + 1).padStart(2, '0'),
);
const partnerInitial = computed(() => partner.value?.profile.displayName.slice(0, 1) || 'P');
function closeMobileNav(event: PointerEvent) {
  if (event.target instanceof Node && !mobileNav.value?.contains(event.target))
    mobileNavOpen.value = false;
}
function escapeMobileNav() {
  if (!mobileNavOpen.value) return;
  mobileNavOpen.value = false;
  mobileNavTrigger.value?.focus();
}
watch(activeTab, async () => {
  mobileNavOpen.value = false;
  await nextTick();
  if (moduleSection.value && moduleSection.value.getBoundingClientRect().top < 80) {
    moduleSection.value.scrollIntoView({ block: 'start' });
  }
});
const statusText: Record<string, string> = {
  pending_confirmation: '待确认合作规则',
  active: '合作中',
  paused: '已暂停',
  closed: '已关闭',
  provisional: '预计',
  pending: '结算等待中',
  available: '已过等待期',
  partially_reversed: '部分冲正',
  reversed: '已冲正',
  held: '暂缓结算',
  cancelled: '已取消',
  reserved: '提现处理中',
  paid: '已结算',
  recovery_due: '待追偿',
  submitted: '待审核',
  approved: '审核通过',
  under_review: '待确认结算金额',
  batched: '已组批',
  executing: '出款中',
  succeeded: '已到账',
  rejected: '已驳回',
  failed: '失败',
  unknown: '渠道待确认',
  verified: '已验证',
  hidden: '已隐藏',
  published: '已公开',
  draft: '草稿',
};
const visibleChoices: Array<{ key: keyof PartnerVisibleFields; label: string }> = [
  { key: 'avatar', label: '头像' },
  { key: 'displayName', label: '姓名' },
  { key: 'company', label: '公司' },
  { key: 'title', label: '职位' },
  { key: 'industry', label: '行业' },
  { key: 'businessIntro', label: '介绍' },
  { key: 'businessUrl', label: '项目网址' },
  { key: 'contactPhone', label: '联系电话' },
  { key: 'contactEmail', label: '联系邮箱' },
  { key: 'wechatId', label: '微信号' },
  { key: 'gallery', label: '图片资料' },
];
const referralUrl = computed(() => {
  const path = partner.value?.referralPath ?? '';
  return import.meta.client && path ? new URL(path, window.location.origin).toString() : path;
});
const confirmed = computed(() =>
  Boolean(
    partner.value?.currentProgram?.id &&
    partner.value.acceptedProgramVersionId === partner.value.currentProgram.id,
  ),
);
const verifiedRecipients = computed(() =>
  recipients.value.filter((item) => item.status === 'verified'),
);
const posterDraft = reactive({ invitation: '', introduction: '', callToAction: '', scanHint: '' });
const posterDirty = computed(() => {
  if (!partner.value) return false;
  const saved = resolvePartnerPosterCopy(partner.value.profile);
  return (Object.keys(posterDraft) as Array<keyof typeof posterDraft>).some(key => posterDraft[key] !== saved[key]);
});
const returnFromAvatar = ref(false);
async function editPosterAvatar() {
  returnFromAvatar.value = true;
  await navigateTo({ query: { ...route.query, tab: 'profile', focus: 'avatar' } });
  await nextTick();
  document.querySelector<HTMLElement>('.avatar-editor input')?.focus();
  document.querySelector('.avatar-editor')?.scrollIntoView({ block: 'center' });
}
function savePosterCopy() {
  if (!partner.value) return;
  const validation = PartnerPosterCopySchema.safeParse(posterDraft);
  if (!validation.success) {
    const issue = validation.error.issues[0]!;
    const labels: Record<string, string> = { invitation: '邀请语', introduction: '合作介绍', callToAction: '扫码引导标题', scanHint: '扫码引导说明' };
    errorMessage.value = `${labels[String(issue.path[0])] ?? '海报文案'}：${issue.message}`;
    return;
  }
  return run(async () => {
    const value = await customer.updatePartnerPosterCopy(eventId.value, {
      expectedVersion: partner.value!.version,
      posterCopy: { ...posterDraft },
    });
    hydrate(value);
    Object.assign(posterDraft, resolvePartnerPosterCopy(value.profile));
  }, '海报文案已保存');
}
onBeforeRouteLeave(() => !posterDirty.value || window.confirm('海报文案尚未保存，确定离开？'));
onBeforeRouteUpdate((to, from) => to.params.eventId === from.params.eventId || !posterDirty.value || window.confirm('海报文案尚未保存，确定切换大会？'));
function confirmPosterUnload(event: BeforeUnloadEvent) {
  if (posterDirty.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => window.addEventListener('beforeunload', confirmPosterUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', confirmPosterUnload));
const posterContent = computed(() =>
  partner.value
    ? resolvePartnerPosterContent({ ...partner.value.profile, posterCopy: { ...posterDraft } })
    : null,
);
const posterEventLine = computed(() => {
  const value = posterEvent.value;
  if (!value?.startsAt) return value?.city || '大会现场';
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: value.timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(value.startsAt));
  return [date, value.city].filter(Boolean).join(' · ');
});
async function loadPosterEvent() {
  const slug = partner.value?.eventSlug;
  posterEvent.value = null;
  if (!slug) return;
  try {
    const value = await conferenceApi.getEvent(slug);
    if (value.slug === slug) posterEvent.value = value;
  } catch {
    // The partner's event name still identifies the poster when public details are unavailable.
  }
}

watch(
  () => recipientForm.type,
  (type) => {
    if (type === 'organization') recipientForm.channel = 'manual_bank';
  },
);

function money(value: unknown) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(
    Number(value ?? 0) / 100,
  );
}
function dateTime(value: unknown) {
  return typeof value === 'string' && value ? new Date(value).toLocaleString('zh-CN') : '暂无';
}
function hydrate(value: PartnerRelationshipView) {
  if (!partner.value || !posterDirty.value)
    Object.assign(posterDraft, resolvePartnerPosterCopy(value.profile));
  partner.value = value;
  Object.assign(profileForm, value.profile);
  Object.assign(visibility, value.profile.visibleFields);
  Object.assign(posterVisibility, value.profile.posterFields);
  privacyForm.publicStatus = value.profile.publicStatus;
  privacyForm.searchIndexingEnabled = value.profile.searchIndexingEnabled;
  gallery.value = value.profile.gallery.map((item) => ({ ...item }));
  avatarPreview.value = value.profile.avatarUrl ?? '';
  pendingAvatarAssetId.value = undefined;
}
async function refreshFinance() {
  const [commissionResult, payoutResult, inquiryResult] = await Promise.all([
    customer.partnerCommissions(eventId.value),
    customer.partnerPayouts(eventId.value),
    customer.partnerInquiries(eventId.value),
  ]);
  inquiryHistory.value = inquiryResult.items;
  inquiriesHasMore.value = inquiryResult.hasMore;
  payoutChannels.value = payoutResult.channels ?? [];
  if (!wechatPayoutEnabled.value) recipientForm.channel = 'manual_bank';
  commissions.value = commissionResult.items;
  payouts.value = payoutResult.requests;
  recipients.value = payoutResult.recipients;
  payoutDocuments.value = payoutResult.documents;
  if (!payoutForm.recipientId && verifiedRecipients.value[0]?.id)
    payoutForm.recipientId = String(verifiedRecipients.value[0].id);
}
async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    await customer.refresh();
    if (!customer.session.value) return customer.openLogin();
    hydrate(await customer.partnership(eventId.value));
    if (import.meta.client) {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const handoffCode = fragment.get('partner-recipient-handoff');
      if (handoffCode) {
        await customer.completePartnerWechatRecipientBinding(eventId.value, handoffCode);
        window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
        successMessage.value = '微信收款人已完成身份授权和绑定';
      }
    }
    await Promise.all([refreshFinance(), loadPosterEvent()]);
  } catch (error) {
    errorMessage.value =
      (error as { data?: { message?: string } }).data?.message ?? '合作伙伴中心暂时无法加载';
  } finally {
    loading.value = false;
  }
}
async function run(action: () => Promise<void>, message: string) {
  if (pending.value) return;
  pending.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    await action();
    successMessage.value = message;
  } catch (error) {
    errorMessage.value =
      (error as { data?: { message?: string }; message?: string }).data?.message ??
      (error as Error).message ??
      '操作失败，请稍后重试';
  } finally {
    pending.value = false;
  }
}
function acceptRules() {
  const current = partner.value?.currentProgram;
  if (!partner.value || !current) return;
  return run(
    async () =>
      hydrate(
        await customer.acceptPartnerProgram(eventId.value, {
          programVersionId: current.id,
          expectedPartnerVersion: partner.value!.version,
        }),
      ),
    '合作规则已确认，专属推广链接已经生效',
  );
}
function saveProfile() {
  if (!partner.value) return;
  return run(async () => {
    hydrate(
      await customer.updatePartnerProfile(eventId.value, {
        expectedVersion: partner.value!.version,
        ...profileForm,
        ...(pendingAvatarAssetId.value ? { avatarAssetId: pendingAvatarAssetId.value } : {}),
        gallery: gallery.value.map(({ assetId, alt }) => ({ assetId, alt })),
      }),
    );
    if (returnFromAvatar.value) {
      returnFromAvatar.value = false;
      await navigateTo({ query: { tab: 'promotion' } });
    }
  }, '合作伙伴资料已保存');
}
function savePrivacy() {
  if (!partner.value) return;
  return run(
    async () =>
      hydrate(
        await customer.updatePartnerPrivacy(eventId.value, {
          expectedVersion: partner.value!.version,
          publicStatus: privacyForm.publicStatus,
          visibleFields: { ...visibility },
          posterFields: { ...posterVisibility },
          searchIndexingEnabled: privacyForm.searchIndexingEnabled,
        }),
      ),
    '公开范围已更新',
  );
}
async function uploadAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await run(async () => {
    const uploaded = await customer.uploadPartnerMedia(eventId.value, 'avatar', file);
    pendingAvatarAssetId.value = uploaded.assetId;
    avatarPreview.value = URL.createObjectURL(file);
  }, '头像已上传，请保存资料');
}
async function uploadGallery(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || gallery.value.length >= 4) return;
  await run(async () => {
    const uploaded = await customer.uploadPartnerMedia(eventId.value, 'gallery', file);
    gallery.value.push({
      assetId: uploaded.assetId,
      url: URL.createObjectURL(file),
      alt: file.name.replace(/\.[^.]+$/u, ''),
    });
  }, '图片已加入，请保存资料');
}
async function copyLink() {
  if (await copyPlainText(referralUrl.value)) successMessage.value = '推广链接已复制';
}
async function renderPoster() {
  const version = ++posterRenderVersion;
  const canvas = posterCanvas.value;
  const qrCanvas = posterQrHolder.value?.querySelector('canvas');
  const value = partner.value;
  const content = posterContent.value;
  if (!canvas || !qrCanvas || !value || !content || !referralUrl.value) return;
  posterRendering.value = true;
  posterError.value = '';
  try {
    const rendered = await renderPersonalEventPoster(canvas, qrCanvas, {
      variant: 'partner',
      eventName: value.eventName,
      eventMark: posterEvent.value?.shortName?.trim() || value.eventName,
      eventLine: posterEventLine.value,
      location: posterEvent.value?.city?.trim() || '大会现场',
      content,
    });
    if (version === posterRenderVersion && canvas === posterCanvas.value)
      posterReady.value = rendered;
  } catch (error) {
    if (version === posterRenderVersion)
      posterError.value = error instanceof Error ? error.message : '海报生成失败，请重试';
  } finally {
    if (version === posterRenderVersion) posterRendering.value = false;
  }
}
function downloadPoster() {
  const canvas = posterCanvas.value;
  if (!canvas || !partner.value || !posterReady.value || posterRendering.value) return;
  return run(async () => {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('海报生成失败，请重试'))),
        'image/png',
      );
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = partnerPosterFilename(
      posterContent.value?.displayName ?? null,
      partner.value!.eventName,
    );
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  }, '推广海报下载已开始');
}
watch(
  [loading, activeTab, partner, posterEvent, referralUrl, () => JSON.stringify(posterDraft)],
  async () => {
    ++posterRenderVersion;
    posterReady.value = false;
    posterRendering.value = false;
    posterError.value = '';
    if (loading.value || activeTab.value !== 'promotion') return;
    await nextTick();
    await renderPoster();
  },
  { flush: 'post' },
);

function bindRecipient() {
  if (recipientForm.channel === 'wechat_transfer') {
    return run(async () => {
      const result = await customer.startPartnerWechatRecipientBinding(
        eventId.value,
        recipientForm.displayName,
      );
      window.location.assign(result.authorizeUrl);
    }, '正在进入微信身份授权');
  }
  return run(async () => {
    await customer.bindPartnerRecipient(eventId.value, {
      ...recipientForm,
      idempotencyKey: crypto.randomUUID(),
    });
    await refreshFinance();
  }, '收款信息已提交，验证完成后可用于提现');
}
function requestPayout() {
  return run(async () => {
    await customer.createPartnerPayout(eventId.value, {
      amount: Math.round(Number(payoutForm.amountYuan) * 100),
      recipientId: payoutForm.recipientId,
      idempotencyKey: crypto.randomUUID(),
    });
    await refreshFinance();
    if (partner.value) hydrate(await customer.partnership(eventId.value));
  }, '提现申请已提交');
}
function confirmSettlement(request: FinanceRow) {
  if (!request.id || !request.version) return;
  return run(async () => {
    await customer.confirmPartnerPayoutSettlement(eventId.value, request.id!, request.version!);
    await refreshFinance();
  }, '结算金额已确认，提现进入待组批状态');
}
function submitInquiry() {
  return run(async () => {
    await customer.createPartnerInquiry(eventId.value, { ...inquiryForm, evidenceAssetIds: [] });
    inquiryForm.orderReference = '';
    inquiryForm.description = '';
    await refreshFinance();
  }, '佣金申诉已提交');
}
async function confirmWechat(request: FinanceRow) {
  if (!request.id) return;
  await run(async () => {
    const payload = await customer.partnerPayoutConfirmation(eventId.value, request.id!);
    const bridge = (
      window as unknown as {
        WeixinJSBridge?: {
          invoke: (
            name: string,
            input: Record<string, string>,
            callback: (result: { err_msg?: string }) => void,
          ) => void;
        };
      }
    ).WeixinJSBridge;
    if (!bridge) throw new Error('请在微信中打开本页面完成确认');
    await new Promise<void>((resolve, reject) =>
      bridge.invoke(
        'requestMerchantTransfer',
        { mchId: payload.mchId, appId: payload.appId, package: payload.package },
        (result) =>
          result.err_msg?.includes(':ok') ? resolve() : reject(new Error('微信确认未完成')),
      ),
    );
    await customer.markPartnerPayoutConfirmed(eventId.value, request.id!, payload.requestVersion);
    await refreshFinance();
  }, '微信确认已提交，请等待到账结果');
}
function documentsForPayout(requestId: unknown) {
  return payoutDocuments.value.filter((item) => item.payoutRequestId === requestId);
}
function downloadPayoutDocument(document: FinanceRow) {
  if (!document.id) return;
  return run(
    () => customer.downloadPartnerPayoutDocument(eventId.value, document.id!),
    '结算文件下载已开始',
  );
}

onMounted(() => {
  void load();
  document.addEventListener('pointerdown', closeMobileNav);
});
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeMobileNav));
watch(
  () => customer.session.value?.customer.id,
  (id, previous) => {
    if (id && id !== previous && !loading.value) void load();
    if (!id) partner.value = null;
  },
);
watch(
  visibility,
  (current) => {
    for (const key of visibleChoices.map((item) => item.key)) {
      if (!current[key]) posterVisibility[key] = false;
    }
  },
  { deep: true },
);
useHead({ title: '合作伙伴中心' });
</script>

<template>
  <div class="flow-page account-page partner-account-page">
    <FlowHeader />
    <main id="main-content" class="account-shell">
      <div v-if="loading" class="account-loading" role="status">
        <span aria-hidden="true"></span>
        <p>正在加载合作伙伴中心…</p>
      </div>
      <template v-else>
        <header class="account-heading">
          <div>
            <p class="flow-eyebrow">PARTNER ACCOUNT</p>
            <h1>合作伙伴中心</h1>
            <p>
              {{ partner?.eventName || '在这里管理你的大会合作资料与推广收益。' }}
              <span
                v-if="partner"
                class="mobile-partner-status status-badge"
                :class="{ 'is-success': partner.qualificationStatus === 'active' }"
              >{{ statusText[partner.qualificationStatus] }}</span>
            </p>
          </div>
          <NuxtLink class="account-back-link" to="/account">
            返回个人中心 <span aria-hidden="true">↗</span>
          </NuxtLink>
        </header>
        <section v-if="!customer.session.value" class="account-surface account-empty">
          <span class="section-index">YOUR PARTNERSHIP</span>
          <h2>登录后查看合作伙伴中心</h2>
          <p>使用开通合作伙伴资格的手机号登录，即可管理资料与收益。</p>
          <button type="button" class="account-primary" @click="customer.openLogin()">
            验证码登录 <span aria-hidden="true">→</span>
          </button>
        </section>
        <section v-else-if="!partner" class="account-surface account-empty" role="status">
          <span class="section-index">YOUR PARTNERSHIP</span>
          <h2>暂时无法查看合作信息</h2>
          <p>{{ errorMessage || '当前大会尚未开通合作伙伴权限，请联系大会运营人员。' }}</p>
          <button type="button" class="account-secondary" @click="load">重新加载</button>
        </section>
        <div v-else class="account-workspace">
          <aside class="account-rail" aria-label="合作伙伴导航">
            <div class="account-rail__identity">
              <div class="account-avatar">
                <img
                  v-if="partner.profile.avatarUrl"
                  :src="partner.profile.avatarUrl"
                  alt=""
                /><span v-else>{{ partnerInitial }}</span>
              </div>
              <div>
                <strong>{{ partner.profile.displayName }}</strong><span
                  class="partner-status"
                  :class="{ 'is-active': partner.qualificationStatus === 'active' }"
                ><i aria-hidden="true"></i>{{ statusText[partner.qualificationStatus] }}</span>
              </div>
            </div>
            <p class="account-rail__company">{{ partner.profile.company || '大会合作伙伴' }}</p>
            <nav class="account-nav account-nav--desktop" aria-label="合作伙伴中心模块">
              <button
                v-for="(tab, index) in tabs"
                :key="tab.id"
                type="button"
                :aria-current="activeTab === tab.id ? 'page' : undefined"
                aria-controls="partner-module"
                @click="activeTab = tab.id"
              >
                <span>{{ String(index + 1).padStart(2, '0') }}</span>{{ tab.label }}
              </button>
            </nav>
            <div class="account-rail__footer">
              <span>当前合作大会</span>
              <p>{{ partner.eventName }}</p>
              <small>合作资料与收益按大会独立管理。</small>
            </div>
            <div
              ref="mobileNav"
              class="account-mobile-nav"
              @keydown.esc.stop.prevent="escapeMobileNav"
            >
              <button
                ref="mobileNavTrigger"
                type="button"
                class="account-mobile-trigger"
                :aria-expanded="mobileNavOpen"
                aria-controls="partner-mobile-menu"
                @click="mobileNavOpen = !mobileNavOpen"
              >
                <span>合作伙伴导航</span><strong>{{ currentTab.label }}</strong><i aria-hidden="true">{{ mobileNavOpen ? '−' : '+' }}</i>
              </button>
              <nav
                v-if="mobileNavOpen"
                id="partner-mobile-menu"
                class="account-mobile-panel"
                aria-label="切换合作伙伴模块"
              >
                <button
                  v-for="(tab, index) in tabs"
                  :key="tab.id"
                  type="button"
                  :aria-current="activeTab === tab.id ? 'page' : undefined"
                  @click="
                    activeTab = tab.id;
                    mobileNavOpen = false;
                    mobileNavTrigger?.focus();
                  "
                >
                  <span>{{ String(index + 1).padStart(2, '0') }}</span>{{ tab.label }}
                </button>
              </nav>
            </div>
          </aside>
          <div class="account-content">
            <div
              v-if="errorMessage || successMessage"
              class="account-message"
              :class="errorMessage ? 'is-error' : 'is-success'"
              :role="errorMessage ? 'alert' : 'status'"
            >
              <span aria-hidden="true">{{ errorMessage ? '!' : '✓' }}</span>
              <p>{{ errorMessage || successMessage }}</p>
            </div>
            <section
              v-if="!confirmed && partner.currentProgram"
              class="account-surface rules-card"
              aria-labelledby="rules-title"
            >
              <span class="section-index">BEFORE YOU START</span>
              <h2 id="rules-title">{{ partner.currentProgram.termsTitle }}</h2>
              <p class="hint">确认本期合作规则后，即可开始推广。</p>
              <div class="rules-copy" tabindex="0" aria-label="合作规则正文">
                {{ partner.currentProgram.termsContent }}
              </div>
              <p class="hint">{{ partner.currentProgram.promotionPolicy }}</p>
              <button
                type="button"
                class="account-primary"
                :disabled="pending"
                @click="acceptRules"
              >
                确认规则并开通推广 <span aria-hidden="true">→</span>
              </button>
            </section>

            <section
              id="partner-module"
              ref="moduleSection"
              class="account-section"
              aria-labelledby="partner-module-title"
            >
              <header class="account-section__heading">
                <div>
                  <span class="section-index">{{ currentTabNumber }} / {{ currentTab.caption }}</span>
                  <h2 id="partner-module-title">{{ currentTab.label }}</h2>
                </div>
                <p>{{ currentTab.description }}</p>
              </header>

              <div v-if="activeTab === 'profile'" class="section-stack">
                <form class="account-surface" @submit.prevent="saveProfile">
                  <div class="surface-heading">
                    <h3>合作伙伴资料</h3>
                    <p>用于当前大会的合作伙伴名片与介绍页。</p>
                  </div>
                  <div class="account-form">
                    <div class="avatar-editor wide" tabindex="-1">
                      <div class="profile-avatar">
                        <img
                          v-if="avatarPreview"
                          :src="avatarPreview"
                          alt="合作伙伴头像预览"
                        /><span v-else>{{ partnerInitial }}</span>
                      </div>
                      <div>
                        <label class="account-secondary file-control">上传头像<input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          :disabled="pending"
                          @change="uploadAvatar"
                        /></label>
                        <p class="field-hint">支持 JPG、PNG、WebP，上传后请保存资料。</p>
                      </div>
                    </div>
                    <label>公开姓名 <span class="required">必填</span><input
                      v-model="profileForm.displayName"
                      required
                      maxlength="80"
                      autocomplete="name"
                    /></label>
                    <label>公司<input
                      v-model="profileForm.company"
                      maxlength="160"
                      autocomplete="organization"
                      placeholder="填写公司或机构名称"
                    /></label>
                    <label>职位<input
                      v-model="profileForm.title"
                      maxlength="100"
                      autocomplete="organization-title"
                      placeholder="填写你的职位"
                    /></label>
                    <label>行业<input
                      v-model="profileForm.industry"
                      maxlength="80"
                      placeholder="例如：企业服务"
                    /></label>
                    <label class="wide">个人或业务介绍<textarea
                      v-model="profileForm.businessIntro"
                      rows="5"
                      maxlength="2000"
                      placeholder="介绍你的专业领域、业务或合作方向"
                    ></textarea><span class="field-hint">最多 2,000 字。</span></label>
                    <label class="wide">项目网址<input
                      v-model="profileForm.businessUrl"
                      type="url"
                      placeholder="https://"
                      inputmode="url"
                    /></label>
                    <label>联系电话<input
                      v-model="profileForm.contactPhone"
                      type="tel"
                      maxlength="32"
                      autocomplete="tel"
                      placeholder="选填，公开范围由你决定"
                    /></label>
                    <label>联系邮箱<input
                      v-model="profileForm.contactEmail"
                      type="email"
                      autocomplete="email"
                      placeholder="选填，公开范围由你决定"
                    /></label>
                    <label>微信号<input
                      v-model="profileForm.wechatId"
                      maxlength="80"
                      placeholder="填写微信号"
                    /></label>
                    <div class="gallery-editor wide">
                      <div class="section-row">
                        <div>
                          <h3>图片资料</h3>
                          <p class="field-hint">最多 4 张，可展示个人形象或业务内容。</p>
                        </div>
                        <label v-if="gallery.length < 4" class="account-secondary file-control">添加图片<input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          :disabled="pending"
                          @change="uploadGallery"
                        /></label>
                      </div>
                      <div v-if="gallery.length" class="gallery-list">
                        <div v-for="(item, index) in gallery" :key="item.assetId">
                          <img :src="item.url" :alt="item.alt" /><label>图片 {{ index + 1 }} 说明<input
                            v-model="item.alt"
                            maxlength="120"
                          /></label><button
                            type="button"
                            class="text-button"
                            :disabled="pending"
                            @click="gallery.splice(index, 1)"
                          >
                            移除图片
                          </button>
                        </div>
                      </div>
                    </div>
                    <div class="form-actions wide">
                      <button class="account-primary" :disabled="pending">
                        {{ pending ? '处理中…' : '保存资料' }}
                        <span aria-hidden="true">→</span>
                      </button><small>修改仅用于当前大会。</small>
                    </div>
                  </div>
                </form>
                <form class="account-surface" @submit.prevent="savePrivacy">
                  <div class="surface-heading">
                    <h3>公开授权</h3>
                    <p>选择可公开的信息，海报只使用已授权公开的字段。</p>
                  </div>
                  <div class="privacy-content">
                    <label class="privacy-status">资料状态<select v-model="privacyForm.publicStatus">
                      <option value="draft">草稿，暂不展示</option>
                      <option value="published">公开展示</option>
                      <option value="hidden">暂时隐藏</option>
                    </select></label>
                    <table class="privacy-table">
                      <caption class="sr-only">
                        详情页与海报的公开字段设置
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">资料字段</th>
                          <th scope="col">详情页公开</th>
                          <th scope="col">允许海报使用</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="item in visibleChoices" :key="item.key">
                          <th scope="row">{{ item.label }}</th>
                          <td>
                            <label class="check-control"><input
                              v-model="visibility[item.key]"
                              type="checkbox"
                              :aria-label="`详情页公开${item.label}`"
                            /></label>
                          </td>
                          <td>
                            <label class="check-control"><input
                              v-model="posterVisibility[item.key]"
                              type="checkbox"
                              :disabled="!visibility[item.key]"
                              :aria-label="`允许海报使用${item.label}`"
                            /></label>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <label class="switch-line"><input
                      v-model="privacyForm.searchIndexingEnabled"
                      type="checkbox"
                    />允许搜索引擎收录公开详情页</label>
                    <p class="field-hint">关闭详情页中的某个字段后，海报的对应授权会同步关闭。</p>
                    <div class="form-actions">
                      <button class="account-primary" :disabled="pending">
                        保存公开设置 <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </div>
                </form>
              </div>

              <div v-else-if="activeTab === 'promotion'" class="promotion-layout">
                <article class="account-surface promotion-content">
                  <span class="section-index">YOUR REFERRAL LINK</span>
                  <h3>专属推广链接</h3>
                  <p class="hint">
                    朋友通过此链接进入报名页面后，推广来源将保留
                    {{ partner.currentProgram?.attributionDays ?? 30 }} 天。
                  </p>
                  <div class="link-box">
                    <code>{{ referralUrl || '确认合作规则后生成' }}</code>
                  </div>
                  <button
                    type="button"
                    class="account-primary"
                    :disabled="!referralUrl"
                    @click="copyLink"
                  >
                    复制推广链接 <span aria-hidden="true">→</span>
                  </button>
                  <div class="promotion-actions">
                    <a
                      v-if="referralUrl"
                      :href="referralUrl"
                      target="_blank"
                      rel="noopener"
                      class="account-secondary"
                    >测试推广入口 ↗</a><a
                      v-if="
                        partner.directoryEnabled &&
                          partner.profile.publicStatus === 'published' &&
                          partner.qualificationStatus === 'active'
                      "
                      :href="`/partners/${partner.publicSlug}?event=${partner.eventSlug}`"
                      class="account-secondary"
                    >预览公开详情 ↗</a>
                  </div>
                  <p v-if="!partner.directoryEnabled" class="field-hint">
                    主办方尚未开放公开目录，个人详情暂不可访问；专属推广链接确认规则后仍可使用。
                  </p>
                  <p v-else-if="partner.profile.publicStatus !== 'published'" class="field-hint">
                    请在资料设置中选择公开发布后查看个人详情。
                  </p>

                  <div class="promotion-tip poster-copy-editor">
                    <h3>海报文案设置</h3>
                    <label>邀请语 <small>{{ Array.from(posterDraft.invitation).length }}/32</small><input v-model="posterDraft.invitation" :disabled="pending" placeholder="期待在大会现场与你见面" /></label>
                    <label>合作介绍 <small>{{ Array.from(posterDraft.introduction).length }}/80</small><textarea
                      v-model="posterDraft.introduction"
                      :disabled="pending"
                      rows="3"
                      placeholder="留空使用已授权的资料介绍或默认文案"
                    />
                    </label>
                    <p class="field-hint">
                      保存的文案将用于分享海报。姓名、公司和头像请在资料设置修改。
                    </p>
                    <label>扫码引导标题 <small>{{ Array.from(posterDraft.callToAction).length }}/20</small><input v-model="posterDraft.callToAction" :disabled="pending" /></label>
                    <label>扫码引导说明 <small>{{ Array.from(posterDraft.scanHint).length }}/32</small><input v-model="posterDraft.scanHint" :disabled="pending" /></label>
                    <p class="field-hint">以上三个区域已提供大会海报默认文案，可直接修改。保存后用于分享海报，二维码仍指向你的专属报名链接。</p>
                    <p v-if="posterDirty" role="status">文案尚未保存，保存后可下载。</p>
                    <div class="inline-actions">
                      <button
                        type="button"
                        class="account-primary"
                        :disabled="pending || !posterDirty"
                        @click="savePosterCopy"
                      >
                        保存文案
                      </button><button
                        type="button"
                        class="account-secondary"
                        :disabled="pending"
                        @click="Object.assign(posterDraft, resolvePartnerPosterCopy({ ...partner.profile, posterCopy: undefined }))"
                      >
                        恢复默认文案
                      </button>
                    </div>
                    <h3>分享你的大会名片</h3>
                    <p class="hint">
                      完善个人资料并保存公开设置，再下载专属海报，方便朋友扫码报名。
                    </p>
                    <button
                      type="button"
                      class="account-secondary"
                      :disabled="!posterReady || posterRendering || pending || posterDirty"
                      @click="downloadPoster"
                    >
                      下载 1080 × 1440 海报 ↓
                    </button>
                  </div>
                </article>
                <figure class="poster-preview account-surface">
                  <div class="poster-heading">
                    <div>
                      <span class="section-index">PERSONAL POSTER</span>
                      <h3>我的推广海报</h3>
                    </div>
                    <button type="button" class="account-secondary" :disabled="pending" @click="editPosterAvatar">
                      修改头像
                    </button>
                  </div>
                  <canvas
                    v-show="posterReady"
                    ref="posterCanvas"
                    class="promotion-poster"
                    width="1080"
                    height="1440"
                    aria-label="合作伙伴推广海报预览"
                    :aria-busy="posterRendering"
                  />
                  <div
                    v-if="!posterReady"
                    class="poster-placeholder"
                    :role="posterError ? 'alert' : 'status'"
                  >
                    <p>
                      {{
                        posterError ||
                          (referralUrl ? '正在生成推广海报…' : '确认合作规则后生成专属海报')
                      }}
                    </p>
                    <button
                      v-if="posterError"
                      type="button"
                      class="account-secondary"
                      @click="renderPoster"
                    >
                      重新生成
                    </button>
                  </div>
                  <figcaption>每次保存后，预览与下载都会使用最新资料及海报公开授权。</figcaption>
                  <div ref="posterQrHolder" class="poster-qr-source" aria-hidden="true">
                    <QRCode
                      v-if="referralUrl"
                      :value="referralUrl"
                      :size="360"
                      level="M"
                      render-as="canvas"
                    />
                  </div>
                </figure>
              </div>

              <article v-else-if="activeTab === 'earnings'" class="account-surface earnings-surface">
                <section class="balance-strip" aria-label="合作收益概览">
                  <div>
                    <span>可提现收益</span><strong>{{ money(partner.balances.available) }}</strong><small>税前可提现金额</small>
                  </div>
                  <div>
                    <span>待结算</span><strong>{{ money(partner.balances.pending) }}</strong><small>等待结算期结束</small>
                  </div>
                  <div>
                    <span>提现处理中</span><strong>{{ money(partner.balances.reserved) }}</strong><small>已申请的提现金额</small>
                  </div>
                  <div>
                    <span>已结算</span><strong>{{ money(partner.balances.paid) }}</strong><small>累计完成结算</small>
                  </div>
                </section>
                <div class="promotion-tip">
                  <h3>推广效果</h3>
                  <div class="data-list">
                    <article>
                      <span>推广访问次数</span><strong>{{ partner.promotion?.visits ?? 0 }}</strong>
                    </article>
                    <article>
                      <span>每日去重访问人次</span><strong>{{ partner.promotion?.uniqueDailyVisits ?? 0 }}</strong>
                    </article>
                    <article>
                      <span>有效推广订单</span><strong>{{ partner.promotion?.paidOrders ?? 0 }}</strong>
                    </article>
                    <article>
                      <span>有效推广成交额</span><strong>{{ money(partner.promotion?.netSalesAmount) }}</strong>
                    </article>
                  </div>
                  <p class="field-hint">
                    累计数据，仅统计专属入口。访问按日去重后累计；成交额扣除退款和不计佣明细，自购不计入。
                  </p>
                </div>
                <div class="surface-heading section-row">
                  <div>
                    <h3>佣金记录</h3>
                    <p>
                      展示每笔订单扣除冲正后的佣金。可提现余额以页面顶部为准，到账进度见提现与结算记录。
                    </p>
                  </div>
                  <span class="record-count">{{ commissions.length }} 条记录</span>
                </div>
                <div v-if="commissions.length" class="data-list">
                  <article v-for="item in commissions" :key="String(item.id)">
                    <div>
                      <strong style="overflow-wrap: anywhere">订单 {{ String(item.orderId ?? '') }}</strong><small>{{ dateTime(item.createdAt) }}</small>
                    </div>
                    <div>
                      <b>{{
                        money(Number(item.commissionAmount ?? 0) - Number(item.reversedAmount ?? 0))
                      }}</b><small v-if="Number(item.reversedAmount ?? 0)">原佣金 {{ money(item.commissionAmount) }} · 已冲正
                        {{ money(item.reversedAmount) }}</small><span
                        class="status-badge"
                        :class="{
                          'is-success': item.status === 'available' || item.status === 'paid',
                        }"
                      >{{ statusText[String(item.status)] ?? item.status }}</span>
                    </div>
                  </article>
                </div>
                <div v-else class="account-empty">
                  <span class="section-index">YOUR EARNINGS</span>
                  <h3>还没有佣金记录</h3>
                  <p>分享专属推广链接，有效订单产生后可在这里查看收益。</p>
                  <button type="button" class="account-secondary" @click="activeTab = 'promotion'">
                    查看推广素材 <span aria-hidden="true">→</span>
                  </button>
                </div>
              </article>

              <div v-else-if="activeTab === 'payouts'" class="section-stack">
                <div class="payout-layout">
                  <article class="account-surface">
                    <div class="surface-heading">
                      <h3>申请提现</h3>
                      <p>税前金额满 {{ money(minimumPayout * 100) }} 可申请。</p>
                    </div>
                    <form class="stack-form" @submit.prevent="requestPayout">
                      <label>已验证收款人<select v-model="payoutForm.recipientId" required>
                        <option value="">请选择收款人</option>
                        <option
                          v-for="item in verifiedRecipients"
                          :key="String(item.id)"
                          :value="String(item.id)"
                        >
                          {{ item.channel === 'wechat_transfer' ? '微信商家转账' : '人工结算' }}
                        </option>
                      </select></label>
                      <p v-if="!verifiedRecipients.length" class="field-note">
                        请先填写收款信息，验证完成后即可申请提现。
                      </p>
                      <label>税前提现金额（元）<input
                        v-model="payoutForm.amountYuan"
                        type="number"
                        :min="minimumPayout"
                        step="0.01"
                        required
                        inputmode="decimal"
                      /></label>
                      <p class="field-hint">
                        当前可提现
                        {{ money(partner.balances.available) }}，实际到账金额以结算结果为准。
                      </p>
                      <button
                        class="account-primary"
                        :disabled="pending || !payoutForm.recipientId"
                      >
                        提交提现申请 <span aria-hidden="true">→</span>
                      </button>
                    </form>
                  </article>
                  <form class="account-surface" @submit.prevent="bindRecipient">
                    <div class="surface-heading">
                      <h3>收款信息</h3>
                      <p>选择与你实际收款身份一致的信息。</p>
                      <p v-if="!wechatPayoutEnabled" class="field-hint">
                        主办方暂未开通微信转账，请使用银行账户结算。
                      </p>
                    </div>
                    <div class="stack-form">
                      <label>收款主体<select v-model="recipientForm.type">
                        <option value="individual">个人</option>
                        <option value="organization">企业</option>
                      </select></label><label>结算渠道<select v-model="recipientForm.channel">
                        <option
                          v-if="recipientForm.type === 'individual' && wechatPayoutEnabled"
                          value="wechat_transfer"
                        >
                          微信商家转账
                        </option>
                        <option value="manual_bank">人工结算</option>
                      </select></label><label>收款人名称<input
                        v-model="recipientForm.displayName"
                        required
                        maxlength="120"
                        autocomplete="name"
                      /></label><label v-if="recipientForm.channel === 'manual_bank'">收款账户信息<input
                        v-model="recipientForm.accountReference"
                        required
                        autocomplete="off"
                      /></label>
                      <p v-else class="field-hint">
                        请在微信中完成身份授权，绑定后可用于接收推广收益。
                      </p>
                      <button class="account-primary" :disabled="pending">
                        {{
                          recipientForm.channel === 'wechat_transfer'
                            ? '在微信中授权绑定'
                            : '提交验证'
                        }}
                        <span aria-hidden="true">→</span>
                      </button><small class="field-hint">收款信息加密保存。企业收款通过人工结算。</small>
                    </div>
                  </form>
                </div>
                <article class="account-surface">
                  <div class="surface-heading section-row">
                    <div>
                      <h3>提现与结算记录</h3>
                      <p>查看处理进度，下载结算单与回单。</p>
                    </div>
                    <span class="record-count">{{ payouts.length }} 条记录</span>
                  </div>
                  <div v-if="payouts.length" class="data-list">
                    <article v-for="item in payouts" :key="String(item.id)">
                      <div>
                        <strong>{{ money(item.grossAmount) }}</strong><small v-if="Number(item.taxAmount ?? 0) > 0">代扣税费 {{ money(item.taxAmount) }}，预计到账
                          {{ money(item.netAmount) }}</small><small>{{ dateTime(item.createdAt) }}</small><span class="document-links"><button
                          v-for="document in documentsForPayout(item.id)"
                          :key="String(document.id)"
                          type="button"
                          class="text-button"
                          :disabled="pending"
                          @click="downloadPayoutDocument(document)"
                        >
                          {{
                            document.kind === 'manual_receipt'
                              ? '下载结算回单'
                              : document.kind === 'wechat_receipt'
                                ? '下载微信回单'
                                : document.kind === 'tax_document'
                                  ? '下载税务材料'
                                  : '下载结算单'
                          }}
                        </button></span>
                      </div>
                      <div>
                        <span
                          class="status-badge"
                          :class="{ 'is-success': item.status === 'succeeded' }"
                        >{{ statusText[String(item.status)] ?? item.status }}</span><button
                          v-if="item.status === 'under_review'"
                          type="button"
                          class="account-secondary"
                          :disabled="pending"
                          @click="confirmSettlement(item)"
                        >
                          确认结算金额
                        </button><button
                          v-if="
                            item.status === 'executing' &&
                              recipients.some(
                                (recipient) =>
                                  recipient.id === item.recipientId &&
                                  recipient.channel === 'wechat_transfer',
                              )
                          "
                          type="button"
                          class="account-secondary"
                          :disabled="pending"
                          @click="confirmWechat(item)"
                        >
                          微信确认
                        </button>
                      </div>
                    </article>
                  </div>
                  <div v-else class="account-empty">
                    <span class="section-index">PAYOUT HISTORY</span>
                    <h3>还没有提现记录</h3>
                    <p>提交申请后，可在这里跟进结算与到账情况。</p>
                  </div>
                </article>
              </div>

              <div v-else class="section-stack">
                <div class="account-surface inquiry-layout">
                  <div class="inquiry-intro">
                    <span class="section-index">HOW IT WORKS</span>
                    <h3>我们会核对每一笔收益</h3>
                    <p>请填写订单编号和具体情况，方便大会运营人员核对。</p>
                    <ol>
                      <li>选择问题类型</li>
                      <li>填写订单与情况说明</li>
                      <li>提交后等待运营人员核查</li>
                    </ol>
                    <p>核查内容包括订单、推广来源、退款和结算记录。</p>
                  </div>
                  <form class="stack-form" @submit.prevent="submitInquiry">
                    <label>问题类型<select v-model="inquiryForm.type">
                      <option value="missing_order">订单未计佣</option>
                      <option value="amount_dispute">佣金金额有疑问</option>
                    </select></label><label>订单编号<input
                      v-model="inquiryForm.orderReference"
                      required
                      maxlength="80"
                      placeholder="填写需要核对的订单编号"
                    /></label><label>问题说明<textarea
                      v-model="inquiryForm.description"
                      required
                      rows="7"
                      minlength="10"
                      maxlength="4000"
                      placeholder="请描述遇到的问题及相关情况，至少 10 个字"
                    ></textarea><span class="field-hint">请填写 10 至 4,000 个字。</span></label><button class="account-primary" :disabled="pending">
                      提交佣金申诉 <span aria-hidden="true">→</span>
                    </button>
                  </form>
                </div>
                <article class="account-surface">
                  <div class="surface-heading">
                    <h3>我的申诉记录</h3>
                    <p>查看核查进度及大会运营人员的处理说明。</p>
                  </div>
                  <div v-if="inquiryHistory.length" class="data-list">
                    <article v-for="item in inquiryHistory" :key="item.id">
                      <div>
                        <strong style="overflow-wrap: anywhere">订单 {{ item.orderReference }}</strong><small>{{ dateTime(item.createdAt) }}</small>
                        <p>{{ item.description }}</p>
                        <p v-if="item.decisionReason">处理说明：{{ item.decisionReason }}</p>
                        <small v-if="item.adjustmentAmount !== null">佣金调整 {{ money(item.adjustmentAmount) }}</small>
                      </div>
                      <span class="status-badge">{{
                        item.status === 'open'
                          ? '待核查'
                          : item.status === 'under_review'
                            ? '复核中'
                            : item.status === 'resolved'
                              ? '已处理'
                              : '已驳回'
                      }}</span>
                    </article>
                  </div>
                  <p v-else class="field-hint">还没有申诉记录，提交后可在这里跟进。</p>
                  <p v-if="inquiriesHasMore" class="field-hint">
                    当前显示最近 100 条记录，较早记录请联系大会运营人员查询。
                  </p>
                </article>
              </div>
            </section>
          </div>
        </div>
      </template>
    </main>
  </div>
</template>

<style scoped>
/* Account tokens and dimensions follow /account. Keep this scoped to the partner workspace. */
.account-page {
  --account-canvas: #f4f5f7;
  --account-surface: #fff;
  --account-ink: #15171b;
  --account-muted: #6f737c;
  --account-line: #dfe2e7;
  --account-line-soft: #eceef1;
  --account-title-page: clamp(32px, 3.2vw, 40px);
  --account-title-section: 23px;
  min-height: 100vh;
  background: var(--account-canvas);
  color: var(--account-ink);
  font-size: 13px;
}
.account-shell {
  width: min(100% - 40px, 1180px);
  margin-inline: auto;
  padding: 52px 0 104px;
}
.account-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin-bottom: 42px;
}
.account-heading h1 {
  margin: 0;
  color: var(--account-ink);
  font-size: var(--account-title-page);
  font-weight: 850;
  line-height: 1.12;
  letter-spacing: -0.025em;
}
.account-heading > div > p:last-child {
  margin: 18px 0 0;
  color: var(--account-muted);
  font-size: 15px;
  line-height: 1.75;
  text-wrap: pretty;
}
.account-back-link {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 10px;
  color: var(--account-muted);
  font-size: 13px;
  font-weight: 680;
  text-decoration: none;
  flex-shrink: 0;
}
.account-workspace {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  align-items: start;
  gap: 34px;
}
.account-rail {
  position: sticky;
  top: 24px;
  overflow: hidden;
  border: 1px solid var(--account-line);
  border-radius: 10px;
  background: var(--account-surface);
}
.account-rail__identity {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 22px 20px 12px;
}
.account-rail__identity > div:last-child {
  min-width: 0;
}
.account-rail__identity strong {
  display: block;
  font-size: 14px;
  font-weight: 780;
  overflow-wrap: anywhere;
}
.account-avatar {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid #cddcf6;
  border-radius: 8px;
  background: #edf3fd;
  color: var(--conference-primary);
  font-size: 16px;
  font-weight: 820;
}
.account-avatar img,
.profile-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.partner-status {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  color: var(--account-muted);
  font-size: 10px;
}
.partner-status i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.partner-status.is-active {
  color: #167653;
}
.account-rail__company {
  margin: 0;
  padding: 0 20px 20px;
  color: var(--account-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.account-nav {
  display: grid;
  padding: 8px;
  border-block: 1px solid var(--account-line-soft);
}
.account-nav button,
.account-mobile-panel button {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 13px;
  padding: 0 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #44474f;
  font-size: 12px;
  font-weight: 650;
  text-align: left;
}
.account-nav button > span,
.account-mobile-panel button > span {
  color: #858a94;
  font: 500 9px var(--conference-font-mono);
}
.account-nav button:hover,
.account-nav button[aria-current],
.account-mobile-panel button:hover,
.account-mobile-panel button[aria-current] {
  background: #f2f5fb;
  color: var(--conference-primary);
}
.account-nav button[aria-current] > span,
.account-mobile-panel button[aria-current] > span {
  color: var(--conference-primary);
}
.account-rail__footer {
  padding: 18px 20px 20px;
  background: #fafafa;
}
.account-rail__footer > span {
  color: var(--account-muted);
  font-size: 10px;
}
.account-rail__footer p {
  margin: 9px 0;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.account-rail__footer small {
  color: var(--account-muted);
  font-size: 10px;
  line-height: 1.6;
}
.account-mobile-nav {
  display: none;
}
.account-heading .mobile-partner-status {
  display: none;
}
.account-content {
  display: grid;
  min-width: 0;
  gap: 34px;
}
.account-section {
  min-width: 0;
  padding: 0;
  scroll-margin-top: 80px;
}
.account-section__heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 20px;
}
.account-section__heading h2 {
  margin: 0;
  font-size: var(--account-title-section);
  font-weight: 820;
  line-height: 1.15;
}
.account-section__heading > p {
  max-width: 300px;
  margin: 0;
  color: var(--account-muted);
  font-size: 12px;
  line-height: 1.6;
  text-wrap: pretty;
}
.section-index {
  display: block;
  margin-bottom: 8px;
  color: var(--conference-primary);
  font: 700 9px var(--conference-font-mono);
  letter-spacing: 0.1em;
}
.account-surface {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--account-line);
  border-radius: 10px;
  background: var(--account-surface);
}
.earnings-surface .balance-strip {
  padding-inline: clamp(20px, 3vw, 30px);
  border-top: 0;
  margin: 0;
}
.earnings-surface .promotion-tip {
  margin: 0;
  padding: 26px clamp(20px, 3vw, 30px);
  border-top: 0;
  border-bottom: 1px solid var(--account-line-soft);
}
.earnings-surface .promotion-tip h3 {
  margin: 0 0 16px;
  font-size: 20px;
  font-weight: 700;
}
.earnings-surface .promotion-tip .data-list { padding: 0; }
.balance-strip {
  display: grid;
  padding: 0;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-block: 1px solid var(--account-line);
  margin-bottom: 6px;
}
.balance-strip > div {
  min-width: 0;
  padding: 20px 14px;
  border-right: 1px solid var(--account-line);
}
.balance-strip > div:first-child {
  padding-left: 0;
}
.balance-strip > div:last-child {
  border-right: 0;
  padding-right: 0;
}
.balance-strip span,
.balance-strip small {
  display: block;
  color: var(--account-muted);
  font-size: 10px;
  line-height: 1.6;
}
.balance-strip strong {
  display: block;
  margin: 9px 0 7px;
  font-size: clamp(18px, 1.7vw, 24px);
  font-weight: 780;
  letter-spacing: -0.035em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.balance-strip small {
  font-size: 9px;
}
.section-stack {
  display: grid;
  gap: 28px;
}
.surface-heading {
  padding: 24px 30px 20px;
  border-bottom: 1px solid var(--account-line-soft);
}
.surface-heading h3,
.section-row h3,
.promotion-content h3,
.inquiry-intro h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 750;
  line-height: 1.5;
}
.surface-heading p {
  margin: 6px 0 0;
  color: var(--account-muted);
  font-size: 12px;
  line-height: 1.7;
}
.account-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  padding: 30px;
}
.wide {
  grid-column: 1/-1;
}
label {
  display: grid;
  align-content: start;
  gap: 7px;
  color: #555962;
  font-size: 11px;
  font-weight: 650;
}
.required {
  color: var(--conference-primary);
  font-size: 10px;
}
label:has(> .required) {
  grid-template-columns: auto 1fr;
  align-items: center;
}
label:has(> .required) > input {
  grid-column: 1/-1;
}
input,
textarea,
select {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid #d7d9de;
  border-radius: 7px;
  background: #fff;
  color: var(--account-ink);
  font: inherit;
  outline: 0;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}
input::placeholder,
textarea::placeholder {
  color: #8a8f98;
}
input:focus,
textarea:focus,
select:focus {
  border-color: var(--conference-primary);
  box-shadow: 0 0 0 3px rgb(37 99 235/10%);
}
textarea {
  resize: vertical;
  line-height: 1.7;
}
input[type='checkbox'] {
  width: 16px;
  min-height: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  accent-color: var(--conference-primary);
  cursor: pointer;
}
input:disabled {
  cursor: not-allowed;
}
button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.account-primary,
.account-secondary {
  display: inline-flex;
  min-height: 46px;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 0 20px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--conference-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 720;
  line-height: 1.5;
  text-decoration: none;
  cursor: pointer;
  transition:
    background-color 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}
.account-primary:hover:not(:disabled) {
  background: var(--conference-primary-dark);
}
.account-secondary {
  min-height: 44px;
  gap: 8px;
  padding: 0 14px;
  border-color: var(--account-line);
  border-radius: 7px;
  background: #fff;
  color: #44474f;
  font-size: 12px;
}
.account-secondary:hover:not(:disabled) {
  background: #f5f7fb;
  color: var(--conference-primary);
}
button:active:not(:disabled),
.account-primary:active,
.account-secondary:active,
.account-back-link:active {
  transform: scale(0.98);
}
.field-hint {
  display: block;
  margin: 0;
  color: var(--account-muted);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.7;
}
.field-note {
  margin: 0;
  padding: 12px;
  border-radius: 7px;
  background: #f2f5fb;
  color: #425475;
  font-size: 12px;
  line-height: 1.7;
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  margin-top: 4px;
}
.form-actions small {
  color: var(--account-muted);
  font-size: 11px;
}
.avatar-editor {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 4px;
}
.profile-avatar {
  display: grid;
  width: 72px;
  height: 72px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid #cddcf6;
  border-radius: 8px;
  background: #edf3fd;
  color: var(--conference-primary);
  font-size: 26px;
  font-weight: 780;
}
.avatar-editor .field-hint {
  margin-top: 8px;
}
.file-control {
  position: relative;
  width: fit-content;
  overflow: hidden;
}
.file-control input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.file-control:focus-within {
  outline: 2px solid var(--conference-primary);
  outline-offset: 3px;
}
.file-control:has(input:disabled) {
  opacity: 0.55;
  cursor: not-allowed;
}
.section-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.gallery-editor {
  padding-top: 8px;
}
.gallery-editor .field-hint {
  margin-top: 5px;
}
.gallery-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  margin-top: 16px;
}
.gallery-list > div {
  min-width: 0;
}
.gallery-list img {
  width: 100%;
  aspect-ratio: 4/3;
  object-fit: cover;
  border: 1px solid var(--account-line);
  border-radius: 7px;
  margin-bottom: 10px;
}
.text-button {
  min-height: 44px;
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: var(--conference-primary);
  font-size: 12px;
  font-weight: 650;
  text-align: left;
}
.privacy-content {
  padding: 24px 30px 30px;
}
.privacy-status {
  max-width: 300px;
}
.privacy-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 24px;
  table-layout: fixed;
  text-align: left;
}
.privacy-table thead th {
  padding: 12px 0;
  background: #fafafa;
  color: var(--account-muted);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.5;
}
.privacy-table th:first-child {
  padding-left: 12px;
}
.privacy-table tbody th {
  font-size: 12px;
  font-weight: 550;
}
.privacy-table th,
.privacy-table td {
  border-bottom: 1px solid var(--account-line-soft);
}
.privacy-table th:not(:first-child),
.privacy-table td {
  text-align: center;
}
.check-control {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.check-control:has(input:disabled) {
  cursor: not-allowed;
}
.switch-line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  margin-top: 16px;
}
.privacy-content > .form-actions {
  margin-top: 20px;
}
.promotion-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  align-items: start;
  gap: 24px;
}
.promotion-content {
  padding: 30px;
}
.hint {
  margin: 12px 0;
  color: var(--account-muted);
  font-size: 12px;
  line-height: 1.8;
}
.link-box {
  margin: 22px 0 16px;
  padding: 14px;
  border: 1px solid var(--account-line-soft);
  border-radius: 7px;
  background: #f7f8fa;
}
.link-box code {
  color: #44474f;
  font: 12px/1.8 var(--conference-font-mono);
  overflow-wrap: anywhere;
}
.promotion-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}
.promotion-tip {
  margin-top: 30px;
  padding-top: 26px;
  border-top: 1px solid var(--account-line-soft);
}
.poster-copy-editor { display: grid; gap: 16px; }
.poster-copy-editor h3, .poster-copy-editor p { margin: 0; }
.poster-copy-editor label { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
.poster-copy-editor label small { color: var(--account-muted); font-weight: 400; }
.poster-copy-editor input, .poster-copy-editor textarea { grid-column: 1 / -1; }
.poster-copy-editor .inline-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.poster-copy-editor .inline-actions + h3 { margin-top: 12px; padding-top: 24px; border-top: 1px solid var(--account-line-soft); }
.poster-copy-editor > button { justify-self: start; }
.poster-preview {
  min-width: 0;
  margin: 0;
  padding: 20px;
}
.poster-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 18px;
}
.poster-heading h3 {
  margin: 5px 0 0;
  font-size: 16px;
  font-weight: 750;
}
.poster-ratio {
  padding: 5px 7px;
  border-radius: 5px;
  background: #f0f4fa;
  color: #687386;
  font-size: 10px;
  white-space: nowrap;
}
.poster-preview figcaption {
  margin-top: 16px;
  color: var(--account-muted);
  font-size: 11px;
  line-height: 1.7;
}
.promotion-poster {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 3/4;
  background: #07111f;
  box-shadow: 0 12px 28px rgb(7 17 31 / 12%);
}
.poster-placeholder {
  display: grid;
  align-content: center;
  justify-items: center;
  aspect-ratio: 3/4;
  padding: 24px;
  background: #07111f;
  color: #eef2f8;
  text-align: center;
  font-size: 12px;
  line-height: 1.8;
}
.poster-qr-source {
  position: fixed;
  left: -10000px;
  top: 0;
  width: 360px;
  height: 360px;
  pointer-events: none;
}
.record-count {
  flex-shrink: 0;
  color: var(--account-muted);
  font: 10px var(--conference-font-mono);
}
.data-list {
  padding: 0 30px;
}
.data-list article {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 0;
  border-bottom: 1px solid var(--account-line-soft);
}
.data-list article:last-child {
  border-bottom: 0;
}
.data-list article > div {
  display: grid;
  min-width: 0;
  gap: 8px;
}
.data-list article > div:last-child {
  justify-items: end;
  text-align: right;
}
.data-list strong {
  font-size: 13px;
  font-weight: 680;
  overflow-wrap: anywhere;
}
.data-list b {
  font-size: 18px;
  letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;
}
.data-list small {
  color: var(--account-muted);
  font-size: 11px;
  line-height: 1.6;
}
.status-badge {
  display: inline-flex;
  min-height: 24px;
  align-items: center;
  width: fit-content;
  padding: 3px 8px;
  border-radius: 5px;
  background: #f2f5fb;
  color: #48618c;
  font-size: 10px;
  font-weight: 650;
}
.status-badge.is-success {
  background: #ecfdf5;
  color: #047857;
}
.document-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.payout-layout {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
  align-items: start;
}
.stack-form {
  display: grid;
  align-content: start;
  gap: 18px;
  min-width: 0;
  padding: 30px;
}
.stack-form > .account-primary {
  width: fit-content;
}
.inquiry-layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
}
.inquiry-intro {
  padding: 30px 24px;
  background: #f7f8fa;
  border-right: 1px solid var(--account-line-soft);
}
.inquiry-intro h3 {
  margin: 20px 0 12px;
}
.inquiry-intro p,
.inquiry-intro li {
  color: var(--account-muted);
  font-size: 12px;
  line-height: 1.9;
}
.inquiry-intro ol {
  margin: 20px 0;
  padding-left: 18px;
  list-style: decimal;
}
.inquiry-intro li + li {
  margin-top: 8px;
}
.rules-card {
  padding: 26px 30px;
}
.rules-card h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 750;
}
.rules-copy {
  max-height: 160px;
  overflow: auto;
  padding: 14px;
  border: 1px solid var(--account-line-soft);
  border-radius: 7px;
  background: #fafafa;
  color: #44474f;
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
}
.rules-card > .account-primary {
  margin-top: 6px;
}
.account-message {
  position: sticky;
  z-index: 15;
  top: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0;
  padding: 14px 16px;
  border: 1px solid;
  border-radius: 8px;
  font-size: 13px;
}
.account-message > span {
  font-size: 18px;
  font-weight: 750;
}
.account-message p {
  margin: 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.account-message.is-error {
  background: #fff1f2;
  border-color: #fecdd3;
  color: #be123c;
}
.account-message.is-success {
  background: #ecfdf5;
  border-color: #a7f3d0;
  color: #047857;
}
.account-empty {
  padding: 60px 30px;
}
.account-empty h2,
.account-empty h3 {
  margin: 16px 0 10px;
  font-size: 22px;
  font-weight: 720;
}
.account-empty p {
  margin: 0 0 22px;
  color: var(--account-muted);
  font-size: 13px;
  line-height: 1.8;
}
.account-loading {
  display: grid;
  min-height: 420px;
  place-content: center;
  justify-items: center;
  gap: 15px;
  color: var(--account-muted);
}
.account-loading > span {
  width: 28px;
  height: 28px;
  border: 2px solid var(--account-line);
  border-top-color: var(--conference-primary);
  border-radius: 50%;
  animation: loading-spin 800ms linear infinite;
}
.account-loading p {
  margin: 0;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@keyframes loading-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1200px) {
  .promotion-layout {
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 18px;
  }
  .promotion-content {
    padding: 24px;
  }
  .inquiry-layout {
    grid-template-columns: 200px minmax(0, 1fr);
  }
}
@media (max-width: 1000px) {
  .account-workspace {
    grid-template-columns: 1fr;
  }
  .account-rail {
    z-index: 20;
    top: max(8px, env(safe-area-inset-top));
    overflow: visible;
    box-shadow: 0 8px 24px rgb(15 23 42/7%);
  }
  .account-rail__identity,
  .account-rail__company,
  .account-rail__footer,
  .account-nav--desktop {
    display: none;
  }
  .account-mobile-nav {
    display: block;
    position: relative;
  }
  .account-heading .mobile-partner-status {
    display: flex;
    margin-top: 8px;
  }
  .account-mobile-trigger {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 24px;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 0 16px;
    border: 0;
    border-radius: 10px;
    background: #fff;
    color: var(--account-ink);
    text-align: left;
  }
  .account-mobile-trigger > span {
    color: var(--conference-primary);
    font-size: 10px;
  }
  .account-mobile-trigger strong {
    font-size: 12px;
    font-weight: 750;
  }
  .account-mobile-trigger i {
    font-size: 22px;
    font-style: normal;
    text-align: center;
  }
  .account-mobile-panel {
    position: absolute;
    top: calc(100% + 6px);
    left: -1px;
    right: -1px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
    padding: 8px;
    border: 1px solid var(--account-line);
    border-radius: 9px;
    background: #fff;
    box-shadow: 0 12px 24px rgb(15 23 42/10%);
  }
  .account-mobile-panel button {
    min-height: 44px;
  }
  .account-message {
    top: 70px;
  }
  .account-content {
    gap: 28px;
  }
  input,
  select,
  textarea {
    font-size: 16px;
  }
  .balance-strip strong {
    font-size: 24px;
  }
  .promotion-layout {
    grid-template-columns: minmax(0, 1fr) 380px;
  }
  .inquiry-layout {
    grid-template-columns: 240px minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .account-shell {
    width: min(100% - 28px, 1180px);
    padding: 26px 0 calc(72px + env(safe-area-inset-bottom));
  }
  .account-heading {
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 20px;
  }
  .account-heading h1 {
    font-size: 32px;
  }
  .account-heading > div > p:last-child {
    margin-top: 12px;
    max-width: 30ch;
    font-size: 12px;
  }
  .account-back-link {
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--account-line);
    border-radius: 7px;
    background: #fff;
    font-size: 11px;
    gap: 6px;
  }
  .account-workspace {
    gap: 20px;
  }
  .account-section__heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }
  .account-section__heading > p {
    max-width: none;
  }
  .account-section__heading h2 {
    font-size: 23px;
  }
  .balance-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-bottom: 0;
  }
  .balance-strip > div {
    padding: 16px;
  }
  .balance-strip > div:first-child {
    padding-left: 16px;
  }
  .balance-strip > div:nth-child(2) {
    border-right: 0;
  }
  .balance-strip > div:nth-child(-n + 2) {
    border-bottom: 1px solid var(--account-line);
  }
  .balance-strip > div:last-child {
    padding-right: 16px;
  }
  .balance-strip strong {
    font-size: 24px;
  }
  .balance-strip small {
    font-size: 10px;
  }
  .account-form {
    grid-template-columns: 1fr;
    padding: 22px 20px;
    gap: 20px;
  }
  .surface-heading {
    padding: 20px;
  }
  .privacy-content {
    padding: 20px;
  }
  .privacy-status {
    max-width: none;
  }
  .privacy-table th:first-child {
    padding-left: 8px;
  }
  .privacy-table thead th {
    font-size: 10px;
  }
  .promotion-layout,
  .payout-layout,
  .inquiry-layout {
    grid-template-columns: 1fr;
  }
  .promotion-content {
    padding: 24px 20px;
  }
  .poster-preview {
    width: min(100%, 420px);
    margin-inline: auto;
  }
  .stack-form {
    padding: 22px 20px;
  }
  .data-list {
    padding: 0 20px;
  }
  .data-list article {
    gap: 12px;
  }
  .data-list article > div:last-child {
    flex-shrink: 0;
  }
  .inquiry-intro {
    padding: 24px 20px;
    border-right: 0;
    border-bottom: 1px solid var(--account-line-soft);
  }
  .inquiry-intro h3 {
    margin: 12px 0;
  }
  .inquiry-intro ol {
    margin: 14px 0;
  }
  .rules-card {
    padding: 24px 20px;
  }
  .account-empty {
    padding: 40px 24px;
  }
  .section-stack {
    gap: 24px;
  }
  .form-actions {
    gap: 12px;
  }
  .avatar-editor {
    gap: 14px;
  }
  .avatar-editor > div:last-child {
    min-width: 0;
  }
  .gallery-list {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 420px) {
  .account-heading {
    flex-wrap: wrap;
    row-gap: 12px;
  }
  .account-heading > div {
    flex: 1 1 200px;
  }
  .account-back-link {
    min-height: 44px;
  }
  .account-mobile-trigger {
    padding-inline: 12px;
    gap: 8px;
  }
  .account-mobile-panel button {
    padding-inline: 8px;
    gap: 8px;
  }
  .balance-strip strong {
    font-size: 23px;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition: none !important;
  }
}
</style>
