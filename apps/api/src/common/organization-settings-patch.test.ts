import { describe, expect, it } from 'vitest';
import { OrganizationSettingsSchema, UpdateOrganizationSettingsSchema } from '@conference/contracts';
import { mergeOrganizationSettingsPatch } from './organization-admin.service.js';

describe('organization settings partial update', () => {
  const before = OrganizationSettingsSchema.parse({
    brandName: 'Conference',
    defaultTemplateId: '18181818-1818-4181-8181-181818181818',
    defaultBlueprintId: 'existing-blueprint',
    customerAccounts: { termsUrl: 'https://example.com/old', privacyUrl: 'https://example.com/privacy', termsVersion: 'v1' },
    website: { siteName: 'Production', footerText: 'Keep me' },
  });

  it('saving terms preserves default pointers and other nested settings', () => {
    const patch = UpdateOrganizationSettingsSchema.parse({ settings: { customerAccounts: { termsUrl: 'https://example.com/terms' } } });
    const result = mergeOrganizationSettingsPatch(before, patch.settings);
    expect(result).toEqual({ ...before, customerAccounts: { ...before.customerAccounts, termsUrl: 'https://example.com/terms' } });
  });

  it('merges website fields without blanking the footer or changing analytics', () => {
    const patch = UpdateOrganizationSettingsSchema.parse({ settings: { website: { siteName: 'New name' } } });
    expect(mergeOrganizationSettingsPatch(before, patch.settings)).toEqual({ ...before, website: { ...before.website, siteName: 'New name' } });
  });

  it('ignores explicit undefined in internal calls but honors explicit null', () => {
    expect(mergeOrganizationSettingsPatch(before, { customerAccounts: { termsVersion: undefined } })).toEqual(before);
    expect(mergeOrganizationSettingsPatch(before, { defaultTemplateId: null }).defaultTemplateId).toBeNull();
  });
});
