<script setup lang="ts">
import { computed } from 'vue';
import type { FeishuDigestSnapshot } from '@conference/contracts';
const props = defineProps<{ snapshot: FeishuDigestSnapshot }>();
function amount(value: number | null) {
  return value === null
    ? '待核对'
    : new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: props.snapshot.currency,
        minimumFractionDigits: 2,
      }).format(value / 100);
}
const generatedAt = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: props.snapshot.event.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(new Date(props.snapshot.generatedAt)),
);
const showCheckins = computed(() => ['in_progress', 'ended'].includes(props.snapshot.event.status));
const daily = computed(() => [
  ['访问次数', props.snapshot.daily.pageViews ?? '暂无完整数据'],
  ['新增报名记录', props.snapshot.daily.newRegistrations],
  ['支付订单', props.snapshot.daily.paidOrders],
  ['支付金额', amount(props.snapshot.daily.grossReceipts)],
  ['退款成功', props.snapshot.daily.successfulRefunds ?? '待核对'],
  ['退款金额', amount(props.snapshot.daily.refundAmount)],
  ['支付净额', amount(props.snapshot.daily.netCash)],
  ...(showCheckins.value ? [['签到', props.snapshot.daily.checkins]] : []),
  ...(props.snapshot.metricVersion === 2
    ? [
        ['新增退款申请', props.snapshot.daily.refundRequests],
        ['新增开票需求', props.snapshot.daily.invoiceDemands],
        ['提交开票资料', props.snapshot.daily.invoiceSubmissions],
      ]
    : [['发票申请（V1）', props.snapshot.daily.invoiceRequests]]),
]);
const todos = computed(() => [
  ['报名待审核', props.snapshot.todos.pendingRegistrationReview],
  ...(props.snapshot.metricVersion === 2
    ? [
        ['退款待审核', props.snapshot.todos.refundPendingReview],
        ['退款等待资金', props.snapshot.todos.refundWaitingFunds],
        ['退款需关注', props.snapshot.todos.refundAttention],
      ]
    : []),
  ['发票待处理', props.snapshot.todos.invoiceActionable],
  ['发票待补资料', props.snapshot.monitoring.invoiceAwaitingDetails],
  ['开票中', props.snapshot.monitoring.invoiceIssuing],
  ['待支付', props.snapshot.monitoring.pendingPayments],
  ...(props.snapshot.metricVersion === 2
    ? [['退款处理中', props.snapshot.monitoring.refundProcessing]]
    : []),
  ['支付异常', props.snapshot.todos.paymentExceptions],
  ['合作咨询', props.snapshot.todos.cooperationRequests],
  ['低库存票种', props.snapshot.todos.lowStockTicketTypes],
]);
const quality = computed(() =>
  props.snapshot.metricVersion === 2
    ? [...new Set(props.snapshot.qualityIssues.map((issue) => issue.description))]
    : [],
);
</script>
<template>
  <article class="feishu-preview" aria-label="日报内容预览">
    <header>
      <p class="feishu-hint">
        运营日报 · {{ snapshot.metricVersion === 1 ? '历史 V1' : '数据预览' }}
      </p>
      <h3>{{ snapshot.event.name }}</h3>
      <p>{{ snapshot.reportDate }} · {{ snapshot.event.timezone }}</p>
    </header>
    <section>
      <h4>昨日新增</h4>
      <dl>
        <div v-for="[label, value] in daily" :key="String(label)">
          <dt>{{ label }}</dt>
          <dd>{{ value }}</dd>
        </div>
      </dl>
    </section>
    <section>
      <h4>当前待办</h4>
      <dl>
        <div v-for="[label, value] in todos" :key="String(label)">
          <dt>{{ label }}</dt>
          <dd>{{ value }}</dd>
        </div>
      </dl>
    </section>
    <section>
      <h4>当前累计</h4>
      <dl>
        <div>
          <dt>已支付订单</dt>
          <dd>{{ snapshot.cumulative.paidOrders }}</dd>
        </div>
        <div v-if="showCheckins">
          <dt>累计签到</dt>
          <dd>{{ snapshot.cumulative.checkins }}</dd>
        </div>
        <div>
          <dt>已确认参会</dt>
          <dd>{{ snapshot.cumulative.confirmedAttendees }} 人</dd>
        </div>
        <div>
          <dt>剩余库存</dt>
          <dd>{{ snapshot.cumulative.remainingInventory }} 席</dd>
        </div>
        <div>
          <dt>有效报名</dt>
          <dd>{{ snapshot.cumulative.validRegistrations }}</dd>
        </div>
        <div>
          <dt>{{ snapshot.metricVersion === 1 ? '累计净收入（历史 V1）' : '累计订单净额' }}</dt>
          <dd>{{ amount(snapshot.cumulative.netRevenue) }}</dd>
        </div>
      </dl>
    </section>
    <footer>
      <p v-for="issue in quality" :key="issue" class="feishu-quality">{{ issue }}</p>
      <p>生成于 {{ generatedAt }}，当前待办以此时刻为准。</p>
      <p>金额按业务流水统计。群内仅展示汇总数据，处理按钮进入后台。</p>
    </footer>
  </article>
</template>
