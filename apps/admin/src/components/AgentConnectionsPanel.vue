<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  conferenceApi,
  session,
  type AgentConnectionSummary,
  type AgentSecurityMetrics,
} from '../lib/api';
import { agentApprovalHash } from '../lib/agent-approval';

const connections = ref<AgentConnectionSummary[]>([]);
const metrics = ref<AgentSecurityMetrics>();
const pending = ref(false);
const errorMessage = ref('');
const message = ref('');
const password = ref('');

async function load() {
  errorMessage.value = '';
  try {
    [connections.value, metrics.value] = await Promise.all([
      conferenceApi.getAgentConnections(),
      conferenceApi.getAgentSecurityMetrics(),
    ]);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Agent 连接读取失败';
  }
}

async function revoke(connection: AgentConnectionSummary) {
  if (!window.confirm(`撤销“${connection.name}”后，远程 Skill 会立即失去访问权限。确定继续吗？`)) {
    return;
  }
  pending.value = true;
  try {
    await conferenceApi.revokeAgentConnection(connection.id);
    message.value = '连接已撤销。';
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '连接撤销失败';
  } finally {
    pending.value = false;
  }
}

async function updatePolicy(connection: AgentConnectionSummary) {
  if (!password.value) {
    errorMessage.value = '修改审批策略需要输入当前管理员密码。';
    return;
  }
  const approvalPolicy =
    connection.approvalPolicy === 'controlled-and-critical'
      ? 'critical-only'
      : 'controlled-and-critical';
  const requestHash = await agentApprovalHash({
    connectionId: connection.id,
    approvalPolicy,
  });
  const currentPassword = password.value;
  password.value = '';
  errorMessage.value = '';
  message.value = '';
  pending.value = true;
  try {
    const stepUp = await conferenceApi.stepUp({
      password: currentPassword,
      purpose: 'agent-policy',
      targetId: connection.id,
      requestHash,
    });
    await conferenceApi.updateAgentConnectionPolicy(connection.id, {
      approvalPolicy,
      requestHash,
      stepUpToken: stepUp.stepUpToken,
    });
    message.value = '审批策略已更新。';
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '审批策略更新失败';
  } finally {
    pending.value = false;
  }
}

async function revokeAll() {
  const organizationId = session.identity.value?.organization.id;
  if (!organizationId || !password.value) {
    errorMessage.value = '紧急撤销需要输入当前管理员密码。';
    return;
  }
  if (!window.confirm('这会立即撤销当前组织的全部 Agent 连接。确定继续吗？')) return;
  const requestHash = await agentApprovalHash({ organizationId, action: 'revoke-all' });
  const currentPassword = password.value;
  password.value = '';
  errorMessage.value = '';
  message.value = '';
  pending.value = true;
  try {
    const stepUp = await conferenceApi.stepUp({
      password: currentPassword,
      purpose: 'agent-revoke-all',
      targetId: organizationId,
      requestHash,
    });
    const result = await conferenceApi.revokeAllAgentConnections({
      requestHash,
      stepUpToken: stepUp.stepUpToken,
    });
    message.value = `已撤销 ${result.revoked} 个连接。`;
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '紧急撤销失败';
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="admin-panel agent-connections">
    <header class="admin-panel-header">
      <div>
        <p class="eyebrow">AGENT ACCESS</p>
        <h2>AI 管理连接</h2>
        <p>连接按组织、管理员凭据、权限范围和 DPoP 密钥绑定，可随时撤销。</p>
      </div>
      <button class="button secondary compact" type="button" :disabled="pending" @click="load">
        刷新
      </button>
    </header>

    <p v-if="errorMessage" class="admin-error">{{ errorMessage }}</p>
    <p v-if="message" class="admin-success">{{ message }}</p>

    <div v-if="metrics" class="agent-metrics-grid">
      <article>
        <span>活跃连接</span>
        <strong>{{ metrics.connections.active ?? 0 }}</strong>
      </article>
      <article>
        <span>待处理授权</span>
        <strong>{{ metrics.authorizations.pending ?? 0 }}</strong>
      </article>
      <article>
        <span>24 小时操作</span>
        <strong>{{
          Object.values(metrics.operations).reduce((sum, count) => sum + count, 0)
        }}</strong>
      </article>
      <article :class="{ alert: (metrics.operations.unknown ?? 0) > 0 }">
        <span>待核对结果</span>
        <strong>{{ metrics.operations.unknown ?? 0 }}</strong>
      </article>
    </div>

    <div v-if="metrics?.alerts.length" class="agent-alerts" role="status">
      <p v-for="alert in metrics.alerts" :key="alert.code">
        <strong>{{ alert.severity === 'critical' ? '关键告警' : '安全提醒' }}</strong>
        {{ alert.code }} · {{ alert.count }} 次
      </p>
    </div>

    <div class="agent-emergency-row">
      <label>
        <span>管理员密码（策略变更或紧急撤销）</span>
        <input v-model="password" type="password" autocomplete="current-password" />
      </label>
      <button class="button danger compact" type="button" :disabled="pending" @click="revokeAll">
        撤销全部连接
      </button>
    </div>

    <div class="data-table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>连接</th>
            <th>权限与策略</th>
            <th>有效期</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="connection in connections" :key="connection.id">
            <td>
              <span class="row-title">{{ connection.name }}</span>
              <span class="row-sub mono-code">{{ connection.clientId }} · {{ connection.id }}</span>
              <span class="row-sub">DPoP {{ connection.dpopThumbprint.slice(0, 16) }}…</span>
            </td>
            <td>
              <span class="row-title">{{ connection.scopes.join(' · ') }}</span>
              <span class="row-sub">{{ connection.approvalPolicy }}</span>
            </td>
            <td>
              <span class="row-title">{{
                new Date(connection.expiresAt).toLocaleDateString('zh-CN')
              }}</span>
              <span class="row-sub">最近使用：{{
                connection.lastUsedAt
                  ? new Date(connection.lastUsedAt).toLocaleString('zh-CN')
                  : '尚未使用'
              }}</span>
            </td>
            <td>
              <span
                class="status-badge"
                :class="connection.status === 'active' ? 'paid' : 'draft'"
              >{{ connection.status }}</span>
            </td>
            <td>
              <div v-if="connection.status === 'active'" class="table-actions">
                <button
                  class="button secondary compact"
                  type="button"
                  :disabled="pending"
                  @click="updatePolicy(connection)"
                >
                  切换审批策略
                </button>
                <button
                  class="button danger compact"
                  type="button"
                  :disabled="pending"
                  @click="revoke(connection)"
                >
                  撤销
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!connections.length" class="admin-empty">当前组织还没有 AI 管理连接。</div>
    </div>
  </section>
</template>

<style scoped>
.agent-connections {
  margin-top: 24px;
}
.agent-metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 18px 0;
}
.agent-metrics-grid article {
  display: grid;
  gap: 8px;
  padding: 14px;
  background: var(--paper);
  border: 1px solid var(--line);
}
.agent-metrics-grid article.alert {
  border-color: var(--danger);
}
.agent-metrics-grid span {
  color: var(--muted);
  font-size: 11px;
}
.agent-metrics-grid strong {
  font-family: var(--font-display);
  font-size: 24px;
}
.agent-alerts {
  display: grid;
  gap: 6px;
  margin: 0 0 18px;
  padding: 12px 14px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 7%, var(--paper));
  border: 1px solid color-mix(in srgb, var(--danger) 32%, var(--line));
}
.agent-alerts p {
  margin: 0;
}
.agent-emergency-row {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  margin: 18px 0;
  padding: 16px;
  background: var(--paper);
  border: 1px solid var(--line);
}
.agent-emergency-row label {
  display: grid;
  flex: 1;
  max-width: 420px;
  gap: 6px;
  color: var(--muted);
  font-size: 10px;
}
.agent-emergency-row input {
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid var(--line);
}
@media (max-width: 760px) {
  .agent-metrics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .agent-emergency-row {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
