export const ROUTE_LOAD_RECOVERY_KEY = 'tokems:route-load-recovery';

interface RouteLoadRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface RouteLoadRecoveryOptions {
  origin: string;
  storage: RouteLoadRecoveryStorage;
  navigate(target: string): void;
}

const routeAssetErrorPatterns = [
  /Failed to fetch dynamically imported module/iu,
  /error loading dynamically imported module/iu,
  /Importing a module script failed/iu,
  /Unable to preload CSS/iu,
  /ChunkLoadError/iu,
  /Loading chunk .+ failed/iu,
];

export function isRouteAssetLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return routeAssetErrorPatterns.some((pattern) => pattern.test(message));
}

export function normalizeSameOriginRouteTarget(target: string, origin: string) {
  const expectedOrigin = new URL(origin).origin;
  const resolved = new URL(target, expectedOrigin);
  if (resolved.origin !== expectedOrigin) return undefined;
  return resolved.href;
}

export function createRouteLoadRecovery({ origin, storage, navigate }: RouteLoadRecoveryOptions) {
  let latestTarget: string | undefined;

  return {
    begin(target: string) {
      latestTarget = normalizeSameOriginRouteTarget(target, origin);
    },
    recover(error: unknown, target: string) {
      if (!isRouteAssetLoadError(error)) return false;
      const normalizedTarget = normalizeSameOriginRouteTarget(target, origin);
      if (!normalizedTarget || normalizedTarget !== latestTarget) return false;
      if (storage.getItem(ROUTE_LOAD_RECOVERY_KEY) === normalizedTarget) return false;

      storage.setItem(ROUTE_LOAD_RECOVERY_KEY, normalizedTarget);
      navigate(normalizedTarget);
      return true;
    },
    complete(target: string) {
      const normalizedTarget = normalizeSameOriginRouteTarget(target, origin);
      if (normalizedTarget && storage.getItem(ROUTE_LOAD_RECOVERY_KEY) === normalizedTarget) {
        storage.removeItem(ROUTE_LOAD_RECOVERY_KEY);
      }
    },
  };
}
