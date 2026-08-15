export function buildAdministratorLoginUrl(
  origin: string,
  baseUrl: string,
  organizationSlug: string,
) {
  const basePath = baseUrl.startsWith('/') ? baseUrl : `/${baseUrl}`;
  const loginPath = `${basePath.endsWith('/') ? basePath : `${basePath}/`}login`;
  const url = new URL(loginPath, origin);
  if (organizationSlug) url.searchParams.set('organization', organizationSlug);
  return url.toString();
}
