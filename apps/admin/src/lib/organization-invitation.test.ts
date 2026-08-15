import { describe, expect, it } from 'vitest';
import { buildOrganizationInvitationAcceptanceUrl } from './organization-invitation';

describe('organization invitation URL', () => {
  it('keeps the secret in the fragment and preserves the admin base path', () => {
    const link = buildOrganizationInvitationAcceptanceUrl(
      'secret/token',
      'tokems',
      '/admin/',
      'https://example.com',
    );
    const url = new URL(link);

    expect(url.pathname).toBe('/admin/accept-invitation');
    expect(url.search).toBe('');
    expect(url.hash).toContain('token=secret%2Ftoken');
    expect(url.hash).toContain('organization=tokems');
  });
});
