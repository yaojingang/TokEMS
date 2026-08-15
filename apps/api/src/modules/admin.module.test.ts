import { describe, expect, it } from 'vitest';
import { ADMIN_EVENT_READ_GRANTS } from './admin.module.js';

describe('admin event read permissions', () => {
  it('allows the public-site reader to load the event workspace shell', () => {
    expect(ADMIN_EVENT_READ_GRANTS).toContain('event.site.read');
  });
});
