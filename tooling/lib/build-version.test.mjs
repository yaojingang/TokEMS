import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBuildSourceState, assertBuildsConsistent } from './build-version.mjs';

const build = {
  sha: 'abcdef1234567890',
  builtAt: '2026-08-01T01:02:03.000Z',
  migration: '0024_latest.sql',
  migrationHash: 'a'.repeat(64),
};

test('build version gate accepts service-specific records with one release identity', () => {
  assert.doesNotThrow(() =>
    assertBuildsConsistent({
      api: { service: 'api', ...build },
      worker: { service: 'worker', ...build },
      web: { service: 'web', ...build },
      admin: { service: 'admin', ...build },
      gateway: { service: 'gateway', ...build },
    }),
  );
});

test('build version gate rejects unknown and mixed service versions', () => {
  assert.throws(
    () =>
      assertBuildsConsistent({
        api: { service: 'api', ...build },
        web: { service: 'web', ...build, sha: 'unknown' },
      }),
    /unknown build metadata/u,
  );
  assert.throws(
    () =>
      assertBuildsConsistent({
        api: { service: 'api', ...build },
        web: { service: 'web', ...build, migration: '0023_previous.sql' },
      }),
    /mixed build metadata/u,
  );
});

test('build source gate rejects dirty or moving worktrees', () => {
  assert.doesNotThrow(() =>
    assertBuildSourceState({
      expectedSha: 'abcdef1234567890',
      actualSha: 'abcdef1234567890',
      status: '',
    }),
  );
  assert.throws(
    () =>
      assertBuildSourceState({
        expectedSha: 'abcdef1234567890',
        actualSha: 'abcdef1234567890',
        status: ' M apps/api/src/main.ts',
      }),
    /clean Git worktree/u,
  );
  assert.throws(
    () =>
      assertBuildSourceState({
        expectedSha: 'abcdef1234567890',
        actualSha: '1234567abcdef890',
        status: '',
      }),
    /changed during the build/u,
  );
});
