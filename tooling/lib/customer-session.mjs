export async function createCustomerSession({ apiBase, mobile, organizationSlug }) {
  const organizationHeaders = {
    'Content-Type': 'application/json',
    'X-Organization-Slug': organizationSlug,
  };
  const challengeResponse = await fetch(`${apiBase}/customer-auth/otp`, {
    method: 'POST',
    headers: organizationHeaders,
    body: JSON.stringify({ mobile }),
  });
  const challenge = await challengeResponse.json().catch(() => ({}));
  if (!challengeResponse.ok) {
    throw new Error(
      `Customer OTP request failed: ${challengeResponse.status} ${JSON.stringify(challenge)}`,
    );
  }
  const developmentCode = challenge.developmentCode;
  if (typeof developmentCode !== 'string' || developmentCode.length !== 6) {
    throw new Error('Local customer OTP challenge did not expose a development code');
  }
  const verifyResponse = await fetch(`${apiBase}/customer-auth/verify`, {
    method: 'POST',
    headers: organizationHeaders,
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      mobile,
      code: developmentCode,
      consentAccepted: true,
      termsVersion: '',
      privacyVersion: '',
    }),
  });
  const session = await verifyResponse.json().catch(() => ({}));
  if (!verifyResponse.ok) {
    throw new Error(
      `Customer OTP verification failed: ${verifyResponse.status} ${JSON.stringify(session)}`,
    );
  }
  const cookie = verifyResponse.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie || typeof session.csrfToken !== 'string') {
    throw new Error('Customer OTP verification did not return a usable session');
  }
  return {
    cookie,
    csrfToken: session.csrfToken,
    customer: session.customer,
    headers: {
      Cookie: cookie,
      'X-Csrf-Token': session.csrfToken,
      'X-Organization-Slug': organizationSlug,
    },
  };
}
