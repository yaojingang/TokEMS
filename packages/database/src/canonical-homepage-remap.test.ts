import { describe, expect, it } from 'vitest';
import { remapCanonicalReferences } from './canonical-homepage-remap.js';

describe('canonical homepage reference remapping', () => {
  it('remaps exact IDs, storage keys, and template asset URLs inside HTML', () => {
    const canonicalId = '11111111-1111-4111-8111-111111111111';
    const seededId = '22222222-2222-4222-8222-222222222222';
    const value = {
      assetId: canonicalId,
      sourceStorageKey: 'templates/canonical/source.html',
      sanitizedHtml: `<img src="/api/v1/assets/templates/${canonicalId}">`,
      assetManifest: [{ url: `/api/v1/assets/templates/${canonicalId}` }],
    };

    expect(
      remapCanonicalReferences(
        value,
        new Map([
          [canonicalId, seededId],
          ['templates/canonical/source.html', 'templates/production/source.html'],
        ]),
      ),
    ).toEqual({
      assetId: seededId,
      sourceStorageKey: 'templates/production/source.html',
      sanitizedHtml: `<img src="/api/v1/assets/templates/${seededId}">`,
      assetManifest: [{ url: `/api/v1/assets/templates/${seededId}` }],
    });
  });

  it('does not rewrite a path with a suffix after the asset UUID', () => {
    const canonicalId = '11111111-1111-4111-8111-111111111111';
    const value = `/api/v1/assets/templates/${canonicalId}/unexpected`;

    expect(remapCanonicalReferences(value, new Map([[canonicalId, 'replacement']]))).toBe(value);
  });
});
