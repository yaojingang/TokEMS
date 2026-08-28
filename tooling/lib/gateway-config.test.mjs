import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const gatewayConfig = readFileSync(
  new URL('../../docker/gateway.nginx.conf', import.meta.url),
  'utf8',
);

test('gateway resolves compose services dynamically after container address changes', () => {
  assert.match(gatewayConfig, /resolver\s+127\.0\.0\.11\b[^;]*;/u);

  const services = [
    ['api', '4100', 'api_backend'],
    ['web', '3000', 'web_backend'],
    ['payment-web', '3000', 'payment_web_backend'],
    ['admin', '8080', 'admin_backend'],
  ];

  for (const [service, port, upstream] of services) {
    assert.match(
      gatewayConfig,
      new RegExp(
        `upstream\\s+${upstream}\\s*\\{[\\s\\S]*?server\\s+${service}:${port}\\s+resolve;[\\s\\S]*?\\}`,
        'u',
      ),
    );
    assert.doesNotMatch(
      gatewayConfig,
      new RegExp(`proxy_pass\\s+http://${service}:${port}`, 'u'),
    );
  }
});
