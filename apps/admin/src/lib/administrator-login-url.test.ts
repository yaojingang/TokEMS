import { describe, expect, it } from 'vitest';
import { buildAdministratorLoginUrl } from './administrator-login-url.js';

describe('administrator organization login URL', () => {
  it('preserves the configured administrator base path', () => {
    expect(buildAdministratorLoginUrl('https://example.com', '/admin/', 'tokems-demo')).toBe(
      'https://example.com/admin/login?organization=tokems-demo',
    );
  });

  it('supports a root-hosted administrator application', () => {
    expect(buildAdministratorLoginUrl('https://admin.example.com', '/', 'tokems-demo')).toBe(
      'https://admin.example.com/login?organization=tokems-demo',
    );
  });
});
