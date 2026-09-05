<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { AdminRefundApplicationView } from '@conference/contracts';
import { conferenceApi, session } from '../../lib/api';
import { dateTime, money } from '../../lib/format';
const props = defineProps<{ eventId: number; orderId?: string }>();
const emit = defineEmits<{ changed: [] }>();
const rows = ref<AdminRefundApplicationView[]>([]);
const exceptions = ref<Awaited<ReturnType<typeof conferenceApi.refundExceptions>>>([]);
const pending = ref(false);
const loading = ref(false);
const errorMessage = ref('');
const message = ref('');
const reason = ref('');
const externalNumber = ref('');
const filter = ref('all');
const offset = ref(0);
const canManage = computed(() => session.canAny(['event.order.refund']));
let timer: ReturnType<typeof setInterval> | undefined;
let loadVersion = 0;
let scopeVersion = 0;
function label(row: AdminRefundApplicationView) {
  if (row.reviewStatus === 'rejected') return '已驳回';
  if (row.reviewStatus === 'withdrawn') return '已撤回';
  if (row.reviewStatus === 'pending_review') return '待审核';
  if (row.fulfillmentStatus === 'completed') return '退款完成';
  return (
    (
      {
        waiting_funds: '等待资金',
        processing: '微信处理中',
        closed: '渠道已关闭',
        abnormal: '需要财务处理',
        failed: '需要修复配置',
        superseded: '请确认剩余退款',
      } as Record<string, string>
    )[row.executionStatus ?? ''] ?? '已批准，等待处理'
  );
}
async function load() {
  const version = ++loadVersion;
  const eventId = props.eventId;
  const orderId = props.orderId;
  loading.value = true;
  errorMessage.value = '';
  try {
    const [nextExceptions, nextRows] = await Promise.all([
      conferenceApi.refundExceptions(eventId),
      conferenceApi.refundApplications(eventId, {
        ...(orderId ? { orderId } : {}),
        status: filter.value,
        offset: offset.value,
      }),
    ]);
    if (version !== loadVersion || eventId !== props.eventId || orderId !== props.orderId) return;
    exceptions.value = nextExceptions.filter((row) => !orderId || row.orderId === orderId);
    rows.value = nextRows;
  } catch (error) {
    if (version === loadVersion)
      errorMessage.value = error instanceof Error ? error.message : '退款申请读取失败';
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
async function act(
  row: AdminRefundApplicationView,
  action: 'approve' | 'reject' | 'retry' | 'reconcile' | 'continue',
) {
  if (
    pending.value ||
    row.eventId !== props.eventId ||
    (props.orderId && row.orderId !== props.orderId)
  )
    return;
  const operationScope = scopeVersion;
  if (action === 'reject' && reason.value.trim().length < 2) {
    errorMessage.value = '请填写具体的驳回原因';
    return;
  }
  if (
    action === 'approve' &&
    !window.confirm(
      `确认批准订单 ${row.orderNo} 退款 ${money(row.amount)}？${row.fullRefund ? '批准后票券暂停使用。' : ''}将自动向微信申请原路退款。`,
    )
  )
    return;
  if (
    action === 'continue' &&
    !window.confirm(
      `将向微信确认原退款已关闭或尚未受理，随后继续处理剩余 ${money(row.amount - row.completedAmount)}，是否继续？`,
    )
  )
    return;
  pending.value = true;
  errorMessage.value = '';
  message.value = '';
  try {
    await conferenceApi.refundApplicationAction(
      props.eventId,
      row.id,
      action,
      row.version,
      action === 'reject' ? reason.value.trim() : undefined,
    );
    if (operationScope !== scopeVersion) return;
    message.value =
      action === 'approve' ? '已批准，系统将自动提交原路退款。' : '操作已提交，请查看最新进度。';
    reason.value = '';
    emit('changed');
  } catch (error) {
    if (operationScope === scopeVersion)
      errorMessage.value = error instanceof Error ? error.message : '退款操作未完成';
  } finally {
    if (operationScope === scopeVersion) {
      pending.value = false;
      await load();
    }
  }
}
async function external(action: 'external_hold' | 'automatic' | 'verify') {
  if (!props.orderId || pending.value) return;
  const operationScope = scopeVersion;
  const orderId = props.orderId;
  if (action !== 'verify' && reason.value.trim().length < 2) {
    errorMessage.value = '请填写本次处理原因';
    return;
  }
  if (action === 'verify' && !externalNumber.value.trim()) {
    errorMessage.value = '请填写商户退款单号';
    return;
  }
  pending.value = true;
  errorMessage.value = '';
  message.value = '';
  try {
    if (action === 'verify') {
      await conferenceApi.verifyExternalRefund(orderId, externalNumber.value.trim());
      if (operationScope !== scopeVersion) return;
      message.value = '已查询渠道并同步核验结果。';
    } else {
      const result = await conferenceApi.refundExecutionMode(orderId, action, reason.value.trim());
      if (operationScope !== scopeVersion) return;
      message.value =
        action === 'automatic'
          ? '已恢复自动处理。'
          : result.externalReady
            ? '已暂停自动提交，可以按财务流程处理并核验外部退款。'
            : '已暂停后续提交，仍有在途或待核实退款，请先查询，勿另开退款。';
    }
    emit('changed');
  } catch (error) {
    if (operationScope === scopeVersion)
      errorMessage.value = error instanceof Error ? error.message : '外部退款核验未完成';
  } finally {
    if (operationScope === scopeVersion) {
      pending.value = false;
      await load();
    }
  }
}
watch(
  () => [props.eventId, props.orderId],
  () => {
    scopeVersion += 1;
    rows.value = [];
    exceptions.value = [];
    reason.value = '';
    externalNumber.value = '';
    message.value = '';
    pending.value = false;
    offset.value = 0;
    void load();
  },
  { immediate: true },
);
watch(filter, () => {
  offset.value = 0;
  void load();
});
timer = setInterval(() => {
  if (!pending.value && document.visibilityState === 'visible') void load();
}, 30_000);
onBeforeUnmount(() => {
  loadVersion += 1;
  scopeVersion += 1;
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="refund-panel" aria-label="退款申请与审核">
    <header>
      <div>
        <p class="eyebrow">退款服务</p>
        <h2>退款申请与审核</h2>
      </div>
      <button class="button secondary" type="button" :disabled="loading || pending" @click="load">
        刷新
      </button>
    </header>
    <div
      v-for="exception in exceptions"
      :key="exception.orderId"
      class="refund-error"
      role="status"
    >
      <strong>订单 {{ exception.orderNo }} 已暂停自动退款</strong>
      <p>{{ exception.reason || '请由财务核验退款记录后恢复' }}</p>
      <RouterLink
        v-if="!orderId"
        :to="`/admin/events/${eventId}/registrations/${exception.registrationId}`"
      >
        进入订单核验
      </RouterLink>
    </div>
    <p v-if="errorMessage" class="refund-error" role="alert">{{ errorMessage }}</p>
    <p v-if="message" class="refund-message" role="status">{{ message }}</p>
    <label v-if="!orderId" class="filter">处理状态
      <select v-model="filter">
        <option value="all">全部申请</option>
        <option value="pending_review">待审核</option>
        <option value="waiting_funds">等待资金</option>
        <option value="processing">微信处理中</option>
        <option value="attention">异常与超时</option>
        <option value="completed">已完成</option>
      </select></label>
    <p v-if="loading && !rows.length">正在读取退款申请…</p>
    <p v-else-if="!rows.length" class="empty">暂无退款申请。用户可从个人中心的购买订单提交申请。</p>
    <article v-for="row in rows" :key="row.id" class="refund-row">
      <div class="row-head">
        <div>
          <strong>{{ money(row.amount) }}</strong><span>{{ label(row) }}</span>
        </div>
        <small>{{ row.orderNo }} · {{ dateTime(row.createdAt) }}</small>
      </div>
      <p>{{ row.reason || '用户未填写退款原因' }}</p>
      <p>
        {{ row.fullRefund ? '全额退还剩余款项，批准后暂停票券' : '部分退款，保留参会资格' }} ·
        已完成 {{ money(row.completedAmount) }}
      </p>
      <p v-if="row.reviewReason">审核说明：{{ row.reviewReason }}</p>
      <p v-if="row.attentionReason" class="refund-error">{{ row.attentionReason }}</p>
      <p v-if="row.executionMode === 'external_hold'" class="refund-message">
        自动提交已暂停，查询和结果通知继续处理。
      </p>
      <div v-for="execution in row.executions" :key="execution.id" class="execution">
        <small>退款单 {{ execution.refundNo }} ·
          {{ execution.channelStatus || execution.status }}</small>
        <p v-if="execution.lastError">{{ execution.lastError }}</p>
        <p v-if="execution.fulfillmentAttention">{{ execution.fulfillmentAttention }}</p>
        <small v-if="execution.nextAttemptAt">下次处理：{{ dateTime(execution.nextAttemptAt) }}</small>
      </div>
      <div v-if="canManage" class="actions">
        <template v-if="row.reviewStatus === 'pending_review'">
          <button class="button" type="button" :disabled="pending" @click="act(row, 'approve')">
            同意并原路退款
          </button><button
            class="button secondary"
            type="button"
            :disabled="pending"
            @click="act(row, 'reject')"
          >
            驳回申请
          </button>
        </template>
        <template
          v-else-if="row.reviewStatus === 'approved' && row.fulfillmentStatus !== 'completed'"
        >
          <button
            class="button secondary"
            type="button"
            :disabled="pending"
            @click="act(row, 'reconcile')"
          >
            查询最新结果
          </button><button
            v-if="
              ['waiting_funds', 'failed', 'queued', 'query_pending'].includes(
                row.executionStatus || '',
              )
            "
            class="button secondary"
            type="button"
            :disabled="pending"
            @click="act(row, 'retry')"
          >
            补款或修复后重试
          </button><button
            v-if="['closed', 'superseded'].includes(row.executionStatus || '')"
            class="button secondary"
            type="button"
            :disabled="pending"
            @click="act(row, 'continue')"
          >
            确认继续退款
          </button>
        </template>
      </div>
    </article>
    <div v-if="canManage" class="reason">
      <label><span>处理原因 <small>驳回或外部处理时必填</small></span><textarea
        v-model="reason"
        rows="2"
        maxlength="1000"
        :disabled="pending"
        placeholder="填写可供用户或财务理解的具体原因"
      />
      </label>
    </div>
    <details v-if="canManage && orderId" class="external">
      <summary>外部退款核验与自动提交管理</summary>
      <p>在微信商户平台另行退款前，先暂停自动提交并确认在途退款已查清。异常退款应处理原异常单。</p>
      <div class="actions">
        <button
          class="button secondary"
          type="button"
          :disabled="pending"
          @click="external('external_hold')"
        >
          暂停自动提交
        </button><button
          class="button secondary"
          type="button"
          :disabled="pending"
          @click="external('automatic')"
        >
          恢复自动处理
        </button>
      </div>
      <label><span>商户退款单号</span><input v-model="externalNumber" maxlength="64" :disabled="pending" /></label><button
        class="button secondary"
        type="button"
        :disabled="pending"
        @click="external('verify')"
      >
        向微信核验退款
      </button>
    </details>
    <div v-if="offset > 0 || rows.length === 30" class="actions pagination">
      <button
        class="button secondary"
        type="button"
        :disabled="offset === 0 || loading"
        @click="
          offset = Math.max(0, offset - 30);
          load();
        "
      >
        上一页
      </button><button
        class="button secondary"
        type="button"
        :disabled="rows.length < 30 || loading"
        @click="
          offset += 30;
          load();
        "
      >
        下一页
      </button>
    </div>
  </section>
</template>

<style scoped>
.refund-panel {
  padding: 24px;
  border: 1px solid #dbe1e8;
  border-radius: 8px;
  background: #fff;
  margin: 20px 0;
}
header,
.row-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
h2 {
  margin: 4px 0 12px;
  font-size: 22px;
}
.eyebrow {
  color: #315b83;
  font-size: 12px;
  font-weight: 700;
  margin: 0;
}
p {
  line-height: 1.6;
}
small,
.empty {
  color: #5d6877;
}
.refund-row {
  padding: 22px 0;
  border-top: 1px solid #e2e7ec;
}
.row-head strong {
  font-size: 23px;
  font-variant-numeric: tabular-nums;
}
.row-head span {
  margin-left: 14px;
  color: #315b83;
}
.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 14px 0;
}
.execution {
  padding: 12px 16px;
  background: #f4f6f9;
  margin: 10px 0;
  overflow-wrap: anywhere;
}
.execution p {
  margin: 6px 0;
}
.refund-error {
  color: #973e31;
  background: #fff2ef;
  padding: 12px;
}
.refund-message {
  color: #2a5878;
  background: #eff5fa;
  padding: 12px;
}
.reason label,
.external label {
  display: grid;
  gap: 8px;
  margin: 14px 0;
}
textarea,
input,
select {
  border: 1px solid #bdc8d4;
  border-radius: 4px;
  padding: 10px;
  font: inherit;
  max-width: 100%;
}
textarea {
  resize: vertical;
}
.external {
  border-top: 1px solid #dbe1e8;
  margin-top: 20px;
  padding-top: 18px;
}
summary {
  cursor: pointer;
  min-height: 44px;
  display: flex;
  align-items: center;
  font-weight: 600;
}
button:active {
  transform: translateY(1px);
}
.filter {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 16px 0;
}
@media (max-width: 640px) {
  .refund-panel {
    padding: 16px;
  }
  .actions .button {
    flex: 1 1 auto;
  }
}
</style>
