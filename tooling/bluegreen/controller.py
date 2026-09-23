#!/usr/bin/env python3
"""TokEMS deployment state machine; old production-deploy.sh remains independent."""
import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from artifacts import LOCK, prepare
from download import proxy_url
from policy import DeployError, digest, plan_release, require
from runtime import APPS, Runtime, containers, inspect, run, wait_until
from system import atomic, private_directory, protected

ROOT = Path('/www/backup/TokEMS/bluegreen')
MARKER = Path('/www/backup/TokEMS/RECOVERY_REQUIRED')
CONFIG = Path('/etc/tokems/bluegreen.json')


def save(directory, state, phase):
    state['phase'] = phase
    state['updatedAt'] = datetime.utcnow().isoformat() + 'Z'
    atomic(Path(directory) / 'state.json', state)
    print('[TokEMS bluegreen] ' + phase, flush=True)


def seal(directory):
    # Runtime inputs are immutable after the artifact barrier; mutable files are explicit.
    files = {}
    for path in Path(directory).rglob('*'):
        if path.is_file() and not path.is_symlink() and path.name not in ('state.json', 'seal.json', 'compatible.json', 'ownership.json', 'proxy-transition.json') and '__pycache__' not in path.parts and path.suffix != '.dump':
            files[str(path.relative_to(directory))] = digest(path)
    atomic(Path(directory) / 'seal.json', files)


def verify_seal(directory):
    files = json.loads(protected(Path(directory) / 'seal.json').read_text())
    for name, expected in files.items():
        path = Path(directory) / name
        require(not path.is_symlink() and path.is_file() and digest(path) == expected, 'Prepared release file changed: ' + name)


def require_target_controller(directory):
    def implementation(folder):
        return {path.name: digest(path) for path in folder.glob('*.py')
                if not path.name.startswith('test_') and path.is_file() and not path.is_symlink()}
    installed = implementation(Path(__file__).parent)
    target = implementation(Path(directory) / 'source/tooling/bluegreen')
    require(installed and installed == target,
            'Installed bluegreen controller differs from verified target; start a new deploy using the updated target checkout before changing services')


def marker(directory, state):
    atomic(MARKER, 'protocol=bluegreen-v1\nbackup_dir={}\ntarget_sha={}\nphase={}\n'.format(directory, state['sha'], state['phase']))


def clear_marker(directory):
    if MARKER.exists():
        require('backup_dir=' + str(directory) + '\n' in protected(MARKER).read_text(), 'Another recovery owns the marker')
        MARKER.unlink()


def require_rollback_compatible(runtime, state):
    require(state['plan']['applicationRollbackCompatible'] or not state.get('targetMayHaveWritten'),
            'New application may have written incompatible data; forward recovery is required')
    require(not state.get('databaseStarted') or state['plan']['rollbackCompatible'] or runtime.database_unchanged(state),
            'Committed database change requires forward recovery')


def recover_old(runtime, state):
    """Stop the new background owner before restoring the old one, never restore a DB dump."""
    require_rollback_compatible(runtime, state)
    runtime.assert_restorable(state['old'])
    if state.get('candidateStarted'):
        runtime.quiesce_candidate(state['target'])
    runtime.restore(state['old'])
    if state.get('candidateStarted'):
        runtime.stop_candidate(state['target'])


def execute(runtime, state, checkpoint):
    """All effects through Runtime make order and failure boundaries testable."""
    plan, old, target = state['plan'], state['old'], state['target']
    runtime.local_images()  # hard barrier on every entry, including offline resume
    if not state.get('backup'):
        state['backup'] = runtime.backup('before-release')
        state['countsBefore'] = runtime.counts()
        checkpoint('backup-ready')
    if plan['migrationHash'] != old['build']['migration-hash'] and old['protocol'] and plan['rollbackCompatible']:
        runtime.set_compatibility(old, plan['compatibleHashes'])
    if plan['mode'] == 'maintenance' and state.get('maintenanceStopped'):
        require(runtime.writers_stopped(old), 'Maintenance recovery found old writers running')
    if plan['mode'] == 'maintenance' and not state.get('maintenanceStopped'):
        runtime.quiet()
        checkpoint('maintenance-stopping')
        runtime.drain(old)
        runtime.stop(old, APPS)
        # A raced payment remains a pre-database failure and restores the original release.
        runtime.quiet()
        require(runtime.sql("select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend';") == '0', 'Other database clients remain; maintenance cannot begin')
        state['finalBackup'] = runtime.backup('before-database')
        state['maintenanceStopped'] = True
        checkpoint('maintenance-stopped')
    if not state.get('migrated'):
        if plan['steps']:
            state['databaseStarted'] = True
            checkpoint('database-updating')  # persisted BEFORE first possible commit
            # Refresh actual DB history; interrupted committed steps are not repeated.
            remaining = plan_release(runtime.source, runtime.history(), runtime.completed(), old['protocol'])
            for step in remaining['steps']:
                runtime.apply(step)
                checkpoint('database-step-complete')
            require(runtime.history()[-1] == plan['migrationHash'], 'Database did not reach target migration')
        state['migrated'] = True
        checkpoint('database-ready')
    state['candidateStarted'] = True
    checkpoint('candidate-starting')
    runtime.start_candidate(target)
    checkpoint('candidate-ready')
    if plan['mode'] == 'online':
        # Candidate HTTP is writable while both candidate background processes remain standby.
        state['targetMayHaveWritten'] = True
        checkpoint('traffic-switching')
        runtime.switch(target['port'])
        checkpoint('traffic-switched')
        runtime.verify_http(target['port'], target['build'], public=True)
        runtime.drain(old)
        runtime.stop(old, ('api', 'worker'))
    # On recovery never trust just a journal bit: prove old writers are actually stopped.
    require(runtime.writers_stopped(old), 'Old writers are still running')
    state['targetMayHaveWritten'] = True
    checkpoint('old-writers-stopped')
    runtime.activate(target)
    checkpoint('background-transferred')
    if plan['mode'] == 'maintenance':
        runtime.switch(target['port'])
    runtime.verify_http(target['port'], target['build'], public=True)
    state['countsAfter'] = runtime.counts()
    runtime.stop(old, tuple(s for s in APPS if s not in ('api', 'worker')))
    runtime.verify_final(target)
    checkpoint('complete')


def config():
    protected('/etc/tokems', True)
    protected('/etc/tokems/production.env')
    value = json.loads(protected(CONFIG).read_text()) if CONFIG.exists() else {}
    require(set(value) <= {'downloadProxy'},
            'bluegreen.json accepts downloadProxy only; host Nginx configuration is not used')
    value['downloadProxy'] = proxy_url(value.get('downloadProxy'))
    return value


def finish(directory, state):
    if not MARKER.exists():
        return
    require('backup_dir=' + str(directory) + '\n' in protected(MARKER).read_text(), 'Another release owns recovery')
    if state['phase'] == 'complete':
        atomic(ROOT / 'active.json', dict(directory=str(directory), target=state['target']))
    elif state['phase'] == 'rolled-back':
        if state.get('previousActive'):
            atomic(ROOT / 'active.json', state['previousActive'])
        elif (ROOT / 'active.json').exists():
            (ROOT / 'active.json').unlink()
    clear_marker(directory)


def perform(directory):
    directory = protected(directory, True)
    state_path = directory / 'state.json'
    state = json.loads(protected(state_path).read_text())
    if state['phase'] in ('complete', 'rolled-back'):
        finish(directory, state)
        return
    runtime = None
    try:
        if not state.get('artifactsReady'):
            require(not MARKER.exists(), 'Resolve existing legacy or bluegreen recovery first')
            cfg = config()
            print('[TokEMS bluegreen] Download network: ' + ('SSH proxy' if state.get('downloadProxy') else 'direct'), flush=True)
            prepare(directory, state['sha'], state.get('downloadProxy'))
            require_target_controller(directory)
            runtime = Runtime(directory, cfg)
            runtime.capacity()
            port = runtime.proxy_port()
            old = runtime.active(port)
            plan = plan_release(runtime.source, runtime.history(), runtime.completed(), old['protocol'])
            require(plan['migrationHash'] == runtime.artifacts['build']['migration-hash'], 'Migration journal differs from verified image build')
            if plan['mode'] == 'maintenance':
                runtime.quiet()
            target = runtime.configure(old, 'green' if port == 18088 else 'blue')
            previous = json.loads(protected(ROOT / 'active.json').read_text()) if (ROOT / 'active.json').exists() else None
            if previous:
                require(previous['target']['port'] == old['port'] and previous['target']['build'] == old['build'], 'Active release journal disagrees with running services')
            state.update(old=old, target=target, plan=plan, config=cfg, previousActive=previous,
                         databaseBefore=dict(history=runtime.history(), tasks=runtime.completed()))
            for service in APPS:
                run(['docker', 'tag', old['images'][service], 'tokems-' + service + ':rollback-' + directory.name])
            atomic(directory / 'plan.json', plan)
            # Controller and configuration snapshots travel with the recovery directory.
            seal(directory)
            state['artifactsReady'] = True
            save(directory, state, 'artifacts-ready')
            marker(directory, state)
        else:
            verify_seal(directory)
            require(not MARKER.exists() or 'backup_dir=' + str(directory) + '\n' in protected(MARKER).read_text(), 'Recovery marker belongs to another release')
            runtime = Runtime(directory, state['config'])
            marker(directory, state)
        def checkpoint(phase):
            save(directory, state, phase)
            marker(directory, state)
        if state.get('rollbackRequested'):
            recover_old(runtime, state)
            checkpoint('rolled-back')
        else:
            execute(runtime, state, checkpoint)
        finish(directory, state)
    except (DeployError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        # No exception text from external tools or production configuration is printed.
        print('[TokEMS bluegreen] release failed: ' + (str(error) if isinstance(error, DeployError) else type(error).__name__), flush=True)
        if runtime is not None and state.get('artifactsReady'):
            try:
                require_rollback_compatible(runtime, state)
                state['rollbackRequested'] = True
                save(directory, state, 'rollback-started')
                marker(directory, state)
                recover_old(runtime, state)
                save(directory, state, 'rolled-back')
                finish(directory, state)
            except (DeployError, OSError, ValueError, KeyError):
                save(directory, state, 'recovery-required')
                marker(directory, state)
                print('[TokEMS bluegreen] Use resume with this cached release; no CI or registry access is needed.', flush=True)
        else:
            save(directory, state, 'preparation-failed')
        raise SystemExit(1)


def dispatch(command, sha=None, release=None, proxy=None, direct=False):
    require(os.geteuid() == 0, 'Run with sudo on the production host')
    os.umask(0o077)
    require(command == 'deploy' or (proxy is None and not direct), 'Proxy options apply to deploy only; recovery uses local artifacts')
    private_directory(LOCK)
    private_directory(ROOT)
    if command == 'status':
        for path in sorted(ROOT.glob('*/state.json'))[-10:]:
            state = json.loads(protected(path).read_text())
            print(json.dumps(dict(release=path.parent.name, **{key: state.get(key) for key in ('sha', 'phase', 'updatedAt')})))
        return
    require(Path('/run/systemd/system').is_dir(), 'systemd supervision is required')
    if command == 'deploy':
        require(sha is not None and re.fullmatch('[a-f0-9]{40}', sha), 'deploy requires --target-sha with a full merged main SHA')
        require(not MARKER.exists(), 'An existing recovery must be resolved before starting another release')
        cfg = config()
        selected_proxy = None if direct else proxy_url(proxy if proxy is not None else cfg.get('downloadProxy'))
        stamp = datetime.utcnow().strftime('%Y%m%dT%H%M%SZ') + '-' + sha[:12]
        directory = ROOT / stamp
        directory.mkdir(mode=0o700)
        # Pin the controller before detaching from the SSH session.
        controller = directory / 'controller'
        shutil.copytree(str(Path(__file__).parent), str(controller), ignore=shutil.ignore_patterns('__pycache__', '*.test.py'))
        save(directory, dict(sha=sha, downloadProxy=selected_proxy), 'preparing')
    else:
        require(release is not None and re.fullmatch('[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}', release), 'Supply --release from status/output')
        directory = protected(ROOT / release, True)
        controller = directory / 'controller'
        state = json.loads(protected(directory / 'state.json').read_text())
        if command == 'resume':
            require(state['phase'] != 'preparation-failed', 'Preparation failed; use deploy for a new attempt')
            if not MARKER.exists() and state.get('rollbackRequested') and state['phase'] == 'rollback-started':
                active = json.loads(protected(ROOT / 'active.json').read_text())
                require(active['directory'] == str(directory), 'Rollback belongs to a superseded release')
            else:
                require(MARKER.exists() and 'backup_dir=' + str(directory) + '\n' in protected(MARKER).read_text(), 'Resume requires this release to own the current recovery marker')
        if command == 'rollback':
            require(state['phase'] == 'complete', 'Only a completed active release can be rolled back')
            require(not MARKER.exists(), 'Resolve the current recovery before rollback')
            active = json.loads(protected(ROOT / 'active.json').read_text())
            require(active['directory'] == str(directory), 'Only the current active release can be rolled back')
        require(state.get('artifactsReady'), 'Preparation was incomplete; start a new deploy while old service remains available')
        verify_seal(directory)
    unit = 'tokems-bluegreen-' + directory.name + '-' + command
    run(['systemd-run', '--unit=' + unit, '--collect', '--property=Type=exec',
         '--property=UMask=0077', '--property=KillMode=control-group', '--property=TimeoutStopSec=60',
         '--property=Restart=on-abnormal', '--property=RestartSec=10',
         '/usr/bin/python3', controller / 'controller.py', '_rollback' if command == 'rollback' else '_run',
         '--release', directory.name])
    print('Release: ' + directory.name + '\nFollow: journalctl -fu ' + unit + '\nStatus: sudo bash tooling/production-bluegreen.sh status')


def begin_rollback(directory):
    verify_seal(directory)
    state = json.loads(protected(directory / 'state.json').read_text())
    if state.get('rollbackRequested') and state['phase'] != 'complete':
        if state['phase'] == 'rolled-back':
            finish(directory, state)
            return
        if MARKER.exists():
            require('backup_dir=' + str(directory) + '\n' in protected(MARKER).read_text(), 'Another recovery is in progress')
        else:
            active = json.loads(protected(ROOT / 'active.json').read_text())
            require(active['directory'] == str(directory), 'Rollback belongs to a superseded release')
        marker(directory, state)
        perform(directory)
        return
    active = json.loads(protected(ROOT / 'active.json').read_text())
    require(active['directory'] == str(directory) and state['phase'] == 'complete', 'Release is no longer the current completed release')
    require(not MARKER.exists(), 'Another recovery is in progress')
    runtime = Runtime(directory, state['config'])
    require(runtime.proxy_port() == state['target']['port'], 'Actual upstream is not the release being rolled back')
    runtime.assert_target(state['target'])
    # A rejected rollback must leave the healthy active release and marker untouched.
    require_rollback_compatible(runtime, state)
    runtime.assert_restorable(state['old'])
    state['rollbackRequested'] = True
    save(directory, state, 'rollback-started')
    marker(directory, state)
    perform(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('deploy', 'status', 'resume', 'rollback', '_run', '_rollback'))
    parser.add_argument('--target-sha')
    parser.add_argument('--release')
    network = parser.add_mutually_exclusive_group()
    network.add_argument('--proxy', metavar='URL', help='Download through a loopback HTTP/HTTPS/SOCKS5 proxy (deploy only)')
    network.add_argument('--no-proxy', action='store_true', help='Override downloadProxy and use normal networking (deploy only)')
    args = parser.parse_args()
    require(args.command == 'deploy' or (args.proxy is None and not args.no_proxy), 'Proxy options apply to deploy only')
    if args.command in ('_run', '_rollback'):
        require(os.geteuid() == 0 and re.fullmatch('[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}', args.release or ''), 'Invalid supervised release')
        os.umask(0o077)
        private_directory(LOCK)
        lock_path = LOCK / 'deploy.lock'
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        protected(lock_path)
        with os.fdopen(fd, 'w') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeployError('Another production deploy owns the lock')
            directory = ROOT / args.release
            if args.command == '_run':
                perform(directory)
            else:
                begin_rollback(directory)
    else:
        dispatch(args.command, args.target_sha, args.release, args.proxy, args.no_proxy)


if __name__ == '__main__':
    try:
        main()
    except (DeployError, OSError, ValueError, KeyError) as error:
        print('[TokEMS bluegreen] ' + (str(error) if isinstance(error, DeployError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
