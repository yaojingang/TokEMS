<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { conferenceApi, type AgentOperationDetail } from '../lib/api';

const route = useRoute();
const operationId = computed(() => String(route.params.operationId));
const operation = ref<AgentOperationDetail>();
const password = ref('');
const pending = ref(false);
const errorMessage = ref('');
const message = ref('');

async function load() {
  try {
    operation.value = await conferenceApi.getAgentOperation(operationId.value);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Agent 操作读取失败';
  }
}

async function approve() {
  if (!operation.value) return;
  errorMessage.value = '';
  message.value = '';
  const currentPassword = password.value;
  password.value = '';
  pending.value = true;
  try {
    let stepUpToken: string | undefined;
    if (operation.value.risk === 'critical') {
      if (!currentPassword) throw new Error('关键操作需要输入当前超级管理员密码。');
      const stepUp = await conferenceApi.stepUp({
        password: currentPassword,
        purpose: 'agent-critical-operation',
        targetId: operation.value.id,
        requestHash: operation.value.requestHash,
      });
      stepUpToken = stepUp.stepUpToken;
    }
    operation.value = await conferenceApi.approveAgentOperation(operation.value.id, {
      requestHash: operation.value.requestHash,
      beforeFingerprint: operation.value.beforeFingerprint,
      ...(stepUpToken ? { stepUpToken } : {}),
    });
    message.value = '操作已批准，Skill 必须在五分钟内使用同一请求摘要和服务端前态观测执行。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '操作批准失败';
  } finally {
    pending.value = false;
  }
}

async function deny() {
  if (!operation.value || !window.confirm('拒绝后，该 operation 无法执行。确定继续吗？')) return;
  pending.value = true;
  try {
    operation.value = await conferenceApi.denyAgentOperation(operation.value.id);
    message.value = '操作已拒绝。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '操作拒绝失败';
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
        <p class="eyebrow">BOUND OPERATION APPROVAL</p>
        <p class="settings-page-title">审核 AI 管理操作</p>
        <p>
          审批与 operation、动作、目标、请求摘要和服务端签发的前态观测绑定，超时后需要重新准备。
        </p>
      </div>
    </header>
    <p v-if="errorMessage" class="admin-error">{{ errorMessage }}</p>
    <p v-if="message" class="admin-success">{{ message }}</p>
    <section v-if="operation" class="admin-panel operation-card">
      <div class="operation-head">
        <span class="status-badge" :class="operation.risk === 'critical' ? 'issue' : 'pending'">{{
          operation.risk
        }}</span><span class="status-badge pending">{{ operation.status }}</span>
      </div>
      <h2>{{ operation.actionId }}</h2>
      <p>{{ operation.reason }}</p>
      <div class="operation-grid">
        <article>
          <h3>目标</h3>
          <pre>{{ JSON.stringify(operation.target, null, 2) }}</pre>
        </article>
        <article>
          <h3>脱敏差异</h3>
          <pre>{{ JSON.stringify(operation.redactedDiff, null, 2) }}</pre>
        </article>
        <article>
          <h3>影响摘要</h3>
          <pre>{{ JSON.stringify(operation.impactSummary, null, 2) }}</pre>
        </article>
      </div>
      <p class="row-sub mono-code">
        请求 {{ operation.requestHash.slice(0, 16) }}… · 服务端前态
        {{ operation.beforeFingerprint.slice(0, 16) }}… ·
        {{ new Date(operation.expiresAt).toLocaleString('zh-CN') }} 到期
      </p>
      <label v-if="operation.risk === 'critical'" class="operation-password"><span>超级管理员密码</span><input v-model="password" type="password" autocomplete="current-password" /></label>
      <div class="event-form-actions">
        <button
          class="button danger"
          type="button"
          :disabled="operation.status !== 'approval_required' || pending"
          @click="deny"
        >
          拒绝
        </button>
        <button
          class="button"
          type="button"
          :disabled="operation.status !== 'approval_required' || pending"
          @click="approve"
        >
          {{ pending ? '处理中…' : '批准单次执行' }}
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
.operation-card {
  display: grid;
  gap: 16px;
  max-width: 1080px;
}
.operation-head {
  display: flex;
  gap: 8px;
}
.operation-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.operation-grid article {
  min-width: 0;
  padding: 14px;
  background: var(--paper);
  border: 1px solid var(--line);
}
.operation-grid h3 {
  margin: 0 0 10px;
  font-size: 11px;
}
.operation-grid pre {
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 10px;
}
.operation-password {
  display: grid;
  gap: 7px;
  max-width: 440px;
  color: var(--muted);
  font-size: 10px;
}
.operation-password input {
  min-height: 42px;
  padding: 9px 11px;
  border: 1px solid var(--line);
}
@media (max-width: 860px) {
  .operation-grid {
    grid-template-columns: 1fr;
  }
}
</style>
