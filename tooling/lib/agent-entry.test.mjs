import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = readFileSync(new URL('../../docker/agent-entry.nginx.conf', import.meta.url), 'utf8');
const locations = [...config.matchAll(/location\s+(=|\^~)\s+(\S+)\s*\{([^}]+)\}/gu)].map(([, mode, path, body]) => ({ mode, path, body }));
function selected(path) {
  return locations.find((entry) => entry.mode === '=' && entry.path === path) ??
    locations.filter((entry) => entry.mode === '^~' && path.startsWith(entry.path)).sort((a, b) => b.path.length - a.path.length)[0];
}

test('Agent discovery wins over panel-managed well-known and catch-all prefixes', () => {
  for (const path of ['/.well-known/tokems-agent', '/.well-known/oauth-authorization-server']) {
    const entry = selected(path);
    assert.equal(entry?.mode, '=');
    assert.match(entry.body, /proxy_pass http:\/\/127\.0\.0\.1:8088;/u);
  }
  assert.equal(selected('/.well-known/acme-challenge/certificate'), undefined);
});

test('preview credentials stay out of logs even with a panel catch-all ^~ location', () => {
  for (const base of ['/api/v1/template-previews', '/api/v1/previews', '/template-previews', '/previews']) {
    for (const path of [base, `${base}/events/101`]) {
      const entry = selected(path);
      assert.ok(entry);
      assert.match(entry.body, /access_log off;/u);
      assert.match(entry.body, /error_log \/dev\/null crit;/u);
      assert.match(entry.body, /proxy_set_header Referer "";/u);
    }
    assert.equal(selected(`${base}-other`), undefined);
  }
});
