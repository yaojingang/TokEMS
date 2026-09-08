import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputedRef, Ref } from 'vue';
import EventRegistrationSettingsView from './EventRegistrationSettingsView.vue';

const { updateEvent } = vi.hoisted(() => ({ updateEvent: vi.fn() }));
vi.mock('../lib/api', () => ({
  conferenceApi: { updateEvent },
  session: { can: () => false, canAny: () => true },
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ hash: '' }) }));
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onMounted: vi.fn(),
  useSSRContext: () => ({ modules: new Set() }),
}));

interface RefundSettingsState {
  settingsForm: { refundEnabled: boolean };
  savedRefundEnabled: Ref<boolean>;
  refundPending: Ref<boolean>;
  refundPolicyDirty: ComputedRef<boolean>;
  saveRefundPolicy: () => Promise<void>;
}

function settingsState() {
  const setup = EventRegistrationSettingsView.setup;
  if (!setup) throw new Error('Refund settings component has no setup function');
  return setup(
    {},
    { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() },
  ) as unknown as RefundSettingsState;
}

describe('refund settings saving', () => {
  beforeEach(() => {
    updateEvent.mockReset();
  });

  it.each([false, true])(
    'keeps edits made while saving pending (initially %s)',
    async (initial) => {
      let finish!: () => void;
      updateEvent.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const state = settingsState();
      state.savedRefundEnabled.value = initial;
      state.settingsForm.refundEnabled = !initial;

      const saving = state.saveRefundPolicy();
      expect(updateEvent).toHaveBeenCalledWith({
        settings: { refunds: { enabled: !initial, version: 'seven-day-v1', windowDays: 7 } },
      });
      state.settingsForm.refundEnabled = initial;
      finish();
      await saving;

      expect(state.savedRefundEnabled.value).toBe(!initial);
      expect(state.refundPolicyDirty.value).toBe(true);
      expect(state.refundPending.value).toBe(false);
    },
  );

  it('allows only one request while the previous save is pending', async () => {
    let finish!: () => void;
    updateEvent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const state = settingsState();
    state.settingsForm.refundEnabled = true;
    const saving = state.saveRefundPolicy();
    void state.saveRefundPolicy();
    expect(updateEvent).toHaveBeenCalledTimes(1);
    finish();
    await saving;
  });
});
