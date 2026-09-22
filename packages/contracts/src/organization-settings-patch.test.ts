import { describe, expect, it } from 'vitest';
import { OrganizationSettingsSchema, UpdateOrganizationSettingsSchema } from './index.js';

describe('organization settings PATCH preserves omitted fields', () => {
  it('does not inject defaults when only agreement settings are submitted', () => {
    const input = { settings: { customerAccounts: { termsUrl: 'https://example.com/terms' } } };
    expect(UpdateOrganizationSettingsSchema.parse(input)).toEqual(input);
  });

  it('preserves an explicit pointer clear and rejects empty patches', () => {
    expect(UpdateOrganizationSettingsSchema.parse({ settings: { defaultTemplateId: null } }))
      .toEqual({ settings: { defaultTemplateId: null } });
    for (const settings of [{}, { customerAccounts: {} }, { website: {} }]) {
      expect(UpdateOrganizationSettingsSchema.safeParse({ settings }).success).toBe(false);
    }
  });

  it('keeps defaults for full settings reads, not partial writes', () => {
    expect(OrganizationSettingsSchema.parse({ brandName: 'Conference' }).defaultTemplateId).toBeNull();
    expect(UpdateOrganizationSettingsSchema.parse({ name: 'Conference' })).toEqual({ name: 'Conference' });
  });
});
