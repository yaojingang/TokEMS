import base64
import gzip
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import controller
import download
from download import ImageSource, cache_tag, proxy_environment, proxy_url, set_archive_cache_tag, verified_json, verify_archive
from policy import DeployError


def fingerprint(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()


def image_fixture(label='unit-test'):
    layer = io.BytesIO()
    with tarfile_open(layer, 'w'):
        pass
    raw = layer.getvalue()
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode='wb', mtime=0) as stream:
        stream.write(raw)
    blob = compressed.getvalue()
    config = json.dumps(dict(architecture='amd64', os='linux', config={'Labels': {'com.tokems.proxy-test': label}},
                             rootfs={'type': 'layers', 'diff_ids': [fingerprint(raw)]})).encode()
    manifest = dict(schemaVersion=2, mediaType='application/vnd.docker.distribution.manifest.v2+json',
                    config=dict(mediaType='application/vnd.docker.container.image.v1+json', size=len(config), digest=fingerprint(config)),
                    layers=[dict(mediaType='application/vnd.docker.image.rootfs.diff.tar.gzip', size=len(blob), digest=fingerprint(blob))])
    return manifest, config, blob


def tarfile_open(fileobj, mode):
    import tarfile
    return tarfile.open(fileobj=fileobj, mode=mode)


def make_archive(path, config, blob, tags=None):
    import tarfile
    config_name, layer_name = fingerprint(config), fingerprint(blob)[7:] + '.tar.gz'
    record = dict(Config=config_name, Layers=[layer_name], RepoTags=tags)
    with tarfile.open(str(path), 'w') as output:
        for name, data in [(config_name, config), (layer_name, blob), ('manifest.json', json.dumps([record]).encode())]:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            output.addfile(info, io.BytesIO(data))


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.manifest, self.config, self.blob = image_fixture()
        self.reference = 'ghcr.io/yaojingang/tokems-production-private@' + fingerprint(json.dumps(self.manifest).encode())
        self.source = object.__new__(ImageSource)
        self.source.proxy = 'http://127.0.0.1:1080'
        self.source.env = proxy_environment(self.source.proxy)
        self.source.crane = '/test/crane'

    def tearDown(self):
        self.tmp.cleanup()

    def test_explicit_proxy_protocols_and_remote_dns(self):
        self.assertIsNone(proxy_url(None))
        self.assertEqual(proxy_url('http://127.0.0.1:1080/'), 'http://127.0.0.1:1080')
        self.assertEqual(proxy_url('socks5://localhost:1080'), 'socks5h://localhost:1080')
        self.assertEqual(proxy_url('https://[::1]:1080'), 'https://[::1]:1080')
        for value in ('', 'ftp://localhost:1080', 'http://example.com:1080', 'http://0.0.0.0:1080',
                      'http://user:secret@localhost:1080', 'http://localhost', 'http://localhost:0',
                      'http://localhost:65536', 'http://localhost:1080/?secret=value', 'http://localhost:1080\n', True):
            with self.assertRaises(DeployError):
                proxy_url(value)

    def test_proxy_is_opt_in_and_only_passed_to_selected_processes(self):
        with patch('system.subprocess.run', return_value=Mock(returncode=0, stdout=b'ok')) as run, \
                patch.dict('os.environ', {'HTTPS_PROXY': 'http://unrelated.invalid:1'}):
            from system import run as invoke
            invoke(['curl', 'https://example.invalid'], env=self.source.env)
            self.assertEqual(run.call_args[1]['env']['HTTPS_PROXY'], self.source.proxy)
            invoke(['curl', 'http://127.0.0.1:18088/api/v1/health'])
            self.assertNotIn('HTTPS_PROXY', run.call_args[1]['env'])

    def test_direct_download_has_no_crane_dependency(self):
        with patch('download.run') as run, patch('download.shutil.which') as which:
            source = ImageSource()
            self.assertEqual(source.pull(self.reference, 'linux/amd64', self.root, 'api'), self.reference)
            which.assert_not_called()
            self.assertEqual(run.call_args[0][0][:2], ['docker', 'pull'])

    def test_proxy_auth_does_not_call_daemon_login_or_put_token_in_argv(self):
        with patch('download.run') as run:
            self.source.authenticate(self.root, 'test-token')
            run.assert_not_called()
        auth = json.loads((self.root / 'config.json').read_text())['auths']['ghcr.io']['auth']
        self.assertEqual(base64.b64decode(auth).decode(), 'yaojingang:test-token')
        self.assertEqual((self.root / 'config.json').stat().st_mode & 0o777, 0o600)

    def test_json_digest_matches_exact_remote_bytes_including_trailing_newline(self):
        for data in (b'{"x":1}', b'{"x":1}\n'):
            self.assertEqual(verified_json(data + b'\n', fingerprint(data))[1], data)
        with self.assertRaisesRegex(DeployError, 'differs'):
            verified_json(b'{"x":2}\n', fingerprint(b'{"x":1}'))

    def test_crane_synthetic_tag_is_replaced_with_content_addressed_cache_tag(self):
        archive = self.root / 'image.tar'
        tag = self.reference.split('@')[0] + ':i-was-a-digest'
        make_archive(archive, self.config, self.blob, [tag])
        record = verify_archive(archive, self.manifest, self.reference)
        set_archive_cache_tag(archive, record, self.manifest['config']['digest'])
        self.assertEqual(verify_archive(archive, self.manifest, self.reference, imported=True)['RepoTags'],
                         [cache_tag(self.manifest['config']['digest'])])

    def test_tampered_layers_configs_and_unexpected_tags_are_rejected(self):
        archive = self.root / 'image.tar'
        for config, layer, tags in [(self.config, b'corrupt', None), (b'{}', self.blob, None),
                                     (self.config, self.blob, ['tokems-api:local'])]:
            make_archive(archive, config, layer, tags)
            with self.assertRaises(DeployError):
                verify_archive(archive, self.manifest, self.reference)

    def test_proxy_pull_verifies_before_load_and_pins_image_id(self):
        self.source.manifest = Mock(return_value=(self.manifest, json.dumps(self.manifest).encode()))
        events = []
        def invoke(args, **kwargs):
            events.append(args[:2])
            if args[:2] == ['/test/crane', 'pull']:
                self.assertEqual(kwargs['env']['HTTPS_PROXY'], self.source.proxy)
                make_archive(args[-1], self.config, self.blob, [self.reference.split('@')[0] + ':i-was-a-digest'])
            elif args[:2] == ['docker', 'load']:
                self.assertNotIn('env', kwargs)
                self.assertEqual(verify_archive(args[-1], self.manifest, self.reference, imported=True)['RepoTags'],
                                 [cache_tag(self.manifest['config']['digest'])])
            elif args[:2] == ['docker', 'image']:
                self.assertEqual(args[-1], cache_tag(self.manifest['config']['digest']))
                return self.manifest['config']['digest']
            else:
                self.fail('Unexpected command')
        with patch('download.run', side_effect=invoke), patch('download.shutil.disk_usage', return_value=Mock(free=4 * 1024 ** 3)):
            result = self.source.pull(self.reference, 'linux/amd64', self.root, 'api')
        self.assertEqual(result, self.manifest['config']['digest'])
        self.assertEqual(events, [['/test/crane', 'pull'], ['docker', 'load'], ['docker', 'image']])
        self.assertFalse((self.root / 'api-download.tar').exists())

    def test_broken_proxy_or_tampered_download_never_imports_or_falls_back(self):
        self.source.manifest = Mock(return_value=(self.manifest, json.dumps(self.manifest).encode()))
        for broken_proxy in (True, False):
            def invoke(args, **kwargs):
                self.assertEqual(args[:2], ['/test/crane', 'pull'])
                if broken_proxy:
                    raise DeployError('proxy unreachable')
                make_archive(args[-1], self.config, b'corrupt')
            with patch('download.run', side_effect=invoke) as run, patch('download.shutil.disk_usage', return_value=Mock(free=4 * 1024 ** 3)):
                with self.assertRaises(DeployError):
                    self.source.pull(self.reference, 'linux/amd64', self.root, 'api')
                self.assertEqual(run.call_count, 1)
            self.assertFalse((self.root / 'api-download.tar').exists())

    def test_insufficient_archive_space_fails_before_download_or_import(self):
        self.source.manifest = Mock(return_value=(self.manifest, json.dumps(self.manifest).encode()))
        with patch('download.shutil.disk_usage', return_value=Mock(free=1024)), patch('download.run') as run:
            with self.assertRaisesRegex(DeployError, 'Insufficient space'):
                self.source.pull(self.reference, 'linux/amd64', self.root, 'api')
            run.assert_not_called()

    def test_deploy_persists_configured_proxy_and_per_run_overrides_for_systemd(self):
        for override, direct, expected in [(None, False, 'http://127.0.0.1:1080'),
                                           ('socks5://127.0.0.1:1081', False, 'socks5h://127.0.0.1:1081'),
                                           (None, True, None)]:
            with tempfile.TemporaryDirectory() as root, patch.object(controller, 'ROOT', Path(root)), \
                    patch.object(controller, 'MARKER', Path(root) / 'absent'), patch.object(controller, 'private_directory'), \
                    patch('controller.os.geteuid', return_value=0), patch('controller.os.umask'), \
                    patch.object(Path, 'is_dir', return_value=True), patch('controller.shutil.copytree'), \
                    patch.object(controller, 'config', return_value={'downloadProxy': 'http://127.0.0.1:1080'}), \
                    patch.object(controller, 'run'), patch('builtins.print'):
                controller.dispatch('deploy', sha='a' * 40, proxy=override, direct=direct)
                record = next(Path(root).glob('*/state.json'))
                self.assertEqual(json.loads(record.read_text())['downloadProxy'], expected)


if __name__ == '__main__':
    unittest.main()
