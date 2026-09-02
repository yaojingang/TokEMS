#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly APP_DIR='/www/wwwroot/TokEMS'
readonly BACKUP_ROOT='/www/backup/TokEMS'
readonly ENV_DIR='/etc/tokems'
readonly PRODUCTION_ENV_FILE='/etc/tokems/production.env'
readonly GIT_USER='ecs-user'
readonly EXPECTED_ORIGIN='https://github.com/yaojingang/TokEMS.git'
readonly EXPECTED_BRANCH='production'
readonly EXPECTED_UPSTREAM='origin/main'
readonly EXPECTED_UPSTREAM_REF='refs/remotes/origin/main'
readonly SOURCE_BUNDLE_REF='refs/heads/tokems-release-source'
readonly GITHUB_REPOSITORY='yaojingang/TokEMS'
readonly IMAGE_PUBLISH_WORKFLOW='.github/workflows/publish-images.yml'
readonly GHCR_REGISTRY='ghcr.io'
readonly GHCR_USERNAME='yaojingang'
readonly GHCR_PACKAGE='ghcr.io/yaojingang/tokems-production'
readonly GHCR_TOKEN_FILE='/etc/tokems/ghcr-read-token'
readonly PUBLIC_ORIGIN='https://hui.ailingdaoli.com'
readonly ADMIN_ORIGIN='https://admin.hui.ailingdaoli.com'
readonly PAYMENT_URL='https://www.ailingdaoli.com/pay/hui/'
readonly PAYMENT_ORIGIN='https://www.ailingdaoli.com'
readonly PAYMENT_BASE_PATH='/pay/hui'
readonly PAYMENT_PUBLIC_URL='https://www.ailingdaoli.com/pay/hui'
readonly COMPOSE_PROJECT='tokems'
readonly DEFAULT_COMPOSE_FILE_PATH="${APP_DIR}/docker-compose.yml"
readonly LOCAL_DOCKER_HOST='unix:///var/run/docker.sock'
readonly SAFE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly LOCK_DIR='/run/lock/tokems-production-deploy'
readonly LOCK_FILE="${LOCK_DIR}/deploy.lock"
readonly RECOVERY_MARKER="${BACKUP_ROOT}/RECOVERY_REQUIRED"
readonly MIN_BUILD_CAPACITY_KIB=10485760
readonly MIN_BUILD_DISK_KIB=12582912
readonly MIN_BACKUP_RESERVE_KIB=4194304
readonly DB_PROOF_TIMEOUT_SECONDS=30
readonly DB_QUERY_TIMEOUT_SECONDS=120
readonly DB_DUMP_TIMEOUT_SECONDS=1800
readonly DB_MIGRATION_TIMEOUT_SECONDS=1800
readonly SERVICE_TRANSITION_TIMEOUT_SECONDS=360
readonly GIT_BUNDLE_IMPORT_TIMEOUT_SECONDS=180
readonly BUILD_TIMEOUT_SECONDS=3600
readonly DATA_COMPARE_TIMEOUT_SECONDS=300
readonly DATA_COMPARE_MAX_VIRTUAL_KIB=262144
readonly POST_THAW_STABILIZATION_SECONDS=15
readonly WORKER_READY_TIMEOUT_SECONDS=2400
readonly WORKER_READY_POLL_SECONDS=5
readonly CANONICAL_ORGANIZATION_SLUG='geo-conference'
readonly CANONICAL_EVENT_SLUG='tokems26'
readonly -a CURL_ARGS=(
  --fail
  --silent
  --show-error
  --connect-timeout 10
  --max-time 60
  --retry 2
  --retry-delay 2
  --retry-connrefused
)

readonly -a BUILD_SERVICES=(notification-sink api worker web admin gateway)
readonly -a RELEASE_SERVICES=(notification-sink api worker web payment-web admin gateway)
readonly -a LONG_RUNNING_SERVICES=(
  postgres redis minio mailpit notification-sink api worker web payment-web admin gateway
)
readonly -a ROLLBACK_IMAGES=(
  tokems-api tokems-admin tokems-web tokems-worker tokems-gateway tokems-notification-sink
)
readonly -a CANONICAL_SNAPSHOT_PATHS=(
  packages/contracts/src/canonical-homepage.snapshot.json
  packages/contracts/src/canonical-homepage.public.json
)

mode=''
canonical_mode='auto'
build_on_host='false'
requested_target_sha=''
target_sha=''
source_head_before=''
runtime_sha=''
runtime_time=''
runtime_migration=''
runtime_migration_hash=''
runtime_code_migration=''
runtime_code_migration_hash=''
release_baseline_sha=''
release_baseline_time=''
release_baseline_migration=''
release_baseline_migration_hash=''
release_baseline_code_migration=''
release_baseline_code_migration_hash=''
release_stamp=''
backup_dir=''
rollback_tag=''
target_image_tag=''
protection_cutoff=''
backup_device_id=''
canonical_sync_required='false'
canonical_sync_performed='false'
canonical_update_started='false'
canonical_repair_mode='false'
resume_recovery='false'
recovery_in_progress='false'
pending_recovery_backup_dir=''
pending_recovery_phase=''
pending_recovery_rollback_tag=''
pending_recovery_target_sha=''
pending_recovery_protocol=''
pending_recovery_script=''
pending_recovery_script_sha256=''
pending_recovery_target_image_tag=''
target_writes_enabled='false'
recovery_marker_armed='false'
protected_write_block_confirmed='false'
release_write_freeze='false'
read_only_compose_file=''
canonical_probe_compose_file=''
canonical_probe_target_snapshot=''
canonical_probe_actual_snapshot=''
backup_ready='false'
environment_changed='false'
images_changed='false'
containers_switched='false'
database_update_started='false'
database_changed='false'
deployment_succeeded='false'
handling_exit='false'
repair_env_file=''
release_phase=''
deployment_marker_armed='false'
thaw_watchdog_pid=''
thaw_watchdog_unit=''
thaw_guard_compose_file=''
active_env_file="$PRODUCTION_ENV_FILE"
active_compose_file="$DEFAULT_COMPOSE_FILE_PATH"
session_env_file=''
release_source_dir=''
build_compose_file=''
registry_auth_dir=''
descriptor_evidence_dir=''
source_bundle_dir=''
descriptor_container_id=''
descriptor_digest=''
descriptor_platform=''
descriptor_build_sha=''
descriptor_build_time=''
descriptor_migration=''
descriptor_migration_hash=''
descriptor_source_bundle_sha256=''
descriptor_verifier_sha256=''
descriptor_api_ref=''
descriptor_worker_ref=''
descriptor_web_ref=''
descriptor_admin_ref=''
descriptor_gateway_ref=''
descriptor_notification_sink_ref=''

usage() {
  cat <<'USAGE'
TokEMS production deployment

Usage:
  sudo bash tooling/production-deploy.sh check [options]
  sudo bash tooling/production-deploy.sh deploy [options]
  sudo bash tooling/production-deploy.sh repair-identity [options]
  sudo bash tooling/production-deploy.sh recover-interrupted [options]
  sudo bash tooling/production-deploy.sh resolve-recovery [options]

Modes:
  check                         Run the complete read-only production preflight.
  deploy                        Back up, update from CI-passed origin/main, migrate, and release.
  repair-identity               Back up and align protected BUILD_* metadata with the running release.
  recover-interrupted           Restore a pre-database hard-interrupted release from its rollback point.
  resolve-recovery              Clear a pending marker after independently restoring normal writes.

Options:
  --target-sha <40-char-sha>    Require origin/main to equal this exact commit.
  --sync-canonical              Run the canonical template sync even when snapshots are unchanged;
                                reuse the current images when the target changes only deployment controls.
  --skip-canonical              Allowed only when Git snapshots and production already match.
  --resume-recovery             Allow deploy to continue a verified read-only recovery state.
  --build-on-host               Emergency path: build all images on this host after the 10 GiB gate.
  -h, --help                    Show this help.

The default canonical mode is automatic. A Git snapshot change or production database
drift enables the protected geo-conference/tokems26 synchronization while preserving
production business data. Standard check and deploy modes use verified prebuilt images.
USAGE
}

log() {
  printf '[TokEMS deploy] %s\n' "$*"
}

die() {
  printf '[TokEMS deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

git_as_owner() {
  sudo -u "$GIT_USER" env -i \
    "PATH=$SAFE_PATH" \
    'HOME=/nonexistent' \
    GIT_TERMINAL_PROMPT=0 \
    GIT_NO_REPLACE_OBJECTS=1 \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    git -C "$APP_DIR" "$@"
}

compose() {
  local -a clean_env=(env -i "PATH=$SAFE_PATH" 'HOME=/root' "DOCKER_HOST=$LOCAL_DOCKER_HOST")
  [[ -n "${TOKEMS_READ_ONLY_DATABASE_URL+x}" ]] && clean_env+=("TOKEMS_READ_ONLY_DATABASE_URL=$TOKEMS_READ_ONLY_DATABASE_URL")
  [[ -n "${SEED_DEMO_DATA+x}" ]] && clean_env+=("SEED_DEMO_DATA=$SEED_DEMO_DATA")
  [[ -n "${COMPOSE_PARALLEL_LIMIT+x}" ]] && clean_env+=("COMPOSE_PARALLEL_LIMIT=$COMPOSE_PARALLEL_LIMIT")
  "${clean_env[@]}" docker compose \
    --project-name "$COMPOSE_PROJECT" \
    --project-directory "$APP_DIR" \
    --env-file "$active_env_file" \
    -f "$active_compose_file" \
    "$@"
}

compose_read_only_bounded() {
  local timeout_seconds="$1"
  shift
  local -a clean_env=(env -i "PATH=$SAFE_PATH" 'HOME=/root' "DOCKER_HOST=$LOCAL_DOCKER_HOST")
  [[ -n "${TOKEMS_READ_ONLY_DATABASE_URL+x}" ]] && clean_env+=("TOKEMS_READ_ONLY_DATABASE_URL=$TOKEMS_READ_ONLY_DATABASE_URL")
  [[ -n "${SEED_DEMO_DATA+x}" ]] && clean_env+=("SEED_DEMO_DATA=$SEED_DEMO_DATA")
  timeout --foreground --kill-after=10s "${timeout_seconds}s" \
    "${clean_env[@]}" docker compose \
    --project-name "$COMPOSE_PROJECT" \
    --project-directory "$APP_DIR" \
    --env-file "$active_env_file" \
    -f "$active_compose_file" \
    -f "$read_only_compose_file" \
    "$@"
}

compose_bounded() {
  local timeout_seconds="$1"
  shift
  local -a clean_env=(env -i "PATH=$SAFE_PATH" 'HOME=/root' "DOCKER_HOST=$LOCAL_DOCKER_HOST")
  [[ -n "${TOKEMS_READ_ONLY_DATABASE_URL+x}" ]] && clean_env+=("TOKEMS_READ_ONLY_DATABASE_URL=$TOKEMS_READ_ONLY_DATABASE_URL")
  [[ -n "${SEED_DEMO_DATA+x}" ]] && clean_env+=("SEED_DEMO_DATA=$SEED_DEMO_DATA")
  [[ -n "${COMPOSE_PARALLEL_LIMIT+x}" ]] && clean_env+=("COMPOSE_PARALLEL_LIMIT=$COMPOSE_PARALLEL_LIMIT")
  timeout --foreground --kill-after=10s "${timeout_seconds}s" \
    "${clean_env[@]}" docker compose \
    --project-name "$COMPOSE_PROJECT" \
    --project-directory "$APP_DIR" \
    --env-file "$active_env_file" \
    -f "$active_compose_file" \
    "$@"
}

compose_thaw_guard_bounded() {
  local timeout_seconds="$1"
  shift
  local -a clean_env=(env -i "PATH=$SAFE_PATH" 'HOME=/root' "DOCKER_HOST=$LOCAL_DOCKER_HOST")
  timeout --foreground --kill-after=10s "${timeout_seconds}s" \
    "${clean_env[@]}" docker compose \
    --project-name "$COMPOSE_PROJECT" \
    --project-directory "$APP_DIR" \
    --env-file "$active_env_file" \
    -f "$active_compose_file" \
    -f "$thaw_guard_compose_file" \
    "$@"
}

compose_build_bounded() {
  local timeout_seconds="$1"
  shift
  [[ -s "$build_compose_file" ]] || die 'Root-owned build context override is unavailable.'
  local -a clean_env=(env -i "PATH=$SAFE_PATH" 'HOME=/root' "DOCKER_HOST=$LOCAL_DOCKER_HOST")
  [[ -n "${COMPOSE_PARALLEL_LIMIT+x}" ]] && clean_env+=("COMPOSE_PARALLEL_LIMIT=$COMPOSE_PARALLEL_LIMIT")
  timeout --foreground --kill-after=10s "${timeout_seconds}s" \
    "${clean_env[@]}" docker compose \
    --project-name "$COMPOSE_PROJECT" \
    --project-directory "$APP_DIR" \
    --env-file "$active_env_file" \
    -f "$active_compose_file" \
    -f "$build_compose_file" \
    "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

cleanup_canonical_probe() {
  local probe_file
  for probe_file in \
    "$canonical_probe_compose_file" \
    "$canonical_probe_target_snapshot" \
    "$canonical_probe_actual_snapshot"; do
    [[ -n "$probe_file" && -f "$probe_file" ]] || continue
    case "$probe_file" in
      /run/lock/tokems-production-deploy/canonical-probe.*) rm -f -- "$probe_file" ;;
    esac
  done
  canonical_probe_compose_file=''
  canonical_probe_target_snapshot=''
  canonical_probe_actual_snapshot=''
}

cleanup_registry_state() {
  if [[ -n "$descriptor_container_id" ]]; then
    docker rm -f "$descriptor_container_id" >/dev/null 2>&1 || true
    descriptor_container_id=''
  fi
  if [[ -n "$source_bundle_dir" && -d "$source_bundle_dir" ]]; then
    case "$source_bundle_dir" in
      /run/tokems-release-source.*)
        find "$source_bundle_dir" -depth -delete 2>/dev/null || true
        ;;
    esac
  fi
  source_bundle_dir=''
  if [[ -n "$registry_auth_dir" && -d "$registry_auth_dir" ]]; then
    case "$registry_auth_dir" in
      /run/lock/tokems-production-deploy/registry-auth.*)
        find "$registry_auth_dir" -depth -delete 2>/dev/null || true
        ;;
    esac
  fi
  registry_auth_dir=''
  if [[ -n "$descriptor_evidence_dir" && -d "$descriptor_evidence_dir" ]]; then
    case "$descriptor_evidence_dir" in
      /run/lock/tokems-production-deploy/release-descriptor.*)
        find "$descriptor_evidence_dir" -depth -delete 2>/dev/null || true
        ;;
    esac
  fi
  descriptor_evidence_dir=''
}

cleanup_temp_script() {
  cleanup_canonical_probe
  cleanup_registry_state
  if [[ -f "${BASH_SOURCE[0]}" ]]; then
    case "${BASH_SOURCE[0]}" in
      /run/lock/tokems-production-deploy/bootstrap.*) rm -f -- "${BASH_SOURCE[0]}" ;;
    esac
  fi
  if [[ -n "$repair_env_file" && -f "$repair_env_file" ]]; then
    case "$repair_env_file" in
      /etc/tokems/production.env.repair.* | /etc/tokems/production.env.release.*) rm -f -- "$repair_env_file" ;;
    esac
  fi
  if [[ -n "$session_env_file" && -f "$session_env_file" ]]; then
    case "$session_env_file" in
      /run/lock/tokems-production-deploy/production.env.*) rm -f -- "$session_env_file" ;;
    esac
  fi
}

snapshot_production_environment() {
  assert_trusted_recovery_file "$PRODUCTION_ENV_FILE"
  session_env_file="$(mktemp "${LOCK_DIR}/production.env.XXXXXX")"
  cp -- "$PRODUCTION_ENV_FILE" "$session_env_file"
  chown root:root "$session_env_file"
  chmod 600 "$session_env_file"
  active_env_file="$session_env_file"
}

install_active_production_environment() {
  local source_env_file="$active_env_file"
  assert_trusted_root_directory "$ENV_DIR"
  repair_env_file="$(mktemp "${PRODUCTION_ENV_FILE}.release.XXXXXX")"
  cp -- "$source_env_file" "$repair_env_file"
  chown root:root "$repair_env_file"
  chmod 600 "$repair_env_file"
  mv -f -- "$repair_env_file" "$PRODUCTION_ENV_FILE"
  repair_env_file=''
  active_env_file="$PRODUCTION_ENV_FILE"
  assert_trusted_recovery_file "$PRODUCTION_ENV_FILE"
  case "$source_env_file" in
    /etc/tokems/production.env.repair.*) rm -f -- "$source_env_file" ;;
  esac
}

start_thaw_watchdog() {
  [[ -z "$thaw_watchdog_unit" ]] || die 'The release write watchdog is already running.'
  local deploy_parent_pid="$BASHPID" deploy_parent_start helper_script helper_env_file
  deploy_parent_start="$(awk '{ print $22 }' "/proc/${deploy_parent_pid}/stat")"
  [[ "$deploy_parent_start" =~ ^[0-9]+$ ]] || die 'Cannot establish the deployment process lease.'
  helper_script="$backup_dir/thaw-watchdog.sh"
  helper_env_file="$backup_dir/thaw-watchdog.env"
  cp -- "$active_env_file" "$helper_env_file"
  chown root:root "$helper_env_file"
  chmod 600 "$helper_env_file"
  cat >"$helper_script" <<'WATCHDOG'
#!/usr/bin/env bash
set -u
umask 077

parent_pid="$1"
parent_start="$2"
recovery_marker="$3"
ready_file="$4"
log_file="$5"
safe_path="$6"
docker_host="$7"
compose_project="$8"
project_directory="$9"
env_file="${10}"
compose_file="${11}"

PATH="$safe_path"
export PATH
exec >>"$log_file" 2>&1
printf 'ready\n' >"$ready_file"
chmod 600 "$ready_file"

parent_lease_is_alive() {
  [[ -r "/proc/${parent_pid}/stat" ]] || return 1
  [[ "$(awk '{ print $22 }' "/proc/${parent_pid}/stat" 2>/dev/null)" == "$parent_start" ]]
}

while parent_lease_is_alive; do
  sleep 2
done

while [[ -e "$recovery_marker" || -L "$recovery_marker" ]]; do
  if timeout --foreground --kill-after=10s 60s \
    env -i "PATH=$safe_path" 'HOME=/root' "DOCKER_HOST=$docker_host" \
    docker compose \
      --project-name "$compose_project" \
      --project-directory "$project_directory" \
      --env-file "$env_file" \
      -f "$compose_file" \
      stop --timeout 30 api worker; then
    writes_stopped='true'
    for service in api worker; do
      container="$(env -i "PATH=$safe_path" 'HOME=/root' "DOCKER_HOST=$docker_host" \
        docker compose \
          --project-name "$compose_project" \
          --project-directory "$project_directory" \
          --env-file "$env_file" \
          -f "$compose_file" \
          ps -a -q "$service" 2>/dev/null || true)"
      if [[ -n "$container" ]]; then
        running="$(env -i "PATH=$safe_path" 'HOME=/root' "DOCKER_HOST=$docker_host" \
          docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || printf 'unknown')"
        [[ "$running" == 'false' ]] || writes_stopped='false'
      fi
    done
    if [[ "$writes_stopped" == 'true' ]]; then
      printf '[%s] API and Worker write containers are stopped.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      exit 0
    fi
  fi
  printf '[%s] write stop is not yet confirmed; retrying.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  sleep 5
done
WATCHDOG
  chown root:root "$helper_script"
  chmod 700 "$helper_script"
  rm -f -- "$backup_dir/thaw-watchdog.ready"
  thaw_watchdog_unit="tokems-write-guard-${release_stamp}"
  systemd-run \
    --quiet \
    --collect \
    --unit "$thaw_watchdog_unit" \
    --service-type=exec \
    --property=Restart=on-failure \
    --property=RestartSec=5s \
    "$helper_script" \
    "$deploy_parent_pid" \
    "$deploy_parent_start" \
    "$RECOVERY_MARKER" \
    "$backup_dir/thaw-watchdog.ready" \
    "$backup_dir/thaw-watchdog.log" \
    "$SAFE_PATH" \
    "$LOCAL_DOCKER_HOST" \
    "$COMPOSE_PROJECT" \
    "$APP_DIR" \
    "$helper_env_file" \
    "$active_compose_file"
  local attempt
  for ((attempt = 0; attempt < 50; attempt += 1)); do
    if [[ -s "$backup_dir/thaw-watchdog.ready" ]] && systemctl is-active --quiet "$thaw_watchdog_unit"; then
      thaw_watchdog_pid="$(systemctl show --property=MainPID --value "$thaw_watchdog_unit")"
      [[ "$thaw_watchdog_pid" =~ ^[1-9][0-9]*$ ]] || die 'The supervised write watchdog has no running process.'
      printf '%s\n' "$thaw_watchdog_pid" >"$backup_dir/thaw-watchdog.pid"
      chmod 600 "$backup_dir/thaw-watchdog.pid"
      return 0
    fi
    sleep 0.1
  done
  die 'The release write watchdog did not report a healthy startup.'
}

stop_thaw_watchdog() {
  [[ -n "$thaw_watchdog_unit" ]] || return 0
  systemctl stop "$thaw_watchdog_unit" 2>/dev/null || true
  systemctl reset-failed "$thaw_watchdog_unit" 2>/dev/null || true
  thaw_watchdog_pid=''
  thaw_watchdog_unit=''
}

assert_thaw_watchdog_active() {
  [[ -n "$thaw_watchdog_unit" ]] || die 'The supervised write watchdog is unavailable.'
  systemctl is-active --quiet "$thaw_watchdog_unit" || {
    die 'The supervised write watchdog is not active.'
  }
}

restore_application_rollback() {
  [[ "$backup_ready" == 'true' ]] || return 0

  local protected_recovery='false' marker_status=0 stop_status=0
  if [[ "$recovery_marker_armed" == 'true' || "$release_write_freeze" == 'true' || "$database_update_started" == 'true' || "$canonical_update_started" == 'true' || "$recovery_in_progress" == 'true' || "$target_writes_enabled" == 'true' ]]; then
    protected_recovery='true'
    if ! write_pending_recovery_marker 'failed-release-database-state-pending'; then
      marker_status=1
      log "CRITICAL: unable to persist ${RECOVERY_MARKER}."
    fi
    if ! compose_bounded 60 stop --timeout 30 api worker \
      >"${backup_dir}/automatic-rollback-write-stop.log" 2>&1; then
      stop_status=1
      log "CRITICAL: unable to confirm that API and Worker writes stopped; intervene immediately."
    else
      protected_write_block_confirmed='true'
      release_write_freeze='true'
    fi
    if [[ $marker_status -ne 0 || $stop_status -ne 0 ]]; then
      return 1
    fi
  fi

  unset TOKEMS_READ_ONLY_DATABASE_URL

  log "Restoring application rollback point ${rollback_tag}"
  active_env_file="${backup_dir}/.env"
  active_compose_file="${backup_dir}/docker-compose.yml"
  if [[ "$images_changed" == 'true' ]]; then
    local image
    for image in "${ROLLBACK_IMAGES[@]}"; do
      docker image inspect "${image}:${rollback_tag}" >/dev/null 2>&1 || return 1
      docker tag "${image}:${rollback_tag}" "${image}:local" || return 1
    done
  fi

  local current_database_hash='' current_database_migration=''
  if [[ "$database_update_started" == 'true' ]]; then
    if ! current_database_hash="$(read_database_migration_hash)"; then
      log 'Database migration identity is unavailable; old images and environment are restored while API and Worker remain stopped.'
      return 1
    fi
    if [[ ! "$current_database_hash" =~ ^[0-9a-f]{64}$ ]]; then
      log 'Database migration identity is invalid; old images and environment are restored while API and Worker remain stopped.'
      return 1
    fi
    if [[ "$current_database_hash" != "$release_baseline_migration_hash" ]]; then
      if ! current_database_migration="$(migration_name_for_hash "$current_database_hash")" || [[ -z "$current_database_migration" ]]; then
        log 'Database migration cannot be mapped to reviewed source; API and Worker remain stopped.'
        return 1
      fi
      database_changed='true'
    fi
  fi

  if [[ "$database_changed" == 'true' ]]; then
    log "Database advanced during the failed release; aligning read-only rollback metadata with ${current_database_migration}"
    cp -- "$backup_dir/.env" "$backup_dir/.env.rollback-runtime" || return 1
    chown root:root "$backup_dir/.env.rollback-runtime" || return 1
    chmod 600 "$backup_dir/.env.rollback-runtime" || return 1
    active_env_file="$backup_dir/.env.rollback-runtime"
    set_env_value BUILD_MIGRATION "$current_database_migration"
    set_env_value BUILD_MIGRATION_HASH "$current_database_hash"
    set_release_metadata_value TOKEMS_COMPATIBILITY_ROLLBACK active
    set_release_metadata_value TOKEMS_ROLLBACK_CODE_MIGRATION "$release_baseline_code_migration"
    set_release_metadata_value TOKEMS_ROLLBACK_CODE_MIGRATION_HASH "$release_baseline_code_migration_hash"
    printf 'mode=read-only-application-rollback-pending-review\ndatabase_migration=%s\ndatabase_migration_hash=%s\n' \
      "$current_database_migration" "$current_database_hash" \
      >"${backup_dir}/automatic-rollback-identity.txt"
    chmod 600 "${backup_dir}/automatic-rollback-identity.txt"
    printf 'database_migration_changed=true\nautomatic_database_restore=false\nmanual_review=required\nwrites=read-only-api-and-paused-worker\n' \
      >"${backup_dir}/automatic-rollback-migration-state.txt"
    chmod 600 "${backup_dir}/automatic-rollback-migration-state.txt"
  fi

  if [[ "$environment_changed" == 'true' || "$database_changed" == 'true' ]]; then
    install_active_production_environment || return 1
  fi

  if [[ "$target_writes_enabled" == 'true' ]]; then
    printf 'target_writes_enabled=true\nmanual_review=required\nwrites=read-only-api-and-paused-worker\n' \
      >"${backup_dir}/automatic-rollback-target-writes-state.txt"
    chmod 600 "${backup_dir}/automatic-rollback-target-writes-state.txt"
  fi

  if [[ "$protected_recovery" == 'true' ]]; then
    local recovery_reason='resumed-release-failed'
    [[ "$database_changed" == 'false' ]] || recovery_reason='database-migration-changed'
    [[ "$canonical_update_started" == 'false' ]] || recovery_reason='canonical-update-started'
    [[ "$target_writes_enabled" == 'false' ]] || recovery_reason='target-writes-were-enabled'
    if ! write_pending_recovery_marker "$recovery_reason"; then
      log "Unable to persist ${RECOVERY_MARKER}; continuing the read-only application recovery."
    fi
    [[ -s "$read_only_compose_file" ]] || return 1
    export TOKEMS_READ_ONLY_DATABASE_URL
    TOKEMS_READ_ONLY_DATABASE_URL="$(read_only_database_url)" || return 1
  fi

  if [[ "$canonical_update_started" == 'true' ]]; then
    printf 'canonical_update_started=true\nautomatic_database_restore=false\nmanual_review=required\nwrites=read-only-api-and-paused-worker\n' \
      >"${backup_dir}/automatic-rollback-canonical-state.txt"
    chmod 600 "${backup_dir}/automatic-rollback-canonical-state.txt"
  fi

  if [[ "$containers_switched" == 'true' || "$database_changed" == 'true' ]]; then
    if [[ "$protected_recovery" == 'true' ]]; then
      compose_read_only_bounded "$SERVICE_TRANSITION_TIMEOUT_SECONDS" \
        up -d \
        --no-build \
        --no-deps \
        --force-recreate \
        --wait \
        --wait-timeout 300 \
        "${RELEASE_SERVICES[@]}" \
        >"${backup_dir}/automatic-rollback.log" 2>&1 || return 1
    else
      compose_bounded "$SERVICE_TRANSITION_TIMEOUT_SECONDS" \
        up -d \
        --no-build \
        --no-deps \
        --force-recreate \
        --wait \
        --wait-timeout 300 \
        "${RELEASE_SERVICES[@]}" \
        >"${backup_dir}/automatic-rollback.log" 2>&1 || return 1
    fi
  fi

  curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/api/v1/health' \
    >"${backup_dir}/automatic-rollback-health.json" || return 1
  assert_health_json <"${backup_dir}/automatic-rollback-health.json" || return 1
  assert_current_runtime_identity || return 1
  assert_api_uses_compose_database || return 1

  if [[ "$protected_recovery" == 'true' ]]; then
    curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/api/v1/homepage' \
      >"${backup_dir}/automatic-rollback-homepage.json" || return 1
    local projection_state
    if verify_homepage_file \
      "${backup_dir}/automatic-rollback-homepage.json" \
      "${backup_dir}/canonical-homepage.public.before.json"; then
      projection_state='public_projection=matches_previous_release'
    else
      projection_state='public_projection=differs_from_previous_release'
    fi
    if [[ "$canonical_update_started" == 'true' ]]; then
      printf '%s\n' "$projection_state" >>"${backup_dir}/automatic-rollback-canonical-state.txt"
    fi
    if [[ "$database_changed" == 'true' ]]; then
      printf '%s\n' "$projection_state" >>"${backup_dir}/automatic-rollback-migration-state.txt"
    fi
    if [[ "$target_writes_enabled" == 'true' ]]; then
      printf '%s\n' "$projection_state" >>"${backup_dir}/automatic-rollback-target-writes-state.txt"
    fi
    return 1
  fi

  return 0
}

on_exit() {
  local exit_code=$?
  [[ "$handling_exit" == 'false' ]] || return
  handling_exit='true'
  trap - EXIT ERR
  trap '' HUP INT TERM
  set +e

  if [[ $exit_code -ne 0 && "$deployment_succeeded" != 'true' && "$backup_ready" == 'true' ]]; then
    printf 'status=failed\ntarget_sha=%s\nruntime_before=%s\nbackup_dir=%s\n' \
      "$target_sha" "$release_baseline_sha" "$backup_dir" \
      >"${backup_dir}/deployment-result.txt"
    chmod 600 "${backup_dir}/deployment-result.txt"
    if restore_application_rollback; then
      if [[ "$recovery_marker_armed" == 'false' && "$release_write_freeze" == 'false' && "$database_update_started" == 'false' && "$canonical_update_started" == 'false' && "$target_writes_enabled" == 'false' ]]; then
        clear_pending_recovery_marker || log "Pre-database rollback completed, but ${RECOVERY_MARKER} still requires manual review."
      fi
      printf 'recovery=application-rollback\n' >>"${backup_dir}/deployment-result.txt"
      log "Application rollback restored. Database backups remain at ${backup_dir}."
    else
      printf 'recovery=manual-follow-through-required\n' >>"${backup_dir}/deployment-result.txt"
      if [[ "$recovery_marker_armed" == 'true' || "$release_write_freeze" == 'true' || "$database_update_started" == 'true' || "$canonical_update_started" == 'true' || "$recovery_in_progress" == 'true' || "$target_writes_enabled" == 'true' ]]; then
        if [[ "$protected_write_block_confirmed" == 'true' ]]; then
          log "Protected recovery needs manual follow-through; API and Worker writes are blocked. Evidence: ${backup_dir}."
        else
          log "CRITICAL: protected recovery could not confirm the write block. Intervene immediately and inspect ${backup_dir}."
        fi
      else
        log "Automatic application rollback needs manual follow-through from ${backup_dir}."
      fi
    fi
  fi

  if [[ "$deployment_succeeded" == 'true' || "$protected_write_block_confirmed" == 'true' || ( ! -e "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" ) ]]; then
    stop_thaw_watchdog
  elif [[ -n "$thaw_watchdog_unit" ]] && systemctl is-active --quiet "$thaw_watchdog_unit"; then
    log "The supervised write watchdog ${thaw_watchdog_unit} remains active until API and Worker writes are confirmed stopped."
    thaw_watchdog_pid=''
    thaw_watchdog_unit=''
  elif [[ -n "$thaw_watchdog_unit" ]]; then
    log "CRITICAL: the supervised write watchdog ${thaw_watchdog_unit} is not active while recovery remains pending."
    thaw_watchdog_pid=''
    thaw_watchdog_unit=''
  fi
  cleanup_temp_script
  exit "$exit_code"
}

on_signal() {
  local signal_name="$1" exit_code="$2"
  log "Received ${signal_name}; starting the protected exit path."
  exit "$exit_code"
}

trap on_exit EXIT
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

parse_arguments() {
  [[ $# -gt 0 ]] || {
    usage >&2
    exit 2
  }

  mode="$1"
  shift
  case "$mode" in
    check | deploy | repair-identity | recover-interrupted | resolve-recovery) ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target-sha)
        [[ $# -ge 2 ]] || die '--target-sha requires a value'
        requested_target_sha="$2"
        shift 2
        ;;
      --sync-canonical)
        canonical_mode='always'
        shift
        ;;
      --skip-canonical)
        canonical_mode='never'
        shift
        ;;
      --resume-recovery)
        resume_recovery='true'
        shift
        ;;
      --build-on-host)
        build_on_host='true'
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  if [[ -n "$requested_target_sha" && ! "$requested_target_sha" =~ ^[0-9a-f]{40}$ ]]; then
    die '--target-sha must be a full lowercase 40-character Git SHA'
  fi
  if [[ ( "$mode" == 'repair-identity' || "$mode" == 'recover-interrupted' || "$mode" == 'resolve-recovery' ) && "$canonical_mode" != 'auto' ]]; then
    die 'Canonical synchronization options apply only to check and deploy modes.'
  fi
  if [[ "$resume_recovery" == 'true' && "$mode" != 'deploy' ]]; then
    die '--resume-recovery applies only to deploy mode.'
  fi
  if [[ "$build_on_host" == 'true' && "$mode" != 'check' && "$mode" != 'deploy' ]]; then
    die '--build-on-host applies only to check and deploy modes.'
  fi
}

assert_target_selection() {
  local actual_sha="$1"
  if [[ -n "$requested_target_sha" && "$requested_target_sha" != "$actual_sha" ]]; then
    die "origin/main is ${actual_sha}; requested target was ${requested_target_sha}."
  fi
}

pin_local_runtime_controls() {
  PATH="$SAFE_PATH"
  export PATH
  export DOCKER_HOST="$LOCAL_DOCKER_HOST"
  unset DOCKER_CONTEXT DOCKER_CONFIG
  unset DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
  unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES
  unset COMPOSE_PATH_SEPARATOR COMPOSE_CONVERT_WINDOWS_PATHS COMPOSE_IGNORE_ORPHANS
  unset BUILD_SHA BUILD_TIME BUILD_MIGRATION BUILD_MIGRATION_HASH
  unset GH_TOKEN GITHUB_TOKEN
  unset TOKEMS_READ_ONLY_DATABASE_URL SEED_DEMO_DATA COMPOSE_PARALLEL_LIMIT
}

require_root_and_base_commands() {
  [[ "$(id -u)" -eq 0 ]] || die 'Run this command with sudo or as root.'
  local command_name
  for command_name in bash sudo env git flock curl python3 docker nginx awk grep sed sha256sum find sort tail tar install ps mkdir stat dirname df mktemp cp mv chmod chown rm basename date timeout sleep cat readlink systemd-run systemctl uname; do
    require_command "$command_name"
  done
  [[ "$(cd "$APP_DIR" && pwd -P)" == "$APP_DIR" ]] || die 'Production app path resolved unexpectedly.'
  if [[ ! -e "$ENV_DIR" && ! -L "$ENV_DIR" ]]; then
    install -d -o root -g root -m 700 "$ENV_DIR"
  fi
  assert_trusted_root_directory "$ENV_DIR"
  [[ "$(stat -c '%a' "$ENV_DIR")" == '700' ]] || die "Production environment directory must have mode 700: ${ENV_DIR}"
  if [[ "$mode" != 'recover-interrupted' ]]; then
    [[ -d "$APP_DIR/.git" ]] || die "Git checkout is missing at ${APP_DIR}"
    assert_trusted_recovery_file "$PRODUCTION_ENV_FILE"
  fi
  [[ -S /var/run/docker.sock ]] || die 'The local Docker Unix socket is unavailable.'
  ensure_trusted_backup_root
}

assert_trusted_root_directory() {
  local directory="$1" mode numeric_mode
  [[ -d "$directory" && ! -L "$directory" ]] || die "Trusted directory is missing or symbolic: ${directory}"
  [[ "$(stat -c '%u' "$directory")" == '0' ]] || die "Trusted directory must be owned by root: ${directory}"
  mode="$(stat -c '%a' "$directory")"
  numeric_mode=$((8#$mode))
  (( (numeric_mode & 0022) == 0 )) || die "Trusted directory must not be writable by group or others: ${directory}"
}

ensure_trusted_backup_root() {
  assert_trusted_root_directory /www
  if [[ ! -e /www/backup && ! -L /www/backup ]]; then
    install -d -o root -g root -m 700 /www/backup
  fi
  assert_trusted_root_directory /www/backup
  if [[ ! -e "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]]; then
    install -d -o root -g root -m 700 "$BACKUP_ROOT"
  fi
  assert_trusted_root_directory "$BACKUP_ROOT"
}

assert_trusted_release_directory() {
  local directory="$1" release_name
  [[ "$(dirname "$directory")" == "$BACKUP_ROOT" ]] || die 'Recovery backup directory must be an immediate child of the backup root.'
  release_name="$(basename "$directory")"
  [[ "$release_name" =~ ^[0-9]{8}-[0-9]{6}$ ]] || die 'Recovery backup directory has an invalid release name.'
  assert_trusted_root_directory "$directory"
  [[ "$(stat -c '%a' "$directory")" == '700' ]] || die 'Recovery backup directory must have mode 700.'
}

assert_trusted_recovery_file() {
  local file_name="$1"
  [[ -f "$file_name" && ! -L "$file_name" ]] || die "Recovery evidence must be a regular non-symbolic file: ${file_name}"
  [[ "$(stat -c '%u:%a' "$file_name")" == '0:600' ]] || {
    die "Recovery evidence must be owned by root with mode 600: ${file_name}"
  }
}

assert_no_parallel_release() {
  if ps -eo pid=,args= | awk -v self_pid="$$" '
    $1 != self_pid && ($0 ~ /docker[ ]+.*compose[ ]+([^ ]+[ ]+)*(build|run|up|stop|restart)([ ]|$)/ || $0 ~ /docker[-]compose[ ]+([^ ]+[ ]+)*(build|run|up|stop|restart)([ ]|$)/ || $0 ~ /docker[ ]+.*buildx[ ]+([^ ]+[ ]+)*build([ ]|$)/ || $0 ~ /docker[ ]+([^ ]+[ ]+)*build([ ]|$)/ || $0 ~ /buildctl[ ]+([^ ]+[ ]+)*build([ ]|$)/) { found = 1 }
    END { exit(found ? 0 : 1) }
  ' >/dev/null; then
    die 'Another Docker build, migration, or service switch is already running on this host.'
  fi
  local db_init_containers
  db_init_containers="$(docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --filter 'label=com.docker.compose.service=db-init')"
  if [[ -n "$db_init_containers" ]]; then
    if [[ "$mode" == 'deploy' && "$resume_recovery" == 'true' ]]; then
      log 'A detached db-init container belongs to the interrupted release; recovery will wait for it.'
    else
      die 'A TokEMS db-init container is still running; database state must become quiescent first.'
    fi
  fi
}

wait_for_db_init_quiescence() {
  local deadline=$((SECONDS + DB_MIGRATION_TIMEOUT_SECONDS)) containers
  while true; do
    containers="$(docker ps -q \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
      --filter 'label=com.docker.compose.service=db-init')"
    [[ -n "$containers" ]] || return 0
    (( SECONDS < deadline )) || die 'Detached db-init did not finish within the recovery timeout.'
    sleep 5
  done
}

assert_recovery_migration_chain() {
  local current_hash="$1" baseline_hash="$2" target_hash="$3"
  local source_dir="$pending_recovery_backup_dir/source/packages/database/drizzle"
  [[ -d "$source_dir" && ! -L "$source_dir" ]] || die 'Protected target migration source is unavailable.'
  python3 - "$source_dir" "$current_hash" "$baseline_hash" "$target_hash" <<'PY'
import hashlib
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1])
current, baseline, target = sys.argv[2:]
files = sorted(path for path in source.iterdir() if re.fullmatch(r"[0-9]{4}_.+\.sql", path.name))
hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in files]
if len(hashes) != len(set(hashes)):
    raise SystemExit("target migration chain contains duplicate hashes")
try:
    baseline_index = hashes.index(baseline)
    current_index = hashes.index(current)
    target_index = hashes.index(target)
except ValueError as error:
    raise SystemExit("current database hash is outside the protected target migration chain") from error
if not baseline_index <= current_index <= target_index:
    raise SystemExit("current database hash is outside the baseline-to-target migration interval")
print("Protected recovery migration chain verified")
PY
}

acquire_deploy_lock() {
  if [[ -L "$LOCK_DIR" ]]; then
    die "Deployment lock directory must not be a symbolic link: ${LOCK_DIR}"
  fi
  if [[ ! -e "$LOCK_DIR" ]]; then
    mkdir -m 700 -- "$LOCK_DIR" || die "Unable to create deployment lock directory: ${LOCK_DIR}"
  fi
  [[ -d "$LOCK_DIR" && ! -L "$LOCK_DIR" ]] || die 'Deployment lock path is not a trusted directory.'
  [[ "$(stat -c '%u:%a' "$LOCK_DIR")" == '0:700' ]] || {
    die 'Deployment lock directory must be owned by root with mode 700.'
  }
  [[ ! -L "$LOCK_FILE" ]] || die 'Deployment lock file must not be a symbolic link.'
  if [[ -e "$LOCK_FILE" ]]; then
    [[ -f "$LOCK_FILE" && "$(stat -c '%u' "$LOCK_FILE")" == '0' ]] || {
      die 'Deployment lock file is not a root-owned regular file.'
    }
  fi
  if [[ -e /proc/$$/fd/9 ]] && [[ "$(readlink -f /proc/$$/fd/9)" == "$LOCK_FILE" ]]; then
    flock -n 9 || die 'Inherited deployment lock descriptor is not held by this release.'
    return 0
  fi
  exec 9>>"$LOCK_FILE"
  chmod 600 "$LOCK_FILE"
  flock -n 9 || die 'Another TokEMS deployment is already running.'
}

read_pending_recovery_marker() {
  [[ ! -L "$RECOVERY_MARKER" ]] || die "Recovery marker must not be a symbolic link: ${RECOVERY_MARKER}"
  [[ -f "$RECOVERY_MARKER" ]] || die "Recovery marker is not a regular file: ${RECOVERY_MARKER}"
  [[ "$(stat -c '%u:%a' "$RECOVERY_MARKER")" == '0:600' ]] || {
    die 'Recovery marker must be owned by root with mode 600.'
  }
  pending_recovery_backup_dir="$(awk -F= '$1 == "backup_dir" { value = substr($0, index($0, "=") + 1) } END { print value }' "$RECOVERY_MARKER")"
  pending_recovery_phase="$(awk -F= '$1 == "phase" { value = substr($0, index($0, "=") + 1) } END { print value }' "$RECOVERY_MARKER")"
  pending_recovery_rollback_tag="$(awk -F= '$1 == "rollback_tag" { value = substr($0, index($0, "=") + 1) } END { print value }' "$RECOVERY_MARKER")"
  pending_recovery_target_sha="$(awk -F= '$1 == "target_sha" { value = substr($0, index($0, "=") + 1) } END { print value }' "$RECOVERY_MARKER")"
  pending_recovery_protocol="$(awk -F= '$1 == "protocol_version" { value = substr($0, index($0, "=") + 1) } END { print value }' "$RECOVERY_MARKER")"
  pending_recovery_script="$(awk -F= '$1 == "recovery_script" { value = substr($0, index($0, "=") + 1) } END { print value }' "$RECOVERY_MARKER")"
  pending_recovery_script_sha256="$(awk -F= '$1 == "recovery_script_sha256" { value = substr($0, index($0, "=") + 1) } END { print value }' "$RECOVERY_MARKER")"
  pending_recovery_target_image_tag="$(awk -F= '$1 == "target_image_tag" { value = substr($0, index($0, "=") + 1) } END { print value }' "$RECOVERY_MARKER")"
  assert_trusted_release_directory "$pending_recovery_backup_dir"
  [[ -z "$pending_recovery_rollback_tag" || "$pending_recovery_rollback_tag" =~ ^rollback-[0-9]{8}-[0-9]{6}$ ]] || {
    die 'Recovery marker contains an invalid rollback image tag.'
  }
  [[ "$pending_recovery_target_sha" =~ ^[0-9a-f]{40}$ ]] || {
    die 'Recovery marker contains an invalid target commit.'
  }
  [[ "$pending_recovery_protocol" == '1' ]] || die 'Recovery marker protocol is unsupported.'
  [[ "$pending_recovery_script" == "${pending_recovery_backup_dir}/production-deploy.recovery.sh" ]] || {
    die 'Recovery marker points outside its protected release directory.'
  }
  [[ "$pending_recovery_script_sha256" =~ ^[0-9a-f]{64}$ ]] || {
    die 'Recovery marker contains an invalid recovery script digest.'
  }
  [[ "$pending_recovery_target_image_tag" =~ ^release-[0-9]{8}-[0-9]{6}$ ]] || {
    die 'Recovery marker contains an invalid target image tag.'
  }
  assert_trusted_recovery_file "$pending_recovery_script"
  [[ "$(sha256sum "$pending_recovery_script" | awk '{ print $1 }')" == "$pending_recovery_script_sha256" ]] || {
    die 'Protected recovery script digest does not match the marker.'
  }
}

assert_pending_recovery_policy() {
  if [[ -e "$RECOVERY_MARKER" || -L "$RECOVERY_MARKER" ]]; then
    read_pending_recovery_marker
    if [[ "$pending_recovery_phase" == 'pre-write' ]]; then
      if [[ "$mode" == 'recover-interrupted' ]]; then
        recovery_in_progress='true'
        log "Recovering the pre-database interrupted release recorded at ${pending_recovery_backup_dir}"
        return 0
      fi
      die "A pre-database release interruption is pending at ${pending_recovery_backup_dir}; run recover-interrupted before any normal release."
    fi
    [[ -z "$pending_recovery_phase" || "$pending_recovery_phase" == 'write-freeze' ]] || {
      die "Recovery marker contains an unsupported release phase: ${pending_recovery_phase}"
    }
    if [[ "$mode" == 'deploy' && "$resume_recovery" == 'true' ]]; then
      recovery_in_progress='true'
      active_env_file="${pending_recovery_backup_dir}/.env"
      active_compose_file="${pending_recovery_backup_dir}/docker-compose.yml"
      assert_trusted_recovery_file "$active_env_file"
      assert_trusted_recovery_file "$active_compose_file"
      read_only_compose_file="${pending_recovery_backup_dir}/docker-compose.read-only.yml"
      assert_trusted_recovery_file "$read_only_compose_file"
      [[ -s "$read_only_compose_file" ]] || die 'Pending recovery read-only Compose override is empty.'
      wait_for_db_init_quiescence
      local image current_database_hash baseline_database_hash target_database_hash recovery_runtime='rollback'
      assert_trusted_recovery_file "$pending_recovery_backup_dir/.env.release"
      current_database_hash="$(read_database_migration_hash)"
      baseline_database_hash="$(env_file_value BUILD_MIGRATION_HASH "$pending_recovery_backup_dir/.env")"
      target_database_hash="$(env_file_value BUILD_MIGRATION_HASH "$pending_recovery_backup_dir/.env.release")"
      [[ "$current_database_hash" =~ ^[0-9a-f]{64}$ && "$baseline_database_hash" =~ ^[0-9a-f]{64}$ && "$target_database_hash" =~ ^[0-9a-f]{64}$ ]] || {
        die 'Recovery migration identity is incomplete.'
      }
      if [[ "$current_database_hash" == "$baseline_database_hash" ]]; then
        log "Restoring the rollback runtime in read-only mode before resuming ${pending_recovery_target_sha}"
        for image in "${ROLLBACK_IMAGES[@]}"; do
          docker image inspect "${image}:${pending_recovery_rollback_tag}" >/dev/null
          docker tag "${image}:${pending_recovery_rollback_tag}" "${image}:local"
        done
      else
        log "Completing the interrupted target migration before resuming ${pending_recovery_target_sha}"
        recovery_runtime='target'
        assert_recovery_migration_chain "$current_database_hash" "$baseline_database_hash" "$target_database_hash"
        active_env_file="$pending_recovery_backup_dir/.env.release"
        for image in "${ROLLBACK_IMAGES[@]}"; do
          docker image inspect "${image}:${pending_recovery_target_image_tag}" >/dev/null
          docker tag "${image}:${pending_recovery_target_image_tag}" "${image}:local"
        done
        if [[ "$current_database_hash" != "$target_database_hash" ]]; then
          (export SEED_DEMO_DATA=false; compose_bounded "$DB_MIGRATION_TIMEOUT_SECONDS" run --rm --no-deps db-init)
          current_database_hash="$(read_database_migration_hash)"
          [[ "$current_database_hash" == "$target_database_hash" ]] || {
            die 'Interrupted target migration did not converge to its recorded migration hash.'
          }
        fi
        canonical_mode='always'
      fi
      export TOKEMS_READ_ONLY_DATABASE_URL
      TOKEMS_READ_ONLY_DATABASE_URL="$(read_only_database_url)"
      if [[ "$recovery_runtime" == 'target' ]]; then
        compose_read_only_bounded "$SERVICE_TRANSITION_TIMEOUT_SECONDS" up -d \
          --no-build \
          --no-deps \
          --force-recreate \
          --wait \
          --wait-timeout 300 \
          "${RELEASE_SERVICES[@]}"
      else
        compose_read_only_bounded "$SERVICE_TRANSITION_TIMEOUT_SECONDS" up -d \
          --no-build \
          --no-deps \
          --force-recreate \
          --wait \
          --wait-timeout 300 \
          api worker
      fi
      assert_operational_write_state recovery
      return 0
    fi
    if [[ "$mode" == 'resolve-recovery' ]]; then
      recovery_in_progress='true'
      active_compose_file="${pending_recovery_backup_dir}/docker-compose.yml"
      read_only_compose_file="${pending_recovery_backup_dir}/docker-compose.read-only.yml"
      assert_trusted_recovery_file "$active_compose_file"
      assert_trusted_recovery_file "$read_only_compose_file"
      return 0
    fi
    die "A protected recovery is pending at ${pending_recovery_backup_dir}; writes may remain frozen. Resolve it or run deploy --resume-recovery."
  fi
  [[ "$resume_recovery" == 'false' ]] || die 'No pending recovery marker exists to resume.'
  [[ "$mode" != 'resolve-recovery' ]] || die 'No pending recovery marker exists to resolve.'
  [[ "$mode" != 'recover-interrupted' ]] || die 'No pre-database interrupted release exists to recover.'
}

write_pending_recovery_marker() {
  local reason="$1" marker_temp="${RECOVERY_MARKER}.tmp.$$" recovery_script recovery_script_sha256
  install -d -m 700 "$BACKUP_ROOT"
  [[ ! -L "$RECOVERY_MARKER" ]] || return 1
  recovery_script="$backup_dir/production-deploy.recovery.sh"
  [[ -f "$recovery_script" && ! -L "$recovery_script" ]] || return 1
  recovery_script_sha256="$(sha256sum "$recovery_script" | awk '{ print $1 }')" || return 1
  printf 'status=protected-release\nprotocol_version=1\nphase=%s\nreason=%s\nbackup_dir=%s\ntarget_sha=%s\nrollback_tag=%s\ntarget_image_tag=%s\nrecovery_script=%s\nrecovery_script_sha256=%s\n' \
    "$release_phase" "$reason" "$backup_dir" "$target_sha" "$rollback_tag" "$target_image_tag" "$recovery_script" "$recovery_script_sha256" >"$marker_temp" || return 1
  chmod 600 "$marker_temp" || return 1
  mv -f -- "$marker_temp" "$RECOVERY_MARKER" || return 1
}

bootstrap_recovery_script() {
  read_pending_recovery_marker
  local current_script_sha256
  current_script_sha256="$(sha256sum "${BASH_SOURCE[0]}" | awk '{ print $1 }')"
  [[ "$current_script_sha256" != "$pending_recovery_script_sha256" ]] || return 0
  log "Loading the exact protected recovery script for ${pending_recovery_target_sha}"
  exec env -i \
    "PATH=$SAFE_PATH" \
    'HOME=/root' \
    bash "$pending_recovery_script" "$@"
}

arm_release_recovery_marker() {
  release_phase='write-freeze'
  write_pending_recovery_marker 'release-write-freeze-armed' || {
    die "Unable to persist ${RECOVERY_MARKER} before the protected release window."
  }
  recovery_marker_armed='true'
  deployment_marker_armed='true'
}

clear_pending_recovery_marker() {
  [[ -e "$RECOVERY_MARKER" || -L "$RECOVERY_MARKER" ]] || return 0
  read_pending_recovery_marker
  local resolved_marker="${pending_recovery_backup_dir}/RECOVERY_RESOLVED-$(date '+%Y%m%d-%H%M%S')"
  [[ ! -e "$resolved_marker" ]] || die "Resolved recovery evidence already exists: ${resolved_marker}"
  mv -- "$RECOVERY_MARKER" "$resolved_marker"
  chmod 600 "$resolved_marker"
  deployment_marker_armed='false'
}

assert_minimal_git_state() {
  [[ "$(git_as_owner branch --show-current)" == "$EXPECTED_BRANCH" ]] || {
    die "Server branch must be ${EXPECTED_BRANCH}."
  }
  [[ "$(git_as_owner remote get-url origin)" == "$EXPECTED_ORIGIN" ]] || {
    die "origin must be ${EXPECTED_ORIGIN}."
  }
  [[ -z "$(git_as_owner status --porcelain --untracked-files=all)" ]] || {
    die 'Server Git worktree contains uncommitted or untracked files.'
  }
  [[ "$(git_as_owner rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')" == "$EXPECTED_UPSTREAM" ]] || {
    die "${EXPECTED_BRANCH} must track ${EXPECTED_UPSTREAM}."
  }
  [[ -z "$(git_as_owner for-each-ref --format='%(refname)' refs/replace)" ]] || {
    die 'Git replacement references are forbidden in the production checkout.'
  }
}

bootstrap_latest_script() {
  log 'Loading the deployment script from the latest verified main release'
  local latest_sha latest_script_sha current_script_sha temp_script
  latest_sha="$(github_main_sha)"
  assert_target_selection "$latest_sha"
  target_sha="$latest_sha"
  verify_github_release_gate
  verify_image_publish_gate
  prepare_release_source_bundle
  verify_release_descriptor
  [[ "$(git_as_owner rev-parse "$EXPECTED_UPSTREAM_REF")" == "$target_sha" ]] || {
    die 'Verified release source did not update origin/main to the target commit.'
  }
  git_as_owner merge-base --is-ancestor "$(git_as_owner rev-parse HEAD)" "$latest_sha" || {
    die 'Server production branch cannot fast-forward to origin/main.'
  }
  latest_script_sha="$(git_as_owner show "${latest_sha}:tooling/production-deploy.sh" | sha256sum | awk '{ print $1 }')"
  current_script_sha="$(sha256sum "${BASH_SOURCE[0]}" | awk '{ print $1 }')"
  [[ "$current_script_sha" != "$latest_script_sha" ]] || return 0
  temp_script="$(mktemp "${LOCK_DIR}/bootstrap.XXXXXX")"
  git_as_owner show "${latest_sha}:tooling/production-deploy.sh" >"$temp_script" || {
    rm -f -- "$temp_script"
    die 'origin/main does not contain the production deployment script.'
  }
  chmod 700 "$temp_script"
  bash -n "$temp_script" || {
    rm -f -- "$temp_script"
    die 'The deployment script on origin/main failed shell syntax validation.'
  }

  cleanup_registry_state

  exec env -i \
    "PATH=$SAFE_PATH" \
    'HOME=/root' \
    bash "$temp_script" "$@"
}

env_value() {
  local key="$1"
  env_file_value "$key" "$active_env_file"
}

env_file_value() {
  local key="$1" env_file="$2"
  awk -F= -v expected_key="$key" '
    $1 == expected_key { value = substr($0, index($0, "=") + 1); found = 1 }
    END { if (found) print value }
  ' \
    "$env_file"
}

env_key_count() {
  local key="$1"
  awk -F= -v expected_key="$key" '$1 == expected_key { count += 1 } END { print count + 0 }' \
    "$active_env_file"
}

assert_unique_production_env_keys() {
  local verify_build_keys="${1:-true}" key count
  for key in \
    DEPLOYMENT_MODE \
    SEED_DEMO_DATA \
    PUBLIC_ORGANIZATION_SLUG \
    NUXT_PUBLIC_ORGANIZATION_SLUG \
    PUBLIC_ORIGIN \
    ADMIN_ORIGIN \
    PAYMENT_PUBLIC_ORIGIN \
    PAYMENT_PUBLIC_BASE_PATH \
    PAYMENT_PUBLIC_URL \
    CUSTOMER_OTP_MODE \
    ALLOW_INSECURE_LOCAL_AUTH \
    VITE_SIMPLE_AUTH \
    ENABLE_LOCAL_PAYMENT_SIMULATION; do
    count="$(env_key_count "$key")"
    [[ "$count" == '1' ]] || die "Production .env must contain exactly one ${key} entry."
  done
  if [[ "$verify_build_keys" == 'true' ]]; then
    for key in BUILD_SHA BUILD_TIME BUILD_MIGRATION BUILD_MIGRATION_HASH; do
      count="$(env_key_count "$key")"
      [[ "$count" == '1' ]] || die "Production .env must contain exactly one ${key} entry."
    done
  fi
  count="$(env_key_count GATEWAY_BIND_ADDRESS)"
  (( count <= 1 )) || die 'Production .env contains duplicate GATEWAY_BIND_ADDRESS entries.'
  if [[ "$verify_build_keys" == 'true' ]]; then
    for key in \
      TOKEMS_COMPATIBILITY_ROLLBACK \
      TOKEMS_ROLLBACK_CODE_MIGRATION \
      TOKEMS_ROLLBACK_CODE_MIGRATION_HASH; do
      count="$(env_key_count "$key")"
      (( count <= 1 )) || die "Production .env contains duplicate ${key} entries."
    done
  fi
}

assert_production_environment() {
  local verify_build_keys="${1:-true}"
  assert_unique_production_env_keys "$verify_build_keys"
  [[ "$(env_value DEPLOYMENT_MODE)" == 'production' ]] || die 'DEPLOYMENT_MODE must equal production.'
  [[ "$(env_value SEED_DEMO_DATA)" == 'false' ]] || die 'SEED_DEMO_DATA must remain false in .env.'
  [[ "$(env_value PUBLIC_ORGANIZATION_SLUG)" == "$CANONICAL_ORGANIZATION_SLUG" ]] || {
    die "PUBLIC_ORGANIZATION_SLUG must equal ${CANONICAL_ORGANIZATION_SLUG}."
  }
  [[ "$(env_value NUXT_PUBLIC_ORGANIZATION_SLUG)" == "$CANONICAL_ORGANIZATION_SLUG" ]] || {
    die "NUXT_PUBLIC_ORGANIZATION_SLUG must equal ${CANONICAL_ORGANIZATION_SLUG}."
  }
  [[ "$(env_value PUBLIC_ORIGIN)" == "$PUBLIC_ORIGIN" ]] || die "PUBLIC_ORIGIN must equal ${PUBLIC_ORIGIN}."
  [[ "$(env_value ADMIN_ORIGIN)" == "$ADMIN_ORIGIN" ]] || die "ADMIN_ORIGIN must equal ${ADMIN_ORIGIN}."
  [[ "$(env_value PAYMENT_PUBLIC_ORIGIN)" == "$PAYMENT_ORIGIN" ]] || {
    die "PAYMENT_PUBLIC_ORIGIN must equal ${PAYMENT_ORIGIN}."
  }
  [[ "$(env_value PAYMENT_PUBLIC_BASE_PATH)" == "$PAYMENT_BASE_PATH" ]] || {
    die "PAYMENT_PUBLIC_BASE_PATH must equal ${PAYMENT_BASE_PATH}."
  }
  [[ "$(env_value PAYMENT_PUBLIC_URL)" == "$PAYMENT_PUBLIC_URL" ]] || {
    die "PAYMENT_PUBLIC_URL must equal ${PAYMENT_PUBLIC_URL}."
  }
  [[ "$(env_value CUSTOMER_OTP_MODE)" == 'provider' ]] || die 'CUSTOMER_OTP_MODE must equal provider.'
  [[ "$(env_value ALLOW_INSECURE_LOCAL_AUTH)" == 'false' ]] || {
    die 'ALLOW_INSECURE_LOCAL_AUTH must equal false.'
  }
  [[ "$(env_value VITE_SIMPLE_AUTH)" == 'false' ]] || die 'VITE_SIMPLE_AUTH must equal false.'
  [[ "$(env_value ENABLE_LOCAL_PAYMENT_SIMULATION)" == 'false' ]] || {
    die 'ENABLE_LOCAL_PAYMENT_SIMULATION must equal false.'
  }
  if awk -F= '$1 ~ /^(COMPOSE_|DOCKER_(HOST|CONTEXT|CONFIG|TLS_VERIFY|CERT_PATH|API_VERSION)$)/ { found = 1 } END { exit(found ? 0 : 1) }' "$active_env_file"; then
    die 'Production .env must not define Docker or Compose control variables.'
  fi
  local gateway_bind
  gateway_bind="$(env_value GATEWAY_BIND_ADDRESS)"
  [[ -z "$gateway_bind" || "$gateway_bind" == '127.0.0.1' ]] || {
    die 'GATEWAY_BIND_ADDRESS must remain on 127.0.0.1.'
  }
}

github_get() {
  local url="$1"
  local -a headers=(
    -H 'Accept: application/vnd.github+json'
    -H 'X-GitHub-Api-Version: 2022-11-28'
    -H 'User-Agent: TokEMS-production-deploy'
  )
  curl "${CURL_ARGS[@]}" --location "${headers[@]}" "$url"
}

github_main_sha() {
  github_get "https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/main" \
    | python3 -c '
import json, re, sys
payload = json.load(sys.stdin)
sha = payload.get("sha", "")
if not re.fullmatch(r"[0-9a-f]{40}", sha):
    raise SystemExit("GitHub main did not resolve to a full lowercase commit SHA")
print(sha)
'
}

assert_github_main_unchanged() {
  local latest_sha
  latest_sha="$(github_main_sha)"
  [[ "$latest_sha" == "$target_sha" ]] || {
    die "GitHub main advanced to ${latest_sha}; approved target was ${target_sha}."
  }
  assert_target_selection "$latest_sha"
}

verify_github_release_gate() {
  log "Verifying merged PR and successful main CI for ${target_sha}"
  github_get "https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${target_sha}/pulls?per_page=100" \
    | python3 -c '
import json, sys
target = sys.argv[1]
pulls = json.load(sys.stdin)
valid = [
    item for item in pulls
    if item.get("merged_at")
    and item.get("merge_commit_sha") == target
    and (item.get("base") or {}).get("ref") == "main"
]
if not valid:
    raise SystemExit("origin/main is not associated with a merged pull request")
print("Merged PR verified: #{}".format(valid[0]["number"]))
' "$target_sha"

  github_get "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100" \
    | python3 -c '
import json, sys
target = sys.argv[1]
payload = json.load(sys.stdin)
valid = [
    item for item in payload.get("workflow_runs", [])
    if item.get("name") == "tokems-ci"
    and item.get("path") == ".github/workflows/ci.yml"
    and item.get("event") == "push"
    and item.get("head_branch") == "main"
    and item.get("head_sha") == target
    and item.get("status") == "completed"
    and item.get("conclusion") == "success"
    and (item.get("repository") or {}).get("full_name") == "yaojingang/TokEMS"
    and (item.get("head_repository") or {}).get("full_name") == "yaojingang/TokEMS"
]
if not valid:
    raise SystemExit("official main push workflow has not completed successfully for origin/main")
print("Official main push workflow verified: run {}".format(valid[0]["id"]))
' "$target_sha"

  github_get "https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${target_sha}/check-runs?per_page=100" \
    | python3 -c '
import json, sys
target = sys.argv[1]
payload = json.load(sys.stdin)
valid = [
    item for item in payload.get("check_runs", [])
    if item.get("name") == "quality-and-flows"
    and item.get("head_sha") == target
    and item.get("status") == "completed"
    and item.get("conclusion") == "success"
    and (item.get("app") or {}).get("slug") == "github-actions"
    and "/yaojingang/TokEMS/actions/runs/" in (item.get("details_url") or "")
]
if not valid:
    raise SystemExit("official GitHub Actions quality-and-flows job has not completed successfully for origin/main")
print("Official GitHub Actions quality-and-flows job verified")
' "$target_sha"
}

verify_image_publish_gate() {
  log "Verifying successful immutable image publication for ${target_sha}"
  github_get "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/publish-images.yml/runs?branch=main&event=workflow_run&per_page=100" \
    | python3 -c '
import json, sys
target = sys.argv[1]
payload = json.load(sys.stdin)
valid = [
    item for item in payload.get("workflow_runs", [])
    if item.get("name") == "tokems-image-publish"
    and item.get("path") == ".github/workflows/publish-images.yml"
    and item.get("event") == "workflow_run"
    and item.get("head_branch") == "main"
    and item.get("head_sha") == target
    and item.get("status") == "completed"
    and item.get("conclusion") == "success"
    and (item.get("repository") or {}).get("full_name") == "yaojingang/TokEMS"
    and (item.get("head_repository") or {}).get("full_name") == "yaojingang/TokEMS"
]
if not valid:
    raise SystemExit("official image publication workflow has not completed successfully for origin/main")
print("Official image publication workflow verified: run {}".format(valid[0]["id"]))
' "$target_sha"
}

expected_release_platform() {
  case "$(uname -m)" in
    x86_64) printf 'linux/amd64\n' ;;
    aarch64 | arm64) printf 'linux/arm64\n' ;;
    *) die "Unsupported production CPU architecture: $(uname -m)" ;;
  esac
}

registry_docker() {
  [[ -n "$registry_auth_dir" && -d "$registry_auth_dir" ]] || die 'Temporary GHCR authentication is unavailable.'
  env -i \
    "PATH=$SAFE_PATH" \
    'HOME=/root' \
    "DOCKER_HOST=$LOCAL_DOCKER_HOST" \
    "DOCKER_CONFIG=$registry_auth_dir" \
    docker "$@"
}

registry_gh() {
  [[ -n "$registry_auth_dir" && -d "$registry_auth_dir" ]] || die 'Temporary GHCR authentication is unavailable.'
  local token
  IFS= read -r token <"$GHCR_TOKEN_FILE"
  [[ -n "$token" && "$token" != *[[:space:]]* ]] || die 'GHCR read token file contains an invalid value.'
  env -i \
    "PATH=$SAFE_PATH" \
    'HOME=/root' \
    "XDG_CACHE_HOME=$registry_auth_dir/cache" \
    "DOCKER_CONFIG=$registry_auth_dir" \
    "GH_TOKEN=$token" \
    gh "$@"
}

login_ghcr() {
  require_command gh
  docker buildx version >/dev/null || die 'Docker Buildx is required to inspect immutable release images.'
  gh attestation verify --help >/dev/null || die 'GitHub CLI does not support attestation verification.'

  local network_status
  network_status="$({
    env -i "PATH=$SAFE_PATH" 'HOME=/root' curl \
      --silent \
      --show-error \
      --connect-timeout 10 \
      --max-time 30 \
      --output /dev/null \
      --write-out '%{http_code}' \
      "https://${GHCR_REGISTRY}/v2/"
  } 2>/dev/null)" || die 'GHCR network probe failed before authentication.'
  [[ "$network_status" == '200' || "$network_status" == '401' ]] || {
    die "GHCR network probe returned unexpected HTTP status ${network_status}."
  }
  [[ -e "$GHCR_TOKEN_FILE" || -L "$GHCR_TOKEN_FILE" ]] || {
    die "GHCR read token file is missing: ${GHCR_TOKEN_FILE}"
  }
  assert_trusted_recovery_file "$GHCR_TOKEN_FILE"

  registry_auth_dir="$(mktemp -d "${LOCK_DIR}/registry-auth.XXXXXX")"
  chmod 700 "$registry_auth_dir"
  local token login_error
  IFS= read -r token <"$GHCR_TOKEN_FILE"
  [[ -n "$token" && "$token" != *[[:space:]]* ]] || die 'GHCR read token file contains an invalid value.'
  login_error="$registry_auth_dir/login.err"
  if ! printf '%s' "$token" \
    | env -i \
      "PATH=$SAFE_PATH" \
      'HOME=/root' \
      "DOCKER_HOST=$LOCAL_DOCKER_HOST" \
      "DOCKER_CONFIG=$registry_auth_dir" \
      docker login "$GHCR_REGISTRY" --username "$GHCR_USERNAME" --password-stdin \
      >/dev/null 2>"$login_error"; then
    die 'GHCR authentication failed; the read token may be expired or invalid.'
  fi
  : >"$login_error"
  local package_name package_visibility
  package_name="${GHCR_PACKAGE##*/}"
  package_visibility="$(registry_gh api "/users/yaojingang/packages/container/${package_name}" --jq .visibility)" || {
    die 'Unable to verify the TokEMS GHCR package visibility.'
  }
  [[ "$package_visibility" == 'private' ]] || die 'The TokEMS GHCR package must remain private.'
}

prepare_release_source_bundle() {
  [[ -z "$descriptor_evidence_dir" ]] || die 'Release descriptor preparation ran more than once.'
  login_ghcr
  descriptor_platform="$(expected_release_platform)"
  descriptor_evidence_dir="$(mktemp -d "${LOCK_DIR}/release-descriptor.XXXXXX")"
  chmod 700 "$descriptor_evidence_dir"

  local release_ref descriptor_ref labels_file bootstrap_records_file
  local source_bundle_file verifier git_group target_verifier_hash
  release_ref="${GHCR_PACKAGE}:release-${target_sha}"
  labels_file="$descriptor_evidence_dir/labels.json"
  bootstrap_records_file="$descriptor_evidence_dir/bootstrap-records.tsv"
  source_bundle_file="$descriptor_evidence_dir/source.bundle"
  verifier="$descriptor_evidence_dir/release-descriptor.py"

  descriptor_digest="$(registry_docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$release_ref")"
  [[ "$descriptor_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Release descriptor has an invalid registry digest.'
  descriptor_ref="${GHCR_PACKAGE}@${descriptor_digest}"
  registry_docker buildx imagetools inspect \
    --format '{{json .Image.Config.Labels}}' \
    "$descriptor_ref" >"$labels_file" || {
    die "Immutable release descriptor is missing or unreadable: release-${target_sha}"
  }
  printf '%s\n' "$descriptor_digest" >"$descriptor_evidence_dir/descriptor-digest.txt"
  registry_gh attestation verify "oci://${GHCR_PACKAGE}@${descriptor_digest}" \
    --repo "$GITHUB_REPOSITORY" \
    --signer-workflow "${GITHUB_REPOSITORY}/${IMAGE_PUBLISH_WORKFLOW}" \
    --source-digest "$target_sha" \
    --source-ref refs/heads/main \
    --deny-self-hosted-runners \
    --format json >"$descriptor_evidence_dir/descriptor-attestation.json"

  python3 - "$labels_file" "$target_sha" "$descriptor_platform" >"$bootstrap_records_file" <<'PY'
import json
import re
import sys

labels_file, target_sha, platform = sys.argv[1:]
with open(labels_file, encoding="utf-8") as handle:
    labels = json.load(handle)
if not isinstance(labels, dict):
    raise SystemExit("release descriptor labels must be a JSON object")

expected = {
    "org.opencontainers.image.source": "https://github.com/yaojingang/TokEMS",
    "org.opencontainers.image.revision": target_sha,
    "com.tokems.release.schema": "2",
    "com.tokems.release.platform": platform,
    "com.tokems.release.source-bundle.ref": "refs/heads/tokems-release-source",
    "com.tokems.build.sha": target_sha,
}
for key, value in expected.items():
    if labels.get(key) != value:
        raise SystemExit(f"release descriptor bootstrap label mismatch: {key}")

for record_name, key in (
    ("source-bundle-sha256", "com.tokems.release.source-bundle.sha256"),
    ("verifier-sha256", "com.tokems.release.verifier.sha256"),
):
    value = labels.get(key, "")
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise SystemExit(f"release descriptor bootstrap hash is invalid: {key}")
    print("release", record_name, value, sep="\t")
PY

  while IFS=$'\t' read -r record_type record_name record_value; do
    case "${record_type}:${record_name}" in
      release:source-bundle-sha256) descriptor_source_bundle_sha256="$record_value" ;;
      release:verifier-sha256) descriptor_verifier_sha256="$record_value" ;;
      *) die "Unexpected bootstrap descriptor record: ${record_type}:${record_name}" ;;
    esac
  done <"$bootstrap_records_file"

  registry_docker pull --platform "$descriptor_platform" "$descriptor_ref" \
    >"$descriptor_evidence_dir/descriptor-pull.log" 2>&1 || {
    die 'Unable to pull the verified release descriptor payload.'
  }
  descriptor_container_id="$(registry_docker create "$descriptor_ref" /release/source.bundle)"
  [[ -n "$descriptor_container_id" ]] || die 'Unable to create a temporary descriptor payload container.'
  registry_docker cp "${descriptor_container_id}:/release/source.bundle" "$source_bundle_file"
  registry_docker cp "${descriptor_container_id}:/release/release-descriptor.py" "$verifier"
  registry_docker rm "$descriptor_container_id" >/dev/null
  descriptor_container_id=''

  [[ -f "$source_bundle_file" && ! -L "$source_bundle_file" ]] || die 'Descriptor source bundle is not a regular file.'
  [[ -f "$verifier" && ! -L "$verifier" ]] || die 'Descriptor verifier is not a regular file.'
  [[ "$(sha256sum "$source_bundle_file" | awk '{ print $1 }')" == "$descriptor_source_bundle_sha256" ]] || {
    die 'Descriptor source bundle payload hash does not match its verified label.'
  }
  [[ "$(sha256sum "$verifier" | awk '{ print $1 }')" == "$descriptor_verifier_sha256" ]] || {
    die 'Descriptor verifier payload hash does not match its verified label.'
  }
  chmod 600 "$source_bundle_file" "$verifier"

  source_bundle_dir="$(mktemp -d /run/tokems-release-source.XXXXXX)"
  [[ -d "$source_bundle_dir" && ! -L "$source_bundle_dir" ]] || die 'Unable to create a trusted source bundle transport directory.'
  chmod 711 "$source_bundle_dir"
  git_group="$(id -gn "$GIT_USER")"
  install -o root -g "$git_group" -m 440 "$source_bundle_file" "$source_bundle_dir/source.bundle"
  install -o root -g "$git_group" -m 440 "$verifier" "$source_bundle_dir/release-descriptor.py"
  sudo -u "$GIT_USER" env -i \
    "PATH=$SAFE_PATH" \
    'HOME=/nonexistent' \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_NO_REPLACE_OBJECTS=1 \
    GIT_TERMINAL_PROMPT=0 \
    python3 "$source_bundle_dir/release-descriptor.py" import-source-bundle \
      --bundle-file "$source_bundle_dir/source.bundle" \
      --repository "$APP_DIR" \
      --target-sha "$target_sha" \
      --timeout-seconds "$GIT_BUNDLE_IMPORT_TIMEOUT_SECONDS" \
      >"$descriptor_evidence_dir/source-import.log" || {
    die 'Verified source bundle could not be imported into the production checkout.'
  }
  git_as_owner cat-file -e "${target_sha}^{commit}"

  target_verifier_hash="$({
    git_as_owner show "${target_sha}:tooling/release-descriptor.py" | sha256sum | awk '{ print $1 }'
  })" || die 'Unable to read the release descriptor verifier from the imported target source.'
  [[ "$target_verifier_hash" == "$descriptor_verifier_sha256" ]] || {
    die 'Descriptor verifier payload differs from the verified target source.'
  }

  find "$source_bundle_dir" -depth -delete
  source_bundle_dir=''
  printf 'target_sha=%s\nsource_bundle_sha256=%s\nverifier_sha256=%s\n' \
    "$target_sha" "$descriptor_source_bundle_sha256" "$descriptor_verifier_sha256" \
    >"$descriptor_evidence_dir/source-import.txt"
  chmod 600 "$descriptor_evidence_dir/source-import.txt"
  log "Imported verified main source bundle for ${target_sha}."
}

descriptor_image_ref() {
  case "$1" in
    api) printf '%s\n' "$descriptor_api_ref" ;;
    worker) printf '%s\n' "$descriptor_worker_ref" ;;
    web) printf '%s\n' "$descriptor_web_ref" ;;
    admin) printf '%s\n' "$descriptor_admin_ref" ;;
    gateway) printf '%s\n' "$descriptor_gateway_ref" ;;
    notification-sink) printf '%s\n' "$descriptor_notification_sink_ref" ;;
    *) die "Unknown release service: $1" ;;
  esac
}

local_image_for_service() {
  case "$1" in
    api) printf 'tokems-api\n' ;;
    worker) printf 'tokems-worker\n' ;;
    web) printf 'tokems-web\n' ;;
    admin) printf 'tokems-admin\n' ;;
    gateway) printf 'tokems-gateway\n' ;;
    notification-sink) printf 'tokems-notification-sink\n' ;;
    *) die "Unknown release service: $1" ;;
  esac
}

verify_release_descriptor() {
  [[ -n "$descriptor_evidence_dir" && -d "$descriptor_evidence_dir" ]] || {
    die 'Release descriptor source evidence is unavailable.'
  }
  [[ "$descriptor_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Verified descriptor digest is unavailable.'
  local verifier labels_file records_file source_migration source_migration_hash
  verifier="$descriptor_evidence_dir/release-descriptor.py"
  labels_file="$descriptor_evidence_dir/labels.json"
  records_file="$descriptor_evidence_dir/records.tsv"
  [[ -f "$verifier" && ! -L "$verifier" ]] || die 'Verified descriptor verifier is unavailable.'
  [[ -f "$labels_file" && ! -L "$labels_file" ]] || die 'Verified descriptor labels are unavailable.'
  python3 "$verifier" verify-descriptor \
    --labels-file "$labels_file" \
    --target-sha "$target_sha" \
    --platform "$descriptor_platform" \
    --records-output "$records_file"

  while IFS=$'\t' read -r record_type record_name record_value; do
    case "${record_type}:${record_name}" in
      build:sha) descriptor_build_sha="$record_value" ;;
      build:time) descriptor_build_time="$record_value" ;;
      build:migration) descriptor_migration="$record_value" ;;
      build:migration-hash) descriptor_migration_hash="$record_value" ;;
      release:platform) [[ "$record_value" == "$descriptor_platform" ]] || die 'Descriptor platform record changed during verification.' ;;
      release:source-bundle-ref) [[ "$record_value" == "$SOURCE_BUNDLE_REF" ]] || die 'Descriptor source bundle ref changed during verification.' ;;
      release:source-bundle-sha256) [[ "$record_value" == "$descriptor_source_bundle_sha256" ]] || die 'Descriptor source bundle hash changed during verification.' ;;
      release:verifier-sha256) [[ "$record_value" == "$descriptor_verifier_sha256" ]] || die 'Descriptor verifier hash changed during verification.' ;;
      image:api) descriptor_api_ref="$record_value" ;;
      image:worker) descriptor_worker_ref="$record_value" ;;
      image:web) descriptor_web_ref="$record_value" ;;
      image:admin) descriptor_admin_ref="$record_value" ;;
      image:gateway) descriptor_gateway_ref="$record_value" ;;
      image:notification-sink) descriptor_notification_sink_ref="$record_value" ;;
      *) die "Unexpected release descriptor record: ${record_type}:${record_name}" ;;
    esac
  done <"$records_file"

  [[ "$descriptor_build_sha" == "$target_sha" ]] || die 'Descriptor build SHA differs from the target commit.'
  python3 "$verifier" verify-source-bundle \
    --bundle-file "$descriptor_evidence_dir/source.bundle" \
    --target-sha "$target_sha"
  source_migration="$({
    git_as_owner ls-tree -r --name-only "$target_sha" -- packages/database/drizzle \
      | awk -F/ '$NF ~ /^[0-9][0-9][0-9][0-9]_.*[.]sql$/ { print $NF }' \
      | sort \
      | tail -n 1
  })"
  [[ "$source_migration" == "$descriptor_migration" ]] || die 'Descriptor migration differs from target source.'
  source_migration_hash="$(git_as_owner show "${target_sha}:packages/database/drizzle/${source_migration}" | sha256sum | awk '{ print $1 }')"
  [[ "$source_migration_hash" == "$descriptor_migration_hash" ]] || die 'Descriptor migration hash differs from target source.'

  local service image_ref metadata_file attestation_file
  for service in "${BUILD_SERVICES[@]}"; do
    image_ref="$(descriptor_image_ref "$service")"
    metadata_file="$descriptor_evidence_dir/image-${service}.json"
    attestation_file="$descriptor_evidence_dir/attestation-${service}.json"
    registry_docker buildx imagetools inspect --format '{{json .Image}}' "$image_ref" >"$metadata_file" || {
      die "Release descriptor image is missing or unreadable: ${service}"
    }
    python3 "$verifier" verify-service \
      --metadata-file "$metadata_file" \
      --service "$service" \
      --target-sha "$target_sha" \
      --build-time "$descriptor_build_time" \
      --migration "$descriptor_migration" \
      --migration-hash "$descriptor_migration_hash" \
      --platform "$descriptor_platform"
    registry_gh attestation verify "oci://${image_ref}" \
      --repo "$GITHUB_REPOSITORY" \
      --signer-workflow "${GITHUB_REPOSITORY}/${IMAGE_PUBLISH_WORKFLOW}" \
      --source-digest "$target_sha" \
      --source-ref refs/heads/main \
      --deny-self-hosted-runners \
      --format json >"$attestation_file"
  done
  log "Verified release descriptor ${descriptor_digest} for ${descriptor_platform}."
}

combined_build_capacity_kib() {
  awk '
    $1 == "MemAvailable:" { memory = $2 }
    $1 == "SwapFree:" { swap = $2 }
    END { print memory + swap }
  ' /proc/meminfo
}

assert_build_capacity() {
  local capacity_kib app_disk_kib docker_disk_kib docker_root
  capacity_kib="$(combined_build_capacity_kib)"
  app_disk_kib="$(df -Pk "$APP_DIR" | awk 'NR == 2 { print $4 }')"
  docker_root="$(docker info --format '{{.DockerRootDir}}')"
  [[ -n "$docker_root" && -d "$docker_root" ]] || die 'Docker reported an invalid data-root directory.'
  docker_disk_kib="$(df -Pk "$docker_root" | awk 'NR == 2 { print $4 }')"

  (( capacity_kib >= MIN_BUILD_CAPACITY_KIB )) || {
    die "In-place image build requires at least $((MIN_BUILD_CAPACITY_KIB / 1048576)) GiB of MemAvailable + SwapFree. Current: $((capacity_kib / 1048576)) GiB. Expand memory or adopt prebuilt images before deployment."
  }
  (( app_disk_kib >= MIN_BUILD_DISK_KIB )) || {
    die "${APP_DIR} filesystem needs at least $((MIN_BUILD_DISK_KIB / 1048576)) GiB free for a release build."
  }
  (( docker_disk_kib >= MIN_BUILD_DISK_KIB )) || {
    die "Docker data-root ${docker_root} needs at least $((MIN_BUILD_DISK_KIB / 1048576)) GiB free for a release build."
  }
}

read_database_size_bytes() {
  compose_bounded "$DB_QUERY_TIMEOUT_SECONDS" exec -T postgres sh -lc \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select pg_database_size(current_database())"'
}

resolved_compose_database_url() {
  compose config --format json | python3 -c '
import json, sys
payload = json.load(sys.stdin)
services = payload.get("services") or {}

def database_url(service_name):
    environment = (services.get(service_name) or {}).get("environment") or {}
    if not isinstance(environment, dict):
        raise SystemExit(f"{service_name} environment is unavailable")
    value = environment.get("DATABASE_URL")
    if not isinstance(value, str) or not value:
        raise SystemExit(f"{service_name} DATABASE_URL is unavailable")
    return value

api_url = database_url("api")
if database_url("db-init") != api_url or database_url("worker") != api_url:
    raise SystemExit("API, Worker, and db-init resolve different DATABASE_URL values")
sys.stdout.write(api_url)
'
}

database_proof_from_api_container() {
  local challenge="$1" source_mode="$2" api_container
  api_container="$(compose ps -q api)"
  [[ -n "$api_container" ]] || die 'API container is unavailable for database identity proof.'

  if [[ "$source_mode" == 'runtime' ]]; then
    timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker exec \
      -e TOKEMS_DB_CHALLENGE="$challenge" \
      "$api_container" \
      node --input-type=module -e \
      "import { createHash } from 'node:crypto'; import pg from 'pg'; const client = new pg.Client({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 10000}); try { await client.connect(); const result = await client.query(\`select system_identifier::text as \"systemIdentifier\", current_database() as \"databaseName\", (select oid::text from pg_database where datname = current_database()) as \"databaseOid\", extract(epoch from pg_postmaster_start_time())::text as \"startedAt\" from pg_control_system()\`); const row=result.rows[0]; console.log(createHash('sha256').update([process.env.TOKEMS_DB_CHALLENGE,row.systemIdentifier,row.databaseName,row.databaseOid,row.startedAt].join('\\n')).digest('hex')); } finally { await client.end().catch(() => {}); }"
    return
  fi

  [[ "$source_mode" == 'compose' ]] || die 'Unknown API database proof source mode.'
  resolved_compose_database_url | timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker exec -i \
    -e TOKEMS_DB_CHALLENGE="$challenge" \
    "$api_container" \
    node --input-type=module -e \
    "import { createHash } from 'node:crypto'; import pg from 'pg'; let connectionString=''; for await (const chunk of process.stdin) connectionString += chunk; const client = new pg.Client({connectionString, connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 10000}); try { await client.connect(); const result = await client.query(\`select system_identifier::text as \"systemIdentifier\", current_database() as \"databaseName\", (select oid::text from pg_database where datname = current_database()) as \"databaseOid\", extract(epoch from pg_postmaster_start_time())::text as \"startedAt\" from pg_control_system()\`); const row=result.rows[0]; console.log(createHash('sha256').update([process.env.TOKEMS_DB_CHALLENGE,row.systemIdentifier,row.databaseName,row.databaseOid,row.startedAt].join('\\n')).digest('hex')); } finally { await client.end().catch(() => {}); }"
}

database_proof_from_compose_postgres() {
  local challenge="$1" identity
  identity="$(
    compose_bounded "$DB_PROOF_TIMEOUT_SECONDS" exec -T postgres sh -lc \
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -c '\''select system_identifier::text, current_database(), (select oid::text from pg_database where datname = current_database()), extract(epoch from pg_postmaster_start_time())::text from pg_control_system()'\'''
  )"
  python3 -c '
import hashlib, sys
fields = sys.argv[2].split("|")
if len(fields) != 4 or any(not field for field in fields):
    raise SystemExit("Compose PostgreSQL identity is incomplete")
print(hashlib.sha256("\n".join([sys.argv[1], *fields]).encode()).hexdigest())
' "$challenge" "$identity"
}

assert_api_uses_compose_database() {
  local challenge runtime_proof resolved_proof postgres_proof
  challenge="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  runtime_proof="$(database_proof_from_api_container "$challenge" runtime)"
  resolved_proof="$(database_proof_from_api_container "$challenge" compose)"
  postgres_proof="$(database_proof_from_compose_postgres "$challenge")"
  [[ "$runtime_proof" =~ ^[0-9a-f]{64}$ && "$resolved_proof" =~ ^[0-9a-f]{64}$ && "$postgres_proof" =~ ^[0-9a-f]{64}$ ]] || {
    die 'Database identity proof returned an invalid digest.'
  }
  [[ "$runtime_proof" == "$postgres_proof" ]] || {
    die 'The running API is not connected to the protected Compose PostgreSQL database.'
  }
  [[ "$resolved_proof" == "$postgres_proof" ]] || {
    die 'Resolved API, Worker, and db-init configuration does not target the protected Compose PostgreSQL database.'
  }
}

database_write_mode_from_api_container() {
  local api_container
  api_container="$(compose ps -q api)"
  [[ -n "$api_container" ]] || die 'API container is unavailable for write-mode verification.'
  timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker exec \
    "$api_container" \
    node --input-type=module -e \
    "import pg from 'pg'; const client = new pg.Client({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 10000}); try { await client.connect(); const result = await client.query('show default_transaction_read_only'); console.log(result.rows[0].default_transaction_read_only); } finally { await client.end().catch(() => {}); }"
}

assert_operational_write_state() {
  local expected_mode="$1" database_mode worker_container runtime_command image_command
  database_mode="$(database_write_mode_from_api_container)"
  worker_container="$(compose ps -q worker)"
  [[ -n "$worker_container" ]] || die 'Worker container is unavailable for command verification.'
  runtime_command="$(timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker inspect --format '{{json .Config.Cmd}}' "$worker_container")"
  image_command="$(timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker image inspect --format '{{json .Config.Cmd}}' tokems-worker:local)"

  if [[ "$expected_mode" == 'normal' ]]; then
    [[ "$database_mode" == 'off' ]] || die 'Production API database session is unexpectedly read-only.'
    python3 -c '
import json, sys
if json.loads(sys.argv[1]) != json.loads(sys.argv[2]):
    raise SystemExit("Worker command differs from the standard image command")
' "$runtime_command" "$image_command"
    return
  fi

  [[ "$expected_mode" == 'recovery' ]] || die 'Unknown operational write-state expectation.'
  [[ "$database_mode" == 'on' ]] || die 'Pending recovery API is not using a read-only database session.'
  python3 -c '
import json, sys
expected = ["node", "-e", "setInterval(() => {}, 1000)"]
if json.loads(sys.argv[1]) != expected:
    raise SystemExit("Pending recovery Worker is not paused")
' "$runtime_command"
}

assert_backup_capacity() {
  local database_bytes required_kib available_kib capacity_path
  database_bytes="$(read_database_size_bytes)"
  [[ "$database_bytes" =~ ^[0-9]+$ ]] || die 'PostgreSQL returned an invalid database size.'
  capacity_path="$BACKUP_ROOT"
  while [[ ! -e "$capacity_path" ]]; do
    [[ "$capacity_path" != '/' ]] || die 'No existing parent was found for the production backup directory.'
    capacity_path="$(dirname "$capacity_path")"
  done
  [[ -d "$capacity_path" ]] || die "Backup capacity path is not a directory: ${capacity_path}"
  backup_device_id="$(stat -c '%d' "$capacity_path")"
  available_kib="$(df -Pk "$capacity_path" | awk 'NR == 2 { print $4 }')"
  required_kib=$(( (database_bytes * 4 + 1023) / 1024 + MIN_BACKUP_RESERVE_KIB ))
  (( available_kib >= required_kib )) || {
    die "Backup filesystem needs $((required_kib / 1048576)) GiB free for two dumps, production-ID evidence, and the protected reserve."
  }
}

assert_final_backup_capacity() {
  local database_bytes stable_bytes retention_bytes required_bytes required_kib available_kib
  database_bytes="$(read_database_size_bytes)"
  [[ "$database_bytes" =~ ^[0-9]+$ ]] || die 'PostgreSQL returned an invalid final database size.'
  [[ -d "$backup_dir" ]] || die "Release backup directory is missing: ${backup_dir}"
  [[ "$(stat -c '%d' "$backup_dir")" == "$backup_device_id" ]] || {
    die 'The release backup directory is on a different filesystem from the preflight capacity check.'
  }
  stable_bytes="$(stat -c '%s' "$backup_dir/protected-business-ids-build-start.csv")"
  retention_bytes="$(stat -c '%s' "$backup_dir/retention-managed-ids-build-start.csv")"
  available_kib="$(df -Pk "$backup_dir" | awk 'NR == 2 { print $4 }')"
  required_bytes=$(( database_bytes + 6 * stable_bytes + 4 * retention_bytes ))
  required_kib=$(( (required_bytes + 1023) / 1024 + MIN_BACKUP_RESERVE_KIB ))
  (( available_kib >= required_kib )) || {
    die "Final backup and measured production-ID evidence need $((required_kib / 1048576)) GiB free after image preparation."
  }
}

assert_release_verification_capacity() {
  local stable_bytes retention_bytes required_bytes required_kib available_kib
  stable_bytes="$(stat -c '%s' "$backup_dir/protected-business-ids-before.csv")"
  retention_bytes="$(stat -c '%s' "$backup_dir/retention-managed-ids-before.csv")"
  available_kib="$(df -Pk "$backup_dir" | awk 'NR == 2 { print $4 }')"
  required_bytes=$(( 2 * stable_bytes + retention_bytes ))
  required_kib=$(( (required_bytes + 1023) / 1024 + MIN_BACKUP_RESERVE_KIB ))
  (( available_kib >= required_kib )) || {
    die "Release verification evidence needs $((required_kib / 1048576)) GiB free after the final database backup."
  }
}

assert_post_thaw_evidence_capacity() {
  local stable_bytes required_kib available_kib
  stable_bytes="$(stat -c '%s' "$backup_dir/protected-business-ids-after.csv")"
  available_kib="$(df -Pk "$backup_dir" | awk 'NR == 2 { print $4 }')"
  required_kib=$(( (stable_bytes + 1023) / 1024 + MIN_BACKUP_RESERVE_KIB ))
  (( available_kib >= required_kib )) || {
    die "Post-thaw production evidence needs $((required_kib / 1048576)) GiB free before writes resume."
  }
}

json_sha_from_stdin() {
  python3 -c '
import json, re, sys
payload = json.load(sys.stdin)
sha = payload.get("sha") or (payload.get("build") or {}).get("sha")
if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
    raise SystemExit("version response did not contain a full build SHA")
print(sha)
'
}

build_fingerprint_from_stdin() {
  local expected_service="$1"
  python3 -c '
import json, re, sys
payload = json.load(sys.stdin)
build = payload.get("build", payload)
expected_service = sys.argv[1]
if build.get("service") != expected_service:
    raise SystemExit(f"expected {expected_service} build metadata")
values = [build.get(key) for key in ("sha", "builtAt", "migration", "migrationHash")]
if not isinstance(values[0], str) or not re.fullmatch(r"[0-9a-f]{40}", values[0]):
    raise SystemExit("build metadata did not contain a full SHA")
if any(not isinstance(value, str) or not value or value == "unknown" for value in values[1:]):
    raise SystemExit("build metadata contains an unknown value")
print("|".join(values))
' "$expected_service"
}

assert_health_json() {
  python3 -c '
import json, sys
payload = json.load(sys.stdin)
if payload.get("status") != "ok":
    raise SystemExit("health status is not ok")
database = payload.get("database") or {}
if database.get("ok") is not True or (database.get("migration") or {}).get("ok") is not True:
    raise SystemExit("database or migration health is not current")
'
}

assert_service_healthy() {
  local service="$1" container_id running health
  container_id="$(compose ps -q "$service")"
  [[ -n "$container_id" ]] || die "Compose service has no container: ${service}"
  running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
  [[ "$running" == 'true' ]] || die "Compose service is not running: ${service}"
  [[ "$health" == 'healthy' || "$health" == 'none' ]] || die "Compose service is not healthy: ${service} (${health})"
}

wait_for_worker_ready() {
  local deadline=$((SECONDS + WORKER_READY_TIMEOUT_SECONDS))
  local worker_container started_at running ready_fingerprint expected_fingerprint started_epoch ready_protocol
  local persistent_ready_supported='false'
  expected_fingerprint="${runtime_sha}|${runtime_time}|${runtime_migration}|${runtime_migration_hash}"
  worker_container="$(compose ps -q worker)"
  [[ -n "$worker_container" ]] || die 'Worker container is unavailable for readiness capability detection.'
  ready_protocol="$(docker inspect --format '{{index .Config.Labels "com.tokems.worker-ready-protocol"}}' "$worker_container")"
  if [[ "$ready_protocol" == '1' ]]; then
    persistent_ready_supported='true'
  fi
  while (( SECONDS < deadline )); do
    worker_container="$(compose ps -q worker)"
    [[ -n "$worker_container" ]] || die 'Worker container disappeared while waiting for readiness.'
    running="$(timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker inspect --format '{{.State.Running}}' "$worker_container")"
    [[ "$running" == 'true' ]] || die 'Worker stopped before reporting readiness.'
    started_at="$(timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker inspect --format '{{.State.StartedAt}}' "$worker_container")"
    if [[ "$persistent_ready_supported" == 'true' ]]; then
      if ready_fingerprint="$(
        timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" \
          docker exec "$worker_container" node -e \
          "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync('/tmp/tokems-worker-ready.json','utf8'));process.stdout.write([value.sha,value.builtAt,value.migration,value.migrationHash].join('|'))" \
          2>/dev/null
      )" && [[ "$ready_fingerprint" == "$expected_fingerprint" ]]; then
        log 'Worker startup maintenance completed and its persistent ready identity matches the running release.'
        return 0
      fi
    else
      started_epoch="$(date -d "$started_at" '+%s')" || die 'Unable to parse the legacy Worker start time.'
      if (( $(date '+%s') - started_epoch >= 300 )); then
        log 'Legacy Worker predates the persistent ready identity; five minutes of healthy uptime satisfies this transitional preflight.'
        return 0
      fi
      if timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" \
        docker logs --since "$started_at" "$worker_container" 2>&1 \
        | grep -F '[worker] ready queue=' >/dev/null; then
        log 'Legacy Worker startup maintenance ready signal was observed.'
        return 0
      fi
    fi
    sleep "$WORKER_READY_POLL_SECONDS"
  done
  die "Worker did not report readiness within ${WORKER_READY_TIMEOUT_SECONDS} seconds."
}

assert_runtime_image() {
  local service="$1" image="$2" container_id running_image tagged_image
  container_id="$(compose ps -q "$service")"
  running_image="$(docker inspect --format '{{.Image}}' "$container_id")"
  tagged_image="$(docker image inspect --format '{{.Id}}' "${image}:local")"
  [[ "$running_image" == "$tagged_image" ]] || {
    die "${image}:local does not match the currently running ${service} container."
  }
}

assert_runtime_image_tags() {
  assert_runtime_image api tokems-api
  assert_runtime_image worker tokems-worker
  assert_runtime_image web tokems-web
  assert_runtime_image payment-web tokems-web
  assert_runtime_image admin tokems-admin
  assert_runtime_image gateway tokems-gateway
  assert_runtime_image notification-sink tokems-notification-sink
}

assert_current_runtime_identity() {
  local verify_environment="${1:-true}"
  local gateway_json web_json admin_json health_json worker_json
  local gateway_fingerprint web_fingerprint admin_fingerprint api_fingerprint worker_fingerprint
  local gateway_sha gateway_time gateway_migration gateway_migration_hash
  local api_sha api_time api_migration api_migration_hash
  local worker_container

  gateway_json="$(curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/version.json')"
  web_json="$(curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/web-version.json')"
  admin_json="$(curl "${CURL_ARGS[@]}" -H 'Host: admin.hui.ailingdaoli.com' 'http://127.0.0.1:8088/admin/version.json')"
  health_json="$(curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/api/v1/health')"
  printf '%s' "$health_json" | assert_health_json
  worker_container="$(compose ps -q worker)"
  worker_json="$(
    timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker exec "$worker_container" node -e \
      "console.log(JSON.stringify({service:'worker',sha:process.env.BUILD_SHA,builtAt:process.env.BUILD_TIME,migration:process.env.BUILD_MIGRATION,migrationHash:process.env.BUILD_MIGRATION_HASH}))"
  )"

  gateway_fingerprint="$(printf '%s' "$gateway_json" | build_fingerprint_from_stdin gateway)"
  web_fingerprint="$(printf '%s' "$web_json" | build_fingerprint_from_stdin web)"
  admin_fingerprint="$(printf '%s' "$admin_json" | build_fingerprint_from_stdin admin)"
  api_fingerprint="$(printf '%s' "$health_json" | build_fingerprint_from_stdin api)"
  worker_fingerprint="$(printf '%s' "$worker_json" | build_fingerprint_from_stdin worker)"

  [[ "$web_fingerprint" == "$gateway_fingerprint" ]] || die 'Current web and gateway build identities are mixed.'
  [[ "$admin_fingerprint" == "$gateway_fingerprint" ]] || die 'Current admin and gateway build identities are mixed.'
  [[ "$worker_fingerprint" == "$api_fingerprint" ]] || die 'Current worker and API build identities are mixed.'

  IFS='|' read -r gateway_sha gateway_time gateway_migration gateway_migration_hash <<<"$gateway_fingerprint"
  IFS='|' read -r api_sha api_time api_migration api_migration_hash <<<"$api_fingerprint"
  [[ "$api_sha" == "$gateway_sha" && "$api_time" == "$gateway_time" ]] || {
    die 'Current API and Gateway code identities are mixed.'
  }

  runtime_sha="$gateway_sha"
  runtime_time="$gateway_time"
  runtime_code_migration="$gateway_migration"
  runtime_code_migration_hash="$gateway_migration_hash"
  runtime_migration="$api_migration"
  runtime_migration_hash="$api_migration_hash"

  if [[ "$api_migration" != "$gateway_migration" || "$api_migration_hash" != "$gateway_migration_hash" ]]; then
    [[ "$(env_value TOKEMS_COMPATIBILITY_ROLLBACK)" == 'active' ]] || {
      die 'Current API and Gateway migration identities are mixed without a compatibility rollback marker.'
    }
    [[ "$(env_value TOKEMS_ROLLBACK_CODE_MIGRATION)" == "$gateway_migration" ]] || {
      die 'Compatibility rollback code migration marker does not match Gateway.'
    }
    [[ "$(env_value TOKEMS_ROLLBACK_CODE_MIGRATION_HASH)" == "$gateway_migration_hash" ]] || {
      die 'Compatibility rollback code migration hash marker does not match Gateway.'
    }
    log "Compatibility rollback baseline detected: code=${gateway_sha}, database=${api_migration}"
  elif [[ "$verify_environment" == 'true' && -n "$(env_value TOKEMS_COMPATIBILITY_ROLLBACK)" ]]; then
    die 'Compatibility rollback marker is stale for a uniform runtime identity.'
  fi

  if [[ "$verify_environment" == 'true' ]]; then
    [[ "$(env_value BUILD_SHA)" == "$runtime_sha" ]] || die 'Production .env BUILD_SHA does not match the running release.'
    [[ "$(env_value BUILD_TIME)" == "$runtime_time" ]] || die 'Production .env BUILD_TIME does not match the running release.'
    [[ "$(env_value BUILD_MIGRATION)" == "$runtime_migration" ]] || die 'Production .env BUILD_MIGRATION does not match the running release.'
    [[ "$(env_value BUILD_MIGRATION_HASH)" == "$runtime_migration_hash" ]] || {
      die 'Production .env BUILD_MIGRATION_HASH does not match the running release.'
    }
  fi
}

capture_release_baseline() {
  [[ -z "$release_baseline_sha" ]] || die 'Release baseline identity was already captured.'
  [[ -n "$runtime_sha" && -n "$runtime_time" && -n "$runtime_migration" && -n "$runtime_migration_hash" ]] || {
    die 'Current runtime identity is incomplete; the release baseline cannot be captured.'
  }
  release_baseline_sha="$runtime_sha"
  release_baseline_time="$runtime_time"
  release_baseline_migration="$runtime_migration"
  release_baseline_migration_hash="$runtime_migration_hash"
  release_baseline_code_migration="$runtime_code_migration"
  release_baseline_code_migration_hash="$runtime_code_migration_hash"
}

canonical_snapshot_files_match() {
  local actual_snapshot="$1"
  shift
  [[ $# -gt 0 ]] || return 2
  python3 - "$actual_snapshot" "$@" <<'PY'
import json
import sys


def load_snapshot(file_name):
    with open(file_name, encoding="utf-8") as handle:
        return json.load(handle)


try:
    actual = load_snapshot(sys.argv[1])
    expected = [load_snapshot(file_name) for file_name in sys.argv[2:]]
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(2)

raise SystemExit(0 if actual in expected else 1)
PY
}

production_canonical_snapshot_matches_target() {
  local previous_read_only_compose_file="$read_only_compose_file"
  local read_only_url='' export_status=0 compare_status=0
  [[ -z "$canonical_probe_compose_file" && -z "$canonical_probe_target_snapshot" && -z "$canonical_probe_actual_snapshot" ]] || {
    die 'Canonical production probe state was already initialized.'
  }

  canonical_probe_compose_file="$(mktemp "${LOCK_DIR}/canonical-probe.compose.XXXXXX")" || return 2
  canonical_probe_target_snapshot="$(mktemp "${LOCK_DIR}/canonical-probe.target.XXXXXX")" || {
    cleanup_canonical_probe
    return 2
  }
  canonical_probe_actual_snapshot="$(mktemp "${LOCK_DIR}/canonical-probe.actual.XXXXXX")" || {
    cleanup_canonical_probe
    return 2
  }
  if ! cat >"$canonical_probe_compose_file" <<'YAML'
services:
  api:
    environment:
      DATABASE_URL: ${TOKEMS_READ_ONLY_DATABASE_URL:?TOKEMS_READ_ONLY_DATABASE_URL is required}
YAML
  then
    cleanup_canonical_probe
    return 2
  fi
  git_as_owner show "${target_sha}:${CANONICAL_SNAPSHOT_PATHS[0]}" >"$canonical_probe_target_snapshot" || {
    cleanup_canonical_probe
    return 2
  }
  chmod 600 \
    "$canonical_probe_compose_file" \
    "$canonical_probe_target_snapshot" \
    "$canonical_probe_actual_snapshot" || {
    cleanup_canonical_probe
    return 2
  }

  read_only_url="$(read_only_database_url)" || {
    cleanup_canonical_probe
    return 2
  }
  TOKEMS_READ_ONLY_DATABASE_URL="$read_only_url"
  export TOKEMS_READ_ONLY_DATABASE_URL
  read_only_compose_file="$canonical_probe_compose_file"
  compose_read_only_bounded "$DB_QUERY_TIMEOUT_SECONDS" run --rm --no-deps \
    -e CANONICAL_API_BASE_URL=http://api:4100/api/v1 \
    -e CANONICAL_EXPORT_TRUSTED_COMPOSE_INTERNAL=true \
    api \
    node node_modules/@conference/database/dist/export-canonical-homepage.js --stdout \
    >"$canonical_probe_actual_snapshot" 2>/dev/null || export_status=$?
  read_only_compose_file="$previous_read_only_compose_file"
  unset TOKEMS_READ_ONLY_DATABASE_URL
  if [[ $export_status -ne 0 ]]; then
    cleanup_canonical_probe
    return 2
  fi

  canonical_snapshot_files_match \
    "$canonical_probe_actual_snapshot" \
    "$canonical_probe_target_snapshot" || compare_status=$?
  cleanup_canonical_probe
  return "$compare_status"
}

determine_canonical_sync() {
  local changed='false' diff_status=0 production_status=0
  if git_as_owner diff --quiet "$release_baseline_sha" "$target_sha" -- "${CANONICAL_SNAPSHOT_PATHS[@]}"; then
    changed='false'
  else
    diff_status=$?
    [[ $diff_status -eq 1 ]] || die 'Unable to compare canonical snapshots across release commits.'
    changed='true'
  fi

  if [[ "$canonical_mode" == 'always' ]]; then
    canonical_sync_required='true'
    return 0
  fi
  if [[ "$changed" == 'true' ]]; then
    [[ "$canonical_mode" != 'never' ]] || {
      die 'Canonical snapshots changed; this release must run the protected canonical sync.'
    }
    canonical_sync_required='true'
    return 0
  fi

  if production_canonical_snapshot_matches_target; then
    canonical_sync_required='false'
    return 0
  else
    production_status=$?
  fi
  [[ $production_status -eq 1 ]] || {
    die 'Unable to compare the production canonical snapshot with the target; diagnose the read-only probe or rerun with --sync-canonical.'
  }

  log 'Production canonical snapshot drift detected.'
  [[ "$canonical_mode" != 'never' ]] || {
    die 'Cannot skip canonical synchronization while production is drifted.'
  }
  canonical_sync_required='true'
}

assert_standard_release_scope() {
  if ! git_as_owner diff --quiet "$release_baseline_sha" "$target_sha" -- docker-compose.yml; then
    die 'docker-compose.yml changed; use the reviewed infrastructure maintenance procedure for this release.'
  fi
}

canonical_repair_scope_is_compatible() {
  local changed_path changed_paths
  if ! git_as_owner diff --quiet "$release_baseline_sha" "$target_sha" -- "${CANONICAL_SNAPSHOT_PATHS[@]}"; then
    log 'Canonical snapshots changed since the running release; verified target images are required.'
    return 1
  fi

  changed_paths="$(git_as_owner diff --name-only "$release_baseline_sha" "$target_sha" --)" || {
    log 'Unable to inspect the target change scope; verified target images are required.'
    return 1
  }
  while IFS= read -r changed_path; do
    [[ -n "$changed_path" ]] || continue
    case "$changed_path" in
      AGENTS.md | docs/* | tooling/production-deploy.sh | tooling/lib/production-deploy.test.mjs) ;;
      *)
        log "Runtime-affecting target change requires the verified target images: ${changed_path}"
        return 1
        ;;
    esac
  done <<<"$changed_paths"
  return 0
}

run_full_preflight() {
  log 'Running production preflight'
  assert_minimal_git_state
  assert_production_environment
  assert_no_parallel_release
  assert_pending_recovery_policy

  assert_github_main_unchanged
  [[ "$(git_as_owner rev-parse "$EXPECTED_UPSTREAM_REF")" == "$target_sha" ]] || {
    die 'origin/main differs from the verified release source bundle.'
  }
  if [[ "$recovery_in_progress" == 'true' ]]; then
    git_as_owner cat-file -e "${pending_recovery_target_sha}^{commit}"
    git_as_owner merge-base --is-ancestor "$pending_recovery_target_sha" "$target_sha" || {
      die 'Current origin/main does not descend from the interrupted release target.'
    }
    log "Resumed recovery target lineage verified: ${pending_recovery_target_sha} -> ${target_sha}"
  fi
  source_head_before="$(git_as_owner rev-parse HEAD)"
  git_as_owner merge-base --is-ancestor "$source_head_before" "$target_sha" || {
    die 'Server production branch cannot fast-forward to origin/main.'
  }

  compose config --quiet
  docker info >/dev/null
  nginx -t

  local service
  for service in "${LONG_RUNNING_SERVICES[@]}"; do
    assert_service_healthy "$service"
  done
  assert_runtime_image_tags

  assert_current_runtime_identity
  capture_release_baseline
  assert_api_uses_compose_database
  if [[ "$recovery_in_progress" == 'true' ]]; then
    assert_operational_write_state recovery
  else
    assert_operational_write_state normal
    wait_for_worker_ready
  fi
  git_as_owner cat-file -e "${release_baseline_sha}^{commit}"
  git_as_owner merge-base --is-ancestor "$release_baseline_sha" "$target_sha" || {
    die 'The running production build is not an ancestor of origin/main.'
  }
  [[ "$(curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/version.json" | json_sha_from_stdin)" == "$release_baseline_sha" ]] || {
    die 'Public version endpoint differs from the local Gateway release.'
  }
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/health" | assert_health_json

  assert_standard_release_scope
  determine_canonical_sync
  if [[ "$canonical_sync_required" == 'true' ]] && canonical_repair_scope_is_compatible; then
    canonical_repair_mode='true'
    log 'Canonical repair can reuse the verified running images; host-build capacity is not required.'
  elif [[ "$build_on_host" == 'true' ]]; then
    assert_build_capacity
    log 'Emergency host-build preflight passed.'
  else
    [[ "$descriptor_build_sha" == "$target_sha" ]] || {
      die 'Prebuilt release descriptor evidence changed after bootstrap verification.'
    }
    log "Prebuilt descriptor remains verified: ${descriptor_digest}"
  fi
  assert_backup_capacity

  log "Runtime commit: ${release_baseline_sha}"
  log "Target commit:  ${target_sha}"
  log "Canonical sync: ${canonical_sync_required}"
}

capture_business_snapshot() {
  local output_file="$1"
  compose_bounded "$DB_QUERY_TIMEOUT_SECONDS" exec -T postgres sh -lc \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F ","' \
    >"$output_file" <<'SQL'
select metric, value
from (values
  ('customer_users', (select count(*)::bigint from customer_users)),
  ('registrations', (select count(*)::bigint from registrations)),
  ('orders', (select count(*)::bigint from orders)),
  ('tickets', (select count(*)::bigint from tickets)),
  ('invoice_requests', (select count(*)::bigint from invoice_requests))
) as snapshot(metric, value)
order by metric;
SQL
}

set_production_protection_cutoff() {
  local cutoff_temp="$backup_dir/production-protection-cutoff.txt.tmp.$$"
  protection_cutoff="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  printf '%s\n' "$protection_cutoff" >"$cutoff_temp"
  chmod 600 "$cutoff_temp"
  mv -f -- "$cutoff_temp" "$backup_dir/production-protection-cutoff.txt"
}

capture_protected_business_ids() {
  local output_file="$1" protection_profile="${2:-stable}" capture_role="${3:-baseline}"
  [[ "$protection_profile" == 'stable' || "$protection_profile" == 'retention' ]] || {
    die "Unexpected production protection profile: ${protection_profile}"
  }
  [[ "$capture_role" == 'baseline' || "$capture_role" == 'comparison' || "$capture_role" == 'growth_comparison' ]] || {
    die "Unexpected production protection capture role: ${capture_role}"
  }
  if [[ -z "$protection_cutoff" ]]; then
    [[ -s "$backup_dir/production-protection-cutoff.txt" ]] || {
      die 'The fixed production protection cutoff evidence is missing.'
    }
    protection_cutoff="$(<"$backup_dir/production-protection-cutoff.txt")"
  fi
  date -d "$protection_cutoff" '+%s' >/dev/null 2>&1 || die 'The production protection cutoff is invalid.'
  compose_bounded "$DB_QUERY_TIMEOUT_SECONDS" exec -T \
    -e PROTECTION_PROFILE="$protection_profile" \
    -e PROTECTION_CUTOFF="$protection_cutoff" \
    -e CAPTURE_ROLE="$capture_role" \
    postgres sh -lc \
    'psql -q -v ON_ERROR_STOP=1 -v protection_profile="$PROTECTION_PROFILE" -v protection_cutoff="$PROTECTION_CUTOFF" -v capture_role="$CAPTURE_ROLE" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F ","' \
    >"$output_file" <<'SQL'
create temp table release_protected_manifest (
  profile text not null,
  table_name text not null,
  row_predicate text not null,
  primary key (profile, table_name)
);

insert into release_protected_manifest (profile, table_name, row_predicate) values
  ('stable', 'organizations', 'true'),
  ('stable', 'events', 'true'),
  ('stable', 'users', 'true'),
  ('stable', 'customer_users', 'true'),
  ('stable', 'public_user_ids', 'true'),
  ('stable', 'customer_profiles', 'true'),
  ('stable', 'customer_media_assets', 'true'),
  ('stable', 'customer_consents', 'true'),
  ('stable', 'memberships', 'true'),
  ('stable', 'member_profiles', 'true'),
  ('stable', 'organization_integrations', 'true'),
  ('stable', 'organization_invitations', 'true'),
  ('stable', 'event_feishu_digest_subscriptions', 'true'),
  ('stable', 'feishu_digest_deliveries', 'true'),
  ('stable', 'event_releases', 'true'),
  ('stable', 'conference_template_versions', 'true'),
  ('stable', 'registrations', 'true'),
  ('stable', 'orders', 'true'),
  ('stable', 'attendee_claim_tokens', 'true'),
  ('stable', 'registration_purchase_attempts', 'true'),
  ('stable', 'order_state_logs', 'true'),
  ('stable', 'inventory_reservations', 'true'),
  ('stable', 'payments', 'true'),
  ('stable', 'attendee_showcase_profiles', 'true'),
  ('stable', 'attendee_need_submissions', 'true'),
  ('stable', 'attendee_need_questions', 'true'),
  ('stable', 'payment_notification_inbox', 'true'),
  ('stable', 'refunds', 'true'),
  ('stable', 'invoice_requests', 'true'),
  ('stable', 'invoice_documents', 'true'),
  ('stable', 'invoice_state_logs', 'true'),
  ('stable', 'invoice_export_jobs', 'true'),
  ('stable', 'order_access_tokens', 'true'),
  ('stable', 'tickets', 'true'),
  ('stable', 'checkin_devices', 'true'),
  ('stable', 'checkin_sync_batches', 'true'),
  ('stable', 'checkin_records', 'true'),
  ('stable', 'cooperation_requests', 'true'),
  ('stable', 'waitlist_entries', 'true'),
  ('stable', 'notification_deliveries', $predicate$not (channel = 'sms' and subject is not distinct from '登录验证码')$predicate$),
  ('stable', 'ai_runs', 'true'),
  ('stable', 'template_ai_mapping_actions', 'true'),
  ('stable', 'outbox_events', $predicate$event_type <> 'CustomerOtpRequested'$predicate$),
  ('stable', 'audit_logs', 'true'),
  ('stable', 'agent_connections', 'true'),
  ('stable', 'agent_device_authorizations', $predicate$status not in ('denied', 'consumed', 'expired')$predicate$),
  ('stable', 'agent_refresh_tokens', format($predicate$revoked_at is null and expires_at >= %L::timestamptz$predicate$, :'protection_cutoff')),
  ('stable', 'agent_operations', $predicate$status not in ('succeeded', 'failed', 'denied', 'cancelled', 'expired')$predicate$),
  ('retention', 'customer_auth_challenges', 'true'),
  ('retention', 'customer_sessions', 'true'),
  ('retention', 'idempotency_keys', 'true'),
  ('retention', 'order_access_link_attempts', 'true'),
  ('retention', 'notification_deliveries', $predicate$channel = 'sms' and subject is not distinct from '登录验证码'$predicate$),
  ('retention', 'outbox_events', $predicate$event_type = 'CustomerOtpRequested'$predicate$),
  ('retention', 'agent_device_authorizations', 'true'),
  ('retention', 'agent_refresh_tokens', 'true'),
  ('retention', 'agent_operations', 'true');

select $guard_command$
do $guard$
begin
  raise exception 'a protected production table is missing or has no primary key';
end
$guard$;
$guard_command$
where exists (
    select 1
    from release_protected_manifest manifest
    left join pg_class relation on relation.relname = manifest.table_name
    left join pg_namespace namespace
      on namespace.oid = relation.relnamespace
     and namespace.nspname = 'public'
    where (:'capture_role' <> 'baseline' and namespace.oid is null)
       or (namespace.oid is not null and not exists (
        select 1
        from pg_constraint primary_key
        where primary_key.conrelid = relation.oid
          and primary_key.contype = 'p'
      ))
  )
\gexec

select format(
  'select %L, encode(convert_to(jsonb_build_array(%s)::text, %L), %L) from %I.%I t where %s order by %s;',
  protected_table.table_name,
  protected_table.key_expression,
  'UTF8',
  'hex',
  protected_table.schema_name,
  protected_table.table_name,
  protected_table.row_predicate,
  protected_table.key_expression
)
from (
  select
    namespace.nspname as schema_name,
    relation.relname as table_name,
    case
      when :'capture_role' = 'growth_comparison'
       and manifest.profile = 'stable'
       and manifest.table_name in ('agent_device_authorizations', 'agent_refresh_tokens', 'agent_operations')
        then 'true'
      else manifest.row_predicate
    end as row_predicate,
    string_agg(format('t.%I', attribute.attname), ', ' order by key_column.ordinality) as key_expression
  from release_protected_manifest manifest
  join pg_class relation on relation.relname = manifest.table_name
  join pg_namespace namespace
    on namespace.oid = relation.relnamespace
   and namespace.nspname = 'public'
  join pg_constraint primary_key
    on primary_key.conrelid = relation.oid
   and primary_key.contype = 'p'
  cross join lateral unnest(primary_key.conkey) with ordinality as key_column(attnum, ordinality)
  join pg_attribute attribute
    on attribute.attrelid = relation.oid
   and attribute.attnum = key_column.attnum
  where manifest.profile = :'protection_profile'
    and relation.relkind in ('r', 'p')
  group by
    namespace.nspname,
    relation.relname,
    manifest.table_name,
    manifest.profile,
    manifest.row_predicate
) protected_table
order by protected_table.table_name collate "C"
\gexec
SQL
}

capture_ticket_sales() {
  local ticket_file="$1" quota_file="$2"
  compose_bounded "$DB_QUERY_TIMEOUT_SECONDS" exec -T postgres sh -lc \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F ","' \
    >"$ticket_file" <<'SQL'
select id, sold from ticket_types order by id;
SQL
  compose_bounded "$DB_QUERY_TIMEOUT_SECONDS" exec -T postgres sh -lc \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F ","' \
    >"$quota_file" <<'SQL'
select id, sold from ticket_quotas order by id;
SQL
}

read_database_migration_hash() {
  compose_bounded "$DB_QUERY_TIMEOUT_SECONDS" exec -T postgres sh -lc \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc '\''select hash from "drizzle"."__drizzle_migrations" order by created_at desc limit 1'\'''
}

migration_name_for_hash() {
  local expected_hash="$1" migration_file migration_hash
  while IFS= read -r migration_file; do
    migration_hash="$(sha256sum "$migration_file" | awk '{ print $1 }')"
    if [[ "$migration_hash" == "$expected_hash" ]]; then
      basename "$migration_file"
      return 0
    fi
  done < <(
    find "$APP_DIR/packages/database/drizzle" -maxdepth 1 -type f \
      -name '[0-9][0-9][0-9][0-9]_*.sql' -print \
      | sort
  )
  return 1
}

create_backup_and_rollback_point() {
  release_stamp="$(date '+%Y%m%d-%H%M%S')"
  backup_dir="${BACKUP_ROOT}/${release_stamp}"
  rollback_tag="rollback-${release_stamp}"
  target_image_tag="release-${release_stamp}"
  [[ ! -e "$backup_dir" ]] || die "Backup directory already exists: ${backup_dir}"

  assert_api_uses_compose_database
  log "Creating backup and rollback point at ${backup_dir}"
  install -d -m 700 "$BACKUP_ROOT"
  install -d -m 700 "$backup_dir"
  [[ "$(stat -c '%d' "$backup_dir")" == "$backup_device_id" ]] || {
    die 'The created release backup directory is on a different filesystem from the preflight capacity check.'
  }
  if [[ -n "$descriptor_evidence_dir" && -d "$descriptor_evidence_dir" ]]; then
    cp -a -- "$descriptor_evidence_dir" "$backup_dir/release-descriptor"
    chown -R root:root "$backup_dir/release-descriptor"
    chmod 700 "$backup_dir/release-descriptor"
    find "$backup_dir/release-descriptor" -type f -exec chmod 600 {} +
  fi
  cp -- "${BASH_SOURCE[0]}" "$backup_dir/production-deploy.recovery.sh"
  chown root:root "$backup_dir/production-deploy.recovery.sh"
  chmod 600 "$backup_dir/production-deploy.recovery.sh"
  bash -n "$backup_dir/production-deploy.recovery.sh"
  set_production_protection_cutoff
  if [[ "$recovery_in_progress" == 'true' ]]; then
    [[ -s "$read_only_compose_file" ]] || die 'Pending recovery read-only Compose override disappeared before backup.'
    cp -a -- "$read_only_compose_file" "$backup_dir/docker-compose.read-only.yml"
    chmod 600 "$backup_dir/docker-compose.read-only.yml"
    chown root:root "$backup_dir/docker-compose.read-only.yml"
    read_only_compose_file="$backup_dir/docker-compose.read-only.yml"
  fi
  cp -- "$active_env_file" "$backup_dir/.env"
  git_as_owner show "${target_sha}:docker-compose.yml" >"$backup_dir/docker-compose.yml"
  git_as_owner show "${release_baseline_sha}:packages/contracts/src/canonical-homepage.snapshot.json" \
    >"$backup_dir/canonical-homepage.snapshot.before.json"
  git_as_owner show "${release_baseline_sha}:packages/contracts/src/canonical-homepage.public.json" \
    >"$backup_dir/canonical-homepage.public.before.json"
  chmod 600 \
    "$backup_dir/.env" \
    "$backup_dir/docker-compose.yml" \
    "$backup_dir/canonical-homepage.snapshot.before.json" \
    "$backup_dir/canonical-homepage.public.before.json"
  chown root:root \
    "$backup_dir/.env" \
    "$backup_dir/docker-compose.yml" \
    "$backup_dir/canonical-homepage.snapshot.before.json" \
    "$backup_dir/canonical-homepage.public.before.json"

  release_source_dir="$backup_dir/source"
  install -d -o root -g root -m 700 "$release_source_dir"
  git_as_owner archive --format=tar "$target_sha" | tar -xf - -C "$release_source_dir"
  [[ "$(sha256sum "$release_source_dir/tooling/production-deploy.sh" | awk '{ print $1 }')" == \
    "$(git_as_owner show "${target_sha}:tooling/production-deploy.sh" | sha256sum | awk '{ print $1 }')" ]] || {
    die 'Root-owned release source snapshot does not match the verified target commit.'
  }
  cp -- "$backup_dir/.env" "$backup_dir/.env.release"
  chown root:root "$backup_dir/.env.release"
  chmod 600 "$backup_dir/.env.release"
  active_env_file="$backup_dir/.env.release"
  active_compose_file="$backup_dir/docker-compose.yml"
  build_compose_file="$backup_dir/docker-compose.build-context.yml"
  cat >"$build_compose_file" <<YAML
services:
  notification-sink:
    build:
      context: ${release_source_dir}
  api:
    build:
      context: ${release_source_dir}
  worker:
    build:
      context: ${release_source_dir}
  web:
    build:
      context: ${release_source_dir}
  payment-web:
    build:
      context: ${release_source_dir}
  admin:
    build:
      context: ${release_source_dir}
  gateway:
    build:
      context: ${release_source_dir}
YAML
  chown root:root "$build_compose_file"
  chmod 600 "$build_compose_file"
  compose config --quiet
  printf '%s\n' "$release_baseline_sha" >"$backup_dir/runtime-commit-before.txt"
  printf '%s\n' "$source_head_before" >"$backup_dir/source-head-before.txt"
  compose ps >"$backup_dir/compose-ps-before.txt"
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/version.json" >"$backup_dir/version-before.json"
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/health" >"$backup_dir/health-before.json"
  capture_business_snapshot "$backup_dir/business-counts-build-start.csv"
  capture_protected_business_ids "$backup_dir/protected-business-ids-build-start.csv"
  capture_protected_business_ids "$backup_dir/retention-managed-ids-build-start.csv" retention
  capture_ticket_sales "$backup_dir/ticket-types-sold-build-start.csv" "$backup_dir/ticket-quotas-sold-build-start.csv"

  compose_bounded "$DB_DUMP_TIMEOUT_SECONDS" exec -T postgres sh -lc \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
    >"$backup_dir/conference-build-start.dump"
  compose_bounded "$DB_QUERY_TIMEOUT_SECONDS" exec -T postgres pg_restore --list \
    <"$backup_dir/conference-build-start.dump" \
    >"$backup_dir/conference-build-start.dump.list"
  [[ -s "$backup_dir/conference-build-start.dump" ]] || die 'Build-start database backup is empty.'
  [[ -s "$backup_dir/conference-build-start.dump.list" ]] || die 'Build-start database backup catalog is empty.'
  sha256sum "$backup_dir/conference-build-start.dump" >"$backup_dir/conference-build-start.dump.sha256"

  local image
  for image in "${ROLLBACK_IMAGES[@]}"; do
    docker image inspect "${image}:local" >/dev/null
    docker tag "${image}:local" "${image}:${rollback_tag}"
  done
  docker image inspect \
    "tokems-api:${rollback_tag}" \
    "tokems-admin:${rollback_tag}" \
    "tokems-web:${rollback_tag}" \
    "tokems-worker:${rollback_tag}" \
    "tokems-gateway:${rollback_tag}" \
    "tokems-notification-sink:${rollback_tag}" \
    >"$backup_dir/images-before.json"

  printf '%s\n' "$backup_dir" >"${BACKUP_ROOT}/LATEST.tmp.$$"
  chmod 600 "${BACKUP_ROOT}/LATEST.tmp.$$"
  mv -f -- "${BACKUP_ROOT}/LATEST.tmp.$$" "${BACKUP_ROOT}/LATEST"
  backup_ready='true'
  if [[ "$recovery_in_progress" == 'true' ]]; then
    release_phase='write-freeze'
    recovery_marker_armed='true'
    write_pending_recovery_marker 'resumed-write-freeze-release-armed' || {
      die "Unable to preserve ${RECOVERY_MARKER} for the resumed protected release."
    }
  else
    release_phase='pre-write'
    write_pending_recovery_marker 'release-pre-write-armed' || {
      die "Unable to persist ${RECOVERY_MARKER} before source, environment, or image changes."
    }
  fi
  deployment_marker_armed='true'
}

refresh_pre_mutation_database_backup() {
  [[ "$release_write_freeze" == 'true' ]] || {
    die 'The final pre-mutation database backup requires the API and Worker write freeze.'
  }
  assert_final_backup_capacity
  log 'Capturing the final database backup and business baseline after the write freeze'
  set_production_protection_cutoff
  capture_business_snapshot "$backup_dir/business-counts-before.csv"
  capture_protected_business_ids "$backup_dir/protected-business-ids-before.csv"
  capture_protected_business_ids "$backup_dir/retention-managed-ids-before.csv" retention
  capture_ticket_sales "$backup_dir/ticket-types-sold-before.csv" "$backup_dir/ticket-quotas-sold-before.csv"

  compose_bounded "$DB_DUMP_TIMEOUT_SECONDS" exec -T postgres sh -lc \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
    >"$backup_dir/conference.dump"
  compose_bounded "$DB_QUERY_TIMEOUT_SECONDS" exec -T postgres pg_restore --list \
    <"$backup_dir/conference.dump" \
    >"$backup_dir/conference.dump.list"
  [[ -s "$backup_dir/conference.dump" ]] || die 'Final pre-mutation database backup is empty.'
  [[ -s "$backup_dir/conference.dump.list" ]] || die 'Final pre-mutation database backup catalog is empty.'
  sha256sum "$backup_dir/conference.dump" >"$backup_dir/conference.dump.sha256"
  assert_release_verification_capacity
}

sync_source() {
  log 'Fast-forwarding production to the verified origin/main commit'
  assert_github_main_unchanged
  [[ "$(git_as_owner rev-parse "$EXPECTED_UPSTREAM_REF")" == "$target_sha" ]] || {
    die 'origin/main changed after verified bundle import; run the deployment again.'
  }
  git_as_owner merge --ff-only "$target_sha"
  [[ "$(git_as_owner rev-parse HEAD)" == "$target_sha" ]] || die 'Server HEAD does not equal target commit.'
  [[ -z "$(git_as_owner status --porcelain --untracked-files=all)" ]] || {
    die 'Server worktree changed during source synchronization.'
  }
  compose config --quiet
}

set_env_value() {
  local key="$1" value="$2" env_file="${3:-$active_env_file}"
  [[ "$key" =~ ^BUILD_(SHA|TIME|MIGRATION|MIGRATION_HASH)$ ]] || die "Unexpected build environment key: ${key}"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*$|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$env_file"
  fi
}

set_release_metadata_value() {
  local key="$1" value="$2" env_file="${3:-$active_env_file}"
  [[ "$key" =~ ^TOKEMS_(COMPATIBILITY_ROLLBACK|ROLLBACK_CODE_MIGRATION|ROLLBACK_CODE_MIGRATION_HASH)$ ]] || {
    die "Unexpected release metadata key: ${key}"
  }
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*$|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$env_file"
  fi
}

clear_compatibility_release_metadata() {
  local env_file="${1:-$active_env_file}"
  sed -i \
    -e '/^TOKEMS_COMPATIBILITY_ROLLBACK=/d' \
    -e '/^TOKEMS_ROLLBACK_CODE_MIGRATION=/d' \
    -e '/^TOKEMS_ROLLBACK_CODE_MIGRATION_HASH=/d' \
    "$env_file"
}

clear_build_identity() {
  local env_file="$1"
  sed -i \
    -e '/^BUILD_SHA=/d' \
    -e '/^BUILD_TIME=/d' \
    -e '/^BUILD_MIGRATION=/d' \
    -e '/^BUILD_MIGRATION_HASH=/d' \
    "$env_file"
}

write_build_identity() {
  local migration migration_hash build_time
  migration="$(
    find "$release_source_dir/packages/database/drizzle" -maxdepth 1 -type f \
      -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' \
      | sort \
      | tail -n 1
  )"
  [[ -n "$migration" ]] || die 'No numbered database migration was found.'
  migration_hash="$(sha256sum "$release_source_dir/packages/database/drizzle/$migration" | awk '{ print $1 }')"
  build_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  environment_changed='true'
  clear_compatibility_release_metadata
  set_env_value BUILD_SHA "$target_sha"
  set_env_value BUILD_TIME "$build_time"
  set_env_value BUILD_MIGRATION "$migration"
  set_env_value BUILD_MIGRATION_HASH "$migration_hash"
  chown root:root "$active_env_file"
  chmod 600 "$active_env_file"

  BUILD_SHA="$target_sha"
  BUILD_TIME="$build_time"
  BUILD_MIGRATION="$migration"
  BUILD_MIGRATION_HASH="$migration_hash"
  export COMPOSE_PARALLEL_LIMIT=1
  [[ "$target_sha" != 'unknown' && "$build_time" != 'unknown' && "$migration" != 'unknown' && "$migration_hash" != 'unknown' ]] || {
    die 'Build identity contains an unknown value.'
  }
  compose config --quiet
  printf 'BUILD_SHA=%s\nBUILD_TIME=%s\nBUILD_MIGRATION=%s\nBUILD_MIGRATION_HASH=%s\n' \
    "$target_sha" "$build_time" "$migration" "$migration_hash" \
    >"$backup_dir/build-identity.txt"
}

assert_source_unchanged() {
  [[ "$(git_as_owner rev-parse HEAD)" == "$target_sha" ]] || die 'Git HEAD changed during deployment.'
  [[ -z "$(git_as_owner status --porcelain --untracked-files=all)" ]] || {
    die 'Git worktree changed during deployment.'
  }
}

build_images() {
  local service build_log image
  images_changed='true'
  for service in "${BUILD_SERVICES[@]}"; do
    assert_no_parallel_release
    assert_build_capacity
    build_log="$backup_dir/build-${service}.log"
    log "Building ${service} with COMPOSE_PARALLEL_LIMIT=1"
    if ! compose_build_bounded "$BUILD_TIMEOUT_SECONDS" build "$service" >"$build_log" 2>&1; then
      tail -n 80 "$build_log" >&2 || true
      return 1
    fi
    docker info >/dev/null
    assert_source_unchanged
  done
  for image in "${ROLLBACK_IMAGES[@]}"; do
    docker image inspect "${image}:local" >/dev/null
    docker tag "${image}:local" "${image}:${target_image_tag}"
  done
  docker image inspect \
    "tokems-api:${target_image_tag}" \
    "tokems-admin:${target_image_tag}" \
    "tokems-web:${target_image_tag}" \
    "tokems-worker:${target_image_tag}" \
    "tokems-gateway:${target_image_tag}" \
    "tokems-notification-sink:${target_image_tag}" \
    >"$backup_dir/images-target.json"
}

pull_prebuilt_images() {
  [[ -n "$descriptor_evidence_dir" && -d "$descriptor_evidence_dir" ]] || {
    die 'Verified release descriptor evidence is unavailable.'
  }
  local verifier service image_ref image_name metadata_file pull_log
  verifier="$descriptor_evidence_dir/release-descriptor.py"
  log "Pulling six digest-pinned images for ${target_sha}"
  for service in "${BUILD_SERVICES[@]}"; do
    image_ref="$(descriptor_image_ref "$service")"
    image_name="$(local_image_for_service "$service")"
    pull_log="$backup_dir/pull-${service}.log"
    if ! registry_docker pull --platform "$descriptor_platform" "$image_ref" >"$pull_log" 2>&1; then
      tail -n 80 "$pull_log" >&2 || true
      die "Prebuilt image pull failed for ${service}; running containers and release tags are unchanged."
    fi
    metadata_file="$backup_dir/pulled-image-${service}.json"
    docker image inspect --format '{{json .}}' "$image_ref" >"$metadata_file"
    python3 "$verifier" verify-service \
      --metadata-file "$metadata_file" \
      --service "$service" \
      --target-sha "$target_sha" \
      --build-time "$descriptor_build_time" \
      --migration "$descriptor_migration" \
      --migration-hash "$descriptor_migration_hash" \
      --platform "$descriptor_platform"
    printf 'service=%s\nimage=%s\nsource=%s\n' "$service" "$image_name" "$image_ref" \
      >"$backup_dir/pulled-image-${service}.txt"
  done

  for service in "${BUILD_SERVICES[@]}"; do
    image_ref="$(descriptor_image_ref "$service")"
    image_name="$(local_image_for_service "$service")"
    docker tag "$image_ref" "${image_name}:candidate-${release_stamp}"
  done
  log 'All candidate images were pulled and verified without changing release tags.'
}

write_prebuilt_build_identity() {
  [[ "$descriptor_build_sha" == "$target_sha" ]] || die 'Verified descriptor SHA is unavailable.'
  [[ -n "$descriptor_build_time" && -n "$descriptor_migration" && -n "$descriptor_migration_hash" ]] || {
    die 'Verified descriptor build identity is incomplete.'
  }
  environment_changed='true'
  clear_compatibility_release_metadata
  set_env_value BUILD_SHA "$descriptor_build_sha"
  set_env_value BUILD_TIME "$descriptor_build_time"
  set_env_value BUILD_MIGRATION "$descriptor_migration"
  set_env_value BUILD_MIGRATION_HASH "$descriptor_migration_hash"
  chown root:root "$active_env_file"
  chmod 600 "$active_env_file"

  BUILD_SHA="$descriptor_build_sha"
  BUILD_TIME="$descriptor_build_time"
  BUILD_MIGRATION="$descriptor_migration"
  BUILD_MIGRATION_HASH="$descriptor_migration_hash"
  export BUILD_SHA BUILD_TIME BUILD_MIGRATION BUILD_MIGRATION_HASH
  compose config --quiet
  printf 'BUILD_SHA=%s\nBUILD_TIME=%s\nBUILD_MIGRATION=%s\nBUILD_MIGRATION_HASH=%s\n' \
    "$BUILD_SHA" "$BUILD_TIME" "$BUILD_MIGRATION" "$BUILD_MIGRATION_HASH" \
    >"$backup_dir/build-identity.txt"
}

activate_prebuilt_images() {
  local service image_name
  images_changed='true'
  for service in "${BUILD_SERVICES[@]}"; do
    image_name="$(local_image_for_service "$service")"
    docker image inspect "${image_name}:candidate-${release_stamp}" >/dev/null
    docker tag "${image_name}:candidate-${release_stamp}" "${image_name}:local"
    docker tag "${image_name}:local" "${image_name}:${target_image_tag}"
  done
  docker image inspect \
    "tokems-api:${target_image_tag}" \
    "tokems-admin:${target_image_tag}" \
    "tokems-web:${target_image_tag}" \
    "tokems-worker:${target_image_tag}" \
    "tokems-gateway:${target_image_tag}" \
    "tokems-notification-sink:${target_image_tag}" \
    >"$backup_dir/images-target.json"
  log 'Activated the complete verified image set for the Compose release.'
}

read_only_database_url() {
  resolved_compose_database_url | python3 -c '
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

value = sys.stdin.read()
parts = urlsplit(value)
if parts.scheme not in {"postgres", "postgresql"} or not parts.hostname or not parts.path:
    raise SystemExit("resolved DATABASE_URL is not a PostgreSQL URL")
items = parse_qsl(parts.query, keep_blank_values=True)
query = [(key, item) for key, item in items if key != "options"]
existing_options = [item for key, item in items if key == "options" and item.strip()]
query.append(("options", " ".join([*existing_options, "-c default_transaction_read_only=on"])))
sys.stdout.write(urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)))
'
}

set_write_service_restart_policy() {
  local policy="$1" service container current_policy
  [[ "$policy" == 'no' || "$policy" == 'unless-stopped' ]] || die "Unexpected restart policy: ${policy}"
  for service in api worker; do
    container="$(compose ps -q "$service")"
    [[ -n "$container" ]] || die "Cannot update restart policy for missing service: ${service}"
    docker update --restart "$policy" "$container" >/dev/null
    current_policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container")"
    [[ "$current_policy" == "$policy" ]] || die "Restart policy update was not persisted for ${service}."
  done
}

assert_write_services_stopped() {
  local service container running
  for service in api worker; do
    container="$(compose ps -a -q "$service")"
    [[ -n "$container" ]] || continue
    running="$(docker inspect --format '{{.State.Running}}' "$container")"
    [[ "$running" == 'false' ]] || die "Write service is still running after the freeze request: ${service}"
  done
}

enter_release_write_freeze() {
  assert_no_parallel_release
  log 'Freezing API and Worker writes for the final database backup, migration, and release verification'
  read_only_compose_file="$backup_dir/docker-compose.read-only.yml"
  cat >"$read_only_compose_file" <<'YAML'
services:
  api:
    environment:
      DATABASE_URL: ${TOKEMS_READ_ONLY_DATABASE_URL:?TOKEMS_READ_ONLY_DATABASE_URL is required}
  worker:
    command: [node, -e, "setInterval(() => {}, 1000)"]
YAML
  chmod 600 "$read_only_compose_file"
  containers_switched='true'
  start_thaw_watchdog
  set_write_service_restart_policy no
  arm_release_recovery_marker
  compose_bounded 60 stop --timeout 30 api worker >"$backup_dir/release-write-freeze.log" 2>&1
  assert_write_services_stopped
  protected_write_block_confirmed='true'
  release_write_freeze='true'
}

thaw_release_write_freeze() {
  [[ "$release_write_freeze" == 'true' ]] || return 0
  log 'Re-enabling production writes with the verified API and Worker'
  unset TOKEMS_READ_ONLY_DATABASE_URL
  assert_no_parallel_release
  assert_post_thaw_evidence_capacity
  protected_write_block_confirmed='false'
  target_writes_enabled='true'
  thaw_guard_compose_file="$backup_dir/docker-compose.thaw-guard.yml"
  cat >"$thaw_guard_compose_file" <<'YAML'
services:
  api:
    restart: "no"
  worker:
    restart: "no"
YAML
  chmod 600 "$thaw_guard_compose_file"
  [[ -n "$thaw_watchdog_unit" ]] || start_thaw_watchdog
  assert_thaw_watchdog_active
  compose_thaw_guard_bounded "$SERVICE_TRANSITION_TIMEOUT_SECONDS" up -d \
    --no-build \
    --no-deps \
    --force-recreate \
    --wait \
    --wait-timeout 300 \
    api worker \
    >"$backup_dir/release-write-thaw.log" 2>&1
  assert_service_healthy api
  assert_service_healthy worker
  curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/api/v1/health' | assert_health_json
  assert_current_runtime_identity
  assert_api_uses_compose_database
  assert_operational_write_state normal
  wait_for_worker_ready
  assert_thaw_watchdog_active
  log "Observing ready API and Worker writes for ${POST_THAW_STABILIZATION_SECONDS} seconds before final data verification"
  sleep "$POST_THAW_STABILIZATION_SECONDS"
  assert_service_healthy api
  assert_service_healthy worker
  assert_thaw_watchdog_active
  curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/api/v1/health' | assert_health_json
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/health" | assert_health_json
  capture_business_snapshot "$backup_dir/business-counts-post-thaw.csv"
  capture_protected_business_ids "$backup_dir/protected-business-ids-post-thaw.csv" stable growth_comparison
  capture_ticket_sales "$backup_dir/ticket-types-sold-post-thaw.csv" "$backup_dir/ticket-quotas-sold-post-thaw.csv"
  compare_production_data post-thaw before false growth
  set_write_service_restart_policy unless-stopped \
    >"$backup_dir/restart-policy-restore.log"
  release_write_freeze='false'
}

run_database_updates() {
  assert_no_parallel_release
  log 'Running database migrations with SEED_DEMO_DATA=false'
  database_update_started='true'
  if ! (export SEED_DEMO_DATA=false; compose_bounded "$DB_MIGRATION_TIMEOUT_SECONDS" run --rm --no-deps db-init) >"$backup_dir/db-init.log" 2>&1; then
    log "Database migration failed; protected log: ${backup_dir}/db-init.log"
    return 1
  fi
  [[ "$(read_database_migration_hash)" == "$BUILD_MIGRATION_HASH" ]] || {
    log 'Database migration command completed without the target migration hash.'
    return 1
  }

  if [[ "$canonical_sync_required" == 'true' ]]; then
    log "Synchronizing canonical ${CANONICAL_ORGANIZATION_SLUG}/${CANONICAL_EVENT_SLUG} template"
    canonical_update_started='true'
    if ! (export SEED_DEMO_DATA=true; compose_bounded "$DB_MIGRATION_TIMEOUT_SECONDS" run --rm --no-deps db-init) >"$backup_dir/canonical-sync.log" 2>&1; then
      log "Canonical sync failed; protected log: ${backup_dir}/canonical-sync.log"
      return 1
    fi
    canonical_sync_performed='true'
  fi
  if [[ "$release_write_freeze" != 'true' ]]; then
    assert_api_uses_compose_database
  fi
}

run_canonical_database_sync() {
  local migration_hash_before migration_hash_after
  [[ "$canonical_sync_required" == 'true' ]] || {
    die 'Canonical repair requires an explicit canonical synchronization request.'
  }
  migration_hash_before="$(read_database_migration_hash)"
  [[ "$migration_hash_before" == "$release_baseline_migration_hash" ]] || {
    die 'Canonical repair requires the database migration to match the verified running release.'
  }

  assert_no_parallel_release
  log "Synchronizing canonical ${CANONICAL_ORGANIZATION_SLUG}/${CANONICAL_EVENT_SLUG} template with the verified running images"
  database_update_started='true'
  canonical_update_started='true'
  if ! (export SEED_DEMO_DATA=true; compose_bounded "$DB_MIGRATION_TIMEOUT_SECONDS" run --rm --no-deps db-init) >"$backup_dir/canonical-sync.log" 2>&1; then
    log "Canonical sync failed; protected log: ${backup_dir}/canonical-sync.log"
    return 1
  fi
  migration_hash_after="$(read_database_migration_hash)"
  [[ "$migration_hash_after" == "$migration_hash_before" ]] || {
    log 'Canonical repair unexpectedly changed the database migration identity.'
    return 1
  }
  canonical_sync_performed='true'
}

start_canonical_read_only_verification() {
  local start_status=0
  [[ "$release_write_freeze" == 'true' ]] || {
    die 'Canonical verification requires the protected write freeze.'
  }
  log 'Starting the verified API in read-only mode and pausing the Worker for canonical verification'
  export TOKEMS_READ_ONLY_DATABASE_URL
  TOKEMS_READ_ONLY_DATABASE_URL="$(read_only_database_url)"
  compose_read_only_bounded "$SERVICE_TRANSITION_TIMEOUT_SECONDS" up -d \
    --no-build \
    --no-deps \
    --force-recreate \
    --wait \
    --wait-timeout 300 \
    api worker \
    >"$backup_dir/canonical-verification-start.log" 2>&1 || start_status=$?
  if [[ $start_status -ne 0 ]]; then
    tail -n 160 "$backup_dir/canonical-verification-start.log" >&2 || true
    return 1
  fi
  assert_operational_write_state recovery
}

switch_services() {
  assert_no_parallel_release
  log 'Switching application containers to the new images'
  containers_switched='true'
  local switch_status=0
  if [[ "$release_write_freeze" == 'true' ]]; then
    export TOKEMS_READ_ONLY_DATABASE_URL
    TOKEMS_READ_ONLY_DATABASE_URL="$(read_only_database_url)"
    compose_read_only_bounded "$SERVICE_TRANSITION_TIMEOUT_SECONDS" up -d \
      --no-build \
      --no-deps \
      --force-recreate \
      --wait \
      --wait-timeout 300 \
      "${RELEASE_SERVICES[@]}" \
      >"$backup_dir/compose-switch.log" 2>&1 || switch_status=$?
  else
    compose_bounded "$SERVICE_TRANSITION_TIMEOUT_SECONDS" up -d \
      --no-build \
      --no-deps \
      --force-recreate \
      --wait \
      --wait-timeout 300 \
      "${RELEASE_SERVICES[@]}" \
      >"$backup_dir/compose-switch.log" 2>&1 || switch_status=$?
  fi
  if [[ $switch_status -ne 0 ]]; then
    tail -n 160 "$backup_dir/compose-switch.log" >&2 || true
    return 1
  fi
}

compare_production_data() {
  local after_phase="${1:-after}"
  local before_phase="${2:-before}"
  local include_retention="${3:-true}"
  local comparison_mode="${4:-auto}"
  if [[ "$comparison_mode" == 'auto' ]]; then
    comparison_mode='exact'
    [[ "$canonical_sync_performed" == 'false' ]] || comparison_mode='canonical'
  fi
  [[ "$comparison_mode" == 'exact' || "$comparison_mode" == 'growth' || "$comparison_mode" == 'canonical' ]] || {
    die "Unexpected production data comparison mode: ${comparison_mode}"
  }
  local -a comparison_files=(
    "$backup_dir/business-counts-${before_phase}.csv"
    "$backup_dir/business-counts-${after_phase}.csv"
    "$backup_dir/protected-business-ids-${before_phase}.csv"
    "$backup_dir/protected-business-ids-${after_phase}.csv"
    "$backup_dir/ticket-types-sold-${before_phase}.csv"
    "$backup_dir/ticket-types-sold-${after_phase}.csv"
    "$backup_dir/ticket-quotas-sold-${before_phase}.csv"
    "$backup_dir/ticket-quotas-sold-${after_phase}.csv"
  )
  if [[ "$include_retention" == 'true' ]]; then
    comparison_files+=(
      "$backup_dir/retention-managed-ids-${before_phase}.csv"
      "$backup_dir/retention-managed-ids-${after_phase}.csv"
    )
  elif [[ "$include_retention" != 'false' ]]; then
    die "Unexpected retention comparison mode: ${include_retention}"
  fi
  if [[ "$comparison_mode" == 'canonical' ]]; then
    comparison_files+=("$release_source_dir/packages/contracts/src/canonical-homepage.snapshot.json")
  fi
  (
    ulimit -v "$DATA_COMPARE_MAX_VIRTUAL_KIB"
    timeout --foreground --kill-after=10s "${DATA_COMPARE_TIMEOUT_SECONDS}s" python3 - \
      "$comparison_mode" "${comparison_files[@]}" <<'PY'
import csv
import json
import sys


def read_pairs(file_name):
    with open(file_name, newline="", encoding="utf-8") as handle:
        return {row[0]: int(row[1]) for row in csv.reader(handle) if row}


mode = sys.argv[1]
files = sys.argv[2:]
canonical_snapshot = None
if mode == "canonical":
    with open(files.pop(), encoding="utf-8") as handle:
        canonical_snapshot = json.load(handle)
before_counts = read_pairs(files[0])
after_counts = read_pairs(files[1])
if mode in {"exact", "canonical"}:
    if before_counts != after_counts:
        raise SystemExit("protected production counts changed during the write freeze")
else:
    for key, before in before_counts.items():
        after = after_counts.get(key)
        if after is None or after < before:
            raise SystemExit(f"production count decreased for {key}: {before} -> {after}")

def iter_protected_rows(file_name):
    with open(file_name, newline="", encoding="utf-8") as handle:
        for row in csv.reader(handle):
            if not row:
                continue
            current = tuple(row)
            if len(current) != 2:
                raise SystemExit(f"invalid protected ID row in {file_name}")
            yield current


def assert_ordered_subsequence(before_file, after_file):
    after_rows = iter_protected_rows(after_file)
    current_after = next(after_rows, None)
    missing = []
    for expected in iter_protected_rows(before_file):
        while current_after is not None and current_after != expected:
            current_after = next(after_rows, None)
        if current_after is None:
            missing.append(expected)
            if len(missing) == 5:
                break
            continue
        current_after = next(after_rows, None)
    for _ in after_rows:
        pass
    if missing:
        raise SystemExit(f"protected production records disappeared: {missing}")


def assert_exact_rows(before_file, after_file):
    if list(iter_protected_rows(before_file)) != list(iter_protected_rows(after_file)):
        raise SystemExit("protected production record identities changed during the write freeze")


def rows_by_table(file_name):
    result = {}
    for table, encoded_key in iter_protected_rows(file_name):
        result.setdefault(table, []).append(encoded_key)
    return result


def decoded_single_key(encoded_key, label):
    try:
        value = json.loads(bytes.fromhex(encoded_key).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"invalid protected key encoding for {label}") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], str):
        raise SystemExit(f"unexpected protected key shape for {label}")
    return value[0]


def assert_canonical_rows(before_file, after_file):
    before_tables = rows_by_table(before_file)
    after_tables = rows_by_table(after_file)
    allowed_ids = {
        "event_releases": {canonical_snapshot["release"]["id"]},
        "conference_template_versions": {
            item["id"] for item in canonical_snapshot["template"]["publishedVersions"]
        },
    }
    for table in set(before_tables) | set(after_tables):
        before = before_tables.get(table, [])
        after = after_tables.get(table, [])
        if table not in allowed_ids:
            if before != after:
                raise SystemExit(f"protected production record identities changed for {table}")
            continue
        before_set = set(before)
        after_set = set(after)
        if len(before_set) != len(before) or len(after_set) != len(after):
            raise SystemExit(f"duplicate protected record identity for {table}")
        if not before_set <= after_set:
            raise SystemExit(f"protected production records disappeared from {table}")
        before_ids = {decoded_single_key(item, table) for item in before}
        expected_additions = allowed_ids[table] - before_ids
        actual_additions = {
            decoded_single_key(item, table) for item in after_set - before_set
        }
        if actual_additions != expected_additions:
            raise SystemExit(f"canonical synchronization added unexpected identities to {table}")


if mode == "exact":
    identity_check = assert_exact_rows
elif mode == "canonical":
    identity_check = assert_canonical_rows
else:
    identity_check = assert_ordered_subsequence
identity_check(files[2], files[3])
if len(files) == 10:
    identity_check(files[8], files[9])


def assert_canonical_ticket_rows(label, before_rows, after_rows, expected_ids):
    if not set(before_rows) <= set(after_rows):
        raise SystemExit(f"protected {label} records disappeared")
    for key, before in before_rows.items():
        if after_rows[key] != before:
            raise SystemExit(f"{label} sold value changed during the write freeze")
    expected_additions = expected_ids - set(before_rows)
    actual_additions = set(after_rows) - set(before_rows)
    if actual_additions != expected_additions:
        raise SystemExit(f"canonical synchronization added unexpected {label} identities")
    if any(after_rows[key] != 0 for key in actual_additions):
        raise SystemExit(f"new canonical {label} must start with zero sold inventory")


for label, before_file, after_file in (
    ("ticket type", files[4], files[5]),
    ("ticket quota", files[6], files[7]),
):
    before_rows = read_pairs(before_file)
    after_rows = read_pairs(after_file)
    if mode == "exact" and before_rows != after_rows:
        raise SystemExit(f"{label} sold values changed during the write freeze")
    if mode == "canonical":
        if label == "ticket type":
            expected_ids = {
                item["id"] for item in canonical_snapshot["backend"]["ticketTypes"]
            }
        else:
            expected_ids = {item["id"] for item in canonical_snapshot["ticketQuotas"]}
        assert_canonical_ticket_rows(label, before_rows, after_rows, expected_ids)
    for key, before in before_rows.items():
        after = after_rows.get(key)
        if after is None or after < before:
            raise SystemExit(f"{label} sold count decreased for {key}: {before} -> {after}")

print("Production business counts and sold values were preserved")
PY
  )
}

verify_build_identity_files() {
  local expected_sha="${1:-$target_sha}"
  local expected_migration="${2:-${BUILD_MIGRATION:-}}"
  local expected_migration_hash="${3:-${BUILD_MIGRATION_HASH:-}}"
  [[ -n "$expected_sha" && -n "$expected_migration" && -n "$expected_migration_hash" ]] || {
    die 'Release verification expected an incomplete build identity.'
  }
  python3 - \
    "$expected_sha" \
    "$expected_migration" \
    "$expected_migration_hash" \
    "$backup_dir/version-after.json" \
    "$backup_dir/web-version-after.json" \
    "$backup_dir/admin-version-after.json" \
    "$backup_dir/health-after.json" \
    "$backup_dir/worker-version-after.json" <<'PY'
import json
import sys

target, migration, migration_hash = sys.argv[1:4]
file_names = sys.argv[4:]
labels = ("gateway", "web", "admin", "api", "worker")
built_at = None

for label, file_name in zip(labels, file_names):
    with open(file_name, encoding="utf-8") as handle:
        payload = json.load(handle)
    build = payload.get("build", payload) if label == "api" else payload
    expected = {
        "sha": target,
        "migration": migration,
        "migrationHash": migration_hash,
    }
    for key, value in expected.items():
        if build.get(key) != value:
            raise SystemExit(f"{label} returned an unexpected {key}")
    if build.get("service") != label:
        raise SystemExit(f"{label} returned metadata for another service")
    if not build.get("builtAt") or build.get("builtAt") == "unknown":
        raise SystemExit(f"{label} returned an unknown build time")
    if built_at is None:
        built_at = build["builtAt"]
    elif build["builtAt"] != built_at:
        raise SystemExit(f"{label} returned a mixed build time")

with open(file_names[3], encoding="utf-8") as handle:
    health = json.load(handle)
if health.get("status") != "ok":
    raise SystemExit("API health status is not ok")
database = health.get("database") or {}
if database.get("ok") is not True or (database.get("migration") or {}).get("ok") is not True:
    raise SystemExit("database migration health is not current")

print("Gateway, web, admin, API, and worker build identities are consistent")
PY
}

verify_homepage_file() {
  local file_name="$1"
  local expected_snapshot="${2:-${release_source_dir:-$APP_DIR}/packages/contracts/src/canonical-homepage.public.json}"
  python3 - \
    "$file_name" \
    "$expected_snapshot" \
    "$CANONICAL_EVENT_SLUG" <<'PY'
from copy import deepcopy
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    actual = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
    expected = json.load(handle)["publicEvent"]

if actual.get("slug") != sys.argv[3]:
    raise SystemExit("public homepage did not return the canonical event slug")

normalized = deepcopy(actual)
normalized["publicMetrics"] = deepcopy(expected.get("publicMetrics"))
expected_experience = expected.get("experience") or {}
actual_experience = normalized.get("experience") or {}
if expected_experience.get("overrideRevisions") is None and actual_experience.get("overrideRevisions") == {}:
    actual_experience["overrideRevisions"] = None
expected_template = expected_experience.get("template") or {}
actual_template = actual_experience.get("template") or {}
if "bindingRevision" not in expected_template:
    actual_template.pop("bindingRevision", None)
elif expected_template.get("bindingRevision") is None:
    actual_template["bindingRevision"] = None

expected_tickets = {item.get("id"): item for item in expected.get("tickets", [])}
for ticket in normalized.get("tickets", []):
    expected_ticket = expected_tickets.get(ticket.get("id"))
    if expected_ticket is not None:
        ticket["remaining"] = expected_ticket.get("remaining")

if normalized != expected:
    raise SystemExit("public homepage content does not match the canonical public snapshot")
PY
}

verify_canonical_full_snapshot() {
  local expected_snapshot="${1:-$release_source_dir/packages/contracts/src/canonical-homepage.snapshot.json}"
  local evidence_suffix="${2:-production}"
  local alternate_expected_snapshot="${3:-}"
  local actual_snapshot="$backup_dir/canonical-homepage.snapshot.${evidence_suffix}.json"
  [[ -s "$expected_snapshot" ]] || die 'Verified target canonical full snapshot is unavailable.'
  [[ -z "$alternate_expected_snapshot" || -s "$alternate_expected_snapshot" ]] || {
    die 'Alternate verified canonical full snapshot is unavailable.'
  }
  compose_read_only_bounded "$DB_QUERY_TIMEOUT_SECONDS" run --rm --no-deps \
    -e CANONICAL_API_BASE_URL=http://api:4100/api/v1 \
    -e CANONICAL_EXPORT_TRUSTED_COMPOSE_INTERNAL=true \
    api \
    node node_modules/@conference/database/dist/export-canonical-homepage.js --stdout \
    >"$actual_snapshot"
  chmod 600 "$actual_snapshot"
  local -a expected_snapshots=("$expected_snapshot")
  [[ -z "$alternate_expected_snapshot" ]] || expected_snapshots+=("$alternate_expected_snapshot")
  canonical_snapshot_files_match "$actual_snapshot" "${expected_snapshots[@]}" || {
    die 'production canonical homepage and backend settings differ from the verified target snapshot'
  }
  log 'Production canonical homepage and backend settings match a verified release snapshot'
}

verify_release() {
  local expected_runtime_sha="${1:-$target_sha}"
  local expected_migration="${2:-${BUILD_MIGRATION:-}}"
  local expected_migration_hash="${3:-${BUILD_MIGRATION_HASH:-}}"
  log 'Verifying containers, build identity, HTTP, canonical homepage, and production data'
  local service worker_container container_id
  local -a release_container_ids=()
  for service in "${LONG_RUNNING_SERVICES[@]}"; do
    assert_service_healthy "$service"
  done
  assert_runtime_image_tags
  assert_api_uses_compose_database

  for service in notification-sink api worker web payment-web admin gateway; do
    container_id="$(compose ps -q "$service")"
    [[ -n "$container_id" ]] || die "Release container is missing during image evidence capture: ${service}"
    release_container_ids+=("$container_id")
  done
  docker inspect "${release_container_ids[@]}" >"$backup_dir/containers-after.json"

  compose ps >"$backup_dir/compose-ps-after.txt"
  compose logs --no-color --tail=200 api worker db-init gateway >"$backup_dir/runtime-logs-after.txt" 2>&1

  curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/version.json' >"$backup_dir/version-after.json"
  curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/web-version.json' >"$backup_dir/web-version-after.json"
  curl "${CURL_ARGS[@]}" -H 'Host: admin.hui.ailingdaoli.com' \
    'http://127.0.0.1:8088/admin/version.json' >"$backup_dir/admin-version-after.json"
  curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/api/v1/health' >"$backup_dir/health-after.json"
  curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/api/v1/homepage' >"$backup_dir/homepage-after.json"

  worker_container="$(compose ps -q worker)"
  timeout --foreground --kill-after=10s "${DB_PROOF_TIMEOUT_SECONDS}s" docker exec "$worker_container" node -e \
    "console.log(JSON.stringify({service:'worker',sha:process.env.BUILD_SHA,builtAt:process.env.BUILD_TIME,migration:process.env.BUILD_MIGRATION,migrationHash:process.env.BUILD_MIGRATION_HASH}))" \
    >"$backup_dir/worker-version-after.json"

  verify_build_identity_files "$expected_runtime_sha" "$expected_migration" "$expected_migration_hash"
  verify_homepage_file "$backup_dir/homepage-after.json"

  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/version.json" >"$backup_dir/public-version-after.json"
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/web-version.json" >"$backup_dir/public-web-version-after.json"
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/health" >"$backup_dir/public-health-after.json"
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/homepage" >"$backup_dir/public-homepage-after.json"
  curl "${CURL_ARGS[@]}" --location --max-redirs 5 --max-filesize 5242880 \
    "${PUBLIC_ORIGIN}/" >"$backup_dir/public-homepage-document-after.html"
  curl "${CURL_ARGS[@]}" --head "${PUBLIC_ORIGIN}/" >"$backup_dir/public-homepage-headers.txt"
  curl "${CURL_ARGS[@]}" --head "${ADMIN_ORIGIN}/admin/" >"$backup_dir/public-admin-headers.txt"
  curl "${CURL_ARGS[@]}" --head "$PAYMENT_URL" >"$backup_dir/public-payment-headers.txt"
  [[ "$(json_sha_from_stdin <"$backup_dir/public-version-after.json")" == "$expected_runtime_sha" ]] || {
    die 'Public version endpoint does not match the expected runtime commit.'
  }
  [[ "$(build_fingerprint_from_stdin web <"$backup_dir/public-web-version-after.json")" == \
    "$(build_fingerprint_from_stdin web <"$backup_dir/web-version-after.json")" ]] || {
    die 'Public web bundle does not match the verified local target bundle.'
  }
  [[ -s "$backup_dir/public-homepage-document-after.html" ]] || {
    die 'Public homepage returned an empty document.'
  }
  assert_health_json <"$backup_dir/public-health-after.json"
  verify_homepage_file "$backup_dir/public-homepage-after.json"
  verify_canonical_full_snapshot

  capture_business_snapshot "$backup_dir/business-counts-after.csv"
  capture_protected_business_ids "$backup_dir/protected-business-ids-after.csv" stable comparison
  capture_protected_business_ids "$backup_dir/retention-managed-ids-after.csv" retention comparison
  capture_ticket_sales "$backup_dir/ticket-types-sold-after.csv" "$backup_dir/ticket-quotas-sold-after.csv"
  compare_production_data
  docker image inspect \
    tokems-api:local \
    tokems-admin:local \
    tokems-web:local \
    tokems-worker:local \
    tokems-gateway:local \
    tokems-notification-sink:local \
    >"$backup_dir/images-after.json"
  nginx -t
  assert_source_unchanged
}

repair_runtime_identity() {
  log 'Validating the running release before repairing protected production build identity'
  assert_minimal_git_state
  assert_production_environment false
  assert_no_parallel_release
  assert_pending_recovery_policy
  compose config --quiet
  docker info >/dev/null
  nginx -t

  local service source_sha repair_stamp repair_dir
  for service in "${LONG_RUNNING_SERVICES[@]}"; do
    assert_service_healthy "$service"
  done
  assert_runtime_image_tags
  assert_current_runtime_identity false
  assert_api_uses_compose_database
  assert_operational_write_state normal
  wait_for_worker_ready

  source_sha="$(git_as_owner rev-parse HEAD)"
  assert_github_main_unchanged
  [[ "$(git_as_owner rev-parse "$EXPECTED_UPSTREAM_REF")" == "$target_sha" ]] || {
    die 'origin/main differs from the verified release source bundle.'
  }
  git_as_owner cat-file -e "${runtime_sha}^{commit}"
  git_as_owner merge-base --is-ancestor "$runtime_sha" "$target_sha" || {
    die 'The running release is not an ancestor of origin/main.'
  }
  git_as_owner merge-base --is-ancestor "$source_sha" "$target_sha" || {
    die 'The server source checkout cannot fast-forward to origin/main.'
  }
  [[ "$(curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/version.json" | json_sha_from_stdin)" == "$runtime_sha" ]] || {
    die 'Public version endpoint differs from the verified local runtime.'
  }
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/health" | assert_health_json
  verify_github_release_gate

  repair_stamp="$(date '+%Y%m%d-%H%M%S')"
  repair_dir="${BACKUP_ROOT}/identity-repair-${repair_stamp}"
  [[ ! -e "$repair_dir" ]] || die "Identity repair directory already exists: ${repair_dir}"
  install -d -m 700 "$BACKUP_ROOT"
  install -d -m 700 "$repair_dir"
  cp -- "$active_env_file" "$repair_dir/.env.before"
  chown root:root "$repair_dir/.env.before"
  chmod 600 "$repair_dir/.env.before"

  repair_env_file="$(mktemp "${PRODUCTION_ENV_FILE}.repair.XXXXXX")"
  cp -- "$active_env_file" "$repair_env_file"
  clear_build_identity "$repair_env_file"
  clear_compatibility_release_metadata "$repair_env_file"
  set_env_value BUILD_SHA "$runtime_sha" "$repair_env_file"
  set_env_value BUILD_TIME "$runtime_time" "$repair_env_file"
  set_env_value BUILD_MIGRATION "$runtime_migration" "$repair_env_file"
  set_env_value BUILD_MIGRATION_HASH "$runtime_migration_hash" "$repair_env_file"
  if [[ "$runtime_code_migration_hash" != "$runtime_migration_hash" ]]; then
    set_release_metadata_value TOKEMS_COMPATIBILITY_ROLLBACK active "$repair_env_file"
    set_release_metadata_value TOKEMS_ROLLBACK_CODE_MIGRATION "$runtime_code_migration" "$repair_env_file"
    set_release_metadata_value TOKEMS_ROLLBACK_CODE_MIGRATION_HASH "$runtime_code_migration_hash" "$repair_env_file"
  fi
  chown root:root "$repair_env_file"
  chmod 600 "$repair_env_file"
  [[ "$(env_file_value BUILD_SHA "$repair_env_file")" == "$runtime_sha" ]] || die 'Repaired BUILD_SHA validation failed.'
  [[ "$(env_file_value BUILD_TIME "$repair_env_file")" == "$runtime_time" ]] || die 'Repaired BUILD_TIME validation failed.'
  [[ "$(env_file_value BUILD_MIGRATION "$repair_env_file")" == "$runtime_migration" ]] || die 'Repaired BUILD_MIGRATION validation failed.'
  [[ "$(env_file_value BUILD_MIGRATION_HASH "$repair_env_file")" == "$runtime_migration_hash" ]] || {
    die 'Repaired BUILD_MIGRATION_HASH validation failed.'
  }
  active_env_file="$repair_env_file"
  if ! (compose config --quiet && assert_current_runtime_identity); then
    active_env_file="$session_env_file"
    die 'Identity repair validation failed; the protected production environment was not changed.'
  fi
  install_active_production_environment

  printf 'status=repaired\nruntime_sha=%s\nruntime_migration=%s\ntarget_sha=%s\n' \
    "$runtime_sha" "$runtime_migration" "$target_sha" \
    >"$repair_dir/identity-repair-result.txt"
  chmod 600 "$repair_dir/identity-repair-result.txt"
  log "Production build identity now matches the healthy running release ${runtime_sha}."
  log "Identity repair backup: ${repair_dir}"
}

recover_interrupted_release() {
  log 'Restoring the application state recorded before the interrupted database-free release phase'
  assert_no_parallel_release
  assert_pending_recovery_policy
  [[ "$pending_recovery_phase" == 'pre-write' ]] || die 'recover-interrupted accepts only a pre-database release marker.'
  [[ -n "$pending_recovery_rollback_tag" ]] || die 'Interrupted release marker is missing its rollback image tag.'

  backup_dir="$pending_recovery_backup_dir"
  rollback_tag="$pending_recovery_rollback_tag"
  target_sha="$pending_recovery_target_sha"
  if [[ -n "$requested_target_sha" && "$requested_target_sha" != "$target_sha" ]]; then
    die "Interrupted release target is ${target_sha}; requested target was ${requested_target_sha}."
  fi
  assert_trusted_recovery_file "$backup_dir/.env"
  assert_trusted_recovery_file "$backup_dir/docker-compose.yml"
  active_env_file="$backup_dir/.env"
  active_compose_file="$backup_dir/docker-compose.yml"
  assert_production_environment false

  local image service
  for image in "${ROLLBACK_IMAGES[@]}"; do
    docker image inspect "${image}:${rollback_tag}" >/dev/null
    docker tag "${image}:${rollback_tag}" "${image}:local"
  done

  install_active_production_environment

  compose_bounded "$SERVICE_TRANSITION_TIMEOUT_SECONDS" \
    up -d \
    --no-build \
    --no-deps \
    --force-recreate \
    --wait \
    --wait-timeout 300 \
    "${RELEASE_SERVICES[@]}" \
    >"$backup_dir/interrupted-release-recovery.log" 2>&1

  compose config --quiet
  docker info >/dev/null
  nginx -t
  for service in "${LONG_RUNNING_SERVICES[@]}"; do
    assert_service_healthy "$service"
  done
  assert_runtime_image_tags
  assert_current_runtime_identity
  assert_api_uses_compose_database
  assert_operational_write_state normal
  wait_for_worker_ready
  [[ "$(curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/version.json" | json_sha_from_stdin)" == "$runtime_sha" ]] || {
    die 'Recovered public version differs from the restored local runtime.'
  }
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/health" \
    >"$backup_dir/public-health-interrupted-recovery.json"
  chmod 600 "$backup_dir/public-health-interrupted-recovery.json"
  assert_health_json <"$backup_dir/public-health-interrupted-recovery.json"
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/homepage" \
    >"$backup_dir/public-homepage-interrupted-recovery.json"
  chmod 600 "$backup_dir/public-homepage-interrupted-recovery.json"
  verify_homepage_file \
    "$backup_dir/public-homepage-interrupted-recovery.json" \
    "$backup_dir/canonical-homepage.public.before.json"

  printf 'status=recovered-pre-write\nruntime_sha=%s\ntarget_sha=%s\nrollback_tag=%s\n' \
    "$runtime_sha" "$target_sha" "$rollback_tag" \
    >"$backup_dir/interrupted-release-recovery-result.txt"
  chmod 600 "$backup_dir/interrupted-release-recovery-result.txt"
  clear_pending_recovery_marker
  log "Interrupted pre-database release recovered to ${runtime_sha}; evidence remains at ${backup_dir}."
}

resolve_pending_recovery() {
  log 'Verifying independently restored production writes before clearing the recovery marker'
  assert_minimal_git_state
  assert_production_environment
  assert_no_parallel_release
  assert_pending_recovery_policy
  compose config --quiet
  docker info >/dev/null
  nginx -t

  local service baseline_phase expected_file resolved_snapshot resolved_full_snapshot
  local alternate_full_snapshot='' previous_projection='false' runtime_projection='false'
  for service in "${LONG_RUNNING_SERVICES[@]}"; do
    assert_service_healthy "$service"
  done
  assert_runtime_image_tags
  assert_current_runtime_identity
  assert_api_uses_compose_database
  assert_operational_write_state normal
  wait_for_worker_ready
  curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/api/v1/health' | assert_health_json

  assert_github_main_unchanged
  [[ "$(git_as_owner rev-parse "$EXPECTED_UPSTREAM_REF")" == "$target_sha" ]] || {
    die 'origin/main differs from the verified release source bundle.'
  }
  git_as_owner cat-file -e "${runtime_sha}^{commit}"
  git_as_owner merge-base --is-ancestor "$runtime_sha" "$target_sha" || {
    die 'Resolved runtime is not an ancestor of origin/main.'
  }
  verify_github_release_gate
  [[ "$(curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/version.json" | json_sha_from_stdin)" == "$runtime_sha" ]] || {
    die 'Resolved public version differs from the verified local runtime.'
  }
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/health" \
    >"$pending_recovery_backup_dir/public-health-recovery-resolve.json"
  chmod 600 "$pending_recovery_backup_dir/public-health-recovery-resolve.json"
  assert_health_json <"$pending_recovery_backup_dir/public-health-recovery-resolve.json"

  backup_dir="$pending_recovery_backup_dir"
  baseline_phase='before'
  if [[ ! -s "$backup_dir/business-counts-before.csv" ]] || \
    [[ ! -f "$backup_dir/protected-business-ids-before.csv" ]] || \
    [[ ! -f "$backup_dir/ticket-types-sold-before.csv" ]] || \
    [[ ! -f "$backup_dir/ticket-quotas-sold-before.csv" ]]; then
    baseline_phase='build-start'
  fi
  expected_file="business-counts-${baseline_phase}.csv"
  [[ -s "$backup_dir/$expected_file" ]] || die "Recovery baseline evidence is missing: ${expected_file}"
  for expected_file in \
    "protected-business-ids-${baseline_phase}.csv" \
    "ticket-types-sold-${baseline_phase}.csv" \
    "ticket-quotas-sold-${baseline_phase}.csv"; do
    [[ -f "$backup_dir/$expected_file" ]] || die "Recovery baseline evidence is missing: ${expected_file}"
  done
  capture_business_snapshot "$backup_dir/business-counts-recovery-resolve.csv"
  capture_protected_business_ids "$backup_dir/protected-business-ids-recovery-resolve.csv" stable growth_comparison
  capture_ticket_sales \
    "$backup_dir/ticket-types-sold-recovery-resolve.csv" \
    "$backup_dir/ticket-quotas-sold-recovery-resolve.csv"
  compare_production_data recovery-resolve "$baseline_phase" false growth

  git_as_owner show "${runtime_sha}:packages/contracts/src/canonical-homepage.public.json" \
    >"$backup_dir/canonical-homepage.public.resolved-runtime.json"
  git_as_owner show "${runtime_sha}:packages/contracts/src/canonical-homepage.snapshot.json" \
    >"$backup_dir/canonical-homepage.snapshot.resolved-runtime.json"
  chmod 600 \
    "$backup_dir/canonical-homepage.public.resolved-runtime.json" \
    "$backup_dir/canonical-homepage.snapshot.resolved-runtime.json"
  curl "${CURL_ARGS[@]}" 'http://127.0.0.1:8088/api/v1/homepage' \
    >"$backup_dir/homepage-recovery-resolve.json"
  if verify_homepage_file \
    "$backup_dir/homepage-recovery-resolve.json" \
    "$backup_dir/canonical-homepage.public.before.json" 2>/dev/null; then
    previous_projection='true'
  fi
  if verify_homepage_file \
    "$backup_dir/homepage-recovery-resolve.json" \
    "$backup_dir/canonical-homepage.public.resolved-runtime.json" 2>/dev/null; then
    runtime_projection='true'
  fi
  if [[ "$previous_projection" == 'true' && "$runtime_projection" == 'true' ]]; then
    resolved_snapshot="$backup_dir/canonical-homepage.public.resolved-runtime.json"
    resolved_full_snapshot="$backup_dir/canonical-homepage.snapshot.resolved-runtime.json"
    alternate_full_snapshot="$backup_dir/canonical-homepage.snapshot.before.json"
    printf 'homepage_projection=shared-by-previous-and-runtime\n' >"$backup_dir/recovery-resolve-result.txt"
  elif [[ "$previous_projection" == 'true' ]]; then
    resolved_snapshot="$backup_dir/canonical-homepage.public.before.json"
    resolved_full_snapshot="$backup_dir/canonical-homepage.snapshot.before.json"
    printf 'homepage_projection=previous-release\n' >"$backup_dir/recovery-resolve-result.txt"
  elif [[ "$runtime_projection" == 'true' ]]; then
    resolved_snapshot="$backup_dir/canonical-homepage.public.resolved-runtime.json"
    resolved_full_snapshot="$backup_dir/canonical-homepage.snapshot.resolved-runtime.json"
    printf 'homepage_projection=resolved-runtime\n' >"$backup_dir/recovery-resolve-result.txt"
  else
    die 'Resolved homepage matches neither the previous release nor the verified running release snapshot.'
  fi
  curl "${CURL_ARGS[@]}" "${PUBLIC_ORIGIN}/api/v1/homepage" \
    >"$backup_dir/public-homepage-recovery-resolve.json"
  chmod 600 "$backup_dir/public-homepage-recovery-resolve.json"
  verify_homepage_file "$backup_dir/public-homepage-recovery-resolve.json" "$resolved_snapshot"
  export TOKEMS_READ_ONLY_DATABASE_URL
  TOKEMS_READ_ONLY_DATABASE_URL="$(read_only_database_url)"
  verify_canonical_full_snapshot \
    "$resolved_full_snapshot" \
    recovery-resolve \
    "$alternate_full_snapshot"
  unset TOKEMS_READ_ONLY_DATABASE_URL
  printf 'baseline=%s\nruntime_sha=%s\n' "$baseline_phase" "$runtime_sha" \
    >>"$backup_dir/recovery-resolve-result.txt"
  chmod 600 "$backup_dir/recovery-resolve-result.txt"
  clear_pending_recovery_marker
  log "Normal API writes and the standard Worker command are verified; recovery evidence remains at ${pending_recovery_backup_dir}."
}

run_canonical_repair_release() {
  create_backup_and_rollback_point
  sync_source
  enter_release_write_freeze
  refresh_pre_mutation_database_backup
  run_canonical_database_sync
  start_canonical_read_only_verification
  verify_release \
    "$release_baseline_sha" \
    "$release_baseline_migration" \
    "$release_baseline_migration_hash"
  thaw_release_write_freeze
  write_success_summary
}

write_success_summary() {
  install_active_production_environment
  local result_status='deployed' release_strategy='prebuilt-images'
  local runtime_after_sha="$target_sha"
  if [[ "$canonical_repair_mode" == 'true' ]]; then
    result_status='canonical-synchronized'
    release_strategy='verified-runtime-reuse'
    runtime_after_sha="$release_baseline_sha"
  elif [[ "$build_on_host" == 'true' ]]; then
    release_strategy='emergency-host-build'
  fi
  printf 'status=%s\nrelease_strategy=%s\nruntime_before=%s\nruntime_after=%s\ntarget_sha=%s\ncanonical_sync=%s\nbackup_dir=%s\nrollback_tag=%s\nrelease_descriptor_digest=%s\nsource_bundle_sha256=%s\ndescriptor_verifier_sha256=%s\n' \
    "$result_status" \
    "$release_strategy" \
    "$release_baseline_sha" \
    "$runtime_after_sha" \
    "$target_sha" \
    "$canonical_sync_performed" \
    "$backup_dir" \
    "$rollback_tag" \
    "$descriptor_digest" \
    "$descriptor_source_bundle_sha256" \
    "$descriptor_verifier_sha256" \
    >"$backup_dir/deployment-result.txt"
  chmod 600 "$backup_dir/deployment-result.txt"
  clear_pending_recovery_marker
  stop_thaw_watchdog
  deployment_succeeded='true'
  if [[ "$canonical_repair_mode" == 'true' ]]; then
    log "Canonical synchronization completed on runtime ${release_baseline_sha}; source is now ${target_sha}."
  else
    log "Deployment completed: ${release_baseline_sha} -> ${target_sha}"
  fi
  log "Backup: ${backup_dir}"
  log "Rollback images: ${rollback_tag}"
  log "Canonical sync performed: ${canonical_sync_performed}"
}

main() {
  [[ $# -gt 0 ]] || {
    usage >&2
    return 2
  }

  parse_arguments "$@"
  pin_local_runtime_controls
  require_root_and_base_commands
  acquire_deploy_lock
  if [[ "$mode" == 'recover-interrupted' ]]; then
    bootstrap_recovery_script "$@"
    recover_interrupted_release
    return 0
  fi
  assert_minimal_git_state
  bootstrap_latest_script "$@"
  snapshot_production_environment
  if [[ "$mode" == 'repair-identity' ]]; then
    repair_runtime_identity
    return 0
  fi
  if [[ "$mode" == 'resolve-recovery' ]]; then
    resolve_pending_recovery
    return 0
  fi
  run_full_preflight

  if [[ "$mode" == 'check' ]]; then
    if [[ "$canonical_repair_mode" == 'true' ]]; then
      log 'Canonical repair preflight passed; the current images are compatible and the build-memory gate is not required.'
    elif [[ "$build_on_host" == 'true' ]]; then
      log 'Emergency host-build preflight passed; no production state was changed.'
    else
      log "Prebuilt image preflight passed for descriptor ${descriptor_digest}; production state was unchanged."
    fi
    return 0
  fi

  if [[ "$canonical_repair_mode" == 'true' ]]; then
    run_canonical_repair_release
    return 0
  fi

  create_backup_and_rollback_point
  sync_source
  if [[ "$build_on_host" == 'true' ]]; then
    write_build_identity
    build_images
  else
    pull_prebuilt_images
    write_prebuilt_build_identity
    activate_prebuilt_images
  fi
  enter_release_write_freeze
  refresh_pre_mutation_database_backup
  run_database_updates
  switch_services
  verify_release
  thaw_release_write_freeze
  write_success_summary
}

main "$@"
