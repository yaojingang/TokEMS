import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialWriteInvocation } from './credentials.mjs';

test('credential-store writes keep secret values out of subprocess arguments', () => {
  const secret = 'refresh-token-value';
  for (const platform of ['darwin', 'linux']) {
    const invocation = credentialWriteInvocation(platform, 'connection-id', secret);
    assert.ok(invocation);
    assert.equal(invocation.args.includes(secret), false);
    assert.equal(invocation.options.input.includes(secret), true);
  }
});
