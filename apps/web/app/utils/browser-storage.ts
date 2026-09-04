import type { RegistrationDraftStorage } from './registration-draft';

/** Keeps failed browser writes available in this document, including deletion tombstones. */
export function createResilientBrowserStorage(
  resolveStorage: () => RegistrationDraftStorage,
): RegistrationDraftStorage {
  const fallback = new Map<string, string | null>();
  function keys() {
    const result = new Set<string>();
    try {
      const storage = resolveStorage();
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null) result.add(key);
      }
    } catch {
      // Some browsers also deny access to the storage object or its index.
    }
    for (const [key, value] of fallback) {
      if (value === null) result.delete(key);
      else result.add(key);
    }
    return [...result];
  }
  return {
    get length() {
      return keys().length;
    },
    key: (index) => keys()[index] ?? null,
    getItem(key) {
      if (fallback.has(key)) return fallback.get(key) ?? null;
      try {
        return resolveStorage().getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        resolveStorage().setItem(key, value);
        fallback.delete(key);
      } catch {
        fallback.set(key, value);
      }
    },
    removeItem(key) {
      try {
        resolveStorage().removeItem(key);
        fallback.delete(key);
      } catch {
        fallback.set(key, null);
      }
    },
  };
}

// Access is lazy; callers only use these stores in the browser.
export const browserLocalStorage = createResilientBrowserStorage(() => window.localStorage);
export const browserSessionStorage = createResilientBrowserStorage(() => window.sessionStorage);

export function readBrowserSessionValue<T>(key: string): T | undefined {
  const value = browserSessionStorage.getItem(key);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    browserSessionStorage.removeItem(key);
    return undefined;
  }
}
