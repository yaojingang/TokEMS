import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputedRef, Ref } from 'vue';
import { WeChatPayConfigurationSchema, type WeChatPayConfiguration } from '@conference/contracts';
import EventRegistrationSettingsView from './EventRegistrationSettingsView.vue';

const { updateEvent, canReadPayment } = vi.hoisted(() => ({
  updateEvent: vi.fn(),
  canReadPayment: vi.fn(() => false),
}));
vi.mock('../lib/api', () => ({
  conferenceApi: { updateEvent },
  session: { can: canReadPayment, canAny: () => true },
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
  paymentConfiguration: Ref<WeChatPayConfiguration | undefined>;
  refundPaymentReadiness: ComputedRef<string>;
  refundPaymentStatus: ComputedRef<string>;
  refundPaymentDescription: ComputedRef<string>;
  errorMessage: Ref<string>;
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
    canReadPayment.mockReturnValue(false);
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

  function payment(status: WeChatPayConfiguration['status'], refundFunding: 'default' | null) {
    return WeChatPayConfigurationSchema.parse({
      status,
      refundFunding,
      enabled: true,
      appId: 'wx-test',
      mchId: 'test-merchant',
      merchantCertificateSerial: 'TEST_SERIAL',
      platformPublicKeyId: 'PUB_KEY_ID_TEST',
      notifyUrl: 'https://example.test/notify',
      lastVerifiedAt: null,
      lastError: null,
      secretsPresent: {
        merchantPrivateKey: true,
        apiV3Key: true,
        platformPublicKey: true,
        appSecret: false,
      },
    });
  }

  it.each([
    ['verified', null, '商户验证已通过，请选择退款出资账户。'],
    ['configured', 'default', '退款出资账户已设置，请完成商户验证。'],
    ['error', 'default', '退款出资账户已设置，商户验证失败，请前往支付设置重新验证。'],
    ['unconfigured', null, '请完成商户配置与验证，并选择退款出资账户。'],
  ] as const)(
    'explains and blocks an incomplete configuration (%s, %s)',
    async (status, funding, description) => {
      canReadPayment.mockReturnValue(true);
      const state = settingsState();
      state.paymentConfiguration.value = payment(status, funding);
      state.settingsForm.refundEnabled = true;
      expect(state.refundPaymentReadiness.value).toBe('incomplete');
      expect(state.refundPaymentDescription.value).toBe(description);
      await state.saveRefundPolicy();
      expect(updateEvent).not.toHaveBeenCalled();
      expect(state.errorMessage.value).toBe(description);
    },
  );

  it('saves when both conditions are met without claiming a verified refund transaction', async () => {
    canReadPayment.mockReturnValue(true);
    const state = settingsState();
    state.paymentConfiguration.value = payment('verified', 'default');
    state.settingsForm.refundEnabled = true;
    expect(state.refundPaymentStatus.value).toBe('退款开启条件已满足');
    await state.saveRefundPolicy();
    expect(updateEvent).toHaveBeenCalledOnce();
    expect(state.savedRefundEnabled.value).toBe(true);
  });

  it('allows closing the entry with incomplete payment configuration', async () => {
    canReadPayment.mockReturnValue(true);
    const state = settingsState();
    state.paymentConfiguration.value = payment('configured', null);
    state.savedRefundEnabled.value = true;
    await state.saveRefundPolicy();
    expect(updateEvent).toHaveBeenCalledWith({
      settings: { refunds: { enabled: false, version: 'seven-day-v1', windowDays: 7 } },
    });
  });

  it.each([false, true])(
    'lets the server validate unavailable payment settings (read access: %s)',
    async (canRead) => {
      canReadPayment.mockReturnValue(canRead);
      const state = settingsState();
      state.settingsForm.refundEnabled = true;
      updateEvent.mockRejectedValueOnce(new Error('尚未确认微信退款出资配置'));
      expect(state.refundPaymentReadiness.value).toBe('unknown');
      await state.saveRefundPolicy();
      expect(updateEvent).toHaveBeenCalledOnce();
      expect(state.savedRefundEnabled.value).toBe(false);
      expect(state.errorMessage.value).toBe('尚未确认微信退款出资配置');
    },
  );
});
