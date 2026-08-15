<script setup lang="ts">
import {
  DEMO_EVENT,
  type CreateRegistration,
  type EventPurchaseContext,
  type PublicEvent,
  type PublicSiteConfiguration,
} from '@conference/contracts';
import { watch } from 'vue';
import {
  activeFlowStep,
  enabledFlowSteps,
  hasEnabledEventFlowStep,
  resolveEventExperience,
} from '~/composables/useEventExperience';
import { useCustomerSession } from '~/composables/useCustomerSession';
import { readOrderAccessToken } from '~/composables/useOrderAccessToken';
import {
  createRegistrationIntent,
  resolveCheckoutSuccessDestination,
  resolveRegistrationIntent,
} from '~/utils/purchase-journey';
import {
  pruneRegistrationDrafts,
  readRegistrationDraft,
  registrationDraftIdentityTransition,
  registrationDraftStorageKey,
  removeRegistrationDraft,
  removeRegistrationDraftVersions,
  sanitizeRegistrationDraftAnswers,
  type RegistrationDraftScope,
  type RegistrationDraftStorage,
  writeRegistrationDraft,
} from '~/utils/registration-draft';

const api = useConferenceApi();
const customer = useCustomerSession();
const router = useRouter();
const route = useRoute();
/** Real event only — never seed DEMO_EVENT prices into the first paint. */
const event = ref<PublicEvent | null>(null);
const pageLoading = ref(true);
const loadError = ref('');
const selectedTicketId = ref('');
const pending = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const offerToken = ref('');
const purchaseFor = ref<'self' | 'other'>('self');
const purchaseIntentId = ref('');
const proxyAuthorizationAccepted = ref(false);
const termsAccepted = ref(false);
const invoiceRequired = ref(false);
const marketingConsent = ref(false);
const purchaseContext = ref<EventPurchaseContext | null>(null);
const purchaseContextReady = ref(false);
const siteConfiguration = ref<PublicSiteConfiguration | null>(null);
const answers = reactive<Record<string, string>>({
  name: '',
  mobile: '',
  email: '',
  company: '',
  title: '',
  city: '',
});
const registrationFields = computed(() => event.value?.registrationForm?.fields ?? []);
const experience = computed(() =>
  event.value ? resolveEventExperience(event.value) : resolveEventExperience(DEMO_EVENT),
);
const emptyTicket: PublicEvent['tickets'][number] = {
  id: '',
  name: '暂无可报名票种',
  description: '',
  price: 0,
  currency: 'CNY',
  remaining: 0,
  benefits: [],
  recommended: false,
};

const selectedTicket = computed(() => {
  if (!event.value) return emptyTicket;
  return (
    event.value.tickets.find((ticket) => ticket.id === selectedTicketId.value) ??
    event.value.tickets[0] ??
    emptyTicket
  );
});

const money = (amount: number) => `¥${(amount / 100).toLocaleString('zh-CN')}`;
const priceLabel = (amount: number) => (amount === 0 ? '免费' : money(amount));
const isFreeTicket = computed(() => selectedTicket.value.price === 0);
const registrationAvailable = computed(() =>
  Boolean(
    event.value?.status === 'registration_open' &&
    event.value.registration.registrationOpen &&
    event.value.tickets.length,
  ),
);
const joiningWaitlist = computed(
  () =>
    purchaseFor.value === 'self' &&
    registrationAvailable.value &&
    experience.value.registrationFlow.branches.waitlist &&
    selectedTicket.value.remaining < 1 &&
    !offerToken.value,
);
const flowSteps = computed(() =>
  event.value
    ? enabledFlowSteps(event.value, {
      paymentRequired: !isFreeTicket.value,
      invoiceRequired: invoiceRequired.value,
      })
    : [],
);
const activeStep = computed(() => activeFlowStep(flowSteps.value, 'ticket-selection'));
const registrationHelp = computed(
  () =>
    flowSteps.value.find((step) => step.type === 'attendee-form')?.helpText ||
    '选择参会票种并填写真实信息。提交后将进入下一步。',
);
const answer = (key: string) => String(answers[key] ?? '').trim();
const accountRequired = computed(
  () => event.value?.registration.accountMode === 'mobile_otp_required',
);
const verifiedMobile = computed(() => customer.session.value?.customer.maskedMobile ?? '');
const canPurchaseAdditional = computed(
  () => purchaseContext.value?.canPurchaseAdditional === true,
);
const pendingOrderHref = computed(() => {
  const orderId = purchaseContext.value?.resumePaymentOrderId;
  if (!orderId || !event.value) return '';
  const token = readOrderAccessToken(orderId);
  if (token) {
    return `/order/${encodeURIComponent(orderId)}?event=${encodeURIComponent(event.value.slug)}`;
  }
  return `/account?event=${encodeURIComponent(event.value.slug)}&order=${encodeURIComponent(orderId)}#purchases`;
});
const termsUrl = computed(() => siteConfiguration.value?.customerAccounts.termsUrl ?? '');
const termsVersion = computed(
  () =>
    event.value?.registrationForm?.termsVersion ||
    siteConfiguration.value?.customerAccounts.termsVersion ||
    '2026-07-16',
);
const inputAutocomplete = (key: string) =>
  ({
    name: 'name',
    mobile: 'tel',
    email: 'email',
    company: 'organization',
    title: 'organization-title',
    city: 'address-level2',
  })[key] ?? 'off';
const dateRange = computed(() => {
  if (!event.value) return '';
  const format = new Intl.DateTimeFormat('zh-CN', {
    timeZone: event.value.timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `${format.format(new Date(event.value.startsAt))} 至 ${format.format(new Date(event.value.endsAt))}`;
});
useHead(() => ({ title: `报名 · ${event.value?.name ?? '大会'}` }));

interface ActiveRegistrationDraftContext {
  identity: string;
  storage: RegistrationDraftStorage;
  scope: RegistrationDraftScope;
  formVersion: number;
}

let activeRegistrationDraftContext: ActiveRegistrationDraftContext | null = null;
let retainedAnonymousDraftContext: ActiveRegistrationDraftContext | null = null;
let registrationDraftSaveTimer: ReturnType<typeof setTimeout> | undefined;
let registrationDraftCompleted = false;

function clearRegistrationDraftSaveTimer() {
  if (!registrationDraftSaveTimer) return;
  clearTimeout(registrationDraftSaveTimer);
  registrationDraftSaveTimer = undefined;
}

function resetRegistrationAnswers(loaded: PublicEvent, preserveCurrentAnswers: boolean) {
  const fields = loaded.registrationForm?.fields ?? [];
  const preserved = preserveCurrentAnswers ? sanitizeRegistrationDraftAnswers(answers, fields) : {};
  for (const key of Object.keys(answers)) delete answers[key];
  for (const field of fields) answers[field.key] = preserved[field.key] ?? '';
}

function browserRegistrationDraftStorage(kind: 'local' | 'session') {
  if (!import.meta.client) return null;
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function currentRegistrationDraftContext(): ActiveRegistrationDraftContext | null {
  if (!import.meta.client || !event.value) return null;

  const session = customer.session.value;
  const scope: RegistrationDraftScope = {
    organizationId: event.value.organizationId,
    eventId: event.value.id,
    ownerId: session ? `customer:${session.customer.id}` : 'anonymous',
    purchaseFor: purchaseFor.value,
    purchaseIntentId: purchaseIntentId.value,
  };
  const formVersion = event.value.registrationForm?.version ?? 1;
  const storage = browserRegistrationDraftStorage(session ? 'local' : 'session');
  if (!storage) return null;
  return {
    identity: registrationDraftStorageKey(scope, formVersion),
    storage,
    scope,
    formVersion,
  };
}

function prefillFromCustomerSession(session: typeof customer.session.value) {
  if (!session || purchaseFor.value !== 'self') return;
  answers.mobile = session.customer.mobile;
  answers.name ||= session.customer.profile.realName || session.customer.profile.nickname || '';
  answers.email ||= session.customer.profile.email || '';
  answers.company ||= session.customer.profile.company || '';
  answers.title ||= session.customer.profile.title || '';
  answers.city ||= session.customer.profile.city || '';
}

function sameRegistrationDraftForm(
  first: ActiveRegistrationDraftContext,
  second: ActiveRegistrationDraftContext,
) {
  return (
    first.scope.organizationId === second.scope.organizationId &&
    first.scope.eventId === second.scope.eventId &&
    first.formVersion === second.formVersion
  );
}

function persistRegistrationDraftToContext(context: ActiveRegistrationDraftContext) {
  const written = writeRegistrationDraft(
    context.storage,
    context.scope,
    context.formVersion,
    answers,
    registrationFields.value,
  );
  if (
    written &&
    retainedAnonymousDraftContext &&
    String(context.scope.ownerId).startsWith('customer:') &&
    sameRegistrationDraftForm(context, retainedAnonymousDraftContext)
  ) {
    removeRegistrationDraft(
      retainedAnonymousDraftContext.storage,
      retainedAnonymousDraftContext.scope,
      retainedAnonymousDraftContext.formVersion,
    );
    retainedAnonymousDraftContext = null;
  }
  return written;
}

function persistRegistrationDraft() {
  if (registrationDraftCompleted || !activeRegistrationDraftContext) return false;
  return persistRegistrationDraftToContext(activeRegistrationDraftContext);
}

function restoreRegistrationDraftForCurrentIdentity() {
  if (registrationDraftCompleted) return;
  const next = currentRegistrationDraftContext();
  if (!next || next.identity === activeRegistrationDraftContext?.identity) return;

  const previous = activeRegistrationDraftContext;
  clearRegistrationDraftSaveTimer();
  if (previous && !registrationDraftCompleted) persistRegistrationDraftToContext(previous);

  const identityTransition = previous
    ? registrationDraftIdentityTransition(previous.scope.ownerId, next.scope.ownerId)
    : null;
  const anonymousLogin = identityTransition?.kind === 'anonymous_to_customer';
  const sessionExpired = identityTransition?.kind === 'customer_to_anonymous';

  const preserveCurrentAnswers = identityTransition?.migrateCurrentAnswers === true;
  const customerChanged =
    previous && identityTransition?.clearAnswers === true;
  const purchaseModeChanged = previous && previous.scope.purchaseFor !== next.scope.purchaseFor;
  if ((customerChanged || purchaseModeChanged) && event.value) {
    resetRegistrationAnswers(event.value, false);
  }

  if (sessionExpired) {
    activeRegistrationDraftContext = next;
    return;
  }

  const restored = readRegistrationDraft(
    next.storage,
    next.scope,
    next.formVersion,
    registrationFields.value,
  );
  if (preserveCurrentAnswers) {
    for (const [key, value] of Object.entries(restored)) answers[key] ||= value;
  } else {
    Object.assign(answers, restored);
  }
  prefillFromCustomerSession(customer.session.value);

  activeRegistrationDraftContext = next;
  if (preserveCurrentAnswers && previous) {
    const migrated = persistRegistrationDraftToContext(next);
    if (anonymousLogin && migrated) {
      removeRegistrationDraft(previous.storage, previous.scope, previous.formVersion);
    } else if (anonymousLogin) {
      retainedAnonymousDraftContext = previous;
    }
  }
}

function completeRegistrationDraft() {
  registrationDraftCompleted = true;
  clearRegistrationDraftSaveTimer();
  if (activeRegistrationDraftContext) {
    removeRegistrationDraftVersions(
      activeRegistrationDraftContext.storage,
      activeRegistrationDraftContext.scope,
    );
    const anonymousStorage = browserRegistrationDraftStorage('session');
    if (anonymousStorage) {
      removeRegistrationDraftVersions(anonymousStorage, {
        ...activeRegistrationDraftContext.scope,
        ownerId: 'anonymous',
      });
    }
  }
  if (
    retainedAnonymousDraftContext &&
    activeRegistrationDraftContext &&
    sameRegistrationDraftForm(activeRegistrationDraftContext, retainedAnonymousDraftContext)
  ) {
    removeRegistrationDraftVersions(
      retainedAnonymousDraftContext.storage,
      retainedAnonymousDraftContext.scope,
    );
    retainedAnonymousDraftContext = null;
  }
}

/**
 * Applies a loaded public event and selects the ticket from the query string when valid.
 *
 * @param loaded - Event payload from API or matching local cache
 * @param ticketFromQuery - Optional ticket id from the URL
 */
function applyLoadedEvent(loaded: PublicEvent, ticketFromQuery = '') {
  const eventChanged = Boolean(event.value && event.value.id !== loaded.id);
  const formChanged = Boolean(
    event.value &&
    event.value.id === loaded.id &&
    event.value.registrationForm?.version !== loaded.registrationForm?.version,
  );
  if (eventChanged || formChanged) {
    if (activeRegistrationDraftContext && !registrationDraftCompleted) {
      persistRegistrationDraftToContext(activeRegistrationDraftContext);
    }
    clearRegistrationDraftSaveTimer();
    resetRegistrationAnswers(loaded, formChanged);
    activeRegistrationDraftContext = null;
    registrationDraftCompleted = false;
  }

  event.value = loaded;
  if (!loaded.registration.additionalPurchaseEnabled || offerToken.value) {
    purchaseFor.value = 'self';
  }
  selectedTicketId.value = loaded.tickets.some((ticket) => ticket.id === ticketFromQuery)
    ? ticketFromQuery
    : (loaded.tickets[0]?.id ?? '');
  for (const field of registrationFields.value) answers[field.key] ??= '';
}

watch(
  answers,
  () => {
    if (!activeRegistrationDraftContext || registrationDraftCompleted) return;
    clearRegistrationDraftSaveTimer();
    const scheduledContext = activeRegistrationDraftContext;
    registrationDraftSaveTimer = setTimeout(() => {
      if (
        registrationDraftCompleted ||
        activeRegistrationDraftContext?.identity !== scheduledContext.identity
      ) {
        return;
      }
      persistRegistrationDraftToContext(scheduledContext);
    }, 400);
  },
  { deep: true },
);

watch(api.eventState, (loaded) => {
  if (!event.value || event.value.slug !== loaded.slug) return;
  applyLoadedEvent(loaded, selectedTicketId.value);
});

watch(
  () => [
    event.value?.id,
    event.value?.registrationForm?.version,
    customer.session.value?.customer.id,
    purchaseFor.value,
    purchaseIntentId.value,
  ],
  restoreRegistrationDraftForCurrentIdentity,
  { flush: 'sync' },
);

watch(
  () => customer.session.value,
  (session) => {
    prefillFromCustomerSession(session);
  },
  { immediate: true },
);

watch(purchaseFor, (next) => {
  proxyAuthorizationAccepted.value = false;
  if (next === 'other') marketingConsent.value = false;
  if (next === 'self') prefillFromCustomerSession(customer.session.value);
});

async function loadPurchaseContext() {
  if (!event.value || !customer.session.value) {
    purchaseContext.value = null;
    purchaseContextReady.value = true;
    return;
  }
  purchaseContextReady.value = false;
  try {
    purchaseContext.value = await customer.purchaseContext(event.value.id);
  } catch {
    purchaseContext.value = null;
  } finally {
    purchaseContextReady.value = true;
  }
}

function beginAdditionalPurchase() {
  purchaseFor.value = 'other';
  purchaseIntentId.value = createRegistrationIntent();
  termsAccepted.value = false;
  proxyAuthorizationAccepted.value = false;
  void router.replace({
    query: { ...route.query, intent: purchaseIntentId.value, purchaseFor: 'other' },
  });
}

function errorStatus(error: unknown) {
  const value = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return value.status ?? value.statusCode ?? value.response?.status;
}

async function registrationError(error: unknown, fallback: string) {
  if (accountRequired.value && errorStatus(error) === 401) {
    await customer.refresh(true).catch(() => null);
    customer.openLogin();
    return '登录状态已失效，请重新验证手机号。当前填写内容已经保留。';
  }
  return error instanceof Error ? error.message : fallback;
}

onMounted(async () => {
  const localDraftStorage = browserRegistrationDraftStorage('local');
  const sessionDraftStorage = browserRegistrationDraftStorage('session');
  if (localDraftStorage) pruneRegistrationDrafts(localDraftStorage);
  if (sessionDraftStorage) pruneRegistrationDrafts(sessionDraftStorage);
  window.addEventListener('pagehide', persistRegistrationDraft);
  const query = new URL(window.location.href).searchParams;
  const slug = query.get('event');
  const ticketFromQuery = query.get('ticket') ?? '';
  offerToken.value = query.get('offer') ?? '';
  const intentFromQuery = query.get('intent');
  const requestedPurchaseFor = query.get('purchaseFor') === 'other' ? 'other' : 'self';
  purchaseFor.value = requestedPurchaseFor;
  const resolvedIntent = resolveRegistrationIntent(intentFromQuery);
  purchaseIntentId.value = resolvedIntent.purchaseIntentId;
  if (resolvedIntent.shouldReplace) {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}?${new URLSearchParams({
        ...Object.fromEntries(query.entries()),
        intent: purchaseIntentId.value,
      }).toString()}${window.location.hash}`,
    );
  }
  if (offerToken.value) purchaseFor.value = 'self';

  // Prefer a cache hit for the same slug; never paint DEMO_EVENT ticket prices.
  const cached = api.readEvent();
  if (slug && cached?.slug === slug) {
    applyLoadedEvent(cached, ticketFromQuery);
    if (
      requestedPurchaseFor === 'other' &&
      cached.registration.additionalPurchaseEnabled &&
      !offerToken.value
    ) {
      purchaseFor.value = 'other';
    }
    pageLoading.value = false;
  }

  try {
    const [loaded, site] = await Promise.all([
      slug ? api.getEvent(slug) : api.getHomepageEvent(),
      api.getSiteConfiguration().catch(() => null),
    ]);
    siteConfiguration.value = site;
    applyLoadedEvent(loaded, ticketFromQuery);
    if (
      requestedPurchaseFor === 'other' &&
      loaded.registration.additionalPurchaseEnabled &&
      !offerToken.value
    ) {
      purchaseFor.value = 'other';
    }
    await customer.refresh().catch(() => null);
    await loadPurchaseContext();
    if (accountRequired.value && !customer.session.value) {
      customer.openLogin();
    }
  } catch (error) {
    if (!event.value) {
      loadError.value = error instanceof Error ? error.message : '报名信息加载失败，请刷新重试。';
    }
  } finally {
    pageLoading.value = false;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', persistRegistrationDraft);
  clearRegistrationDraftSaveTimer();
  persistRegistrationDraft();
});

async function submit() {
  errorMessage.value = '';
  successMessage.value = '';
  if (!event.value) {
    errorMessage.value = '报名信息仍在加载，请稍后再试。';
    return;
  }
  if (!customer.session.value) {
    errorMessage.value = '本场大会需要先登录，登录后会继续保留当前填写内容。';
    customer.openLogin();
    return;
  }
  if (!registrationAvailable.value) {
    errorMessage.value = '当前大会已暂停报名，请留意后续开放通知。';
    return;
  }
  if (!termsAccepted.value) {
    errorMessage.value = '请阅读并同意报名条款后继续。';
    return;
  }
  if (purchaseFor.value === 'other' && !proxyAuthorizationAccepted.value) {
    errorMessage.value = '请确认已获得参会人授权后继续。';
    return;
  }
  if (purchaseFor.value === 'other' && selectedTicket.value.remaining < 1) {
    errorMessage.value = '候补仅支持本人报名，请选择仍有名额的票种。';
    return;
  }
  if (
    selectedTicket.value.remaining < 1 &&
    !offerToken.value &&
    !experience.value.registrationFlow.branches.waitlist
  ) {
    errorMessage.value = '当前票种已售罄，本大会未开启候补流程，请选择其他票种。';
    return;
  }
  if (joiningWaitlist.value) {
    pending.value = true;
    try {
      const entry = await api.joinWaitlist({
        eventId: event.value.id,
        ticketTypeId: selectedTicketId.value,
        name: answer('name'),
        email: answer('email'),
        mobile: customer.session.value.customer.mobile,
      });
      const contact = entry.email || entry.mobile;
      completeRegistrationDraft();
      successMessage.value = `候补申请已提交，你当前位于第 ${entry.position} 位。名额释放后会向 ${contact} 发送两小时有效的报名链接。`;
    } catch (error) {
      errorMessage.value = await registrationError(error, '候补申请提交失败。');
    } finally {
      pending.value = false;
    }
    return;
  }
  const input: CreateRegistration = {
    eventId: event.value.id,
    ticketTypeId: selectedTicketId.value,
    attendee: {
      name: answer('name'),
      mobile:
        purchaseFor.value === 'self'
          ? customer.session.value.customer.mobile
          : answer('mobile'),
      email: answer('email'),
      company: answer('company'),
      title: answer('title'),
      city: answer('city'),
    },
    invoiceRequired: invoiceRequired.value,
    marketingConsent: purchaseFor.value === 'other' ? false : marketingConsent.value,
    termsAccepted: true,
    purchaseFor: purchaseFor.value,
    purchaseIntentId: purchaseIntentId.value,
    proxyAuthorizationAccepted:
      purchaseFor.value === 'other' && proxyAuthorizationAccepted.value,
    formVersion: event.value.registrationForm?.version ?? 1,
    termsVersion: termsVersion.value,
    formAnswers: Object.fromEntries(
      registrationFields.value.map((field) => [field.key, answer(field.key)]),
    ),
    ...(offerToken.value ? { waitlistOfferToken: offerToken.value } : {}),
  };

  pending.value = true;
  try {
    const checkout = await api.createRegistration(input);
    api.saveCheckout(checkout);
    completeRegistrationDraft();
    const freeCheckoutCompleted =
      (checkout.order.amount === 0 || checkout.order.paymentMethod === 'free') &&
      checkout.order.status === 'paid';
    if (checkout.ticket || freeCheckoutCompleted) {
      if (checkout.ticket && !checkout.isProxyPurchase) api.saveTicket(checkout.ticket);
      const destination = resolveCheckoutSuccessDestination({
        isProxyPurchase: checkout.isProxyPurchase,
        eventSlug: event.value.slug,
        registrationId: checkout.registration.id,
        ticketCode: checkout.ticket?.code,
        memberProfileEnabled: hasEnabledEventFlowStep(event.value, 'member-profile'),
      });
      if (destination) {
        await router.push(destination);
        return;
      }
    }
    const accessToken = checkout.orderAccessToken ?? '';
    const paymentCheckoutUrl = api.resolvePaymentCheckoutUrl(
      checkout.order.id,
      event.value.slug,
      accessToken,
    );
    if (/^https?:\/\//i.test(paymentCheckoutUrl)) {
      window.location.assign(paymentCheckoutUrl);
      return;
    }
    await router.push({
      path: `/order/${checkout.order.id}`,
      query: { event: event.value.slug },
      ...(accessToken ? { hash: `#access=${encodeURIComponent(accessToken)}` } : {}),
    });
  } catch (error) {
    errorMessage.value = await registrationError(error, '提交失败，请检查报名信息后重试。');
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="flow-page">
    <FlowHeader />
    <main class="flow-shell" id="main-content">
      <div
        v-if="pageLoading && !event"
        class="flow-card flow-card__body"
        style="text-align: center"
        role="status"
      >
        正在加载报名信息…
      </div>
      <div v-else-if="loadError && !event" class="form-error" role="alert">{{ loadError }}</div>
      <template v-else-if="event">
        <p class="flow-eyebrow">REGISTRATION</p>
        <h1 class="flow-title">锁定你的大会席位</h1>
        <p class="flow-lead">{{ registrationHelp }}</p>
        <p v-if="offerToken" class="waitlist-offer-banner" role="status">
          候补名额已为你保留，请使用收到邀请的邮箱，并在有效期内完成报名。
        </p>
        <p v-if="!registrationAvailable" class="waitlist-offer-banner" role="status">
          当前大会已暂停报名。页面内容仍可查看，报名重新开放后可继续提交。
        </p>
        <div
          v-if="purchaseContextReady && customer.session.value && purchaseContext?.resumePaymentOrderId"
          class="registration-state-line"
          role="status"
        >
          <span>你有一笔待支付订单，席位仍在保留时间内。</span>
          <a :href="pendingOrderHref">继续支付 →</a>
        </div>
        <div
          v-else-if="
            purchaseContextReady &&
              customer.session.value &&
              purchaseFor === 'self' &&
              purchaseContext?.myAttendance
          "
          class="registration-state-line"
          role="status"
        >
          <span>你已拥有本场大会的参会名额。</span>
          <button v-if="canPurchaseAdditional" type="button" @click="beginAdditionalPurchase">
            继续为他人增加名额 →
          </button>
        </div>
        <FlowStepper
          :active="activeStep"
          :payment-required="!isFreeTicket"
          :steps="flowSteps.map((step) => step.title)"
          :variant="experience.registrationFlow.progressVariant"
        />

        <div
          class="flow-grid"
          :class="{ 'is-single-column': !experience.registrationFlow.summaryCardEnabled }"
        >
          <form class="flow-card" @submit.prevent="submit">
            <div class="flow-card__head">
              <h2>报名信息</h2>
              <p>带 * 字段用于参会身份核验与会前通知。</p>
            </div>
            <div class="flow-card__body">
              <h3 class="form-section-title" style="margin-top: 0; border-top: 0; padding-top: 0">
                选择票种
              </h3>
              <div class="ticket-options">
                <label
                  v-for="ticket in event.tickets"
                  :key="ticket.id"
                  class="ticket-option"
                  :class="{ 'is-selected': selectedTicketId === ticket.id }"
                >
                  <input v-model="selectedTicketId" type="radio" name="ticket" :value="ticket.id" />
                  <span>
                    <span class="ticket-option__name">
                      {{ ticket.name }}
                      <span v-if="ticket.recommended" class="ticket-option__tag">推荐</span>
                    </span>
                    <span class="ticket-option__desc">{{ ticket.description }}</span>
                    <span class="ticket-option__stock">剩余 {{ ticket.remaining }} 席</span>
                  </span>
                  <strong class="ticket-option__price">{{ priceLabel(ticket.price) }}</strong>
                </label>
                <p v-if="!event.tickets.length" class="form-error">当前没有可报名票种。</p>
              </div>

              <h3 class="form-section-title">参会人信息</h3>
              <fieldset class="purchase-for-switch">
                <legend>这张票给谁使用</legend>
                <label :class="{ 'is-selected': purchaseFor === 'self' }">
                  <input v-model="purchaseFor" type="radio" value="self" />
                  <span><strong>本人参会</strong><small>使用当前登录手机号核验身份</small></span>
                </label>
                <label
                  :class="{ 'is-selected': purchaseFor === 'other', 'is-disabled': !event.registration.additionalPurchaseEnabled }"
                >
                  <input
                    v-model="purchaseFor"
                    type="radio"
                    value="other"
                    :disabled="!event.registration.additionalPurchaseEnabled"
                  />
                  <span><strong>为他人购票</strong><small>填写实际参会人的信息，可继续增加名额</small></span>
                </label>
              </fieldset>
              <div
                v-if="accountRequired"
                class="registration-auth-status"
                :class="{ 'is-verified': Boolean(customer.session.value) }"
              >
                <span aria-hidden="true">{{ customer.session.value ? '✓' : '•' }}</span>
                <p v-if="customer.session.value">
                  手机号已验证：<strong>{{ verifiedMobile }}</strong>
                  。{{ purchaseFor === 'self' ? '本人报名将绑定该手机号。' : '代购订单归入你的购买记录。' }}
                </p>
                <p v-else>本场大会需要先验证手机号，验证成功后会保留当前填写内容。</p>
                <button v-if="!customer.session.value" type="button" @click="customer.openLogin">
                  登录 / 注册
                </button>
              </div>
              <div class="form-grid">
                <div v-for="field in registrationFields" :key="field.key" class="form-field">
                  <label :for="`registration-${field.key}`">
                    {{ field.label }}<em v-if="field.required">*</em>
                  </label>
                  <select
                    v-if="field.type === 'select'"
                    :id="`registration-${field.key}`"
                    v-model="answers[field.key]"
                    class="form-input"
                    :required="field.required"
                  >
                    <option value="">{{ field.placeholder ?? `请选择${field.label}` }}</option>
                    <option v-for="option in field.options" :key="option" :value="option">
                      {{ option }}
                    </option>
                  </select>
                  <input
                    v-else
                    :id="`registration-${field.key}`"
                    v-model="answers[field.key]"
                    class="form-input"
                    :required="field.required"
                    :type="field.type"
                    :autocomplete="inputAutocomplete(field.key)"
                    :placeholder="field.placeholder ?? `请填写${field.label}`"
                    :readonly="field.key === 'mobile' && purchaseFor === 'self'"
                  />
                </div>
              </div>

              <div class="registration-consents">
                <label v-if="purchaseFor === 'other'">
                  <input v-model="proxyAuthorizationAccepted" type="checkbox" required />
                  <span>我已获得参会人授权，可代为提交其报名信息并接收订单通知。</span>
                </label>
                <label>
                  <input v-model="invoiceRequired" type="checkbox" />
                  <span>支付完成后需要申请发票</span>
                </label>
                <label v-if="purchaseFor === 'self'">
                  <input v-model="marketingConsent" type="checkbox" />
                  <span>接收本场大会及后续相关活动通知</span>
                </label>
                <label>
                  <input v-model="termsAccepted" type="checkbox" required />
                  <span>
                    我已阅读并同意
                    <a v-if="termsUrl" :href="termsUrl" target="_blank" rel="noopener noreferrer">报名条款</a>
                    <span v-else>报名条款</span>
                    （版本 {{ termsVersion }}）
                  </span>
                </label>
              </div>

              <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
              <p v-if="successMessage" class="form-success" role="status">{{ successMessage }}</p>
              <button
                class="flow-action is-full"
                type="submit"
                :disabled="
                  pending ||
                    !registrationAvailable ||
                    (purchaseFor === 'other' && selectedTicket.remaining < 1)
                "
                style="margin-top: 24px"
              >
                {{
                  pending
                    ? joiningWaitlist
                      ? '正在加入候补…'
                      : isFreeTicket
                        ? '正在确认报名…'
                        : '正在创建订单…'
                    : purchaseFor === 'other' && selectedTicket.remaining < 1
                      ? '候补仅支持本人报名'
                      : joiningWaitlist
                        ? '加入候补名单'
                        : isFreeTicket
                          ? '免费报名并领取电子票'
                          : `提交报名并支付 ${money(selectedTicket.price)}`
                }}
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </form>

          <aside
            v-if="experience.registrationFlow.summaryCardEnabled"
            class="flow-card summary-card"
          >
            <div class="summary-event">
              <div class="summary-event__label">TOKEMS CONFERENCE 2026</div>
              <h3>{{ event.name }}</h3>
              <p>{{ dateRange }}<br />{{ event.venue }} · {{ event.city }}</p>
            </div>
            <div class="summary-body">
              <div class="summary-row">
                <span>所选票种</span><strong>{{ selectedTicket.name }}</strong>
              </div>
              <div class="summary-row"><span>电子票数量</span><strong>1 张</strong></div>
              <div class="summary-row">
                <span>退改规则</span>
                <strong>{{ isFreeTicket ? '可取消报名' : '7 天内可退' }}</strong>
              </div>
              <div class="summary-row is-total">
                <span>{{ isFreeTicket ? '报名费用' : '应付金额' }}</span>
                <strong>{{ priceLabel(selectedTicket.price) }}</strong>
              </div>
              <p class="summary-note">
                {{
                  isFreeTicket
                    ? '提交后即确认席位并签发电子票，请确保参会人信息准确。'
                    : '支付窗口为 15 分钟。支付完成后可查看电子票，并继续申请发票。'
                }}
              </p>
            </div>
          </aside>
        </div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.registration-state-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 18px 0;
  padding: 12px 0;
  border-block: 1px solid #dbe4f7;
  color: #172033;
  font-size: 13px;
  line-height: 1.7;
}
.registration-state-line a,
.registration-state-line button {
  min-height: 40px;
  padding: 0 4px;
  color: #1f5fe0;
  font-weight: 760;
  white-space: nowrap;
  touch-action: manipulation;
  transition: transform 120ms cubic-bezier(0.16, 1, 0.3, 1);
}
.registration-state-line a:active,
.registration-state-line button:active {
  transform: scale(0.96);
}
.purchase-for-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0 0 16px;
  padding: 0;
  border: 0;
}
.purchase-for-switch legend {
  grid-column: 1 / -1;
  margin-bottom: 2px;
  color: #697386;
  font-size: 12px;
  font-weight: 680;
}
.purchase-for-switch label {
  display: flex;
  min-height: 72px;
  gap: 10px;
  align-items: flex-start;
  padding: 13px;
  border: 1px solid #d8dde8;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
}
.purchase-for-switch label.is-selected {
  border-color: #1f5fe0;
  box-shadow: inset 0 0 0 1px #1f5fe0;
}
.purchase-for-switch label.is-disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.purchase-for-switch input {
  margin-top: 3px;
  accent-color: #1f5fe0;
}
.purchase-for-switch span {
  display: grid;
  gap: 3px;
}
.purchase-for-switch strong {
  color: #111827;
  font-size: 14px;
}
.purchase-for-switch small {
  color: #697386;
  font-size: 12px;
  line-height: 1.55;
}
.registration-consents {
  display: grid;
  gap: 10px;
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid #e3e7ef;
}
.registration-consents label {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  color: #4b5565;
  font-size: 13px;
  line-height: 1.65;
}
.registration-consents input {
  width: 16px;
  height: 16px;
  margin-top: 3px;
  accent-color: #1f5fe0;
}
.registration-consents a {
  color: #1f5fe0;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.registration-auth-status {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: 10px;
  align-items: center;
  margin: 0 0 18px;
  padding: 12px 14px;
  border-radius: 8px;
  background: #eef4ff;
  color: #194caa;
  font-size: 13px;
  line-height: 1.6;
}
.registration-auth-status > span {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: rgb(31 95 224 / 10%);
  font-weight: 760;
}
.registration-auth-status p {
  margin: 0;
}
.registration-auth-status button {
  min-height: 40px;
  padding: 0 12px;
  border-radius: 7px;
  background: #1f5fe0;
  color: #fff;
  font-size: 12px;
  font-weight: 720;
  touch-action: manipulation;
  transition: transform 160ms ease;
}
.registration-auth-status button:active {
  transform: scale(0.96);
}
.registration-auth-status.is-verified {
  grid-template-columns: 24px 1fr;
  background: #ecfdf5;
  color: #047857;
}
.registration-auth-status.is-verified > span {
  background: rgb(4 120 87 / 10%);
}
@media (max-width: 560px) {
  .registration-state-line {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
  .purchase-for-switch {
    grid-template-columns: 1fr;
  }
  .registration-auth-status {
    grid-template-columns: 24px 1fr;
  }
  .registration-auth-status button {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
