<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import type {
  ConferenceTemplateSummary,
  ConferenceTemplateVersion,
  HtmlTemplateBinding,
  HtmlTemplateBindingManifest,
  HtmlTemplateBindingProposal,
  HtmlTemplateVariablePath,
} from '@conference/contracts';
import {
  conferenceApi,
  session,
  type HtmlTemplateDocumentDetail,
  type HtmlTemplateVariableCatalog,
} from '../lib/api';

type BindingOperation = 'text' | 'attribute' | 'conditional';
type VariableFormat =
  'plain' | 'date-long' | 'date-short' | 'time' | 'datetime' | 'currency' | 'integer' | 'decimal';

const route = useRoute();
const router = useRouter();
const templateId = computed(() => String(route.params.templateId));
const loading = ref(true);
const pending = ref(false);
const errorMessage = ref('');
const message = ref('');
const detail = ref<HtmlTemplateDocumentDetail>();
const summary = ref<ConferenceTemplateSummary>();
const versions = ref<ConferenceTemplateVersion[]>([]);
const catalog = ref<HtmlTemplateVariableCatalog>();
const manifest = ref<HtmlTemplateBindingManifest>({ version: 1, bindings: [] });
const selectedNodeId = ref('');
const nodeQuery = ref('');
const operation = ref<BindingOperation>('text');
const selectedVariable = ref<HtmlTemplateVariablePath>('event.name');
const selectedFormat = ref<VariableFormat>('plain');
const missingPolicy = ref<'empty' | 'fallback' | 'hide' | 'error'>('fallback');
const previewUrl = ref('');
const previewMode = ref<'desktop' | 'tablet' | 'mobile'>('desktop');
const previewFrame = ref<HTMLIFrameElement>();
const previewChannelId = ref('');
const aiProposals = ref<HtmlTemplateBindingProposal[]>([]);
const selectedAiProposalIds = ref<string[]>([]);
const aiPanelOpen = ref(false);
const activeAiRunId = ref('');
const aiRunStatus = ref('idle');
const publishPanelOpen = ref(false);
const changeSummary = ref('');
const metadataOpen = ref(false);
const metadata = ref({ name: '', description: '', tags: '' });

const canManage = computed(() => session.can('org.template.manage'));
const canPublish = computed(() => session.can('org.template.publish'));
const canUseAi = computed(() => session.can('org.template.ai.generate'));
const aiAvailable = computed(
  () => canUseAi.value && catalog.value?.ai.enabled && catalog.value.ai.configured,
);
const nodes = computed(() => detail.value?.nodeManifest ?? []);
const filteredNodes = computed(() => {
  const query = nodeQuery.value.trim().toLocaleLowerCase('zh-CN');
  if (!query) return nodes.value;
  return nodes.value.filter((node) =>
    [node.id, node.tagName, node.text, ...Object.values(node.attributes)].some((value) =>
      value.toLocaleLowerCase('zh-CN').includes(query),
    ),
  );
});
const selectedNode = computed(() => nodes.value.find((node) => node.id === selectedNodeId.value));
const nodeBindings = computed(() =>
  manifest.value.bindings.filter((binding) => binding.nodeId === selectedNodeId.value),
);
const boundNodeIds = computed(
  () => new Set(manifest.value.bindings.map((binding) => binding.nodeId)),
);
const variableGroups = computed(() => {
  const groups = new Map<string, NonNullable<typeof catalog.value>['variables']>();
  for (const variable of catalog.value?.variables ?? []) {
    const values = groups.get(variable.category) ?? [];
    values.push(variable);
    groups.set(variable.category, values);
  }
  return [...groups.entries()];
});
const selectedCatalogVariable = computed(() =>
  catalog.value?.variables.find((item) => item.path === selectedVariable.value),
);
const routeVariables = computed(
  () => catalog.value?.variables.filter((item) => item.path.startsWith('routes.')) ?? [],
);
const previewWidth = computed(
  () => ({ desktop: '100%', tablet: '820px', mobile: '390px' })[previewMode.value],
);
const securityWarnings = computed(() => detail.value?.securityReport.warnings ?? []);
const aiRunning = computed(() => ['queued', 'running'].includes(aiRunStatus.value));
const bindingsDirty = computed(
  () => JSON.stringify(manifest.value) !== JSON.stringify(detail.value?.bindings ?? manifest.value),
);
let disposed = false;

function bindingLabel(binding: HtmlTemplateBinding) {
  if (binding.kind === 'text') {
    return binding.segments
      .filter((segment) => segment.kind === 'variable')
      .map((segment) => (segment.kind === 'variable' ? segment.path : ''))
      .filter(Boolean)
      .join(' + ');
  }
  if (binding.kind === 'attribute' || binding.kind === 'conditional') {
    return binding.variablePath;
  }
  return binding.collectionPath;
}

function operationLabel(binding: HtmlTemplateBinding) {
  return {
    text: '文本',
    attribute: '链接',
    conditional: '显隐',
    repeat: '重复列表',
  }[binding.kind];
}

function selectNode(nodeId: string) {
  selectedNodeId.value = nodeId;
  const node = nodes.value.find((item) => item.id === nodeId);
  operation.value = node?.tagName === 'a' ? 'attribute' : 'text';
  if (operation.value === 'attribute') {
    selectedVariable.value = 'routes.registration';
    missingPolicy.value = 'error';
  } else {
    selectedVariable.value = 'event.name';
    missingPolicy.value = 'fallback';
  }
  highlightPreviewNode();
}

function highlightPreviewNode() {
  previewFrame.value?.contentWindow?.postMessage(
    {
      type: 'tok-template-highlight',
      channelId: previewChannelId.value,
      nodeId: selectedNodeId.value,
    },
    '*',
  );
}

function onPreviewLoad() {
  highlightPreviewNode();
}

function onPreviewMessage(event: MessageEvent) {
  if (
    event.source !== previewFrame.value?.contentWindow ||
    !event.data ||
    event.data.type !== 'tok-template-node-selected' ||
    event.data.channelId !== previewChannelId.value ||
    typeof event.data.nodeId !== 'string'
  ) {
    return;
  }
  selectNode(event.data.nodeId);
}

async function load(options: { preserveSelection?: boolean } = {}) {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [template, document, variables, aiRuns] = await Promise.all([
      conferenceApi.getConferenceTemplate(templateId.value),
      conferenceApi.getHtmlTemplateDocument(templateId.value),
      conferenceApi.getHtmlTemplateVariableCatalog(),
      conferenceApi.getHtmlTemplateAiRuns(templateId.value),
    ]);
    summary.value = template.summary;
    versions.value = template.versions;
    detail.value = document;
    catalog.value = variables;
    manifest.value = structuredClone(document.bindings);
    metadata.value = {
      name: template.summary.name,
      description: template.summary.description,
      tags: template.summary.tags.join('、'),
    };
    const latestAiRun = aiRuns[0];
    if (latestAiRun && ['queued', 'running', 'review_ready'].includes(latestAiRun.status)) {
      activeAiRunId.value = latestAiRun.id;
      aiRunStatus.value = latestAiRun.status;
      aiProposals.value = latestAiRun.output?.proposals ?? [];
      selectedAiProposalIds.value = aiProposals.value
        .filter((proposal) => proposal.confidence >= 0.8)
        .map((proposal) => proposal.proposalId);
      if (['queued', 'running'].includes(latestAiRun.status)) {
        void waitForAiRun(latestAiRun.id);
      }
    }
    if (
      !options.preserveSelection ||
      !nodes.value.some((node) => node.id === selectedNodeId.value)
    ) {
      selectedNodeId.value =
        nodes.value.find((node) => node.bindable)?.id ?? nodes.value[0]?.id ?? '';
    }
    await refreshPreview();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'HTML 模板读取失败';
  } finally {
    loading.value = false;
  }
}

async function refreshPreview() {
  try {
    const preview = await conferenceApi.createHtmlTemplatePreview(templateId.value);
    previewChannelId.value = preview.channelId;
    previewUrl.value = `${preview.previewUrl}${preview.previewUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
    await nextTick();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预览生成失败';
  }
}

function addBinding() {
  const node = selectedNode.value;
  if (!node || !canManage.value) return;
  const id = `manual-${crypto.randomUUID().slice(0, 12)}`;
  let binding: HtmlTemplateBinding;
  if (operation.value === 'attribute') {
    const variable = selectedVariable.value;
    if (
      !['routes.registration', 'routes.cooperation', 'routes.faq', 'routes.account'].includes(
        variable,
      )
    ) {
      errorMessage.value = '链接绑定请选择报名、合作申请、FAQ 或个人中心路由。';
      return;
    }
    binding = {
      id,
      kind: 'attribute',
      nodeId: node.id,
      attributeName: 'href',
      variablePath: variable as
        'routes.registration' | 'routes.cooperation' | 'routes.faq' | 'routes.account',
      missingPolicy: 'error',
    };
  } else if (operation.value === 'conditional') {
    binding = {
      id,
      kind: 'conditional',
      nodeId: node.id,
      variablePath: selectedVariable.value,
      truthyWhen: 'present',
      missingPolicy: 'hide',
    };
  } else {
    binding = {
      id,
      kind: 'text',
      nodeId: node.id,
      missingPolicy:
        missingPolicy.value === 'error' || missingPolicy.value === 'hide'
          ? 'fallback'
          : missingPolicy.value,
      segments: [
        {
          kind: 'variable',
          path: selectedVariable.value,
          format: selectedFormat.value,
          ...(missingPolicy.value === 'fallback' && node.text
            ? { fallback: node.text.slice(0, 500) }
            : {}),
        },
      ],
    };
  }
  const target = `${binding.nodeId}:${binding.kind === 'attribute' ? 'attribute' : binding.kind}`;
  manifest.value.bindings = manifest.value.bindings.filter(
    (item) => `${item.nodeId}:${item.kind === 'attribute' ? 'attribute' : item.kind}` !== target,
  );
  manifest.value.bindings.push(binding);
  message.value = '变量已加入本地草稿，保存后更新预览。';
  errorMessage.value = '';
}

function removeBinding(bindingId: string) {
  manifest.value.bindings = manifest.value.bindings.filter((binding) => binding.id !== bindingId);
}

async function saveBindings() {
  if (!detail.value || !canManage.value) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const saved = await conferenceApi.saveHtmlTemplateBindings(
      templateId.value,
      detail.value.revision,
      manifest.value,
    );
    detail.value.revision = saved.revision;
    detail.value.bindings = saved.bindings;
    detail.value.bindingDigest = saved.bindingDigest;
    manifest.value = structuredClone(saved.bindings);
    message.value = `已保存 ${saved.bindings.bindings.length} 条变量绑定。`;
    await refreshPreview();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '变量保存失败';
  } finally {
    pending.value = false;
  }
}

async function generateAiSuggestions() {
  if (!canUseAi.value) return;
  pending.value = true;
  errorMessage.value = '';
  message.value = 'AI 正在分析页面节点与大会变量。';
  try {
    const run = await conferenceApi.createHtmlTemplateAiRun(templateId.value);
    activeAiRunId.value = run.id;
    aiRunStatus.value = run.status;
    if (run.status === 'review_ready') {
      showAiProposals(run.output?.proposals ?? []);
    } else {
      pending.value = false;
      await waitForAiRun(run.id);
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'AI 变量识别失败';
  } finally {
    pending.value = false;
  }
}

function showAiProposals(proposals: HtmlTemplateBindingProposal[]) {
  aiProposals.value = proposals;
  selectedAiProposalIds.value = proposals
    .filter((proposal) => proposal.confidence >= 0.8)
    .map((proposal) => proposal.proposalId);
  aiPanelOpen.value = true;
  aiRunStatus.value = 'review_ready';
  message.value = `AI 已生成 ${proposals.length} 条建议，请审核后应用。`;
}

async function waitForAiRun(runId: string) {
  aiRunStatus.value = aiRunStatus.value === 'idle' ? 'queued' : aiRunStatus.value;
  for (let attempt = 0; attempt < 50 && !disposed; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    if (disposed || activeAiRunId.value !== runId) return;
    try {
      const runs = await conferenceApi.getHtmlTemplateAiRuns(templateId.value);
      const run = runs.find((item) => item.id === runId);
      if (!run) throw new Error('AI 识别任务不存在');
      aiRunStatus.value = run.status;
      if (run.status === 'review_ready') {
        showAiProposals(run.output?.proposals ?? []);
        return;
      }
      if (run.status === 'failed') {
        throw new Error(run.errorMessage ?? 'AI 变量识别失败，当前草稿保持不变');
      }
      if (['cancelled', 'rejected', 'superseded'].includes(run.status)) return;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : 'AI 识别状态读取失败';
      aiRunStatus.value = 'failed';
      return;
    }
  }
  if (!disposed && aiRunStatus.value !== 'review_ready') {
    errorMessage.value = 'AI 识别仍在后台运行，可以稍后回到编辑器查看结果。';
  }
}

async function cancelAiSuggestions() {
  if (!activeAiRunId.value) return;
  try {
    await conferenceApi.cancelHtmlTemplateAiRun(templateId.value, activeAiRunId.value);
    aiRunStatus.value = 'cancelled';
    message.value = 'AI 识别任务已取消。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'AI 任务取消失败';
  }
}

async function rejectAiSuggestions() {
  if (!activeAiRunId.value) return;
  pending.value = true;
  try {
    await conferenceApi.rejectHtmlTemplateAiRun(templateId.value, activeAiRunId.value);
    aiPanelOpen.value = false;
    aiRunStatus.value = 'rejected';
    aiProposals.value = [];
    message.value = '本轮 AI 建议已全部拒绝并记录。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'AI 建议拒绝失败';
  } finally {
    pending.value = false;
  }
}

async function applyAiSuggestions() {
  if (!aiProposals.value.length || !selectedAiProposalIds.value.length) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    if (!activeAiRunId.value || aiRunStatus.value !== 'review_ready') {
      throw new Error('AI 建议已过期，请重新识别。');
    }
    await conferenceApi.applyHtmlTemplateAiProposals(
      templateId.value,
      activeAiRunId.value,
      selectedAiProposalIds.value,
    );
    aiPanelOpen.value = false;
    aiRunStatus.value = 'completed';
    aiProposals.value = [];
    message.value = `已应用 ${selectedAiProposalIds.value.length} 条 AI 建议。`;
    await load({ preserveSelection: true });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'AI 建议应用失败';
  } finally {
    pending.value = false;
  }
}

async function saveMetadata() {
  if (!detail.value) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const updated = (await conferenceApi.updateConferenceTemplate(templateId.value, {
      name: metadata.value.name.trim(),
      description: metadata.value.description.trim(),
      tags: metadata.value.tags
        .split(/、|,|，/u)
        .map((item) => item.trim())
        .filter(Boolean),
      revision: detail.value.revision,
    })) as { summary: ConferenceTemplateSummary; draft: { revision: number } };
    summary.value = updated.summary;
    detail.value.revision = updated.draft.revision;
    metadataOpen.value = false;
    message.value = '模板资料已保存。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '模板资料保存失败';
  } finally {
    pending.value = false;
  }
}

async function openPublishPanel() {
  if (bindingsDirty.value) {
    await saveBindings();
    if (bindingsDirty.value || errorMessage.value) return;
  }
  publishPanelOpen.value = true;
}

async function publish() {
  if (!detail.value || !changeSummary.value.trim()) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const version = await conferenceApi.publishConferenceTemplate(
      templateId.value,
      detail.value.revision,
      changeSummary.value.trim(),
    );
    versions.value.unshift(version);
    if (summary.value) summary.value.status = 'published';
    publishPanelOpen.value = false;
    changeSummary.value = '';
    message.value = `${summary.value?.name ?? '模板'} V${version.version} 已发布。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '模板发布失败';
  } finally {
    pending.value = false;
  }
}

watch(operation, (value) => {
  if (value === 'attribute') {
    selectedVariable.value = 'routes.registration';
    missingPolicy.value = 'error';
  }
});

watch(selectedVariable, () => {
  const formats = selectedCatalogVariable.value?.formats as VariableFormat[] | undefined;
  if (formats?.length && !formats.includes(selectedFormat.value)) {
    selectedFormat.value = formats[0] ?? 'plain';
  }
});

onMounted(() => {
  window.addEventListener('message', onPreviewMessage);
  void load();
});
onBeforeUnmount(() => window.removeEventListener('message', onPreviewMessage));
onBeforeUnmount(() => {
  disposed = true;
});
onBeforeRouteLeave(() =>
  bindingsDirty.value ? window.confirm('变量绑定尚未保存，确认离开编辑器吗？') : true,
);
</script>

<template>
  <div class="template-editor-toolbar html-editor-toolbar">
    <div>
      <button
        class="button secondary compact"
        type="button"
        @click="router.push({ name: 'manage-templates' })"
      >
        返回列表
      </button>
      <span>
        <small>HTML TEMPLATE WORKBENCH</small>
        <strong>{{ summary?.name ?? 'HTML 模板' }}</strong>
      </span>
      <span v-if="summary" class="status-badge" :class="summary.status">
        {{
          summary.status === 'published'
            ? '已发布'
            : summary.status === 'archived'
              ? '已归档'
              : '草稿'
        }}
      </span>
    </div>
    <div class="template-save-tools">
      <span class="save-state" :class="{ saving: bindingsDirty }">
        {{ bindingsDirty ? '有未保存变量' : `草稿 R${detail?.revision ?? 0}` }}
      </span>
      <button
        v-if="canManage"
        class="button secondary compact"
        type="button"
        @click="metadataOpen = true"
      >
        模板资料
      </button>
      <button
        v-if="canManage"
        class="button secondary compact"
        type="button"
        @click="router.push({ name: 'manage-template-create', query: { replace: templateId } })"
      >
        替换 HTML
      </button>
      <button
        v-if="canManage"
        class="button secondary compact"
        type="button"
        :disabled="pending || !bindingsDirty"
        @click="saveBindings"
      >
        保存变量
      </button>
      <button
        v-if="canPublish"
        class="button compact"
        type="button"
        :disabled="pending"
        @click="openPublishPanel"
      >
        发布版本
      </button>
    </div>
  </div>

  <p v-if="message" class="admin-success" role="status">{{ message }}</p>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <div v-if="loading" class="admin-loading">正在装载 HTML 模板工作台…</div>

  <main v-else-if="detail" class="html-template-editor-layout">
    <aside class="html-node-browser">
      <header>
        <p class="eyebrow">PAGE NODES</p>
        <h2>页面节点</h2>
        <span>{{ boundNodeIds.size }} / {{ nodes.length }} 已绑定</span>
      </header>
      <label class="admin-search compact-search">
        <span aria-hidden="true">⌕</span>
        <input v-model="nodeQuery" type="search" placeholder="搜索文案、标签或节点" />
      </label>
      <div class="html-node-list">
        <button
          v-for="node in filteredNodes"
          :key="node.id"
          type="button"
          :class="{ active: node.id === selectedNodeId, bound: boundNodeIds.has(node.id) }"
          @click="selectNode(node.id)"
        >
          <span class="node-tag">{{ node.tagName }}</span>
          <strong>{{ node.text || node.attributes.href || '无可见文案' }}</strong>
          <small>{{ node.id }}</small>
          <i v-if="boundNodeIds.has(node.id)" aria-label="已绑定">✓</i>
        </button>
      </div>
    </aside>

    <section class="html-live-preview">
      <header>
        <div>
          <p class="eyebrow">SAFE PREVIEW</p>
          <h2>动态预览</h2>
          <span>点击页面元素可以定位左侧节点</span>
        </div>
        <div class="preview-device-switch" aria-label="预览宽度">
          <button
            v-for="mode in ['desktop', 'tablet', 'mobile'] as const"
            :key="mode"
            type="button"
            :class="{ active: previewMode === mode }"
            @click="previewMode = mode"
          >
            {{ { desktop: '桌面', tablet: '平板', mobile: '手机' }[mode] }}
          </button>
        </div>
      </header>
      <div class="html-preview-stage">
        <iframe
          v-if="previewUrl"
          ref="previewFrame"
          :key="previewUrl"
          :src="previewUrl"
          :style="{ width: previewWidth }"
          title="HTML 模板安全预览"
          sandbox="allow-scripts"
          @load="onPreviewLoad"
        />
      </div>
      <footer>
        <span>{{ detail.originalFilename }} · {{ (detail.sourceSize / 1024).toFixed(1) }} KiB</span>
        <button class="text-button" type="button" @click="refreshPreview">刷新预览</button>
      </footer>
    </section>

    <aside class="html-binding-panel">
      <header>
        <p class="eyebrow">VARIABLE BINDING</p>
        <h2>变量设计</h2>
        <span v-if="selectedNode">{{ selectedNode.id }} · &lt;{{ selectedNode.tagName }}&gt;</span>
      </header>

      <div v-if="selectedNode" class="binding-inspector">
        <div class="selected-node-sample">
          <small>当前内容</small>
          <p>{{ selectedNode.text || selectedNode.attributes.href || '此节点没有可见文本' }}</p>
        </div>

        <section v-if="nodeBindings.length" class="existing-bindings">
          <h3>已设置变量</h3>
          <article v-for="binding in nodeBindings" :key="binding.id">
            <span>{{ operationLabel(binding) }}</span>
            <code>{{ bindingLabel(binding) }}</code>
            <button
              v-if="canManage"
              type="button"
              aria-label="移除变量绑定"
              @click="removeBinding(binding.id)"
            >
              ×
            </button>
          </article>
        </section>

        <section v-if="canManage" class="binding-builder">
          <h3>{{ nodeBindings.length ? '添加或替换绑定' : '创建变量绑定' }}</h3>
          <div class="binding-operation-tabs">
            <button
              v-for="item in [
                { value: 'text', label: '替换文本' },
                { value: 'attribute', label: '绑定链接' },
                { value: 'conditional', label: '控制显隐' },
              ] as const"
              :key="item.value"
              type="button"
              :disabled="item.value === 'attribute' && selectedNode.tagName !== 'a'"
              :class="{ active: operation === item.value }"
              @click="operation = item.value"
            >
              {{ item.label }}
            </button>
          </div>

          <label class="form-field">
            <span>大会变量</span>
            <select v-model="selectedVariable">
              <template v-if="operation === 'attribute'">
                <option
                  v-for="variable in routeVariables"
                  :key="variable.path"
                  :value="variable.path"
                >
                  {{ variable.label }} · {{ variable.path }}
                </option>
              </template>
              <template v-else>
                <optgroup
                  v-for="[category, variables] in variableGroups"
                  :key="category"
                  :label="category"
                >
                  <option v-for="variable in variables" :key="variable.path" :value="variable.path">
                    {{ variable.label }} · {{ variable.path }}
                  </option>
                </optgroup>
              </template>
            </select>
            <small>{{ selectedCatalogVariable?.description }}</small>
          </label>

          <div v-if="operation === 'text'" class="binding-builder-grid">
            <label class="form-field">
              <span>显示格式</span>
              <select v-model="selectedFormat">
                <option
                  v-for="format in selectedCatalogVariable?.formats ?? ['plain']"
                  :key="format"
                  :value="format"
                >
                  {{ format }}
                </option>
              </select>
            </label>
            <label class="form-field">
              <span>缺省策略</span>
              <select v-model="missingPolicy">
                <option value="fallback">保留原文</option>
                <option value="empty">显示为空</option>
              </select>
            </label>
          </div>

          <button class="button full-button" type="button" @click="addBinding">
            应用到本地草稿
          </button>
        </section>

        <section class="ai-mapping-card">
          <span aria-hidden="true">AI</span>
          <div>
            <strong>智能识别整页变量</strong>
            <p>
              AI 只接收已清理节点和变量目录，所有建议都需要人工确认。
              <template v-if="catalog?.ai.configured">
                当前模型：{{ catalog.ai.model }}。
              </template>
            </p>
          </div>
          <button
            v-if="aiAvailable && !aiRunning && !aiProposals.length"
            class="button secondary compact"
            type="button"
            :disabled="pending"
            @click="generateAiSuggestions"
          >
            {{ pending ? '识别中…' : '开始识别' }}
          </button>
          <button
            v-else-if="aiAvailable && aiRunning"
            class="button secondary compact"
            type="button"
            @click="cancelAiSuggestions"
          >
            取消识别
          </button>
          <button
            v-else-if="aiAvailable && aiProposals.length"
            class="button secondary compact"
            type="button"
            @click="aiPanelOpen = true"
          >
            查看 {{ aiProposals.length }} 条建议
          </button>
          <small v-else>
            {{
              canUseAi ? 'AI 服务未配置，可继续使用规则建议和手工绑定' : '当前角色没有 AI 识别权限'
            }}
          </small>
        </section>

        <details class="security-summary">
          <summary>安全与编译信息</summary>
          <dl>
            <div>
              <dt>编译器</dt>
              <dd>V{{ detail.compilerVersion }}</dd>
            </div>
            <div>
              <dt>变量数</dt>
              <dd>{{ manifest.bindings.length }}</dd>
            </div>
            <div>
              <dt>扫描提醒</dt>
              <dd>{{ securityWarnings.length }}</dd>
            </div>
          </dl>
          <p v-for="warning in securityWarnings" :key="warning">{{ warning }}</p>
        </details>
      </div>
      <div v-else class="admin-empty">从左侧选择一个页面节点。</div>
    </aside>
  </main>

  <div v-if="metadataOpen" class="admin-modal-backdrop" @click.self="metadataOpen = false">
    <section
      class="admin-panel html-editor-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="metadata-title"
    >
      <header>
        <div>
          <p class="eyebrow">TEMPLATE PROFILE</p>
          <h2 id="metadata-title">模板资料</h2>
        </div>
        <button type="button" aria-label="关闭" @click="metadataOpen = false">×</button>
      </header>
      <form @submit.prevent="saveMetadata">
        <label class="form-field"><span>模板名称</span><input v-model="metadata.name" required minlength="2" /></label>
        <label class="form-field"><span>适用场景</span><textarea v-model="metadata.description" required rows="4" />
        </label>
        <label class="form-field"><span>标签</span><input v-model="metadata.tags" placeholder="品牌大会、行业峰会" /></label>
        <footer class="row-actions">
          <button class="button secondary" type="button" @click="metadataOpen = false">取消</button>
          <button class="button" type="submit" :disabled="pending">保存资料</button>
        </footer>
      </form>
    </section>
  </div>

  <div v-if="publishPanelOpen" class="admin-modal-backdrop" @click.self="publishPanelOpen = false">
    <section
      class="admin-panel html-editor-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-title"
    >
      <header>
        <div>
          <p class="eyebrow">PUBLISH VERSION</p>
          <h2 id="publish-title">发布 HTML 模板</h2>
        </div>
        <button type="button" aria-label="关闭" @click="publishPanelOpen = false">×</button>
      </header>
      <form @submit.prevent="publish">
        <p>
          发布会冻结当前 HTML 文档与
          {{ manifest.bindings.length }} 条变量绑定。现有大会继续使用各自绑定版本。
        </p>
        <dl class="html-publish-metrics">
          <div>
            <dt>变量绑定</dt>
            <dd>{{ manifest.bindings.length }}</dd>
          </div>
          <div>
            <dt>内化资源</dt>
            <dd>{{ detail?.assetManifest.length ?? 0 }}</dd>
          </div>
          <div>
            <dt>编译器</dt>
            <dd>V{{ detail?.compilerVersion ?? 1 }}</dd>
          </div>
          <div>
            <dt>使用大会</dt>
            <dd>{{ summary?.usageCount ?? 0 }}</dd>
          </div>
        </dl>
        <label class="form-field">
          <span>版本说明</span>
          <textarea
            v-model="changeSummary"
            required
            minlength="2"
            rows="4"
            placeholder="记录本次页面和变量变化"
          />
        </label>
        <footer class="row-actions">
          <button class="button secondary" type="button" @click="publishPanelOpen = false">
            取消
          </button>
          <button class="button" type="submit" :disabled="pending || !changeSummary.trim()">
            确认发布
          </button>
        </footer>
      </form>
    </section>
  </div>

  <div v-if="aiPanelOpen" class="admin-modal-backdrop" @click.self="aiPanelOpen = false">
    <section
      class="admin-panel ai-review-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-review-title"
    >
      <header>
        <div>
          <p class="eyebrow">AI PROPOSAL REVIEW</p>
          <h2 id="ai-review-title">审核 AI 变量建议</h2>
          <p>预选置信度达到 80% 的建议，应用前可以逐条调整。</p>
        </div>
        <button type="button" aria-label="关闭" @click="aiPanelOpen = false">×</button>
      </header>
      <div v-if="aiProposals.length" class="ai-proposal-list">
        <label v-for="proposal in aiProposals" :key="proposal.proposalId">
          <input v-model="selectedAiProposalIds" type="checkbox" :value="proposal.proposalId" />
          <span><strong>{{ proposal.originalValue || proposal.nodeId }}</strong><small>{{ proposal.reason }}</small></span>
          <code>{{ bindingLabel(proposal.binding) }}</code>
          <b>{{ Math.round(proposal.confidence * 100) }}%</b>
        </label>
      </div>
      <div v-else class="admin-empty">AI 暂未找到可靠变量建议，可以继续使用手工绑定。</div>
      <footer class="row-actions">
        <button
          class="button secondary danger"
          type="button"
          :disabled="pending"
          @click="rejectAiSuggestions"
        >
          拒绝本轮
        </button>
        <button class="button secondary" type="button" @click="aiPanelOpen = false">
          稍后处理
        </button>
        <button
          class="button"
          type="button"
          :disabled="pending || !selectedAiProposalIds.length"
          @click="applyAiSuggestions"
        >
          应用 {{ selectedAiProposalIds.length }} 条建议
        </button>
      </footer>
    </section>
  </div>
</template>
