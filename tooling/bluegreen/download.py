"""Optional process-scoped SSH proxy; never reconfigure or restart the Docker daemon."""
import base64
import hashlib
import io
import json
import re
import shutil
import tarfile
from pathlib import Path
from policy import require
from system import SAFE_ENV, atomic, run


def proxy_url(value):
    if value is None:
        return None
    require(isinstance(value, str), 'downloadProxy must be null or a loopback proxy URL')
    match = re.fullmatch(r'(https?|socks5h?)://(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})/?', value)
    require(match is not None and 1 <= int(match.group(3)) <= 65535,
            'Use an HTTP/HTTPS/SOCKS5 loopback proxy URL with an explicit port and no credentials')
    scheme = 'socks5h' if match.group(1).startswith('socks5') else match.group(1)
    return '{}://{}:{}'.format(scheme, match.group(2), int(match.group(3)))


def proxy_environment(value):
    value = proxy_url(value)
    if value is None:
        return {}
    result = {key: value for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')}
    result.update(NO_PROXY='localhost,127.0.0.1,::1', no_proxy='localhost,127.0.0.1,::1')
    return result


def verified_json(raw, expected):
    # crane prints one extra newline; never hash reserialized JSON or strip payload whitespace.
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', expected or ''), 'Invalid OCI content digest')
    for payload in (raw, raw[:-1] if raw.endswith(b'\n') else raw):
        if 'sha256:' + hashlib.sha256(payload).hexdigest() == expected:
            return json.loads(payload.decode()), payload
    require(False, 'Registry content differs from the verified digest')


def cache_tag(identifier):
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', identifier or ''), 'Invalid imported image ID')
    return 'tokems-bluegreen-cache:sha256-' + identifier[7:]


def verify_archive(path, manifest, reference, imported=False):
    """Bind every imported config/layer to the attested manifest before docker load."""
    hashes, records = {}, None
    with tarfile.open(str(path), mode='r|') as archive:
        for member in archive:
            require(member.isfile() and '/' not in member.name and member.name not in hashes,
                    'Unexpected image archive entry')
            require(len(hashes) < len(manifest['layers']) + 2, 'Unexpected image archive contents')
            source = archive.extractfile(member)
            fingerprint = hashlib.sha256()
            if member.name == 'manifest.json':
                require(member.size <= 1024 * 1024, 'Image archive manifest is too large')
                data = source.read()
                records = json.loads(data.decode())
                fingerprint.update(data)
            else:
                while True:
                    data = source.read(1024 * 1024)
                    if not data:
                        break
                    fingerprint.update(data)
            hashes[member.name] = 'sha256:' + fingerprint.hexdigest()
    require(isinstance(records, list) and len(records) == 1, 'Expected one image in archive')
    record = records[0]
    tags = record.get('RepoTags')
    expected_tag = cache_tag(manifest['config']['digest']) if imported else reference.rsplit('@', 1)[0] + ':i-was-a-digest'
    require((not tags or tags == [expected_tag]) and not record.get('LayerSources'),
            'Archive contains unexpected tags or foreign layers')
    require(hashes.get(record['Config']) == manifest['config']['digest'], 'Image config digest mismatch')
    require(len(record['Layers']) == len(manifest['layers']), 'Incomplete image layers')
    require(set(hashes) == set(record['Layers'] + [record['Config'], 'manifest.json']), 'Unexpected archive members')
    for filename, layer in zip(record['Layers'], manifest['layers']):
        require(hashes.get(filename) == layer['digest'], 'Image layer digest mismatch')
    return record


def set_archive_cache_tag(path, record, identifier):
    # Classic Docker silently ignores untagged archives. Use one content-addressed local tag.
    temporary = path.with_name(path.name + '.cache-tag')
    record = dict(record, RepoTags=[cache_tag(identifier)])
    try:
        with tarfile.open(str(path), 'r|') as source, tarfile.open(str(temporary), 'w|') as output:
            for member in source:
                if member.name == 'manifest.json':
                    data = json.dumps([record]).encode()
                    member.size = len(data)
                    output.addfile(member, io.BytesIO(data))
                else:
                    output.addfile(member, source.extractfile(member))
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


class ImageSource:
    def __init__(self, proxy=None):
        self.proxy = proxy_url(proxy)
        self.env = proxy_environment(self.proxy)
        self.crane = None
        if self.proxy:
            executable = shutil.which('crane', path=SAFE_ENV['PATH'])
            require(executable is not None, 'Proxy image downloads require crane >= 0.20.3; see the bluegreen runbook')
            path = Path(executable).resolve()
            require(path.is_file() and path.stat().st_uid == 0 and not path.stat().st_mode & 0o022,
                    'crane must be installed by root without group/other write permission')
            self.crane = str(path)
            version = run([self.crane, 'version'])
            match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', version)
            require(match and tuple(map(int, match.groups())) >= (0, 20, 3), 'crane >= 0.20.3 is required')

    def authenticate(self, directory, token):
        self.env.update(DOCKER_CONFIG=str(directory), GH_TOKEN=token, GH_HOST='github.com')
        if self.proxy:
            # docker login can contact the registry through dockerd, outside the selected proxy.
            encoded = base64.b64encode(('yaojingang:' + token).encode()).decode()
            atomic(Path(directory) / 'config.json', {'auths': {'ghcr.io': {'auth': encoded}}})
        else:
            run(['docker', 'login', 'ghcr.io', '-u', 'yaojingang', '--password-stdin'],
                data=token + '\n', env=self.env, timeout=60)

    def digest(self, reference):
        if self.proxy:
            return run([self.crane, 'digest', reference], env=self.env)
        return run(['docker', 'buildx', 'imagetools', 'inspect', '--format', '{{.Manifest.Digest}}', reference], env=self.env)

    def manifest(self, reference):
        raw = run([self.crane, 'manifest', reference], env=self.env, binary=True)
        manifest, payload = verified_json(raw, reference.rsplit('@', 1)[-1])
        # The production workflow publishes one platform with provenance stored separately.
        require(manifest.get('schemaVersion') == 2 and 'manifests' not in manifest and
                isinstance(manifest.get('config'), dict) and isinstance(manifest.get('layers'), list),
                'Expected a single-platform production image manifest')
        return manifest, payload

    def labels(self, reference):
        if self.proxy:
            manifest, _ = self.manifest(reference)
            raw = run([self.crane, 'config', reference], env=self.env, binary=True)
            config, _ = verified_json(raw, manifest['config']['digest'])
            return config['config']['Labels']
        return json.loads(run(['docker', 'buildx', 'imagetools', 'inspect', '--format',
                               '{{json .Image.Config.Labels}}', reference], env=self.env))

    def pull(self, reference, platform, directory, name):
        if not self.proxy:
            run(['docker', 'pull', '--platform', platform, reference], env=self.env, timeout=1800)
            return reference
        manifest, payload = self.manifest(reference)
        needed = 2 * (sum(layer['size'] for layer in manifest['layers']) + manifest['config']['size']) + 1024 ** 3
        require(shutil.disk_usage(str(directory)).free >= needed, 'Insufficient space for proxy image archive')
        archive = Path(directory) / (name + '-download.tar')
        try:
            run([self.crane, 'pull', '--platform', platform, '--format=tarball', reference, archive],
                env=self.env, timeout=1800)
            record = verify_archive(archive, manifest, reference)
            config_digest = manifest['config']['digest']
            set_archive_cache_tag(archive, record, config_digest)
            run(['docker', 'load', '--input', archive], timeout=1800)
            # Classic storage uses config IDs; containerd storage uses manifest IDs.
            # Resolve the imported, content-addressed cache tag once, then pin the actual ID.
            identifier = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', cache_tag(config_digest)])
            require(re.fullmatch(r'sha256:[a-f0-9]{64}', identifier), 'Invalid imported image identity')
            atomic(Path(directory) / (name + '-source-manifest.json'), payload.decode())
            return identifier
        finally:
            if archive.exists():
                archive.unlink()
