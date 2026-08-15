import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const service = argument('--service');
const output = argument('--output');
if (!service || !/^[a-z0-9-]+$/u.test(service) || !output) {
  throw new Error('Usage: node tooling/write-build-info.mjs --service <name> --output <path>');
}

const shaCandidate = process.env.BUILD_SHA?.trim().toLowerCase() ?? '';
const builtAtCandidate = process.env.BUILD_TIME?.trim() ?? '';
const migrationCandidate = process.env.BUILD_MIGRATION?.trim() ?? '';
const migrationHashCandidate = process.env.BUILD_MIGRATION_HASH?.trim().toLowerCase() ?? '';
const document = {
  service,
  sha: /^[a-f0-9]{7,64}$/u.test(shaCandidate) ? shaCandidate : 'unknown',
  builtAt: !Number.isNaN(Date.parse(builtAtCandidate)) ? builtAtCandidate : 'unknown',
  migration: /^\d{4}_[A-Za-z0-9_-]+\.sql$/u.test(migrationCandidate)
    ? migrationCandidate
    : 'unknown',
  migrationHash: /^[a-f0-9]{64}$/u.test(migrationHashCandidate)
    ? migrationHashCandidate
    : 'unknown',
};
const target = resolve(output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
