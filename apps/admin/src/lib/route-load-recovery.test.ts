import { describe, expect, it, vi } from 'vitest';
import {
  ROUTE_LOAD_RECOVERY_KEY,
  createRouteLoadRecovery,
  isRouteAssetLoadError,
  normalizeSameOriginRouteTarget,
} from './route-load-recovery';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

describe('route load recovery', () => {
  it.each([
    'Failed to fetch dynamically imported module: /admin/assets/PublishingView-old.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Unable to preload CSS for /admin/assets/PublishingView-old.css',
  ])('recognizes stale route asset failures: %s', (message) => {
    expect(isRouteAssetLoadError(new TypeError(message))).toBe(true);
  });

  it('normalizes same-origin targets and rejects protocol-relative external targets', () => {
    expect(
      normalizeSameOriginRouteTarget(
        '/admin/events/101/settings/site?preview=1#hero',
        'https://admin.example',
      ),
    ).toBe('https://admin.example/admin/events/101/settings/site?preview=1#hero');
    expect(
      normalizeSameOriginRouteTarget('//evil.example/path', 'https://admin.example'),
    ).toBeUndefined();
    expect(
      normalizeSameOriginRouteTarget(
        '/admin/%2e%2e//evil.example/path',
        'https://admin.example',
      ),
    ).toBe('https://admin.example//evil.example/path');
  });

  it('reloads the latest requested route once when a stale route asset fails', () => {
    const storage = createStorage();
    const navigate = vi.fn();
    const target = '/admin/events/101/settings/site';
    const normalizedTarget = `https://admin.example${target}`;
    const error = new TypeError('Failed to fetch dynamically imported module');
    const recovery = createRouteLoadRecovery({
      origin: 'https://admin.example',
      storage,
      navigate,
    });

    recovery.begin(target);

    expect(recovery.recover(error, target)).toBe(true);
    expect(storage.getItem(ROUTE_LOAD_RECOVERY_KEY)).toBe(normalizedTarget);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(normalizedTarget);

    expect(recovery.recover(error, target)).toBe(false);
    expect(storage.getItem(ROUTE_LOAD_RECOVERY_KEY)).toBe(normalizedTarget);
    expect(navigate).toHaveBeenCalledOnce();

    recovery.complete(target);
    expect(storage.getItem(ROUTE_LOAD_RECOVERY_KEY)).toBeNull();
  });

  it('ignores failures from a navigation superseded by a newer target', () => {
    const storage = createStorage();
    const navigate = vi.fn();
    const recovery = createRouteLoadRecovery({
      origin: 'https://admin.example',
      storage,
      navigate,
    });

    recovery.begin('/admin/events/101/settings/site');
    recovery.begin('/admin/events/101/settings/form');

    expect(
      recovery.recover(
        new TypeError('Failed to fetch dynamically imported module'),
        '/admin/events/101/settings/site',
      ),
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps another target recovery marker when a concurrent navigation succeeds', () => {
    const storage = createStorage();
    const navigate = vi.fn();
    const recovery = createRouteLoadRecovery({
      origin: 'https://admin.example',
      storage,
      navigate,
    });
    const staleTarget = '/admin/events/101/settings/site';

    recovery.begin(staleTarget);
    expect(
      recovery.recover(
        new TypeError('Failed to fetch dynamically imported module'),
        staleTarget,
      ),
    ).toBe(true);
    recovery.begin('/admin/events/101/settings/form');
    recovery.complete('/admin/events/101/settings/form');

    expect(storage.getItem(ROUTE_LOAD_RECOVERY_KEY)).toBe(
      `https://admin.example${staleTarget}`,
    );
  });

  it('leaves ordinary route errors untouched', () => {
    const storage = createStorage();
    const navigate = vi.fn();
    const recovery = createRouteLoadRecovery({
      origin: 'https://admin.example',
      storage,
      navigate,
    });
    const target = '/admin/events/101/settings/site';
    recovery.begin(target);

    expect(recovery.recover(new Error('event context is unavailable'), target)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('never navigates to an external recovery target', () => {
    const storage = createStorage();
    const navigate = vi.fn();
    const recovery = createRouteLoadRecovery({
      origin: 'https://admin.example',
      storage,
      navigate,
    });

    recovery.begin('//evil.example/path');
    expect(
      recovery.recover(
        new TypeError('Failed to fetch dynamically imported module'),
        '//evil.example/path',
      ),
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
