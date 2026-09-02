import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = resolve(repositoryRoot, '.github/workflows/publish-images.yml');
const source = readFileSync(workflowPath, 'utf8');
const descriptorDockerfile = readFileSync(
  resolve(repositoryRoot, 'tooling/release-descriptor.Dockerfile'),
  'utf8',
);

test('image publication starts only after the official main CI workflow succeeds', () => {
  assert.match(source, /^name: tokems-image-publish$/m);
  assert.match(source, /workflow_run:/);
  assert.match(source, /workflows: \[tokems-ci\]/);
  assert.match(source, /types: \[completed\]/);
  for (const gate of [
    "workflow_run.event != 'push'",
    "workflow_run.head_branch != 'main'",
    "workflow_run.status != 'completed'",
    "workflow_run.conclusion != 'success'",
    'workflow_run.repository.full_name != expected_repository',
    'workflow_run.head_repository.full_name != expected_repository',
    "os.environ.get('WORKFLOW_SHA') != workflow_run.head_sha",
  ]) {
    assert.ok(source.includes(gate), `missing workflow trust gate: ${gate}`);
  }
  assert.match(source, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(source, /cancel-in-progress: false/);
});

test('workflow source guard rejects untrusted workflow_run payloads', () => {
  const match = source.match(/python3 - <<'PY'\n([\s\S]*?)\n {10}PY/);
  assert.ok(match, 'workflow_run source guard was not found');
  const targetSha = 'a'.repeat(40);
  const valid = {
    event: 'push',
    head_branch: 'main',
    head_sha: targetSha,
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: 'yaojingang/TokEMS' },
    head_repository: { full_name: 'yaojingang/TokEMS' },
  };
  const run = (payload, platform = 'linux/amd64') =>
    spawnSync('python3', ['-'], {
      encoding: 'utf8',
      input: match[1].replace(/^ {10}/gm, ''),
      env: {
        ...process.env,
        EXPECTED_REPOSITORY: 'yaojingang/TokEMS',
        TARGET_SHA: targetSha,
        WORKFLOW_SHA: targetSha,
        PRODUCTION_PLATFORM: platform,
        WORKFLOW_RUN_JSON: JSON.stringify(payload),
      },
    });

  assert.equal(run(valid).status, 0);
  for (const [field, value] of [
    ['event', 'pull_request'],
    ['head_branch', 'feature'],
    ['status', 'in_progress'],
    ['conclusion', 'failure'],
  ]) {
    assert.notEqual(run({ ...valid, [field]: value }).status, 0, `${field} drift passed`);
  }
  assert.notEqual(run({ ...valid, head_repository: { full_name: 'attacker/TokEMS' } }).status, 0);
  assert.notEqual(run(valid, 'linux/riscv64').status, 0);
  const staleWorkflow = spawnSync('python3', ['-'], {
    encoding: 'utf8',
    input: match[1].replace(/^ {10}/gm, ''),
    env: {
      ...process.env,
      EXPECTED_REPOSITORY: 'yaojingang/TokEMS',
      TARGET_SHA: targetSha,
      WORKFLOW_SHA: 'b'.repeat(40),
      PRODUCTION_PLATFORM: 'linux/amd64',
      WORKFLOW_RUN_JSON: JSON.stringify(valid),
    },
  });
  assert.notEqual(staleWorkflow.status, 0);
});

test('image publication uses an explicit production platform and immutable release identity', () => {
  assert.match(source, /PRODUCTION_PLATFORM: \$\{\{ vars\.PRODUCTION_PLATFORM \}\}/);
  assert.match(source, /linux\/(amd64|arm64)/);
  assert.doesNotMatch(source, /PRODUCTION_PLATFORM:-linux\/amd64/);
  for (const service of ['api', 'worker', 'web', 'admin', 'gateway', 'notification-sink']) {
    assert.match(source, new RegExp(`- ${service.replace('-', '\\-')}`));
  }
  assert.match(
    source,
    /\$\{\{ matrix\.service \}\}-\$\{\{ needs\.guard\.outputs\.target_sha \}\}-\$\{\{ github\.run_id \}\}/,
  );
  assert.match(source, /release-\$\{TARGET_SHA\}/);
  assert.match(source, /Refusing to overwrite the immutable release descriptor/);
  assert.match(source, /TokEMS GHCR package must remain private/);
  assert.match(source, /Unable to establish TokEMS GHCR package visibility before publication/);
  assert.doesNotMatch(source, /package_visibility=.*gh api[^\n]+\|\| true/);
  assert.match(source, /docker buildx imagetools create/);
  assert.match(source, /--prefer-index=false/);
  assert.match(source, /final_digest.*steps\.descriptor\.outputs\.digest/s);
  assert.match(source, /descriptor_ref="\$\{GHCR_PACKAGE\}@\$\{descriptor_digest\}"/);
  assert.match(
    source,
    /imagetools inspect --format '\{\{json \.Image\.Config\.Labels\}\}' "\$descriptor_ref"/,
  );
  assert.ok(
    source.indexOf('Attest release descriptor provenance') <
      source.indexOf('Publish the immutable release descriptor last'),
    'the final release tag must appear only after descriptor attestation',
  );
  assert.match(descriptorDockerfile, /com\.tokems\.release\.image\.notification-sink/);
  assert.match(
    descriptorDockerfile,
    /COPY --from=release source\.bundle \/release\/source\.bundle/,
  );
  assert.match(
    descriptorDockerfile,
    /COPY tooling\/release-descriptor\.py \/release\/release-descriptor\.py/,
  );
  assert.match(descriptorDockerfile, /com\.tokems\.release\.source-bundle\.sha256/);
  assert.match(descriptorDockerfile, /com\.tokems\.release\.verifier\.sha256/);
  assert.match(source, /source_ref='refs\/heads\/tokems-release-source'/);
  assert.match(source, /git bundle create "\$bundle_file" "\$source_ref"/);
  assert.match(source, /git bundle verify/);
  assert.match(source, /fetch-depth: 0/);
  assert.match(
    source,
    /build-contexts:[\s\S]*release=\$\{\{ runner\.temp \}\}\/tokems-release-context/,
  );
  assert.match(source, /SOURCE_BUNDLE_SHA256=\$\{\{ steps\.source\.outputs\.bundle_sha256 \}\}/);
  assert.match(source, /VERIFIER_SHA256=\$\{\{ steps\.source\.outputs\.verifier_sha256 \}\}/);
  assert.match(source, /sha256sum tooling\/release-descriptor\.py/);
  assert.doesNotMatch(source, /python3 "\$payload_dir\/release-descriptor\.py"/);
});

test('every service and the descriptor receive GitHub provenance', () => {
  assert.match(source, /permissions:[\s\S]*packages: write/);
  assert.match(source, /permissions:[\s\S]*id-token: write/);
  assert.match(source, /permissions:[\s\S]*attestations: write/);
  assert.ok(
    source.match(/actions\/attest-build-provenance@[0-9a-f]{40}/g)?.length >= 2,
    'service images and the release descriptor must both be attested',
  );
  assert.match(source, /gh attestation verify/);
  assert.match(source, /--source-digest "\$TARGET_SHA"/);
  assert.match(source, /--source-ref refs\/heads\/main/);
  assert.match(source, /--deny-self-hosted-runners/);
  assert.doesNotMatch(source, /uses: [^\n]+@(v|main|master)(?:\d|\b)/);
});
