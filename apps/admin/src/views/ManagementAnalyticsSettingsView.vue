<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { AnalyticsSettings } from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import SettingsFormActions from '../components/SettingsFormActions.vue';
import { useSettingsFormScope } from '../composables/settings-form-state';
import { conferenceApi, session } from '../lib/api';

const loading = ref(true);
const loaded = ref(false);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const showUmamiConfirm = ref(false);
const form = reactive<AnalyticsSettings>({
  enabled: false,
  provider: 'baidu',
  trackingId: '',
  scriptUrl: '',
  siteId: '',
});
const canManage = computed(() => session.canAny(['org.settings.manage']));
const { clearDirty, setBusy, setResetHandler } = useSettingsFormScope();
let baseline: AnalyticsSettings | null = null;
const needsTrackingId = computed(() => ['baidu', 'google'].includes(form.provider));
const needsScriptUrl = computed(() => form.provider === 'umami');

function applySettings(value: AnalyticsSettings) {
  Object.assign(form, value);
  baseline = { ...value };
  clearDirty();
}

function resetForm() {
  if (baseline) Object.assign(form, baseline);
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
    errorMessage.value = error instanceof Error ? error.message : '统计设置读取失败';
  } finally {
    loading.value = false;
  }
}

function requestSave() {
  if (!loaded.value) {
    errorMessage.value = '请先重新载入统计设置';
    return;
  }
  if (form.enabled && form.provider === 'umami') {
    showUmamiConfirm.value = true;
    return;
  }
  void save();
}

async function save() {
  showUmamiConfirm.value = false;
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const result = await conferenceApi.updateOrganizationSettings({
      settings: { analytics: { ...form } },
    });
    applySettings(result.settings.analytics);
    message.value = form.enabled
      ? '统计配置已启用，将应用到全部公开页面。'
      : '统计配置已保存，当前处于停用状态。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '统计设置保存失败';
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在载入统计设置…</div>
  <div v-else-if="!loaded" class="admin-loading">
    <button class="btn btn-secondary" type="button" @click="load">重新载入</button>
  </div>

  <section v-else class="admin-panel settings-module">
    <header class="admin-panel-header settings-module-header">
      <div>
        <p class="settings-module-kicker">ANALYTICS</p>
        <h1>统计与数据</h1>
        <p>一次配置即可覆盖公开端全部页面，停用后不会加载任何统计脚本。</p>
      </div>
      <span class="status-badge" :class="form.enabled ? 'paid' : 'draft'">
        {{ form.enabled ? '已启用' : '已停用' }}
      </span>
    </header>
    <form
      class="event-form settings-form-spaced"
      data-settings-form
      :inert="pending"
      :aria-busy="pending"
      @submit.prevent="requestSave"
    >
      <div class="settings-summary">
        <div>
          <span>加载状态</span>
          <strong>{{ form.enabled ? '公开页面正在加载' : '公开页面停止加载' }}</strong>
        </div>
        <label class="settings-toggle">
          <input v-model="form.enabled" type="checkbox" :disabled="!canManage" />
          <span>{{ form.enabled ? '已启用' : '已停用' }}</span>
        </label>
      </div>
      <section class="settings-form-section" aria-labelledby="analytics-provider-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="analytics-provider-heading">统计平台</h2>
            <p>选择数据服务，并填写该平台要求的站点标识。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label for="analytics-provider">统计平台</label>
            <select id="analytics-provider" v-model="form.provider" :disabled="!canManage">
              <option value="baidu">百度统计</option>
              <option value="google">Google Analytics</option>
              <option value="umami">Umami</option>
            </select>
          </div>
          <div v-if="needsTrackingId" class="form-field">
            <label for="analytics-id">{{
              form.provider === 'baidu' ? '站点统计 ID' : 'Measurement ID'
            }}</label>
            <input
              id="analytics-id"
              v-model="form.trackingId"
              :required="form.enabled"
              maxlength="160"
              :placeholder="form.provider === 'baidu' ? '32 位站点 ID' : 'G-XXXXXXXXXX'"
              :disabled="!canManage"
            />
          </div>
          <div v-if="needsScriptUrl" class="form-field full">
            <label for="analytics-script-url">HTTPS 脚本地址</label>
            <input
              id="analytics-script-url"
              v-model="form.scriptUrl"
              type="url"
              :required="form.enabled"
              placeholder="https://analytics.example.com/script.js"
              :disabled="!canManage"
            />
            <small>脚本会在公开页面运行，请仅填写由可信团队维护的 Umami 实例地址。</small>
          </div>
          <div v-if="form.provider === 'umami'" class="form-field full">
            <label for="analytics-site-id">Website ID</label>
            <input
              id="analytics-site-id"
              v-model="form.siteId"
              maxlength="200"
              :required="form.enabled"
              :disabled="!canManage"
            />
          </div>
        </div>
      </section>
      <div class="settings-security-note">
        <strong>加载范围</strong>
        <span>保存成功后，首页、报名、订单、票证和发票页面都会使用同一套统计设置。</span>
      </div>
      <SettingsFormActions v-if="canManage" :pending="pending" primary-label="保存统计设置" />
    </form>
  </section>

  <AdminConfirmDialog
    :open="showUmamiConfirm"
    title="确认启用 Umami 统计"
    description="该脚本会在全部公开页面运行，并可接触页面访问数据。请确认地址由可信团队维护。"
    confirm-label="确认保存并启用"
    :details="[
      { label: '脚本地址', value: form.scriptUrl || '未填写' },
      { label: 'Website ID', value: form.siteId || '未填写' },
    ]"
    :error="errorMessage"
    @confirm="save"
    @cancel="showUmamiConfirm = false"
  />
</template>
