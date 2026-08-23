import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_SESSION_REQUEST_TIMEOUT_MS,
  useCustomerSession,
} from './useCustomerSession';

describe('useCustomerSession refresh', () => {
  beforeEach(() => {
    const state = new Map<string, { value: unknown }>();
    vi.stubGlobal('useRuntimeConfig', () => ({
      apiInternalBase: 'http://api:4100/api/v1',
      public: {
        apiBase: '/api/v1',
        organizationSlug: 'geo-conference',
      },
    }));
    vi.stubGlobal('useState', (key: string, initialize: () => unknown) => {
      if (!state.has(key)) state.set(key, { value: initialize() });
      return state.get(key);
    });
    vi.stubGlobal('readonly', <T>(value: T) => value);
  });

  it('finishes the initial loading state when the session request fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('gateway unavailable'));
    vi.stubGlobal('$fetch', request);
    const customer = useCustomerSession();

    await expect(customer.refresh()).rejects.toThrow('gateway unavailable');

    expect(customer.loaded.value).toBe(true);
    expect(request).toHaveBeenCalledWith(
      '/customer-auth/session',
      expect.objectContaining({ timeout: CUSTOMER_SESSION_REQUEST_TIMEOUT_MS }),
    );
  });

  it('allows a forced retry after a failed session request', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ authenticated: false });
    vi.stubGlobal('$fetch', request);
    const customer = useCustomerSession();

    await expect(customer.refresh()).rejects.toThrow('temporary failure');
    await expect(customer.refresh(true)).resolves.toBeNull();

    expect(request).toHaveBeenCalledTimes(2);
    expect(customer.loaded.value).toBe(true);
    expect(customer.session.value).toBeNull();
  });

  it('bounds the purchase-context request that controls the home CTA', async () => {
    const request = vi.fn().mockResolvedValue({});
    vi.stubGlobal('$fetch', request);
    const customer = useCustomerSession();

    await customer.purchaseContext(14);

    expect(request).toHaveBeenCalledWith(
      '/customer/events/14/purchase-context',
      expect.objectContaining({ timeout: CUSTOMER_SESSION_REQUEST_TIMEOUT_MS }),
    );
  });
});
