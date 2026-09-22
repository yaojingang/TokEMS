import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import controller
from controller import finish, recover_old
from policy import DeployError
from runtime import Runtime
import test_deploy as fixtures
from test_deploy import FakeRuntime, state


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.runtime = object.__new__(Runtime)
        self.runtime.directory = self.root
        self.runtime.config = {}

    def tearDown(self):
        self.tmp.cleanup()

    def test_false_ownership_file_does_not_skip_real_candidate_drain(self):
        (self.root / 'runtime').mkdir()
        (self.root / 'runtime/ownership.json').write_text('{"active":false}')
        found = {'api': dict(Id='new-api', Config={'Labels': {'com.tokems.build.sha': 'sha'}}, State={'Running': True}),
                 'worker': dict(Id='new-worker', Config={'Labels': {'com.tokems.build.sha': 'sha'}}, State={'Running': True})}
        self.runtime.control = Mock(return_value=dict(phase='drained'))
        with patch('runtime.containers', return_value=found):
            self.runtime.quiesce_candidate(dict(project='tokems-green', build={'sha': 'sha'}))
        self.runtime.control.assert_any_call('new-api', 'drain')
        self.runtime.control.assert_any_call('new-worker', 'drain')

    def test_drain_of_already_stopped_old_writers_is_idempotent(self):
        self.runtime.ownership = Mock()
        self.runtime.control = Mock()
        with patch('runtime.inspect', return_value={'State': {'Running': False}}):
            self.runtime.drain(dict(protocol=True, containers={'api': 'old-api', 'worker': 'old-worker'}))
        self.runtime.control.assert_not_called()

    def test_same_process_never_receives_a_second_termination_signal(self):
        (self.root / 'term-intents.json').write_text('{"old-worker":"started"}')
        info = dict(Image='image', State={'Running': True, 'StartedAt': 'started'})
        with patch('runtime.inspect', return_value=info), patch('runtime.wait_until'), patch('runtime.run') as run:
            self.runtime.stop(dict(containers={'worker': 'old-worker'}, images={'worker': 'image'}), ['worker'])
        self.assertFalse(any(call[0][0][1] == 'kill' for call in run.call_args_list))

    def test_failed_first_transaction_with_no_commit_restores_old(self):
        runtime, saved = FakeRuntime(), state('maintenance', compatible=False)
        saved['databaseStarted'] = True
        runtime.database_unchanged = Mock(return_value=True)
        recover_old(runtime, saved)
        self.assertEqual(runtime.events, ['restore'])

    def test_finish_recovers_active_pointer_before_clearing_marker(self):
        directory = self.root / 'release-b'
        directory.mkdir()
        marker = self.root / 'RECOVERY_REQUIRED'
        marker.write_text('backup_dir=' + str(directory) + '\n')
        (self.root / 'active.json').write_text('{"directory":"release-a"}')
        with patch.object(controller, 'ROOT', self.root), patch.object(controller, 'MARKER', marker), patch.object(controller, 'protected', side_effect=Path):
            finish(directory, dict(phase='complete', target={'port': 18089}))
        self.assertEqual(json.loads((self.root / 'active.json').read_text())['directory'], str(directory))
        self.assertFalse(marker.exists())

    def test_old_completed_record_cannot_overwrite_newer_active_pointer(self):
        active = self.root / 'active.json'
        active.write_text('{"directory":"newer-release"}')
        with patch.object(controller, 'ROOT', self.root), patch.object(controller, 'MARKER', self.root / 'absent'):
            finish(self.root / 'old-release', dict(phase='complete', target={}))
        self.assertEqual(json.loads(active.read_text())['directory'], 'newer-release')

    def test_public_resume_accepts_terminal_record_only_with_owned_marker(self):
        release = '20260922T120000Z-' + 'a' * 12
        directory = self.root / release
        directory.mkdir()
        marker = self.root / 'RECOVERY_REQUIRED'
        for phase in ('complete', 'rolled-back'):
            (directory / 'state.json').write_text(json.dumps(dict(phase=phase, artifactsReady=True)))
            marker.write_text('backup_dir=' + str(directory) + '\n')
            with patch.object(controller, 'ROOT', self.root), patch.object(controller, 'MARKER', marker), \
                    patch.object(controller, 'protected', side_effect=lambda path, *args: Path(path)), patch.object(controller, 'private_directory'), \
                    patch.object(controller, 'verify_seal'), patch('controller.os.geteuid', return_value=0), \
                    patch('controller.os.umask'), patch.object(Path, 'is_dir', return_value=True), patch.object(controller, 'run') as run:
                controller.dispatch('resume', release=release)
                self.assertEqual(run.call_count, 1)
                marker.unlink()
                with self.assertRaisesRegex(DeployError, 'own the current recovery marker'):
                    controller.dispatch('resume', release=release)
                self.assertEqual(run.call_count, 1)

    def test_rejected_manual_rollback_leaves_active_state_and_marker_untouched(self):
        directory = self.root / 'release'
        directory.mkdir()
        saved = state('maintenance', compatible=False)
        saved.update(phase='complete', config={}, databaseStarted=True)
        state_path, active_path = directory / 'state.json', self.root / 'active.json'
        state_path.write_text(json.dumps(saved))
        active_path.write_text(json.dumps(dict(directory=str(directory))))
        before = state_path.read_bytes(), active_path.read_bytes()
        runtime = Mock(spec=Runtime)
        runtime.assert_target = Mock()
        runtime.proxy_port.return_value = saved['target']['port']
        runtime.database_unchanged.return_value = False
        marker = self.root / 'RECOVERY_REQUIRED'
        with patch.object(controller, 'ROOT', self.root), patch.object(controller, 'MARKER', marker), \
                patch.object(controller, 'protected', side_effect=Path), patch.object(controller, 'verify_seal'), \
                patch.object(controller, 'Runtime', return_value=runtime), patch.object(controller, 'perform') as perform:
            with self.assertRaisesRegex(DeployError, 'forward recovery'):
                controller.begin_rollback(directory)
            perform.assert_not_called()
        self.assertEqual(before, (state_path.read_bytes(), active_path.read_bytes()))
        self.assertFalse(marker.exists())

    def test_application_incompatibility_blocks_rollback_only_after_write_boundary(self):
        runtime, saved = FakeRuntime(), state('maintenance', compatible=False)
        saved['plan']['applicationRollbackCompatible'] = False
        saved['candidateStarted'] = True
        recover_old(runtime, saved)
        self.assertIn('restore', runtime.events)
        runtime.events.clear()
        saved['targetMayHaveWritten'] = True
        runtime.database_unchanged = Mock(return_value=True)
        with self.assertRaisesRegex(DeployError, 'forward recovery'):
            recover_old(runtime, saved)
        self.assertEqual(runtime.events, [])
        runtime.database_unchanged.assert_not_called()



class AppCompatibilityTests(unittest.TestCase):
    setUp = fixtures.PolicyTests.setUp
    tearDown = fixtures.PolicyTests.tearDown
    classify = fixtures.PolicyTests.classify
    write = fixtures.PolicyTests.write
    def test_application_incompatibility_forces_maintenance(self):
        self.classify()
        self.policy['applicationRollbackCompatible'] = False
        self.write()
        from policy import plan_release
        plan = plan_release(self.root, self.hashes[:1], {}, True)
        self.assertEqual(plan['mode'], 'maintenance')
        self.assertFalse(plan['rollbackCompatible'])


if __name__ == '__main__':
    unittest.main()
