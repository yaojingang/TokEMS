<script setup lang="ts">
import { watch } from 'vue';
import { navigateTo } from '#imports';
import { publicEventHomePath, publicEventScopedPath, type Ticket } from '@conference/contracts';
import QRCode from 'qrcode.vue';
import {
  activeFlowStep,
  enabledFlowSteps,
  hasEnabledEventFlowStep,
  resolveEventExperience,
} from '~/composables/useEventExperience';
import { useCustomerSession } from '~/composables/useCustomerSession';
import { useOrderPayment } from '~/composables/useOrderPayment';
import {
  createRegistrationIntent,
  resolveCheckoutSuccessDestination,
} from '~/utils/purchase-journey';

const route = useRoute();
const api = useConferenceApi();
const customer = useCustomerSession();

const orderId = String(route.params.id);
const checkout = ref<ReturnType<typeof api.readCheckout>>();
const event = api.eventState;
const pending = ref(false);
const pageError = ref('');
const remainingSeconds = ref(15 * 60);
const issuedTicket = ref<Ticket>();
const claimPending = ref(false);
const claimMessage = ref('');
const localSimulationAllowed = ref(false);
const paymentSurface = computed(() => api.isPaymentSurface());
let countdown: ReturnType<typeof setInterval> | undefined;

const memberProfileEnabled = computed(() => hasEnabledEventFlowStep(event.value, 'member-profile'));
const attendeeNeedsEnabled = computed(() => hasEnabledEventFlowStep(event.value, 'attendee-needs'));
const attendeeMaterialsEnabled = computed(
  () => memberProfileEnabled.value || attendeeNeedsEnabled.value,
);

async function goToCompletion(registrationId: string, ticket?: Ticket) {
  const eventSlug = event.value.slug || String(route.query.event ?? '');
  const path = resolveCheckoutSuccessDestination({
    isProxyPurchase: isProxyPurchase.value,
    eventSlug,
    registrationId,
    ticketCode: ticket?.code,
    memberProfileEnabled: memberProfileEnabled.value,
    attendeeNeedsEnabled: attendeeNeedsEnabled.value,
  });
  if (!path) return;
  const destination = api.resolveConferenceUrl(path);
  await navigateTo(destination, { external: /^https?:\/\//i.test(destination) });
}

const payment = useOrderPayment({
  orderId,
  eventSlug: String(route.query.event ?? ''),
  async onPaid(latest) {
    if (latest.isProxyPurchase) return;
    if (!payment.accessToken.value) return;
    const ticket = await api
      .getOrderTicket(latest.id, payment.accessToken.value)
      .catch(() => undefined);
    if (ticket) {
      api.saveTicket(ticket);
      issuedTicket.value = ticket;
    }
    await goToCompletion(latest.registrationId, ticket);
  },
});

const {
  channel: paymentChannel,
  phase: paymentPhase,
  preparing: paymentPreparing,
  launching: paymentLaunching,
  errorMessage: paymentError,
  accessToken: orderAccessToken,
  codeUrl: paymentCodeUrl,
  h5Url: paymentH5Url,
  jsapiParams: paymentJsapiParams,
  order,
  switchOptions,
  canPay: paymentCanPay,
  start: startPayment,
  cleanup: cleanupPayment,
  preparePayment,
  refreshOrderStatus,
  launchPayment,
  switchChannel,
  retry: retryPayment,
} = payment;
const isProxyPurchase = computed(
  () => checkout.value?.isProxyPurchase ?? order.value?.isProxyPurchase ?? false,
);

/**
 * Formats fen amounts as CNY for display.
 *
 * @param amount - Amount in fen
 * @returns Localized currency label
 */
const money = (amount: number) => `¥${(amount / 100).toLocaleString('zh-CN')}`;

/**
 * Syncs the countdown from the order expiry timestamp.
 */
function syncRemainingSeconds() {
  remainingSeconds.value = order.value
    ? Math.max(0, Math.floor((new Date(order.value.expiresAt).getTime() - Date.now()) / 1_000))
    : 0;
}

/**
 * Ensures a one-second countdown interval is running.
 */
function ensureCountdown() {
  syncRemainingSeconds();
  if (!countdown) countdown = setInterval(syncRemainingSeconds, 1_000);
}

watch(
  () => order.value?.expiresAt,
  () => {
    if (
      order.value &&
      !isFreeOrder.value &&
      ['pending_payment', 'processing'].includes(order.value.status)
    ) {
      ensureCountdown();
    }
  },
);

const remainingText = computed(() => {
  const minutes = Math.floor(remainingSeconds.value / 60);
  const seconds = remainingSeconds.value % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
});
const isFreeOrder = computed(
  () => order.value?.amount === 0 || order.value?.paymentMethod === 'free',
);
const awaitingReview = computed(
  () =>
    order.value?.status === 'pending_review' ||
    checkout.value?.registration.status === 'pending_review',
);
const canPay = computed(() => paymentCanPay.value && remainingSeconds.value > 0);
const stateTitle = computed(() => {
  if (awaitingReview.value) return '报名已提交，等待大会审核';
  if (isProxyPurchase.value && order.value?.status === 'paid') return '代购订单已完成';
  if (isProxyPurchase.value && order.value?.status === 'partially_refunded')
    return '代购订单已完成部分退款';
  if (isFreeOrder.value && order.value?.status === 'paid') return '报名已确认，电子票已签发';
  if (order.value?.status === 'paid') return '订单已支付，电子票已签发';
  if (order.value?.status === 'partially_refunded') return '订单已完成部分退款';
  if (order.value?.status === 'refunded') return '订单已完成退款';
  if (order.value?.status === 'closed') return '订单已关闭';
  return '报名已提交，请完成支付';
});
const stateLead = computed(() => {
  if (awaitingReview.value)
    return '运营人员将在后台核对报名信息。审核结果会发送到报名邮箱，通过后即可继续支付或领取免费电子票。';
  if (isProxyPurchase.value && ['paid', 'partially_refunded'].includes(order.value?.status ?? ''))
    return '参会名额已生成，认领邀请已发送给参会人。你可在个人中心继续管理订单或增加名额。';
  if (isFreeOrder.value && order.value?.status === 'paid')
    return '免费报名已经完成，可随时打开电子票并在现场出示二维码签到。';
  if (order.value?.status === 'paid') return '可随时打开电子票，并在现场出示二维码完成签到。';
  if (order.value?.status === 'partially_refunded')
    return '退款进度已同步，剩余有效金额与票务状态以订单记录为准。';
  if (order.value?.status === 'refunded') return '对应电子票已取消，如有疑问请联系大会运营方。';
  if (order.value?.status === 'closed') return '席位保留已结束，请返回报名页重新提交。';
  return '席位已为你临时保留。支付成功后，系统会签发唯一电子票。';
});
const statusLabel = computed(() => {
  if (isFreeOrder.value && order.value?.status === 'paid') return '已确认';
  return {
    pending_review: '待审核',
    pending_payment: '待支付',
    processing: '支付处理中',
    paid: '已支付',
    partially_refunded: '部分退款',
    refunded: '已退款',
    closed: '已关闭',
  }[order.value?.status ?? 'pending_payment'];
});
const paymentMethodLabel = computed(
  () =>
    ({
      wechat: '微信支付',
      alipay: '支付宝',
      bank: '银行转账',
      free: '免费报名',
    })[order.value?.paymentMethod ?? 'wechat'],
);

const ticketHref = computed(() => {
  const ticket = issuedTicket.value ?? checkout.value?.ticket;
  if (!ticket) return '/';
  return publicEventScopedPath(`/ticket/${encodeURIComponent(ticket.code)}`, event.value.slug);
});

const showcaseHref = computed(() =>
  publicEventScopedPath(
    `/account/registrations/${encodeURIComponent(order.value?.registrationId ?? checkout.value?.registration.id ?? '')}/showcase`,
    event.value.slug,
  ),
);

const needsHref = computed(() =>
  publicEventScopedPath(
    `/account/registrations/${encodeURIComponent(order.value?.registrationId ?? checkout.value?.registration.id ?? '')}/needs`,
    event.value.slug,
  ),
);

const attendeeMaterialHref = computed(() =>
  memberProfileEnabled.value ? showcaseHref.value : needsHref.value,
);

const registerHref = computed(() => {
  const path = publicEventScopedPath('/register', event.value.slug);
  return api.resolveConferenceUrl(path);
});

const conferenceHomeHref = computed(() =>
  api.resolveConferenceUrl(publicEventHomePath(event.value.slug)),
);

const accountClaimHref = computed(() => {
  const path = publicEventScopedPath('/account', event.value.slug);
  return api.resolveConferenceUrl(path);
});

async function continueForOther() {
  const path = publicEventScopedPath('/register', event.value.slug, {
    intent: createRegistrationIntent(),
    purchaseFor: 'other',
  });
  const destination = api.resolveConferenceUrl(path);
  await navigateTo(destination, { external: /^https?:\/\//i.test(destination) });
}

const flowSteps = computed(() =>
  enabledFlowSteps(event.value, {
    paymentRequired: !isFreeOrder.value,
    invoiceRequired: Boolean(checkout.value?.registration && api.readInvoiceAccess()),
  }),
);
const activeStep = computed(() =>
  activeFlowStep(
    flowSteps.value,
    isFreeOrder.value && order.value?.status === 'paid' ? 'success-ticket' : 'review-payment',
  ),
);

const paymentHint = computed(() => {
  if (paymentPhase.value === 'authorizing') return '正在获取微信授权，请稍候…';
  if (paymentChannel.value === 'jsapi') return '请在微信内完成支付。取消后可重新发起。';
  if (paymentChannel.value === 'h5') return '将跳转到微信支付收银台。完成后请返回本页查看结果。';
  return '请使用微信扫描二维码完成支付。';
});

const displayError = computed(() => pageError.value || paymentError.value);

useHead(() => ({
  title: `${isFreeOrder.value ? '报名确认' : '确认订单'} · ${event.value.name}`,
  meta: [
    { name: 'referrer', content: 'no-referrer' },
    { 'http-equiv': 'Cache-Control', content: 'no-store' },
  ],
}));

onMounted(async () => {
  try {
    checkout.value = api.readCheckout();
    issuedTicket.value = checkout.value?.isProxyPurchase ? undefined : checkout.value?.ticket;
    if (!paymentSurface.value) {
      await customer.refresh().catch(() => null);
    }
    const eventSlug = String(route.query.event ?? '');
    if (eventSlug) event.value = await api.getEvent(eventSlug);
    await startPayment({ localSimulationAllowed: true });
    if (
      orderAccessToken.value &&
      order.value &&
      ['pending_payment', 'processing'].includes(order.value.status)
    ) {
      localSimulationAllowed.value = await api
        .localPaymentSimulationCapability(order.value.id, orderAccessToken.value)
        .then((result) => result.allowed)
        .catch(() => false);
      if (!localSimulationAllowed.value) {
        await preparePayment({ userInitiated: false });
      }
    }
    if (
      orderAccessToken.value &&
      !isProxyPurchase.value &&
      ['paid', 'partially_refunded'].includes(order.value?.status ?? '') &&
      !issuedTicket.value
    ) {
      issuedTicket.value = await api
        .getOrderTicket(orderId, orderAccessToken.value)
        .catch(() => undefined);
    }
    if (
      order.value &&
      !isFreeOrder.value &&
      ['pending_payment', 'processing'].includes(order.value.status)
    ) {
      ensureCountdown();
    }
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '订单读取失败，请稍后重试。';
  }
});

onBeforeUnmount(() => {
  if (countdown) clearInterval(countdown);
  cleanupPayment();
});

/**
 * Claims the registration into the signed-in customer account.
 */
async function claimRegistration() {
  if (!order.value || !orderAccessToken.value) return;
  if (!customer.session.value) {
    customer.openLogin();
    return;
  }
  claimPending.value = true;
  claimMessage.value = '';
  try {
    await customer.claimRegistration(order.value.id, orderAccessToken.value);
    claimMessage.value = '这条报名已保存到用户中心';
  } catch (error) {
    const value = error as { data?: { message?: string } };
    pageError.value = value.data?.message ?? '报名记录保存失败';
  } finally {
    claimPending.value = false;
  }
}

/**
 * Reloads the order and retries payment prepare when still awaiting payment.
 */
async function retryOrder() {
  pageError.value = '';
  await retryPayment();
  ensureCountdown();
}

/**
 * Confirms payment via the local simulation endpoint (development only).
 */
async function confirmPaymentSimulation() {
  if (!order.value) return;
  pending.value = true;
  pageError.value = '';
  try {
    if (!orderAccessToken.value) throw new Error('订单访问凭证缺失，请重新进入支付页面');
    const result = await api.confirmPayment(
      order.value,
      order.value.registrationId,
      orderAccessToken.value,
    );
    if (!isProxyPurchase.value && result.ticket) {
      api.saveTicket(result.ticket);
      issuedTicket.value = result.ticket;
    }
    if (result.invoice) api.saveInvoiceAccess(result.invoice);
    if (!isProxyPurchase.value && result.ticket) {
      await goToCompletion(result.order.registrationId, result.ticket);
    }
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '支付确认失败，请稍后重试。';
  } finally {
    pending.value = false;
  }
}

/**
 * Returns a short label for a manual channel switch option.
 *
 * @param channel - Target payment channel
 * @returns Button label
 */
function switchChannelLabel(channel: string) {
  if (channel === 'h5') return '在本机打开微信支付';
  if (channel === 'native') return '改用扫码支付';
  return '切换支付方式';
}
</script>

<template>
  <div class="flow-page">
    <FlowHeader />
    <main class="flow-shell" id="main-content">
      <div class="state-panel">
        <div class="state-icon" aria-hidden="true">
          {{ order?.status === 'closed' ? '!' : awaitingReview ? '…' : '✓' }}
        </div>
        <p class="flow-eyebrow" style="justify-content: center">
          {{ isFreeOrder ? 'REGISTRATION' : 'ORDER' }} / {{ statusLabel }}
        </p>
        <h1>{{ stateTitle }}</h1>
        <p>{{ stateLead }}</p>
      </div>
      <FlowStepper
        :active="activeStep"
        :payment-required="!isFreeOrder"
        :steps="flowSteps.map((step) => step.title)"
        :variant="resolveEventExperience(event).registrationFlow.progressVariant"
      />

      <div v-if="order" class="flow-card order-card">
        <section class="order-details">
          <h2>{{ isFreeOrder ? '报名明细' : '订单明细' }}</h2>
          <div class="summary-row">
            <span>订单编号</span><strong>{{ order.orderNo }}</strong>
          </div>
          <div class="summary-row">
            <span>大会</span><strong>{{ event.name }}</strong>
          </div>
          <div class="summary-row">
            <span>参会人</span><strong>{{ checkout?.registration.attendee.name ?? '待查询' }}</strong>
          </div>
          <div class="summary-row">
            <span>公司 / 组织</span>
            <strong>{{ checkout?.registration.attendee.company ?? '待查询' }}</strong>
          </div>
          <div class="summary-row">
            <span>票种</span><strong>{{ checkout?.registration.ticketType.name ?? '大会门票' }}</strong>
          </div>
          <div class="summary-row">
            <span>{{ isFreeOrder ? '报名方式' : '支付方式' }}</span>
            <strong>{{ paymentMethodLabel }}</strong>
          </div>
          <div class="summary-row is-total">
            <span>{{ isFreeOrder ? '报名费用' : '应付金额' }}</span>
            <strong>{{ isFreeOrder ? '免费' : money(order.amount) }}</strong>
          </div>
          <p v-if="displayError && !canPay" class="form-error" role="alert">{{ displayError }}</p>
          <div
            v-if="orderAccessToken && !paymentSurface && !isProxyPurchase"
            class="order-account-link"
          >
            <p v-if="claimMessage" class="form-success" role="status">{{ claimMessage }}</p>
            <button
              class="flow-action is-secondary"
              type="button"
              :disabled="claimPending"
              @click="claimRegistration"
            >
              {{
                customer.session.value
                  ? claimPending
                    ? '正在保存…'
                    : '保存到用户中心'
                  : '登录并保存到用户中心'
              }}
            </button>
          </div>
          <div v-else-if="orderAccessToken && paymentSurface" class="order-account-link">
            <a class="flow-action is-secondary" :href="accountClaimHref">返回大会后登录并保存</a>
          </div>
        </section>
        <aside class="order-payment">
          <template v-if="awaitingReview">
            <p>审核期间无需付款，请留意报名邮箱中的结果通知。</p>
            <a class="flow-action is-secondary is-full" :href="conferenceHomeHref">返回大会首页</a>
          </template>
          <template
            v-else-if="isProxyPurchase && ['paid', 'partially_refunded'].includes(order.status)"
          >
            <p>认领邀请已发送给参会人。电子票与参会名片将在对方认领后归入其账户。</p>
            <a class="flow-action is-full" :href="`${accountClaimHref}#purchases`">
              管理购买订单
            </a>
            <button
              v-if="event.registration.additionalPurchaseEnabled"
              class="flow-action is-secondary is-full"
              type="button"
              @click="continueForOther"
            >
              继续为他人购票
            </button>
          </template>
          <template v-else-if="isFreeOrder && order.status === 'paid'">
            <p v-if="attendeeMaterialsEnabled">
              席位已确认。接下来可以完善参会资料，并提交希望通过大会解决的问题。
            </p>
            <p v-else>席位已确认，可继续查看电子票与参会安排。</p>
            <NuxtLink
              v-if="attendeeMaterialsEnabled"
              class="flow-action is-full"
              :to="attendeeMaterialHref"
            >
              {{ memberProfileEnabled ? '完善个人信息' : '提交参会需求' }}
            </NuxtLink>
            <NuxtLink class="flow-action is-secondary is-full" :to="ticketHref">
              {{ attendeeMaterialsEnabled ? '稍后填写，先看电子票' : '查看电子票' }}
            </NuxtLink>
            <button
              v-if="event.registration.additionalPurchaseEnabled"
              class="flow-action is-secondary is-full"
              type="button"
              @click="continueForOther"
            >
              继续为他人购票
            </button>
          </template>
          <template v-else-if="order.status === 'pending_payment' || order.status === 'processing'">
            <div
              v-if="!localSimulationAllowed && (paymentPreparing || paymentPhase === 'authorizing')"
              class="payment-status-note"
              role="status"
              :aria-label="paymentPhase === 'authorizing' ? '正在获取微信授权' : '正在准备支付'"
            >
              {{ paymentPhase === 'authorizing' ? '正在获取微信授权…' : '正在准备支付…' }}
            </div>
            <QRCode
              v-else-if="!localSimulationAllowed && paymentChannel === 'native' && paymentCodeUrl"
              class="payment-qr"
              :value="paymentCodeUrl"
              :size="144"
              level="M"
              render-as="svg"
              aria-label="微信支付二维码"
            />

            <p>
              {{
                localSimulationAllowed
                  ? '姚金刚的本机测试账户已授权，可直接确认模拟支付。'
                  : paymentHint
              }}
            </p>
            <p>
              请在
              <strong style="color: var(--conference-red)">{{ remainingText }}</strong> 内完成支付
            </p>

            <p
              v-if="!localSimulationAllowed && paymentError"
              class="form-error payment-prepare-error"
              role="alert"
            >
              {{ paymentError }}
            </p>

            <button
              v-if="!localSimulationAllowed && paymentChannel === 'jsapi' && paymentJsapiParams"
              class="flow-action is-full"
              type="button"
              :disabled="!canPay || paymentLaunching || paymentPreparing"
              @click="launchPayment()"
            >
              {{ paymentLaunching ? '正在调起微信支付…' : '微信支付' }}
            </button>

            <button
              v-else-if="
                !localSimulationAllowed &&
                  paymentChannel === 'jsapi' &&
                  paymentPhase === 'authorizing'
              "
              class="flow-action is-full"
              type="button"
              disabled
            >
              正在获取微信授权…
            </button>

            <button
              v-else-if="!localSimulationAllowed && paymentChannel === 'jsapi'"
              class="flow-action is-full"
              type="button"
              :disabled="!canPay || paymentPreparing"
              @click="preparePayment({ userInitiated: true })"
            >
              {{ paymentPreparing ? '正在准备…' : '准备微信支付' }}
            </button>

            <button
              v-else-if="!localSimulationAllowed && paymentChannel === 'h5'"
              class="flow-action is-full"
              type="button"
              :disabled="!canPay || paymentLaunching || paymentPreparing"
              @click="launchPayment()"
            >
              {{
                paymentLaunching
                  ? '正在跳转…'
                  : paymentH5Url
                    ? '打开微信支付'
                    : '准备并打开微信支付'
              }}
            </button>

            <button
              v-if="
                !localSimulationAllowed &&
                  (paymentError ||
                    (paymentChannel === 'native' && !paymentCodeUrl && !paymentPreparing))
              "
              class="flow-action is-secondary is-full"
              type="button"
              :disabled="!canPay || paymentPreparing"
              @click="preparePayment({ userInitiated: true })"
            >
              重新尝试支付
            </button>

            <button
              v-if="!localSimulationAllowed"
              class="flow-action is-full"
              type="button"
              :disabled="paymentPreparing || !canPay"
              style="margin-top: 8px"
              @click="refreshOrderStatus({ sync: true })"
            >
              我已完成支付
            </button>

            <div
              v-for="option in localSimulationAllowed ? [] : switchOptions"
              :key="option"
              class="payment-channel-switch"
            >
              <button
                class="flow-action is-secondary is-full"
                type="button"
                :disabled="!canPay || paymentPreparing"
                @click="switchChannel(option)"
              >
                {{ switchChannelLabel(option) }}
              </button>
            </div>

            <button
              v-if="localSimulationAllowed"
              class="flow-action is-full"
              type="button"
              :disabled="pending || !canPay"
              style="margin-top: 8px"
              @click="confirmPaymentSimulation"
            >
              {{ pending ? '正在确认支付…' : '确认并模拟支付成功' }}
            </button>

            <a
              class="flow-action is-secondary is-full"
              :href="registerHref"
              style="margin-top: 8px"
            >
              返回修改信息
            </a>
          </template>
          <template v-else-if="['paid', 'partially_refunded'].includes(order.status)">
            <p v-if="attendeeMaterialsEnabled">
              {{ statusLabel }}。下一步可完善参会资料，提交希望通过大会解决的问题。
            </p>
            <p v-else>{{ statusLabel }}。可继续查看电子票与参会安排。</p>
            <NuxtLink
              v-if="attendeeMaterialsEnabled"
              class="flow-action is-full"
              :to="attendeeMaterialHref"
            >
              {{ memberProfileEnabled ? '完善个人信息' : '提交参会需求' }}
            </NuxtLink>
            <NuxtLink class="flow-action is-secondary is-full" :to="ticketHref">
              {{ attendeeMaterialsEnabled ? '稍后填写，先看电子票' : '查看电子票' }}
            </NuxtLink>
            <button
              v-if="event.registration.additionalPurchaseEnabled"
              class="flow-action is-secondary is-full"
              type="button"
              @click="continueForOther"
            >
              继续为他人购票
            </button>
          </template>
          <template v-else>
            <p>{{ stateLead }}</p>
            <a class="flow-action is-secondary is-full" :href="registerHref">重新报名</a>
          </template>
        </aside>
      </div>

      <div v-else class="flow-card flow-card__body" style="text-align: center">
        <template v-if="displayError">
          <p class="form-error" role="alert">{{ displayError }}</p>
          <button class="flow-action" type="button" @click="retryOrder">重新读取订单</button>
        </template>
        <p v-else>正在读取订单…</p>
      </div>
    </main>
  </div>
</template>
