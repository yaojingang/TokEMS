"""Exercise the standalone old entrypoint, without invoking a production controller."""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from test_download import fingerprint, image_fixture, make_archive

SOURCE = (Path(__file__).resolve().parents[1] / 'production-deploy.sh').read_text()
legacy = types.ModuleType('legacy_proxy_download')
embedded = SOURCE.split("<<'LEGACY_PROXY_DOWNLOAD'\n", 1)[1].split('\nLEGACY_PROXY_DOWNLOAD', 1)[0]
exec(compile(embedded, 'production-deploy.sh:LEGACY_PROXY_DOWNLOAD', 'exec'), legacy.__dict__)


def shell_function(name):
    return re.search(r'^' + name + r'\(\) \{\n.*?^\}', SOURCE, re.M | re.S).group(0)


def shell(body, arguments=(), environment=None):
    functions = '\n'.join(shell_function(name) for name in (
        'parse_arguments', 'configure_download_proxy', 'download_network',
        'pin_local_runtime_controls', 'registry_local_image', 'registry_docker'))
    return subprocess.run(['bash', '-c', 'set -euo pipefail\n' + functions + '\n'
        'die() { printf "%s\\n" "$*" >&2; exit 1; }\n'
        'mode=; canonical_mode=auto; build_on_host=false; download_proxy=; requested_target_sha=; resume_recovery=false\n'
        'download_proxy_env=(HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= http_proxy= https_proxy= all_proxy= "NO_PROXY=*" "no_proxy=*")\n'
        'SAFE_PATH="$PATH"; LOCAL_DOCKER_HOST=unix:///var/run/docker.sock\n' + body, 'test'] + list(arguments),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, **(environment or {})))


@unittest.skipUnless(shutil.which('bash'), 'Bash is tested by the Linux proxy integration job')
class LegacyShellTests(unittest.TestCase):
    def test_proxy_options_reject_non_loopback_credentials_and_incompatible_modes(self):
        for url, expected in [('http://127.0.0.1:1080/', 'http://127.0.0.1:1080'),
                              ('socks5://localhost:1080', 'socks5h://localhost:1080'),
                              ('https://[::1]:1080', 'https://[::1]:1080')]:
            result = shell('parse_arguments "$@"; printf "%s" "$download_proxy"', ['deploy', '--proxy', url])
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(result.stdout.decode(), expected)
        for arguments in [('deploy', '--proxy'), ('deploy', '--proxy', 'http://remote.invalid:1080'),
                          ('deploy', '--proxy', 'http://secret@localhost:1080'),
                          ('deploy', '--proxy', 'http://localhost:0'),
                          ('deploy', '--proxy', 'http://localhost:65536'),
                          ('deploy', '--proxy', 'http://localhost:1080/?secret=value'),
                          ('deploy', '--proxy', 'http://localhost:1080\n'),
                          ('deploy', '--proxy', 'http://localhost:1080', '--proxy', 'http://localhost:1080'),
                          ('deploy', '--build-on-host', '--proxy', 'http://localhost:1080'),
                          ('resolve-recovery', '--proxy', 'http://localhost:1080')]:
            result = shell('parse_arguments "$@"', arguments)
            self.assertNotEqual(result.returncode, 0, str(arguments))
            self.assertNotIn(b'secret', result.stdout + result.stderr)

    def test_network_proxy_is_explicit_and_does_not_leak_to_local_commands(self):
        probe = 'python3 -c \'import os; print(os.environ.get("HTTPS_PROXY", "absent"))\''
        result = shell('parse_arguments "$@"; pin_local_runtime_controls; download_network ' + probe + '\n' + probe,
                       ['check', '--proxy', 'http://127.0.0.1:1080'], {'HTTPS_PROXY': 'http://unrelated.invalid:1'})
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout.decode().splitlines(), ['http://127.0.0.1:1080', 'absent'])
        result = shell('parse_arguments check; pin_local_runtime_controls; download_network ' + probe,
                       environment={'HTTPS_PROXY': 'http://unrelated.invalid:1'})
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout.decode(), '\n')

    def test_only_verified_image_mapping_can_be_used_for_descriptor_create(self):
        reference = 'ghcr.io/yaojingang/tokems-production-private@sha256:' + 'a' * 64
        identifier = 'sha256:' + 'b' * 64
        with tempfile.TemporaryDirectory() as directory:
            mapping = Path(directory) / ('image-' + 'a' * 64)
            for value, succeeds in [(None, False), ('tokems-api:local', False), (identifier, True)]:
                if value:
                    mapping.write_text(value + '\n')
                result = shell('download_proxy=http://127.0.0.1:1080; registry_auth_dir="$1"; registry_local_image "$2"',
                               [directory, reference])
                self.assertEqual(result.returncode == 0, succeeds, result.stderr.decode())
                if succeeds:
                    self.assertEqual(result.stdout.decode().strip(), identifier)
        direct = shell('registry_local_image "$1"', [reference])
        self.assertEqual(direct.stdout.decode().strip(), reference)


class LegacyArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.manifest, self.config, self.blob = image_fixture()
        self.reference = 'ghcr.io/yaojingang/tokems-production-private@' + fingerprint(json.dumps(self.manifest).encode())
        self.source = object.__new__(legacy.ImageSource)
        self.source.proxy = 'http://127.0.0.1:1080'
        self.source.env = legacy.proxy_environment(self.source.proxy)
        self.source.crane = '/test/crane'
        self.source.manifest = Mock(return_value=(self.manifest, json.dumps(self.manifest).encode()))

    def tearDown(self):
        self.tmp.cleanup()

    def test_manifest_digest_binds_exact_remote_bytes(self):
        for data in (b'{"x":1}', b'{"x":1}\n'):
            self.assertEqual(legacy.verified_json(data + b'\n', fingerprint(data))[1], data)
        with self.assertRaisesRegex(legacy.DeployError, 'differs'):
            legacy.verified_json(b'{"x":2}', fingerprint(b'{"x":1}'))

    def test_verified_archive_import_never_changes_application_tags_or_proxies_docker(self):
        events = []
        def invoke(args, **kwargs):
            events.append(args[:2])
            if args[:2] == ['/test/crane', 'pull']:
                self.assertEqual(kwargs['env']['HTTPS_PROXY'], self.source.proxy)
                make_archive(args[-1], self.config, self.blob, [self.reference.split('@')[0] + ':i-was-a-digest'])
            elif args[:2] == ['docker', 'load']:
                self.assertNotIn('env', kwargs)
                self.assertEqual(legacy.verify_archive(args[-1], self.manifest, self.reference, imported=True)['RepoTags'],
                                 [legacy.cache_tag(self.manifest['config']['digest'])])
            elif args[:2] == ['docker', 'image']:
                return self.manifest['config']['digest']
            else:
                self.fail('Unexpected command')
        with patch.object(legacy, 'run', side_effect=invoke), patch.object(legacy.shutil, 'disk_usage', return_value=Mock(free=4 * 1024 ** 3)):
            result = self.source.pull(self.reference, 'linux/amd64', self.root, 'api')
        self.assertEqual(result, self.manifest['config']['digest'])
        self.assertEqual(events, [['/test/crane', 'pull'], ['docker', 'load'], ['docker', 'image']])
        self.assertFalse((self.root / 'api-download.tar').exists())

    def test_broken_tunnel_and_tampered_archive_stop_before_import_without_direct_fallback(self):
        for invalid in ('tunnel', 'layer', 'config', 'tag'):
            def invoke(args, **kwargs):
                self.assertEqual(args[:2], ['/test/crane', 'pull'])
                if invalid == 'tunnel':
                    raise legacy.DeployError('proxy unreachable')
                make_archive(args[-1], b'{}' if invalid == 'config' else self.config,
                             b'corrupt' if invalid == 'layer' else self.blob,
                             ['tokems-api:local'] if invalid == 'tag' else None)
            with patch.object(legacy, 'run', side_effect=invoke) as run, patch.object(legacy.shutil, 'disk_usage', return_value=Mock(free=4 * 1024 ** 3)):
                with self.assertRaises(legacy.DeployError):
                    self.source.pull(self.reference, 'linux/amd64', self.root, 'api')
                self.assertEqual(run.call_count, 1)
            self.assertFalse((self.root / 'api-download.tar').exists())

    def test_disk_gate_precedes_download(self):
        with patch.object(legacy.shutil, 'disk_usage', return_value=Mock(free=1024)), patch.object(legacy, 'run') as run:
            with self.assertRaisesRegex(legacy.DeployError, 'Insufficient space'):
                self.source.pull(self.reference, 'linux/amd64', self.root, 'api')
            run.assert_not_called()

    def test_cache_reuse_requires_exact_config_identity_and_new_mapping_is_private(self):
        expected = self.manifest['config']['digest']
        mapping = self.root / ('image-' + self.reference.rsplit(':', 1)[-1])
        for cached in (expected, 'sha256:' + '0' * 64):
            self.source.pull = Mock(return_value=expected)
            with patch.object(legacy, 'ImageSource', return_value=self.source), patch.object(legacy, 'run', return_value=cached) as run, patch('builtins.print'):
                legacy.main([self.source.proxy, str(self.root), str(self.root), self.reference, 'linux/amd64'])
            self.assertEqual(run.call_args[0][0][-1], expected, 'Reuse ordinary Docker pulls by immutable ID too')
            self.assertEqual(self.source.pull.call_count, int(cached != expected))
            self.assertEqual(mapping.read_text().strip(), expected)
            self.assertEqual(mapping.stat().st_mode & 0o777, 0o600)
            self.assertFalse(list(self.root.glob('.image-download-*')))

    def test_failed_download_never_creates_mapping_and_cleans_own_temporary_archive(self):
        self.source.pull = Mock(side_effect=legacy.DeployError('proxy unreachable'))
        with patch.object(legacy, 'ImageSource', return_value=self.source), patch.object(legacy, 'run', side_effect=legacy.DeployError('not cached')):
            with self.assertRaises(legacy.DeployError):
                legacy.main([self.source.proxy, str(self.root), str(self.root), self.reference, 'linux/amd64'])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_tool_errors_cannot_leak_signed_urls_or_tokens(self):
        with patch.object(legacy.subprocess, 'run', return_value=Mock(returncode=1, stderr=b'https://registry.invalid?token=secret')):
            with self.assertRaisesRegex(legacy.DeployError, '^Command failed: crane \\(exit 1\\)$'):
                legacy.run(['crane', 'pull'])

    def test_term_and_hup_reap_download_child_and_remove_partial_archive(self):
        prefix, entrypoint = embedded.rsplit("if __name__ == '__main__':", 1)
        fake_source = '''
class ImageSource:
    def __init__(self, proxy): self.env = {}
    def manifest(self, reference):
        return ({'config': {'digest': 'sha256:' + 'b' * 64}}, b'{}')
    def pull(self, reference, platform, directory, name):
        child = "from pathlib import Path; import os, sys, time; Path(sys.argv[1]).write_bytes(b'partial'); Path(sys.argv[2]).write_text(str(os.getpid())); time.sleep(20)"
        run([sys.executable, '-c', child, directory / 'image-download.tar', directory.parent / 'ready'])
'''
        program = prefix + fake_source + "\nif __name__ == '__main__':" + entrypoint
        for signum in (signal.SIGTERM, signal.SIGHUP):
            ready = self.root / 'ready'
            if ready.exists():
                ready.unlink()
            process = subprocess.Popen([sys.executable, '-c', program, self.source.proxy,
                                        str(self.root), str(self.root), self.reference, 'linux/amd64'],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), 'The real download subprocess must start before interrupting')
                child_pid = int(ready.read_text())
                process.send_signal(signum)
                process.communicate(timeout=5)
                self.assertEqual(list(self.root.glob('.image-download-*')), [], 'Interrupted tarballs must be removed')
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
                self.assertNotEqual(process.returncode, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)
                if ready.exists():
                    try:
                        os.kill(int(ready.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_interrupt_during_cache_probe_is_not_treated_as_a_cache_miss(self):
        prefix, entrypoint = embedded.rsplit("if __name__ == '__main__':", 1)
        fake_source = '''
class ImageSource:
    def __init__(self, proxy): self.env = {}
    def manifest(self, reference):
        return ({'config': {'digest': 'sha256:' + 'b' * 64}}, b'{}')
    def pull(self, reference, platform, directory, name):
        (directory.parent / 'unexpected-pull').write_text('must not continue')
        return 'sha256:' + 'b' * 64
original_run = run
def run(args, **kwargs):
    child = "from pathlib import Path; import os, sys, time; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(20)"
    return original_run([sys.executable, '-c', child, Path(sys.argv[3]) / 'ready'])
'''
        program = prefix + fake_source + "\nif __name__ == '__main__':" + entrypoint
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with tempfile.TemporaryDirectory(dir=str(self.root)) as directory:
                root = Path(directory)
                process = subprocess.Popen([sys.executable, '-c', program, self.source.proxy,
                                            directory, directory, self.reference, 'linux/amd64'],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 5
                    while not (root / 'ready').exists() and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue((root / 'ready').exists(), 'Cache subprocess must start')
                    child_pid = int((root / 'ready').read_text())
                    process.send_signal(signum)
                    process.communicate(timeout=5)
                    self.assertFalse((root / 'unexpected-pull').exists(), 'Cancelled cache probe must not download')
                    self.assertFalse(list(root.glob('image-*')), 'Cancelled invocation must not write a mapping')
                    with self.assertRaises(ProcessLookupError):
                        os.kill(child_pid, 0)
                    self.assertNotEqual(process.returncode, 0)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
