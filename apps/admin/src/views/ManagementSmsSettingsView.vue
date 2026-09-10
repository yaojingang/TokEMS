<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  TestAliyunSmsConfigurationSchema,
  type AliyunSmsConfiguration,
  type AliyunSmsConnectionTest,
  type AliyunSmsTemplateKey,
} from '@conference/contracts';
import SaveStatus from '../components/SaveStatus.vue';
import SettingsFormActions from '../components/SettingsFormActions.vue';
import { useSettingsFormScope } from '../composables/settings-form-state';
import { conferenceApi, session } from '../lib/api';

const templateRows: Array<{
  key: AliyunSmsTemplateKey;
  name: string;
  description: string;
  variables: string[];
}> = [
  {
    key: 'customerOtp',
    name: '登录验证码',
    description: '用户使用手机号登录网站时发送',
    variables: ['code'],
  },
  {
    key: 'registrationSubmitted',
    name: '报名已提交',
    description: '报名资料提交成功后发送访问入口',
    variables: ['eventName', 'url', 'expiresAt'],
  },
  {
    key: 'registrationApproved',
    name: '报名审核通过',
    description: '人工审核通过后通知参会用户',
    variables: ['eventName', 'url'],
  },
  {
    key: 'registrationRejected',
    name: '报名审核未通过',
    description: '人工审核拒绝后发送原因',
    variables: ['eventName', 'reason'],
  },
  {
    key: 'refundReviewed',
    name: '退款审核结果',
    description: '审核通过或驳回后通知购票人',
    variables: ['eventName', 'orderNo', 'result'],
  },
  {
    key: 'refundSucceeded',
    name: '退款成功',
    description: '微信核验成功后通知购票人',
    variables: ['eventName', 'orderNo', 'amount'],
  },
  {
    key: 'ticketIssued',
    name: '电子票已签发',
    description: '电子票签发后通知参会人',
    variables: ['eventName', 'url'],
  },
  {
    key: 'paymentSucceeded',
    name: '支付成功',
    description: '支付回调确认成功后发送',
    variables: ['eventName', 'orderNo', 'amount'],
  },
  {
    key: 'waitlistAvailable',
    name: '候补名额释放',
    description: '候补用户获得限时名额时发送',
    variables: ['name', 'eventName', 'expiresAt', 'url'],
  },
  {
    key: 'invoiceDetailsRequested',
    name: '补充发票信息',
    description: '发票资料需要补充时发送填写入口',
    variables: ['eventName', 'expiresAt', 'url'],
  },
  {
    key: 'invoiceReady',
    name: '发票短信通知',
    description: '开启后，上传或替换发票成功时通知购票人。链接免登录，有效期 30 天。',
    variables: ['eventName', 'expiresAt', 'fileToken'],
  },
  {
    key: 'eventReminder',
    name: '大会提醒',
    description: '运营人员发送大会开始提醒',
    variables: ['eventName', 'startsAt', 'venue'],
  },
];

const templateGroups = [
  {
    key: 'account',
    name: '账号与登录',
    description: '保障用户登录和身份验证。',
    keys: ['customerOtp'] as AliyunSmsTemplateKey[],
  },
  {
    key: 'registration',
    name: '报名与交易',
    description: '覆盖报名、审核、支付、候补和发票进度。',
    keys: [
      'registrationSubmitted',
      'registrationApproved',
      'registrationRejected',
      'paymentSucceeded',
      'ticketIssued',
      'refundReviewed',
      'refundSucceeded',
      'waitlistAvailable',
      'invoiceDetailsRequested',
      'invoiceReady',
    ] as AliyunSmsTemplateKey[],
  },
  {
    key: 'operations',
    name: '运营通知',
    description: '用于大会前的运营提醒。',
    keys: ['eventReminder'] as AliyunSmsTemplateKey[],
  },
].map((group) => ({
  ...group,
  rows: templateRows.filter((row) => group.keys.includes(row.key)),
}));

const configuration = ref<AliyunSmsConfiguration>();
const loading = ref(true);
const loaded = ref(false);
const pending = ref(false);
const testing = ref(false);
const invoiceTestMessage = ref('');
const needsReload = ref(false);
const invoiceCopy = computed(
  () =>
    `【${form.signName || '短信签名'}】您的${'${eventName}'}电子发票已开具，请于${'${expiresAt}'}前查看及下载：${configuration.value?.invoiceFileOrigin || '本站域名'}/invoice/file/${'${fileToken}'}。请妥善保管领取链接。`,
);
let testTimer: ReturnType<typeof setInterval> | undefined;
const invoiceReadyVerified = computed(() =>
  Boolean(configuration.value?.invoiceSms.verifiedFingerprint),
);
onUnmounted(() => {
  if (testTimer) clearInterval(testTimer);
});
async function refreshInvoiceTest(deliveryId: string) {
  try {
    const result = await conferenceApi.getInvoiceSmsTestStatus(deliveryId);
    invoiceTestMessage.value = result.ready
      ? '测试短信已送达，PDF 可直接打开。现在可以开启发票短信通知。'
      : (result.error ??
        (result.status === 'accepted'
          ? '短信平台已受理，等待送达回执。'
          : '正在验证公开文件与短信发送结果。'));
    if (
      result.ready ||
      ['failed', 'cancelled'].includes(result.status) ||
      !result.configurationMatches
    ) {
      if (testTimer) clearInterval(testTimer);
      const latest = await conferenceApi.getAliyunSmsConfiguration();
      if (!hasUnsavedChanges.value) applyConfiguration(latest);
      else {
        invoiceTestMessage.value += ' 当前有未保存修改，请重新载入配置后继续。';
        needsReload.value = true;
      }
    }
  } catch {
    invoiceTestMessage.value = '测试状态读取失败，请稍后刷新。';
  }
}
const message = ref('');
const errorMessage = ref('');
const testPhone = ref('');
const testTemplateKey = ref<AliyunSmsTemplateKey>('customerOtp');
const testConfirmed = ref(false);
const testPhoneInput = ref<HTMLInputElement>();
const testResult = ref<AliyunSmsConnectionTest>();
const testError = ref('');
const form = reactive({
  enabled: false,
  signName: '',
  accessKeyId: '',
  accessKeySecret: '',
  templates: Object.fromEntries(
    templateRows.map((row) => [row.key, { enabled: row.key === 'customerOtp', templateCode: '' }]),
  ) as AliyunSmsConfiguration['templates'],
});

const canManage = computed(() => session.can('org.settings.manage'));
const { clearDirty, setBusy, setDirty, setResetHandler } = useSettingsFormScope();
const statusLabel = computed(() => {
  const labels = {
    unconfigured: '待配置',
    configured: '待验证',
    verified: '接口验证通过',
    error: '验证失败',
  };
  return labels[configuration.value?.status ?? 'unconfigured'];
});
const enabledTemplates = computed(() =>
  templateRows.filter((row) => form.templates[row.key].enabled),
);
const hasUnsavedChanges = computed(() => {
  const current = configuration.value;
  if (!current) return false;
  if (form.accessKeyId.trim() || form.accessKeySecret.trim()) return true;
  if (form.enabled !== current.enabled || form.signName.trim() !== current.signName) return true;
  return templateRows.some(
    (row) =>
      form.templates[row.key].enabled !== current.templates[row.key].enabled ||
      form.templates[row.key].templateCode.trim() !== current.templates[row.key].templateCode,
  );
});
const selectedTemplate = computed(
  () => templateRows.find((row) => row.key === testTemplateKey.value)!,
);
const testPhoneValid = computed(() =>
  TestAliyunSmsConfigurationSchema.shape.phoneNumber.safeParse(testPhone.value).success,
);
const testBlockedReason = computed(() => {
  const saved = configuration.value;
  if (!canManage.value) return '当前账号没有短信设置管理权限。';
  if (hasUnsavedChanges.value) return '当前有未保存修改，请先保存配置再发送测试短信。';
  if (needsReload.value) return '请重新载入最新配置后继续测试。';
  if (!saved?.secretsPresent.accessKeyId || !saved.secretsPresent.accessKeySecret || !saved.signName)
    return '请先在下方保存短信账号与签名，并配置要测试的模板 CODE。';
  if (!saved.enabled) return '短信服务尚未启用，请在下方开启并保存。';
  if (!saved.templates[testTemplateKey.value].templateCode)
    return `请先填写并保存「${selectedTemplate.value.name}」的模板 CODE。`;
  if (testTemplateKey.value !== 'invoiceReady' && !saved.templates[testTemplateKey.value].enabled)
    return `请先启用并保存「${selectedTemplate.value.name}」场景。`;
  return '';
});
const canSendTest = computed(
  () =>
    canManage.value &&
    loaded.value &&
    !testBlockedReason.value &&
    testPhoneValid.value &&
    testConfirmed.value &&
    !pending.value &&
    !testing.value,
);

async function selectTestTemplate(key: AliyunSmsTemplateKey) {
  testTemplateKey.value = key;
  testConfirmed.value = false;
  await nextTick();
  testPhoneInput.value?.focus({ preventScroll: true });
  testPhoneInput.value?.scrollIntoView({ block: 'center' });
}

function applyConfiguration(value: AliyunSmsConfiguration) {
  configuration.value = value;
  form.enabled = value.enabled;
  form.signName = value.signName;
  form.accessKeyId = '';
  form.accessKeySecret = '';
  for (const row of templateRows) {
    Object.assign(form.templates[row.key], value.templates[row.key]);
  }
  const firstEnabled = templateRows.find((row) => value.templates[row.key].enabled);
  if (firstEnabled && testTemplateKey.value !== 'invoiceReady' && !value.templates[testTemplateKey.value].enabled) testTemplateKey.value = firstEnabled.key;
  testConfirmed.value = false;
  clearDirty();
}

function resetForm() {
  if (configuration.value) applyConfiguration(configuration.value);
}

setResetHandler(resetForm);
watch([pending, testing], () => setBusy(pending.value || testing.value), { immediate: true });
watch(hasUnsavedChanges, setDirty, { immediate: true });

async function load() {
  needsReload.value = false;
  loading.value = true;
  loaded.value = false;
  message.value = '';
  errorMessage.value = '';
  try {
    applyConfiguration(await conferenceApi.getAliyunSmsConfiguration());
    loaded.value = true;
    const testId = configuration.value?.invoiceSms.testDeliveryId;
    if (testId) {
      void refreshInvoiceTest(testId);
      if (testTimer) clearInterval(testTimer);
      testTimer = setInterval(() => void refreshInvoiceTest(testId), 5000);
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '短信服务配置读取失败';
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!loaded.value) {
    errorMessage.value = '请先重新载入短信服务配置';
    return;
  }
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const result = await conferenceApi.updateAliyunSmsConfiguration({
      enabled: form.enabled,
      expectedUpdatedAt: configuration.value?.updatedAt ?? null,
      invoiceDeliveryMode: 'direct_file_v1',
      signName: form.signName.trim(),
      templates: Object.fromEntries(
        templateRows.map((row) => [
          row.key,
          {
            enabled: form.templates[row.key].enabled,
            templateCode: form.templates[row.key].templateCode.trim(),
          },
        ]),
      ) as AliyunSmsConfiguration['templates'],
      ...(form.accessKeyId.trim() ? { accessKeyId: form.accessKeyId.trim() } : {}),
      ...(form.accessKeySecret.trim() ? { accessKeySecret: form.accessKeySecret.trim() } : {}),
    });
    applyConfiguration(result);
    message.value =
      '短信配置已加密保存。发送测试短信后，阿里云受理成功的模板会标记为接口验证通过。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '短信服务配置保存失败';
  } finally {
    pending.value = false;
  }
}

async function sendTest() {
  if (!canSendTest.value) return;
  testing.value = true;
  testResult.value = undefined;
  testError.value = '';
  try {
    const result = await conferenceApi.testAliyunSmsConfiguration({
      phoneNumber: testPhone.value.trim(),
      templateKey: testTemplateKey.value,
    });
    testResult.value = result;
    testConfirmed.value = false;
    if (result.deliveryId) {
      invoiceTestMessage.value = result.message;
      if (testTimer) clearInterval(testTimer);
      testTimer = setInterval(() => void refreshInvoiceTest(result.deliveryId!), 5000);
    }
    try {
      applyConfiguration(await conferenceApi.getAliyunSmsConfiguration());
    } catch {
      testError.value = '测试已提交，配置状态刷新失败。请重新载入后查看。';
      needsReload.value = true;
    }
  } catch (error) {
    testError.value = error instanceof Error ? error.message : '测试短信发送失败';
  } finally {
    testing.value = false;
  }
}

onMounted(load);

watch([testPhone, testTemplateKey], () => {
  testConfirmed.value = false;
});
</script>

<template>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在载入短信服务设置…</div>
  <div v-else-if="!loaded" class="admin-loading">
    <button class="btn btn-secondary" type="button" @click="load">重新载入</button>
  </div>

  <section v-else class="admin-panel settings-module">
    <header class="admin-panel-header settings-module-header">
      <div>
        <p class="settings-module-kicker">ALIYUN SMS · DOMESTIC</p>
        <h1>短信服务</h1>
        <p>组织级配置会供全部大会使用，每个通知场景独立绑定阿里云模板。</p>
      </div>
      <span
        class="status-badge"
        :class="
          configuration?.status === 'verified'
            ? 'paid'
            : configuration?.status === 'error'
              ? 'issue'
              : 'draft'
        "
      >
        {{ statusLabel }}
      </span>
    </header>

    <form
      id="sms-test"
      class="sms-test-panel"
      aria-labelledby="sms-test-heading"
      :aria-busy="testing"
      @submit.prevent="sendTest"
    >
      <div class="settings-form-section-head">
        <div>
          <h3 id="sms-test-heading">发送测试短信</h3>
          <p>使用已保存的账号、签名和模板，向指定手机发送真实短信。</p>
        </div>
        <a class="text-link" href="#sms-account">配置账号与签名</a>
      </div>
      <p v-if="testBlockedReason" class="settings-inline-warning" role="status">
        {{ testBlockedReason }}
      </p>
      <button v-if="needsReload" class="button secondary" type="button" @click="load">
        {{ hasUnsavedChanges ? '放弃未保存修改并重新载入' : '重新载入配置' }}
      </button>
      <div class="sms-test-fields">
        <div class="form-field">
          <label for="sms-test-phone">接收手机号</label>
          <input
            id="sms-test-phone"
            ref="testPhoneInput"
            v-model="testPhone"
            type="tel"
            inputmode="tel"
            autocomplete="tel"
            maxlength="14"
            placeholder="填写接收测试短信的手机号"
            :aria-invalid="Boolean(testPhone.trim()) && !testPhoneValid"
            aria-describedby="sms-test-phone-hint"
            :disabled="!canManage || pending || testing"
          />
          <small
            id="sms-test-phone-hint"
            :class="{ 'sms-test-invalid': testPhone.trim() && !testPhoneValid }"
          >
            {{
              testPhone.trim() && !testPhoneValid
                ? '请输入有效的中国大陆手机号'
                : '支持中国大陆手机号，可带 +86 前缀。'
            }}
          </small>
        </div>
        <div class="form-field">
          <label for="sms-test-template">测试场景</label>
          <select
            id="sms-test-template"
            v-model="testTemplateKey"
            :disabled="!canManage || pending || testing"
          >
            <option v-for="row in templateRows" :key="row.key" :value="row.key">
              {{ row.name
              }}{{
                row.key === 'invoiceReady'
                  ? '（可先测试）'
                  : form.templates[row.key].enabled
                    ? ''
                    : '（未启用）'
              }}
            </option>
          </select>
        </div>
      </div>
      <div class="sms-test-context">
        <span>签名：<strong>{{ configuration?.signName || '待配置' }}</strong></span>
        <span>
          模板：<code>{{ configuration?.templates[testTemplateKey].templateCode || '待配置' }}</code>
        </span>
        <a class="text-link" href="#sms-templates">配置通知模板</a>
        <p>
          {{
            testTemplateKey === 'invoiceReady'
              ? '将发送测试 PDF 的领取链接，并检查文件访问与送达回执。重新测试会暂时关闭发票通知。'
              : '系统自动填入所选场景的示例数据，用于验证短信接口与模板。'
          }}
        </p>
      </div>
      <label class="sms-test-confirm">
        <input
          v-model="testConfirmed"
          type="checkbox"
          :disabled="!canManage || pending || testing"
        />
        <span>我确认将向上述手机号发送真实短信，并可能产生费用。</span>
      </label>
      <button class="button" type="submit" :disabled="!canSendTest">
        {{ testing ? '发送中…' : '发送并验证' }}
      </button>
      <div
        v-if="testResult && !testResult.deliveryId"
        class="sms-test-result"
        :class="{ 'is-error': !testResult.ok }"
        :role="testResult.ok ? 'status' : 'alert'"
      >
        <strong>{{ testResult.ok ? '短信平台已受理' : '短信发送失败' }}</strong>
        <p>{{ testResult.message }}</p>
        <p v-if="testResult.bizId">受理编号：<code>{{ testResult.bizId }}</code></p>
      </div>
      <p v-if="testError" class="settings-inline-error" role="alert">{{ testError }}</p>
      <p v-if="invoiceTestMessage" class="sms-test-result" role="status">{{ invoiceTestMessage }}</p>
    </form>

    <form
      class="event-form settings-form-spaced"
      data-settings-form
      :inert="pending || testing"
      :aria-busy="pending || testing"
      @submit.prevent="save"
    >
      <div class="settings-summary sms-settings-summary">
        <div>
          <span>服务商</span>
          <strong>阿里云短信</strong>
        </div>
        <div>
          <span>API 地址</span>
          <code>{{ configuration?.endpoint }}</code>
        </div>
        <label class="settings-toggle">
          <input v-model="form.enabled" type="checkbox" :disabled="!canManage" />
          <span>{{ form.enabled ? '已启用' : '已停用' }}</span>
        </label>
      </div>

      <section id="sms-account" class="settings-form-section" aria-labelledby="sms-account-heading">
        <div class="settings-form-section-head">
          <div>
            <h3 id="sms-account-heading">账号与签名</h3>
            <p>建议使用仅拥有短信发送与查询权限的 RAM 用户。</p>
          </div>
          <a
            class="text-link"
            href="https://help.aliyun.com/zh/sms/identity-management"
            target="_blank"
            rel="noopener noreferrer"
          >查看权限文档</a>
        </div>
        <div class="form-grid">
          <div class="form-field full">
            <label for="sms-sign-name">短信签名名称</label>
            <input
              id="sms-sign-name"
              v-model="form.signName"
              required
              maxlength="100"
              placeholder="填写已审核通过的阿里云短信签名"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="sms-access-key-id">AccessKey ID</label>
            <input
              id="sms-access-key-id"
              v-model="form.accessKeyId"
              autocomplete="off"
              maxlength="128"
              :required="!configuration?.secretsPresent.accessKeyId"
              :placeholder="
                configuration?.secretsPresent.accessKeyId ? '已安全保存，留空保持原值' : 'LTAI…'
              "
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="sms-access-key-secret">AccessKey Secret</label>
            <input
              id="sms-access-key-secret"
              v-model="form.accessKeySecret"
              type="password"
              autocomplete="new-password"
              maxlength="256"
              :required="!configuration?.secretsPresent.accessKeySecret"
              :placeholder="
                configuration?.secretsPresent.accessKeySecret
                  ? '已安全保存，留空保持原值'
                  : '填写 AccessKey Secret'
              "
              :disabled="!canManage"
            />
          </div>
        </div>
      </section>

      <section id="sms-templates" class="settings-form-section" aria-labelledby="sms-template-heading">
        <div class="settings-form-section-head">
          <div>
            <h3 id="sms-template-heading">通知场景与模板</h3>
            <p>变量名称需要与阿里云控制台中已审核通过的模板保持一致。</p>
          </div>
          <span class="settings-count">{{ enabledTemplates.length }} 个场景已启用</span>
        </div>
        <div class="sms-template-groups">
          <section v-for="group in templateGroups" :key="group.key" class="sms-template-group">
            <header>
              <h4>{{ group.name }}</h4>
              <p>{{ group.description }}</p>
            </header>
            <div class="sms-template-list">
              <article v-for="row in group.rows" :key="row.key" class="sms-template-row">
                <label class="sms-template-switch">
                  <input
                    v-model="form.templates[row.key].enabled"
                    type="checkbox"
                    :disabled="
                      !canManage ||
                        (row.key === 'invoiceReady' &&
                          !form.templates.invoiceReady.enabled &&
                          !invoiceReadyVerified)
                    "
                  />
                  <span>
                    <strong>{{ row.name }}</strong>
                    <small>{{ row.description }}</small>
                    <small
                      v-if="form.templates[row.key].enabled"
                      class="sms-template-validation"
                      :class="`is-${row.key === 'invoiceReady' && invoiceReadyVerified ? 'verified' : form.templates[row.key].status ?? 'unverified'}`"
                    >
                      {{
                        row.key === 'invoiceReady' && invoiceReadyVerified
                          ? '测试短信已送达，文件可打开'
                          : form.templates[row.key].status === 'verified'
                            ? '接口已受理'
                            : form.templates[row.key].status === 'error'
                              ? '模板验证失败'
                              : '模板待验证'
                      }}
                    </small>
                  </span>
                </label>
                <div class="sms-template-code">
                  <label :for="`sms-template-${row.key}`">模板 CODE</label>
                  <input
                    :id="`sms-template-${row.key}`"
                    v-model="form.templates[row.key].templateCode"
                    maxlength="40"
                    placeholder="SMS_123456789"
                    :required="form.templates[row.key].enabled"
                    :disabled="!canManage"
                  />
                </div>
                <div class="sms-template-tools">
                  <div class="sms-variable-list" aria-label="模板变量">
                    <code v-for="variable in row.variables" :key="variable">{{ variable }}</code>
                  </div>
                  <button
                    class="button secondary compact"
                    type="button"
                    :disabled="!canManage || pending || testing"
                    :aria-label="`测试${row.name}模板`"
                    @click="selectTestTemplate(row.key)"
                  >
                    测试此模板
                  </button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </section>

      <div class="settings-security-note">
        <strong>发票短信启用步骤</strong>
        <span>保存发票模板 CODE → 选择发票场景发送测试 → 收到送达回执 →
          开启并保存。模板须包含固定本站域名与 /invoice/file/ 路径，fileToken 使用 24
          位字母数字变量，需由短信服务商审核。变更签名、密钥、模板或域名后须重新验证。关闭不会补发历史发票。重新测试会暂时关闭发票通知。</span>
      </div>
      <div class="settings-security-note">
        <strong>发票短信文案参考</strong><span>{{ invoiceCopy }}<br /><small>当前参考文案 {{ invoiceCopy.length }} 个字符；变量实际内容及计费以渠道为准。</small></span>
      </div>
      <div class="settings-security-note">
        <strong>安全策略</strong>
        <span>AccessKey 使用 AES-256-GCM
          加密保存，浏览器只显示保存状态。每次修改和测试都会留下审计记录。</span>
      </div>
      <div v-if="configuration?.lastError" class="settings-inline-error">
        最近一次验证：{{ configuration.lastError }}
      </div>
      <SettingsFormActions
        v-if="canManage"
        :pending="pending"
        :disabled="testing"
        primary-label="保存短信配置"
      />
    </form>
  </section>
</template>

<style scoped>
.sms-test-panel {
  border-top: 0;
  border-bottom: 1px solid var(--line);
}

.sms-test-panel > .button {
  justify-self: start;
  width: auto;
}

.sms-test-fields {
  align-items: start;
}

.sms-test-context {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  color: var(--muted);
  font-size: var(--admin-font-caption);
  overflow-wrap: anywhere;
}

.sms-test-context p {
  flex-basis: 100%;
  margin: 0;
  line-height: 1.6;
}

.sms-test-context strong {
  color: var(--ink);
}

.sms-test-result {
  margin: 0;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  background: var(--surface);
  color: var(--ink);
  font-size: var(--admin-font-control);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.sms-test-result p {
  margin: 6px 0 0;
}

.sms-test-result strong {
  color: var(--green);
}

.sms-test-result.is-error,
.sms-test-result.is-error strong,
.sms-test-invalid {
  color: var(--red);
}

.sms-template-tools {
  display: grid;
  gap: 10px;
  justify-items: start;
  min-width: 0;
}

.sms-template-tools .button {
  white-space: nowrap;
}

#sms-account,
#sms-templates {
  scroll-margin-top: 96px;
}
</style>
