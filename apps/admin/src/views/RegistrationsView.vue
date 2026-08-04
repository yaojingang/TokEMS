<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { RegistrationStatus, WaitlistEntry } from '@conference/contracts';
import { useRoute } from 'vue-router';
import { conferenceApi, publicEventUrl, session, type AdminRegistrationRow } from '../lib/api';
import { dateTime, money, statusClass, statusLabel } from '../lib/format';

const rows = ref<AdminRegistrationRow[]>([]);
const waitlist = ref<WaitlistEntry[]>([]);
const q = ref('');
const status = ref<RegistrationStatus | ''>('');
const loading = ref(false);
const exporting = ref(false);
const errorMessage = ref('');
const canExport = session.can('event.registration.export');
const page = ref(1);
const pageSize = ref(10);
const pageSizeDraft = ref('10');
const jumpPageDraft = ref('1');
const totalRecords = ref(0);
let loadRequestId = 0;
const route = useRoute();
const registrationUrl = computed(() => publicEventUrl('/register'));
const totalPages = computed(() => Math.max(1, Math.ceil(totalRecords.value / pageSize.value)));
const visibleRange = computed(() => {
  if (!totalRecords.value) return '0 条';
  const start = (page.value - 1) * pageSize.value + 1;
  const end = start + rows.value.length - 1;
  return `第 ${start}–${end} 条，共 ${totalRecords.value} 条`;
});
const paginationItems = computed<Array<number | 'ellipsis'>>(() => {
  if (totalPages.value <= 7) {
    return Array.from({ length: totalPages.value }, (_, index) => index + 1);
  }
  const anchors = [...new Set([1, page.value - 1, page.value, page.value + 1, totalPages.value])]
    .filter((item) => item >= 1 && item <= totalPages.value)
    .sort((left, right) => left - right);
  const items: Array<number | 'ellipsis'> = [];
  anchors.forEach((item, index) => {
    if (index > 0 && item - anchors[index - 1]! > 1) items.push('ellipsis');
    items.push(item);
  });
  return items;
});

function paymentMethodLabel(value: string) {
  return (
    {
      wechat: '微信支付',
      alipay: '支付宝',
      bank: '银行转账',
      free: '免费票',
    }[value] ?? value
  );
}

function setPageState(nextPage: number) {
  page.value = Math.min(Math.max(Math.round(nextPage) || 1, 1), totalPages.value);
  jumpPageDraft.value = String(page.value);
}

function changePage(nextPage: number) {
  const previousPage = page.value;
  setPageState(nextPage);
  if (page.value !== previousPage) void load();
}

function commitPageSize() {
  const nextSize = Math.min(Math.max(Number.parseInt(pageSizeDraft.value, 10) || 10, 1), 100);
  if (nextSize === pageSize.value) {
    pageSizeDraft.value = String(nextSize);
    return;
  }
  pageSize.value = nextSize;
  pageSizeDraft.value = String(nextSize);
  void load(true);
}

function jumpToPage() {
  changePage(Number.parseInt(jumpPageDraft.value, 10));
}

async function load(resetPage = false) {
  const requestId = ++loadRequestId;
  const requestedPage = resetPage ? 1 : page.value;
  loading.value = true;
  errorMessage.value = '';
  try {
    const [result, waiting] = await Promise.all([
      conferenceApi.getRegistrations({
        ...(q.value.trim() ? { q: q.value.trim() } : {}),
        ...(status.value ? { status: status.value } : {}),
        page: requestedPage,
        pageSize: pageSize.value,
      }),
      conferenceApi.getWaitlist(),
    ]);
    if (requestId !== loadRequestId) return;
    rows.value = result.items;
    waitlist.value = waiting;
    totalRecords.value = result.total;
    page.value = result.page;
    pageSize.value = result.pageSize;
    pageSizeDraft.value = String(result.pageSize);
    jumpPageDraft.value = String(result.page);
  } catch (error) {
    if (requestId === loadRequestId) {
      errorMessage.value = error instanceof Error ? error.message : '报名数据读取失败';
    }
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}

async function exportData() {
  exporting.value = true;
  errorMessage.value = '';
  try {
    await conferenceApi.exportRegistrations();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报名数据导出失败';
  } finally {
    exporting.value = false;
  }
}

watch(
  () => route.query.q,
  (query) => {
    q.value = String(query ?? '');
    void load(true);
  },
  { immediate: true },
);
</script>

<template>
  <header class="admin-page-head registration-page-head reveal is-visible">
    <div class="registration-page-heading">
      <p class="eyebrow">REGISTRATION OPERATIONS</p>
      <h1>报名管理</h1>
      <p>统一查看参会人资料、报名进度与关联订单。</p>
    </div>
    <form class="registration-toolbar" role="search" @submit.prevent="load(true)">
      <div class="registration-toolbar-filters">
        <label class="admin-search">
          <span aria-hidden="true">⌕</span>
          <input
            v-model="q"
            type="search"
            aria-label="搜索报名"
            placeholder="搜索姓名、公司、手机号、报名码"
          />
        </label>
        <select
          v-model="status"
          class="admin-select"
          aria-label="按报名状态筛选"
          @change="load(true)"
        >
          <option value="">全部报名状态</option>
          <option value="pending_review">待审核</option>
          <option value="pending_payment">待支付</option>
          <option value="confirmed">已确认</option>
          <option value="checked_in">已签到</option>
          <option value="cancelled">已取消</option>
        </select>
        <button class="button secondary" type="submit">查询</button>
        <button
          class="button subtle"
          type="button"
          @click="
            q = '';
            status = '';
            load(true);
          "
        >
          重置
        </button>
      </div>
      <div class="registration-toolbar-actions" aria-label="报名数据操作">
        <button class="button secondary" type="button" @click="load()">刷新数据</button>
        <button
          v-if="canExport"
          class="button secondary"
          type="button"
          :disabled="exporting"
          @click="exportData"
        >
          {{ exporting ? '正在导出…' : '导出报名与订单 CSV' }}
        </button>
        <a class="button" :href="registrationUrl" target="_blank" rel="noopener noreferrer">
          新增报名 ↗
        </a>
      </div>
    </form>
  </header>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>

  <section class="admin-panel registration-list-panel reveal is-visible">
    <div class="data-table-wrap">
      <table class="data-table registration-table">
        <caption class="sr-only">
          报名记录与关联订单
        </caption>
        <thead>
          <tr>
            <th>参会人</th>
            <th>联系方式</th>
            <th>票种</th>
            <th>报名状态</th>
            <th>关联订单</th>
            <th class="number">金额</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>
              <span class="row-title">{{ row.attendee.name }}</span>
              <span class="row-sub">{{ row.attendee.company }} · {{ row.attendee.title }}</span>
            </td>
            <td>
              <span>{{ row.attendee.mobile }}</span>
              <span class="row-sub">{{ row.attendee.email }}</span>
            </td>
            <td>{{ row.ticketType.name }}</td>
            <td>
              <span class="status-badge" :class="statusClass(row.status)">
                {{ statusLabel(row.status) }}
              </span>
            </td>
            <td>
              <template v-if="row.order">
                <span class="status-badge" :class="statusClass(row.order.status)">
                  {{ statusLabel(row.order.status) }}
                </span>
                <span class="row-sub order-reference">
                  {{ row.order.orderNo }} · {{ paymentMethodLabel(row.order.paymentMethod) }}
                </span>
              </template>
              <span v-else class="status-badge muted">未生成</span>
            </td>
            <td class="number">
              <strong v-if="row.order">{{ money(row.order.amount) }}</strong>
              <span v-else>－</span>
            </td>
            <td>
              <div class="row-actions">
                <RouterLink
                  class="button secondary compact"
                  :to="{
                    name: 'event-registration-detail',
                    params: { eventId: route.params.eventId, registrationId: row.id },
                    query: route.query,
                  }"
                >
                  查看
                </RouterLink>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!loading && !rows.length" class="admin-empty">当前筛选条件下没有报名记录。</div>
    </div>
    <footer class="table-footer registration-pagination">
      <span>{{ visibleRange }} · 时间均为 Asia/Shanghai</span>
      <nav class="registration-page-nav" aria-label="报名记录分页">
        <button
          type="button"
          aria-label="上一页"
          :disabled="page === 1 || loading"
          @click="changePage(page - 1)"
        >
          ‹
        </button>
        <template v-for="(item, index) in paginationItems" :key="`${item}-${index}`">
          <span v-if="item === 'ellipsis'" class="page-ellipsis" aria-hidden="true">…</span>
          <button
            v-else
            type="button"
            :class="{ active: item === page }"
            :aria-current="item === page ? 'page' : undefined"
            :aria-label="`第 ${item} 页`"
            :disabled="loading"
            @click="changePage(item)"
          >
            {{ item }}
          </button>
        </template>
        <button
          type="button"
          aria-label="下一页"
          :disabled="page === totalPages || loading"
          @click="changePage(page + 1)"
        >
          ›
        </button>
      </nav>
      <div class="registration-page-inputs">
        <label>
          <span>每页</span>
          <input
            v-model="pageSizeDraft"
            type="number"
            inputmode="numeric"
            min="1"
            max="100"
            aria-label="每页显示条数"
            @change="commitPageSize"
            @keydown.enter.prevent="commitPageSize"
          />
          <span>条</span>
        </label>
        <label>
          <span>跳至</span>
          <input
            v-model="jumpPageDraft"
            type="number"
            inputmode="numeric"
            min="1"
            :max="totalPages"
            aria-label="跳转页码"
            @change="jumpToPage"
            @keydown.enter.prevent="jumpToPage"
          />
          <span>页</span>
        </label>
      </div>
    </footer>
  </section>

  <section class="admin-panel reveal is-visible admin-panel-spaced">
    <header class="admin-panel-header">
      <div>
        <h2>候补名单</h2>
        <p>库存释放后按队列顺序发放两小时购买资格</p>
      </div>
      <span class="status-badge">{{ waitlist.length }} WAITING</span>
    </header>
    <div class="data-table-wrap">
      <table class="data-table">
        <caption class="sr-only">
          报名候补名单
        </caption>
        <thead>
          <tr>
            <th>队列</th>
            <th>申请人</th>
            <th>票种</th>
            <th>状态</th>
            <th>邀请有效期</th>
            <th>申请时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in waitlist" :key="entry.id">
            <td>
              <span class="mono-code">#{{ entry.position }}</span>
            </td>
            <td>
              <span class="row-title">{{ entry.name }}</span>
              <span class="row-sub">{{ entry.email }}</span>
            </td>
            <td>{{ entry.ticketTypeName }}</td>
            <td>
              <span class="status-badge" :class="statusClass(entry.status)">
                {{ statusLabel(entry.status) }}
              </span>
            </td>
            <td>{{ entry.expiresAt ? dateTime(entry.expiresAt) : '等待释放' }}</td>
            <td>{{ dateTime(entry.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!loading && !waitlist.length" class="admin-empty">当前大会没有候补申请。</div>
    </div>
  </section>
</template>

<style scoped>
.registration-page-head {
  display: block;
  margin-bottom: 16px;
}

.registration-page-heading {
  margin-bottom: 18px;
}

.registration-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 10px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.registration-toolbar-filters {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(200px, 1fr) 160px auto auto;
  gap: 8px;
  align-items: center;
}

.registration-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 10px;
  border-left: 1px solid var(--line);
}

.registration-toolbar .admin-search,
.registration-toolbar .admin-select {
  width: 100%;
  min-width: 0;
}

.registration-toolbar .button {
  min-height: var(--admin-control-height);
  padding-inline: 12px;
  font-size: var(--admin-font-control);
  white-space: nowrap;
}

.registration-list-panel {
  overflow: hidden;
}

.registration-table {
  min-width: 920px;
}

.order-reference {
  max-width: 190px;
  overflow: hidden;
  text-overflow: clip;
  white-space: nowrap;
}

.registration-pagination {
  min-height: 64px;
  flex-wrap: wrap;
}

.registration-page-nav,
.registration-page-inputs,
.registration-page-inputs label {
  display: flex;
  align-items: center;
}

.registration-page-nav {
  gap: 4px;
}

.registration-page-nav button {
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--muted);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  font-family: var(--mono);
  font-size: 10px;
  transition:
    color 140ms var(--ease),
    background-color 140ms var(--ease),
    border-color 140ms var(--ease),
    transform 140ms var(--ease);
}

.registration-page-nav button:hover:not(:disabled) {
  color: var(--blue);
  background: var(--blue-soft);
  border-color: color-mix(in srgb, var(--blue) 28%, var(--line));
}

.registration-page-nav button:active:not(:disabled) {
  transform: scale(0.95);
}

.registration-page-nav button.active {
  color: #fff;
  background: var(--blue);
  border-color: var(--blue);
}

.registration-page-nav button:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.page-ellipsis {
  width: 20px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  text-align: center;
}

.registration-page-inputs {
  gap: 12px;
}

.registration-page-inputs label {
  gap: 5px;
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
}

.registration-page-inputs input {
  width: 50px;
  height: 32px;
  padding: 0 6px;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  font-family: var(--mono);
  font-size: 10px;
  text-align: center;
}

.registration-page-inputs input:focus,
.registration-page-nav button:focus-visible {
  border-color: var(--blue);
  outline: 2px solid color-mix(in srgb, var(--blue) 18%, transparent);
  outline-offset: 1px;
}

@media (max-width: 1040px) {
  .registration-toolbar {
    grid-template-columns: 1fr;
  }

  .registration-toolbar-actions {
    justify-content: flex-end;
    padding-top: 10px;
    padding-left: 0;
    border-top: 1px solid var(--line);
    border-left: 0;
  }

  .registration-pagination {
    justify-content: center;
  }

  .registration-pagination > span {
    width: 100%;
    text-align: center;
  }
}

@media (max-width: 640px) {
  .registration-page-heading {
    margin-bottom: 16px;
  }

  .registration-toolbar-filters {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .registration-toolbar .admin-search {
    grid-column: 1 / -1;
  }

  .registration-toolbar-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .registration-toolbar-actions .button {
    width: 100%;
  }

  .registration-toolbar-actions .button:last-child {
    grid-column: 1 / -1;
  }
}

@media (max-width: 520px) {
  .registration-pagination {
    gap: 10px;
  }

  .registration-page-inputs {
    width: 100%;
    justify-content: center;
  }

  .registration-page-nav button {
    width: 40px;
    height: 40px;
  }

  .registration-page-inputs input {
    width: 56px;
    height: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .registration-page-nav button {
    transition: none;
  }
}
</style>
