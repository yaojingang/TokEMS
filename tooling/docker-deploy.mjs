import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertBuildSourceState } from './lib/build-version.mjs';
import {
  localComposeEnvironment,
  localComposeEnvironmentPath,
} from './lib/local-compose-environment.mjs';

const buildOnly = process.argv.includes('--build-only');
const buildServices = ['notification-sink', 'api', 'worker', 'web', 'admin', 'gateway'];
const migration = readdirSync(resolve('packages/database/drizzle'))
  .filter((file) => /^\d{4}_[A-Za-z0-9_-]+\.sql$/u.test(file))
  .sort()
  .at(-1);
const migrationHash = migration
  ? createHash('sha256')
      .update(readFileSync(resolve('packages/database/drizzle', migration)))
      .digest('hex')
  : 'unknown';
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const gitSha = git('rev-parse', 'HEAD');
function assertSourceUnchanged() {
  return assertBuildSourceState({
    expectedSha: gitSha,
    actualSha: git('rev-parse', 'HEAD'),
    status: git('status', '--porcelain', '--untracked-files=all'),
  });
}

assertSourceUnchanged();
const environment = {
  ...localComposeEnvironment(),
  COMPOSE_PARALLEL_LIMIT: '1',
  BUILD_SHA: gitSha,
  BUILD_TIME: process.env.BUILD_TIME ?? new Date().toISOString(),
  BUILD_MIGRATION: migration ?? 'unknown',
  BUILD_MIGRATION_HASH: migrationHash,
};

function run(command, args) {
  console.info(`\n> ${command} ${args.join(' ')}`);
  execFileSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  });
}

for (const service of buildServices) {
  run('docker', ['compose', 'build', service]);
}
assertSourceUnchanged();

if (!buildOnly) {
  run('docker', ['compose', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '300']);
  run(process.execPath, ['tooling/docker-smoke.mjs']);
  if (environment.DEPLOYMENT_MODE === 'production') {
    console.info('TokEMS production Docker deployment verified');
  } else {
    console.info(`本地运行配置保存在 ${localComposeEnvironmentPath}`);
  }
}
