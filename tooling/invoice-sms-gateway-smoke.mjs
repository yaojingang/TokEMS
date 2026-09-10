import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

test(
  'real gateway keeps invoice response private and rejects the payment alias without logging credentials',
  { skip: process.env.INVOICE_SMS_GATEWAY_TEST !== '1', timeout: 60000 },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), 'tokems-invoice-gateway-'));
    const name = `tokems-invoice-gateway-${process.pid}`;
    const requests = [];
    const backend = createServer((request, response) => {
      requests.push({ url: request.url, referer: request.headers.referer });
      response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'private, no-store',
      });
      response.end('%PDF-test');
    });
    backend.listen(0, '0.0.0.0');
    await once(backend, 'listening');
    const port = backend.address().port;
    const original = await readFile(
      new URL('../docker/gateway.nginx.conf', import.meta.url),
      'utf8',
    );
    const config = original.replace(
      /server (?:api:4100|web:3000|payment-web:3000|admin:8080) resolve;/g,
      `server host.docker.internal:${port};`,
    );
    await writeFile(join(temp, 'default.conf'), config);
    let started = false;
    try {
      execFileSync(
        'docker',
        [
          'run',
          '--detach',
          '--name',
          name,
          '--add-host',
          'host.docker.internal:host-gateway',
          '-p',
          '127.0.0.1::8080',
          '-v',
          `${temp}/default.conf:/etc/nginx/conf.d/default.conf:ro`,
          'nginx:1.31.1-alpine',
        ],
        { stdio: 'pipe' },
      );
      started = true;
      const published = execFileSync('docker', ['port', name, '8080'], { encoding: 'utf8' }).trim();
      const base = `http://${published}`;
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          if ((await fetch(`${base}/healthz`)).ok) {
            ready = true;
            break;
          }
        } catch {
          /* Container may still be starting. */
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(ready, true);
      const token = 'A12345678901234567890123';
      for (const host of ['public.test', 'admin.public.test'])
        for (const path of ['/invoice/file/', '/api/v1/invoice-files/']) {
          const result = await fetch(`${base}${path}${token}`, {
            headers: { host, referer: `https://public.test/invoice/file/${token}` },
          });
          assert.equal(result.status, 200);
          assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
          assert.match(result.headers.get('cache-control'), /no-store/);
          assert.equal(await result.text(), '%PDF-test');
        }
      assert.equal(requests.length, 4);
      assert.ok(
        requests.every(
          (request) => request.url === `/api/v1/invoice-files/${token}` && !request.referer,
        ),
      );
      const alias = await fetch(`${base}/pay/hui/api/v1/invoice-files/${token}`);
      assert.equal(alias.status, 404);
      assert.equal(requests.length, 4);
      const logs = execFileSync('docker', ['logs', name], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.ok(!logs.includes(token));
    } finally {
      if (started) execFileSync('docker', ['rm', '--force', name], { stdio: 'pipe' });
      await new Promise((resolve) => backend.close(resolve));
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  'standalone payment entry rejects invoice aliases before proxying or recording the token',
  { skip: process.env.INVOICE_SMS_GATEWAY_TEST !== '1', timeout: 60000 },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), 'tokems-invoice-payment-entry-'));
    const name = `tokems-invoice-payment-entry-${process.pid}`;
    const requests = [];
    const backend = createServer((request, response) => {
      requests.push({ url: request.url, referer: request.headers.referer });
      response.writeHead(request.url.includes('/invoice-files/') ? 404 : 200);
      response.end('gateway');
    });
    backend.listen(0, '0.0.0.0');
    await once(backend, 'listening');
    const original = await readFile(
      new URL('../docker/payment-entry.nginx.conf.example', import.meta.url),
      'utf8',
    );
    // Run the documented locations unchanged; isolate the listener and upstream for this test.
    const config = original
      .replace('server 127.0.0.1:8088;', `server host.docker.internal:${backend.address().port};`)
      .replace('listen 443 ssl http2;', 'listen 8080;')
      .replace('listen [::]:443 ssl http2;', 'listen [::]:8080;')
      .replace(/^\s*ssl_certificate(?:_key)?\s+[^;]+;/gm, '');
    await writeFile(join(temp, 'default.conf'), config);
    let started = false;
    try {
      execFileSync(
        'docker',
        [
          'run',
          '--detach',
          '--name',
          name,
          '--add-host',
          'host.docker.internal:host-gateway',
          '-p',
          '127.0.0.1::8080',
          '-v',
          `${temp}/default.conf:/etc/nginx/conf.d/default.conf:ro`,
          'nginx:1.31.1-alpine',
        ],
        { stdio: 'pipe' },
      );
      started = true;
      const published = execFileSync('docker', ['port', name, '8080'], { encoding: 'utf8' }).trim();
      const base = `http://${published}`;
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const result = await fetch(`${base}/`);
          await result.text();
          if (result.status === 404) {
            ready = true;
            break;
          }
        } catch {
          /* Container may still be starting. */
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(ready, true);
      const token = 'B12345678901234567890123';
      const alias = await fetch(`${base}/pay/hui/api/v1/invoice-files/${token}`, {
        headers: { referer: `https://public.test/invoice/file/${token}` },
      });
      await alias.text();
      const logs = execFileSync('docker', ['logs', name], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.ok(!logs.includes(token), 'payment entry access log must exclude invoice credentials');
      assert.equal(alias.status, 404);
      assert.equal(alias.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(requests.length, 0, 'invoice alias must be rejected at the outer entry');
      const payment = await fetch(`${base}/pay/hui/`, {
        headers: { referer: 'https://payment.test/pay/hui/' },
      });
      assert.equal(payment.status, 200);
      await payment.text();
      assert.deepEqual(requests, [{ url: '/pay/hui/', referer: 'https://payment.test/pay/hui/' }]);
    } finally {
      if (started) execFileSync('docker', ['rm', '--force', name], { stdio: 'pipe' });
      await new Promise((resolve) => backend.close(resolve));
      await rm(temp, { recursive: true, force: true });
    }
  },
);
