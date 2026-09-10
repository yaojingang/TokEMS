<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { RegistrationBatchCheckout } from '@conference/contracts';
import { conferenceApi, session } from '../../lib/api';
import { money, statusLabel } from '../../lib/format';

const props = defineProps<{ orderId: string; eventId?: number | undefined }>();
const emit = defineEmits<{ changed: [] }>();
const detail = ref<RegistrationBatchCheckout>();
const context = ref<Awaited<ReturnType<typeof conferenceApi.getItemRefundContext>>>();
const loading = ref(false);
const pending = ref(false);
const error = ref('');
const message = ref('');
const reason = ref('');
const selected = reactive<
  Record<string, { checked: boolean; yuan: number; rightsEffect: 'retain' | 'revoke' }>
>({});
const canReview = session.can('event.registration.manage');
const canRefund = session.can('event.order.refund');
let generation = 0;
let scopeGeneration = 0;
let refundIntent: { fingerprint: string; key: string } | undefined;
const allocations = computed(() =>
  (context.value?.items ?? [])
    .filter((item) => selected[item.id]?.checked)
    .map((item) => ({
      orderItemId: item.id,
      version: item.version,
      amount: Math.round(Number(selected[item.id]!.yuan) * 100),
      rightsEffect: selected[item.id]!.rightsEffect,
    })),
);
const total = computed(() => allocations.value.reduce((sum, item) => sum + item.amount, 0));

async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const [order, refund] = await Promise.all([
      conferenceApi.getBatchOrder(props.orderId, props.eventId),
      canRefund ? conferenceApi.getItemRefundContext(props.orderId, props.eventId) : undefined,
    ]);
    if (current !== generation) return;
    detail.value = order;
    context.value = refund;
    Object.keys(selected).forEach((id) => delete selected[id]);
    refund?.items.forEach((item) => {
      selected[item.id] = {
        checked: false,
        yuan: item.refundableAmount / 100,
        rightsEffect: 'retain',
      };
    });
  } catch (failure) {
    if (current === generation)
      error.value = failure instanceof Error ? failure.message : '名额读取失败，请重试';
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => [props.orderId, props.eventId],
  () => {
    scopeGeneration += 1;
    pending.value = false;
    reason.value = '';
    message.value = '';
    refundIntent = undefined;
    detail.value = undefined;
    context.value = undefined;
    void load();
  },
  { immediate: true },
);

async function review(decision: 'approve' | 'reject') {
  if (!detail.value?.order.version || pending.value) return;
  if (decision === 'reject' && reason.value.trim().length < 2) {
    error.value = '请填写拒绝原因';
    return;
  }
  if (
    !window.confirm(
      `确认${decision === 'approve' ? '通过' : '拒绝'}本订单全部 ${detail.value.items.length} 位参会人的报名？`,
    )
  )
    return;
  const operationScope = scopeGeneration;
  pending.value = true;
  error.value = '';
  message.value = '';
  try {
    await conferenceApi.reviewBatchOrder(
      props.orderId,
      { expectedVersion: detail.value.order.version, decision, reason: reason.value.trim() },
      props.eventId,
    );
    if (operationScope !== scopeGeneration) return;
    await load();
    if (operationScope !== scopeGeneration) return;
    emit('changed');
    message.value = '整单审核结果已保存';
  } catch (failure) {
    if (operationScope !== scopeGeneration) return;
    error.value = failure instanceof Error ? failure.message : '审核未完成，请刷新核对';
  } finally {
    if (operationScope === scopeGeneration) pending.value = false;
  }
}
async function refund() {
  if (!context.value || pending.value || !allocations.value.length) return;
  if (reason.value.trim().length < 2) {
    error.value = '请填写补偿原因';
    return;
  }
  for (const item of allocations.value) {
    const limit = context.value.items.find((row) => row.id === item.orderItemId)!;
    if (
      !Number.isSafeInteger(item.amount) ||
      item.amount <= 0 ||
      item.amount > limit.refundableAmount ||
      (item.rightsEffect === 'retain' ? !limit.canRetain : !limit.canRevoke)
    ) {
      error.value = '请核对所选名额金额及权益处理方式';
      return;
    }
  }
  const payload = {
    contextVersion: context.value.contextVersion,
    reason: reason.value.trim(),
    allocations: allocations.value,
  };
  const fingerprint = JSON.stringify(payload);
  if (
    !window.confirm(
      `确认向 ${allocations.value.length} 个指定名额发起合计 ${money(total.value)} 的退款？各名额将按所选方式保留或取消参会资格。`,
    )
  )
    return;
  if (refundIntent?.fingerprint !== fingerprint)
    refundIntent = { fingerprint, key: crypto.randomUUID() };
  const operationScope = scopeGeneration;
  pending.value = true;
  error.value = '';
  message.value = '';
  try {
    await conferenceApi.refundOrderItems(props.orderId, payload, refundIntent.key, props.eventId);
    if (operationScope !== scopeGeneration) return;
    refundIntent = undefined;
    await load();
    if (operationScope !== scopeGeneration) return;
    emit('changed');
    message.value = '退款已受理，请在退款申请中查看渠道处理结果';
  } catch (failure) {
    if (operationScope !== scopeGeneration) return;
    error.value = failure instanceof Error ? failure.message : '请求结果未确认，请重试或刷新核对';
  } finally {
    if (operationScope === scopeGeneration) pending.value = false;
  }
}
</script>

<template>
  <section class="batch-order-panel" aria-label="订单名额明细">
    <p v-if="loading" role="status">正在读取订单名额…</p>
    <p v-if="error" class="form-error" role="alert">
      {{ error }} <button type="button" @click="load">刷新</button>
    </p>
    <p v-if="message" class="form-success" role="status">{{ message }}</p>
    <template v-if="detail">
      <h3>本订单共 {{ detail.items.length }} 个名额 · {{ money(detail.order.amount) }}</h3>
      <p>统一收款，每位参会人的票证和退款权益分别管理。</p>
      <div class="data-table-wrap">
        <table class="data-table">
          <caption class="sr-only">
            每位参会人的报名资料、名额和票券状态
          </caption>
          <thead>
            <tr>
              <th>参会人</th>
              <th>手机号</th>
              <th>公司 / 组织</th>
              <th>名额状态</th>
              <th>票券 / 认领</th>
              <th>名额金额</th>
              <th>已退款</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in detail.items" :key="item.id">
              <td>{{ item.position }}. {{ item.registration.attendee.name }}</td>
              <td>{{ item.registration.attendee.mobile }}</td>
              <td>{{ item.registration.attendee.company || '—' }}</td>
              <td>
                {{
                  item.state === 'active'
                    ? '有效'
                    : item.state === 'cancelled'
                      ? '已取消'
                      : statusLabel(item.registration.status)
                }}
              </td>
              <td>
                {{ item.ticketStatus ? statusLabel(item.ticketStatus) : '未出票' }} ·
                {{ item.attendeeClaimed ? '已归属账号' : '待认领' }}
              </td>
              <td>{{ money(item.allocatedAmount) }}</td>
              <td>{{ money(item.refundedAmount) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div
        v-if="canReview && detail.order.status === 'pending_review'"
        class="event-form settings-form-spaced"
      >
        <label class="form-field">审核说明<input v-model="reason" :disabled="pending" maxlength="500" placeholder="拒绝报名时必须填写" /></label>
        <div class="event-form-actions">
          <button class="button" type="button" :disabled="pending" @click="review('approve')">
            整单通过
          </button><button
            class="button danger"
            type="button"
            :disabled="pending"
            @click="review('reject')"
          >
            整单拒绝
          </button>
        </div>
      </div>
      <form
        v-if="
          canRefund &&
            context &&
            context.remaining > 0 &&
            ['paid', 'partially_refunded'].includes(detail.order.status)
        "
        class="event-form settings-form-spaced"
        @submit.prevent="refund"
      >
        <h4>指定名额补偿退款</h4>
        <p>填写每个名额的退款金额，并明确参会资格的处理方式。已使用票仅支持保留资格的补偿。</p>
        <div v-for="item in context.items" :key="item.id" class="batch-refund-row">
          <label><input
            v-model="selected[item.id]!.checked"
            type="checkbox"
            :disabled="pending || (!item.canRetain && !item.canRevoke)"
          />{{ item.name }}</label>
          <label>金额（元）<input
            v-model.number="selected[item.id]!.yuan"
            type="number"
            min="0.01"
            step="0.01"
            :max="item.refundableAmount / 100"
            :disabled="pending || !selected[item.id]!.checked"
          /></label>
          <label>参会资格<select
            v-model="selected[item.id]!.rightsEffect"
            :disabled="pending || !selected[item.id]!.checked"
          >
            <option value="retain" :disabled="!item.canRetain">保留</option>
            <option value="revoke" :disabled="!item.canRevoke">取消</option>
          </select></label>
        </div>
        <label class="form-field">补偿原因<input v-model="reason" :disabled="pending" minlength="2" maxlength="1000" required /></label>
        <div class="event-form-actions">
          <strong>退款合计 {{ money(total) }}</strong><button class="button danger" type="submit" :disabled="pending || !allocations.length">
            {{ pending ? '正在提交…' : '确认指定名额退款' }}
          </button>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.batch-order-panel {
  margin-block: 20px;
}
.batch-order-panel h3,
.batch-order-panel h4 {
  margin-bottom: 8px;
}
.batch-order-panel > p {
  color: var(--text-secondary, #667085);
}
.batch-refund-row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(120px, 1fr) minmax(100px, 1fr);
  gap: 16px;
  padding-block: 12px;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}
.batch-refund-row label,
.event-form > label {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.batch-refund-row label:first-child {
  flex-direction: row;
  align-items: center;
}
@media (max-width: 640px) {
  .batch-refund-row {
    grid-template-columns: 1fr;
  }
}
</style>
