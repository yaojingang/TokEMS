import { EventIdParamSchema, type EventId } from '@conference/contracts';

export function parseEventId(value: unknown): EventId | undefined {
  const candidate = typeof value === 'number' ? String(value) : value;
  if (typeof candidate !== 'string') return undefined;
  const parsed = EventIdParamSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function routeEventId(pathname: string, baseURL: string): EventId | undefined {
  const basePath = new URL(baseURL, 'http://localhost').pathname.replace(/\/$/, '');
  const relativePath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const encodedEventId = relativePath.match(/^\/events\/([^/]+)/)?.[1];
  return encodedEventId ? parseEventId(decodeURIComponent(encodedEventId)) : undefined;
}
