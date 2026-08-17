<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from 'vue';
import {
  ConferenceTemplateDefinitionSchema,
  normalizeConferenceTemplateDefinition,
  type ConferenceTemplateDefinition,
  type ConferenceTemplateVersion,
} from '@conference/contracts';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { conferenceApi, session, type TemplateAsset } from '../lib/api';
import { dateTime } from '../lib/format';

type EditorSection =
  'overview' | 'home' | 'faq' | 'registration' | 'initialization' | 'assets' | 'versions';

const route = useRoute();
const router = useRouter();
const templateId = computed(() => String(route.params.templateId));
const loading = ref(true);
const pending = ref(false);
const ready = ref(false);
const errorMessage = ref('');
const message = ref('');
const saveState = ref<'saved' | 'saving' | 'failed' | 'conflict'>('saved');
const activeSection = ref<EditorSection>('overview');
const selectedNodeKey = ref('');
const previewMode = ref<'desktop' | 'tablet' | 'mobile'>('desktop');
const publishPanelOpen = ref(false);
const changeSummary = ref('');
const revision = ref(0);
const definition = ref<ConferenceTemplateDefinition>();
const structuredHome = computed(() =>
  definition.value?.presentation.kind === 'structured'
    ? definition.value.presentation.home
    : undefined,
);
const versions = ref<ConferenceTemplateVersion[]>([]);
const usages = ref<Array<Record<string, unknown>>>([]);
const assets = ref<TemplateAsset[]>([]);
const selectedAssetFile = ref<File>();
const assetAltText = ref('');
const assetDeleteTarget = ref<TemplateAsset>();
const summary = reactive({
  name: '',
  description: '',
  tags: [] as string[],
  status: 'draft',
  usageCount: 0,
});
const metadataForm = reactive({ name: '', description: '', tags: '' });
const canManage = computed(() => session.can('org.template.manage'));
const canPublish = computed(() => session.can('org.template.publish'));
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savePromise: Promise<void> | undefined;
let saveQueued = false;

function escapePreviewHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const validation = computed(() =>
  definition.value
    ? ConferenceTemplateDefinitionSchema.safeParse(definition.value)
    : { success: false as const, error: undefined },
);
const validationErrors = computed(() =>
  validation.value.success
    ? []
    : (validation.value.error?.issues ?? []).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
);
const currentNodes = computed(() => {
  if (!definition.value) return [];
  if (activeSection.value === 'home') {
    if (!structuredHome.value) return [];
    return [
      { nodeKey: '$page', displayLabel: '首页元信息' },
      ...structuredHome.value.blocks.map((node) => ({
        nodeKey: node.nodeKey,
        displayLabel: node.label,
      })),
    ];
  }
  if (activeSection.value === 'faq') {
    return [
      { nodeKey: '$page', displayLabel: 'FAQ 页面设置' },
      ...definition.value.faq.items.map((node) => ({
        nodeKey: node.nodeKey,
        displayLabel: node.question,
      })),
    ];
  }
  if (activeSection.value === 'registration') {
    return [
      { nodeKey: '$page', displayLabel: '流程全局设置' },
      ...definition.value.registrationFlow.steps.map((node) => ({
        nodeKey: node.nodeKey,
        displayLabel: node.title,
      })),
    ];
  }
  return [];
});
const selectedHomeBlock = computed(() =>
  structuredHome.value?.blocks.find((item) => item.nodeKey === selectedNodeKey.value),
);
const selectedHomeCopyFields = computed(() =>
  Object.entries(selectedHomeBlock.value?.content ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
const selectedFaqItem = computed(() =>
  definition.value?.faq.items.find((item) => item.nodeKey === selectedNodeKey.value),
);
const selectedFlowStep = computed(() =>
  definition.value?.registrationFlow.steps.find((item) => item.nodeKey === selectedNodeKey.value),
);
const previewWidth = computed(
  () => ({ desktop: '100%', tablet: '820px', mobile: '390px' })[previewMode.value],
);
const previewDocument = computed(() => {
  const data = definition.value;
  if (!data) return '';
  if (data.presentation.kind !== 'structured') {
    return '<!doctype html><html lang="zh-CN"><body><p>HTML 模板请通过安全编译器预览。</p></body></html>';
  }
  const blocks = data.presentation.home.blocks
    .filter((item) => item.enabled)
    .map(
      (item) =>
        `<section class="block block-${item.type}"><small>${escapePreviewHtml(item.label)}</small><h2>${escapePreviewHtml(item.type === 'hero' ? summary.name || '大会名称' : item.label)}</h2><p>${escapePreviewHtml(item.type === 'hero' ? summary.description : `变体：${item.variant}`)}</p></section>`,
    )
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
    *{box-sizing:border-box}body{margin:0;color:#172233;background:#fff;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    .watermark{position:sticky;top:0;z-index:2;padding:8px 14px;color:#fff;background:#1b416f;font-size:11px;letter-spacing:.12em}
    .page{max-width:1080px;margin:auto;background:#fff}.block{min-height:150px;padding:42px;border-bottom:1px solid #dce1e3}
    .block small{color:#637181;font-size:10px;letter-spacing:.1em;text-transform:uppercase}.block h2{margin:8px 0;font-family:Georgia,"Songti SC",serif;font-size:28px;font-weight:500}.block p{color:#637181;font-size:13px}
    .block-hero{min-height:360px;padding-top:90px;background:#173b67;color:#fff}.block-hero small,.block-hero p{color:#c9d5e2}.block-hero h2{font-size:52px}
    @media(max-width:560px){.block{padding:28px 20px}.block-hero{min-height:300px;padding-top:64px}.block-hero h2{font-size:36px}}
  </style></head><body><div class="watermark">草稿预览 · 提交操作已禁用</div><main class="page">${blocks}</main></body></html>`;
});

const allSections: Array<{ key: EditorSection; label: string; description: string }> = [
  { key: 'overview', label: '概览', description: '名称、说明与状态' },
  { key: 'home', label: '首页', description: '区块、顺序与文案' },
  { key: 'faq', label: 'FAQ', description: '页面模式与问题骨架' },
  { key: 'registration', label: '报名流程', description: '预设、步骤与分支' },
  { key: 'initialization', label: '初始化内容', description: '票种、表单与复制策略' },
  { key: 'assets', label: '图片资源', description: 'Logo、分享图与背景' },
  { key: 'versions', label: '版本与引用', description: '历史版本和使用大会' },
];
const sections = computed(() =>
  allSections.filter((section) => section.key !== 'home' || Boolean(structuredHome.value)),
);

function saveStateLabel() {
  return {
    saved: '已保存',
    saving: '保存中',
    failed: '保存失败',
    conflict: '版本冲突',
  }[saveState.value];
}

async function load() {
  loading.value = true;
  ready.value = false;
  errorMessage.value = '';
  try {
    const [detail, loadedAssets] = await Promise.all([
      conferenceApi.getConferenceTemplate(templateId.value),
      conferenceApi.getTemplateAssets(),
    ]);
    Object.assign(summary, {
      name: detail.summary.name,
      description: detail.summary.description,
      tags: detail.summary.tags,
      status: detail.summary.status,
      usageCount: detail.summary.usageCount,
    });
    Object.assign(metadataForm, {
      name: detail.summary.name,
      description: detail.summary.description,
      tags: detail.summary.tags.join('、'),
    });
    definition.value = normalizeConferenceTemplateDefinition(
      structuredClone(detail.draft.definition),
    );
    revision.value = detail.draft.revision;
    versions.value = detail.versions;
    usages.value = detail.usages;
    assets.value = loadedAssets;
    await nextTick();
    ready.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '模板详情读取失败';
  } finally {
    loading.value = false;
  }
}

function readImageDimensions(file: File) {
  return new Promise<{ width: number; height: number } | undefined>((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      resolve(undefined);
      URL.revokeObjectURL(url);
    };
    image.src = url;
  });
}

async function uploadAsset() {
  const file = selectedAssetFile.value;
  if (!file) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const dimensions = await readImageDimensions(file);
    const asset = await conferenceApi.uploadTemplateAsset(
      file,
      assetAltText.value.trim(),
      dimensions,
    );
    assets.value.unshift(asset);
    selectedAssetFile.value = undefined;
    assetAltText.value = '';
    message.value = '模板图片已上传并完成文件校验。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '模板图片上传失败';
  } finally {
    pending.value = false;
  }
}

function useAsShareAsset(asset: TemplateAsset) {
  if (!structuredHome.value) return;
  structuredHome.value.seo.shareAssetId = asset.id;
  scheduleSave(true);
  message.value = '分享图引用已更新，保存草稿后生效。';
}

async function confirmDeleteAsset() {
  const asset = assetDeleteTarget.value;
  if (!asset) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    await conferenceApi.deleteTemplateAsset(asset.id);
    assets.value = assets.value.filter((item) => item.id !== asset.id);
    assetDeleteTarget.value = undefined;
    message.value = '未被引用的模板图片已删除。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '模板图片仍被引用，暂时无法删除';
  } finally {
    pending.value = false;
  }
}

function saveDraft() {
  if (!definition.value || !canManage.value) return Promise.resolve();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (savePromise) {
    saveQueued = true;
    return savePromise;
  }
  savePromise = (async () => {
    do {
      saveQueued = false;
      saveState.value = 'saving';
      errorMessage.value = '';
      try {
        const snapshot = structuredClone(toRaw(definition.value!));
        const saved = await conferenceApi.saveConferenceTemplateDraft(templateId.value, {
          definition: snapshot,
          revision: revision.value,
        });
        revision.value = saved.revision;
      } catch (error) {
        const text = error instanceof Error ? error.message : '模板草稿保存失败';
        errorMessage.value = text;
        saveState.value = text.includes('冲突') ? 'conflict' : 'failed';
        saveQueued = false;
        return;
      }
    } while (saveQueued);
    saveState.value = 'saved';
  })().finally(() => {
    savePromise = undefined;
  });
  return savePromise;
}

function scheduleSave(immediate = false) {
  if (!ready.value || !canManage.value) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveState.value = 'saving';
  saveTimer = setTimeout(
    () => {
      saveTimer = undefined;
      void saveDraft();
    },
    immediate ? 0 : 800,
  );
}

watch(
  definition,
  () => {
    if (ready.value) scheduleSave();
  },
  { deep: true },
);

watch(activeSection, () => {
  selectedNodeKey.value = currentNodes.value[0]?.nodeKey ?? '';
});

function selectNode(nodeKey: string) {
  selectedNodeKey.value = nodeKey;
}

const homeCopyLabels: Record<string, string> = {
  logoMark: 'Logo 字标',
  brandLabel: '品牌名称',
  brandMeta: '品牌补充说明',
  kicker: '英文眉题',
  eyebrow: '首屏眉题',
  title: '区块标题',
  titleLine1: '标题第一行',
  titleLine2: '标题第二行',
  titlePrefix: '主标题前半段',
  titleEvent: '大会名称标题',
  slogan: '大会主张',
  subtitle: '区块导语',
  description: '说明文案',
  descriptionLead: '首屏导语开头',
  descriptionStrong: '首屏重点文案',
  descriptionTail: '首屏导语结尾',
  primaryAction: '主按钮文案',
  secondaryAction: '辅助按钮文案',
  actionLabel: '行动按钮文案',
  cooperationLabel: '合作导航文案',
  directions: '合作方向说明',
  note: '补充说明',
  quote: '引用文案',
  attributionNames: '引用署名',
  attributionRole: '署名身份',
  moreLabel: '嘉宾尾注',
  organizer: '组委会名称',
  eventLabel: '大会版权名称',
  support: '联系说明',
};

function homeCopyLabel(key: string) {
  if (homeCopyLabels[key]) return homeCopyLabels[key];
  const repeated = key.match(/^(item|host|benefit|assurance|answerRank|mockRank)(\d+)(.*)$/);
  if (repeated) {
    const group = {
      item: '内容组',
      host: '发起人',
      benefit: '权益',
      assurance: '保障项',
      answerRank: '首屏推荐项',
      mockRank: '回答示例项',
    }[repeated[1]!];
    const suffix =
      {
        Old: '原值',
        New: '新值',
        Title: '标题',
        Body: '正文',
        Role: '身份',
        Bio: '介绍',
        Goal: '目标',
        Detail: '补充说明',
        Badge: '标签',
        Name: '姓名',
      }[repeated[3]!] ?? repeated[3];
    return [group, repeated[2], suffix].filter(Boolean).join(' ');
  }
  return key.replaceAll(/([a-z])([A-Z])/g, '$1 $2');
}

function setSelectedHomeCopy(key: string, value: string) {
  if (!selectedHomeBlock.value) return;
  selectedHomeBlock.value.content[key] = value;
}

function addTemplateFaq() {
  if (!definition.value) return;
  const nodeKey = `faq.custom-${Date.now().toString(36)}`;
  definition.value.faq.items.push({
    nodeKey,
    category: '常见问题',
    question: '新问题',
    answer: '请填写默认答案。',
    enabled: true,
  });
  selectedNodeKey.value = nodeKey;
  scheduleSave(true);
}

function removeSelectedFaq() {
  if (!definition.value || !selectedFaqItem.value) return;
  const index = definition.value.faq.items.findIndex(
    (item) => item.nodeKey === selectedFaqItem.value?.nodeKey,
  );
  if (index < 0) return;
  definition.value.faq.items.splice(index, 1);
  selectedNodeKey.value = definition.value.faq.items[index]?.nodeKey ?? '$page';
  scheduleSave(true);
}

function moveNode(direction: -1 | 1) {
  if (!definition.value || !selectedNodeKey.value) return;
  if (activeSection.value === 'home' && !structuredHome.value) return;
  const list = (
    activeSection.value === 'home'
      ? structuredHome.value?.blocks
      : activeSection.value === 'faq'
        ? definition.value.faq.items
        : definition.value.registrationFlow.steps
  ) as Array<{ nodeKey: string }>;
  const index = list.findIndex((item) => item.nodeKey === selectedNodeKey.value);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= list.length) return;
  const [moved] = list.splice(index, 1);
  if (moved) list.splice(target, 0, moved);
  scheduleSave(true);
}

function applyFlowPreset(preset: 'standard' | 'quick' | 'free') {
  if (!definition.value) return;
  const common = {
    helpText: '',
    variant: 'default',
    enabled: true,
  };
  definition.value.registrationFlow.preset = preset;
  definition.value.registrationFlow.steps =
    preset === 'standard'
      ? [
          {
            ...common,
            nodeKey: 'flow.ticket-selection',
            type: 'ticket-selection',
            title: '选择票种',
          },
          { ...common, nodeKey: 'flow.attendee-form', type: 'attendee-form', title: '填写资料' },
          {
            ...common,
            nodeKey: 'flow.review-payment',
            type: 'review-payment',
            title: '确认并支付',
          },
          { ...common, nodeKey: 'flow.success-ticket', type: 'success-ticket', title: '报名成功' },
        ]
      : preset === 'quick'
        ? [
            {
              ...common,
              nodeKey: 'flow.attendee-form',
              type: 'attendee-form',
              title: '票种与资料',
            },
            {
              ...common,
              nodeKey: 'flow.review-payment',
              type: 'review-payment',
              title: '确认并支付',
            },
            {
              ...common,
              nodeKey: 'flow.success-ticket',
              type: 'success-ticket',
              title: '报名成功',
            },
          ]
        : [
            { ...common, nodeKey: 'flow.attendee-form', type: 'attendee-form', title: '填写资料' },
            {
              ...common,
              nodeKey: 'flow.success-ticket',
              type: 'success-ticket',
              title: '报名成功',
            },
          ];
  selectedNodeKey.value = definition.value.registrationFlow.steps[0]?.nodeKey ?? '';
  scheduleSave(true);
}

function addTicketSkeleton() {
  if (!definition.value) return;
  definition.value.initialization.ticketTypes.push({
    code: `ticket_${definition.value.initialization.ticketTypes.length + 1}`,
    name: '新票种',
    description: '',
    price: 0,
    currency: 'CNY',
    capacity: 100,
    benefits: [],
  });
}

function setTicketName(index: number, value: string) {
  const ticket = definition.value?.initialization.ticketTypes[index];
  if (ticket) ticket.name = value;
}

function addRegistrationField() {
  if (!definition.value) return;
  const fields = definition.value.initialization.registrationFields;
  let index = fields.length + 1;
  let key = `custom_field_${index}`;
  while (fields.some((field) => field.key === key)) {
    index += 1;
    key = `custom_field_${index}`;
  }
  fields.push({
    key,
    label: '新字段',
    type: 'text',
    required: false,
    placeholder: '',
  });
}

async function saveMetadata() {
  pending.value = true;
  errorMessage.value = '';
  try {
    await saveDraft();
    if (saveState.value !== 'saved') return;
    const detail = await conferenceApi.updateConferenceTemplate(templateId.value, {
      name: metadataForm.name.trim(),
      description: metadataForm.description.trim(),
      tags: metadataForm.tags
        .split(/、|,|，/)
        .map((item) => item.trim())
        .filter(Boolean),
      revision: revision.value,
    });
    const typed = detail as { summary: typeof summary; draft: { revision: number } };
    Object.assign(summary, typed.summary);
    revision.value = typed.draft.revision;
    message.value = '模板概览信息已保存。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '模板概览保存失败';
  } finally {
    pending.value = false;
  }
}

async function publish() {
  if (!definition.value || !validation.value.success || saveState.value !== 'saved') return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const version = await conferenceApi.publishConferenceTemplate(
      templateId.value,
      revision.value,
      changeSummary.value,
    );
    versions.value.unshift(version);
    summary.status = 'published';
    publishPanelOpen.value = false;
    changeSummary.value = '';
    message.value = `${summary.name} V${version.version} 已发布。现有大会继续使用各自绑定版本。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '模板发布失败';
  } finally {
    pending.value = false;
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (saveState.value === 'saving' || saveState.value === 'failed') event.preventDefault();
}

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload);
  void load();
});
onBeforeRouteLeave(async () => {
  if (!canManage.value || saveState.value === 'saved') return true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  await saveDraft();
  return String(saveState.value) === 'saved';
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload);
  if (saveTimer) clearTimeout(saveTimer);
});
</script>

<template>
  <header class="template-editor-toolbar">
    <div>
      <button
        class="button secondary compact"
        type="button"
        @click="router.push({ name: 'manage-templates' })"
      >
        返回
      </button>
      <span>
        <small>模板编辑</small>
        <strong>{{ summary.name || '正在载入…' }}</strong>
      </span>
    </div>
    <div class="template-save-tools">
      <span class="save-state" :class="saveState">{{ saveStateLabel() }}</span>
      <button
        v-if="canManage"
        class="button secondary"
        type="button"
        :disabled="saveState === 'saving'"
        @click="saveDraft"
      >
        保存草稿
      </button>
      <button
        v-if="canPublish"
        class="button"
        type="button"
        :disabled="saveState !== 'saved' || !validation.success"
        @click="publishPanelOpen = true"
      >
        发布新版本
      </button>
    </div>
  </header>
  <p v-if="message" class="admin-success" role="status">{{ message }}</p>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <div v-if="loading" class="admin-loading">正在载入模板编辑器…</div>

  <div v-else-if="definition" class="template-editor-layout">
    <aside class="template-node-panel">
      <nav aria-label="模板编辑分区">
        <button
          v-for="section in sections"
          :key="section.key"
          type="button"
          :class="{ active: activeSection === section.key }"
          @click="activeSection = section.key"
        >
          <strong>{{ section.label }}</strong><small>{{ section.description }}</small>
        </button>
      </nav>
      <div v-if="currentNodes.length" class="template-node-list">
        <p class="eyebrow">页面与节点</p>
        <button
          v-for="node in currentNodes"
          :key="node.nodeKey"
          type="button"
          :class="{ active: selectedNodeKey === node.nodeKey }"
          @click="selectNode(node.nodeKey)"
        >
          <span>{{ node.displayLabel }}</span>
          <small>{{ node.nodeKey }}</small>
        </button>
        <div class="node-order-actions">
          <button class="button secondary compact" type="button" @click="moveNode(-1)">上移</button>
          <button class="button secondary compact" type="button" @click="moveNode(1)">下移</button>
        </div>
        <div v-if="activeSection === 'faq' && canManage" class="node-order-actions">
          <button class="button secondary compact" type="button" @click="addTemplateFaq">
            添加问题
          </button>
          <button
            class="button danger compact"
            type="button"
            :disabled="!selectedFaqItem"
            @click="removeSelectedFaq"
          >
            移除问题
          </button>
        </div>
      </div>
    </aside>

    <main class="template-preview-panel">
      <header>
        <div>
          <h2>实时预览</h2>
          <p>预览环境禁止报名、支付、候补和发票提交</p>
        </div>
        <div class="preview-device-switch" role="group" aria-label="预览宽度">
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
      <div class="template-preview-stage">
        <iframe
          title="大会模板草稿预览"
          sandbox=""
          :srcdoc="previewDocument"
          :style="{ width: previewWidth }"
        />
      </div>
    </main>

    <aside class="template-property-panel">
      <template v-if="activeSection === 'overview'">
        <p class="eyebrow">OVERVIEW</p>
        <h2>模板概览</h2>
        <form class="property-form" @submit.prevent="saveMetadata">
          <div class="form-field">
            <label for="editor-template-name">名称</label>
            <input id="editor-template-name" v-model="metadataForm.name" :disabled="!canManage" />
          </div>
          <div class="form-field">
            <label for="editor-template-description">适用场景</label>
            <textarea
              id="editor-template-description"
              v-model="metadataForm.description"
              rows="5"
              :disabled="!canManage"
            />
          </div>
          <div class="form-field">
            <label for="editor-template-tags">标签</label>
            <input id="editor-template-tags" v-model="metadataForm.tags" :disabled="!canManage" />
          </div>
          <button v-if="canManage" class="button" type="submit" :disabled="pending">
            保存概览
          </button>
        </form>
      </template>

      <template
        v-else-if="activeSection === 'home' && selectedNodeKey === '$page' && structuredHome"
      >
        <p class="eyebrow">HOME SETTINGS</p>
        <h2>首页元信息</h2>
        <div class="property-form">
          <div class="form-field">
            <label>页面标题</label>
            <input v-model="structuredHome.seo.title" :disabled="!canManage" />
          </div>
          <div class="form-field">
            <label>页面摘要</label>
            <textarea v-model="structuredHome.seo.description" rows="5" :disabled="!canManage" />
          </div>
          <label class="setting-toggle">
            <input v-model="structuredHome.seo.indexable" type="checkbox" :disabled="!canManage" />
            <span><strong>允许搜索引擎收录</strong><small>草稿预览始终禁止收录</small></span>
          </label>
        </div>
      </template>

      <template v-else-if="activeSection === 'home' && selectedHomeBlock">
        <p class="eyebrow">HOME BLOCK</p>
        <h2>{{ selectedHomeBlock.label }}</h2>
        <div class="property-form">
          <label class="setting-toggle">
            <input v-model="selectedHomeBlock.enabled" type="checkbox" :disabled="!canManage" />
            <span><strong>显示此区块</strong><small>{{ selectedHomeBlock.nodeKey }}</small></span>
          </label>
          <div class="form-field">
            <label>区块名称</label>
            <input v-model="selectedHomeBlock.label" :disabled="!canManage" />
          </div>
          <div class="form-field">
            <label>展示变体</label>
            <select v-model="selectedHomeBlock.variant" :disabled="!canManage">
              <option value="default">默认</option>
              <option value="editorial">编辑式</option>
              <option value="compact">紧凑</option>
              <option value="cards">卡片</option>
              <option value="timeline">时间线</option>
              <option value="editorial-band">编辑式行动区</option>
            </select>
          </div>
          <div v-for="[key, value] in selectedHomeCopyFields" :key="key" class="form-field">
            <label :for="'home-copy-' + key">{{ homeCopyLabel(key) }}</label>
            <textarea
              :id="'home-copy-' + key"
              :value="value"
              rows="3"
              :disabled="!canManage"
              @input="setSelectedHomeCopy(key, ($event.target as HTMLTextAreaElement).value)"
            />
          </div>
        </div>
      </template>

      <template v-else-if="activeSection === 'faq'">
        <p class="eyebrow">FAQ SETTINGS</p>
        <h2>{{ selectedFaqItem ? '问题骨架' : 'FAQ 页面' }}</h2>
        <div class="property-form">
          <template v-if="selectedFaqItem">
            <label class="setting-toggle">
              <input v-model="selectedFaqItem.enabled" type="checkbox" :disabled="!canManage" />
              <span><strong>显示此问题</strong><small>{{ selectedFaqItem.nodeKey }}</small></span>
            </label>
            <div class="form-field">
              <label>分类</label><input v-model="selectedFaqItem.category" :disabled="!canManage" />
            </div>
            <div class="form-field">
              <label>问题</label><textarea v-model="selectedFaqItem.question" rows="3" :disabled="!canManage" />
            </div>
            <div class="form-field">
              <label>默认答案</label><textarea v-model="selectedFaqItem.answer" rows="7" :disabled="!canManage" />
            </div>
          </template>
          <template v-else>
            <div class="form-field">
              <label>呈现方式</label>
              <select v-model="definition.faq.mode" :disabled="!canManage">
                <option value="home">首页区块</option>
                <option value="page">独立 FAQ 页面</option>
              </select>
            </div>
            <div class="form-field">
              <label>页面标题</label><input v-model="definition.faq.title" :disabled="!canManage" />
            </div>
            <div class="form-field">
              <label>页面导语</label>
              <textarea v-model="definition.faq.introduction" rows="4" :disabled="!canManage" />
            </div>
            <label class="setting-toggle">
              <input
                v-model="definition.faq.searchEnabled"
                type="checkbox"
                :disabled="!canManage"
              />
              <span><strong>显示关键词搜索</strong><small>独立页面支持问题全文检索</small></span>
            </label>
            <div class="form-field">
              <label>联系入口文案</label>
              <input v-model="definition.faq.contactLabel" :disabled="!canManage" />
            </div>
            <div class="form-field">
              <label>联系入口地址</label>
              <input
                v-model="definition.faq.contactUrl"
                :disabled="!canManage"
                placeholder="https://、mailto: 或 tel:"
              />
            </div>
          </template>
        </div>
      </template>

      <template v-else-if="activeSection === 'registration'">
        <p class="eyebrow">REGISTRATION FLOW</p>
        <h2>{{ selectedFlowStep ? '流程步骤' : '报名流程' }}</h2>
        <div class="flow-preset-buttons">
          <button type="button" @click="applyFlowPreset('standard')">标准四步</button>
          <button type="button" @click="applyFlowPreset('quick')">快速三步</button>
          <button type="button" @click="applyFlowPreset('free')">免费两步</button>
        </div>
        <div v-if="selectedFlowStep" class="property-form">
          <label class="setting-toggle">
            <input v-model="selectedFlowStep.enabled" type="checkbox" :disabled="!canManage" />
            <span><strong>启用步骤</strong><small>{{ selectedFlowStep.nodeKey }}</small></span>
          </label>
          <div class="form-field">
            <label>步骤标题</label><input v-model="selectedFlowStep.title" :disabled="!canManage" />
          </div>
          <div class="form-field">
            <label>帮助文案</label><textarea v-model="selectedFlowStep.helpText" rows="4" :disabled="!canManage" />
          </div>
          <div class="form-field">
            <label>页面变体</label><input v-model="selectedFlowStep.variant" :disabled="!canManage" />
          </div>
        </div>
        <div class="property-form">
          <template v-if="!selectedFlowStep">
            <div class="form-field">
              <label>进度展示</label>
              <select v-model="definition.registrationFlow.progressVariant" :disabled="!canManage">
                <option value="steps">完整步骤</option>
                <option value="compact">紧凑进度</option>
                <option value="minimal">极简进度</option>
              </select>
            </div>
            <label class="setting-toggle">
              <input
                v-model="definition.registrationFlow.summaryCardEnabled"
                type="checkbox"
                :disabled="!canManage"
              />
              <span><strong>显示报名摘要卡</strong><small>展示票种、金额与退改说明</small></span>
            </label>
          </template>
          <label class="setting-toggle">
            <input
              v-model="definition.registrationFlow.branches.waitlist"
              type="checkbox"
              :disabled="!canManage"
            />
            <span><strong>售罄候补</strong><small>票种售罄后允许加入候补</small></span>
          </label>
          <label class="setting-toggle">
            <input
              v-model="definition.registrationFlow.branches.invoiceAfterPayment"
              type="checkbox"
              :disabled="!canManage"
            />
            <span><strong>支付后补发票资料</strong><small>仅控制入口，资格由发票服务判断</small></span>
          </label>
          <label class="setting-toggle">
            <input
              v-model="definition.registrationFlow.branches.manualReview"
              type="checkbox"
              :disabled="!canManage"
            />
            <span><strong>人工审核分支</strong><small>审核通过后进入支付</small></span>
          </label>
        </div>
      </template>

      <template v-else-if="activeSection === 'initialization'">
        <p class="eyebrow">INITIALIZATION</p>
        <h2>初始化内容</h2>
        <dl class="initialization-summary">
          <div>
            <dt>票种骨架</dt>
            <dd>{{ definition.initialization.ticketTypes.length }} 个</dd>
          </div>
          <div>
            <dt>报名字段</dt>
            <dd>{{ definition.initialization.registrationFields.length }} 个</dd>
          </div>
          <div>
            <dt>复制策略</dt>
            <dd>{{ Object.keys(definition.initialization.copyPolicy).length }} 项</dd>
          </div>
        </dl>
        <h3 class="property-subtitle">复制策略</h3>
        <div class="property-form">
          <div
            v-for="(policy, key) in definition.initialization.copyPolicy"
            :key="key"
            class="form-field"
          >
            <label :for="`copy-policy-${key}`">{{ key }}</label>
            <select
              :id="`copy-policy-${key}`"
              v-model="definition.initialization.copyPolicy[key]"
              :disabled="!canManage"
            >
              <option
                v-if="!['registrations', 'orders', 'invoices', 'checkins'].includes(String(key))"
                value="COPY"
              >
                复制到大会
              </option>
              <option
                v-if="!['registrations', 'orders', 'invoices', 'checkins'].includes(String(key))"
                value="RESET"
              >
                创建后重置
              </option>
              <option
                v-if="
                  ![
                    'ticketTypes',
                    'registrationForm',
                    'registrations',
                    'orders',
                    'invoices',
                    'checkins',
                  ].includes(String(key))
                "
                value="REFERENCE"
              >
                保持引用
              </option>
              <option value="EXCLUDE">排除</option>
            </select>
          </div>
        </div>
        <h3 class="property-subtitle">票种骨架</h3>
        <ul class="version-list initialization-list">
          <li
            v-for="(ticket, index) in definition.initialization.ticketTypes"
            :key="String(ticket.code ?? index)"
          >
            <input
              :value="String(ticket.name ?? '')"
              :disabled="!canManage"
              aria-label="票种名称"
              @input="setTicketName(index, ($event.target as HTMLInputElement).value)"
            />
            <button
              v-if="canManage"
              class="button danger compact"
              type="button"
              @click="definition.initialization.ticketTypes.splice(index, 1)"
            >
              移除
            </button>
          </li>
        </ul>
        <button
          v-if="canManage"
          class="button secondary compact"
          type="button"
          @click="addTicketSkeleton"
        >
          添加票种骨架
        </button>
        <h3 class="property-subtitle">报名字段骨架</h3>
        <ul class="version-list initialization-list">
          <li
            v-for="(field, index) in definition.initialization.registrationFields"
            :key="field.key"
          >
            <input v-model="field.label" :disabled="!canManage" aria-label="字段名称" />
            <select v-model="field.type" :disabled="!canManage" aria-label="字段类型">
              <option value="text">文本</option>
              <option value="email">邮箱</option>
              <option value="tel">电话</option>
              <option value="select">选项</option>
            </select>
            <label class="initialization-required">
              <input v-model="field.required" type="checkbox" :disabled="!canManage" />
              必填
            </label>
            <button
              v-if="canManage"
              class="button danger compact"
              type="button"
              @click="definition.initialization.registrationFields.splice(index, 1)"
            >
              移除
            </button>
          </li>
        </ul>
        <button
          v-if="canManage"
          class="button secondary compact"
          type="button"
          @click="addRegistrationField"
        >
          添加报名字段
        </button>
        <div class="form-field">
          <label>服务条款骨架</label>
          <textarea
            v-model="definition.initialization.termsContent"
            rows="10"
            :disabled="!canManage"
          />
        </div>
        <p class="property-help">价格、容量、报名、订单、发票和签到数据会保持大会独立。</p>
      </template>

      <template v-else-if="activeSection === 'assets'">
        <p class="eyebrow">TEMPLATE ASSETS</p>
        <h2>图片资源</h2>
        <form v-if="canManage" class="property-form" @submit.prevent="uploadAsset">
          <div class="form-field">
            <label for="template-asset-file">选择图片</label>
            <input
              id="template-asset-file"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              required
              @change="selectedAssetFile = ($event.target as HTMLInputElement).files?.[0]"
            />
            <small>支持 JPG、PNG、WebP，单个文件不超过 10MB。</small>
          </div>
          <div class="form-field">
            <label for="template-asset-alt">图片说明</label>
            <input
              id="template-asset-alt"
              v-model="assetAltText"
              maxlength="500"
              placeholder="用于无障碍阅读和资源识别"
            />
          </div>
          <button class="button" type="submit" :disabled="pending || !selectedAssetFile">
            {{ pending ? '正在校验上传…' : '上传图片' }}
          </button>
        </form>
        <p class="property-help">
          图片使用内容摘要去重。已被草稿、版本或大会引用的资源会受到删除保护。
        </p>
        <ul class="template-asset-list">
          <li v-for="asset in assets" :key="asset.id">
            <img
              v-if="asset.previewUrl"
              :src="asset.previewUrl"
              :alt="asset.altText || '模板图片预览'"
            />
            <div>
              <strong>{{ asset.altText || '未填写图片说明' }}</strong>
              <small>
                {{ asset.mediaType }} · {{ Math.ceil(asset.size / 1024) }} KB
                <template v-if="asset.width && asset.height">
                  · {{ asset.width }} × {{ asset.height }}
                </template>
              </small>
              <span
                v-if="structuredHome?.seo.shareAssetId === asset.id"
                class="status-badge success"
              >
                当前分享图
              </span>
            </div>
            <div v-if="canManage" class="row-actions">
              <button
                v-if="structuredHome"
                class="button secondary compact"
                type="button"
                @click="useAsShareAsset(asset)"
              >
                设为分享图
              </button>
              <button
                class="button danger compact"
                type="button"
                @click="assetDeleteTarget = asset"
              >
                删除
              </button>
            </div>
          </li>
          <li v-if="!assets.length">
            <span>尚未上传模板图片。</span>
          </li>
        </ul>
        <section v-if="assetDeleteTarget" class="asset-delete-confirm">
          <strong>删除“{{ assetDeleteTarget.altText || '未命名图片' }}”</strong>
          <p>系统会先检查草稿、已发布版本和大会引用，存在引用时会阻止删除。</p>
          <div class="row-actions">
            <button
              class="button secondary compact"
              type="button"
              @click="assetDeleteTarget = undefined"
            >
              取消
            </button>
            <button
              class="button danger compact"
              type="button"
              :disabled="pending"
              @click="confirmDeleteAsset"
            >
              确认删除
            </button>
          </div>
        </section>
      </template>

      <template v-else>
        <p class="eyebrow">VERSIONS & USAGES</p>
        <h2>版本与引用</h2>
        <ul class="version-list">
          <li v-for="version in versions" :key="version.id">
            <strong>V{{ version.version }}</strong>
            <span>{{ version.changeSummary }}</span>
            <small>{{ version.createdByName ?? '系统' }} · {{ dateTime(version.publishedAt) }}</small>
          </li>
          <li v-if="!versions.length"><span>尚未发布版本</span></li>
        </ul>
        <h3 class="property-subtitle">使用大会（{{ usages.length }}）</h3>
        <ul class="version-list usage-list">
          <li v-for="usage in usages" :key="String(usage.eventId)">
            <strong>{{ usage.eventName }}</strong>
            <span>绑定 V{{ usage.version }}</span>
            <small>{{ usage.upgradeAvailable ? '存在可用升级' : '当前版本' }}</small>
          </li>
        </ul>
      </template>

      <div v-if="validationErrors.length" class="property-validation">
        <strong>发布前需要处理</strong>
        <p v-for="item in validationErrors" :key="`${item.path}-${item.message}`">
          {{ item.path || '模板' }}：{{ item.message }}
        </p>
      </div>
    </aside>
  </div>

  <section v-if="publishPanelOpen" class="admin-panel inline-confirm-panel publish-confirm-panel">
    <div>
      <p class="eyebrow">PUBLISH IMMUTABLE VERSION</p>
      <h2>发布 {{ summary.name }} 的新版本</h2>
      <p>
        将生成不可变版本。当前 {{ summary.usageCount }} 场大会保持原绑定，可由运营人员逐场升级。
      </p>
      <div class="form-field">
        <label for="template-change-summary">版本变更说明</label>
        <textarea
          id="template-change-summary"
          v-model="changeSummary"
          rows="3"
          placeholder="说明首页、FAQ 或报名流程的主要变化"
        />
      </div>
    </div>
    <div class="row-actions">
      <button class="button secondary" type="button" @click="publishPanelOpen = false">取消</button>
      <button
        class="button"
        type="button"
        :disabled="pending || changeSummary.trim().length < 2"
        @click="publish"
      >
        {{ pending ? '正在发布…' : '确认发布新版本' }}
      </button>
    </div>
  </section>
</template>
