<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AdminDashboard } from '@conference/contracts';
import { useRoute } from 'vue-router';
import { conferenceApi, session, type AdminRegistrationRow } from '../lib/api';
import { dateTime, statusClass, statusLabel } from '../lib/format';

const route = useRoute();
const dashboard = ref<AdminDashboard>();
const registrations = ref<AdminRegistrationRow[]>([]);
const pendingPaymentCount = ref(0);
const loading = ref(true);
const errorMessage = ref('');
const trendDays = ref<7 | 14>(14);
const trendOptions = [7, 14] as const;
const todayLabel = new Intl.DateTimeFormat('zh-CN', {
  weekday: 'long',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

const money = (amount = 0) =>
  `¥${(amount / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const visibleTrend = computed(() =>
  (dashboard.value?.registrationTrend ?? []).slice(-trendDays.value),
);
const eventRoute = (name: string) => ({
  name,
  params: { eventId: String(route.params.eventId) },
});
const chart = computed(() => {
  const values = visibleTrend.value;
  if (!values.length) return { line: '', area: '', labels: [] as { x: number; text: string }[] };
  const width = 658;
  const left = 46;
  const bottom = 175;
  const top = 25;
  const max = Math.max(...values.map((item) => item.value), 1);
  const points = values.map((item, index) => {
    const x = left + (index / Math.max(values.length - 1, 1)) * width;
    const y = bottom - (item.value / max) * (bottom - top);
    return { x, y, text: item.date };
  });
  const line = points
    .map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${points.at(-1)!.x.toFixed(1)},${bottom} L${left},${bottom} Z`;
  const labelIndexes = [...new Set([0, Math.floor((values.length - 1) / 2), values.length - 1])];
  return {
    line,
    area,
    labels: labelIndexes.map((index) => ({ x: points[index]!.x, text: points[index]!.text })),
  };
});

onMounted(async () => {
  try {
    const canReadRegistrations = session.can('event.registration.read');
    const [dashboardResult, latestRegistrations, pendingPayments] = await Promise.all([
      conferenceApi.getDashboard(),
      canReadRegistrations
        ? conferenceApi.getRegistrations({ page: 1, pageSize: 5 })
        : Promise.resolve(undefined),
      canReadRegistrations
        ? conferenceApi.getRegistrations({ status: 'pending_payment', page: 1, pageSize: 1 })
        : Promise.resolve(undefined),
    ]);
    dashboard.value = dashboardResult;
    registrations.value = latestRegistrations?.items ?? [];
    pendingPaymentCount.value = pendingPayments?.total ?? 0;
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
      <p class="eyebrow">{{ todayLabel }}</p>
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
          <strong>{{ dashboard.metrics.registrations.toLocaleString() }}</strong><span class="delta neutral">当前大会</span>
        </div>
      </article>
      <article class="admin-metric">
        <span>已支付订单</span>
        <div class="admin-metric-value">
          <strong>{{ dashboard.metrics.paidOrders.toLocaleString() }}</strong><span class="delta up">{{ dashboard.metrics.conversionRate }}% 转化</span>
        </div>
      </article>
      <article class="admin-metric">
        <span>实收金额</span>
        <div class="admin-metric-value">
          <strong class="metric-money">{{ money(dashboard.metrics.revenue) }}</strong><span class="delta neutral">累计实收</span>
        </div>
      </article>
      <article class="admin-metric">
        <span>现场已签到</span>
        <div class="admin-metric-value">
          <strong>{{ dashboard.metrics.checkedIn }}</strong><span class="delta neutral">会前模式</span>
        </div>
      </article>
    </section>

    <div class="dashboard-grid">
      <div class="dashboard-stack">
        <section class="admin-panel reveal is-visible" aria-labelledby="trend-title">
          <header class="admin-panel-header">
            <div>
              <h2 id="trend-title">报名趋势</h2>
              <p>最近 14 天每日新增报名</p>
            </div>
            <div class="panel-tabs">
              <button
                v-for="value in trendOptions"
                :key="value"
                class="panel-tab"
                :class="{ active: trendDays === value }"
                type="button"
                @click="trendDays = value"
              >
                {{ value }} 天
              </button>
            </div>
          </header>
          <div class="trend-wrap">
            <div class="trend-summary">
              <strong>{{ visibleTrend.reduce((sum, item) => sum + item.value, 0) }}</strong><span>近 {{ trendDays }} 天新增</span>
            </div>
            <svg
              class="trend-chart"
              viewBox="0 0 720 220"
              role="img"
              aria-label="最近 14 天报名趋势"
            >
              <line
                v-for="y in [25, 75, 125, 175]"
                :key="y"
                class="grid-line"
                x1="46"
                :y1="y"
                x2="704"
                :y2="y"
              />
              <path class="area" :d="chart.area" />
              <path class="line" :d="chart.line" />
              <text
                v-for="label in chart.labels"
                :key="label.text"
                class="axis-label"
                :x="label.x - 15"
                y="205"
              >
                {{ label.text }}
              </text>
            </svg>
            <div class="chart-legend">
              <span><i class="legend-dot"></i>每日新增报名</span><span><i class="legend-dot red"></i>趋势数据每 5 分钟更新</span>
            </div>
          </div>
        </section>

        <section
          v-if="session.can('event.registration.read')"
          class="admin-panel reveal is-visible"
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
          <div class="data-table-wrap">
            <table class="data-table">
              <caption class="sr-only">
                最近报名记录
              </caption>
              <thead>
                <tr>
                  <th>参会人</th>
                  <th>票种</th>
                  <th>状态</th>
                  <th>城市</th>
                  <th>提交时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in registrations.slice(0, 5)" :key="row.id">
                  <td>
                    <span class="row-title">{{ row.attendee.name }}</span><span class="row-sub">{{ row.attendee.company }}</span>
                  </td>
                  <td>{{ row.ticketType.name }}</td>
                  <td>
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
                  </td>
                  <td>{{ row.attendee.city }}</td>
                  <td>{{ new Date(row.createdAt).toLocaleDateString('zh-CN') }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="!registrations.length" class="admin-empty">当前大会暂无报名记录。</div>
          </div>
        </section>
      </div>

      <div class="dashboard-stack">
        <section class="admin-panel reveal is-visible" aria-labelledby="ticket-title">
          <header class="admin-panel-header">
            <div>
              <h2 id="ticket-title">票种库存</h2>
              <p>已售数量与总配额</p>
            </div>
            <span class="status-badge">报名开放</span>
          </header>
          <div class="ticket-progress-list">
            <div
              v-for="ticket in dashboard.ticketBreakdown"
              :key="ticket.id"
              class="ticket-progress"
            >
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
              v-if="session.canAny(['event.checkin.execute', 'event.checkin.manage'])"
              class="quick-action"
              :to="eventRoute('event-check-in')"
            >
              <span>02 / CHECK IN</span><strong>启动现场核销</strong>
            </RouterLink>
            <RouterLink
              v-if="session.can('event.content.manage')"
              class="quick-action"
              :to="eventRoute('event-content')"
            >
              <span>03 / CONTENT</span><strong>查看嘉宾与议程</strong>
            </RouterLink>
            <RouterLink
              v-if="session.can('event.manage')"
              class="quick-action"
              :to="eventRoute('event-settings-general')"
            >
              <span>04 / PUBLISH</span><strong>更新大会信息</strong>
            </RouterLink>
          </div>
        </section>
      </div>
    </div>
  </template>
</template>
