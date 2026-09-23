import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from controller import execute, recover_old, seal, verify_seal
from policy import DeployError, load_policy, plan_release, transactional_sql
from runtime import escape_compose

ROOT = Path(__file__).resolve().parents[2]


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        folder = self.root / 'packages/database/drizzle'
        (folder / 'meta').mkdir(parents=True)
        (self.root / 'tooling/bluegreen').mkdir(parents=True)
        entries = []
        self.hashes = []
        for i in range(2):
            name = '000%d_change' % i
            body = 'select %d;' % i
            (folder / (name + '.sql')).write_text(body)
            self.hashes.append(hashlib.sha256(body.encode()).hexdigest())
            entries.append(dict(tag=name, when=i + 1))
        (folder / 'meta/_journal.json').write_text(json.dumps(dict(entries=entries)))
        self.policy = dict(schema=1, baseline=dict(migration='0000_change.sql', hash=self.hashes[0]),
                           migrations={}, dataTasks=[], applicationRollbackCompatible=True)
        self.write()

    def tearDown(self):
        self.tmp.cleanup()

    def write(self):
        (self.root / 'tooling/bluegreen/release-policy.json').write_text(json.dumps(self.policy))

    def classify(self, mode='online', compatible=True):
        self.policy['migrations']['0001_change.sql'] = dict(mode=mode, sha256=self.hashes[1], transaction=True,
                                                          backwardCompatible=compatible, reason='reviewed additive change')
        self.write()

    def test_current_repository_policy_is_valid(self):
        policy, migrations = load_policy(ROOT)
        self.assertEqual(plan_release(ROOT, [m['hash'] for m in migrations], {}, True)['steps'], [])
        self.assertTrue(policy['applicationRollbackCompatible'])

    def test_unknown_migration_and_divergent_database_fail_before_deployment(self):
        with self.assertRaisesRegex(DeployError, 'Unclassified'):
            plan_release(self.root, self.hashes[:1], {}, True)
        self.classify()
        with self.assertRaisesRegex(DeployError, 'exact prefix'):
            plan_release(self.root, ['f' * 64], {}, True)

    def test_online_maintenance_and_legacy_routes(self):
        self.classify()
        self.assertEqual(plan_release(self.root, self.hashes[:1], {}, True)['mode'], 'online')
        self.assertEqual(plan_release(self.root, self.hashes[:1], {}, False)['mode'], 'maintenance')
        self.classify('maintenance', False)
        plan = plan_release(self.root, self.hashes[:1], {}, True)
        self.assertEqual(plan['mode'], 'maintenance')
        self.assertFalse(plan['rollbackCompatible'])

    def test_hash_tampering_and_false_online_claim_rejected(self):
        self.classify('online', False)
        with self.assertRaisesRegex(DeployError, 'backward'):
            plan_release(self.root, self.hashes[:1], {}, True)
        self.classify()
        (self.root / 'packages/database/drizzle/0001_change.sql').write_text('drop table orders;')
        with self.assertRaisesRegex(DeployError, 'digest'):
            plan_release(self.root, self.hashes[:1], {}, True)

    def test_task_is_transactional_and_completed_task_is_not_repeated(self):
        data = self.root / 'tooling/bluegreen/fill.sql'
        data.write_text("select 'idempotent';")
        verify = self.root / 'tooling/bluegreen/verify.sql'
        verify.write_text('select true;')
        task = dict(id='fill-v1', path='tooling/bluegreen/fill.sql', verifyPath='tooling/bluegreen/verify.sql',
                    sha256=hashlib.sha256(data.read_bytes()).hexdigest(), verifySha256=hashlib.sha256(verify.read_bytes()).hexdigest(),
                    mode='online', transaction=True, backwardCompatible=True, reason='reviewed')
        self.classify()
        self.policy['dataTasks'] = [task]
        self.write()
        plan = plan_release(self.root, self.hashes, {}, True)
        sql = transactional_sql(plan['steps'][0], self.root)
        self.assertLess(sql.index('begin;'), sql.index("select 'idempotent'"))
        self.assertLess(sql.index('as verified'), sql.index('insert into public.tokems_deployment_tasks'))
        self.assertTrue(sql.rstrip().endswith('commit;'))
        self.assertEqual(plan_release(self.root, self.hashes, {'fill-v1': task['sha256']}, True)['steps'], [])
        with self.assertRaisesRegex(DeployError, 'Applied data task changed'):
            plan_release(self.root, self.hashes, {'fill-v1': 'f'*64}, True)

    def test_compose_preserves_literal_dollars(self):
        self.assertEqual(escape_compose({'env': ['a$b', '$${X}']}), {'env': ['a$$b', '$$$${X}']})

    def test_seal_detects_code_changes_but_allows_runtime_ownership(self):
        (self.root / 'code.py').write_text('ok')
        (self.root / 'ownership.json').write_text('false')
        seal(self.root)
        # protected() is the separate root permission gate, not the seal algorithm under test.
        with patch('controller.protected', side_effect=Path):
            verify_seal(self.root)
            (self.root / 'ownership.json').write_text('true')
            verify_seal(self.root)
            (self.root / 'code.py').write_text('changed')
            with self.assertRaisesRegex(DeployError, 'changed'):
                verify_seal(self.root)


class FakeRuntime:
    def __init__(self, fail=None):
        self.events = []
        self.fail = fail
        self.source = ROOT
    def __getattr__(self, name):
        def effect(*args, **kwargs):
            self.events.append(name)
            if name == self.fail:
                raise DeployError('injected ' + name)
            if name == 'backup': return 'backup.dump'
            if name == 'counts': return {'orders': 10}
            if name == 'sql': return '0'
            if name == 'writers_stopped': return True
        return effect


def state(mode='online', steps=None, compatible=True):
    return dict(plan=dict(mode=mode, steps=steps or [], migrationHash='hash', compatibleHashes=['hash'], applicationRollbackCompatible=True, rollbackCompatible=compatible),
                old=dict(protocol=True, build={'migration-hash': 'hash'}, containers={'api': 'old-api', 'worker': 'old-worker'}),
                target=dict(port=18089, build={}), sha='a'*40)


class FlowTests(unittest.TestCase):
    def test_online_images_and_backup_before_candidate_old_stopped_after_switch(self):
        runtime, saved = FakeRuntime(), state()
        execute(runtime, saved, lambda phase: runtime.events.append('phase:' + phase))
        sequence = ['local_images', 'backup', 'start_candidate', 'switch', 'drain', 'stop', 'writers_stopped', 'activate', 'verify_http']
        cursor = -1
        for action in sequence:
            cursor = runtime.events.index(action, cursor + 1)
        self.assertNotIn('quiet', runtime.events)
        self.assertNotIn('apply', runtime.events)

    def test_bad_image_never_stops_or_starts_any_service(self):
        runtime = FakeRuntime('local_images')
        with self.assertRaises(DeployError): execute(runtime, state(), lambda phase: None)
        self.assertEqual(runtime.events, ['local_images'])

    def test_candidate_write_boundary_is_persisted_before_traffic_or_background(self):
        for mode in ('online', 'maintenance'):
            runtime, saved = FakeRuntime(), state(mode)
            durable = {}
            def checkpoint(phase):
                durable.update(copy.deepcopy(saved))
            def writing_effect(*args):
                self.assertTrue(durable.get('targetMayHaveWritten'))
            runtime.switch = writing_effect
            runtime.activate = writing_effect
            execute(runtime, saved, checkpoint)

    def test_maintenance_stops_all_apps_then_rechecks_payments_then_final_backup(self):
        runtime = FakeRuntime()
        execute(runtime, state('maintenance'), lambda phase: None)
        self.assertEqual(runtime.events[:10], ['local_images', 'backup', 'counts', 'quiet', 'drain', 'stop', 'quiet', 'sql', 'backup', 'start_candidate'])
        self.assertLess(runtime.events.index('activate'), runtime.events.index('switch'))

    def test_post_stop_payment_race_is_before_database_started(self):
        runtime, saved = FakeRuntime(), state('maintenance', ['pending'])
        quiet_calls = []
        def quiet():
            quiet_calls.append(True)
            if len(quiet_calls) == 2: raise DeployError('payment race')
        runtime.quiet = quiet
        with self.assertRaises(DeployError): execute(runtime, saved, lambda phase: None)
        self.assertFalse(saved.get('databaseStarted'))
        recover_old(runtime, saved)
        self.assertIn('restore', runtime.events)

    def test_incompatible_database_never_rolls_back_or_restores_dump(self):
        runtime, saved = FakeRuntime(), state('maintenance', compatible=False)
        saved['databaseStarted'] = True
        with self.assertRaisesRegex(DeployError, 'forward recovery'): recover_old(runtime, saved)
        self.assertEqual(runtime.events, ['database_unchanged'])

    def test_candidate_background_drained_before_old_resumes(self):
        runtime, saved = FakeRuntime(), state()
        saved['candidateStarted'] = True
        recover_old(runtime, saved)
        self.assertEqual(runtime.events, ['assert_restorable', 'quiesce_candidate', 'restore', 'stop_candidate'])

    def test_resume_after_database_commit_skips_maintenance_gate(self):
        runtime, saved = FakeRuntime(), state('maintenance')
        saved.update(databaseStarted=True, maintenanceStopped=True, migrated=True, backup='backup.dump')
        execute(runtime, saved, lambda phase: None)
        self.assertNotIn('quiet', runtime.events)
        self.assertNotIn('backup', runtime.events)
        self.assertEqual(runtime.events[:3], ['local_images', 'writers_stopped', 'start_candidate'])

    def test_code_only_maintenance_resume_does_not_gate_on_candidate_connections_or_payments(self):
        for interrupted_phase in ('candidate-ready', 'background-transferred'):
            saved = state('maintenance', compatible=False)
            saved['plan']['applicationRollbackCompatible'] = False
            def checkpoint(phase):
                if phase == interrupted_phase:
                    raise DeployError('controller interrupted')
            with self.assertRaisesRegex(DeployError, 'controller interrupted'):
                execute(FakeRuntime(), saved, checkpoint)
            self.assertTrue(saved['maintenanceStopped'])
            self.assertFalse(saved.get('databaseStarted'))
            resumed = FakeRuntime('quiet')
            execute(resumed, saved, lambda phase: None)
            self.assertNotIn('quiet', resumed.events)
            self.assertNotIn('sql', resumed.events)
            self.assertNotIn('backup', resumed.events)
            self.assertIn('writers_stopped', resumed.events)


if __name__ == '__main__':
    unittest.main()
