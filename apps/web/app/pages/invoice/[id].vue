<script setup lang="ts">
import { isCustomerInvoiceEditableStatus, type SubmitInvoiceDetails } from '@conference/contracts';
import { watch } from 'vue';
import {
  activeFlowStep,
  enabledFlowSteps,
  resolveEventExperience,
} from '~/composables/useEventExperience';

const route = useRoute();
const api = useConferenceApi();
const event = api.eventState;
const access = ref(api.readInvoiceAccess(String(route.params.id)));
const checkout = ref(api.readCheckout());
const orderId = ref(checkout.value?.order.id ?? '');
const pending = ref(false);
const completed = ref(false);
const errorMessage = ref('');
const recoveryMessage = ref('');
const invoiceDetail = ref<{
  status: string;
  requestNo: string;
  rejectionReason?: string | null;
  documents: Array<{
    id: string;
    invoiceNumber: string;
    mediaType: string;
    downloadUrl?: string | null;
  }>;
}>();
const recovery = reactive({
  orderNo: checkout.value?.order.orderNo ?? '',
  email: checkout.value?.registration.attendee.email ?? '',
});
const form = reactive({
  buyerType: 'company' as 'individual' | 'company',
  title: '',
  taxId: '',
  email: checkout.value?.registration.attendee.email ?? '',
  mobile: checkout.value?.registration.attendee.mobile ?? '',
  content: '会务费',
});
const flowSteps = computed(() =>
  enabledFlowSteps(event.value, { paymentRequired: true, invoiceRequired: true }),
);
const editableStatus = computed(
  () =>
    !invoiceDetail.value ||
    isCustomerInvoiceEditableStatus(
      invoiceDetail.value.status as Parameters<typeof isCustomerInvoiceEditableStatus>[0],
    ),
);
const statusLabel = computed(
  () =>
    ({
      awaiting_details: '待补充资料',
      pending_review: '待财务审核',
      issuing: '正在开具',
      issue_failed: '开具失败',
      issued: '已开具',
      rejected: '资料被驳回',
      adjustment_required: '退款后待调整',
      voided: '已作废',
      cancelled: '已取消',
    })[invoiceDetail.value?.status ?? 'awaiting_details'] ?? '处理中',
);
const activeStep = computed(() => activeFlowStep(flowSteps.value, 'invoice-details'));
const ticketHref = computed(() => {
  const ticket = api.readTicket(checkout.value?.registration.id ?? '');
  const identifier = ticket?.code ?? checkout.value?.registration.id ?? '';
  return identifier
    ? `/ticket/${encodeURIComponent(identifier)}?event=${encodeURIComponent(event.value.slug)}`
    : `/?event=${encodeURIComponent(event.value.slug)}`;
});

useHead(() => ({
  title: `填写发票信息 · ${event.value.name}`,
  meta: [{ name: 'robots', content: 'noindex,nofollow' }],
}));

onMounted(async () => {
  const currentUrl = new URL(window.location.href);
  const query = currentUrl.searchParams;
  const eventSlug = query.get('event') ?? '';
  if (eventSlug) event.value = await api.getEvent(eventSlug);
  orderId.value = query.get('order') ?? checkout.value?.order.id ?? '';
  const token =
    new URLSearchParams(currentUrl.hash.slice(1)).get('token') ?? query.get('token') ?? '';
  if (token) {
    query.delete('token');
    currentUrl.hash = '';
    currentUrl.search = query.toString();
    window.history.replaceState({}, '', `${currentUrl.pathname}${currentUrl.search}`);
  }
  if (token && orderId.value) {
    try {
      const detail = await api.getOrderInvoice(orderId.value, token);
      invoiceDetail.value = detail as typeof invoiceDetail.value;
      access.value = {
        id: String(detail.id ?? route.params.id),
        requestNo: String(detail.requestNo ?? '发票申请'),
        status: 'awaiting_details',
        accessToken: token,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
      api.saveInvoiceAccess(access.value);
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '发票访问链接无效或已经过期。';
    }
  }
});

watch(
  () => form.buyerType,
  (buyerType) => {
    if (buyerType === 'individual') form.taxId = '';
  },
);

async function submit() {
  if (!access.value || !orderId.value) {
    errorMessage.value = '发票填写凭证不存在或已被清除，请通过支付成功通知重新进入。';
    return;
  }
  if (new Date(access.value.expiresAt).getTime() <= Date.now()) {
    errorMessage.value = '发票填写链接已过期，请联系大会运营方重新发送。';
    return;
  }
  errorMessage.value = '';
  pending.value = true;
  try {
    const input: SubmitInvoiceDetails = {
      buyerType: form.buyerType,
      title: form.title.trim(),
      taxId: form.taxId.trim(),
      email: form.email.trim(),
      mobile: form.mobile.trim(),
      content: form.content.trim(),
      accessToken: access.value.accessToken,
    };
    await api.submitOrderInvoice(orderId.value, input);
    completed.value = true;
    api.clearInvoiceAccess();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发票信息提交失败，请稍后重试。';
  } finally {
    pending.value = false;
  }
}

async function requestNewLink() {
  pending.value = true;
  errorMessage.value = '';
  recoveryMessage.value = '';
  try {
    const result = await api.requestOrderAccessLink(recovery.orderNo.trim(), recovery.email.trim());
    recoveryMessage.value = result.message;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '访问链接申请失败，请稍后重试。';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="flow-page">
    <FlowHeader />
    <main id="main-content" class="flow-shell invoice-flow-shell">
      <p class="flow-eyebrow">INVOICE DETAILS</p>
      <h1 class="flow-title">{{ completed ? '发票信息已提交' : '补充发票信息' }}</h1>
      <p class="flow-lead">
        {{
          completed
            ? '财务审核后将完成开具，并发送到你填写的邮箱。'
            : `申请编号 ${access?.requestNo ?? '待读取'}。请核对抬头、税号与接收邮箱。`
        }}
      </p>
      <FlowStepper
        :active="activeStep"
        :steps="flowSteps.map((step) => step.title)"
        :variant="resolveEventExperience(event).registrationFlow.progressVariant"
      />

      <div v-if="completed" class="flow-card invoice-complete-card">
        <div class="state-icon" aria-hidden="true">✓</div>
        <h2>提交成功</h2>
        <p>申请进入“待审核”状态。运营人员可在后台完成审核、开具、发送及后续作废处理。</p>
        <NuxtLink class="flow-action" :to="ticketHref">继续查看电子票</NuxtLink>
      </div>

      <div v-else-if="invoiceDetail && !editableStatus" class="flow-card invoice-status-card">
        <header>
          <div>
            <small>申请编号 {{ invoiceDetail.requestNo }}</small>
            <h2>{{ statusLabel }}</h2>
          </div>
          <span class="invoice-public-status">{{ statusLabel }}</span>
        </header>
        <p v-if="invoiceDetail.rejectionReason">{{ invoiceDetail.rejectionReason }}</p>
        <div v-if="invoiceDetail.documents.length" class="invoice-public-documents">
          <a
            v-for="document in invoiceDetail.documents"
            :key="document.id"
            class="flow-action is-secondary"
            :href="document.downloadUrl ? api.invoiceDownloadUrl(document.downloadUrl) : undefined"
          >
            下载发票 {{ document.invoiceNumber }}
          </a>
        </div>
        <NuxtLink class="flow-action" :to="ticketHref">查看电子票</NuxtLink>
      </div>

      <form v-else-if="access" class="flow-card invoice-form-card" @submit.prevent="submit">
        <div class="flow-card__head">
          <h2>购方与接收信息</h2>
          <p>企业发票需填写统一社会信用代码。提交后如需修改，请联系大会运营方。</p>
        </div>
        <div class="flow-card__body">
          <fieldset class="invoice-buyer-types">
            <legend>抬头类型</legend>
            <label :class="{ 'is-selected': form.buyerType === 'company' }">
              <input v-model="form.buyerType" type="radio" value="company" />
              <span>企业</span>
            </label>
            <label :class="{ 'is-selected': form.buyerType === 'individual' }">
              <input v-model="form.buyerType" type="radio" value="individual" />
              <span>个人</span>
            </label>
          </fieldset>

          <div class="form-grid">
            <div class="form-field">
              <label for="invoice-title">发票抬头<em>*</em></label>
              <input
                id="invoice-title"
                v-model="form.title"
                class="form-input"
                required
                minlength="2"
                maxlength="200"
                autocomplete="organization"
                placeholder="请输入完整抬头"
              />
            </div>
            <div v-if="form.buyerType === 'company'" class="form-field">
              <label for="invoice-tax-id">统一社会信用代码<em>*</em></label>
              <input
                id="invoice-tax-id"
                v-model="form.taxId"
                class="form-input"
                required
                minlength="8"
                maxlength="40"
                autocomplete="off"
                placeholder="请输入税号"
              />
            </div>
            <div class="form-field">
              <label for="invoice-content">开票内容<em>*</em></label>
              <input
                id="invoice-content"
                v-model="form.content"
                class="form-input"
                required
                maxlength="120"
              />
            </div>
            <div class="form-field">
              <label for="invoice-email">接收邮箱<em>*</em></label>
              <input
                id="invoice-email"
                v-model="form.email"
                class="form-input"
                type="email"
                required
                autocomplete="email"
                placeholder="name@example.com"
              />
            </div>
            <div class="form-field">
              <label for="invoice-mobile">联系电话<em>*</em></label>
              <input
                id="invoice-mobile"
                v-model="form.mobile"
                class="form-input"
                type="tel"
                required
                minlength="7"
                maxlength="24"
                autocomplete="tel"
              />
            </div>
          </div>

          <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
          <div class="invoice-form-actions">
            <NuxtLink class="flow-action is-secondary" :to="ticketHref">暂后填写</NuxtLink>
            <button class="flow-action" type="submit" :disabled="pending || !access">
              {{ pending ? '正在提交…' : '确认并提交发票信息' }}
            </button>
          </div>
        </div>
      </form>

      <form v-else class="flow-card invoice-form-card" @submit.prevent="requestNewLink">
        <div class="flow-card__head">
          <h2>重新获取安全访问链接</h2>
          <p>填写订单号和报名邮箱。匹配成功时，系统会发送 10 分钟有效的访问链接。</p>
        </div>
        <div class="flow-card__body">
          <div class="form-grid">
            <div class="form-field">
              <label for="invoice-order-no">订单号<em>*</em></label>
              <input
                id="invoice-order-no"
                v-model="recovery.orderNo"
                class="form-input"
                required
                minlength="6"
                autocomplete="off"
              />
            </div>
            <div class="form-field">
              <label for="invoice-recovery-email">报名邮箱<em>*</em></label>
              <input
                id="invoice-recovery-email"
                v-model="recovery.email"
                class="form-input"
                type="email"
                required
                autocomplete="email"
              />
            </div>
          </div>
          <p v-if="recoveryMessage" class="form-success" role="status">
            {{ recoveryMessage }}
          </p>
          <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
          <div class="invoice-form-actions">
            <NuxtLink class="flow-action is-secondary" :to="ticketHref">返回电子票</NuxtLink>
            <button class="flow-action" type="submit" :disabled="pending">
              {{ pending ? '正在提交…' : '发送新的访问链接' }}
            </button>
          </div>
        </div>
      </form>
    </main>
  </div>
</template>
