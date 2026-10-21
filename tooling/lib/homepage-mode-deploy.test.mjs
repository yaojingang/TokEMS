import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync('tooling/production-deploy.sh', 'utf8');
const program = source.match(
  /verify_root_homepage_document\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/u,
)?.[1];
assert.ok(program);
const empty =
  '<!doctype html><html data-tokems-homepage="empty"><head><meta charset="utf-8"></head><body></body></html>';
const emptyHeaders =
  "HTTP/1.1 200 OK\nCache-Control: no-store\nX-Robots-Tag: noindex, nofollow\nContent-Security-Policy: default-src 'none'\n";

function verify({
  mode = 'empty',
  document = empty,
  headers = emptyHeaders,
  surface = 'local',
  owner,
  rootOwner = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tokems-root-verifier-'));
  const snapshot = join(directory, 'snapshot.json');
  const html = join(directory, 'root.html');
  const head = join(directory, 'headers.txt');
  const record = join(directory, 'owner.json');
  writeFileSync(
    snapshot,
    JSON.stringify({ organization: { settings: mode === null ? {} : { homepage: { mode } } } }),
  );
  writeFileSync(html, document);
  writeFileSync(head, headers);
  if (owner) writeFileSync(record, JSON.stringify(owner), { mode: 0o600 });
  const prefix = rootOwner
    ? 'import os, types\n_original_stat = os.stat\ndef _root_stat(path, *args, **kwargs):\n    result = _original_stat(path, *args, **kwargs)\n    if str(path).endswith("owner.json"):\n        return types.SimpleNamespace(st_uid=0, st_mode=result.st_mode)\n    return result\nos.stat = _root_stat\n'
    : '';
  return spawnSync(
    'python3',
    ['-', snapshot, html, head, surface, record, 'https://conference.example'],
    { input: prefix + program, encoding: 'utf8' },
  );
}

test('accepts an isolated blank root and a rendered conference root', () => {
  assert.equal(verify().status, 0);
  assert.equal(
    verify({ mode: 'event', document: '<html><body><h1>大会</h1></body></html>' }).status,
    0,
  );
  assert.equal(
    verify({ mode: null, document: '<html><body>Legacy conference</body></html>' }).status,
    0,
  );
});
test('rejects application content, scripts, missing policies, and a blank conference root', () => {
  for (const document of [
    empty.replace('<body>', '<body><p>Unexpected content</p>'),
    empty.replace('</head>', '<script>alert(1)</script></head>'),
  ]) {
    assert.notEqual(verify({ document }).status, 0);
  }
  assert.notEqual(verify({ headers: 'HTTP/1.1 200 OK\n' }).status, 0);
  assert.notEqual(verify({ mode: 'event' }).status, 0);
});
test('allows an external public root only with its matching acceptance record', () => {
  const document = '<html><body><h1>Brand home</h1></body></html>';
  const owner = { url: 'https://conference.example/', requiredText: 'Brand home' };
  assert.notEqual(verify({ document, surface: 'public' }).status, 0);
  assert.equal(verify({ document, surface: 'public', owner, rootOwner: true }).status, 0);
  assert.notEqual(
    verify({
      document,
      surface: 'public',
      owner: { ...owner, requiredText: 'Another site' },
      rootOwner: true,
    }).status,
    0,
  );
  assert.notEqual(verify({ document, surface: 'local', owner, rootOwner: true }).status, 0);
});

test('compares the public independent conference with the locally verified page', () => {
  const verifier = source.match(
    /verify_conference_home_document\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/u,
  )?.[1];
  assert.ok(verifier, 'Independent conference content must be verified');
  const directory = mkdtempSync(join(tmpdir(), 'tokems-conference-verifier-'));
  const local = join(directory, 'local.html');
  const publicPage = join(directory, 'public.html');
  writeFileSync(
    local,
    '<html><body><h1>大会 2026</h1><p>议程与报名</p><script>runtimeOne()</script></body></html>',
  );
  const run = (document) => {
    writeFileSync(publicPage, document);
    return spawnSync('python3', ['-', local, publicPage], { input: verifier, encoding: 'utf8' });
  };
  assert.equal(
    run(
      '<html><body><h1>大会 2026</h1> <p>议程与报名</p><script>runtimeTwo()</script></body></html>',
    ).status,
    0,
  );
  assert.notEqual(run('<html><body><h1>另一个网站</h1></body></html>').status, 0);
  assert.notEqual(run('<html><body></body></html>').status, 0);
});
