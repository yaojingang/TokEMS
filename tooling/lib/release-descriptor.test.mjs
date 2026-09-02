import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifierPath = resolve(repositoryRoot, 'tooling/release-descriptor.py');
const sha = 'a'.repeat(40);
const migrationHash = 'b'.repeat(64);
const sourceBundleHash = 'c'.repeat(64);
const verifierHash = 'd'.repeat(64);
const buildTime = '2026-09-02T04:05:06Z';
const platform = 'linux/amd64';
const services = ['api', 'worker', 'web', 'admin', 'gateway', 'notification-sink'];

function descriptorLabels(overrides = {}) {
  const labels = {
    'org.opencontainers.image.source': 'https://github.com/yaojingang/TokEMS',
    'org.opencontainers.image.revision': sha,
    'org.opencontainers.image.created': buildTime,
    'com.tokems.release.schema': '2',
    'com.tokems.release.platform': platform,
    'com.tokems.release.source-bundle.ref': 'refs/heads/tokems-release-source',
    'com.tokems.release.source-bundle.sha256': sourceBundleHash,
    'com.tokems.release.verifier.sha256': verifierHash,
    'com.tokems.build.sha': sha,
    'com.tokems.build.time': buildTime,
    'com.tokems.build.migration': '0054_example.sql',
    'com.tokems.build.migration-hash': migrationHash,
  };
  services.forEach((service, index) => {
    labels[`com.tokems.release.image.${service}`] =
      `ghcr.io/yaojingang/tokems-production-private@sha256:${String(index + 1).repeat(64)}`;
  });
  return { ...labels, ...overrides };
}

function runVerifier(args) {
  return spawnSync('python3', [verifierPath, ...args], { encoding: 'utf8' });
}

test('release descriptor verifier emits a complete immutable image set', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-release-descriptor-'));
  const labelsFile = resolve(directory, 'labels.json');
  const recordsFile = resolve(directory, 'records.tsv');
  try {
    writeFileSync(labelsFile, JSON.stringify(descriptorLabels()));
    const result = runVerifier([
      'verify-descriptor',
      '--labels-file',
      labelsFile,
      '--target-sha',
      sha,
      '--platform',
      platform,
      '--records-output',
      recordsFile,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const records = readFileSync(recordsFile, 'utf8');
    assert.match(records, new RegExp(`^build\\tsha\\t${sha}$`, 'm'));
    assert.match(records, /^build\tmigration\t0054_example\.sql$/m);
    assert.match(
      records,
      new RegExp(`^release\\tsource-bundle-sha256\\t${sourceBundleHash}$`, 'm'),
    );
    assert.match(records, new RegExp(`^release\\tverifier-sha256\\t${verifierHash}$`, 'm'));
    for (const service of services) {
      assert.match(
        records,
        new RegExp(
          `^image\\t${service.replace('-', '\\-')}\\tghcr\\.io/yaojingang/tokems-production-private@sha256:[0-9]+$`,
          'm',
        ),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release descriptor verifier rejects partial, drifting, and non-atomic descriptors', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-release-descriptor-invalid-'));
  const labelsFile = resolve(directory, 'labels.json');
  try {
    const cases = [
      [
        'missing service',
        (() => {
          const labels = descriptorLabels();
          delete labels['com.tokems.release.image.worker'];
          return labels;
        })(),
        /exactly the six supported service images/i,
      ],
      [
        'wrong source sha',
        descriptorLabels({ 'org.opencontainers.image.revision': 'c'.repeat(40) }),
        /revision/i,
      ],
      [
        'wrong platform',
        descriptorLabels({ 'com.tokems.release.platform': 'linux/arm64' }),
        /platform/i,
      ],
      [
        'duplicate digest',
        descriptorLabels({
          'com.tokems.release.image.worker':
            'ghcr.io/yaojingang/tokems-production-private@sha256:' + '1'.repeat(64),
        }),
        /unique digest/i,
      ],
      [
        'legacy public package',
        descriptorLabels({
          'com.tokems.release.image.worker': 'ghcr.io/yaojingang/tokems@sha256:' + '8'.repeat(64),
        }),
        /private TokEMS package/i,
      ],
      [
        'legacy dedicated package',
        descriptorLabels({
          'com.tokems.release.image.worker':
            'ghcr.io/yaojingang/tokems-production@sha256:' + '8'.repeat(64),
        }),
        /private TokEMS package/i,
      ],
      [
        'extra service',
        descriptorLabels({
          'com.tokems.release.image.debug':
            'ghcr.io/yaojingang/tokems-production-private@sha256:' + '9'.repeat(64),
        }),
        /exactly the six supported service images/i,
      ],
      [
        'invalid calendar time',
        descriptorLabels({
          'org.opencontainers.image.created': '2026-99-02T04:05:06Z',
          'com.tokems.build.time': '2026-99-02T04:05:06Z',
        }),
        /valid calendar time/i,
      ],
      [
        'missing source bundle hash',
        (() => {
          const labels = descriptorLabels();
          delete labels['com.tokems.release.source-bundle.sha256'];
          return labels;
        })(),
        /source bundle/i,
      ],
      [
        'wrong source bundle ref',
        descriptorLabels({
          'com.tokems.release.source-bundle.ref': 'refs/heads/attacker',
        }),
        /source bundle ref/i,
      ],
    ];

    for (const [name, labels, expected] of cases) {
      writeFileSync(labelsFile, JSON.stringify(labels));
      const result = runVerifier([
        'verify-descriptor',
        '--labels-file',
        labelsFile,
        '--target-sha',
        sha,
        '--platform',
        platform,
      ]);
      assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
      assert.match(result.stderr, expected, name);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source bundle verifier accepts the exact release ref and rejects wrong or corrupt bundles', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-source-bundle-'));
  const repository = resolve(directory, 'repository');
  const bundle = resolve(directory, 'source.bundle');
  const corruptedBundle = resolve(directory, 'source-corrupt.bundle');
  const runGit = (args) => spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  try {
    assert.equal(spawnSync('git', ['init', repository], { encoding: 'utf8' }).status, 0);
    assert.equal(runGit(['config', 'user.name', 'TokEMS Test']).status, 0);
    assert.equal(runGit(['config', 'user.email', 'tokems-test@example.invalid']).status, 0);
    writeFileSync(resolve(repository, 'release.txt'), 'verified source\n');
    assert.equal(runGit(['add', 'release.txt']).status, 0);
    assert.equal(runGit(['commit', '-m', 'release source']).status, 0);
    const targetSha = runGit(['rev-parse', 'HEAD']).stdout.trim();
    assert.match(targetSha, /^[0-9a-f]{40}$/);
    assert.equal(runGit(['update-ref', 'refs/heads/tokems-release-source', targetSha]).status, 0);
    const created = runGit(['bundle', 'create', bundle, 'refs/heads/tokems-release-source']);
    assert.equal(created.status, 0, created.stderr);

    const accepted = runVerifier([
      'verify-source-bundle',
      '--bundle-file',
      bundle,
      '--target-sha',
      targetSha,
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);

    const wrongSha = runVerifier([
      'verify-source-bundle',
      '--bundle-file',
      bundle,
      '--target-sha',
      'f'.repeat(40),
    ]);
    assert.notEqual(wrongSha.status, 0);
    assert.match(wrongSha.stderr, /target/i);

    const bundleBytes = readFileSync(bundle);
    writeFileSync(corruptedBundle, bundleBytes.subarray(0, Math.max(1, bundleBytes.length - 32)));
    const corrupted = runVerifier([
      'verify-source-bundle',
      '--bundle-file',
      corruptedBundle,
      '--target-sha',
      targetSha,
    ]);
    assert.notEqual(corrupted.status, 0);
    assert.match(corrupted.stderr, /bundle/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source bundle importer fast-forwards only origin/main and leaves production HEAD untouched', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-source-import-'));
  const sourceRepository = resolve(directory, 'source');
  const productionRepository = resolve(directory, 'production');
  const unrelatedRepository = resolve(directory, 'unrelated');
  const bundle = resolve(directory, 'source.bundle');
  const unrelatedBundle = resolve(directory, 'unrelated.bundle');
  const runGit = (repository, args) =>
    spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  try {
    assert.equal(
      spawnSync('git', ['init', '--initial-branch=main', sourceRepository], {
        encoding: 'utf8',
      }).status,
      0,
    );
    assert.equal(runGit(sourceRepository, ['config', 'user.name', 'TokEMS Test']).status, 0);
    assert.equal(
      runGit(sourceRepository, ['config', 'user.email', 'tokems-test@example.invalid']).status,
      0,
    );
    writeFileSync(resolve(sourceRepository, 'release.txt'), 'base\n');
    assert.equal(runGit(sourceRepository, ['add', 'release.txt']).status, 0);
    assert.equal(runGit(sourceRepository, ['commit', '-m', 'base']).status, 0);
    const baseSha = runGit(sourceRepository, ['rev-parse', 'HEAD']).stdout.trim();

    const cloned = spawnSync('git', ['clone', sourceRepository, productionRepository], {
      encoding: 'utf8',
    });
    assert.equal(cloned.status, 0, cloned.stderr);
    assert.equal(runGit(productionRepository, ['branch', '-m', 'production']).status, 0);

    writeFileSync(resolve(sourceRepository, 'release.txt'), 'target\n');
    assert.equal(runGit(sourceRepository, ['add', 'release.txt']).status, 0);
    assert.equal(runGit(sourceRepository, ['commit', '-m', 'target']).status, 0);
    const targetSha = runGit(sourceRepository, ['rev-parse', 'HEAD']).stdout.trim();
    assert.equal(
      runGit(sourceRepository, ['update-ref', 'refs/heads/tokems-release-source', targetSha])
        .status,
      0,
    );
    const created = runGit(sourceRepository, [
      'bundle',
      'create',
      bundle,
      'refs/heads/tokems-release-source',
    ]);
    assert.equal(created.status, 0, created.stderr);

    const imported = runVerifier([
      'import-source-bundle',
      '--bundle-file',
      bundle,
      '--repository',
      productionRepository,
      '--target-sha',
      targetSha,
      '--timeout-seconds',
      '30',
    ]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(
      runGit(productionRepository, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim(),
      targetSha,
    );
    assert.equal(runGit(productionRepository, ['rev-parse', 'HEAD']).stdout.trim(), baseSha);
    assert.equal(runGit(productionRepository, ['status', '--porcelain']).stdout, '');

    assert.equal(
      runGit(productionRepository, ['update-ref', 'refs/tokems-deploy/source-candidate', targetSha])
        .status,
      0,
    );
    const concurrentImport = runVerifier([
      'import-source-bundle',
      '--bundle-file',
      bundle,
      '--repository',
      productionRepository,
      '--target-sha',
      targetSha,
      '--timeout-seconds',
      '30',
    ]);
    assert.notEqual(concurrentImport.status, 0);
    assert.match(concurrentImport.stderr, /reserved source candidate ref already exists/i);
    assert.equal(
      runGit(productionRepository, ['update-ref', '-d', 'refs/tokems-deploy/source-candidate'])
        .status,
      0,
    );

    assert.equal(
      spawnSync('git', ['init', '--initial-branch=main', unrelatedRepository], {
        encoding: 'utf8',
      }).status,
      0,
    );
    assert.equal(runGit(unrelatedRepository, ['config', 'user.name', 'TokEMS Test']).status, 0);
    assert.equal(
      runGit(unrelatedRepository, ['config', 'user.email', 'tokems-test@example.invalid']).status,
      0,
    );
    writeFileSync(resolve(unrelatedRepository, 'unrelated.txt'), 'unrelated\n');
    assert.equal(runGit(unrelatedRepository, ['add', 'unrelated.txt']).status, 0);
    assert.equal(runGit(unrelatedRepository, ['commit', '-m', 'unrelated']).status, 0);
    const unrelatedSha = runGit(unrelatedRepository, ['rev-parse', 'HEAD']).stdout.trim();
    assert.equal(
      runGit(unrelatedRepository, ['update-ref', 'refs/heads/tokems-release-source', unrelatedSha])
        .status,
      0,
    );
    assert.equal(
      runGit(unrelatedRepository, [
        'bundle',
        'create',
        unrelatedBundle,
        'refs/heads/tokems-release-source',
      ]).status,
      0,
    );
    const rejected = runVerifier([
      'import-source-bundle',
      '--bundle-file',
      unrelatedBundle,
      '--repository',
      productionRepository,
      '--target-sha',
      unrelatedSha,
      '--timeout-seconds',
      '30',
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /cannot fast-forward/i);
    assert.equal(
      runGit(productionRepository, [
        'show-ref',
        '--verify',
        '--quiet',
        'refs/tokems-deploy/source-candidate',
      ]).status,
      1,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('service image verifier checks platform, service, source, and all build identity fields', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-release-image-'));
  const metadataFile = resolve(directory, 'image.json');
  const labels = {
    'org.opencontainers.image.source': 'https://github.com/yaojingang/TokEMS',
    'org.opencontainers.image.revision': sha,
    'org.opencontainers.image.created': buildTime,
    'com.tokems.service': 'api',
    'com.tokems.build.sha': sha,
    'com.tokems.build.time': buildTime,
    'com.tokems.build.migration': '0054_example.sql',
    'com.tokems.build.migration-hash': migrationHash,
  };
  try {
    writeFileSync(
      metadataFile,
      JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: labels } }),
    );
    const baseArgs = [
      'verify-service',
      '--metadata-file',
      metadataFile,
      '--service',
      'api',
      '--target-sha',
      sha,
      '--build-time',
      buildTime,
      '--migration',
      '0054_example.sql',
      '--migration-hash',
      migrationHash,
      '--platform',
      platform,
    ];
    const accepted = runVerifier(baseArgs);
    assert.equal(accepted.status, 0, accepted.stderr);

    labels['com.tokems.service'] = 'worker';
    writeFileSync(
      metadataFile,
      JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: labels } }),
    );
    const rejected = runVerifier(baseArgs);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /service/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
