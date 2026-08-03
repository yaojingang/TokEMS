<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import type { Refund } from '@conference/contracts';
import { conferenceApi, session, type AdminOrderRow } from '../lib/api';
import { dateTime, money, statusClass, statusLabel } from '../lib/format';

const rows = ref<AdminOrderRow[]>([]);
const q = ref('');
const status = ref('');
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

async function load() {
  loading.value = true;
  try {
    [rows.value, inventory.value, refunds.value] = await Promise.all([
      conferenceApi.getOrders({ q: q.value, status: status.value }),
      canReadInventory ? conferenceApi.getInventory() : Promise.resolve([]),
      conferenceApi.getRefunds(),
    ]);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '订单数据读取失败';
  } finally {
    loading.value = false;
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
      <h1>订单与支付流水</h1>
      <p>查看订单状态、支付金额、票种与关联参会人。</p>
    </div>
    <div class="admin-head-actions">
      <button class="button secondary" type="button" @click="load">刷新流水</button><button class="button" type="button" :disabled="exporting" @click="exportData">
        {{ exporting ? '正在导出…' : '导出订单 CSV' }}
      </button>
    </div>
  </header>

  <form class="admin-filter-bar" @submit.prevent="load">
    <label class="admin-search"><span aria-hidden="true">⌕</span><input
      v-model="q"
      type="search"
      aria-label="搜索订单"
      placeholder="搜索订单号、参会人或公司"
    /></label>
    <select v-model="status" class="admin-select" aria-label="按订单状态筛选" @change="load">
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
        load();
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
          当前筛选合计
          {{ money(rows.reduce((sum, row) => sum + (row.status === 'paid' ? row.amount : 0), 0)) }}
        </p>
      </div>
      <span class="status-badge">{{ rows.length }} ORDERS</span>
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
              <span class="row-title">{{ row.attendeeName }}</span><span class="row-sub">{{ row.attendeeCompany }}</span>
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
    <footer class="table-footer">
      <span>订单与支付回调按幂等价处理</span>
      <span class="mono-code">PAGE 1</span>
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
        <span>参会人</span><strong>{{ selected.attendeeName }} · {{ selected.attendeeCompany }}</strong>
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
