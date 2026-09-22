"""The fixed Docker Gateway owns port 8088; host Nginx is never inspected or changed."""
import json
import re
import time
from pathlib import Path
from policy import DeployError, require
from system import atomic, private_directory, protected, run

NAME = 'tokems-entry-gateway'
LABEL = 'com.tokems.bluegreen.entry'
CONFIG = '/etc/tokems-entry/nginx.conf'


def inspect(identifier):
    return json.loads(run(['docker', 'inspect', identifier]))[0]


def wait(check, seconds=60):
    deadline = time.monotonic() + seconds
    while True:
        if check():
            return
        require(time.monotonic() < deadline, 'Timed out waiting for Gateway switch/drain')
        time.sleep(0.5)


def route(port, backend):
    require(port in (18088, 18089) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]+', backend), 'Invalid Gateway route')
    # The entry can fail before the version Gateway handles the request. Keep
    # bearer invoice URLs out of its own upstream error logs as well.
    private_routes = ''.join('''
    location ^~ {path} {{
      error_log /dev/null crit;
      proxy_hide_header Referrer-Policy;
      add_header Referrer-Policy "no-referrer" always;
      proxy_pass http://active_release;
    }}
'''.format(path=path) for path in (
        '/invoice/file/', '/api/v1/invoice-files/', '/pay/hui/api/v1/invoice-files/'))
    return '''# TokEMS container entry v1: {port} {backend}
worker_processes auto;
pid /var/run/nginx.pid;
error_log /dev/stderr warn;
events {{ worker_connections 1024; }}
http {{
  access_log off;
  resolver 127.0.0.11 valid=1s ipv6=off;
  map $http_upgrade $entry_connection {{ default upgrade; '' ''; }}
  upstream active_release {{
    zone active_release 64k;
    server {backend}:8080 resolve;
    keepalive 32;
  }}
  server {{
    listen 127.0.0.1:18080;
    location = /active {{ default_type text/plain; return 200 "{port}"; }}
  }}
  server {{
    listen 8080;
    server_name _;
    server_tokens off;
    client_max_body_size 64m;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $entry_connection;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    location = /healthz {{ access_log off; return 200 "ok\\n"; }}
{private_routes}
    location / {{
      proxy_pass http://active_release;
    }}
  }}
}}
'''.format(port=port, backend=backend, private_routes=private_routes)


class Gateway:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.root = self.directory.parent / 'gateway'
        self.configuration = self.root / 'config/nginx.conf'
        self.transition = self.directory / 'proxy-transition.json'

    def managed(self):
        ids = run(['docker', 'ps', '-aq', '--filter', 'label=' + LABEL + '=1']).splitlines()
        require(len(ids) <= 1, 'Multiple fixed Gateway containers')
        if not ids:
            saved = json.loads(protected(self.root / 'identity.json').read_text()) if (self.root / 'identity.json').exists() else {}
            require(not saved.get('id'), 'Fixed Gateway was removed; restore its recorded container before deployment')
            return None
        obj = inspect(ids[0])
        saved = json.loads(protected(self.root / 'identity.json').read_text())
        require((saved.get('id') is None or obj['Id'] == saved['id']) and obj['Image'] == saved['image'] and obj['Name'] == '/' + NAME,
                'Fixed Gateway identity changed')
        require(obj['HostConfig']['PortBindings'].get('8080/tcp') == [{'HostIp': '127.0.0.1', 'HostPort': '8088'}], 'Fixed Gateway must own loopback port 8088')
        require(any(m['Destination'] == '/etc/tokems-entry' and m['Source'] == str(self.configuration.parent) and not m['RW'] for m in obj['Mounts']), 'Fixed Gateway configuration mount changed')
        if saved.get('id') is None:
            atomic(self.root / 'identity.json', dict(id=obj['Id'], image=obj['Image']))
        return obj

    def legacy(self):
        ids = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=tokems',
                   '--filter', 'label=com.docker.compose.service=gateway']).splitlines()
        require(len(ids) == 1, 'Need the original tokems Gateway for legacy takeover/recovery')
        obj = inspect(ids[0])
        require(obj['HostConfig']['PortBindings'].get('8080/tcp') == [{'HostIp': '127.0.0.1', 'HostPort': '8088'}], 'Legacy Gateway must own loopback port 8088')
        return obj

    def read_route(self):
        text = self.configuration.read_text()
        match = re.match(r'# TokEMS container entry v1: (18088|18089) ([a-zA-Z0-9_.-]+)\n', text)
        require(match is not None and text == route(int(match[1]), match[2]), 'Fixed Gateway configuration differs from managed route')
        return int(match[1])

    def port(self):
        obj = self.managed()
        if obj and obj['State']['Running']:
            port = self.read_route()
            require(self.live_port(obj['Id']) == str(port), 'Gateway reload is incomplete; resume the cached release')
            return port
        require(self.legacy()['State']['Running'], 'Neither fixed nor legacy Gateway is running; resume recovery')
        return 8088

    def prepare(self):
        obj = self.managed()
        legacy = self.legacy()
        atomic(self.directory / 'gateway-before.json', dict(legacy=dict(id=legacy['Id'], image=legacy['Image'], restart=legacy['HostConfig']['RestartPolicy']['Name']),
               entry=None if obj is None else dict(id=obj['Id'], image=obj['Image'])))

    def live_port(self, identifier):
        return run(['docker', 'exec', identifier, 'wget', '-qO-', 'http://127.0.0.1:18080/active'], timeout=10)

    def workers(self, identifier):
        # Read /proc inside this container's PID namespace only.
        text = run(['docker', 'exec', identifier, 'sh', '-c',
                    'for p in /proc/[0-9]*; do [ -r "$p/cmdline" ] || continue; case "$(tr "\\000" " " < "$p/cmdline")" in "nginx: worker process"*) cat "$p/stat" 2>/dev/null || true;; esac; done'])
        return {row.split(' ', 1)[0]: row.split(') ', 1)[1].split()[19] for row in text.splitlines()}

    def quit_intents(self):
        path = self.root / 'quit-intents.json'
        return json.loads(protected(path).read_text()) if path.exists() else {}

    def settle_quit(self, obj):
        started = self.quit_intents().get(obj['Id'])
        if started is None:
            return obj
        def exited():
            current = inspect(obj['Id'])
            return not current['State']['Running'] or current['State']['StartedAt'] != started
        if obj['State']['Running'] and obj['State']['StartedAt'] == started:
            wait(exited)
        # Running before the wait does not mean that the draining process survived it.
        return inspect(obj['Id'])

    def halt(self, obj):
        identifier = obj['Id']
        run(['docker', 'update', '--restart=no', identifier])
        current = inspect(identifier)
        if current['State']['Running']:
            intents = self.quit_intents()
            started = current['State']['StartedAt']
            if intents.get(identifier) != started:
                private_directory(self.root)
                intents[identifier] = started
                atomic(self.root / 'quit-intents.json', intents)
                # Persist before sending; an uncertain send requires inspection, never a force kill.
                run(['docker', 'kill', '--signal=QUIT', identifier])
        wait(lambda: not inspect(identifier)['State']['Running'])

    def restore_legacy(self):
        saved = json.loads(protected(self.directory / 'gateway-before.json').read_text())['legacy']
        legacy = self.legacy()
        require(legacy['Id'] == saved['id'] and legacy['Image'] == saved['image'], 'Original Gateway identity changed')
        entry = self.managed()
        if entry:
            self.halt(entry)
        legacy = self.settle_quit(inspect(legacy['Id']))
        run(['docker', 'update', '--restart=' + saved['restart'], legacy['Id']])
        if not legacy['State']['Running']:
            run(['docker', 'start', legacy['Id']])
        if self.transition.exists():
            self.transition.unlink()

    def switch(self, port, image):
        if port == 8088:
            self.restore_legacy()
            return
        require(port in (18088, 18089), 'Invalid target slot')
        project = 'tokems-blue' if port == 18088 else 'tokems-green'
        ids = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
                   '--filter', 'label=com.docker.compose.service=gateway']).splitlines()
        require(len(ids) == 1, 'Target Gateway is not running')
        target = inspect(ids[0])
        desired = route(port, target['Name'].lstrip('/'))
        entry = self.managed()
        if entry:
            entry = self.settle_quit(entry)
        private_directory(self.root)
        private_directory(self.configuration.parent)
        old = self.configuration.read_text() if self.configuration.exists() else None
        # Persist the intended route before any stop, config replacement or reload.
        if not self.transition.exists() or json.loads(self.transition.read_text())['port'] != port:
            atomic(self.transition, dict(port=port, workers=self.workers(entry['Id']) if entry and entry['State']['Running'] else {}))
        pending_config = self.configuration.parent / 'pending.conf'
        atomic(pending_config, desired)
        # Test within a running Gateway, without starting a throwaway container.
        if entry and entry['State']['Running']:
            if project not in entry['NetworkSettings']['Networks']:
                run(['docker', 'network', 'connect', project, entry['Id']])
                entry = inspect(entry['Id'])
            run(['docker', 'exec', entry['Id'], 'nginx', '-t', '-c', '/etc/tokems-entry/pending.conf'])
        else:
            # Initial handover uses this exact verified candidate Gateway image.
            # The v1 route uses the same supported directives on a retained entry.
            run(['docker', 'exec', '-i', target['Id'], 'sh', '-c',
                 "umask 077; trap 'rm -f /tmp/tokems-entry-check.conf' EXIT; "
                 "cat > /tmp/tokems-entry-check.conf && nginx -t -c /tmp/tokems-entry-check.conf"], data=desired)
        atomic(self.configuration, desired)
        if entry is None:
            # Intent survives a controller exit between docker create and recording its ID.
            atomic(self.root / 'identity.json', dict(id=None, image=inspect(image)['Id']))
            identifier = run(['docker', 'create', '--pull', 'never', '--name', NAME, '--label', LABEL + '=1',
                              '--label', 'com.docker.compose.project=tokems-entry', '--label', 'com.docker.compose.service=gateway',
                              '--restart', 'no', '--read-only', '--security-opt', 'no-new-privileges:true',
                              '--memory', '128m', '--cpus', '0.5', '--network', project,
                              '--publish', '127.0.0.1:8088:8080',
                              '--mount', 'type=bind,src=' + str(self.configuration.parent) + ',dst=/etc/tokems-entry,readonly',
                              '--tmpfs', '/var/cache/nginx:size=32m', '--tmpfs', '/var/run:size=4m',
                              '--health-cmd', 'wget --quiet --spider http://127.0.0.1:8080/healthz', '--health-interval', '5s',
                              '--entrypoint', 'nginx', image, '-c', CONFIG, '-g', 'daemon off;'])
            entry = inspect(identifier)
            atomic(self.root / 'identity.json', dict(id=entry['Id'], image=entry['Image']))
        if project not in entry['NetworkSettings']['Networks']:
            run(['docker', 'network', 'connect', project, entry['Id']])
        if not entry['State']['Running']:
            # Legacy's read-only container needs one short port handover, only after candidate health.
            legacy = self.legacy()
            saved = json.loads(protected(self.directory / 'gateway-before.json').read_text())['legacy']
            require(legacy['Id'] == saved['id'] and legacy['Image'] == saved['image'], 'Original Gateway identity changed')
            self.halt(legacy)
            run(['docker', 'update', '--restart=unless-stopped', entry['Id']])
            run(['docker', 'start', entry['Id']])
        else:
            try:
                run(['docker', 'exec', entry['Id'], 'nginx', '-t', '-c', CONFIG])
                run(['docker', 'exec', entry['Id'], 'nginx', '-s', 'reload', '-c', CONFIG])
            except DeployError:
                if old is not None:
                    atomic(self.configuration, old)
                    run(['docker', 'exec', entry['Id'], 'nginx', '-t', '-c', CONFIG])
                    run(['docker', 'exec', entry['Id'], 'nginx', '-s', 'reload', '-c', CONFIG])
                raise
        pending = json.loads(self.transition.read_text())
        def drained():
            try:
                current = self.workers(entry['Id'])
                return self.live_port(entry['Id']) == str(port) and not any(current.get(pid) == start for pid, start in pending['workers'].items())
            except DeployError:
                return False
        wait(drained)
        self.transition.unlink()
