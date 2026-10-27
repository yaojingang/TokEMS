import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSSRApp,
  effectScope,
  nextTick,
  reactive,
  watch,
  type EffectScope,
  type Ref,
} from 'vue';
import { renderToString } from 'vue/server-renderer';
import DashboardView from './DashboardView.vue';
import RegistrationsView from './RegistrationsView.vue';

const api = vi.hoisted(() => ({
  getDashboard: vi.fn(),
  getRegistrations: vi.fn(),
  getWaitlist: vi.fn(),
  getRegistrationCount: vi.fn(),
  getInvoicePendingCount: vi.fn(),
}));
const routing = vi.hoisted(() => ({
  route: { params: { eventId: '101' }, query: {} },
  push: vi.fn(),
}));
vi.mock('../lib/api', async () => {
  const { ref } = await import('vue');
  return {
    conferenceApi: api,
    publicEventUrl: () => '/register',
    session: {
      can: () => true,
      activeEvent: ref({
        id: 101,
        name: '测试大会',
        status: 'registration_open',
        startsAt: '2027-01-01',
        endsAt: '2027-01-02',
        city: '深圳',
      }),
    },
  };
});
vi.mock('vue-router', () => ({
  useRoute: () => routing.route,
  useRouter: () => ({ push: routing.push }),
}));
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({ modules: new Set() }),
}));

const scopes: EffectScope[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setupRegistration() {
  const setup = RegistrationsView.setup!;
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() =>
    setup({}, { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }),
  ) as unknown as {
    rows: Ref<Array<{ id: string }>>;
    loading: Ref<boolean>;
    q: Ref<string>;
    page: Ref<number>;
    load: (reset?: boolean) => Promise<void>;
    registrationSection: { data: Ref<unknown>; error: Ref<string> };
    waitlistSection: { loading: Ref<boolean> };
  };
}
async function render(component: typeof DashboardView | typeof RegistrationsView) {
  const app = createSSRApp(component);
  app.component('RouterLink', { template: '<a><slot /></a>' });
  return renderToString(app);
}

describe('admin first paint and independent loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routing.route = reactive({ params: { eventId: '101' }, query: {} });
    for (const mock of Object.values(api)) mock.mockImplementation(() => new Promise(() => {}));
  });

  it('renders dashboard titles, actions and animated value placeholders before any data arrives', async () => {
    const html = await render(DashboardView);
    for (const label of [
      '累计报名',
      '实收金额',
      '票种库存',
      '运营待办',
      '快捷操作',
      '报名趋势',
      '最近报名',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('admin-skeleton-number');
    expect(html).not.toContain('LOADING OPERATIONS DATA');
    expect(html).not.toContain('当前大会暂无报名记录');
  });

  it('renders table skeletons and an unknown total instead of a zero count', async () => {
    const html = await render(RegistrationsView);
    expect(html).toContain('正在读取报名记录');
    expect(html).toContain('admin-skeleton-row');
    expect(html).toContain('购票人');
    expect(html).not.toContain('<strong>0</strong>');
    expect(html).not.toContain('0 WAITING');
    expect(html).not.toContain('当前筛选条件下没有报名记录');
  });

  it('shows registrations before the waitlist and does not reload the waitlist for filters', async () => {
    api.getRegistrations.mockResolvedValue({
      items: [{ id: 'ready' }],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    const view = setupRegistration();
    await vi.waitFor(() => expect(view.rows.value).toEqual([{ id: 'ready' }]));
    expect(view.loading.value).toBe(false);
    expect(view.waitlistSection.loading.value).toBe(true);
    await view.load();
    expect(api.getWaitlist).toHaveBeenCalledTimes(1);
  });

  it('clears old data on conference change and rejects the old conference response', async () => {
    const old = pending<unknown>();
    api.getRegistrations
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ items: [{ id: 'new-event' }], total: 1, page: 1, pageSize: 10 });
    const view = setupRegistration();
    routing.route.params.eventId = '102';
    await nextTick();
    await vi.waitFor(() => expect(view.rows.value).toEqual([{ id: 'new-event' }]));
    old.resolve({ items: [{ id: 'old-event' }], total: 1, page: 1, pageSize: 10 });
    await nextTick();
    expect(view.rows.value).toEqual([{ id: 'new-event' }]);
    expect(api.getRegistrations).toHaveBeenLastCalledWith(
      expect.anything(),
      102,
      expect.any(AbortSignal),
    );
  });
  it('does not apply old pagination when context changes between publishing and consuming a result', async () => {
    const old = pending<unknown>();
    const next = pending<unknown>();
    api.getRegistrations.mockReturnValueOnce(old.promise).mockReturnValue(next.promise);
    const view = setupRegistration();
    const stop = watch(
      view.registrationSection.data,
      (value) => {
        if (value) routing.route.params.eventId = '102';
      },
      { flush: 'sync' },
    );
    old.resolve({ items: [{ id: 'old-event' }], total: 100, page: 7, pageSize: 10 });
    await vi.waitFor(() => expect(api.getRegistrations).toHaveBeenCalledTimes(2));
    expect(view.page.value).toBe(1);
    expect(view.rows.value).toEqual([]);
    stop();
  });
  it('does not publish old dashboard statistics after the conference has reset', async () => {
    const old = pending<unknown>();
    const next = pending<unknown>();
    api.getDashboard.mockReturnValueOnce(old.promise).mockReturnValue(next.promise);
    const scope = effectScope();
    scopes.push(scope);
    const view = scope.run(() =>
      DashboardView.setup!({}, { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }),
    ) as unknown as {
      summarySection: { data: Ref<unknown> };
      dashboard: Ref<{ eventId: number } | undefined>;
    };
    const stop = watch(
      view.summarySection.data,
      (value) => {
        if (value) routing.route.params.eventId = '102';
      },
      { flush: 'sync' },
    );
    old.resolve({ eventId: 101, registrationTrend: [], updatedAt: '2026-10-27T01:00:00.000Z' });
    await vi.waitFor(() => expect(api.getDashboard).toHaveBeenCalledTimes(2));
    expect(view.dashboard.value).toBeUndefined();
    stop();
  });
});
