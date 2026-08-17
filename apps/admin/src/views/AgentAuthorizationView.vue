<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { conferenceApi, type AgentAuthorizationDetail } from '../lib/api';
import { agentApprovalHash } from '../lib/agent-approval';

const route = useRoute();
const authorization = ref<AgentAuthorizationDetail>();
const selectedScopes = ref<string[]>([]);
const approvalPolicy = ref<'controlled-and-critical' | 'critical-only'>('controlled-and-critical');
const password = ref('');
const pending = ref(false);
const errorMessage = ref('');
const message = ref('');
const enteredUserCode = ref(
  String(route.query.user_code ?? '')
    .trim()
    .toUpperCase(),
);
const authorizationId = computed(() =>
  authorization.value?.id
    ? authorization.value.id
    : typeof route.params.authorizationId === 'string'
      ? route.params.authorizationId
      : '',
);

async function resolveCode() {
  const userCode = enteredUserCode.value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u.test(userCode)) {
    errorMessage.value = '请输入设备端显示的 8 位授权码，例如 ABCD-2345。';
    return;
  }
  errorMessage.value = '';
  pending.value = true;
  try {
    authorization.value = await conferenceApi.resolveAgentAuthorization(userCode);
    selectedScopes.value = [...authorization.value.requestedScopes];
    enteredUserCode.value = userCode;
  } catch (error) {
    authorization.value = undefined;
    errorMessage.value = error instanceof Error ? error.message : '授权码核对失败';
  } finally {
    pending.value = false;
  }
}

async function load() {
  try {
    if (enteredUserCode.value) await resolveCode();
    else if (authorizationId.value) {
      authorization.value = await conferenceApi.getAgentAuthorization(authorizationId.value);
      selectedScopes.value = [...authorization.value.requestedScopes];
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '授权请求读取失败';
  }
}

async function approve() {
  const userCode = enteredUserCode.value.trim().toUpperCase();
  if (!password.value || !selectedScopes.value.length || !authorizationId.value || !userCode) {
    errorMessage.value = '请输入并核对设备授权码，选择权限，然后输入当前超级管理员密码。';
    return;
  }
  errorMessage.value = '';
  message.value = '';
  const requestHash = await agentApprovalHash({
    authorizationId: authorizationId.value,
    scopes: [...selectedScopes.value].sort(),
    approvalPolicy: approvalPolicy.value,
    userCode,
  });
  const currentPassword = password.value;
  password.value = '';
  pending.value = true;
  try {
    const stepUp = await conferenceApi.stepUp({
      password: currentPassword,
      purpose: 'agent-authorization',
      targetId: authorizationId.value,
      requestHash,
    });
    await conferenceApi.approveAgentAuthorization(authorizationId.value, {
      scopes: selectedScopes.value,
      approvalPolicy: approvalPolicy.value,
      userCode,
      requestHash,
      stepUpToken: stepUp.stepUpToken,
    });
    message.value = '连接已批准。Skill 可在设备授权有效期内领取令牌。';
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '连接批准失败';
  } finally {
    pending.value = false;
  }
}

async function deny() {
  if (!window.confirm('拒绝后，当前设备授权无法恢复。确定继续吗？')) return;
  pending.value = true;
  errorMessage.value = '';
  message.value = '';
  try {
    await conferenceApi.denyAgentAuthorization(authorizationId.value);
    message.value = '授权请求已拒绝。';
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '授权拒绝失败';
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="approval-page">
    <header class="settings-page-head">
      <div>
        <p class="eyebrow">SECURE DEVICE AUTHORIZATION</p>
        <p class="settings-page-title">批准 TokEMS AI 管理连接</p>
        <p>确认实例、客户端、密钥指纹、数据范围和审批策略。密码仅提交给当前 TokEMS 后台。</p>
      </div>
    </header>
    <p v-if="errorMessage" class="admin-error">{{ errorMessage }}</p>
    <p v-if="message" class="admin-success">{{ message }}</p>
    <section class="admin-panel authorization-code-card">
      <label class="approval-field">
        <span>设备授权码</span>
        <input
          v-model.trim="enteredUserCode"
          inputmode="text"
          autocomplete="one-time-code"
          maxlength="9"
          placeholder="ABCD-2345"
          :disabled="pending"
        />
      </label>
      <button
        class="button secondary compact"
        type="button"
        :disabled="pending"
        @click="resolveCode"
      >
        核对授权请求
      </button>
      <p>请逐字核对这里的授权码与发起连接的设备端一致。只批准由你本人刚刚发起并确认来源的连接。</p>
    </section>
    <section v-if="authorization" class="admin-panel approval-card">
      <dl>
        <div>
          <dt>设备授权码</dt>
          <dd class="mono-code authorization-code">{{ enteredUserCode }}</dd>
        </div>
        <div>
          <dt>实例</dt>
          <dd>{{ authorization.resource }}</dd>
        </div>
        <div>
          <dt>客户端</dt>
          <dd>{{ authorization.clientName }} · {{ authorization.clientId }}</dd>
        </div>
        <div>
          <dt>Skill 版本</dt>
          <dd>{{ authorization.skillVersion }}</dd>
        </div>
        <div>
          <dt>DPoP 指纹</dt>
          <dd class="mono-code">{{ authorization.dpopThumbprint }}</dd>
        </div>
        <div>
          <dt>状态与到期</dt>
          <dd>
            {{ authorization.status }} ·
            {{ new Date(authorization.expiresAt).toLocaleString('zh-CN') }}
          </dd>
        </div>
      </dl>
      <fieldset :disabled="authorization.status !== 'pending' || pending">
        <legend>允许的权限范围</legend>
        <label v-for="scope in authorization.requestedScopes" :key="scope" class="scope-option">
          <input v-model="selectedScopes" type="checkbox" :value="scope" />
          <span>{{ scope }}</span>
        </label>
      </fieldset>
      <label class="approval-field">
        <span>浏览器审批策略</span>
        <select v-model="approvalPolicy" :disabled="authorization.status !== 'pending' || pending">
          <option value="controlled-and-critical">受控与关键操作均需浏览器批准</option>
          <option value="critical-only">仅关键操作需浏览器批准</option>
        </select>
      </label>
      <label class="approval-field">
        <span>超级管理员密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          :disabled="authorization.status !== 'pending' || pending"
        />
      </label>
      <aside class="approval-notice">
        所选 AI 平台可能接收完成任务所需的最小数据。用户、订单和发票列表默认掩码；PII
        导出、退款、用户删除、管理员权限、集成密钥与关键文件继续要求单次关键审批。
      </aside>
      <div class="event-form-actions">
        <button
          class="button danger"
          type="button"
          :disabled="authorization.status !== 'pending' || pending"
          @click="deny"
        >
          拒绝
        </button>
        <button
          class="button"
          type="button"
          :disabled="authorization.status !== 'pending' || pending"
          @click="approve"
        >
          {{ pending ? '处理中…' : '确认并批准' }}
        </button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.approval-page {
  display: grid;
  gap: 20px;
}
.approval-card {
  max-width: 920px;
}
.authorization-code-card {
  display: grid;
  grid-template-columns: minmax(240px, 420px) auto;
  gap: 12px;
  align-items: end;
  max-width: 920px;
}
.authorization-code-card p {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
}
.authorization-code {
  color: var(--danger);
  font-size: 16px !important;
  letter-spacing: 0.14em;
}
.approval-card dl {
  display: grid;
  gap: 0;
  margin: 0 0 24px;
}
.approval-card dl div {
  display: grid;
  grid-template-columns: 150px 1fr;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.approval-card dt {
  color: var(--muted);
  font-size: 10px;
}
.approval-card dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.approval-card fieldset {
  display: grid;
  gap: 10px;
  margin: 18px 0;
  padding: 16px;
  border: 1px solid var(--line);
}
.scope-option {
  display: flex;
  gap: 10px;
  align-items: center;
}
.approval-field {
  display: grid;
  gap: 7px;
  margin-top: 16px;
  color: var(--muted);
  font-size: 10px;
}
.approval-field input,
.approval-field select {
  min-height: 42px;
  padding: 9px 11px;
  border: 1px solid var(--line);
}
.approval-notice {
  margin-top: 18px;
  padding: 14px;
  color: var(--muted);
  background: var(--paper);
  border: 1px solid var(--line);
  font-size: 11px;
  line-height: 1.7;
}
@media (max-width: 640px) {
  .authorization-code-card {
    grid-template-columns: 1fr;
  }
  .authorization-code-card p {
    grid-column: 1;
  }
}
</style>
