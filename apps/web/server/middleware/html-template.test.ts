import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let url: URL;
let responseHeaders: Record<string, string>;
let status: number;
const fetchMock = vi.fn();
beforeEach(() => {
  url = new URL('https://conference.example/'); responseHeaders = {}; status = 200;
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
  vi.stubGlobal('getRequestURL', () => url);
  vi.stubGlobal('useRuntimeConfig', () => ({ apiInternalBase: 'http://api:4100/api/v1', public: { organizationSlug: 'conference' } }));
  vi.stubGlobal('getHeader', () => undefined);
  vi.stubGlobal('setHeader', (_event: unknown, key: string, value: string) => { responseHeaders[key] = value; });
  vi.stubGlobal('setResponseStatus', (_event: unknown, value: number) => { status = value; });
  vi.stubGlobal('createError', (value: object) => Object.assign(new Error('HTTP failure'), value));
  vi.stubGlobal('sendRedirect', (_event: unknown, location: string, code: number) => ({ location, code }));
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
async function request(method = 'GET') {
  const handler = (await import('./html-template')).default;
  return Reflect.apply(handler, undefined, [{ method }]);
}

describe('root document routing', () => {
  it.each(['GET', 'HEAD'])('serves an explicit blank document for %s without falling into the application', async (method) => {
    const html = '<!doctype html><html data-tokems-homepage="empty"><body></body></html>';
    fetchMock.mockResolvedValue(new Response(html, { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'", 'X-TokEMS-Homepage': 'empty' } }));
    expect(await request(method)).toBe(html);
    expect(status).toBe(200);
    expect(responseHeaders).toMatchObject({ 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'x-tokems-homepage': 'empty' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api:4100/api/v1/homepage/home-document');
  });
  it('leaves structured rendering to Nuxt and preserves explicit event paths', async () => {
    url = new URL('https://conference.example/another-event');
    fetchMock.mockResolvedValue(new Response(null, { status: 204, headers: { 'Content-Security-Policy': "default-src 'none'" } }));
    expect(await request()).toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api:4100/api/v1/events/another-event/home-document');
    expect(responseHeaders).not.toHaveProperty('content-security-policy');
  });
  it('preserves legacy root-event links and other query parameters', async () => {
    url = new URL('https://conference.example/?event=another-event&utm_source=legacy');
    expect(await request()).toEqual({ location: '/another-event?utm_source=legacy', code: 308 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('keeps upstream outages and missing organizations as errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(request()).rejects.toMatchObject({ statusCode: 503 });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(request()).rejects.toMatchObject({ statusCode: 404 });
  });
});
