<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { OrganizationHomepageConfiguration } from '@conference/contracts';
import { conferenceApi, publicEventHomeUrl, session } from '../lib/api';

const loading = ref(true);
const emit = defineEmits<{ 'dirty-change': [value: boolean]; 'busy-change': [value: boolean] }>();
const pending = ref(false);
const configuration = ref<OrganizationHomepageConfiguration>();
const candidates = ref<NonNullable<OrganizationHomepageConfiguration['candidates']>>([]);
const error = ref('');
const message = ref('');
const form = reactive({ mode: 'event' as 'event' | 'empty', eventId: '' });
const canManage = computed(() => session.can('org.settings.manage'));
const dirty = computed(
  () =>
    configuration.value &&
    (form.mode !== configuration.value.mode ||
      form.eventId !== String(configuration.value.eventId ?? '')),
);
const eventUrl = computed(() =>
  configuration.value?.slug ? publicEventHomeUrl(configuration.value.slug) : '',
);
watch(dirty, (value) => emit('dirty-change', Boolean(value)), { immediate: true });
watch(pending, (value) => emit('busy-change', value), { immediate: true });
defineExpose({ reset: () => { if (configuration.value) apply(configuration.value); } });

function apply(value: OrganizationHomepageConfiguration) {
  configuration.value = value;
  form.mode = value.mode;
  form.eventId = String(value.eventId ?? '');
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const value = await conferenceApi.getOrganizationHomepage();
    candidates.value = value.candidates ?? [];
    apply(value);
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '首页设置读取失败';
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!configuration.value) return;
  pending.value = true;
  error.value = '';
  message.value = '';
  try {
    apply(
      await conferenceApi.updateOrganizationHomepage({
        mode: form.mode,
        ...(form.eventId ? { eventId: Number(form.eventId) } : {}),
        revision: configuration.value.revision,
      }),
    );
    message.value = '首页设置已保存，访问根地址即可查看';
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '首页设置保存失败';
  } finally {
    pending.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="admin-panel settings-module homepage-settings" aria-labelledby="homepage-heading">
    <header class="admin-panel-header settings-module-header">
      <div>
        <p class="settings-module-kicker">HOMEPAGE</p>
        <h2 id="homepage-heading">根首页与默认大会</h2>
        <p>选择域名根地址展示什么，每场大会的独立地址继续可用。</p>
      </div>
    </header>
    <p v-if="loading" role="status">正在读取首页设置…</p>
    <p v-if="error" class="admin-error" role="alert">{{ error }}</p>
    <p v-if="message" class="admin-success" role="status">{{ message }}</p>
    <button v-if="!loading && !configuration" type="button" class="button secondary" @click="load">
      重新载入
    </button>
    <form
      v-if="configuration && !loading"
      class="event-form settings-form-spaced"
      :aria-busy="pending"
      @submit.prevent="save"
    >
      <p class="homepage-status">
        当前根首页：<strong>{{
          configuration.mode === 'empty' ? '不设置页面' : configuration.name
        }}</strong>
      </p>
      <div class="form-grid">
        <div class="form-field">
          <label for="homepage-mode">根首页展示方式</label>
          <select id="homepage-mode" v-model="form.mode" :disabled="!canManage || pending">
            <option value="event">展示默认大会</option>
            <option value="empty">不设置页面</option>
          </select>
        </div>
        <div class="form-field">
          <label for="homepage-default-event">默认业务大会</label>
          <select
            id="homepage-default-event"
            v-model="form.eventId"
            :disabled="!canManage || pending"
            :required="form.mode === 'event'"
          >
            <option value="" :disabled="Boolean(configuration.eventId)">请选择已发布大会</option>
            <option v-for="event in candidates" :key="event.id" :value="String(event.id)">
              {{ event.name }}
            </option>
          </select>
          <small>没有指定大会的历史报名、FAQ 和合作入口会使用这场大会。</small>
        </div>
      </div>
      <p v-if="form.mode === 'empty'" class="homepage-help">
        保存后根地址为空白，默认业务大会继续保留。放置其他首页时，还需配置网站入口及其资源路径。
      </p>
      <p v-else class="homepage-help">保存后根地址展示默认大会，同时更新历史业务入口使用的大会。</p>
      <p v-if="eventUrl" class="homepage-help">
        大会独立地址：<a :href="eventUrl" target="_blank" rel="noopener noreferrer">{{
          eventUrl
        }}</a>
      </p>
      <div v-if="canManage" class="event-form-actions">
        <button
          class="button"
          type="submit"
          :disabled="pending || !dirty || (form.mode === 'event' && !form.eventId)"
        >
          {{ pending ? '保存中…' : '保存首页设置' }}
        </button>
        <button
          class="button secondary"
          type="button"
          :disabled="pending"
          @click="apply(configuration)"
        >
          还原编辑
        </button>
        <button v-if="error" class="button subtle" type="button" :disabled="pending" @click="load">
          载入最新设置
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.homepage-settings {
  margin-bottom: 24px;
}
.homepage-status {
  margin: 0;
  color: var(--ink-soft);
}
.homepage-help {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.homepage-help a {
  color: var(--blue);
}
</style>
