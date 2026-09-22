import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import controller
from policy import DeployError
from proxy import CONFIG, Gateway, route


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name) / 'release'
        self.directory.mkdir()
        self.gateway = Gateway(self.directory)
        self.gateway.configuration.parent.mkdir(parents=True)
        self.gateway.configuration.write_text(route(18088, 'tokems-blue-gateway-1'))
        self.entry = dict(Id='entry', Image='image', State={'Running': True}, NetworkSettings={'Networks': {'tokems-green': {}}})
        self.target = dict(Id='target', Name='/tokems-green-gateway-1')
        self.gateway.managed = Mock(return_value=self.entry)
        self.gateway.workers = Mock(return_value={})
        self.gateway.live_port = Mock(return_value='18089')
        self.private = patch('proxy.private_directory', side_effect=lambda path: Path(path))
        self.private.start()

    def tearDown(self):
        self.private.stop()
        self.tmp.cleanup()

    def test_resume_after_config_write_reloads_inside_the_container(self):
        self.gateway.configuration.write_text(route(18089, 'tokems-green-gateway-1'))
        self.gateway.transition.write_text('{"port":18089,"workers":{}}')
        with patch('proxy.inspect', return_value=self.target), patch('proxy.run', return_value='target') as run:
            self.gateway.switch(18089, 'candidate-image')
        run.assert_any_call(['docker', 'exec', 'entry', 'nginx', '-s', 'reload', '-c', CONFIG])
        self.assertTrue(all(call[0][0][0] == 'docker' for call in run.call_args_list))
        self.assertFalse(self.gateway.transition.exists())

    def test_syntax_failure_keeps_previous_route_and_never_stops_gateway(self):
        before = self.gateway.configuration.read_bytes()
        def effect(args, **kwargs):
            if 'nginx' in args and '-t' in args:
                raise DeployError('bad nginx config')
            return 'target'
        with patch('proxy.inspect', return_value=self.target), patch('proxy.run', side_effect=effect) as run:
            with self.assertRaisesRegex(DeployError, 'bad nginx'):
                self.gateway.switch(18089, 'candidate-image')
        self.assertEqual(before, self.gateway.configuration.read_bytes())
        self.assertFalse(any(call[0][0][1] in ('kill', 'start', 'update') for call in run.call_args_list))

    def test_reload_failure_restores_previous_container_configuration(self):
        before = self.gateway.configuration.read_bytes()
        reloads = []
        def effect(args, **kwargs):
            if 'reload' in args:
                reloads.append(args)
                if len(reloads) == 1: raise DeployError('reload failure')
            return 'target'
        with patch('proxy.inspect', return_value=self.target), patch('proxy.run', side_effect=effect):
            with self.assertRaisesRegex(DeployError, 'reload failure'):
                self.gateway.switch(18089, 'candidate-image')
        self.assertEqual(before, self.gateway.configuration.read_bytes())
        self.assertEqual(len(reloads), 2)

    def test_written_route_is_not_assumed_to_be_live(self):
        self.gateway.live_port.return_value = '18089'
        with self.assertRaisesRegex(DeployError, 'reload is incomplete'):
            self.gateway.port()

    def test_initial_handover_validates_before_stopping_legacy(self):
        self.gateway.managed.return_value = None
        legacy = dict(Id='legacy', Image='old-image', State={'Running': False})
        self.gateway.legacy = Mock(return_value=legacy)
        self.gateway.halt = Mock()
        (self.directory/'gateway-before.json').write_text(json.dumps({'legacy': {'id':'legacy','image':'old-image'}}))
        created = dict(self.entry, State={'Running':False})
        def inspect(identifier):
            return self.target if identifier == 'target' else dict(Id='candidate-image') if identifier == 'candidate-image' else created
        events = []
        def run(args, **kwargs):
            events.append('validate' if args[:3]==['docker','exec','-i'] else args[1]); return 'target' if args[1]=='ps' else 'entry'
        self.gateway.halt.side_effect = lambda obj: events.append('halt')
        with patch('proxy.inspect', side_effect=inspect), patch('proxy.run', side_effect=run), patch('proxy.protected', side_effect=Path):
            self.gateway.switch(18089, 'candidate-image')
        self.assertLess(events.index('validate'), events.index('halt'))
        self.assertLess(events.index('create'), events.index('halt'))
        self.assertLess(events.index('halt'), events.index('start'))

    def test_gateway_workers_are_read_in_container_pid_namespace(self):
        self.gateway.workers = Gateway.workers.__get__(self.gateway)
        process = '7 (nginx) ' + ' '.join(['0'] * 19 + ['456'])
        with patch('proxy.run', return_value=process) as run:
            self.assertEqual(self.gateway.workers('entry'), {'7':'456'})
        self.assertEqual(run.call_args[0][0][:3], ['docker','exec','entry'])

    def test_crash_after_create_can_adopt_only_the_intended_gateway(self):
        self.gateway.managed = Gateway.managed.__get__(self.gateway)
        self.gateway.root.mkdir(exist_ok=True)
        (self.gateway.root/'identity.json').write_text('{"id":null,"image":"image"}')
        obj = dict(self.entry, Name='/tokems-entry-gateway',
                   HostConfig={'PortBindings':{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'8088'}]}},
                   Mounts=[{'Destination':'/etc/tokems-entry','Source':str(self.gateway.configuration.parent),'RW':False}])
        with patch('proxy.run', return_value='entry'), patch('proxy.inspect', return_value=obj), patch('proxy.protected', side_effect=Path):
            self.assertEqual(self.gateway.managed()['Id'], 'entry')
            saved = json.loads((self.gateway.root/'identity.json').read_text())
            self.assertEqual(saved, {'id':'entry','image':'image'})
            obj['Image'] = 'unrelated-image'
            with self.assertRaisesRegex(DeployError, 'identity changed'):
                self.gateway.managed()

    def test_old_config_keys_are_rejected_without_invoking_host_nginx(self):
        config = self.directory/'bluegreen.json'
        config.write_text('{"nginx":"/usr/sbin/nginx","upstreamFile":"/etc/nginx/foo"}')
        with patch.object(controller, 'CONFIG', config), patch('controller.protected', side_effect=lambda path,*args: Path(path)), patch('controller.run') as run:
            with self.assertRaisesRegex(DeployError, 'downloadProxy only'):
                controller.config()
            run.assert_not_called()
            config.unlink()
            self.assertEqual(controller.config(), {'downloadProxy':None})


if __name__ == '__main__':
    unittest.main()
