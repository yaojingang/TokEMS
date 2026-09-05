<script setup lang="ts">
import { watch } from 'vue';
import type {
  RefundContext,
  RefundApplicationView,
  CustomerRefundApplication,
} from '@conference/contracts';
import { useCustomerSession } from '~/composables/useCustomerSession';

const route = useRoute();
const customer = useCustomerSession();
const orderId = computed(() => String(route.params.orderId));
const context = ref<RefundContext | null>(null);
const loading = ref(true);
const pending = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const reason = ref('');
const acknowledged = ref(false);
const key = ref('');
const submittedInput = ref<CustomerRefundApplication | null>(null);
const active = computed(() =>
  context.value?.applications.find(
    (row) =>
      ['pending_review', 'approved'].includes(row.reviewStatus) &&
      row.fulfillmentStatus !== 'completed',
  ),
);
const latest = computed(() => active.value ?? context.value?.applications[0]);
let timer: ReturnType<typeof setInterval> | undefined;
let contextVersion = 0;
const money = (amount: number) => `¥${(amount / 100).toFixed(2)}`;
const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Shanghai',
      }).format(new Date(value))
    : '';

function status(row: RefundApplicationView) {
  if (row.reviewStatus === 'withdrawn') return '申请已撤回';
  if (row.reviewStatus === 'rejected') return '申请未通过';
  if (row.fulfillmentStatus === 'completed') return '退款成功';
  if (row.reviewStatus === 'pending_review') return '等待管理员审核';
  if (row.executionStatus === 'processing') return '微信支付处理中';
  return row.fulfillmentStatus === 'manual_required'
    ? '主办方正在处理退款'
    : '退款已通过，正在安排退款';
}
async function refresh() {
  const version = ++contextVersion;
  const requestedOrder = orderId.value;
  const requestedCustomer = customer.session.value?.customer.id;
  const next = await customer.refundContext(requestedOrder);
  if (
    version === contextVersion &&
    requestedOrder === orderId.value &&
    requestedCustomer === customer.session.value?.customer.id
  )
    context.value = next;
}
async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    await customer.refresh();
    if (!customer.session.value) {
      customer.openLogin();
      return;
    }
    await refresh();
  } catch (error) {
    errorMessage.value =
      (error as { data?: { message?: string } }).data?.message ?? '退款信息加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}
async function submit() {
  if (
    !context.value?.eligible ||
    context.value.orderId !== orderId.value ||
    pending.value ||
    !acknowledged.value
  )
    return;
  contextVersion += 1;
  pending.value = true;
  errorMessage.value = '';
  key.value ||= crypto.randomUUID();
  submittedInput.value ??= {
    amount: context.value.refundableAmount,
    policyVersion: context.value.policyVersion,
    reason: reason.value,
  };
  try {
    await customer.applyRefund(orderId.value, submittedInput.value, key.value);
    key.value = '';
    submittedInput.value = null;
    successMessage.value = '退款申请已提交，你可以随时回来查看进度。';
    await refresh();
  } catch (error) {
    errorMessage.value =
      (error as { data?: { message?: string } }).data?.message ??
      '暂未确认提交结果，请刷新查看进度后重试';
    await refresh().catch(() => undefined);
    if (
      active.value ||
      (error as { statusCode?: number }).statusCode === 409 ||
      (error as { statusCode?: number }).statusCode === 400
    ) {
      key.value = '';
      submittedInput.value = null;
    }
  } finally {
    pending.value = false;
  }
}
async function withdraw() {
  if (!active.value || pending.value || !window.confirm('确认撤回这次退款申请？')) return;
  contextVersion += 1;
  pending.value = true;
  errorMessage.value = '';
  try {
    await customer.withdrawRefund(active.value.id, active.value.version, crypto.randomUUID());
    key.value = '';
    submittedInput.value = null;
    acknowledged.value = false;
    successMessage.value = '退款申请已撤回。';
    await refresh();
  } catch (error) {
    errorMessage.value =
      (error as { data?: { message?: string } }).data?.message ?? '撤回未完成，请刷新查看最新状态';
    await refresh().catch(() => undefined);
  } finally {
    pending.value = false;
  }
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (active.value && !pending.value && document.visibilityState === 'visible')
      void refresh().catch(() => undefined);
  }, 15_000);
});
onBeforeUnmount(() => {
  contextVersion += 1;
  if (timer) clearInterval(timer);
});
watch(
  () => customer.session.value?.customer.id,
  () => {
    if (customer.session.value) void load();
    else {
      contextVersion += 1;
      context.value = null;
    }
  },
);
watch(orderId, () => {
  contextVersion += 1;
  successMessage.value = '';
  context.value = null;
  key.value = '';
  submittedInput.value = null;
  reason.value = '';
  acknowledged.value = false;
  void load();
});
useHead({ title: '申请退款 · 个人中心', meta: [{ name: 'robots', content: 'noindex, nofollow' }] });
</script>

<template>
  <div class="refund-page">
    <FlowHeader />
    <main id="main-content" class="refund-shell">
      <NuxtLink class="back" to="/account#purchases">← 返回个人中心</NuxtLink>
      <header class="refund-heading">
        <span>订单售后</span>
        <h1>{{ latest ? '退款进度' : '申请退款' }}</h1>
        <p>审核通过后，款项将退回原交易的实际付款账户。</p>
      </header>
      <p v-if="errorMessage" class="notice error" role="alert">
        {{ errorMessage }} <button type="button" @click="load">刷新状态</button>
      </p>
      <p v-if="successMessage" class="notice" role="status">{{ successMessage }}</p>
      <p v-if="loading" role="status">正在读取订单信息…</p>
      <section v-else-if="!customer.session.value" class="surface">
        <h2>登录后查看退款</h2>
        <p>请使用购票时的账号登录。</p>
        <button class="primary" type="button" @click="customer.openLogin">登录个人中心</button>
      </section>
      <template v-else-if="context">
        <section class="surface order-summary" aria-labelledby="refund-order-title">
          <div>
            <span class="eyebrow">{{ context.ticketName }}</span>
            <h2 id="refund-order-title">{{ context.eventName }}</h2>
            <p class="order-no">订单 {{ context.orderNo }}</p>
            <p>参会人：{{ context.attendeeName }} · {{ context.paymentMethod }}原路退回</p>
          </div>
          <dl>
            <div>
              <dt>原交易金额</dt>
              <dd>{{ money(context.paidAmount) }}</dd>
            </div>
            <div v-if="context.payerTotal !== null">
              <dt>原交易现金实付</dt>
              <dd>{{ money(context.payerTotal) }}</dd>
            </div>
            <div>
              <dt>已退金额</dt>
              <dd>{{ money(context.refundedAmount) }}</dd>
            </div>
            <div class="amount">
              <dt>{{ latest ? '申请退款金额' : '本次退款金额' }}</dt>
              <dd>{{ money(latest?.amount ?? context.refundableAmount) }}</dd>
            </div>
          </dl>
        </section>
        <section
          v-if="latest"
          class="surface progress"
          aria-labelledby="refund-status-title"
          aria-live="polite"
        >
          <span class="eyebrow">处理进度</span>
          <h2 id="refund-status-title">{{ status(latest) }}</h2>
          <p v-if="latest.completedAmount > 0">
            已确认退款总额 {{ money(latest.completedAmount) }}；
            {{
              latest.payerRefund === null
                ? '现金退款金额待渠道核验'
                : `其中现金退款 ${money(latest.payerRefund)}`
            }}；
            {{
              latest.discountRefund === null
                ? '优惠退还金额待渠道核验'
                : `优惠退还 ${money(latest.discountRefund)}`
            }}。
          </p>
          <ol>
            <li>
              <strong>提交申请</strong><span>{{ date(latest.createdAt) }}</span>
            </li>
            <li :class="{ muted: !latest.reviewedAt }">
              <strong>{{ latest.reviewStatus === 'rejected' ? '审核未通过' : '管理员审核' }}</strong><span>{{ date(latest.reviewedAt) || '通常在 24 小时内处理' }}</span>
            </li>
            <li :class="{ muted: !latest.completedAt }">
              <strong>退款完成</strong><span>{{ date(latest.completedAt) || '以微信支付及银行实际处理结果为准' }}</span>
            </li>
          </ol>
          <p v-if="latest.reviewReason" class="notice">处理说明：{{ latest.reviewReason }}</p>
          <p v-if="latest.payerRefund !== null">
            已确认现金退款 {{ money(latest.payerRefund) }}，优惠部分按微信支付规则处理。
          </p>
          <p v-if="latest.reviewStatus === 'approved' && latest.fulfillmentStatus !== 'completed'">
            退款会持续处理，无需重新申请。{{
              latest.fullRefund ? '本张票券已暂停使用。' : ''
            }}如需了解异常处理进度，请联系主办方。
          </p>
          <div class="actions">
            <button
              v-if="active?.reviewStatus === 'pending_review'"
              :disabled="pending"
              type="button"
              @click="withdraw"
            >
              {{ pending ? '处理中…' : '撤回申请' }}
            </button><button type="button" :disabled="pending" @click="load">刷新进度</button>
          </div>
        </section>
        <form v-if="context.eligible" class="surface" @submit.prevent="submit">
          <h2>{{ latest ? '重新申请退款' : '确认退款申请' }}</h2>
          <p>
            购票后 7 天内可申请无理由退款。申请提交后由管理员审核，全额退款审核通过后暂停票券使用。
          </p>
          <p v-if="context.deadline">申请截止：{{ date(context.deadline) }}</p>
          <label class="reason"><span>退款说明 <small>选填</small></span><textarea
            v-model="reason"
            rows="3"
            maxlength="1000"
            :disabled="pending"
            placeholder="可补充需要主办方了解的信息"
          />
          </label>
          <label class="ack"><input v-model="acknowledged" type="checkbox" :disabled="pending" /><span>我已了解：审核期间票券仍可使用，使用后将影响全额退款审核；审核通过后票券暂停使用，退款退回原付款账户。</span></label>
          <button class="primary" type="submit" :disabled="pending || !acknowledged">
            {{ pending ? '正在提交…' : `提交 ${money(context.refundableAmount)} 退款申请` }}
          </button>
        </form>
        <p v-else-if="!active" class="notice">{{ context.blockedReason }}</p>
        <aside class="refund-help">
          <h2>到账说明</h2>
          <p>
            无需提供银行卡或微信号。实际付款人与购票账号不同时，退款仍退回实际付款人。含微信优惠的订单，现金退款与优惠退还金额以渠道确认为准。
          </p>
          <p>
            审核通过后自动发起退款，等待资金时系统会继续跟进。银行卡通常需要 1 至 3
            个工作日，实际到账以微信支付及银行处理为准。
          </p>
        </aside>
      </template>
    </main>
  </div>
</template>

<style scoped>
.refund-page {
  min-height: 100vh;
  background: #f4f5f7;
  color: #17191d;
}
.refund-shell {
  width: min(100% - 40px, 820px);
  margin-inline: auto;
  padding: 32px 0 80px;
}
.back {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  color: #555f6b;
  text-decoration: none;
}
.refund-heading {
  margin: 20px 0 28px;
}
.refund-heading > span,
.eyebrow {
  color: #52657c;
  font-size: 13px;
  font-weight: 700;
}
h1 {
  font-size: clamp(28px, 5vw, 40px);
  margin: 10px 0;
  letter-spacing: -0.025em;
}
h2 {
  font-size: 21px;
  margin: 10px 0;
}
p {
  line-height: 1.7;
  color: #535c68;
}
.surface {
  background: #fff;
  border: 1px solid #dfe3e9;
  border-radius: 12px;
  padding: 28px;
  margin-bottom: 20px;
}
.order-no {
  font-size: 13px;
  overflow-wrap: anywhere;
}
dl {
  margin: 24px 0 0;
}
dl > div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid #eceef2;
}
dt {
  color: #596472;
}
dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}
.amount dd {
  color: var(--conference-primary, #244d7c);
  font-size: 26px;
}
ol {
  padding-left: 24px;
  margin: 24px 0;
}
li {
  padding: 0 0 22px 8px;
}
li span {
  display: block;
  font-size: 13px;
  margin-top: 5px;
  color: #53616f;
}
.muted {
  color: #657182;
}
.reason {
  display: grid;
  gap: 10px;
  margin-top: 24px;
}
small {
  color: #617082;
  font-weight: normal;
  margin-left: 6px;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid #bec7d2;
  border-radius: 6px;
  padding: 12px;
  font: inherit;
}
.ack {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin: 22px 0;
  line-height: 1.7;
  font-size: 14px;
}
.ack input {
  width: 19px;
  height: 19px;
  flex-shrink: 0;
  margin-top: 3px;
}
button {
  min-height: 44px;
  padding: 10px 18px;
  border: 1px solid #bac5d1;
  border-radius: 6px;
  background: #fff;
  color: #263b52;
  font: inherit;
  cursor: pointer;
}
button:active {
  transform: translateY(1px);
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
button:focus-visible,
textarea:focus-visible,
input:focus-visible {
  outline: 3px solid #82aada;
  outline-offset: 3px;
}
.primary {
  background: var(--conference-primary, #244d7c);
  border-color: transparent;
  color: #fff;
  font-weight: 700;
}
.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.notice {
  padding: 16px;
  border-radius: 6px;
  background: #edf3f8;
  line-height: 1.6;
}
.notice.error {
  background: #fff0ee;
  color: #8c3028;
}
.refund-help {
  padding: 8px 4px;
}
.refund-help h2 {
  font-size: 16px;
}
.refund-help p {
  font-size: 14px;
}
@media (max-width: 540px) {
  .refund-shell {
    width: calc(100% - 24px);
    padding-top: 20px;
  }
  .surface {
    padding: 20px;
  }
  .primary {
    width: 100%;
  }
}
</style>
