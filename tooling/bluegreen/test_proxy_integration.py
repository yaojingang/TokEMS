"""Real crane + Docker import through local HTTP/SOCKS tunnels, with no external registry."""
import json
import os
import select
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from download import ImageSource, cache_tag, proxy_environment
from system import SAFE_ENV, run
from test_download import fingerprint, image_fixture

CRANE = os.environ.get('TOKEMS_BLUEGREEN_TEST_CRANE')
HOST = 'registry.tokems-proxy-test.invalid'


class ThreadedServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True


def receive(connection, length):
    result = b''
    while len(result) < length:
        chunk = connection.recv(length - len(result))
        if not chunk:
            raise IOError('Tunnel closed')
        result += chunk
    return result


@unittest.skipUnless(CRANE and sys.platform.startswith('linux'), 'explicit Linux crane binary and local Docker integration not requested')
class ProxyIntegrationTests(unittest.TestCase):
    def exercise(self, protocol):
        unique = str(uuid.uuid4())
        manifest, config, blob = image_fixture(unique)
        manifest_bytes = json.dumps(manifest).encode()
        image_id = fingerprint(config)
        reference = HOST + '/test/image@' + fingerprint(manifest_bytes)
        self.assertNotEqual(subprocess.run(['docker', 'image', 'inspect', image_id], stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL).returncode, 0, 'Never overwrite a pre-existing image')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'openssl.cnf').write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n'
                '[dn]\nCN=' + HOST + '\n[ext]\nsubjectAltName=DNS:' + HOST + '\nbasicConstraints=critical,CA:TRUE\n')
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
                            '-config', str(root / 'openssl.cnf'), '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem')],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            payloads = {'/v2/': (b'{}', 'application/json'),
                        '/v2/test/image/manifests/' + fingerprint(manifest_bytes): (manifest_bytes, manifest['mediaType']),
                        '/v2/test/image/blobs/' + image_id: (config, 'application/octet-stream'),
                        '/v2/test/image/blobs/' + fingerprint(blob): (blob, 'application/octet-stream')}
            class Registry(BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path not in payloads:
                        self.send_error(404)
                        return
                    data, content_type = payloads[self.path]
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('Docker-Content-Digest', fingerprint(data))
                    self.send_header('Docker-Distribution-API-Version', 'registry/2.0')
                    self.end_headers()
                    if self.command != 'HEAD':
                        self.wfile.write(data)
                do_HEAD = do_GET
                def log_message(self, *args):
                    pass
            registry = ThreadedServer(('127.0.0.1', 0), Registry)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(root / 'cert.pem'), str(root / 'key.pem'))
            registry.socket = context.wrap_socket(registry.socket, server_side=True)
            destinations = []
            class Tunnel(socketserver.BaseRequestHandler):
                def handle(self):
                    connection = self.request
                    connection.settimeout(10)
                    if protocol == 'http':
                        request = b''
                        while not request.endswith(b'\r\n\r\n') and len(request) < 8192:
                            request += receive(connection, 1)
                        destination = request.split(b'\r\n')[0].decode()
                        if destination != 'CONNECT ' + HOST + ':443 HTTP/1.1':
                            return
                        destinations.append(destination)
                        connection.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                    else:
                        greeting = receive(connection, 2)
                        receive(connection, greeting[1])
                        connection.sendall(b'\x05\x00')
                        header = receive(connection, 4)
                        if header != b'\x05\x01\x00\x03':
                            return  # DNS must happen at the proxy, not on the server.
                        host = receive(connection, receive(connection, 1)[0]).decode()
                        port = int.from_bytes(receive(connection, 2), 'big')
                        if (host, port) != (HOST, 443):
                            return
                        destinations.append(host)
                        connection.sendall(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00')
                    with socket.create_connection(registry.server_address, timeout=10) as upstream:
                        connection.settimeout(None)
                        upstream.settimeout(None)
                        while True:
                            readable, _, _ = select.select([connection, upstream], [], [], 10)
                            if not readable:
                                return
                            for source in readable:
                                data = source.recv(65536)
                                if not data:
                                    return
                                (upstream if source is connection else connection).sendall(data)
            class TunnelServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
                daemon_threads = True
            tunnel = TunnelServer(('127.0.0.1', 0), Tunnel)
            threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (registry, tunnel)]
            for thread in threads:
                thread.start()
            container = None
            try:
                source = object.__new__(ImageSource)
                source.proxy = protocol + '://127.0.0.1:' + str(tunnel.server_address[1])
                source.env = proxy_environment(source.proxy)
                source.env.update(SSL_CERT_FILE=str(root / 'cert.pem'), DOCKER_CONFIG=str(root))
                source.crane = CRANE
                def diagnostic_run(args, **kwargs):
                    # This fixture has no credentials; show test-registry errors, never production output.
                    result = subprocess.run([str(arg) for arg in args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            env=dict(SAFE_ENV, **kwargs.get('env', {})), timeout=kwargs.get('timeout', 30))
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    if args[:2] == ['docker', 'load']:
                        self.assertIn('Loaded image', result.stdout.decode(), result.stdout.decode() + result.stderr.decode())
                    return result.stdout if kwargs.get('binary') else result.stdout.decode().strip()
                with patch('download.run', side_effect=diagnostic_run):
                    self.assertEqual(source.digest(reference), fingerprint(manifest_bytes))
                    self.assertEqual(source.labels(reference)['com.tokems.proxy-test'], unique)
                    result = source.pull(reference, 'linux/amd64', root, 'test')
                self.assertRegex(result, '^sha256:[a-f0-9]{64}$')
                self.assertGreaterEqual(len(destinations), 3, 'Manifest, config and layer must use the tunnel')
                metadata = json.loads(run(['docker', 'image', 'inspect', '--format', '{{json .}}', result]))
                self.assertEqual(metadata['Config']['Labels']['com.tokems.proxy-test'], unique)
                self.assertEqual(metadata['RootFS']['Layers'], json.loads(config.decode())['rootfs']['diff_ids'])
                self.assertEqual(metadata.get('RepoTags'), [cache_tag(image_id)])
                self.assertFalse(list(root.glob('*download.tar*')))
                container = run(['docker', 'create', '--label', 'com.tokems.proxy-test=' + unique, result, '/not-executed'])
                self.assertEqual(run(['docker', 'inspect', '--format', '{{.Image}}', container]), result)
            finally:
                if container:
                    run(['docker', 'rm', container])
                owned = run(['docker', 'image', 'ls', '--quiet', '--no-trunc', '--filter', 'reference=' + cache_tag(image_id)])
                if owned:
                    metadata = json.loads(run(['docker', 'image', 'inspect', '--format', '{{json .}}', owned]))
                    if metadata['Config']['Labels'].get('com.tokems.proxy-test') == unique:
                        run(['docker', 'image', 'rm', cache_tag(image_id)])
                for server in (tunnel, registry):
                    server.shutdown()
                    server.server_close()
                for thread in threads:
                    thread.join(2)

    def test_real_http_proxy_download_and_local_import(self):
        self.exercise('http')

    def test_real_socks5_proxy_remote_dns_and_local_import(self):
        self.exercise('socks5h')


if __name__ == '__main__':
    unittest.main()
