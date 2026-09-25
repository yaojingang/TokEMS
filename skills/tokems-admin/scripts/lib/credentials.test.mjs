import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialWriteInvocation, decodeKeychainOutput } from './credentials.mjs';

test('credential-store writes keep secret values out of subprocess arguments', () => {
  const secret = 'refresh-token-value';
  for (const platform of ['darwin', 'linux']) {
    const invocation = credentialWriteInvocation(platform, 'connection-id', secret);
    assert.ok(invocation);
    assert.equal(invocation.args.includes(secret), false);
    assert.equal(invocation.options.input.includes(secret), true);
    if (platform === 'darwin') assert.equal(invocation.options.input, secret);
  }
});

test('Keychain hex output for Unicode JSON is decoded before parsing', () => {
  const profile = JSON.stringify({ name: '首页内容管理' });
  assert.equal(decodeKeychainOutput(Buffer.from(profile).toString('hex')), profile);
  assert.equal(decodeKeychainOutput('plain-password'), 'plain-password');
});
