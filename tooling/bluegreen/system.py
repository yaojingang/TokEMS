"""Bounded subprocesses and durable root-owned deployment state (Python >= 3.6)."""
import json
import os
import stat
import subprocess
from pathlib import Path
from policy import DeployError, require

SAFE_ENV = dict(PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME='/root',
                DOCKER_HOST='unix:///var/run/docker.sock', GIT_CONFIG_NOSYSTEM='1',
                GIT_CONFIG_GLOBAL='/dev/null', GIT_NO_REPLACE_OBJECTS='1', GIT_TERMINAL_PROMPT='0')


def run(args, data=None, timeout=180, env=None, binary=False):
    try:
        result = subprocess.run([str(a) for a in args], input=data if binary or data is None else data.encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                                env=dict(SAFE_ENV, **(env or {})))
    except (OSError, subprocess.TimeoutExpired):
        raise DeployError('Command unavailable or timed out: ' + str(args[0]))
    # Tool errors can contain interpolated production secrets. Never echo them.
    require(result.returncode == 0, 'Command failed: ' + str(args[0]) + ' (exit {})'.format(result.returncode))
    return result.stdout if binary else result.stdout.decode().strip()


def atomic(path, value, mode=0o600):
    path = Path(path)
    data = value if isinstance(value, str) else json.dumps(value, indent=2) + '\n'
    temporary = path.with_name(path.name + '.new')
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'w') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(str(temporary), mode)
    os.replace(str(temporary), str(path))
    fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def protected(path, directory=False):
    path = Path(path)
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0, 'Path must be root-owned, without symlinks: ' + str(path))
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'Invalid path type')
    require(stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600), 'Invalid permissions: ' + str(path))
    return path


def private_directory(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    protected(path, True)
    return path
