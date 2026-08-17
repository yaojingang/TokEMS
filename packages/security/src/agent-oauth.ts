import {
  createHash,
  createHmac,
  createPublicKey,
  createSecretKey,
  timingSafeEqual,
  verify,
  type webcrypto,
} from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey;

export const AGENT_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
export const AGENT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AGENT_CONNECTION_TTL_SECONDS = 90 * 24 * 60 * 60;
export const AGENT_DEVICE_CODE_TTL_SECONDS = 10 * 60;
export const AGENT_STEP_UP_TTL_SECONDS = 5 * 60;
export const AGENT_DPOP_REPLAY_TTL_SECONDS = 11 * 60;
export const AGENT_STATE_OBSERVATION_TTL_SECONDS = 2 * 60;

export interface AgentAccessFeatures {
  access: boolean;
  writes: boolean;
  criticalActions: boolean;
}

export interface VerifiedDpopProof {
  jti: string;
  jkt: string;
  issuedAt: number;
}

export interface AgentStateObservation {
  connectionId: string;
  organizationId: string;
  actionId: string;
  targetFingerprint: string;
  stateFingerprint: string;
  issuedAt: number;
  expiresAt: number;
}

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

export function resolveAgentAccessFeatures(
  environment: Record<string, string | undefined> = process.env,
): AgentAccessFeatures {
  const access = enabled(environment.TOKEMS_AGENT_ACCESS_ENABLED);
  const writes = access && enabled(environment.TOKEMS_AGENT_WRITES_ENABLED);
  return {
    access,
    writes,
    criticalActions: writes && enabled(environment.TOKEMS_AGENT_CRITICAL_ACTIONS_ENABLED),
  };
}

export function normalizeAgentOrigin(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('TokEMS Agent origin must be an absolute URL');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('TokEMS Agent origin must contain only scheme, host, and optional port');
  }
  const developmentLoopback =
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
    environment.NODE_ENV !== 'production';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && developmentLoopback)) {
    throw new Error('TokEMS Agent origin must use HTTPS');
  }
  return url.origin;
}

export function resolveAgentResource(
  environment: Record<string, string | undefined> = process.env,
) {
  const raw = environment.PUBLIC_ORIGIN ?? environment.PUBLIC_WEB_URL;
  if (!raw) throw new Error('PUBLIC_ORIGIN is required for TokEMS Agent Access');
  return `${normalizeAgentOrigin(raw, environment)}/api/v1`;
}

export function decodeAgentAccessSecret(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required when TokEMS Agent Access is enabled`);
  const key = Buffer.from(value, 'base64');
  if (
    key.length !== 32 ||
    key.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')
  ) {
    throw new Error(`${label} must be exactly 32 random bytes encoded as base64`);
  }
  return key;
}

export function agentAccessKeyId(secret: Buffer) {
  return createHash('sha256').update(secret).digest('base64url').slice(0, 16);
}

export function agentAccessSigningKey(value: string | undefined, label: string) {
  return createSecretKey(decodeAgentAccessSecret(value, label));
}

export function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableCanonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256Base64Url(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('base64url');
}

export function safeDigestEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAgentStateObservation(
  input: Omit<AgentStateObservation, 'issuedAt' | 'expiresAt'>,
  secret: Buffer,
  now = Math.floor(Date.now() / 1000),
) {
  const payload: AgentStateObservation = {
    ...input,
    issuedAt: now,
    expiresAt: now + AGENT_STATE_OBSERVATION_TTL_SECONDS,
  };
  const encoded = Buffer.from(stableCanonicalJson(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`tokems-agent-state.v1.${encoded}`)
    .digest('base64url');
  return `v1.${encoded}.${signature}`;
}

export function verifyAgentStateObservation(
  token: string,
  secrets: Buffer[],
  now = Math.floor(Date.now() / 1000),
): AgentStateObservation {
  const [version, encoded, signature, extra] = token.split('.');
  if (version !== 'v1' || !encoded || !signature || extra) {
    throw new Error('Agent state observation token is invalid');
  }
  const signatureValid = secrets.some((secret) => {
    const expected = createHmac('sha256', secret)
      .update(`tokems-agent-state.v1.${encoded}`)
      .digest('base64url');
    return safeDigestEqual(signature, expected);
  });
  if (!signatureValid) throw new Error('Agent state observation signature is invalid');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Agent state observation payload is invalid');
  }
  const observation = value as Partial<AgentStateObservation>;
  if (
    !observation ||
    typeof observation.connectionId !== 'string' ||
    typeof observation.organizationId !== 'string' ||
    typeof observation.actionId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(observation.targetFingerprint ?? '') ||
    !/^[a-f0-9]{64}$/u.test(observation.stateFingerprint ?? '') ||
    !Number.isSafeInteger(observation.issuedAt) ||
    !Number.isSafeInteger(observation.expiresAt) ||
    observation.issuedAt! > now + 30 ||
    observation.expiresAt! < now
  ) {
    throw new Error('Agent state observation payload is invalid or expired');
  }
  return observation as AgentStateObservation;
}

export function dpopJwkThumbprint(jwk: JsonWebKey) {
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string'
  ) {
    throw new Error('DPoP requires a public P-256 EC JWK');
  }
  return sha256Base64Url(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y }));
}

function decodeJwtSection(section: string) {
  try {
    return JSON.parse(Buffer.from(section, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error('DPoP proof is not a valid JWT');
  }
}

export function verifyDpopProof(input: {
  proof: string;
  method: string;
  url: string;
  accessToken?: string;
  now?: number;
}): VerifiedDpopProof {
  const sections = input.proof.split('.');
  if (sections.length !== 3) throw new Error('DPoP proof is not a valid JWT');
  const [encodedHeader, encodedPayload, encodedSignature] = sections as [string, string, string];
  const header = decodeJwtSection(encodedHeader);
  const payload = decodeJwtSection(encodedPayload);
  if (header.alg !== 'ES256' || String(header.typ).toLowerCase() !== 'dpop+jwt') {
    throw new Error('DPoP proof must use typ dpop+jwt and ES256');
  }
  if (!header.jwk || typeof header.jwk !== 'object') {
    throw new Error('DPoP proof must contain a public JWK');
  }
  const jwk = header.jwk as JsonWebKey;
  if ('d' in jwk) throw new Error('DPoP proof header must not contain private key material');
  const jkt = dpopJwkThumbprint(jwk);
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== 64) throw new Error('DPoP proof signature has an invalid length');
  const valid = verify(
    'sha256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
    { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    signature,
  );
  if (!valid) throw new Error('DPoP proof signature is invalid');

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const issuedAt = typeof payload.iat === 'number' ? payload.iat : Number.NaN;
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > 300) {
    throw new Error('DPoP proof iat is outside the accepted clock window');
  }
  if (payload.htm !== input.method.toUpperCase()) throw new Error('DPoP proof htm does not match');
  if (payload.htu !== input.url) throw new Error('DPoP proof htu does not match');
  if (typeof payload.jti !== 'string' || payload.jti.length < 8 || payload.jti.length > 160) {
    throw new Error('DPoP proof jti is invalid');
  }
  if (input.accessToken) {
    if (payload.ath !== sha256Base64Url(input.accessToken)) {
      throw new Error('DPoP proof ath does not match the access token');
    }
  } else if (payload.ath !== undefined) {
    throw new Error('Token endpoint DPoP proof must not contain ath');
  }
  return { jti: payload.jti, jkt, issuedAt };
}
