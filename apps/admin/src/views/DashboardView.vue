<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { createDashboardTrendState } from '../composables/dashboard-trend-state';
import { conferenceApi, session, type AdminRegistrationRow } from '../lib/api';
import { dateTime, statusClass, statusLabel } from '../lib/format';

const route = useRoute();
const registrations = ref<AdminRegistrationRow[]>([]);
const pendingPaymentCount = ref(0);
const pendingInvoiceCount = ref<number | null>(null);
const loading = ref(true);
const errorMessage = ref('');
const trendOptions = [7, 14, 30] as const;
const trendChartStage = ref<HTMLElement>();
const trendChartSize = ref({ width: 720, height: 300 });
const hoveredTrendIndex = ref<number | null>(null);
let trendChartResizeObserver: ResizeObserver | undefined;
const {
  dashboard,
  trendLoading,
  trendErrorMessage,
  trendPreset,
  appliedTrendRange,
  customTrendFrom,
  customTrendTo,
  acceptDashboard,
  selectTrendPreset,
  applyCustomTrend,
} = createDashboardTrendState((query) => conferenceApi.getDashboard(query));
const money = (amount = 0) =>
  `¥${(amount / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const trendTotal = computed(() =>
  (dashboard.value?.registrationTrend ?? []).reduce((sum, item) => sum + item.value, 0),
);
const displayTrendDate = (value: string) =>
  (value.length === 10 ? value.slice(5) : value).replace('-', '/');
const displayFullDate = (value: string) => value.replaceAll('-', '.');
const trendRangeSummary = computed(() => {
  if (trendPreset.value !== 'custom') return `近 ${trendPreset.value} 天新增`;
  return `${displayFullDate(appliedTrendRange.value.from)} 至 ${displayFullDate(appliedTrendRange.value.to)}`;
});
const trendDescription = computed(() => {
  if (trendPreset.value !== 'custom') return `最近 ${trendPreset.value} 天每日新增报名`;
  return `自定义日期区间内的每日新增报名`;
});
const eventRoute = (name: string) => ({
  name,
  params: { eventId: String(route.params.eventId) },
});
const chart = computed(() => {
  const values = dashboard.value?.registrationTrend ?? [];
  const { width, height } = trendChartSize.value;
  const left = 14;
  const right = Math.max(left, width - 14);
  const top = 24;
  const bottom = Math.max(top, height - 30);
  const gridLines = [0, 1 / 3, 2 / 3, 1].map((ratio) => top + ratio * Math.max(0, bottom - top));
  if (!values.length) {
    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      gridLines,
      line: '',
      area: '',
      points: [] as { x: number; y: number; date: string; value: number }[],
      labels: [] as { x: number; text: string; anchor: 'start' | 'middle' | 'end' }[],
    };
  }
  const max = Math.max(...values.map((item) => item.value), 1);
  const points = values.map((item, index) => {
    const x =
      values.length === 1
        ? (left + right) / 2
        : left + (index / (values.length - 1)) * (right - left);
    const y = bottom - (item.value / max) * (bottom - top);
    return { x, y, date: item.date, value: item.value };
  });
  const line = points
    .map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${points.at(-1)!.x.toFixed(1)},${bottom} L${left},${bottom} Z`;
  const labelIndexes = [...new Set([0, Math.floor((values.length - 1) / 2), values.length - 1])];
  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    gridLines,
    line,
    area,
    points,
    labels: labelIndexes.map((index, labelIndex) => ({
      x: points[index]!.x,
      text: points[index]!.date,
      anchor: (labelIndex === 0
        ? 'start'
        : labelIndex === labelIndexes.length - 1
          ? 'end'
          : 'middle') as 'start' | 'middle' | 'end',
    })),
  };
});
const hoveredTrendPoint = computed(() =>
  hoveredTrendIndex.value === null ? undefined : chart.value.points[hoveredTrendIndex.value],
);
const trendTooltipClass = computed(() => {
  const point = hoveredTrendPoint.value;
  if (!point) return {};
  return {
    'align-right': point.x < chart.value.width * 0.18,
    'align-left': point.x > chart.value.width * 0.82,
    below: point.y < 74,
  };
});

function setHoveredTrendFromPointer(event: PointerEvent, includeTouch = false) {
  if ((!includeTouch && event.pointerType === 'touch') || !chart.value.points.length) return;
  const bounds = trendChartStage.value?.getBoundingClientRect();
  if (!bounds?.width) return;
  const x = ((event.clientX - bounds.left) / bounds.width) * chart.value.width;
  const ratio = Math.min(
    1,
    Math.max(0, (x - chart.value.left) / (chart.value.right - chart.value.left)),
  );
  hoveredTrendIndex.value = Math.round(ratio * (chart.value.points.length - 1));
}

function selectTrendFromPointer(event: PointerEvent) {
  setHoveredTrendFromPointer(event, true);
}

function moveHoveredTrend(direction: -1 | 1) {
  const lastIndex = chart.value.points.length - 1;
  if (lastIndex < 0) return;
  const current = hoveredTrendIndex.value ?? lastIndex;
  hoveredTrendIndex.value = Math.min(lastIndex, Math.max(0, current + direction));
}

watch(
  trendChartStage,
  (element) => {
    trendChartResizeObserver?.disconnect();
    trendChartResizeObserver = undefined;
    if (!element) return;
    const updateSize = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        trendChartSize.value = { width: bounds.width, height: bounds.height };
      }
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;
    trendChartResizeObserver = new ResizeObserver(updateSize);
    trendChartResizeObserver.observe(element);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => trendChartResizeObserver?.disconnect());

onMounted(async () => {
  try {
    const canReadRegistrations = session.can('event.registration.read');
    const canReadInvoices = session.can('org.invoice.read');
    const [dashboardResult, latestRegistrations, pendingPayments, pendingInvoices] =
      await Promise.all([
        conferenceApi.getDashboard(),
        canReadRegistrations
          ? conferenceApi.getRegistrations({ page: 1, pageSize: 5 })
          : Promise.resolve(undefined),
        canReadRegistrations
          ? conferenceApi.getRegistrations({ status: 'pending_payment', page: 1, pageSize: 1 })
          : Promise.resolve(undefined),
        canReadInvoices
          ? conferenceApi.getInvoicePendingCount().catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
    acceptDashboard(dashboardResult);
    registrations.value = latestRegistrations?.items ?? [];
    pendingPaymentCount.value = pendingPayments?.total ?? 0;
    pendingInvoiceCount.value = pendingInvoices?.count ?? null;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据读取失败';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <h1>{{ session.activeEvent.value?.name ?? '大会运营概览' }}</h1>
      <p class="event-page-context">
        <span
          v-if="session.activeEvent.value"
          class="status-badge"
          :class="statusClass(session.activeEvent.value.status)"
        >
          {{ statusLabel(session.activeEvent.value.status) }}
        </span>
        <span v-if="session.activeEvent.value">
          {{ dateTime(session.activeEvent.value.startsAt) }} 至
          {{ dateTime(session.activeEvent.value.endsAt) }} · {{ session.activeEvent.value.city }}
        </span>
        <span>关注报名转化、待审核名单和各票种剩余库存。</span>
      </p>
    </div>
    <div class="admin-head-actions">
      <RouterLink
        v-if="session.can('event.registration.read')"
        class="button secondary"
        :to="eventRoute('event-registrations')"
      >
        处理待审核
      </RouterLink>
      <RouterLink
        v-if="session.can('event.manage')"
        class="button"
        :to="eventRoute('event-settings-general')"
      >
        编辑大会配置
      </RouterLink>
    </div>
  </header>

  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <div v-if="loading" class="admin-loading">LOADING OPERATIONS DATA…</div>
  <template v-else-if="dashboard">
    <section class="admin-metrics reveal is-visible" aria-label="核心指标">
      <article class="admin-metric">
        <span>累计报名</span>
        <div class="admin-metric-value">
          <strong>{{ dashboard.metrics.registrations.toLocaleString() }}</strong>
          <span class="delta neutral">当前大会</span>
        </div>
      </article>
      <article class="admin-metric">
        <span>付费席位</span>
        <div class="admin-metric-value">
          <strong>{{ dashboard.metrics.paidSeats.toLocaleString() }}</strong>
          <span class="delta up">{{ dashboard.metrics.conversionRate }}% 转化</span>
        </div>
      </article>
      <article class="admin-metric">
        <span>付费购票人</span>
        <div class="admin-metric-value">
          <strong>{{ dashboard.metrics.purchasers.toLocaleString() }}</strong>
          <span class="delta neutral">{{ dashboard.metrics.paidOrders.toLocaleString() }} 笔订单</span>
        </div>
      </article>
      <article class="admin-metric">
        <span>确认参会人</span>
        <div class="admin-metric-value">
          <strong>{{ dashboard.metrics.confirmedAttendees.toLocaleString() }}</strong>
          <span class="delta neutral">含已签到与已完成</span>
        </div>
      </article>
      <article class="admin-metric">
        <span>实收金额</span>
        <div class="admin-metric-value">
          <strong class="metric-money">{{ money(dashboard.metrics.revenue) }}</strong>
          <span class="delta neutral">累计实收</span>
        </div>
      </article>
      <article class="admin-metric">
        <span>发票开具情况</span>
        <div class="admin-metric-value">
          <strong>{{ pendingInvoiceCount?.toLocaleString() ?? '—' }}</strong>
          <span class="delta neutral">{{
            pendingInvoiceCount === null ? '暂不可用' : '项待处理'
          }}</span>
        </div>
      </article>
    </section>

    <div class="dashboard-overview-grid">
      <section class="admin-panel reveal is-visible" aria-labelledby="ticket-title">
        <header class="admin-panel-header">
          <div>
            <h2 id="ticket-title">票种库存</h2>
            <p>已售数量与总配额</p>
          </div>
          <span class="status-badge">报名开放</span>
        </header>
        <div class="ticket-progress-list">
          <div v-for="ticket in dashboard.ticketBreakdown" :key="ticket.id" class="ticket-progress">
            <div class="ticket-progress__label">
              <span>{{ ticket.name }}</span><span>{{ ticket.sold }} / {{ ticket.quota }}</span>
            </div>
            <div class="ticket-progress__track">
              <i :style="{ width: `${Math.min(100, (ticket.sold / ticket.quota) * 100)}%` }"></i>
            </div>
          </div>
        </div>
        <div v-if="!dashboard.ticketBreakdown.length" class="admin-empty">
          当前大会暂无票种库存数据。
        </div>
      </section>

      <section class="admin-panel reveal is-visible" aria-labelledby="health-title">
        <header class="admin-panel-header">
          <div>
            <h2 id="health-title">运营待办</h2>
            <p>需要运营人员关注的状态</p>
          </div>
          <span class="status-badge pending">{{ dashboard.metrics.pendingReview }} 项待处理</span>
        </header>
        <ul class="status-list">
          <li>
            <i class="status-dot red"></i><span><strong>待审核报名</strong><small>核实参会人身份与企业信息</small></span><b>{{ dashboard.metrics.pendingReview }}</b>
          </li>
          <li>
            <i class="status-dot gold"></i><span><strong>待支付订单</strong><small>即将超时的库存保留</small></span><b>{{ pendingPaymentCount }}</b>
          </li>
          <li>
            <i class="status-dot"></i><span><strong>大会发布状态</strong><small>报名通道正常开放</small></span><b>正常</b>
          </li>
        </ul>
      </section>

      <section class="admin-panel reveal is-visible" aria-labelledby="quick-title">
        <header class="admin-panel-header">
          <div>
            <h2 id="quick-title">快捷操作</h2>
            <p>日常运营任务</p>
          </div>
        </header>
        <div class="quick-actions">
          <RouterLink
            v-if="session.can('event.registration.read')"
            class="quick-action"
            :to="eventRoute('event-registrations')"
          >
            <span>01 / REVIEW</span><strong>处理报名审核</strong>
          </RouterLink>
          <RouterLink
            v-if="session.can('event.manage')"
            class="quick-action"
            :to="eventRoute('event-settings-general')"
          >
            <span>02 / PUBLISH</span><strong>更新大会信息</strong>
          </RouterLink>
        </div>
      </section>
    </div>

    <div class="dashboard-flow">
      <section class="admin-panel reveal is-visible" aria-labelledby="trend-title">
        <header class="admin-panel-header trend-panel-header">
          <div>
            <h2 id="trend-title">报名趋势</h2>
            <p>{{ trendDescription }}</p>
          </div>
          <div class="trend-toolbar">
            <div class="panel-tabs" aria-label="报名趋势日期范围">
              <button
                v-for="value in trendOptions"
                :key="value"
                class="panel-tab"
                :class="{ active: trendPreset === value }"
                type="button"
                :aria-pressed="trendPreset === value"
                :disabled="trendLoading"
                @click="selectTrendPreset(value)"
              >
                {{ value }} 天
              </button>
              <button
                class="panel-tab"
                :class="{ active: trendPreset === 'custom' }"
                type="button"
                :aria-pressed="trendPreset === 'custom'"
                :disabled="trendLoading"
                @click="selectTrendPreset('custom')"
              >
                自定义
              </button>
            </div>
            <form
              v-if="trendPreset === 'custom'"
              class="trend-date-range"
              aria-label="自定义报名趋势日期"
              @submit.prevent="applyCustomTrend"
            >
              <label>
                <span class="sr-only">开始日期</span>
                <input
                  v-model="customTrendFrom"
                  type="date"
                  :max="customTrendTo || undefined"
                  aria-label="趋势开始日期"
                  required
                />
              </label>
              <span aria-hidden="true">至</span>
              <label>
                <span class="sr-only">结束日期</span>
                <input
                  v-model="customTrendTo"
                  type="date"
                  :min="customTrendFrom"
                  aria-label="趋势结束日期"
                  required
                />
              </label>
              <button
                class="button secondary trend-date-apply"
                type="submit"
                :disabled="trendLoading"
              >
                {{ trendLoading ? '读取中' : '应用' }}
              </button>
            </form>
            <p v-if="trendErrorMessage" class="trend-range-error" role="alert">
              {{ trendErrorMessage }}
            </p>
          </div>
        </header>
        <div class="trend-wrap" :aria-busy="trendLoading">
          <div class="trend-summary">
            <strong>{{ trendTotal }}</strong><span>{{ trendRangeSummary }}</span>
            <small v-if="trendLoading" role="status">正在更新趋势…</small>
          </div>
          <div
            ref="trendChartStage"
            class="trend-chart-stage"
            tabindex="0"
            role="group"
            :aria-label="`${trendRangeSummary}报名趋势，使用左右方向键查看每天数据`"
            @pointermove="setHoveredTrendFromPointer"
            @pointerdown="selectTrendFromPointer"
            @pointerleave="hoveredTrendIndex = null"
            @focus="hoveredTrendIndex ??= Math.max(0, chart.points.length - 1)"
            @blur="hoveredTrendIndex = null"
            @keydown.left.prevent="moveHoveredTrend(-1)"
            @keydown.right.prevent="moveHoveredTrend(1)"
          >
            <svg
              class="trend-chart"
              :viewBox="`0 0 ${chart.width} ${chart.height}`"
              aria-hidden="true"
            >
              <line
                v-for="y in chart.gridLines"
                :key="y"
                class="grid-line"
                :x1="chart.left"
                :y1="y"
                :x2="chart.right"
                :y2="y"
              />
              <path class="area" :d="chart.area" />
              <path class="line" :d="chart.line" />
              <circle
                v-for="point in chart.points"
                :key="point.date"
                class="point"
                :cx="point.x"
                :cy="point.y"
                r="2.4"
              />
              <template v-if="hoveredTrendPoint">
                <line
                  class="trend-guide"
                  :x1="hoveredTrendPoint.x"
                  :y1="chart.top"
                  :x2="hoveredTrendPoint.x"
                  :y2="chart.bottom"
                />
                <circle
                  class="point active"
                  :cx="hoveredTrendPoint.x"
                  :cy="hoveredTrendPoint.y"
                  r="5"
                />
              </template>
              <text
                v-for="label in chart.labels"
                :key="label.text"
                class="axis-label"
                :x="label.x"
                :y="chart.height - 7"
                :text-anchor="label.anchor"
              >
                {{ displayTrendDate(label.text) }}
              </text>
            </svg>
            <div
              v-if="hoveredTrendPoint"
              class="trend-chart-tooltip"
              :class="trendTooltipClass"
              :style="{ left: `${hoveredTrendPoint.x}px`, top: `${hoveredTrendPoint.y}px` }"
              role="tooltip"
            >
              <span>{{ displayFullDate(hoveredTrendPoint.date) }}</span>
              <strong>{{ hoveredTrendPoint.value }}<small> 人</small></strong>
            </div>
            <p class="sr-only trend-chart-live" aria-live="polite" aria-atomic="true">
              <template v-if="hoveredTrendPoint">
                {{ displayFullDate(hoveredTrendPoint.date) }}，新增报名
                {{ hoveredTrendPoint.value }} 人
              </template>
            </p>
          </div>
          <div class="chart-legend">
            <span><i class="legend-dot"></i>每日新增报名</span><span><i class="legend-dot red"></i>趋势数据每 5 分钟更新</span>
          </div>
        </div>
      </section>

      <section
        v-if="session.can('event.registration.read')"
        class="admin-panel dashboard-latest-panel reveal is-visible"
        aria-labelledby="latest-title"
      >
        <header class="admin-panel-header">
          <div>
            <h2 id="latest-title">最近报名</h2>
            <p>实时显示最新提交的参会人</p>
          </div>
          <RouterLink class="text-link" :to="eventRoute('event-registrations')">
            查看全部 →
          </RouterLink>
        </header>
        <ul v-if="registrations.length" class="latest-registration-list">
          <li v-for="row in registrations.slice(0, 5)" :key="row.id">
            <div class="latest-registration-person">
              <span class="row-title">{{ row.attendee.name }}</span>
              <span class="row-sub">{{ row.attendee.company }}</span>
            </div>
            <span
              class="status-badge"
              :class="{
                pending: row.status === 'pending_review',
                draft: row.status === 'pending_payment',
              }"
            >{{
              row.status === 'confirmed'
                ? '已确认'
                : row.status === 'pending_review'
                  ? '待审核'
                  : '待支付'
            }}</span>
            <div class="latest-registration-meta">
              <span>{{ row.ticketType.name }}</span>
              <span>{{ row.attendee.city }}</span>
              <time :datetime="row.createdAt">
                {{ new Date(row.createdAt).toLocaleDateString('zh-CN') }}
              </time>
            </div>
          </li>
        </ul>
        <div v-else class="admin-empty">当前大会暂无报名记录。</div>
      </section>
    </div>
  </template>
</template>
