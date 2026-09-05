<script setup lang="ts">
import RegistrationRefundPanel from '../components/registration/RegistrationRefundPanel.vue';
import { computed, ref, watch } from 'vue';
import type {
  RegistrationBusinessStatus,
  RegistrationInvoiceSummaryStatus,
  RegistrationStatus,
  WaitlistEntry,
} from '@conference/contracts';
import { useRoute } from 'vue-router';
import { conferenceApi, publicEventUrl, session, type AdminRegistrationRow } from '../lib/api';
import RegistrationOperationsTabs from '../components/RegistrationOperationsTabs.vue';
import { dateTime, money, statusClass, statusLabel } from '../lib/format';

const showRefunds = ref(false);
const refundEventId = computed(() => Number(route.params.eventId));
const rows = ref<AdminRegistrationRow[]>([]);
const waitlist = ref<WaitlistEntry[]>([]);
const q = ref('');
const status = ref<RegistrationStatus | ''>('');
const businessStatus = ref<RegistrationBusinessStatus | ''>('');
const invoiceStatus = ref<RegistrationInvoiceSummaryStatus | ''>('');
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
        ...(businessStatus.value ? { businessStatus: businessStatus.value } : {}),
        ...(invoiceStatus.value ? { invoiceStatus: invoiceStatus.value } : {}),
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
    <div class="registration-page-titlebar">
      <div class="registration-page-heading">
        <p class="eyebrow">REGISTRATION OPERATIONS</p>
        <h1>报名管理</h1>
        <p>统一查看参会人资料、报名进度与关联订单。</p>
      </div>
      <div class="admin-head-actions registration-page-actions" aria-label="报名数据操作">
        <button
          v-if="session.can('event.order.read')"
          class="button secondary"
          type="button"
          :aria-expanded="showRefunds"
          @click="showRefunds = !showRefunds"
        >
          {{ showRefunds ? '收起退款申请' : '退款申请' }}
        </button>
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
        <a
          class="button secondary"
          :href="registrationUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          新增报名 ↗
        </a>
      </div>
    </div>
    <RegistrationRefundPanel
      v-if="showRefunds && refundEventId"
      :event-id="refundEventId"
      @changed="load()"
    />
    <form class="registration-toolbar" role="search" @submit.prevent="load(true)">
      <div class="registration-toolbar-filters">
        <label class="admin-search">
          <span aria-hidden="true">⌕</span>
          <input
            v-model="q"
            type="search"
            aria-label="搜索报名"
            placeholder="搜索姓名、公司、手机号、报名码、订单号"
          />
        </label>
        <select
          v-model="businessStatus"
          class="admin-select"
          aria-label="按业务状态筛选"
          @change="load(true)"
        >
          <option value="">全部业务状态</option>
          <option value="pending_review">待审核</option>
          <option value="pending_payment">待支付</option>
          <option value="payment_processing">支付中</option>
          <option value="payment_failed">支付失败</option>
          <option value="paid">已支付</option>
          <option value="partially_refunded">部分退款</option>
          <option value="refunded">已退款</option>
          <option value="closed">已关闭</option>
          <option value="confirmed">免费报名已确认</option>
        </select>
        <select
          v-model="invoiceStatus"
          class="admin-select"
          aria-label="按发票状态筛选"
          @change="load(true)"
        >
          <option value="">全部发票状态</option>
          <option value="eligible">可申请</option>
          <option value="not_eligible">不可开票</option>
          <option value="pending_review">待审核</option>
          <option value="issuing">开票中</option>
          <option value="issued">已开具</option>
          <option value="adjustment_required">待调整</option>
          <option value="cancelled">已终止</option>
        </select>
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
            businessStatus = '';
            invoiceStatus = '';
            load(true);
          "
        >
          重置
        </button>
      </div>
    </form>
  </header>
  <RegistrationOperationsTabs />
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>

  <section class="admin-panel registration-list-panel reveal is-visible">
    <div class="data-table-wrap">
      <table class="data-table registration-table">
        <caption class="sr-only">
          报名记录与关联订单
        </caption>
        <thead>
          <tr>
            <th>购票人</th>
            <th>参会人</th>
            <th class="registration-contact-column">联系方式</th>
            <th class="registration-ticket-column">票种</th>
            <th class="registration-status-column">业务状态</th>
            <th>支付与退款</th>
            <th>发票</th>
            <th>最近更新</th>
            <th class="registration-action-column"><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>
              <span class="row-title">{{ row.purchaserName || '未填写姓名' }}</span>
              <span class="row-sub">{{ row.purchaserMobile }}</span>
              <span v-if="row.isProxyPurchase" class="status-badge draft">代购</span>
            </td>
            <td>
              <span class="row-title">{{ row.attendee.name }}</span>
              <span class="row-sub">{{ row.attendee.company }} · {{ row.attendee.title }}</span>
            </td>
            <td class="registration-contact-column">
              <span>{{ row.attendee.mobile }}</span>
            </td>
            <td class="registration-ticket-column">{{ row.ticketType.name }}</td>
            <td class="registration-status-column">
              <span class="status-badge" :class="statusClass(row.businessStatus)">
                {{ statusLabel(row.businessStatus) }}
              </span>
              <span class="row-sub registration-status-detail">
                报名：{{ statusLabel(row.status) }}
              </span>
            </td>
            <td>
              <template v-if="row.order">
                <span class="row-sub order-reference">
                  {{ row.order.orderNo }} · {{ paymentMethodLabel(row.order.paymentMethod) }}
                </span>
                <span class="row-sub">
                  实付 {{ money(row.paidAmount) }} · 已退 {{ money(row.refundedAmount) }}
                </span>
              </template>
              <span v-else class="status-badge muted">未生成</span>
            </td>
            <td>
              <span class="status-badge" :class="statusClass(row.invoiceSummary.status)">
                {{ statusLabel(row.invoiceSummary.status) }}
              </span>
              <span v-if="row.invoiceSummary.requestNo" class="row-sub">
                {{ row.invoiceSummary.requestNo }}
              </span>
            </td>
            <td>{{ dateTime(row.lastBusinessAt) }}</td>
            <td class="registration-action-column">
              <div class="row-actions">
                <RouterLink
                  class="button secondary compact registration-view-action"
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

.registration-page-titlebar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 18px;
}

.registration-page-heading {
  min-width: 0;
}

.registration-page-actions {
  flex: 0 0 auto;
}

.registration-page-actions .button {
  min-height: var(--admin-control-height);
  padding-inline: 12px;
  background: transparent;
  font-size: var(--admin-font-control);
  white-space: nowrap;
}

.registration-toolbar {
  container-name: registration-toolbar;
  container-type: inline-size;
  padding: 10px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.registration-toolbar-filters {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(220px, 1fr) repeat(3, minmax(140px, 160px)) repeat(2, 64px);
  gap: 8px;
  align-items: center;
}

.registration-toolbar .admin-search,
.registration-toolbar .admin-select {
  width: 100%;
  min-width: 0;
}

.registration-toolbar .admin-search {
  border: 1px solid var(--line);
}

.registration-toolbar .admin-search:focus-within {
  border-color: var(--blue);
}

.registration-toolbar .button {
  min-height: var(--admin-control-height);
  padding-inline: 12px;
  font-size: var(--admin-font-control);
  white-space: nowrap;
}

.registration-toolbar-filters > .button {
  width: 64px;
}

.registration-list-panel {
  overflow: hidden;
}

.registration-table {
  min-width: 1180px;
}

.registration-contact-column {
  width: 156px;
  min-width: 156px;
  white-space: nowrap;
}

.registration-ticket-column {
  width: 176px;
  min-width: 176px;
}

.registration-status-column {
  width: 132px;
  min-width: 132px;
}

.registration-status-detail {
  white-space: nowrap;
}

.registration-action-column {
  width: 84px;
  min-width: 84px;
  padding-inline: 12px;
  text-align: center;
}

.registration-action-column .row-actions {
  justify-content: center;
}

.registration-view-action {
  min-width: 56px;
  justify-content: center;
  padding-inline: 12px;
  white-space: nowrap;
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

@container registration-toolbar (max-width: 860px) {
  .registration-toolbar-filters {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .registration-toolbar .admin-search {
    grid-column: 1 / -1;
  }

  .registration-toolbar .admin-select {
    grid-column: span 2;
  }

  .registration-toolbar-filters > .button {
    width: 100%;
    grid-column: span 3;
  }
}

@media (max-width: 1040px) {
  .registration-pagination {
    justify-content: center;
  }

  .registration-pagination > span {
    width: 100%;
    text-align: center;
  }
}

@media (max-width: 640px) {
  .registration-page-titlebar {
    align-items: stretch;
    flex-direction: column;
    gap: 16px;
  }

  .registration-page-actions {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .registration-page-actions .button {
    width: 100%;
  }

  .registration-page-actions .button:nth-child(3):last-child {
    grid-column: 1 / -1;
  }
}

@container registration-toolbar (max-width: 500px) {
  .registration-toolbar .admin-select {
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
