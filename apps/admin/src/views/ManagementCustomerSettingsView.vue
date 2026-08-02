<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { CustomerAccountMode, OrganizationSettingsResult } from '@conference/contracts';
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
  defaultAccountMode: 'mobile_otp_required' as CustomerAccountMode,
  termsUrl: '',
  termsVersion: '',
  privacyUrl: '',
  privacyVersion: '',
});
const canManage = computed(() => session.canAny(['org.settings.manage']));
const { clearDirty, setBusy, setResetHandler } = useSettingsFormScope();

function applySettings(value: OrganizationSettingsResult) {
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
    errorMessage.value = error instanceof Error ? error.message : '用户账号设置读取失败';
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!loaded.value) {
    errorMessage.value = '请先重新载入用户账号设置';
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
    message.value = '用户账号默认值已保存，新建大会会继承当前登录模式。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '用户账号设置保存失败';
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在载入用户账号设置…</div>
  <div v-else-if="!loaded" class="admin-loading">
    <button class="btn btn-secondary" type="button" @click="load">重新载入</button>
  </div>

  <section v-else class="admin-panel settings-module">
    <header class="admin-panel-header settings-module-header">
      <div>
        <p class="settings-module-kicker">CUSTOMER ACCOUNTS</p>
        <h1>用户账号</h1>
        <p>设置新建大会的默认登录模式，并维护用户协议和隐私政策版本。</p>
      </div>
    </header>
    <form
      class="event-form settings-form-spaced"
      data-settings-form
      :inert="pending"
      :aria-busy="pending"
      @submit.prevent="save"
    >
      <section class="settings-form-section" aria-labelledby="customer-login-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="customer-login-heading">默认登录模式</h2>
            <p>新建大会将继承该模式，单个大会仍可独立调整。</p>
          </div>
        </div>
        <div class="choice-card-grid" role="radiogroup" aria-labelledby="customer-login-heading">
          <label
            class="choice-card"
            :class="{ selected: form.defaultAccountMode === 'mobile_otp_required' }"
          >
            <input
              v-model="form.defaultAccountMode"
              type="radio"
              value="mobile_otp_required"
              :disabled="!canManage"
            />
            <span>
              <strong>默认手机号验证码登录</strong>
              <small>普通用户登录后报名，自动沉淀跨大会历史</small>
            </span>
          </label>
          <label
            class="choice-card"
            :class="{ selected: form.defaultAccountMode === 'guest_allowed' }"
          >
            <input
              v-model="form.defaultAccountMode"
              type="radio"
              value="guest_allowed"
              :disabled="!canManage"
            />
            <span>
              <strong>默认允许游客报名</strong>
              <small>适合临时活动，登录用户仍会关联用户中心</small>
            </span>
          </label>
        </div>
      </section>
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
        primary-label="保存用户账号设置"
        impact-text="条款链接会立即更新；默认登录方式用于后续新建大会。"
      />
    </form>
  </section>
</template>
