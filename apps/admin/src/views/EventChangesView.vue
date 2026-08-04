<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { EventRelease, EventStatus, RegistrationForm } from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import { conferenceApi, session } from '../lib/api';
import { dateTime } from '../lib/format';

const releases = ref<EventRelease[]>([]);
const forms = ref<RegistrationForm[]>([]);
const eventStatus = ref<EventStatus>('configuring');
const loading = ref(true);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const rollbackTarget = ref<EventRelease>();
const canReadReleases = session.can('event.site.read');
const canReadForms = session.can('event.registration.manage');
const canRestore = session.can('event.site.publish');
const currentRelease = computed(() => releases.value.find((release) => release.active));

const scopeLabels: Record<EventRelease['changeScope'], string> = {
  site: '官网',
  event: '基本信息',
  experience: '页面体验',
  registration: '报名设置',
  ticket: '票种',
  content: '内容运营',
  form: '表单与条款',
  lifecycle: '大会状态',
};

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [loadedReleases, loadedForms, event] = await Promise.all([
      canReadReleases ? conferenceApi.getReleases() : Promise.resolve([]),
      canReadForms ? conferenceApi.getForms() : Promise.resolve([]),
      conferenceApi.getEvent(),
    ]);
    releases.value = loadedReleases;
    forms.value = loadedForms;
    eventStatus.value = event.status;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '修改记录读取失败';
  } finally {
    loading.value = false;
  }
}

function activationLabel(release: EventRelease) {
  if (release.activationKind === 'initial') return '首次上线';
  if (release.activationKind === 'save') return '保存生效';
  return '历史操作';
}

function requestRollback(release: EventRelease) {
  if (release.active) return;
  errorMessage.value = '';
  rollbackTarget.value = release;
}

async function rollback(release: EventRelease) {
  if (release.active) return;
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    await conferenceApi.rollbackRelease(release.id);
    message.value = ['prepublished', 'registration_open', 'in_progress', 'ended'].includes(
      eventStatus.value,
    )
      ? `已恢复到 V${release.version}，前台已生效`
      : `已将 V${release.version} 设为大会上线时使用的配置`;
    rollbackTarget.value = undefined;
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '恢复历史配置失败';
  } finally {
    pending.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">CHANGE HISTORY</p>
      <h1>修改记录</h1>
      <p>每次有效保存都会自动留存，日常修改无需执行额外发布操作。</p>
    </div>
    <span v-if="currentRelease" class="status-badge success">
      当前生效 V{{ currentRelease.version }}
    </span>
  </header>

  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在读取修改记录…</div>

  <div v-else class="settings-section-stack">
    <section v-if="canReadReleases" class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>大会配置快照</h2>
          <p>官网、报名、票种、内容和大会状态的有效修改统一记录在这里</p>
        </div>
        <span class="status-badge">{{ releases.length }} 条记录</span>
      </header>
      <ul class="operations-list change-history-list">
        <li v-for="release in releases" :key="release.id">
          <div>
            <strong>
              <span class="change-scope-label">{{ scopeLabels[release.changeScope] }}</span>
              V{{ release.version }} · {{ release.changeSummary }}
            </strong>
            <small>
              {{ release.createdByName ?? '系统' }} · {{ dateTime(release.publishedAt) }} ·
              {{ activationLabel(release) }}
            </small>
          </div>
          <button
            v-if="canRestore && !release.active"
            class="button danger compact"
            type="button"
            :disabled="pending"
            @click="requestRollback(release)"
          >
            恢复到此记录
          </button>
          <span v-else-if="release.active" class="status-badge success">当前生效</span>
          <span v-else class="status-badge draft">历史记录</span>
        </li>
      </ul>
      <div v-if="!releases.length" class="admin-empty">
        大会公开后，首次有效保存会自动生成配置记录。
      </div>
    </section>

    <section v-if="canReadForms" class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>表单与条款存证</h2>
          <p>历史报名继续关联当时确认的字段、条款版本和同意时间</p>
        </div>
        <span class="status-badge">{{ forms.length }} 份存证</span>
      </header>
      <ul class="operations-list">
        <li v-for="(item, index) in forms" :key="item.id">
          <div>
            <strong>表单 V{{ item.version }} · {{ item.name }}</strong>
            <small>
              条款 {{ item.termsVersion }} · {{ item.fields.length }} 个字段 ·
              {{ item.publishedAt ? dateTime(item.publishedAt) : '尚未用于报名' }}
            </small>
          </div>
          <span class="status-badge" :class="{ success: index === 0 }">
            {{ index === 0 ? '当前使用' : '历史存证' }}
          </span>
        </li>
      </ul>
      <div v-if="!forms.length" class="admin-empty">尚无表单与条款存证。</div>
    </section>
  </div>

  <AdminConfirmDialog
    :open="Boolean(rollbackTarget)"
    :event-name="session.activeEvent.value?.name"
    :title="`确认恢复到 V${rollbackTarget?.version ?? ''}？`"
    description="公开大会会立即恢复该记录中的官网、报名表、票种和内容。后台当前配置与已有报名、订单和电子票继续保留。"
    confirm-label="确认恢复"
    tone="danger"
    :details="[
      { label: '修改摘要', value: rollbackTarget?.changeSummary ?? '' },
      { label: '记录时间', value: rollbackTarget ? dateTime(rollbackTarget.publishedAt) : '' },
    ]"
    :busy="pending"
    :error="errorMessage"
    @cancel="
      rollbackTarget = undefined;
      errorMessage = '';
    "
    @confirm="rollbackTarget && rollback(rollbackTarget)"
  />
</template>
