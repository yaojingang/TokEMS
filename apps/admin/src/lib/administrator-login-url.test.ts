import { describe, expect, it } from 'vitest';
import { buildAdministratorLoginUrl } from './administrator-login-url.js';

describe('administrator organization login URL', () => {
  it('preserves the configured administrator base path', () => {
    expect(buildAdministratorLoginUrl('https://example.com', '/admin/', 'geo-conference')).toBe(
      'https://example.com/admin/login?organization=geo-conference',
    );
  });

  it('supports a root-hosted administrator application', () => {
    expect(buildAdministratorLoginUrl('https://admin.example.com', '/', 'geo-conference')).toBe(
      'https://admin.example.com/login?organization=geo-conference',
    );
  });
});
