<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import type { OrderStatus, Refund } from '@conference/contracts';
import { conferenceApi, session, type AdminOrderRow } from '../lib/api';
import { dateTime, money, statusClass, statusLabel } from '../lib/format';

const rows = ref<AdminOrderRow[]>([]);
const q = ref('');
const status = ref<OrderStatus | ''>('');
const loading = ref(false);
const exporting = ref(false);
const refundPending = ref(false);
const errorMessage = ref('');
const canReadInventory = session.canAny(['event.inventory.read', 'event.inventory.manage']);
const canRefund = session.can('event.order.refund');
const refunds = ref<Refund[]>([]);
const selected = ref<AdminOrderRow>();
const refundTarget = ref<AdminOrderRow>();
const refundAmountInput = ref<HTMLInputElement>();
const page = ref(1);
const totalRecords = ref(0);
const pageSize = 20;
let loadRequestId = 0;
const refundForm = reactive({
  amountYuan: 0,
  reason: '参会人申请退款',
});
const selectedRefunds = computed(() =>
  selected.value
    ? refunds.value.filter((refundItem) => refundItem.orderId === selected.value?.id)
    : [],
);
const inventory = ref<
  Array<{
    id: string;
    name: string;
    capacity: number;
    sold: number;
    reserved: number;
    available: number;
  }>
>([]);
const refundTargetRefunded = computed(() =>
  refundTarget.value
    ? refunds.value
        .filter(
          (refundItem) =>
            refundItem.orderId === refundTarget.value?.id && refundItem.status === 'succeeded',
        )
        .reduce((sum, refundItem) => sum + refundItem.amount, 0)
    : 0,
);
const refundTargetRemaining = computed(() =>
  Math.max(0, (refundTarget.value?.amount ?? 0) - refundTargetRefunded.value),
);
const totalPages = computed(() => Math.max(1, Math.ceil(totalRecords.value / pageSize)));
const visibleRange = computed(() => {
  if (!totalRecords.value) return '0 条订单';
  const start = (page.value - 1) * pageSize + 1;
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

function changePage(nextPage: number) {
  const normalized = Math.min(Math.max(Math.round(nextPage) || 1, 1), totalPages.value);
  if (normalized === page.value || loading.value) return;
  page.value = normalized;
  void load();
}

async function load(resetPage = false) {
  const requestId = ++loadRequestId;
  const requestedPage = resetPage ? 1 : page.value;
  loading.value = true;
  errorMessage.value = '';
  try {
    const [result, nextInventory, nextRefunds] = await Promise.all([
      conferenceApi.getOrders({
        ...(q.value.trim() ? { q: q.value.trim() } : {}),
        ...(status.value ? { status: status.value } : {}),
        page: requestedPage,
      }),
      canReadInventory ? conferenceApi.getInventory() : Promise.resolve([]),
      conferenceApi.getRefunds(),
    ]);
    if (requestId !== loadRequestId) return;
    rows.value = result.items;
    totalRecords.value = result.total;
    page.value = result.page;
    inventory.value = nextInventory;
    refunds.value = nextRefunds;
  } catch (error) {
    if (requestId === loadRequestId) {
      errorMessage.value = error instanceof Error ? error.message : '订单数据读取失败';
    }
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}

async function openRefund(row: AdminOrderRow) {
  refundTarget.value = row;
  refundForm.amountYuan =
    Math.max(
      0,
      row.amount -
        refunds.value
          .filter(
            (refundItem) => refundItem.orderId === row.id && refundItem.status === 'succeeded',
          )
          .reduce((sum, refundItem) => sum + refundItem.amount, 0),
    ) / 100;
  refundForm.reason = '参会人申请退款';
  errorMessage.value = '';
  await nextTick();
  refundAmountInput.value?.focus();
}

function cancelRefund() {
  refundTarget.value = undefined;
}

async function submitRefund() {
  if (!refundTarget.value) return;
  const amount = Math.round(Number(refundForm.amountYuan) * 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    errorMessage.value = '退款金额格式不正确';
    return;
  }
  if (amount > refundTargetRemaining.value) {
    errorMessage.value = `退款金额不能超过可退余额 ${money(refundTargetRemaining.value)}`;
    return;
  }
  const reason = refundForm.reason.trim();
  if (reason.length < 2) {
    errorMessage.value = '退款原因至少需要 2 个字符';
    return;
  }
  const orderId = refundTarget.value.id;
  refundPending.value = true;
  errorMessage.value = '';
  try {
    await conferenceApi.refundOrder(orderId, { amount, reason });
    await load();
    selected.value = rows.value.find((item) => item.id === orderId);
    refundTarget.value = undefined;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '退款失败';
  } finally {
    refundPending.value = false;
  }
}

async function exportData() {
  exporting.value = true;
  errorMessage.value = '';
  try {
    conferenceApi.exportOrders(rows.value);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '订单数据导出失败';
  } finally {
    exporting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">COMMERCE LEDGER</p>
      <h1>订单管理</h1>
      <p>查看订单状态、支付金额、票种与关联参会人。</p>
    </div>
    <div class="admin-head-actions">
      <button class="button secondary" type="button" @click="load()">刷新流水</button><button class="button" type="button" :disabled="exporting" @click="exportData">
        {{ exporting ? '正在导出…' : '导出当前页 CSV' }}
      </button>
    </div>
  </header>

  <form class="admin-filter-bar" @submit.prevent="load(true)">
    <label class="admin-search"><span aria-hidden="true">⌕</span><input
      v-model="q"
      type="search"
      aria-label="搜索订单"
      placeholder="搜索姓名、手机号、订单号或公司"
    /></label>
    <select v-model="status" class="admin-select" aria-label="按订单状态筛选" @change="load(true)">
      <option value="">全部状态</option>
      <option value="pending_review">待审核</option>
      <option value="pending_payment">待支付</option>
      <option value="processing">支付处理中</option>
      <option value="paid">已支付</option>
      <option value="partially_refunded">部分退款</option>
      <option value="refunded">已退款</option>
      <option value="closed">已关闭</option>
    </select>
    <button class="button secondary" type="submit">查询</button><button
      class="button"
      type="button"
      @click="
        q = '';
        status = '';
        load(true);
      "
    >
      重置
    </button>
  </form>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>

  <div class="inventory-strip">
    <article v-for="item in inventory" :key="item.id">
      <span>{{ item.name }}</span><strong>{{ item.available }}</strong><small>可售 · 已售 {{ item.sold }} · 占用 {{ item.reserved }} / {{ item.capacity }}</small>
    </article>
  </div>

  <section
    v-if="refundTarget"
    class="admin-panel editor-panel refund-editor"
    aria-labelledby="refund-editor-title"
  >
    <header class="admin-panel-header">
      <div>
        <h2 id="refund-editor-title">发起退款 · {{ refundTarget.orderNo }}</h2>
        <p>{{ refundTarget.attendeeName }} · 可退余额 {{ money(refundTargetRemaining) }}</p>
        <p class="operation-event-context">
          当前大会 · {{ session.activeEvent.value?.name ?? '大会信息读取中' }}
        </p>
      </div>
      <button class="button secondary compact" type="button" @click="cancelRefund">关闭</button>
    </header>
    <form class="event-form settings-form-spaced" @submit.prevent="submitRefund">
      <div class="form-grid">
        <div class="form-field">
          <label for="refund-amount">退款金额（元）</label>
          <input
            id="refund-amount"
            ref="refundAmountInput"
            v-model.number="refundForm.amountYuan"
            type="number"
            min="0.01"
            :max="refundTargetRemaining / 100"
            step="0.01"
            required
          />
          <small>已退款 {{ money(refundTargetRefunded) }}，本次最多
            {{ money(refundTargetRemaining) }}</small>
        </div>
        <div class="form-field">
          <label for="refund-reason">退款原因</label>
          <input
            id="refund-reason"
            v-model="refundForm.reason"
            minlength="2"
            maxlength="240"
            required
          />
        </div>
      </div>
      <div class="event-form-actions">
        <span class="operation-event-context">
          退款将记入 {{ session.activeEvent.value?.shortName ?? '当前大会' }}
        </span>
        <button class="button secondary" type="button" @click="cancelRefund">取消</button>
        <button class="button danger" type="submit" :disabled="refundPending">
          {{ refundPending ? '正在退款…' : '确认退款' }}
        </button>
      </div>
    </form>
  </section>

  <section class="admin-panel reveal is-visible">
    <header class="admin-panel-header">
      <div>
        <h2>订单列表</h2>
        <p>
          本页已支付合计
          {{ money(rows.reduce((sum, row) => sum + (row.status === 'paid' ? row.amount : 0), 0)) }}
        </p>
      </div>
      <span class="status-badge">共 {{ totalRecords }} 条</span>
    </header>
    <div class="data-table-wrap">
      <table class="data-table">
        <caption class="sr-only">
          订单与支付流水
        </caption>
        <thead>
          <tr>
            <th>订单号</th>
            <th>参会人</th>
            <th>票种</th>
            <th>支付方式</th>
            <th>状态</th>
            <th class="number">金额</th>
            <th>创建时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>
              <span class="row-title mono-code">{{ row.orderNo }}</span><span class="row-sub">{{ row.id }}</span>
            </td>
            <td>
              <span class="row-title">{{ row.attendeeName }}</span><span class="row-sub">{{ row.attendeeCompany }} · {{ row.attendeeMobile }}</span>
            </td>
            <td>{{ row.ticketTypeName }}</td>
            <td>{{ row.paymentMethod === 'wechat' ? '微信支付' : row.paymentMethod }}</td>
            <td>
              <span class="status-badge" :class="statusClass(row.status)">{{
                statusLabel(row.status)
              }}</span>
            </td>
            <td class="number">
              <strong>{{ money(row.amount) }}</strong>
            </td>
            <td>{{ dateTime(row.createdAt) }}</td>
            <td>
              <div class="row-actions">
                <button class="button secondary compact" type="button" @click="selected = row">
                  查看
                </button>
                <button
                  v-if="canRefund && ['paid', 'partially_refunded'].includes(row.status)"
                  class="button danger compact"
                  type="button"
                  @click="openRefund(row)"
                >
                  退款
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!loading && !rows.length" class="admin-empty">当前筛选条件下没有订单记录。</div>
    </div>
    <footer class="table-footer order-pagination">
      <span>{{ visibleRange }} · 每页 20 条</span>
      <nav class="order-page-nav" aria-label="订单列表分页">
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
    </footer>
  </section>

  <section v-if="selected" class="admin-panel editor-panel admin-panel-spaced">
    <header class="admin-panel-header">
      <div>
        <h2>订单详情 · {{ selected.orderNo }}</h2>
        <p>订单、参会人与退款流水</p>
      </div>
      <button class="button secondary compact" type="button" @click="selected = undefined">
        关闭
      </button>
    </header>
    <div class="checkin-result">
      <div class="summary-row">
        <span>订单标识</span><strong class="mono-code">{{ selected.id }}</strong>
      </div>
      <div class="summary-row">
        <span>参会人</span><strong>{{ selected.attendeeName }} · {{ selected.attendeeMobile }} ·
          {{ selected.attendeeCompany }}</strong>
      </div>
      <div class="summary-row">
        <span>票种</span><strong>{{ selected.ticketTypeName }}</strong>
      </div>
      <div class="summary-row">
        <span>状态与金额</span><strong>{{ statusLabel(selected.status) }} · {{ money(selected.amount) }}</strong>
      </div>
      <div class="summary-row">
        <span>支付方式</span><strong>{{
          selected.paymentMethod === 'wechat' ? '微信支付' : selected.paymentMethod
        }}</strong>
      </div>
      <div class="summary-row">
        <span>创建时间</span><strong>{{ dateTime(selected.createdAt) }}</strong>
      </div>
      <div class="summary-row">
        <span>退款记录</span>
        <strong v-if="selectedRefunds.length">{{
          selectedRefunds
            .map((item) => `${money(item.amount)} · ${statusLabel(item.status)}`)
            .join('；')
        }}</strong>
        <strong v-else>无</strong>
      </div>
    </div>
  </section>
</template>

<style scoped>
.order-pagination {
  min-height: 64px;
  flex-wrap: wrap;
}

.order-page-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.order-page-nav button {
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
    border-color 140ms var(--ease);
}

.order-page-nav button:hover:not(:disabled) {
  color: var(--blue);
  background: var(--blue-soft);
  border-color: color-mix(in srgb, var(--blue) 28%, var(--line));
}

.order-page-nav button.active {
  color: #fff;
  background: var(--blue);
  border-color: var(--blue);
}

.order-page-nav button:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.order-page-nav button:focus-visible {
  border-color: var(--blue);
  outline: 2px solid color-mix(in srgb, var(--blue) 18%, transparent);
  outline-offset: 1px;
}

.page-ellipsis {
  width: 20px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  text-align: center;
}

@media (max-width: 760px) {
  .order-pagination {
    justify-content: center;
  }

  .order-pagination > span {
    width: 100%;
    text-align: center;
  }
}

@media (max-width: 520px) {
  .order-page-nav button {
    width: 40px;
    height: 40px;
  }
}
</style>
