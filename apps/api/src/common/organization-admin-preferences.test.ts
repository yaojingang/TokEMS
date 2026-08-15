import { describe, expect, it } from 'vitest';
import type { DatabaseService } from './database.service.js';
import {
  normalizeAdminPreferences,
  OrganizationAdminService,
} from './organization-admin.service.js';

describe('administrator navigation preferences', () => {
  it('normalizes missing and malformed profile JSON to an empty preference', () => {
    expect(normalizeAdminPreferences(undefined)).toEqual({ lastEventId: null });
    expect(normalizeAdminPreferences({ admin: { lastEventId: 100 } })).toEqual({
      lastEventId: null,
    });
    expect(normalizeAdminPreferences({ admin: { lastEventId: 101 } })).toEqual({
      lastEventId: 101,
    });
  });

  it('allows clearing without event access and rejects setting in local mode without it', async () => {
    const service = new OrganizationAdminService({ db: null } as unknown as DatabaseService);

    await expect(
      service.updateAdminPreferences('org-a', 'user-a', { lastEventId: null }, []),
    ).resolves.toEqual({ lastEventId: null });
    await expect(
      service.updateAdminPreferences('org-a', 'user-a', { lastEventId: 101 }, []),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.updateAdminPreferences('org-a', 'user-a', { lastEventId: 999 }, ['event.read']),
    ).rejects.toMatchObject({ status: 404 });
  });
});
