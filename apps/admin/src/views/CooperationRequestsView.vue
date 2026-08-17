<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  COOPERATION_TYPE_OPTIONS,
  type CooperationRequestStatus,
  type CooperationType,
} from '@conference/contracts';
import RegistrationOperationsTabs from '../components/RegistrationOperationsTabs.vue';
import {
  conferenceApi,
  session,
  type AdminCooperationRequest,
  type AdminCooperationRequestList,
} from '../lib/api';
import { dateTime, statusClass, statusLabel } from '../lib/format';

const route = useRoute();
const router = useRouter();
const canManage = computed(() => session.can('event.registration.manage'));
const list = ref<AdminCooperationRequestList>();
const detail = ref<AdminCooperationRequest>();
const q = ref('');
const status = ref<CooperationRequestStatus | ''>('');
const type = ref<CooperationType | ''>('');
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const saving = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const editStatus = ref<CooperationRequestStatus>('new');
const internalNote = ref('');
let loadRequestId = 0;

const requestId = computed(() => {
  const value = route.params.requestId;
  return typeof value === 'string' && value ? value : '';
});
const statusOptions: Array<{ value: CooperationRequestStatus; label: string }> = [
  { value: 'new', label: '待跟进' },
  { value: 'contacted', label: '已联系' },
  { value: 'converted', label: '已达成' },
  { value: 'closed', label: '已关闭' },
];
const typeLabels = Object.fromEntries(
  COOPERATION_TYPE_OPTIONS.map((option) => [option.value, option.label]),
) as Record<CooperationType, string>;
const totalPages = computed(() => Math.max(1, Math.ceil((list.value?.total ?? 0) / pageSize)));
const dirty = computed(
  () =>
    Boolean(detail.value) &&
    (editStatus.value !== detail.value!.status ||
      internalNote.value !== detail.value!.internalNote),
);
const cooperationCount = computed(() => list.value?.counts.all);
const listRouteQuery = computed(() => ({
  ...(q.value.trim() ? { q: q.value.trim() } : {}),
  ...(status.value ? { status: status.value } : {}),
  ...(type.value ? { type: type.value } : {}),
  ...(page.value > 1 ? { page: String(page.value) } : {}),
}));

function hydrateFilters() {
  q.value = typeof route.query.q === 'string' ? route.query.q : '';
  status.value = statusOptions.some((item) => item.value === route.query.status)
    ? (route.query.status as CooperationRequestStatus)
    : '';
  type.value = COOPERATION_TYPE_OPTIONS.some((item) => item.value === route.query.type)
    ? (route.query.type as CooperationType)
    : '';
  page.value = Math.max(1, Number.parseInt(String(route.query.page ?? '1'), 10) || 1);
}

function editFromDetail(item: AdminCooperationRequest) {
  editStatus.value = item.status;
  internalNote.value = item.internalNote;
}

async function loadList() {
  const currentRequest = ++loadRequestId;
  loading.value = true;
  errorMessage.value = '';
  try {
    const result = await conferenceApi.getCooperationRequests({
      ...(q.value.trim() ? { q: q.value.trim() } : {}),
      ...(status.value ? { status: status.value } : {}),
      ...(type.value ? { type: type.value } : {}),
      page: page.value,
      pageSize,
    });
    if (currentRequest !== loadRequestId) return;
    list.value = result;
    page.value = result.page;
  } catch (error) {
    if (currentRequest === loadRequestId) {
      errorMessage.value = error instanceof Error ? error.message : '合作申请读取失败';
    }
  } finally {
    if (currentRequest === loadRequestId) loading.value = false;
  }
}

async function loadDetail() {
  if (!requestId.value) return;
  const currentRequest = ++loadRequestId;
  loading.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const item = await conferenceApi.getCooperationRequest(requestId.value);
    if (currentRequest !== loadRequestId) return;
    detail.value = item;
    editFromDetail(item);
  } catch (error) {
    if (currentRequest === loadRequestId) {
      errorMessage.value = error instanceof Error ? error.message : '合作申请详情读取失败';
    }
  } finally {
    if (currentRequest === loadRequestId) loading.value = false;
  }
}

async function applyFilters() {
  page.value = 1;
  await router.replace({
    name: 'event-cooperation-requests',
    params: { eventId: route.params.eventId },
    query: listRouteQuery.value,
  });
}

async function resetFilters() {
  q.value = '';
  status.value = '';
  type.value = '';
  page.value = 1;
  await router.replace({
    name: 'event-cooperation-requests',
    params: { eventId: route.params.eventId },
  });
}

async function selectStatus(next: CooperationRequestStatus | '') {
  status.value = next;
  await applyFilters();
}

async function changePage(next: number) {
  page.value = Math.min(Math.max(next, 1), totalPages.value);
  await router.replace({
    name: 'event-cooperation-requests',
    params: { eventId: route.params.eventId },
    query: listRouteQuery.value,
  });
}

async function save() {
  if (!detail.value || !dirty.value || !canManage.value || saving.value) return;
  saving.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const updated = await conferenceApi.updateCooperationRequest(detail.value.id, {
      status: editStatus.value,
      internalNote: internalNote.value,
      expectedUpdatedAt: detail.value.updatedAt,
    });
    detail.value = updated;
    editFromDetail(updated);
    successMessage.value = '跟进状态和内部备注已保存。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '合作申请更新失败';
  } finally {
    saving.value = false;
  }
}

watch(
  () => [route.params.eventId, route.params.requestId, route.query],
  () => {
    hydrateFilters();
    if (requestId.value) void loadDetail();
    else void loadList();
  },
  { immediate: true, deep: true },
);
</script>

<template>
  <header class="admin-page-head cooperation-page-head reveal is-visible">
    <div>
      <p class="eyebrow">REGISTRATION OPERATIONS</p>
      <h1>{{ requestId ? '合作申请详情' : '合作申请' }}</h1>
      <p>
        {{
          requestId
            ? '查看申请原始内容，记录跟进状态与内部备注。'
            : '集中处理大会收到的品牌、媒体、内容和渠道合作意向。'
        }}
      </p>
    </div>
    <div class="admin-head-actions">
      <button
        class="button secondary"
        type="button"
        :disabled="loading"
        @click="requestId ? loadDetail() : loadList()"
      >
        {{ loading ? '正在刷新…' : '刷新数据' }}
      </button>
    </div>
  </header>

  <RegistrationOperationsTabs :cooperation-count="cooperationCount ?? 0" />
  <p v-if="errorMessage" class="admin-error" role="alert">
    {{ errorMessage }}
    <button v-if="requestId" class="inline-reload" type="button" @click="loadDetail">
      重新载入
    </button>
  </p>
  <p v-if="successMessage" class="admin-success" role="status">{{ successMessage }}</p>

  <template v-if="!requestId">
    <section class="cooperation-stats" aria-label="合作申请状态统计">
      <button
        v-for="item in [
          { value: '', label: '全部', count: list?.counts.all ?? 0 },
          { value: 'new', label: '待跟进', count: list?.counts.new ?? 0 },
          { value: 'contacted', label: '已联系', count: list?.counts.contacted ?? 0 },
          { value: 'converted', label: '已达成', count: list?.counts.converted ?? 0 },
          { value: 'closed', label: '已关闭', count: list?.counts.closed ?? 0 },
        ]"
        :key="item.value"
        type="button"
        :class="{ active: status === item.value }"
        :aria-pressed="status === item.value"
        @click="selectStatus(item.value as CooperationRequestStatus | '')"
      >
        <span>{{ item.label }}</span>
        <strong>{{ item.count }}</strong>
      </button>
    </section>

    <form class="cooperation-toolbar" role="search" @submit.prevent="applyFilters">
      <label class="admin-search">
        <span aria-hidden="true">⌕</span>
        <input
          v-model="q"
          type="search"
          aria-label="搜索合作申请"
          placeholder="搜索申请编号、机构、联系人或联系方式"
        />
      </label>
      <select
        v-model="status"
        class="admin-select"
        aria-label="按跟进状态筛选"
        @change="applyFilters"
      >
        <option value="">全部状态</option>
        <option v-for="item in statusOptions" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>
      <select
        v-model="type"
        class="admin-select"
        aria-label="按合作方向筛选"
        @change="applyFilters"
      >
        <option value="">全部合作方向</option>
        <option v-for="item in COOPERATION_TYPE_OPTIONS" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>
      <button class="button secondary" type="submit">查询</button>
      <button class="button subtle" type="button" @click="resetFilters">重置</button>
    </form>

    <section class="admin-panel cooperation-list-panel reveal is-visible">
      <div class="data-table-wrap">
        <table class="data-table cooperation-table">
          <caption class="sr-only">
            大会合作申请
          </caption>
          <thead>
            <tr>
              <th>申请与机构</th>
              <th>合作方向</th>
              <th>联系人</th>
              <th>状态</th>
              <th>提交时间</th>
              <th>最近更新</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in list?.items ?? []" :key="item.id">
              <td>
                <span class="row-title">{{ item.companyName }}</span>
                <span class="row-sub mono-code">{{ item.requestNo }}</span>
              </td>
              <td>
                <div class="cooperation-type-list">
                  <span v-for="direction in item.cooperationTypes" :key="direction">{{
                    typeLabels[direction]
                  }}</span>
                </div>
              </td>
              <td>
                <span class="row-title">{{ item.contactName }}</span>
                <span class="row-sub">{{ item.mobile || item.email || item.wechatId }}</span>
              </td>
              <td>
                <span class="status-badge" :class="statusClass(item.status)">{{
                  statusLabel(item.status)
                }}</span>
              </td>
              <td>{{ dateTime(item.createdAt) }}</td>
              <td>{{ dateTime(item.updatedAt) }}</td>
              <td>
                <RouterLink
                  class="button secondary compact"
                  :to="{
                    name: 'event-cooperation-requests',
                    params: { eventId: route.params.eventId, requestId: item.id },
                    query: listRouteQuery,
                  }"
                >
                  查看
                </RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="loading && !list" class="admin-empty">正在读取合作申请…</div>
        <div v-else-if="!loading && !list?.items.length" class="admin-empty">
          当前筛选条件下没有合作申请。
        </div>
      </div>
      <footer class="table-footer cooperation-pagination">
        <span>共 {{ list?.total ?? 0 }} 条 · 第 {{ page }} / {{ totalPages }} 页</span>
        <nav aria-label="合作申请分页">
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
  </template>

  <template v-else>
    <div class="cooperation-detail-back">
      <RouterLink
        :to="{
          name: 'event-cooperation-requests',
          params: { eventId: route.params.eventId },
          query: route.query,
        }"
      >
        ← 返回合作申请列表
      </RouterLink>
    </div>

    <section v-if="detail" class="cooperation-detail-grid">
      <article class="admin-panel cooperation-original">
        <header class="admin-panel-header">
          <div>
            <p class="eyebrow">{{ detail.requestNo }}</p>
            <h2>{{ detail.companyName }}</h2>
            <p>提交于 {{ dateTime(detail.createdAt) }}</p>
          </div>
          <span class="status-badge" :class="statusClass(detail.status)">{{
            statusLabel(detail.status)
          }}</span>
        </header>

        <dl class="cooperation-facts">
          <div>
            <dt>联系人</dt>
            <dd>
              {{ detail.contactName
              }}<small v-if="detail.contactTitle">{{ detail.contactTitle }}</small>
            </dd>
          </div>
          <div>
            <dt>手机</dt>
            <dd>
              <a v-if="detail.mobile" :href="`tel:${detail.mobile}`">{{ detail.mobile }}</a><span v-else>未填写</span>
            </dd>
          </div>
          <div>
            <dt>邮箱</dt>
            <dd>
              <a v-if="detail.email" :href="`mailto:${detail.email}`">{{ detail.email }}</a><span v-else>未填写</span>
            </dd>
          </div>
          <div>
            <dt>微信号</dt>
            <dd>{{ detail.wechatId || '未填写' }}</dd>
          </div>
        </dl>

        <section class="cooperation-original-section">
          <h3>合作方向</h3>
          <div class="cooperation-type-list">
            <span v-for="direction in detail.cooperationTypes" :key="direction">{{
              typeLabels[direction]
            }}</span>
          </div>
        </section>
        <section class="cooperation-original-section">
          <h3>合作设想</h3>
          <p>{{ detail.message }}</p>
        </section>
      </article>

      <aside class="admin-panel cooperation-followup">
        <header class="admin-panel-header">
          <div>
            <h2>跟进记录</h2>
            <p>原始申请保持只读</p>
          </div>
        </header>
        <form @submit.prevent="save">
          <label class="form-field">
            <span>处理状态</span>
            <select v-model="editStatus" class="admin-select" :disabled="!canManage || saving">
              <option v-for="item in statusOptions" :key="item.value" :value="item.value">
                {{ item.label }}
              </option>
            </select>
          </label>
          <label class="form-field cooperation-note-field">
            <span>内部备注</span>
            <textarea
              v-model="internalNote"
              maxlength="2000"
              rows="10"
              :disabled="!canManage || saving"
              placeholder="记录沟通进展、关键诉求和后续安排，仅后台运营人员可见。"
            ></textarea>
            <small>{{ internalNote.length }} / 2000</small>
          </label>
          <div class="cooperation-lifecycle">
            <span>首次联系</span><strong>{{
              detail.firstContactedAt ? dateTime(detail.firstContactedAt) : '尚未联系'
            }}</strong>
            <span>达成或关闭</span><strong>{{ detail.resolvedAt ? dateTime(detail.resolvedAt) : '尚未完成' }}</strong>
            <span>最近更新</span><strong>{{ dateTime(detail.updatedAt) }}</strong>
          </div>
          <button
            v-if="canManage"
            class="button primary cooperation-save"
            type="submit"
            :disabled="!dirty || saving"
          >
            {{ saving ? '正在保存…' : '保存跟进记录' }}
          </button>
          <p v-else class="cooperation-readonly-note">你当前拥有只读权限。</p>
        </form>
      </aside>
    </section>
    <div v-else-if="loading" class="admin-panel admin-empty">正在读取合作申请详情…</div>
  </template>
</template>

<style scoped>
.cooperation-page-head {
  align-items: flex-end;
  margin-bottom: 16px;
}

.cooperation-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.cooperation-stats button {
  min-height: 70px;
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 15px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fff;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
  transition:
    border-color 140ms var(--ease),
    background-color 140ms var(--ease),
    transform 140ms var(--ease);
}

.cooperation-stats button:hover,
.cooperation-stats button.active {
  border-color: color-mix(in srgb, var(--blue) 42%, var(--line));
  background: var(--blue-soft);
  color: var(--blue);
}

.cooperation-stats button:active {
  transform: scale(0.98);
}

.cooperation-stats span {
  font-size: var(--admin-font-control);
  font-weight: 680;
}

.cooperation-stats strong {
  color: var(--ink);
  font-family: var(--mono);
  font-size: 22px;
  font-weight: 620;
}

.cooperation-toolbar {
  display: grid;
  grid-template-columns: minmax(230px, 1fr) minmax(140px, 170px) minmax(160px, 200px) 64px 64px;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fff;
}

.cooperation-toolbar > * {
  width: 100%;
  min-width: 0;
}

.cooperation-list-panel {
  overflow: hidden;
}

.cooperation-table {
  min-width: 940px;
}

.cooperation-type-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.cooperation-type-list span {
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--blue-soft);
  color: var(--blue);
  font-size: 10px;
  white-space: nowrap;
}

.cooperation-pagination nav {
  display: flex;
  gap: 6px;
}

.cooperation-pagination button {
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  background: #fff;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
}

.cooperation-pagination button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.inline-reload {
  margin-left: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.cooperation-detail-back {
  margin: 3px 0 14px;
}

.cooperation-detail-back a {
  color: var(--muted);
  font-size: 12px;
  text-decoration: none;
}

.cooperation-detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.6fr);
  align-items: start;
  gap: 16px;
}

.cooperation-original,
.cooperation-followup {
  overflow: hidden;
}

.cooperation-original > .admin-panel-header,
.cooperation-followup > .admin-panel-header {
  padding: 20px 22px;
  border-bottom: 1px solid var(--line);
}

.cooperation-original .eyebrow {
  margin-bottom: 5px;
  color: var(--blue);
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.cooperation-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
  padding: 4px 22px 18px;
}

.cooperation-facts > div {
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}

.cooperation-facts > div:nth-child(odd) {
  padding-right: 20px;
}

.cooperation-facts dt,
.cooperation-lifecycle span {
  color: var(--muted);
  font-size: 10px;
}

.cooperation-facts dd {
  display: grid;
  gap: 3px;
  margin: 5px 0 0;
  color: var(--ink);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.cooperation-facts dd a {
  color: var(--blue);
}

.cooperation-facts dd small {
  color: var(--muted);
  font-size: 10px;
}

.cooperation-original-section {
  padding: 0 22px 22px;
}

.cooperation-original-section h3 {
  margin: 0 0 10px;
  font-size: 12px;
}

.cooperation-original-section p {
  margin: 0;
  padding: 17px 18px;
  border-left: 2px solid var(--blue);
  background: var(--surface-muted);
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
}

.cooperation-followup form {
  display: grid;
  gap: 18px;
  padding: 20px 22px 22px;
}

.cooperation-followup .form-field {
  display: grid;
  gap: 7px;
}

.cooperation-followup .form-field > span {
  color: var(--ink);
  font-size: 11px;
  font-weight: 680;
}

.cooperation-note-field textarea {
  width: 100%;
  resize: vertical;
  line-height: 1.7;
}

.cooperation-note-field small {
  justify-self: end;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9px;
}

.cooperation-lifecycle {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 9px 12px;
  padding: 14px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.cooperation-lifecycle strong {
  color: var(--ink-soft);
  font-size: 10px;
  font-weight: 560;
  text-align: right;
}

.cooperation-save {
  width: 100%;
  min-height: 40px;
}

.cooperation-save:active:not(:disabled) {
  transform: scale(0.98);
}

.cooperation-readonly-note {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
}

@media (max-width: 980px) {
  .cooperation-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .cooperation-toolbar {
    grid-template-columns: 1fr 1fr;
  }

  .cooperation-toolbar .admin-search {
    grid-column: 1 / -1;
  }

  .cooperation-detail-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 600px) {
  .cooperation-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .cooperation-toolbar {
    grid-template-columns: 1fr;
  }

  .cooperation-toolbar .admin-search {
    grid-column: auto;
  }

  .cooperation-facts {
    grid-template-columns: 1fr;
  }

  .cooperation-facts > div:nth-child(odd) {
    padding-right: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cooperation-stats button {
    transition: none;
  }
}
</style>
