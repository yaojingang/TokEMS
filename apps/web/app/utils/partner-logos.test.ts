import { describe, expect, it } from 'vitest';
import { TemplateLogoWallSchema, type TemplatePartnerLogo } from '@conference/contracts';
import { visiblePartnerLogos } from './partner-logos';

function logo(overrides: Partial<TemplatePartnerLogo> = {}): TemplatePartnerLogo {
  return {
    id: crypto.randomUUID(),
    name: '移山科技',
    assetId: crypto.randomUUID(),
    group: 'speaker',
    enabled: true,
    background: 'light',
    scale: 1,
    ...overrides,
  };
}

describe('pure logo wall', () => {
  it('omits disabled and missing images, while preserving the maintained order', () => {
    const first = logo({ name: '媒体甲', group: 'media' });
    const last = logo({ name: '嘉宾乙' });
    expect(
      visiblePartnerLogos({
        enabled: true,
        items: [first, logo({ enabled: false }), logo({ assetId: null }), last],
      }),
    ).toEqual([first, last]);
  });
  it('hides an absent, empty or disabled wall without text fallback', () => {
    expect(visiblePartnerLogos(undefined)).toEqual([]);
    expect(visiblePartnerLogos({ enabled: true, items: [] })).toEqual([]);
    expect(visiblePartnerLogos({ enabled: false, items: [logo()] })).toEqual([]);
  });
  it('rejects duplicate identifiers and invalid image references or display sizes', () => {
    const entry = logo();
    expect(TemplateLogoWallSchema.safeParse({ enabled: true, items: [entry, entry] }).success).toBe(
      false,
    );
    for (const invalid of [
      { assetId: 'https://untrusted.example/logo.png' },
      { scale: 3 },
      { background: 'red' },
    ]) {
      expect(visiblePartnerLogos({ enabled: true, items: [{ ...entry, ...invalid }] })).toEqual([]);
    }
  });
});
