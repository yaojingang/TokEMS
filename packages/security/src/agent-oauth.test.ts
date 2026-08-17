import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createAgentStateObservation,
  dpopJwkThumbprint,
  normalizeAgentOrigin,
  resolveAgentAccessFeatures,
  sha256Base64Url,
  stableCanonicalJson,
  verifyDpopProof,
  verifyAgentStateObservation,
} from './agent-oauth.js';

describe('stableCanonicalJson', () => {
  it('binds equivalent object bodies to the same canonical representation', () => {
    expect(stableCanonicalJson({ z: 1, a: { y: true, x: ['v', 2] } })).toBe(
      stableCanonicalJson({ a: { x: ['v', 2], y: true }, z: 1 }),
    );
  });
});

function proof(method: string, url: string, token?: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const header = Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      htm: method,
      htu: url,
      iat: 1_800_000_000,
      jti: 'proof-12345678',
      ...(token ? { ath: sha256Base64Url(token) } : {}),
    }),
  ).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { value: `${header}.${payload}.${signature}`, jkt: dpopJwkThumbprint(jwk) };
}

describe('TokEMS Agent OAuth security helpers', () => {
  it('keeps every feature disabled by default and enforces dependency ordering', () => {
    expect(resolveAgentAccessFeatures({})).toEqual({
      access: false,
      writes: false,
      criticalActions: false,
    });
    expect(
      resolveAgentAccessFeatures({
        TOKEMS_AGENT_WRITES_ENABLED: 'true',
        TOKEMS_AGENT_CRITICAL_ACTIONS_ENABLED: 'true',
      }),
    ).toEqual({ access: false, writes: false, criticalActions: false });
  });

  it('accepts HTTPS and local development HTTP origins only', () => {
    expect(normalizeAgentOrigin('https://events.example.com', {})).toBe(
      'https://events.example.com',
    );
    expect(normalizeAgentOrigin('http://localhost:3000', { NODE_ENV: 'development' })).toBe(
      'http://localhost:3000',
    );
    expect(() => normalizeAgentOrigin('https://events.example.com/path', {})).toThrow(
      'only scheme',
    );
    expect(() => normalizeAgentOrigin('http://events.example.com', {})).toThrow('HTTPS');
  });

  it('verifies an ES256 DPoP proof and access-token binding', () => {
    const token = 'access-token-value';
    const generated = proof('GET', 'https://events.example.com/api/v1/agent/capabilities', token);
    expect(
      verifyDpopProof({
        proof: generated.value,
        method: 'GET',
        url: 'https://events.example.com/api/v1/agent/capabilities',
        accessToken: token,
        now: 1_800_000_000,
      }),
    ).toMatchObject({ jti: 'proof-12345678', jkt: generated.jkt });
  });

  it('signs short-lived server state observations and rejects tampering', () => {
    const secret = Buffer.alloc(32, 7);
    const token = createAgentStateObservation(
      {
        connectionId: '4d46d6b7-f7b4-4f6f-8cd4-66e5e5f44c01',
        organizationId: 'ad57a5eb-1c84-4d30-9306-4a6708ff0aa2',
        actionId: 'events.get',
        targetFingerprint: 'a'.repeat(64),
        stateFingerprint: 'b'.repeat(64),
      },
      secret,
      1_800_000_000,
    );
    expect(verifyAgentStateObservation(token, [secret], 1_800_000_010)).toMatchObject({
      actionId: 'events.get',
      stateFingerprint: 'b'.repeat(64),
    });
    expect(() =>
      verifyAgentStateObservation(`${token.slice(0, -1)}x`, [secret], 1_800_000_010),
    ).toThrow('signature');
    expect(() => verifyAgentStateObservation(token, [secret], 1_800_000_121)).toThrow('expired');
  });
});
