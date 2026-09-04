<script setup lang="ts">
import type {
  AttendeeNeedsProfile,
  CustomerAttendeeServiceHub,
  CustomerInvoiceCenterCounts,
  CustomerInvoiceCenterItem,
  CustomerPurchasedOrder,
  CustomerRegistrationSummary,
  CustomerServiceHubItem,
  EventPurchaseContext,
} from '@conference/contracts';
import { publicEventHomePath } from '@conference/contracts';
import { nextTick, watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  canRestartSelfOrder,
  canResumePendingOrder,
  shouldRefreshPurchasedOrder,
} from '~/utils/purchase-journey';
import { resolveAttendeeNeedsAccountState } from '~/utils/attendee-needs';
import {
  selectFeaturedAccountContext,
  shouldRevealOrganizerContact,
  visibleServiceHubItems,
} from '~/utils/account-service-hub';
import { copyPlainText } from '~/utils/copy-text';
import AccountServiceHubIcon from '~/components/AccountServiceHubIcon.vue';

const customer = useCustomerSession();
const api = useConferenceApi();
const router = useRouter();
const route = useRoute();
const registrations = ref<CustomerRegistrationSummary[]>([]);
const purchasedOrders = ref<CustomerPurchasedOrder[]>([]);
const purchaseContexts = ref<Record<number, EventPurchaseContext>>({});
const purchaseContextErrors = ref<Record<number, boolean>>({});
const attendeeNeedsProfiles = ref<Record<string, AttendeeNeedsProfile>>({});
const attendeeNeedsProfileErrors = ref<Record<string, boolean>>({});
const attendeeNeedsProfilePending = ref<Record<string, boolean>>({});
const serviceHubs = ref<Record<string, CustomerAttendeeServiceHub>>({});
const serviceHubPending = ref(false);
const serviceHubError = ref(false);
const organizerPanelOpen = ref(false);
const organizerConfirmationPending = ref(false);
const organizerCopyStatus = ref('');
const latestServiceHubRequestByRegistration = new Map<string, number>();
let serviceHubRequestSequence = 0;
const invoiceHighlights = ref<CustomerInvoiceCenterItem[]>([]);
const invoiceCounts = ref<CustomerInvoiceCenterCounts>({
  all: 0,
  eligible: 0,
  actionRequired: 0,
  processing: 0,
  issued: 0,
  history: 0,
});
const loading = ref(true);
const loadingMore = ref(false);
const saving = ref(false);
const nextCursor = ref<string | null>(null);
const nextOrdersCursor = ref<string | null>(null);
const editingOrderId = ref('');
const attendeeSaving = ref(false);
const resumingOrderId = ref('');
const refreshingPurchaseContexts = ref(false);
const attendeeEdit = reactive({ name: '', mobile: '' });
const errorMessage = ref('');
const successMessage = ref('');
const emailError = ref('');
const profile = reactive({
  nickname: '',
  realName: '',
  email: '',
  company: '',
  title: '',
  city: '',
});

const displayName = computed(
  () =>
    customer.session.value?.customer.profile.nickname ||
    customer.session.value?.customer.profile.realName ||
    customer.session.value?.customer.maskedMobile ||
    '参会者',
);
const accountInitial = computed(() => displayName.value.trim().slice(0, 1).toUpperCase());
const profileCompletion = computed(() => {
  const values = Object.values(profile);
  return Math.round((values.filter((value) => value.trim()).length / values.length) * 100);
});
const validTicketCount = computed(
  () => registrations.value.filter((item) => item.ticketStatus === 'valid').length,
);
const pendingActionCount = computed(
  () =>
    registrations.value.filter((item) =>
      ['pending_review', 'pending_payment'].includes(item.registrationStatus),
    ).length +
    purchasedOrders.value.filter((item) =>
      ['pending_review', 'pending_payment', 'processing'].includes(item.status),
    ).length +
    invoiceCounts.value.actionRequired,
);
const featuredAccountContext = computed(() =>
  selectFeaturedAccountContext(
    registrations.value,
    purchasedOrders.value,
    typeof route.query.event === 'string' ? route.query.event : null,
    {
      requestedRegistrationId:
        typeof route.query.registration === 'string' ? route.query.registration : null,
    },
  ),
);
const featuredRegistration = computed(() => featuredAccountContext.value.registration);
const featuredOrder = computed(() => featuredAccountContext.value.order);
const featuredServiceHub = computed(() =>
  featuredRegistration.value ? serviceHubs.value[featuredRegistration.value.id] : undefined,
);
const publicHomepageHref = computed(() => {
  const slug = featuredRegistration.value?.eventSlug ?? featuredOrder.value?.eventSlug;
  return slug ? publicEventHomePath(slug) : '/';
});
const eventSwitcherOptions = computed(() => {
  return [
    ...new Map(
      [...registrations.value, ...purchasedOrders.value].map((item) => [
        item.eventSlug,
        { slug: item.eventSlug, name: item.eventName },
      ]),
    ).values(),
  ];
});
const registrationCountLabel = computed(
  () => `${registrations.value.length}${nextCursor.value ? '+' : ''}`,
);

const statusLabels: Record<string, string> = {
  draft: '草稿',
  pending_review: '待审核',
  pending_payment: '待支付',
  confirmed: '已确认',
  cancelled: '已取消',
  checked_in: '已签到',
  completed: '已完成',
  processing: '处理中',
  paid: '已支付',
  partially_refunded: '部分退款',
  refunded: '已退款',
  closed: '已关闭',
  valid: '可使用',
  used: '已使用',
  awaiting_details: '待补充资料',
  issuing: '开具中',
  issue_failed: '开具失败',
  issued: '已开具',
  rejected: '已驳回',
  adjustment_required: '待调整',
  voided: '已作废',
};
const statusLabel = (value: string) => statusLabels[value] ?? value;
const serviceStateLabels: Record<CustomerServiceHubItem['state'], string> = {
  complete: '已完成',
  available: '可使用',
  pending: '待完善',
  attention: '需处理',
  unavailable: '未开放',
};
const accountSections = [
  { id: 'overview', index: '01', label: '大会服务台' },
  { id: 'events', index: '02', label: '我的参会名额' },
  { id: 'purchases', index: '03', label: '我购买的订单' },
  { id: 'showcases', index: '04', label: '参会资料' },
  { id: 'invoices', index: '05', label: '发票中心' },
  { id: 'profile', index: '06', label: '常用资料' },
  { id: 'security', index: '07', label: '账户安全' },
] as const;
const mobileNavigationOpen = ref(false);
const mobileNavigationRoot = ref<HTMLElement | null>(null);
const mobileNavigationTrigger = ref<HTMLButtonElement | null>(null);
const activeAccountSection = ref<(typeof accountSections)[number]['id']>('overview');
const activeAccountSectionLabel = computed(
  () =>
    accountSections.find((section) => section.id === activeAccountSection.value)?.label ??
    '大会服务台',
);

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
  }).format(amount / 100);

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));

const formatMonth = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', { month: 'short' }).format(new Date(value));

const formatDay = (value: string) => String(new Date(value).getDate()).padStart(2, '0');

const formatDateTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '暂无记录';

const primaryRegistrationAction = (
  item: CustomerRegistrationSummary,
  latestPaymentStatus: CustomerAttendeeServiceHub['latestPaymentStatus'] = null,
) => {
  if (item.ticketCode && item.ticketStatus === 'valid') {
    return {
      label: '打开电子票',
      to: `/ticket/${encodeURIComponent(item.ticketCode)}?event=${encodeURIComponent(item.eventSlug)}`,
    };
  }
  if (item.registrationStatus === 'pending_payment') {
    if (['preparing', 'processing', 'query_pending'].includes(latestPaymentStatus ?? '')) {
      return { label: '查看支付进度', to: `/account/registrations/${item.id}` };
    }
    if (latestPaymentStatus === 'failed' || latestPaymentStatus === 'closed') {
      return { label: '重新支付', to: `/account/registrations/${item.id}` };
    }
    return { label: '继续支付', to: `/account/registrations/${item.id}` };
  }
  if (item.registrationStatus === 'pending_review') {
    return { label: '查看审核进度', to: `/account/registrations/${item.id}` };
  }
  return { label: '查看报名', to: `/account/registrations/${item.id}` };
};

const serviceHubNames: Record<CustomerServiceHubItem['code'], string> = {
  ticket: '门票信息',
  poster: '个人海报',
  showcase: '大会首页名片',
  needs: '参会需求',
  organizer_contact: '添加大会组织者',
  invoice: '发票服务',
};
const fallbackServiceHubItems = computed<CustomerServiceHubItem[]>(() => {
  const item = featuredRegistration.value;
  if (!item) return [];
  return [
    {
      code: 'ticket',
      state:
        item.ticketStatus === 'valid' || item.ticketStatus === 'used'
          ? 'complete'
          : item.registrationStatus === 'pending_payment'
            ? 'attention'
            : 'available',
      label: item.ticketStatus
        ? statusLabel(item.ticketStatus)
        : statusLabel(item.registrationStatus),
      description: '进入报名详情查看票券与处理进度',
    },
    {
      code: 'poster',
      state:
        item.ticketStatus === 'valid' || item.ticketStatus === 'used' ? 'available' : 'unavailable',
      label:
        item.ticketStatus === 'valid' || item.ticketStatus === 'used'
          ? '可以生成海报'
          : '取得电子票后开放',
      description: '海报资料与参会名片共用',
    },
    {
      code: 'showcase',
      state: 'available',
      label: '进入参会名片',
      description: '可维护首页展示资料与公开范围',
    },
    {
      code: 'needs',
      state: attendeeNeedsState(item.id).canEdit ? 'available' : 'unavailable',
      label: attendeeNeedsStatus(item.id),
      description: '提交希望大会回应的问题',
    },
    {
      code: 'organizer_contact',
      state: 'unavailable',
      label: '状态读取失败',
      description: '请重试后查看组织者联系方式',
    },
    {
      code: 'invoice',
      state: item.canManageOrder ? 'available' : 'unavailable',
      label: item.canManageOrder ? '进入发票服务' : '由购票人管理',
      description: '发票资料仅向订单购买人开放',
    },
  ];
});
const serviceHubItems = computed(() =>
  visibleServiceHubItems(
    featuredServiceHub.value?.items ?? fallbackServiceHubItems.value,
    Boolean(featuredRegistration.value?.canManageOrder),
  ),
);
const featuredTicketServiceItem = computed(() =>
  serviceHubItems.value.find((item) => item.code === 'ticket'),
);
const organizerServiceItem = computed(() =>
  serviceHubItems.value.find((item) => item.code === 'organizer_contact'),
);
const organizerContactAvailable = computed(
  () =>
    Boolean(featuredServiceHub.value?.organizerContact.enabled) &&
    Boolean(featuredServiceHub.value?.organizerContact.eligible),
);
const serviceActionCount = computed(
  () =>
    featuredServiceHub.value?.actionRequiredCount ??
    serviceHubItems.value.filter(
      (item) =>
        !['poster', 'invoice'].includes(item.code) && ['pending', 'attention'].includes(item.state),
    ).length,
);

function serviceHubActionLabel(item: CustomerServiceHubItem) {
  if (item.code === 'ticket')
    return primaryRegistrationAction(
      featuredRegistration.value!,
      featuredServiceHub.value?.latestPaymentStatus,
    ).label;
  if (item.code === 'poster') return '生成个人海报';
  if (item.code === 'showcase') return '编辑首页信息';
  if (item.code === 'needs')
    return item.state === 'unavailable' ? '查看开放状态' : '提交或编辑需求';
  if (item.code === 'organizer_contact')
    return item.state === 'unavailable' ? '暂不可查看' : '查看入群方式';
  return featuredRegistration.value?.canManageOrder ? '进入发票服务' : '由购票人管理';
}

function serviceHubActionDisabled(item: CustomerServiceHubItem) {
  return (
    (item.code === 'organizer_contact' && item.state === 'unavailable') ||
    (item.code === 'invoice' && !featuredRegistration.value?.canManageOrder)
  );
}

async function openServiceHubItem(item: CustomerServiceHubItem) {
  const registration = featuredRegistration.value;
  if (!registration || serviceHubActionDisabled(item)) return;
  if (item.code === 'organizer_contact') {
    await revealOrganizerPanel();
    return;
  }
  const routes: Record<Exclude<CustomerServiceHubItem['code'], 'organizer_contact'>, string> = {
    ticket: primaryRegistrationAction(registration, featuredServiceHub.value?.latestPaymentStatus)
      .to,
    poster: `/account/registrations/${registration.id}/showcase?event=${encodeURIComponent(registration.eventSlug)}#showcase-poster`,
    showcase: `/account/registrations/${registration.id}/showcase?event=${encodeURIComponent(registration.eventSlug)}#showcase-profile-editor`,
    needs: `/account/registrations/${registration.id}/needs?event=${encodeURIComponent(registration.eventSlug)}`,
    invoice: `/account/invoices/${registration.orderId}`,
  };
  await router.push(routes[item.code]);
}

async function revealOrganizerPanel() {
  organizerPanelOpen.value = true;
  await nextTick();
  const panel = document.querySelector<HTMLElement>('#organizer-contact-panel');
  panel?.scrollIntoView({ block: 'center' });
  panel?.focus({ preventScroll: true });
}

function selectEvent(event: Event) {
  const eventSlug = (event.target as HTMLSelectElement).value;
  organizerPanelOpen.value = false;
  const query = { ...route.query };
  delete query.registration;
  delete query.service;
  void router.replace({ query: { ...query, event: eventSlug }, hash: '' });
}

function selectAccountSection(sectionId: (typeof accountSections)[number]['id']) {
  activeAccountSection.value = sectionId;
  mobileNavigationOpen.value = false;
}

async function selectMobileAccountSection(sectionId: (typeof accountSections)[number]['id']) {
  selectAccountSection(sectionId);
  mobileNavigationTrigger.value?.focus({ preventScroll: true });
  await router.push({ query: route.query, hash: `#${sectionId}` });
  await nextTick();
  mobileNavigationTrigger.value?.focus({ preventScroll: true });
}

async function closeMobileNavigationFromKeyboard() {
  mobileNavigationOpen.value = false;
  await nextTick();
  mobileNavigationTrigger.value?.focus({ preventScroll: true });
}

function closeMobileNavigationFromOutside(event: PointerEvent) {
  const target = event.target;
  if (
    mobileNavigationOpen.value &&
    target instanceof Node &&
    !mobileNavigationRoot.value?.contains(target)
  ) {
    mobileNavigationOpen.value = false;
  }
}

async function loadServiceHub(registrationId: string) {
  const requestSequence = ++serviceHubRequestSequence;
  latestServiceHubRequestByRegistration.set(registrationId, requestSequence);
  serviceHubPending.value = true;
  serviceHubError.value = false;
  try {
    const result = await customer.attendeeServiceHub(registrationId);
    if (latestServiceHubRequestByRegistration.get(registrationId) !== requestSequence) return;
    serviceHubs.value = { ...serviceHubs.value, [registrationId]: result };
    if (
      shouldRevealOrganizerContact(route.query.service, route.query.registration, registrationId)
    ) {
      await revealOrganizerPanel();
    }
  } catch {
    if (requestSequence === serviceHubRequestSequence) serviceHubError.value = true;
  } finally {
    if (requestSequence === serviceHubRequestSequence) serviceHubPending.value = false;
  }
}

async function setOrganizerConfirmed(confirmed: boolean) {
  const registration = featuredRegistration.value;
  if (!registration) return;
  organizerConfirmationPending.value = true;
  errorMessage.value = '';
  try {
    await customer.setOrganizerContactConfirmed(registration.id, confirmed);
    await loadServiceHub(registration.id);
    successMessage.value = confirmed ? '已确认添加，等待大会组织者邀请入群' : '已恢复为待添加状态';
  } catch (error) {
    const value = error as { data?: { message?: string } };
    errorMessage.value = value.data?.message ?? '组织者添加状态更新失败';
  } finally {
    organizerConfirmationPending.value = false;
  }
}

let organizerCopyStatusTimer: ReturnType<typeof setTimeout> | undefined;
async function copyOrganizerWechatId() {
  const wechatId = featuredServiceHub.value?.organizerContact.wechatId;
  if (!wechatId) return;
  const copied = await copyPlainText(wechatId);
  organizerCopyStatus.value = copied ? '微信号已复制' : '复制失败，请长按微信号复制';
  if (organizerCopyStatusTimer) clearTimeout(organizerCopyStatusTimer);
  organizerCopyStatusTimer = setTimeout(() => {
    organizerCopyStatus.value = '';
  }, 3000);
}

function startAttendeeEdit(order: CustomerPurchasedOrder) {
  editingOrderId.value = order.id;
  attendeeEdit.name = order.attendeeName;
  attendeeEdit.mobile = order.attendeeMobile;
}

async function saveAttendee(order: CustomerPurchasedOrder) {
  attendeeSaving.value = true;
  errorMessage.value = '';
  try {
    const updated = await customer.updatePurchasedOrderAttendee(order.id, {
      name: attendeeEdit.name,
      mobile: attendeeEdit.mobile,
    });
    purchasedOrders.value = purchasedOrders.value.map((item) =>
      item.id === updated.id ? updated : item,
    );
    editingOrderId.value = '';
    successMessage.value = '参会人资料已更新，新的认领邀请已发送';
  } catch (error) {
    const value = error as { data?: { message?: string } };
    errorMessage.value = value.data?.message ?? '参会人资料更新失败，请稍后重试';
  } finally {
    attendeeSaving.value = false;
  }
}

async function resumeOrder(order: CustomerPurchasedOrder) {
  resumingOrderId.value = order.id;
  errorMessage.value = '';
  try {
    const access = await customer.createOrderPaymentAccess(order.id);
    window.location.assign(
      api.resolvePaymentCheckoutUrl(order.id, order.eventSlug, access.orderAccessToken),
    );
  } catch (error) {
    await refreshOrderPurchaseState(order);
    const value = error as { data?: { message?: string } };
    errorMessage.value = value.data?.message ?? '支付入口恢复失败，请稍后重试。';
  } finally {
    resumingOrderId.value = '';
  }
}

function mergePurchasedOrder(order: CustomerPurchasedOrder | undefined) {
  if (!order) return;
  purchasedOrders.value = purchasedOrders.value.map((item) =>
    item.id === order.id ? order : item,
  );
}

async function refreshOrderPurchaseState(order: CustomerPurchasedOrder) {
  refreshingPurchaseContexts.value = true;
  try {
    const [orderResult, contextResult] = await Promise.all([
      customer.purchasedOrders(undefined, 1, order.id).catch(() => null),
      customer.purchaseContext(order.eventId).catch(() => null),
    ]);
    mergePurchasedOrder(orderResult?.items[0]);
    purchaseContextErrors.value = {
      ...purchaseContextErrors.value,
      [order.eventId]: !contextResult,
    };
    if (contextResult) {
      purchaseContexts.value = {
        ...purchaseContexts.value,
        [contextResult.eventId]: contextResult,
      };
    }
  } finally {
    refreshingPurchaseContexts.value = false;
  }
}

async function refreshPurchaseContexts(eventIds: number[]) {
  if (!eventIds.length || refreshingPurchaseContexts.value) return;
  refreshingPurchaseContexts.value = true;
  try {
    const loadedContexts = await Promise.all(
      eventIds.map(async (eventId) => {
        try {
          return { eventId, context: await customer.purchaseContext(eventId) };
        } catch {
          return { eventId, context: null };
        }
      }),
    );
    purchaseContextErrors.value = {
      ...purchaseContextErrors.value,
      ...Object.fromEntries(loadedContexts.map(({ eventId, context }) => [eventId, !context])),
    };
    purchaseContexts.value = {
      ...purchaseContexts.value,
      ...Object.fromEntries(
        loadedContexts
          .map(({ context }) => context)
          .filter((context): context is EventPurchaseContext => Boolean(context))
          .map((context) => [context.eventId, context]),
      ),
    };
  } finally {
    refreshingPurchaseContexts.value = false;
  }
}

async function retryPurchaseContext(order: CustomerPurchasedOrder) {
  errorMessage.value = '';
  await refreshOrderPurchaseState(order);
  if (purchaseContextErrors.value[order.eventId]) {
    errorMessage.value = '报名状态刷新失败，请稍后重试。';
  }
}

async function refreshMutablePurchasedOrders() {
  const targets = purchasedOrders.value.filter((order) =>
    shouldRefreshPurchasedOrder(order, purchaseContexts.value[order.eventId]),
  );
  const results = await Promise.all(
    targets.map((order) =>
      customer
        .purchasedOrders(undefined, 1, order.id)
        .then((result) => result.items[0])
        .catch(() => undefined),
    ),
  );
  const refreshedById = new Map(
    results
      .filter((order): order is CustomerPurchasedOrder => Boolean(order))
      .map((order) => [order.id, order]),
  );
  if (refreshedById.size) {
    purchasedOrders.value = purchasedOrders.value.map(
      (order) => refreshedById.get(order.id) ?? order,
    );
  }
}

async function refreshVisiblePurchaseState() {
  await refreshPurchaseContexts([...new Set(purchasedOrders.value.map((item) => item.eventId))]);
  await refreshMutablePurchasedOrders();
}

function additionalPurchase(order: CustomerPurchasedOrder) {
  return router.push({
    path: '/register',
    query: {
      event: order.eventSlug,
      purchaseFor: 'other',
      restart: '1',
    },
  });
}

function restartClosedSelfOrder(order: CustomerPurchasedOrder) {
  return router.push({
    path: '/register',
    query: {
      event: order.eventSlug,
      purchaseFor: 'self',
      restart: '1',
    },
  });
}

function validateEmail() {
  const value = profile.email.trim();
  emailError.value =
    value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? '请输入有效的邮箱地址' : '';
  return !emailError.value;
}

function syncProfile() {
  const value = customer.session.value?.customer.profile;
  if (!value) return;
  profile.nickname = value.nickname ?? '';
  profile.realName = value.realName ?? '';
  profile.email = value.email ?? '';
  profile.company = value.company ?? '';
  profile.title = value.title ?? '';
  profile.city = value.city ?? '';
}

async function loadRegistrations(append = false) {
  if (append) loadingMore.value = true;
  else nextCursor.value = null;
  try {
    const result = await customer.registrations(
      append ? (nextCursor.value ?? undefined) : undefined,
    );
    registrations.value = append
      ? [
          ...new Map(
            [...registrations.value, ...result.items].map((item) => [item.id, item]),
          ).values(),
        ]
      : result.items;
    nextCursor.value = result.nextCursor;
    const missing = registrations.value.filter(
      (item) => attendeeNeedsProfiles.value[item.id] === undefined,
    );
    void Promise.all(missing.map((item) => loadAttendeeNeedsProfile(item.id)));
  } finally {
    loadingMore.value = false;
  }
}

async function loadRequestedRegistration() {
  const registrationId =
    typeof route.query.registration === 'string' ? route.query.registration : '';
  if (!registrationId || registrations.value.some((item) => item.id === registrationId)) return;
  try {
    const detail = await customer.registration(registrationId);
    const { attendee, ...summary } = detail;
    void attendee;
    registrations.value = [summary, ...registrations.value];
    void loadAttendeeNeedsProfile(summary.id);
  } catch {
    // A stale or inaccessible deep link falls back to the normal account priority.
  }
}

async function loadAttendeeNeedsProfile(registrationId: string) {
  if (attendeeNeedsProfilePending.value[registrationId]) return;
  attendeeNeedsProfilePending.value = {
    ...attendeeNeedsProfilePending.value,
    [registrationId]: true,
  };
  try {
    const profile = await customer.attendeeNeeds(registrationId);
    attendeeNeedsProfiles.value = { ...attendeeNeedsProfiles.value, [registrationId]: profile };
    const nextErrors = { ...attendeeNeedsProfileErrors.value };
    delete nextErrors[registrationId];
    attendeeNeedsProfileErrors.value = nextErrors;
  } catch {
    attendeeNeedsProfileErrors.value = {
      ...attendeeNeedsProfileErrors.value,
      [registrationId]: true,
    };
  } finally {
    const nextPending = { ...attendeeNeedsProfilePending.value };
    delete nextPending[registrationId];
    attendeeNeedsProfilePending.value = nextPending;
  }
}

function attendeeNeedsState(registrationId: string) {
  return resolveAttendeeNeedsAccountState(
    attendeeNeedsProfiles.value[registrationId],
    Boolean(attendeeNeedsProfileErrors.value[registrationId]),
  );
}

function attendeeNeedsStatus(registrationId: string) {
  return attendeeNeedsState(registrationId).label;
}

function hasAttendeeNeedsEntry(registrationId: string) {
  return attendeeNeedsState(registrationId).canEdit;
}

function hasAttendeeMaterials(item: CustomerRegistrationSummary) {
  return (
    ['confirmed', 'checked_in', 'completed'].includes(item.registrationStatus) ||
    attendeeNeedsState(item.id).hasMaterial
  );
}

async function loadPurchasedOrders(append = false) {
  const result = await customer.purchasedOrders(
    append ? (nextOrdersCursor.value ?? undefined) : undefined,
  );
  purchasedOrders.value = append ? [...purchasedOrders.value, ...result.items] : result.items;
  nextOrdersCursor.value = result.nextCursor;
  await refreshPurchaseContexts([...new Set(result.items.map((item) => item.eventId))]);
}

async function loadInvoiceSummary() {
  const result = await customer.invoices('all', undefined, 3);
  invoiceHighlights.value = result.items;
  invoiceCounts.value = result.counts;
}

async function initialize() {
  loading.value = true;
  errorMessage.value = '';
  try {
    await customer.refresh();
    if (customer.session.value) {
      syncProfile();
      await Promise.all([loadRegistrations(), loadPurchasedOrders(), loadInvoiceSummary()]);
      await loadRequestedRegistration();
    }
  } catch {
    errorMessage.value = '个人中心暂时无法加载，请稍后重试';
  } finally {
    loading.value = false;
  }
}

async function saveProfile() {
  const current = customer.session.value;
  if (!current) return;
  if (!validateEmail()) return;
  saving.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    await customer.updateProfile({
      version: current.customer.profile.version,
      nickname: profile.nickname.trim() || null,
      realName: profile.realName.trim() || null,
      email: profile.email.trim() || null,
      company: profile.company.trim() || null,
      title: profile.title.trim() || null,
      city: profile.city.trim() || null,
    });
    syncProfile();
    successMessage.value = '常用资料已保存';
  } catch (error) {
    const value = error as { data?: { message?: string } };
    errorMessage.value = value.data?.message ?? '资料保存失败，请刷新后重试';
  } finally {
    saving.value = false;
  }
}

async function logout() {
  await customer.logout();
  registrations.value = [];
  purchasedOrders.value = [];
  purchaseContexts.value = {};
  purchaseContextErrors.value = {};
  invoiceHighlights.value = [];
  invoiceCounts.value = {
    all: 0,
    eligible: 0,
    actionRequired: 0,
    processing: 0,
    issued: 0,
    history: 0,
  };
  nextCursor.value = null;
  nextOrdersCursor.value = null;
  serviceHubs.value = {};
  organizerPanelOpen.value = false;
  mobileNavigationOpen.value = false;
  activeAccountSection.value = 'overview';
}

let purchaseContextRefreshTimer: ReturnType<typeof setInterval> | undefined;
let accountSectionObserver: IntersectionObserver | undefined;

async function observeAccountSections() {
  accountSectionObserver?.disconnect();
  if (!customer.session.value || loading.value) return;
  await nextTick();
  const sectionElements = accountSections
    .map((section) => document.getElementById(section.id))
    .filter((element): element is HTMLElement => Boolean(element));
  accountSectionObserver = new IntersectionObserver(
    (entries) => {
      const visibleEntry = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visibleEntry) {
        activeAccountSection.value = visibleEntry.target
          .id as (typeof accountSections)[number]['id'];
      }
    },
    { rootMargin: '-18% 0px -68% 0px', threshold: [0, 0.1, 0.4] },
  );
  sectionElements.forEach((section) => accountSectionObserver?.observe(section));
}

onMounted(() => {
  void initialize();
  document.addEventListener('pointerdown', closeMobileNavigationFromOutside);
  purchaseContextRefreshTimer = setInterval(() => {
    if (customer.session.value) void refreshVisiblePurchaseState();
  }, 30_000);
});
onBeforeUnmount(() => {
  if (purchaseContextRefreshTimer) clearInterval(purchaseContextRefreshTimer);
  if (organizerCopyStatusTimer) clearTimeout(organizerCopyStatusTimer);
  accountSectionObserver?.disconnect();
  document.removeEventListener('pointerdown', closeMobileNavigationFromOutside);
});
watch(
  () => [loading.value, customer.session.value?.customer.id] as const,
  () => void observeAccountSections(),
);
watch(
  () => customer.session.value?.customer.id,
  (id, previous) => {
    if (id && id !== previous && !loading.value) void initialize();
  },
);
watch(
  () => featuredRegistration.value?.id,
  (registrationId, previousId) => {
    if (!registrationId) return;
    const selected = featuredRegistration.value!;
    if (registrationId !== previousId) organizerPanelOpen.value = false;
    if (route.query.event !== selected.eventSlug) {
      void router.replace({ query: { ...route.query, event: selected.eventSlug } });
    }
    void loadServiceHub(registrationId);
  },
);
watch(
  () => (!featuredRegistration.value ? featuredOrder.value?.eventSlug : undefined),
  (eventSlug) => {
    if (eventSlug && route.query.event !== eventSlug) {
      void router.replace({ query: { ...route.query, event: eventSlug } });
    }
  },
);
useHead({ title: '个人中心' });
</script>

<template>
  <div class="flow-page account-page">
    <FlowHeader />
    <main id="main-content" class="account-shell">
      <template v-if="loading">
        <div class="account-loading" role="status">
          <span aria-hidden="true"></span>
          <p>正在整理你的参会信息</p>
        </div>
      </template>

      <section v-else-if="!customer.session.value" class="account-login">
        <div class="account-login__copy">
          <p class="flow-eyebrow">ATTENDEE ACCOUNT</p>
          <h1>你的大会信息，集中在一个入口</h1>
          <p>登录后查看报名进度、电子票、订单与发票，也可以维护常用参会资料。</p>
          <button class="account-primary" type="button" @click="customer.openLogin">
            登录个人中心
            <span aria-hidden="true">→</span>
          </button>
        </div>
        <div class="account-login__preview" aria-hidden="true">
          <span>TOKEMS CONFERENCE</span>
          <strong>ATTENDEE<br />PASS</strong>
          <i>01</i>
        </div>
      </section>

      <template v-else>
        <header class="account-heading">
          <div>
            <p class="flow-eyebrow">ATTENDEE ACCOUNT</p>
            <h1>个人中心</h1>
            <p>{{ displayName }}，这里汇总了你的参会凭证与账户资料。</p>
          </div>
          <a class="account-back-link" :href="publicHomepageHref">
            大会官网
            <span aria-hidden="true">↗</span>
          </a>
        </header>

        <p v-if="errorMessage" class="account-message is-error" role="alert">
          {{ errorMessage }}
        </p>
        <p v-if="successMessage" class="account-message is-success" role="status">
          {{ successMessage }}
        </p>

        <div class="account-workspace">
          <aside class="account-rail" aria-label="账户导航">
            <div class="account-rail__identity">
              <div class="account-avatar" aria-hidden="true">{{ accountInitial }}</div>
              <div>
                <strong>{{ displayName }}</strong>
                <span><i></i> 手机已验证</span>
              </div>
            </div>
            <p class="account-rail__mobile">
              {{ customer.session.value.customer.maskedMobile }}
            </p>
            <nav class="account-nav account-nav--desktop" aria-label="个人中心模块">
              <a
                v-for="section in accountSections"
                :key="section.id"
                :href="`#${section.id}`"
                @click="selectAccountSection(section.id)"
              >
                <span>{{ section.index }}</span> {{ section.label }}
              </a>
            </nav>
            <div class="account-rail__completion">
              <div>
                <span>资料完整度</span>
                <strong>{{ profileCompletion }}%</strong>
              </div>
              <div class="account-progress" aria-hidden="true">
                <i :style="{ width: `${profileCompletion}%` }"></i>
              </div>
              <p>
                {{
                  profileCompletion === 100
                    ? '资料完整，报名时可直接使用'
                    : '完善资料，下次报名填写更快'
                }}
              </p>
            </div>
            <div class="account-rail__footer">
              <span>最近登录</span>
              <strong>{{ formatDateTime(customer.session.value.customer.lastLoginAt) }}</strong>
              <button type="button" @click="logout">退出登录</button>
            </div>
            <div
              ref="mobileNavigationRoot"
              class="account-mobile-navigation"
              @keydown.esc.prevent.stop="closeMobileNavigationFromKeyboard"
            >
              <button
                ref="mobileNavigationTrigger"
                class="account-mobile-navigation__trigger"
                type="button"
                aria-controls="account-mobile-navigation-panel"
                :aria-expanded="mobileNavigationOpen"
                @click="mobileNavigationOpen = !mobileNavigationOpen"
              >
                <span>页面导航</span>
                <strong>{{ activeAccountSectionLabel }}</strong>
                <i aria-hidden="true">{{ mobileNavigationOpen ? '−' : '＋' }}</i>
              </button>
              <div
                v-show="mobileNavigationOpen"
                id="account-mobile-navigation-panel"
                class="account-mobile-navigation__panel"
              >
                <nav class="account-mobile-navigation__links" aria-label="个人中心移动端模块">
                  <a
                    v-for="section in accountSections"
                    :key="section.id"
                    :href="`#${section.id}`"
                    :aria-current="activeAccountSection === section.id ? 'location' : undefined"
                    @click.prevent="selectMobileAccountSection(section.id)"
                  >
                    <span>{{ section.index }}</span>
                    {{ section.label }}
                  </a>
                </nav>
                <div class="account-mobile-navigation__meta">
                  <span>{{ customer.session.value.customer.maskedMobile }}</span>
                  <strong>资料完整度 {{ profileCompletion }}%</strong>
                  <button type="button" @click="logout">退出登录</button>
                </div>
              </div>
            </div>
          </aside>

          <div class="account-content">
            <section
              id="overview"
              class="account-section account-overview"
              aria-labelledby="overview-title"
            >
              <div class="account-section__heading is-compact service-hub-heading">
                <div>
                  <span class="account-section__index">01 / EVENT SERVICE HUB</span>
                  <h2 id="overview-title">我的大会服务台</h2>
                </div>
                <div class="service-hub-heading__tools">
                  <label v-if="eventSwitcherOptions.length > 1">
                    <span>切换大会</span>
                    <select
                      :value="featuredRegistration?.eventSlug ?? featuredOrder?.eventSlug"
                      @change="selectEvent"
                    >
                      <option
                        v-for="eventOption in eventSwitcherOptions"
                        :key="eventOption.slug"
                        :value="eventOption.slug"
                      >
                        {{ eventOption.name }}
                      </option>
                    </select>
                  </label>
                  <p
                    :class="{ 'is-attention': featuredRegistration && serviceActionCount > 0 }"
                    role="status"
                    aria-live="polite"
                  >
                    <i aria-hidden="true"></i>
                    {{
                      featuredRegistration
                        ? serviceActionCount
                          ? `还有 ${serviceActionCount} 项可以完善`
                          : '大会服务已准备就绪'
                        : featuredOrder
                          ? '当前为订单服务台'
                          : '当前账户状态正常'
                    }}
                  </p>
                </div>
              </div>

              <article
                v-if="featuredRegistration"
                class="account-pass"
                :data-state="featuredTicketServiceItem?.state"
              >
                <div class="account-pass__main">
                  <div class="account-pass__topline">
                    <span>TOKEMS CONFERENCE · ATTENDEE PASS</span>
                    <span
                      class="account-pass__status"
                      :data-state="featuredTicketServiceItem?.state"
                    >
                      {{
                        featuredTicketServiceItem?.label ??
                          statusLabel(featuredRegistration.registrationStatus)
                      }}
                    </span>
                  </div>
                  <h3>{{ featuredRegistration.eventName }}</h3>
                  <p>
                    {{ formatDate(featuredRegistration.startsAt) }} 至
                    {{ formatDate(featuredRegistration.endsAt) }} ·
                    {{ featuredRegistration.ticketTypeName }}
                  </p>
                  <div class="account-pass__actions">
                    <NuxtLink
                      class="account-pass__primary"
                      :to="
                        primaryRegistrationAction(
                          featuredRegistration,
                          featuredServiceHub?.latestPaymentStatus,
                        ).to
                      "
                    >
                      {{
                        primaryRegistrationAction(
                          featuredRegistration,
                          featuredServiceHub?.latestPaymentStatus,
                        ).label
                      }}
                      <span aria-hidden="true">→</span>
                    </NuxtLink>
                    <NuxtLink :to="`/account/registrations/${featuredRegistration.id}`">
                      报名详情
                    </NuxtLink>
                  </div>
                </div>
                <div class="account-pass__stub">
                  <span>{{ formatMonth(featuredRegistration.startsAt) }}</span>
                  <strong>{{ formatDay(featuredRegistration.startsAt) }}</strong>
                  <small>{{ featuredRegistration.registrationCode }}</small>
                </div>
              </article>

              <div v-if="featuredRegistration" class="service-hub-body">
                <div v-if="serviceHubError" class="service-hub-read-error" role="status">
                  <span>部分状态读取失败，常用入口仍可使用。</span>
                  <button type="button" @click="loadServiceHub(featuredRegistration.id)">
                    重新读取
                  </button>
                </div>
                <div
                  class="service-hub-grid"
                  :aria-busy="serviceHubPending"
                  :data-count="serviceHubItems.length"
                >
                  <button
                    v-for="item in serviceHubItems"
                    :key="item.code"
                    class="service-hub-card"
                    :data-state="item.state"
                    :data-priority="['pending', 'attention'].includes(item.state)"
                    type="button"
                    :disabled="serviceHubActionDisabled(item)"
                    @click="openServiceHubItem(item)"
                  >
                    <span class="service-hub-card__icon" aria-hidden="true">
                      <AccountServiceHubIcon :code="item.code" />
                    </span>
                    <span class="service-hub-card__copy">
                      <span class="service-hub-card__name">{{ serviceHubNames[item.code] }}</span>
                      <strong>{{ item.label }}</strong>
                      <small>{{ item.description }}</small>
                    </span>
                    <span class="service-hub-card__action">
                      {{ serviceHubActionLabel(item) }}
                      <span v-if="!serviceHubActionDisabled(item)" aria-hidden="true">→</span>
                    </span>
                    <span class="service-hub-card__state">{{
                      serviceStateLabels[item.state]
                    }}</span>
                  </button>
                </div>

                <section
                  v-if="organizerPanelOpen && featuredServiceHub?.organizerContact"
                  id="organizer-contact-panel"
                  class="organizer-contact-panel"
                  tabindex="-1"
                  aria-labelledby="organizer-contact-title"
                >
                  <header>
                    <div>
                      <span>ORGANIZER CONTACT</span>
                      <h3 id="organizer-contact-title">添加大会组织者</h3>
                    </div>
                    <button
                      type="button"
                      aria-label="关闭组织者信息"
                      @click="organizerPanelOpen = false"
                    >
                      关闭
                    </button>
                  </header>
                  <div v-if="organizerContactAvailable" class="organizer-contact-panel__body">
                    <img
                      v-if="featuredServiceHub.organizerContact.qrAvailable"
                      :src="customer.organizerContactQrUrl(featuredRegistration.id)"
                      :alt="`${featuredServiceHub.organizerContact.organizerName}微信二维码`"
                    />
                    <div class="organizer-contact-panel__content">
                      <div class="organizer-contact-panel__identity">
                        <strong>{{ featuredServiceHub.organizerContact.organizerName }}</strong>
                        <span>{{ featuredServiceHub.organizerContact.organizerRole }}</span>
                        <p>{{ featuredServiceHub.organizerContact.instructions }}</p>
                      </div>
                      <div class="organizer-contact-panel__wechat">
                        <span>微信号</span>
                        <code>{{ featuredServiceHub.organizerContact.wechatId }}</code>
                        <button type="button" @click="copyOrganizerWechatId">
                          {{ organizerCopyStatus === '微信号已复制' ? '已复制' : '复制微信号' }}
                        </button>
                      </div>
                      <p
                        class="organizer-contact-panel__copy-status"
                        role="status"
                        aria-live="polite"
                      >
                        {{ organizerCopyStatus }}
                      </p>
                      <ol class="organizer-contact-panel__steps" aria-label="会员入群步骤">
                        <li>
                          <span>01</span>
                          <div>
                            <strong>添加大会组织者</strong>
                            <p>
                              扫码添加{{
                                featuredServiceHub.organizerContact.organizerName
                              }}，好友申请按上方说明备注。
                            </p>
                          </div>
                        </li>
                        <li>
                          <span>02</span>
                          <div>
                            <strong>发送报名信息截图</strong>
                            <p>进入报名详情，截图含姓名和报名编号的信息并发送。</p>
                          </div>
                        </li>
                        <li>
                          <span>03</span>
                          <div>
                            <strong>等待会员群邀请</strong>
                            <p>组织者核验参会资格后，会邀请你进入大会会员群。</p>
                          </div>
                        </li>
                      </ol>
                      <button
                        class="organizer-contact-panel__confirm"
                        type="button"
                        :disabled="organizerConfirmationPending"
                        @click="
                          setOrganizerConfirmed(!featuredServiceHub.organizerContact.confirmedAt)
                        "
                      >
                        {{
                          organizerConfirmationPending
                            ? '正在更新…'
                            : featuredServiceHub.organizerContact.confirmedAt
                              ? '恢复为待添加'
                              : '我已添加并发送报名截图'
                        }}
                      </button>
                    </div>
                  </div>
                  <div v-else class="organizer-contact-panel__unavailable" role="status">
                    <span aria-hidden="true">i</span>
                    <div>
                      <strong>{{ organizerServiceItem?.label ?? '暂不可查看' }}</strong>
                      <p>
                        {{
                          organizerServiceItem?.description ??
                            '大会团队开放服务并确认参会资格后，可在这里查看组织者信息。'
                        }}
                      </p>
                    </div>
                  </div>
                </section>
              </div>

              <article v-else-if="featuredOrder" class="account-pass order-service-pass">
                <div class="account-pass__main">
                  <div class="account-pass__topline">
                    <span>TOKEMS CONFERENCE · ORDER SERVICE</span>
                    <span class="account-pass__status">{{
                      statusLabel(featuredOrder.status)
                    }}</span>
                  </div>
                  <h3>{{ featuredOrder.eventName }}</h3>
                  <p>
                    {{ featuredOrder.ticketTypeName }} · 参会人 {{ featuredOrder.attendeeName }}
                  </p>
                  <div class="account-pass__actions">
                    <button
                      v-if="['pending_payment', 'processing'].includes(featuredOrder.status)"
                      class="account-pass__primary"
                      type="button"
                      :disabled="resumingOrderId === featuredOrder.id"
                      @click="resumeOrder(featuredOrder)"
                    >
                      {{ resumingOrderId === featuredOrder.id ? '正在恢复支付…' : '继续支付' }}
                      <span aria-hidden="true">→</span>
                    </button>
                    <a href="#purchases">查看订单详情</a>
                  </div>
                </div>
                <div class="account-pass__stub">
                  <span>ORDER</span>
                  <strong>{{ purchasedOrders.length }}</strong>
                  <small>{{ featuredOrder.orderNo }}</small>
                </div>
              </article>

              <div v-if="!featuredRegistration && featuredOrder" class="order-service-grid">
                <a href="#purchases">
                  <span>01</span><strong>订单与支付</strong><small>{{ statusLabel(featuredOrder.status) }}</small>
                </a>
                <NuxtLink
                  v-if="
                    featuredOrder.invoiceId ||
                      ['paid', 'partially_refunded'].includes(featuredOrder.status)
                  "
                  :to="`/account/invoices/${featuredOrder.id}`"
                >
                  <span>02</span><strong>发票服务</strong><small>{{ featuredOrder.invoiceId ? '查看开票记录' : '当前可以申请' }}</small>
                </NuxtLink>
                <a v-else href="#invoices" aria-disabled="true">
                  <span>02</span><strong>发票服务</strong><small>支付完成后开放</small>
                </a>
                <a href="#purchases">
                  <span>03</span><strong>参会人信息</strong><small>{{
                    featuredOrder.attendeeClaimed ? '参会人已认领' : '等待参会人认领'
                  }}</small>
                </a>
              </div>

              <article v-if="!featuredRegistration && !featuredOrder" class="account-pass is-empty">
                <div class="account-pass__main">
                  <div class="account-pass__topline">
                    <span>TOKEMS CONFERENCE · NEXT EVENT</span>
                    <span class="account-pass__status">待启程</span>
                  </div>
                  <h3>下一场大会，从这里开始</h3>
                  <p>完成报名后，进度、电子票与现场签到凭证会自动汇总到个人中心。</p>
                  <div class="account-pass__actions">
                    <a class="account-pass__primary" :href="publicHomepageHref">
                      浏览近期大会
                      <span aria-hidden="true">→</span>
                    </a>
                  </div>
                </div>
                <div class="account-pass__stub">
                  <span>MEMBER</span>
                  <strong>G</strong>
                  <small>READY TO JOIN</small>
                </div>
              </article>

              <dl class="account-summary" aria-label="参会信息摘要">
                <div>
                  <dt>我的大会</dt>
                  <dd>{{ registrationCountLabel }}</dd>
                  <small>本人名额</small>
                </div>
                <div>
                  <dt>有效票券</dt>
                  <dd>{{ validTicketCount }}{{ nextCursor ? '+' : '' }}</dd>
                  <small>可用于签到</small>
                </div>
                <div>
                  <dt>待办事项</dt>
                  <dd :class="{ 'is-attention': pendingActionCount > 0 }">
                    {{ featuredRegistration ? serviceActionCount : pendingActionCount
                    }}{{ nextCursor ? '+' : '' }}
                  </dd>
                  <small>{{
                    (featuredRegistration ? serviceActionCount : pendingActionCount)
                      ? '请及时处理'
                      : '当前无待办'
                  }}</small>
                </div>
              </dl>
            </section>

            <section id="events" class="account-section" aria-labelledby="events-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">02 / MY EVENTS</span>
                  <h2 id="events-title">我的参会名额</h2>
                </div>
                <p>这里仅展示你本人可使用的报名与电子票。</p>
              </div>

              <div class="account-surface account-events">
                <div v-if="registrations.length" class="registration-list">
                  <article v-for="item in registrations" :key="item.id" class="registration-row">
                    <div class="registration-row__date" aria-hidden="true">
                      <span>{{ formatMonth(item.startsAt) }}</span>
                      <strong>{{ formatDay(item.startsAt) }}</strong>
                    </div>
                    <div class="registration-row__body">
                      <div class="registration-row__heading">
                        <div>
                          <h3>{{ item.eventName }}</h3>
                          <p>{{ formatDate(item.startsAt) }} 至 {{ formatDate(item.endsAt) }}</p>
                        </div>
                        <span class="registration-status" :data-status="item.registrationStatus">
                          {{ statusLabels[item.registrationStatus] ?? item.registrationStatus }}
                        </span>
                      </div>
                      <dl class="registration-meta">
                        <div>
                          <dt>票种</dt>
                          <dd>{{ item.ticketTypeName }}</dd>
                        </div>
                        <div>
                          <dt>电子票</dt>
                          <dd>
                            {{
                              item.ticketStatus
                                ? (statusLabels[item.ticketStatus] ?? item.ticketStatus)
                                : '暂未生成'
                            }}
                          </dd>
                        </div>
                        <div>
                          <dt>报名编号</dt>
                          <dd>{{ item.registrationCode }}</dd>
                        </div>
                        <div>
                          <dt>资料权限</dt>
                          <dd>{{ item.canManageOrder ? '本人购买' : '参会人已认领' }}</dd>
                        </div>
                        <div>
                          <dt>参会需求</dt>
                          <dd>
                            {{ attendeeNeedsStatus(item.id) }}
                            <button
                              v-if="attendeeNeedsState(item.id).canRetry"
                              class="account-inline-retry"
                              type="button"
                              @click="loadAttendeeNeedsProfile(item.id)"
                            >
                              重试
                            </button>
                          </dd>
                        </div>
                      </dl>
                      <div class="registration-row__actions">
                        <NuxtLink
                          class="registration-primary-action"
                          :to="primaryRegistrationAction(item).to"
                        >
                          {{ primaryRegistrationAction(item).label }}
                          <span aria-hidden="true">→</span>
                        </NuxtLink>
                        <NuxtLink :to="`/account/registrations/${item.id}`">报名详情</NuxtLink>
                        <NuxtLink
                          v-if="item.ticketStatus === 'valid' || item.ticketStatus === 'used'"
                          :to="`/account/registrations/${item.id}/showcase?event=${encodeURIComponent(item.eventSlug)}`"
                        >
                          编辑参会名片
                        </NuxtLink>
                        <NuxtLink
                          v-if="hasAttendeeNeedsEntry(item.id)"
                          :to="`/account/registrations/${item.id}/needs?event=${encodeURIComponent(item.eventSlug)}`"
                        >
                          编辑参会需求
                        </NuxtLink>
                      </div>
                    </div>
                  </article>
                  <button
                    v-if="nextCursor"
                    class="registration-more"
                    type="button"
                    :disabled="loadingMore"
                    @click="loadRegistrations(true)"
                  >
                    {{ loadingMore ? '正在加载…' : '加载更多大会' }}
                  </button>
                </div>
                <div v-else class="account-empty">
                  <span class="account-empty__count">00</span>
                  <div>
                    <p class="account-empty__eyebrow">YOUR EVENT ARCHIVE</p>
                    <h3>还没有报名记录</h3>
                    <p>本人报名或认领他人购买的名额后，会在这里显示参会凭证。</p>
                    <a :href="publicHomepageHref">查看正在报名的大会 <span aria-hidden="true">→</span></a>
                  </div>
                </div>
              </div>
            </section>

            <section id="purchases" class="account-section" aria-labelledby="purchases-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">03 / PURCHASES</span>
                  <h2 id="purchases-title">我购买的订单</h2>
                </div>
                <p>订单、支付、参会人和发票由购票人统一管理。</p>
              </div>

              <div class="account-surface account-purchases">
                <article
                  v-for="orderItem in purchasedOrders"
                  :key="orderItem.id"
                  class="purchase-row"
                >
                  <div class="purchase-row__heading">
                    <div>
                      <span>{{ orderItem.orderNo }}</span>
                      <h3>{{ orderItem.eventName }}</h3>
                      <p>
                        {{ orderItem.ticketTypeName }} ·
                        {{ orderItem.isProxyPurchase ? '代购参会人' : '本人参会' }}
                        {{ orderItem.attendeeName }}
                      </p>
                    </div>
                    <div class="purchase-row__amount">
                      <span class="registration-status" :data-status="orderItem.status">
                        {{ statusLabel(orderItem.status) }}
                      </span>
                      <strong>{{ money(orderItem.amount, orderItem.currency) }}</strong>
                    </div>
                  </div>
                  <dl class="registration-meta purchase-row__meta">
                    <div>
                      <dt>参会手机号</dt>
                      <dd>{{ orderItem.attendeeMobile }}</dd>
                    </div>
                    <div>
                      <dt>认领状态</dt>
                      <dd>
                        {{
                          orderItem.status === 'closed' && orderItem.attendeeClaimed
                            ? '账号已绑定'
                            : orderItem.attendeeClaimed
                              ? '参会人已认领'
                              : '等待参会人认领'
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>支付状态</dt>
                      <dd>
                        {{
                          orderItem.paymentStatus
                            ? statusLabel(orderItem.paymentStatus)
                            : '尚未支付'
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>电子票</dt>
                      <dd>
                        {{
                          orderItem.ticketStatus ? statusLabel(orderItem.ticketStatus) : '暂未生成'
                        }}
                      </dd>
                    </div>
                  </dl>

                  <form
                    v-if="editingOrderId === orderItem.id"
                    class="purchase-attendee-edit"
                    @submit.prevent="saveAttendee(orderItem)"
                  >
                    <label>
                      <span>参会人姓名</span>
                      <input v-model="attendeeEdit.name" maxlength="120" />
                    </label>
                    <label>
                      <span>参会手机号</span>
                      <input v-model="attendeeEdit.mobile" inputmode="tel" required />
                    </label>
                    <div>
                      <button
                        class="registration-primary-action"
                        type="submit"
                        :disabled="attendeeSaving"
                      >
                        {{ attendeeSaving ? '保存中…' : '保存并发送新邀请' }}
                      </button>
                      <button type="button" @click="editingOrderId = ''">取消</button>
                    </div>
                  </form>

                  <div v-else class="registration-row__actions">
                    <button
                      v-if="canResumePendingOrder(orderItem, purchaseContexts[orderItem.eventId])"
                      class="registration-primary-action"
                      type="button"
                      :disabled="resumingOrderId === orderItem.id"
                      @click="resumeOrder(orderItem)"
                    >
                      {{ resumingOrderId === orderItem.id ? '正在恢复支付…' : '继续支付' }}
                      <span aria-hidden="true">→</span>
                    </button>
                    <button
                      v-if="canRestartSelfOrder(orderItem, purchaseContexts[orderItem.eventId])"
                      class="registration-primary-action"
                      type="button"
                      @click="restartClosedSelfOrder(orderItem)"
                    >
                      重新报名
                      <span aria-hidden="true">→</span>
                    </button>
                    <button
                      v-if="
                        (orderItem.status === 'pending_payment' &&
                          !canResumePendingOrder(orderItem, purchaseContexts[orderItem.eventId]) &&
                          !canRestartSelfOrder(orderItem, purchaseContexts[orderItem.eventId])) ||
                          (orderItem.status === 'closed' &&
                            (!purchaseContexts[orderItem.eventId] ||
                              purchaseContextErrors[orderItem.eventId] ||
                              purchaseContexts[orderItem.eventId]?.resumePaymentOrderId ===
                              orderItem.id))
                      "
                      type="button"
                      :disabled="refreshingPurchaseContexts"
                      @click="retryPurchaseContext(orderItem)"
                    >
                      {{ refreshingPurchaseContexts ? '正在刷新…' : '刷新报名状态' }}
                    </button>
                    <NuxtLink
                      v-if="
                        orderItem.invoiceId ||
                          ['paid', 'partially_refunded'].includes(orderItem.status)
                      "
                      :to="`/account/invoices/${orderItem.id}`"
                    >
                      {{ orderItem.invoiceId ? '查看发票' : '申请发票' }}
                    </NuxtLink>
                    <button
                      v-if="orderItem.canEditAttendee"
                      type="button"
                      @click="startAttendeeEdit(orderItem)"
                    >
                      编辑未认领参会人
                    </button>
                    <button
                      v-if="purchaseContexts[orderItem.eventId]?.canPurchaseAdditional"
                      type="button"
                      @click="additionalPurchase(orderItem)"
                    >
                      继续增加名额（剩余
                      {{ purchaseContexts[orderItem.eventId]?.remainingSeatCount }}）
                    </button>
                  </div>
                </article>

                <div v-if="!purchasedOrders.length" class="account-empty compact">
                  <span class="account-empty__count">00</span>
                  <div>
                    <p class="account-empty__eyebrow">PURCHASE HISTORY</p>
                    <h3>还没有购买订单</h3>
                    <p>本人报名和为他人购票产生的订单会在这里集中管理。</p>
                  </div>
                </div>
                <button
                  v-if="nextOrdersCursor"
                  class="registration-more"
                  type="button"
                  @click="loadPurchasedOrders(true)"
                >
                  加载更多订单
                </button>
              </div>
            </section>

            <section id="showcases" class="account-section" aria-labelledby="showcases-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">04 / ATTENDEE MATERIALS</span>
                  <h2 id="showcases-title">参会资料</h2>
                </div>
                <p>每场大会独立维护参会名片和参会需求，公开范围由你分别决定。</p>
              </div>

              <div class="account-surface account-showcases">
                <article
                  v-for="item in registrations.filter((registration) =>
                    hasAttendeeMaterials(registration),
                  )"
                  :key="item.id"
                  class="showcase-entry"
                >
                  <div>
                    <span>ATTENDEE MATERIALS</span>
                    <h3>{{ item.eventName }}</h3>
                    <p>{{ item.attendeeName }} · {{ item.ticketTypeName }}</p>
                    <p>参会需求：{{ attendeeNeedsStatus(item.id) }}</p>
                  </div>
                  <div class="showcase-entry__actions">
                    <NuxtLink
                      :to="`/account/registrations/${item.id}/showcase?event=${encodeURIComponent(item.eventSlug)}`"
                    >
                      编辑参会名片
                    </NuxtLink>
                    <NuxtLink
                      v-if="hasAttendeeNeedsEntry(item.id)"
                      :to="`/account/registrations/${item.id}/needs?event=${encodeURIComponent(item.eventSlug)}`"
                    >
                      编辑参会需求 <span aria-hidden="true">→</span>
                    </NuxtLink>
                    <button
                      v-if="attendeeNeedsState(item.id).canRetry"
                      class="account-inline-retry"
                      type="button"
                      @click="loadAttendeeNeedsProfile(item.id)"
                    >
                      重新读取
                    </button>
                  </div>
                </article>
                <div
                  v-if="!registrations.some((registration) => hasAttendeeMaterials(registration))"
                  class="account-empty compact"
                >
                  <span class="account-empty__count">00</span>
                  <div>
                    <p class="account-empty__eyebrow">ATTENDEE MATERIALS</p>
                    <h3>完成报名后即可维护参会资料</h3>
                    <p>你可以完善参会名片，也可以提交希望大会解决的问题。</p>
                  </div>
                </div>
              </div>
            </section>

            <section id="invoices" class="account-section" aria-labelledby="invoices-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">05 / INVOICES</span>
                  <h2 id="invoices-title">发票中心</h2>
                </div>
                <p>申请、审核、下载和历史记录统一汇总。</p>
              </div>

              <div class="account-surface account-invoices">
                <div class="account-invoices__summary">
                  <div>
                    <span>可申请</span>
                    <strong>{{ invoiceCounts.eligible }}</strong>
                    <small>已支付订单</small>
                  </div>
                  <div :class="{ attention: invoiceCounts.actionRequired > 0 }">
                    <span>待我处理</span>
                    <strong>{{ invoiceCounts.actionRequired }}</strong>
                    <small>{{ invoiceCounts.actionRequired ? '请完善资料' : '当前无待办' }}</small>
                  </div>
                  <div>
                    <span>处理中</span>
                    <strong>{{ invoiceCounts.processing }}</strong>
                    <small>审核与开具</small>
                  </div>
                  <div>
                    <span>已开具</span>
                    <strong>{{ invoiceCounts.issued }}</strong>
                    <small>可下载文件</small>
                  </div>
                </div>

                <div class="account-invoices__entry">
                  <div>
                    <span class="account-invoices__eyebrow">INVOICE SERVICE</span>
                    <h3>
                      {{
                        invoiceCounts.actionRequired
                          ? `有 ${invoiceCounts.actionRequired} 项发票资料需要处理`
                          : invoiceCounts.eligible
                            ? `有 ${invoiceCounts.eligible} 笔订单可以申请发票`
                            : '发票记录已经整理完成'
                      }}
                    </h3>
                    <p>
                      {{
                        invoiceHighlights[0]
                          ? `${invoiceHighlights[0].eventName} · ${statusLabel(invoiceHighlights[0].status ?? 'paid')}`
                          : '收费订单完成支付后，可以在这里提交开票资料。'
                      }}
                    </p>
                  </div>
                  <NuxtLink to="/account/invoices">
                    进入发票中心 <span aria-hidden="true">→</span>
                  </NuxtLink>
                </div>
              </div>
            </section>

            <section id="profile" class="account-section" aria-labelledby="profile-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">06 / COMMON PROFILE</span>
                  <h2 id="profile-title">常用资料</h2>
                </div>
                <p>这些资料可用于下一次报名预填。</p>
              </div>

              <div class="account-surface account-profile">
                <div class="account-profile__intro">
                  <span>{{ profileCompletion }}%</span>
                  <h3>{{ profileCompletion === 100 ? '资料已经完整' : '继续完善常用资料' }}</h3>
                  <p>姓名、公司与职位会用于参会信息，请保持内容准确。</p>
                  <div class="account-progress" aria-hidden="true">
                    <i :style="{ width: `${profileCompletion}%` }"></i>
                  </div>
                </div>
                <form class="account-form" @submit.prevent="saveProfile">
                  <label>
                    <span>常用称呼</span>
                    <input
                      v-model="profile.nickname"
                      maxlength="80"
                      autocomplete="nickname"
                      placeholder="你的常用称呼"
                    />
                  </label>
                  <label>
                    <span>真实姓名</span>
                    <input
                      v-model="profile.realName"
                      maxlength="120"
                      autocomplete="name"
                      placeholder="用于参会信息"
                    />
                  </label>
                  <label>
                    <span>邮箱</span>
                    <input
                      v-model="profile.email"
                      type="email"
                      autocomplete="email"
                      placeholder="用于接收参会通知"
                      :aria-invalid="Boolean(emailError)"
                      @blur="validateEmail"
                    />
                    <small v-if="emailError" class="account-field-error">{{ emailError }}</small>
                  </label>
                  <label>
                    <span>所在公司</span>
                    <input
                      v-model="profile.company"
                      maxlength="160"
                      autocomplete="organization"
                      placeholder="公司或机构名称"
                    />
                  </label>
                  <label>
                    <span>职位</span>
                    <input
                      v-model="profile.title"
                      maxlength="100"
                      autocomplete="organization-title"
                      placeholder="当前职位"
                    />
                  </label>
                  <label>
                    <span>城市</span>
                    <input
                      v-model="profile.city"
                      maxlength="80"
                      autocomplete="address-level2"
                      placeholder="常驻城市"
                    />
                  </label>
                  <button class="account-primary is-form-action" type="submit" :disabled="saving">
                    {{ saving ? '正在保存…' : '保存常用资料' }}
                  </button>
                </form>
              </div>
            </section>

            <section id="security" class="account-section" aria-labelledby="security-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">07 / SECURITY</span>
                  <h2 id="security-title">账户与安全</h2>
                </div>
                <p>手机号验证保护你的参会凭证与订单信息。</p>
              </div>

              <div class="account-surface account-security">
                <div class="account-security__status">
                  <span aria-hidden="true">✓</span>
                  <div>
                    <strong>账户状态正常</strong>
                    <p>登录手机号已经完成验证</p>
                  </div>
                </div>
                <dl class="account-facts">
                  <div>
                    <dt>登录手机号</dt>
                    <dd>{{ customer.session.value.customer.maskedMobile }}</dd>
                  </div>
                  <div>
                    <dt>完成验证</dt>
                    <dd>{{ formatDateTime(customer.session.value.customer.verifiedAt) }}</dd>
                  </div>
                  <div>
                    <dt>最近登录</dt>
                    <dd>{{ formatDateTime(customer.session.value.customer.lastLoginAt) }}</dd>
                  </div>
                  <div>
                    <dt>账户创建</dt>
                    <dd>{{ formatDateTime(customer.session.value.customer.createdAt) }}</dd>
                  </div>
                  <div>
                    <dt>本次登录有效期</dt>
                    <dd>{{ formatDateTime(customer.session.value.expiresAt) }}</dd>
                  </div>
                </dl>
                <div class="account-security__action">
                  <div>
                    <strong>退出当前账号</strong>
                    <p>退出后需要重新验证手机号才能进入个人中心。</p>
                  </div>
                  <button type="button" @click="logout">退出登录</button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.account-page {
  --account-canvas: #f4f5f7;
  --account-surface: #ffffff;
  --account-ink: #15171b;
  --account-muted: #6f737c;
  --account-line: #dfe2e7;
  --account-line-soft: #eceef1;
  --account-title-page: clamp(32px, 3.2vw, 40px);
  --account-title-section: 23px;
  --account-title-card: clamp(22px, 2.5vw, 28px);
  --account-body: 13px;
  min-height: 100vh;
  background: var(--account-canvas);
}

.account-shell {
  width: min(100% - 40px, 1180px);
  margin-inline: auto;
  padding: 52px 0 104px;
}

.account-loading {
  display: grid;
  min-height: 420px;
  place-content: center;
  justify-items: center;
  gap: 15px;
  color: var(--account-muted);
}

.account-loading span {
  width: 28px;
  height: 28px;
  border: 2px solid #dbeafe;
  border-top-color: var(--conference-primary);
  border-radius: 50%;
  animation: account-loading-spin 800ms linear infinite;
}

.account-loading p {
  margin: 0;
  font-size: 13px;
}

@keyframes account-loading-spin {
  to {
    transform: rotate(360deg);
  }
}

.account-login {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  min-height: 540px;
  align-items: center;
  gap: 72px;
}

.account-login__copy {
  max-width: 650px;
}

.account-login h1,
.account-heading h1 {
  margin: 0;
  color: var(--account-ink);
  font-weight: 850;
  line-height: 1.12;
  text-wrap: balance;
}

.account-login h1 {
  font-size: clamp(32px, 4vw, 48px);
}

.account-login__copy > p:not(.flow-eyebrow),
.account-heading > div > p:last-child {
  margin: 18px 0 0;
  color: var(--account-muted);
  font-size: 15px;
  line-height: 1.75;
  text-wrap: pretty;
}

.account-login__preview {
  position: relative;
  display: grid;
  min-height: 380px;
  align-content: space-between;
  overflow: hidden;
  padding: 30px;
  border: 1px solid #dbe5f6;
  border-radius: 12px;
  background: #f5f8fe;
  color: var(--conference-primary);
}

.account-login__preview::before,
.account-login__preview::after {
  position: absolute;
  right: -20px;
  width: 120px;
  height: 120px;
  border: 1px solid #dce6f7;
  border-radius: 50%;
  content: '';
}

.account-login__preview::before {
  top: 90px;
}
.account-login__preview::after {
  top: 145px;
}

.account-login__preview span {
  font-family: var(--conference-font-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
}

.account-login__preview strong {
  color: var(--account-ink);
  font-size: 34px;
  line-height: 1.02;
}

.account-login__preview i {
  font-family: var(--conference-font-mono);
  font-size: 12px;
  font-style: normal;
}

.account-primary {
  display: inline-flex;
  min-height: 46px;
  align-items: center;
  justify-content: center;
  gap: 20px;
  margin-top: 28px;
  padding: 0 20px;
  border-radius: 8px;
  background: var(--conference-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 720;
  transition:
    background-color 160ms ease,
    transform 160ms ease,
    opacity 160ms ease;
}

.account-primary:active {
  transform: scale(0.97);
}
.account-primary:disabled {
  cursor: wait;
  opacity: 0.62;
}

.account-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin-bottom: 42px;
}

.account-heading h1 {
  font-size: var(--account-title-page);
  letter-spacing: -0.025em;
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
  transition:
    color 160ms ease,
    transform 160ms ease;
}

.account-back-link:active {
  transform: scale(0.96);
}

.account-message {
  margin: -18px 0 24px;
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 13px;
}

.account-message.is-error {
  background: #fff1f2;
  color: #be123c;
}
.account-message.is-success {
  background: #ecfdf5;
  color: #047857;
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

.account-avatar {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  border: 1px solid #cddcf6;
  background: #edf3fd;
  color: var(--conference-primary);
  font-size: 16px;
  font-weight: 820;
}

.account-rail__identity > div:last-child {
  min-width: 0;
}

.account-rail__identity strong {
  display: block;
  overflow: hidden;
  color: var(--account-ink);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-rail__identity span {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  color: #167653;
  font-size: 10px;
}

.account-rail__identity i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentcolor;
}

.account-rail__mobile {
  margin: 0;
  padding: 0 20px 20px;
  color: var(--account-muted);
  font-family: var(--conference-font-mono);
  font-size: 10px;
}

.account-nav {
  display: grid;
  padding: 8px;
  border-top: 1px solid var(--account-line-soft);
  border-bottom: 1px solid var(--account-line-soft);
}

.account-nav a {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 13px;
  padding: 0 12px;
  border-radius: 7px;
  color: #44474f;
  font-size: 12px;
  font-weight: 650;
  text-decoration: none;
  transition:
    background-color 160ms ease,
    color 160ms ease;
}

.account-nav a span {
  color: #a0a4ad;
  font-family: var(--conference-font-mono);
  font-size: 9px;
}

.account-rail__completion {
  padding: 20px;
}

.account-rail__completion > div:first-child {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--account-muted);
  font-size: 11px;
}

.account-rail__completion strong {
  color: var(--account-ink);
  font-family: var(--conference-font-mono);
  font-size: 12px;
}

.account-progress {
  width: 100%;
  height: 3px;
  overflow: hidden;
  margin-top: 12px;
  border-radius: 999px;
  background: #e6e8ec;
}

.account-progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--conference-primary);
  transition: width 240ms ease;
}

.account-rail__completion p {
  margin: 10px 0 0;
  color: #8a8e97;
  font-size: 10px;
  line-height: 1.55;
}

.account-rail__footer {
  padding: 18px 20px 20px;
  border-top: 1px solid var(--account-line-soft);
  background: #fafafa;
}

.account-rail__footer > span,
.account-rail__footer > strong {
  display: block;
}

.account-rail__footer > span {
  color: #999da5;
  font-size: 9px;
  letter-spacing: 0.08em;
}

.account-rail__footer > strong {
  margin-top: 5px;
  color: #686c74;
  font-size: 10px;
  font-weight: 550;
  line-height: 1.5;
}

.account-rail__footer button {
  min-height: 40px;
  margin-top: 12px;
  color: var(--account-muted);
  font-size: 11px;
  font-weight: 650;
}

.account-mobile-navigation {
  display: none;
}

.account-content {
  display: grid;
  min-width: 0;
  gap: 74px;
}

.account-section {
  min-width: 0;
  padding: 0;
  scroll-margin-top: 24px;
}

.account-section__heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 20px;
}

.account-section__heading.is-compact {
  margin-bottom: 18px;
}

.account-section__index {
  display: block;
  margin-bottom: 8px;
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.account-section__heading h2 {
  margin: 0;
  color: var(--account-ink);
  font-size: var(--account-title-section);
  font-weight: 820;
  line-height: 1.15;
}

.account-section__heading > p {
  max-width: 380px;
  margin: 0;
  color: var(--account-muted);
  font-size: 12px;
  line-height: 1.6;
  text-align: right;
}

.service-hub-heading__tools {
  display: grid;
  justify-items: end;
  gap: 8px;
}

.service-hub-heading__tools > p {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 0 9px;
  border: 1px solid #dce3ee;
  border-radius: 999px;
  background: #fff;
  color: #596273;
  font-size: 10.5px;
  font-weight: 650;
}

.service-hub-heading__tools > p i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #16805b;
}

.service-hub-heading__tools > p.is-attention {
  border-color: #fed7aa;
  background: #fffaf5;
  color: #9a3412;
}

.service-hub-heading__tools > p.is-attention i {
  background: #ea580c;
}

.service-hub-heading__tools label {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #8b9099;
  font-size: 10px;
}

.service-hub-heading__tools select {
  max-width: 260px;
  min-height: 36px;
  padding: 0 30px 0 11px;
  border: 1px solid var(--account-line);
  border-radius: 6px;
  background: #fff;
  color: var(--account-ink);
  font-size: 11px;
}

.account-pass {
  position: relative;
  display: grid;
  width: 100%;
  max-width: 100%;
  grid-template-columns: minmax(0, 1fr) 178px;
  min-height: 252px;
  overflow: hidden;
  border: 1px solid #cedbf1;
  border-top: 3px solid var(--conference-primary);
  border-radius: 0;
  background: var(--account-surface);
  color: var(--account-ink);
}

.account-pass__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  padding: 30px 32px;
}

.account-pass__topline {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: #6d7f9e;
  font-family: var(--conference-font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.account-pass__status {
  padding: 5px 7px;
  border: 1px solid #c9d9f4;
  border-radius: 4px;
  background: #f1f6ff;
  color: var(--conference-primary);
  letter-spacing: 0;
}

.account-pass__status[data-state='complete'] {
  border-color: #b7dfd0;
  background: #edf8f3;
  color: #167653;
}

.account-pass__status[data-state='attention'] {
  border-color: #fecdd3;
  background: #fff1f2;
  color: #be123c;
}

.account-pass h3 {
  max-width: 620px;
  margin: 35px 0 0;
  font-size: var(--account-title-card);
  font-weight: 830;
  line-height: 1.12;
  text-wrap: balance;
}

.account-pass__main > p {
  margin: 12px 0 0;
  color: var(--account-muted);
  font-size: var(--account-body);
  line-height: 1.65;
}

.account-pass__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 18px;
  margin-top: auto;
  padding-top: 24px;
}

.account-pass__actions a {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 18px;
  color: var(--conference-primary);
  font-size: 12px;
  font-weight: 680;
  text-decoration: none;
}

.account-pass__actions button {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 18px;
  color: var(--conference-primary);
  font-size: 12px;
  font-weight: 680;
}

.account-pass__actions .account-pass__primary {
  padding: 0 16px;
  border: 1px solid var(--conference-primary);
  border-radius: 7px;
  background: var(--conference-primary);
  color: #fff;
}

.account-pass[data-state='attention'] .account-pass__actions .account-pass__primary {
  border-color: #be123c;
  background: #be123c;
}

.account-pass__actions .account-pass__primary:active {
  transform: scale(0.97);
}

.account-pass__stub {
  position: relative;
  display: grid;
  align-content: center;
  justify-items: center;
  border-left: 1px dashed #b7c7e1;
  background: #f5f8fd;
  text-align: center;
}

.account-pass__stub::before,
.account-pass__stub::after {
  position: absolute;
  left: -10px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--account-canvas);
  content: '';
}

.account-pass__stub::before {
  top: -10px;
}
.account-pass__stub::after {
  bottom: -10px;
}

.account-pass__stub span,
.account-pass__stub small {
  color: #7c8ba4;
  font-family: var(--conference-font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.account-pass__stub strong {
  margin: 7px 0 12px;
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 44px;
  line-height: 0.95;
}

.service-hub-body {
  margin-top: 16px;
}

.service-hub-read-error {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
  padding: 9px 12px;
  border: 1px solid #fed7aa;
  background: #fff7ed;
  color: #9a3412;
  font-size: 11px;
}

.service-hub-read-error button {
  min-height: 30px;
  flex: 0 0 auto;
  color: #9a3412;
  font-weight: 750;
}

.service-hub-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  border-top: 1px solid var(--account-line);
  border-left: 1px solid var(--account-line);
}

.service-hub-grid > .service-hub-card {
  grid-column: span 2;
}

.service-hub-grid[data-count='5'] > .service-hub-card:nth-last-child(-n + 2) {
  grid-column: span 3;
}

.service-hub-grid[aria-busy='true'] {
  opacity: 0.72;
}

.service-hub-card {
  --service-color: #2563eb;
  --service-soft: #eff6ff;
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 168px;
  grid-template-columns: 40px minmax(0, 1fr);
  grid-template-rows: 1fr auto;
  gap: 0 13px;
  padding: 19px 18px 16px;
  overflow: hidden;
  border-right: 1px solid var(--account-line);
  border-bottom: 1px solid var(--account-line);
  background: #fff;
  color: var(--account-ink);
  text-align: left;
  touch-action: manipulation;
  transition:
    background-color 140ms ease,
    transform 120ms cubic-bezier(0.16, 1, 0.3, 1);
}

.service-hub-card[data-priority='true'] {
  box-shadow: inset 0 2px 0 var(--service-color);
  background: color-mix(in srgb, var(--service-soft) 24%, white);
}

.service-hub-card[data-state='complete'] {
  --service-color: #167653;
  --service-soft: #eaf7f1;
}

.service-hub-card[data-state='pending'] {
  --service-color: #b45309;
  --service-soft: #fff3e7;
}

.service-hub-card[data-state='attention'] {
  --service-color: #be123c;
  --service-soft: #fff1f2;
}

.service-hub-card[data-state='unavailable'] {
  --service-color: #7b8089;
  --service-soft: #f1f2f4;
}

.service-hub-card:active:not(:disabled) {
  transform: scale(0.985);
}

.service-hub-card:disabled {
  cursor: not-allowed;
  opacity: 0.76;
}

.service-hub-card:focus-visible {
  z-index: 1;
  outline: 3px solid rgb(37 99 235 / 24%);
  outline-offset: -3px;
}

.service-hub-card__icon {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--service-color) 30%, white);
  border-radius: 8px;
  background: var(--service-soft);
  color: var(--service-color);
}

.service-hub-card__icon svg {
  width: 19px;
  height: 19px;
}

.service-hub-card__copy {
  display: block;
  min-width: 0;
  padding-right: 35px;
}

.service-hub-card__name,
.service-hub-card__copy strong,
.service-hub-card__copy small {
  display: block;
}

.service-hub-card__name {
  color: #8c919a;
  font: 700 9.5px/1.3 var(--conference-font-mono);
  letter-spacing: 0.04em;
}

.service-hub-card__copy strong {
  margin-top: 6px;
  color: var(--service-color);
  font-size: 14px;
  font-weight: 760;
  line-height: 1.35;
}

.service-hub-card__copy small {
  margin-top: 7px;
  color: #666d78;
  font-size: 10.5px;
  line-height: 1.5;
}

.service-hub-card__action {
  align-self: end;
  grid-column: 1 / -1;
  margin-top: 14px;
  color: var(--service-color);
  font-size: 10.5px;
  font-weight: 750;
}

.service-hub-card__state {
  position: absolute;
  top: 0;
  right: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 8px 0 0;
  background: transparent;
  color: var(--service-color);
  font-size: 8.5px;
  font-weight: 760;
}

.service-hub-card__state::before {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  content: '';
}

.organizer-contact-panel {
  margin-top: 16px;
  padding: 24px;
  border: 1px solid #cbd8ef;
  border-top: 3px solid var(--conference-primary);
  background: #f8faff;
  outline: none;
}

.organizer-contact-panel > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.organizer-contact-panel > header span {
  color: var(--conference-primary);
  font: 700 9px/1.2 var(--conference-font-mono);
  letter-spacing: 0.08em;
}

.organizer-contact-panel h3 {
  margin: 7px 0 0;
  color: var(--account-ink);
  font-size: 18px;
}

.organizer-contact-panel > header button {
  min-height: 36px;
  color: var(--account-muted);
  font-size: 10px;
}

.organizer-contact-panel__body {
  display: grid;
  grid-template-columns: minmax(200px, 240px) minmax(0, 1fr);
  gap: 30px;
  margin-top: 22px;
}

.organizer-contact-panel__body > img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid #d7dfec;
  background: #fff;
}

.organizer-contact-panel__content {
  min-width: 0;
}

.organizer-contact-panel__identity strong,
.organizer-contact-panel__identity > span {
  display: block;
}

.organizer-contact-panel__identity strong {
  font-size: 17px;
}

.organizer-contact-panel__identity > span {
  margin-top: 5px;
  color: var(--account-muted);
  font-size: 11px;
}

.organizer-contact-panel__identity p {
  margin: 16px 0;
  color: #555b66;
  font-size: 11px;
  line-height: 1.75;
}

.organizer-contact-panel__wechat {
  display: grid;
  min-height: 46px;
  grid-template-columns: 54px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-top: 1px solid #dce4f1;
  border-bottom: 1px solid #dce4f1;
}

.organizer-contact-panel__wechat > span {
  color: #9297a0;
  font-size: 11px;
}

.organizer-contact-panel__wechat code {
  color: var(--account-ink);
  font-family: var(--conference-font-mono);
  font-size: 12px;
  font-weight: 700;
  user-select: all;
}

.organizer-contact-panel__wechat button {
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid #c5d2e6;
  border-radius: 5px;
  color: var(--conference-primary);
  font-size: 10px;
  font-weight: 720;
  transition:
    background-color 120ms ease,
    transform 120ms ease;
}

.organizer-contact-panel__wechat button:hover {
  background: #edf3ff;
}

.organizer-contact-panel__wechat button:active {
  transform: scale(0.96);
}

.organizer-contact-panel__copy-status {
  min-height: 18px;
  margin: 5px 0 0;
  color: #3571d2;
  font-size: 9.5px;
  line-height: 1.5;
}

.organizer-contact-panel__steps {
  display: grid;
  margin: 12px 0 0;
  padding: 0;
  border-top: 1px solid #dce4f1;
  list-style: none;
}

.organizer-contact-panel__steps li {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #dce4f1;
}

.organizer-contact-panel__steps li > span {
  padding-top: 3px;
  color: var(--conference-primary);
  font: 700 9px/1 var(--conference-font-mono);
}

.organizer-contact-panel__steps strong {
  color: var(--account-ink);
  font-size: 11px;
}

.organizer-contact-panel__steps p {
  margin: 3px 0 0;
  color: #6f747d;
  font-size: 10px;
  line-height: 1.6;
}

.organizer-contact-panel__unavailable {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-top: 22px;
  padding: 18px;
  border: 1px solid #d7dfec;
  background: #fff;
}

.organizer-contact-panel__unavailable > span {
  display: grid;
  flex: 0 0 30px;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid #b9c8e4;
  border-radius: 50%;
  color: var(--conference-primary);
  font: 700 13px/1 var(--conference-font-mono);
}

.organizer-contact-panel__unavailable strong {
  display: block;
  color: var(--account-ink);
  font-size: 14px;
}

.organizer-contact-panel__unavailable p {
  margin: 7px 0 0;
  color: var(--account-muted);
  font-size: 11px;
  line-height: 1.65;
}

.organizer-contact-panel__confirm {
  min-height: 42px;
  margin-top: 20px;
  padding: 0 15px;
  border-radius: 6px;
  background: var(--conference-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 750;
}

.organizer-contact-panel__confirm:active {
  transform: scale(0.97);
}

.order-service-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 16px;
  border-top: 1px solid var(--account-line);
  border-left: 1px solid var(--account-line);
}

.order-service-grid a {
  display: grid;
  min-height: 116px;
  align-content: center;
  gap: 6px;
  padding: 18px;
  border-right: 1px solid var(--account-line);
  border-bottom: 1px solid var(--account-line);
  background: #fff;
  color: var(--account-ink);
  text-decoration: none;
}

.order-service-grid span {
  color: var(--conference-primary);
  font: 700 9px/1 var(--conference-font-mono);
}

.order-service-grid strong {
  font-size: 13px;
}

.order-service-grid small {
  color: var(--account-muted);
  font-size: 9.5px;
}

.account-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 24px 0 0;
  border-top: 1px solid #cfd3d9;
  border-bottom: 1px solid #cfd3d9;
}

.account-summary > div {
  padding: 20px 2px;
}
.account-summary > div + div {
  padding-left: 22px;
  border-left: 1px solid #cfd3d9;
}

.account-summary dt,
.account-summary dd,
.account-summary small {
  margin: 0;
}

.account-summary dt {
  color: var(--account-muted);
  font-size: 10px;
}

.account-summary dd {
  margin-top: 8px;
  color: var(--account-ink);
  font-family: var(--conference-font-mono);
  font-size: 24px;
  font-weight: 750;
  line-height: 1;
}

.account-summary dd.is-attention {
  color: #c2410c;
}

.account-summary small {
  display: block;
  margin-top: 6px;
  color: #999da5;
  font-size: 9.5px;
}

.account-surface {
  overflow: hidden;
  border: 1px solid var(--account-line);
  border-radius: 10px;
  background: var(--account-surface);
}

.account-invoices__summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid var(--account-line-soft);
}

.account-showcases {
  display: grid;
}

.showcase-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 25px 28px;
  border-bottom: 1px solid var(--conference-line);
}

.showcase-entry:last-child {
  border-bottom: 0;
}

.showcase-entry > div > span {
  color: var(--conference-primary);
  font: 700 10px var(--conference-font-mono);
  letter-spacing: 0.08em;
}

.showcase-entry h3 {
  margin: 6px 0 5px;
  color: var(--conference-ink);
  font-size: 17px;
}

.showcase-entry p {
  margin: 0;
  color: var(--conference-ink-muted);
  font-size: 12px;
}

.showcase-entry__actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.showcase-entry__actions > a {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 14px;
  padding: 0 15px;
  border: 1px solid #d8e0ec;
  border-radius: 7px;
  color: #2f3c53;
  font-size: 12px;
  font-weight: 700;
}

.account-invoices__summary > div {
  display: grid;
  gap: 5px;
  padding: 20px 22px 22px;
  border-right: 1px solid var(--account-line-soft);
}

.account-invoices__summary > div:last-child {
  border-right: 0;
}

.account-invoices__summary span,
.account-invoices__summary small {
  color: var(--account-muted);
  font-size: 9.5px;
}

.account-invoices__summary strong {
  color: var(--account-ink);
  font-family: var(--conference-font-mono);
  font-size: 23px;
  font-variant-numeric: tabular-nums;
}

.account-invoices__summary .attention strong {
  color: #aa6c12;
}

.account-invoices__entry {
  display: flex;
  min-height: 154px;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 25px 28px 28px;
  background: #fafbfd;
}

.account-invoices__entry > div {
  min-width: 0;
}

.account-invoices__eyebrow {
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.account-invoices__entry h3 {
  margin: 9px 0 0;
  color: var(--account-ink);
  font-size: 18px;
  font-weight: 780;
  line-height: 1.4;
  text-wrap: balance;
}

.account-invoices__entry p {
  margin: 7px 0 0;
  color: var(--account-muted);
  font-size: 11px;
  line-height: 1.6;
}

.account-invoices__entry > a {
  display: inline-flex;
  min-height: 44px;
  flex: 0 0 auto;
  align-items: center;
  gap: 18px;
  padding: 0 16px;
  border-radius: 8px;
  background: var(--conference-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 720;
  text-decoration: none;
  transition:
    transform 150ms ease,
    opacity 150ms ease;
}

.account-invoices__entry > a:active {
  transform: scale(0.97);
}

.registration-list {
  display: grid;
}

.registration-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 24px;
  padding: 28px;
  border-bottom: 1px solid var(--account-line-soft);
  transition: background-color 160ms ease;
}

.registration-row:last-child {
  border-bottom: 0;
}

.registration-row__date {
  display: grid;
  width: 68px;
  height: 72px;
  align-content: center;
  border-top: 3px solid var(--conference-primary);
  background: #f2f5fb;
  color: var(--account-ink);
  text-align: center;
}

.registration-row__date span {
  color: var(--conference-primary);
  font-size: 9px;
  font-weight: 700;
}

.registration-row__date strong {
  margin-top: 4px;
  font-family: var(--conference-font-mono);
  font-size: 26px;
  line-height: 1;
}

.registration-row__body {
  min-width: 0;
}

.registration-row__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.registration-row__heading > div {
  min-width: 0;
}

.registration-row__heading h3 {
  margin: 0;
  overflow: hidden;
  color: var(--account-ink);
  font-size: 17px;
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.registration-row__heading p {
  margin: 7px 0 0;
  color: var(--account-muted);
  font-size: 11px;
}

.registration-status {
  flex: 0 0 auto;
  padding: 5px 8px;
  border-radius: 4px;
  background: #f2f3f5;
  color: #5f636b;
  font-size: 10px;
}

.registration-status[data-status='confirmed'],
.registration-status[data-status='completed'],
.registration-status[data-status='checked_in'] {
  background: #eaf7f1;
  color: #167653;
}

.registration-status[data-status='pending_payment'],
.registration-status[data-status='pending_review'] {
  background: #fff3e7;
  color: #b45309;
}

.registration-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px 24px;
  margin: 22px 0 0;
  padding: 18px 0;
  border-top: 1px solid var(--account-line-soft);
  border-bottom: 1px solid var(--account-line-soft);
}

.registration-meta div {
  min-width: 0;
}
.registration-meta dt,
.registration-meta dd {
  margin: 0;
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-inline-retry {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--conference-primary);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}
.registration-meta dt {
  color: #979ba4;
}
.registration-meta dd {
  margin-top: 5px;
  color: #4f535b;
  font-variant-numeric: tabular-nums;
}

.registration-row__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 20px;
  margin-top: 10px;
}

.registration-row__actions a,
.registration-row__actions button {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: 10px;
  color: #676b73;
  font-size: 11px;
  font-weight: 650;
  text-decoration: none;
  touch-action: manipulation;
  transition:
    color 120ms ease,
    transform 120ms cubic-bezier(0.16, 1, 0.3, 1);
}

.registration-row__actions .registration-primary-action {
  color: var(--conference-primary);
}

.registration-row__actions a:active,
.registration-row__actions button:active {
  transform: scale(0.96);
}

.account-purchases {
  display: grid;
}

.purchase-row {
  padding: 28px;
  border-bottom: 1px solid var(--account-line-soft);
}

.purchase-row:last-of-type {
  border-bottom: 0;
}

.purchase-row__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.purchase-row__heading > div:first-child > span {
  color: #8b919d;
  font-family: var(--conference-font-mono);
  font-size: 9px;
  letter-spacing: 0.06em;
}

.purchase-row__heading h3 {
  margin: 8px 0 0;
  color: var(--account-ink);
  font-size: 18px;
}

.purchase-row__heading p {
  margin: 7px 0 0;
  color: var(--account-muted);
  font-size: 11px;
}

.purchase-row__amount {
  display: grid;
  justify-items: end;
  gap: 12px;
}

.purchase-row__amount strong {
  color: var(--account-ink);
  font-family: var(--conference-font-mono);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.purchase-attendee-edit {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--account-line-soft);
}

.purchase-attendee-edit label {
  display: grid;
  gap: 7px;
  color: var(--account-muted);
  font-size: 10px;
}

.purchase-attendee-edit input {
  min-height: 42px;
  padding: 0 12px;
  border: 1px solid var(--account-line);
  border-radius: 7px;
  color: var(--account-ink);
}

.purchase-attendee-edit > div {
  display: flex;
  grid-column: 1 / -1;
  gap: 18px;
}

.purchase-attendee-edit button {
  min-height: 40px;
  color: var(--account-muted);
  font-size: 11px;
  font-weight: 680;
  transition: transform 120ms cubic-bezier(0.16, 1, 0.3, 1);
}

.purchase-attendee-edit button.registration-primary-action {
  color: var(--conference-primary);
}

.purchase-attendee-edit button:active {
  transform: scale(0.96);
}

.registration-more {
  min-height: 44px;
  margin: 18px 28px 24px;
  padding: 0 16px;
  border: 1px solid var(--account-line);
  border-radius: 7px;
  background: #fff;
  color: var(--conference-primary);
  font-size: 12px;
  font-weight: 680;
  transition:
    background-color 160ms ease,
    transform 160ms ease;
}

.registration-more:active {
  transform: scale(0.98);
}
.registration-more:disabled {
  cursor: wait;
  opacity: 0.62;
}

.account-empty {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  min-height: 300px;
  align-items: center;
}

.account-empty__count {
  display: grid;
  height: 100%;
  place-items: center;
  border-right: 1px solid var(--account-line-soft);
  background: #f6f7f9;
  color: #d1d4da;
  font-family: var(--conference-font-mono);
  font-size: 44px;
  font-weight: 720;
}

.account-empty > div {
  max-width: 480px;
  padding: 40px;
}
.account-empty__eyebrow {
  margin: 0 0 12px;
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
}
.account-empty h3 {
  margin: 0;
  color: var(--account-ink);
  font-size: 20px;
}
.account-empty > div > p:not(.account-empty__eyebrow) {
  margin: 12px 0 0;
  color: var(--account-muted);
  font-size: 12px;
  line-height: 1.7;
}
.account-empty a {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  color: var(--conference-primary);
  font-size: 12px;
  font-weight: 680;
  text-decoration: none;
}

.account-profile {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
}

.account-profile__intro {
  padding: 30px;
  border-right: 1px solid var(--account-line-soft);
  background: #f7f8fa;
}

.account-profile__intro > span {
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 32px;
  font-weight: 750;
  line-height: 1;
}

.account-profile__intro h3 {
  margin: 24px 0 0;
  color: var(--account-ink);
  font-size: 16px;
}
.account-profile__intro p {
  margin: 10px 0 0;
  color: var(--account-muted);
  font-size: 11px;
  line-height: 1.65;
}
.account-profile__intro .account-progress {
  margin-top: 24px;
}

.account-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  padding: 30px;
}

.account-form label {
  display: grid;
  align-content: start;
  gap: 7px;
  color: #555962;
  font-size: 11px;
  font-weight: 650;
}

.account-form input {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid #d7d9de;
  border-radius: 7px;
  background: #fff;
  color: var(--account-ink);
  font: inherit;
  outline: none;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.account-form input::placeholder {
  color: #a6a9b0;
}
.account-form input:focus {
  border-color: var(--conference-primary);
  box-shadow: 0 0 0 3px rgb(37 99 235 / 10%);
}
.account-form input[aria-invalid='true'] {
  border-color: #e11d48;
}
.account-field-error {
  color: #be123c;
  font-size: 10px;
  font-weight: 500;
}

.account-primary.is-form-action {
  grid-column: 1 / -1;
  width: max-content;
  margin-top: 4px;
}

.account-security {
  padding: 0 28px;
}

.account-security__status,
.account-security__action {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 24px 0;
}

.account-security__status {
  border-bottom: 1px solid var(--account-line-soft);
}

.account-security__status > span {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  background: #eaf7f1;
  color: #167653;
  font-size: 14px;
  font-weight: 800;
}

.account-security__status strong,
.account-security__action strong {
  color: var(--account-ink);
  font-size: 13px;
}
.account-security__status p,
.account-security__action p {
  margin: 5px 0 0;
  color: var(--account-muted);
  font-size: 10px;
}

.account-facts {
  margin: 0;
}

.account-facts > div {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: 24px;
  padding: 16px 0;
  border-bottom: 1px solid var(--account-line-soft);
}

.account-facts dt,
.account-facts dd {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
}
.account-facts dt {
  color: #8d9199;
}
.account-facts dd {
  color: #4f535b;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.account-security__action {
  justify-content: space-between;
  gap: 24px;
}
.account-security__action button {
  min-height: 40px;
  flex: 0 0 auto;
  padding: 0 14px;
  border: 1px solid var(--account-line);
  border-radius: 7px;
  color: #565a62;
  font-size: 11px;
  font-weight: 650;
  transition:
    background-color 160ms ease,
    transform 160ms ease;
}
.account-security__action button:active {
  transform: scale(0.96);
}

@media (hover: hover) {
  .account-back-link:hover {
    color: var(--conference-primary);
  }
  .account-nav a:hover {
    background: #f2f5fb;
    color: var(--conference-primary);
  }
  .account-rail__footer button:hover {
    color: #b42318;
  }
  .account-primary:hover {
    background: var(--conference-primary-dark);
  }
  .registration-row:hover {
    background: #fafbfc;
  }
  .registration-row__actions a:hover,
  .registration-row__actions button:hover,
  .account-empty a:hover {
    color: var(--conference-primary-dark);
  }
  .registration-more:hover {
    background: #f2f5fb;
  }
  .service-hub-card:hover:not(:disabled) {
    background: color-mix(in srgb, var(--service-soft) 34%, white);
  }
  .order-service-grid a:hover {
    background: #f8faff;
  }
  .account-security__action button:hover {
    background: #f5f5f6;
  }
}

@media (max-width: 1000px) {
  .account-workspace {
    grid-template-columns: 1fr;
  }
  .account-rail {
    position: sticky;
    z-index: 20;
    top: max(8px, env(safe-area-inset-top));
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: center;
    overflow: visible;
    box-shadow: 0 8px 24px rgb(15 23 42 / 7%);
  }
  .account-rail__identity {
    padding: 14px 16px 12px;
  }
  .account-rail__mobile {
    display: none;
  }
  .account-nav--desktop {
    display: none;
  }
  .account-rail__completion {
    display: none;
  }
  .account-rail__footer {
    display: none;
  }
  .account-mobile-navigation {
    position: relative;
    display: block;
    border-top: 1px solid var(--account-line-soft);
  }
  .account-mobile-navigation__trigger {
    display: grid;
    width: 100%;
    min-height: 48px;
    grid-template-columns: auto minmax(0, 1fr) 24px;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    color: var(--account-ink);
    text-align: left;
    transition: transform 110ms ease;
  }
  .account-mobile-navigation__trigger > span {
    color: var(--conference-primary);
    font: 720 9px/1 var(--conference-font-mono);
    letter-spacing: 0.08em;
  }
  .account-mobile-navigation__trigger strong {
    min-width: 0;
    font-size: 12px;
    font-weight: 720;
  }
  .account-mobile-navigation__trigger i {
    display: grid;
    width: 24px;
    height: 24px;
    place-items: center;
    color: var(--account-muted);
    font-size: 15px;
    font-style: normal;
  }
  .account-mobile-navigation__panel {
    position: absolute;
    z-index: 2;
    top: calc(100% + 6px);
    right: -1px;
    left: -1px;
    overflow: hidden;
    border: 1px solid var(--account-line);
    border-radius: 9px;
    background: #fff;
    box-shadow: 0 18px 38px rgb(15 23 42 / 15%);
  }
  .account-mobile-navigation__links {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 8px;
  }
  .account-mobile-navigation__links a {
    display: grid;
    min-width: 0;
    min-height: 48px;
    grid-template-columns: 24px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    padding: 0 9px;
    border-radius: 6px;
    color: #44474f;
    font-size: 12px;
    font-weight: 650;
    line-height: 1.35;
    text-decoration: none;
    transition:
      background-color 110ms ease,
      color 110ms ease,
      transform 110ms ease;
  }
  .account-mobile-navigation__links a[aria-current='location'] {
    background: #eff5ff;
    color: var(--conference-primary);
  }
  .account-mobile-navigation__links a span {
    color: #9da3ae;
    font: 650 9px/1 var(--conference-font-mono);
  }
  .account-mobile-navigation__meta {
    display: flex;
    min-height: 48px;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-top: 1px solid var(--account-line-soft);
    background: #fafbfc;
    color: var(--account-muted);
    font-size: 10px;
  }
  .account-mobile-navigation__meta span {
    font-family: var(--conference-font-mono);
  }
  .account-mobile-navigation__meta strong {
    margin-left: auto;
    color: #575b64;
    font-weight: 680;
  }
  .account-mobile-navigation__meta button {
    min-height: 44px;
    padding-inline: 8px;
    color: #9f2736;
    font-size: 10px;
    font-weight: 700;
    transition: transform 110ms ease;
  }
  .account-mobile-navigation__trigger:active,
  .account-mobile-navigation__links a:active,
  .account-mobile-navigation__meta button:active {
    transform: scale(0.98);
  }
  .service-hub-heading__tools select,
  .account-form input,
  .purchase-attendee-edit input {
    font-size: 16px;
  }
  .purchase-attendee-edit input,
  .registration-row__actions a,
  .registration-row__actions button,
  .purchase-attendee-edit button,
  .account-security__action button {
    min-height: 44px;
  }
  .account-section {
    scroll-margin-top: 142px;
  }
}

@media (max-width: 760px) {
  .account-shell {
    width: min(100% - 28px, 1180px);
    padding: 26px 0 calc(72px + env(safe-area-inset-bottom));
  }
  .account-heading {
    align-items: flex-start;
    margin-bottom: 20px;
  }
  .account-heading h1 {
    font-size: 32px;
  }
  .account-heading > div > p:last-child {
    max-width: 30ch;
    margin-top: 12px;
    font-size: 12px;
  }
  .account-rail__identity {
    display: none;
  }
  .account-mobile-navigation {
    border-top: 0;
  }
  .account-back-link {
    min-height: 44px;
    gap: 6px;
    padding: 0 12px;
    border: 1px solid var(--account-line);
    border-radius: 7px;
    background: #fff;
    font-size: 11px;
  }
  .account-back-link span {
    font-size: 13px;
  }
  .account-login {
    grid-template-columns: 1fr;
    min-height: 0;
    gap: 44px;
  }
  .account-login__preview {
    min-height: 280px;
  }
  .account-workspace {
    gap: 20px;
  }
  .account-content {
    gap: 48px;
  }
  .account-section__heading {
    align-items: flex-start;
  }
  .account-section__heading > p {
    max-width: 210px;
    text-align: right;
  }
  .account-pass {
    grid-template-columns: minmax(0, 1fr);
  }
  .service-hub-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .service-hub-grid > .service-hub-card,
  .service-hub-grid[data-count='5'] > .service-hub-card:nth-last-child(-n + 2) {
    grid-column: span 1;
  }
  .service-hub-grid[data-count='5'] > .service-hub-card:last-child {
    grid-column: span 2;
  }
  .account-pass__main {
    width: 100%;
  }
  .account-pass__topline > span:first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .account-pass__stub {
    min-height: 68px;
    grid-template-columns: auto auto 1fr;
    align-content: center;
    justify-items: start;
    gap: 12px;
    padding: 0 22px;
    border-top: 1px dashed #b7c7e1;
    border-left: 0;
    text-align: left;
  }
  .account-pass__stub::before,
  .account-pass__stub::after {
    top: -10px;
    bottom: auto;
  }
  .account-pass__stub::before {
    left: -10px;
  }
  .account-pass__stub::after {
    right: -10px;
    left: auto;
  }
  .account-pass__stub strong {
    margin: 0;
    font-size: 26px;
  }
  .account-pass__stub small {
    justify-self: end;
  }
  .account-profile {
    grid-template-columns: 1fr;
  }
  .account-profile__intro {
    border-right: 0;
    border-bottom: 1px solid var(--account-line-soft);
  }
  .account-invoices__summary {
    grid-template-columns: 1fr 1fr;
  }
  .account-invoices__summary > div:nth-child(2) {
    border-right: 0;
  }
  .account-invoices__summary > div:nth-child(-n + 2) {
    border-bottom: 1px solid var(--account-line-soft);
  }
  .account-invoices__entry {
    align-items: flex-start;
    flex-direction: column;
  }
  .order-service-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 600px) {
  .account-section__heading {
    display: block;
  }
  .account-section__heading > p {
    max-width: none;
    margin-top: 10px;
    text-align: left;
  }
  .service-hub-heading__tools {
    justify-items: start;
    margin-top: 12px;
  }
  .service-hub-heading__tools label {
    width: 100%;
    align-items: flex-start;
    flex-direction: column;
  }
  .service-hub-heading__tools select {
    min-height: 44px;
    width: 100%;
    max-width: none;
  }
  .account-pass__main {
    padding: 22px 20px;
  }
  .account-pass__topline {
    align-items: flex-start;
  }
  .account-pass h3 {
    margin-top: 22px;
    font-size: 24px;
  }
  .account-pass__actions {
    width: 100%;
    gap: 10px 16px;
    padding-top: 20px;
  }
  .account-pass__actions a,
  .account-pass__actions button {
    min-height: 44px;
  }
  .account-pass__actions .account-pass__primary {
    justify-content: space-between;
  }
  .account-summary > div {
    padding-block: 17px;
  }
  .account-summary > div + div {
    padding-left: 14px;
  }
  .account-summary dd {
    font-size: 23px;
  }
  .registration-row {
    grid-template-columns: 56px minmax(0, 1fr);
    gap: 16px;
    padding: 20px;
  }
  .purchase-row {
    padding: 20px;
  }
  .purchase-row__heading {
    display: grid;
  }
  .purchase-row__amount {
    justify-items: start;
    grid-template-columns: auto auto;
    align-items: center;
  }
  .purchase-attendee-edit {
    grid-template-columns: 1fr;
  }
  .registration-row__date {
    width: 54px;
    height: 60px;
  }
  .registration-row__date strong {
    font-size: 21px;
  }
  .registration-row__heading {
    display: block;
  }
  .registration-status {
    display: inline-block;
    margin-top: 10px;
  }
  .registration-meta {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .account-empty {
    grid-template-columns: 1fr;
  }
  .account-empty__count {
    height: 110px;
    border-right: 0;
    border-bottom: 1px solid var(--account-line-soft);
    font-size: 44px;
  }
  .account-empty > div {
    padding: 30px 24px 34px;
  }
  .account-form {
    grid-template-columns: 1fr;
    padding: 24px;
  }
  .account-profile__intro {
    padding: 24px;
  }
  .showcase-entry {
    align-items: flex-start;
    flex-direction: column;
    padding: 22px;
  }
  .showcase-entry__actions {
    width: 100%;
    justify-content: flex-start;
  }
  .organizer-contact-panel {
    padding: 20px;
  }
  .organizer-contact-panel__body {
    grid-template-columns: 1fr;
  }
  .organizer-contact-panel__body > img {
    width: min(100%, 300px);
    height: auto;
  }
  .organizer-contact-panel > header button,
  .organizer-contact-panel__wechat button,
  .organizer-contact-panel__confirm {
    min-height: 44px;
  }
  .organizer-contact-panel__confirm {
    width: 100%;
  }
  .organizer-contact-panel__wechat code {
    overflow-wrap: anywhere;
  }
}

@media (max-width: 400px) {
  .account-shell {
    width: min(100% - 22px, 1180px);
  }
  .account-heading h1 {
    font-size: 30px;
  }
  .account-pass__topline > span:first-child {
    max-width: 180px;
    line-height: 1.5;
  }
  .account-pass__stub {
    grid-template-columns: auto auto;
  }
  .account-pass__stub small {
    display: none;
  }
  .account-summary dt {
    font-size: 9px;
  }
  .account-summary small {
    font-size: 8.5px;
  }
  .service-hub-card {
    min-height: 174px;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 0 9px;
    padding: 18px 13px 14px;
  }
  .service-hub-card__icon {
    width: 30px;
    height: 30px;
  }
  .service-hub-card__icon svg {
    width: 16px;
    height: 16px;
  }
  .service-hub-card__copy {
    padding-right: 24px;
  }
  .service-hub-card__copy strong {
    font-size: 12.5px;
  }
  .service-hub-card__copy small {
    font-size: 10px;
  }
  .service-hub-card__state {
    padding-top: 6px;
    padding-right: 6px;
  }
  .registration-row {
    grid-template-columns: 1fr;
  }
  .registration-row__date {
    width: 100%;
    height: 52px;
    grid-template-columns: auto auto;
    place-content: center;
    align-items: center;
    gap: 7px;
  }
  .registration-row__date strong {
    margin: 0;
  }
  .account-facts > div {
    grid-template-columns: 1fr;
    gap: 5px;
  }
  .account-facts dd {
    text-align: left;
  }
  .account-security__action {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 340px) {
  .service-hub-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .service-hub-grid > .service-hub-card,
  .service-hub-grid[data-count='5'] > .service-hub-card:nth-last-child(-n + 2),
  .service-hub-grid[data-count='5'] > .service-hub-card:last-child {
    grid-column: span 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .account-loading span {
    animation: none;
  }
  .account-progress i {
    transition: none;
  }
}
</style>
