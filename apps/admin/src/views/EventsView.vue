<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  EventShortSlugSchema,
  isPublicEventStatus,
  type ConferenceTemplateOption,
  type EventId,
  type EventSummary,
} from '@conference/contracts';
import { useRouter } from 'vue-router';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import { conferenceApi, publicEventHomeUrl, session } from '../lib/api';
import { dateTime, statusClass, statusLabel } from '../lib/format';
import { localDateTimeToIso } from '../lib/timezone';

const router = useRouter();
const rows = ref<EventSummary[]>([]);
const templates = ref<ConferenceTemplateOption[]>([]);
const loading = ref(true);
const preparingForm = ref(false);
const pending = ref(false);
const quickTemplatePending = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const showCreateForm = ref(false);
const showQuickTemplate = ref(false);
const homepageCandidate = ref<EventSummary>();
const homepagePending = ref(false);
const homepageError = ref('');
const copiedEventId = ref<EventId>();
const slugCandidate = ref<EventSummary>();
const slugDraft = ref('');
const slugPending = ref(false);
const slugAvailabilityPending = ref(false);
const slugAvailability = ref<boolean>();
const slugUpdateError = ref('');
const currentStep = ref(1);
const tagFilter = ref('');
const canCreateEvent = computed(() => session.canAll(['event.manage', 'org.template.use']));
const canCreateTemplate = computed(
  () => session.can('org.template.manage') && session.can('org.template.publish'),
);
const canManageHomepage = computed(() => session.can('org.settings.manage'));
const canManageEventUrl = computed(() => session.can('event.manage'));
const hasHomepageDefault = computed(() => rows.value.some((item) => item.isHomepageDefault));
const slugValidation = computed(() =>
  form.slug ? EventShortSlugSchema.safeParse(form.slug) : undefined,
);
const slugError = computed(() => {
  if (!slugValidation.value || slugValidation.value.success) return '';
  return slugValidation.value.error.issues[0]?.message ?? '大会路径不可用';
});
const createEventPublicUrl = computed(() =>
  slugValidation.value?.success ? publicEventHomeUrl(slugValidation.value.data) : '',
);
const slugEditValidation = computed(() => EventShortSlugSchema.safeParse(slugDraft.value));
const slugEditError = computed(() => {
  if (!slugCandidate.value || slugEditValidation.value.success) return '';
  return slugEditValidation.value.error.issues[0]?.message ?? '大会短地址不可用';
});
const slugEditPublicUrl = computed(() =>
  slugEditValidation.value.success ? publicEventHomeUrl(slugEditValidation.value.data) : '',
);
const availableTags = computed(() => [...new Set(templates.value.flatMap((item) => item.tags))]);
const filteredTemplates = computed(() =>
  templates.value.filter((item) => !tagFilter.value || item.tags.includes(tagFilter.value)),
);
const selectedTemplate = computed(() =>
  templates.value.find((item) => item.currentPublishedVersionId === form.templateVersionId),
);
const form = reactive({
  name: '',
  shortName: '',
  slug: '',
  startsAt: '2027-06-18T09:00',
  endsAt: '2027-06-19T18:00',
  timezone: 'Asia/Shanghai',
  venue: '',
  city: '深圳',
  address: '',
  templateVersionId: '',
});
const quickTemplateForm = reactive({
  name: '',
  description: '',
  tags: '',
  sourceTemplateVersionId: '',
});

function basicInformationValid() {
  try {
    return Boolean(
      form.name.trim().length >= 2 &&
      form.shortName.trim().length >= 2 &&
      (!form.slug || EventShortSlugSchema.safeParse(form.slug).success) &&
      form.startsAt &&
      form.endsAt &&
      form.timezone.trim() &&
      new Date(localDateTimeToIso(form.endsAt, form.timezone)) >
        new Date(localDateTimeToIso(form.startsAt, form.timezone)) &&
      form.city.trim() &&
      form.venue.trim() &&
      form.address.trim(),
    );
  } catch {
    return false;
  }
}

function eventPublicUrl(item: EventSummary) {
  return publicEventHomeUrl(item.slug) ?? '';
}

function homepageEligible(item: EventSummary) {
  return isPublicEventStatus(item.status) && Boolean(item.currentReleaseId);
}

function homepageDisabledReason(item: EventSummary) {
  if (!isPublicEventStatus(item.status)) return '大会需处于预发布、报名开放、进行中或已结束状态';
  if (!item.currentReleaseId) return '大会需先完成一次发布';
  return '';
}

function requestHomepageChange(item: EventSummary) {
  homepageCandidate.value = item;
  homepageError.value = '';
}

function requestSlugChange(item: EventSummary) {
  slugCandidate.value = item;
  slugDraft.value = item.slug;
  slugAvailability.value = undefined;
  slugUpdateError.value = '';
}

function cancelSlugChange() {
  if (slugPending.value) return;
  slugCandidate.value = undefined;
  slugDraft.value = '';
  slugAvailability.value = undefined;
  slugUpdateError.value = '';
}

async function checkSlugAvailability() {
  const candidate = slugCandidate.value;
  if (!candidate || !slugEditValidation.value.success) {
    slugAvailability.value = undefined;
    return false;
  }
  const checkedSlug = slugEditValidation.value.data;
  slugAvailabilityPending.value = true;
  slugUpdateError.value = '';
  try {
    const result = await conferenceApi.getEventSlugAvailability(checkedSlug, candidate.id);
    if (slugDraft.value === checkedSlug) slugAvailability.value = result.available;
    return result.available;
  } catch (error) {
    if (slugDraft.value === checkedSlug) {
      slugUpdateError.value = error instanceof Error ? error.message : '短地址检查失败';
      slugAvailability.value = undefined;
    }
    return false;
  } finally {
    slugAvailabilityPending.value = false;
  }
}

async function confirmSlugChange() {
  const candidate = slugCandidate.value;
  if (!candidate || !slugEditValidation.value.success) return;
  const nextSlug = slugEditValidation.value.data;
  if (nextSlug === candidate.slug) {
    cancelSlugChange();
    return;
  }
  if (!(await checkSlugAvailability())) return;
  slugPending.value = true;
  slugUpdateError.value = '';
  try {
    const result = await conferenceApi.updateEventSlug(candidate.id, nextSlug);
    const updated = { ...candidate, slug: result.slug };
    rows.value = rows.value.map((item) => (item.id === candidate.id ? updated : item));
    if (session.activeEventId.value === candidate.id) session.rememberEvent(updated);
    successMessage.value = `大会短地址已更新为 ${eventPublicUrl(updated)}，原地址将自动跳转。`;
    slugCandidate.value = undefined;
    slugDraft.value = '';
    slugAvailability.value = undefined;
  } catch (error) {
    slugUpdateError.value = error instanceof Error ? error.message : '大会短地址更新失败';
  } finally {
    slugPending.value = false;
  }
}

async function confirmHomepageChange() {
  const candidate = homepageCandidate.value;
  if (!candidate) return;
  homepagePending.value = true;
  homepageError.value = '';
  try {
    await conferenceApi.setOrganizationHomepageEvent(candidate.id);
    rows.value = rows.value.map((item) => ({
      ...item,
      isHomepageDefault: item.id === candidate.id,
    }));
    successMessage.value = `${candidate.name} 已设为首页默认大会，访问前台首页将展示该大会。`;
    homepageCandidate.value = undefined;
  } catch (error) {
    homepageError.value = error instanceof Error ? error.message : '首页默认大会设置失败';
  } finally {
    homepagePending.value = false;
  }
}

async function copyEventUrl(item: EventSummary) {
  errorMessage.value = '';
  const url = eventPublicUrl(item);
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const input = document.createElement('textarea');
    input.value = url;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) {
      errorMessage.value = '复制失败，请手动选择前台地址。';
      return;
    }
  }
  copiedEventId.value = item.id;
  window.setTimeout(() => {
    if (copiedEventId.value === item.id) copiedEventId.value = undefined;
  }, 1800);
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    rows.value = await conferenceApi.getEvents();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '大会列表读取失败';
  } finally {
    loading.value = false;
  }
}

async function openCreateForm() {
  showCreateForm.value = true;
  currentStep.value = 1;
  errorMessage.value = '';
  preparingForm.value = true;
  try {
    const templateOptions = await conferenceApi.getTemplateOptions();
    templates.value = templateOptions;
    form.timezone = 'Asia/Shanghai';
    form.templateVersionId = templateOptions[0]?.currentPublishedVersionId ?? '';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建大会配置读取失败';
  } finally {
    preparingForm.value = false;
  }
}

function closeCreateForm() {
  if (pending.value) return;
  showCreateForm.value = false;
  showQuickTemplate.value = false;
  errorMessage.value = '';
}

function nextStep() {
  errorMessage.value = '';
  if (currentStep.value === 1 && !basicInformationValid()) {
    errorMessage.value = '请完整填写基本信息，并确认结束时间晚于开始时间。';
    return;
  }
  if (currentStep.value === 2 && !form.templateVersionId) {
    errorMessage.value = '请选择一个已发布的大会模板版本。';
    return;
  }
  currentStep.value = Math.min(3, currentStep.value + 1);
}

function previousStep() {
  errorMessage.value = '';
  currentStep.value = Math.max(1, currentStep.value - 1);
}

function openQuickTemplate() {
  quickTemplateForm.sourceTemplateVersionId =
    form.templateVersionId ?? templates.value[0]?.currentPublishedVersionId ?? '';
  quickTemplateForm.name = form.name ? `${form.shortName || form.name} 模板` : '';
  quickTemplateForm.description = '从现有模板快速复制，供本场及后续大会复用。';
  quickTemplateForm.tags = selectedTemplate.value?.tags.join('、') ?? '';
  showQuickTemplate.value = true;
}

async function createQuickTemplate() {
  quickTemplatePending.value = true;
  errorMessage.value = '';
  try {
    const created = await conferenceApi.createConferenceTemplate({
      name: quickTemplateForm.name.trim(),
      description: quickTemplateForm.description.trim(),
      tags: quickTemplateForm.tags
        .split(/、|,|，/)
        .map((item) => item.trim())
        .filter(Boolean),
      ...(quickTemplateForm.sourceTemplateVersionId
        ? { sourceTemplateVersionId: quickTemplateForm.sourceTemplateVersionId }
        : {}),
      publishImmediately: true,
    });
    const option: ConferenceTemplateOption = {
      id: created.summary.id,
      name: created.summary.name,
      description: created.summary.description,
      tags: created.summary.tags,
      currentPublishedVersionId: created.summary.currentPublishedVersionId,
      currentVersion: created.summary.currentVersion,
      presentationKind: created.summary.presentationKind,
      previewAssetKey: created.summary.previewAssetKey,
      updatedAt: created.summary.updatedAt,
    };
    templates.value.unshift(option);
    form.templateVersionId = option.currentPublishedVersionId ?? '';
    showQuickTemplate.value = false;
    successMessage.value = `${option.name} V1 已创建并自动选中。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '快速创建模板失败';
  } finally {
    quickTemplatePending.value = false;
  }
}

async function createEvent() {
  pending.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const created = (await conferenceApi.createEvent({
      name: form.name.trim(),
      shortName: form.shortName.trim(),
      ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
      startsAt: localDateTimeToIso(form.startsAt, form.timezone),
      endsAt: localDateTimeToIso(form.endsAt, form.timezone),
      timezone: form.timezone,
      venue: form.venue.trim(),
      city: form.city.trim(),
      address: form.address.trim(),
      templateVersionId: form.templateVersionId,
    })) as { id: EventId; name: string };
    successMessage.value = `${created.name} 已创建，模板绑定、报名表、票种骨架和核销入口已初始化。`;
    await load();
    showCreateForm.value = false;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建大会失败';
  } finally {
    pending.value = false;
  }
}

function activate(item: EventSummary, routeName?: string) {
  session.rememberEvent(item);
  void router.push({
    name: routeName ?? session.eventLandingRouteName(),
    params: { eventId: item.id },
  });
}

onMounted(() => void load());
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">MULTI EVENT WORKSPACE</p>
      <h1>大会管理</h1>
      <p>创建和查找组织内的大会，并维护每场大会的模板绑定和发布状态。</p>
    </div>
    <span class="status-badge">{{ rows.length }} EVENTS</span>
  </header>
  <div v-if="session.entryNotice.value" class="admin-context-notice" role="status">
    <span>{{ session.entryNotice.value }}</span>
    <button type="button" aria-label="关闭提示" @click="session.entryNotice.value = ''">×</button>
  </div>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <p v-if="successMessage" class="admin-success" role="status">{{ successMessage }}</p>

  <div class="events-page-stack">
    <section v-if="!showCreateForm" class="admin-panel events-list-panel reveal is-visible">
      <header class="admin-panel-header">
        <div>
          <h2>大会列表</h2>
          <p>每一场大会拥有独立内容、业务数据和模板版本</p>
        </div>
        <button v-if="canCreateEvent" class="button" type="button" @click="openCreateForm">
          创建大会
        </button>
      </header>
      <div v-if="loading" class="admin-loading">正在读取大会列表…</div>
      <template v-else-if="rows.length">
        <p v-if="!hasHomepageDefault" class="event-homepage-warning" role="status">
          当前组织还没有首页默认大会。设置后，访问前台根地址会直接展示所选大会。
        </p>
        <ul class="operations-list event-management-list">
          <li v-for="item in rows" :key="item.id">
            <div class="event-management-copy">
              <div class="event-management-title">
                <strong>{{ item.name }}</strong>
                <span class="status-badge" :class="statusClass(item.status)">
                  {{ statusLabel(item.status) }}
                </span>
                <span v-if="item.isHomepageDefault" class="event-homepage-badge">首页默认</span>
              </div>
              <small>
                {{ item.city }} · {{ dateTime(item.startsAt) }} ·
                {{ item.registrationCount }} 人报名
              </small>
              <small class="event-template-line">
                模板：{{ item.templateName ?? '历史兼容模板' }}
                <template v-if="item.templateVersion"> · V{{ item.templateVersion }}</template>
                <b v-if="item.templateUpgradeAvailable" class="inline-warning">可升级</b>
              </small>
              <div class="event-public-url">
                <code>{{ eventPublicUrl(item) }}</code>
                <button type="button" @click="copyEventUrl(item)">
                  {{ copiedEventId === item.id ? '已复制' : '复制' }}
                </button>
                <a
                  v-if="isPublicEventStatus(item.status)"
                  :href="eventPublicUrl(item)"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  打开 ↗
                </a>
                <span v-else class="event-public-state">尚未公开</span>
                <button v-if="canManageEventUrl" type="button" @click="requestSlugChange(item)">
                  修改短地址
                </button>
              </div>
            </div>
            <div
              class="row-actions"
              :class="{ 'has-homepage-action': canManageHomepage && !item.isHomepageDefault }"
            >
              <button
                v-if="canManageHomepage && !item.isHomepageDefault"
                class="button secondary compact event-default-action"
                type="button"
                :disabled="!homepageEligible(item)"
                :title="homepageDisabledReason(item)"
                :aria-describedby="
                  !homepageEligible(item) ? `homepage-disabled-reason-${item.id}` : undefined
                "
                @click="requestHomepageChange(item)"
              >
                设为首页
              </button>
              <span
                v-if="canManageHomepage && !item.isHomepageDefault && !homepageEligible(item)"
                :id="`homepage-disabled-reason-${item.id}`"
                class="sr-only"
              >
                {{ homepageDisabledReason(item) }}
              </span>
              <button
                v-if="session.can('event.site.read')"
                class="button secondary compact event-template-action"
                type="button"
                @click="activate(item, 'event-settings-general')"
              >
                设置模板
              </button>
              <button
                class="button compact event-workspace-action"
                type="button"
                @click="activate(item)"
              >
                {{ item.id === session.activeEventId.value ? '继续管理' : '进入工作台' }}
              </button>
            </div>
          </li>
        </ul>
      </template>
      <div v-else class="admin-empty">当前组织还没有大会。创建大会时需要选择一个已发布模板。</div>
    </section>

    <section v-else class="admin-panel event-create-panel reveal is-visible">
      <header class="admin-panel-header">
        <div>
          <h2>创建大会</h2>
          <p>选择不可变模板版本，初始化大会内容与报名流程</p>
        </div>
        <button class="button secondary" type="button" :disabled="pending" @click="closeCreateForm">
          返回大会列表
        </button>
      </header>

      <ol class="create-stepper" aria-label="创建大会步骤">
        <li :class="{ active: currentStep === 1, complete: currentStep > 1 }">
          <span>1</span><b>基本信息</b>
        </li>
        <li :class="{ active: currentStep === 2, complete: currentStep > 2 }">
          <span>2</span><b>选择模板</b>
        </li>
        <li :class="{ active: currentStep === 3 }"><span>3</span><b>确认创建</b></li>
      </ol>

      <div v-if="preparingForm" class="admin-loading">正在准备大会模板…</div>
      <form v-else class="event-form event-create-workflow" @submit.prevent="createEvent">
        <div v-if="currentStep === 1" class="form-grid">
          <div class="form-field">
            <label for="event-name">大会名称</label>
            <input id="event-name" v-model="form.name" required minlength="2" />
          </div>
          <div class="form-field">
            <label for="event-short">后台简称</label>
            <input id="event-short" v-model="form.shortName" required minlength="2" />
          </div>
          <div class="form-field full">
            <label for="event-slug">前台路径</label>
            <input
              id="event-slug"
              v-model="form.slug"
              minlength="3"
              maxlength="24"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="例如 geo26；留空自动生成"
              :aria-invalid="Boolean(slugError)"
            />
            <small v-if="slugError" class="form-field-error">{{ slugError }}</small>
            <small v-else-if="createEventPublicUrl">独立前台地址：{{ createEventPublicUrl }}</small>
            <small v-else>留空后系统会生成 7 位以内的一级短地址，创建后仍可修改。</small>
          </div>
          <div class="form-field">
            <label for="event-start">开始时间</label>
            <input id="event-start" v-model="form.startsAt" type="datetime-local" required />
          </div>
          <div class="form-field">
            <label for="event-end">结束时间</label>
            <input id="event-end" v-model="form.endsAt" type="datetime-local" required />
          </div>
          <div class="form-field full">
            <label for="event-timezone">大会时区</label>
            <input
              id="event-timezone"
              v-model="form.timezone"
              list="event-timezone-options"
              required
              placeholder="Asia/Shanghai"
            />
            <datalist id="event-timezone-options">
              <option value="Asia/Shanghai" />
              <option value="Asia/Hong_Kong" />
              <option value="Asia/Tokyo" />
              <option value="Europe/London" />
              <option value="America/New_York" />
            </datalist>
            <small>开始与结束时间会按此时区保存和发布。</small>
          </div>
          <div class="form-field">
            <label for="event-city">城市</label>
            <input id="event-city" v-model="form.city" required />
          </div>
          <div class="form-field">
            <label for="event-venue">场馆</label>
            <input id="event-venue" v-model="form.venue" required />
          </div>
          <div class="form-field full">
            <label for="event-address">详细地址</label>
            <input id="event-address" v-model="form.address" required />
          </div>
        </div>

        <div v-else-if="currentStep === 2" class="template-selection-step">
          <div class="template-selection-toolbar">
            <label class="admin-select-label">
              <span>适用标签</span>
              <select v-model="tagFilter" class="admin-select">
                <option value="">全部模板</option>
                <option v-for="tag in availableTags" :key="tag" :value="tag">{{ tag }}</option>
              </select>
            </label>
            <button
              v-if="canCreateTemplate"
              class="button secondary"
              type="button"
              @click="openQuickTemplate"
            >
              新建模板
            </button>
          </div>
          <div v-if="filteredTemplates.length" class="template-option-list">
            <label
              v-for="item in filteredTemplates"
              :key="item.id"
              class="template-option-row"
              :class="{ selected: form.templateVersionId === item.currentPublishedVersionId }"
            >
              <input
                v-model="form.templateVersionId"
                type="radio"
                :value="item.currentPublishedVersionId ?? ''"
              />
              <span class="template-option-preview" aria-hidden="true">TokEMS</span>
              <span>
                <strong>{{ item.name }}</strong>
                <small>{{ item.description }}</small>
                <em>
                  V{{ item.currentVersion }} · {{ item.tags.join(' / ') || '通用模板' }} ·
                  {{ dateTime(item.updatedAt) }}
                </em>
              </span>
              <b>使用此模板</b>
            </label>
          </div>
          <div v-else class="admin-empty">当前筛选下没有可用模板。</div>
        </div>

        <div v-else class="creation-confirmation">
          <section>
            <h3>{{ form.name }}</h3>
            <p>
              {{ form.city }} · {{ form.venue }} · {{ form.startsAt.replace('T', ' ') }}（{{
                form.timezone
              }}）
            </p>
          </section>
          <section>
            <span>绑定模板</span>
            <strong>{{ selectedTemplate?.name }} · V{{ selectedTemplate?.currentVersion }}</strong>
            <p>{{ selectedTemplate?.description }}</p>
          </section>
          <div class="initialization-groups">
            <div>
              <b>复制</b>
              <p>首页结构、FAQ 骨架、报名表字段、条款和票种骨架</p>
            </div>
            <div>
              <b>重置</b>
              <p>库存销量、发布状态、报名开放状态和运营统计</p>
            </div>
            <div>
              <b>保持独立</b>
              <p>报名、订单、发票、签到和大会后续内容修改</p>
            </div>
          </div>
        </div>

        <aside v-if="showQuickTemplate" class="quick-template-drawer" aria-label="快速新建模板">
          <header>
            <div>
              <p class="eyebrow">QUICK TEMPLATE</p>
              <h3>新建并发布模板 V1</h3>
            </div>
            <button
              class="button secondary compact"
              type="button"
              @click="showQuickTemplate = false"
            >
              关闭
            </button>
          </header>
          <div class="form-field">
            <label for="quick-template-name">模板名称</label>
            <input id="quick-template-name" v-model="quickTemplateForm.name" required />
          </div>
          <div class="form-field">
            <label for="quick-template-description">适用场景</label>
            <textarea
              id="quick-template-description"
              v-model="quickTemplateForm.description"
              rows="4"
              required
            />
          </div>
          <div class="form-field">
            <label for="quick-template-tags">标签</label>
            <input
              id="quick-template-tags"
              v-model="quickTemplateForm.tags"
              placeholder="行业峰会、品牌大会"
            />
          </div>
          <div class="form-field">
            <label for="quick-template-source">复制来源</label>
            <select id="quick-template-source" v-model="quickTemplateForm.sourceTemplateVersionId">
              <option
                v-for="item in templates"
                :key="item.id"
                :value="item.currentPublishedVersionId ?? ''"
              >
                {{ item.name }} · V{{ item.currentVersion }}
              </option>
            </select>
          </div>
          <button
            class="button"
            type="button"
            :disabled="quickTemplatePending"
            @click="createQuickTemplate"
          >
            {{ quickTemplatePending ? '正在创建…' : '创建模板并自动选中' }}
          </button>
        </aside>

        <div class="event-form-actions event-create-actions">
          <button
            v-if="currentStep > 1"
            class="button secondary"
            type="button"
            :disabled="pending"
            @click="previousStep"
          >
            上一步
          </button>
          <button
            v-if="currentStep < 3"
            class="button"
            type="button"
            :disabled="pending"
            @click="nextStep"
          >
            下一步
          </button>
          <button v-else class="button" type="submit" :disabled="pending">
            {{ pending ? '正在创建…' : '创建大会项目' }}
          </button>
        </div>
      </form>
    </section>
  </div>

  <AdminConfirmDialog
    :open="Boolean(homepageCandidate)"
    title="确认切换首页默认大会？"
    description="切换后，组织前台根地址会立即展示所选大会；每场大会原有的独立地址保持可访问。"
    confirm-label="确认设为首页"
    :busy="homepagePending"
    :error="homepageError"
    :details="
      homepageCandidate
        ? [
          { label: '默认大会', value: homepageCandidate.name },
          { label: '独立地址', value: eventPublicUrl(homepageCandidate) },
        ]
        : []
    "
    @cancel="homepageCandidate = undefined"
    @confirm="confirmHomepageChange"
  />

  <AdminConfirmDialog
    :open="Boolean(slugCandidate)"
    title="修改大会短地址"
    description="保存后，新地址立即成为规范地址；旧地址会使用 308 永久跳转并继续兼容历史链接。"
    confirm-label="保存短地址"
    :busy="slugPending"
    :confirm-disabled="
      Boolean(slugEditError) || slugAvailability === false || slugAvailabilityPending
    "
    :error="slugUpdateError"
    :details="
      slugCandidate
        ? [
          { label: '原地址', value: eventPublicUrl(slugCandidate) },
          { label: '新地址', value: slugEditPublicUrl || '请输入有效短地址' },
        ]
        : []
    "
    @cancel="cancelSlugChange"
    @confirm="confirmSlugChange"
  >
    <label class="event-slug-editor">
      <span>一级短地址</span>
      <span class="event-slug-editor__control">
        <b>/</b>
        <input
          v-model.trim="slugDraft"
          maxlength="24"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          autocomplete="off"
          spellcheck="false"
          @input="slugAvailability = undefined"
          @blur="checkSlugAvailability"
        />
      </span>
      <small v-if="slugEditError" class="form-field-error">{{ slugEditError }}</small>
      <small v-else-if="slugAvailabilityPending">正在检查地址…</small>
      <small v-else-if="slugAvailability === true" class="event-slug-available">该短地址可用</small>
      <small v-else-if="slugAvailability === false" class="form-field-error">该短地址已被占用</small>
      <small v-else>3–24 位小写字母、数字或连字符，推荐 4–12 位。</small>
    </label>
  </AdminConfirmDialog>
</template>
