import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ref } from 'vue';
import { WeChatPayConfigurationSchema, type WeChatPayConfiguration } from '@conference/contracts';
import ManagementPaymentSettingsView from './ManagementPaymentSettingsView.vue';

const api = vi.hoisted(() => ({
  getWeChatPayConfiguration: vi.fn(),
  updateWeChatPayConfiguration: vi.fn(),
  testWeChatPayConfiguration: vi.fn(),
  unmatchedRefundNotifications: vi.fn(),
}));
vi.mock('../lib/api', () => ({ conferenceApi: api, session: { canAny: () => true } }));
vi.mock('vue-router', () => ({ useRoute: () => ({ hash: '' }) }));
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onMounted: vi.fn(),
  useSSRContext: () => ({ modules: new Set() }),
}));
vi.mock('../composables/settings-form-state', async () => {
  const { ref } = await import('vue');
  return {
    useSettingsFormScope: () => ({
      dirty: ref(false),
      clearDirty: vi.fn(),
      setBusy: vi.fn(),
      setResetHandler: vi.fn(),
    }),
  };
});

interface PaymentSettingsState {
  form: { refundFunding: '' | 'default' | 'available'; apiV3Key: string };
  configuration: Ref<WeChatPayConfiguration>;
  message: Ref<string>;
  errorMessage: Ref<string>;
  load: () => Promise<void>;
  save: () => Promise<void>;
  testConnection: () => Promise<void>;
}

function configuration(
  status: WeChatPayConfiguration['status'],
  refundFunding: 'default' | null = null,
) {
  return WeChatPayConfigurationSchema.parse({
    status,
    refundFunding,
    enabled: true,
    appId: 'wx-test',
    mchId: 'test-merchant',
    merchantCertificateSerial: 'TEST_SERIAL',
    platformPublicKeyId: 'PUB_KEY_ID_TEST',
    notifyUrl: 'https://example.test/notify',
    lastVerifiedAt: '2026-09-08T00:00:00Z',
    lastError: null,
    secretsPresent: {
      merchantPrivateKey: true,
      apiV3Key: true,
      platformPublicKey: true,
      appSecret: false,
    },
  });
}

async function settingsState(status: WeChatPayConfiguration['status'] = 'verified') {
  api.getWeChatPayConfiguration.mockResolvedValue(configuration(status));
  const setup = ManagementPaymentSettingsView.setup;
  if (!setup) throw new Error('Payment settings component has no setup function');
  const state = setup(
    {},
    { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() },
  ) as unknown as PaymentSettingsState;
  await state.load();
  return state;
}

describe('saving WeChat refund funding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.unmatchedRefundNotifications.mockResolvedValue([]);
    api.testWeChatPayConfiguration.mockRejectedValue(new Error('微信验证接口暂不可用'));
  });

  it('keeps verified funding saves independent of the WeChat verification endpoint', async () => {
    const state = await settingsState();
    state.form.refundFunding = 'default';
    api.updateWeChatPayConfiguration.mockResolvedValue(configuration('verified', 'default'));
    await state.save();
    expect(api.updateWeChatPayConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ refundFunding: 'default' }),
    );
    expect(api.testWeChatPayConfiguration).not.toHaveBeenCalled();
    expect(state.configuration.value.status).toBe('verified');
    expect(state.configuration.value.lastVerifiedAt).toBe('2026-09-08T00:00:00Z');
    expect(state.message.value).toBe('配置已保存，商户验证保持通过。');
    expect(state.errorMessage.value).toBe('');
  });

  it('verifies changed credentials based on the saved server status', async () => {
    const state = await settingsState();
    state.form.apiV3Key = 'test-key';
    api.updateWeChatPayConfiguration.mockResolvedValue(configuration('configured', 'default'));
    api.testWeChatPayConfiguration.mockResolvedValue({ ok: true, message: '连接验证通过' });
    api.getWeChatPayConfiguration.mockResolvedValue(configuration('verified', 'default'));
    await state.save();
    expect(api.testWeChatPayConfiguration).toHaveBeenCalledOnce();
    expect(state.configuration.value.status).toBe('verified');
    expect(state.message.value).toBe('连接验证通过');
  });

  it('keeps an unverified merchant unverified if the verification request fails', async () => {
    const state = await settingsState('configured');
    state.form.refundFunding = 'default';
    api.updateWeChatPayConfiguration.mockResolvedValue(configuration('configured', 'default'));
    await state.save();
    expect(api.testWeChatPayConfiguration).toHaveBeenCalledOnce();
    expect(state.configuration.value.status).toBe('configured');
    expect(state.errorMessage.value).toBe('微信验证接口暂不可用');
  });

  it('allows explicitly revalidating a verified merchant', async () => {
    const state = await settingsState();
    await state.testConnection();
    expect(api.testWeChatPayConfiguration).toHaveBeenCalledOnce();
    expect(state.errorMessage.value).toBe('微信验证接口暂不可用');
  });
});
