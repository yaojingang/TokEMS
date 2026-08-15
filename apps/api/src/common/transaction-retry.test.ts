import { describe, expect, it, vi } from 'vitest';
import { withPostgresTransactionRetry } from './transaction-retry.js';

describe('PostgreSQL transaction retry', () => {
  it('retries deadlocks and serialization failures within the configured cap', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
      .mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: '40001' }))
      .mockResolvedValue('consistent');
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      withPostgresTransactionRetry(operation, { maxAttempts: 3, sleep, jitter: () => 0 }),
    ).resolves.toBe('consistent');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent constraint failure', async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(Object.assign(new Error('foreign key'), { code: '23503' }));

    await expect(withPostgresTransactionRetry(operation)).rejects.toMatchObject({ code: '23503' });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
