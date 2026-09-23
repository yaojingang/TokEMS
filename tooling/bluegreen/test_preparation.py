import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import artifacts
import controller
from policy import DeployError


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_interrupted_source_extraction_retries_the_verified_archive(self):
        source = self.root / 'source'
        source.mkdir(mode=0o700)
        (source / 'partial.txt').write_text('incomplete')
        def run(args, **kwargs):
            if 'archive' in args:
                return b'verified archive'
            self.assertEqual(kwargs['data'], b'verified archive')
            (source / 'partial.txt').write_text('complete')
            (source / 'remaining.txt').write_text('complete')
        with patch.object(artifacts, 'run', side_effect=run) as command, \
                patch.object(artifacts, 'protected', side_effect=lambda path, *args: Path(path)):
            for _ in range(2):
                self.assertEqual(artifacts.extract_source(self.root, 'a' * 40), source)
                self.assertEqual((source / 'remaining.txt').read_text(), 'complete')
                self.assertEqual((source / 'partial.txt').read_text(), 'complete')
        self.assertEqual(command.call_count, 4)

    def test_changed_controller_is_rejected_before_runtime_preparation(self):
        target = self.root / 'source/tooling/bluegreen'
        target.mkdir(parents=True)
        for path in Path(controller.__file__).parent.glob('*.py'):
            shutil.copyfile(str(path), str(target / path.name))
        (target / 'runtime.py').write_text('# newer target implementation')
        (self.root / 'state.json').write_text(json.dumps(dict(sha='a' * 40, phase='preparing')))
        with patch.object(controller, 'MARKER', self.root / 'absent'), \
                patch.object(controller, 'protected', side_effect=lambda path, *args: Path(path)), \
                patch.object(controller, 'config', return_value={}), \
                patch.object(controller, 'prepare'), \
                patch.object(controller, 'Runtime', side_effect=AssertionError('Runtime must not start with stale controller')) as runtime:
            with self.assertRaises(SystemExit):
                controller.perform(self.root)
            runtime.assert_not_called()
        self.assertEqual(json.loads((self.root / 'state.json').read_text())['phase'], 'preparation-failed')

    def test_matching_controller_accepts_test_only_changes_but_rejects_new_runtime_modules(self):
        target = self.root / 'source/tooling/bluegreen'
        target.mkdir(parents=True)
        for path in Path(controller.__file__).parent.glob('*.py'):
            shutil.copyfile(str(path), str(target / path.name))
        controller.require_target_controller(self.root)
        (target / 'test_new.py').write_text('# target-only test')
        controller.require_target_controller(self.root)
        (target / 'new_runtime.py').write_text('# new implementation')
        with self.assertRaisesRegex(DeployError, 'controller differs'):
            controller.require_target_controller(self.root)


if __name__ == '__main__':
    unittest.main()
