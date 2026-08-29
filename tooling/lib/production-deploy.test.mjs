import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = resolve(repositoryRoot, 'tooling/production-deploy.sh');
const source = readFileSync(scriptPath, 'utf8');
const workerSource = readFileSync(resolve(repositoryRoot, 'apps/worker/src/main.ts'), 'utf8');
const dockerfileSource = readFileSync(resolve(repositoryRoot, 'Dockerfile'), 'utf8');

test('production deploy script has valid Bash syntax and a read-only help path', () => {
  const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const help = spawnSync('bash', [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /production-deploy\.sh check/);
  assert.match(help.stdout, /production-deploy\.sh deploy/);
  assert.match(help.stdout, /production-deploy\.sh repair-identity/);
  assert.match(help.stdout, /production-deploy\.sh recover-interrupted/);
  assert.match(help.stdout, /production-deploy\.sh resolve-recovery/);
  assert.match(help.stdout, /--resume-recovery/);
  assert.match(help.stdout, /default canonical mode is automatic/);

  const modeHelp = spawnSync('bash', [scriptPath, 'check', '--help'], { encoding: 'utf8' });
  assert.equal(modeHelp.status, 0, modeHelp.stderr);
  assert.match(modeHelp.stdout, /complete read-only production preflight/);

  const missingMode = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
  assert.equal(missingMode.status, 2);

  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-production-install-'));
  const installedPath = resolve(directory, 'tokems-deploy');
  try {
    copyFileSync(scriptPath, installedPath);
    chmodSync(installedPath, 0o755);
    const installedHelp = spawnSync(installedPath, ['--help'], { encoding: 'utf8' });
    assert.equal(installedHelp.status, 0, installedHelp.stderr);
    assert.match(installedHelp.stdout, /TokEMS production deployment/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('forced canonical sync reuses a compatible runtime without building images', () => {
  const help = spawnSync('bash', [scriptPath, 'deploy', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--sync-canonical/);

  const preflight = source.slice(
    source.indexOf('run_full_preflight() {'),
    source.indexOf('\ncapture_business_snapshot() {'),
  );
  assert.match(preflight, /canonical_repair_scope_is_compatible/);
  assert.match(
    preflight,
    /if \[\[ "\$canonical_sync_required" == 'true' \]\] && canonical_repair_scope_is_compatible; then[\s\S]*?canonical_repair_mode='true'[\s\S]*?else[\s\S]*?assert_build_capacity/,
  );

  const repair = source.slice(
    source.indexOf('run_canonical_repair_release() {'),
    source.indexOf('\nwrite_success_summary() {'),
  );
  assert.ok(repair.length > 0, 'canonical repair workflow was not found');
  const steps = [
    'create_backup_and_rollback_point',
    'sync_source',
    'enter_release_write_freeze',
    'refresh_pre_mutation_database_backup',
    'run_canonical_database_sync',
    'start_canonical_read_only_verification',
    'verify_release',
    'thaw_release_write_freeze',
    'write_success_summary',
  ];
  let previous = -1;
  for (const step of steps) {
    const current = repair.indexOf(step);
    assert.ok(current > previous, `${step} must follow the preceding canonical repair step`);
    previous = current;
  }
  assert.doesNotMatch(repair, /write_build_identity|build_images|switch_services/);

  const main = source.slice(source.indexOf('\nmain() {'));
  assert.match(
    main,
    /if \[\[ "\$canonical_repair_mode" == 'true' \]\]; then\n\s+run_canonical_repair_release\n\s+return 0\n\s+fi/,
  );
});

test('production deploy script pins the documented topology and release gates', () => {
  for (const required of [
    "readonly APP_DIR='/www/wwwroot/TokEMS'",
    "readonly BACKUP_ROOT='/www/backup/TokEMS'",
    "readonly GIT_USER='ecs-user'",
    "readonly EXPECTED_ORIGIN='https://github.com/yaojingang/TokEMS.git'",
    "readonly EXPECTED_BRANCH='production'",
    "readonly EXPECTED_UPSTREAM='origin/main'",
    "readonly CANONICAL_ORGANIZATION_SLUG='geo-conference'",
    "readonly CANONICAL_EVENT_SLUG='tokems26'",
    'MIN_BUILD_CAPACITY_KIB=10485760',
    'quality-and-flows',
    'merge_commit_sha',
    'GIT_NO_REPLACE_OBJECTS=1',
    'GIT_CONFIG_GLOBAL=/dev/null',
    "PRODUCTION_ENV_FILE='/etc/tokems/production.env'",
    'GIT_TERMINAL_PROMPT=0',
    'GIT_FETCH_TIMEOUT_SECONDS=180',
    'BUILD_TIMEOUT_SECONDS=3600',
    "LOCAL_DOCKER_HOST='unix:///var/run/docker.sock'",
    '--project-name "$COMPOSE_PROJECT"',
    '-f "$active_compose_file"',
    'COMPOSE_PARALLEL_LIMIT=1',
    'SEED_DEMO_DATA=false',
    'SEED_DEMO_DATA=true',
    'assert_current_runtime_identity',
    'assert_no_parallel_release',
    'assert_standard_release_scope',
    "docker info --format '{{.DockerRootDir}}'",
    'MIN_BACKUP_RESERVE_KIB=4194304',
    'protected-business-ids-before.csv',
    'protected-business-ids-after.csv',
    'TOKEMS_COMPATIBILITY_ROLLBACK',
    'automatic-rollback-health.json',
    'repair_runtime_identity',
    'identity-repair-result.txt',
    'assert_unique_production_env_keys',
    'assert_api_uses_compose_database',
    'system_identifier',
    'enter_release_write_freeze',
    'refresh_pre_mutation_database_backup',
    'default_transaction_read_only=on',
    'thaw_release_write_freeze',
    'connectionTimeoutMillis: 10000',
    'statement_timeout: 10000',
    'query_timeout: 10000',
    'timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker exec',
    '--kill-after=10s',
    'SERVICE_TRANSITION_TIMEOUT_SECONDS=360',
    'WORKER_READY_TIMEOUT_SECONDS=2400',
    'tokems-worker-ready.json',
    'assert_final_backup_capacity',
    'assert_release_verification_capacity',
    'assert_post_thaw_evidence_capacity',
    'DATA_COMPARE_MAX_VIRTUAL_KIB=262144',
    'assert_ordered_subsequence',
    'RECOVERY_REQUIRED',
    'arm_release_recovery_marker',
    'failed-release-database-state-pending',
    'production-protection-cutoff.txt',
    'retention-managed-ids-before.csv',
    'assert_pending_recovery_policy',
    'assert_operational_write_state',
    'deploy --resume-recovery',
    'resolve_pending_recovery',
    'recover_interrupted_release',
    "release_phase='pre-write'",
    'docker-compose.thaw-guard.yml',
    'start_thaw_watchdog',
    'compare_production_data recovery-resolve "$baseline_phase"',
    'canonical-homepage.public.resolved-runtime.json',
    'recovery-resolve-result.txt',
    'cp -a -- "$read_only_compose_file" "$backup_dir/docker-compose.read-only.yml"',
    'automatic-rollback-migration-state.txt',
    'automatic-rollback-target-writes-state.txt',
    'automatic-rollback-canonical-state.txt',
    'manual_review=required',
    'writes=read-only-api-and-paused-worker',
    '--no-deps',
    '--connect-timeout 10',
    '--max-time 60',
    'public homepage content does not match the canonical public snapshot',
  ]) {
    assert.ok(source.includes(required), `missing production gate: ${required}`);
  }
});

test('production deploy workflow creates recovery evidence before mutation and verifies after switch', () => {
  const mainStart = source.indexOf('\nmain() {');
  assert.ok(mainStart >= 0, 'top-level main function was not found');
  const main = source.slice(mainStart);
  const steps = [
    'run_full_preflight',
    'create_backup_and_rollback_point',
    'sync_source',
    'write_build_identity',
    'build_images',
    'enter_release_write_freeze',
    'refresh_pre_mutation_database_backup',
    'run_database_updates',
    'switch_services',
    'verify_release',
    'thaw_release_write_freeze',
    'write_success_summary',
  ];
  let previous = -1;
  for (const step of steps) {
    const current = main.indexOf(step);
    assert.ok(current > previous, `${step} must follow the preceding release step`);
    previous = current;
  }

  assert.match(source, /restore_application_rollback/);
  assert.match(source, /conference\.dump/);
  assert.match(source, /conference-build-start\.dump/);
  assert.match(source, /rollback-/);
  assert.match(source, /Production business counts and sold values were preserved/);
  assert.match(source, /protected production records disappeared/);
  assert.match(source, /Database advanced during the failed release/);
  assert.match(source, /canonical_update_started='true'/);
  assert.match(source, /canonical-homepage\.public\.before\.json/);
  assert.match(source, /business-counts-post-thaw\.csv/);
  assert.match(source, /compare_production_data post-thaw/);
  assert.match(source, /write_pending_recovery_marker 'release-pre-write-armed'/);
  assert.doesNotMatch(source, /return \{tuple\(row\) for row/);
  assert.match(
    source,
    /enter_release_write_freeze\n\s+refresh_pre_mutation_database_backup\n\s+run_database_updates/,
  );
});

test('production deploy protects durable and retention-managed business identity classes', () => {
  for (const table of [
    'organizations',
    'events',
    'users',
    'customer_users',
    'public_user_ids',
    'customer_profiles',
    'customer_media_assets',
    'customer_consents',
    'memberships',
    'member_profiles',
    'organization_integrations',
    'organization_invitations',
    'registrations',
    'orders',
    'order_state_logs',
    'inventory_reservations',
    'payments',
    'payment_notification_inbox',
    'refunds',
    'invoice_requests',
    'invoice_documents',
    'order_access_tokens',
    'tickets',
    'checkin_devices',
    'checkin_records',
    'cooperation_requests',
    'waitlist_entries',
    'notification_deliveries',
    'ai_runs',
    'template_ai_mapping_actions',
    'outbox_events',
    'audit_logs',
    'agent_connections',
    'agent_operations',
  ]) {
    assert.match(
      source,
      new RegExp(`\\('stable', '${table}',`),
      `missing stable protected IDs for ${table}`,
    );
  }
  for (const table of [
    'customer_auth_challenges',
    'customer_sessions',
    'idempotency_keys',
    'order_access_link_attempts',
    'agent_device_authorizations',
    'agent_refresh_tokens',
  ]) {
    assert.match(
      source,
      new RegExp(`\\('retention', '${table}',`),
      `missing retention evidence for ${table}`,
    );
  }
  assert.doesNotMatch(source, /\('stable', 'speaker_public_routes',/);
  assert.doesNotMatch(source, /create temp table protected_release_ids/);
  assert.match(source, /order by %s;'/);
});

test('production data comparison streams ordered IDs and rejects a missing protected record', () => {
  const match = source.match(/compare_production_data\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/);
  assert.ok(match, 'production data comparison Python program was not found');
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-production-compare-'));
  const files = Array.from({ length: 8 }, (_, index) => resolve(directory, `${index}.csv`));
  try {
    writeFileSync(files[0], 'orders,2\n');
    writeFileSync(files[1], 'orders,3\n');
    writeFileSync(files[2], 'orders,hex-999\norders,hex-1000\n');
    writeFileSync(
      files[3],
      'orders,hex-added-before\norders,hex-999\norders,hex-added-middle\norders,hex-1000\n',
    );
    for (const index of [4, 5, 6, 7]) writeFileSync(files[index], 'ticket,1\n');

    const accepted = spawnSync('python3', ['-', 'growth', ...files], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.equal(accepted.status, 0, accepted.stderr);

    for (const index of [2, 3, 4, 5, 6, 7]) writeFileSync(files[index], '');
    const acceptedEmptySets = spawnSync('python3', ['-', 'growth', ...files], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.equal(acceptedEmptySets.status, 0, acceptedEmptySets.stderr);

    writeFileSync(files[2], 'orders,hex-999\norders,hex-1000\n');
    writeFileSync(files[3], 'orders,hex-999\norders,hex-added-after\n');
    const rejected = spawnSync('python3', ['-', 'growth', ...files], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /protected production records disappeared/);

    writeFileSync(files[1], 'orders,2\n');
    writeFileSync(files[2], 'orders,hex-999\norders,hex-1000\n');
    writeFileSync(files[3], 'orders,hex-999\norders,hex-added\norders,hex-1000\n');
    const exactRejected = spawnSync('python3', ['-', 'exact', ...files], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.notEqual(exactRejected.status, 0);
    assert.match(exactRejected.stderr, /record identities changed during the write freeze/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical data comparison permits only snapshot-declared rows with zero new sales', () => {
  const match = source.match(/compare_production_data\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/);
  assert.ok(match, 'production data comparison Python program was not found');
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-canonical-compare-'));
  const files = Array.from({ length: 8 }, (_, index) => resolve(directory, `${index}.csv`));
  const snapshotFile = resolve(directory, 'snapshot.json');
  const encoded = (value) => Buffer.from(JSON.stringify([value]), 'utf8').toString('hex');
  const targetRelease = 'release-target';
  const targetVersion = 'version-target';
  const targetTicket = 'ticket-target';
  const targetQuota = 'quota-target';
  try {
    writeFileSync(files[0], 'orders,1\n');
    writeFileSync(files[1], 'orders,1\n');
    writeFileSync(
      files[2],
      [
        `conference_template_versions,${encoded('version-old')}`,
        `event_releases,${encoded('release-old')}`,
        `organizations,${encoded('organization-old')}`,
      ].join('\n') + '\n',
    );
    writeFileSync(
      files[3],
      [
        `conference_template_versions,${encoded('version-old')}`,
        `conference_template_versions,${encoded(targetVersion)}`,
        `event_releases,${encoded('release-old')}`,
        `event_releases,${encoded(targetRelease)}`,
        `organizations,${encoded('organization-old')}`,
      ].join('\n') + '\n',
    );
    writeFileSync(files[4], 'ticket-old,5\n');
    writeFileSync(files[5], `ticket-old,5\n${targetTicket},0\n`);
    writeFileSync(files[6], 'quota-old,7\n');
    writeFileSync(files[7], `quota-old,7\n${targetQuota},0\n`);
    writeFileSync(
      snapshotFile,
      JSON.stringify({
        release: { id: targetRelease },
        template: { publishedVersions: [{ id: targetVersion }] },
        backend: { ticketTypes: [{ id: targetTicket }] },
        ticketQuotas: [{ id: targetQuota }],
      }),
    );

    const accepted = spawnSync('python3', ['-', 'canonical', ...files, snapshotFile], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.equal(accepted.status, 0, accepted.stderr);

    writeFileSync(files[5], `ticket-old,5\n${targetTicket},1\n`);
    const soldRejected = spawnSync('python3', ['-', 'canonical', ...files, snapshotFile], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.notEqual(soldRejected.status, 0);
    assert.match(soldRejected.stderr, /zero sold inventory/);

    writeFileSync(files[5], `ticket-old,5\n${targetTicket},0\n`);
    writeFileSync(
      files[3],
      readFileSync(files[3], 'utf8') + `organizations,${encoded('organization-unexpected')}\n`,
    );
    const identityRejected = spawnSync('python3', ['-', 'canonical', ...files, snapshotFile], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.notEqual(identityRejected.status, 0);
    assert.match(identityRejected.stderr, /identities changed for organizations/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('protected rollback blocks writes and persists recovery before database evidence queries', () => {
  const rollback = source.slice(
    source.indexOf('restore_application_rollback() {'),
    source.indexOf('\non_exit() {'),
  );
  const marker = rollback.indexOf(
    "write_pending_recovery_marker 'failed-release-database-state-pending'",
  );
  const stop = rollback.indexOf('compose_bounded 60 stop --timeout 30 api worker');
  const databaseRead = rollback.indexOf('read_database_migration_hash');
  assert.ok(marker >= 0 && marker < databaseRead, 'recovery marker must precede database evidence');
  assert.ok(stop >= 0 && stop < databaseRead, 'write stop must precede database evidence');

  const enterFreeze = source.slice(
    source.indexOf('enter_release_write_freeze() {'),
    source.indexOf('\nthaw_release_write_freeze() {'),
  );
  assert.ok(
    enterFreeze.indexOf('arm_release_recovery_marker') <
      enterFreeze.indexOf('compose_bounded 60 stop --timeout 30 api worker'),
    'persistent recovery must be armed before the write freeze transition',
  );
  const main = source.slice(source.indexOf('main() {'));
  assert.ok(
    main.indexOf('enter_release_write_freeze') < main.indexOf('run_database_updates'),
    'the armed write freeze must precede database updates',
  );
});

test('worker publishes a persistent release identity only after startup maintenance', () => {
  const readyWrite = workerSource.indexOf('writeFile(workerReadyTempFile');
  const readyLog = workerSource.indexOf('`[worker] ready queue=');
  assert.ok(readyWrite >= 0 && readyWrite < readyLog);
  const firstConsumerStart = workerSource.indexOf('const workerRun = worker.run()');
  const finalStartupMaintenance = workerSource.indexOf('await maintainFeishuDigests()');
  assert.ok(finalStartupMaintenance >= 0 && finalStartupMaintenance < firstConsumerStart);
  assert.equal(workerSource.match(/autorun: false/g)?.length, 2);
  assert.match(workerSource, /Promise\.all\(\[worker\.waitUntilReady\(\), htmlImportWorker\.waitUntilReady\(\)\]\)/);
  assert.match(workerSource, /rename\(workerReadyTempFile, workerReadyFile\)/);
  assert.match(workerSource, /unlink\(workerReadyFile\)/);
  assert.match(source, /fs\.readFileSync\('\/tmp\/tokems-worker-ready\.json'/);
  assert.match(dockerfileSource, /com\.tokems\.worker-ready-protocol="1"/);
  assert.match(source, /com\.tokems\.worker-ready-protocol/);
  assert.doesNotMatch(source, /git_as_owner show "\$\{runtime_sha\}:apps\/worker\/src\/main\.ts"/);
});

test('rollback keeps the immutable pre-release identity after target verification', () => {
  const rollback = source.slice(
    source.indexOf('restore_application_rollback() {'),
    source.indexOf('\non_exit() {'),
  );
  assert.match(rollback, /release_baseline_migration_hash/);
  assert.match(rollback, /release_baseline_code_migration_hash/);
  assert.doesNotMatch(rollback, /current_database_hash" != "\$runtime_migration_hash/);
  const success = source.slice(
    source.indexOf('write_success_summary() {'),
    source.indexOf('\nmain() {'),
  );
  assert.match(success, /release_baseline_sha/);
  assert.doesNotMatch(success, /"\$runtime_sha"/);
});

test('target pinning is shared by every mode and recovery verifies the public API', () => {
  assert.ok(
    source.match(/assert_target_selection "\$target_sha"/g)?.length >= 3,
    'target selection must be rechecked by deploy, repair, and recovery modes',
  );
  assert.match(source, /public-health-recovery-resolve\.json/);
  assert.match(source, /assert_health_json <"\$pending_recovery_backup_dir\/public-health-recovery-resolve\.json"/);
});

test('root deployment pins Docker Compose and trusts only protected recovery paths', () => {
  assert.match(source, /umask 077/);
  assert.match(source, /export DOCKER_HOST="\$LOCAL_DOCKER_HOST"/);
  assert.match(source, /unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES/);
  assert.match(source, /--project-name "\$COMPOSE_PROJECT"/);
  assert.match(source, /--project-directory "\$APP_DIR"/);
  assert.match(source, /--env-file "\$active_env_file"/);
  assert.match(source, /assert_trusted_release_directory "\$pending_recovery_backup_dir"/);
  assert.match(source, /env -i "PATH=\$SAFE_PATH" 'HOME=\/root'/);
  assert.match(source, /snapshot_production_environment/);
  assert.match(source, /git_as_owner archive --format=tar "\$target_sha"/);
  assert.match(source, /docker-compose\.build-context\.yml/);
  assert.match(source, /Recovery backup directory must be an immediate child/);
  assert.match(source, /Recovery evidence must be owned by root with mode 600/);
  assert.match(source, /Git replacement references are forbidden/);
  assert.match(source, /readlink -f \/proc\/\$\$\/fd\/9/);
  assert.doesNotMatch(source, /TOKEMS_DEPLOY_LOCK_HELD|TOKEMS_DEPLOY_BOOTSTRAPPED|TOKEMS_RECOVERY_BOOTSTRAPPED/);
  assert.doesNotMatch(source, /"\$APP_DIR\/\.env"|"\$\{APP_DIR\}\/\.env"/);
  for (const key of [
    'PUBLIC_ORIGIN',
    'ADMIN_ORIGIN',
    'PAYMENT_PUBLIC_ORIGIN',
    'PAYMENT_PUBLIC_BASE_PATH',
    'PAYMENT_PUBLIC_URL',
    'CUSTOMER_OTP_MODE',
    'ALLOW_INSECURE_LOCAL_AUTH',
    'VITE_SIMPLE_AUTH',
    'ENABLE_LOCAL_PAYMENT_SIMULATION',
  ]) {
    assert.match(source, new RegExp(`env_value ${key}`), `missing fixed production gate for ${key}`);
  }
});

test('public release verification proves the deployed web bundle and document', () => {
  assert.match(source, /public-web-version-after\.json/);
  assert.match(source, /build_fingerprint_from_stdin web <"\$backup_dir\/public-web-version-after\.json"/);
  assert.match(source, /public-homepage-document-after\.html/);
  assert.match(source, /Public web bundle does not match/);
});

test('target-schema protected tables may be absent only from the pre-migration baseline', () => {
  assert.match(source, /:'capture_role' <> 'baseline' and namespace\.oid is null/);
  assert.match(
    source,
    /retention-managed-ids-after\.csv" retention comparison/,
  );
});

test('agent terminal states expand only for post-thaw growth evidence', () => {
  assert.match(source, /:'capture_role' = 'growth_comparison'/);
  assert.match(
    source,
    /protected-business-ids-post-thaw\.csv" stable growth_comparison/,
  );
  assert.match(
    source,
    /protected-business-ids-after\.csv" stable comparison/,
  );
});

test('a resumed write-freeze release never downgrades its persistent recovery phase', () => {
  const backup = source.slice(
    source.indexOf('create_backup_and_rollback_point() {'),
    source.indexOf('\nrefresh_pre_mutation_database_backup() {'),
  );
  const inherited = backup.indexOf("if [[ \"$recovery_in_progress\" == 'true' ]]");
  const writeFreeze = backup.indexOf("release_phase='write-freeze'", inherited);
  const preWrite = backup.indexOf("release_phase='pre-write'", inherited);
  assert.ok(inherited >= 0 && writeFreeze > inherited && preWrite > writeFreeze);
  assert.match(backup, /resumed-write-freeze-release-armed/);
  assert.match(backup, /recovery_marker_armed='true'/);
});

test('the thaw watchdog remains active until protected exit recovery finishes', () => {
  const exitHandler = source.slice(source.indexOf('on_exit() {'), source.indexOf('\non_signal() {'));
  const rollback = exitHandler.indexOf('restore_application_rollback');
  const stopWatchdog = exitHandler.lastIndexOf('stop_thaw_watchdog');
  assert.ok(rollback >= 0 && stopWatchdog > rollback);
});

test('the supervised watchdog helper is valid and releases only without a recovery marker', () => {
  const match = source.match(/cat >"\$helper_script" <<'WATCHDOG'\n([\s\S]*?)\nWATCHDOG/);
  assert.ok(match, 'supervised watchdog helper was not found');
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-watchdog-'));
  const helper = resolve(directory, 'watchdog.sh');
  const ready = resolve(directory, 'ready');
  const log = resolve(directory, 'watchdog.log');
  try {
    writeFileSync(helper, match[1]);
    chmodSync(helper, 0o700);
    const syntax = spawnSync('bash', ['-n', helper], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const completed = spawnSync(
      helper,
      [
        '99999999',
        '1',
        resolve(directory, 'absent-marker'),
        ready,
        log,
        '/usr/bin:/bin',
        'unix:///var/run/docker.sock',
        'tokems',
        '/tmp',
        resolve(directory, 'env'),
        resolve(directory, 'compose.yml'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(readFileSync(ready, 'utf8'), 'ready\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('write freeze disables restart before arming recovery and keeps a retrying guard', () => {
  const freeze = source.slice(
    source.indexOf('enter_release_write_freeze() {'),
    source.indexOf('\nthaw_release_write_freeze() {'),
  );
  const guard = freeze.indexOf('start_thaw_watchdog');
  const restartNo = freeze.indexOf('set_write_service_restart_policy no');
  const marker = freeze.indexOf('arm_release_recovery_marker');
  const stop = freeze.indexOf('compose_bounded 60 stop --timeout 30 api worker');
  assert.ok(guard >= 0 && guard < restartNo && restartNo < marker && marker < stop);
  assert.match(source, /systemd-run/);
  assert.match(source, /--property=Restart=on-failure/);
  assert.match(source, /while \[\[ -e "\$recovery_marker" \|\| -L "\$recovery_marker" \]\]; do/);
  assert.match(source, /write stop is not yet confirmed; retrying/);
  assert.match(source, /assert_write_services_stopped/);
});

test('recovery is versioned, offline-capable, and waits for detached database work', () => {
  assert.match(source, /protocol_version=1/);
  assert.match(source, /production-deploy\.recovery\.sh/);
  assert.match(source, /recovery_script_sha256/);
  assert.match(source, /bootstrap_recovery_script "\$@"/);
  const recover = source.slice(
    source.indexOf('recover_interrupted_release() {'),
    source.indexOf('\nresolve_pending_recovery() {'),
  );
  assert.doesNotMatch(recover, /git_fetch_origin_main|verify_github_release_gate/);
  const resume = source.slice(
    source.indexOf("if [[ \"$mode\" == 'deploy' && \"$resume_recovery\" == 'true' ]]") ,
    source.indexOf("if [[ \"$mode\" == 'resolve-recovery' ]]") ,
  );
  assert.match(resume, /wait_for_db_init_quiescence/);
  assert.match(resume, /pending_recovery_target_image_tag/);
  assert.match(resume, /recovery_runtime" == 'target'/);
  assert.match(resume, /"\$\{RELEASE_SERVICES\[@\]\}"/);
  assert.match(source, /com\.docker\.compose\.service=db-init/);
});

test('release verifies public recovery projection and the full canonical backend snapshot', () => {
  assert.match(source, /public-homepage-recovery-resolve\.json/);
  assert.match(source, /canonical-homepage\.snapshot\.\$\{evidence_suffix\}\.json/);
  assert.match(source, /export-canonical-homepage\.js --stdout/);
  assert.match(source, /CANONICAL_EXPORT_TRUSTED_COMPOSE_INTERNAL=true/);
  assert.match(source, /verify_canonical_full_snapshot \\\n\s+"\$resolved_full_snapshot" \\\n\s+recovery-resolve/);
  assert.match(source, /homepage_projection=shared-by-previous-and-runtime/);
  assert.match(source, /alternate_full_snapshot/);
  assert.match(source, /backend settings differ from the verified target snapshot/);
});

test('automatic canonical sync repairs pre-existing production drift', () => {
  const decision = source.slice(
    source.indexOf('determine_canonical_sync() {'),
    source.indexOf('\nassert_standard_release_scope() {'),
  );

  assert.match(source, /production_canonical_snapshot_matches_target/);
  assert.match(source, /canonical-probe\.compose/);
  assert.match(source, /default_transaction_read_only=on/);
  assert.match(source, /read_only_compose_file="\$previous_read_only_compose_file"/);
  assert.match(source, /unset TOKEMS_READ_ONLY_DATABASE_URL/);
  assert.match(decision, /production_canonical_snapshot_matches_target/);
  assert.match(decision, /canonical_sync_required='true'/);
  assert.match(decision, /Production canonical snapshot drift detected/);
  assert.match(decision, /Cannot skip canonical synchronization while production is drifted/);
});

test('canonical snapshot comparator detects equality, drift, and invalid JSON', () => {
  const match = source.match(/canonical_snapshot_files_match\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/);
  assert.ok(match, 'canonical snapshot comparison Python program was not found');
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-canonical-probe-'));
  const actual = resolve(directory, 'actual.json');
  const matching = resolve(directory, 'matching.json');
  const drifted = resolve(directory, 'drifted.json');
  const invalid = resolve(directory, 'invalid.json');
  try {
    writeFileSync(actual, '{"nested":{"value":"大会"},"items":[1,2]}\n');
    writeFileSync(matching, '{\n  "items": [1, 2],\n  "nested": {"value": "大会"}\n}\n');
    writeFileSync(drifted, '{"nested":{"value":"旧文案"},"items":[1,2]}\n');
    writeFileSync(invalid, '{"nested":');

    const equalResult = spawnSync('python3', ['-', actual, matching], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.equal(equalResult.status, 0, equalResult.stderr);

    const driftResult = spawnSync('python3', ['-', actual, drifted], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.equal(driftResult.status, 1, driftResult.stderr);

    const invalidResult = spawnSync('python3', ['-', actual, invalid], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.equal(invalidResult.status, 2, invalidResult.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('public homepage verifier treats an omitted binding revision as sanitized metadata', () => {
  const match = source.match(/verify_homepage_file\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/);
  assert.ok(match, 'public homepage verification Python program was not found');
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-homepage-verifier-'));
  const actual = resolve(directory, 'actual.json');
  const expected = resolve(directory, 'expected.json');
  const publicEvent = {
    slug: 'tokems26',
    publicMetrics: null,
    experience: { template: { id: 'template-current' } },
    tickets: [],
  };
  try {
    writeFileSync(actual, JSON.stringify(publicEvent));
    writeFileSync(expected, JSON.stringify({ publicEvent }));
    const result = spawnSync('python3', ['-', actual, expected, 'tokems26'], {
      encoding: 'utf8',
      input: match[1],
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production network calls are bounded and infrastructure reconciliation is isolated', () => {
  assert.doesNotMatch(source, /curl\s+-f/);
  assert.match(source, /readonly -a CURL_ARGS=/);
  assert.match(source, /docker-compose\.yml changed/);
  assert.match(
    source,
    /compose_bounded "\$DB_MIGRATION_TIMEOUT_SECONDS" run --rm --no-deps db-init/,
  );
  assert.match(
    source,
    /compose_bounded "\$SERVICE_TRANSITION_TIMEOUT_SECONDS" up -d \\\n\s+--no-build \\\n\s+--no-deps/,
  );
});

test('parallel release awk gate runs portably and detects Docker mutation commands', () => {
  const match = source.match(
    /assert_no_parallel_release\(\) \{[\s\S]*?awk -v self_pid="\$\$" '\n([\s\S]*?)\n {2}' >\/dev\/null/,
  );
  assert.ok(match, 'parallel release awk program was not found');
  const program = match[1];
  const detected = spawnSync('awk', ['-v', 'self_pid=999', program], {
    encoding: 'utf8',
    input: '123 docker --context prod compose --env-file .env.production up -d --build\n',
  });
  assert.equal(detected.status, 0, detected.stderr);

  const clear = spawnSync('awk', ['-v', 'self_pid=999', program], {
    encoding: 'utf8',
    input: '123 node apps/api/dist/main.js\n124 /usr/bin/buildkitd --config /etc/buildkitd.toml\n',
  });
  assert.equal(clear.status, 1, clear.stderr);
});

test('production deploy script excludes destructive recovery shortcuts', () => {
  for (const forbidden of [
    /git reset --hard/,
    /git clean/,
    /docker system prune/,
    /docker compose down/,
    /docker volume rm/,
    /pg_restore --clean/,
    /DROP DATABASE/i,
    /TRUNCATE/i,
    /rm -rf/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
