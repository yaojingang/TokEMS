import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
const cli = fileURLToPath(new URL('../../skills/tokems-admin/scripts/tokems-admin.js', import.meta.url));
test('CLI exposes version and template commands without a connection', () => {
  assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), '0.4.0');
  assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /template preview/);
});
test('CLI rejects unknown options before using credentials or network', () => {
  const result = spawnSync(process.execPath, [cli, 'auth', 'connect', '--origin', 'https://example.com', '--unrecognized', 'x'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, 'CLI_OPTION_UNSUPPORTED');
});
