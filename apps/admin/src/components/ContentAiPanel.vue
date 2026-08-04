<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from 'vue';
import type { AiRun } from '@conference/contracts';
import { conferenceApi, session } from '../lib/api';
import { dateTime, statusLabel } from '../lib/format';
import SaveStatus from './SaveStatus.vue';

const runs = ref<AiRun[]>([]);
const pending = ref(false);
const errorMessage = ref('');
const message = ref('');
const canGenerate = session.can('event.ai.generate');
const canApprove = session.can('event.ai.approve');
const form = reactive({
  task: 'event_tagline' as
    'event_tagline' | 'event_description' | 'notification_subject' | 'notification_body',
  brief: '突出 TokEMS 行业前沿、企业增长和两天现场实战交流',
  knowledge: '大会地点为深圳；大会日期为 2026 年 11 月 21 至 22 日；参会对象为企业负责人和增长团队',
});

async function load() {
  errorMessage.value = '';
  try {
    runs.value = await conferenceApi.getAiRuns();
    if (session.can('event.read')) {
      const event = await conferenceApi.getEvent();
      form.knowledge = [
        `大会名称为${event.name}`,
        `大会时间为${dateTime(event.startsAt)}至${dateTime(event.endsAt)}`,
        `大会地点为${event.city}·${event.venue}`,
        event.tagline,
      ].join('；');
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'AI 记录读取失败';
  }
}

async function generate() {
  pending.value = true;
  errorMessage.value = '';
  message.value = '';
  try {
    await conferenceApi.generateAiCopy({
      task: form.task,
      brief: form.brief,
      knowledge: form.knowledge
        .split(/[；\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    });
    message.value = '文案草稿已生成，审核通过后可用于通知与发布流程。';
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'AI 文案生成失败';
  } finally {
    pending.value = false;
  }
}

async function approve(run: AiRun) {
  errorMessage.value = '';
  message.value = '';
  try {
    await conferenceApi.approveAiRun(run.id);
    message.value = '文案已经审核通过。';
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'AI 文案审核失败';
  }
}

onMounted(async () => {
  await load();
  if (window.location.hash !== '#ai-copy') return;
  await nextTick();
  document.getElementById('ai-copy')?.scrollIntoView();
});
</script>

<template>
  <section
    id="ai-copy"
    class="content-ai-section reveal is-visible"
    aria-labelledby="content-ai-title"
  >
    <header class="content-section-heading">
      <div>
        <p class="eyebrow">AI COPY WORKFLOW</p>
        <h2 id="content-ai-title">AI 文案</h2>
        <p>使用当前大会资料生成可审核的运营文案，批准后可进入通知与发布流程。</p>
      </div>
      <span class="status-badge">人工审核</span>
    </header>
    <SaveStatus :message="message" :error="errorMessage" />

    <div class="content-grid" :class="{ 'single-column': !canGenerate }">
      <section v-if="canGenerate" class="admin-panel">
        <header class="admin-panel-header">
          <div>
            <h3>生成新草稿</h3>
            <p>资料会与当前组织和大会作用域一起记录</p>
          </div>
        </header>
        <form class="event-form" @submit.prevent="generate">
          <div class="form-grid">
            <div class="form-field full">
              <label for="ai-task">文案任务</label><select id="ai-task" v-model="form.task">
                <option value="event_tagline">大会主张</option>
                <option value="event_description">大会介绍</option>
                <option value="notification_subject">通知标题</option>
                <option value="notification_body">通知正文</option>
              </select>
            </div>
            <div class="form-field full">
              <label for="ai-brief">创作要求</label><textarea id="ai-brief" v-model="form.brief" required minlength="5"></textarea>
            </div>
            <div class="form-field full">
              <label for="ai-knowledge">事实资料，每行或分号分隔</label><textarea id="ai-knowledge" v-model="form.knowledge"></textarea>
            </div>
          </div>
          <div class="event-form-actions">
            <button class="button" type="submit" :disabled="pending">
              {{ pending ? '正在生成…' : '生成待审核草稿' }}
            </button>
          </div>
        </form>
      </section>

      <section class="admin-panel">
        <header class="admin-panel-header">
          <div>
            <h3>生成与审核记录</h3>
            <p>已批准文案可以进入通知发送流程</p>
          </div>
          <span class="status-badge">{{ runs.length }} RUNS</span>
        </header>
        <ul class="ai-run-list">
          <li v-for="run in runs" :key="run.id">
            <div class="ai-run-head">
              <span class="status-badge" :class="{ success: run.status === 'approved' }">{{
                statusLabel(run.status)
              }}</span><small>{{ run.provider }} · {{ dateTime(run.createdAt) }}</small>
            </div>
            <strong>{{ run.task }}</strong>
            <p>{{ run.output }}</p>
            <button
              v-if="canApprove && run.status === 'draft'"
              class="button secondary compact"
              type="button"
              @click="approve(run)"
            >
              审核通过
            </button>
          </li>
          <li v-if="!runs.length" class="admin-empty">尚无 AI 生成记录。</li>
        </ul>
      </section>
    </div>
  </section>
</template>
