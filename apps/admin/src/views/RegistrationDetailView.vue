<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { AdminRegistrationOperationsDetail, EventId } from '@conference/contracts';
import { useRoute } from 'vue-router';
import RegistrationInvoicePanel from '../components/registration/RegistrationInvoicePanel.vue';
import { conferenceApi } from '../lib/api';
import { dateTime, money, statusClass, statusLabel } from '../lib/format';
import { deriveAdminInvoicePresentation } from '../lib/invoice-presentation';
import { parseEventId } from '../lib/route-scope';

const route = useRoute();
const detail = ref<AdminRegistrationOperationsDetail>();
const loading = ref(true);
const refreshing = ref(false);
const errorMessage = ref('');
const operationMessage = ref('');
const reviewReason = ref('');
const reviewPending = ref(false);
const refundFormOpen = ref(false);
const refundPending = ref(false);
const refundAmountInput = ref<HTMLInputElement>();
const attendeeEditOpen = ref(false);
const attendeeSaving = ref(false);
const noteBody = ref('');
const noteSaving = ref(false);
const copied = ref(false);

const attendeeForm = reactive({
  name: '',
  mobile: '',
  email: '',
  company: '',
  title: '',
  city: '',
  reason: '应参会人要求更正报名资料',
});
const refundForm = reactive({
  amountYuan: 0,
  reason: '参会人申请退款',
});
const coreKeys = new Set(['name', 'mobile', 'email', 'company', 'title', 'city']);
const fieldLabels: Record<string, string> = {
  name: '姓名',
  mobile: '手机号码',
  email: '电子邮箱',
  company: '公司 / 机构',
  title: '职位',
  city: '所在城市',
};

const registrationId = computed(() => String(route.params.registrationId ?? ''));
const eventId = computed<EventId | undefined>(() => parseEventId(route.params.eventId));
const registration = computed(() => detail.value?.registration);
const commerce = computed(() =>
  detail.value?.commerce.access === 'included' ? detail.value.commerce : null,
);
const order = computed(() => commerce.value?.order ?? null);
const invoiceRequest = computed(() =>
  detail.value?.invoice.access === 'included' ? detail.value.invoice.request : null,
);
const invoicePresentation = computed(() =>
  deriveAdminInvoicePresentation({
    access: detail.value?.invoice.access ?? 'restricted',
    invoiceRequired: registration.value?.invoiceRequired ?? false,
    ...(order.value?.status ? { orderStatus: order.value.status } : {}),
    request: invoiceRequest.value
      ? {
          status: invoiceRequest.value.status,
          deliveryStatus: invoiceRequest.value.deliveryStatus,
          invoiceNumber:
            invoiceRequest.value.documents.find((document) => !document.voidedAt)?.invoiceNumber ??
            null,
        }
      : null,
  }),
);
const refundableAmount = computed(() => commerce.value?.totals.refundableAmount ?? 0);
const canStartRefund = computed(
  () => detail.value?.capabilities.refund_order?.allowed === true && refundableAmount.value > 0,
);
const canReview = computed(
  () =>
    detail.value?.capabilities.review_registration?.allowed === true &&
    registration.value?.status === 'pending_review',
);
const canManageInvoice = computed(
  () => detail.value?.capabilities.manage_invoice?.allowed === true,
);
const refundAmount = computed(() => Math.round(Number(refundForm.amountYuan || 0) * 100));
const refundInvoiceImpact = computed(() => {
  if (!invoiceRequest.value || refundAmount.value <= 0) return '本次退款不涉及已存在的发票申请。';
  if (['issued', 'adjustment_required'].includes(invoiceRequest.value.status)) {
    return `退款成功后，发票净额将减少 ${money(refundAmount.value)}，原票需要进入红冲或重开处理。`;
  }
  if (
    ['awaiting_details', 'pending_review', 'issuing', 'issue_failed'].includes(
      invoiceRequest.value.status,
    )
  ) {
    return `退款成功后，开票净额将减少 ${money(refundAmount.value)}，后续按新净额开具。`;
  }
  return '发票申请已经终止，本次退款不会恢复该申请。';
});
const refundDisabledReason = computed(() => {
  const code = detail.value?.capabilities.refund_order?.reasonCode;
  return (
    {
      permission_required: '当前账号缺少退款权限',
      order_unavailable: '订单不可用或没有订单查看权限',
      order_state_not_refundable: '当前订单状态不可退款',
      no_refundable_balance: '订单已无可退余额',
      wechat_refund_unavailable: '微信支付退款通道暂未启用，请通过线下流程处理',
    }[code ?? ''] ?? '当前订单暂不可退款'
  );
});
const attentionItems = computed(() => {
  const items: Array<{
    title: string;
    description: string;
    target: string;
    level: 'high' | 'medium';
  }> = [];
  if (registration.value?.status === 'pending_review') {
    items.push({
      title: '报名等待审核',
      description: '完成审核后才能进入支付或出票流程。',
      target: 'registration-review',
      level: 'high',
    });
  }
  if (invoicePresentation.value.attentionLevel >= 2) {
    items.push({
      title: invoicePresentation.value.substateLabel,
      description: invoicePresentation.value.summary,
      target: 'invoice',
      level: invoicePresentation.value.attentionLevel === 3 ? 'high' : 'medium',
    });
  }
  if (commerce.value?.totals.processingRefundAmount) {
    items.push({
      title: '退款处理中',
      description: `${money(commerce.value.totals.processingRefundAmount)} 正在由支付渠道处理。`,
      target: 'commerce',
      level: 'medium',
    });
  }
  return items;
});
const activityItems = computed(() => {
  const row = registration.value;
  if (!row) return [];
  const items: Array<{
    id: string;
    title: string;
    description: string;
    occurredAt: string;
    tone: string;
  }> = [
    {
      id: `registration-${row.id}`,
      title: '提交报名',
      description: `${row.attendee.name} 提交了 ${row.ticketType.name} 报名`,
      occurredAt: row.createdAt,
      tone: 'neutral',
    },
  ];
  detail.value?.fulfillment.checkins.forEach((checkin) => {
    items.push({
      id: checkin.id,
      title: checkin.result === 'accepted' ? '完成签到' : '产生签到记录',
      description: `${checkin.listName} · ${checkin.operatorName || checkin.deviceName}`,
      occurredAt: checkin.checkedInAt,
      tone: checkin.result === 'accepted' ? 'success' : 'warning',
    });
  });
  commerce.value?.refunds.forEach((refund) => {
    items.push({
      id: refund.id,
      title: `退款${statusLabel(refund.status)}`,
      description: `${money(refund.amount)} · ${refund.reason}`,
      occurredAt: refund.updatedAt ?? refund.createdAt,
      tone: refund.status === 'succeeded' ? 'success' : 'warning',
    });
  });
  invoiceRequest.value?.logs.forEach((log) => {
    items.push({
      id: log.id,
      title: `发票：${invoiceLogLabel(log.toStatus)}`,
      description: log.reason,
      occurredAt: log.createdAt,
      tone: ['issue_failed', 'adjustment_required', 'rejected'].includes(log.toStatus)
        ? 'warning'
        : 'neutral',
    });
  });
  detail.value?.notes.forEach((note) => {
    items.push({
      id: note.id,
      title: '添加内部备注',
      description: `${note.authorName || '运营人员'}：${note.body}`,
      occurredAt: note.createdAt,
      tone: 'info',
    });
  });
  return items.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
});

function answerEntries(row: AdminRegistrationOperationsDetail['registration']) {
  return Object.entries(row.formAnswers ?? {})
    .filter(([key, value]) => !coreKeys.has(key) && value)
    .map(([key, value]) => ({ key, label: fieldLabels[key] ?? key, value }));
}

function paymentMethodLabel(value: string) {
  return { wechat: '微信支付', alipay: '支付宝', bank: '银行转账', free: '免费票' }[value] ?? value;
}

function paymentProviderLabel(value: string) {
  return (
    { wechatpay: '微信支付', alipay: '支付宝', mock: '模拟支付', free: '免费订单' }[value] ?? value
  );
}

function invoiceLogLabel(value: string) {
  return (
    {
      awaiting_details: '待提交资料',
      pending_review: '资料待审核',
      issuing: '开票中',
      issued: '已开具',
      issue_failed: '开票失败',
      rejected: '资料已驳回',
      adjustment_required: '退款待调整',
      voided: '已作废',
      cancelled: '已取消',
    }[value] ?? value
  );
}

function checkinResultLabel(value: string) {
  return (
    {
      accepted: '签到成功',
      duplicate: '重复签到',
      invalid: '票码无效',
      forbidden: '禁止签到',
      manual_review: '人工复核',
    }[value] ?? value
  );
}

function snapshotText(row: AdminRegistrationOperationsDetail['registration'], key: string) {
  const value = row.consentSnapshot?.[key];
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value;
  return '';
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fillAttendeeForm() {
  if (!registration.value) return;
  Object.assign(attendeeForm, registration.value.attendee, {
    reason: '应参会人要求更正报名资料',
  });
  attendeeEditOpen.value = true;
}

function clearMessages() {
  errorMessage.value = '';
  operationMessage.value = '';
}

async function load(options: { quiet?: boolean } = {}) {
  if (!eventId.value) {
    loading.value = false;
    detail.value = undefined;
    errorMessage.value = '大会标识无效，无法读取报名详情。';
    return;
  }
  if (options.quiet) refreshing.value = true;
  else loading.value = true;
  errorMessage.value = '';
  try {
    detail.value = await conferenceApi.getRegistrationOperations(
      registrationId.value,
      eventId.value,
    );
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报名运营详情读取失败';
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function review(decision: 'approve' | 'reject') {
  const current = registration.value;
  if (!current || !eventId.value || current.status !== 'pending_review') return;
  if (decision === 'reject' && reviewReason.value.trim().length < 2) {
    errorMessage.value = '拒绝报名时请填写原因。';
    return;
  }
  if (
    !window.confirm(
      `${decision === 'approve' ? '通过' : '拒绝'} ${current.attendee.name} 的报名审核？`,
    )
  )
    return;
  reviewPending.value = true;
  clearMessages();
  try {
    const result = await conferenceApi.reviewRegistration(
      current.id,
      { decision, reason: reviewReason.value.trim() },
      eventId.value,
    );
    reviewReason.value = '';
    operationMessage.value =
      decision === 'approve'
        ? result.ticket
          ? '审核已通过，电子票已经签发。'
          : '审核已通过，参会人已获得支付窗口。'
        : '审核已拒绝，关联订单已关闭。';
    await load({ quiet: true });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报名审核失败';
  } finally {
    reviewPending.value = false;
  }
}

async function saveAttendee() {
  if (!registration.value || !eventId.value) return;
  attendeeSaving.value = true;
  clearMessages();
  try {
    await conferenceApi.updateRegistrationAttendee(
      registration.value.id,
      {
        attendee: {
          name: attendeeForm.name,
          mobile: attendeeForm.mobile,
          email: attendeeForm.email,
          company: attendeeForm.company,
          title: attendeeForm.title,
          city: attendeeForm.city,
        },
        reason: attendeeForm.reason,
      },
      eventId.value,
    );
    attendeeEditOpen.value = false;
    operationMessage.value = '参会人资料已更新，修改原因已写入审计记录。';
    await load({ quiet: true });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '参会人资料更新失败';
  } finally {
    attendeeSaving.value = false;
  }
}

async function openRefundForm() {
  if (!canStartRefund.value) return;
  refundForm.amountYuan = refundableAmount.value / 100;
  refundForm.reason = '参会人申请退款';
  refundFormOpen.value = true;
  clearMessages();
  await nextTick();
  refundAmountInput.value?.focus();
}

async function submitRefund() {
  if (!order.value) return;
  if (!Number.isFinite(refundAmount.value) || refundAmount.value <= 0) {
    errorMessage.value = '退款金额格式不正确。';
    return;
  }
  if (refundAmount.value > refundableAmount.value) {
    errorMessage.value = `退款金额不能超过可退余额 ${money(refundableAmount.value)}。`;
    return;
  }
  if (refundForm.reason.trim().length < 2) {
    errorMessage.value = '退款原因至少需要 2 个字符。';
    return;
  }
  if (!window.confirm(`确认从订单 ${order.value.orderNo} 退款 ${money(refundAmount.value)}？`))
    return;
  refundPending.value = true;
  clearMessages();
  try {
    await conferenceApi.refundOrder(order.value.id, {
      amount: refundAmount.value,
      reason: refundForm.reason.trim(),
    });
    refundFormOpen.value = false;
    operationMessage.value = `退款 ${money(refundAmount.value)} 已提交。`;
    await load({ quiet: true });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '退款失败';
  } finally {
    refundPending.value = false;
  }
}

async function addNote() {
  if (!eventId.value || !registration.value || !noteBody.value.trim()) return;
  noteSaving.value = true;
  clearMessages();
  try {
    await conferenceApi.addRegistrationNote(
      registration.value.id,
      { body: noteBody.value.trim() },
      eventId.value,
    );
    noteBody.value = '';
    operationMessage.value = '内部备注已保存。';
    await load({ quiet: true });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '备注保存失败';
  } finally {
    noteSaving.value = false;
  }
}

async function copyContact() {
  if (!registration.value) return;
  const attendee = registration.value.attendee;
  await navigator.clipboard.writeText(
    `${attendee.name} ${attendee.mobile} ${attendee.email}`.trim(),
  );
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 1600);
}

function onInvoiceSuccess(message: string) {
  operationMessage.value = message;
  errorMessage.value = '';
}

function onInvoiceError(message: string) {
  errorMessage.value = message;
  operationMessage.value = '';
}

watch([registrationId, eventId], () => void load(), { immediate: true });
</script>

<template>
  <div class="registration-detail-page">
    <nav class="registration-breadcrumb" aria-label="报名详情路径">
      <RouterLink
        :to="{
          name: 'event-registrations',
          params: { eventId: route.params.eventId },
          query: route.query,
        }"
      >
        <span aria-hidden="true">←</span> 返回报名管理
      </RouterLink>
    </nav>

    <div v-if="loading" class="registration-detail-state">
      <div class="admin-loading">正在汇总报名、订单、发票与履约信息…</div>
    </div>

    <div v-else-if="!detail || !registration" class="registration-detail-state">
      <div>
        <p class="admin-error" role="alert">{{ errorMessage || '报名记录不存在。' }}</p>
        <RouterLink
          class="button secondary"
          :to="{ name: 'event-registrations', params: { eventId: route.params.eventId } }"
        >
          返回报名管理
        </RouterLink>
      </div>
    </div>

    <template v-else>
      <header class="registration-hero reveal is-visible">
        <div class="registration-hero-copy">
          <div class="hero-kicker">
            <span>报名运营工作台</span><i :class="statusClass(registration.status)">{{ statusLabel(registration.status) }}</i>
          </div>
          <h1>{{ registration.attendee.name }}</h1>
          <p>
            <span class="mono-code">{{ registration.registrationCode }}</span><b>·</b>{{ registration.ticketType.name }}<b>·</b>提交于
            {{ dateTime(registration.createdAt) }}
          </p>
        </div>
        <div class="admin-head-actions">
          <button
            class="button secondary"
            type="button"
            :disabled="refreshing"
            @click="load({ quiet: true })"
          >
            {{ refreshing ? '刷新中…' : '刷新信息' }}
          </button>
          <button class="button" type="button" @click="copyContact">
            {{ copied ? '已复制' : '复制联系方式' }}
          </button>
        </div>
      </header>

      <div class="message-stack" aria-live="polite">
        <p v-if="operationMessage" class="admin-success" role="status">{{ operationMessage }}</p>
        <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
      </div>

      <section class="operations-summary" aria-label="报名运营状态总览">
        <div>
          <span>报名</span>
          <strong><i class="status-badge" :class="statusClass(registration.status)">{{
            statusLabel(registration.status)
          }}</i></strong>
          <small>{{ registration.ticketType.name }}</small>
        </div>
        <div>
          <span>订单</span>
          <strong><i v-if="order" class="status-badge" :class="statusClass(order.status)">{{
            statusLabel(order.status)
          }}</i><template v-else>{{
            detail.commerce.access === 'restricted' ? '权限受限' : '未生成'
          }}</template></strong>
          <small>{{ order?.orderNo || '暂无关联订单' }}</small>
        </div>
        <div>
          <span>实付</span>
          <strong>{{ commerce ? money(commerce.totals.paidAmount) : '－' }}</strong>
          <small>{{
            commerce?.successfulPayment
              ? paymentProviderLabel(commerce.successfulPayment.provider)
              : '暂无成功支付'
          }}</small>
        </div>
        <div>
          <span>退款</span>
          <strong>{{ commerce ? money(commerce.totals.succeededRefundAmount) : '－' }}</strong>
          <small v-if="commerce">可退 {{ money(commerce.totals.refundableAmount)
          }}<template v-if="commerce.totals.processingRefundAmount">
            · 处理中 {{ money(commerce.totals.processingRefundAmount) }}</template></small>
          <small v-else>需要订单查看权限</small>
        </div>
        <div :class="`summary-${invoicePresentation.tone}`">
          <span>发票</span>
          <strong>{{ invoicePresentation.stageLabel }}</strong>
          <small>{{ invoicePresentation.substateLabel
          }}<template v-if="invoicePresentation.deliveryLabel">
            · {{ invoicePresentation.deliveryLabel }}</template></small>
        </div>
      </section>

      <nav class="detail-anchor-nav" aria-label="页内信息导航">
        <button type="button" @click="scrollToSection('attendee')">参会人</button>
        <button type="button" @click="scrollToSection('commerce')">订单与退款</button>
        <button type="button" @click="scrollToSection('invoice')">发票</button>
        <button type="button" @click="scrollToSection('fulfillment')">电子票与签到</button>
        <button type="button" @click="scrollToSection('form-snapshot')">报名表</button>
        <button type="button" @click="scrollToSection('activity')">操作记录</button>
      </nav>

      <div class="operations-workspace">
        <main class="operations-main">
          <section
            v-if="attentionItems.length"
            class="attention-strip"
            aria-labelledby="attention-title"
          >
            <header>
              <p class="eyebrow">ATTENTION</p>
              <h2 id="attention-title">当前需要处理</h2>
            </header>
            <button
              v-for="item in attentionItems"
              :key="item.target"
              type="button"
              :class="item.level"
              @click="scrollToSection(item.target)"
            >
              <span></span>
              <div>
                <strong>{{ item.title }}</strong><small>{{ item.description }}</small>
              </div>
              <b aria-hidden="true">→</b>
            </button>
          </section>

          <section
            v-if="canReview"
            id="registration-review"
            class="operation-card review-card"
            aria-labelledby="review-title"
          >
            <header class="operation-card-head">
              <div>
                <p class="eyebrow">REVIEW</p>
                <h2 id="review-title">处理报名审核</h2>
              </div>
              <span class="state-pill tone-warning">待审核</span>
            </header>
            <div class="review-content">
              <div>
                <strong>核对参会人身份与企业信息</strong>
                <p>通过后将生成支付窗口，免费票会直接签发电子票。</p>
              </div>
              <label><span>审核备注 / 拒绝原因</span><textarea
                v-model="reviewReason"
                rows="3"
                maxlength="500"
                placeholder="通过时可选，拒绝时必填"
              />
              </label>
              <div class="inline-actions">
                <button
                  class="button secondary"
                  type="button"
                  :disabled="reviewPending"
                  @click="review('reject')"
                >
                  拒绝报名
                </button><button
                  class="button"
                  type="button"
                  :disabled="reviewPending"
                  @click="review('approve')"
                >
                  {{ reviewPending ? '处理中…' : '通过审核' }}
                </button>
              </div>
            </div>
          </section>

          <section id="attendee" class="operation-card" aria-labelledby="attendee-title">
            <header class="operation-card-head">
              <div>
                <p class="eyebrow">ATTENDEE</p>
                <h2 id="attendee-title">参会人信息</h2>
              </div>
              <button
                v-if="detail.capabilities.review_registration?.allowed"
                class="text-action"
                type="button"
                @click="attendeeEditOpen ? (attendeeEditOpen = false) : fillAttendeeForm()"
              >
                {{ attendeeEditOpen ? '取消编辑' : '编辑资料' }}
              </button>
            </header>
            <form v-if="attendeeEditOpen" class="attendee-edit-form" @submit.prevent="saveAttendee">
              <label><span>真实姓名</span><input v-model="attendeeForm.name" maxlength="80" /></label>
              <label><span>手机号码</span><input v-model="attendeeForm.mobile" minlength="7" maxlength="24" required /></label>
              <label><span>电子邮箱</span><input v-model="attendeeForm.email" type="email" /></label>
              <label><span>公司 / 机构</span><input v-model="attendeeForm.company" maxlength="120" /></label>
              <label><span>职位</span><input v-model="attendeeForm.title" maxlength="80" /></label>
              <label><span>所在城市</span><input v-model="attendeeForm.city" maxlength="60" /></label>
              <label class="full"><span>修改原因</span><input v-model="attendeeForm.reason" minlength="2" maxlength="500" required /></label>
              <div class="full form-submit-row">
                <small>修改会保留操作人、时间、修改前内容和原因。</small><button class="button" type="submit" :disabled="attendeeSaving">
                  {{ attendeeSaving ? '保存中…' : '保存资料' }}
                </button>
              </div>
            </form>
            <dl v-else class="detail-facts attendee-facts">
              <div>
                <dt>真实姓名</dt>
                <dd>{{ registration.attendee.name || '待补充' }}</dd>
              </div>
              <div>
                <dt>手机号码</dt>
                <dd>{{ registration.attendee.mobile }}</dd>
              </div>
              <div>
                <dt>电子邮箱</dt>
                <dd>{{ registration.attendee.email || '待补充' }}</dd>
              </div>
              <div>
                <dt>公司 / 机构</dt>
                <dd>{{ registration.attendee.company || '待补充' }}</dd>
              </div>
              <div>
                <dt>职位</dt>
                <dd>{{ registration.attendee.title || '待补充' }}</dd>
              </div>
              <div>
                <dt>所在城市</dt>
                <dd>{{ registration.attendee.city || '待补充' }}</dd>
              </div>
            </dl>
          </section>

          <section id="commerce" class="operation-card" aria-labelledby="commerce-title">
            <header class="operation-card-head">
              <div>
                <p class="eyebrow">COMMERCE</p>
                <h2 id="commerce-title">订单、支付与退款</h2>
              </div>
              <button
                v-if="canStartRefund && !refundFormOpen"
                class="button danger compact"
                type="button"
                @click="openRefundForm"
              >
                发起退款
              </button>
              <span v-else-if="commerce && !canStartRefund" class="operation-hint">{{
                refundDisabledReason
              }}</span>
            </header>
            <div v-if="detail.commerce.access === 'restricted'" class="permission-empty">
              <strong>订单信息受权限保护</strong>
              <p>当前角色没有订单查看权限。</p>
            </div>
            <template v-else-if="commerce">
              <dl v-if="order" class="detail-facts commerce-facts">
                <div>
                  <dt>订单号</dt>
                  <dd class="mono-code">{{ order.orderNo }}</dd>
                </div>
                <div>
                  <dt>订单状态</dt>
                  <dd>{{ statusLabel(order.status) }}</dd>
                </div>
                <div>
                  <dt>订单金额</dt>
                  <dd>{{ money(order.amount) }}</dd>
                </div>
                <div>
                  <dt>支付方式</dt>
                  <dd>{{ paymentMethodLabel(order.paymentMethod) }}</dd>
                </div>
                <div>
                  <dt>创建时间</dt>
                  <dd>{{ dateTime(order.createdAt) }}</dd>
                </div>
                <div>
                  <dt>支付窗口截止</dt>
                  <dd>{{ dateTime(order.expiresAt) }}</dd>
                </div>
              </dl>
              <div v-else class="section-empty">当前报名没有关联订单。</div>

              <form
                v-if="refundFormOpen && order"
                class="refund-preview"
                @submit.prevent="submitRefund"
              >
                <div class="refund-preview-head">
                  <div><span>退款操作</span><strong>先确认金额与后续影响</strong></div>
                  <button
                    class="text-action"
                    type="button"
                    :disabled="refundPending"
                    @click="refundFormOpen = false"
                  >
                    收起
                  </button>
                </div>
                <div class="refund-preview-grid">
                  <label><span>退款金额（元）</span><input
                    ref="refundAmountInput"
                    v-model.number="refundForm.amountYuan"
                    type="number"
                    min="0.01"
                    :max="refundableAmount / 100"
                    step="0.01"
                    required
                  /></label>
                  <label><span>退款原因</span><input v-model="refundForm.reason" minlength="2" maxlength="240" required /></label>
                  <div>
                    <span>退款后可退余额</span><strong>{{ money(Math.max(0, refundableAmount - refundAmount)) }}</strong>
                  </div>
                </div>
                <div class="impact-note">
                  <span aria-hidden="true">i</span>
                  <p>{{ refundInvoiceImpact }}</p>
                </div>
                <div class="refund-confirm">
                  <p>
                    支付渠道：{{
                      commerce.successfulPayment
                        ? paymentProviderLabel(commerce.successfulPayment.provider)
                        : paymentMethodLabel(order.paymentMethod)
                    }}。退款提交后可在下方记录中追踪结果。
                  </p>
                  <button class="button danger" type="submit" :disabled="refundPending">
                    {{ refundPending ? '提交中…' : `确认退款 ${money(refundAmount)}` }}
                  </button>
                </div>
              </form>

              <section class="commerce-subsection">
                <header>
                  <strong>支付记录</strong><span>{{ commerce.paymentAttempts.length }} 条</span>
                </header>
                <div
                  v-if="commerce.paymentAttempts.length"
                  class="compact-table"
                  role="table"
                  aria-label="支付记录"
                >
                  <div class="compact-table-head" role="row">
                    <span>渠道</span><span>状态</span><span>金额</span><span>时间</span>
                  </div>
                  <div v-for="payment in commerce.paymentAttempts" :key="payment.id" role="row">
                    <span>{{ paymentProviderLabel(payment.provider) }}</span><span><i class="status-badge" :class="statusClass(payment.status)">{{
                      statusLabel(payment.status)
                    }}</i></span><span>{{ money(payment.amount) }}</span><span>{{ dateTime(payment.updatedAt) }}</span>
                  </div>
                </div>
                <p v-else class="subsection-empty">暂无支付尝试记录。</p>
              </section>

              <section class="commerce-subsection refund-subsection">
                <header>
                  <strong>退款记录</strong><span>{{ commerce.refunds.length }} 条</span>
                </header>
                <ul v-if="commerce.refunds.length" class="refund-list">
                  <li v-for="refund in commerce.refunds" :key="refund.id">
                    <div>
                      <strong>{{ money(refund.amount) }}</strong><i class="status-badge" :class="statusClass(refund.status)">{{
                        statusLabel(refund.status)
                      }}</i>
                    </div>
                    <p>{{ refund.reason }}</p>
                    <small>{{ refund.refundNo }} · {{ dateTime(refund.createdAt) }}</small>
                  </li>
                </ul>
                <p v-else class="subsection-empty">当前订单没有退款记录。</p>
              </section>
            </template>
          </section>

          <RegistrationInvoicePanel
            :context="detail.invoice"
            :invoice-required="registration.invoiceRequired"
            :order-status="order?.status"
            :event-id="eventId!"
            :can-manage="canManageInvoice"
            @refresh="load({ quiet: true })"
            @success="onInvoiceSuccess"
            @error="onInvoiceError"
          />

          <section id="fulfillment" class="operation-card" aria-labelledby="fulfillment-title">
            <header class="operation-card-head">
              <div>
                <p class="eyebrow">FULFILLMENT</p>
                <h2 id="fulfillment-title">电子票与签到</h2>
              </div>
              <span
                class="state-pill"
                :class="
                  detail.fulfillment.ticket?.status === 'used' ? 'tone-success' : 'tone-neutral'
                "
              >{{
                detail.fulfillment.ticket
                  ? statusLabel(detail.fulfillment.ticket.status)
                  : '未出票'
              }}</span>
            </header>
            <dl v-if="detail.fulfillment.ticket" class="detail-facts ticket-facts">
              <div>
                <dt>电子票状态</dt>
                <dd>{{ statusLabel(detail.fulfillment.ticket.status) }}</dd>
              </div>
              <div>
                <dt>票码</dt>
                <dd class="mono-code">{{ detail.fulfillment.ticket.code }}</dd>
              </div>
              <div>
                <dt>签发时间</dt>
                <dd>{{ dateTime(detail.fulfillment.ticket.issuedAt) }}</dd>
              </div>
            </dl>
            <div v-else class="section-empty">当前报名尚未签发电子票。</div>
            <section class="commerce-subsection">
              <header>
                <strong>签到记录</strong><span>{{ detail.fulfillment.checkins.length }} 条</span>
              </header>
              <ul v-if="detail.fulfillment.checkins.length" class="checkin-list">
                <li v-for="checkin in detail.fulfillment.checkins" :key="checkin.id">
                  <span :class="checkin.result"></span>
                  <div>
                    <strong>{{ checkinResultLabel(checkin.result) }} · {{ checkin.listName }}</strong>
                    <p>{{ checkin.operatorName || '设备签到' }} · {{ checkin.deviceName }}</p>
                  </div>
                  <time>{{ dateTime(checkin.checkedInAt) }}</time>
                </li>
              </ul>
              <p v-else class="subsection-empty">暂无签到记录。</p>
            </section>
          </section>

          <section id="form-snapshot" class="operation-card" aria-labelledby="form-title">
            <header class="operation-card-head">
              <div>
                <p class="eyebrow">FORM SNAPSHOT</p>
                <h2 id="form-title">报名表与授权</h2>
              </div>
              <span class="operation-hint">表单 V{{ registration.formVersion ?? 1 }} · 条款
                {{ registration.termsVersion || '未记录' }}</span>
            </header>
            <dl class="detail-facts form-facts">
              <div v-for="answer in answerEntries(registration)" :key="answer.key">
                <dt>{{ answer.label }}</dt>
                <dd>{{ answer.value }}</dd>
              </div>
              <div>
                <dt>是否需要发票</dt>
                <dd>{{ registration.invoiceRequired ? '是' : '否' }}</dd>
              </div>
              <div>
                <dt>营销信息授权</dt>
                <dd>{{ registration.marketingConsent ? '已同意' : '未同意' }}</dd>
              </div>
              <div>
                <dt>条款同意</dt>
                <dd>{{ snapshotText(registration, 'termsAccepted') || '已记录' }}</dd>
              </div>
              <div>
                <dt>同意时间</dt>
                <dd>
                  {{
                    snapshotText(registration, 'acceptedAt')
                      ? dateTime(snapshotText(registration, 'acceptedAt'))
                      : '未记录'
                  }}
                </dd>
              </div>
            </dl>
            <details v-if="snapshotText(registration, 'termsContent')" class="terms-snapshot">
              <summary>查看报名时同意的条款快照</summary>
              <p>{{ snapshotText(registration, 'termsContent') }}</p>
            </details>
          </section>

          <section id="activity" class="operation-card" aria-labelledby="activity-title">
            <header class="operation-card-head">
              <div>
                <p class="eyebrow">ACTIVITY</p>
                <h2 id="activity-title">操作与状态记录</h2>
              </div>
              <span class="operation-hint">{{ activityItems.length }} 条</span>
            </header>
            <ol class="activity-list">
              <li v-for="item in activityItems" :key="item.id">
                <span :class="`tone-${item.tone}`"></span>
                <div>
                  <strong>{{ item.title }}</strong>
                  <p>{{ item.description }}</p>
                </div>
                <time>{{ dateTime(item.occurredAt) }}</time>
              </li>
            </ol>
          </section>
        </main>

        <aside class="operations-aside">
          <section class="side-card identity-card">
            <div class="identity-monogram">{{ registration.attendee.name.slice(0, 1) }}</div>
            <h2>{{ registration.attendee.name }}</h2>
            <p>
              {{ registration.attendee.company || '公司待补充'
              }}<template v-if="registration.attendee.title">
                · {{ registration.attendee.title }}
              </template>
            </p>
            <dl>
              <div>
                <dt>手机</dt>
                <dd>{{ registration.attendee.mobile }}</dd>
              </div>
              <div>
                <dt>邮箱</dt>
                <dd>{{ registration.attendee.email || '待补充' }}</dd>
              </div>
              <div>
                <dt>城市</dt>
                <dd>{{ registration.attendee.city || '待补充' }}</dd>
              </div>
            </dl>
            <button class="button secondary full-button" type="button" @click="copyContact">
              {{ copied ? '联系方式已复制' : '复制联系方式' }}
            </button>
          </section>

          <section class="side-card quick-card">
            <header>
              <p class="eyebrow">QUICK ACTIONS</p>
              <h2>快捷操作</h2>
            </header>
            <button v-if="canReview" type="button" @click="scrollToSection('registration-review')">
              <span>处理报名审核</span><b>→</b>
            </button>
            <button
              v-if="canStartRefund"
              type="button"
              @click="
                openRefundForm();
                scrollToSection('commerce');
              "
            >
              <span>发起订单退款</span><b>→</b>
            </button>
            <button type="button" @click="scrollToSection('invoice')">
              <span>查看发票管理</span><b>→</b>
            </button>
            <button
              v-if="detail.capabilities.review_registration?.allowed"
              type="button"
              @click="
                fillAttendeeForm();
                scrollToSection('attendee');
              "
            >
              <span>更正参会资料</span><b>→</b>
            </button>
          </section>

          <section class="side-card account-card">
            <header>
              <p class="eyebrow">USER ACCOUNT</p>
              <h2>用户账号</h2>
            </header>
            <template v-if="detail.customer.access === 'included'">
              <dl>
                <div>
                  <dt>账号姓名</dt>
                  <dd>
                    {{
                      detail.customer.customer.profile.realName ||
                        detail.customer.customer.profile.nickname ||
                        '待补充'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>账号状态</dt>
                  <dd>{{ statusLabel(detail.customer.customer.status) }}</dd>
                </div>
                <div>
                  <dt>最近登录</dt>
                  <dd>
                    {{
                      detail.customer.customer.lastLoginAt
                        ? dateTime(detail.customer.customer.lastLoginAt)
                        : '暂无'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>账号标签</dt>
                  <dd>{{ detail.customer.customer.tags.join('、') || '无' }}</dd>
                </div>
              </dl>
            </template>
            <p v-else class="side-empty">
              {{
                detail.customer.access === 'restricted'
                  ? '当前角色没有用户账号查看权限。'
                  : '本次报名未关联前台用户账号。'
              }}
            </p>
          </section>

          <section
            v-if="detail.capabilities.review_registration?.allowed"
            class="side-card note-card"
          >
            <header>
              <p class="eyebrow">INTERNAL NOTES</p>
              <h2>内部备注</h2>
            </header>
            <form @submit.prevent="addNote">
              <label for="registration-note">记录需交接的信息</label><textarea
                id="registration-note"
                v-model="noteBody"
                rows="4"
                maxlength="2000"
                placeholder="例如：参会人要求会前电话确认发票抬头"
              /><button
                class="button full-button"
                type="submit"
                :disabled="noteSaving || !noteBody.trim()"
              >
                {{ noteSaving ? '保存中…' : '添加备注' }}
              </button>
            </form>
            <ul v-if="detail.notes.length">
              <li v-for="note in detail.notes.slice(0, 5)" :key="note.id">
                <p>{{ note.body }}</p>
                <small>{{ note.authorName || '运营人员' }} · {{ dateTime(note.createdAt) }}</small>
              </li>
            </ul>
            <p v-else class="side-empty">暂无内部备注。</p>
          </section>

          <section class="side-card record-card">
            <header>
              <p class="eyebrow">RECORD</p>
              <h2>记录标识</h2>
            </header>
            <dl>
              <div>
                <dt>报名 ID</dt>
                <dd class="mono-code">{{ registration.id }}</dd>
              </div>
              <div>
                <dt>最后更新</dt>
                <dd>{{ dateTime(registration.updatedAt) }}</dd>
              </div>
              <div>
                <dt>数据快照</dt>
                <dd>{{ dateTime(detail.snapshotAt) }}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.registration-detail-page {
  --registration-font-micro: 11px;
  --registration-font-label: 12px;
  --registration-font-control: 13px;
  --registration-font-body: 14px;

  font-size: var(--registration-font-body);
}
.registration-breadcrumb {
  margin-bottom: 14px;
}
.registration-breadcrumb a {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: var(--registration-font-control);
  font-weight: 700;
  transition:
    color 140ms var(--ease),
    transform 140ms var(--ease);
}
.registration-breadcrumb a:hover {
  color: var(--blue);
}
.registration-breadcrumb a:active {
  transform: scale(0.97);
}
.registration-detail-state {
  display: grid;
  min-height: 440px;
  place-items: center;
  text-align: center;
}
.registration-detail-state .admin-error {
  width: min(520px, calc(100vw - 48px));
  margin: 0 0 14px;
}
.registration-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin-bottom: 18px;
  padding: 0 2px;
}
.registration-hero-copy {
  min-width: 0;
}
.hero-kicker {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
}
.hero-kicker > span {
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--registration-font-label);
  font-weight: 700;
  letter-spacing: 0.18em;
}
.hero-kicker i {
  display: inline-flex;
  padding: 4px 7px;
  border-radius: 4px;
  background: #edf6f1;
  color: #25664e;
  font-size: var(--registration-font-label);
  font-style: normal;
  font-weight: 700;
}
.registration-hero h1 {
  margin: 0;
  color: var(--ink);
  font-family: var(--serif);
  font-size: clamp(34px, 4vw, 52px);
  font-weight: 500;
  letter-spacing: -0.025em;
  line-height: 1.05;
}
.registration-hero p {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin: 9px 0 0;
  color: var(--muted);
  font-size: var(--registration-font-body);
}
.registration-hero p b {
  color: #bdc5cb;
  font-weight: 400;
}
.message-stack {
  position: sticky;
  z-index: 12;
  top: 8px;
}
.message-stack > p {
  margin: 0 0 10px;
  box-shadow: 0 7px 20px rgb(22 33 49 / 6%);
}
.operations-summary {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin-bottom: 12px;
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.operations-summary > div {
  min-width: 0;
  padding: 15px 16px 14px;
}
.operations-summary > div + div {
  border-left: 1px solid var(--line);
}
.operations-summary span,
.operations-summary small {
  display: block;
  overflow: hidden;
  color: var(--muted);
  font-size: var(--registration-font-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.operations-summary strong {
  display: block;
  min-height: 27px;
  margin: 6px 0 3px;
  overflow: hidden;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.operations-summary .status-badge {
  display: inline-flex;
  width: fit-content;
  font-family: var(--mono);
  font-style: normal;
}
.operations-summary .summary-danger {
  box-shadow: inset 0 3px 0 #c84c3e;
}
.operations-summary .summary-warning {
  box-shadow: inset 0 3px 0 #b98422;
}
.operations-summary .summary-success {
  box-shadow: inset 0 3px 0 #318263;
}
.detail-anchor-nav {
  position: sticky;
  z-index: 10;
  top: 0;
  display: flex;
  gap: 2px;
  margin-bottom: 16px;
  padding: 5px;
  overflow-x: auto;
  background: rgb(248 249 249 / 94%);
  border: 1px solid var(--line);
  border-radius: 6px;
  backdrop-filter: blur(12px);
}
.detail-anchor-nav button {
  min-height: 40px;
  padding: 0 12px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--registration-font-control);
  font-weight: 700;
  white-space: nowrap;
}
.detail-anchor-nav button:hover {
  background: #fff;
  color: var(--blue);
}
.operations-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 274px;
  gap: 16px;
  align-items: start;
}
.operations-main {
  display: grid;
  min-width: 0;
  gap: 14px;
}
.operations-aside {
  position: sticky;
  top: 55px;
  display: grid;
  gap: 12px;
  min-width: 0;
  max-height: calc(100vh - 65px);
  overflow-y: auto;
  scrollbar-width: thin;
}
.operation-card,
.side-card {
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  scroll-margin-top: 96px;
}
.operation-card-head {
  display: flex;
  min-height: 64px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 18px 13px;
  border-bottom: 1px solid var(--line);
}
.operation-card-head h2,
.side-card h2 {
  margin: 3px 0 0;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 18px;
  font-weight: 600;
}
.state-pill {
  display: inline-flex;
  min-height: 27px;
  align-items: center;
  padding: 5px 9px;
  border-radius: 5px;
  background: #f0f2f3;
  color: var(--muted);
  font-size: var(--registration-font-label);
  font-weight: 700;
}
.tone-success {
  background: #edf6f1 !important;
  color: #25664e !important;
}
.tone-warning {
  background: #fff5df !important;
  color: #8a5c0c !important;
}
.tone-danger {
  background: #fff0ed !important;
  color: #b83f32 !important;
}
.tone-info {
  background: #edf3fa !important;
  color: var(--blue) !important;
}
.tone-neutral {
  background: #f0f2f3 !important;
  color: var(--muted) !important;
}
.text-action {
  min-width: 40px;
  min-height: 40px;
  padding: 0 8px;
  background: transparent;
  border: 0;
  color: var(--blue);
  cursor: pointer;
  font: inherit;
  font-size: var(--registration-font-control);
  font-weight: 700;
}
.operation-hint {
  color: var(--muted);
  font-size: var(--registration-font-label);
  text-align: right;
}
.attention-strip {
  display: grid;
  grid-template-columns: 150px repeat(3, minmax(0, 1fr));
  overflow: hidden;
  background: #fff;
  border: 1px solid #e8dcc4;
  border-radius: var(--radius-sm);
}
.attention-strip > header {
  padding: 15px 17px;
  background: #fffbf2;
}
.attention-strip h2 {
  margin: 3px 0 0;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 16px;
  font-weight: 600;
}
.attention-strip > button {
  display: grid;
  grid-template-columns: 7px 1fr auto;
  gap: 9px;
  align-items: center;
  min-width: 0;
  padding: 13px 14px;
  background: #fff;
  border: 0;
  border-left: 1px solid #eee4d1;
  color: var(--ink);
  cursor: pointer;
  text-align: left;
}
.attention-strip > button > span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #b98422;
}
.attention-strip > button.high > span {
  background: #c84c3e;
}
.attention-strip > button strong,
.attention-strip > button small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attention-strip > button strong {
  font-size: var(--registration-font-body);
}
.attention-strip > button small {
  margin-top: 4px;
  color: var(--muted);
  font-size: var(--registration-font-micro);
}
.attention-strip > button b {
  color: var(--muted);
  font-size: var(--registration-font-body);
}
.review-card {
  border-color: #e7d7b7;
}
.review-content {
  display: grid;
  grid-template-columns: minmax(180px, 0.65fr) minmax(260px, 1fr) auto;
  gap: 16px;
  align-items: end;
  padding: 17px 18px;
  background: #fffbf3;
}
.review-content strong {
  color: var(--ink);
  font-size: var(--registration-font-body);
}
.review-content p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: var(--registration-font-label);
  line-height: 1.6;
}
.review-content label,
.attendee-edit-form label,
.refund-preview label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: var(--registration-font-label);
}
.review-content textarea,
.attendee-edit-form input,
.refund-preview input {
  width: 100%;
  min-height: 39px;
  padding: 9px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: #fff;
  color: var(--ink);
  font: inherit;
  resize: vertical;
}
.inline-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.detail-facts {
  display: grid;
  margin: 0;
}
.attendee-facts,
.commerce-facts,
.form-facts {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.ticket-facts {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.detail-facts > div {
  min-width: 0;
  padding: 13px 16px;
  border-right: 1px solid rgb(23 34 51 / 7%);
  border-bottom: 1px solid rgb(23 34 51 / 7%);
}
.detail-facts > div:nth-child(3n) {
  border-right: 0;
}
.detail-facts dt {
  margin-bottom: 4px;
  color: var(--muted);
  font-size: var(--registration-font-label);
}
.detail-facts dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--ink);
  font-size: var(--registration-font-body);
  font-weight: 600;
  line-height: 1.55;
}
.mono-code {
  color: #455461 !important;
  font-family: var(--mono);
  font-size: var(--registration-font-micro) !important;
  font-weight: 500 !important;
}
.attendee-edit-form {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 13px;
  padding: 17px 18px;
  background: #f8fafb;
}
.attendee-edit-form .full {
  grid-column: 1 / -1;
}
.form-submit-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.form-submit-row small {
  color: var(--muted);
  font-size: var(--registration-font-label);
}
.permission-empty,
.section-empty {
  padding: 28px 18px;
  color: var(--muted);
  font-size: var(--registration-font-body);
  text-align: center;
}
.permission-empty strong {
  display: block;
  margin-bottom: 5px;
  color: var(--ink);
  font-size: var(--registration-font-body);
}
.permission-empty p {
  margin: 0;
}
.refund-preview {
  padding: 17px 18px;
  background: #fff8f5;
  border-bottom: 1px solid #efd9d3;
}
.refund-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 13px;
}
.refund-preview-head span,
.refund-preview-grid span {
  display: block;
  color: var(--muted);
  font-size: var(--registration-font-label);
}
.refund-preview-head strong {
  display: block;
  margin-top: 3px;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 16px;
}
.refund-preview-grid {
  display: grid;
  grid-template-columns: minmax(150px, 0.45fr) minmax(240px, 1fr) minmax(145px, 0.35fr);
  gap: 12px;
  align-items: end;
}
.refund-preview-grid > div {
  padding: 9px 11px;
  background: #fff;
  border: 1px solid #ead6d0;
  border-radius: 4px;
}
.refund-preview-grid strong {
  display: block;
  margin-top: 6px;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 17px;
}
.impact-note {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  margin-top: 12px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #ead6d0;
  border-radius: 4px;
}
.impact-note > span {
  display: grid;
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  place-items: center;
  border-radius: 50%;
  background: #f6ded8;
  color: var(--red);
  font-family: var(--serif);
  font-size: var(--registration-font-micro);
  font-weight: 700;
}
.impact-note p,
.refund-confirm p {
  margin: 0;
  color: #6d524d;
  font-size: var(--registration-font-body);
  line-height: 1.65;
}
.refund-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-top: 12px;
}
.refund-confirm p {
  max-width: 620px;
}
.commerce-subsection {
  padding: 15px 18px;
  border-top: 1px solid var(--line);
}
.commerce-subsection > header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
  color: var(--ink);
  font-size: var(--registration-font-body);
}
.commerce-subsection > header span {
  color: var(--muted);
}
.compact-table {
  border: 1px solid #edf0f1;
  border-radius: 4px;
}
.compact-table > div {
  display: grid;
  grid-template-columns: 1fr 0.8fr 0.7fr 1fr;
  gap: 10px;
  align-items: center;
  min-height: 39px;
  padding: 7px 10px;
  border-top: 1px solid #edf0f1;
  color: #46535f;
  font-size: var(--registration-font-control);
}
.compact-table > div:first-child {
  border-top: 0;
}
.compact-table .compact-table-head {
  min-height: 31px;
  background: #f7f8f8;
  color: var(--muted);
  font-size: var(--registration-font-micro);
  font-weight: 700;
}
.compact-table .status-badge {
  display: inline-flex;
}
.refund-list,
.checkin-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.refund-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.refund-list li {
  padding: 11px 12px;
  background: #f7f8f8;
  border: 1px solid #edf0f1;
  border-radius: 4px;
}
.refund-list li > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.refund-list strong {
  color: var(--ink);
  font-family: var(--serif);
  font-size: 15px;
}
.refund-list i {
  font-style: normal;
}
.refund-list p {
  margin: 6px 0 3px;
  color: #455461;
  font-size: var(--registration-font-body);
}
.refund-list small,
.subsection-empty {
  color: var(--muted);
  font-size: var(--registration-font-micro);
}
.subsection-empty {
  margin: 0;
  padding: 12px;
  text-align: center;
}
.checkin-list li {
  display: grid;
  grid-template-columns: 8px 1fr auto;
  gap: 10px;
  align-items: start;
  padding: 10px 0;
  border-top: 1px solid #edf0f1;
}
.checkin-list li:first-child {
  border-top: 0;
}
.checkin-list li > span {
  width: 7px;
  height: 7px;
  margin-top: 3px;
  border-radius: 50%;
  background: #b98422;
}
.checkin-list li > span.accepted {
  background: #318263;
}
.checkin-list strong {
  color: var(--ink);
  font-size: var(--registration-font-body);
}
.checkin-list p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: var(--registration-font-label);
}
.checkin-list time,
.activity-list time {
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--registration-font-micro);
  white-space: nowrap;
}
.terms-snapshot {
  padding: 0 18px;
}
.terms-snapshot summary {
  min-height: 45px;
  padding: 14px 0;
  color: var(--blue);
  cursor: pointer;
  font-size: var(--registration-font-control);
  font-weight: 700;
}
.terms-snapshot p {
  margin: 0 0 16px;
  color: #455461;
  font-size: var(--registration-font-body);
  line-height: 1.75;
  white-space: pre-wrap;
}
.activity-list {
  margin: 0;
  padding: 7px 18px 13px;
  list-style: none;
}
.activity-list li {
  display: grid;
  grid-template-columns: 9px 1fr auto;
  gap: 11px;
  align-items: start;
  padding: 11px 0;
  border-bottom: 1px solid #edf0f1;
}
.activity-list li:last-child {
  border-bottom: 0;
}
.activity-list li > span {
  width: 8px;
  height: 8px;
  margin-top: 3px;
  border: 2px solid #aab4bc;
  border-radius: 50%;
  background: #fff !important;
}
.activity-list li > span.tone-success {
  border-color: #318263;
}
.activity-list li > span.tone-warning {
  border-color: #b98422;
}
.activity-list li > span.tone-info {
  border-color: var(--blue);
}
.activity-list strong {
  color: var(--ink);
  font-size: var(--registration-font-body);
}
.activity-list p {
  margin: 3px 0 0;
  color: #53606b;
  font-size: var(--registration-font-body);
  line-height: 1.55;
}
.side-card {
  padding: 16px;
}
.side-card > header {
  margin: -1px 0 13px;
}
.side-card h2 {
  font-size: 16px;
}
.identity-card {
  text-align: center;
}
.identity-monogram {
  display: grid;
  width: 46px;
  height: 46px;
  margin: 1px auto 10px;
  place-items: center;
  border-radius: 50%;
  background: #eaf0f6;
  color: var(--blue);
  font-family: var(--serif);
  font-size: 20px;
}
.identity-card h2 {
  margin: 0;
  font-size: 20px;
}
.identity-card > p {
  margin: 5px 0 14px;
  color: var(--muted);
  font-size: var(--registration-font-label);
}
.side-card dl {
  margin: 0 0 13px;
  text-align: left;
}
.side-card dl > div {
  padding: 8px 0;
  border-top: 1px solid #edf0f1;
}
.side-card dt {
  margin-bottom: 3px;
  color: var(--muted);
  font-size: var(--registration-font-label);
}
.side-card dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--ink);
  font-size: var(--registration-font-body);
  font-weight: 600;
  line-height: 1.5;
}
.full-button {
  width: 100%;
}
.quick-card {
  padding-bottom: 8px;
}
.quick-card > button {
  display: flex;
  width: calc(100% + 32px);
  min-height: 41px;
  align-items: center;
  justify-content: space-between;
  margin: 0 -16px;
  padding: 0 16px;
  background: #fff;
  border: 0;
  border-top: 1px solid #edf0f1;
  color: #3f4c58;
  cursor: pointer;
  font: inherit;
  font-size: var(--registration-font-control);
  text-align: left;
}
.quick-card > button:hover {
  background: #f7f9fa;
  color: var(--blue);
}
.quick-card > button b {
  color: #9da8b1;
}
.side-empty {
  margin: 0;
  padding: 12px 0 4px;
  color: var(--muted);
  font-size: var(--registration-font-body);
  line-height: 1.65;
  text-align: center;
}
.note-card form label {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: var(--registration-font-label);
}
.note-card textarea {
  width: 100%;
  margin-bottom: 8px;
  padding: 9px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--ink);
  font: inherit;
  font-size: var(--registration-font-body);
  line-height: 1.6;
  resize: vertical;
}
.note-card ul {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.note-card li {
  padding: 10px 0;
  border-top: 1px solid #edf0f1;
}
.note-card li p {
  margin: 0 0 4px;
  color: #455461;
  font-size: var(--registration-font-body);
  line-height: 1.6;
}
.note-card li small {
  color: var(--muted);
  font-size: var(--registration-font-micro);
}
@media (max-width: 1180px) {
  .operations-workspace {
    grid-template-columns: minmax(0, 1fr) 245px;
  }
  .attention-strip {
    grid-template-columns: 130px repeat(2, minmax(0, 1fr));
  }
  .attention-strip > button:nth-of-type(3) {
    grid-column: 2 / -1;
    border-top: 1px solid #eee4d1;
  }
}
@media (max-width: 980px) {
  .operations-summary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .operations-summary > div:nth-child(4),
  .operations-summary > div:nth-child(5) {
    border-top: 1px solid var(--line);
  }
  .operations-summary > div:nth-child(4) {
    border-left: 0;
  }
  .operations-workspace {
    grid-template-columns: 1fr;
  }
  .operations-aside {
    position: static;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-height: none;
    overflow: visible;
  }
  .review-content {
    grid-template-columns: 1fr;
  }
  .review-content .inline-actions {
    justify-content: flex-start;
  }
  .refund-preview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .refund-preview-grid > div {
    grid-column: 1 / -1;
  }
  .attendee-facts,
  .commerce-facts,
  .form-facts,
  .attendee-edit-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .detail-facts > div:nth-child(3n) {
    border-right: 1px solid rgb(23 34 51 / 7%);
  }
  .detail-facts > div:nth-child(2n) {
    border-right: 0;
  }
}
@media (max-width: 700px) {
  .registration-hero {
    align-items: flex-start;
    flex-direction: column;
  }
  .registration-hero .admin-head-actions {
    width: 100%;
  }
  .registration-hero .button {
    flex: 1;
  }
  .operations-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .operations-summary > div {
    border-top: 1px solid var(--line);
    border-left: 0 !important;
  }
  .operations-summary > div:nth-child(-n + 2) {
    border-top: 0;
  }
  .operations-summary > div:nth-child(2n) {
    border-left: 1px solid var(--line) !important;
  }
  .operations-summary > div:last-child {
    grid-column: 1 / -1;
    border-left: 0 !important;
  }
  .attention-strip {
    grid-template-columns: 1fr;
  }
  .attention-strip > button {
    border-top: 1px solid #eee4d1;
    border-left: 0;
  }
  .attention-strip > button:nth-of-type(3) {
    grid-column: auto;
  }
  .operations-aside {
    grid-template-columns: 1fr;
  }
  .refund-preview-grid,
  .attendee-facts,
  .commerce-facts,
  .form-facts,
  .ticket-facts,
  .attendee-edit-form {
    grid-template-columns: 1fr;
  }
  .detail-facts > div,
  .detail-facts > div:nth-child(2n),
  .detail-facts > div:nth-child(3n) {
    border-right: 0;
  }
  .refund-confirm,
  .form-submit-row {
    align-items: stretch;
    flex-direction: column;
  }
  .refund-confirm .button {
    width: 100%;
  }
  .refund-list {
    grid-template-columns: 1fr;
  }
  .compact-table > div {
    grid-template-columns: 1fr 0.75fr 0.7fr;
  }
  .compact-table > div > span:last-child {
    display: none;
  }
  .operation-card-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .operation-hint {
    text-align: left;
  }
}
@media (prefers-reduced-motion: reduce) {
  .registration-breadcrumb a {
    transition: none;
  }
  .detail-anchor-nav button {
    scroll-behavior: auto;
  }
}
</style>
