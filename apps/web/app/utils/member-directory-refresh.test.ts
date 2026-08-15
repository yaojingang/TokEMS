import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEMBER_DIRECTORY_REFRESH_INTERVAL_MS,
  MEMBER_DIRECTORY_REQUEST_TIMEOUT_MS,
  loadMemberDirectoryWithFallback,
  startMemberDirectoryAutoRefresh,
} from './member-directory-refresh';

describe('member directory auto refresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('times out a stalled request before the next scheduled refresh', () => {
    expect(MEMBER_DIRECTORY_REQUEST_TIMEOUT_MS).toBeLessThan(
      MEMBER_DIRECTORY_REFRESH_INTERVAL_MS,
    );
  });

  it('refreshes a visible member directory within ten seconds', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = startMemberDirectoryAutoRefresh(refresh, () => true);

    await vi.advanceTimersByTimeAsync(MEMBER_DIRECTORY_REFRESH_INTERVAL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(MEMBER_DIRECTORY_REFRESH_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('pauses background refreshes and supports an immediate visibility refresh', async () => {
    let shouldRefresh = false;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = startMemberDirectoryAutoRefresh(refresh, () => shouldRefresh);

    await vi.advanceTimersByTimeAsync(MEMBER_DIRECTORY_REFRESH_INTERVAL_MS);
    expect(refresh).not.toHaveBeenCalled();

    shouldRefresh = true;
    controller.refreshIfNeeded();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('keeps the last successful directory when a background refresh fails', async () => {
    const previous = { items: [{ publicSlug: 'member-1' }], total: 1 };

    await expect(
      loadMemberDirectoryWithFallback(
        () => Promise.reject(new Error('temporary network failure')),
        previous,
      ),
    ).resolves.toBe(previous);
  });

  it('recovers after a rejected refresh instead of locking future refreshes', async () => {
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValue(undefined);
    const controller = startMemberDirectoryAutoRefresh(refresh, () => true);

    controller.refreshIfNeeded();
    await vi.advanceTimersByTimeAsync(0);
    controller.refreshIfNeeded();
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).toHaveBeenCalledTimes(2);
    controller.stop();
  });
});
