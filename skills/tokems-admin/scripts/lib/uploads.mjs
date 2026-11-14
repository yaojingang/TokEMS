import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadProfile } from './auth.mjs';
import { operationStatus, prepareOperation } from './operations.mjs';
import { readPendingArtifact } from './files.mjs';
import { normalizeOrigin } from './http.mjs';
import { sha256 } from './crypto.mjs';

export async function uploadFileBytes(path, limit = 10 * 1024 * 1024) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error('Upload file size is invalid');
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error('Upload file changed while reading');
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export function validateUploadGrant(grant, origins, digest, size) {
  const url = new URL(grant.uploadUrl);
  const origin = normalizeOrigin(url.origin);
  if (!origins?.includes(origin) || url.username || url.password || url.hash ||
    grant.method !== 'PUT' || new Date(grant.expiresAt).getTime() <= Date.now() ||
    !Number.isFinite(new Date(grant.expiresAt).getTime()) ||
    grant.contentDigest !== digest || grant.size !== size) {
    throw new Error('Signed upload does not match the approved origin, file, or expiry');
  }
  const headers = grant.headers ?? {};
  if (Object.keys(headers).some((key) => !['content-type', 'if-none-match'].includes(key.toLowerCase()))) {
    throw new Error('Signed upload contains unsupported headers');
  }
  return { url: url.toString(), headers };
}

export async function prepareAsset({ file, mediaType, altText, reasonFile, connectionId }) {
  const bytes = await uploadFileBytes(file);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) throw new Error('Unsupported asset media type');
  return prepareOperation({ actionId: 'templates.assets.upload.prepare', params: {},
    input: { fileName: basename(file), mediaType, altText, size: bytes.length, contentDigest: sha256(bytes) },
    reasonFile, connectionId });
}

export async function uploadPreparedFile({ operationId, file, reasonFile, connectionId }) {
  const profile = loadProfile(connectionId);
  const operation = await operationStatus(operationId, connectionId);
  if (operation.status !== 'succeeded' ||
    !['templates.assets.upload.prepare', 'templates.html-imports.prepare'].includes(operation.actionId)) {
    throw new Error('Upload requires a successfully executed upload reservation');
  }
  const artifact = await readPendingArtifact(operationId, profile.connectionId, profile.dataKey);
  const metadata = JSON.parse(artifact.bytes.toString('utf8'));
  const grant = metadata.upload ?? metadata;
  const bytes = await uploadFileBytes(file, metadata.upload ? 5 * 1024 * 1024 : undefined);
  const digest = sha256(bytes);
  const validated = validateUploadGrant(grant, profile.uploadOrigins, digest, bytes.length);
  let response;
  try {
    response = await fetch(validated.url, { method: 'PUT', headers: validated.headers,
      body: bytes, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new Error('Upload result is unknown; inspect the reservation before retrying');
  }
  if (!response.ok && response.status !== 412) throw new Error(`Upload failed (${response.status})`);
  await response.body?.cancel();
  const prepared = metadata.upload
    ? await prepareOperation({ actionId: 'templates.html-imports.scan', params: { importId: metadata.import.id },
      input: {}, reasonFile, connectionId })
    : await prepareOperation({ actionId: 'templates.assets.create', params: {},
      input: { storageKey: metadata.storageKey, mediaType: metadata.mediaType,
        altText: metadata.altText, size: bytes.length, contentDigest: digest }, reasonFile, connectionId });
  return { ...prepared, upload: { size: bytes.length, sha256: digest,
    status: response.status === 412 ? 'already-present-awaiting-server-validation' : 'uploaded' } };
}
