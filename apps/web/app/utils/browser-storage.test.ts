import { describe, expect, it } from 'vitest';
import { createResilientBrowserStorage } from './browser-storage';
import { adoptRegistrationIntent, storedRegistrationIntent } from './purchase-journey';
import {
  removeRegistrationDraftVersions,
  writeRegistrationDraft,
  readRegistrationDraft,
} from './registration-draft';

describe('registration storage fallback', () => {
  it('keeps each identity and purchase mode stable when storage access is denied', () => {
    const storage = createResilientBrowserStorage(() => {
      throw new Error('denied');
    });
    const anonymous = storedRegistrationIntent(storage, 'anonymous:self');
    expect(storedRegistrationIntent(storage, 'anonymous:self')).toBe(anonymous);
    expect(adoptRegistrationIntent(storage, 'anonymous:self', 'customer:A:self', anonymous)).toBe(
      anonymous,
    );
    expect(storage.getItem('anonymous:self')).toBeNull();
    const other = storedRegistrationIntent(storage, 'customer:A:other');
    const second = storedRegistrationIntent(storage, 'customer:B:self');
    expect(new Set([anonymous, other, second]).size).toBe(3);
    expect(storedRegistrationIntent(storage, 'customer:A:self')).toBe(anonymous);
    const scope = {
      organizationId: 'org',
      eventId: 101,
      ownerId: 'customer:A',
      purchaseFor: 'self' as const,
      purchaseIntentId: anonymous,
    };
    const fields = [{ key: 'name', type: 'text' as const }];
    writeRegistrationDraft(storage, scope, 1, { name: '草稿' }, fields);
    expect(readRegistrationDraft(storage, scope, 1, fields)).toEqual({ name: '草稿' });
    removeRegistrationDraftVersions(storage, scope);
    expect(readRegistrationDraft(storage, scope, 1, fields)).toEqual({});
  });

  it('reads existing records and suppresses stale values after failed writes or removals', () => {
    const saved = new Map([
      ['intent', 'old'],
      ['other', 'untouched'],
    ]);
    let failing = true;
    const storage = createResilientBrowserStorage(() => ({
      get length() {
        return saved.size;
      },
      key: (index) => [...saved.keys()][index] ?? null,
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        if (failing) throw new Error('quota');
        saved.set(key, value);
      },
      removeItem: (key) => {
        if (failing) throw new Error('denied');
        saved.delete(key);
      },
    }));
    expect(storage.getItem('intent')).toBe('old');
    storage.setItem('intent', 'new');
    expect(storage.getItem('intent')).toBe('new');
    storage.removeItem('intent');
    expect(storage.getItem('intent')).toBeNull();
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe('other');
    failing = false;
    storage.setItem('intent', 'recovered');
    expect(storage.getItem('intent')).toBe('recovered');
    saved.set('intent', 'updated-in-another-tab');
    expect(storage.getItem('intent')).toBe('updated-in-another-tab');
    storage.removeItem('intent');
    expect(saved.has('intent')).toBe(false);
  });
});
