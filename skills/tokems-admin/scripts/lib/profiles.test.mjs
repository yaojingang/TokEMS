import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationScope } from './profiles.mjs';
import { normalizeOrigin } from './http.mjs';

test('authorization presets preserve least privilege and reject ambiguous grants', () => {
  assert.equal(authorizationScope('read'), 'tokems:read');
  assert.equal(authorizationScope(), 'tokems:read tokems:write');
  assert.match(authorizationScope('full'), /tokems:dangerous/);
  assert.throws(() => authorizationScope('full', 'tokems:read'));
  assert.throws(() => authorizationScope('__proto__'));
  assert.equal(normalizeOrigin('http://admin.localhost:8088'), 'http://admin.localhost:8088');
  assert.throws(() => normalizeOrigin('http://admin.localhost.example.com'));
});
