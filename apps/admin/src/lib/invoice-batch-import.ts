import { InvoiceBatchPreflightSchema, type InvoiceBatchManifestItem } from '@conference/contracts';

const MAX_ENTRY_SIZE = 20 * 1024 * 1024;
const MAX_ARCHIVE_SIZE = 220 * 1024 * 1024;
const MAX_ENTRY_COUNT = 1_001;
const MAX_COMPRESSION_RATIO = 200;

export interface InvoiceBatchArchive {
  items: InvoiceBatchManifestItem[];
  files: Map<string, Uint8Array>;
}

function readCsvRows(source: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell.replace(/\r$/, ''));
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  if (quoted) throw new Error('manifest.csv 存在未闭合的引号');
  row.push(cell.replace(/\r$/, ''));
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function hexDigest(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

export async function parseInvoiceManifestCsv(
  source: string,
  files: Map<string, Uint8Array>,
): Promise<InvoiceBatchManifestItem[]> {
  const rows = readCsvRows(source.replace(/^\uFEFF/, ''));
  const header = rows.shift()?.map((value) => value.trim()) ?? [];
  const required = ['request_no', 'invoice_number', 'invoice_code', 'upload_file'] as const;
  const indexes = Object.fromEntries(required.map((key) => [key, header.indexOf(key)])) as Record<
    (typeof required)[number],
    number
  >;
  const missing = required.filter((key) => indexes[key] < 0);
  if (missing.length) throw new Error(`manifest.csv 缺少字段：${missing.join('、')}`);
  if (!rows.length) throw new Error('manifest.csv 没有可导入的数据');

  const items = await Promise.all(
    rows.map(async (row, index) => {
      const requestNo = String(row[indexes.request_no] ?? '').trim();
      const invoiceNumber = String(row[indexes.invoice_number] ?? '').trim();
      const invoiceCode = String(row[indexes.invoice_code] ?? '').trim();
      const uploadFile = String(row[indexes.upload_file] ?? '')
        .trim()
        .replaceAll('\\', '/');
      const bytes = files.get(uploadFile);
      if (!bytes) throw new Error(`第 ${index + 2} 行找不到文件 ${uploadFile || '（空）'}`);
      const lowerName = uploadFile.toLowerCase();
      const mediaType = lowerName.endsWith('.ofd') ? 'application/ofd' : 'application/pdf';
      if (
        mediaType === 'application/pdf' &&
        new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-'
      ) {
        throw new Error(`${uploadFile} 的内容不是有效 PDF`);
      }
      if (mediaType === 'application/ofd' && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
        throw new Error(`${uploadFile} 的内容不是有效 OFD`);
      }
      return {
        requestNo,
        invoiceNumber,
        invoiceCode,
        uploadFile,
        mediaType,
        size: bytes.byteLength,
        contentDigest: hexDigest(
          await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer),
        ),
      } satisfies InvoiceBatchManifestItem;
    }),
  );
  return InvoiceBatchPreflightSchema.parse({ items }).items;
}

async function inflateRaw(bytes: Uint8Array, expectedSize: number) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 ZIP 解压，请升级浏览器后重试');
  }
  const stream = new Blob([bytes.slice().buffer])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > expectedSize || totalSize > MAX_ENTRY_SIZE) {
        await reader.cancel();
        throw new Error('ZIP 条目的实际解压数据超过声明大小');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function safeArchivePath(value: string) {
  const normalized = value.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`ZIP 包含不安全路径：${value}`);
  }
  return normalized;
}

export async function readInvoiceBatchZip(file: File): Promise<InvoiceBatchArchive> {
  if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('请选择 ZIP 批量导入包');
  if (file.size > MAX_ARCHIVE_SIZE) throw new Error('ZIP 批量导入包不能超过 220 MB');
  const archive = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let eocd = -1;
  for (
    let offset = archive.length - 22;
    offset >= Math.max(0, archive.length - 65_557);
    offset -= 1
  ) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    const diskNumber = view.getUint16(offset + 4, true);
    const centralDiskNumber = view.getUint16(offset + 6, true);
    const diskEntryCount = view.getUint16(offset + 8, true);
    const entryCount = view.getUint16(offset + 10, true);
    const centralSize = view.getUint32(offset + 12, true);
    const centralOffset = view.getUint32(offset + 16, true);
    if (
      offset + 22 + commentLength === archive.length &&
      diskNumber === 0 &&
      centralDiskNumber === 0 &&
      diskEntryCount === entryCount &&
      centralOffset + centralSize === offset
    ) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 中央目录损坏或使用了暂不支持的 ZIP64 格式');
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDiskNumber = view.getUint16(eocd + 6, true);
  const diskEntryCount = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    diskNumber !== 0 ||
    centralDiskNumber !== 0 ||
    diskEntryCount !== entryCount ||
    centralOffset + centralSize !== eocd
  ) {
    throw new Error('暂不支持分卷 ZIP 或 ZIP64 格式');
  }
  if (!entryCount || entryCount > MAX_ENTRY_COUNT) {
    throw new Error(`ZIP 文件数量需在 1 到 ${MAX_ENTRY_COUNT} 之间`);
  }

  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('ZIP 中央目录条目损坏');
    }
    const method = view.getUint16(offset + 10, true);
    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const versionMadeBy = view.getUint16(offset + 4, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > eocd) throw new Error('ZIP 中央目录条目越界');
    const name = safeArchivePath(
      decoder.decode(archive.slice(offset + 46, offset + 46 + nameLength)),
    );
    offset = entryEnd;
    if (name.endsWith('/')) continue;
    if (flags & 0x0001) throw new Error(`${name} 使用了暂不支持的加密 ZIP 条目`);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error(`${name} 使用了暂不支持的 ZIP64 条目`);
    }
    const madeByHost = versionMadeBy >> 8;
    const unixMode = externalAttributes >>> 16;
    if (madeByHost === 3 && (unixMode & 0o170000) === 0o120000) {
      throw new Error(`${name} 不能是符号链接`);
    }
    if (name !== 'manifest.csv' && !/^files\/[A-Za-z0-9._-]+\.(?:pdf|ofd)$/iu.test(name)) {
      throw new Error(`ZIP 包含未声明目录中的文件：${name}`);
    }
    if (files.has(name)) throw new Error(`ZIP 包含重复文件：${name}`);
    if (uncompressedSize > MAX_ENTRY_SIZE) throw new Error(`${name} 超过 20 MB`);
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO)
    ) {
      throw new Error(`${name} 的压缩比超过安全上限`);
    }
    totalSize += uncompressedSize;
    if (totalSize > MAX_ARCHIVE_SIZE) throw new Error('ZIP 解压后的文件总量不能超过 220 MB');
    if (localOffset + 30 > archive.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`${name} 的本地文件头损坏`);
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = safeArchivePath(
      decoder.decode(archive.slice(localOffset + 30, localOffset + 30 + localNameLength)),
    );
    if (localFlags !== flags || localMethod !== method || localName !== name) {
      throw new Error(`${name} 的中央目录与本地文件头不一致`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > centralOffset) throw new Error(`${name} 的压缩数据越界`);
    const compressed = archive.slice(dataStart, dataStart + compressedSize);
    const bytes =
      method === 0
        ? compressed
        : method === 8
          ? await inflateRaw(compressed, uncompressedSize)
          : null;
    if (!bytes) throw new Error(`${name} 使用了暂不支持的 ZIP 压缩算法`);
    if (bytes.byteLength !== uncompressedSize) throw new Error(`${name} 解压后大小不一致`);
    if (name === 'manifest.csv' || name.startsWith('files/')) files.set(name, bytes);
  }
  if (offset !== eocd) throw new Error('ZIP 中央目录长度与条目不一致');
  const manifest = files.get('manifest.csv');
  if (!manifest) throw new Error('ZIP 根目录缺少 manifest.csv');
  const items = await parseInvoiceManifestCsv(decoder.decode(manifest), files);
  return { items, files };
}
