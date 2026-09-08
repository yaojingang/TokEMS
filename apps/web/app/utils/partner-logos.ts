import { TemplateLogoWallSchema } from '@conference/contracts';

export function visiblePartnerLogos(value: unknown) {
  const parsed = TemplateLogoWallSchema.safeParse(value);
  if (!parsed.success || !parsed.data.enabled) return [];
  return parsed.data.items.flatMap((logo) =>
    logo.enabled && logo.assetId ? [{ ...logo, assetId: logo.assetId }] : [],
  );
}
