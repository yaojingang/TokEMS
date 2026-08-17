import { generateDataKey, generateDpopKey, dpopProof } from './crypto.mjs';
import {
  credentialStoreAvailable,
  credentialStoreKind,
  deleteCredential,
  readJsonCredential,
  storeJsonCredential,
} from './credentials.mjs';
import { fetchBound, formBody, normalizeOrigin } from './http.mjs';
import { requireUuid, withLocalLock } from './files.mjs';

const CLIENT_ID = 'tokems-admin-skill';
const SKILL_VERSION = '0.1.1';
const INDEX_KEY = 'connections:index';
const ACTIVE_KEY = 'connections:active';

function versionAtLeast(version, minimum) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/u.exec(String(value));
    return match ? { parts: match.slice(1, 4).map(Number), suffix: match[4] } : undefined;
  };
  const actual = parse(version);
  const required = parse(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < required.parts.length; index += 1) {
    if (actual.parts[index] > required.parts[index]) return true;
    if (actual.parts[index] < required.parts[index]) return false;
  }
  return !actual.suffix.startsWith('-') || required.suffix.startsWith('-');
}

function profileKey(id) {
  requireUuid(id, 'connection identifier');
  return `connection:${id}`;
}

export async function inspectInstance(origin) {
  const normalized = normalizeOrigin(origin);
  const { value } = await fetchBound(normalized, '/.well-known/tokems-agent');
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.resource !== 'string' ||
    typeof value.catalogVersion !== 'string'
  ) {
    const error = new Error('Target does not expose TokEMS Agent metadata');
    error.code = 'TOKEMS_IDENTITY_MISMATCH';
    throw error;
  }
  if (new URL(value.resource).origin !== normalized) {
    const error = new Error('TokEMS metadata resource origin does not match the approved origin');
    error.code = 'TOKEMS_IDENTITY_MISMATCH';
    throw error;
  }
  if (value.resource !== `${normalized}/api/v1`) {
    const error = new Error('TokEMS metadata resource path is invalid');
    error.code = 'TOKEMS_IDENTITY_MISMATCH';
    throw error;
  }
  if (!versionAtLeast(SKILL_VERSION, value.minClientVersion)) {
    const error = new Error(`TokEMS Admin Skill ${value.minClientVersion} or newer is required`);
    error.code = 'AGENT_VERSION_UNSUPPORTED';
    throw error;
  }
  return {
    ...value,
    origin: normalized,
    adminOrigin: normalizeOrigin(value.adminOrigin || normalized),
  };
}

function updateIndex(profile, remove = false) {
  const index = readJsonCredential(INDEX_KEY, []);
  const filtered = index.filter((item) => item.id !== profile.connectionId);
  if (!remove) {
    filtered.push({
      id: profile.connectionId,
      name: profile.name,
      origin: profile.origin,
      organizationId: profile.organizationId,
      scopes: profile.scopes,
      createdAt: profile.createdAt,
    });
  }
  storeJsonCredential(INDEX_KEY, filtered);
  return filtered;
}

export function listConnections() {
  return readJsonCredential(INDEX_KEY, []);
}

export function activeConnectionId() {
  return readJsonCredential(ACTIVE_KEY, {}).id;
}

export function selectConnection(id) {
  const profile = loadProfile(id);
  storeJsonCredential(ACTIVE_KEY, { id: profile.connectionId });
  return { id: profile.connectionId, name: profile.name, origin: profile.origin };
}

export function loadProfile(id = activeConnectionId()) {
  if (!id) {
    const error = new Error('No active TokEMS Admin connection is selected');
    error.code = 'CONNECTION_REQUIRED';
    throw error;
  }
  const profile = readJsonCredential(profileKey(id));
  if (!profile) {
    const error = new Error('TokEMS Admin connection profile was not found');
    error.code = 'CONNECTION_NOT_FOUND';
    throw error;
  }
  return profile;
}

export async function connect({ origin, name, scope }) {
  if (!credentialStoreAvailable()) {
    const error = new Error('A supported secure credential store is required before connection');
    error.code = 'CREDENTIAL_STORE_UNAVAILABLE';
    throw error;
  }
  const metadata = await inspectInstance(origin);
  if (!metadata.features?.access) {
    const error = new Error('TokEMS Agent Access is disabled on this instance');
    error.code = 'AGENT_ACCESS_DISABLED';
    throw error;
  }
  const keys = generateDpopKey();
  const request = formBody({
    client_id: CLIENT_ID,
    resource: metadata.resource,
    scope: scope || 'tokems:*',
    dpop_jkt: keys.thumbprint,
    client_name: name || 'TokEMS Admin Skill',
    skill_version: SKILL_VERSION,
  });
  const { value: authorization } = await fetchBound(
    metadata.origin,
    '/api/v1/oauth/device_authorization',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: request,
    },
  );
  const verificationUri = new URL(authorization.verification_uri);
  const verificationUriComplete = new URL(authorization.verification_uri_complete);
  if (
    verificationUri.origin !== metadata.adminOrigin ||
    verificationUriComplete.origin !== metadata.adminOrigin ||
    !verificationUri.pathname.endsWith('/agent-authorizations') ||
    verificationUriComplete.pathname !== verificationUri.pathname ||
    verificationUriComplete.searchParams.get('user_code') !== authorization.user_code
  ) {
    const error = new Error('TokEMS authorization page does not match the approved admin origin');
    error.code = 'TOKEMS_IDENTITY_MISMATCH';
    throw error;
  }
  process.stderr.write(
    `Open this TokEMS authorization page and complete super-administrator step-up:\n${authorization.verification_uri_complete}\nCode: ${authorization.user_code}\n`,
  );
  const deadline = Date.now() + Number(authorization.expires_in) * 1000;
  let interval = Math.max(5, Number(authorization.interval || 5));
  let token;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const path = '/api/v1/oauth/token';
    const url = new URL(path, metadata.origin).toString();
    try {
      const response = await fetchBound(metadata.origin, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: dpopProof({ keys, method: 'POST', url }),
        },
        body: formBody({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: authorization.device_code,
          client_id: CLIENT_ID,
        }),
      });
      token = response.value;
      break;
    } catch (error) {
      if (error.code === 'authorization_pending') continue;
      if (error.code === 'slow_down') {
        interval += 5;
        continue;
      }
      throw error;
    }
  }
  if (!token) {
    const error = new Error('TokEMS device authorization expired before approval');
    error.code = 'expired_token';
    throw error;
  }
  requireUuid(token.connection_id, 'connection identifier');
  const tokenPayload = JSON.parse(
    Buffer.from(String(token.access_token).split('.')[1], 'base64url').toString('utf8'),
  );
  requireUuid(tokenPayload.organization_id, 'organization identifier');
  const profile = {
    connectionId: token.connection_id,
    name: name || 'TokEMS Admin Skill',
    origin: metadata.origin,
    adminOrigin: metadata.adminOrigin || metadata.origin,
    organizationId: tokenPayload.organization_id,
    resource: metadata.resource,
    catalogVersion: metadata.catalogVersion,
    scopes: String(token.scope || '')
      .split(/\s+/u)
      .filter(Boolean),
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    accessTokenExpiresAt: new Date(Date.now() + Number(token.expires_in) * 1000).toISOString(),
    publicJwk: keys.publicJwk,
    privateJwk: keys.privateJwk,
    dpopThumbprint: keys.thumbprint,
    dataKey: generateDataKey(),
    createdAt: new Date().toISOString(),
  };
  try {
    storeJsonCredential(profileKey(profile.connectionId), profile);
    updateIndex(profile);
    storeJsonCredential(ACTIVE_KEY, { id: profile.connectionId });
  } catch (error) {
    await fetchBound(profile.origin, '/api/v1/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ token: profile.refreshToken, token_type_hint: 'refresh_token' }),
    }).catch(() => undefined);
    throw error;
  }
  return {
    connectionId: profile.connectionId,
    name: profile.name,
    origin: profile.origin,
    scopes: profile.scopes,
    credentialStore: credentialStoreKind(),
  };
}

async function refreshAccess(profile) {
  const path = '/api/v1/oauth/token';
  const url = new URL(path, profile.origin).toString();
  const keys = { publicJwk: profile.publicJwk, privateJwk: profile.privateJwk };
  const { value } = await fetchBound(profile.origin, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: dpopProof({ keys, method: 'POST', url }),
    },
    body: formBody({
      grant_type: 'refresh_token',
      refresh_token: profile.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  profile.refreshToken = value.refresh_token;
  profile.accessToken = value.access_token;
  profile.accessTokenExpiresAt = new Date(
    Date.now() + Number(value.expires_in) * 1000,
  ).toISOString();
  profile.scopes = String(value.scope || '')
    .split(/\s+/u)
    .filter(Boolean);
  storeJsonCredential(profileKey(profile.connectionId), profile);
  updateIndex(profile);
  return value.access_token;
}

export async function authenticatedFetch(connectionId, path, options = {}) {
  const id = connectionId || activeConnectionId();
  requireUuid(id, 'connection identifier');
  return withLocalLock(id, async () => {
    const profile = loadProfile(id);
    const cachedExpiry = Date.parse(profile.accessTokenExpiresAt || '');
    const accessToken =
      profile.accessToken && Number.isFinite(cachedExpiry) && cachedExpiry > Date.now() + 30_000
        ? profile.accessToken
        : await refreshAccess(profile);
    const method = options.method ?? 'GET';
    const url = new URL(path, profile.origin).toString();
    return fetchBound(profile.origin, path, {
      ...options,
      method,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
        Authorization: `DPoP ${accessToken}`,
        DPoP: dpopProof({
          keys: { publicJwk: profile.publicJwk, privateJwk: profile.privateJwk },
          method,
          url,
          accessToken,
        }),
      },
    });
  });
}

export async function revokeConnection(id = activeConnectionId()) {
  requireUuid(id, 'connection identifier');
  return withLocalLock(id, async () => {
    const profile = loadProfile(id);
    await fetchBound(profile.origin, '/api/v1/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ token: profile.refreshToken, token_type_hint: 'refresh_token' }),
    }).catch((error) => {
      if (!['AGENT_CONNECTION_REVOKED', 'invalid_grant'].includes(error.code)) throw error;
    });
    deleteCredential(profileKey(profile.connectionId));
    updateIndex(profile, true);
    if (activeConnectionId() === profile.connectionId) deleteCredential(ACTIVE_KEY);
    return { connectionId: profile.connectionId, revoked: true };
  });
}
