import { isLoopbackHostname, normalizeMainlandMobile } from '@conference/security';

type LocalPaymentSimulationEnvironment = Partial<
  Record<
    | 'DEPLOYMENT_MODE'
    | 'ENABLE_LOCAL_PAYMENT_SIMULATION'
    | 'LOCAL_PAYMENT_SIMULATION_MOBILES'
    | 'PUBLIC_ORIGIN'
    | 'PUBLIC_WEB_URL'
    | 'ADMIN_ORIGIN'
    | 'ADMIN_WEB_URL'
    | 'PAYMENT_PUBLIC_ORIGIN',
    string | undefined
  >
>;

export interface LocalPaymentSimulationPolicy {
  enabled: boolean;
  allowedMobileE164s: string[];
}

const DISABLED_POLICY: LocalPaymentSimulationPolicy = {
  enabled: false,
  allowedMobileE164s: [],
};

function isLoopbackUrl(value: string | undefined) {
  if (!value) return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolves the tightly-scoped local payment simulation allowlist.
 *
 * The feature requires a local deployment, an explicit switch, loopback-only browser
 * origins, and at least one valid mainland mobile. Production deployments always disable it.
 */
export function resolveLocalPaymentSimulationPolicy(
  environment: LocalPaymentSimulationEnvironment = process.env,
): LocalPaymentSimulationPolicy {
  if (
    environment.DEPLOYMENT_MODE !== 'local' ||
    environment.ENABLE_LOCAL_PAYMENT_SIMULATION !== 'true'
  ) {
    return { ...DISABLED_POLICY };
  }

  const publicOrigin = environment.PUBLIC_ORIGIN ?? environment.PUBLIC_WEB_URL;
  const adminOrigin = environment.ADMIN_ORIGIN ?? environment.ADMIN_WEB_URL;
  const paymentOrigin = environment.PAYMENT_PUBLIC_ORIGIN;
  const configuredOrigins = [publicOrigin, adminOrigin, paymentOrigin];
  if (
    !publicOrigin ||
    !adminOrigin ||
    !paymentOrigin ||
    configuredOrigins.some((origin) => !isLoopbackUrl(origin))
  ) {
    return { ...DISABLED_POLICY };
  }

  const allowedMobileE164s = [
    ...new Set(
      String(environment.LOCAL_PAYMENT_SIMULATION_MOBILES ?? '')
        .split(',')
        .map((mobile) => mobile.trim())
        .filter(Boolean)
        .map((mobile) => normalizeMainlandMobile(mobile)),
    ),
  ];
  if (!allowedMobileE164s.length) return { ...DISABLED_POLICY };
  return { enabled: true, allowedMobileE164s };
}
