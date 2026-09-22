"""Online preparation only. Execution/resume uses its sealed local output."""
import json
import os
import platform
import re
import shutil
import tempfile
from pathlib import Path
from download import ImageSource
from policy import digest, require
from system import atomic, protected, run

REPO = 'yaojingang/TokEMS'
PACKAGE = 'ghcr.io/yaojingang/tokems-production-private'
APP = Path('/www/wwwroot/TokEMS')
LOCK = Path('/run/lock/tokems-production-deploy')
SERVICES = ('api', 'worker', 'web', 'admin', 'gateway', 'notification-sink')


def git(*args):
    return run(['sudo', '-u', 'ecs-user', 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
                'HOME=/nonexistent', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null',
                'GIT_NO_REPLACE_OBJECTS=1', 'GIT_TERMINAL_PROMPT=0', 'git', '-C', APP] + list(args))


def github(endpoint, env=None):
    return json.loads(run(['curl', '--fail', '--silent', '--show-error', '--connect-timeout', '10',
                           '--max-time', '60', '-H', 'Accept: application/vnd.github+json',
                           'https://api.github.com/repos/' + REPO + '/' + endpoint], env=env))


def release_gate(sha, env=None):
    require(github('commits/main', env)['sha'] == sha, 'Target is not current official main')
    pulls = github('commits/' + sha + '/pulls?per_page=100', env)
    require(any(p.get('merged_at') and p.get('merge_commit_sha') == sha and p.get('base', {}).get('ref') == 'main' for p in pulls), 'Target must be the merge SHA of a merged main PR')
    evidence = dict(pulls=pulls)
    for workflow, name, event in [('ci.yml', 'tokems-ci', 'push'), ('publish-images.yml', 'tokems-image-publish', 'workflow_run')]:
        payload = github('actions/workflows/' + workflow + '/runs?branch=main&event=' + event + '&per_page=100', env)
        require(any(r.get('head_sha') == sha and r.get('status') == 'completed' and r.get('conclusion') == 'success'
                    and r.get('name') == name and r.get('event') == event and r.get('head_branch') == 'main'
                    and r.get('path') == '.github/workflows/' + workflow
                    and r.get('repository', {}).get('full_name') == REPO
                    and r.get('head_repository', {}).get('full_name') == REPO
                    for r in payload['workflow_runs']), 'Required workflow has not succeeded: ' + workflow)
        evidence[workflow] = payload
    checks = github('commits/' + sha + '/check-runs?per_page=100', env)
    require(any(c.get('name') == 'quality-and-flows' and c.get('head_sha') == sha and c.get('status') == 'completed'
                and c.get('conclusion') == 'success' and c.get('app', {}).get('slug') == 'github-actions'
                and '/yaojingang/TokEMS/actions/runs/' in c.get('details_url', '') for c in checks['check_runs']), 'Required quality job is missing')
    evidence['checks'] = checks
    return evidence


def prepare(directory, sha, proxy=None):
    directory = Path(directory)
    network = ImageSource(proxy)
    require(re.fullmatch('[a-f0-9]{40}', sha), 'Invalid target SHA')
    require(git('remote', 'get-url', 'origin') == 'https://github.com/yaojingang/TokEMS.git', 'Invalid origin')
    require(git('branch', '--show-current') == 'production', 'Expected production branch')
    require(git('rev-parse', '--abbrev-ref', '@{upstream}') == 'origin/main', 'Invalid upstream')
    require(not git('status', '--porcelain'), 'Production source must be clean')
    atomic(directory / 'github.json', release_gate(sha, network.env))
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    require(arch is not None, 'Unsupported architecture')
    target_platform = 'linux/' + arch
    token = protected('/etc/tokems/ghcr-read-token').read_text().strip()
    require(token and '\n' not in token, 'Invalid registry credential')
    auth = Path(tempfile.mkdtemp(prefix='bluegreen-auth-', dir=str(LOCK)))
    env = network.env
    try:
        network.authenticate(auth, token)
        require(run(['gh', 'api', '/users/yaojingang/packages/container/tokems-production-private', '--jq', '.visibility'], env=env) == 'private', 'Production package must be private')
        descriptor_digest = network.digest(PACKAGE + ':release-' + sha)
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', descriptor_digest), 'Invalid descriptor digest')
        ref = PACKAGE + '@' + descriptor_digest

        def attest(image, name):
            proof = run(['gh', 'attestation', 'verify', 'oci://' + image, '--repo', REPO, '--signer-workflow',
                         REPO + '/.github/workflows/publish-images.yml', '--source-digest', sha, '--source-ref',
                         'refs/heads/main', '--deny-self-hosted-runners', '--format', 'json'], env=env)
            atomic(directory / (name + '-attestation.json'), proof)

        attest(ref, 'descriptor')
        labels = network.labels(ref)
        for key, value in {'org.opencontainers.image.source': 'https://github.com/' + REPO,
                           'org.opencontainers.image.revision': sha, 'com.tokems.build.sha': sha,
                           'com.tokems.release.schema': '2', 'com.tokems.release.platform': target_platform,
                           'com.tokems.release.source-bundle.ref': 'refs/heads/tokems-release-source'}.items():
            require(labels.get(key) == value, 'Descriptor bootstrap mismatch: ' + key)
        atomic(directory / 'labels.json', labels)
        descriptor_image = network.pull(ref, target_platform, directory, 'descriptor')
        container = run(['docker', 'create', descriptor_image, '/release/source.bundle'])
        try:
            for name, key in [('source.bundle', 'source-bundle'), ('release-descriptor.py', 'verifier')]:
                run(['docker', 'cp', container + ':/release/' + name, directory / name])
                require(digest(directory / name) == labels.get('com.tokems.release.' + key + '.sha256'), 'Descriptor payload mismatch')
        finally:
            run(['docker', 'rm', container])
        verifier = directory / 'release-descriptor.py'
        run(['python3', verifier, 'verify-descriptor', '--labels-file', directory / 'labels.json', '--target-sha', sha,
             '--platform', target_platform, '--records-output', directory / 'records.tsv'])
        run(['python3', verifier, 'verify-source-bundle', '--bundle-file', directory / 'source.bundle', '--target-sha', sha])
        # Source transport is readable only by repository owner; no unverified remote git fetch.
        transport = Path(tempfile.mkdtemp(prefix='tokems-release-source-', dir='/run'))
        try:
            os.chmod(str(transport), 0o711)
            group = run(['id', '-gn', 'ecs-user'])
            for name in ('source.bundle', 'release-descriptor.py'):
                run(['install', '-o', 'root', '-g', group, '-m', '440', directory / name, transport / name])
            run(['sudo', '-u', 'ecs-user', 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/nonexistent',
                 'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_NO_REPLACE_OBJECTS=1',
                 'GIT_TERMINAL_PROMPT=0', 'python3', transport / 'release-descriptor.py', 'import-source-bundle',
                 '--bundle-file', transport / 'source.bundle', '--repository', APP, '--target-sha', sha,
                 '--timeout-seconds', '180'])
        finally:
            shutil.rmtree(str(transport))
        source = directory / 'source'
        source.mkdir(mode=0o700)
        # Archive is produced from the verified local commit, not downloaded tar metadata.
        archive = run(['sudo', '-u', 'ecs-user', 'git', '-C', APP, 'archive', sha], binary=True)
        run(['tar', '-xf', '-', '-C', source], data=archive, binary=True)
        require(digest(verifier) == digest(source / 'tooling/release-descriptor.py'), 'Verifier differs from target source')
        records = [line.split('\t') for line in (directory / 'records.tsv').read_text().splitlines()]
        build = {name: value for kind, name, value in records if kind == 'build'}
        registry_images = {name: value for kind, name, value in records if kind == 'image'}
        require(set(registry_images) == set(SERVICES), 'Incomplete image set')
        images = {}
        require(sorted((source / 'packages/database/drizzle').glob('[0-9][0-9][0-9][0-9]_*.sql'))[-1].name == build['migration'], 'Descriptor does not contain latest source migration')
        require(digest(source / 'packages/database/drizzle' / build['migration']) == build['migration-hash'], 'Source migration differs from image')
        for service in SERVICES:
            image = registry_images[service]
            attest(image, service)
            images[service] = network.pull(image, target_platform, directory, service)
            metadata = run(['docker', 'image', 'inspect', '--format', '{{json .}}', images[service]])
            atomic(directory / (service + '-image.json'), metadata)
            run(['python3', verifier, 'verify-service', '--metadata-file', directory / (service + '-image.json'),
                 '--service', service, '--target-sha', sha, '--build-time', build['time'], '--migration', build['migration'],
                 '--migration-hash', build['migration-hash'], '--platform', target_platform])
        require(github('commits/main', env)['sha'] == sha, 'Main changed during preparation; retry before touching services')
        git('-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', sha)
        require(git('rev-parse', 'HEAD') == sha and not git('status', '--porcelain'), 'Source identity changed')
        result = dict(sha=sha, build=build, images=images, registryImages=registry_images,
                      platform=target_platform, downloadMode='proxy' if network.proxy else 'direct')
        atomic(directory / 'artifacts.json', result)
        return result
    finally:
        shutil.rmtree(str(auth))
