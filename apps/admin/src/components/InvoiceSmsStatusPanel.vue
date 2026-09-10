<script setup lang="ts">
import { computed, ref } from 'vue';
import type { EventId, InvoiceRequest } from '@conference/contracts';
import { conferenceApi } from '../lib/api';
const props = defineProps<{
  invoice: Pick<InvoiceRequest, 'id' | 'updatedAt' | 'smsNotification'>;
  eventId: EventId;
  canManage: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();
const busy = ref(false),
  reason = ref(''),
  message = ref(''),
  error = ref('');
const mode = ref<'' | 'force' | 'revoke'>('');
const sms = computed(() => props.invoice.smsNotification);
const labels: Record<string, string> = {
  not_sent: '未发送',
  queued: '等待发送',
  retrying: '等待重试',
  claimed: '准备发送',
  sending: '等待提交结果',
  accepted: '短信平台已受理',
  unknown: '发送结果待确认',
  delivered: '已送达',
  failed: '发送失败',
  cancelled: '已取消',
};
async function run(action: 'send' | 'force' | 'revoke') {
  if (busy.value || (action !== 'send' && reason.value.trim().length < 4)) return;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    if (action === 'revoke') {
      await conferenceApi.revokeInvoiceAccess(
        props.invoice.id,
        { expectedUpdatedAt: props.invoice.updatedAt, reason: reason.value.trim(), resend: false },
        props.eventId,
      );
      message.value = '已发出的领取链接已撤销；需要时可重新补发短信。';
    } else {
      const result = await conferenceApi.sendInvoice(
        props.invoice.id,
        props.eventId,
        action === 'force' ? { forceAfterUncertain: true, reason: reason.value.trim() } : {},
      );
      message.value = result.alreadyQueued
        ? '已有短信任务，等待发送结果。'
        : `短信已排队，将发送至 ${result.maskedRecipient}。`;
    }
    mode.value = '';
    reason.value = '';
    emit('refresh');
  } catch (value) {
    error.value = value instanceof Error ? value.message : '操作失败，请稍后重试';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section v-if="sms" class="invoice-sms-panel" aria-label="发票短信通知">
    <strong>发票短信通知 · {{ labels[sms.status] ?? sms.status }}</strong>
    <p v-if="sms.maskedRecipient">
      接收手机：{{ sms.maskedRecipient }}（{{
        sms.recipientSource === 'legacy_registration' ? '历史报名联系人' : '购票人'
      }}）
    </p>
    <p v-if="sms.nextMaskedRecipient">
      当前接收手机号已更新，下次补发将发送至 {{ sms.nextMaskedRecipient }}。
    </p>
    <p v-if="sms.reason">{{ sms.reason }}</p>
    <p v-if="sms.expiresAt">
      领取有效期至 {{ new Date(sms.expiresAt).toLocaleString('zh-CN') }}，打开链接即可查看发票。
    </p>
    <p v-if="sms.retryAfterSeconds">
      {{ Math.ceil(sms.retryAfterSeconds / 60) }} 分钟后可再次补发，请刷新查看。
    </p>
    <div v-if="canManage" class="invoice-sms-actions">
      <button
        type="button"
        class="button secondary"
        :disabled="busy || !sms.canSend"
        @click="run('send')"
      >
        补发发票短信
      </button>
      <button
        v-if="sms.canForceSend"
        type="button"
        class="button secondary"
        :disabled="busy"
        @click="mode = 'force'"
      >
        确认后再次发送
      </button>
      <button
        v-if="sms.canRevoke"
        type="button"
        class="button secondary"
        :disabled="busy"
        @click="mode = 'revoke'"
      >
        撤销领取链接
      </button>
    </div>
    <div v-if="mode" class="form-field">
      <p>
        {{
          mode === 'force'
            ? '前次短信结果尚未确认，再次发送可能让用户收到重复短信。'
            : '撤销后，用户短信中的现有链接将无法打开。'
        }}
      </p>
      <label :for="`sms-reason-${invoice.id}`">操作原因（至少 4 个字）</label>
      <input :id="`sms-reason-${invoice.id}`" v-model="reason" maxlength="500" />
      <div class="invoice-sms-actions">
        <button
          class="button"
          type="button"
          :disabled="busy || reason.trim().length < 4"
          @click="run(mode)"
        >
          确认{{ mode === 'force' ? '补发' : '撤销' }}
        </button>
        <button class="button secondary" type="button" :disabled="busy" @click="mode = ''">
          取消
        </button>
      </div>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.invoice-sms-panel {
  padding: 16px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 12px;
  margin-block: 16px;
}
.invoice-sms-panel p {
  font-size: 13px;
  line-height: 1.65;
  margin-block: 8px;
  color: var(--text-secondary, #64748b);
}
.invoice-sms-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-block: 12px;
}
</style>
