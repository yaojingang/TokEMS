import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../common/auth.guard.js';
import type { DatabaseService } from '../common/database.service.js';
import { AuthService } from './auth.module.js';

describe('administrator browser login lifetime', () => {
  const issuedAt = new Date('2026-09-08T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const jwt = new JwtService({
    secret: 'administrator-session-test-secret',
    signOptions: { expiresIn: '8h' },
  });
  const database = { db: undefined } as unknown as DatabaseService;
  const auth = new AuthService(jwt, database);
  const guard = new AuthGuard(jwt, new Reflector(), database);

  function context(accessToken: string) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${accessToken}` } }),
      }),
      getHandler: () => context,
      getClass: () => AuthService,
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ADMIN_USERNAME', 'session-admin');
    vi.stubEnv('ADMIN_PASSWORD', 'session-test-password');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(issuedAt);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('keeps a login valid after eight hours and until exactly 90 days from sign-in', async () => {
    const { accessToken } = await auth.login({
      username: 'session-admin',
      password: 'session-test-password',
    });
    const claims = jwt.decode<{ iat: number; exp: number }>(accessToken);
    expect(claims.exp - claims.iat).toBe(90 * 24 * 60 * 60);

    vi.setSystemTime(issuedAt.getTime() + day);
    await expect(guard.canActivate(context(accessToken))).resolves.toBe(true);

    vi.setSystemTime(issuedAt.getTime() + 90 * day - 1000);
    await expect(guard.canActivate(context(accessToken))).resolves.toBe(true);

    vi.setSystemTime(issuedAt.getTime() + 90 * day);
    await expect(guard.canActivate(context(accessToken))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects incorrect passwords', async () => {
    await expect(
      auth.login({ username: 'session-admin', password: 'incorrect-password' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('preserves the shared lifetime for other tokens', async () => {
    const token = await jwt.signAsync({ sub: 'unrelated-token' });
    const claims = jwt.decode<{ iat: number; exp: number }>(token);
    expect(claims.exp - claims.iat).toBe(8 * 60 * 60);
  });
});
