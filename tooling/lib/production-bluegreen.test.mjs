import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('bluegreen CLI help and Python deployment fault tests', () => {
  const help = spawnSync('bash', ['tooling/production-bluegreen.sh', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  for (const command of ['deploy', 'resume', 'rollback', 'status']) assert.ok(help.stdout.includes(command));
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tooling/bluegreen', '-p', 'test_*.py'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/u);
});

test('all service mutations are behind the locally verified artifact barrier', () => {
  const runtime = readFileSync(new URL('../bluegreen/runtime.py', import.meta.url), 'utf8');
  assert.ok(runtime.includes("'--no-build', '--pull', 'never'"));
  assert.doesNotMatch(runtime, /\['docker', '(?:pull|build)'/u);
  assert.doesNotMatch(runtime, /SEED_DEMO_DATA='true'|default_transaction_read_only\s*=\s*on/u);
});


test('bluegreen route switching is confined to the Docker Gateway', () => {
  const proxy = readFileSync(new URL('../bluegreen/proxy.py', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../bluegreen/runtime.py', import.meta.url), 'utf8');
  assert.doesNotMatch(proxy + runtime, /upstreamFile|config\['nginx'\]|\/www\/server\/nginx|nginx_workers/u);
  assert.match(proxy, /'docker', 'exec', entry\['Id'\], 'nginx', '-s', 'reload'/u);
  assert.match(proxy, /127\.0\.0\.1:8088:8080/u);
});
