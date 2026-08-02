<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { OrganizationSettingsResult } from '@conference/contracts';
import SaveStatus from '../components/SaveStatus.vue';
import SettingsFormActions from '../components/SettingsFormActions.vue';
import { useSettingsFormScope } from '../composables/settings-form-state';
import { conferenceApi, session } from '../lib/api';

type WebsiteSettings = OrganizationSettingsResult['settings']['website'];

const loading = ref(true);
const loaded = ref(false);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const form = reactive({
  siteName: '',
  seoTitle: '',
  seoDescription: '',
  faviconUrl: '',
  footerText: '',
  icpNumber: '',
  supportEmail: '',
});
const canManage = computed(() => session.canAny(['org.settings.manage']));
const { clearDirty, setBusy, setResetHandler } = useSettingsFormScope();
let baseline: WebsiteSettings | null = null;

function applySettings(settings: WebsiteSettings) {
  Object.assign(form, settings);
  baseline = { ...settings };
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
    applySettings(result.settings.website);
    loaded.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '网站设置读取失败';
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!loaded.value) {
    errorMessage.value = '请先重新载入网站设置';
    return;
  }
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const result = await conferenceApi.updateOrganizationSettings({
      settings: { website: { ...form } },
    });
    applySettings(result.settings.website);
    message.value = '已保存，公开网站实时生效';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '网站设置保存失败';
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在载入网站设置…</div>
  <div v-else-if="!loaded" class="admin-loading">
    <button class="btn btn-secondary" type="button" @click="load">重新载入</button>
  </div>

  <section v-else class="admin-panel settings-module">
    <header class="admin-panel-header settings-module-header">
      <div>
        <p class="settings-module-kicker">PUBLIC WEBSITE</p>
        <h1>公开网站</h1>
        <p>这些内容会统一应用到所有公开报名页面。</p>
      </div>
    </header>
    <form
      class="event-form settings-form-spaced"
      data-settings-form
      :inert="pending"
      :aria-busy="pending"
      @submit.prevent="save"
    >
      <section class="settings-form-section" aria-labelledby="website-identity-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="website-identity-heading">站点身份</h2>
            <p>定义公开页面使用的站点名称、服务联系方式与浏览器图标。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label for="site-name">网站名称</label>
            <input
              id="site-name"
              v-model="form.siteName"
              required
              maxlength="160"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="site-support-email">服务邮箱</label>
            <input
              id="site-support-email"
              v-model="form.supportEmail"
              type="email"
              maxlength="255"
              placeholder="service@example.com"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field full">
            <label for="site-favicon">网站图标地址</label>
            <input
              id="site-favicon"
              v-model="form.faviconUrl"
              type="url"
              placeholder="https://static.example.com/favicon.svg"
              :disabled="!canManage"
            />
          </div>
        </div>
      </section>

      <section class="settings-form-section" aria-labelledby="website-search-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="website-search-heading">搜索与分享</h2>
            <p>为大会之外的公开页面提供统一的标题与搜索摘要。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-field full">
            <label for="site-seo-title">默认页面标题</label>
            <input
              id="site-seo-title"
              v-model="form.seoTitle"
              required
              maxlength="180"
              :disabled="!canManage"
            />
            <small>大会页面可以继续使用自己的标题，其他页面会采用此标题。</small>
          </div>
          <div class="form-field full">
            <label for="site-seo-description">搜索摘要</label>
            <textarea
              id="site-seo-description"
              v-model="form.seoDescription"
              rows="3"
              maxlength="500"
              :disabled="!canManage"
            />
          </div>
        </div>
      </section>

      <section class="settings-form-section" aria-labelledby="website-footer-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="website-footer-heading">页脚与合规</h2>
            <p>维护公开站点页脚中的版权信息与备案信息。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label for="site-footer">页脚文字</label>
            <input
              id="site-footer"
              v-model="form.footerText"
              maxlength="300"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="site-icp">ICP备案号</label>
            <input id="site-icp" v-model="form.icpNumber" maxlength="80" :disabled="!canManage" />
          </div>
        </div>
      </section>
      <SettingsFormActions v-if="canManage" :pending="pending" primary-label="保存网站设置" />
    </form>
  </section>
</template>
