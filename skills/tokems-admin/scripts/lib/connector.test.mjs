import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { actionPath } from './catalog.mjs';
import { validateOperationInput } from './operations.mjs';
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

test('attendee-needs operations require versions, reasons, and anonymous speaker exports', () => {
  assert.doesNotThrow(() =>
    validateOperationInput(
      'attendee-needs.update',
      { eventId: 101, questionId: crypto.randomUUID() },
      { version: 2, reason: '修正错别字' },
    ),
  );
  assert.throws(
    () =>
      validateOperationInput(
        'attendee-needs.moderate',
        { eventId: 101, questionId: crypto.randomUUID() },
        { version: 2, action: 'hide', reason: '' },
      ),
    { code: 'ATTENDEE_NEEDS_REASON_REQUIRED' },
  );
  assert.throws(
    () =>
      validateOperationInput(
        'attendee-needs.export',
        { eventId: 101, variant: 'speaker', forceAnonymous: false },
        {},
      ),
    { code: 'ATTENDEE_NEEDS_SPEAKER_EXPORT_REQUIRES_ANONYMITY' },
  );
  assert.doesNotThrow(() =>
    validateOperationInput(
      'attendee-needs.export',
      { eventId: 101, variant: 'internal', forceAnonymous: false },
      {},
    ),
  );
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

test('artifact output preserves existing parent permissions and creates private new directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokems-output-permissions-'));
  try {
    await chmod(directory, 0o750);
    const output = join(directory, 'draft.json');
    await writeArtifact(output, Buffer.from('{}'));
    assert.equal((await stat(directory)).mode & 0o777, 0o750);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(() => writeArtifact(output, Buffer.from('replacement')), { code: 'OUTPUT_PATH_EXISTS' });
    assert.equal((await stat(directory)).mode & 0o777, 0o750);
    await writeArtifact(join(directory, 'private', 'nested', 'draft.json'), Buffer.from('{}'));
    assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'private', 'nested'))).mode & 0o777, 0o700);
    assert.equal((await stat(directory)).mode & 0o777, 0o750);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('artifact writes keep permission changes on the opened file during path substitution', () => {
  const script = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    const io=fs.promises, root=await io.mkdtemp(join(tmpdir(),'tokems-path-race-'));
    const output=join(root,'draft.json'), saved=join(root,'saved.json'), victim=join(root,'victim');
    await io.mkdir(victim,{mode:0o755}); await io.chmod(victim,0o755);
    let swapped=false;
    const replace=async()=>{if(swapped)return;await io.rename(output,saved);await io.symlink(victim,output);swapped=true;};
    const originalWrite=io.writeFile, originalOpen=io.open;
    io.writeFile=async(path,...args)=>{const result=await originalWrite(path,...args);if(path===output)await replace();return result;};
    io.open=async(path,...args)=>{const handle=await originalOpen(path,...args);if(path===output){
      const write=handle.writeFile.bind(handle);handle.writeFile=async(...values)=>{const result=await write(...values);await replace();return result;};
    }return handle;};
    syncBuiltinESMExports();
    try {
      const {writeArtifact}=await import(process.argv[1]);await writeArtifact(output,Buffer.from('protected'));
      process.stdout.write(JSON.stringify({swapped,victimMode:(await io.stat(victim)).mode&0o777,
        fileMode:(await io.stat(saved)).mode&0o777,bytes:await io.readFile(saved,'utf8')}));
    }finally{await io.chmod(victim,0o755);await io.rm(root,{recursive:true,force:true});}
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script,
    new URL('./files.mjs', import.meta.url).href], { encoding: 'utf8' }));
  assert.equal(result.swapped, true);
  assert.equal(result.victimMode, 0o755);
  assert.equal(result.fileMode, 0o600);
  assert.equal(result.bytes, 'protected');
});

test('bounded response reading rejects declared and streamed oversized payloads', async () => {
  await assert.rejects(
    () => readBoundedResponse(new Response('small', { headers: { 'content-length': '100' } }), 10),
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
