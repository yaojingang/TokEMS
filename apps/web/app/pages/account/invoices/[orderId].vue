<script setup lang="ts">
import {
  isCustomerInvoiceEditableStatus,
  type CustomerInvoiceDetail,
  type CustomerInvoiceOrderContext,
} from '@conference/contracts';
import { watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  customerInvoiceStatusCopy,
  invoiceDate,
  invoiceDocumentType,
  invoiceFileSize,
  invoiceMoney,
} from '~/utils/customer-invoice';

const route = useRoute();
const customer = useCustomerSession();
const orderId = computed(() => String(route.params.orderId));
const existingInvoice = ref<CustomerInvoiceDetail | null>(null);
const orderContext = ref<CustomerInvoiceOrderContext | null>(null);
const loading = ref(true);
const pending = ref(false);
const sending = ref(false);
const downloadingId = ref('');
const editing = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const fieldErrors = reactive<Record<string, string>>({});
const form = reactive({
  companyName: '',
  taxId: '',
  email: '',
});

const statusPresentation = computed(() =>
  existingInvoice.value ? customerInvoiceStatusCopy[existingInvoice.value.status] : null,
);
const editable = computed(
  () => !existingInvoice.value || isCustomerInvoiceEditableStatus(existingInvoice.value.status),
);
const showForm = computed(
  () =>
    !existingInvoice.value ||
    editing.value ||
    existingInvoice.value.status === 'awaiting_details' ||
    existingInvoice.value.status === 'rejected',
);
const invoiceDocuments = computed(() => {
  return [...(existingInvoice.value?.documents ?? [])].sort((left, right) => {
    if (Boolean(left.voidedAt) !== Boolean(right.voidedAt)) return left.voidedAt ? 1 : -1;
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
});
const timeline = computed(() =>
  [...(existingInvoice.value?.timeline ?? [])].sort(
    (left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
  ),
);
const canResend = computed(
  () =>
    existingInvoice.value?.status === 'issued' &&
    Boolean(existingInvoice.value.email) &&
    invoiceDocuments.value.some((document) => !document.voidedAt && document.downloadUrl),
);
const canCancelEditing = computed(() => existingInvoice.value?.status === 'pending_review');
const newApplicationUnavailable = computed(
  () => !existingInvoice.value && orderContext.value && !orderContext.value.canApply,
);
const displayedAmount = computed(
  () => existingInvoice.value?.amount ?? orderContext.value?.eligibleAmount ?? 0,
);
const displayedCurrency = computed(
  () => existingInvoice.value?.currency ?? orderContext.value?.currency ?? 'CNY',
);

function syncForm() {
  const session = customer.session.value;
  if (!session) return;
  form.email = existingInvoice.value?.email ?? session.customer.profile.email ?? '';
  form.companyName =
    existingInvoice.value?.title ??
    session.customer.profile.company ??
    session.customer.profile.realName ??
    '';
  form.taxId = existingInvoice.value?.taxId ?? '';
}

async function refreshInvoice() {
  try {
    existingInvoice.value = await customer.invoice(orderId.value);
  } catch (error) {
    const status =
      (error as { statusCode?: number; response?: { status?: number } }).statusCode ??
      (error as { response?: { status?: number } }).response?.status;
    if (status === 404) existingInvoice.value = null;
    else throw error;
  }
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
    const [, context] = await Promise.all([
      refreshInvoice(),
      customer.invoiceContext(orderId.value),
    ]);
    orderContext.value = context;
    editing.value = !existingInvoice.value;
    syncForm();
  } catch (error) {
    const value = error as { data?: { message?: string } };
    errorMessage.value = value.data?.message ?? '发票信息加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

function validate() {
  Object.keys(fieldErrors).forEach((key) => delete fieldErrors[key]);
  if (form.companyName.trim().length < 2) {
    fieldErrors.companyName = '请填写至少 2 个字的公司名称';
  }
  if (form.taxId.trim().length < 8) {
    fieldErrors.taxId = '请填写有效的统一社会信用代码';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    fieldErrors.email = '请输入有效的接收邮箱';
  }
  return Object.keys(fieldErrors).length === 0;
}

async function submit() {
  if (!validate()) return;
  pending.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    existingInvoice.value = await customer.submitInvoice(orderId.value, {
      companyName: form.companyName.trim(),
      taxId: form.taxId.trim().toUpperCase(),
      email: form.email.trim(),
      ...(existingInvoice.value ? { expectedUpdatedAt: existingInvoice.value.updatedAt } : {}),
    });
    editing.value = false;
    syncForm();
    successMessage.value = '开票资料已提交，主办方将按最新信息审核';
  } catch (error) {
    const value = error as {
      statusCode?: number;
      response?: { status?: number };
      data?: { message?: string };
    };
    const status = value.statusCode ?? value.response?.status;
    if (status === 409) {
      await refreshInvoice();
      syncForm();
      editing.value = false;
      errorMessage.value = '发票状态已经更新，页面已刷新，请重新确认后操作';
    } else {
      errorMessage.value = value.data?.message ?? '发票申请提交失败，请检查填写内容';
    }
  } finally {
    pending.value = false;
  }
}

async function downloadDocument(documentId: string) {
  const downloadWindow = window.open('', '_blank');
  if (downloadWindow) downloadWindow.opener = null;
  downloadingId.value = documentId;
  errorMessage.value = '';
  try {
    await refreshInvoice();
    const document = existingInvoice.value?.documents.find((item) => item.id === documentId);
    if (!document?.downloadUrl || document.voidedAt) {
      throw new Error('当前发票文件已失效，请刷新后重试');
    }
    if (downloadWindow) downloadWindow.location.href = document.downloadUrl;
    else window.location.href = document.downloadUrl;
  } catch (error) {
    downloadWindow?.close();
    errorMessage.value = error instanceof Error ? error.message : '电子发票下载失败';
  } finally {
    downloadingId.value = '';
  }
}

async function resendInvoice() {
  if (!existingInvoice.value) return;
  sending.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const result = await customer.sendInvoice(orderId.value);
    successMessage.value = result.alreadyQueued
      ? '电子发票已经在发送队列中，请稍后查收'
      : `电子发票将重新发送至 ${existingInvoice.value.email ?? existingInvoice.value.maskedEmail}`;
    await refreshInvoice();
  } catch (error) {
    const value = error as { data?: { message?: string } };
    errorMessage.value = value.data?.message ?? '电子发票重新发送失败';
  } finally {
    sending.value = false;
  }
}

function startEditing() {
  if (!editable.value) return;
  syncForm();
  editing.value = true;
  successMessage.value = '';
  errorMessage.value = '';
}

onMounted(load);
watch(
  () => customer.session.value?.customer.id,
  (id, previous) => {
    if (id && id !== previous && !loading.value) void load();
  },
);
watch(orderId, (value, previous) => {
  if (value !== previous) void load();
});
useHead({ title: computed(() => (existingInvoice.value ? '发票详情' : '申请发票')) });
</script>

<template>
  <div class="flow-page invoice-page">
    <FlowHeader />
    <main id="main-content" class="invoice-shell">
      <NuxtLink class="invoice-back" to="/account/invoices">
        <span aria-hidden="true">←</span> 返回发票中心
      </NuxtLink>

      <div v-if="loading" class="invoice-loading" role="status">
        <span aria-hidden="true"></span>
        <p>正在读取发票信息</p>
      </div>

      <template v-else-if="customer.session.value">
        <header class="invoice-heading">
          <div>
            <p class="invoice-eyebrow">INVOICE SERVICE</p>
            <h1>{{ existingInvoice ? '发票详情' : '申请发票' }}</h1>
            <p>
              {{
                existingInvoice?.eventName ??
                orderContext?.eventName ??
                '填写准确的购买方信息，提交后可在这里查看进度。'
              }}
            </p>
          </div>
          <span
            v-if="existingInvoice && statusPresentation"
            class="invoice-status"
            :data-tone="statusPresentation.tone"
          >
            <i aria-hidden="true"></i>{{ statusPresentation.label }}
          </span>
        </header>

        <div class="invoice-layout">
          <div class="invoice-main">
            <p v-if="errorMessage" class="invoice-message is-error" role="alert">
              {{ errorMessage }}
            </p>
            <p v-if="successMessage" class="invoice-message is-success" role="status">
              {{ successMessage }}
            </p>

            <section class="invoice-surface invoice-buyer" aria-labelledby="buyer-title">
              <header class="invoice-section-head">
                <div>
                  <span>01 / BUYER</span>
                  <h2 id="buyer-title">{{ showForm ? '开票信息' : '购买方资料' }}</h2>
                  <p>
                    {{
                      showForm
                        ? '企业发票需要填写准确的抬头和统一社会信用代码。'
                        : '以下信息将用于发票票面与发送通知。'
                    }}
                  </p>
                </div>
                <button
                  v-if="existingInvoice && editable && !showForm"
                  class="invoice-text-action"
                  type="button"
                  @click="startEditing"
                >
                  修改发票信息
                </button>
              </header>

              <form v-if="showForm" class="invoice-form" novalidate @submit.prevent="submit">
                <p v-if="newApplicationUnavailable" class="invoice-rejection" role="alert">
                  <strong>当前订单暂不可申请发票</strong>
                  <span>{{ orderContext?.unavailableReason }}</span>
                </p>
                <p v-if="existingInvoice?.rejectionReason" class="invoice-rejection" role="status">
                  <strong>请按以下说明修改</strong>
                  <span>{{ existingInvoice.rejectionReason }}</span>
                </p>
                <div class="invoice-form-grid">
                  <label class="is-wide">
                    <span>公司名称</span>
                    <input
                      v-model="form.companyName"
                      required
                      maxlength="200"
                      autocomplete="organization"
                      placeholder="请输入营业执照上的公司全称"
                      :aria-invalid="Boolean(fieldErrors.companyName)"
                    />
                    <small v-if="fieldErrors.companyName" class="invoice-field-error">
                      {{ fieldErrors.companyName }}
                    </small>
                  </label>
                  <label class="is-wide">
                    <span>统一社会信用代码</span>
                    <input
                      v-model="form.taxId"
                      required
                      minlength="8"
                      maxlength="40"
                      autocomplete="off"
                      placeholder="请输入税号或统一社会信用代码"
                      :aria-invalid="Boolean(fieldErrors.taxId)"
                    />
                    <small v-if="fieldErrors.taxId" class="invoice-field-error">
                      {{ fieldErrors.taxId }}
                    </small>
                  </label>
                  <label class="is-wide">
                    <span>接收邮箱</span>
                    <input
                      v-model="form.email"
                      required
                      type="email"
                      maxlength="255"
                      autocomplete="email"
                      placeholder="用于接收电子发票"
                      :aria-invalid="Boolean(fieldErrors.email)"
                    />
                    <small v-if="fieldErrors.email" class="invoice-field-error">
                      {{ fieldErrors.email }}
                    </small>
                  </label>
                </div>

                <div class="invoice-form-action">
                  <div>
                    <span>本次开票金额</span>
                    <strong>{{ invoiceMoney(displayedAmount, displayedCurrency) }}</strong>
                    <small v-if="!existingInvoice">已扣除成功退款，以实际支付金额为准</small>
                  </div>
                  <div class="invoice-form-buttons">
                    <button
                      v-if="existingInvoice && editing && canCancelEditing"
                      class="invoice-secondary"
                      type="button"
                      @click="editing = false"
                    >
                      取消修改
                    </button>
                    <button
                      class="invoice-primary"
                      type="submit"
                      :disabled="pending || Boolean(newApplicationUnavailable)"
                    >
                      {{
                        pending ? '正在提交' : existingInvoice ? '保存并重新提交' : '提交发票申请'
                      }}
                    </button>
                  </div>
                </div>
              </form>

              <dl v-else-if="existingInvoice" class="invoice-details">
                <div>
                  <dt>公司名称</dt>
                  <dd>{{ existingInvoice.title ?? '待补充' }}</dd>
                </div>
                <div>
                  <dt>统一社会信用代码</dt>
                  <dd>{{ existingInvoice.maskedTaxId ?? '待补充' }}</dd>
                </div>
                <div>
                  <dt>接收邮箱</dt>
                  <dd>{{ existingInvoice.email ?? existingInvoice.maskedEmail }}</dd>
                </div>
              </dl>
            </section>

            <section
              v-if="existingInvoice"
              class="invoice-surface invoice-files"
              aria-labelledby="files-title"
            >
              <header class="invoice-section-head">
                <div>
                  <span>02 / DOCUMENTS</span>
                  <h2 id="files-title">发票文件</h2>
                  <p>下载地址按点击实时生成，作废文件仅保留历史信息。</p>
                </div>
              </header>
              <div v-if="invoiceDocuments.length" class="invoice-file-list">
                <article
                  v-for="document in invoiceDocuments"
                  :key="document.id"
                  class="invoice-file"
                  :class="{ voided: Boolean(document.voidedAt) }"
                >
                  <div class="invoice-file__mark" aria-hidden="true">
                    {{ document.mediaType === 'application/ofd' ? 'OFD' : 'PDF' }}
                  </div>
                  <div class="invoice-file__body">
                    <div>
                      <strong>{{ invoiceDocumentType(document.documentType) }}</strong>
                      <span v-if="document.voidedAt">已作废</span>
                    </div>
                    <p>发票号码 {{ document.invoiceNumber }}</p>
                    <small>
                      {{ invoiceDate(document.issuedAt) }} · {{ invoiceFileSize(document.size) }}
                    </small>
                  </div>
                  <button
                    v-if="document.downloadUrl && !document.voidedAt"
                    type="button"
                    :disabled="downloadingId === document.id"
                    @click="downloadDocument(document.id)"
                  >
                    {{ downloadingId === document.id ? '正在获取' : '下载文件' }}
                  </button>
                  <span v-else class="invoice-file__unavailable">不可下载</span>
                </article>
              </div>
              <div v-else class="invoice-empty-block">
                <strong>电子发票尚未生成</strong>
                <p>{{ statusPresentation?.description }}</p>
              </div>
            </section>

            <section
              v-if="existingInvoice"
              class="invoice-surface invoice-timeline"
              aria-labelledby="timeline-title"
            >
              <header class="invoice-section-head">
                <div>
                  <span>03 / PROGRESS</span>
                  <h2 id="timeline-title">处理进度</h2>
                  <p>这里记录申请、审核、开具与调整过程中的公开节点。</p>
                </div>
              </header>
              <ol v-if="timeline.length">
                <li v-for="item in timeline" :key="item.id" :data-tone="item.tone">
                  <i aria-hidden="true"></i>
                  <div>
                    <time>{{ invoiceDate(item.occurredAt, true) }}</time>
                    <strong>{{ item.label }}</strong>
                    <p>{{ item.description }}</p>
                  </div>
                </li>
              </ol>
            </section>
          </div>

          <aside class="invoice-aside" aria-label="订单与申请摘要">
            <section class="invoice-order-summary">
              <span>ORDER SUMMARY</span>
              <h2>{{ existingInvoice?.eventName ?? orderContext?.eventName ?? '大会订单' }}</h2>
              <dl>
                <div>
                  <dt>订单号</dt>
                  <dd>{{ existingInvoice?.orderNo ?? orderContext?.orderNo ?? orderId }}</dd>
                </div>
                <div v-if="existingInvoice">
                  <dt>申请编号</dt>
                  <dd>{{ existingInvoice.requestNo }}</dd>
                </div>
                <div>
                  <dt>开票金额</dt>
                  <dd>{{ invoiceMoney(displayedAmount, displayedCurrency) }}</dd>
                </div>
                <div v-if="existingInvoice">
                  <dt>最近提交</dt>
                  <dd>{{ invoiceDate(existingInvoice.requestedAt, true) }}</dd>
                </div>
              </dl>
            </section>

            <section v-if="existingInvoice" class="invoice-aside-actions">
              <strong>当前可用操作</strong>
              <button
                v-if="editable && !showForm"
                class="invoice-primary"
                type="button"
                @click="startEditing"
              >
                修改发票信息
              </button>
              <button
                v-if="canResend"
                class="invoice-secondary"
                type="button"
                :disabled="sending"
                @click="resendInvoice"
              >
                {{ sending ? '正在加入发送队列' : '重新发送至邮箱' }}
              </button>
              <p v-if="existingInvoice.status === 'issued'">
                已开具发票如需更正，请联系大会主办方处理作废与重开。
              </p>
              <p v-else-if="!editable">{{ statusPresentation?.description }}</p>
            </section>

            <section class="invoice-help">
              <span aria-hidden="true">i</span>
              <div>
                <strong>资料提交前请仔细核对</strong>
                <p>企业名称与统一社会信用代码需要保持一致，审核通过后将进入开具流程。</p>
              </div>
            </section>
          </aside>
        </div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.invoice-page {
  --invoice-canvas: #f4f5f7;
  --invoice-surface: #ffffff;
  --invoice-ink: #17191d;
  --invoice-muted: #6f737c;
  --invoice-line: #dfe3e9;
  --invoice-line-soft: #eceef2;
  min-height: 100vh;
  background: var(--invoice-canvas);
  color: var(--invoice-ink);
}

.invoice-shell {
  width: min(100% - 40px, 1120px);
  margin-inline: auto;
  padding: 38px 0 96px;
}

.invoice-back {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: 9px;
  color: var(--invoice-muted);
  font-size: 13px;
  font-weight: 680;
  text-decoration: none;
  transition:
    color 150ms ease,
    transform 150ms ease;
}

.invoice-back:active,
.invoice-primary:active,
.invoice-secondary:active,
.invoice-text-action:active,
.invoice-file button:active {
  transform: scale(0.97);
}

.invoice-loading {
  display: grid;
  min-height: 440px;
  place-content: center;
  justify-items: center;
  gap: 14px;
  color: var(--invoice-muted);
  font-size: 13px;
}

.invoice-loading span {
  width: 28px;
  height: 28px;
  border: 2px solid #dbe6f7;
  border-top-color: var(--conference-primary);
  border-radius: 50%;
  animation: invoice-spin 800ms linear infinite;
}

@keyframes invoice-spin {
  to {
    transform: rotate(360deg);
  }
}

.invoice-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin: 22px 0 30px;
}

.invoice-eyebrow,
.invoice-section-head span,
.invoice-order-summary > span {
  display: block;
  margin: 0 0 8px;
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 9px;
  font-weight: 720;
  letter-spacing: 0.11em;
}

.invoice-heading h1 {
  margin: 0;
  font-size: clamp(30px, 3.2vw, 34px);
  font-weight: 850;
  line-height: 1.12;
  text-wrap: balance;
}

.invoice-heading > div > p:last-child {
  margin: 12px 0 0;
  color: var(--invoice-muted);
  font-size: 14px;
  line-height: 1.7;
  text-wrap: pretty;
}

.invoice-status {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid #cfd9e9;
  border-radius: 999px;
  background: #f4f7fc;
  color: #315d9a;
  font-size: 12px;
  font-weight: 720;
  white-space: nowrap;
}

.invoice-status i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
}

.invoice-status[data-tone='success'] {
  border-color: #b9ddce;
  background: #f0faf6;
  color: #167653;
}

.invoice-status[data-tone='warning'] {
  border-color: #eed6a9;
  background: #fff9ec;
  color: #946313;
}

.invoice-status[data-tone='neutral'] {
  border-color: #d9dce2;
  background: #f5f5f6;
  color: #666a72;
}

.invoice-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 308px;
  align-items: start;
  gap: 26px;
}

.invoice-main {
  display: grid;
  min-width: 0;
  gap: 22px;
}

.invoice-surface,
.invoice-order-summary,
.invoice-aside-actions {
  border: 1px solid var(--invoice-line);
  border-radius: 11px;
  background: var(--invoice-surface);
  box-shadow: 0 1px 3px rgb(15 23 42 / 10%);
}

.invoice-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 22px;
  padding: 24px 26px 21px;
  border-bottom: 1px solid var(--invoice-line-soft);
}

.invoice-section-head h2,
.invoice-order-summary h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 820;
  line-height: 1.2;
}

.invoice-section-head p {
  margin: 8px 0 0;
  color: var(--invoice-muted);
  font-size: 13px;
  line-height: 1.65;
  text-wrap: pretty;
}

.invoice-text-action {
  min-height: 40px;
  flex: 0 0 auto;
  padding: 0 4px;
  color: var(--conference-primary);
  font-size: 13px;
  font-weight: 720;
  transition: transform 150ms ease;
}

.invoice-message {
  margin: 0;
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.55;
}

.invoice-message.is-error,
.invoice-rejection {
  background: #fff3f2;
  color: #a83e38;
}

.invoice-message.is-success {
  background: #eef9f4;
  color: #167653;
}

.invoice-form {
  padding: 24px 26px 28px;
}

.invoice-rejection {
  display: grid;
  gap: 4px;
  margin: 0 0 20px;
  padding: 13px 14px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
}

.invoice-buyer-type {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
}

.invoice-buyer-type legend {
  margin-bottom: 9px;
  color: #494c53;
  font-size: 12px;
  font-weight: 700;
}

.invoice-buyer-type label {
  position: relative;
  display: grid;
  min-height: 76px;
  align-content: center;
  gap: 4px;
  padding: 12px 15px 12px 42px;
  border: 1px solid var(--invoice-line);
  border-radius: 8px;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease,
    transform 150ms ease;
}

.invoice-buyer-type label.active {
  border-color: #9ebbea;
  background: #f3f7fe;
}

.invoice-buyer-type input {
  position: absolute;
  top: 27px;
  left: 16px;
  accent-color: var(--conference-primary);
}

.invoice-buyer-type span {
  font-size: 13px;
  font-weight: 760;
}

.invoice-buyer-type small {
  color: var(--invoice-muted);
  font-size: 10px;
}

.invoice-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 17px;
  margin-top: 22px;
}

.invoice-form-grid label {
  display: grid;
  align-content: start;
  gap: 7px;
  color: #494c53;
  font-size: 12px;
  font-weight: 680;
}

.invoice-form-grid label.is-wide {
  grid-column: 1 / -1;
}

.invoice-form-grid input {
  width: 100%;
  min-height: 44px;
  padding: 9px 11px;
  border: 1px solid #d2d6dd;
  border-radius: 7px;
  background: #fff;
  color: var(--invoice-ink);
  font: inherit;
  font-weight: 520;
}

.invoice-form-grid input::placeholder {
  color: #a1a5ad;
}

.invoice-form-grid input:focus-visible {
  border-color: var(--conference-primary);
  outline: 3px solid rgb(37 99 235 / 12%);
}

.invoice-form-grid input[aria-invalid='true'] {
  border-color: #d98c87;
}

.invoice-field-error {
  color: #b4453f;
  font-size: 11px;
  font-weight: 580;
}

.invoice-form-action {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-top: 26px;
  padding-top: 22px;
  border-top: 1px solid var(--invoice-line-soft);
}

.invoice-form-action > div:first-child {
  display: grid;
  gap: 4px;
}

.invoice-form-action span,
.invoice-form-action small {
  color: var(--invoice-muted);
  font-size: 10px;
  line-height: 1.5;
}

.invoice-form-action strong {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}

.invoice-form-buttons {
  display: flex;
  align-items: center;
  gap: 9px;
}

.invoice-primary,
.invoice-secondary,
.invoice-file button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 720;
  transition:
    transform 150ms ease,
    opacity 150ms ease,
    background-color 150ms ease;
}

.invoice-primary {
  background: var(--conference-primary);
  color: #fff;
}

.invoice-secondary,
.invoice-file button {
  border: 1px solid #ccd3de;
  background: #fff;
  color: #394150;
}

.invoice-primary:disabled,
.invoice-secondary:disabled,
.invoice-file button:disabled {
  cursor: wait;
  opacity: 0.58;
}

.invoice-details {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin: 0;
  padding: 8px 26px 27px;
}

.invoice-details div {
  min-width: 0;
  padding: 18px 0;
  border-bottom: 1px solid var(--invoice-line-soft);
}

.invoice-details div:nth-child(odd) {
  padding-right: 20px;
}

.invoice-details dt {
  color: var(--invoice-muted);
  font-size: 11px;
}

.invoice-details dd {
  overflow-wrap: anywhere;
  margin: 6px 0 0;
  font-size: 14px;
  font-weight: 680;
  line-height: 1.55;
}

.invoice-file-list {
  padding: 4px 26px 20px;
}

.invoice-file {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 17px 0;
  border-bottom: 1px solid var(--invoice-line-soft);
}

.invoice-file:last-child {
  border-bottom: 0;
}

.invoice-file.voided {
  opacity: 0.62;
}

.invoice-file__mark {
  display: grid;
  width: 46px;
  height: 48px;
  place-items: center;
  border: 1px solid #cfdcf0;
  border-radius: 7px;
  background: #f2f6fc;
  color: #315d9a;
  font-family: var(--conference-font-mono);
  font-size: 9px;
  font-weight: 740;
}

.invoice-file__body {
  min-width: 0;
}

.invoice-file__body > div {
  display: flex;
  align-items: center;
  gap: 9px;
}

.invoice-file__body strong {
  font-size: 13px;
}

.invoice-file__body span {
  padding: 3px 6px;
  border-radius: 4px;
  background: #f0f1f3;
  color: #737780;
  font-size: 9px;
}

.invoice-file__body p,
.invoice-file__body small {
  margin: 5px 0 0;
  color: var(--invoice-muted);
  font-size: 11px;
  line-height: 1.5;
}

.invoice-file__unavailable {
  color: #969aa2;
  font-size: 11px;
}

.invoice-empty-block {
  padding: 36px 26px 40px;
}

.invoice-empty-block strong {
  font-size: 14px;
}

.invoice-empty-block p {
  margin: 7px 0 0;
  color: var(--invoice-muted);
  font-size: 12px;
  line-height: 1.6;
}

.invoice-timeline ol {
  display: grid;
  margin: 0;
  padding: 9px 26px 25px;
  list-style: none;
}

.invoice-timeline li {
  position: relative;
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 14px;
  padding: 15px 0;
}

.invoice-timeline li:not(:last-child)::after {
  position: absolute;
  top: 31px;
  bottom: -15px;
  left: 5px;
  width: 1px;
  background: #dfe3e9;
  content: '';
}

.invoice-timeline li > i {
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #7694c2;
  box-shadow: 0 0 0 1px #b9c8de;
}

.invoice-timeline li[data-tone='success'] > i {
  background: #2f9a73;
  box-shadow: 0 0 0 1px #95cdb8;
}

.invoice-timeline li[data-tone='warning'] > i {
  background: #c88b2b;
  box-shadow: 0 0 0 1px #e7c486;
}

.invoice-timeline time {
  display: block;
  color: #92969e;
  font-family: var(--conference-font-mono);
  font-size: 9px;
}

.invoice-timeline strong {
  display: block;
  margin-top: 5px;
  font-size: 13px;
}

.invoice-timeline p {
  margin: 4px 0 0;
  color: var(--invoice-muted);
  font-size: 12px;
  line-height: 1.6;
}

.invoice-aside {
  position: sticky;
  top: 22px;
  display: grid;
  gap: 14px;
}

.invoice-order-summary {
  padding: 22px;
}

.invoice-order-summary h2 {
  font-size: 18px;
  line-height: 1.4;
}

.invoice-order-summary dl {
  display: grid;
  margin: 20px 0 0;
}

.invoice-order-summary dl div {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 10px;
  padding: 11px 0;
  border-top: 1px solid var(--invoice-line-soft);
}

.invoice-order-summary dt {
  color: var(--invoice-muted);
  font-size: 10px;
}

.invoice-order-summary dd {
  overflow-wrap: anywhere;
  margin: 0;
  font-size: 11px;
  font-weight: 680;
  line-height: 1.5;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.invoice-aside-actions {
  display: grid;
  gap: 9px;
  padding: 20px 22px 22px;
}

.invoice-aside-actions > strong {
  margin-bottom: 3px;
  font-size: 12px;
}

.invoice-aside-actions .invoice-primary,
.invoice-aside-actions .invoice-secondary {
  width: 100%;
}

.invoice-aside-actions p {
  margin: 5px 0 0;
  color: var(--invoice-muted);
  font-size: 10px;
  line-height: 1.6;
}

.invoice-help {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 11px;
  padding: 17px 18px;
  border: 1px solid #d5e1f2;
  border-radius: 10px;
  background: #f1f6fd;
}

.invoice-help > span {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: #dbe8fa;
  color: #315d9a;
  font-family: serif;
  font-size: 12px;
  font-weight: 700;
}

.invoice-help strong {
  font-size: 11px;
}

.invoice-help p {
  margin: 5px 0 0;
  color: #61718b;
  font-size: 10px;
  line-height: 1.6;
}

@media (hover: hover) {
  .invoice-back:hover,
  .invoice-text-action:hover {
    color: var(--conference-primary);
  }

  .invoice-buyer-type label:hover {
    border-color: #b4c7e5;
    background: #f7f9fd;
  }

  .invoice-secondary:hover,
  .invoice-file button:hover {
    background: #f5f7fa;
  }
}

@media (max-width: 880px) {
  .invoice-layout {
    grid-template-columns: 1fr;
  }

  .invoice-aside {
    position: static;
    grid-template-columns: 1fr 1fr;
  }

  .invoice-help {
    grid-column: 1 / -1;
  }
}

@media (max-width: 640px) {
  .invoice-shell {
    width: min(100% - 28px, 1120px);
    padding: 24px 0 calc(72px + env(safe-area-inset-bottom));
  }

  .invoice-heading {
    display: grid;
    margin-top: 16px;
  }

  .invoice-heading h1 {
    font-size: 29px;
  }

  .invoice-status {
    justify-self: start;
  }

  .invoice-section-head,
  .invoice-form {
    padding-inline: 20px;
  }

  .invoice-section-head {
    display: grid;
  }

  .invoice-section-head h2 {
    font-size: 21px;
  }

  .invoice-buyer-type,
  .invoice-form-grid,
  .invoice-details {
    grid-template-columns: 1fr;
  }

  .invoice-form-grid label.is-wide {
    grid-column: auto;
  }

  .invoice-form-grid input {
    font-size: 16px;
  }

  .invoice-form-action {
    display: grid;
  }

  .invoice-form-buttons {
    display: grid;
    width: 100%;
    justify-content: flex-start;
  }

  .invoice-form-buttons .invoice-primary,
  .invoice-form-buttons .invoice-secondary {
    width: 100%;
  }

  .invoice-details,
  .invoice-file-list,
  .invoice-timeline ol {
    padding-inline: 20px;
  }

  .invoice-details div:nth-child(odd) {
    padding-right: 0;
  }

  .invoice-file {
    grid-template-columns: 42px minmax(0, 1fr);
  }

  .invoice-file button,
  .invoice-file__unavailable {
    grid-column: 2;
    justify-self: start;
  }

  .invoice-aside {
    grid-template-columns: 1fr;
  }

  .invoice-help {
    grid-column: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .invoice-loading span {
    animation: none;
  }

  .invoice-back,
  .invoice-primary,
  .invoice-secondary,
  .invoice-text-action,
  .invoice-file button,
  .invoice-buyer-type label {
    transition: none;
  }
}
</style>
