"""Opt-in real Nginx regression for bearer-token privacy on upstream failures."""
import json
import os
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from proxy import route


IMAGE = os.environ.get('TOKEMS_BLUEGREEN_TEST_GATEWAY_IMAGE')


@unittest.skipUnless(IMAGE, 'set TOKEMS_BLUEGREEN_TEST_GATEWAY_IMAGE to an existing local Nginx Gateway image')
class GatewayPrivacyIntegrationTests(unittest.TestCase):
    def docker(self, *arguments, **options):
        result = subprocess.run(['docker'] + list(arguments), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30, **options)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        return result

    def test_invoice_upstream_errors_hide_tokens_without_disabling_ordinary_errors(self):
        # No pulls, published ports, shared networks, existing containers or services.
        image = json.loads(self.docker('image', 'inspect', IMAGE).stdout)[0]
        self.assertEqual(image['Os'], 'linux')
        identifier = None
        token_suffix = uuid.uuid4().hex
        paths = [
            '/invoice/file/PrivacyInvoice' + token_suffix,
            '/api/v1/invoice-files/PrivacyApi' + token_suffix,
            '/pay/hui/api/v1/invoice-files/PrivacyPayment' + token_suffix,
        ]
        ordinary = '/ordinary-upstream-error-' + token_suffix
        config = route(18088, 'privacy-test-upstream')
        # Preserve the generated location rules exactly. Only replace the upstream
        # endpoint with a closed loopback port so failures are immediate and local.
        original = 'server privacy-test-upstream:8080 resolve;'
        self.assertEqual(config.count(original), 1)
        config = config.replace(original, 'server 127.0.0.1:9;')
        with tempfile.TemporaryDirectory(prefix='tokems-gateway-privacy-') as temporary:
            path = Path(temporary) / 'nginx.conf'
            path.write_text(config)
            try:
                identifier = self.docker(
                    'create', '--pull', 'never', '--name', 'tokems-gateway-privacy-' + token_suffix,
                    '--label', 'com.tokems.test.gateway-privacy=' + token_suffix,
                    '--network', 'none', '--memory', '128m', '--cpus', '0.5',
                    '--security-opt', 'no-new-privileges:true', '--entrypoint', 'nginx',
                    image['Id'], '-c', '/etc/tokems-privacy-test.conf', '-g', 'daemon off;',
                ).stdout.decode().strip()
                # Copy into only the newly created disposable container; no host bind mounts.
                self.docker('cp', str(path), identifier + ':/etc/tokems-privacy-test.conf')
                self.docker('start', identifier)
                deadline = time.monotonic() + 15
                while True:
                    healthy = subprocess.run(
                        ['docker', 'exec', identifier, 'wget', '-qO-', 'http://127.0.0.1:8080/healthz'],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
                    )
                    if healthy.returncode == 0:
                        break
                    self.assertLess(time.monotonic(), deadline, 'Isolated Nginx did not become healthy')
                    time.sleep(0.1)

                headers = {}
                for request_path in [ordinary] + paths:
                    # BusyBox wget hides response headers after a non-2xx status.
                    # Keep netcat stdin open briefly: BusyBox otherwise exits at EOF
                    # before reading the response. Traffic remains inside this container.
                    response = self.docker(
                        'exec', '-i', identifier, 'sh', '-c',
                        '{ cat; sleep 1; } | busybox nc -w 5 127.0.0.1 8080',
                        input=('GET ' + request_path + ' HTTP/1.1\r\nHost: hui.ailingdaoli.com\r\n'
                               'Connection: close\r\n\r\n').encode(),
                    )
                    headers[request_path] = response.stdout.split(b'\r\n\r\n', 1)[0].lower()
                    self.assertIn(b'http/1.1 502 bad gateway', headers[request_path])

                # Docker separates non-TTY container stdout and stderr. A control URI
                # must appear in stderr, proving upstream errors really were emitted.
                logs = self.docker('logs', identifier)
                self.assertIn(ordinary, logs.stderr.decode(errors='replace'))
                combined = (logs.stdout + logs.stderr).decode(errors='replace')
                for request_path in paths:
                    self.assertNotIn(request_path.rsplit('/', 1)[-1], combined)
                    self.assertIn(b'referrer-policy: no-referrer', headers[request_path])
            finally:
                if identifier:
                    # This ID was returned by this test's create; never select by project/tag.
                    self.docker('rm', '--force', identifier)


if __name__ == '__main__':
    unittest.main()
