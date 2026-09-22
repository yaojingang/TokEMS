import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from policy import DeployError
from proxy import Gateway, route


class GatewayQuitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name) / 'release'
        self.directory.mkdir()
        self.gateway = Gateway(self.directory)
        self.gateway.configuration.parent.mkdir(parents=True)
        self.gateway.configuration.write_text(route(18088, 'tokems-blue-gateway-1'))
        self.legacy = dict(Id='legacy', Image='old-image', State={'Running': True, 'StartedAt': 'legacy-start'})
        self.entry = dict(Id='entry', Image='entry-image', State={'Running': True, 'StartedAt': 'entry-start'},
                          NetworkSettings={'Networks': {'tokems-green': {}}})
        self.target = dict(Id='target', Name='/tokems-green-gateway-1')
        self.objects = {'legacy': self.legacy, 'entry': self.entry, 'target': self.target}
        self.events = []
        (self.directory / 'gateway-before.json').write_text(json.dumps({'legacy': {
            'id': 'legacy', 'image': 'old-image', 'restart': 'unless-stopped'}}))
        self.gateway.legacy = Mock(side_effect=lambda: copy.deepcopy(self.legacy))
        self.gateway.managed = Mock(return_value=None)
        self.patches = [
            patch('proxy.protected', side_effect=Path),
            patch('proxy.private_directory', side_effect=lambda path: Path(path)),
            patch('proxy.inspect', side_effect=lambda identifier: copy.deepcopy(self.objects[identifier])),
            patch('proxy.run', side_effect=self.command),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def command(self, args, **kwargs):
        self.events.append(args)
        if args[:2] == ['docker', 'start']:
            self.objects[args[2]]['State'].update(Running=True, StartedAt='restarted')
        return 'target' if args[:2] == ['docker', 'ps'] else ''

    def intent(self, identifier):
        (self.gateway.root / 'quit-intents.json').write_text(json.dumps({
            identifier: self.objects[identifier]['State']['StartedAt']}))

    def test_legacy_rollback_waits_for_quit_then_restarts_fresh_state(self):
        self.intent('legacy')
        def finish_quit(check, seconds=60):
            self.events.append(['wait-for-quit'])
            self.assertFalse(check())
            self.legacy['State']['Running'] = False
            self.assertTrue(check())
        with patch('proxy.wait', side_effect=finish_quit):
            self.gateway.restore_legacy()
        self.assertEqual(self.events, [
            ['wait-for-quit'],
            ['docker', 'update', '--restart=unless-stopped', 'legacy'],
            ['docker', 'start', 'legacy'],
        ])

    def test_timeout_persists_quit_and_retry_does_not_signal_twice(self):
        with patch('proxy.wait', side_effect=DeployError('still draining')):
            for _ in range(2):
                with self.assertRaisesRegex(DeployError, 'still draining'):
                    self.gateway.halt(copy.deepcopy(self.legacy))
        signals = [args for args in self.events if args[:2] == ['docker', 'kill']]
        self.assertEqual(signals, [['docker', 'kill', '--signal=QUIT', 'legacy']])
        self.assertEqual(json.loads((self.gateway.root / 'quit-intents.json').read_text()), {'legacy': 'legacy-start'})

    def test_restore_timeout_never_starts_or_forcibly_kills_draining_legacy(self):
        self.intent('legacy')
        with patch('proxy.wait', side_effect=DeployError('still draining')):
            with self.assertRaisesRegex(DeployError, 'still draining'):
                self.gateway.restore_legacy()
        self.assertEqual(self.events, [])

    def test_old_intent_does_not_wait_for_a_new_process(self):
        self.intent('legacy')
        self.legacy['State']['StartedAt'] = 'restarted-elsewhere'
        with patch('proxy.wait') as wait:
            self.gateway.restore_legacy()
        wait.assert_not_called()
        self.assertEqual(self.events, [['docker', 'update', '--restart=unless-stopped', 'legacy']])

    def test_halt_rechecks_a_stale_stopped_snapshot(self):
        stale = copy.deepcopy(self.legacy)
        stale['State']['Running'] = False
        with patch('proxy.wait', side_effect=DeployError('still draining')):
            with self.assertRaises(DeployError):
                self.gateway.halt(stale)
        self.assertIn(['docker', 'kill', '--signal=QUIT', 'legacy'], self.events)

    def test_switch_waits_for_quitting_entry_and_starts_it_instead_of_reload(self):
        self.intent('entry')
        self.gateway.managed.return_value = copy.deepcopy(self.entry)
        self.gateway.workers = Mock(return_value={})
        self.gateway.live_port = Mock(return_value='18089')
        self.gateway.halt = Mock(side_effect=lambda obj: self.events.append(['halt', obj['Id']]))
        waits = []
        def finish_quit(check, seconds=60):
            waits.append(True)
            if len(waits) == 1:
                self.assertFalse(check())
                self.entry['State']['Running'] = False
            self.assertTrue(check())
        with patch('proxy.wait', side_effect=finish_quit):
            self.gateway.switch(18089, 'candidate-image')
        self.assertEqual(len(waits), 2)
        self.assertIn(['docker', 'start', 'entry'], self.events)
        self.assertFalse(any('reload' in args for args in self.events))
        self.assertFalse(self.gateway.transition.exists())


if __name__ == '__main__':
    unittest.main()
