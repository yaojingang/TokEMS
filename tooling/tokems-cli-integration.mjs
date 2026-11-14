import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const containers = [];
let storageConfigDirectory;
const prefix = `tokems-cli-test-${randomUUID().slice(0, 8)}`;
const run = async (command, args, env = process.env) => {
  const result = await exec(command, args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024 });
  if (command === 'pnpm') process.stdout.write(result.stdout);
  return result.stdout.trim();
};
const docker = (args) => run('docker', args);
async function start(suffix, args) {
  const id = await docker([
    'run',
    '-d',
    '--name',
    `${prefix}-${suffix}`,
    '--label',
    'tokems.cli-test=true',
    ...args,
  ]);
  containers.push(id);
  return id;
}
async function port(id, containerPort) {
  const binding = await docker(['port', id, `${containerPort}/tcp`]);
  if (!/^127\.0\.0\.1:\d+$/u.test(binding)) throw new Error('Test services must bind to loopback');
  return Number(binding.split(':')[1]);
}
async function ready(check) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if (await check()) return;
    } catch {
      /* The disposable service is starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Disposable CLI test service did not become ready');
}

try {
  await run('pnpm', ['db:prepare']);
  await run('pnpm', ['--filter', '@conference/html-template', 'build']);
  const postgres = await start('postgres', [
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=tokems_cli',
    '--tmpfs',
    '/var/lib/postgresql/data',
    'pgvector/pgvector:pg16',
  ]);
  const redis = await start('redis', ['-p', '127.0.0.1::6379', 'redis:7.4-alpine']);
  storageConfigDirectory = await mkdtemp(join(tmpdir(), 'tokems-cli-storage-'));
  const storageConfig = join(storageConfigDirectory, 's3.json');
  await writeFile(storageConfig, JSON.stringify({ identities: [{
    name: 'cli-test',
    credentials: [{ accessKey: 'cli-test-access', secretKey: 'cli-test-storage-secret' }],
    actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
  }] }), { mode: 0o644 });
  // Use the same anonymously available, digest-pinned S3 fixture as the CI workflow.
  const storage = await start('storage', [
    '-p',
    '127.0.0.1::9000',
    '--tmpfs',
    '/data',
    '--volume',
    `${storageConfig}:/etc/seaweedfs/s3.json:ro`,
    'chrislusf/seaweedfs:4.30@sha256:20fb6eabf1468d3e53fb7b8bd05d929f8b01ae8ceccc2668b501176b2366940f',
    'server',
    '-s3',
    '-s3.port=9000',
    '-s3.config=/etc/seaweedfs/s3.json',
    '-dir=/data',
  ]);
  const pgPort = await port(postgres, 5432);
  const redisPort = await port(redis, 6379);
  const s3Port = await port(storage, 9000);
  await ready(async () =>
    (await docker(['exec', postgres, 'pg_isready', '-U', 'postgres'])).includes(
      'accepting connections',
    ),
  );
  await ready(async () => (await fetch(`http://127.0.0.1:${s3Port}/`)).status === 403);
  await ready(async () => (await docker([
    'exec', storage, 'sh', '-c',
    "printf 's3.bucket.create -name cli-test-assets\\n' | weed shell",
  ])).includes('created bucket cli-test-assets'));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'local',
    SEED_DEMO_DATA: 'true',
    DATABASE_URL: `postgresql://postgres@127.0.0.1:${pgPort}/tokems_cli`,
    TOKEMS_AGENT_TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${pgPort}/tokems_cli`,
    TOKEMS_AGENT_TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    ADMIN_USERNAME: 'cli-test-admin',
    ADMIN_PASSWORD: 'cli-test-password',
    ADMIN_EMAIL: 'cli-test-admin@tokems.local',
    S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    S3_PUBLIC_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    S3_ACCESS_KEY: 'cli-test-access',
    S3_SECRET_KEY: 'cli-test-storage-secret',
    S3_BUCKET: 'cli-test-assets',
    S3_REGION: 'us-east-1',
  };
  await run('pnpm', ['db:migrate'], env);
  await run('pnpm', ['db:seed'], env);
  await run(
    'pnpm',
    [
      '--filter',
      '@conference/api',
      'exec',
      'vitest',
      'run',
      'src/common/agent-cli.integration.test.ts',
      'src/common/idempotency.service.integration.test.ts',
    ],
    env,
  );
} catch (error) {
  process.stderr.write(`${error.stderr || error.message}\n`);
  process.exitCode = 1;
} finally {
  for (const id of containers.reverse()) {
    try {
      await docker(['rm', '-f', id]);
    } catch {
      process.stderr.write(`Remove disposable CLI test container ${id} manually.\n`);
      process.exitCode = 1;
    }
  }
  if (storageConfigDirectory) await rm(storageConfigDirectory, { recursive: true, force: true });
}
