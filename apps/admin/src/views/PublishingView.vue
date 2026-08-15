<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type {
  ConferenceTemplateOption,
  EventExperience,
  EventStatus,
  EventTemplateBinding,
  TemplateSurface,
} from '@conference/contracts';
import { normalizeConferenceTemplateDefinition } from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import { conferenceApi, publicEventUrl, session } from '../lib/api';
import { dateTime } from '../lib/format';

type EditableSiteSurface = Extract<TemplateSurface, 'home' | 'faq'>;

defineProps<{ embedded?: boolean }>();

const binding = ref<EventTemplateBinding>();
const experience = ref<EventExperience>();
const options = ref<ConferenceTemplateOption[]>([]);
const pending = ref(false);
const loading = ref(true);
const message = ref('');
const errorMessage = ref('');
const replacementVersionId = ref('');
const showReplacementConfirm = ref(false);
const showSaveAsTemplate = ref(false);
const eventStatus = ref<EventStatus>('configuring');
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
  description: '从大会公开页面设置提取的可复用模板',
  tags: '',
  includeContent: false,
});
const selectedReplacement = computed(() =>
  options.value.find((item) => item.currentPublishedVersionId === replacementVersionId.value),
);
const hasStructuredHome = computed(
  () => experience.value?.definition.presentation.kind === 'structured',
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

function hydrateExperience(
  value: EventExperience,
  surfaces: EditableSiteSurface[] = ['home', 'faq'],
) {
  const definition = normalizeConferenceTemplateDefinition(value.definition);
  experience.value = { ...value, definition };
  if (surfaces.includes('home')) {
    const home =
      definition.presentation.kind === 'structured' ? definition.presentation.home : undefined;
    const hero = home?.blocks.find((item) => item.nodeKey === 'home.hero');
    homeForm.primaryAction = String(hero?.content.primaryAction ?? '立即报名');
    homeForm.secondaryAction = String(hero?.content.secondaryAction ?? '查看议程');
  }
  if (surfaces.includes('faq')) {
    Object.assign(faqForm, {
      mode: definition.faq.mode,
      title: definition.faq.title,
      introduction: definition.faq.introduction,
      searchEnabled: definition.faq.searchEnabled,
      contactLabel: definition.faq.contactLabel,
      contactUrl: definition.faq.contactUrl,
    });
    faqItems.value = structuredClone(definition.faq.items);
  }
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [loadedBinding, loadedExperience, loadedOptions, event] = await Promise.all([
      conferenceApi.getTemplateBinding(),
      conferenceApi.getEventExperience(),
      canUseTemplate ? conferenceApi.getTemplateOptions() : Promise.resolve([]),
      conferenceApi.getEvent(),
    ]);
    binding.value = loadedBinding;
    hydrateExperience(loadedExperience);
    options.value = loadedOptions;
    eventStatus.value = event.status;
    replacementVersionId.value =
      loadedBinding.currentPublishedVersionId ?? loadedBinding.templateVersionId;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '大会公开页面设置读取失败';
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
    showReplacementConfirm.value = false;
    message.value = savedMessage(
      `已应用模板 ${binding.value.templateName} V${binding.value.templateVersion}`,
    );
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '大会页面模板更新失败';
  } finally {
    pending.value = false;
  }
}

async function saveSurface(surface: EditableSiteSurface) {
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
        : {
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
          };
    const updated = await conferenceApi.saveEventExperience(surface, override.revision, document);
    hydrateExperience(updated, [surface]);
    message.value = savedMessage(surface === 'home' ? '首页设置已保存' : 'FAQ 设置已保存');
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '大会公开页面设置保存失败';
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
    message.value = `${created.summary.name} 已创建为共享模板，可以被其他大会选择。`;
    options.value = canUseTemplate ? await conferenceApi.getTemplateOptions() : [];
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建共享模板失败';
  } finally {
    pending.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <header v-if="!embedded" class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">EVENT WEBSITE</p>
      <h1>大会公开页面设置</h1>
      <p>页面模板、首页与常见问题在同一页维护，保存后直接应用到当前大会。</p>
    </div>
    <a class="button secondary" :href="publicEventUrl()" target="_blank" rel="noopener noreferrer">
      查看官网 ↗
    </a>
  </header>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading">正在读取大会公开页面设置…</div>

  <div v-else-if="binding && experience" class="settings-section-stack">
    <section class="admin-panel event-template-binding-panel">
      <header class="admin-panel-header">
        <div>
          <h2>页面模板</h2>
          <p>模板控制整体布局，更换后立即应用，当前大会的业务数据保持不变</p>
        </div>
        <span v-if="binding.upgradeAvailable" class="status-badge pending">存在模板更新</span>
        <span v-else class="status-badge success">模板已是最新</span>
      </header>
      <div class="binding-overview-grid">
        <dl>
          <div>
            <dt>当前模板</dt>
            <dd>{{ binding.templateName }}</dd>
          </div>
          <div>
            <dt>当前模板版本</dt>
            <dd>V{{ binding.templateVersion }}</dd>
          </div>
          <div>
            <dt>应用方式</dt>
            <dd>按大会确认应用</dd>
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
            应用模板更新 V{{ binding.currentPublishedVersion }}
          </button>
          <div class="form-field">
            <label for="replacement-template">更换页面模板</label>
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
            检查并应用模板
          </button>
          <button
            v-if="canSaveAsTemplate"
            class="button subtle"
            type="button"
            @click="
              saveAsForm.name ||= `${binding.templateName} 大会版`;
              showSaveAsTemplate = true;
            "
          >
            另存为共享模板
          </button>
        </div>
      </div>
    </section>

    <section v-if="hasStructuredHome" class="admin-panel event-experience-panel">
      <header class="admin-panel-header">
        <div>
          <h2>首页展示</h2>
          <p>修改当前大会首页的主要行动入口，不影响共享模板</p>
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
          <button class="button" type="submit" :disabled="pending">保存首页设置</button>
        </div>
      </form>
    </section>

    <section class="admin-panel event-experience-panel">
      <header class="admin-panel-header">
        <div>
          <h2>常见问题</h2>
          <p>集中维护 FAQ 的呈现方式、联系入口和大会专属问答</p>
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
              <p>这里的修改只作用于当前大会。</p>
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
                <label :for="`event-faq-category-${index}`">分类</label>
                <input
                  :id="`event-faq-category-${index}`"
                  v-model="item.category"
                  :disabled="!canManageExperience || !item.enabled"
                />
              </div>
              <label class="setting-toggle">
                <input v-model="item.enabled" type="checkbox" :disabled="!canManageExperience" />
                <span><strong>显示</strong><small>{{ item.nodeKey }}</small></span>
              </label>
              <div class="form-field full">
                <label :for="`event-faq-question-${index}`">问题</label>
                <input
                  :id="`event-faq-question-${index}`"
                  v-model="item.question"
                  :disabled="!canManageExperience || !item.enabled"
                />
              </div>
              <div class="form-field full">
                <label :for="`event-faq-answer-${index}`">答案</label>
                <textarea
                  :id="`event-faq-answer-${index}`"
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
          <button class="button" type="submit" :disabled="pending">保存 FAQ 设置</button>
        </div>
      </form>
    </section>
  </div>

  <AdminConfirmDialog
    :open="showReplacementConfirm && Boolean(selectedReplacement)"
    :event-name="session.activeEvent.value?.name"
    :title="`确认应用“${selectedReplacement?.name ?? ''}”V${selectedReplacement?.currentVersion ?? ''}？`"
    description="保存成功后大会官网会立即使用新模板。能匹配的首页、FAQ 和报名流程设置继续保留，失去对应位置的设置会被移除。"
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

  <section v-if="showSaveAsTemplate" class="admin-panel template-replacement-confirm">
    <header class="admin-panel-header">
      <div>
        <p class="eyebrow">SAVE REUSABLE TEMPLATE</p>
        <h2>另存为共享模板</h2>
        <p>页面结构、FAQ 分类、报名流程和初始化策略会进入新的共享模板。</p>
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
          {{ pending ? '正在创建…' : '创建共享模板' }}
        </button>
      </div>
    </form>
  </section>
</template>
