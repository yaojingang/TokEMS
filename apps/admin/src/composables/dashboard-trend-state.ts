import { ref } from 'vue';
import type { AdminDashboard, AdminDashboardQuery } from '@conference/contracts';

export type DashboardTrendPreset = 7 | 14 | 30 | 'custom';

type DashboardLoader = (query: AdminDashboardQuery) => Promise<AdminDashboard>;

const fullDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const partialDatePattern = /^\d{2}-\d{2}$/u;

const isCalendarDate = (value: string) => {
  if (!fullDatePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const isPartialCalendarDate = (value: string) => {
  if (!partialDatePattern.test(value)) return false;
  return isCalendarDate(`2000-${value}`);
};

const sanitizeRegistrationTrend = (dashboard: AdminDashboard) => {
  const rawTrend: unknown = (dashboard as { registrationTrend?: unknown }).registrationTrend;
  if (!Array.isArray(rawTrend)) return [];

  return rawTrend.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { date, value } = item as { date?: unknown; value?: unknown };
    if (
      typeof date !== 'string' ||
      (!isCalendarDate(date) && !isPartialCalendarDate(date)) ||
      typeof value !== 'number' ||
      !Number.isFinite(value)
    ) {
      return [];
    }
    return [{ date, value: Math.max(0, Math.trunc(value)) }];
  });
};

const normalizeLegacyTrendDates = (dashboard: AdminDashboard): AdminDashboard => {
  const sanitizedTrend = sanitizeRegistrationTrend(dashboard);
  if (!sanitizedTrend.length) return { ...dashboard, registrationTrend: [] };
  if (sanitizedTrend.every((item) => isCalendarDate(item.date))) {
    return { ...dashboard, registrationTrend: sanitizedTrend };
  }
  if (!sanitizedTrend.every((item) => isPartialCalendarDate(item.date))) {
    return {
      ...dashboard,
      registrationTrend: sanitizedTrend.filter((item) => isCalendarDate(item.date)),
    };
  }

  const updatedAt = new Date(dashboard.updatedAt);
  const reference = Number.isNaN(updatedAt.getTime()) ? new Date() : updatedAt;
  const referenceMonthDay = reference.toISOString().slice(5, 10);
  let year = reference.getUTCFullYear();
  const lastMonthDay = sanitizedTrend.at(-1)!.date;
  if (lastMonthDay > referenceMonthDay) year -= 1;

  let nextMonthDay: string | undefined;
  const registrationTrend = [...sanitizedTrend];
  for (let index = registrationTrend.length - 1; index >= 0; index -= 1) {
    const item = registrationTrend[index]!;
    if (nextMonthDay && item.date > nextMonthDay) year -= 1;
    registrationTrend[index] = { ...item, date: `${year}-${item.date}` };
    nextMonthDay = item.date;
  }
  return { ...dashboard, registrationTrend };
};

const rangeFromDashboard = (dashboard: AdminDashboard) => {
  const from = dashboard.registrationTrend[0]?.date;
  const to = dashboard.registrationTrend.at(-1)?.date;
  return from && to && isCalendarDate(from) && isCalendarDate(to) ? { from, to } : undefined;
};

const rangeEndingAt = (to: string, days: number) => {
  const from = new Date(`${to}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - days + 1);
  return { from: from.toISOString().slice(0, 10), to };
};

export function createDashboardTrendState(loadDashboard: DashboardLoader) {
  const dashboard = ref<AdminDashboard>();
  const trendLoading = ref(false);
  const trendErrorMessage = ref('');
  const trendPreset = ref<DashboardTrendPreset>(14);
  const appliedTrendRange = ref({ from: '', to: '' });
  const customTrendFrom = ref('');
  const customTrendTo = ref('');
  let trendRequestId = 0;

  function acceptDashboard(result: AdminDashboard) {
    const normalizedDashboard = normalizeLegacyTrendDates(result);
    dashboard.value = normalizedDashboard;
    const range = rangeFromDashboard(normalizedDashboard);
    if (!range) return;
    appliedTrendRange.value = range;
    if (!customTrendFrom.value || !customTrendTo.value) {
      const customRange = rangeEndingAt(range.to, 30);
      customTrendFrom.value = customRange.from;
      customTrendTo.value = customRange.to;
    }
  }

  async function loadTrend(query: AdminDashboardQuery) {
    const requestId = ++trendRequestId;
    trendLoading.value = true;
    trendErrorMessage.value = '';
    try {
      const result = await loadDashboard(query);
      if (requestId !== trendRequestId) return false;
      acceptDashboard(result);
      return true;
    } catch (error) {
      if (requestId !== trendRequestId) return false;
      trendErrorMessage.value = error instanceof Error ? error.message : '报名趋势读取失败';
      return false;
    } finally {
      if (requestId === trendRequestId) trendLoading.value = false;
    }
  }

  async function selectTrendPreset(value: DashboardTrendPreset) {
    trendErrorMessage.value = '';
    if (value === 'custom') {
      trendPreset.value = value;
      return;
    }
    if (await loadTrend({ days: value })) trendPreset.value = value;
  }

  async function applyCustomTrend() {
    if (!customTrendFrom.value || !customTrendTo.value) {
      trendErrorMessage.value = '请选择完整的开始和结束日期';
      return false;
    }
    const from = Date.parse(`${customTrendFrom.value}T00:00:00.000Z`);
    const to = Date.parse(`${customTrendTo.value}T00:00:00.000Z`);
    if (from > to) {
      trendErrorMessage.value = '结束日期不能早于开始日期';
      return false;
    }
    if ((to - from) / 86_400_000 + 1 > 366) {
      trendErrorMessage.value = '单次最多查看 366 天的趋势';
      return false;
    }
    return loadTrend({ from: customTrendFrom.value, to: customTrendTo.value });
  }

  return {
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
  };
}
