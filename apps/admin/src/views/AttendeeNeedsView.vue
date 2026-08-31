<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  ATTENDEE_NEED_TOPIC_OPTIONS,
  type AttendeeNeedTagCode,
  type AdminAttendeeNeedListQuery,
  type ModerateAttendeeNeedQuestion,
} from '@conference/contracts';
import {
  conferenceApi,
  session,
  type AdminAttendeeNeedItem,
  type AdminAttendeeNeedList,
} from '../lib/api';
import { dateTime } from '../lib/format';

const route = useRoute();
const canManage = computed(() => session.can('event.registration.manage'));
const canExport = computed(() => session.can('event.registration.export'));
const list = ref<AdminAttendeeNeedList>();
const selected = ref<AdminAttendeeNeedItem>();
const query = ref('');
const tag = ref<AttendeeNeedTagCode | ''>('');
const visibility = ref<NonNullable<AdminAttendeeNeedListQuery['visibility']> | ''>('');
const moderationStatus = ref<NonNullable<AdminAttendeeNeedListQuery['moderationStatus']> | ''>('');
const submittedFrom = ref('');
const submittedTo = ref('');
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const saving = ref(false);
const exporting = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const editContent = ref('');
const editTagCodes = ref<AttendeeNeedTagCode[]>([]);
const operationReason = ref('');
const detailPanel = ref<HTMLElement>();
const listHeading = ref<HTMLElement>();
let detailTrigger: HTMLElement | undefined;
let loadRequestId = 0;

const topicLabels = new Map<string, string>(
  ATTENDEE_NEED_TOPIC_OPTIONS.map((item) => [item.code, item.label]),
);
const lifecycleLabels: Record<string, string> = {
  confirmed: '报名成功',
  checked_in: '已签到',
  completed: '已完成',
  cancelled: '已取消',
  paid: '已支付',
  partially_refunded: '部分退款',
  refunded: '已退款',
  valid: '有效',
  used: '已使用',
  void: '已作废',
};
const totalPages = computed(() => list.value?.totalPages ?? 1);
const summaryItems = computed(() => [
  { label: '提交人数', value: list.value?.counts.submitters },
  { label: '问题总数', value: list.value?.counts.total, emphasis: true },
  { label: '用户公开', value: list.value?.counts.public },
  { label: '匿名公开', value: list.value?.counts.anonymous },
  { label: '后台隐藏', value: list.value?.counts.hidden },
  { label: '软删除', value: list.value?.counts.deleted },
]);
const filters = computed<Partial<AdminAttendeeNeedListQuery>>(() => ({
  ...(query.value.trim() ? { query: query.value.trim() } : {}),
  ...(tag.value ? { tag: tag.value } : {}),
  ...(visibility.value ? { visibility: visibility.value } : {}),
  ...(moderationStatus.value ? { moderationStatus: moderationStatus.value } : {}),
  ...(submittedFrom.value
    ? { submittedFrom: new Date(`${submittedFrom.value}T00:00:00`).toISOString() }
    : {}),
  ...(submittedTo.value
    ? { submittedTo: new Date(`${submittedTo.value}T23:59:59.999`).toISOString() }
    : {}),
}));
const selectedDirty = computed(
  () =>
    Boolean(selected.value) &&
    (editContent.value.trim() !== selected.value!.content ||
      JSON.stringify(editTagCodes.value) !== JSON.stringify(selected.value!.tagCodes)),
);

function statusText(item: AdminAttendeeNeedItem) {
  if (item.deleted) return item.deletedByType === 'admin' ? '管理员已删除' : '用户已删除';
  if (item.adminHidden) return '已隐藏';
  if (item.effectivePublic) return item.isAnonymous ? '匿名公开' : '实名公开';
  if (item.isPublic) return '资格失效';
  return '仅自己可见';
}

function statusTone(item: AdminAttendeeNeedItem) {
  if (item.deleted) return 'muted';
  if (item.adminHidden) return 'warning';
  if (item.effectivePublic) return 'success';
  return 'neutral';
}

function editFromItem(item: AdminAttendeeNeedItem, preserveMessages = false) {
  if (!preserveMessages && document.activeElement instanceof HTMLElement) {
    detailTrigger = document.activeElement;
  }
  selected.value = item;
  editContent.value = item.content;
  editTagCodes.value = item.tagCodes.filter((code): code is AttendeeNeedTagCode =>
    ATTENDEE_NEED_TOPIC_OPTIONS.some((topic) => topic.code === code),
  );
  operationReason.value = '';
  if (!preserveMessages) {
    successMessage.value = '';
    errorMessage.value = '';
    void nextTick(() => {
      const panel = detailPanel.value;
      if (window.matchMedia('(max-width: 1580px)').matches) {
        panel?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
          block: 'start',
        });
      }
      panel?.focus({ preventScroll: true });
    });
  }
}

function closeDetail() {
  selected.value = undefined;
  void nextTick(() => {
    const returnTarget = detailTrigger?.isConnected ? detailTrigger : listHeading.value;
    returnTarget?.focus();
    detailTrigger = undefined;
  });
}

function detailOwnsFocus() {
  return (
    document.activeElement === document.body ||
    Boolean(detailPanel.value?.contains(document.activeElement))
  );
}

function activeDetailControl() {
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement && detailPanel.value?.contains(activeElement)
    ? activeElement
    : undefined;
}

async function restoreFailedDetailFocus(questionId: string, trigger?: HTMLElement) {
  await nextTick();
  if (selected.value?.id !== questionId || !detailOwnsFocus()) return;
  const returnTarget = trigger?.isConnected ? trigger : detailPanel.value;
  returnTarget?.focus({ preventScroll: true });
}

function toggleTag(code: AttendeeNeedTagCode) {
  if (editTagCodes.value.includes(code)) {
    editTagCodes.value = editTagCodes.value.filter((item) => item !== code);
    return;
  }
  if (editTagCodes.value.length < 3) editTagCodes.value.push(code);
}

async function loadList() {
  const current = ++loadRequestId;
  loading.value = true;
  errorMessage.value = '';
  try {
    const result = await conferenceApi.getAttendeeNeeds({
      ...filters.value,
      page: page.value,
      pageSize,
    });
    if (current !== loadRequestId) return;
    list.value = result;
    page.value = result.page;
    if (selected.value) {
      const refreshed = result.items.find((item) => item.id === selected.value?.id);
      const hasLocalDraft = selectedDirty.value || Boolean(operationReason.value.trim());
      if (refreshed && !hasLocalDraft) editFromItem(refreshed, true);
    }
  } catch (error) {
    if (current === loadRequestId) {
      errorMessage.value = error instanceof Error ? error.message : '参会需求读取失败';
    }
  } finally {
    if (current === loadRequestId) loading.value = false;
  }
}

function applyFilters() {
  page.value = 1;
  selected.value = undefined;
  void loadList();
}

function resetFilters() {
  query.value = '';
  tag.value = '';
  visibility.value = '';
  moderationStatus.value = '';
  submittedFrom.value = '';
  submittedTo.value = '';
  applyFilters();
}

function changePage(next: number) {
  page.value = Math.min(Math.max(1, next), totalPages.value);
  selected.value = undefined;
  void loadList();
}

async function saveEdit() {
  if (!selected.value || !selectedDirty.value || !canManage.value) return;
  const contentLength = Array.from(editContent.value.trim()).length;
  if (contentLength < 5 || contentLength > 200) {
    errorMessage.value = '问题正文需要保持在 5 至 200 个字符';
    return;
  }
  if (editTagCodes.value.length < 1 || editTagCodes.value.length > 3) {
    errorMessage.value = '每个问题需要选择 1 至 3 个主题标签';
    return;
  }
  if (!operationReason.value.trim()) {
    errorMessage.value = '管理员修改用户原话时需要填写调整原因';
    return;
  }
  const questionId = selected.value.id;
  const requestTrigger = activeDetailControl();
  let requestFailed = false;
  saving.value = true;
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.updateAttendeeNeed(questionId, {
      version: selected.value.version,
      content: editContent.value.trim(),
      tagCodes: editTagCodes.value,
      reason: operationReason.value.trim(),
    });
    const restoreDetailFocus = detailOwnsFocus();
    if (selected.value?.id === questionId) editFromItem(updated, true);
    successMessage.value = '问题信息已更新，用户端会显示调整提示。';
    await loadList();
    if (selected.value?.id === questionId && restoreDetailFocus && detailOwnsFocus()) {
      await nextTick();
      detailPanel.value?.focus({ preventScroll: true });
    }
  } catch (error) {
    requestFailed = true;
    errorMessage.value = error instanceof Error ? error.message : '参会问题保存失败';
  } finally {
    saving.value = false;
    if (requestFailed) await restoreFailedDetailFocus(questionId, requestTrigger);
  }
}

async function moderate(action: ModerateAttendeeNeedQuestion['action']) {
  if (!selected.value || !canManage.value) return;
  if (['hide', 'delete'].includes(action) && !operationReason.value.trim()) {
    errorMessage.value = '隐藏或删除问题时需要填写原因';
    return;
  }
  if (action === 'delete' && !window.confirm('确认软删除这个问题？删除后可以由管理员恢复。')) {
    return;
  }
  if (action === 'anonymize' && !window.confirm('确认将这位参会者提交的全部问题改为匿名展示？')) {
    return;
  }
  const questionId = selected.value.id;
  const requestTrigger = activeDetailControl();
  let requestFailed = false;
  saving.value = true;
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.moderateAttendeeNeed(questionId, {
      version: selected.value.version,
      action,
      reason: operationReason.value.trim() || null,
    });
    const restoreDetailFocus = detailOwnsFocus();
    if (selected.value?.id === questionId) editFromItem(updated, true);
    successMessage.value = '治理状态已更新。';
    await loadList();
    if (selected.value?.id === questionId && restoreDetailFocus && detailOwnsFocus()) {
      await nextTick();
      detailPanel.value?.focus({ preventScroll: true });
    }
  } catch (error) {
    requestFailed = true;
    errorMessage.value = error instanceof Error ? error.message : '治理操作失败';
  } finally {
    saving.value = false;
    if (requestFailed) await restoreFailedDetailFocus(questionId, requestTrigger);
  }
}

async function exportCsv(variant: 'speaker' | 'internal') {
  if (!canExport.value || exporting.value) return;
  exporting.value = true;
  errorMessage.value = '';
  try {
    const count = await conferenceApi.exportAttendeeNeeds(
      variant,
      variant === 'speaker',
      filters.value,
    );
    successMessage.value = `已导出 ${count} 条${variant === 'speaker' ? '嘉宾版' : '内部运营版'}问题。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '参会需求导出失败';
  } finally {
    exporting.value = false;
  }
}

watch(
  () => route.params.eventId,
  () => {
    page.value = 1;
    selected.value = undefined;
    void loadList();
  },
  { immediate: true },
);
</script>

<template>
  <header class="admin-page-head needs-page-head reveal is-visible">
    <div>
      <p class="eyebrow">ATTENDEE INSIGHTS</p>
      <h1>参会需求</h1>
      <p>查看参会者最关心的问题，完成内容治理，并导出给相关嘉宾。</p>
    </div>
    <div class="admin-head-actions needs-page-actions">
      <button class="button secondary" type="button" :disabled="loading" @click="loadList">
        {{ loading ? '正在刷新…' : '刷新数据' }}
      </button>
      <div v-if="canExport" class="needs-export-actions" aria-label="导出参会需求">
        <button
          class="button secondary"
          type="button"
          :disabled="exporting"
          @click="exportCsv('speaker')"
        >
          导出嘉宾版
        </button>
        <button
          class="button subtle"
          type="button"
          :disabled="exporting"
          @click="exportCsv('internal')"
        >
          导出内部版
        </button>
      </div>
    </div>
  </header>

  <div class="needs-notices">
    <p v-if="errorMessage && list" class="admin-error" role="alert">{{ errorMessage }}</p>
    <p v-if="successMessage" class="admin-success" role="status">{{ successMessage }}</p>
  </div>

  <section class="needs-stats" aria-label="参会需求统计" :aria-busy="loading">
    <div v-for="item in summaryItems" :key="item.label" :class="{ emphasis: item.emphasis }">
      <span>{{ item.label }}</span>
      <strong>{{ item.value ?? '--' }}</strong>
    </div>
  </section>

  <form class="needs-toolbar" role="search" @submit.prevent="applyFilters">
    <div class="needs-toolbar-primary">
      <label class="admin-search">
        <span aria-hidden="true">⌕</span>
        <input
          v-model="query"
          type="search"
          aria-label="搜索参会需求"
          placeholder="搜索问题、报名姓名、署名或报名编号"
        />
      </label>
      <select v-model="tag" class="admin-select" aria-label="按主题筛选">
        <option value="">全部主题</option>
        <option v-for="topic in ATTENDEE_NEED_TOPIC_OPTIONS" :key="topic.code" :value="topic.code">
          {{ topic.label }}
        </option>
      </select>
      <select v-model="visibility" class="admin-select" aria-label="按公开状态筛选">
        <option value="">全部公开状态</option>
        <option value="public">用户允许公开</option>
        <option value="private">仅自己可见</option>
        <option value="anonymous">匿名</option>
        <option value="named">实名</option>
        <option value="ineligible">资格失效</option>
      </select>
      <select v-model="moderationStatus" class="admin-select" aria-label="按治理状态筛选">
        <option value="">全部治理状态</option>
        <option value="visible">正常</option>
        <option value="hidden">后台隐藏</option>
        <option value="deleted">已删除</option>
      </select>
    </div>
    <div class="needs-toolbar-secondary">
      <div class="needs-date-range" role="group" aria-labelledby="needs-date-range-label">
        <span id="needs-date-range-label" class="needs-filter-label">提交时间</span>
        <label>
          <span class="sr-only">提交开始日期</span>
          <input v-model="submittedFrom" type="date" aria-label="提交开始日期" />
        </label>
        <span class="needs-date-separator" aria-hidden="true">至</span>
        <label>
          <span class="sr-only">提交结束日期</span>
          <input v-model="submittedTo" type="date" aria-label="提交结束日期" />
        </label>
      </div>
      <div class="needs-toolbar-actions">
        <button class="button secondary" type="submit">查询</button>
        <button class="button subtle" type="button" @click="resetFilters">重置</button>
      </div>
    </div>
  </form>

  <div class="needs-workspace">
    <section class="admin-panel needs-list-panel reveal is-visible">
      <header class="admin-panel-header needs-list-head">
        <div>
          <p class="eyebrow">QUESTION QUEUE</p>
          <h2 ref="listHeading" tabindex="-1">需求列表</h2>
          <p>按提交时间倒序展示，打开问题后可在右侧完成内容治理。</p>
        </div>
        <span class="needs-list-state">
          {{ loading ? '正在更新…' : list ? `本页 ${list.items.length} 条` : '等待载入' }}
        </span>
      </header>
      <div class="data-table-wrap">
        <table class="data-table needs-table" :aria-busy="loading">
          <caption class="sr-only">
            大会参会需求
          </caption>
          <thead>
            <tr>
              <th>问题</th>
              <th>参会者</th>
              <th>公开状态</th>
              <th>提交时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading && !list" class="needs-state-row">
              <td colspan="5">
                <div class="needs-table-state">
                  <strong>正在读取参会需求</strong>
                  <span>统计和问题列表将在请求完成后显示。</span>
                </div>
              </td>
            </tr>
            <tr v-else-if="errorMessage && !list" class="needs-state-row">
              <td colspan="5">
                <div class="needs-table-state error">
                  <strong>参会需求暂未载入</strong>
                  <span>{{ errorMessage }}</span>
                  <button class="button secondary compact" type="button" @click="loadList">
                    重新加载
                  </button>
                </div>
              </td>
            </tr>
            <tr v-else-if="!list?.items.length" class="needs-state-row">
              <td colspan="5">
                <div class="needs-table-state">
                  <strong>当前没有匹配的参会需求</strong>
                  <span>可以调整主题、公开状态、治理状态或提交时间后重新查询。</span>
                </div>
              </td>
            </tr>
            <template v-else>
              <tr v-for="item in list?.items ?? []" :key="item.id">
                <td>
                  <strong class="need-question-copy">{{ item.content }}</strong>
                  <span class="need-tag-line">
                    {{ item.tagCodes.map((code) => topicLabels.get(code) ?? code).join(' · ') }}
                  </span>
                </td>
                <td>
                  <span class="row-title">{{ item.attendeeName }}</span>
                  <span class="row-sub mono-code">{{ item.registrationCode }}</span>
                </td>
                <td>
                  <span class="need-status" :data-tone="statusTone(item)">{{
                    statusText(item)
                  }}</span>
                </td>
                <td>{{ dateTime(item.createdAt) }}</td>
                <td>
                  <button
                    class="button secondary compact"
                    type="button"
                    @click="editFromItem(item)"
                  >
                    查看处理
                  </button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <footer v-if="list" class="table-footer needs-pagination">
        <span>共 {{ list?.total ?? 0 }} 条 · 第 {{ page }} / {{ totalPages }} 页</span>
        <nav aria-label="参会需求分页">
          <button type="button" :disabled="page <= 1 || loading" @click="changePage(page - 1)">
            上一页
          </button>
          <button
            type="button"
            :disabled="page >= totalPages || loading"
            @click="changePage(page + 1)"
          >
            下一页
          </button>
        </nav>
      </footer>
    </section>

    <aside
      v-if="selected"
      ref="detailPanel"
      class="admin-panel need-detail-panel"
      aria-labelledby="need-detail-title"
      tabindex="-1"
    >
      <header class="need-detail-head">
        <div>
          <p class="eyebrow">QUESTION DETAIL</p>
          <h2 id="need-detail-title">问题处理</h2>
        </div>
        <button type="button" aria-label="关闭问题详情" @click="closeDetail">×</button>
      </header>

      <dl class="need-detail-facts">
        <div>
          <dt>报名人</dt>
          <dd>{{ selected.attendeeName }}</dd>
        </div>
        <div>
          <dt>报名编号</dt>
          <dd class="mono-code">{{ selected.registrationCode }}</dd>
        </div>
        <div>
          <dt>用户选择</dt>
          <dd>{{ selected.isPublic ? '允许公开' : '仅自己可见' }}</dd>
        </div>
        <div>
          <dt>署名方式</dt>
          <dd>{{ selected.isAnonymous ? '匿名' : selected.attributionName }}</dd>
        </div>
        <div>
          <dt>报名 / 订单</dt>
          <dd>
            {{ lifecycleLabels[selected.registrationStatus] ?? selected.registrationStatus }} /
            {{ lifecycleLabels[selected.orderStatus] ?? selected.orderStatus }}
          </dd>
        </div>
        <div>
          <dt>电子票</dt>
          <dd>
            {{
              selected.ticketStatus
                ? (lifecycleLabels[selected.ticketStatus] ?? selected.ticketStatus)
                : '未签发'
            }}
          </dd>
        </div>
        <div>
          <dt>提交时间</dt>
          <dd>{{ dateTime(selected.createdAt) }}</dd>
        </div>
        <div>
          <dt>最近更新</dt>
          <dd>{{ dateTime(selected.updatedAt) }}</dd>
        </div>
      </dl>

      <label class="need-edit-field">
        <span>问题正文</span>
        <textarea
          v-model="editContent"
          rows="6"
          :disabled="saving || !canManage || selected.deleted"
        />
        <small>{{ Array.from(editContent.trim()).length }} / 200</small>
      </label>

      <fieldset class="need-topic-editor" :disabled="saving || !canManage || selected.deleted">
        <legend>主题标签，选择 1 至 3 个</legend>
        <label
          v-for="topic in ATTENDEE_NEED_TOPIC_OPTIONS"
          :key="topic.code"
          :class="{ selected: editTagCodes.includes(topic.code) }"
        >
          <input
            type="checkbox"
            :checked="editTagCodes.includes(topic.code)"
            :disabled="!editTagCodes.includes(topic.code) && editTagCodes.length >= 3"
            @change="toggleTag(topic.code)"
          />
          {{ topic.label }}
        </label>
      </fieldset>

      <label v-if="canManage" class="need-edit-field">
        <span>处理原因</span>
        <textarea
          v-model="operationReason"
          rows="3"
          maxlength="500"
          :disabled="saving"
          placeholder="修改、隐藏或删除时说明原因，用户可见相关提示。"
        />
      </label>

      <div v-if="canManage" class="need-detail-actions">
        <button
          class="button primary"
          type="button"
          :disabled="saving || !selectedDirty || selected.deleted"
          @click="saveEdit"
        >
          保存问题信息
        </button>
        <button
          v-if="!selected.adminHidden && !selected.deleted"
          class="button secondary"
          type="button"
          :disabled="saving"
          @click="moderate('hide')"
        >
          隐藏
        </button>
        <button
          v-if="selected.adminHidden && !selected.deleted"
          class="button secondary"
          type="button"
          :disabled="saving"
          @click="moderate('restore')"
        >
          恢复展示
        </button>
        <button
          v-if="!selected.isAnonymous && !selected.deleted"
          class="button secondary"
          type="button"
          :disabled="saving"
          @click="moderate('anonymize')"
        >
          全部问题改为匿名
        </button>
        <button
          v-if="!selected.deleted"
          class="button danger"
          type="button"
          :disabled="saving"
          @click="moderate('delete')"
        >
          删除问题
        </button>
        <button
          v-if="selected.deleted && selected.deletedByType === 'admin'"
          class="button secondary"
          type="button"
          :disabled="saving"
          @click="moderate('restore-delete')"
        >
          恢复删除
        </button>
      </div>

      <p v-if="selected.qualificationReason" class="need-detail-note">
        当前展示说明：{{ selected.qualificationReason }}
      </p>
      <p v-if="selected.adminEditReason" class="need-detail-note">
        最近调整原因：{{ selected.adminEditReason }}
      </p>
    </aside>
  </div>
</template>

<style scoped>
.needs-page-head {
  align-items: flex-end;
}

.needs-stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin-bottom: 18px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
}

.needs-stats > div {
  display: grid;
  gap: 7px;
  padding: 18px;
  border-right: 1px solid var(--line);
}

.needs-stats > div:last-child {
  border-right: 0;
}

.needs-stats span {
  color: var(--muted);
  font-size: 11px;
}

.needs-stats strong {
  color: var(--ink);
  font-size: 25px;
  font-variant-numeric: tabular-nums;
}

.needs-toolbar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) repeat(3, minmax(135px, 0.6fr));
  gap: 10px;
  margin-bottom: 18px;
}

.needs-date-range {
  display: flex;
  align-items: center;
  gap: 8px;
}

.needs-date-range label {
  display: grid;
  gap: 4px;
  color: var(--muted);
  font-size: 10px;
}

.needs-date-range input {
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #fff;
  color: var(--ink);
  font: inherit;
}

.needs-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
}

.needs-workspace:has(.need-detail-panel) {
  grid-template-columns: minmax(0, 1.35fr) minmax(360px, 0.65fr);
}

.need-question-copy {
  display: block;
  max-width: 620px;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.need-tag-line {
  display: block;
  margin-top: 6px;
  color: var(--muted);
  font-size: 11px;
}

.need-status {
  display: inline-flex;
  padding: 5px 8px;
  border-radius: 999px;
  background: #eef1f5;
  color: #526075;
  font-size: 11px;
  font-weight: 700;
}

.need-status[data-tone='success'] {
  background: #e8f7ef;
  color: #16734b;
}

.need-status[data-tone='warning'] {
  background: #fff2db;
  color: #8a570b;
}

.need-status[data-tone='muted'] {
  opacity: 0.62;
}

.need-detail-panel {
  align-self: start;
  padding: 24px;
  scroll-margin-top: 86px;
}

.need-detail-panel:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.need-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
}

.need-detail-head h2 {
  margin: 4px 0 0;
}

.need-detail-head > button {
  width: 40px;
  height: 40px;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 22px;
}

.need-detail-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin: 20px 0;
}

.need-detail-facts div {
  min-width: 0;
}

.need-detail-facts dt {
  color: var(--muted);
  font-size: 10px;
}

.need-detail-facts dd {
  margin: 5px 0 0;
  color: var(--ink);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.need-edit-field {
  display: grid;
  gap: 8px;
  margin-top: 18px;
}

.need-edit-field > span,
.need-topic-editor legend {
  color: var(--ink);
  font-size: 12px;
  font-weight: 750;
}

.need-edit-field textarea,
.need-edit-field input {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  line-height: 1.65;
  resize: vertical;
}

.need-edit-field small {
  justify-self: end;
  color: var(--muted);
  font-size: 10px;
}

.need-topic-editor {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin: 18px 0 0;
  padding: 0;
  border: 0;
}

.need-topic-editor legend {
  width: 100%;
  margin-bottom: 2px;
}

.need-topic-editor label {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
}

.need-topic-editor label.selected {
  border-color: #3468da;
  background: #edf3ff;
  color: #2456bf;
  font-weight: 700;
}

.need-topic-editor input {
  position: absolute;
  opacity: 0;
}

.need-topic-editor label:active,
.need-detail-head > button:active {
  transform: scale(0.97);
}

.need-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 22px;
}

.need-detail-note {
  margin: 14px 0 0;
  padding: 11px 12px;
  border-radius: 7px;
  background: #fff6e8;
  color: #76501a;
  font-size: 11px;
  line-height: 1.6;
}

@media (max-width: 1580px) {
  .needs-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .needs-stats > div:nth-child(3) {
    border-right: 0;
  }
  .needs-stats > div:nth-child(-n + 3) {
    border-bottom: 1px solid var(--line);
  }
  .needs-workspace:has(.need-detail-panel) {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 820px) {
  .needs-toolbar {
    grid-template-columns: 1fr 1fr;
  }
  .needs-toolbar .admin-search {
    grid-column: 1 / -1;
  }
  .needs-date-range {
    grid-column: 1 / -1;
  }
}

/* Page composition: compact editorial operations surface. */
.needs-page-head {
  margin-bottom: 20px;
}

.needs-page-actions,
.needs-export-actions {
  align-items: center;
}

.needs-export-actions {
  display: flex;
  gap: 8px;
}

.needs-page-actions .button {
  min-height: var(--admin-control-height);
  padding-inline: 14px;
  font-size: var(--admin-font-control);
  white-space: nowrap;
}

.needs-notices {
  display: grid;
  gap: 8px;
  margin-bottom: 14px;
}

.needs-notices:empty {
  display: none;
}

.needs-notices > p {
  margin: 0;
}

.needs-stats {
  gap: 1px;
  padding: 1px;
  margin-bottom: 14px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--line-strong);
}

.needs-stats > div {
  min-height: 82px;
  align-content: center;
  gap: 5px;
  padding: 14px 18px;
  border: 0;
  background: #fff;
}

.needs-stats > div.emphasis {
  background: var(--blue-soft);
}

.needs-stats span {
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--admin-font-micro);
  letter-spacing: 0.04em;
}

.needs-stats strong {
  color: var(--ink);
  font-size: 24px;
  font-weight: 650;
  line-height: 1;
}

.needs-stats > div.emphasis strong {
  color: var(--blue-deep);
}

.needs-toolbar {
  container-name: needs-filters;
  container-type: inline-size;
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
  padding: 12px;
  margin-bottom: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.needs-toolbar-primary {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(280px, 1.5fr) repeat(3, minmax(150px, 0.7fr));
  gap: 8px;
}

.needs-toolbar-primary .admin-search,
.needs-toolbar-primary .admin-select {
  width: 100%;
  min-width: 0;
  background-color: #fff;
  border-color: var(--line);
}

.needs-toolbar-secondary {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.needs-date-range {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(136px, 160px) auto minmax(136px, 160px);
  align-items: center;
  gap: 8px;
}

.needs-filter-label {
  color: var(--muted);
  font-size: var(--admin-font-caption);
  font-weight: 700;
  white-space: nowrap;
}

.needs-date-range label {
  display: block;
}

.needs-date-range input {
  width: 100%;
  min-height: var(--admin-control-height);
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  background: #fff;
  color: var(--ink);
  font: inherit;
  font-size: var(--admin-font-control);
}

.needs-date-separator {
  color: var(--muted);
  font-size: var(--admin-font-caption);
}

.needs-toolbar-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.needs-toolbar-actions .button {
  min-width: 72px;
  min-height: var(--admin-control-height);
  padding-inline: 14px;
  font-size: var(--admin-font-control);
}

.needs-list-panel {
  align-self: start;
  overflow: hidden;
}

.needs-list-head {
  min-height: 76px;
}

.needs-list-head h2 {
  margin: 2px 0 1px;
}

.needs-list-head h2:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 3px;
}

.needs-list-head .eyebrow {
  margin: 0;
}

.needs-list-state {
  flex: 0 0 auto;
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--admin-font-micro);
  white-space: nowrap;
}

.needs-table {
  min-width: 880px;
}

.needs-workspace:has(.need-detail-panel) {
  align-items: start;
}

.needs-workspace:has(.need-detail-panel) .needs-table {
  min-width: 720px;
}

.needs-workspace:has(.need-detail-panel) .needs-table th,
.needs-workspace:has(.need-detail-panel) .needs-table td {
  padding-inline: 12px;
}

.needs-table th:first-child {
  width: 43%;
}

.needs-table th:nth-child(2) {
  width: 18%;
}

.needs-table th:nth-child(3) {
  width: 14%;
}

.needs-table th:nth-child(4) {
  width: 17%;
}

.needs-table th:last-child {
  width: 8%;
}

.needs-table td:last-child {
  text-align: right;
  white-space: nowrap;
}

.needs-state-row td,
.needs-state-row:last-child td {
  padding: 0;
}

.needs-table-state {
  min-height: 220px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 6px;
  padding: 30px;
  color: var(--muted);
  text-align: center;
}

.needs-table-state strong {
  color: var(--ink);
  font-family: var(--serif);
  font-size: 18px;
  font-weight: 600;
}

.needs-table-state span {
  max-width: 480px;
  font-size: var(--admin-font-caption);
  line-height: 1.7;
}

.needs-table-state.error {
  background: var(--red-soft);
}

.needs-table-state.error span {
  color: var(--red);
}

.needs-table-state .button {
  margin-top: 8px;
}

.needs-pagination {
  min-height: 58px;
}

.need-detail-panel {
  position: sticky;
  top: 86px;
  max-height: calc(100dvh - 104px);
  overflow-y: auto;
}

.needs-date-range input:focus,
.need-edit-field textarea:focus,
.need-edit-field input:focus {
  border-color: var(--blue);
  outline: 0;
  box-shadow: var(--admin-focus-ring);
}

.need-topic-editor label:focus-within {
  border-color: var(--blue);
  box-shadow: var(--admin-focus-ring);
}

@media (hover: hover) {
  .need-topic-editor label:hover {
    border-color: var(--blue);
    color: var(--blue);
  }

  .need-detail-head > button:hover {
    color: var(--ink);
    background: var(--surface);
  }
}

@container needs-filters (max-width: 900px) {
  .needs-toolbar-primary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .needs-toolbar-primary .admin-search {
    grid-column: 1 / -1;
  }
}

@container needs-filters (max-width: 620px) {
  .needs-toolbar-primary {
    grid-template-columns: 1fr;
  }

  .needs-toolbar-primary .admin-search {
    grid-column: auto;
  }
}

@media (max-width: 1580px) {
  .needs-stats > div {
    border: 0;
  }

  .needs-workspace:has(.need-detail-panel) {
    grid-template-columns: 1fr;
  }

  .need-detail-panel {
    position: static;
    max-height: none;
  }
}

@media (max-width: 720px) {
  .needs-page-head {
    align-items: stretch;
    flex-direction: column;
    gap: 16px;
  }

  .needs-page-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .needs-toolbar-secondary {
    align-items: stretch;
    flex-direction: column;
  }

  .needs-date-range {
    width: 100%;
    grid-template-columns: 1fr auto 1fr;
  }

  .needs-filter-label {
    grid-column: 1 / -1;
  }

  .needs-toolbar-actions {
    justify-content: flex-end;
  }

  .needs-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .needs-list-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
}

@media (max-width: 520px) {
  .needs-page-actions,
  .needs-export-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .needs-page-actions > .button {
    grid-column: 1 / -1;
  }

  .needs-page-actions .button,
  .needs-toolbar-actions .button {
    width: 100%;
  }

  .needs-export-actions {
    grid-column: 1 / -1;
  }

  .needs-toolbar-actions {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .needs-stats > div {
    min-height: 76px;
    padding: 12px 14px;
  }

  .need-detail-facts {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .need-topic-editor label,
  .need-detail-head > button {
    transition: none;
  }
}
</style>
