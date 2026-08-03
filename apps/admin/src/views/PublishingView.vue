<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type {
  ConferenceTemplateOption,
  EventExperience,
  EventStatus,
  EventRelease,
  EventTemplateBinding,
  TemplateSurface,
} from '@conference/contracts';
import { normalizeConferenceTemplateDefinition } from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import { conferenceApi, publicEventUrl, session } from '../lib/api';
import { dateTime } from '../lib/format';

const binding = ref<EventTemplateBinding>();
const experience = ref<EventExperience>();
const options = ref<ConferenceTemplateOption[]>([]);
const releases = ref<EventRelease[]>([]);
const pending = ref(false);
const loading = ref(true);
const message = ref('');
const errorMessage = ref('');
const activeTab = ref<'binding' | 'home' | 'faq' | 'flow' | 'releases'>('binding');
const tabs = [
  { key: 'binding', label: '模板绑定' },
  { key: 'home', label: '首页设置' },
  { key: 'faq', label: 'FAQ 设置' },
  { key: 'flow', label: '报名流程' },
  { key: 'releases', label: '变更记录' },
] as const;
const visibleTabs = computed(() =>
  experience.value?.definition.presentation.kind === 'html'
    ? tabs.filter((tab) => tab.key !== 'home')
    : tabs,
);
const replacementVersionId = ref('');
const showReplacementConfirm = ref(false);
const showSaveAsTemplate = ref(false);
const rollbackTarget = ref<EventRelease>();
const eventStatus = ref<EventStatus>('configuring');
const canPublish = session.can('event.site.publish');
const canManageBinding = session.can('event.manage');
const canManageExperience = session.can('event.content.manage');
const canUseTemplate = session.can('org.template.use');
const canSaveAsTemplate = session.canAll([
  'event.manage',
  'org.template.manage',
  'org.template.publish',
]);
const saveAsForm = reactive({
  name: '',
  description: '从大会前台配置提取的可复用模板',
  tags: '',
  includeContent: false,
});
const selectedReplacement = computed(() =>
  options.value.find((item) => item.currentPublishedVersionId === replacementVersionId.value),
);
const homeForm = reactive({ primaryAction: '', secondaryAction: '' });
const faqForm = reactive({
  mode: 'home' as 'home' | 'page',
  title: '',
  introduction: '',
  searchEnabled: true,
  contactLabel: '',
  contactUrl: '',
});
const faqItems = ref<EventExperience['definition']['faq']['items']>([]);
const flowForm = reactive({
  preset: 'standard' as 'standard' | 'quick' | 'free',
  progressVariant: 'steps' as 'steps' | 'compact' | 'minimal',
  waitlist: true,
  invoiceAfterPayment: true,
  manualReview: false,
});

function hydrateExperience(value: EventExperience) {
  const definition = normalizeConferenceTemplateDefinition(value.definition);
  experience.value = { ...value, definition };
  if (definition.presentation.kind === 'html' && activeTab.value === 'home') {
    activeTab.value = 'binding';
  }
  const home =
    definition.presentation.kind === 'structured' ? definition.presentation.home : undefined;
  const hero = home?.blocks.find((item) => item.nodeKey === 'home.hero');
  homeForm.primaryAction = String(hero?.content.primaryAction ?? '立即报名');
  homeForm.secondaryAction = String(hero?.content.secondaryAction ?? '查看议程');
  Object.assign(faqForm, {
    mode: definition.faq.mode,
    title: definition.faq.title,
    introduction: definition.faq.introduction,
    searchEnabled: definition.faq.searchEnabled,
    contactLabel: definition.faq.contactLabel,
    contactUrl: definition.faq.contactUrl,
  });
  faqItems.value = structuredClone(definition.faq.items);
  Object.assign(flowForm, {
    preset: definition.registrationFlow.preset,
    progressVariant: definition.registrationFlow.progressVariant,
    waitlist: definition.registrationFlow.branches.waitlist,
    invoiceAfterPayment: definition.registrationFlow.branches.invoiceAfterPayment,
    manualReview: definition.registrationFlow.branches.manualReview,
  });
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [loadedBinding, loadedExperience, loadedReleases, loadedOptions, event] =
      await Promise.all([
        conferenceApi.getTemplateBinding(),
        conferenceApi.getEventExperience(),
        conferenceApi.getReleases(),
        canUseTemplate ? conferenceApi.getTemplateOptions() : Promise.resolve([]),
        conferenceApi.getEvent(),
      ]);
    binding.value = loadedBinding;
    hydrateExperience(loadedExperience);
    releases.value = loadedReleases;
    options.value = loadedOptions;
    eventStatus.value = event.status;
    replacementVersionId.value =
      loadedBinding.currentPublishedVersionId ?? loadedBinding.templateVersionId;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '大会模板配置读取失败';
  } finally {
    loading.value = false;
  }
}

function savedMessage(subject = '已保存') {
  return ['prepublished', 'registration_open', 'in_progress', 'ended'].includes(eventStatus.value)
    ? `${subject}，前台已生效`
    : `${subject}，大会上线时生效`;
}

function requestTemplateReplacement(templateVersionId?: string) {
  if (templateVersionId) replacementVersionId.value = templateVersionId;
  errorMessage.value = '';
  showReplacementConfirm.value = true;
}

async function updateBinding(templateVersionId: string) {
  if (!binding.value) return;
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    binding.value = await conferenceApi.updateTemplateBinding({
      templateVersionId,
      revision: binding.value.revision,
      conflictResolutions: {
        home: 'discard',
        faq: 'discard',
        registration_flow: 'discard',
      },
    });
    hydrateExperience(await conferenceApi.getEventExperience());
    releases.value = await conferenceApi.getReleases();
    showReplacementConfirm.value = false;
    message.value = savedMessage(
      `模板已替换为 ${binding.value.templateName} V${binding.value.templateVersion}`,
    );
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '大会模板绑定更新失败';
  } finally {
    pending.value = false;
  }
}

async function saveSurface(surface: TemplateSurface) {
  if (!experience.value) return;
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const override = experience.value.overrides[surface];
    const document =
      surface === 'home'
        ? {
            'home.hero': {
              content: {
                primaryAction: homeForm.primaryAction,
                secondaryAction: homeForm.secondaryAction,
              },
            },
          }
        : surface === 'faq'
          ? {
              $page: {
                mode: faqForm.mode,
                title: faqForm.title,
                introduction: faqForm.introduction,
                searchEnabled: faqForm.searchEnabled,
                contactLabel: faqForm.contactLabel,
                contactUrl: faqForm.contactUrl,
              },
              ...Object.fromEntries(
                faqItems.value
                  .filter((item) => !item.nodeKey.startsWith('faq.event-'))
                  .map((item) => [
                    item.nodeKey,
                    {
                      category: item.category,
                      question: item.question,
                      answer: item.answer,
                      enabled: item.enabled,
                    },
                  ]),
              ),
              $additions: faqItems.value.filter((item) => item.nodeKey.startsWith('faq.event-')),
            }
          : {
              $page: {
                preset: flowForm.preset,
                progressVariant: flowForm.progressVariant,
                branches: {
                  ...experience.value.definition.registrationFlow.branches,
                  waitlist: flowForm.waitlist,
                  invoiceAfterPayment: flowForm.invoiceAfterPayment,
                  manualReview: flowForm.manualReview,
                },
              },
            };
    const updated = await conferenceApi.saveEventExperience(surface, override.revision, document);
    hydrateExperience(updated);
    releases.value = await conferenceApi.getReleases();
    message.value = savedMessage();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '大会专属设置保存失败';
  } finally {
    pending.value = false;
  }
}

function addFaqItem() {
  faqItems.value.push({
    nodeKey: `faq.event-${Date.now().toString(36)}`,
    category: '常见问题',
    question: '新问题',
    answer: '请填写答案。',
    enabled: true,
  });
}

function removeFaqItem(index: number) {
  const item = faqItems.value[index];
  if (!item) return;
  if (item.nodeKey.startsWith('faq.event-')) {
    faqItems.value.splice(index, 1);
  } else {
    item.enabled = false;
  }
}

async function rollback(release: EventRelease) {
  if (release.active) return;
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    await conferenceApi.rollbackRelease(release.id);
    message.value = ['prepublished', 'registration_open', 'in_progress', 'ended'].includes(
      eventStatus.value,
    )
      ? `前台已回滚到 V${release.version}。后台配置继续保留，后续保存只更新当前模块。`
      : `已将 V${release.version} 设为上线基线。大会当前保持未公开，重新上线时会采用届时的完整后台配置。`;
    await load();
    rollbackTarget.value = undefined;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '回滚失败';
  } finally {
    pending.value = false;
  }
}

function requestRollback(release: EventRelease) {
  if (!release.active) {
    errorMessage.value = '';
    rollbackTarget.value = release;
  }
}

async function saveAsTemplate() {
  pending.value = true;
  errorMessage.value = '';
  try {
    const created = await conferenceApi.saveEventAsTemplate({
      name: saveAsForm.name.trim(),
      description: saveAsForm.description.trim(),
      tags: saveAsForm.tags
        .split(/、|,|，/)
        .map((item) => item.trim())
        .filter(Boolean),
      includeContent: saveAsForm.includeContent,
    });
    showSaveAsTemplate.value = false;
    message.value = `${created.summary.name} V1 已创建并发布，可以被其他大会选择。`;
    options.value = canUseTemplate ? await conferenceApi.getTemplateOptions() : [];
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '另存为模板失败';
  } finally {
    pending.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">EVENT EXPERIENCE</p>
      <h1>大会模板与前台体验</h1>
      <p>保存大会专属配置后立即生效，同时保留完整的不可变版本记录。</p>
    </div>
    <a class="button secondary" :href="publicEventUrl()" target="_blank" rel="noopener noreferrer">
      查看前台 ↗
    </a>
  </header>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在读取大会体验设置…</div>

  <template v-else-if="binding && experience">
    <nav class="panel-tabs experience-tabs" aria-label="大会体验设置">
      <button
        v-for="tab in visibleTabs"
        :key="tab.key"
        class="panel-tab"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>

    <section v-if="activeTab === 'binding'" class="admin-panel event-template-binding-panel">
      <header class="admin-panel-header">
        <div>
          <h2>{{ binding.templateName }} · V{{ binding.templateVersion }}</h2>
          <p>当前大会使用此模板版本，替换后会立即更新前台</p>
        </div>
        <span v-if="binding.upgradeAvailable" class="status-badge pending">存在可用升级</span>
        <span v-else class="status-badge success">当前发布版本</span>
      </header>
      <div class="binding-overview-grid">
        <dl>
          <div>
            <dt>当前绑定</dt>
            <dd>V{{ binding.templateVersion }}</dd>
          </div>
          <div>
            <dt>模板最新</dt>
            <dd>V{{ binding.currentPublishedVersion ?? binding.templateVersion }}</dd>
          </div>
          <div>
            <dt>更新方式</dt>
            <dd>逐场手动升级</dd>
          </div>
          <div>
            <dt>最近调整</dt>
            <dd>{{ dateTime(binding.updatedAt) }}</dd>
          </div>
        </dl>
        <div v-if="canManageBinding && canUseTemplate" class="binding-actions">
          <button
            v-if="binding.upgradeAvailable && binding.currentPublishedVersionId"
            class="button"
            type="button"
            :disabled="pending"
            @click="requestTemplateReplacement(binding.currentPublishedVersionId)"
          >
            升级到 V{{ binding.currentPublishedVersion }}
          </button>
          <div class="form-field">
            <label for="replacement-template">替换为其他模板</label>
            <select id="replacement-template" v-model="replacementVersionId">
              <option
                v-for="item in options"
                :key="item.id"
                :value="item.currentPublishedVersionId ?? ''"
              >
                {{ item.name }} · V{{ item.currentVersion }}
              </option>
            </select>
          </div>
          <button
            class="button secondary"
            type="button"
            :disabled="replacementVersionId === binding.templateVersionId"
            @click="requestTemplateReplacement()"
          >
            检查并替换模板
          </button>
          <button
            v-if="canSaveAsTemplate"
            class="button secondary"
            type="button"
            @click="
              saveAsForm.name ||= `${binding.templateName} 大会版`;
              showSaveAsTemplate = true;
            "
          >
            从本大会另存为模板
          </button>
        </div>
      </div>
    </section>

    <section v-else-if="activeTab === 'home'" class="admin-panel event-experience-panel">
      <header class="admin-panel-header">
        <div>
          <h2>首页专属设置</h2>
          <p>按稳定节点键覆盖当前大会，不影响公共模板</p>
        </div>
      </header>
      <form class="event-form settings-form-spaced" @submit.prevent="saveSurface('home')">
        <div class="form-grid">
          <div class="form-field">
            <label for="event-primary-action">首屏主按钮</label>
            <input
              id="event-primary-action"
              v-model="homeForm.primaryAction"
              :disabled="!canManageExperience"
            />
          </div>
          <div class="form-field">
            <label for="event-secondary-action">首屏辅助按钮</label>
            <input
              id="event-secondary-action"
              v-model="homeForm.secondaryAction"
              :disabled="!canManageExperience"
            />
          </div>
        </div>
        <div v-if="canManageExperience" class="event-form-actions">
          <button class="button" type="submit" :disabled="pending">保存并生效</button>
        </div>
      </form>
    </section>

    <section v-else-if="activeTab === 'faq'" class="admin-panel event-experience-panel">
      <header class="admin-panel-header">
        <div>
          <h2>FAQ 页面设置</h2>
          <p>大会问题与答案保持独立，模板提供布局与默认骨架</p>
        </div>
      </header>
      <form class="event-form settings-form-spaced" @submit.prevent="saveSurface('faq')">
        <div class="form-grid">
          <div class="form-field">
            <label for="event-faq-mode">呈现方式</label>
            <select id="event-faq-mode" v-model="faqForm.mode" :disabled="!canManageExperience">
              <option value="home">首页区块</option>
              <option value="page">独立 FAQ 页面</option>
            </select>
          </div>
          <div class="form-field">
            <label for="event-faq-title">页面标题</label>
            <input id="event-faq-title" v-model="faqForm.title" :disabled="!canManageExperience" />
          </div>
          <div class="form-field full">
            <label for="event-faq-introduction">页面导语</label>
            <textarea
              id="event-faq-introduction"
              v-model="faqForm.introduction"
              rows="4"
              :disabled="!canManageExperience"
            />
          </div>
          <label class="setting-toggle">
            <input
              v-model="faqForm.searchEnabled"
              type="checkbox"
              :disabled="!canManageExperience"
            />
            <span><strong>显示关键词搜索</strong><small>独立 FAQ 页面支持全文检索</small></span>
          </label>
          <div class="form-field">
            <label for="event-faq-contact-label">联系入口文案</label>
            <input
              id="event-faq-contact-label"
              v-model="faqForm.contactLabel"
              :disabled="!canManageExperience"
            />
          </div>
          <div class="form-field">
            <label for="event-faq-contact-url">联系入口地址</label>
            <input
              id="event-faq-contact-url"
              v-model="faqForm.contactUrl"
              :disabled="!canManageExperience"
              placeholder="https://、mailto: 或 tel:"
            />
          </div>
        </div>
        <div class="event-faq-editor">
          <header>
            <div>
              <h3>大会问题与答案</h3>
              <p>修改只作用于当前大会。</p>
            </div>
            <button
              v-if="canManageExperience"
              class="button secondary compact"
              type="button"
              @click="addFaqItem"
            >
              添加问题
            </button>
          </header>
          <article
            v-for="(item, index) in faqItems"
            :key="item.nodeKey"
            :class="{ 'is-disabled': !item.enabled }"
          >
            <div class="form-grid">
              <div class="form-field">
                <label>分类</label>
                <input v-model="item.category" :disabled="!canManageExperience || !item.enabled" />
              </div>
              <label class="setting-toggle">
                <input v-model="item.enabled" type="checkbox" :disabled="!canManageExperience" />
                <span><strong>显示</strong><small>{{ item.nodeKey }}</small></span>
              </label>
              <div class="form-field full">
                <label>问题</label>
                <input v-model="item.question" :disabled="!canManageExperience || !item.enabled" />
              </div>
              <div class="form-field full">
                <label>答案</label>
                <textarea
                  v-model="item.answer"
                  rows="4"
                  :disabled="!canManageExperience || !item.enabled"
                />
              </div>
            </div>
            <button
              v-if="canManageExperience"
              class="button danger compact"
              type="button"
              @click="removeFaqItem(index)"
            >
              {{ item.nodeKey.startsWith('faq.event-') ? '移除' : '停用' }}
            </button>
          </article>
        </div>
        <div v-if="canManageExperience" class="event-form-actions">
          <button class="button" type="submit" :disabled="pending">保存并生效</button>
        </div>
      </form>
    </section>

    <section v-else-if="activeTab === 'flow'" class="admin-panel event-experience-panel">
      <header class="admin-panel-header">
        <div>
          <h2>报名流程设置</h2>
          <p>页面组织可以调整，库存、支付、出票和发票规则由服务端统一执行</p>
        </div>
      </header>
      <form
        class="event-form settings-form-spaced"
        @submit.prevent="saveSurface('registration_flow')"
      >
        <div class="form-grid">
          <div class="form-field">
            <label for="event-flow-preset">流程预设</label>
            <select
              id="event-flow-preset"
              v-model="flowForm.preset"
              :disabled="!canManageExperience"
            >
              <option value="standard">标准四步</option>
              <option value="quick">快速三步</option>
              <option value="free">免费两步</option>
            </select>
          </div>
          <div class="form-field">
            <label for="event-progress-variant">进度展示</label>
            <select
              id="event-progress-variant"
              v-model="flowForm.progressVariant"
              :disabled="!canManageExperience"
            >
              <option value="steps">完整步骤</option>
              <option value="compact">紧凑进度</option>
              <option value="minimal">极简进度</option>
            </select>
          </div>
        </div>
        <div class="setting-toggle-grid">
          <label class="setting-toggle">
            <input v-model="flowForm.waitlist" type="checkbox" :disabled="!canManageExperience" />
            <span><strong>售罄候补</strong><small>票种售罄后展示候补入口</small></span>
          </label>
          <label class="setting-toggle">
            <input
              v-model="flowForm.invoiceAfterPayment"
              type="checkbox"
              :disabled="!canManageExperience"
            />
            <span><strong>支付后补发票资料</strong><small>付费且勾选发票意向时出现</small></span>
          </label>
          <label class="setting-toggle">
            <input
              v-model="flowForm.manualReview"
              type="checkbox"
              :disabled="!canManageExperience"
            />
            <span><strong>人工审核分支</strong><small>审核通过后进入支付</small></span>
          </label>
        </div>
        <div v-if="canManageExperience" class="event-form-actions">
          <button class="button" type="submit" :disabled="pending">保存并生效</button>
        </div>
      </form>
    </section>

    <section v-else class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>不可变变更记录</h2>
          <p>每次有效保存都会固化模板体验、票种、报名表与大会内容</p>
        </div>
      </header>
      <ul class="operations-list">
        <li v-for="release in releases" :key="release.id">
          <div>
            <strong>V{{ release.version }} · {{ release.changeSummary }}</strong>
            <small>
              {{ release.createdByName ?? '系统' }} · {{ dateTime(release.publishedAt) }} ·
              {{
                release.activationKind === 'initial'
                  ? '首次上线'
                  : release.activationKind === 'save'
                    ? '保存生效'
                    : '历史发布'
              }}<br />
              模板 {{ release.templateKey
              }}{{ release.templateVersionId ? ' · 版本已固化' : ' · 历史兼容版本' }}
            </small>
          </div>
          <button
            v-if="canPublish && !release.active"
            class="button danger compact"
            type="button"
            :disabled="pending"
            @click="requestRollback(release)"
          >
            回滚到此版本
          </button>
          <span v-else-if="release.active" class="status-badge success">当前版本</span>
          <span v-else class="status-badge draft">历史版本</span>
        </li>
        <li v-if="!releases.length">
          <div>
            <strong>尚无变更记录</strong><small>完成票种和报名表后，将大会状态切换为预发布或开放报名。</small>
          </div>
        </li>
      </ul>
    </section>
  </template>

  <AdminConfirmDialog
    :open="showReplacementConfirm && Boolean(selectedReplacement)"
    :event-name="session.activeEvent.value?.name"
    :title="`确认替换为“${selectedReplacement?.name ?? ''}”V${selectedReplacement?.currentVersion ?? ''}？`"
    description="保存成功后大会前台会立即使用新模板。能匹配的首页、FAQ 和流程覆盖继续保留，孤立覆盖会被移除。"
    :details="[
      { label: '保持独立', value: '票价、容量、报名、订单、发票和签到数据' },
      { label: '立即更新', value: '页面布局、首页、FAQ 与报名流程' },
    ]"
    :busy="pending"
    :error="errorMessage"
    @cancel="
      showReplacementConfirm = false;
      errorMessage = '';
    "
    @confirm="updateBinding(selectedReplacement?.currentPublishedVersionId ?? '')"
  />

  <AdminConfirmDialog
    :open="Boolean(rollbackTarget)"
    :event-name="session.activeEvent.value?.name"
    :title="`确认回滚到 V${rollbackTarget?.version ?? ''}？`"
    description="当前大会已公开时，前台会立即恢复该版本中的模板体验、报名表、票种和内容；未公开状态会继续保持。后台配置与现有业务记录保持不变。"
    confirm-label="确认回滚"
    tone="danger"
    :details="[
      { label: '版本摘要', value: rollbackTarget?.changeSummary ?? '' },
      { label: '版本时间', value: rollbackTarget ? dateTime(rollbackTarget.publishedAt) : '' },
    ]"
    :busy="pending"
    :error="errorMessage"
    @cancel="
      rollbackTarget = undefined;
      errorMessage = '';
    "
    @confirm="rollbackTarget && rollback(rollbackTarget)"
  />

  <section v-if="showSaveAsTemplate" class="admin-panel template-replacement-confirm">
    <header class="admin-panel-header">
      <div>
        <p class="eyebrow">SAVE REUSABLE TEMPLATE</p>
        <h2>从本大会另存为模板</h2>
        <p>页面结构、FAQ 分类、报名流程和初始化策略会进入新模板 V1。</p>
      </div>
    </header>
    <form class="event-form settings-form-spaced" @submit.prevent="saveAsTemplate">
      <div class="form-grid">
        <div class="form-field">
          <label for="save-template-name">模板名称</label>
          <input
            id="save-template-name"
            v-model="saveAsForm.name"
            required
            minlength="2"
            maxlength="160"
          />
        </div>
        <div class="form-field">
          <label for="save-template-tags">标签</label>
          <input
            id="save-template-tags"
            v-model="saveAsForm.tags"
            placeholder="行业峰会、品牌大会"
          />
        </div>
        <div class="form-field full">
          <label for="save-template-description">适用场景</label>
          <textarea
            id="save-template-description"
            v-model="saveAsForm.description"
            required
            rows="3"
            maxlength="2000"
          />
        </div>
      </div>
      <label class="setting-toggle">
        <input v-model="saveAsForm.includeContent" type="checkbox" />
        <span>
          <strong>附带当前页面文案与 FAQ 答案</strong>
          <small>日期、地点、联系人、价格、容量、报名、订单、发票和签到数据始终排除</small>
        </span>
      </label>
      <div class="event-form-actions">
        <button class="button secondary" type="button" @click="showSaveAsTemplate = false">
          取消
        </button>
        <button class="button" type="submit" :disabled="pending">
          {{ pending ? '正在创建…' : '创建并发布模板 V1' }}
        </button>
      </div>
    </form>
  </section>
</template>
