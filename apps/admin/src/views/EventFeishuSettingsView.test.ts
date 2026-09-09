import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ref } from 'vue';
import type { FeishuDigestDeliveryDetail, FeishuDigestTestMessage } from '@conference/contracts';
import EventFeishuSettingsView from './EventFeishuSettingsView.vue';

const api = vi.hoisted(() => ({
  getFeishuDelivery: vi.fn(),
  getFeishuDeliveries: vi.fn(),
  getFeishuBotConfiguration: vi.fn(),
  getFeishuDigestSubscription: vi.fn(),
  previewFeishuDigest: vi.fn(),
  refreshFeishuChats: vi.fn(),
  getFeishuChats: vi.fn(),
  updateFeishuDigestSubscription: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  conferenceApi: api,
  AdminApiError: class extends Error {},
  session: {
    can: () => true,
    identity: { value: { organization: { id: 'org' }, user: { id: 'user' } } },
  },
}));
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { eventId: '101' } }),
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn(),
}));
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  watch: vi.fn(),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({ modules: new Set() }),
}));
vi.mock('../composables/settings-form-state', async () => {
  const { ref } = await import('vue');
  return { provideSettingsFormState: () => ({ dirty: ref(false) }) };
});

interface State {
  detail: Ref<FeishuDigestDeliveryDetail | undefined>;
  activeDelivery: Ref<FeishuDigestDeliveryDetail | undefined>;
  resendConfirmed: Ref<boolean>;
  unresolvedTest: Ref<
    { key: string; input: FeishuDigestTestMessage; deliveryId?: string } | undefined
  >;
  openDetail: (id: string) => Promise<void>;
  startPolling: (id: string, event: number, scope: number) => void;
  persistTest: () => void;
  load: () => Promise<void>;
  loadChats: (refresh?: boolean) => Promise<void>;
  saveSettings: (enabled: boolean) => Promise<void>;
  editingTarget: Ref<boolean>;
  time: Ref<string>;
}
function state() {
  const setup = EventFeishuSettingsView.setup;
  if (!setup) throw new Error('Feishu settings component has no setup function');
  return setup({}, { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }) as unknown as State;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function delivery(
  id: string,
  status: FeishuDigestDeliveryDetail['status'],
): FeishuDigestDeliveryDetail {
  return {
    id,
    status,
    sourceDeliveryId: null,
    kind: 'manual_test',
    reportDate: '2026-09-08',
    chatName: '运营群',
    attempts: 0,
    scheduledAt: null,
    generatedAt: null,
    sentAt: null,
    providerMessageId: '',
    lastErrorCode: '',
    lastError: '',
    createdAt: '2026-09-09T01:00:00Z',
    resolution: null,
    availableActions: [],
    snapshot: null,
    card: null,
  };
}
const receipt = (deliveryId?: string) => ({
  key: 'attempt-key',
  input: {
    chatId: 'oc_group',
    dataVisibilityConfirmed: true as const,
    expectedConfigVersion: 1,
    expectedConnectionVersion: 1,
  },
  ...(deliveryId ? { deliveryId } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  api.getFeishuDigestSubscription.mockResolvedValue({ chatId: 'oc_group', sendLocalTime: '09:00' });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Feishu async operation ownership', () => {
  it('keeps the latest detail and its confirmation when an earlier response arrives late', async () => {
    const view = state();
    const a = deferred<FeishuDigestDeliveryDetail>();
    const b = deferred<FeishuDigestDeliveryDetail>();
    api.getFeishuDelivery.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const openingA = view.openDetail('A');
    const openingB = view.openDetail('B');
    b.resolve(delivery('B', 'unknown'));
    await openingB;
    view.resendConfirmed.value = true;
    a.resolve(delivery('A', 'unknown'));
    await openingA;
    expect(view.detail.value?.id).toBe('B');
    expect(view.resendConfirmed.value).toBe(true);
  });
  it('invalidates old polling results without clearing the newer test receipt', async () => {
    const view = state();
    const a = deferred<FeishuDigestDeliveryDetail>();
    api.getFeishuDelivery
      .mockReturnValueOnce(a.promise)
      .mockResolvedValueOnce(delivery('B', 'queued'));
    view.startPolling('A', 101, 0);
    view.unresolvedTest.value = receipt('B');
    view.persistTest();
    view.startPolling('B', 101, 0);
    await vi.advanceTimersByTimeAsync(0);
    a.resolve(delivery('A', 'sent'));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.activeDelivery.value?.id).toBe('B');
    expect(view.unresolvedTest.value?.deliveryId).toBe('B');
    expect(sessionStorage.getItem('tokems.feishu.test:org:user:101')).toContain('attempt-key');
  });
  it('clears a test receipt only when its own delivery reaches a terminal state', async () => {
    const view = state();
    view.unresolvedTest.value = receipt('B');
    view.persistTest();
    api.getFeishuDelivery
      .mockResolvedValueOnce(delivery('resend-A', 'sent'))
      .mockResolvedValueOnce(delivery('B', 'sent'));
    view.startPolling('resend-A', 101, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.unresolvedTest.value?.deliveryId).toBe('B');
    view.startPolling('B', 101, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.unresolvedTest.value).toBeUndefined();
    expect(sessionStorage.getItem('tokems.feishu.test:org:user:101')).toBeNull();
  });
  it('restores a pending request without associating it with another running test', async () => {
    const view = state();
    view.unresolvedTest.value = receipt();
    view.persistTest();
    api.getFeishuBotConfiguration.mockResolvedValue({ enabled: false });
    api.getFeishuDeliveries.mockResolvedValue([delivery('unrelated-A', 'queued')]);
    api.previewFeishuDigest.mockResolvedValue({ snapshot: null });
    await view.load();
    expect(api.getFeishuDelivery).not.toHaveBeenCalled();
    expect(view.unresolvedTest.value?.key).toBe('attempt-key');
  });
  it.each([true, false])(
    'preserves the draft baseline while background configuration refreshes (editing %s)',
    async (editing) => {
      const view = state();
      const original = {
        chatId: 'oc_original',
        chatName: '原群',
        sendLocalTime: '09:00',
        configVersion: 1,
        connectionVersion: 1,
      };
      const changed = {
        ...original,
        chatId: 'oc_changed',
        chatName: '新群',
        sendLocalTime: '10:00',
        configVersion: 2,
      };
      api.getFeishuBotConfiguration.mockResolvedValue({
        enabled: true,
        status: 'verified',
        connectionVersion: 1,
      });
      api.getFeishuDeliveries.mockResolvedValue([]);
      api.previewFeishuDigest.mockResolvedValue({ snapshot: null });
      api.getFeishuDigestSubscription
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(changed);
      api.refreshFeishuChats.mockResolvedValue({ connectionVersion: 1, items: [] });
      api.updateFeishuDigestSubscription.mockRejectedValue(new Error('模拟版本冲突'));
      await view.load();
      view.editingTarget.value = editing;
      if (editing) view.time.value = '09:30';
      await view.loadChats(true);
      await view.saveSettings(false);
      expect(api.updateFeishuDigestSubscription).toHaveBeenCalledWith(
        101,
        expect.objectContaining(
          editing
            ? { expectedConfigVersion: 1, chatId: 'oc_original', sendLocalTime: '09:30' }
            : { expectedConfigVersion: 2, chatId: 'oc_changed', sendLocalTime: '10:00' },
        ),
      );
    },
  );
});
