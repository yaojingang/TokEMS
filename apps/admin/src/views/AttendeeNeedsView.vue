<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
  selected.value = item;
  editContent.value = item.content;
  editTagCodes.value = item.tagCodes.filter((code): code is AttendeeNeedTagCode =>
    ATTENDEE_NEED_TOPIC_OPTIONS.some((topic) => topic.code === code),
  );
  operationReason.value = '';
  if (!preserveMessages) {
    successMessage.value = '';
    errorMessage.value = '';
  }
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
      if (refreshed) editFromItem(refreshed, true);
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
  saving.value = true;
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.updateAttendeeNeed(selected.value.id, {
      version: selected.value.version,
      content: editContent.value.trim(),
      tagCodes: editTagCodes.value,
      reason: operationReason.value.trim(),
    });
    editFromItem(updated, true);
    successMessage.value = '问题信息已更新，用户端会显示调整提示。';
    await loadList();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '参会问题保存失败';
  } finally {
    saving.value = false;
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
  saving.value = true;
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.moderateAttendeeNeed(selected.value.id, {
      version: selected.value.version,
      action,
      reason: operationReason.value.trim() || null,
    });
    editFromItem(updated, true);
    successMessage.value = '治理状态已更新。';
    await loadList();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '治理操作失败';
  } finally {
    saving.value = false;
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
    <div class="admin-head-actions">
      <button class="button secondary" type="button" :disabled="loading" @click="loadList">
        {{ loading ? '正在刷新…' : '刷新数据' }}
      </button>
      <button
        v-if="canExport"
        class="button secondary"
        type="button"
        :disabled="exporting"
        @click="exportCsv('speaker')"
      >
        导出嘉宾版
      </button>
      <button
        v-if="canExport"
        class="button subtle"
        type="button"
        :disabled="exporting"
        @click="exportCsv('internal')"
      >
        导出内部版
      </button>
    </div>
  </header>

  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <p v-if="successMessage" class="admin-success" role="status">{{ successMessage }}</p>

  <section class="needs-stats" aria-label="参会需求统计">
    <div
      v-for="item in [
        { label: '提交人数', value: list?.counts.submitters ?? 0 },
        { label: '问题总数', value: list?.counts.total ?? 0 },
        { label: '用户公开', value: list?.counts.public ?? 0 },
        { label: '匿名公开', value: list?.counts.anonymous ?? 0 },
        { label: '后台隐藏', value: list?.counts.hidden ?? 0 },
        { label: '软删除', value: list?.counts.deleted ?? 0 },
      ]"
      :key="item.label"
    >
      <span>{{ item.label }}</span>
      <strong>{{ item.value }}</strong>
    </div>
  </section>

  <form class="needs-toolbar" role="search" @submit.prevent="applyFilters">
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
    <div class="needs-date-range">
      <label>
        <span>提交开始</span>
        <input v-model="submittedFrom" type="date" />
      </label>
      <span aria-hidden="true">至</span>
      <label>
        <span>提交结束</span>
        <input v-model="submittedTo" type="date" />
      </label>
    </div>
    <button class="button secondary" type="submit">查询</button>
    <button class="button subtle" type="button" @click="resetFilters">重置</button>
  </form>

  <div class="needs-workspace">
    <section class="admin-panel needs-list-panel reveal is-visible">
      <div class="data-table-wrap">
        <table class="data-table needs-table">
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
                <button class="button secondary compact" type="button" @click="editFromItem(item)">
                  查看处理
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="loading && !list" class="admin-empty">正在读取参会需求…</div>
        <div v-else-if="!loading && !list?.items.length" class="admin-empty">
          当前筛选条件下没有参会需求。
        </div>
      </div>
      <footer class="table-footer needs-pagination">
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
      class="admin-panel need-detail-panel"
      aria-labelledby="need-detail-title"
    >
      <header class="need-detail-head">
        <div>
          <p class="eyebrow">QUESTION DETAIL</p>
          <h2 id="need-detail-title">问题处理</h2>
        </div>
        <button type="button" aria-label="关闭问题详情" @click="selected = undefined">×</button>
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
        <textarea v-model="editContent" rows="6" :disabled="!canManage || selected.deleted" />
        <small>{{ Array.from(editContent.trim()).length }} / 200</small>
      </label>

      <fieldset class="need-topic-editor" :disabled="!canManage || selected.deleted">
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
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-surface);
}

.needs-stats > div {
  display: grid;
  gap: 7px;
  padding: 18px;
  border-right: 1px solid var(--admin-line);
}

.needs-stats > div:last-child {
  border-right: 0;
}

.needs-stats span {
  color: var(--admin-muted);
  font-size: 11px;
}

.needs-stats strong {
  color: var(--admin-ink);
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
  color: var(--admin-muted);
  font-size: 10px;
}

.needs-date-range input {
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid var(--admin-line);
  border-radius: 7px;
  background: var(--admin-surface);
  color: var(--admin-ink);
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
  color: var(--admin-ink);
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.need-tag-line {
  display: block;
  margin-top: 6px;
  color: var(--admin-muted);
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
}

.need-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--admin-line);
}

.need-detail-head h2 {
  margin: 4px 0 0;
}

.need-detail-head > button {
  width: 40px;
  height: 40px;
  border: 0;
  background: transparent;
  color: var(--admin-muted);
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
  color: var(--admin-muted);
  font-size: 10px;
}

.need-detail-facts dd {
  margin: 5px 0 0;
  color: var(--admin-ink);
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
  color: var(--admin-ink);
  font-size: 12px;
  font-weight: 750;
}

.need-edit-field textarea,
.need-edit-field input {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 7px;
  background: var(--admin-surface-muted);
  color: var(--admin-ink);
  font: inherit;
  line-height: 1.65;
  resize: vertical;
}

.need-edit-field small {
  justify-self: end;
  color: var(--admin-muted);
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
  border: 1px solid var(--admin-line);
  border-radius: 999px;
  color: var(--admin-muted);
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

@media (max-width: 1180px) {
  .needs-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .needs-stats > div:nth-child(3) {
    border-right: 0;
  }
  .needs-stats > div:nth-child(-n + 3) {
    border-bottom: 1px solid var(--admin-line);
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
</style>
