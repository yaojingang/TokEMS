import { describe, expect, it } from 'vitest';
import { homeDocumentResponseHeaders } from './home-document-headers';

function response(status: number) {
  return new Response(null, {
    status,
    headers: {
      'Cache-Control': 'no-cache, must-revalidate',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'",
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      Vary: 'X-Organization-Slug',
    },
  });
}

describe('homeDocumentResponseHeaders', () => {
  it('keeps cache metadata without applying the API CSP to a structured Nuxt page', () => {
    const headers = Object.fromEntries(homeDocumentResponseHeaders(response(204)));

    expect(headers).toMatchObject({
      'cache-control': 'no-cache, must-revalidate',
      vary: 'X-Organization-Slug',
    });
    expect(headers).not.toHaveProperty('content-security-policy');
    expect(headers).not.toHaveProperty('content-type');
  });

  it('preserves the isolated document policy for imported HTML', () => {
    const headers = Object.fromEntries(homeDocumentResponseHeaders(response(200)));

    expect(headers['content-security-policy']).toContain("script-src 'self'");
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('does not leak API document policies into Nuxt error pages', () => {
    const headers = Object.fromEntries(homeDocumentResponseHeaders(response(404)));

    expect(headers).not.toHaveProperty('content-security-policy');
    expect(headers).not.toHaveProperty('content-type');
  });
});
