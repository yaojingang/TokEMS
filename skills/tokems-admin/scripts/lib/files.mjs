import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { decryptJson, encryptJson, sha256 } from './crypto.mjs';

export function stateRoot() {
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'TokEMS Admin Skill')
    : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'tokems-admin');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function requireUuid(value, label = 'identifier') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    const error = new Error(`TokEMS ${label} must be a UUID`);
    error.code = 'INVALID_IDENTIFIER';
    throw error;
  }
  return value;
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicWrite(path, value) {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function saveJson(name, value) {
  const path = join(stateRoot(), name);
  await atomicWrite(path, JSON.stringify(value, null, 2));
  return path;
}

export async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(join(stateRoot(), name), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function savePending(operationId, connectionId, value, dataKey) {
  requireUuid(operationId, 'operation identifier');
  requireUuid(connectionId, 'connection identifier');
  const envelope = encryptJson(value, dataKey, `tokems:${connectionId}:${operationId}:v1`);
  return saveJson(join('pending', `${operationId}.json`), {
    connectionId,
    operationId,
    createdAt: new Date().toISOString(),
    envelope,
  });
}

export async function readPending(operationId, connectionId, dataKey) {
  requireUuid(operationId, 'operation identifier');
  requireUuid(connectionId, 'connection identifier');
  const stored = await readJson(join('pending', `${operationId}.json`));
  if (!stored || stored.connectionId !== connectionId) {
    const error = new Error('Encrypted pending operation was not found for this connection');
    error.code = 'PENDING_OPERATION_NOT_FOUND';
    throw error;
  }
  return decryptJson(stored.envelope, dataKey, `tokems:${connectionId}:${operationId}:v1`);
}

export async function deletePending(operationId) {
  requireUuid(operationId, 'operation identifier');
  await rm(join(stateRoot(), 'pending', `${operationId}.json`), { force: true });
}

export async function savePendingArtifact(operationId, connectionId, bytes, dataKey, contentType) {
  requireUuid(operationId, 'operation identifier');
  requireUuid(connectionId, 'connection identifier');
  const value = {
    contentType: contentType || 'application/octet-stream',
    data: Buffer.from(bytes).toString('base64'),
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
  const envelope = encryptJson(value, dataKey, `tokems:${connectionId}:${operationId}:artifact:v1`);
  await saveJson(join('artifacts', `${operationId}.json`), {
    connectionId,
    operationId,
    createdAt: new Date().toISOString(),
    envelope,
  });
  return { available: true, size: value.size, sha256: value.sha256 };
}

export async function downloadPendingArtifact(operationId, connectionId, outputPath, dataKey) {
  requireUuid(operationId, 'operation identifier');
  requireUuid(connectionId, 'connection identifier');
  const stored = await readJson(join('artifacts', `${operationId}.json`));
  if (!stored || stored.connectionId !== connectionId) {
    const error = new Error('Encrypted operation artifact was not found for this connection');
    error.code = 'ARTIFACT_NOT_FOUND';
    throw error;
  }
  const value = decryptJson(
    stored.envelope,
    dataKey,
    `tokems:${connectionId}:${operationId}:artifact:v1`,
  );
  const artifact = await writeArtifact(outputPath, Buffer.from(value.data, 'base64'));
  if (artifact.sha256 !== value.sha256 || artifact.size !== value.size) {
    await rm(outputPath, { force: true });
    const error = new Error('Downloaded artifact did not match its encrypted digest');
    error.code = 'ARTIFACT_DIGEST_MISMATCH';
    throw error;
  }
  await rm(join(stateRoot(), 'artifacts', `${operationId}.json`), { force: true });
  return { ...artifact, contentType: value.contentType };
}

export async function cleanupExpiredPending(maxAgeMs = 24 * 60 * 60_000) {
  let deleted = 0;
  for (const collection of ['pending', 'artifacts']) {
    const directory = join(stateRoot(), collection);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(directory, entry.name);
      const metadata = await stat(path);
      if (Date.now() - metadata.mtimeMs <= maxAgeMs) continue;
      await rm(path, { force: true });
      deleted += 1;
    }
  }
  return { deleted };
}

export async function writeArtifact(path, bytes) {
  if (!isAbsolute(path)) {
    const error = new Error('Artifact output path must be absolute');
    error.code = 'INVALID_OUTPUT_PATH';
    throw error;
  }
  await ensureDirectory(dirname(path));
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(path, 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const conflict = new Error('Artifact output path already exists');
      conflict.code = 'OUTPUT_PATH_EXISTS';
      throw conflict;
    }
    throw error;
  }
  const metadata = await stat(path);
  return { path, size: metadata.size, sha256: sha256(bytes), mode: '0600' };
}

export async function withLocalLock(name, callback) {
  requireUuid(name, 'connection identifier');
  const lockPath = join(stateRoot(), 'locks', `${name}.lock`);
  await ensureDirectory(dirname(lockPath));
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        'utf8',
      );
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const [owner, metadata] = await Promise.all([
          readFile(lockPath, 'utf8').then(JSON.parse),
          stat(lockPath),
        ]);
        if (Date.now() - metadata.mtimeMs > 10 * 60_000 && Number.isSafeInteger(owner.pid)) {
          try {
            process.kill(owner.pid, 0);
          } catch (processError) {
            stale = processError?.code === 'ESRCH';
          }
        }
      } catch {
        stale = false;
      }
      if (stale && attempt === 0) {
        await rm(lockPath, { force: true });
        continue;
      }
      const conflict = new Error('Another TokEMS Admin process is using this connection');
      conflict.code = 'LOCAL_CONNECTION_BUSY';
      throw conflict;
    }
  }
  if (!handle) throw new Error('TokEMS Admin connection lock could not be acquired');
  try {
    return await callback();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}
