function cookieFrom(response, name) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ?? '').split(/,(?=[^;,]+=)/u);
  return values.find((value) => value.trimStart().startsWith(`${name}=`))?.split(';', 1)[0];
}

function mergeCookies(cookieJar, response) {
  const cookies = new Map(
    cookieJar
      .split(';')
      .map((value) => value.trim().split('=', 2))
      .filter(([name, value]) => name && value)
      .map(([name, value]) => [name, `${name}=${value}`]),
  );
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ?? '').split(/,(?=[^;,]+=)/u);
  for (const value of values) {
    const pair = value.trimStart().split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (cookieValue) cookies.set(name, pair);
    else cookies.delete(name);
  }
  return [...cookies.values()].join('; ');
}

export async function createCustomerSession({ apiBase, mobile, organizationSlug, forwardedFor }) {
  const organizationHeaders = {
    'Content-Type': 'application/json',
    'X-Organization-Slug': organizationSlug,
    ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
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
  let session = await verifyResponse.json().catch(() => ({}));
  if (!verifyResponse.ok) {
    throw new Error(
      `Customer OTP verification failed: ${verifyResponse.status} ${JSON.stringify(session)}`,
    );
  }
  let cookie = mergeCookies('', verifyResponse);
  if (session.consentRequired) {
    const consentCookie = cookieFrom(verifyResponse, 'conference_customer_consent');
    if (!consentCookie || !session.policy) {
      throw new Error('Customer OTP verification returned an incomplete consent challenge');
    }
    const consentResponse = await fetch(`${apiBase}/customer-auth/consent`, {
      method: 'POST',
      headers: {
        ...organizationHeaders,
        Cookie: consentCookie,
        Origin: process.env.PUBLIC_ORIGIN ?? new URL(apiBase).origin,
        'X-Consent-Confirmation': 'true',
      },
      body: JSON.stringify({
        consentAccepted: true,
        termsVersion: session.policy.termsVersion,
        privacyVersion: session.policy.privacyVersion,
      }),
    });
    session = await consentResponse.json().catch(() => ({}));
    if (!consentResponse.ok) {
      throw new Error(
        `Customer consent confirmation failed: ${consentResponse.status} ${JSON.stringify(session)}`,
      );
    }
    cookie = mergeCookies(cookie, consentResponse);
  }
  if (!cookie.includes('conference_customer_session=') || typeof session.csrfToken !== 'string') {
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
      ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
    },
  };
}
