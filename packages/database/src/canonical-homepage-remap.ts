const canonicalTemplateAssetUrlPattern =
  /\/api\/v1\/assets\/templates\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?=["'\s<>)?#]|$)/giu;

export function remapCanonicalReferences(
  value: unknown,
  referenceMap: Map<string, string>,
): unknown {
  if (typeof value === 'string') {
    const exact = referenceMap.get(value);
    if (exact) return exact;
    return value.replace(canonicalTemplateAssetUrlPattern, (match, assetId: string) => {
      const mappedAssetId = referenceMap.get(assetId);
      return mappedAssetId ? match.replace(assetId, mappedAssetId) : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapCanonicalReferences(item, referenceMap));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      remapCanonicalReferences(item, referenceMap),
    ]),
  );
}
