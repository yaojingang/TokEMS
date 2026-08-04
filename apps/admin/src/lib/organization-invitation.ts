export function buildOrganizationInvitationAcceptanceUrl(
  acceptanceToken: string,
  organizationSlug: string,
  baseUrl = import.meta.env.BASE_URL,
  origin = window.location.origin,
) {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const invitationUrl = new URL(`${normalizedBaseUrl}accept-invitation`, origin);
  invitationUrl.hash = new URLSearchParams({
    token: acceptanceToken,
    organization: organizationSlug,
  }).toString();
  return invitationUrl.toString();
}
