<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { AiRun, NotificationTemplate } from '@conference/contracts';
import { conferenceApi, session } from '../lib/api';
import { dateTime, statusLabel } from '../lib/format';

const templates = ref<NotificationTemplate[]>([]);
const deliveries = ref<Array<Record<string, unknown>>>([]);
const aiRuns = ref<AiRun[]>([]);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const canSend = session.can('event.notification.send');
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

async function load() {
  errorMessage.value = '';
  try {
    const [loadedTemplates, loadedDeliveries] = await Promise.all([
      conferenceApi.getNotificationTemplates(),
      conferenceApi.getNotificationDeliveries(),
    ]);
    templates.value = loadedTemplates;
    deliveries.value = loadedDeliveries;
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
    message.value = '通知已进入 Outbox，Worker 将完成投递并更新状态。';
    await load();
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
      <p class="eyebrow">MESSAGE OPERATIONS</p>
      <h1>模板通知与投递记录</h1>
      <p>模板变量在入队时固化，AI 生成内容需要完成审核后才能进入发送流程。</p>
    </div>
    <span class="status-badge">OUTBOX ENABLED</span>
  </header>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <p v-if="message" class="admin-success" role="status">{{ message }}</p>

  <div class="content-grid">
    <section v-if="canSend" class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>发送测试通知</h2>
          <p>{{ selected?.subject ?? '选择通知模板' }}</p>
        </div>
      </header>
      <form class="event-form" @submit.prevent="queue">
        <div class="form-grid">
          <div class="form-field full">
            <label for="notification-template">通知模板</label><select id="notification-template" v-model="form.templateId" required>
              <option v-for="item in templates" :key="item.id" :value="item.id">
                {{ item.name }} · V{{ item.version }}
              </option>
            </select>
          </div>
          <div class="form-field full">
            <label for="notification-recipient">接收地址</label><input id="notification-recipient" v-model="form.recipient" type="email" required />
          </div>
          <div class="form-field">
            <label for="notification-attendee">参会人</label><input id="notification-attendee" v-model="form.attendeeName" />
          </div>
          <div class="form-field">
            <label for="notification-event">大会名称</label><input id="notification-event" v-model="form.eventName" />
          </div>
          <div class="form-field">
            <label for="notification-ticket">票号</label><input id="notification-ticket" v-model="form.ticketCode" />
          </div>
          <div class="form-field">
            <label for="notification-starts-at">大会时间</label><input id="notification-starts-at" v-model="form.startsAt" />
          </div>
          <div class="form-field full">
            <label for="notification-ai-run">AI 审核记录，可选</label><select id="notification-ai-run" v-model="form.aiRunId">
              <option value="">使用模板正文</option>
              <option v-for="run in approvedRuns" :key="run.id" :value="run.id">
                {{ run.task }} · {{ run.output.slice(0, 36) }}
              </option>
            </select>
          </div>
        </div>
        <div class="event-form-actions">
          <span class="operation-event-context">发送范围 · {{ form.eventName }}</span>
          <button class="button" type="submit" :disabled="pending || !form.templateId">
            {{ pending ? '正在入队…' : '加入发送队列' }}
          </button>
        </div>
      </form>
    </section>

    <section class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>最近投递</h2>
          <p>由 Worker 更新最终状态</p>
        </div>
        <div class="row-actions">
          <button class="button secondary compact" type="button" @click="load">刷新状态</button>
          <span class="status-badge">{{ deliveries.length }}</span>
        </div>
      </header>
      <ul class="operations-list">
        <li v-for="item in deliveries" :key="String(item.id)">
          <div>
            <strong>{{ item.subject }}</strong><small>{{ item.recipient }} · {{ dateTime(String(item.createdAt)) }}</small>
          </div>
          <span class="status-badge" :class="{ success: item.status === 'sent' }">{{
            statusLabel(String(item.status))
          }}</span>
        </li>
        <li v-if="!deliveries.length">
          <div>
            <strong>暂无投递记录</strong><small>发送一条测试通知后可在这里追踪状态。</small>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
