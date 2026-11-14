import { describe, expect, it, vi } from 'vitest';
import { verifyAgentPublicDelivery, verifyAgentHomepageDelivery } from './agent-public-verification.js';

describe('server public release verification', () => {
  const expected = { eventId: 101, organizationId: 'organization-1', organizationSlug: 'demo',
    eventSlug: 'conference', releaseId: '4d46d6b7-f7b4-4f6f-8cd4-66e5e5f44c01' };
  function fetcher(releaseId = expected.releaseId, htmlId = expected.releaseId) {
    return vi.fn(async (url: string) => url.includes('/api/v1/')
      ? new Response(JSON.stringify({ id: 101, organizationId: 'organization-1', releaseId }))
      : new Response(`<html><head><meta name="tokems:release-id" content="${htmlId}"></head></html>`, { headers: { 'Content-Type': 'text/html' } }));
  }
  it('binds both API and rendered HTML to the expected immutable release', async () => {
    const request = fetcher();
    expect(await verifyAgentPublicDelivery(expected, 'https://events.example.com', request as unknown as typeof fetch)).toMatchObject({ verified: true });
    expect(request).toHaveBeenCalledWith('https://events.example.com/conference', expect.objectContaining({ redirect: 'error' }));
  });
  it('refuses stale API and stale HTML independently', async () => {
    expect(await verifyAgentPublicDelivery(expected, 'https://events.example.com', fetcher('old') as unknown as typeof fetch)).toMatchObject({ verified: false });
    expect(await verifyAgentPublicDelivery(expected, 'https://events.example.com', fetcher(expected.releaseId, 'old') as unknown as typeof fetch)).toMatchObject({ verified: false });
  });
  it('checks the homepage API and root document for event mode', async () => {
    const request = fetcher();
    expect(await verifyAgentHomepageDelivery({ ...expected, mode: 'event', revision: 2, event: expected },
      'https://events.example.com', request as unknown as typeof fetch)).toMatchObject({ verified: true });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://events.example.com/api/v1/homepage', 'https://events.example.com/',
    ]);
  });
  it('requires empty inert documents from both delivery layers for empty mode', async () => {
    const homepage = { ...expected, mode: 'empty' as const, revision: 3 };
    const empty = () => new Response('<html data-tokems-homepage="empty"><body></body></html>', {
      headers: { 'Content-Type': 'text/html', 'X-TokEMS-Homepage': 'empty' },
    });
    expect(await verifyAgentHomepageDelivery(homepage, 'https://events.example.com',
      vi.fn(async () => empty()))).toMatchObject({ verified: true });
    expect(await verifyAgentHomepageDelivery(homepage, 'https://events.example.com',
      vi.fn(async (url) => String(url).endsWith('/') ? new Response('<script>active()</script>') : empty())))
      .toMatchObject({ verified: false });
  });
  it('verifies an intentional public removal only when both routes are absent', async () => {
    expect(await verifyAgentPublicDelivery({ ...expected, public: false }, 'https://events.example.com',
      vi.fn(async () => new Response('Not found', { status: 404 })))).toMatchObject({ verified: true });
    expect(await verifyAgentPublicDelivery({ ...expected, public: false }, 'https://events.example.com',
      fetcher() as unknown as typeof fetch)).toMatchObject({ verified: false });
  });
});
