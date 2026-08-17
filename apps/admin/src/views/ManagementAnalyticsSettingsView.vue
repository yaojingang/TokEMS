<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { OrganizationSettingsResult, ParsedAnalyticsSnippet } from '@conference/contracts';
import {
  MAX_ANALYTICS_SNIPPET_LENGTH,
  analyticsProviderLabel,
  analyticsSnippetFromSettings,
  isAnalyticsActive,
  parseAnalyticsSnippet,
} from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import SettingsFormActions from '../components/SettingsFormActions.vue';
import { useSettingsFormScope } from '../composables/settings-form-state';
import { conferenceApi, session } from '../lib/api';

type AnalyticsSettings = OrganizationSettingsResult['settings']['analytics'];

const loading = ref(true);
const loaded = ref(false);
const pending = ref(false);
const confirmOpen = ref(false);
const message = ref('');
const errorMessage = ref('');
const legacyPending = ref(false);
const persistedActive = ref(false);
const form = reactive({ enabled: false, snippet: '' });
const canManage = computed(() => session.can('org.analytics.manage'));
const { clearDirty, setBusy, setResetHandler } = useSettingsFormScope();
let baseline: { enabled: boolean; snippet: string } | null = null;

const recognition = computed<{
  result: ParsedAnalyticsSnippet | null;
  error: string;
}>(() => {
  if (!form.snippet.trim()) return { result: null, error: '' };
  try {
    return { result: parseAnalyticsSnippet(form.snippet), error: '' };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : '统计代码无法识别',
    };
  }
});

const statusLabel = computed(() => {
  if (legacyPending.value) return '待重新确认';
  const matchesBaseline = baseline?.enabled === form.enabled && baseline?.snippet === form.snippet;
  if (matchesBaseline && persistedActive.value) return '已启用';
  if (matchesBaseline) return '已停用';
  return form.enabled ? '准备启用' : '准备停用';
});

const providerLabel = computed(() =>
  recognition.value.result ? analyticsProviderLabel(recognition.value.result.provider) : '等待识别',
);

const scriptDomain = computed(() => {
  const result = recognition.value.result;
  if (!result) return '未识别';
  if (result.provider === 'baidu') return 'hm.baidu.com';
  if (result.provider === 'google') return 'www.googletagmanager.com';
  return new URL(result.scriptUrl).hostname;
});

function applySettings(settings: AnalyticsSettings) {
  form.enabled = settings.enabled;
  form.snippet = analyticsSnippetFromSettings(settings);
  persistedActive.value = isAnalyticsActive(settings);
  legacyPending.value = settings.enabled && !isAnalyticsActive(settings);
  baseline = { enabled: form.enabled, snippet: form.snippet };
  clearDirty();
}

function resetForm() {
  if (!baseline) return;
  Object.assign(form, baseline);
}

setResetHandler(resetForm);
watch(pending, setBusy, { immediate: true });

async function load() {
  loading.value = true;
  loaded.value = false;
  errorMessage.value = '';
  try {
    const result = await conferenceApi.getOrganizationSettings();
    applySettings(result.settings.analytics);
    loaded.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '网站统计设置读取失败';
  } finally {
    loading.value = false;
  }
}

function requestSave() {
  message.value = '';
  errorMessage.value = '';
  if (form.snippet.trim() && !recognition.value.result) {
    errorMessage.value = recognition.value.error;
    return;
  }
  if (form.enabled && !recognition.value.result) {
    errorMessage.value = '启用网站统计前，请粘贴并通过平台识别';
    return;
  }
  confirmOpen.value = true;
}

async function confirmSave() {
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const result = await conferenceApi.updateOrganizationAnalytics({
      enabled: form.enabled,
      snippet: form.snippet,
    });
    applySettings(result.settings.analytics);
    confirmOpen.value = false;
    message.value = form.enabled
      ? '网站统计已启用，公开页面立即生效'
      : '网站统计已停用，新页面请求立即移除统计代码';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '网站统计设置保存失败';
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在载入网站统计设置…</div>
  <div v-else-if="!loaded" class="admin-loading">
    <button class="btn btn-secondary" type="button" @click="load">重新载入</button>
  </div>

  <section v-else class="admin-panel settings-module analytics-settings">
    <header class="admin-panel-header settings-module-header">
      <div>
        <p class="settings-module-kicker">PUBLIC ANALYTICS</p>
        <h1>网站统计</h1>
        <p>识别受支持平台的完整代码，并把标准统计标签实时写入公开页面的 Head。</p>
      </div>
      <div class="settings-module-status">
        <span class="status-badge" :class="statusLabel === '已启用' ? 'paid' : 'draft'">
          {{ statusLabel }}
        </span>
      </div>
    </header>

    <form
      class="event-form settings-form-spaced"
      data-settings-form
      :inert="pending"
      :aria-busy="pending"
      @submit.prevent="requestSave"
    >
      <div class="settings-summary analytics-summary">
        <div>
          <span>识别平台</span>
          <strong>{{ providerLabel }}</strong>
        </div>
        <div>
          <span>脚本域名</span>
          <code>{{ scriptDomain }}</code>
        </div>
        <label class="settings-toggle">
          <input v-model="form.enabled" type="checkbox" :disabled="!canManage" />
          <span>{{ form.enabled ? '启用统计' : '停用统计' }}</span>
        </label>
      </div>

      <p v-if="legacyPending" class="analytics-notice" role="status">
        历史配置当前处于安全停用状态。请检查代码和页面范围，保存确认后才会恢复加载。
      </p>

      <section class="settings-form-section" aria-labelledby="analytics-code-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="analytics-code-heading">完整统计代码</h2>
            <p>支持百度统计、Google Analytics 4 和 Umami。系统只保存识别后的结构化配置。</p>
          </div>
        </div>
        <div class="form-field full">
          <label for="analytics-snippet">平台提供的代码</label>
          <textarea
            id="analytics-snippet"
            v-model="form.snippet"
            class="analytics-code-input"
            rows="12"
            :maxlength="MAX_ANALYTICS_SNIPPET_LENGTH"
            spellcheck="false"
            autocomplete="off"
            placeholder="请粘贴统计平台提供的完整 <script> 代码"
            :disabled="!canManage"
          />
          <small v-if="recognition.result" class="analytics-recognition is-valid">
            已识别 {{ providerLabel }}，保存后由系统生成标准代码。
          </small>
          <small v-else-if="recognition.error" class="analytics-recognition is-invalid">
            {{ recognition.error }}
          </small>
          <small v-else>代码会在本页即时识别，未知平台、额外脚本和 HTTP 地址无法保存。</small>
        </div>
      </section>

      <section class="settings-form-section" aria-labelledby="analytics-scope-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="analytics-scope-heading">页面覆盖范围</h2>
            <p>公开内容页加载统计代码，交易、账户和后台页面保持隔离。</p>
          </div>
        </div>
        <div class="analytics-scope-grid">
          <div>
            <strong>加载统计</strong>
            <p>公开首页、大会首页、FAQ、会员详情、嘉宾详情、合作申请、普通公开错误页</p>
          </div>
          <div>
            <strong>保持隔离</strong>
            <p>报名、个人中心、订单、发票、票证、独立支付入口、后台和 API</p>
          </div>
        </div>
      </section>

      <SettingsFormActions
        v-if="canManage"
        :pending="pending"
        :disabled="form.enabled && !recognition.result"
        primary-label="检查并保存"
        impact-text="保存前需要再次确认，生效范围覆盖所有公开内容页。"
      />
    </form>
  </section>

  <AdminConfirmDialog
    :open="confirmOpen"
    :title="form.enabled ? '确认启用网站统计' : '确认停用网站统计'"
    :description="
      form.enabled
        ? '确认后，识别出的标准统计代码会立即进入所有公开内容页。'
        : '确认后，新页面请求会立即移除统计代码。'
    "
    :confirm-label="form.enabled ? '确认启用并生效' : '确认停用'"
    :tone="form.enabled ? 'primary' : 'danger'"
    :busy="pending"
    :details="[
      { label: '统计平台', value: providerLabel },
      { label: '脚本域名', value: scriptDomain },
      { label: '公开范围', value: '首页、FAQ、会员、嘉宾与合作页面' },
      { label: '隔离范围', value: '报名、账户、交易、票证、支付、后台与 API' },
    ]"
    @confirm="confirmSave"
    @cancel="confirmOpen = false"
  />
</template>

<style scoped>
.analytics-settings .analytics-summary {
  grid-template-columns: minmax(150px, 0.8fr) minmax(240px, 1.5fr) auto;
}

.analytics-code-input {
  min-height: 250px;
  resize: vertical;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.65;
  tab-size: 2;
}

.analytics-recognition {
  display: block;
  margin-top: 7px;
  font-weight: 700;
}

.analytics-recognition.is-valid {
  color: var(--green);
}

.analytics-recognition.is-invalid {
  color: var(--red);
}

.analytics-notice {
  margin: 18px 0 0;
  padding: 12px 14px;
  color: var(--ink);
  background: var(--gold-soft);
  border: 1px solid color-mix(in srgb, var(--gold) 28%, var(--line));
  border-radius: var(--radius-xs);
  font-size: 11px;
  line-height: 1.65;
}

.analytics-scope-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
}

.analytics-scope-grid > div {
  padding: 16px 18px;
}

.analytics-scope-grid > div + div {
  border-left: 1px solid var(--line);
}

.analytics-scope-grid strong {
  color: var(--ink);
  font-size: 12px;
}

.analytics-scope-grid p {
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
}

@media (max-width: 720px) {
  .analytics-settings .analytics-summary,
  .analytics-scope-grid {
    grid-template-columns: 1fr;
  }

  .analytics-scope-grid > div + div {
    border-top: 1px solid var(--line);
    border-left: 0;
  }
}
</style>
