import { describe, expect, it } from 'vitest';
import {
  clearRegistrationIntent,
  adoptRegistrationIntent,
  compactRegistrationPath,
  registrationIntentStorageKey,
  storedRegistrationIntent,
} from './purchase-journey.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe('registration intent without URL identifiers', () => {
  it('retires an anonymous intent on login so another customer starts a separate checkout', () => {
    const saved = storage();
    const anonymous = storedRegistrationIntent(saved, 'anonymous');
    const first = adoptRegistrationIntent(saved, 'anonymous', 'customer:A', anonymous);
    expect(first).toBe(anonymous);
    expect(saved.getItem('anonymous')).toBeNull();
    clearRegistrationIntent(saved, 'customer:A');
    const nextAnonymous = storedRegistrationIntent(saved, 'anonymous');
    const second = adoptRegistrationIntent(saved, 'anonymous', 'customer:B', nextAnonymous);
    expect(second).not.toBe(first);
  });
  it('restores the customer draft intent after logout and login', () => {
    const saved = storage();
    const existing = storedRegistrationIntent(saved, 'customer:A');
    const anonymous = storedRegistrationIntent(saved, 'anonymous');
    expect(adoptRegistrationIntent(saved, 'anonymous', 'customer:A', anonymous)).toBe(existing);
    expect(saved.getItem('anonymous')).toBeNull();
  });
  it('keeps an explicit restart through refresh and login even when the customer has an old intent', () => {
    const saved = storage();
    const previous = storedRegistrationIntent(saved, 'customer:A');
    const fresh = crypto.randomUUID();
    storedRegistrationIntent(saved, 'anonymous', fresh);
    const afterRefresh = storedRegistrationIntent(saved, 'anonymous');
    expect(adoptRegistrationIntent(saved, 'anonymous', 'customer:A', afterRefresh)).toBe(fresh);
    expect(storedRegistrationIntent(saved, 'customer:A')).not.toBe(previous);
  });
  it('survives refresh, isolates identities and replaces completed or expired attempts', () => {
    const saved = storage();
    const key = registrationIntentStorageKey('org', 101, 'customer:1', 'self');
    const id = storedRegistrationIntent(saved, key, undefined, 1000);
    expect(storedRegistrationIntent(saved, key, undefined, 1001)).toBe(id);
    expect(
      storedRegistrationIntent(
        saved,
        registrationIntentStorageKey('org', 101, 'customer:2', 'self'),
      ),
    ).not.toBe(id);
    expect(
      storedRegistrationIntent(
        saved,
        registrationIntentStorageKey('org', 101, 'customer:1', 'other'),
      ),
    ).not.toBe(id);
    expect(storedRegistrationIntent(saved, key, undefined, 31 * 24 * 60 * 60 * 1000)).not.toBe(id);
    clearRegistrationIntent(saved, key);
    expect(saved.getItem(key)).toBeNull();
  });
  it('imports legacy intents and keeps working with unavailable storage', () => {
    const legacy = '503d251a-7a43-43e8-99c3-708d2a0f4f0d';
    const saved = storage();
    expect(storedRegistrationIntent(saved, 'key', legacy)).toBe(legacy);
    expect(storedRegistrationIntent(saved, 'key')).toBe(legacy);
    expect(storedRegistrationIntent(null, 'key', legacy)).toBe(legacy);
  });
  it('preserves invitations and multi-ticket selections while removing redundant parameters', () => {
    expect(
      compactRegistrationPath(
        'tokems26',
        new URLSearchParams('event=tokems26&ticket=one&intent=old&purchaseFor=self&restart=1'),
        'one',
      ),
    ).toBe('/register/tokems26');
    expect(
      compactRegistrationPath(
        'tokems26',
        new URLSearchParams('ticket=two&intent=old&offer=invitation&purchaseFor=other'),
      ),
    ).toBe('/register/tokems26?ticket=two&offer=invitation&purchaseFor=other');
  });
});
