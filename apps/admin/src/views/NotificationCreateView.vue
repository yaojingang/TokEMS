<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { AiRun, NotificationTemplate } from '@conference/contracts';
import { useRoute, useRouter } from 'vue-router';
import { conferenceApi, session } from '../lib/api';
import { dateTime } from '../lib/format';

const route = useRoute();
const router = useRouter();
const templates = ref<NotificationTemplate[]>([]);
const aiRuns = ref<AiRun[]>([]);
const loading = ref(true);
const pending = ref(false);
const errorMessage = ref('');
const form = reactive({
  templateId: '',
  recipient: 'attendee@example.com',
  attendeeName: '参会人',
  eventName: '中国第二届 TokEMS 大会',
  ticketCode: 'TOK-T-00DEMO0001',
  startsAt: '2026年11月21日 09:00',
  venue: '深圳湾科技生态园国际会议中心',
  aiRunId: '',
});
const selected = computed(() => templates.value.find((item) => item.id === form.templateId));
const approvedRuns = computed(() => aiRuns.value.filter((item) => item.status === 'approved'));

function notificationListRoute(query: Record<string, string> = {}) {
  return {
    name: 'event-notifications',
    params: { eventId: route.params.eventId },
    query,
  };
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    templates.value = await conferenceApi.getNotificationTemplates();
    aiRuns.value = session.can('event.ai.read') ? await conferenceApi.getAiRuns() : [];
    if (session.can('event.read')) {
      const event = await conferenceApi.getEvent();
      form.eventName = event.name;
      form.startsAt = `${dateTime(event.startsAt)} 至 ${dateTime(event.endsAt)}`;
      form.venue = `${event.city} · ${event.venue}`;
    }
    form.templateId ||= templates.value[0]?.id ?? '';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '通知数据读取失败';
  } finally {
    loading.value = false;
  }
}

async function queue() {
  pending.value = true;
  errorMessage.value = '';
  try {
    await conferenceApi.queueNotification({
      templateId: form.templateId,
      recipient: form.recipient,
      variables: {
        attendeeName: form.attendeeName,
        eventName: form.eventName,
        ticketCode: form.ticketCode,
        startsAt: form.startsAt,
        venue: form.venue,
      },
      ...(form.aiRunId ? { aiRunId: form.aiRunId } : {}),
    });
    await router.push(notificationListRoute({ queued: '1' }));
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '通知入队失败';
  } finally {
    pending.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <button class="text-back-link" type="button" @click="router.push(notificationListRoute())">
        ← 返回通知中心
      </button>
      <p class="eyebrow">CREATE MESSAGE</p>
      <h1>新建消息通知</h1>
      <p>选择通知模板并确认接收对象，提交后消息会进入发送队列。</p>
    </div>
  </header>

  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>

  <section class="admin-panel editor-panel notification-create-panel reveal is-visible">
    <header class="admin-panel-header">
      <div>
        <h2>通知内容</h2>
        <p>{{ selected?.subject ?? (loading ? '正在读取通知模板…' : '请选择通知模板') }}</p>
      </div>
      <span class="status-badge">OUTBOX</span>
    </header>

    <form class="event-form" @submit.prevent="queue">
      <div class="form-grid">
        <div class="form-field full">
          <label for="notification-template">通知模板</label>
          <select id="notification-template" v-model="form.templateId" required :disabled="loading">
            <option v-for="item in templates" :key="item.id" :value="item.id">
              {{ item.name }} · V{{ item.version }}
            </option>
          </select>
        </div>
        <div class="form-field full">
          <label for="notification-recipient">接收地址</label>
          <input
            id="notification-recipient"
            v-model.trim="form.recipient"
            type="email"
            autocomplete="email"
            required
          />
        </div>
        <div class="form-field">
          <label for="notification-attendee">参会人</label>
          <input id="notification-attendee" v-model.trim="form.attendeeName" />
        </div>
        <div class="form-field">
          <label for="notification-event">大会名称</label>
          <input id="notification-event" v-model.trim="form.eventName" />
        </div>
        <div class="form-field">
          <label for="notification-ticket">票号</label>
          <input id="notification-ticket" v-model.trim="form.ticketCode" />
        </div>
        <div class="form-field">
          <label for="notification-starts-at">大会时间</label>
          <input id="notification-starts-at" v-model.trim="form.startsAt" />
        </div>
        <div class="form-field full">
          <label for="notification-ai-run">AI 审核记录，可选</label>
          <select id="notification-ai-run" v-model="form.aiRunId">
            <option value="">使用模板正文</option>
            <option v-for="run in approvedRuns" :key="run.id" :value="run.id">
              {{ run.task }} · {{ run.output.slice(0, 36) }}
            </option>
          </select>
        </div>
      </div>
      <div class="event-form-actions">
        <span class="operation-event-context">发送范围 · {{ form.eventName }}</span>
        <button class="button secondary" type="button" @click="router.push(notificationListRoute())">
          取消
        </button>
        <button class="button" type="submit" :disabled="pending || loading || !form.templateId">
          {{ pending ? '正在加入队列…' : '创建并加入发送队列' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.notification-create-panel {
  max-width: 980px;
}

@media (max-width: 700px) {
  .notification-create-panel {
    max-width: none;
  }
}
</style>
