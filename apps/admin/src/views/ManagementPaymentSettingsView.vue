<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { WeChatPayConfiguration } from '@conference/contracts';
import SaveStatus from '../components/SaveStatus.vue';
import SettingsFormActions from '../components/SettingsFormActions.vue';
import { useSettingsFormScope } from '../composables/settings-form-state';
import { conferenceApi, session } from '../lib/api';

const configuration = ref<WeChatPayConfiguration>();
const unmatchedRefunds = ref<
  Awaited<ReturnType<typeof conferenceApi.unmatchedRefundNotifications>>
>([]);
const loading = ref(true);
const loaded = ref(false);
const pending = ref(false);
const testing = ref(false);
const showMerchantPrivateKey = ref(false);
const message = ref('');
const errorMessage = ref('');
const form = reactive({
  enabled: true,
  refundFunding: '' as '' | 'default' | 'available',
  appId: '',
  mchId: '',
  merchantCertificateSerial: '',
  merchantPrivateKey: '',
  apiV3Key: '',
  platformPublicKeyId: '',
  platformPublicKey: '',
  appSecret: '',
  oauthEnabled: false,
  channels: {
    native: true,
    jsapi: false,
    h5: false,
  },
});
const canManage = computed(() => session.canAny(['org.settings.manage']));
const { clearDirty, dirty, setBusy, setResetHandler } = useSettingsFormScope();
const statusLabel = computed(() => {
  const labels = {
    unconfigured: '待配置',
    configured: '待验证',
    verified: '验证通过',
    error: '验证失败',
  };
  return labels[configuration.value?.status ?? 'unconfigured'];
});
const channelSummary = computed(() => {
  const channels = configuration.value?.channels ?? form.channels;
  const enabled = [
    channels.native ? 'Native' : null,
    channels.jsapi ? 'JSAPI' : null,
    channels.h5 ? 'H5' : null,
  ].filter(Boolean);
  return enabled.length ? enabled.join(' · ') : '未开放通道';
});

/**
 * Hydrates the editable form from a server configuration payload.
 *
 * @param value - Latest WeChat Pay configuration from the API
 */
function applyConfiguration(value: WeChatPayConfiguration) {
  configuration.value = value;
  Object.assign(form, {
    enabled: value.enabled,
    refundFunding: value.refundFunding ?? '',
    appId: value.appId,
    mchId: value.mchId,
    merchantCertificateSerial: value.merchantCertificateSerial,
    merchantPrivateKey: '',
    apiV3Key: '',
    platformPublicKeyId: value.platformPublicKeyId,
    platformPublicKey: '',
    appSecret: '',
    oauthEnabled: value.oauthEnabled,
    channels: {
      native: value.channels.native,
      jsapi: value.channels.jsapi,
      h5: value.channels.h5,
    },
  });
  showMerchantPrivateKey.value = false;
  clearDirty();
}

/**
 * Restores the form to the last loaded configuration.
 */
function resetForm() {
  if (configuration.value) applyConfiguration(configuration.value);
}

setResetHandler(resetForm);
watch([pending, testing], () => setBusy(pending.value || testing.value), { immediate: true });

/**
 * Loads the organization WeChat Pay configuration.
 */
async function load() {
  loading.value = true;
  loaded.value = false;
  errorMessage.value = '';
  try {
    applyConfiguration(await conferenceApi.getWeChatPayConfiguration());
    if (canManage.value)
      unmatchedRefunds.value = await conferenceApi.unmatchedRefundNotifications();
    loaded.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '微信支付配置读取失败';
  } finally {
    loading.value = false;
  }
}

/**
 * Runs the WeChat Pay connection echo test.
 */
async function testConnection() {
  if (!loaded.value) {
    errorMessage.value = '请先重新载入微信支付配置';
    return;
  }
  testing.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const result = await conferenceApi.testWeChatPayConfiguration();
    configuration.value = await conferenceApi.getWeChatPayConfiguration();
    if (result.ok) {
      message.value = result.message;
    } else {
      errorMessage.value = result.message;
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '微信支付连接验证失败';
  } finally {
    testing.value = false;
  }
}

/**
 * Persists configuration changes and immediately re-validates the merchant link.
 */
async function save() {
  if (!loaded.value) {
    errorMessage.value = '请先重新载入微信支付配置';
    return;
  }
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const result = await conferenceApi.updateWeChatPayConfiguration({
      enabled: form.enabled,
      ...(form.refundFunding ? { refundFunding: form.refundFunding } : {}),
      appId: form.appId.trim(),
      mchId: form.mchId.trim(),
      merchantCertificateSerial: form.merchantCertificateSerial.trim(),
      platformPublicKeyId: form.platformPublicKeyId.trim(),
      oauthEnabled: form.oauthEnabled,
      channels: {
        native: form.channels.native,
        jsapi: form.channels.jsapi,
        h5: form.channels.h5,
      },
      ...(form.merchantPrivateKey.trim()
        ? { merchantPrivateKey: form.merchantPrivateKey.trim() }
        : {}),
      ...(form.apiV3Key ? { apiV3Key: form.apiV3Key } : {}),
      ...(form.platformPublicKey.trim()
        ? { platformPublicKey: form.platformPublicKey.trim() }
        : {}),
      ...(form.appSecret.trim() ? { appSecret: form.appSecret.trim() } : {}),
    });
    applyConfiguration(result);
    message.value = '配置已加密保存，正在验证微信支付连接。';
    await testConnection();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '微信支付配置保存失败';
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在载入支付设置…</div>
  <div v-else-if="!loaded" class="admin-loading">
    <button class="btn btn-secondary" type="button" @click="load">重新载入</button>
  </div>

  <section v-else class="admin-panel settings-module">
    <header class="admin-panel-header settings-module-header">
      <div>
        <p class="settings-module-kicker">WECHAT PAY · THREE CHANNELS</p>
        <h1>支付服务</h1>
        <p>配置 Native / JSAPI / H5 三通道。回调仍走大会主站稳定 notify 地址。</p>
      </div>
      <div class="settings-module-status">
        <span class="status-badge" :class="configuration?.status === 'verified' ? 'paid' : 'draft'">
          {{ statusLabel }}
        </span>
        <button
          v-if="canManage"
          class="button secondary compact"
          type="button"
          :disabled="testing || pending || dirty || configuration?.status === 'unconfigured'"
          :title="dirty ? '请先保存当前修改再重新验证' : undefined"
          @click="testConnection"
        >
          {{ testing ? '验证中…' : '重新验证' }}
        </button>
      </div>
    </header>
    <form
      class="event-form settings-form-spaced"
      data-settings-form
      :inert="pending || testing"
      :aria-busy="pending || testing"
      @submit.prevent="save"
    >
      <div class="settings-summary">
        <div>
          <span>开放通道</span>
          <strong>{{ channelSummary }}</strong>
        </div>
        <div>
          <span>支付回调</span>
          <code>{{ configuration?.notifyUrl }}</code>
        </div>
        <div>
          <span>OAuth 回调</span>
          <code>{{ configuration?.oauthRedirectUri || '未配置 PAYMENT_PUBLIC_URL' }}</code>
        </div>
        <label class="settings-toggle">
          <input v-model="form.enabled" type="checkbox" :disabled="!canManage" />
          <span>{{ form.enabled ? '已启用' : '已停用' }}</span>
        </label>
      </div>

      <section class="settings-form-section" aria-labelledby="payment-channels-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="payment-channels-heading">支付通道</h2>
            <p>Native 扫码是当前默认通道，关闭只阻止新建支付，存量入账不受影响。</p>
          </div>
        </div>
        <div class="form-grid">
          <label class="settings-toggle">
            <input v-model="form.channels.native" type="checkbox" :disabled="!canManage" />
            <span>Native 扫码</span>
          </label>
        </div>
        <details class="settings-advanced-block">
          <summary>高级通道：JSAPI、H5 与公众号 OAuth</summary>
          <p>仅在微信内支付或手机浏览器支付上线时配置。</p>
          <div class="form-grid">
            <label class="settings-toggle">
              <input
                v-model="form.channels.jsapi"
                type="checkbox"
                :disabled="
                  !canManage || (!form.oauthEnabled && !configuration?.secretsPresent.appSecret)
                "
              />
              <span>JSAPI（微信内）</span>
            </label>
            <label class="settings-toggle">
              <input v-model="form.channels.h5" type="checkbox" :disabled="!canManage" />
              <span>H5（手机浏览器）</span>
            </label>
            <label class="settings-toggle">
              <input v-model="form.oauthEnabled" type="checkbox" :disabled="!canManage" />
              <span>启用公众号 OAuth</span>
            </label>
            <div class="form-field full">
              <label for="wechat-app-secret">公众号 AppSecret</label>
              <input
                id="wechat-app-secret"
                v-model="form.appSecret"
                type="password"
                autocomplete="new-password"
                maxlength="128"
                :required="form.oauthEnabled && !configuration?.secretsPresent.appSecret"
                :placeholder="
                  configuration?.secretsPresent.appSecret
                    ? '已安全保存，留空保持原值'
                    : '仅 OAuth / JSAPI 需要'
                "
                :disabled="!canManage"
              />
            </div>
          </div>
        </details>
      </section>

      <section class="settings-form-section" aria-labelledby="payment-identity-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="payment-identity-heading">商户身份</h2>
            <p>填写已绑定商户号的公众号 AppID、商户号与证书标识。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label for="wechat-app-id">AppID</label>
            <input
              id="wechat-app-id"
              v-model="form.appId"
              required
              maxlength="64"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="wechat-mch-id">商户号 MCHID</label>
            <input
              id="wechat-mch-id"
              v-model="form.mchId"
              required
              inputmode="numeric"
              maxlength="32"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="wechat-cert-serial">商户证书序列号</label>
            <input
              id="wechat-cert-serial"
              v-model="form.merchantCertificateSerial"
              required
              maxlength="128"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="wechat-public-key-id">微信支付公钥 ID</label>
            <input
              id="wechat-public-key-id"
              v-model="form.platformPublicKeyId"
              required
              maxlength="128"
              :disabled="!canManage"
            />
          </div>
        </div>
      </section>

      <section class="settings-form-section" aria-labelledby="payment-refund-heading">
        <div v-if="unmatchedRefunds.length" class="settings-inline-error" role="alert">
          <strong>{{ unmatchedRefunds.length }} 条退款通知需要核验</strong>
          <p v-for="item in unmatchedRefunds" :key="item.id">
            {{ item.outRefundNo }} · {{ item.lastError }}。请在关联订单中使用外部退款核验入口。
          </p>
        </div>

        <div class="settings-form-section-head">
          <h3 id="payment-refund-heading">原路退款</h3>
          <p>
            请由财务确认商户账户类型。余额不足时，系统每 5 分钟重试；到账时间以微信及银行结果为准。
          </p>
        </div>
        <div class="form-field full">
          <label for="wechat-refund-funding">退款出资账户</label>
          <select id="wechat-refund-funding" v-model="form.refundFunding" :disabled="!canManage">
            <option value="" disabled>待财务确认</option>
            <option value="default">默认退款账户（按微信商户配置）</option>
            <option value="available">可用余额（已确认使用旧资金账户）</option>
          </select>
        </div>
        <p v-if="configuration?.refundNotifyUrl">
          退款结果通知地址：{{ configuration.refundNotifyUrl }}
        </p>
      </section>
      <section class="settings-form-section" aria-labelledby="payment-credentials-heading">
        <div class="settings-form-section-head">
          <div>
            <h2 id="payment-credentials-heading">加密凭据</h2>
            <p>已保存的敏感内容不会回传浏览器，留空即可继续使用原值。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-field full">
            <div class="settings-secret-label">
              <label for="wechat-private-key">商户 API 私钥</label>
              <button
                class="text-link"
                type="button"
                :disabled="!form.merchantPrivateKey"
                :aria-pressed="showMerchantPrivateKey"
                @click="showMerchantPrivateKey = !showMerchantPrivateKey"
              >
                {{ showMerchantPrivateKey ? '隐藏内容' : '显示内容' }}
              </button>
            </div>
            <textarea
              id="wechat-private-key"
              v-model="form.merchantPrivateKey"
              class="settings-secret-input"
              :class="{ 'is-masked': !showMerchantPrivateKey }"
              rows="5"
              autocomplete="new-password"
              :required="!configuration?.secretsPresent.merchantPrivateKey"
              :placeholder="
                configuration?.secretsPresent.merchantPrivateKey
                  ? '已安全保存，留空保持原值'
                  : '粘贴 PEM 格式商户私钥'
              "
              :disabled="!canManage"
            />
          </div>
          <div class="form-field full">
            <label for="wechat-api-v3-key">APIv3 密钥</label>
            <input
              id="wechat-api-v3-key"
              v-model="form.apiV3Key"
              type="password"
              autocomplete="new-password"
              minlength="32"
              maxlength="32"
              :required="!configuration?.secretsPresent.apiV3Key"
              :placeholder="
                configuration?.secretsPresent.apiV3Key
                  ? '已安全保存，留空保持原值'
                  : '32 位 APIv3 密钥'
              "
              :disabled="!canManage"
            />
          </div>
          <div class="form-field full">
            <label for="wechat-public-key">微信支付公钥</label>
            <textarea
              id="wechat-public-key"
              v-model="form.platformPublicKey"
              rows="5"
              autocomplete="off"
              :required="!configuration?.secretsPresent.platformPublicKey"
              :placeholder="
                configuration?.secretsPresent.platformPublicKey
                  ? '已安全保存，留空保持原值'
                  : '-----BEGIN PUBLIC KEY-----'
              "
              :disabled="!canManage"
            />
          </div>
        </div>
      </section>
      <div class="settings-security-note">
        <strong>安全策略</strong>
        <span>密钥使用 AES-256-GCM 加密保存。OAuth AppSecret 永不返回前端，也不写入代理或追踪日志。稳定
          notify 固定在大会主站 API，支付页入口可单独回滚。</span>
      </div>
      <div v-if="configuration?.lastError" class="settings-inline-error">
        最近一次验证：{{ configuration.lastError }}
      </div>
      <SettingsFormActions
        v-if="canManage"
        :pending="pending"
        :disabled="testing"
        primary-label="保存并验证"
      />
    </form>
  </section>
</template>
