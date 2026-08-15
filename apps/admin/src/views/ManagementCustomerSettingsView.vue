<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { OrganizationSettingsResult } from '@conference/contracts';
import SaveStatus from '../components/SaveStatus.vue';
import SettingsFormActions from '../components/SettingsFormActions.vue';
import { useSettingsFormScope } from '../composables/settings-form-state';
import { conferenceApi, session } from '../lib/api';

const organization = ref<OrganizationSettingsResult>();
const loading = ref(true);
const loaded = ref(false);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const form = reactive({
  defaultAccountMode:
    'mobile_otp_required' as OrganizationSettingsResult['settings']['customerAccounts']['defaultAccountMode'],
  termsUrl: '',
  termsVersion: '',
  privacyUrl: '',
  privacyVersion: '',
});
const canManage = computed(() => session.canAny(['org.settings.manage']));
const { clearDirty, setBusy, setResetHandler } = useSettingsFormScope();

function applySettings(value: OrganizationSettingsResult) {
  if (!value?.settings?.customerAccounts) {
    throw new Error('账号与合规设置响应不完整，请重新载入');
  }
  organization.value = value;
  Object.assign(form, value.settings.customerAccounts);
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
    applySettings(await conferenceApi.getOrganizationSettings());
    loaded.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '账号与合规设置读取失败';
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!loaded.value) {
    errorMessage.value = '请先重新载入账号与合规设置';
    return;
  }
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    applySettings(
      await conferenceApi.updateOrganizationSettings({
        settings: {
          customerAccounts: {
            defaultAccountMode: form.defaultAccountMode,
            termsUrl: form.termsUrl.trim(),
            termsVersion: form.termsVersion.trim(),
            privacyUrl: form.privacyUrl.trim(),
            privacyVersion: form.privacyVersion.trim(),
          },
        },
      }),
    );
    message.value = '协议与隐私政策已保存。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '账号与合规设置保存失败';
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在载入账号与合规设置…</div>
  <div v-else-if="!loaded" class="admin-loading">
    <button class="btn btn-secondary" type="button" @click="load">重新载入</button>
  </div>

  <section v-else class="admin-panel settings-module">
    <header class="admin-panel-header settings-module-header">
      <div>
        <p class="settings-module-kicker">ACCOUNT COMPLIANCE</p>
        <h1>账号与合规</h1>
        <p>维护用户协议和隐私政策，用于注册确认与授权存证。</p>
      </div>
    </header>
    <form
      class="event-form settings-form-spaced"
      data-settings-form
      :inert="pending"
      :aria-busy="pending"
      @submit.prevent="save"
    >
      <section class="settings-form-section" aria-labelledby="customer-policy-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="customer-policy-heading">协议与隐私</h2>
            <p>链接与版本号会用于注册确认和用户授权记录。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label for="customer-terms-url">用户协议地址</label>
            <input
              id="customer-terms-url"
              v-model="form.termsUrl"
              type="url"
              placeholder="https://"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="customer-terms-version">用户协议版本</label>
            <input
              id="customer-terms-version"
              v-model="form.termsVersion"
              maxlength="40"
              placeholder="2026-07"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="customer-privacy-url">隐私政策地址</label>
            <input
              id="customer-privacy-url"
              v-model="form.privacyUrl"
              type="url"
              placeholder="https://"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="customer-privacy-version">隐私政策版本</label>
            <input
              id="customer-privacy-version"
              v-model="form.privacyVersion"
              maxlength="40"
              placeholder="2026-07"
              :disabled="!canManage"
            />
          </div>
        </div>
      </section>
      <SettingsFormActions
        v-if="canManage"
        :pending="pending"
        primary-label="保存账号与合规设置"
        impact-text="条款链接与版本号会用于后续的注册确认和授权记录。"
      />
    </form>
  </section>
</template>
