import type { LoginResult } from '@conference/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('administrator browser session persistence', () => {
  const values = new Map<string, string>();
  const login: LoginResult = {
    accessToken: 'browser-session-test-token',
    user: {
      id: 101,
      email: null,
      username: 'session-admin',
      name: 'Session administrator',
      role: 'organization_admin',
    },
  };

  beforeEach(() => {
    values.clear();
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores the login when the same browser opens the app again', async () => {
    const { session } = await import('./api');
    session.set(login);

    vi.resetModules();
    const reopened = (await import('./api')).session;
    expect(reopened.token.value).toBe(login.accessToken);
    expect(reopened.user.value).toEqual(login.user);
    expect(reopened.authenticated.value).toBe(true);
  });

  it('removes the saved login on logout so reopening requires sign-in', async () => {
    const { session } = await import('./api');
    session.set(login);
    expect(values.get('conference.admin.token')).toBe(login.accessToken);
    session.clear();

    vi.resetModules();
    const reopened = (await import('./api')).session;
    expect(reopened.token.value).toBe('');
    expect(reopened.authenticated.value).toBe(false);
    expect(values.has('conference.admin.token')).toBe(false);
    expect(values.has('conference.admin.user')).toBe(false);
  });
});
