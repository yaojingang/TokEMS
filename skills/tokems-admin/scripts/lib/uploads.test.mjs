import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateUploadGrant, uploadFileBytes } from './uploads.mjs';
import { templateDifference } from './template-workflow.mjs';

test('upload grants bind the exact file, trusted storage origin, headers and lifetime', () => {
  const grant = { uploadUrl: 'https://storage.example.com/assets/image?X-Amz-Signature=protected',
    method: 'PUT', contentDigest: 'a'.repeat(64), size: 16,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), headers: { 'Content-Type': 'image/png' } };
  const validate = (input = grant, origins = ['https://storage.example.com']) =>
    validateUploadGrant(input, origins, 'a'.repeat(64), 16);
  assert.equal(validate().headers['Content-Type'], 'image/png');
  assert.throws(() => validate(grant, ['https://other.example.com']));
  assert.throws(() => validate({ ...grant, contentDigest: 'b'.repeat(64) }));
  assert.throws(() => validate({ ...grant, expiresAt: 'invalid' }));
  assert.throws(() => validate({ ...grant, expiresAt: '2000-01-01' }));
  assert.throws(() => validate({ ...grant, headers: { Authorization: 'must-not-forward' } }));
  assert.throws(() => validate({ ...grant, uploadUrl: 'https://user:secret@storage.example.com/assets' }));
});

test('approved HTML-sized files remain uploadable and larger files fail before transfer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokems-cli-upload-'));
  try {
    const path = join(directory, 'page.html');
    await writeFile(path, Buffer.alloc(3 * 1024 * 1024, 32));
    assert.equal((await uploadFileBytes(path, 5 * 1024 * 1024)).length, 3 * 1024 * 1024);
    await assert.rejects(() => uploadFileBytes(path, 1024), /size/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('template diff includes changed fields while preserving unrelated values', () => {
  assert.deepEqual(templateDifference({ a: { value: 'old' }, unchanged: true },
    { a: { value: 'new' }, unchanged: true }), [{ path: '/a/value', before: 'old', after: 'new' }]);
});
