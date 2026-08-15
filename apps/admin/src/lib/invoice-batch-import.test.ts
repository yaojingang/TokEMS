import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { parseInvoiceManifestCsv, readInvoiceBatchZip } from './invoice-batch-import';

interface ZipEntry {
  name: string;
  content: string;
  method?: 0 | 8;
  flags?: number;
  declaredSize?: number;
}

function makeZip(entries: ZipEntry[], comment = new Uint8Array()) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const { name, content } = entry;
    const nameBytes = encoder.encode(name);
    const contentBytes = encoder.encode(content);
    const compressedBytes =
      entry.method === 8 ? new Uint8Array(deflateRawSync(contentBytes)) : contentBytes;
    const declaredSize = entry.declaredSize ?? contentBytes.length;
    const local = new Uint8Array(30 + nameBytes.length + compressedBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, entry.flags ?? 0, true);
    localView.setUint16(8, entry.method ?? 0, true);
    localView.setUint32(18, compressedBytes.length, true);
    localView.setUint32(22, declaredSize, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(compressedBytes, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, entry.flags ?? 0, true);
    centralView.setUint16(10, entry.method ?? 0, true);
    centralView.setUint32(20, compressedBytes.length, true);
    centralView.setUint32(24, declaredSize, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22 + comment.length);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, localOffset, true);
  eocdView.setUint16(20, comment.length, true);
  eocd.set(comment, 22);
  const parts = [...localParts, ...centralParts, eocd];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return {
    name: 'invoices.zip',
    size: bytes.length,
    arrayBuffer: async () => bytes.slice().buffer,
  } as File;
}

function storedZip(entries: Array<[string, string]>, comment = new Uint8Array()) {
  return makeZip(
    entries.map(([name, content]) => ({ name, content })),
    comment,
  );
}

describe('invoice batch manifest parsing', () => {
  it('matches a quoted manifest row to its PDF file', async () => {
    const files = new Map([
      ['files/INV2026ABC001.pdf', new TextEncoder().encode('%PDF-1.7\ninvoice')],
    ]);
    const items = await parseInvoiceManifestCsv(
      [
        'request_no,invoice_number,invoice_code,upload_file',
        'INV2026ABC001,"254012345678",044002500111,files/INV2026ABC001.pdf',
      ].join('\n'),
      files,
    );

    expect(items[0]).toMatchObject({
      requestNo: 'INV2026ABC001',
      invoiceNumber: '254012345678',
      mediaType: 'application/pdf',
      size: files.get('files/INV2026ABC001.pdf')?.byteLength,
    });
  });

  it('reads a stored ZIP when its comment contains an EOCD-like signature', async () => {
    const misleadingComment = new Uint8Array(22);
    new DataView(misleadingComment.buffer).setUint32(0, 0x06054b50, true);
    const archive = await readInvoiceBatchZip(
      storedZip(
        [
          [
            'manifest.csv',
            'request_no,invoice_number,invoice_code,upload_file\nINV2026ABC001,254012345678,,files/INV2026ABC001.pdf',
          ],
          ['files/INV2026ABC001.pdf', '%PDF-1.7\ninvoice'],
        ],
        misleadingComment,
      ),
    );

    expect(archive.items).toHaveLength(1);
    expect(archive.files.has('files/INV2026ABC001.pdf')).toBe(true);
  });

  it('stops decompression when actual output exceeds the declared entry size', async () => {
    const archive = makeZip([
      {
        name: 'files/bomb.pdf',
        content: `%PDF-${'A'.repeat(2 * 1024 * 1024)}`,
        method: 8,
        declaredSize: 1024,
      },
    ]);

    await expect(readInvoiceBatchZip(archive)).rejects.toThrow(
      'ZIP 条目的实际解压数据超过声明大小',
    );
  });

  it('rejects encrypted entries and unexpected root files', async () => {
    await expect(
      readInvoiceBatchZip(makeZip([{ name: 'manifest.csv', content: 'x', flags: 1 }])),
    ).rejects.toThrow('加密 ZIP 条目');
    await expect(readInvoiceBatchZip(storedZip([['notes.txt', 'unexpected']]))).rejects.toThrow(
      '未声明目录中的文件',
    );
  });
});
