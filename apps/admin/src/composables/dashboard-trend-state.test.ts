import { describe, expect, it, vi } from 'vitest';
import type { AdminDashboard, AdminDashboardQuery } from '@conference/contracts';
import { createDashboardTrendState } from './dashboard-trend-state';

const dashboardForRange = (from: string, to: string, value = 1): AdminDashboard => {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return {
    eventId: 101,
    eventName: '测试大会',
    updatedAt: '2026-08-04T00:00:00.000Z',
    metrics: {
      registrations: 1,
      paidOrders: 1,
      revenue: 100,
      checkedIn: 0,
      conversionRate: 100,
      pendingReview: 0,
    },
    registrationTrend: dates.map((date) => ({ date, value })),
    ticketBreakdown: [],
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('dashboard trend state', () => {
  it('keeps a late response from replacing the newest preset', async () => {
    const sevenDays = deferred<AdminDashboard>();
    const thirtyDays = deferred<AdminDashboard>();
    const loader = vi.fn((query: AdminDashboardQuery) =>
      query.days === 7 ? sevenDays.promise : thirtyDays.promise,
    );
    const state = createDashboardTrendState(loader);

    const first = state.selectTrendPreset(7);
    const second = state.selectTrendPreset(30);
    thirtyDays.resolve(dashboardForRange('2026-07-06', '2026-08-04', 30));
    await second;
    sevenDays.resolve(dashboardForRange('2026-07-29', '2026-08-04', 7));
    await first;

    expect(state.trendPreset.value).toBe(30);
    expect(state.dashboard.value?.registrationTrend[0]?.value).toBe(30);
    expect(state.appliedTrendRange.value).toEqual({ from: '2026-07-06', to: '2026-08-04' });
  });

  it('keeps the applied preset when a new preset request fails', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('网络暂时不可用'));
    const state = createDashboardTrendState(loader);
    state.acceptDashboard(dashboardForRange('2026-07-22', '2026-08-04'));

    await state.selectTrendPreset(30);

    expect(state.trendPreset.value).toBe(14);
    expect(state.trendErrorMessage.value).toBe('网络暂时不可用');
    expect(state.appliedTrendRange.value).toEqual({ from: '2026-07-22', to: '2026-08-04' });
  });

  it('keeps custom drafts separate until they are applied', async () => {
    const loader = vi.fn(async (query: AdminDashboardQuery) =>
      dashboardForRange(query.from!, query.to!),
    );
    const state = createDashboardTrendState(loader);
    state.acceptDashboard(dashboardForRange('2026-07-22', '2026-08-04'));
    await state.selectTrendPreset('custom');
    state.customTrendFrom.value = '2026-07-01';
    state.customTrendTo.value = '2026-07-10';

    expect(state.appliedTrendRange.value).toEqual({ from: '2026-07-22', to: '2026-08-04' });

    await state.applyCustomTrend();

    expect(loader).toHaveBeenCalledWith({ from: '2026-07-01', to: '2026-07-10' });
    expect(state.appliedTrendRange.value).toEqual({ from: '2026-07-01', to: '2026-07-10' });
  });

  it('normalizes legacy month-day trend values across a year boundary', () => {
    const state = createDashboardTrendState(vi.fn());
    const legacyDashboard = dashboardForRange('2025-12-31', '2026-01-01');
    legacyDashboard.updatedAt = '2026-01-01T08:00:00.000Z';
    legacyDashboard.registrationTrend = [
      { date: '12-31', value: 2 },
      { date: '01-01', value: 3 },
    ];

    expect(() => state.acceptDashboard(legacyDashboard)).not.toThrow();
    expect(state.dashboard.value?.registrationTrend).toEqual([
      { date: '2025-12-31', value: 2 },
      { date: '2026-01-01', value: 3 },
    ]);
    expect(state.appliedTrendRange.value).toEqual({ from: '2025-12-31', to: '2026-01-01' });
    expect(state.customTrendTo.value).toBe('2026-01-01');
  });

  it('drops malformed trend items before rendering chart data', () => {
    const state = createDashboardTrendState(vi.fn());
    const malformedDashboard = dashboardForRange('2026-08-03', '2026-08-04');
    malformedDashboard.registrationTrend = [
      { date: null, value: 2 },
      { date: 20260803, value: 3 },
      { date: '2026-08-03', value: '4' },
      { date: '2026-08-04', value: 5.9 },
    ] as unknown as AdminDashboard['registrationTrend'];

    expect(() => state.acceptDashboard(malformedDashboard)).not.toThrow();
    expect(state.dashboard.value?.registrationTrend).toEqual([{ date: '2026-08-04', value: 5 }]);
  });
});
