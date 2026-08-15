type LegacyRouteParams = Record<string, string | string[]>;
type LegacyRouteQuery = Record<string, string | (string | null)[] | null | undefined>;

export function legacyContentWorkspaceRoute(
  params: LegacyRouteParams,
  query: LegacyRouteQuery,
  hash: string,
) {
  return {
    name: 'event-settings-general' as const,
    params,
    query,
    hash: hash || '#public-page',
  };
}
