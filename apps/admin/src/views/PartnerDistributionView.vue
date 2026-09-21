<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { AdminEnablePartnerSchema, AdminEditPartnerDetailsSchema, type AdminPartnerRelationshipView } from '@conference/contracts';
import { partnerFieldIssues, partnerServerFieldIssues, type PartnerFieldIssue } from '../lib/partner-form-feedback';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import { conferenceApi, session } from '../lib/api';

type Tab = 'overview' | 'commissions' | 'payouts' | 'settings';
type MoneyRow = Record<string, unknown> & { id?: string; status?: string; version?: number };

const activeTab = ref<Tab>('overview');
const loading = ref(true);
const pending = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const enableDialogOpen = ref(false);
const overview = ref<Record<string, unknown>>({});
const partners = ref<AdminPartnerRelationshipView[]>([]);
const commissions = ref<MoneyRow[]>([]);
const payoutRequests = ref<MoneyRow[]>([]);
const payoutBatches = ref<MoneyRow[]>([]);
const inquiries = ref<MoneyRow[]>([]);
const recipients = ref<MoneyRow[]>([]);
const recipientDetail = ref<Record<string, unknown> | null>(null);
const recipientDialog = ref<HTMLDialogElement>();
async function viewRecipient(item: MoneyRow) {
  await run(async () => {
    recipientDetail.value = await conferenceApi.getPartnerRecipientDetails(String(item.id));
    await nextTick();
    recipientDialog.value?.showModal();
  }, '');
}
function closeRecipientDetails() { recipientDialog.value?.close(); recipientDetail.value = null; }
function partnerName(id: unknown) { return partners.value.find((item) => item.id === id)?.profile.displayName ?? String(id ?? ''); }

const payoutDocuments = ref<MoneyRow[]>([]);
const reconciliations = ref<MoneyRow[]>([]);
const payoutSettings = ref<Record<string, unknown>>({});
const selectedRequestIds = ref<string[]>([]);
const partnerInvitationOpen = ref(false);
const partnerInvitation = ref<HTMLDialogElement>();
const partnerInvitationTrigger = ref<HTMLButtonElement>();
const partnerInvitationError = ref('');
const partnerInvitationIssues = ref<PartnerFieldIssue[]>([]);
const enableForm = reactive({
  mobile: '',
  displayName: '',
  company: '',
  title: '',
  ratePercent: '',
  note: '',
});
const editingPartner = ref<AdminPartnerRelationshipView | null>(null);
const partnerEditor = ref<HTMLDialogElement>();
const partnerEditorError = ref('');
const partnerEditorIssues = ref<PartnerFieldIssue[]>([]);
const partnerEditorNotice = ref('');
const editForm = reactive({
  displayName: '',
  company: '',
  title: '',
  industry: '',
  businessIntro: '',
  businessUrl: '',
  ratePercent: '',
  sortOrder: '0',
  internalNote: '',
});
let partnerEditorReturnFocus: HTMLElement | null = null;
const adjustmentForm = reactive({ partnerId: '', direction: 'credit', amountYuan: '', reason: '' });
const reconciliationForm = reactive({
  batchId: '',
  windowStart: '',
  windowEnd: '',
  checkedCount: '',
  differenceCount: '',
  differenceAmountYuan: '',
  evidenceReference: '',
  evidenceDigest: '',
  note: '',
});
const programForm = reactive({
  mode: 'fixed' as 'fixed' | 'order_count_tiered',
  ratePercent: '10',
  tiers: '1:10\n20:12\n50:15',
  attributionDays: '30',
  settlementDelayDays: '7',
  minimumPayoutYuan: '10',
  publicDirectoryEnabled: false,
  homepageLimit: '12',
  termsTitle: '大会合作伙伴推广规则',
  termsContent:
    '合作伙伴应使用本人专属链接开展真实推广。佣金按成功付款且符合资格的订单明细计算，退款与自购会按规则冲正。',
  promotionPolicy: '推广内容应真实、清晰，不得承诺大会未公开的权益。',
});
const transferForm = reactive({
  enabled: false,
  singleTransferYuan: '200',
  dailyUserYuan: '2000',
  dailyMerchantYuan: '50000',
  monthlyMerchantYuan: '30000000',
  jobType: '推广合作伙伴',
  remunerationDescription: '大会推广佣金',
  verifiedAt: '',
});

const canManagePartners = computed(() => session.can('event.partner.manage'));
const canReadPartners = computed(
  () => session.can('event.partner.read') || canManagePartners.value,
);
const canManageRules = computed(() => session.can('event.partner.rules.manage'));
const canReadCommissions = computed(() => session.can('event.commission.read'));
const canManageCommissions = computed(() => session.can('event.commission.manage'));
const canReviewPayouts = computed(() => session.can('event.payout.review'));
const canExecutePayouts = computed(() => session.can('event.payout.execute'));
const canExportPayouts = computed(() => session.can('event.payout.export'));
const canManagePayoutSettings = computed(() => session.can('org.payout.settings.manage'));
const canReadPayoutSettings = computed(
  () => session.can('org.payout.settings.read') || canManagePayoutSettings.value,
);
const tabs = computed<Array<{ id: Tab; label: string }>>(() => [
  ...(canReadPartners.value || canReadCommissions.value
    ? [{ id: 'overview' as const, label: '概览' }]
    : []),
  ...(canReadCommissions.value ? [{ id: 'commissions' as const, label: '佣金订单' }] : []),
  ...(canReviewPayouts.value ? [{ id: 'payouts' as const, label: '提现与对账' }] : []),
  ...(canManageRules.value || canReadPayoutSettings.value
    ? [{ id: 'settings' as const, label: '分销设置' }]
    : []),
]);
const program = computed(() => (overview.value.program ?? null) as Record<string, unknown> | null);
const counts = computed(() => (overview.value.partnerCounts ?? {}) as Record<string, number>);
const commissionTotals = computed(
  () => (overview.value.commissionTotals ?? {}) as Record<string, number>,
);
const promotion = computed(() => (overview.value.promotion ?? {}) as Record<string, number>);
const enableRateValid = computed(() => {
  if (!enableForm.ratePercent.trim()) return true;
  const value = Number(enableForm.ratePercent);
  return Number.isFinite(value) && value >= 0 && value <= 100;
});
const editRateValid = computed(() => {
  if (!editForm.ratePercent.trim()) return true;
  const value = Number(editForm.ratePercent);
  return Number.isFinite(value) && value >= 0 && value <= 100;
});


function money(value: unknown) {
  return `¥${(Number(value ?? 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`;
}

function dateTime(value: unknown) {
  return typeof value === 'string' && value ? new Date(value).toLocaleString('zh-CN') : '暂无';
}

function mobileDisplay(value: string) {
  return value.replace(/^\+86/u, '');
}

function label(value: unknown) {
  const labels: Record<string, string> = {
    pending_confirmation: '待确认',
    active: '生效中',
    paused: '已暂停',
    closed: '已关闭',
    provisional: '预计',
    pending: '等待释放',
    available: '可提现',
    reserved: '已占用',
    paid: '已结算',
    submitted: '待审核',
    approved: '已通过',
    batched: '已组批',
    executing: '出款中',
    succeeded: '已到账',
    rejected: '已驳回',
    unknown: '待查单',
    draft: '待复核',
    completed: '已完成',
    held: '已暂停',
    cancelled: '已取消',
    open: '待处理',
    under_review: '待复核',
    resolved: '已解决',
    failed: '失败',
    verified: '已验证',
    matched: '核对一致',
    mismatched: '存在差异',
    partially_reversed: '部分冲正',
    reversed: '已冲正',
  };
  return labels[String(value)] ?? String(value ?? '—');
}

function numberValue(value: string, multiplier = 1) {
  return Math.round(Number(value || 0) * multiplier);
}

function parseTiers() {
  return programForm.tiers
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [count, rate] = line.split(':').map(Number);
      return { minimumOrderCount: count ?? 0, rateBps: Math.round((rate ?? 0) * 100) };
    });
}

function programPayload() {
  return {
    mode: programForm.mode,
    fixedRateBps: numberValue(programForm.ratePercent, 100),
    tiers: programForm.mode === 'order_count_tiered' ? parseTiers() : [],
    eligibleTicketTypeIds: [],
    attributionDays: numberValue(programForm.attributionDays),
    settlementDelayDays: numberValue(programForm.settlementDelayDays),
    minimumPayoutAmount: numberValue(programForm.minimumPayoutYuan, 100),
    payoutCadence: 'weekly' as const,
    termsTitle: programForm.termsTitle,
    termsContent: programForm.termsContent,
    promotionPolicy: programForm.promotionPolicy,
    publicDirectoryEnabled: programForm.publicDirectoryEnabled,
    homepageLimit: numberValue(programForm.homepageLimit),
  };
}

function defaultProgramPayload() {
  return {
    mode: 'fixed' as const,
    fixedRateBps: 1000,
    tiers: [],
    eligibleTicketTypeIds: [],
    attributionDays: 30,
    settlementDelayDays: 7,
    minimumPayoutAmount: 1000,
    payoutCadence: 'weekly' as const,
    termsTitle: '大会合作伙伴推广规则',
    termsContent:
      '合作伙伴应使用本人专属链接开展真实推广。佣金按成功付款且符合资格的订单明细计算，退款与自购会按规则冲正。',
    promotionPolicy: '推广内容应真实、清晰，不得承诺大会未公开的权益。',
    publicDirectoryEnabled: false,
    homepageLimit: 12,
  };
}

function hydrateProgram() {
  const item = program.value;
  if (!item) return;
  programForm.mode = item.mode === 'order_count_tiered' ? 'order_count_tiered' : 'fixed';
  programForm.ratePercent = String(Number(item.fixedRateBps ?? 1000) / 100);
  programForm.tiers = Array.isArray(item.tiers)
    ? item.tiers.map((tier) => `${tier.minimumOrderCount}:${Number(tier.rateBps) / 100}`).join('\n')
    : '';
  programForm.attributionDays = String(item.attributionDays ?? 30);
  programForm.settlementDelayDays = String(item.settlementDelayDays ?? 7);
  programForm.minimumPayoutYuan = String(Number(item.minimumPayoutAmount ?? 1000) / 100);
  programForm.publicDirectoryEnabled = item.publicDirectoryEnabled === true;
  programForm.homepageLimit = String(item.homepageLimit ?? 12);
  programForm.termsTitle = String(item.termsTitle ?? programForm.termsTitle);
  programForm.termsContent = String(item.termsContent ?? programForm.termsContent);
  programForm.promotionPolicy = String(item.promotionPolicy ?? programForm.promotionPolicy);
}

function hydrateTransfer() {
  const configuration = (payoutSettings.value.configuration ?? {}) as Record<string, unknown>;
  transferForm.enabled = configuration.enabled === true;
  transferForm.singleTransferYuan = String(
    Number(configuration.singleTransferLimit ?? 20000) / 100,
  );
  transferForm.dailyUserYuan = String(Number(configuration.dailyUserLimit ?? 200000) / 100);
  transferForm.dailyMerchantYuan = String(
    Number(configuration.dailyMerchantLimit ?? 5000000) / 100,
  );
  transferForm.monthlyMerchantYuan = String(
    Number(configuration.monthlyMerchantLimit ?? 3000000000) / 100,
  );
  transferForm.jobType = String(configuration.jobType ?? transferForm.jobType);
  transferForm.remunerationDescription = String(
    configuration.remunerationDescription ?? transferForm.remunerationDescription,
  );
  transferForm.verifiedAt = String(configuration.verifiedAt ?? '');
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [
      overviewResult,
      partnerResult,
      commissionResult,
      inquiryResult,
      payoutResult,
      settingsResult,
    ] = await Promise.all([
      canReadPartners.value || canReadCommissions.value
        ? conferenceApi.getPartnerDistributionOverview()
        : Promise.resolve({}),
      canReadPartners.value ? conferenceApi.getEventPartners() : Promise.resolve({ items: [] }),
      canReadCommissions.value
        ? conferenceApi.getPartnerCommissions()
        : Promise.resolve({ items: [] }),
      canReadCommissions.value
        ? conferenceApi.getPartnerCommissionInquiries()
        : Promise.resolve({ items: [] }),
      canReviewPayouts.value
        ? conferenceApi.getPartnerPayouts()
        : Promise.resolve({
            requests: [],
            batches: [],
            inquiries: [],
            recipients: [],
            documents: [],
            reconciliations: [],
          }),
      canReadPayoutSettings.value ? conferenceApi.getPartnerPayoutSettings() : Promise.resolve({}),
    ]);
    overview.value = overviewResult;
    partners.value = partnerResult.items;
    commissions.value = commissionResult.items;
    inquiries.value = inquiryResult.items;
    payoutRequests.value = payoutResult.requests;
    payoutBatches.value = payoutResult.batches;
    recipients.value = payoutResult.recipients;
    payoutDocuments.value = payoutResult.documents;
    reconciliations.value = payoutResult.reconciliations;
    payoutSettings.value = settingsResult;
    if (!tabs.value.some((tab) => tab.id === activeTab.value)) {
      activeTab.value = tabs.value[0]?.id ?? 'overview';
    }
    hydrateProgram();
    hydrateTransfer();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '分销数据读取失败';
  } finally {
    loading.value = false;
  }
}

async function run<T>(action: () => Promise<T>, message: string): Promise<T | undefined> {
  if (pending.value) return;
  pending.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const result = await action();
    successMessage.value = message;
    await load();
    return result;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '操作失败';
  } finally {
    pending.value = false;
  }
}

type PartnerFormKind = 'invite' | 'edit';

function fieldIssues(kind: PartnerFormKind) {
  return kind === 'invite' ? partnerInvitationIssues : partnerEditorIssues;
}

function fieldError(kind: PartnerFormKind, field: string) {
  return fieldIssues(kind).value.find(issue => issue.field === field)?.message ?? '';
}

function fieldAttributes(kind: PartnerFormKind, field: string) {
  return {
    name: field,
    'aria-invalid': fieldError(kind, field) ? 'true' as const : undefined,
    'aria-describedby': fieldError(kind, field) ? `partner-${kind}-${field}-error` : undefined,
  };
}

async function focusPartnerFeedback(kind: PartnerFormKind, field?: string) {
  await nextTick();
  const dialog = kind === 'invite' ? partnerInvitation.value : partnerEditor.value;
  const targetField = field ?? fieldIssues(kind).value[0]?.field;
  const input = targetField ? dialog?.querySelector<HTMLElement>(`[name="${targetField}"]`) : null;
  if (input) {
    input.focus({ preventScroll: true });
    input.scrollIntoView({ block: 'nearest' });
  } else {
    dialog?.querySelector<HTMLElement>('.partner-form-feedback')?.focus({ preventScroll: true });
  }
}

function clearPartnerFieldError(kind: PartnerFormKind, event: Event) {
  const field = (event.target as HTMLInputElement | HTMLTextAreaElement).name;
  fieldIssues(kind).value = fieldIssues(kind).value.filter(issue => issue.field !== field);
  if (kind === 'invite') partnerInvitationError.value = '';
  else partnerEditorError.value = '';
}

function openPartnerInvitation() {
  if (pending.value || !canManagePartners.value) return;
  Object.assign(enableForm, {
    mobile: '',
    displayName: '',
    company: '',
    title: '',
    ratePercent: '',
    note: '',
  });
  partnerInvitationError.value = '';
  partnerInvitationIssues.value = [];
  partnerInvitationOpen.value = true;
}

function closePartnerInvitation() {
  if (pending.value) return;
  partnerInvitationOpen.value = false;
  partnerInvitationError.value = '';
}

function handlePartnerInvitationCancel(event: Event) {
  event.preventDefault();
  closePartnerInvitation();
}

async function enablePartner() {
  if (pending.value) return;
  partnerInvitationError.value = '';
  partnerInvitationIssues.value = [];
  if (!program.value) {
    partnerInvitationError.value = '请先开启当前大会的分销功能，再邀请合作伙伴。';
    await focusPartnerFeedback('invite');
    return;
  }
  const parsed = AdminEnablePartnerSchema.safeParse({
    mobile: enableForm.mobile.trim(),
    ...(enableForm.displayName.trim() ? { displayName: enableForm.displayName.trim() } : {}),
    ...(enableForm.company.trim() ? { company: enableForm.company.trim() } : {}),
    ...(enableForm.title.trim() ? { title: enableForm.title.trim() } : {}),
    personalRateBps: enableRateValid.value
      ? (enableForm.ratePercent.trim() ? numberValue(enableForm.ratePercent, 100) : null)
      : NaN,
    sortOrder: 0,
    internalNote: enableForm.note,
    sendInvitation: true,
  });
  if (!parsed.success) {
    partnerInvitationIssues.value = partnerFieldIssues(parsed.error.issues);
    await focusPartnerFeedback('invite');
    return;
  }
  pending.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const enabledPartner = await conferenceApi.enableEventPartner(parsed.data);
    await load();
    partnerInvitationOpen.value = false;
    await nextTick();
    if (!enabledPartner.created) {
      const existing = partners.value.find(item => item.id === enabledPartner.id);
      if (existing) {
        openPartnerEditor(existing);
        partnerEditorNotice.value = '该手机号已是本大会的合作伙伴，已打开已有资料供你编辑。';
        successMessage.value = '该手机号已经是合作伙伴，已为你打开资料编辑。';
      } else {
        successMessage.value = '该手机号已经是合作伙伴，请刷新列表后编辑资料。';
      }
    } else {
      successMessage.value = '合作伙伴资格已就绪，对方可使用该手机号验证码登录并确认合作规则。';
    }
    Object.assign(enableForm, { mobile: '', displayName: '', company: '', title: '', ratePercent: '', note: '' });
  } catch (error) {
    partnerInvitationIssues.value = partnerServerFieldIssues(error);
    partnerInvitationError.value = error instanceof Error ? error.message : '合作伙伴开通失败，请重试。';
  } finally {
    pending.value = false;
  }
  if (partnerInvitationOpen.value) await focusPartnerFeedback('invite');
}

function updatePartner(item: AdminPartnerRelationshipView, status: 'active' | 'paused' | 'closed') {
  return run(
    () =>
      conferenceApi.updateEventPartner(item.id, {
        expectedVersion: item.version,
        qualificationStatus: status,
        attributionEnabled: status === 'active',
      }),
    '合作伙伴状态已更新。',
  );
}

function openPartnerEditor(item: AdminPartnerRelationshipView) {
  partnerEditorReturnFocus =
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  partnerEditorError.value = '';
  partnerEditorIssues.value = [];
  partnerEditorNotice.value = '';
  editForm.displayName = item.profile.displayName;
  editForm.company = item.profile.company;
  editForm.title = item.profile.title;
  editForm.industry = item.profile.industry;
  editForm.businessIntro = item.profile.businessIntro;
  editForm.businessUrl = item.profile.businessUrl;
  editForm.ratePercent = item.personalRateBps === null ? '' : String(item.personalRateBps / 100);
  editForm.sortOrder = String(item.sortOrder);
  editForm.internalNote = item.internalNote;
  editingPartner.value = item;
}

function closePartnerEditor() {
  if (pending.value) return;
  editingPartner.value = null;
  partnerEditorError.value = '';
}

function handlePartnerEditorCancel(event: Event) {
  event.preventDefault();
  closePartnerEditor();
}

async function savePartnerDetails() {
  const item = editingPartner.value;
  if (!item || pending.value) return;
  partnerEditorError.value = '';
  partnerEditorIssues.value = [];
  const parsed = AdminEditPartnerDetailsSchema.safeParse({
    expectedVersion: item.version,
    displayName: editForm.displayName.trim(),
    company: editForm.company.trim(),
    title: editForm.title.trim(),
    industry: editForm.industry.trim(),
    businessIntro: editForm.businessIntro.trim(),
    businessUrl: editForm.businessUrl.trim(),
    personalRateBps: editRateValid.value
      ? (editForm.ratePercent.trim() ? numberValue(editForm.ratePercent, 100) : null)
      : NaN,
    sortOrder: Number(editForm.sortOrder),
    internalNote: editForm.internalNote.trim(),
  });
  if (!parsed.success) {
    partnerEditorIssues.value = partnerFieldIssues(parsed.error.issues);
    partnerEditorError.value = partnerEditorIssues.value.length ? '' : '资料状态已变化，请关闭弹窗并刷新列表后重试。';
    await focusPartnerFeedback('edit');
    return;
  }
  pending.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    await conferenceApi.updateEventPartnerDetails(item.id, parsed.data);
    editingPartner.value = null;
    successMessage.value = '合作伙伴资料和佣金设置已更新。';
    await load();
  } catch (error) {
    partnerEditorIssues.value = partnerServerFieldIssues(error);
    partnerEditorError.value = error instanceof Error ? error.message : '合作伙伴资料保存失败，请重试。';
  } finally {
    pending.value = false;
  }
  if (editingPartner.value) await focusPartnerFeedback('edit');
}

function publishProgram() {
  return run(
    () => conferenceApi.publishPartnerProgram(programPayload()),
    '新版分销规则已发布，现有合作伙伴需重新确认。',
  );
}

function requestEnableDistribution() {
  errorMessage.value = '';
  successMessage.value = '';
  enableDialogOpen.value = true;
}

async function enableDistribution() {
  let published = false;
  await run(async () => {
    await conferenceApi.publishPartnerProgram(defaultProgramPayload());
    published = true;
  }, '分销功能已开启。合作伙伴确认规则后即可开始推广归因。');
  if (published) enableDialogOpen.value = false;
}

function openDistributionSettings() {
  activeTab.value = 'settings';
}

function reviewPayout(item: MoneyRow, decision: 'approve' | 'reject') {
  let taxAmount: number | undefined;
  if (decision === 'approve') {
    const grossYuan = Number(item.grossAmount ?? 0) / 100;
    const input = window.prompt(
      `请输入本次代扣税费（元），税前金额为 ¥${grossYuan.toFixed(2)}`,
      '0',
    );
    if (input === null) return;
    const value = Number(input);
    if (!Number.isFinite(value) || value < 0 || value > grossYuan) {
      errorMessage.value = '代扣税费需为零到税前金额之间的有效数字。';
      return;
    }
    taxAmount = Math.round(value * 100);
  }
  return run(
    () =>
      conferenceApi.reviewPartnerPayout(String(item.id), {
        expectedVersion: Number(item.version),
        decision,
        reason: decision === 'approve' ? '资料与金额已核验' : '收款资料需补充',
        ...(taxAmount === undefined ? {} : { taxAmount }),
      }),
    decision === 'approve'
      ? '结算金额已核定，等待合作伙伴确认。'
      : '提现申请已驳回并释放占用金额。',
  );
}

function createBatch(channel: 'manual_bank' | 'wechat_transfer') {
  return run(
    () =>
      conferenceApi.createPartnerPayoutBatch({
        requestIds: selectedRequestIds.value,
        channel,
        cutoffAt: new Date().toISOString(),
        idempotencyKey: `partner-payout-batch-${crypto.randomUUID()}`,
      }),
    '出款批次已建立，请由另一位管理员复核。',
  );
}

function reviewBatch(item: MoneyRow, decision: 'approve' | 'hold' | 'cancel') {
  return run(
    () =>
      conferenceApi.reviewPartnerPayoutBatch(String(item.id), {
        expectedVersion: Number(item.version),
        decision,
        reason: decision === 'approve' ? '批次金额与收款人已复核' : '批次需要调整',
      }),
    '出款批次状态已更新。',
  );
}

function executeBatch(item: MoneyRow) {
  return run(
    () => conferenceApi.executePartnerPayoutBatch(String(item.id), Number(item.version)),
    '微信转账已提交，未知或等待用户确认的金额会继续占用。',
  );
}

function payoutBatch(request: MoneyRow) {
  return payoutBatches.value.find((item) => item.id === request.batchId);
}

function payoutReceipt(request: MoneyRow) {
  return payoutDocuments.value.find(
    (item) =>
      item.payoutRequestId === request.id &&
      item.kind === 'manual_receipt' &&
      item.status === 'active',
  );
}

function uploadReceipt(item: MoneyRow, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  return run(
    () => conferenceApi.uploadPartnerPayoutDocument(String(item.id), 'manual_receipt', file),
    '人工结算回单已完成加密存储登记。',
  );
}

function completeManualPayout(item: MoneyRow) {
  const reference = window.prompt('请输入银行回单号或人工结算凭证编号');
  if (!reference?.trim()) return;
  return run(
    () =>
      conferenceApi.completeManualPartnerPayout(String(item.id), {
        expectedVersion: Number(item.version),
        externalReference: reference.trim(),
        paidAt: new Date().toISOString(),
        documentAssetId: payoutReceipt(item)?.id ?? null,
      }),
    '人工结算已登记到账。',
  );
}

function resolveReconciliation(item: MoneyRow) {
  const reason = window.prompt('请输入差异核对结果、资金账单凭证或处理说明');
  if (!reason?.trim()) return;
  return run(
    () => conferenceApi.resolvePartnerReconciliation(String(item.id), reason.trim()),
    '对账差异已完成销账并写入审计记录。',
  );
}

function verifyRecipient(item: MoneyRow) {
  return run(() => conferenceApi.verifyPartnerRecipient(String(item.id)), '收款信息已验证。');
}

function resolveInquiry(item: MoneyRow, decision: 'explained' | 'rejected') {
  const reason = window.prompt('处理说明（合作伙伴可见，至少 5 个字）');
  if (reason === null) return;
  if (reason.trim().length < 5) { errorMessage.value = '请填写至少 5 个字的处理说明。'; return; }
  return run(
    () =>
      conferenceApi.resolvePartnerInquiry(String(item.id), {
        expectedVersion: Number(item.version),
        decision,
        reason: reason.trim(),
      }),
    '佣金申诉已处理。',
  );
}

function adjustInquiry(item: MoneyRow, direction: 'credit_adjustment' | 'debit_adjustment') {
  const amount = window.prompt('请输入调整金额（元）');
  if (!amount || Number(amount) <= 0) return;
  return run(
    () =>
      conferenceApi.resolvePartnerInquiry(String(item.id), {
        expectedVersion: Number(item.version),
        decision: direction,
        reason: direction === 'credit_adjustment' ? '申诉核对后补记佣金' : '申诉核对后冲减佣金',
        adjustmentAmount: Math.round(Number(amount) * 100),
      }),
    Math.round(Number(amount) * 100) >= 100000
      ? '大额调整已提交，需另一位管理员复核相同内容。'
      : '佣金调整已记入账本。',
  );
}

function createCommissionAdjustment() {
  const cents = Math.round(Number(adjustmentForm.amountYuan) * 100);
  if (!adjustmentForm.partnerId || !Number.isSafeInteger(cents) || cents <= 0) return;
  const amount = adjustmentForm.direction === 'debit' ? -cents : cents;
  return run(
    () =>
      conferenceApi.createPartnerCommissionAdjustment({
        partnerId: adjustmentForm.partnerId,
        amount,
        reason: adjustmentForm.reason,
      }),
    cents >= 100_000
      ? '大额调整已生成待复核记录，需要另一位管理员按原金额复核。'
      : '佣金调整已写入追加式账本。',
  );
}

function createReconciliation() {
  const checkedCount = Number(reconciliationForm.checkedCount);
  const differenceCount = Number(reconciliationForm.differenceCount);
  const differenceAmount = Math.round(Number(reconciliationForm.differenceAmountYuan) * 100);
  if (
    !reconciliationForm.windowStart ||
    !reconciliationForm.windowEnd ||
    !Number.isSafeInteger(checkedCount) ||
    !Number.isSafeInteger(differenceCount) ||
    !Number.isSafeInteger(differenceAmount)
  )
    return;
  return run(
    () =>
      conferenceApi.createPartnerReconciliation({
        kind: 'payouts',
        batchId: reconciliationForm.batchId || null,
        windowStart: new Date(reconciliationForm.windowStart).toISOString(),
        windowEnd: new Date(reconciliationForm.windowEnd).toISOString(),
        checkedCount,
        differenceCount,
        differenceAmount,
        evidenceReference: reconciliationForm.evidenceReference,
        evidenceDigest: reconciliationForm.evidenceDigest,
        note: reconciliationForm.note,
      }),
    differenceCount ? '资金账单差异已登记，相关新出款已暂停。' : '资金账单核对结果已登记。',
  );
}

function saveTransferSettings() {
  return run(
    () =>
      conferenceApi.updatePartnerPayoutSettings({
        expectedRevision: Number(payoutSettings.value.revision ?? 0),
        enabled: transferForm.enabled,
        sceneId: '1005',
        jobType: transferForm.jobType,
        remunerationDescription: transferForm.remunerationDescription,
        payoutCadence: 'weekly',
        singleTransferLimit: numberValue(transferForm.singleTransferYuan, 100),
        dailyUserLimit: numberValue(transferForm.dailyUserYuan, 100),
        dailyMerchantLimit: numberValue(transferForm.dailyMerchantYuan, 100),
        monthlyMerchantLimit: numberValue(transferForm.monthlyMerchantYuan, 100),
        verifiedAt: transferForm.verifiedAt
          ? new Date(transferForm.verifiedAt).toISOString()
          : null,
      }),
    payoutSettings.value.pending
      ? '商家转账配置已完成复核。'
      : '商家转账配置已提交，需另一位管理员复核。',
  );
}

async function exportPayouts() {
  try {
    const count = await conferenceApi.exportPartnerPayouts();
    successMessage.value = `已导出 ${count} 条提现与结算记录。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '提现与对账导出失败';
  }
}

watch(program, hydrateProgram);
watch(partnerInvitationOpen, async (open) => {
  if (open) {
    await nextTick();
    if (partnerInvitationOpen.value && partnerInvitation.value && !partnerInvitation.value.open) {
      partnerInvitation.value.showModal();
    }
    return;
  }
  if (partnerInvitation.value?.open) partnerInvitation.value.close();
  partnerInvitationTrigger.value?.focus();
});
watch(editingPartner, async (item) => {
  const dialog = partnerEditor.value;
  if (item) {
    await nextTick();
    if (partnerEditor.value && !partnerEditor.value.open) partnerEditor.value.showModal();
    return;
  }
  if (dialog?.open) dialog.close();
  partnerEditorReturnFocus?.focus();
  partnerEditorReturnFocus = null;
});
onBeforeUnmount(() => {
  if (partnerInvitation.value?.open) partnerInvitation.value.close();
  if (partnerEditor.value?.open) partnerEditor.value.close();
});
onMounted(() => void load());
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">PARTNER DISTRIBUTION</p>
      <h1>合作伙伴与分销</h1>
      <p>管理伙伴资格、推广归因、佣金账本、提现复核和渠道对账。</p>
    </div>
    <button class="button secondary" type="button" :disabled="loading" @click="load">
      {{ loading ? '正在刷新…' : '刷新数据' }}
    </button>
  </header>

  <nav class="partner-tabs" aria-label="分销管理分区">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      :class="{ active: activeTab === tab.id }"
      @click="activeTab = tab.id"
    >
      {{ tab.label }}
    </button>
  </nav>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <p v-if="successMessage" class="admin-success" role="status">{{ successMessage }}</p>
  <div v-if="loading" class="admin-loading">正在读取合作伙伴与财务数据…</div>

  <template v-else-if="activeTab === 'overview'">
    <section class="partner-metrics">
      <article>
        <span>有效合作伙伴</span><strong>{{ counts.active ?? 0 }}</strong><small>待确认 {{ counts.pending_confirmation ?? 0 }} 人</small>
      </article>
      <article>
        <span>等待释放佣金</span><strong>{{ money(commissionTotals.pending) }}</strong><small>按当前结算等待期及退款窗口释放</small>
      </article>
      <article>
        <span>可提现佣金</span><strong>{{ money(commissionTotals.available) }}</strong><small>税前满 {{ money(program?.minimumPayoutAmount ?? 1000) }} 可申请</small>
      </article>
      <article>
        <span>提现待处理</span><strong>{{ money(commissionTotals.reserved) }}</strong><small>包含审核、确认金额、组批及出款中的占用</small>
      </article>
    </section>
    <section class="partner-panel" aria-label="推广效果统计">
      <div class="panel-heading"><div><p class="eyebrow">PROMOTION RESULTS</p><h2>推广效果</h2></div><span>本大会累计</span></div>
      <dl class="rule-grid">
        <div><dt>推广访问次数</dt><dd>{{ promotion.visits ?? 0 }}</dd></div>
        <div><dt>每日去重访问人次</dt><dd>{{ promotion.uniqueDailyVisits ?? 0 }}</dd></div>
        <div><dt>有效推广订单</dt><dd>{{ promotion.paidOrders ?? 0 }}</dd></div>
        <div><dt>有效推广成交额</dt><dd>{{ money(promotion.netSalesAmount) }}</dd></div>
      </dl>
      <p class="field-hint">仅统计专属推广入口访问；去重访问按日累计，同一人跨日可重复计数。成交额扣除退款和不计佣明细，自购不计入。</p>
    </section>
    <section class="partner-panel">
      <div class="panel-heading program-heading">
        <div>
          <p class="eyebrow">CONTROL BOARD</p>
          <h2>当前运行规则</h2>
        </div>
        <div class="program-state-actions">
          <span class="state-dot" :class="{ active: program }">
            {{ program ? '已开启' : '功能关闭' }}
          </span>
          <button
            v-if="!program && canManageRules"
            class="button compact"
            type="button"
            :disabled="pending"
            @click="requestEnableDistribution"
          >
            一键开启
          </button>
          <button
            v-if="canManageRules"
            class="button secondary compact"
            type="button"
            @click="openDistributionSettings"
          >
            分销设置
          </button>
        </div>
      </div>
      <p v-if="!program" class="program-closed-note">
        一键开启将采用固定佣金 10%、30 天归因有效期和 7
        天结算等待期。公开目录保持关闭，可在分销设置中单独开启。
      </p>
      <dl class="rule-grid">
        <div>
          <dt>佣金方式</dt>
          <dd>{{ program?.mode === 'order_count_tiered' ? '阶梯比例' : '固定比例' }}</dd>
        </div>
        <div>
          <dt>基础比例</dt>
          <dd>{{ Number(program?.fixedRateBps ?? 1000) / 100 }}%</dd>
        </div>
        <div>
          <dt>归因有效期</dt>
          <dd>{{ program?.attributionDays ?? 30 }} 天</dd>
        </div>
        <div>
          <dt>公开目录</dt>
          <dd>{{ program?.publicDirectoryEnabled ? '已开启' : '已关闭' }}</dd>
        </div>
      </dl>
    </section>
    <section v-if="canReadPartners" class="partner-panel partner-directory-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">PARTNER DIRECTORY</p>
          <h2>合作伙伴列表</h2>
        </div>
        <div class="partner-directory-actions">
          <span>{{ partners.length }} 人</span>
          <button
            v-if="canManagePartners"
            ref="partnerInvitationTrigger"
            class="button compact"
            type="button"
            :disabled="pending"
            @click="openPartnerInvitation"
          >
            新增合作伙伴
          </button>
        </div>
      </div>
      <div class="data-table-wrap partner-directory-wrap">
        <table class="data-table partner-directory-table">
          <thead>
            <tr>
              <th>伙伴</th>
              <th>公开资料</th>
              <th>佣金比例</th>
              <th>收益余额</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in partners" :key="item.id">
              <td data-label="伙伴">
                <strong>{{ item.profile.displayName }}</strong>
                <small>
                  {{
                    [item.profile.company, item.profile.title].filter(Boolean).join(' · ') ||
                      '待补充资料'
                  }}
                </small>
                <small>{{ mobileDisplay(item.loginMobile) }}</small>
              </td>
              <td data-label="公开资料">{{ item.profile.publicStatus === 'published' ? '已公开' : item.profile.publicStatus === 'hidden' ? '已隐藏' : '草稿' }}</td>
              <td data-label="佣金比例">
                <strong>{{
                  (item.personalRateBps ?? item.currentProgram?.fixedRateBps ?? 0) / 100
                }}%</strong>
                <small>{{ item.personalRateBps === null ? '继承大会规则' : '个人比例' }}</small>
              </td>
              <td data-label="收益余额">
                {{ money(item.balances.available)
                }}<small>占用 {{ money(item.balances.reserved) }}</small>
              </td>
              <td data-label="状态">
                <span class="status-badge">{{ label(item.qualificationStatus) }}</span>
              </td>
              <td data-label="操作">
                <div class="row-actions">
                  <button v-if="canManagePartners" type="button" @click="openPartnerEditor(item)">
                    编辑
                  </button>
                  <button
                    v-if="canManagePartners && item.qualificationStatus !== 'active'"
                    type="button"
                    @click="updatePartner(item, 'active')"
                  >
                    启用
                  </button><button
                    v-if="canManagePartners && item.qualificationStatus === 'active'"
                    type="button"
                    @click="updatePartner(item, 'paused')"
                  >
                    暂停
                  </button><button
                    v-if="canManagePartners && item.qualificationStatus !== 'closed'"
                    type="button"
                    @click="updatePartner(item, 'closed')"
                  >
                    关闭
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!partners.length">
              <td colspan="6" class="admin-empty">当前大会还没有开通合作伙伴。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>

  <template v-else-if="activeTab === 'commissions'">
    <form
      v-if="canManageCommissions"
      class="partner-panel adjustment-form"
      @submit.prevent="createCommissionAdjustment"
    >
      <div>
        <p class="eyebrow">LEDGER ADJUSTMENT</p>
        <h2>佣金调整</h2>
        <p>调整直接写入追加式账本，金额达到 1,000 元时需要第二位管理员复核。</p>
      </div>
      <label>合作伙伴<select v-model="adjustmentForm.partnerId" required>
        <option value="">请选择</option>
        <option v-for="item in partners" :key="item.id" :value="item.id">
          {{ item.profile.displayName }}
        </option>
      </select></label>
      <label>方向<select v-model="adjustmentForm.direction">
        <option value="credit">补记佣金</option>
        <option value="debit">冲减佣金</option>
      </select></label>
      <label>金额（元）<input
        v-model="adjustmentForm.amountYuan"
        type="number"
        min="0.01"
        step="0.01"
        required
      /></label>
      <label>原因<input v-model="adjustmentForm.reason" minlength="5" maxlength="2000" required /></label>
      <button class="button" type="submit" :disabled="pending">提交调整</button>
    </form>
    <section class="partner-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">COMMISSION ORDERS</p>
          <h2>佣金订单</h2>
        </div>
        <span>{{ commissions.length }} 笔</span>
      </div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>订单</th>
              <th>计佣金额</th>
              <th>比例</th>
              <th>佣金</th>
              <th>退款冲正</th>
              <th>状态</th>
              <th>建立时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in commissions" :key="String(item.id)">
              <td>
                <code style="overflow-wrap: anywhere">{{ item.orderId }}</code><small>{{ partnerName(item.partnerId) }}</small>
              </td>
              <td>{{ money(item.eligibleAmount) }}</td>
              <td>{{ Number(item.rateBps ?? 0) / 100 }}%</td>
              <td>{{ money(Number(item.commissionAmount ?? 0) - Number(item.reversedAmount ?? 0)) }}<small v-if="Number(item.reversedAmount ?? 0)">已冲正 {{ money(item.reversedAmount) }}</small></td>
              <td>{{ money(item.reversedAmount) }}</td>
              <td>
                <span class="status-badge">{{ item.status === 'available' ? '已过等待期' : label(item.status) }}</span>
              </td>
              <td>{{ dateTime(item.createdAt) }}</td>
            </tr>
            <tr v-if="!commissions.length">
              <td colspan="7" class="admin-empty">暂无佣金订单。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="partner-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">INQUIRIES</p>
          <h2>佣金申诉与调整复核</h2>
        </div>
        <span>{{ inquiries.length }} 条</span>
      </div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>订单线索</th>
              <th>问题说明</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in inquiries" :key="String(item.id)">
              <td>{{ item.orderReference }}</td>
              <td>{{ item.description }}</td>
              <td>{{ label(item.status) }}</td>
              <td>
                <div
                  v-if="['open', 'under_review'].includes(String(item.status))"
                  class="row-actions"
                >
                  <button type="button" @click="resolveInquiry(item, 'explained')">已说明</button><button type="button" @click="resolveInquiry(item, 'rejected')">驳回</button><button
                    v-if="canManageCommissions"
                    type="button"
                    @click="adjustInquiry(item, 'credit_adjustment')"
                  >
                    补记佣金
                  </button><button
                    v-if="canManageCommissions"
                    type="button"
                    @click="adjustInquiry(item, 'debit_adjustment')"
                  >
                    冲减佣金
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!inquiries.length">
              <td colspan="4" class="admin-empty">暂无佣金申诉。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>

  <template v-else-if="activeTab === 'payouts'">
    <section class="partner-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">PAYOUT REQUESTS</p>
          <h2>提现申请</h2>
        </div>
        <div class="row-actions">
          <button
            v-if="canExportPayouts"
            class="button secondary compact"
            type="button"
            @click="exportPayouts"
          >
            导出对账表
          </button><button
            v-if="canReviewPayouts"
            class="button secondary compact"
            type="button"
            :disabled="!selectedRequestIds.length"
            @click="createBatch('manual_bank')"
          >
            组成人工结算批次
          </button><button
            v-if="canReviewPayouts"
            class="button compact"
            type="button"
            :disabled="!selectedRequestIds.length"
            @click="createBatch('wechat_transfer')"
          >
            组成微信批次
          </button>
        </div>
      </div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>选择</th>
              <th>合作伙伴</th>
              <th>申请金额</th>
              <th>税额</th>
              <th>净额</th>
              <th>状态</th>
              <th>申请时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in payoutRequests" :key="String(item.id)">
              <td>
                <input
                  v-if="item.status === 'approved' && !item.batchId"
                  v-model="selectedRequestIds"
                  type="checkbox"
                  :value="String(item.id)"
                />
              </td>
              <td><strong>{{ partnerName(item.partnerId) }}</strong></td>
              <td>{{ money(item.grossAmount) }}</td>
              <td>{{ money(item.taxAmount) }}</td>
              <td>{{ money(item.netAmount) }}</td>
              <td>
                <span class="status-badge">{{ item.status === 'under_review' ? '待伙伴确认金额' : label(item.status) }}</span>
              </td>
              <td>{{ dateTime(item.createdAt) }}</td>
              <td>
                <div class="row-actions">
                  <template v-if="item.status === 'submitted' && canReviewPayouts">
                    <button type="button" @click="reviewPayout(item, 'approve')">通过</button><button type="button" @click="reviewPayout(item, 'reject')">
                      驳回
                    </button>
                  </template><button
                    v-if="
                      ['under_review', 'approved'].includes(String(item.status)) &&
                        !item.batchId &&
                        canReviewPayouts
                    "
                    type="button"
                    @click="reviewPayout(item, 'reject')"
                  >
                    驳回并释放
                  </button><label
                    v-if="
                      item.status === 'batched' &&
                        payoutBatch(item)?.channel === 'manual_bank' &&
                        canExecutePayouts
                    "
                    class="file-action"
                  >{{ payoutReceipt(item) ? '回单已存档' : '上传回单'
                  }}<input
                    type="file"
                    accept="application/pdf,image/jpeg,image/png"
                    @change="uploadReceipt(item, $event)"
                  /></label><button
                    v-if="
                      item.status === 'batched' &&
                        payoutBatch(item)?.channel === 'manual_bank' &&
                        payoutBatch(item)?.status === 'approved' &&
                        payoutBatch(item)?.approvedBy !== session.user.value?.id &&
                        canExecutePayouts
                    "
                    type="button"
                    @click="completeManualPayout(item)"
                  >
                    登记到账
                  </button><small v-if="item.status === 'batched' && payoutBatch(item)?.status === 'approved' && payoutBatch(item)?.approvedBy === session.user.value?.id">已由你复核，请另一位出款管理员登记到账。</small>
                </div>
              </td>
            </tr>
            <tr v-if="!payoutRequests.length">
              <td colspan="8" class="admin-empty">暂无提现申请。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="partner-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">RECIPIENT REVIEW</p>
          <h2>收款人验证</h2>
        </div>
        <span>敏感账号信息加密保存</span>
      </div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>合作伙伴</th>
              <th>主体</th>
              <th>渠道</th>
              <th>状态</th>
              <th>提交时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in recipients" :key="String(item.id)">
              <td>
                <strong>{{ partnerName(item.partnerId) }}</strong>
              </td>
              <td>{{ item.type === 'organization' ? '企业' : '自然人' }}</td>
              <td>{{ item.channel === 'wechat_transfer' ? '微信商家转账' : '人工结算' }}</td>
              <td>{{ item.status === 'pending' ? '待验证' : label(item.status) }}</td>
              <td>{{ dateTime(item.createdAt) }}</td>
              <td>
                <button v-if="item.channel === 'manual_bank' && canReviewPayouts" type="button" :disabled="pending" @click="viewRecipient(item)">查看收款信息</button>
                <button
                  v-if="item.status === 'pending' && canReviewPayouts"
                  type="button"
                  @click="verifyRecipient(item)"
                >
                  验证通过
                </button>
              </td>
            </tr>
            <tr v-if="!recipients.length">
              <td colspan="6" class="admin-empty">暂无待验证收款人。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="partner-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">PAYOUT BATCHES</p>
          <h2>出款批次</h2>
        </div>
        <span>执行、回调和查单共用同一状态机</span>
      </div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>渠道</th>
              <th>笔数</th>
              <th>金额</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in payoutBatches" :key="String(item.id)">
              <td>{{ item.channel === 'wechat_transfer' ? '微信商家转账' : '人工银行结算' }}</td>
              <td>{{ item.requestCount }}</td>
              <td>{{ money(item.netAmount) }}</td>
              <td>
                <span class="status-badge">{{ label(item.status) }}</span>
              </td>
              <td>{{ dateTime(item.createdAt) }}</td>
              <td>
                <div class="row-actions">
                  <button
                    v-if="['draft', 'held'].includes(String(item.status)) && canReviewPayouts"
                    type="button"
                    @click="reviewBatch(item, 'approve')"
                  >
                    复核通过
                  </button><button
                    v-if="item.status === 'draft' && canReviewPayouts"
                    type="button"
                    @click="reviewBatch(item, 'hold')"
                  >
                    暂停
                  </button><button
                    v-if="
                      ['draft', 'held', 'approved'].includes(String(item.status)) &&
                        canReviewPayouts
                    "
                    type="button"
                    @click="reviewBatch(item, 'cancel')"
                  >
                    取消
                  </button><button
                    v-if="
                      item.status === 'approved' &&
                        item.channel === 'wechat_transfer' &&
                        canExecutePayouts
                    "
                    type="button"
                    @click="executeBatch(item)"
                  >
                    执行出款
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <form
      v-if="canExecutePayouts"
      class="partner-panel reconciliation-form"
      @submit.prevent="createReconciliation"
    >
      <div>
        <p class="eyebrow">FUND BILL</p>
        <h2>登记资金账单核对结果</h2>
        <p>保存账单证据编号和 SHA-256。存在差异时，系统会暂停相关批次和新的出款。</p>
      </div>
      <label>关联批次<select v-model="reconciliationForm.batchId">
        <option value="">大会全部出款</option>
        <option v-for="item in payoutBatches" :key="String(item.id)" :value="String(item.id)">
          {{ item.channel === 'wechat_transfer' ? '微信' : '人工' }} ·
          {{ String(item.id).slice(0, 8) }}
        </option>
      </select></label>
      <div class="field-pair">
        <label>账单开始时间<input
          v-model="reconciliationForm.windowStart"
          type="datetime-local"
          required
        /></label><label>账单结束时间<input v-model="reconciliationForm.windowEnd" type="datetime-local" required /></label>
      </div>
      <div class="field-pair">
        <label>检查笔数<input
          v-model="reconciliationForm.checkedCount"
          type="number"
          min="0"
          step="1"
          required
        /></label><label>差异笔数<input
          v-model="reconciliationForm.differenceCount"
          type="number"
          min="0"
          step="1"
          required
        /></label>
      </div>
      <label>差异金额（元，可为负数）<input
        v-model="reconciliationForm.differenceAmountYuan"
        type="number"
        step="0.01"
        required
      /></label>
      <label>账单证据编号<input v-model="reconciliationForm.evidenceReference" maxlength="240" required /></label>
      <label>账单文件 SHA-256<input
        v-model="reconciliationForm.evidenceDigest"
        maxlength="64"
        pattern="[a-fA-F0-9]{64}"
        required
      /></label>
      <label>核对说明<textarea v-model="reconciliationForm.note" rows="3" maxlength="1000" />
      </label>
      <button class="button" type="submit" :disabled="pending">登记核对结果</button>
    </form>
    <section class="partner-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">RECONCILIATION</p>
          <h2>财务对账</h2>
        </div>
        <span>差异需保留核对依据</span>
      </div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>检查范围</th>
              <th>检查笔数</th>
              <th>差异</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in reconciliations" :key="String(item.id)">
              <td>
                {{ item.kind === 'payouts' ? '出款' : item.kind === 'refunds' ? '退款' : '支付' }}
              </td>
              <td>{{ dateTime(item.windowStart) }} 至 {{ dateTime(item.windowEnd) }}</td>
              <td>{{ item.checkedCount ?? 0 }}</td>
              <td>{{ item.differenceCount ?? 0 }} 笔 / {{ money(item.differenceAmount) }}</td>
              <td>{{ label(item.status) }}</td>
              <td>
                <button
                  v-if="['difference', 'failed'].includes(String(item.status)) && canExecutePayouts"
                  type="button"
                  @click="resolveReconciliation(item)"
                >
                  登记核对结果
                </button>
              </td>
            </tr>
            <tr v-if="!reconciliations.length">
              <td colspan="6" class="admin-empty">暂无对账记录。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>

  <template v-else>
    <section class="partner-settings-grid">
      <form class="partner-panel settings-form" @submit.prevent="publishProgram">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">PROGRAM RULES</p>
            <h2>大会分销规则</h2>
          </div>
          <span>发布后伙伴重新确认</span>
        </div>
        <label>计佣方式<select v-model="programForm.mode">
          <option value="fixed">固定比例</option>
          <option value="order_count_tiered">按有效订单阶梯</option>
        </select></label>
        <label>基础佣金比例
          <div class="input-unit">
            <input v-model="programForm.ratePercent" inputmode="decimal" /><span>%</span>
          </div></label>
        <label v-if="programForm.mode === 'order_count_tiered'">阶梯设置<textarea v-model="programForm.tiers" rows="4" /><small>每行为“有效订单数:佣金百分比”，一笔批量订单只计一个阶梯订单。</small></label>
        <div class="field-pair">
          <label>归因有效期<input v-model="programForm.attributionDays" inputmode="numeric" /></label><label>结算等待天数<input v-model="programForm.settlementDelayDays" inputmode="numeric" /></label>
        </div>
        <div class="field-pair">
          <label>最低提现金额<input
            v-model="programForm.minimumPayoutYuan"
            inputmode="decimal"
          /></label><label>首页展示人数<input v-model="programForm.homepageLimit" inputmode="numeric" /></label>
        </div>
        <label class="switch-row"><input v-model="programForm.publicDirectoryEnabled" type="checkbox" /><span>开启合作伙伴公开目录与首页区块</span></label>
        <label>规则标题<input v-model="programForm.termsTitle" maxlength="160" /></label>
        <label>规则正文<textarea v-model="programForm.termsContent" rows="5" maxlength="40000" />
        </label>
        <label>推广规范<textarea v-model="programForm.promotionPolicy" rows="4" maxlength="20000" />
        </label>
        <button v-if="canManageRules" class="button" type="submit" :disabled="pending">
          发布新版规则
        </button>
      </form>

      <form class="partner-panel settings-form" @submit.prevent="saveTransferSettings">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">WECHAT TRANSFER</p>
            <h2>微信商家转账</h2>
          </div>
          <span>场景 1005</span>
        </div>
        <p class="settings-note">
          此处复用组织微信支付凭据。配置需另一位管理员复核，未知渠道状态继续占用资金。
        </p>
        <label class="switch-row"><input v-model="transferForm.enabled" type="checkbox" /><span>启用微信商家转账</span></label>
        <label>岗位类型<input v-model="transferForm.jobType" maxlength="32" /></label>
        <label>报酬说明<input v-model="transferForm.remunerationDescription" maxlength="32" /></label>
        <div class="field-pair">
          <label>单笔上限（元）<input
            v-model="transferForm.singleTransferYuan"
            inputmode="decimal"
          /></label><label>单用户单日上限<input v-model="transferForm.dailyUserYuan" inputmode="decimal" /></label>
        </div>
        <div class="field-pair">
          <label>商户单日上限<input
            v-model="transferForm.dailyMerchantYuan"
            inputmode="decimal"
          /></label><label>商户月度上限<input v-model="transferForm.monthlyMerchantYuan" inputmode="decimal" /></label>
        </div>
        <label>资质验收时间<input v-model="transferForm.verifiedAt" type="datetime-local" /></label>
        <p v-if="payoutSettings.pending" class="pending-review">
          已有一份待复核配置。另一位管理员使用相同内容提交后生效。
        </p>
        <button v-if="canManagePayoutSettings" class="button" type="submit" :disabled="pending">
          提交配置
        </button>
      </form>
    </section>
  </template>

  <Teleport to="body">
    <dialog ref="recipientDialog" class="partner-dialog partner-edit-dialog recipient-details-dialog" aria-labelledby="recipient-detail-title" @close="recipientDetail = null" @cancel.prevent="closeRecipientDetails">
      <header class="partner-edit-head"><h2 id="recipient-detail-title">核对人工收款信息</h2><p>仅供财务核验，本次查看已记录访问审计。请核对后再操作转账。</p></header>
      <div v-if="recipientDetail" class="partner-edit-body">
        <dl class="rule-grid">
          <div><dt>合作伙伴</dt><dd>{{ partnerName(recipientDetail.partnerId) }}</dd></div>
          <div><dt>收款人名称</dt><dd>{{ recipientDetail.displayName }}</dd></div>
          <div><dt>收款账户信息</dt><dd style="white-space: pre-wrap; overflow-wrap: anywhere">{{ recipientDetail.accountReference }}</dd></div>
        </dl>
      </div>
      <footer class="partner-edit-footer"><button class="button secondary" type="button" @click="closeRecipientDetails">关闭</button></footer>
    </dialog>
  </Teleport>
  <Teleport to="body">
    <dialog
      ref="partnerInvitation"
      class="partner-dialog partner-invite-dialog"
      aria-labelledby="partner-invite-title"
      aria-describedby="partner-invite-description"
      @cancel="handlePartnerInvitationCancel"
    >
      <form
        v-if="partnerInvitationOpen"
        class="partner-modal-form partner-invite-form"
        novalidate
        @input="clearPartnerFieldError('invite', $event)"
        @submit.prevent="enablePartner"
      >
        <header class="partner-edit-head">
          <div>
            <p class="eyebrow">NEW PARTNER</p>
            <h2 id="partner-invite-title">新增合作伙伴</h2>
            <p id="partner-invite-description">
              输入手机号即可邀请。新手机号会自动建立普通用户账号，对方使用验证码登录后确认合作规则。
            </p>
          </div>
          <button
            class="partner-edit-close"
            type="button"
            aria-label="关闭新增合作伙伴"
            :disabled="pending"
            @click="closePartnerInvitation"
          >
            ×
          </button>
        </header>

        <section v-if="partnerInvitationError || partnerInvitationIssues.length" class="partner-form-feedback" role="alert" tabindex="-1">
          <span class="partner-feedback-icon" aria-hidden="true">!</span>
          <div>
            <h3>{{ partnerInvitationIssues.length ? `请检查以下 ${partnerInvitationIssues.length} 项内容` : '提交未完成' }}</h3>
            <ul v-if="partnerInvitationIssues.length">
              <li v-for="issue in partnerInvitationIssues" :key="issue.field">
                <button type="button" @click="focusPartnerFeedback('invite', issue.field)">{{ issue.message }}</button>
              </li>
            </ul>
            <p v-else>{{ partnerInvitationError }}</p>
          </div>
        </section>

        <div class="partner-edit-body">
          <div v-if="!program" class="quick-enable-locked partner-invite-locked">
            <div>
              <strong>当前大会尚未开启分销功能</strong>
              <p>请先确认佣金与归因规则，再邀请合作伙伴。</p>
            </div>
            <div v-if="canManageRules" class="quick-enable-actions">
              <button
                class="button compact"
                type="button"
                :disabled="pending"
                @click="
                  closePartnerInvitation();
                  requestEnableDistribution();
                "
              >
                一键开启分销
              </button>
              <button
                class="button secondary compact"
                type="button"
                @click="
                  closePartnerInvitation();
                  openDistributionSettings();
                "
              >
                查看分销设置
              </button>
            </div>
            <p v-else class="quick-enable-permission-note">
              请联系拥有分销设置权限的管理员开启当前大会的分销功能。
            </p>
          </div>
          <fieldset v-else class="quick-enable-form" :disabled="pending">
            <label><span>合作伙伴手机号 <span class="required-mark">必填</span></span>
              <input
                v-model="enableForm.mobile"
                v-bind="fieldAttributes('invite', 'mobile')"
                type="tel"
                required
                autofocus
                inputmode="tel"
                autocomplete="tel"
                maxlength="14"
                placeholder="请输入 11 位大陆手机号"
              />
              <small v-if="fieldError('invite', 'mobile')" id="partner-invite-mobile-error" class="partner-field-error">
                {{ fieldError('invite', 'mobile') }}
              </small>
            </label>
            <label><span>姓名 / 展示名称 <span class="optional-mark">选填</span></span>
              <input
                v-model="enableForm.displayName"
                v-bind="fieldAttributes('invite', 'displayName')"
                maxlength="80"
                autocomplete="name"
                placeholder="例如 张三"
              />
              <small v-if="fieldError('invite', 'displayName')" id="partner-invite-displayName-error" class="partner-field-error">
                {{ fieldError('invite', 'displayName') }}
              </small>
            </label>
            <label><span>公司 <span class="optional-mark">选填</span></span>
              <input
                v-model="enableForm.company"
                v-bind="fieldAttributes('invite', 'company')"
                maxlength="160"
                autocomplete="organization"
                placeholder="例如 北京某某科技有限公司"
              />
              <small v-if="fieldError('invite', 'company')" id="partner-invite-company-error" class="partner-field-error">
                {{ fieldError('invite', 'company') }}
              </small>
            </label>
            <label><span>职务 <span class="optional-mark">选填</span></span>
              <input
                v-model="enableForm.title"
                v-bind="fieldAttributes('invite', 'title')"
                maxlength="100"
                autocomplete="organization-title"
                placeholder="例如 市场副总裁"
              />
              <small v-if="fieldError('invite', 'title')" id="partner-invite-title-error" class="partner-field-error">
                {{ fieldError('invite', 'title') }}
              </small>
            </label>
            <label><span>个人佣金比例 <span class="optional-mark">选填</span></span>
              <span class="input-unit">
                <input
                  v-model="enableForm.ratePercent"
                  v-bind="fieldAttributes('invite', 'personalRateBps')"
                  inputmode="decimal"
                  placeholder="留空按大会规则"
                />
                <span>%</span>
              </span>
              <small v-if="fieldError('invite', 'personalRateBps')" id="partner-invite-personalRateBps-error" class="partner-field-error">
                {{ fieldError('invite', 'personalRateBps') }}
              </small>
            </label>
            <label><span>内部备注 <span class="optional-mark">选填，仅后台可见</span></span>
              <textarea
                v-model="enableForm.note"
                v-bind="fieldAttributes('invite', 'internalNote')"
                maxlength="2000"
                rows="3"
                placeholder="记录合作来源、负责人或特殊约定"
              />
              <small v-if="fieldError('invite', 'internalNote')" id="partner-invite-internalNote-error" class="partner-field-error">
                {{ fieldError('invite', 'internalNote') }}
              </small>
            </label>
          </fieldset>
        </div>
        <footer class="partner-edit-footer">
          <button
            class="button secondary"
            type="button"
            :disabled="pending"
            @click="closePartnerInvitation"
          >
            取消
          </button>
          <button
            v-if="program"
            class="button"
            type="submit"
            :disabled="pending"
          >
            {{ pending ? '正在开通…' : '邀请并开通' }}
          </button>
        </footer>
      </form>
    </dialog>
  </Teleport>

  <Teleport to="body">
    <dialog
      ref="partnerEditor"
      class="partner-dialog partner-edit-dialog"
      aria-labelledby="partner-edit-title"
      @cancel="handlePartnerEditorCancel"
    >
      <form v-if="editingPartner" class="partner-modal-form partner-edit-form" novalidate @input="clearPartnerFieldError('edit', $event)" @submit.prevent="savePartnerDetails">
        <header class="partner-edit-head">
          <div>
            <p class="eyebrow">EDIT PARTNER</p>
            <h2 id="partner-edit-title">编辑合作伙伴</h2>
            <p>资料修改仅作用于当前大会，佣金比例从后续符合条件的订单开始生效。</p>
          </div>
          <button
            class="partner-edit-close"
            type="button"
            aria-label="关闭编辑"
            :disabled="pending"
            @click="closePartnerEditor"
          >
            ×
          </button>
        </header>

        <p v-if="partnerEditorNotice" class="partner-editor-notice" role="status">{{ partnerEditorNotice }}</p>

        <section v-if="partnerEditorError || partnerEditorIssues.length" class="partner-form-feedback" role="alert" tabindex="-1">
          <span class="partner-feedback-icon" aria-hidden="true">!</span>
          <div>
            <h3>{{ partnerEditorIssues.length ? `请检查以下 ${partnerEditorIssues.length} 项内容` : '提交未完成' }}</h3>
            <ul v-if="partnerEditorIssues.length">
              <li v-for="issue in partnerEditorIssues" :key="issue.field">
                <button type="button" @click="focusPartnerFeedback('edit', issue.field)">{{ issue.message }}</button>
              </li>
            </ul>
            <p v-else>{{ partnerEditorError }}</p>
          </div>
        </section>


        <div class="partner-edit-body">
          <section class="partner-edit-section" aria-labelledby="partner-basic-title">
            <div>
              <h3 id="partner-basic-title">基础资料</h3>
              <p>这些资料用于当前大会的合作伙伴名片和详情页。</p>
            </div>
            <label>登录手机号
              <input :value="mobileDisplay(editingPartner.loginMobile)" type="tel" readonly />
              <small>手机号是登录账号。如需更换，请在系统用户管理中处理。</small>
            </label>
            <label><span>姓名 / 展示名称 <span class="required-mark">必填</span></span>
              <input
                v-model="editForm.displayName"
                v-bind="fieldAttributes('edit', 'displayName')" maxlength="80" required
              />
              <small v-if="fieldError('edit', 'displayName')" id="partner-edit-displayName-error" class="partner-field-error">
                {{ fieldError('edit', 'displayName') }}
              </small>
            </label>
            <label><span>公司 <span class="optional-mark">选填</span></span>
              <input
                v-model="editForm.company"
                v-bind="fieldAttributes('edit', 'company')" maxlength="160"
              />
              <small v-if="fieldError('edit', 'company')" id="partner-edit-company-error" class="partner-field-error">
                {{ fieldError('edit', 'company') }}
              </small>
            </label>
            <label><span>职务 <span class="optional-mark">选填</span></span>
              <input
                v-model="editForm.title"
                v-bind="fieldAttributes('edit', 'title')" maxlength="100"
              />
              <small v-if="fieldError('edit', 'title')" id="partner-edit-title-error" class="partner-field-error">
                {{ fieldError('edit', 'title') }}
              </small>
            </label>
            <label><span>行业 <span class="optional-mark">选填</span></span>
              <input
                v-model="editForm.industry"
                v-bind="fieldAttributes('edit', 'industry')" maxlength="80"
              />
              <small v-if="fieldError('edit', 'industry')" id="partner-edit-industry-error" class="partner-field-error">
                {{ fieldError('edit', 'industry') }}
              </small>
            </label>
            <label><span>个人 / 业务介绍 <span class="optional-mark">选填</span></span>
              <textarea
                v-model="editForm.businessIntro"
                v-bind="fieldAttributes('edit', 'businessIntro')" maxlength="2000" rows="5"
              />
              <small v-if="fieldError('edit', 'businessIntro')" id="partner-edit-businessIntro-error" class="partner-field-error">
                {{ fieldError('edit', 'businessIntro') }}
              </small>
            </label>
            <label><span>业务链接 <span class="optional-mark">选填</span></span>
              <input
                v-model="editForm.businessUrl"
                v-bind="fieldAttributes('edit', 'businessUrl')"
                type="url"
                maxlength="500"
                placeholder="https://"
              />
              <small v-if="fieldError('edit', 'businessUrl')" id="partner-edit-businessUrl-error" class="partner-field-error">
                {{ fieldError('edit', 'businessUrl') }}
              </small>
            </label>
            <p class="partner-edit-tip">
              联系方式和公开范围由合作伙伴登录个人中心确认，后台不会代替本人公开隐私信息。
            </p>
          </section>

          <section class="partner-edit-section" aria-labelledby="partner-commercial-title">
            <div>
              <h3 id="partner-commercial-title">推广设置</h3>
              <p>调整只影响后续新订单，已经入账的佣金保留原计算结果。</p>
            </div>
            <label><span>个人佣金比例 <span class="optional-mark">选填</span></span>
              <span class="input-unit">
                <input
                  v-model="editForm.ratePercent"
                  v-bind="fieldAttributes('edit', 'personalRateBps')"
                  inputmode="decimal"
                  placeholder="留空按大会规则"
                />
                <span>%</span>
              </span>
              <small>留空继承大会规则；填写 0 表示不计佣金。</small>
              <small v-if="fieldError('edit', 'personalRateBps')" id="partner-edit-personalRateBps-error" class="partner-field-error">
                {{ fieldError('edit', 'personalRateBps') }}
              </small>
            </label>
            <label><span>展示顺序</span>
              <input
                v-model="editForm.sortOrder"
                v-bind="fieldAttributes('edit', 'sortOrder')" inputmode="numeric"
              />
              <small>数值越小，在公开目录中的位置越靠前。</small>
              <small v-if="fieldError('edit', 'sortOrder')" id="partner-edit-sortOrder-error" class="partner-field-error">
                {{ fieldError('edit', 'sortOrder') }}
              </small>
            </label>
            <label><span>内部备注 <span class="optional-mark">选填，仅后台可见</span></span>
              <textarea
                v-model="editForm.internalNote"
                v-bind="fieldAttributes('edit', 'internalNote')" maxlength="2000" rows="4"
              />
              <small v-if="fieldError('edit', 'internalNote')" id="partner-edit-internalNote-error" class="partner-field-error">
                {{ fieldError('edit', 'internalNote') }}
              </small>
            </label>
          </section>
        </div>
        <footer class="partner-edit-footer">
          <button
            class="button secondary"
            type="button"
            :disabled="pending"
            @click="closePartnerEditor"
          >
            取消
          </button>
          <button
            class="button"
            type="submit"
            :disabled="pending"
          >
            {{ pending ? '正在保存…' : '保存修改' }}
          </button>
        </footer>
      </form>
    </dialog>
  </Teleport>

  <AdminConfirmDialog
    :open="enableDialogOpen"
    title="确认开启合作伙伴分销？"
    description="确认后将立即发布默认分销规则。新的推广点击可建立归因，合作伙伴需先确认规则。"
    confirm-label="确认开启"
    :busy="pending"
    :error="errorMessage"
    :event-name="session.activeEvent.value?.name"
    :details="[
      { label: '佣金方式', value: '固定比例 10%' },
      { label: '归因有效期', value: '30 天' },
      { label: '结算等待', value: '支付满 7 天与退款窗口结束后 24 小时取较晚值' },
      { label: '公开目录', value: '保持关闭，可在分销设置中开启' },
    ]"
    @confirm="enableDistribution"
    @cancel="enableDialogOpen = false"
  />
</template>

<style scoped>
.recipient-details-dialog .partner-edit-head { display: block; }
.recipient-details-dialog .partner-edit-head h2 { margin: 0 0 12px; }
.recipient-details-dialog .rule-grid { grid-template-columns: 1fr; }
.recipient-details-dialog .rule-grid dd { margin-top: 8px; overflow-wrap: anywhere; }

.partner-tabs {
  display: flex;
  gap: 8px;
  margin: 0 0 22px;
  padding: 6px;
  border: 1px solid var(--line, #dbe3ee);
  border-radius: 14px;
  background: #fff;
  overflow: auto;
}
.partner-tabs button {
  min-height: 44px;
  border: 0;
  background: transparent;
  padding: 11px 18px;
  border-radius: 9px;
  color: #526176;
  white-space: nowrap;
  font-weight: 650;
}
.partner-tabs button.active {
  background: #0e2b50;
  color: #fff;
}
.partner-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
.partner-metrics article,
.partner-panel {
  border: 1px solid #dbe3ee;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 12px 32px rgba(21, 50, 83, 0.05);
}
.partner-metrics article {
  padding: 20px;
}
.partner-metrics span,
.partner-metrics small {
  display: block;
  color: #6f7e90;
}
.partner-metrics strong {
  display: block;
  margin: 10px 0 5px;
  font:
    700 28px/1.1 Georgia,
    'Songti SC',
    serif;
  color: #102e52;
}
.partner-panel {
  padding: 22px;
  margin-bottom: 18px;
}
.panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 18px;
}
.panel-heading h2 {
  margin: 2px 0 0;
  font:
    700 24px/1.2 Georgia,
    'Songti SC',
    serif;
  color: #102e52;
}
.panel-heading > span,
.state-dot {
  color: #64748b;
  font-size: 13px;
}
.program-state-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.state-dot {
  padding: 6px 10px;
  border-radius: 999px;
  background: #f1f5f9;
  font-weight: 650;
}
.state-dot.active {
  color: #166534;
  background: #ecfdf3;
}
.program-closed-note {
  margin: -3px 0 16px;
  padding: 12px 14px;
  border: 1px solid #dbe5f0;
  border-radius: 10px;
  color: #526176;
  background: #f7f9fc;
  font-size: 13px;
  line-height: 1.7;
}
.rule-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin: 0;
}
.rule-grid div {
  padding: 15px;
  border-radius: 12px;
  background: #f5f8fc;
}
.rule-grid dt {
  color: #718096;
  font-size: 12px;
}
.rule-grid dd {
  margin: 7px 0 0;
  color: #163b66;
  font-weight: 700;
}
.partner-directory-panel .panel-heading {
  flex-wrap: wrap;
}
.partner-directory-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}
.partner-dialog {
  width: min(640px, calc(100vw - 32px));
  max-height: min(880px, calc(100dvh - 32px));
  position: fixed;
  inset: 0;
  margin: auto;
  padding: 0;
  overflow: hidden;
  border: 1px solid #dbe5f0;
  border-radius: 18px;
  background: #fff;
  color: #17385e;
  box-shadow: 0 24px 60px rgba(15, 38, 66, 0.2);
}
.partner-modal-form {
  display: flex;
  flex-direction: column;
  max-height: min(878px, calc(100dvh - 34px));
}
.partner-modal-form > header,
.partner-modal-form > footer,
.partner-modal-form > .partner-form-feedback,
.partner-modal-form > .partner-editor-notice {
  flex-shrink: 0;
}
.partner-invite-form .partner-invite-locked {
  align-items: flex-start;
  flex-direction: column;
}
.partner-invite-locked .quick-enable-permission-note {
  text-align: left;
}
.quick-enable-form {
  display: grid;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  gap: 16px;
}
.quick-enable-locked {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 16px;
  border: 1px solid #dbe5f0;
  border-radius: 12px;
  background: #f7f9fc;
}
.quick-enable-locked strong {
  display: block;
  color: #17385e;
}
.quick-enable-locked p {
  margin: 5px 0 0;
  color: #68788b;
  font-size: 13px;
}
.quick-enable-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}
.quick-enable-locked .quick-enable-permission-note {
  max-width: 360px;
  margin: 0;
  text-align: right;
}
.quick-enable-form label,
.settings-form label {
  display: grid;
  gap: 7px;
  color: #405168;
  font-size: 13px;
  font-weight: 650;
}
.quick-enable-form input,
.quick-enable-form textarea,
.settings-form input,
.settings-form select,
.settings-form textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #ccd7e5;
  border-radius: 10px;
  background: #fff;
  padding: 10px 12px;
  color: #17385e;
  font: inherit;
}
.quick-enable-form textarea,
.partner-edit-form textarea {
  resize: vertical;
}
.required-mark,
.optional-mark {
  margin-left: 5px;
  font-size: 12px;
  font-weight: 500;
}
.required-mark {
  color: #b42318;
}
.optional-mark {
  color: #7b899a;
}
.quick-enable-form small {
  color: #b42318;
  font-size: 12px;
  font-weight: 500;
}
.data-table td strong,
.data-table td small {
  display: block;
}
.data-table td small {
  margin-top: 4px;
  color: #77869a;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.row-actions button {
  border: 1px solid #c9d6e5;
  border-radius: 8px;
  background: #fff;
  padding: 6px 9px;
  color: #21466f;
  cursor: pointer;
}
.partner-dialog::backdrop {
  background: rgba(14, 32, 52, 0.42);
  backdrop-filter: blur(2px);
}
.partner-form-feedback {
  display: flex;
  gap: 10px;
  max-height: min(180px, 23dvh);
  margin: 16px 30px 0;
  padding: 12px 14px;
  overflow: auto;
  border: 1px solid #f0a6a6;
  border-left: 4px solid #c83535;
  border-radius: 10px;
  color: #9b2222;
  background: #fff1f1;
}
.partner-feedback-icon {
  display: grid;
  flex: 0 0 22px;
  height: 22px;
  place-items: center;
  border-radius: 50%;
  color: white;
  background: #b42318;
  font-weight: 700;
}
.partner-form-feedback h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
.partner-form-feedback ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.partner-form-feedback li + li {
  margin-top: 6px;
}
.partner-form-feedback p,
.partner-form-feedback button {
  margin: 0;
  color: inherit;
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.partner-form-feedback button {
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.partner-editor-notice {
  margin: 16px 30px 0;
  padding: 12px 14px;
  border: 1px solid #b9d1ea;
  border-radius: 10px;
  background: #eef5fc;
  color: #234e7c;
  font-size: 13px;
  line-height: 1.65;
}
.partner-modal-form input[aria-invalid='true'],
.partner-modal-form textarea[aria-invalid='true'] {
  border-color: #c83535;
  background: #fff8f8;
}
.partner-modal-form .partner-field-error {
  color: #b42318;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.6;
}
.partner-edit-head {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 28px 30px 22px;
  border-bottom: 1px solid #e1e8f0;
}
.partner-edit-head h2 {
  margin: 4px 0 8px;
  color: #102e52;
  font:
    700 28px/1.2 Georgia,
    'Songti SC',
    serif;
}
.partner-edit-head p:last-child,
.partner-edit-section > div > p {
  margin: 0;
  color: #69788a;
  font-size: 13px;
  line-height: 1.65;
}
.partner-edit-close {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border: 1px solid #d4deea;
  border-radius: 50%;
  background: #fff;
  color: #43576e;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}
.partner-edit-body {
  display: grid;
  gap: 18px;
  padding: 22px 30px 30px;
  overflow: auto;
}
.partner-edit-section {
  display: grid;
  gap: 15px;
  padding: 20px;
  border: 1px solid #dde6f0;
  border-radius: 14px;
  background: #fbfcfe;
}
.partner-edit-section h3 {
  margin: 0 0 4px;
  color: #17385e;
  font-size: 17px;
}
.partner-edit-section label {
  display: grid;
  gap: 7px;
  color: #405168;
  font-size: 13px;
  font-weight: 650;
}
.partner-edit-section input,
.partner-edit-section textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #ccd7e5;
  border-radius: 10px;
  background: #fff;
  padding: 10px 12px;
  color: #17385e;
  font: inherit;
}
.partner-edit-section input[readonly] {
  background: #f1f5f9;
  color: #627186;
}
.partner-edit-section small {
  color: #758398;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
}
.partner-edit-tip {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.65;
}
.partner-edit-tip {
  background: #eef4fa;
  color: #50657c;
}
.partner-edit-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 18px 30px;
  border-top: 1px solid #e1e8f0;
  background: #fff;
}
.partner-settings-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
  gap: 18px;
}
.settings-form {
  display: grid;
  gap: 15px;
}
.field-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.input-unit {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 8px;
}
.switch-row {
  grid-template-columns: auto 1fr !important;
  align-items: center;
}
.switch-row input {
  width: auto;
}
.settings-note,
.pending-review {
  margin: 0;
  padding: 12px;
  border-radius: 10px;
  background: #f4f7fb;
  color: #5e6e82;
  font-size: 13px;
  line-height: 1.65;
}
.pending-review {
  background: #fff7e8;
  color: #8a5a0a;
}
.data-table code {
  font-size: 12px;
  color: #47627f;
}
@media (max-width: 1100px) {
  .partner-metrics {
    grid-template-columns: repeat(2, 1fr);
  }
  .partner-settings-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 680px) {
  .partner-metrics,
  .field-pair,
  .quick-enable-form {
    grid-template-columns: 1fr;
  }
  .quick-enable-locked {
    align-items: flex-start;
    flex-direction: column;
  }
  .quick-enable-actions {
    width: 100%;
    flex-direction: column;
  }
  .quick-enable-actions .button {
    width: 100%;
  }
  .quick-enable-locked .quick-enable-permission-note {
    max-width: none;
    text-align: left;
  }
  .partner-panel {
    padding: 16px;
  }
  .partner-directory-wrap {
    overflow: visible;
  }
  .partner-directory-table,
  .partner-directory-table tbody {
    display: block;
    width: 100%;
    min-width: 0;
  }
  .partner-directory-table thead {
    display: none;
  }
  .partner-directory-table tbody tr {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px 18px;
    padding: 16px 0;
    border-bottom: 1px solid #e1e7ef;
  }
  .partner-directory-table tbody tr:last-child {
    border-bottom: 0;
  }
  .partner-directory-table td {
    display: block;
    min-width: 0;
    padding: 0;
    border: 0;
  }
  .partner-directory-table td::before {
    display: block;
    margin-bottom: 5px;
    color: #8793a2;
    content: attr(data-label);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.08em;
  }
  .partner-directory-table td:first-child,
  .partner-directory-table td:last-child,
  .partner-directory-table td.admin-empty {
    grid-column: 1 / -1;
  }
  .partner-directory-table td:first-child {
    padding-bottom: 12px;
    border-bottom: 1px solid #eef2f7;
  }
  .partner-directory-table td:last-child {
    padding-top: 2px;
  }
  .partner-directory-table td.admin-empty {
    padding: 24px 0;
    border-bottom: 0;
  }
  .partner-directory-table td.admin-empty::before {
    content: none;
  }
  .partner-directory-table .row-actions button {
    min-height: 38px;
    padding-inline: 13px;
  }
  .panel-heading {
    display: block;
  }
  .panel-heading.program-heading {
    display: flex;
    flex-direction: column;
  }
  .program-state-actions {
    justify-content: flex-start;
  }
  .partner-tabs {
    margin-inline: -4px;
  }
  .partner-edit-head {
    padding: 20px 18px 16px;
  }
  .partner-edit-head h2 {
    font-size: 24px;
  }
  .partner-edit-body {
    padding: 16px 18px 24px;
  }
  .partner-edit-section {
    padding: 16px;
  }
  .partner-form-feedback,
  .partner-editor-notice {
    margin: 12px 18px 0;
  }
  .partner-edit-footer {
    padding: 14px 18px calc(14px + env(safe-area-inset-bottom));
  }
}
.file-action {
  border: 1px solid #c9d6e5;
  border-radius: 8px;
  background: #fff;
  padding: 6px 9px;
  color: #21466f;
  cursor: pointer;
}
.file-action input {
  display: none;
}
.adjustment-form {
  display: grid;
  grid-template-columns: minmax(230px, 1.5fr) repeat(4, minmax(130px, 1fr)) auto;
  align-items: end;
  gap: 14px;
}
.adjustment-form h2,
.reconciliation-form h2 {
  margin: 3px 0 5px;
  color: #102e52;
}
.adjustment-form p,
.reconciliation-form p {
  margin: 0;
  color: #69788a;
}
.adjustment-form label,
.reconciliation-form label {
  display: grid;
  gap: 7px;
  color: #405168;
  font-size: 13px;
  font-weight: 650;
}
.adjustment-form input,
.adjustment-form select,
.reconciliation-form input,
.reconciliation-form select,
.reconciliation-form textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #ccd7e5;
  border-radius: 10px;
  background: #fff;
  padding: 10px 12px;
  color: #17385e;
  font: inherit;
}
.reconciliation-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.reconciliation-form > div:first-child,
.reconciliation-form > label:last-of-type,
.reconciliation-form > button {
  grid-column: 1/-1;
}
.reconciliation-form > .field-pair {
  grid-column: 1/-1;
}
@media (max-width: 1100px) {
  .adjustment-form {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 680px) {
  .adjustment-form,
  .reconciliation-form {
    grid-template-columns: 1fr;
  }
  .reconciliation-form > div:first-child,
  .reconciliation-form > label:last-of-type,
  .reconciliation-form > button,
  .reconciliation-form > .field-pair {
    grid-column: auto;
  }
}
</style>
