<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { AliyunSmsConfiguration, AliyunSmsTemplateKey } from '@conference/contracts';
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
    name: '电子发票已开具',
    description: '发票开具完成后发送下载入口',
    variables: ['eventName', 'expiresAt', 'url'],
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
const message = ref('');
const errorMessage = ref('');
const testPhone = ref('');
const testTemplateKey = ref<AliyunSmsTemplateKey>('customerOtp');
const testConfirmed = ref(false);
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
const canSendTest = computed(
  () =>
    canManage.value &&
    loaded.value &&
    configuration.value?.status !== 'unconfigured' &&
    Boolean(testPhone.value.trim()) &&
    form.templates[testTemplateKey.value].enabled &&
    !hasUnsavedChanges.value &&
    testConfirmed.value &&
    !pending.value &&
    !testing.value,
);

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
  if (firstEnabled) testTemplateKey.value = firstEnabled.key;
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
  loading.value = true;
  loaded.value = false;
  message.value = '';
  errorMessage.value = '';
  try {
    applyConfiguration(await conferenceApi.getAliyunSmsConfiguration());
    loaded.value = true;
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
  message.value = '';
  errorMessage.value = '';
  try {
    const result = await conferenceApi.testAliyunSmsConfiguration({
      phoneNumber: testPhone.value.trim(),
      templateKey: testTemplateKey.value,
    });
    applyConfiguration(await conferenceApi.getAliyunSmsConfiguration());
    testConfirmed.value = false;
    if (result.ok) {
      message.value = `${result.message} 受理编号：${result.bizId || '阿里云未返回编号'}`;
    } else {
      errorMessage.value = result.message;
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '测试短信发送失败';
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

      <section class="settings-form-section" aria-labelledby="sms-account-heading">
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

      <section class="settings-form-section" aria-labelledby="sms-template-heading">
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
                    :disabled="!canManage"
                  />
                  <span>
                    <strong>{{ row.name }}</strong>
                    <small>{{ row.description }}</small>
                    <small
                      v-if="form.templates[row.key].enabled"
                      class="sms-template-validation"
                      :class="`is-${form.templates[row.key].status ?? 'unverified'}`"
                    >
                      {{
                        form.templates[row.key].status === 'verified'
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
                <div class="sms-variable-list" aria-label="模板变量">
                  <code v-for="variable in row.variables" :key="variable">{{ variable }}</code>
                </div>
              </article>
            </div>
          </section>
        </div>
      </section>

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

    <section class="sms-test-panel" aria-labelledby="sms-test-heading">
      <div class="settings-form-section-head">
        <div>
          <h3 id="sms-test-heading">发送测试短信</h3>
          <p>该操作会调用阿里云正式接口，产生一条真实短信和相应费用。</p>
        </div>
      </div>
      <p v-if="hasUnsavedChanges" class="settings-inline-warning" role="status">
        当前有未保存修改，请先保存配置再发送测试短信。
      </p>
      <div class="sms-test-fields">
        <div class="form-field">
          <label for="sms-test-phone">接收手机号</label>
          <input
            id="sms-test-phone"
            v-model="testPhone"
            inputmode="tel"
            autocomplete="tel"
            placeholder="13800138000"
            :disabled="!canManage || testing"
          />
        </div>
        <div class="form-field">
          <label for="sms-test-template">测试场景</label>
          <select
            id="sms-test-template"
            v-model="testTemplateKey"
            :disabled="!canManage || testing"
          >
            <option
              v-for="row in templateRows"
              :key="row.key"
              :value="row.key"
              :disabled="!form.templates[row.key].enabled"
            >
              {{ row.name }}{{ form.templates[row.key].enabled ? '' : '（未启用）' }}
            </option>
          </select>
        </div>
      </div>
      <label class="sms-test-confirm">
        <input v-model="testConfirmed" type="checkbox" :disabled="!canManage || testing" />
        <span>我确认将向上述手机号发送真实短信，并可能产生费用。</span>
      </label>
      <button class="button secondary" type="button" :disabled="!canSendTest" @click="sendTest">
        {{ testing ? '发送中…' : '发送并验证' }}
      </button>
    </section>
  </section>
</template>
