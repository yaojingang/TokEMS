<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { FeishuBotConfiguration } from '@conference/contracts';
import { conferenceApi, session } from '../../lib/api';
import { useSettingsFormScope } from '../../composables/settings-form-state';
import SaveStatus from '../SaveStatus.vue';
import SettingsFormActions from '../SettingsFormActions.vue';

const props = defineProps<{ configuration: FeishuBotConfiguration }>();
const emit = defineEmits<{ updated: [configuration: FeishuBotConfiguration] }>();
const canManage = computed(() => session.can('org.settings.manage'));
const scope = useSettingsFormScope();
const appId = ref('');
const secret = ref('');
const reveal = ref(false);
const editing = ref(false);
const pending = ref(false);
const error = ref('');
const message = ref('');
const acknowledge = ref(false);
const disableConfirmed = ref(false);
const errorElement = ref<HTMLElement>();
let alive = true;
let revealTimer: ReturnType<typeof setTimeout> | undefined;
const connected = computed(
  () => props.configuration.status === 'verified' && props.configuration.enabled,
);
const replacing = computed(
  () =>
    props.configuration.connectionVersion > 0 &&
    (appId.value.trim() !== props.configuration.appId ||
      Boolean(secret.value) ||
      !props.configuration.enabled),
);
const changed = computed(
  () => appId.value !== props.configuration.appId || Boolean(secret.value) || !connected.value,
);
const instructions =
  '请为 TokEMS 大会日报创建企业自建应用，启用机器人能力，开通 im:chat:read（读取机器人已加入的群）与 im:message:send_as_bot（发送日报）两项权限，创建版本并完成企业发布审批。请将机器人加入授权运营群，再由 TokEMS 管理员在后台填写应用凭证、选择群并试发。应用密钥请通过企业认可的安全方式交接。';
function reset() {
  appId.value = props.configuration.appId;
  secret.value = '';
  reveal.value = false;
  acknowledge.value = false;
  disableConfirmed.value = false;
  scope.clearDirty();
}
watch(
  () => props.configuration,
  () => {
    reset();
    if (connected.value) editing.value = false;
  },
  { immediate: true },
);
watch([appId, secret], () => {
  acknowledge.value = false;
  scope.setDirty(appId.value !== props.configuration.appId || Boolean(secret.value));
});
scope.setResetHandler(reset);
async function reportError(caught: unknown) {
  error.value = caught instanceof Error ? caught.message : '连接未完成，请稍后重试。';
  await nextTick();
  errorElement.value?.focus();
}
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    message.value = '已复制';
  } catch {
    error.value = '无法自动复制，请选中文本后复制。';
  }
}
function showSecret() {
  reveal.value = !reveal.value;
  if (revealTimer) clearTimeout(revealTimer);
  if (reveal.value)
    revealTimer = setTimeout(() => {
      reveal.value = false;
    }, 10_000);
}
async function save() {
  if (pending.value || !canManage.value || (replacing.value && !acknowledge.value)) return;
  pending.value = true;
  scope.setBusy(true);
  error.value = '';
  message.value = '';
  try {
    const updated = await conferenceApi.updateFeishuBotConfiguration({
      enabled: true,
      appId: appId.value.trim(),
      ...(secret.value ? { appSecret: secret.value.trim() } : {}),
      expectedConnectionVersion: props.configuration.connectionVersion,
    });
    if (!alive) return;
    reset();
    scope.clearDirty();
    emit('updated', updated);
    message.value = '应用连接成功，接下来选择接收群。';
    editing.value = false;
  } catch (caught) {
    if (alive) await reportError(caught);
  } finally {
    if (alive) {
      pending.value = false;
      scope.setBusy(false);
    }
  }
}
async function disableConnection() {
  if (pending.value || !canManage.value || !disableConfirmed.value) return;
  pending.value = true;
  error.value = '';
  try {
    const updated = await conferenceApi.updateFeishuBotConfiguration({
      enabled: false,
      appId: props.configuration.appId,
      expectedConnectionVersion: props.configuration.connectionVersion,
    });
    if (!alive) return;
    emit('updated', updated);
    message.value = '组织连接已暂停，相关大会的配置和发送记录已保留。';
  } catch (caught) {
    if (alive) await reportError(caught);
  } finally {
    if (alive) pending.value = false;
  }
}
async function verify() {
  if (pending.value || !canManage.value) return;
  pending.value = true;
  error.value = '';
  try {
    const result = await conferenceApi.verifyFeishuBot();
    const updated = await conferenceApi.getFeishuBotConfiguration();
    if (!alive) return;
    emit('updated', updated);
    if (!result.ok) await reportError(new Error(result.message));
    else message.value = result.message;
  } catch (caught) {
    if (alive) await reportError(caught);
  } finally {
    if (alive) pending.value = false;
  }
}
onBeforeUnmount(() => {
  alive = false;
  secret.value = '';
  if (revealTimer) clearTimeout(revealTimer);
});
</script>

<template>
  <section class="feishu-connect" aria-label="飞书应用连接">
    <div class="feishu-section-head">
      <div>
        <h3>{{ connected ? configuration.appName || '已连接飞书应用' : '连接飞书应用' }}</h3>
        <p>本组织所有大会共用此连接，各大会独立选择接收群。</p>
      </div>
      <button
        v-if="connected && canManage && !editing"
        class="button secondary"
        type="button"
        @click="editing = true"
      >
        管理连接
      </button>
    </div>
    <div v-if="connected && !editing" class="feishu-connection-summary">
      <span class="feishu-status success">✓ 应用已连接</span><span class="feishu-mono">{{ configuration.appId }}</span>
      <p>应用已连接。当前检查结果见下方，发送权限由群试发确认。</p>
    </div>
    <ul class="feishu-diagnostics" aria-label="连接检查结果">
      <li v-for="item in [{ key: 'credentials' as const, label: '应用凭据' }, { key: 'bot' as const, label: '机器人能力' }, { key: 'chats' as const, label: '群读取' }]" :key="item.key">
        <span>{{ item.label }}</span><strong>{{ configuration.diagnostics[item.key] === 'passed' ? '✓ 已通过' : configuration.diagnostics[item.key] === 'failed' ? '需要处理' : '待检查' }}</strong>
      </li>
      <li><span>发送权限</span><strong>由群试发验证</strong></li>
    </ul>
    <p v-if="configuration.lastError" class="feishu-notice" role="status">{{ configuration.lastError }}</p>
    <details v-if="connected && canManage && editing" class="feishu-help">
      <summary>暂停组织连接</summary>
      <p>
        将暂停
        {{
          configuration.affectedEvents.length
        }}
        场已配置大会的日报。恢复连接后，各大会需要重新试发并开启。已提交给飞书的消息仍可能到达。
      </p>
      <ul v-if="configuration.affectedEvents.length">
        <li v-for="event in configuration.affectedEvents" :key="event.eventId">
          {{ event.eventName }}
        </li>
      </ul>
      <label class="feishu-checkbox"><input
        v-model="disableConfirmed"
        type="checkbox"
      />我确认暂停本组织的飞书连接和相关日报。</label>
      <button
        class="button secondary"
        type="button"
        :disabled="pending || !disableConfirmed"
        @click="disableConnection"
      >
        暂停组织连接
      </button>
    </details>
    <p v-if="!canManage" class="feishu-hint">
      当前账号可以查看配置。连接应用、选择群和开启日报需要组织设置管理权限。
    </p>
    <form
      v-if="canManage && (!connected || editing)"
      data-settings-form
      class="feishu-connection-form"
      @submit.prevent="save"
    >
      <details class="feishu-help" :open="!configuration.secretsPresent.appSecret">
        <summary>还没有应用？按这四步完成配置</summary>
        <ol>
          <li>在飞书开放平台创建企业自建应用。</li>
          <li>在「应用能力」中启用机器人。</li>
          <li>开通下列两项权限。</li>
          <li>创建版本，提交企业管理员审核并发布生效。</li>
        </ol>
        <dl class="feishu-permissions">
          <div>
            <dt>
              <code>im:chat:read</code><button class="feishu-text-button" type="button" @click="copy('im:chat:read')">
                复制
              </button>
            </dt>
            <dd>读取机器人已加入的群，供你选择日报接收群。</dd>
          </div>
          <div>
            <dt>
              <code>im:message:send_as_bot</code><button
                class="feishu-text-button"
                type="button"
                @click="copy('im:message:send_as_bot')"
              >
                复制
              </button>
            </dt>
            <dd>以机器人身份向所选群发送日报。</dd>
          </div>
        </dl>
        <div class="feishu-actions">
          <a
            class="button secondary"
            href="https://open.feishu.cn/app"
            target="_blank"
            rel="noopener noreferrer"
          >前往飞书创建应用 ↗</a><button class="button secondary" type="button" @click="copy(instructions)">
            复制给管理员的配置说明
          </button>
        </div>
        <p>权限变更需要发布后生效。企业管理员尚未完成发布时，可稍后返回重新检查。</p>
      </details>
      <fieldset :disabled="pending">
        <legend>已有应用，填写应用凭证</legend>
        <label for="feishu-app-id">应用 App ID<input
          id="feishu-app-id"
          v-model="appId"
          name="feishu-app-id"
          autocomplete="off"
          required
          pattern="cli_[A-Za-z0-9]+"
          maxlength="128"
          aria-describedby="feishu-app-id-help"
        /></label>
        <p id="feishu-app-id-help" class="feishu-hint">
          以 cli_ 开头。在飞书应用的「凭证与基础信息」中获取。
        </p>
        <label for="feishu-app-secret">应用密钥 App Secret</label>
        <div class="feishu-secret-field">
          <input
            id="feishu-app-secret"
            v-model="secret"
            name="feishu-app-secret"
            :type="reveal ? 'text' : 'password'"
            autocomplete="new-password"
            :required="
              !configuration.secretsPresent.appSecret || appId.trim() !== configuration.appId
            "
            minlength="8"
            maxlength="512"
            aria-describedby="feishu-secret-help"
          /><button
            class="button secondary"
            type="button"
            :aria-pressed="reveal"
            @click="showSecret"
          >
            {{ reveal ? '隐藏' : '显示' }}
          </button>
        </div>
        <p id="feishu-secret-help" class="feishu-hint">
          {{
            configuration.secretsPresent.appSecret && appId.trim() === configuration.appId
              ? '密钥已保存。留空表示继续使用，填写新值将替换连接。'
              : '密钥加密保存在服务端。刷新或离开页面后，需要重新填写未保存的密钥。'
          }}
        </p>
      </fieldset>
      <details class="feishu-help">
        <summary>在哪里找到应用信息？</summary>
        <p>
          打开飞书开放平台，进入企业自建应用的「凭证与基础信息」，复制 App ID 与 App
          Secret。请使用同一应用的凭证，并完成机器人启用及版本发布。
        </p>
      </details>
      <div v-if="replacing" class="feishu-notice">
        <strong>替换连接将暂停相关大会日报</strong>
        <p>验证通过后替换；验证失败时保留当前连接。替换后，各大会需要重新试发并开启。</p>
        <ul v-if="configuration.affectedEvents.length">
          <li v-for="event in configuration.affectedEvents" :key="event.eventId">
            {{ event.eventName }} · {{ event.enabled ? '已开启' : '已暂停' }}
          </li>
        </ul>
        <p>当前关联 {{ configuration.affectedEvents.length }} 场大会。</p>
        <label class="feishu-checkbox"><input
          v-model="acknowledge"
          type="checkbox"
        />我确认替换组织连接，并暂停相关日报。</label>
      </div>
      <p v-if="pending" role="status">正在检查应用凭据、机器人能力和完整群列表，请稍候。</p>
      <SettingsFormActions
        v-if="scope.dirty.value"
        :pending="pending"
        :disabled="replacing && !acknowledge"
        :primary-label="replacing ? '替换连接并暂停相关日报' : '验证并连接'"
        pending-label="正在验证连接"
        impact-text="验证通过后保存连接，此操作不会向群发送消息。"
      />
      <div v-else class="feishu-actions">
        <button
          class="button"
          type="submit"
          :disabled="pending || !changed || (replacing && !acknowledge)"
        >
          {{
            pending ? '正在验证连接' : replacing ? '替换连接并暂停相关日报' : '验证并连接'
          }}
        </button><button
          v-if="editing"
          class="button secondary"
          type="button"
          :disabled="pending"
          @click="
            reset();
            editing = false;
          "
        >
          取消
        </button>
      </div>
      <p class="feishu-hint">验证通过后保存连接；此操作不会向群发送消息。</p>
    </form>
    <button
      v-if="configuration.secretsPresent.appSecret && canManage && !editing"
      class="feishu-text-button"
      type="button"
      :disabled="pending"
      @click="verify"
    >
      {{ pending ? '检查中' : '重新检查连接' }}
    </button>
    <p v-if="error" ref="errorElement" class="feishu-error" role="alert" tabindex="-1">
      {{ error }}
    </p>
    <SaveStatus :message="message" />
  </section>
</template>
