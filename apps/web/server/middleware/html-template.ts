import {
  EventSlugSchema,
  publicEventHomePath,
  publicEventSlugFromPathSegment,
} from '@conference/contracts';

const FORWARDED_HEADERS = [
  'content-type',
  'content-security-policy',
  'cache-control',
  'etag',
  'referrer-policy',
  'permissions-policy',
  'x-content-type-options',
  'content-language',
  'vary',
  'warning',
] as const;

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);
  if (event.method !== 'GET') return;

  const config = useRuntimeConfig(event);
  const apiBase = String(config.apiInternalBase).replace(/\/$/u, '');
  const organizationSlug = String(config.public.organizationSlug);
  const legacyEventSlug = url.pathname === '/' ? url.searchParams.get('event') : null;
  if (legacyEventSlug) {
    const parsedLegacySlug = EventSlugSchema.safeParse(legacyEventSlug);
    if (!parsedLegacySlug.success) {
      throw createError({ statusCode: 404, statusMessage: '大会不存在或尚未发布' });
    }
    const query = new URLSearchParams(url.searchParams);
    query.delete('event');
    const suffix = query.size ? `?${query.toString()}` : '';
    return sendRedirect(event, `${publicEventHomePath(parsedLegacySlug.data)}${suffix}`, 308);
  }

  let documentPath: string;
  let eventSlug: string | undefined;
  if (url.pathname === '/') {
    documentPath = '/homepage/home-document';
  } else {
    const match = url.pathname.match(/^\/([^/]+)\/?$/u);
    if (!match) return;
    eventSlug = publicEventSlugFromPathSegment(match[1]!);
    if (!eventSlug) return;
    if (url.pathname.endsWith('/')) {
      return sendRedirect(event, `${publicEventHomePath(eventSlug)}${url.search}`, 308);
    }
    documentPath = `/events/${encodeURIComponent(eventSlug)}/home-document`;
  }

  let response: Response;
  try {
    const fetchDocument = (path: string) =>
      fetch(`${apiBase}${path}`, {
        headers: {
          'X-Organization-Slug': organizationSlug,
          ...(getHeader(event, 'if-none-match')
            ? { 'If-None-Match': getHeader(event, 'if-none-match')! }
            : {}),
        },
        signal: AbortSignal.timeout(4_000),
      });
    response = await fetchDocument(documentPath);
    const canonicalSlug = eventSlug
      ? response.headers.get('x-canonical-event-slug')
      : undefined;
    if (canonicalSlug && canonicalSlug !== eventSlug) {
      const parsedCanonicalSlug = EventSlugSchema.safeParse(canonicalSlug);
      if (parsedCanonicalSlug.success) {
        return sendRedirect(
          event,
          `${publicEventHomePath(parsedCanonicalSlug.data)}${url.search}`,
          308,
        );
      }
    }
  } catch {
    throw createError({ statusCode: 503, statusMessage: '大会页面暂时不可用' });
  }

  if (response.status === 204) return;
  if (response.status === 404) {
    throw createError({
      statusCode: 404,
      statusMessage: eventSlug ? '大会不存在或尚未发布' : '首页默认大会尚未配置',
    });
  }
  FORWARDED_HEADERS.forEach((header) => {
    const value = response.headers.get(header);
    if (value) setHeader(event, header, value);
  });
  setResponseStatus(event, response.status);
  if (response.status === 304) return '';
  return response.text();
});
