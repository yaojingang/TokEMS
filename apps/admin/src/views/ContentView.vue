<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { EventStatus, Speaker } from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import { conferenceApi, publicEventUrl, session } from '../lib/api';

interface SessionRow {
  id: string;
  day: number;
  startsAt: string;
  endsAt: string;
  title: string;
  speaker?: string | null;
  kind: string;
}

const speakers = ref<Speaker[]>([]);
const sessionRows = ref<SessionRow[]>([]);
const day = ref(1);
const errorMessage = ref('');
const message = ref('');
const eventStatus = ref<EventStatus>('configuring');
const deletionTarget = ref<{
  kind: 'speaker' | 'session';
  id: string;
  name: string;
}>();
const showEditor = ref(false);
const editorMode = ref<'speaker' | 'session'>('speaker');
const editingId = ref('');
const pending = ref(false);
const sessions = computed(() => sessionRows.value.filter((item) => item.day === day.value));
const speakerForm = reactive({ name: '', role: '', topic: '', initials: '' });
const sessionForm = reactive({
  day: 1,
  startsAt: '2026-11-21T09:00',
  endsAt: '2026-11-21T09:40',
  title: '',
  speaker: '',
  kind: 'talk',
});

async function load() {
  const [content, event] = await Promise.all([
    conferenceApi.getContent(),
    conferenceApi.getEvent(),
  ]);
  speakers.value = content.speakers;
  sessionRows.value = content.sessions as unknown as SessionRow[];
  eventStatus.value = event.status;
}

function savedMessage(action = '已保存') {
  return ['prepublished', 'registration_open', 'in_progress', 'ended'].includes(eventStatus.value)
    ? `${action}，前台已生效`
    : `${action}，大会上线时生效`;
}

function resetSpeakerForm() {
  Object.assign(speakerForm, { name: '', role: '', topic: '', initials: '' });
}

function resetSessionForm() {
  Object.assign(sessionForm, {
    day: 1,
    startsAt: '2026-11-21T09:00',
    endsAt: '2026-11-21T09:40',
    title: '',
    speaker: '',
    kind: 'talk',
  });
}

function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function switchMode(mode: 'speaker' | 'session') {
  editorMode.value = mode;
  editingId.value = '';
  resetSpeakerForm();
  resetSessionForm();
}

function openCreate() {
  switchMode('speaker');
  showEditor.value = true;
}

function editSpeaker(speaker: Speaker) {
  editorMode.value = 'speaker';
  editingId.value = speaker.id;
  Object.assign(speakerForm, {
    name: speaker.name,
    role: speaker.role,
    topic: speaker.topic,
    initials: speaker.initials,
  });
  showEditor.value = true;
}

function editSession(sessionItem: SessionRow) {
  editorMode.value = 'session';
  editingId.value = sessionItem.id;
  Object.assign(sessionForm, {
    day: sessionItem.day,
    startsAt: localDateTime(sessionItem.startsAt),
    endsAt: localDateTime(sessionItem.endsAt),
    title: sessionItem.title,
    speaker: sessionItem.speaker ?? '',
    kind: sessionItem.kind,
  });
  showEditor.value = true;
}

onMounted(async () => {
  try {
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '内容数据读取失败';
  }
});

async function saveContent() {
  pending.value = true;
  errorMessage.value = '';
  message.value = '';
  try {
    if (editorMode.value === 'speaker') {
      const payload = {
        ...speakerForm,
        initials: speakerForm.initials || speakerForm.name.slice(0, 1),
        accentFrom: '#2563eb',
        accentTo: '#1e3a8a',
        tags: ['大会嘉宾'],
        sortOrder: speakers.value.length,
      };
      if (editingId.value) await conferenceApi.updateSpeaker(editingId.value, payload);
      else await conferenceApi.createSpeaker(payload);
    } else {
      const payload = {
        day: sessionForm.day,
        startsAt: new Date(sessionForm.startsAt).toISOString(),
        endsAt: new Date(sessionForm.endsAt).toISOString(),
        title: sessionForm.title,
        speaker: sessionForm.speaker,
        kind: sessionForm.kind,
        sortOrder: sessionRows.value.length,
      };
      if (editingId.value) await conferenceApi.updateSession(editingId.value, payload);
      else await conferenceApi.createSession(payload);
    }
    showEditor.value = false;
    editingId.value = '';
    resetSpeakerForm();
    resetSessionForm();
    await load();
    message.value = savedMessage();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '内容保存失败';
  } finally {
    pending.value = false;
  }
}

function requestRemoveSpeaker(speaker: Speaker) {
  deletionTarget.value = { kind: 'speaker', id: speaker.id, name: speaker.name };
}

function requestRemoveSession(sessionItem: SessionRow) {
  deletionTarget.value = { kind: 'session', id: sessionItem.id, name: sessionItem.title };
}

async function confirmDeletion() {
  const target = deletionTarget.value;
  if (!target) return;
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    if (target.kind === 'speaker') await conferenceApi.deleteSpeaker(target.id);
    else await conferenceApi.deleteSession(target.id);
    await load();
    message.value = savedMessage(`${target.kind === 'speaker' ? '嘉宾' : '议程'}已删除`);
    deletionTarget.value = undefined;
  } catch (error) {
    errorMessage.value =
      error instanceof Error
        ? error.message
        : `${target.kind === 'speaker' ? '嘉宾' : '议程'}删除失败`;
  } finally {
    pending.value = false;
  }
}

function clock(value: string) {
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">PROGRAM CONTENT</p>
      <h1>嘉宾与两日议程</h1>
      <p>统一查看前台展示的嘉宾资料、分享主题和议程时段。</p>
    </div>
    <div class="admin-head-actions">
      <a
        class="button secondary"
        :href="publicEventUrl('/#agenda')"
        target="_blank"
        rel="noopener noreferrer"
      >预览议程 ↗</a><button class="button" type="button" @click="openCreate">＋ 新增内容</button>
    </div>
  </header>
  <SaveStatus :message="message" :error="errorMessage" />

  <section v-if="showEditor" class="admin-panel editor-panel">
    <header class="admin-panel-header">
      <div>
        <h2>{{ editingId ? '编辑大会内容' : '新增大会内容' }}</h2>
        <p>保存成功后自动生成大会版本，并立即同步到前台</p>
      </div>
      <div class="panel-tabs">
        <button
          class="panel-tab"
          :class="{ active: editorMode === 'speaker' }"
          type="button"
          @click="switchMode('speaker')"
        >
          嘉宾
        </button><button
          class="panel-tab"
          :class="{ active: editorMode === 'session' }"
          type="button"
          @click="switchMode('session')"
        >
          议程
        </button>
      </div>
    </header>
    <form class="event-form" @submit.prevent="saveContent">
      <div v-if="editorMode === 'speaker'" class="form-grid">
        <div class="form-field">
          <label for="speaker-name">姓名</label><input id="speaker-name" v-model="speakerForm.name" required />
        </div>
        <div class="form-field">
          <label for="speaker-initials">头像字</label><input id="speaker-initials" v-model="speakerForm.initials" maxlength="8" />
        </div>
        <div class="form-field full">
          <label for="speaker-role">身份介绍</label><input id="speaker-role" v-model="speakerForm.role" required />
        </div>
        <div class="form-field full">
          <label for="speaker-topic">分享主题</label><input id="speaker-topic" v-model="speakerForm.topic" required />
        </div>
      </div>
      <div v-else class="form-grid">
        <div class="form-field">
          <label for="session-day">天次</label><select id="session-day" v-model="sessionForm.day">
            <option :value="1">DAY 1</option>
            <option :value="2">DAY 2</option>
          </select>
        </div>
        <div class="form-field">
          <label for="session-kind">类型</label><select id="session-kind" v-model="sessionForm.kind">
            <option value="talk">演讲</option>
            <option value="break">茶歇</option>
            <option value="workshop">工作坊</option>
          </select>
        </div>
        <div class="form-field">
          <label for="session-starts-at">开始</label><input
            id="session-starts-at"
            v-model="sessionForm.startsAt"
            type="datetime-local"
            required
          />
        </div>
        <div class="form-field">
          <label for="session-ends-at">结束</label><input
            id="session-ends-at"
            v-model="sessionForm.endsAt"
            type="datetime-local"
            required
          />
        </div>
        <div class="form-field full">
          <label for="session-title">议程标题</label><input id="session-title" v-model="sessionForm.title" required />
        </div>
        <div class="form-field full">
          <label for="session-speaker">分享嘉宾</label><input id="session-speaker" v-model="sessionForm.speaker" />
        </div>
      </div>
      <div class="event-form-actions">
        <button class="button secondary" type="button" @click="showEditor = false">取消</button><button class="button" type="submit" :disabled="pending">
          {{ pending ? '保存中…' : '保存内容' }}
        </button>
      </div>
    </form>
  </section>

  <div class="content-grid">
    <section class="admin-panel reveal is-visible">
      <header class="admin-panel-header">
        <div>
          <h2>大会嘉宾</h2>
          <p>内容库已收录 {{ speakers.length }} 位嘉宾</p>
        </div>
        <span class="status-badge">{{ speakers.length }} SPEAKERS</span>
      </header>
      <ul class="speaker-list">
        <li v-for="speaker in speakers" :key="speaker.id">
          <span
            class="speaker-initial"
            :style="{
              background: `linear-gradient(140deg, ${speaker.accentFrom}, ${speaker.accentTo})`,
            }"
          >{{ speaker.initials }}</span>
          <span class="speaker-copy"><strong>{{ speaker.name }}</strong><small>{{ speaker.role }} · {{ speaker.topic }}</small></span>
          <div class="row-actions">
            <button class="button secondary compact" type="button" @click="editSpeaker(speaker)">
              编辑
            </button>
            <button
              class="button danger compact"
              type="button"
              @click="requestRemoveSpeaker(speaker)"
            >
              删除
            </button>
          </div>
        </li>
      </ul>
      <div v-if="!speakers.length" class="admin-empty">暂无嘉宾，新增后会进入大会内容库。</div>
    </section>

    <section class="admin-panel reveal is-visible">
      <header class="admin-panel-header">
        <div>
          <h2>议程时间表</h2>
          <p>当前查看第 {{ day }} 天</p>
        </div>
        <div class="panel-tabs">
          <button class="panel-tab" :class="{ active: day === 1 }" type="button" @click="day = 1">
            DAY 1
          </button><button class="panel-tab" :class="{ active: day === 2 }" type="button" @click="day = 2">
            DAY 2
          </button>
        </div>
      </header>
      <ul class="session-list">
        <li v-for="sessionItem in sessions" :key="sessionItem.id">
          <span class="session-time">{{ clock(sessionItem.startsAt) }}<br />{{ clock(sessionItem.endsAt) }}</span>
          <span class="session-copy"><strong>{{ sessionItem.title }}</strong><small>{{ sessionItem.speaker ?? '大会组委会' }} · {{ sessionItem.kind }}</small></span>
          <div class="row-actions">
            <button
              class="button secondary compact"
              type="button"
              @click="editSession(sessionItem)"
            >
              编辑
            </button>
            <button
              class="button danger compact"
              type="button"
              @click="requestRemoveSession(sessionItem)"
            >
              删除
            </button>
          </div>
        </li>
      </ul>
      <div v-if="!sessions.length" class="admin-empty">第 {{ day }} 天暂无议程安排。</div>
    </section>
  </div>

  <AdminConfirmDialog
    :open="Boolean(deletionTarget)"
    :event-name="session.activeEvent.value?.name"
    :title="`确认删除${deletionTarget?.kind === 'speaker' ? '嘉宾' : '议程'}“${deletionTarget?.name ?? ''}”？`"
    description="删除成功后前台会立即移除该内容。如需恢复，可从变更记录回滚到之前的大会版本。"
    confirm-label="确认删除"
    tone="danger"
    :busy="pending"
    :error="errorMessage"
    @cancel="deletionTarget = undefined"
    @confirm="confirmDeletion"
  />
</template>
