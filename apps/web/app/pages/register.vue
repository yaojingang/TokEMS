<script setup lang="ts">
import { DEMO_EVENT, type CreateRegistration, type PublicEvent } from '@conference/contracts';
import { watch } from 'vue';
import {
  activeFlowStep,
  enabledFlowSteps,
  resolveEventExperience,
} from '~/composables/useEventExperience';
import { useCustomerSession } from '~/composables/useCustomerSession';

const api = useConferenceApi();
const customer = useCustomerSession();
const router = useRouter();
/** Real event only — never seed DEMO_EVENT prices into the first paint. */
const event = ref<PublicEvent | null>(null);
const pageLoading = ref(true);
const loadError = ref('');
const selectedTicketId = ref('');
const pending = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const offerToken = ref('');
const answers = reactive<Record<string, string>>({
  name: '',
  mobile: '',
  email: '',
  company: '',
  title: '',
  city: '',
});
const preferences = reactive({
  invoiceRequired: false,
  marketingConsent: false,
  termsAccepted: false,
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
    registrationAvailable.value &&
    experience.value.registrationFlow.branches.waitlist &&
    selectedTicket.value.remaining < 1 &&
    !offerToken.value,
);
const flowSteps = computed(() =>
  event.value
    ? enabledFlowSteps(event.value, {
        paymentRequired: !isFreeTicket.value,
        invoiceRequired: preferences.invoiceRequired,
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

/**
 * Applies a loaded public event and selects the ticket from the query string when valid.
 *
 * @param loaded - Event payload from API or matching local cache
 * @param ticketFromQuery - Optional ticket id from the URL
 */
function applyLoadedEvent(loaded: PublicEvent, ticketFromQuery = '') {
  event.value = loaded;
  selectedTicketId.value = loaded.tickets.some((ticket) => ticket.id === ticketFromQuery)
    ? ticketFromQuery
    : (loaded.tickets[0]?.id ?? '');
  for (const field of registrationFields.value) answers[field.key] ??= '';
}

watch(isFreeTicket, (free) => {
  if (free) preferences.invoiceRequired = false;
});

watch(api.eventState, (loaded) => {
  if (!event.value || event.value.slug !== loaded.slug) return;
  applyLoadedEvent(loaded, selectedTicketId.value);
});

watch(
  () => customer.session.value,
  (session) => {
    if (!session) return;
    // Prefill from profile; keep any value the user already typed (including a different mobile).
    answers.mobile ||= session.customer.mobile;
    answers.name ||= session.customer.profile.realName || session.customer.profile.nickname || '';
    answers.email ||= session.customer.profile.email || '';
    answers.company ||= session.customer.profile.company || '';
    answers.title ||= session.customer.profile.title || '';
    answers.city ||= session.customer.profile.city || '';
  },
  { immediate: true },
);

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
  const query = new URL(window.location.href).searchParams;
  const slug = query.get('event');
  const ticketFromQuery = query.get('ticket') ?? '';
  offerToken.value = query.get('offer') ?? '';

  // Prefer a cache hit for the same slug; never paint DEMO_EVENT ticket prices.
  const cached = api.readEvent();
  if (slug && cached?.slug === slug) {
    applyLoadedEvent(cached, ticketFromQuery);
    pageLoading.value = false;
  }

  try {
    const loaded = slug ? await api.getEvent(slug) : await api.getHomepageEvent();
    applyLoadedEvent(loaded, ticketFromQuery);
    await customer.refresh().catch(() => null);
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

async function submit() {
  errorMessage.value = '';
  successMessage.value = '';
  if (!event.value) {
    errorMessage.value = '报名信息仍在加载，请稍后再试。';
    return;
  }
  if (accountRequired.value && !customer.session.value) {
    errorMessage.value = '本场大会需要先登录，登录后会继续保留当前填写内容。';
    customer.openLogin();
    return;
  }
  if (!registrationAvailable.value) {
    errorMessage.value = '当前大会已暂停报名，请留意后续开放通知。';
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
        mobile: answer('mobile'),
      });
      const contact = entry.email || entry.mobile;
      successMessage.value = `候补申请已提交，你当前位于第 ${entry.position} 位。名额释放后会向 ${contact} 发送两小时有效的报名链接。`;
    } catch (error) {
      errorMessage.value = await registrationError(error, '候补申请提交失败。');
    } finally {
      pending.value = false;
    }
    return;
  }
  if (!preferences.termsAccepted) {
    errorMessage.value = '请阅读并同意报名服务条款和隐私政策。';
    return;
  }

  const input: CreateRegistration = {
    eventId: event.value.id,
    ticketTypeId: selectedTicketId.value,
    attendee: {
      name: answer('name'),
      mobile: answer('mobile'),
      email: answer('email'),
      company: answer('company'),
      title: answer('title'),
      city: answer('city'),
    },
    invoiceRequired: !isFreeTicket.value && preferences.invoiceRequired,
    marketingConsent: preferences.marketingConsent,
    termsAccepted: true,
    formVersion: event.value.registrationForm?.version ?? 1,
    termsVersion: event.value.registrationForm?.termsVersion ?? '2026-07-16',
    formAnswers: Object.fromEntries(
      registrationFields.value.map((field) => [field.key, answer(field.key)]),
    ),
    ...(offerToken.value ? { waitlistOfferToken: offerToken.value } : {}),
  };

  pending.value = true;
  try {
    const checkout = await api.createRegistration(input);
    api.saveCheckout(checkout);
    const freeCheckoutCompleted =
      (checkout.order.amount === 0 || checkout.order.paymentMethod === 'free') &&
      checkout.order.status === 'paid';
    if (checkout.ticket || freeCheckoutCompleted) {
      if (checkout.ticket) api.saveTicket(checkout.ticket);
      await router.push({
        path: `/ticket/${checkout.ticket?.code ?? checkout.registration.id}`,
        query: { event: event.value.slug },
      });
      return;
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
              <div
                v-if="accountRequired"
                class="registration-auth-status"
                :class="{ 'is-verified': Boolean(customer.session.value) }"
              >
                <span aria-hidden="true">{{ customer.session.value ? '✓' : '•' }}</span>
                <p v-if="customer.session.value">
                  手机号已验证：<strong>{{ verifiedMobile }}</strong>
                  。报名手机号可单独填写，不必与登录号相同。
                </p>
                <p v-else>本场大会需要先验证手机号，验证成功后会保留当前填写内容。</p>
                <button v-if="!customer.session.value" type="button" @click="customer.openLogin">
                  登录 / 注册
                </button>
              </div>
              <div class="form-grid">
                <div v-for="field in registrationFields" :key="field.key" class="form-field">
                  <label :for="`registration-${field.key}`">{{ field.label }}<em v-if="field.required">*</em></label>
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
                  />
                </div>
              </div>

              <div class="form-checks">
                <label v-if="!isFreeTicket" class="form-check">
                  <input v-model="preferences.invoiceRequired" type="checkbox" />
                  <span>需要开具发票，支付后可在订单页补充抬头与税号。</span>
                </label>
                <label class="form-check">
                  <input v-model="preferences.marketingConsent" type="checkbox" />
                  <span>同意接收本届大会议程、嘉宾与交通提醒。</span>
                </label>
                <label class="form-check">
                  <input
                    v-model="preferences.termsAccepted"
                    type="checkbox"
                    :required="!joiningWaitlist"
                  />
                  <span>
                    我已阅读并同意《报名服务条款》和《隐私政策》
                    <small v-if="event.registrationForm">（版本 {{ event.registrationForm.termsVersion }}）</small>。
                  </span>
                </label>
              </div>

              <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
              <p v-if="successMessage" class="form-success" role="status">{{ successMessage }}</p>
              <button
                class="flow-action is-full"
                type="submit"
                :disabled="pending || !registrationAvailable"
                style="margin-top: 24px"
              >
                {{
                  pending
                    ? joiningWaitlist
                      ? '正在加入候补…'
                      : isFreeTicket
                        ? '正在确认报名…'
                        : '正在创建订单…'
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
                <span>退改规则</span><strong>{{ isFreeTicket ? '可取消报名' : '7 天内可退' }}</strong>
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
.registration-auth-status {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: 10px;
  align-items: center;
  margin: 0 0 18px;
  padding: 12px 14px;
  border-radius: 8px;
  background: #fff7ed;
  color: #9a3412;
  font-size: 13px;
  line-height: 1.6;
}
.registration-auth-status > span {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: rgb(154 52 18 / 10%);
  font-weight: 760;
}
.registration-auth-status p {
  margin: 0;
}
.registration-auth-status button {
  min-height: 40px;
  padding: 0 12px;
  border-radius: 7px;
  background: #9a3412;
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
  .registration-auth-status {
    grid-template-columns: 24px 1fr;
  }
  .registration-auth-status button {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
