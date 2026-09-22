"""Pure release classification; never infer SQL compatibility from text."""
import hashlib
import json
import re
from pathlib import Path


class DeployError(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise DeployError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_file(root, name):
    require(isinstance(name, str), 'Invalid source path')
    path = (Path(root) / name).resolve()
    require(str(path).startswith(str(Path(root).resolve()) + '/') and path.is_file(), 'Source path escapes release')
    return path


def load_policy(root):
    root = Path(root)
    policy = json.loads((root / 'tooling/bluegreen/release-policy.json').read_text())
    require(policy.get('schema') == 1, 'Unsupported release policy')
    require(type(policy.get('applicationRollbackCompatible')) is bool, 'Declare application rollback compatibility')
    journal = json.loads((root / 'packages/database/drizzle/meta/_journal.json').read_text())['entries']
    migrations = []
    for entry in journal:
        name = entry['tag'] + '.sql'
        path = source_file(root, 'packages/database/drizzle/' + name)
        migrations.append(dict(name=name, hash=digest(path), timestamp=entry['when'], path=str(path)))
    baseline = policy['baseline']
    require(any(m['name'] == baseline['migration'] and m['hash'] == baseline['hash'] for m in migrations), 'Invalid policy baseline')
    baseline_index = next(i for i, m in enumerate(migrations) if m['name'] == baseline['migration'])
    for migration in migrations[baseline_index + 1:]:
        require(migration['name'] in policy['migrations'], 'Unclassified migration: ' + migration['name'])
    names = {m['name']: m for m in migrations}
    for name, spec in policy['migrations'].items():
        require(name in names and spec['sha256'] == names[name]['hash'], 'Migration policy digest mismatch')
        validate_spec(spec)
    tasks = policy['dataTasks']
    require(len({t['id'] for t in tasks}) == len(tasks), 'Duplicate data task IDs')
    for task in tasks:
        require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', task['id']), 'Invalid data task ID')
        validate_spec(task)
        require(digest(source_file(root, task['path'])) == task['sha256'], 'Data task digest mismatch')
        require(digest(source_file(root, task['verifyPath'])) == task['verifySha256'], 'Data verification digest mismatch')
    return policy, migrations


def validate_spec(spec):
    require(spec.get('mode') in ('online', 'maintenance'), 'Update must declare online or maintenance')
    require(type(spec.get('backwardCompatible')) is bool, 'Declare backward compatibility')
    require(spec.get('transaction') is True, 'Only transactional updates supported; split nontransactional DDL into a separately reviewed operation')
    require(spec['mode'] != 'online' or spec['backwardCompatible'], 'Online changes must remain backward compatible')
    require(bool(spec.get('reason')), 'Update requires review rationale')


def plan_release(root, applied, completed, background_protocol):
    policy, migrations = load_policy(root)
    expected = [m['hash'] for m in migrations]
    require(applied and applied == expected[:len(applied)], 'Database history is not an exact prefix of target migrations')
    require(len(applied) <= len(expected), 'Database is newer than target')
    pending = migrations[len(applied):]
    steps = []
    for migration in pending:
        spec = policy['migrations'].get(migration['name'])
        require(spec is not None, 'Unclassified migration: ' + migration['name'])
        steps.append(dict(migration, kind='migration', **spec))
    for task in policy['dataTasks']:
        if task['id'] in completed:
            require(completed[task['id']] == task['sha256'], 'Applied data task changed: ' + task['id'])
        else:
            steps.append(dict(task, kind='data'))
    mode = 'online'
    if not policy['applicationRollbackCompatible'] or any(step['mode'] == 'maintenance' for step in steps) or (pending and not background_protocol):
        mode = 'maintenance'
    return dict(mode=mode, steps=steps, migrationHash=expected[-1],
                compatibleHashes=expected[len(applied)-1:],
                applicationRollbackCompatible=policy['applicationRollbackCompatible'],
                rollbackCompatible=policy['applicationRollbackCompatible'] and (not pending or background_protocol) and all(s['backwardCompatible'] for s in steps))


def transactional_sql(step, root):
    """The mutation and its ledger are committed together; retry skips committed work."""
    body = source_file(root, step['path']).read_text()
    require(digest(step['path'] if Path(step['path']).is_absolute() else source_file(root, step['path'])) == step['sha256'], 'Update source changed')
    # Transaction control and psql commands cannot be embedded in a transactional task.
    require(not re.search(r'^\s*\\|\b(?:BEGIN|COMMIT|ROLLBACK|VACUUM)\s*;', body, re.I | re.M), 'Update must not control its transaction')
    if step['kind'] == 'migration':
        exists = "select exists(select 1 from drizzle.__drizzle_migrations where hash = '{}') as done".format(step['hash'])
        record = "insert into drizzle.__drizzle_migrations(hash, created_at) values ('{}', {});".format(step['hash'], int(step['timestamp']))
        verify = ''
    else:
        exists = "select exists(select 1 from public.tokems_deployment_tasks where id = '{}') as done".format(step['id'])
        record = "insert into public.tokems_deployment_tasks(id, sha256) values ('{}', '{}');".format(step['id'], step['sha256'])
        verify_path = source_file(root, step['verifyPath'])
        require(digest(verify_path) == step['verifySha256'], 'Verification source changed')
        verify = verify_path.read_text().strip().rstrip(';')
        require(not re.search(r'^\s*\\', verify, re.M), 'Verification cannot contain psql commands')
        verify = "\nselect ({}) as verified \\gset\n\\if :verified\n\\else\nselect 1/0;\n\\endif\n".format(verify)
    protect = r"""
create temporary table tokems_preserved_ids(table_name text, id text) on commit drop;
do $tokems_guard$
declare name text;
begin
  foreach name in array array['customer_users','users','registrations','orders','order_items','payments','refunds','tickets','invoice_requests'] loop
    if to_regclass('public.' || name) is not null then
      execute format('insert into pg_temp.tokems_preserved_ids select %L, id::text from public.%I', name, name);
    end if;
  end loop;
end $tokems_guard$;
"""
    preserve = r"""
do $tokems_guard$
declare name text; missing boolean;
begin
  for name in select distinct table_name from pg_temp.tokems_preserved_ids loop
    execute format('select exists(select 1 from pg_temp.tokems_preserved_ids b where b.table_name=%L and not exists(select 1 from public.%I p where p.id::text=b.id))', name, name) into missing;
    if missing then raise exception 'Deployment removed protected business records from %', name; end if;
  end loop;
end $tokems_guard$;
"""
    return r"""begin;
set local lock_timeout = '5s';
set local statement_timeout = '15min';
select pg_advisory_xact_lock(741832091);
create table if not exists public.tokems_deployment_tasks(id text primary key, sha256 text not null, applied_at timestamptz not null default now());
{exists} \gset
\if :done
\else
{protect}
{body}
{preserve}
{verify}
{record}
\endif
commit;
""".format(protect=protect, preserve=preserve, exists=exists, body=body.replace('--> statement-breakpoint', ''), verify=verify, record=record)
