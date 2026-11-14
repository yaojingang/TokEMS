import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const gatewayConfig = readFileSync(
  new URL('../../docker/gateway.nginx.conf', import.meta.url),
  'utf8',
);
const objectStorageInclude = readFileSync(
  new URL('../../docker/gateway-object-storage.include', import.meta.url),
  'utf8',
);

test('gateway resolves compose services dynamically after container address changes', () => {
  assert.match(gatewayConfig, /resolver\s+127\.0\.0\.11\b[^;]*;/u);

  const services = [
    ['api', '4100', 'api_backend'],
    ['web', '3000', 'web_backend'],
    ['payment-web', '3000', 'payment_web_backend'],
    ['admin', '8080', 'admin_backend'],
    ['minio', '9000', 'minio_backend'],
  ];

  for (const [service, port, upstream] of services) {
    assert.match(
      gatewayConfig,
      new RegExp(
        `upstream\\s+${upstream}\\s*\\{[\\s\\S]*?server\\s+${service}:${port}\\s+resolve;[\\s\\S]*?\\}`,
        'u',
      ),
    );
    assert.doesNotMatch(gatewayConfig, new RegExp(`proxy_pass\\s+http://${service}:${port}`, 'u'));
  }
});

test('all preview proxy locations protect exact and nested capability paths from logs', () => {
  const external = readFileSync(
    new URL('../../docker/external-entry.nginx.conf.example', import.meta.url),
    'utf8',
  );
  for (const config of [gatewayConfig, external]) {
    const locations = [...config.matchAll(/location\s+~\s+(\S*previews\S*)\s*\{([^}]+)\}/gu)];
    assert.ok(locations.length > 0);
    for (const [, pattern, block] of locations) {
      const regex = new RegExp(pattern);
      const prefix = pattern.includes('api/v1') ? '/api/v1' : '';
      for (const path of [`${prefix}/template-previews`, `${prefix}/previews/events/101`]) {
        assert.ok(regex.test(path), `${pattern} must protect ${path}`);
      }
      assert.equal(regex.test(`${prefix}/template-previews-other`), false);
      assert.match(block, /access_log\s+off;/u);
      assert.match(block, /error_log\s+\/dev\/null\s+crit;/u);
    }
  }
});

test('gateway proxies path-style object storage with the browser Host', () => {
  assert.equal(
    gatewayConfig.match(/include\s+\/etc\/nginx\/tokems-object-storage\.include;/gu)?.length,
    2,
  );
  assert.match(objectStorageInclude, /location\s+\^~\s+\/conference-assets\//u);
  assert.match(objectStorageInclude, /proxy_pass\s+http:\/\/minio_backend;/u);
  assert.match(objectStorageInclude, /proxy_set_header\s+Host\s+\$http_host;/u);
  assert.match(objectStorageInclude, /Access-Control-Allow-Origin\s+\*/u);
  assert.match(objectStorageInclude, /if\s+\(\$request_method\s+=\s+OPTIONS\)/u);
});
