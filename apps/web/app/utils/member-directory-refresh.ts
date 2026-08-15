export const MEMBER_DIRECTORY_REFRESH_INTERVAL_MS = 8_000;
export const MEMBER_DIRECTORY_REQUEST_TIMEOUT_MS = 5_000;

export async function loadMemberDirectoryWithFallback<T>(
  load: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await load();
  } catch {
    return fallback;
  }
}

type MemberDirectoryRefreshController = {
  refreshIfNeeded: () => void;
  stop: () => void;
};

export function startMemberDirectoryAutoRefresh(
  refresh: () => Promise<unknown> | unknown,
  shouldRefresh: () => boolean,
  intervalMs = MEMBER_DIRECTORY_REFRESH_INTERVAL_MS,
): MemberDirectoryRefreshController {
  let stopped = false;
  let refreshing = false;

  const refreshIfNeeded = () => {
    if (stopped || refreshing || !shouldRefresh()) return;
    refreshing = true;
    void Promise.resolve()
      .then(() => refresh())
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  };
  const timer = setInterval(refreshIfNeeded, intervalMs);

  return {
    refreshIfNeeded,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
