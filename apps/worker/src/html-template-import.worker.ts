import { createHash, createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { UnrecoverableError, type Job } from 'bullmq';
import {
  auditLogs,
  outboxEvents,
  templateAssetUploadReservations,
  templateAssets,
  templateHtmlImportAssets,
  templateHtmlImports,
  type ConferenceDatabase,
} from '@conference/database';
import {
  rewriteHtmlTemplateResources,
  isForbiddenNetworkAddress,
  sanitizeHtmlTemplate,
  sha256Digest,
  templateAssetIdFromUrl,
  type HtmlTemplateResourceReplacement,
  type HtmlTemplateSecurityReport,
} from '@conference/html-template';
import { and, count, eq, inArray, isNull, lt, ne, or, sql, sum } from 'drizzle-orm';
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from 'undici';

const MAX_ASSET_COUNT = 30;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_REDIRECTS = 3;
const DEFAULT_ORG_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_ORG_ASSET_COUNT = 10_000;
const MAX_SCAN_DURATION_MS = 2 * 60_000;

type ImportRow = typeof templateHtmlImports.$inferSelect;
type PersistedImportAsset = HtmlTemplateResourceReplacement & { staged: boolean };

class HtmlImportInputError extends Error {}

function objectStorageUrl(storageKey: string, method: 'GET' | 'PUT', mediaType?: string) {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  const bucket = process.env.S3_BUCKET;
  if (!endpoint || !accessKey || !secretKey || !bucket) return null;
  const region = process.env.S3_REGION ?? 'us-east-1';
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  const day = date.slice(0, 8);
  const endpointUrl = new URL(endpoint);
  const encodedKey = storageKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const canonicalUri = `${endpointUrl.pathname.replace(/\/$/u, '')}/${encodeURIComponent(bucket)}/${encodedKey}`;
  const signedHeaders = mediaType
    ? method === 'PUT'
      ? 'content-type;host;if-none-match'
      : 'content-type;host'
    : method === 'PUT'
      ? 'host;if-none-match'
      : 'host';
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${day}/${region}/s3/aws4_request`,
    'X-Amz-Date': date,
    'X-Amz-Expires': '600',
    'X-Amz-SignedHeaders': signedHeaders,
  });
  params.sort();
  const canonicalHeaders = `${mediaType ? `content-type:${mediaType}\n` : ''}host:${endpointUrl.host}\n${method === 'PUT' ? 'if-none-match:*\n' : ''}`;
  const canonicalRequest = [
    method,
    canonicalUri,
    params.toString(),
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    `${day}/${region}/s3/aws4_request`,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const hmac = (key: Buffer | string, value: string) =>
    createHmac('sha256', key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'), 'aws4_request');
  params.set(
    'X-Amz-Signature',
    createHmac('sha256', signingKey).update(stringToSign).digest('hex'),
  );
  return `${endpointUrl.origin}${canonicalUri}?${params.toString()}`;
}

function redactUrl(value: string) {
  if (value.startsWith('data:')) return 'data:[content-redacted]';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 240);
  } catch {
    return value.split(/[?#]/u)[0]!.slice(0, 240);
  }
}

async function publicTarget(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new Error('外部资源必须使用无凭据的标准 HTTPS 地址');
  }
  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isForbiddenNetworkAddress(item.address))) {
    throw new Error('外部资源地址指向受保护网络，系统已拒绝下载');
  }
  const pinned = addresses[0]!;
  return { url, address: pinned.address, family: pinned.family as 4 | 6 };
}

async function readBody(
  response: Response | UndiciResponse,
  limit = MAX_ASSET_BYTES,
  sharedBudget?: { remaining: number },
) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) throw new Error('资源大小超过限制');
  if (!response.body) throw new Error('资源没有可读取的内容');
  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (sharedBudget) sharedBudget.remaining -= value.byteLength;
      if (total > limit || (sharedBudget?.remaining ?? 0) < 0) {
        await reader.cancel();
        throw new Error(
          (sharedBudget?.remaining ?? 0) < 0 ? '外部资源总量超过限制' : '资源大小超过限制',
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error('资源内容为空');
  return Buffer.concat(chunks, total);
}

function mediaType(bytes: Buffer, declared = '') {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 16 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  throw new Error(`外部资源格式 ${declared || '未知'} 不受支持`);
}

function dimensions(bytes: Buffer, type: string) {
  let width = 0;
  let height = 0;
  if (type === 'image/png' && bytes.length >= 24) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (type === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  } else if (type === 'image/webp' && bytes.length >= 30) {
    const format = bytes.subarray(12, 16).toString('ascii');
    if (format === 'VP8X') {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (format === 'VP8 ') {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (format === 'VP8L' && bytes.length >= 25) {
      const packed = bytes.readUInt32LE(21);
      width = (packed & 0x3fff) + 1;
      height = ((packed >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('图片尺寸无法识别或超过 4000 万像素');
  }
  return { width, height };
}

async function downloadRemote(
  value: string,
  deadline: number,
  budget: { remaining: number },
  redirects = 0,
): Promise<{ mediaType: string; bytes: Buffer }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('HTML 导入扫描超过 2 分钟时限');
  const target = await publicTarget(value);
  const dispatcher = new Agent({
    connect: {
      servername: target.url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    },
  });
  try {
    const response = await undiciFetch(target.url, {
      dispatcher,
      redirect: 'manual',
      headers: {
        Accept: 'image/png,image/jpeg,image/webp',
        'User-Agent': 'TokEMS-HTML-Template-Importer/1.0',
      },
      signal: AbortSignal.timeout(Math.min(20_000, Math.max(1, remaining))),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= MAX_REDIRECTS) throw new Error('外部资源重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new Error('外部资源重定向缺少目标地址');
      return downloadRemote(
        new URL(location, target.url).toString(),
        deadline,
        budget,
        redirects + 1,
      );
    }
    if (!response.ok) throw new Error(`外部资源下载失败（${response.status}）`);
    const bytes = await readBody(response, MAX_ASSET_BYTES, budget);
    const declared = (response.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    return { mediaType: mediaType(bytes, declared), bytes };
  } finally {
    await dispatcher.close();
  }
}

function decodeDataImage(value: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/iu.exec(value);
  if (!match?.[1] || !match[2]) throw new Error('仅支持 PNG、JPEG 和 WebP 格式的内联图片');
  const bytes = Buffer.from(match[2].replace(/\s+/gu, ''), 'base64');
  if (!bytes.length || bytes.byteLength > MAX_ASSET_BYTES)
    throw new Error('单个内联图片不能为空且不能超过 10 MiB');
  const actual = mediaType(bytes, match[1]);
  if (actual !== match[1].toLowerCase()) throw new Error('内联图片内容与声明格式不一致');
  return { mediaType: actual, bytes };
}

async function persistAsset(
  db: ConferenceDatabase,
  importId: string,
  scanLeaseToken: string,
  organizationId: string,
  actorId: string,
  sourceUrl: string,
  type: string,
  bytes: Buffer,
  deadline: number,
): Promise<PersistedImportAsset> {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const replacement = (
    asset: typeof templateAssets.$inferSelect,
    staged: boolean,
  ): PersistedImportAsset => ({
    sourceUrl,
    targetUrl: `/api/v1/assets/templates/${asset.id}`,
    assetId: asset.id,
    mediaType: asset.mediaType,
    size: asset.size,
    contentDigest: asset.contentDigest,
    staged,
  });
  const attach = async (
    tx: Parameters<Parameters<ConferenceDatabase['transaction']>[0]>[0],
    asset: typeof templateAssets.$inferSelect,
    staged: boolean,
  ) => {
    const [lease] = await tx
      .insert(templateHtmlImportAssets)
      .values({ importId, assetId: asset.id, organizationId, staged })
      .onConflictDoUpdate({
        target: [templateHtmlImportAssets.importId, templateHtmlImportAssets.assetId],
        set: {
          staged: sql`${templateHtmlImportAssets.staged} OR excluded.staged`,
          releasedAt: null,
        },
      })
      .returning({ staged: templateHtmlImportAssets.staged });
    return replacement(asset, lease?.staged === true);
  };
  const existingReplacement = await db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
    );
    const [activeImport] = await tx
      .select({ id: templateHtmlImports.id })
      .from(templateHtmlImports)
      .where(
        and(
          eq(templateHtmlImports.id, importId),
          eq(templateHtmlImports.organizationId, organizationId),
          eq(templateHtmlImports.status, 'scanning'),
          eq(templateHtmlImports.scanLeaseToken, scanLeaseToken),
        ),
      )
      .for('update')
      .limit(1);
    if (!activeImport) throw new Error('HTML 导入任务已停止，资源处理已终止');
    const [existing] = await tx
      .select()
      .from(templateAssets)
      .where(
        and(
          eq(templateAssets.organizationId, organizationId),
          eq(templateAssets.contentDigest, digest),
          eq(templateAssets.purpose, 'template'),
        ),
      )
      .limit(1);
    return existing ? attach(tx, existing, false) : null;
  });
  if (existingReplacement) {
    return existingReplacement;
  }
  const imageSize = dimensions(bytes, type);
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type];
  if (!extension) throw new Error(`资源格式 ${type} 不受支持`);
  const storageKey = `templates/${organizationId}/html-${digest}.${extension}`;
  const uploadUrl = objectStorageUrl(storageKey, 'PUT', type);
  if (!uploadUrl) throw new Error('对象存储尚未配置');
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
    );
    const [activeImport] = await tx
      .select({ id: templateHtmlImports.id })
      .from(templateHtmlImports)
      .where(
        and(
          eq(templateHtmlImports.id, importId),
          eq(templateHtmlImports.organizationId, organizationId),
          eq(templateHtmlImports.status, 'scanning'),
          eq(templateHtmlImports.scanLeaseToken, scanLeaseToken),
        ),
      )
      .for('update')
      .limit(1);
    if (!activeImport) throw new Error('HTML 导入任务已停止，资源处理已终止');
    const [existing] = await tx
      .select()
      .from(templateAssets)
      .where(
        and(
          eq(templateAssets.organizationId, organizationId),
          eq(templateAssets.contentDigest, digest),
          eq(templateAssets.purpose, 'template'),
        ),
      )
      .limit(1);
    if (existing) return attach(tx, existing, false);
    const [usage] = await tx
      .select({ value: count(), bytes: sum(templateAssets.size) })
      .from(templateAssets)
      .where(eq(templateAssets.organizationId, organizationId));
    const [reserved] = await tx
      .select({ value: count(), bytes: sum(templateAssetUploadReservations.size) })
      .from(templateAssetUploadReservations)
      .where(
        and(
          eq(templateAssetUploadReservations.organizationId, organizationId),
          isNull(templateAssetUploadReservations.consumedAssetId),
        ),
      );
    const maxBytes =
      Number(process.env.HTML_TEMPLATE_ORG_ASSET_BYTES ?? DEFAULT_ORG_ASSET_BYTES) ||
      DEFAULT_ORG_ASSET_BYTES;
    const maxCount =
      Number(process.env.HTML_TEMPLATE_ORG_ASSET_COUNT ?? DEFAULT_ORG_ASSET_COUNT) ||
      DEFAULT_ORG_ASSET_COUNT;
    if (
      Number(usage?.value ?? 0) + Number(reserved?.value ?? 0) >= maxCount ||
      Number(usage?.bytes ?? 0) + Number(reserved?.bytes ?? 0) + bytes.byteLength > maxBytes
    ) {
      throw new Error('组织模板资产容量已达上限，请清理不再使用的模板图片');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('HTML 导入扫描超过 2 分钟时限');
    const uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': type, 'If-None-Match': '*' },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(Math.min(20_000, Math.max(1, remaining))),
    });
    if (!uploaded.ok && uploaded.status !== 412) {
      throw new Error(`图片资源写入失败（${uploaded.status}）`);
    }
    const [created] = await tx
      .insert(templateAssets)
      .values({
        organizationId,
        storageKey,
        mediaType: type,
        size: bytes.byteLength,
        width: imageSize.width,
        height: imageSize.height,
        contentDigest: digest,
        altText: '',
        purpose: 'template',
        createdBy: actorId,
      })
      .returning();
    if (!created) throw new Error('图片资源登记失败');
    return attach(tx, created, true);
  });
}

async function resolveExistingInternalAssets(
  db: ConferenceDatabase,
  importId: string,
  scanLeaseToken: string,
  organizationId: string,
  urls: string[],
  report: HtmlTemplateSecurityReport,
): Promise<PersistedImportAsset[]> {
  const uniqueUrls = [...new Set(urls)];
  const candidates = uniqueUrls.map((url) => ({ url, assetId: templateAssetIdFromUrl(url) }));
  for (const candidate of candidates) {
    if (!candidate.assetId)
      report.blockers.push(`内部模板资产地址无效：${redactUrl(candidate.url)}`);
  }
  const assetIds = [
    ...new Set(candidates.flatMap((candidate) => (candidate.assetId ? [candidate.assetId] : []))),
  ];
  if (!assetIds.length) return [];
  const assets = await db
    .select()
    .from(templateAssets)
    .where(
      and(
        eq(templateAssets.organizationId, organizationId),
        eq(templateAssets.purpose, 'template'),
        inArray(templateAssets.id, assetIds),
      ),
    );
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const resolved = candidates.flatMap((candidate) => {
    if (!candidate.assetId) return [];
    const asset = assetMap.get(candidate.assetId);
    if (!asset) {
      report.blockers.push(`内部模板资产不存在或不属于当前组织：${candidate.assetId}`);
      return [];
    }
    return [
      {
        sourceUrl: candidate.url,
        targetUrl: candidate.url,
        assetId: asset.id,
        mediaType: asset.mediaType,
        size: asset.size,
        contentDigest: asset.contentDigest,
        staged: false,
      },
    ];
  });
  if (resolved.length) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
      );
      const [activeImport] = await tx
        .select({ id: templateHtmlImports.id })
        .from(templateHtmlImports)
        .where(
          and(
            eq(templateHtmlImports.id, importId),
            eq(templateHtmlImports.organizationId, organizationId),
            eq(templateHtmlImports.status, 'scanning'),
            eq(templateHtmlImports.scanLeaseToken, scanLeaseToken),
          ),
        )
        .for('update')
        .limit(1);
      if (!activeImport) throw new Error('HTML 导入任务已停止，资源处理已终止');
      await tx
        .insert(templateHtmlImportAssets)
        .values(
          resolved.map((item) => ({
            importId,
            assetId: item.assetId,
            organizationId,
            staged: false,
          })),
        )
        .onConflictDoUpdate({
          target: [templateHtmlImportAssets.importId, templateHtmlImportAssets.assetId],
          set: { releasedAt: null },
        });
    });
  }
  return resolved;
}

async function readSource(row: ImportRow, deadline: number) {
  const url = objectStorageUrl(row.sourceStorageKey, 'GET');
  if (!url || !row.sourceSize || !row.sourceDigest)
    throw new HtmlImportInputError('导入任务缺少对象存储或文件校验信息');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('HTML 导入扫描超过 2 分钟时限');
  const response = await fetch(url, {
    signal: AbortSignal.timeout(Math.min(20_000, Math.max(1, remaining))),
  });
  if (!response.ok) throw new Error('HTML 文件尚未上传成功');
  let bytes: Buffer;
  try {
    bytes = await readBody(response, row.sourceSize);
  } catch (error) {
    if (error instanceof Error && error.message === '资源大小超过限制') {
      throw new HtmlImportInputError('HTML 文件大小与登记信息不一致');
    }
    throw error;
  }
  if (bytes.byteLength !== row.sourceSize || sha256Digest(bytes) !== row.sourceDigest)
    throw new HtmlImportInputError('HTML 文件大小或摘要与登记信息不一致');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HtmlImportInputError('HTML 文件必须使用 UTF-8 编码');
  }
}

function storedReplacement(replacement?: HtmlTemplateResourceReplacement) {
  if (!replacement) return {};
  return {
    targetUrl: replacement.targetUrl,
    assetId: replacement.assetId,
    mediaType: replacement.mediaType,
    size: replacement.size,
    contentDigest: replacement.contentDigest,
    staged: 'staged' in replacement && replacement.staged === true,
  };
}

function mergeAssetManifest(
  existing: Array<Record<string, unknown>>,
  replacements: PersistedImportAsset[],
) {
  const merged = new Map<string, Record<string, unknown>>();
  for (const item of existing) {
    const assetId = typeof item.assetId === 'string' ? item.assetId : null;
    if (assetId) merged.set(assetId, item);
  }
  for (const replacement of replacements) {
    const next = storedReplacement(replacement);
    const previous = merged.get(replacement.assetId);
    merged.set(replacement.assetId, {
      ...previous,
      ...next,
      staged: previous?.staged === true || next.staged === true,
    });
  }
  return [...merged.values()];
}

export async function processHtmlTemplateImportScan(
  db: ConferenceDatabase,
  payload: Record<string, unknown>,
  job: Job<Record<string, unknown>>,
) {
  const importId = String(payload.importId ?? '');
  if (!importId) throw new Error('TemplateHtmlImportScanRequested is missing importId');
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const [candidate] = await db
    .select({
      id: templateHtmlImports.id,
      organizationId: templateHtmlImports.organizationId,
      status: templateHtmlImports.status,
      updatedAt: templateHtmlImports.updatedAt,
    })
    .from(templateHtmlImports)
    .where(eq(templateHtmlImports.id, importId))
    .limit(1);
  if (!candidate) return;
  if (candidate.status === 'scanning' && candidate.updatedAt >= staleBefore) {
    throw new Error('HTML 导入扫描租约仍在使用中');
  }
  if (!['queued', 'scanning'].includes(candidate.status)) return;
  const scanLeaseToken = randomUUID();
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`template-html-scan:${candidate.organizationId}`}, 0))`,
    );
    const [otherScan] = await tx
      .select({ id: templateHtmlImports.id })
      .from(templateHtmlImports)
      .where(
        and(
          eq(templateHtmlImports.organizationId, candidate.organizationId),
          eq(templateHtmlImports.status, 'scanning'),
          ne(templateHtmlImports.id, importId),
        ),
      )
      .limit(1);
    if (otherScan) return null;
    const [claimed] = await tx
      .update(templateHtmlImports)
      .set({
        status: 'scanning',
        scanLeaseToken,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(templateHtmlImports.id, importId),
          or(
            eq(templateHtmlImports.status, 'queued'),
            and(
              eq(templateHtmlImports.status, 'scanning'),
              lt(templateHtmlImports.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning();
    return claimed;
  });
  if (!row) {
    const finalAttempt = job.attemptsMade + 1 >= Number(job.opts.attempts ?? 1);
    if (finalAttempt) {
      await db
        .update(templateHtmlImports)
        .set({
          status: 'failed',
          errorCode: 'SCAN_QUEUE_TIMEOUT',
          errorMessage: '同一组织的扫描任务持续繁忙，请稍后重试',
          updatedAt: new Date(),
        })
        .where(and(eq(templateHtmlImports.id, importId), eq(templateHtmlImports.status, 'queued')));
    }
    throw new Error('同一组织已有 HTML 导入正在扫描');
  }
  const deadline = Date.now() + MAX_SCAN_DURATION_MS;
  const stagedReplacements: PersistedImportAsset[] = [];
  try {
    if (!row.createdBy) throw new Error('HTML 导入任务缺少创建人信息');
    const source = await readSource(row, deadline);
    let sanitized: ReturnType<typeof sanitizeHtmlTemplate>;
    try {
      sanitized = sanitizeHtmlTemplate(source);
    } catch (error) {
      throw new HtmlImportInputError(
        error instanceof Error ? error.message : 'HTML 文件结构无法解析',
      );
    }
    const report: HtmlTemplateSecurityReport = structuredClone(sanitized.securityReport);
    const replacements: PersistedImportAsset[] = [];
    const dataUrls = [
      ...new Set(
        sanitized.resourceManifest
          .filter((item) => item.url.startsWith('data:image/'))
          .map((item) => item.url),
      ),
    ];
    if (dataUrls.length > MAX_ASSET_COUNT)
      report.blockers.push(`内联图片数量不能超过 ${MAX_ASSET_COUNT} 个`);
    for (const url of dataUrls.slice(0, MAX_ASSET_COUNT)) {
      try {
        const decoded = decodeDataImage(url);
        const replacement = await persistAsset(
          db,
          row.id,
          scanLeaseToken,
          row.organizationId,
          row.createdBy,
          url,
          decoded.mediaType,
          decoded.bytes,
          deadline,
        );
        replacements.push(replacement);
        if (replacement.staged) stagedReplacements.push(replacement);
      } catch (error) {
        report.blockers.push(error instanceof Error ? error.message : '内联图片处理失败');
      }
    }
    let result = rewriteHtmlTemplateResources(sanitized, replacements);
    const existingInternalAssets = await resolveExistingInternalAssets(
      db,
      row.id,
      scanLeaseToken,
      row.organizationId,
      result.resourceManifest
        .filter((item) => item.url.startsWith('/api/v1/assets/templates/'))
        .map((item) => item.url),
      report,
    );
    const metadata = row.requestedMetadata as { sourceUrl?: string };
    let baseUrl: URL | undefined;
    if (metadata.sourceUrl) {
      try {
        baseUrl = (await publicTarget(metadata.sourceUrl)).url;
      } catch (error) {
        report.blockers.push(
          error instanceof Error ? `原页面地址不可用：${error.message}` : '原页面地址不可用',
        );
      }
    }
    const remoteUrls = [
      ...new Set(
        result.resourceManifest
          .filter(
            (item) =>
              !item.url.startsWith('/api/v1/assets/templates/') &&
              !item.url.startsWith('data:image/'),
          )
          .map((item) => item.url),
      ),
    ];
    if (remoteUrls.length > MAX_ASSET_COUNT)
      report.blockers.push(`外部资源数量不能超过 ${MAX_ASSET_COUNT} 个`);
    const downloadBudget = { remaining: MAX_TOTAL_BYTES };
    for (const rawUrl of remoteUrls.slice(0, MAX_ASSET_COUNT)) {
      if (downloadBudget.remaining <= 0 || Date.now() >= deadline) {
        report.blockers.push('外部资源总量或扫描时长已达上限，其余资源未下载');
        break;
      }
      try {
        const item = {
          rawUrl,
          ...(await downloadRemote(new URL(rawUrl, baseUrl).toString(), deadline, downloadBudget)),
        };
        const replacement = await persistAsset(
          db,
          row.id,
          scanLeaseToken,
          row.organizationId,
          row.createdBy,
          item.rawUrl,
          item.mediaType,
          item.bytes,
          deadline,
        );
        replacements.push(replacement);
        if (replacement.staged) stagedReplacements.push(replacement);
      } catch (error) {
        report.blockers.push(
          error instanceof Error
            ? `资源 ${redactUrl(rawUrl)}：${error.message}`
            : `资源 ${redactUrl(rawUrl)} 处理失败`,
        );
      }
    }
    if (replacements.length) {
      report.warnings.push(`已将 ${replacements.length} 个外部资源转存为组织私有模板资产`);
    }
    result = rewriteHtmlTemplateResources(sanitized, replacements);
    const unresolved = result.resourceManifest.filter(
      (item) => !item.url.startsWith('/api/v1/assets/templates/'),
    );
    result = rewriteHtmlTemplateResources(
      result,
      unresolved.map((item) => ({ sourceUrl: item.url, targetUrl: redactUrl(item.url) })),
    );
    if (unresolved.length)
      report.blockers.push(`仍有 ${unresolved.length} 个资源未能安全内化，请根据明细处理`);
    if (!unresolved.length)
      report.warnings = report.warnings.filter((warning) => !warning.includes('相对图片地址'));
    const needsReview =
      report.removedTags.length > 0 ||
      report.removedAttributes.length > 0 ||
      report.warnings.length > 0 ||
      report.blockers.length > 0;
    const completed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(templateHtmlImports)
        .set({
          status: needsReview ? 'needs_review' : 'ready',
          scanLeaseToken: null,
          sanitizedHtml: result.sanitizedHtml,
          sanitizedDigest: result.sanitizedDigest,
          nodeManifest: result.nodeManifest as unknown as Array<Record<string, unknown>>,
          assetManifest: result.resourceManifest.map((resource) => ({
            ...resource,
            ...storedReplacement(
              [...replacements, ...existingInternalAssets].find(
                (replacement) => replacement.targetUrl === resource.url,
              ),
            ),
          })) as unknown as Array<Record<string, unknown>>,
          securityReport: report as unknown as Record<string, unknown>,
          requestedMetadata: { ...row.requestedMetadata, extracted: result.metadata },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(templateHtmlImports.id, row.id),
            eq(templateHtmlImports.status, 'scanning'),
            eq(templateHtmlImports.scanLeaseToken, scanLeaseToken),
          ),
        )
        .returning({ id: templateHtmlImports.id });
      if (!updated) return false;
      await tx.insert(auditLogs).values({
        organizationId: row.organizationId,
        actorId: row.createdBy,
        action: 'template.html_import.scan',
        resourceType: 'template_html_import',
        resourceId: row.id,
        after: {
          sourceDigest: result.sourceDigest,
          sanitizedDigest: result.sanitizedDigest,
          removedTagCount: report.removedTags.length,
          blockerCount: report.blockers.length,
        },
        traceId: randomUUID(),
      });
      return true;
    });
    if (!completed && stagedReplacements.length) {
      await db.insert(outboxEvents).values({
        organizationId: row.organizationId,
        eventType: 'TemplateHtmlImportCleanupRequested',
        correlationId: `template-html-import-scan-race:${row.id}:${randomUUID()}`,
        payload: {
          importId: row.id,
          organizationId: row.organizationId,
          storageKey: row.sourceStorageKey,
          assetIds: stagedReplacements.map((replacement) => replacement.assetId),
        },
      });
    }
  } catch (error) {
    const finalAttempt =
      error instanceof HtmlImportInputError ||
      job.attemptsMade + 1 >= Number(job.opts.attempts ?? 1);
    const [updated] = await db
      .update(templateHtmlImports)
      .set({
        status: finalAttempt ? 'failed' : 'queued',
        scanLeaseToken: null,
        assetManifest: mergeAssetManifest(row.assetManifest, stagedReplacements),
        errorCode: finalAttempt ? 'SCAN_FAILED' : 'SCAN_RETRY',
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'HTML 扫描失败',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(templateHtmlImports.id, row.id),
          eq(templateHtmlImports.status, 'scanning'),
          eq(templateHtmlImports.scanLeaseToken, scanLeaseToken),
        ),
      )
      .returning({ id: templateHtmlImports.id });
    if (!updated && stagedReplacements.length) {
      await db.insert(outboxEvents).values({
        organizationId: row.organizationId,
        eventType: 'TemplateHtmlImportCleanupRequested',
        correlationId: `template-html-import-scan-failed-race:${row.id}:${randomUUID()}`,
        payload: {
          importId: row.id,
          organizationId: row.organizationId,
          storageKey: row.sourceStorageKey,
          assetIds: stagedReplacements.map((replacement) => replacement.assetId),
        },
      });
    }
    throw error instanceof HtmlImportInputError ? new UnrecoverableError(error.message) : error;
  }
}
