import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const migrationPattern = /(?:^|\/)\d{4}_[A-Za-z0-9_-]+\.sql$/u;
const testNamePattern = /^[a-z0-9][a-z0-9-]*$/u;
const testOutcomeMap = new Map([
  ['success', 'passed'],
  ['passed', 'passed'],
  ['failure', 'failed'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['skipped', 'skipped'],
]);

export function parseTestResults(entries) {
  const results = {};
  for (const entry of entries) {
    const separator = entry.lastIndexOf('=');
    const name = entry.slice(0, separator);
    const outcome = entry.slice(separator + 1);
    const status = testOutcomeMap.get(outcome);
    if (separator <= 0 || !testNamePattern.test(name) || !status) {
      throw new Error(`Invalid test result: ${entry}`);
    }
    if (Object.hasOwn(results, name)) throw new Error(`Duplicate test result: ${name}`);
    results[name] = status;
  }
  return results;
}

export function latestMigration(files) {
  const migrations = files.filter((file) => migrationPattern.test(file)).sort();
  return migrations.length > 0 ? basename(migrations.at(-1)) : 'unknown';
}

async function hashSourceFile(root, path) {
  const contents = await readFile(resolve(root, path));
  return {
    path,
    bytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

export async function buildReleaseManifest({
  root,
  files,
  git,
  builtAt,
  imageDigests = {},
  openApi = {},
  environment = {},
  testResults = {},
}) {
  const sortedFiles = [...new Set(files)].sort();
  const sourceFiles = await Promise.all(sortedFiles.map((path) => hashSourceFile(root, path)));
  const migration = latestMigration(sortedFiles);
  const migrationHash =
    sourceFiles.find((file) => basename(file.path) === migration)?.sha256 ?? 'unknown';
  return {
    schemaVersion: 1,
    build: {
      sha: git.sha,
      branch: git.branch,
      dirty: git.dirty,
      builtAt,
      migration,
      migrationHash,
    },
    source: {
      algorithm: 'sha256',
      fileCount: sourceFiles.length,
      files: sourceFiles,
    },
    openApi,
    images: imageDigests,
    environment,
    tests: testResults,
  };
}
