import { Readable, Transform, pipeline } from 'node:stream';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  invoiceDocumentAccessLinks,
  auditLogs,
  invoiceSmsScope,
  invoiceFileIdentity,
  invoiceTokenHash,
  invoiceRefundPending,
  InvoiceSmsError,
} from '@conference/database';
import { DatabaseService } from './database.service.js';

export const INVOICE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export function invoiceSamplePdf() {
  const stream =
    'BT /F1 18 Tf 50 740 Td (TokEMS invoice SMS test) Tj 0 -30 Td (Sample only - no customer or invoice data.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
export function invoiceByteRange(value: string | undefined, size: number) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new InvoiceSmsError('请求的文件范围无效', 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new InvoiceSmsError('请求的文件范围无效', 416);
  return { start, end };
}
function internalObjectUrl(storageKey: string) {
  const endpoint = process.env.S3_ENDPOINT,
    accessKey = process.env.S3_ACCESS_KEY,
    secret = process.env.S3_SECRET_KEY,
    bucket = process.env.S3_BUCKET;
  if (!endpoint || !accessKey || !secret || !bucket)
    throw new InvoiceSmsError('发票文件暂时无法读取', 503);
  const base = new URL(endpoint),
    region = process.env.S3_REGION ?? 'us-east-1';
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
    day = date.slice(0, 8);
  const path = `${base.pathname.replace(/\/$/, '')}/${bucket}/${storageKey}`
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  const scope = `${day}/${region}/s3/aws4_request`;
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': '60',
    'X-Amz-SignedHeaders': 'host',
  });
  query.sort();
  const request = [
    'GET',
    path,
    query.toString(),
    `host:${base.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const hmac = (key: string | Buffer, text: string) =>
    createHmac('sha256', key).update(text).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
  query.set(
    'X-Amz-Signature',
    hmac(
      key,
      `AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash('sha256').update(request).digest('hex')}`,
    ).toString('hex'),
  );
  return `${base.origin}${path}?${query}`;
}

@Injectable()
export class InvoiceFileService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async resolve(token: string) {
    if (!/^[A-Za-z][A-Za-z0-9]{23}$/.test(token))
      throw new InvoiceSmsError('领取链接已失效，请在订单中重新获取', 404);
    const db = this.database.db;
    if (!db) throw new InvoiceSmsError('文件服务暂时不可用', 503);
    const [link] = await db
      .select()
      .from(invoiceDocumentAccessLinks)
      .where(
        and(
          eq(invoiceDocumentAccessLinks.tokenHash, invoiceTokenHash(token)),
          isNull(invoiceDocumentAccessLinks.revokedAt),
          gt(invoiceDocumentAccessLinks.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!link) throw new InvoiceSmsError('领取链接已失效，请在订单中重新获取', 404);
    if (link.purpose === 'test')
      return {
        link,
        document: null,
        size: invoiceSamplePdf().length,
        mediaType: 'application/pdf',
      };
    if (!link.invoiceRequestId) throw new InvoiceSmsError('领取链接已失效', 404);
    if (link.purpose !== 'invoice' && link.purpose !== 'account')
      throw new InvoiceSmsError('领取链接已失效', 404);
    const scope = await invoiceSmsScope(db, link.invoiceRequestId);
    if (
      !scope.document ||
      scope.invoice.status !== 'issued' ||
      scope.invoice.organizationId !== link.organizationId ||
      scope.order.organizationId !== link.organizationId ||
      scope.event.organizationId !== link.organizationId ||
      scope.invoice.orderId !== link.orderId ||
      scope.invoice.eventId !== link.eventId ||
      scope.order.eventId !== link.eventId ||
      scope.document.id !== link.invoiceDocumentId ||
      invoiceFileIdentity(scope.document) !== link.documentIdentity
    )
      throw new InvoiceSmsError('领取链接已失效，请在订单中查看最新发票', 404);
    if (await invoiceRefundPending(db, scope.order.id))
      throw new InvoiceSmsError('发票正在处理中，请稍后查看', 409);
    if (scope.document.size <= 0 || scope.document.size > INVOICE_FILE_MAX_BYTES)
      throw new InvoiceSmsError('发票文件暂时无法读取', 503);
    return {
      link,
      document: scope.document,
      size: scope.document.size,
      mediaType: scope.document.mediaType,
    };
  }
  async recordAccess(
    link: typeof invoiceDocumentAccessLinks.$inferSelect,
    result: 'opened' | 'partial' | 'interrupted' | 'metadata',
  ) {
    await this.database.db!.insert(auditLogs).values({
      organizationId: link.organizationId,
      eventId: link.eventId,
      actorType: 'anonymous',
      action: 'invoice.file.access',
      resourceType: 'invoice_document_access_link',
      resourceId: link.id,
      after: { invoiceId: link.invoiceRequestId, documentId: link.invoiceDocumentId, result },
      traceId: randomUUID(),
    });
  }
  async read(
    token: string,
    signal: AbortSignal,
    range: { start: number; end: number } | null = null,
  ) {
    const source = await this.resolve(token);
    if (!source.document) {
      const bytes = invoiceSamplePdf();
      return {
        ...source,
        stream: Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]),
      };
    }
    let response: Response;
    const expectedLength = range ? range.end - range.start + 1 : source.size;
    try {
      response = await fetch(internalObjectUrl(source.document.storageKey), {
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}),
      });
      if (
        response.status !== (range ? 206 : 200) ||
        !response.body ||
        Number(response.headers.get('content-length')) !== expectedLength ||
        (range &&
          response.headers.get('content-range') !==
            `bytes ${range.start}-${range.end}/${source.size}`)
      ) {
        await response.body?.cancel();
        throw new Error('storage response');
      }
      try {
        await this.resolve(token);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
    } catch (error) {
      if (error instanceof InvoiceSmsError) throw error;
      throw new InvoiceSmsError('发票文件暂时无法读取，请稍后重试', 503);
    }
    // Upload registration already verifies the digest and uses immutable object keys.
    // Range responses reuse that identity; full streams also verify integrity while flowing.
    const digest = range ? null : createHash('sha256');
    const expectedDigest = source.document.contentDigest.toLowerCase();
    let length = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        length += chunk.length;
        if (length > expectedLength) {
          callback(new Error('Invoice stream exceeds declared size'));
          return;
        }
        digest?.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        callback(
          length !== expectedLength || (digest && digest.digest('hex') !== expectedDigest)
            ? new Error('Invoice stream integrity check failed')
            : null,
        );
      },
    });
    const input = Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0]);
    pipeline(input, guard, () => {
      /* The HTTP stream reports a safe error without the storage URL. */
    });
    return { ...source, stream: guard };
  }
}
