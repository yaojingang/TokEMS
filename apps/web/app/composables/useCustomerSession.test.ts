import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CUSTOMER_SESSION_REQUEST_TIMEOUT_MS, useCustomerSession } from './useCustomerSession';

function draftStorage() {
  const values = new Map([
    ['conference.batchRegistrationDraft.geo.14.customer%3A333.intent-a', 'batch draft'],
    ['conference.batchRegistrationDraft.geo.14.customer%3A444.intent-b', 'other batch draft'],
    ['conference.registrationDraft.geo.14.customer%3A333.self.intent-c.v1', 'own draft'],
    ['conference.registrationDraft.geo.14.customer%3A444.self.intent-d.v1', 'other draft'],
    ['conference.registrationDraft.geo.14.anonymous.self.intent-e.v1', 'anonymous draft'],
    ['unrelated.customer%3A333', 'keep'],
  ]);
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe('useCustomerSession refresh', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
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

  it('automatically retries after a failed session request', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ authenticated: false });
    vi.stubGlobal('$fetch', request);
    const customer = useCustomerSession();

    await expect(customer.refresh()).rejects.toThrow('temporary failure');
    await expect(customer.refresh()).resolves.toBeNull();

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

  it('sends a valid idempotency key when editing a selected order item', async () => {
    const request = vi.fn().mockResolvedValue({});
    vi.stubGlobal('$fetch', request);
    const customer = useCustomerSession();
    await customer.updatePurchasedOrderAttendee(
      'order-1',
      { company: '更正公司' },
      {
        id: 'item-1',
        version: 4,
      },
    );
    expect(request).toHaveBeenCalledWith(
      '/customer/orders/order-1/items/item-1/attendee',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/i),
        }),
        body: { company: '更正公司', expectedVersion: 4 },
      }),
    );
  });

  it('reuses the caller request key for an item edit retry and preserves the legacy endpoint', async () => {
    const request = vi.fn().mockResolvedValue({});
    vi.stubGlobal('$fetch', request);
    const customer = useCustomerSession();
    for (let attempt = 0; attempt < 2; attempt += 1)
      await customer.updatePurchasedOrderAttendee(
        'order-1',
        { company: '更正公司' },
        {
          id: 'item-1',
          version: 4,
        },
        'same-logical-item-edit',
      );
    for (const call of request.mock.calls)
      expect(call[1].headers['Idempotency-Key']).toBe('same-logical-item-edit');
    await customer.updatePurchasedOrderAttendee('legacy-order', { company: '历史订单公司' });
    expect(request).toHaveBeenLastCalledWith(
      '/customer/orders/legacy-order/attendee',
      expect.objectContaining({ body: { company: '历史订单公司' } }),
    );
    expect(request.mock.lastCall?.[1].headers['Idempotency-Key']).toBeUndefined();
  });

  it('bounds attendee-needs enrichment requests in the personal center', async () => {
    const request = vi.fn().mockResolvedValue({});
    vi.stubGlobal('$fetch', request);
    const customer = useCustomerSession();

    await customer.attendeeNeeds('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    expect(request).toHaveBeenCalledWith(
      '/customer/registrations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/needs',
      expect.objectContaining({ timeout: CUSTOMER_SESSION_REQUEST_TIMEOUT_MS }),
    );
  });

  for (const all of [false, true]) {
    it(`clears product batch drafts and only this customer's single drafts after explicit logout: all=${all}`, async () => {
      const localStorage = draftStorage();
      const sessionStorage = draftStorage();
      vi.stubGlobal('window', { localStorage, sessionStorage });
      const request = vi
        .fn()
        .mockResolvedValueOnce({ authenticated: true, customer: { id: 333 }, csrfToken: 'csrf' });
      vi.stubGlobal('$fetch', request);
      const customer = useCustomerSession();
      await customer.refresh();
      await customer.logout(all);
      expect(request).toHaveBeenLastCalledWith(
        `/customer-auth/${all ? 'logout-all' : 'logout'}`,
        expect.objectContaining({ method: 'POST' }),
      );
      for (const storage of [localStorage, sessionStorage]) {
        expect([...storage.values.keys()]).toEqual([
          'conference.registrationDraft.geo.14.customer%3A444.self.intent-d.v1',
          'conference.registrationDraft.geo.14.anonymous.self.intent-e.v1',
          'unrelated.customer%3A333',
        ]);
      }
      expect(customer.session.value).toBeNull();
    });
  }

  it('keeps saved drafts and the session when explicit logout fails', async () => {
    const localStorage = draftStorage();
    const sessionStorage = draftStorage();
    const expected = [...localStorage.values.entries()];
    vi.stubGlobal('window', { localStorage, sessionStorage });
    vi.stubGlobal(
      '$fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ authenticated: true, customer: { id: 333 }, csrfToken: 'csrf' })
        .mockRejectedValueOnce(new Error('logout failed')),
    );
    const customer = useCustomerSession();
    await customer.refresh();
    await expect(customer.logout()).rejects.toThrow('logout failed');
    expect(customer.session.value?.customer.id).toBe(333);
    for (const storage of [localStorage, sessionStorage])
      expect([...storage.values.entries()]).toEqual(expected);
  });

  it('clears drafts after the registration page reacts to losing the session', async () => {
    const { ref, watch } = await import('vue');
    const state = new Map<string, ReturnType<typeof ref>>();
    vi.stubGlobal('useState', (key: string, initialize: () => unknown) => {
      if (!state.has(key)) state.set(key, ref(initialize()));
      return state.get(key);
    });
    const localStorage = draftStorage();
    vi.stubGlobal('window', { localStorage, sessionStorage: draftStorage() });
    vi.stubGlobal(
      '$fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ authenticated: true, customer: { id: 333 }, csrfToken: 'csrf' }),
    );
    const customer = useCustomerSession();
    await customer.refresh();
    const key = 'conference.registrationDraft.geo.14.customer%3A333.self.intent-c.v1';
    const stop = watch(customer.session, (session) => {
      if (!session) localStorage.setItem(key, 'last draft saved on identity transition');
    });
    try {
      await customer.logout();
      expect(localStorage.getItem(key)).toBeNull();
    } finally {
      stop();
    }
  });

  it('keeps persistent drafts on session expiry and reauthentication', async () => {
    const localStorage = draftStorage();
    const sessionStorage = draftStorage();
    const expected = [...localStorage.values.entries()];
    vi.stubGlobal('window', { localStorage, sessionStorage });
    vi.stubGlobal(
      '$fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ authenticated: true, customer: { id: 333 }, csrfToken: 'csrf' })
        .mockRejectedValueOnce({ status: 401 })
        .mockResolvedValueOnce({ authenticated: false }),
    );
    const customer = useCustomerSession();
    await customer.refresh();
    await expect(customer.refresh(true)).rejects.toEqual({ status: 401 });
    customer.requestReauthentication();
    await customer.refresh(true);
    for (const storage of [localStorage, sessionStorage])
      expect([...storage.values.entries()]).toEqual(expected);
  });

  it('finishes logout when browser storage access is denied', async () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('Storage access denied');
      },
      get sessionStorage() {
        throw new Error('Storage access denied');
      },
    });
    vi.stubGlobal(
      '$fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ authenticated: true, customer: { id: 333 }, csrfToken: 'csrf' }),
    );
    const customer = useCustomerSession();
    await customer.refresh();
    await expect(customer.logout()).resolves.toBeUndefined();
    expect(customer.session.value).toBeNull();
  });
});
