import { spawnSync } from 'node:child_process';

const SERVICE = 'org.tokems.admin-skill';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`Secure credential helper failed (${command})`);
    error.code = 'CREDENTIAL_STORE_UNAVAILABLE';
    throw error;
  }
  return result.stdout.trim();
}

export function credentialStoreKind() {
  if (process.platform === 'darwin') return 'macos-keychain';
  if (process.platform === 'linux') return 'linux-secret-service';
  return 'unsupported';
}

export function credentialStoreAvailable() {
  const key = `capability-probe:${process.pid}:${crypto.randomUUID()}`;
  const value = crypto.randomUUID();
  try {
    const invocation = credentialWriteInvocation(process.platform, key, value);
    if (!invocation) return false;
    run(invocation.command, invocation.args, invocation.options);
    return readCredential(key) === value;
  } catch {
    return false;
  } finally {
    deleteCredential(key);
  }
}

export function credentialWriteInvocation(platform, key, value) {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/security',
      args: ['add-generic-password', '-a', key, '-s', SERVICE, '-U', '-w'],
      options: { input: `${value}\n` },
    };
  }
  if (platform === 'linux') {
    return {
      command: 'secret-tool',
      args: ['store', `--label=TokEMS Admin Skill ${key}`, 'service', SERVICE, 'key', key],
      options: { input: value },
    };
  }
  return undefined;
}

export function storeCredential(key, value) {
  const invocation = credentialWriteInvocation(process.platform, key, value);
  if (invocation) {
    run(invocation.command, invocation.args, invocation.options);
    return;
  }
  const error = new Error('TokEMS Admin requires macOS Keychain or Linux Secret Service');
  error.code = 'CREDENTIAL_STORE_UNAVAILABLE';
  throw error;
}

export function readCredential(key, optional = false) {
  try {
    if (process.platform === 'darwin') {
      return run('/usr/bin/security', ['find-generic-password', '-a', key, '-s', SERVICE, '-w']);
    }
    if (process.platform === 'linux') {
      return run('secret-tool', ['lookup', 'service', SERVICE, 'key', key]);
    }
  } catch (error) {
    if (optional) return undefined;
    throw error;
  }
  if (optional) return undefined;
  const error = new Error('TokEMS Admin requires a supported secure credential store');
  error.code = 'CREDENTIAL_STORE_UNAVAILABLE';
  throw error;
}

export function deleteCredential(key) {
  try {
    if (process.platform === 'darwin') {
      run('/usr/bin/security', ['delete-generic-password', '-a', key, '-s', SERVICE]);
    } else if (process.platform === 'linux') {
      run('secret-tool', ['clear', 'service', SERVICE, 'key', key]);
    }
  } catch {
    return false;
  }
  return true;
}

export function readJsonCredential(key, fallback) {
  const value = readCredential(key, true);
  return value ? JSON.parse(value) : fallback;
}

export function storeJsonCredential(key, value) {
  storeCredential(key, JSON.stringify(value));
}
