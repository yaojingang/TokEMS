import {
  analyticsHeadScripts,
  isAnalyticsActive,
  publicEventSlugFromPathSegment,
  type AnalyticsProvider,
  type AnalyticsSettingsLike,
} from '@conference/contracts';

const PUBLIC_EXACT_PATHS = new Set(['/', '/faq', '/apply/cooperation']);
const PUBLIC_PREFIXES = ['/members', '/speakers'];
const SENSITIVE_PREFIXES = [
  '/register',
  '/account',
  '/order',
  '/invoice',
  '/ticket',
  '/pay',
  '/admin',
  '/api',
];

function pathMatchesPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function analyticsPathname(path: string) {
  const pathname = (path.split(/[?#]/u)[0] || '/').toLowerCase();
  return pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;
}

export function isAnalyticsSensitivePath(path: string, paymentSurface = false) {
  const pathname = analyticsPathname(path);
  return paymentSurface || SENSITIVE_PREFIXES.some((prefix) => pathMatchesPrefix(pathname, prefix));
}

export function isPublicAnalyticsPath(path: string, paymentSurface = false) {
  if (isAnalyticsSensitivePath(path, paymentSurface)) return false;
  const pathname = analyticsPathname(path);
  if (
    PUBLIC_EXACT_PATHS.has(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathMatchesPrefix(pathname, prefix))
  ) {
    return true;
  }
  const segments = pathname.split('/').filter(Boolean);
  return segments.length === 1 && Boolean(publicEventSlugFromPathSegment(segments[0]!));
}

export function isPublicAnalyticsErrorPath(path: string, paymentSurface = false) {
  return !isAnalyticsSensitivePath(path, paymentSurface);
}

export function publicAnalyticsHeadEntries(settings: AnalyticsSettingsLike | undefined | null) {
  return analyticsHeadScripts(settings, { spa: true }).map((script) =>
    script.src
      ? {
          key: script.key,
          src: script.src,
          async: script.async,
          defer: script.defer,
          'data-website-id': script['data-website-id'],
          'data-auto-track': script['data-auto-track'],
          'data-tok-analytics': script.key,
          tagPosition: 'head' as const,
        }
      : {
          key: script.key,
          type: 'text/javascript' as const,
          textContent: script.innerHTML ?? '',
          'data-tok-analytics': script.key,
          tagPosition: 'head' as const,
        },
  );
}

export function requiresAnalyticsDocumentBoundary(
  settings: AnalyticsSettingsLike | undefined | null,
  fromPath: string,
  toPath: string,
  options: { paymentSurface?: boolean; analyticsWasActiveInDocument?: boolean } = {},
) {
  return Boolean(
    (isAnalyticsActive(settings) || options.analyticsWasActiveInDocument) &&
    isAnalyticsSensitivePath(fromPath, options.paymentSurface) !==
      isAnalyticsSensitivePath(toPath, options.paymentSurface),
  );
}

export function localAnalyticsBoundaryTarget(fullPath: string) {
  const escaped = fullPath.replaceAll('\\', '%5C').replace(/^\/+/u, '');
  return `/${escaped}`;
}

export interface AnalyticsNavigationContext {
  eligible: boolean;
  identity: string;
  path: string;
  provider: AnalyticsProvider | null;
}

export function analyticsNavigationContext(
  settings: AnalyticsSettingsLike | undefined | null,
  path: string,
  paymentSurface = false,
  publicErrorPage = false,
): AnalyticsNavigationContext {
  const active = isAnalyticsActive(settings);
  const eligible =
    active &&
    (publicErrorPage
      ? isPublicAnalyticsErrorPath(path, paymentSurface)
      : isPublicAnalyticsPath(path.split(/[?#]/u)[0] || '/', paymentSurface));
  return {
    eligible,
    identity: active
      ? [settings!.provider, settings!.trackingId, settings!.scriptUrl, settings!.siteId].join(':')
      : '',
    path,
    provider: active ? settings!.provider : null,
  };
}

export function shouldSendAnalyticsPageView(
  previous: AnalyticsNavigationContext | null,
  next: AnalyticsNavigationContext,
) {
  if (!next.eligible || !next.identity || !next.provider) return false;
  if (!previous || !previous.eligible || previous.identity !== next.identity) {
    return next.provider !== 'baidu';
  }
  return previous.path !== next.path;
}

type AnalyticsBrowserWindow = Window & {
  _hmt?: unknown[][];
  dataLayer?: unknown[][];
  gtag?: (...arguments_: unknown[]) => void;
  umami?: {
    track: (value?: (properties: Record<string, unknown>) => Record<string, unknown>) => void;
  };
};

export function sendAnalyticsPageView(
  provider: AnalyticsProvider,
  path: string,
  options: { umamiAttempts?: number } = {},
) {
  const analyticsWindow = window as AnalyticsBrowserWindow;
  if (provider === 'baidu') {
    analyticsWindow._hmt ??= [];
    analyticsWindow._hmt.push(['_trackPageview', path]);
    return;
  }
  if (provider === 'google') {
    analyticsWindow.dataLayer ??= [];
    analyticsWindow.gtag ??= (...arguments_: unknown[]) => {
      analyticsWindow.dataLayer!.push(arguments_);
    };
    analyticsWindow.gtag('event', 'page_view', {
      page_location: window.location.href,
      page_path: path,
      page_title: document.title,
    });
    return;
  }

  if (analyticsWindow.umami?.track) {
    const title = document.title;
    analyticsWindow.umami.track((properties) => ({ ...properties, url: path, title }));
    return;
  }
  const attempts = options.umamiAttempts ?? 0;
  if (attempts >= 40) return;
  window.setTimeout(
    () => sendAnalyticsPageView(provider, path, { umamiAttempts: attempts + 1 }),
    250,
  );
}
