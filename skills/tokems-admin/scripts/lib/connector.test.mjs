import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { actionPath } from './catalog.mjs';
import {
  decryptJson,
  dpopProof,
  encryptJson,
  generateDpopKey,
  stableStringify,
} from './crypto.mjs';
import { requireUuid, writeArtifact } from './files.mjs';
import { endpoint, normalizeOrigin, readBoundedResponse } from './http.mjs';
import { redact, safeError } from './redaction.mjs';

test('canonical JSON is stable and encrypted pending content is authenticated', () => {
  const left = { z: 2, a: { enabled: true, values: ['one', 3] } };
  const right = { a: { values: ['one', 3], enabled: true }, z: 2 };
  assert.equal(stableStringify(left), stableStringify(right));
  const key = Buffer.alloc(32, 7).toString('base64');
  const envelope = encryptJson(left, key, 'tokems:test:operation:v1');
  assert.deepEqual(decryptJson(envelope, key, 'tokems:test:operation:v1'), right);
  assert.throws(() => decryptJson(envelope, key, 'tokems:test:other:v1'));
});

test('origin and route binding reject credentials, free URLs, and unsupported paths', () => {
  assert.equal(normalizeOrigin('https://events.example.com'), 'https://events.example.com');
  assert.equal(
    endpoint('https://events.example.com', '/api/v1/admin/events'),
    'https://events.example.com/api/v1/admin/events',
  );
  assert.equal(
    endpoint('https://events.example.com', '/api/v1/events/tokems-2026/home-document'),
    'https://events.example.com/api/v1/events/tokems-2026/home-document',
  );
  assert.equal(
    endpoint('https://events.example.com', '/api/v1/homepage'),
    'https://events.example.com/api/v1/homepage',
  );
  assert.throws(() => normalizeOrigin('https://user:secret@events.example.com'));
  assert.throws(() => normalizeOrigin('http://events.example.com'));
  assert.throws(() => endpoint('https://events.example.com', 'https://attacker.example/path'));
  assert.throws(() => endpoint('https://events.example.com', '/internal/debug'));
  assert.throws(() => endpoint('https://events.example.com', '/api/v1/homepage-escape'));
  assert.throws(() =>
    endpoint('https://events.example.com', '/api/v1/admin/templates/%2e%2e/audit-logs'),
  );
});

test('DPoP target binding omits query and fragment components', () => {
  const proof = dpopProof({
    keys: generateDpopKey(),
    method: 'GET',
    url: 'https://events.example.com/api/v1/admin/events?page=2#local',
    accessToken: 'access-token',
  });
  const payload = JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.htu, 'https://events.example.com/api/v1/admin/events');
});

test('catalog route templates encode identifiers and constrain query construction', () => {
  const action = {
    method: 'GET',
    path: '/api/v1/admin/events/:eventId/registrations',
  };
  assert.equal(
    actionPath(action, { eventId: 'event/with space', status: ['paid', 'pending'], _local: true }),
    '/api/v1/admin/events/event%2Fwith%20space/registrations?status=paid&status=pending',
  );
  assert.throws(() => actionPath(action, { status: 'paid' }));
});

test('artifact writes require an absolute path, preserve bytes, and use mode 0600', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokems-admin-test-'));
  const output = join(directory, 'invoice.pdf');
  const bytes = Buffer.from('bounded-artifact');
  const result = await writeArtifact(output, bytes);
  assert.equal(result.path, output);
  assert.equal(result.size, bytes.length);
  assert.deepEqual(await readFile(output), bytes);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(() => writeArtifact(output, Buffer.from('replacement')), {
    code: 'OUTPUT_PATH_EXISTS',
  });
  await assert.rejects(() => writeArtifact('relative.csv', bytes), {
    code: 'INVALID_OUTPUT_PATH',
  });
});

test('bounded response reading rejects declared and streamed oversized payloads', async () => {
  await assert.rejects(
    () =>
      readBoundedResponse(
        new Response('small', { headers: { 'content-length': '100' } }),
        10,
      ),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  await assert.rejects(() => readBoundedResponse(new Response('01234567890'), 10), {
    code: 'RESPONSE_TOO_LARGE',
  });
});

test('local state identifiers reject traversal and non-UUID values', () => {
  assert.equal(
    requireUuid('4d46d6b7-f7b4-4f6f-8cd4-66e5e5f44c01'),
    '4d46d6b7-f7b4-4f6f-8cd4-66e5e5f44c01',
  );
  assert.throws(() => requireUuid('../../outside', 'operation identifier'), {
    code: 'INVALID_IDENTIFIER',
  });
});

test('structured output redacts secret-bearing keys and errors', () => {
  assert.deepEqual(
    redact({
      status: 'ok',
      refreshToken: 'secret',
      nested: {
        email: 'person@example.com',
        attendeeName: 'Private attendee',
        displayName: 'Private display',
        taxId: 'TAX-PRIVATE',
        formAnswers: { custom: 'private answer' },
      },
    }),
    {
      status: 'ok',
      refreshToken: '[redacted]',
      nested: {
        email: '[redacted]',
        attendeeName: '[redacted]',
        displayName: '[redacted]',
        taxId: '[redacted]',
        formAnswers: '[redacted]',
      },
    },
  );
  assert.deepEqual(safeError(Object.assign(new Error('Denied'), { code: 'FORBIDDEN' })), {
    ok: false,
    code: 'FORBIDDEN',
    message: 'Denied',
    details: {},
  });
});
