<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { AdminRegistrationBatchReview } from '@conference/contracts';
import { conferenceApi } from '../../lib/api';
import { statusLabel } from '../../lib/format';

const props = defineProps<{ review: AdminRegistrationBatchReview; eventId: number }>();
const emit = defineEmits<{ changed: [] }>();
const reason = ref('');
const pending = ref(false);
const error = ref('');
const message = ref('');
const reviewable = computed(() => props.review.status === 'pending_review');
let generation = 0;
let request: { fingerprint: string; key: string } | null = null;

watch(
  () => [props.eventId, props.review.orderId],
  (scope, previous) => {
    if (scope[0] === previous[0] && scope[1] === previous[1]) return;
    generation += 1;
    pending.value = false;
    reason.value = '';
    error.value = '';
    message.value = '';
    request = null;
  },
);
onBeforeUnmount(() => {
  generation += 1;
});

async function submit(decision: 'approve' | 'reject') {
  if (!reviewable.value || pending.value) return;
  if (decision === 'reject' && reason.value.trim().length < 2) {
    error.value = '请填写拒绝原因';
    return;
  }
  if (
    !window.confirm(
      `确认${decision === 'approve' ? '通过' : '拒绝'}全部 ${props.review.quantity} 位参会人的报名？`,
    )
  )
    return;
  const scope = generation;
  const input = { expectedVersion: props.review.version, decision, reason: reason.value.trim() };
  const fingerprint = JSON.stringify(input);
  if (request?.fingerprint !== fingerprint) request = { fingerprint, key: crypto.randomUUID() };
  pending.value = true;
  error.value = '';
  message.value = '';
  try {
    await conferenceApi.reviewBatchOrder(props.review.orderId, input, props.eventId, request.key);
    if (scope !== generation) return;
    request = null;
    message.value = '整批审核结果已保存';
    emit('changed');
  } catch (failure) {
    if (scope === generation)
      error.value = failure instanceof Error ? failure.message : '审核结果未确认，请刷新核对后重试';
  } finally {
    if (scope === generation) pending.value = false;
  }
}

function answer(item: AdminRegistrationBatchReview['items'][number], key: string) {
  return item.formAnswers[key] ?? (item.attendee as Record<string, string>)[key] ?? '';
}
</script>

<template>
  <section class="operation-card batch-review-panel" aria-label="整批报名审核">
    <header>
      <h3>整批报名 · {{ review.quantity }} 位</h3>
      <p>
        {{
          reviewable
            ? '请逐位核对原报名资料，再提交整批审核结果。'
            : `当前状态：${statusLabel(review.status)}`
        }}
      </p>
    </header>
    <article v-for="item in review.items" :key="item.registrationId" class="batch-review-person">
      <h4>{{ item.position }}. {{ item.attendee.name }}</h4>
      <dl>
        <div
          v-for="field in item.fields.filter((field) => field.enabled !== false)"
          :key="field.key"
        >
          <dt>{{ field.label }}</dt>
          <dd>{{ answer(item, field.key) || '未填写' }}</dd>
        </div>
      </dl>
    </article>
    <p v-if="error" class="form-error" role="alert">
      {{ error }}
      <button type="button" :disabled="pending" @click="emit('changed')">刷新报名资料</button>
    </p>
    <p v-if="message" class="form-success" role="status">{{ message }}</p>
    <form
      v-if="reviewable"
      class="event-form settings-form-spaced"
      @submit.prevent="submit('approve')"
    >
      <label class="form-field">审核说明<input
        v-model="reason"
        :disabled="pending"
        maxlength="500"
        placeholder="拒绝报名时必须填写"
      /></label>
      <div class="event-form-actions">
        <button type="submit" class="button" :disabled="pending">
          {{ pending ? '正在提交…' : '整批通过' }}
        </button>
        <button type="button" class="button danger" :disabled="pending" @click="submit('reject')">
          整批拒绝
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.batch-review-panel {
  padding: 24px;
}
.batch-review-panel header p {
  margin-top: 8px;
  color: var(--text-secondary, #667085);
}
.batch-review-person {
  padding-block: 16px;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}
.batch-review-person dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 24px;
  margin-top: 12px;
}
.batch-review-person dt {
  font-size: 12px;
  color: var(--text-secondary, #667085);
}
.batch-review-person dd {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .batch-review-person dl {
    grid-template-columns: 1fr;
  }
}
</style>
