import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Approved by the maintainer on 2026-10-28 for the reviewed deepmerge build dependency path.
const approved = {
  ignoreGhsas: ['GHSA-gcqx-w48m-w2h4'],
};
const expiresAt = Date.parse('2026-11-09T00:00:00Z');

function verifyExceptions(config, now) {
  assert.deepEqual(config, approved, 'Audit exceptions must match the approved advisory');
  assert.ok(
    now < expiresAt,
    'Temporary audit exceptions expired; remove or explicitly re-review them',
  );
}

test('effective pnpm audit exceptions stay within the approved scope and time window', () => {
  const output = execFileSync('pnpm', ['config', 'get', 'auditConfig', '--json'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
  });
  verifyExceptions(output.trim() ? JSON.parse(output) : null, Date.now());
});

test('audit exception expiry blocks at the boundary and afterwards', () => {
  verifyExceptions(approved, expiresAt - 1);
  assert.throws(() => verifyExceptions(approved, expiresAt), /expired/);
  assert.throws(() => verifyExceptions(approved, expiresAt + 1), /expired/);
});

test('audit exception scope rejects extra advisories and broader exclusions', () => {
  assert.throws(() =>
    verifyExceptions({ ignoreGhsas: [...approved.ignoreGhsas, 'GHSA-extra'] }, expiresAt - 1),
  );
  assert.throws(() => verifyExceptions({ ...approved, ignoreCves: ['CVE-EXTRA'] }, expiresAt - 1));
});
