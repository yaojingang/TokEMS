"""Run only against an explicitly created, labelled, network-isolated test container."""
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from policy import transactional_sql

CONTAINER = os.environ.get('TOKEMS_BLUEGREEN_TEST_CONTAINER')


@unittest.skipUnless(CONTAINER, 'isolated PostgreSQL test container not requested')
class TransactionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        info = json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER]))[0]
        assert info['Config']['Labels'].get('codex.task') == 'tokems-bluegreen'
        assert info['HostConfig']['NetworkMode'] == 'none'
        cls.sql('drop schema if exists drizzle cascade; drop table if exists fill_test, tokems_deployment_tasks, orders cascade; create table orders(id int primary key); insert into orders values(1); create schema drizzle; create table drizzle.__drizzle_migrations(id serial, hash text, created_at bigint); create table fill_test(id int primary key, value int); insert into fill_test values(1,0);')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @staticmethod
    def sql(body, success=True):
        result = subprocess.run(['docker', 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'conference', '-d', 'conference'], input=body.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if success and result.returncode:
            raise AssertionError(result.stderr.decode())
        if not success and not result.returncode:
            raise AssertionError('expected SQL to fail')
        return result.stdout.decode().strip()

    def task(self, identifier, body, verification):
        path, verify = self.root / (identifier + '.sql'), self.root / (identifier + '-verify.sql')
        path.write_text(body)
        verify.write_text(verification)
        return dict(kind='data', id=identifier, path=path.name, verifyPath=verify.name,
                    sha256=hashlib.sha256(path.read_bytes()).hexdigest(), verifySha256=hashlib.sha256(verify.read_bytes()).hexdigest())

    def test_1_repeat_fill_commits_exactly_once(self):
        task = self.task('increment-once', 'update fill_test set value=value+1 where id=1;', 'select value=1 from fill_test where id=1')
        query = transactional_sql(task, self.root)
        self.sql(query)
        self.sql(query)
        self.assertEqual(self.sql('select value from fill_test where id=1;'), '1')
        self.assertEqual(self.sql("select count(*) from tokems_deployment_tasks where id='increment-once';"), '1')

    def test_2_failed_verification_rolls_back_data_and_ledger(self):
        task = self.task('rejected-fill', 'update fill_test set value=999 where id=1;', 'select false')
        self.sql(transactional_sql(task, self.root), success=False)
        self.assertEqual(self.sql('select value from fill_test where id=1;'), '1')
        self.assertEqual(self.sql("select count(*) from tokems_deployment_tasks where id='rejected-fill';"), '0')

    def test_3_protected_business_rows_cannot_be_removed(self):
        task = self.task('delete-orders', 'delete from orders;', 'select true')
        self.sql(transactional_sql(task, self.root), success=False)
        self.assertEqual(self.sql('select count(*) from orders;'), '1')
        self.assertEqual(self.sql("select count(*) from tokems_deployment_tasks where id='delete-orders';"), '0')

    def test_4_migration_ledger_prevents_duplicate_ddl(self):
        path = self.root / 'migration.sql'
        path.write_text('alter table fill_test add column migrated boolean default true;')
        fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
        step = dict(kind='migration', path=path.name, hash=fingerprint, sha256=fingerprint, timestamp=123)
        query = transactional_sql(step, self.root)
        self.sql(query)
        self.sql(query)
        self.assertEqual(self.sql('select count(*) from drizzle.__drizzle_migrations;'), '1')
        self.assertEqual(self.sql('select migrated from fill_test where id=1;'), 't')


if __name__ == '__main__':
    unittest.main()
