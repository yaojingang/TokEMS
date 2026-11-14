import { normalizeAgentOrigin } from '@conference/security';

export interface AgentPublicExpectation {
  eventId: number;
  organizationId: string;
  organizationSlug: string;
  eventSlug: string;
  releaseId: string;
  public?: boolean;
}

export interface AgentHomepageExpectation {
  organizationId: string;
  organizationSlug: string;
  mode: 'empty' | 'event';
  revision: number;
  eventId: number | null;
  event?: AgentPublicExpectation;
}

async function boundedText(response: Response) {
  if (!response.ok || !response.body) throw new Error('PUBLIC_HTTP_FAILED');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > 4 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('PUBLIC_RESPONSE_TOO_LARGE');
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function verifyAgentPublicDelivery(
  expectation: AgentPublicExpectation,
  publicOrigin: string,
  fetcher: typeof fetch = fetch,
  homepage = false,
) {
  const headers = { 'X-Organization-Slug': expectation.organizationSlug };
  try {
    const origin = normalizeAgentOrigin(publicOrigin);
    const [apiResponse, pageResponse] = await Promise.all([
      fetcher(
        homepage
          ? `${origin}/api/v1/homepage`
          : `${origin}/api/v1/events/${encodeURIComponent(expectation.eventSlug)}`,
        {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        },
      ),
      fetcher(homepage ? `${origin}/` : `${origin}/${encodeURIComponent(expectation.eventSlug)}`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      }),
    ]);
    if (expectation.public === false) {
      await Promise.all([apiResponse.body?.cancel(), pageResponse.body?.cancel()]);
      return apiResponse.status === 404 && pageResponse.status === 404
        ? { verified: true, releaseId: expectation.releaseId }
        : { verified: false, reason: 'PUBLIC_VISIBILITY_MISMATCH' };
    }
    const [apiText, html] = await Promise.all([
      boundedText(apiResponse),
      boundedText(pageResponse),
    ]);
    const api = JSON.parse(apiText) as Record<string, unknown>;
    const escaped = expectation.releaseId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const marker = new RegExp(
      `<meta\\s+[^>]*name=["']tokems:release-id["'][^>]*content=["']${escaped}["']`,
      'iu',
    );
    if (
      api.id !== expectation.eventId ||
      api.organizationId !== expectation.organizationId ||
      api.releaseId !== expectation.releaseId ||
      !marker.test(html) ||
      !(pageResponse.headers.get('content-type') ?? '').includes('text/html')
    ) {
      return { verified: false, reason: 'PUBLIC_RELEASE_MISMATCH' };
    }
    return { verified: true, releaseId: expectation.releaseId };
  } catch {
    return { verified: false, reason: 'PUBLIC_VERIFICATION_UNAVAILABLE' };
  }
}

export async function verifyAgentHomepageDelivery(
  expectation: AgentHomepageExpectation,
  publicOrigin: string,
  fetcher: typeof fetch = fetch,
) {
  if (expectation.mode === 'event') {
    return expectation.event
      ? verifyAgentPublicDelivery(expectation.event, publicOrigin, fetcher, true)
      : { verified: false, reason: 'PUBLIC_RELEASE_MISMATCH' };
  }
  try {
    const origin = normalizeAgentOrigin(publicOrigin);
    const responses = await Promise.all(
      ['/api/v1/homepage/home-document', '/'].map((path) =>
        fetcher(`${origin}${path}`, {
          headers: { 'X-Organization-Slug': expectation.organizationSlug },
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        }),
      ),
    );
    for (const response of responses) {
      const html = await boundedText(response);
      if (
        response.headers.get('x-tokems-homepage') !== 'empty' ||
        !(response.headers.get('content-type') ?? '').includes('text/html') ||
        !html.includes('data-tokems-homepage="empty"') ||
        /<script[\s>]/iu.test(html)
      ) {
        return { verified: false, reason: 'PUBLIC_HOMEPAGE_MISMATCH' };
      }
    }
    return { verified: true, mode: 'empty', revision: expectation.revision };
  } catch {
    return { verified: false, reason: 'PUBLIC_VERIFICATION_UNAVAILABLE' };
  }
}
