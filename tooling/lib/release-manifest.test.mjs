import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildReleaseManifest, latestMigration, parseTestResults } from './release-manifest.mjs';

test('release manifest hashes every supplied source file and records build identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokems-release-manifest-'));
  await mkdir(join(root, 'packages/database/drizzle'), { recursive: true });
  await writeFile(join(root, 'a.txt'), 'alpha\n');
  await writeFile(join(root, 'packages/database/drizzle/0002_latest.sql'), '-- latest\n');

  const manifest = await buildReleaseManifest({
    root,
    files: ['a.txt', 'packages/database/drizzle/0002_latest.sql'],
    git: { sha: 'abc1234', branch: 'test', dirty: false },
    builtAt: '2026-08-01T01:02:03.000Z',
    imageDigests: { api: 'sha256:1234' },
    testResults: { check: 'passed' },
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.build.sha, 'abc1234');
  assert.equal(manifest.build.migration, '0002_latest.sql');
  assert.equal(
    manifest.build.migrationHash,
    createHash('sha256').update('-- latest\n').digest('hex'),
  );
  assert.deepEqual(manifest.images, { api: 'sha256:1234' });
  assert.deepEqual(manifest.tests, { check: 'passed' });
  assert.equal(manifest.source.files.length, 2);
  assert.match(manifest.source.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.source.files[0].path, 'a.txt');
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha\n');
});

test('latestMigration selects the highest numbered SQL migration', () => {
  assert.equal(
    latestMigration(['drizzle/0009_old.sql', 'drizzle/0010_current.sql', 'README.md']),
    '0010_current.sql',
  );
});

test('parseTestResults normalizes CI outcomes and rejects untrusted input', () => {
  assert.deepEqual(
    parseTestResults(['quality-gate=success', 'business-flows=passed', 'audit=failure']),
    {
      'quality-gate': 'passed',
      'business-flows': 'passed',
      audit: 'failed',
    },
  );
  assert.throws(() => parseTestResults(['quality gate=success']), /Invalid test result/u);
  assert.throws(() => parseTestResults(['quality-gate=unknown']), /Invalid test result/u);
  assert.throws(
    () => parseTestResults(['quality-gate=failure', 'quality-gate=success']),
    /Duplicate test result/u,
  );
});
