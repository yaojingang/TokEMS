<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { ConferenceTemplateOption, OrganizationSettingsResult } from '@conference/contracts';
import SaveStatus from '../components/SaveStatus.vue';
import SettingsFormActions from '../components/SettingsFormActions.vue';
import { useSettingsFormScope } from '../composables/settings-form-state';
import { conferenceApi, session } from '../lib/api';

const organization = ref<OrganizationSettingsResult>();
const templates = ref<ConferenceTemplateOption[]>([]);
const loading = ref(true);
const loaded = ref(false);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const form = reactive({
  name: '',
  brandName: '',
  defaultTimezone: 'Asia/Shanghai',
  defaultCurrency: 'CNY' as const,
  defaultTemplateId: '',
});
const canManage = computed(() => session.canAny(['org.settings.manage']));
const { clearDirty, setBusy, setResetHandler } = useSettingsFormScope();

function applySettings(settings: OrganizationSettingsResult) {
  organization.value = settings;
  Object.assign(form, {
    name: settings.name,
    brandName: settings.settings.brandName,
    defaultTimezone: settings.settings.defaultTimezone,
    defaultCurrency: settings.settings.defaultCurrency,
    defaultTemplateId: settings.settings.defaultTemplateId ?? '',
  });
  clearDirty();
}

function resetForm() {
  if (organization.value) applySettings(organization.value);
}

setResetHandler(resetForm);
watch(pending, setBusy, { immediate: true });

async function load() {
  loading.value = true;
  loaded.value = false;
  errorMessage.value = '';
  try {
    const settings = await conferenceApi.getOrganizationSettings();
    templates.value = session.canAny(['org.template.use', 'org.template.read'])
      ? await conferenceApi.getTemplateOptions()
      : [];
    applySettings(settings);
    loaded.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '基础设置读取失败';
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!loaded.value) {
    errorMessage.value = '请先重新载入基础设置';
    return;
  }
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    applySettings(
      await conferenceApi.updateOrganizationSettings({
        name: form.name.trim(),
        settings: {
          brandName: form.brandName.trim(),
          defaultTimezone: form.defaultTimezone,
          defaultCurrency: form.defaultCurrency,
          defaultTemplateId: form.defaultTemplateId || null,
        },
      }),
    );
    message.value = '基础设置已保存，后续新建大会会继承这些默认项。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '基础设置保存失败';
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在载入基础设置…</div>
  <div v-else-if="!loaded" class="admin-loading">
    <button class="btn btn-secondary" type="button" @click="load">重新载入</button>
  </div>

  <section v-else class="admin-panel settings-module">
    <header class="admin-panel-header settings-module-header">
      <div>
        <p class="settings-module-kicker">GENERAL</p>
        <h1>组织与建会默认项</h1>
        <p>统一品牌资料和大会创建时的初始值。</p>
      </div>
      <span class="status-badge draft">{{ organization?.slug }}</span>
    </header>
    <form
      class="event-form settings-form-spaced"
      data-settings-form
      :inert="pending"
      :aria-busy="pending"
      @submit.prevent="save"
    >
      <section class="settings-form-section" aria-labelledby="organization-profile-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="organization-profile-heading">组织资料</h2>
            <p>用于后台识别组织，并统一公开页面中的品牌名称。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label for="organization-name">组织名称</label>
            <input
              id="organization-name"
              v-model="form.name"
              required
              maxlength="160"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="organization-brand-name">品牌显示名</label>
            <input
              id="organization-brand-name"
              v-model="form.brandName"
              required
              maxlength="160"
              :disabled="!canManage"
            />
          </div>
        </div>
      </section>

      <section class="settings-form-section" aria-labelledby="event-defaults-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="event-defaults-heading">建会默认项</h2>
            <p>新建大会时自动带入，创建完成后仍可在大会配置中调整。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label for="organization-timezone">默认时区</label>
            <select
              id="organization-timezone"
              v-model="form.defaultTimezone"
              :disabled="!canManage"
            >
              <option value="Asia/Shanghai">Asia/Shanghai</option>
              <option value="Asia/Hong_Kong">Asia/Hong_Kong</option>
              <option value="Asia/Singapore">Asia/Singapore</option>
              <option value="UTC">UTC</option>
            </select>
          </div>
          <div class="form-field">
            <label for="organization-currency">默认币种</label>
            <select id="organization-currency" v-model="form.defaultCurrency" disabled>
              <option value="CNY">CNY 人民币</option>
            </select>
          </div>
          <div class="form-field full">
            <label for="organization-template">默认大会模板</label>
            <select
              id="organization-template"
              v-model="form.defaultTemplateId"
              :disabled="!canManage"
            >
              <option value="">创建大会时手动选择</option>
              <option
                v-if="
                  form.defaultTemplateId &&
                    !templates.some((item) => item.id === form.defaultTemplateId)
                "
                :value="form.defaultTemplateId"
              >
                当前默认模板
              </option>
              <option v-for="item in templates" :key="item.id" :value="item.id">
                {{ item.name }} · V{{ item.currentVersion }}
              </option>
            </select>
          </div>
        </div>
      </section>
      <SettingsFormActions
        v-if="canManage"
        :pending="pending"
        primary-label="保存组织设置"
        impact-text="组织名称会立即更新；时区与默认模板用于后续新建大会。"
      />
    </form>
  </section>
</template>
