"""Local Docker/Nginx adapter. No network downloads and no image builds."""
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from policy import DeployError, digest, require, transactional_sql
from proxy import Gateway
from system import SAFE_ENV, atomic, protected, run

APPS = ('notification-sink', 'api', 'worker', 'web', 'payment-web', 'admin', 'gateway')
INFRA = ('postgres', 'redis', 'minio', 'mailpit')
MEMORY = dict(api='768m', worker='1024m', web='384m', **{'payment-web': '384m', 'admin': '128m', 'gateway': '128m', 'notification-sink': '128m'})
CONTROL = """const net=require('node:net');let out='';const s=net.connect('/tmp/tokems-deploy-control.sock',()=>s.write(process.argv[1]+'\\n'));s.setTimeout(5000,()=>{s.destroy();process.exit(1)});s.on('data',d=>out+=d);s.on('end',()=>process.stdout.write(out));s.on('error',()=>process.exit(1));"""


def inspect(container):
    return json.loads(run(['docker', 'inspect', container]))[0]


def containers(project):
    ids = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]).splitlines()
    found = {}
    for identifier in ids:
        obj = inspect(identifier)
        name = obj['Config']['Labels'].get('com.docker.compose.service')
        require(name not in found, 'Duplicate containers in project ' + project)
        found[name] = obj
    return found


def curl(url, host=None):
    args = ['curl', '--fail', '--silent', '--show-error', '--connect-timeout', '5', '--max-time', '15',
            '-H', 'Cache-Control: no-cache']
    if host:
        args += ['-H', 'Host: ' + host]
    return run(args + [url], timeout=20)


def wait_until(check, seconds=120):
    deadline = time.monotonic() + seconds
    while True:
        try:
            if check():
                return
        except DeployError:
            pass
        require(time.monotonic() < deadline, 'Timed out waiting for readiness/drain')
        time.sleep(2)


def escape_compose(value):
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, list):
        return [escape_compose(v) for v in value]
    if isinstance(value, dict):
        return {k: escape_compose(v) for k, v in value.items()}
    return value


class Runtime:
    def __init__(self, directory, config):
        self.directory = Path(directory)
        self.config = config
        self.source = self.directory / 'source'
        self.artifacts = json.loads((self.directory / 'artifacts.json').read_text())
        self.compose_path = self.directory / 'compose.json'
        self.infra = containers('tokems')
        require(all(name in self.infra and self.infra[name]['State']['Running'] for name in INFRA), 'Shared infrastructure is unavailable')
        self.postgres = self.infra['postgres']['Id']

    def sql(self, query):
        return run(['docker', 'exec', '-i', self.postgres, 'sh', '-c',
                    'exec psql -Xq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F ,'], data=query, timeout=1000)

    def history(self):
        return self.sql('begin read only; select hash from drizzle.__drizzle_migrations order by created_at; commit;').splitlines()

    def completed(self):
        if self.sql("select to_regclass('public.tokems_deployment_tasks') is not null;") != 't':
            return {}
        return dict(line.split(',') for line in self.sql('select id, sha256 from public.tokems_deployment_tasks;').splitlines())

    def database_unchanged(self, state):
        # The same lock fences an orphaned psql transaction before deciding that rollback is safe.
        query = r"""begin;
set local lock_timeout = '5s';
select pg_advisory_xact_lock(741832091);
select to_regclass('public.tokems_deployment_tasks') is not null as tasks_exist \gset
\if :tasks_exist
select json_build_object('history', (select json_agg(hash order by created_at) from drizzle.__drizzle_migrations),
  'tasks', (select coalesce(json_object_agg(id,sha256),'{}'::json) from public.tokems_deployment_tasks));
\else
select json_build_object('history', (select json_agg(hash order by created_at) from drizzle.__drizzle_migrations), 'tasks', '{}'::json);
\endif
commit;
"""
        return json.loads(self.sql(query)) == state['databaseBefore']

    def quiet(self):
        require(self.sql((self.source / 'tooling/bluegreen/payment-quiet.sql').read_text()) == '0,0,0', 'Payments have not settled; retry while current service remains available')

    def local_images(self):
        for service, image in self.artifacts['images'].items():
            metadata = json.loads(run(['docker', 'image', 'inspect', '--format', '{{json .}}', image]))
            saved = json.loads((self.directory / (service + '-image.json')).read_text())
            require(metadata['Id'] == saved['Id'], 'Cached image changed: ' + service)

    def control(self, container, command='status'):
        result = json.loads(run(['docker', 'exec', container, 'node', '-e', CONTROL, command], timeout=15))
        require('error' not in result, 'Background control rejected command')
        return result

    def active(self, port):
        project = {8088: 'tokems', 18088: 'tokems-blue', 18089: 'tokems-green'}[port]
        found = containers(project)
        require(all(s in found and found[s]['State']['Running'] for s in APPS), 'Active release is incomplete')
        result = dict(project=project, port=port, containers={s: found[s]['Id'] for s in APPS},
                      images={s: found[s]['Image'] for s in APPS},
                      restart={s: found[s]['HostConfig']['RestartPolicy']['Name'] for s in APPS})
        identities = []
        for s in APPS:
            labels = found[s]['Config']['Labels']
            values = [labels.get('com.tokems.build.' + key) for key in ('sha', 'time', 'migration', 'migration-hash')]
            require(all(v and v != 'unknown' for v in values), 'Active build identity missing: ' + s)
            identities.append(values)
        require(all(v == identities[0] for v in identities), 'Active applications have mixed builds')
        result['build'] = dict(zip(('sha', 'time', 'migration', 'migration-hash'), identities[0]))
        self.verify_http(port, result['build'])
        self.verify_http(8088, result['build'])
        self.verify_http(port, result['build'], public=True)
        # Do not operate on a different PostgreSQL instance from the API.
        query = "select current_database() as db, system_identifier::text as id, current_setting('default_transaction_read_only') as mode from pg_control_system()"
        proof = run(['docker', 'exec', result['containers']['api'], 'node', '--input-type=module', '-e',
                     "import{createDatabase}from'@conference/database';const{pool}=createDatabase();console.log(JSON.stringify((await pool.query(" + json.dumps(query) + ")).rows[0]));await pool.end();"])
        require(json.loads(proof) == json.loads(self.sql('select row_to_json(t) from (' + query + ') t;')), 'API and backup databases differ')
        require(self.sql('show default_transaction_read_only;') == 'off', 'Database is already frozen')
        result['protocol'] = all(found[s]['Config']['Labels'].get('com.tokems.background-control') == '1' and
                                 'TOKEMS_DEPLOY_CONTROL_SOCKET=/tmp/tokems-deploy-control.sock' in found[s]['Config']['Env']
                                 for s in ('api', 'worker'))
        applied_hash = self.history()[-1]
        if applied_hash != identities[0][3]:
            require(result['protocol'] and applied_hash in json.loads((self.runtime_directory(result['containers']['api']) / 'compatible.json').read_text()), 'Active database/build mismatch; resolve existing recovery first')
        if result['protocol']:
            for s in ('api', 'worker'):
                status = self.control(result['containers'][s])
                require(status['ready'] and status['phase'] == 'active' and status['buildSha'] == result['build']['sha'], 'Active background owner is not ready')
        require(not any(obj['State']['Running'] for name, obj in self.infra.items() if name in ('db-init', 'minio-init')), 'Initialization job is still running')
        return result

    def capacity(self):
        values = dict(re.findall(r'^(\w+):\s+(\d+)', Path('/proc/meminfo').read_text(), re.M))
        require(int(values['MemAvailable']) >= 4 * 1024 * 1024, 'Need 4 GiB available RAM for two application slots')
        db_bytes = int(self.sql('select pg_database_size(current_database());'))
        for path in (self.directory, Path('/var/lib/docker')):
            require(shutil.disk_usage(str(path)).free >= 8 * 1024 ** 3 + 2 * db_bytes, 'Insufficient disk for images, backup and rollback')
        available = int(self.sql("select current_setting('max_connections')::int - count(*) from pg_stat_activity;"))
        require(available >= 30, 'Insufficient PostgreSQL connections for candidate')

    def backup(self, name):
        path = self.directory / (name + '.dump')
        with path.open('wb') as output:
            result = subprocess.run(['docker', 'exec', self.postgres, 'sh', '-c',
                                     'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],
                                    stdout=output, stderr=subprocess.DEVNULL, env=SAFE_ENV, timeout=1800)
            require(result.returncode == 0, 'Database backup failed')
            output.flush()
            os.fsync(output.fileno())
        require(path.stat().st_size > 0, 'Empty database backup')
        with path.open('rb') as source:
            result = subprocess.run(['docker', 'exec', '-i', self.postgres, 'pg_restore', '--list'],
                                    stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    env=SAFE_ENV, timeout=180)
            require(result.returncode == 0, 'Database backup archive is unreadable')
        return str(path)

    def counts(self):
        return {table: int(self.sql('select count(*) from ' + table + ';')) for table in
                ('customer_users', 'registrations', 'orders', 'tickets', 'invoice_requests')}

    def configure(self, old, slot):
        Gateway(self.directory).prepare()
        project = 'tokems-' + slot
        port = 18088 if slot == 'blue' else 18089
        require(not any(o['State']['Running'] for o in containers(project).values()), 'Inactive slot is still running')
        metadata_env = dict(BUILD_SHA=self.artifacts['build']['sha'], BUILD_TIME=self.artifacts['build']['time'],
                            BUILD_MIGRATION=self.artifacts['build']['migration'], BUILD_MIGRATION_HASH=self.artifacts['build']['migration-hash'])
        raw = json.loads(run(['docker', 'compose', '--env-file', '/etc/tokems/production.env',
                              '--project-directory', self.source, '-f', self.source / 'docker-compose.yml',
                              'config', '--format', 'json'], env=metadata_env))
        api_env = raw['services']['api']['environment']
        require(api_env.get('DEPLOYMENT_MODE') == 'production' and api_env.get('PUBLIC_ORIGIN') == 'https://hui.ailingdaoli.com' and api_env.get('ADMIN_ORIGIN') == 'https://admin.hui.ailingdaoli.com', 'Production deployment origins/mode are invalid')
        for key in ('JWT_SECRET', 'CUSTOMER_OTP_PEPPER', 'CUSTOMER_SESSION_SECRET', 'NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET'):
            require(len(api_env.get(key, '')) >= 32, 'Required production credential is missing or too short: ' + key)
        require(api_env.get('CUSTOMER_OTP_MODE') != 'fake' and api_env.get('ALLOW_INSECURE_LOCAL_AUTH') != 'true', 'Local authentication is forbidden in production')
        assets = Path('/var/lib/tokems-bluegreen-assets')
        assets.mkdir(mode=0o755, exist_ok=True)
        require(not assets.is_symlink() and assets.stat().st_uid == 0 and not assets.stat().st_mode & 0o022, 'Invalid asset cache owner')
        os.chmod(str(assets), 0o755)
        # Preserve content-hashed files from the active and new images; HTML remains version-specific.
        for service, path, subdir in [('web', '/app/public/_nuxt', 'web'), ('admin', '/usr/share/nginx/html/assets', 'admin')]:
            for image in (old['images'][service], self.artifacts['images'][service]):
                container = run(['docker', 'create', image])
                temporary = self.directory / ('assets-' + service)
                temporary.mkdir(exist_ok=True)
                try:
                    run(['docker', 'cp', container + ':' + path + '/.', temporary])
                    dest = assets / subdir
                    dest.mkdir(mode=0o755, exist_ok=True)
                    os.chmod(str(dest), 0o755)
                    for file in temporary.rglob('*'):
                        require(not file.is_symlink(), 'Symlink in static asset output')
                        if file.relative_to(temporary).as_posix() == 'builds/latest.json':
                            continue
                        if not file.is_file():
                            continue
                        require(file.suffix in ('.js', '.css', '.woff', '.woff2', '.ttf', '.svg', '.png', '.jpg', '.webp', '.avif', '.gif', '.jpeg', '.otf', '.wasm', '.ico', '.json', '.map'), 'Unexpected static asset type')
                        relative = file.relative_to(temporary)
                        target = dest / relative
                        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                        for parent in [target.parent] + list(target.parent.parents):
                            if parent == assets: break
                            require(not parent.is_symlink() and parent.stat().st_uid == 0, 'Invalid static asset directory')
                            os.chmod(str(parent), 0o755)
                        require(not target.exists() or digest(target) == digest(file), 'Static asset path collision: ' + str(relative))
                        shutil.copyfile(str(file), str(target))
                        os.chmod(str(target), 0o644)
                finally:
                    run(['docker', 'rm', container])
                    shutil.rmtree(str(temporary))
        gateway = (self.source / 'docker/gateway.nginx.conf').read_text()
        locations = '''\n  location = /_nuxt/builds/latest.json { proxy_pass http://web_backend; add_header Cache-Control "no-store"; }
  location = /pay/hui/_nuxt/builds/latest.json { proxy_pass http://payment_web_backend; add_header Cache-Control "no-store"; }
  location ^~ /_nuxt/ { alias /tokems-assets/web/; add_header Cache-Control "public, max-age=31536000, immutable"; }
  location ^~ /pay/hui/_nuxt/ { alias /tokems-assets/web/; add_header Cache-Control "public, max-age=31536000, immutable"; }
'''
        gateway = gateway.replace('  client_max_body_size 2m;', locations + '\n  client_max_body_size 2m;')
        # Only the admin virtual host exposes admin assets.
        gateway = gateway.replace('  location /admin/ {', '  location ^~ /admin/assets/ { alias /tokems-assets/admin/; }\n\n  location /admin/ {')
        atomic(self.directory / 'gateway.conf', gateway, 0o644)
        runtime_dir = self.directory / 'runtime'
        runtime_dir.mkdir(mode=0o755, exist_ok=True)
        os.chmod(str(runtime_dir), 0o755)
        atomic(runtime_dir / 'compatible.json', [], 0o644)
        atomic(runtime_dir / 'ownership.json', dict(sha=self.artifacts['sha'], active=False), 0o644)
        config = dict(name=project, services={}, networks={'default': {'external': True, 'name': project}})
        for service in APPS:
            entry = dict(raw['services'][service])
            for field in ('build', 'depends_on', 'ports', 'networks', 'container_name'):
                entry.pop(field, None)
            entry.update(image=self.artifacts['images']['web' if service == 'payment-web' else service],
                         pull_policy='never', mem_limit=MEMORY[service], cpus='1.0', restart='unless-stopped',
                         networks={'default': {'aliases': [service]}})
            environment = entry.setdefault('environment', {})
            environment.update(metadata_env, SEED_DEMO_DATA='false')
            if service in ('api', 'worker'):
                entry.setdefault('labels', {})['com.tokems.background-control'] = '1'
                environment.update(TOKEMS_DEPLOY_STANDBY='true', TOKEMS_DEPLOY_CONTROL_SOCKET='/tmp/tokems-deploy-control.sock',
                                   TOKEMS_COMPATIBLE_MIGRATIONS_FILE='/run/tokems/compatible.json',
                                   TOKEMS_DEPLOY_STATE_FILE='/run/tokems/ownership.json', DATABASE_POOL_SIZE='10')
                entry.setdefault('volumes', []).append({'type': 'bind', 'source': str(runtime_dir),
                                                       'target': '/run/tokems', 'read_only': True})
            if service == 'gateway':
                entry['ports'] = [{'target': 8080, 'published': str(port), 'host_ip': '127.0.0.1', 'protocol': 'tcp'}]
                entry.setdefault('volumes', []).extend([
                    {'type': 'bind', 'source': str(self.directory / 'gateway.conf'), 'target': '/etc/nginx/conf.d/default.conf', 'read_only': True},
                    {'type': 'bind', 'source': str(assets), 'target': '/tokems-assets', 'read_only': True}])
            config['services'][service] = entry
        atomic(self.compose_path, escape_compose(config))
        return dict(project=project, port=port, compose=str(self.compose_path), build=self.artifacts['build'])

    def compose(self, *args):
        return run(['docker', 'compose', '--env-file', '/dev/null', '--project-directory', self.source,
                    '-f', self.compose_path] + list(args), timeout=300)

    def connect(self, project):
        existing = run(['docker', 'network', 'ls', '--format', '{{.Name}}']).splitlines()
        if project not in existing:
            run(['docker', 'network', 'create', project])
        for name in INFRA:
            obj = inspect(self.infra[name]['Id'])
            if project not in obj['NetworkSettings']['Networks']:
                run(['docker', 'network', 'connect', '--alias', name, project, obj['Id']])

    def assert_target(self, target):
        found = containers(target['project'])
        require(all(name in found for name in APPS), 'Target slot is incomplete')
        for name in APPS:
            source = 'web' if name == 'payment-web' else name
            expected = json.loads((self.directory / (source + '-image.json')).read_text())['Id']
            require(found[name]['Image'] == expected and found[name]['State']['Running'], 'Target slot identity changed: ' + name)
        return found

    def database_identity(self, identifier):
        query = "select current_database() as db, system_identifier::text as id, current_setting('default_transaction_read_only') as mode from pg_control_system()"
        proof = run(['docker', 'exec', identifier, 'node', '--input-type=module', '-e',
                     "import{createDatabase}from'@conference/database';const{pool}=createDatabase();console.log(JSON.stringify((await pool.query(" + json.dumps(query) + ")).rows[0]));await pool.end();"])
        require(json.loads(proof) == json.loads(self.sql('select row_to_json(t) from (' + query + ') t;')), 'Candidate and backup databases differ')

    def start_candidate(self, target):
        self.local_images()
        self.connect(target['project'])
        self.compose('up', '-d', '--no-build', '--pull', 'never', '--no-deps', *APPS)
        def ready():
            found = containers(target['project'])
            if not all(s in found and found[s]['State']['Running'] and found[s]['State'].get('Health', {}).get('Status', 'healthy') == 'healthy' for s in APPS):
                return False
            for name in ('api', 'worker'):
                state = self.control(found[name]['Id'])
                if not state['ready'] or state['buildSha'] != target['build']['sha']:
                    return False
            self.assert_target(target)
            self.database_identity(found['api']['Id'])
            self.verify_http(target['port'], target['build'])
            return True
        wait_until(ready, 180)

    def verify_final(self, target):
        found = self.assert_target(target)
        for name in ('api', 'worker'):
            status = self.control(found[name]['Id'])
            require(status['ready'] and status['phase'] == 'active' and status['buildSha'] == target['build']['sha'], 'Background owner is not active')
        self.verify_http(target['port'], target['build'])
        self.verify_http(8088, target['build'])
        self.verify_http(target['port'], target['build'], public=True)
        atomic(self.directory / 'containers-after.json', {name: dict(id=obj['Id'], image=obj['Image'], state=obj['State']) for name, obj in found.items()})

    def verify_http(self, port, build, public=False):
        base = 'https://hui.ailingdaoli.com' if public else 'http://127.0.0.1:' + str(port)
        for endpoint, service in [('/api/v1/health', 'api'), ('/version.json', 'gateway'), ('/web-version.json', 'web')]:
            response = json.loads(curl(base + endpoint))
            data = response.get('build', response)
            require(data.get('service') == service and [data.get(k) for k in ('sha', 'builtAt', 'migration', 'migrationHash')] ==
                    [build[k] for k in ('sha', 'time', 'migration', 'migration-hash')], 'HTTP build identity mismatch: ' + service)
            if service == 'api':
                require(response.get('status') == 'ok' and response.get('database', {}).get('ok') is True and
                        response['database'].get('migration', {}).get('ok') is True, 'API/database health failure')
        for host, path, service in [('admin.hui.ailingdaoli.com', '/admin/version.json', 'admin'),
                                    ('www.ailingdaoli.com', '/pay/hui/version.json', 'web')]:
            response = json.loads(curl('https://' + host + path if public else base + path, None if public else host))
            data = response.get('build', response)
            require(data.get('service') == service and [data.get(k) for k in ('sha', 'builtAt', 'migration', 'migrationHash')] ==
                    [build[k] for k in ('sha', 'time', 'migration', 'migration-hash')], 'Public entry points have mixed builds: ' + host)
        homepage = json.loads(curl(base + '/api/v1/homepage'))
        require(isinstance(homepage, dict) and isinstance(homepage.get('slug'), str) and bool(homepage['slug']), 'Published homepage event is unavailable')
        checks = [('admin.hui.ailingdaoli.com', '/admin/'), ('www.ailingdaoli.com', '/pay/hui/'), ('hui.ailingdaoli.com', '/')]
        for host, path in checks:
            html = curl('https://' + host + path if public else base + path, None if public else host)
            require('<html' in html.lower(), 'Public document is not available')

    def proxy_port(self):
        return Gateway(self.directory).port()

    def switch(self, port):
        Gateway(self.directory).switch(port, self.artifacts['images']['gateway'])

    def runtime_directory(self, container):
        mounts = [m for m in inspect(container).get('Mounts', []) if m['Destination'] == '/run/tokems']
        require(len(mounts) == 1, 'Current release lacks durable deployment controls')
        path = Path(mounts[0]['Source'])
        require(path.is_dir() and path.stat().st_uid == 0 and not path.is_symlink(), 'Invalid runtime directory')
        return path

    def set_compatibility(self, old, hashes):
        for service in ('api', 'worker'):
            atomic(self.runtime_directory(old['containers'][service]) / 'compatible.json', hashes, 0o644)
            if inspect(old['containers'][service])['State']['Running']:
                self.control(old['containers'][service], 'compatible ' + ','.join(hashes))

    def ownership(self, old, active):
        if old['protocol']:
            for service in ('api', 'worker'):
                atomic(self.runtime_directory(old['containers'][service]) / 'ownership.json',
                       dict(sha=old['build']['sha'], active=active), 0o644)

    def drain(self, old):
        self.ownership(old, False)
        if old['protocol']:
            active = [old['containers'][s] for s in ('api', 'worker') if inspect(old['containers'][s])['State']['Running']]
            for identifier in active:
                self.control(identifier, 'drain')
            wait_until(lambda: all(self.control(identifier)['phase'] == 'drained' for identifier in active), 60)

    def writers_stopped(self, old):
        return all(not inspect(old['containers'][s])['State']['Running'] for s in ('api', 'worker'))

    def stop(self, old, services):
        for service in services:
            identifier = old['containers'][service]
            require(inspect(identifier)['Image'] == old['images'][service], 'Old container changed during release')
            run(['docker', 'update', '--restart=no', identifier])
            obj = inspect(identifier)
            if obj['State']['Running']:
                intents_path = self.directory / 'term-intents.json'
                intents = json.loads(intents_path.read_text()) if intents_path.exists() else {}
                if intents.get(identifier) != obj['State']['StartedAt']:
                    intents[identifier] = obj['State']['StartedAt']
                    atomic(intents_path, intents)
                    # At most one signal per process. A legacy uncertain send is left for inspection.
                    run(['docker', 'kill', '--signal=TERM', identifier])
        wait_until(lambda: all(not inspect(old['containers'][s])['State']['Running'] for s in services), 60)

    def restore(self, old):
        self.ownership(old, True)
        for service in APPS:
            if service == 'gateway' and old['port'] == 8088:
                continue  # Fixed entry must release 8088 before the original Gateway restarts.
            identifier = old['containers'][service]
            require(inspect(identifier)['Image'] == old['images'][service], 'Rollback container identity changed')
            intents_path = self.directory / 'term-intents.json'
            intents = json.loads(intents_path.read_text()) if intents_path.exists() else {}
            if identifier in intents:
                wait_until(lambda: not inspect(identifier)['State']['Running'] or inspect(identifier)['State']['StartedAt'] != intents[identifier], 60)
            run(['docker', 'update', '--restart=' + old['restart'][service], identifier])
            if not inspect(identifier)['State']['Running']:
                run(['docker', 'start', identifier])
        if old['protocol']:
            for service in ('api', 'worker'):
                wait_until(lambda: self.control(old['containers'][service])['ready'])
                self.control(old['containers'][service], 'resume')
        if old['port'] != 8088:
            wait_until(lambda: self.verify_http(old['port'], old['build']) is None)
        self.switch(old['port'])
        wait_until(lambda: self.verify_http(8088, old['build']) is None)
        self.verify_http(old['port'], old['build'], public=True)

    def activate(self, target):
        atomic(self.directory / 'runtime/ownership.json', dict(sha=target['build']['sha'], active=True), 0o644)
        found = containers(target['project'])
        for service in ('api', 'worker'):
            status = self.control(found[service]['Id'], 'activate')
            require(status['phase'] == 'active', 'Target background activation failed')

    def quiesce_candidate(self, target):
        found = containers(target['project'])
        if not found:
            return
        require(all(o['Config']['Labels'].get('com.tokems.build.sha') == target['build']['sha'] for o in found.values()), 'Candidate slot belongs to another release')
        ownership = self.directory / 'runtime/ownership.json'
        atomic(ownership, dict(sha=target['build']['sha'], active=False), 0o644)
        active = [found[s]['Id'] for s in ('api', 'worker') if s in found and found[s]['State']['Running']]
        try:
            for identifier in active:
                self.control(identifier, 'drain')
            wait_until(lambda: all(self.control(identifier)['phase'] == 'drained' for identifier in active), 60)
        except DeployError:
            # A failed startup may not have opened its socket. Prove these writers exited.
            old = dict(containers={s: found[s]['Id'] for s in ('api', 'worker') if s in found},
                       images={s: found[s]['Image'] for s in ('api', 'worker') if s in found})
            self.stop(old, tuple(old['containers']))

    def stop_candidate(self, target):
        found = containers(target['project'])
        if not found:
            return
        require(all(o['Config']['Labels'].get('com.tokems.build.sha') == target['build']['sha'] for o in found.values()), 'Candidate slot now belongs to another release')
        atomic(self.directory / 'runtime/ownership.json', dict(sha=target['build']['sha'], active=False), 0o644)
        old = dict(containers={s: o['Id'] for s, o in found.items()}, images={s: o['Image'] for s, o in found.items()})
        self.stop(old, list(found))

    def apply(self, step):
        self.sql(transactional_sql(step, self.source))
