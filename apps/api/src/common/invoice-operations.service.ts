import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  CustomerInvoiceDetailSchema,
  isCustomerInvoiceEditableStatus,
  type CreateInvoiceDocument,
  type CustomerCreateInvoice,
  type CustomerInvoiceOrderContext,
  type CustomerInvoiceSendResult,
  type CustomerUpdateInvoice,
  type EventId,
  type InvoiceBuyer,
  type InvoiceAction,
  type InvoiceListQuery,
  type InvoiceRequest,
  type InvoiceRequestStatus,
  type InvoiceVersion,
  type RequestOrderAccessLink,
  type SubmitInvoiceDetails,
} from '@conference/contracts';
import {
  auditLogs,
  events,
  invoiceDocuments,
  invoiceExportJobs,
  invoiceRequests,
  invoiceStateLogs,
  orderAccessLinkAttempts,
  orderAccessTokens,
  orders,
  outboxEvents,
  refunds,
  registrations,
  users,
} from '@conference/database';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNull,
  lt,
  lte,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { customerInvoicePaymentEligibility } from './customer-invoice-policy.js';
import { DomainError } from './domain-error.js';
import { matchesDeclaredMediaType, readUploadWithinLimit } from './object-storage-verification.js';

type Database = NonNullable<DatabaseService['db']>;
type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type StoredInvoiceDocumentInput = Pick<
  CreateInvoiceDocument,
  'storageKey' | 'mediaType' | 'size' | 'contentDigest'
>;
type ReplaceInvoiceDocumentFileInput = StoredInvoiceDocumentInput & InvoiceAction;

const INVOICE_TRANSITIONS: Record<InvoiceRequestStatus, InvoiceRequestStatus[]> = {
  awaiting_details: ['pending_review', 'cancelled'],
  pending_review: ['issuing', 'rejected', 'cancelled'],
  rejected: ['pending_review', 'cancelled'],
  issuing: ['issued', 'issue_failed'],
  issue_failed: ['issuing', 'rejected', 'cancelled'],
  issued: ['adjustment_required', 'voided'],
  adjustment_required: ['voided'],
  voided: ['issuing'],
  cancelled: [],
};

const CUSTOMER_INVOICE_STATUS_COPY: Record<
  InvoiceRequestStatus,
  { label: string; description: string; tone: 'neutral' | 'info' | 'warning' | 'success' }
> = {
  awaiting_details: {
    label: '等待开票资料',
    description: '发票申请已经创建，请补充购买方资料后提交。',
    tone: 'info',
  },
  pending_review: {
    label: '资料已提交',
    description: '主办方正在审核本次开票资料。',
    tone: 'info',
  },
  issuing: {
    label: '发票开具中',
    description: '开票资料已通过审核，主办方正在开具电子发票。',
    tone: 'info',
  },
  issue_failed: {
    label: '开票处理中',
    description: '开票过程遇到异常，主办方正在处理。',
    tone: 'warning',
  },
  issued: {
    label: '发票已开具',
    description: '电子发票已经生成，可以在文件明细中下载。',
    tone: 'success',
  },
  rejected: {
    label: '资料需要修改',
    description: '主办方退回了本次开票资料。',
    tone: 'warning',
  },
  adjustment_required: {
    label: '退款调整中',
    description: '订单发生退款，主办方正在处理发票调整。',
    tone: 'warning',
  },
  voided: {
    label: '发票已作废',
    description: '当前电子发票已经作废，文件仅保留历史信息。',
    tone: 'neutral',
  },
  cancelled: {
    label: '申请已取消',
    description: '本次发票申请已经取消。',
    tone: 'neutral',
  },
};

export function allowedInvoiceTransitions(status: InvoiceRequestStatus) {
  return [...INVOICE_TRANSITIONS[status]];
}

export function canTransitionInvoice(from: InvoiceRequestStatus, to: InvoiceRequestStatus) {
  return INVOICE_TRANSITIONS[from].includes(to);
}

export const DEFAULT_ASYNC_INVOICE_EXPORT_THRESHOLD = 50_000;

export function invoiceExportRequiresWorker(
  rowCount: number,
  threshold = DEFAULT_ASYNC_INVOICE_EXPORT_THRESHOLD,
) {
  return rowCount >= threshold;
}

export function invoiceExportJobMatchesEvent(filters: Record<string, unknown>, eventId: EventId) {
  return Number(filters.eventId) === eventId;
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function buildInvoiceExportCsv(
  rows: Array<{
    requestNo: string;
    eventName: string;
    orderNo: string;
    title: string | null;
    amount: number;
    status: string;
    requestedAt: string;
  }>,
) {
  return [
    ['申请单号', '大会', '订单号', '发票抬头', '金额', '状态', '申请时间'],
    ...rows.map((row) => [
      row.requestNo,
      row.eventName,
      row.orderNo,
      row.title,
      row.amount,
      row.status,
      row.requestedAt,
    ]),
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\n');
}

function mask(value: string | null, visibleStart = 2, visibleEnd = 2) {
  if (!value) return null;
  if (value.length <= visibleStart + visibleEnd) return '*'.repeat(value.length);
  return `${value.slice(0, visibleStart)}${'*'.repeat(Math.min(8, value.length - visibleStart - visibleEnd))}${value.slice(-visibleEnd)}`;
}

@Injectable()
export class InvoiceOperationsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private db(): Database {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '发票管理需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private async scopedRequest(organizationId: string, invoiceId: string, eventId?: EventId) {
    const conditions = [
      eq(invoiceRequests.id, invoiceId),
      eq(invoiceRequests.organizationId, organizationId),
    ];
    if (eventId) conditions.push(eq(invoiceRequests.eventId, eventId));
    const [row] = await this.db()
      .select({
        invoice: invoiceRequests,
        eventName: events.name,
        orderNo: orders.orderNo,
        attendeeName: registrations.attendee,
      })
      .from(invoiceRequests)
      .innerJoin(events, eq(events.id, invoiceRequests.eventId))
      .innerJoin(orders, eq(orders.id, invoiceRequests.orderId))
      .innerJoin(registrations, eq(registrations.id, invoiceRequests.registrationId))
      .where(and(...conditions))
      .limit(1);
    if (!row) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '发票申请不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private tokenHash(rawToken: string) {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private auditFilters(query: InvoiceListQuery) {
    const { q, ...filters } = query;
    return {
      ...filters,
      ...(q ? { qHash: createHash('sha256').update(q).digest('hex') } : {}),
    };
  }

  private async orderToken(rawToken: string, orderId: string, requiredScope: string) {
    const [token] = await this.db()
      .select()
      .from(orderAccessTokens)
      .where(
        and(
          eq(orderAccessTokens.orderId, orderId),
          eq(orderAccessTokens.tokenHash, this.tokenHash(rawToken)),
          isNull(orderAccessTokens.revokedAt),
        ),
      )
      .limit(1);
    if (!token || token.expiresAt <= new Date() || !token.scopes.includes(requiredScope)) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '订单访问链接无效或已经过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.db()
      .update(orderAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(orderAccessTokens.id, token.id));
    return token;
  }

  private downloadSignature(orderId: string, documentId: string, expires: number) {
    const secret =
      process.env.INVOICE_DOWNLOAD_SIGNING_SECRET ??
      process.env.JWT_SECRET ??
      'conference-invoice-download-development-secret';
    return createHmac('sha256', secret).update(`${orderId}.${documentId}.${expires}`).digest('hex');
  }

  private exportSignature(
    organizationId: string,
    eventId: EventId,
    exportJobId: string,
    expires: number,
  ) {
    const secret =
      process.env.INVOICE_DOWNLOAD_SIGNING_SECRET ??
      process.env.JWT_SECRET ??
      'conference-invoice-download-development-secret';
    return createHmac('sha256', secret)
      .update(`${organizationId}.${eventId}.${exportJobId}.${expires}`)
      .digest('hex');
  }

  private s3Presigned(
    storageKey: string,
    method: 'GET' | 'PUT',
    mediaType?: string,
    endpointOverride?: string,
  ) {
    const endpoint = endpointOverride ?? process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT;
    const accessKey = process.env.S3_ACCESS_KEY;
    const secretKey = process.env.S3_SECRET_KEY;
    const bucket = process.env.S3_BUCKET;
    if (!endpoint || !accessKey || !secretKey || !bucket) return null;
    const region = process.env.S3_REGION ?? 'us-east-1';
    const now = new Date();
    const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const endpointUrl = new URL(endpoint);
    const encodePath = (value: string) =>
      value
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    const canonicalUri = `${endpointUrl.pathname.replace(/\/$/, '')}/${encodePath(bucket)}/${encodePath(storageKey)}`;
    const credential = `${accessKey}/${day}/${region}/s3/aws4_request`;
    const signedHeaders = mediaType
      ? method === 'PUT'
        ? 'content-type;host;if-none-match'
        : 'content-type;host'
      : method === 'PUT'
        ? 'host;if-none-match'
        : 'host';
    const params = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': credential,
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
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'),
      'aws4_request',
    );
    params.set(
      'X-Amz-Signature',
      createHmac('sha256', signingKey).update(stringToSign).digest('hex'),
    );
    return `${endpointUrl.origin}${canonicalUri}?${params.toString()}`;
  }

  private async assertStoredDocument(
    organizationId: string,
    invoiceId: string,
    input: StoredInvoiceDocumentInput,
    eventId?: EventId,
  ) {
    await this.scopedRequest(organizationId, invoiceId, eventId);
    const expectedPrefix = `invoices/${organizationId}/`;
    if (
      !input.storageKey.startsWith(expectedPrefix) ||
      !input.storageKey.includes(`/${invoiceId}/`)
    ) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '发票文件不属于当前组织或申请',
        HttpStatus.BAD_REQUEST,
      );
    }
    const internalUrl = this.s3Presigned(
      input.storageKey,
      'GET',
      undefined,
      process.env.S3_ENDPOINT,
    );
    if (!internalUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法校验发票文件',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    let response: Response;
    try {
      response = await fetch(internalUrl, { signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '电子发票文件暂时无法读取，请重新上传',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!response.ok) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '电子发票文件尚未上传成功',
        HttpStatus.BAD_REQUEST,
      );
    }
    let file: Buffer;
    try {
      file = await readUploadWithinLimit(response, input.size);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '电子发票文件的大小、类型或校验摘要不一致',
        HttpStatus.BAD_REQUEST,
      );
    }
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0];
    const digest = createHash('sha256').update(file).digest('hex');
    if (
      file.byteLength !== input.size ||
      mediaType !== input.mediaType ||
      !matchesDeclaredMediaType(file, input.mediaType) ||
      digest !== input.contentDigest.toLowerCase()
    ) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '电子发票文件的大小、类型或校验摘要不一致',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async prepareDocumentUpload(
    organizationId: string,
    invoiceId: string,
    actorId: string,
    input: {
      fileName: string;
      mediaType: 'application/pdf' | 'application/ofd';
      size: number;
      contentDigest: string;
      replaceDocumentId?: string | undefined;
    },
    eventId?: EventId,
  ) {
    const detail = await this.detail(organizationId, invoiceId, true, eventId);
    const replacementTarget = input.replaceDocumentId
      ? (detail.documents.find((document) => document.id === input.replaceDocumentId) ?? null)
      : null;
    const activeDocuments = detail.documents.filter((document) => !document.voidedAt);
    const canCreateDocument = !input.replaceDocumentId && detail.status === 'issuing';
    const canReplaceActiveDocument =
      detail.status === 'issued' &&
      replacementTarget !== null &&
      !replacementTarget.voidedAt &&
      activeDocuments.length === 1;
    const canRestoreDeletedDocument =
      detail.status === 'voided' &&
      replacementTarget !== null &&
      Boolean(replacementTarget.voidedAt) &&
      activeDocuments.length === 0;
    if (!canCreateDocument && !canReplaceActiveDocument && !canRestoreDeletedDocument) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        input.replaceDocumentId
          ? '当前发票文件不可重新上传，请刷新详情后重试'
          : '发票处于开具中时才能上传电子发票文件',
        HttpStatus.CONFLICT,
      );
    }
    const safeName = input.fileName
      .normalize('NFKC')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .slice(-120);
    const storageKey = `invoices/${organizationId}/${detail.eventId}/${invoiceId}/${crypto.randomUUID()}-${safeName || 'invoice-file'}`;
    const uploadUrl = this.s3Presigned(storageKey, 'PUT', input.mediaType);
    if (!uploadUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法上传发票文件',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.db()
      .insert(auditLogs)
      .values({
        organizationId,
        eventId: detail.eventId,
        actorId,
        action: 'invoice.document.upload.prepare',
        resourceType: 'invoice_request',
        resourceId: invoiceId,
        after: {
          storageKey,
          mediaType: input.mediaType,
          size: input.size,
          contentDigest: input.contentDigest,
          ...(input.replaceDocumentId ? { replaceDocumentId: input.replaceDocumentId } : {}),
        },
        traceId: crypto.randomUUID(),
      });
    return {
      uploadUrl,
      method: 'PUT' as const,
      headers: { 'Content-Type': input.mediaType, 'If-None-Match': '*' },
      storageKey,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }

  private mapRequest(
    row: Awaited<ReturnType<InvoiceOperationsService['scopedRequest']>>,
    includePrivate: boolean,
  ): InvoiceRequest {
    const invoice = row.invoice;
    return {
      id: invoice.id,
      requestNo: invoice.requestNo,
      organizationId: invoice.organizationId,
      eventId: invoice.eventId,
      eventName: row.eventName,
      orderId: invoice.orderId,
      orderNo: row.orderNo,
      registrationId: invoice.registrationId,
      attendeeName: row.attendeeName.name,
      buyerType:
        invoice.buyerType === 'individual' || invoice.buyerType === 'company'
          ? invoice.buyerType
          : null,
      title: invoice.title,
      maskedTaxId: mask(invoice.taxId, 2, 2),
      ...(includePrivate ? { taxId: invoice.taxId } : {}),
      maskedEmail: invoice.email ? mask(invoice.email, 2, 6) : null,
      ...(includePrivate ? { email: invoice.email } : {}),
      maskedMobile: mask(invoice.mobile, 3, 4),
      ...(includePrivate ? { mobile: invoice.mobile } : {}),
      content: invoice.content,
      amount: invoice.amount,
      currency: 'CNY',
      netPaidAmount: invoice.netPaidAmount,
      status: invoice.status,
      rejectionReason: invoice.rejectionReason,
      deliveryStatus:
        invoice.deliveryStatus === 'queued' ||
        invoice.deliveryStatus === 'sent' ||
        invoice.deliveryStatus === 'failed'
          ? invoice.deliveryStatus
          : 'not_sent',
      lastSentAt: invoice.lastSentAt?.toISOString() ?? null,
      requestedAt: invoice.requestedAt.toISOString(),
      reviewedAt: invoice.reviewedAt?.toISOString() ?? null,
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
      documents: [],
      logs: [],
    };
  }

  private listConditions(organizationId: string, query: InvoiceListQuery = {}): SQL[] {
    const conditions = [eq(invoiceRequests.organizationId, organizationId)];
    if (query.eventId) conditions.push(eq(invoiceRequests.eventId, query.eventId));
    if (query.status) conditions.push(eq(invoiceRequests.status, query.status));
    if (query.dateField === 'issued' && (query.from || query.to)) {
      const issuedConditions: SQL[] = [eq(invoiceDocuments.invoiceRequestId, invoiceRequests.id)];
      if (query.from) issuedConditions.push(gte(invoiceDocuments.issuedAt, new Date(query.from)));
      if (query.to) issuedConditions.push(lte(invoiceDocuments.issuedAt, new Date(query.to)));
      conditions.push(
        sql<boolean>`exists (
          select 1 from ${invoiceDocuments}
          where ${and(...issuedConditions)}
        )`,
      );
    } else {
      if (query.from) conditions.push(gte(invoiceRequests.createdAt, new Date(query.from)));
      if (query.to) conditions.push(lte(invoiceRequests.createdAt, new Date(query.to)));
    }
    if (query.q) {
      const pattern = `%${query.q}%`;
      conditions.push(
        or(
          ilike(invoiceRequests.requestNo, pattern),
          ilike(orders.orderNo, pattern),
          ilike(invoiceRequests.title, pattern),
          ilike(invoiceRequests.taxId, pattern),
          ilike(invoiceRequests.email, pattern),
          ilike(invoiceRequests.mobile, pattern),
          ilike(events.name, pattern),
          sql<boolean>`${registrations.attendee}->>'name' ilike ${pattern}`,
        )!,
      );
    }
    return conditions;
  }

  async list(organizationId: string, query: InvoiceListQuery = {}) {
    const conditions = this.listConditions(organizationId, query);
    const rows = await this.db()
      .select({
        invoice: invoiceRequests,
        eventName: events.name,
        orderNo: orders.orderNo,
        attendeeName: registrations.attendee,
      })
      .from(invoiceRequests)
      .innerJoin(events, eq(events.id, invoiceRequests.eventId))
      .innerJoin(orders, eq(orders.id, invoiceRequests.orderId))
      .innerJoin(registrations, eq(registrations.id, invoiceRequests.registrationId))
      .where(and(...conditions))
      .orderBy(desc(invoiceRequests.createdAt));
    return rows.map((row) => this.mapRequest(row, false));
  }

  async page(organizationId: string, query: InvoiceListQuery = {}) {
    const conditions = this.listConditions(organizationId, query);
    if (query.cursor) {
      const [cursor] = await this.db()
        .select({ id: invoiceRequests.id, createdAt: invoiceRequests.createdAt })
        .from(invoiceRequests)
        .where(
          and(
            eq(invoiceRequests.id, query.cursor),
            eq(invoiceRequests.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!cursor) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '发票列表游标无效或已经过期',
          HttpStatus.BAD_REQUEST,
        );
      }
      conditions.push(
        or(
          lt(invoiceRequests.createdAt, cursor.createdAt),
          and(eq(invoiceRequests.createdAt, cursor.createdAt), lt(invoiceRequests.id, cursor.id)),
        )!,
      );
    }
    const limit = query.limit ?? 50;
    const rows = await this.db()
      .select({
        invoice: invoiceRequests,
        eventName: events.name,
        orderNo: orders.orderNo,
        attendeeName: registrations.attendee,
      })
      .from(invoiceRequests)
      .innerJoin(events, eq(events.id, invoiceRequests.eventId))
      .innerJoin(orders, eq(orders.id, invoiceRequests.orderId))
      .innerJoin(registrations, eq(registrations.id, invoiceRequests.registrationId))
      .where(and(...conditions))
      .orderBy(desc(invoiceRequests.createdAt), desc(invoiceRequests.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map((row) => this.mapRequest(row, false)),
      nextCursor: hasMore ? (pageRows.at(-1)?.invoice.id ?? null) : null,
    };
  }

  async exportRowCount(organizationId: string, query: InvoiceListQuery = {}) {
    const [result] = await this.db()
      .select({ value: count() })
      .from(invoiceRequests)
      .innerJoin(events, eq(events.id, invoiceRequests.eventId))
      .innerJoin(orders, eq(orders.id, invoiceRequests.orderId))
      .innerJoin(registrations, eq(registrations.id, invoiceRequests.registrationId))
      .where(and(...this.listConditions(organizationId, query)));
    return Number(result?.value ?? 0);
  }

  requiresAsyncExport(rowCount: number) {
    const configured = Number(process.env.INVOICE_ASYNC_EXPORT_THRESHOLD);
    const threshold =
      Number.isSafeInteger(configured) && configured >= 0
        ? configured
        : DEFAULT_ASYNC_INVOICE_EXPORT_THRESHOLD;
    return invoiceExportRequiresWorker(rowCount, threshold);
  }

  async queueExport(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    query: InvoiceListQuery,
    rowCount: number,
  ) {
    const [job] = await this.db().transaction(async (tx) => {
      const [created] = await tx
        .insert(invoiceExportJobs)
        .values({
          organizationId,
          requestedBy: actorId,
          status: 'queued',
          filters: query,
          rowCount,
        })
        .returning();
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId,
        eventType: 'InvoiceExportRequested',
        correlationId: `invoice:export:${created!.id}`,
        payload: { exportJobId: created!.id },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: 'invoice.export.queued',
        resourceType: 'invoice_export_job',
        resourceId: created!.id,
        after: { filters: this.auditFilters(query), count: rowCount },
        traceId: crypto.randomUUID(),
      });
      return [created!];
    });
    return {
      id: job.id,
      status: job.status,
      rowCount: job.rowCount,
      createdAt: job.createdAt.toISOString(),
    };
  }

  async exportJob(organizationId: string, eventId: EventId, exportJobId: string) {
    const [job] = await this.db()
      .select()
      .from(invoiceExportJobs)
      .where(
        and(
          eq(invoiceExportJobs.id, exportJobId),
          eq(invoiceExportJobs.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!job || !invoiceExportJobMatchesEvent(job.filters, eventId)) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '发票导出任务不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    const usable =
      job.status === 'ready' &&
      job.expiresAt &&
      job.expiresAt.getTime() > Date.now() &&
      (job.csvContent || job.storageKey);
    const expires = usable ? Math.min(job.expiresAt!.getTime(), Date.now() + 10 * 60_000) : null;
    return {
      id: job.id,
      status: usable ? 'ready' : job.status === 'ready' ? 'expired' : job.status,
      rowCount: job.rowCount,
      attempts: job.attempts,
      error: job.error,
      filename: job.filename,
      size: job.size,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
      expiresAt: job.expiresAt?.toISOString() ?? null,
      ...(expires
        ? {
            downloadPath: `/admin/events/${eventId}/invoices/export-jobs/${job.id}/download?expires=${expires}&signature=${this.exportSignature(organizationId, eventId, job.id, expires)}`,
          }
        : {}),
    };
  }

  async retryExport(
    organizationId: string,
    eventId: EventId,
    exportJobId: string,
    actorId: string,
  ) {
    const job = await this.db().transaction(async (tx) => {
      const [current] = await tx
        .select({ filters: invoiceExportJobs.filters })
        .from(invoiceExportJobs)
        .where(
          and(
            eq(invoiceExportJobs.id, exportJobId),
            eq(invoiceExportJobs.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!current || !invoiceExportJobMatchesEvent(current.filters, eventId)) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '发票导出任务不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const [updated] = await tx
        .update(invoiceExportJobs)
        .set({ status: 'queued', error: null, updatedAt: new Date() })
        .where(
          and(
            eq(invoiceExportJobs.id, exportJobId),
            eq(invoiceExportJobs.organizationId, organizationId),
            eq(invoiceExportJobs.status, 'failed'),
          ),
        )
        .returning();
      if (!updated) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前发票导出任务无法重试',
          HttpStatus.CONFLICT,
        );
      }
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId,
        eventType: 'InvoiceExportRequested',
        correlationId: `invoice:export:retry:${updated.id}:${updated.attempts + 1}`,
        payload: { exportJobId: updated.id },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: 'invoice.export.retry',
        resourceType: 'invoice_export_job',
        resourceId: updated.id,
        traceId: crypto.randomUUID(),
      });
      return updated;
    });
    return this.exportJob(organizationId, eventId, job.id);
  }

  async downloadExport(
    organizationId: string,
    eventId: EventId,
    exportJobId: string,
    expires: number,
    signature: string,
    actorId: string,
  ) {
    const expected = this.exportSignature(organizationId, eventId, exportJobId, expires);
    const supplied = Buffer.from(signature);
    const valid =
      Number.isSafeInteger(expires) &&
      expires > Date.now() &&
      supplied.length === expected.length &&
      timingSafeEqual(supplied, Buffer.from(expected));
    if (!valid) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '发票导出下载链接无效或已经过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const [job] = await this.db()
      .select()
      .from(invoiceExportJobs)
      .where(
        and(
          eq(invoiceExportJobs.id, exportJobId),
          eq(invoiceExportJobs.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (
      !job ||
      !invoiceExportJobMatchesEvent(job.filters, eventId) ||
      job.status !== 'ready' ||
      (!job.csvContent && !job.storageKey) ||
      !job.expiresAt ||
      job.expiresAt.getTime() <= Date.now()
    ) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '发票导出文件不存在或已经过期',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.db()
      .insert(auditLogs)
      .values({
        organizationId,
        eventId,
        actorId,
        action: 'invoice.export.download',
        resourceType: 'invoice_export_job',
        resourceId: job.id,
        after: { count: job.rowCount },
        traceId: crypto.randomUUID(),
      });
    const downloadUrl = job.storageKey
      ? this.s3Presigned(job.storageKey, 'GET', undefined, process.env.S3_ENDPOINT)
      : null;
    if (job.storageKey && !downloadUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法读取导出文件',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      content: job.csvContent,
      downloadUrl,
      filename: job.filename ?? `invoice-requests-${job.createdAt.toISOString().slice(0, 10)}.csv`,
      size: job.size,
    };
  }

  async auditRead(
    organizationId: string,
    eventId: EventId,
    invoiceId: string,
    actorId: string,
    action = 'invoice.detail.read',
  ) {
    const row = await this.scopedRequest(organizationId, invoiceId, eventId);
    await this.db().insert(auditLogs).values({
      organizationId,
      eventId: row.invoice.eventId,
      actorId,
      action,
      resourceType: 'invoice_request',
      resourceId: invoiceId,
      traceId: crypto.randomUUID(),
    });
  }

  async auditExport(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    query: InvoiceListQuery,
    count: number,
  ) {
    await this.db()
      .insert(auditLogs)
      .values({
        organizationId,
        eventId,
        actorId,
        action: 'invoice.export',
        resourceType: 'invoice_request_export',
        resourceId: crypto.randomUUID(),
        after: { filters: this.auditFilters(query), count },
        traceId: crypto.randomUUID(),
      });
  }

  async adminDocumentDownload(
    organizationId: string,
    eventId: EventId,
    invoiceId: string,
    documentId: string,
    actorId: string,
  ) {
    const request = await this.scopedRequest(organizationId, invoiceId, eventId);
    const [document] = await this.db()
      .select()
      .from(invoiceDocuments)
      .where(
        and(
          eq(invoiceDocuments.id, documentId),
          eq(invoiceDocuments.invoiceRequestId, invoiceId),
          isNull(invoiceDocuments.voidedAt),
        ),
      )
      .limit(1);
    if (!document) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '可下载的发票文件不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    const downloadUrl = this.s3Presigned(document.storageKey, 'GET');
    if (!downloadUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法下载发票文件',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.db().insert(auditLogs).values({
      organizationId,
      eventId: request.invoice.eventId,
      actorId,
      action: 'invoice.document.download',
      resourceType: 'invoice_document',
      resourceId: documentId,
      after: { invoiceId },
      traceId: crypto.randomUUID(),
    });
    return downloadUrl;
  }

  async detail(
    organizationId: string,
    invoiceId: string,
    includePrivate = true,
    eventId?: EventId,
  ) {
    const row = await this.scopedRequest(organizationId, invoiceId, eventId);
    const [documents, logs] = await Promise.all([
      this.db()
        .select()
        .from(invoiceDocuments)
        .where(eq(invoiceDocuments.invoiceRequestId, invoiceId))
        .orderBy(desc(invoiceDocuments.issuedAt)),
      this.db()
        .select()
        .from(invoiceStateLogs)
        .where(eq(invoiceStateLogs.invoiceRequestId, invoiceId))
        .orderBy(asc(invoiceStateLogs.createdAt)),
    ]);
    const actorIds = [...new Set(logs.flatMap((item) => (item.actorId ? [item.actorId] : [])))];
    const actorNames = new Map<string, string>();
    for (const actorId of actorIds) {
      const [actor] = await this.db()
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, actorId))
        .limit(1);
      if (actor) actorNames.set(actorId, actor.name);
    }
    return {
      ...this.mapRequest(row, includePrivate),
      documents: documents.map((document) => ({
        id: document.id,
        documentType:
          document.documentType === 'adjustment' || document.documentType === 'reissue'
            ? document.documentType
            : ('original' as const),
        invoiceNumber: document.invoiceNumber,
        invoiceCode: document.invoiceCode,
        externalReference: document.externalReference,
        storageKey: document.storageKey,
        mediaType:
          document.mediaType === 'application/ofd'
            ? ('application/ofd' as const)
            : ('application/pdf' as const),
        size: document.size,
        contentDigest: document.contentDigest,
        replacesDocumentId: document.replacesDocumentId,
        issuedAt: document.issuedAt.toISOString(),
        voidedAt: document.voidedAt?.toISOString() ?? null,
        voidReason: document.voidReason,
      })),
      logs: logs.map((log) => ({
        id: log.id,
        fromStatus: (log.fromStatus as InvoiceRequestStatus | null) ?? null,
        toStatus: log.toStatus as InvoiceRequestStatus,
        reason: log.reason,
        actorName: log.actorId ? (actorNames.get(log.actorId) ?? null) : null,
        metadata: log.metadata,
        createdAt: log.createdAt.toISOString(),
      })),
    } satisfies InvoiceRequest;
  }

  private async transition(
    organizationId: string,
    invoiceId: string,
    actorId: string,
    next: InvoiceRequestStatus,
    reason: string,
    expectedUpdatedAt: string,
    patch: Partial<typeof invoiceRequests.$inferInsert> = {},
    eventId?: EventId,
  ) {
    const db = this.db();
    await db.transaction(async (tx) => {
      const conditions = [
        eq(invoiceRequests.id, invoiceId),
        eq(invoiceRequests.organizationId, organizationId),
      ];
      if (eventId) conditions.push(eq(invoiceRequests.eventId, eventId));
      const [current] = await tx
        .select()
        .from(invoiceRequests)
        .where(and(...conditions))
        .for('update')
        .limit(1);
      if (!current) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '发票申请不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (current.updatedAt.toISOString() !== expectedUpdatedAt) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '发票资料已经更新，请刷新详情后重新操作',
          HttpStatus.CONFLICT,
          {
            currentStatus: current.status,
            currentUpdatedAt: current.updatedAt.toISOString(),
          },
        );
      }
      if (!canTransitionInvoice(current.status, next)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          `发票状态不能从 ${current.status} 变更为 ${next}`,
          HttpStatus.CONFLICT,
          { currentStatus: current.status, allowed: allowedInvoiceTransitions(current.status) },
        );
      }
      await tx
        .update(invoiceRequests)
        .set({ ...patch, status: next, updatedAt: new Date() })
        .where(eq(invoiceRequests.id, current.id));
      await tx.insert(invoiceStateLogs).values({
        invoiceRequestId: current.id,
        fromStatus: current.status,
        toStatus: next,
        reason,
        actorId,
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: current.eventId,
        actorId,
        action: `invoice.${next}`,
        resourceType: 'invoice_request',
        resourceId: current.id,
        before: { status: current.status },
        after: { status: next, reason },
        traceId: crypto.randomUUID(),
      });
    });
    return this.detail(organizationId, invoiceId, true, eventId);
  }

  approve(
    organizationId: string,
    invoiceId: string,
    actorId: string,
    input: InvoiceVersion,
    eventId?: EventId,
  ) {
    return this.transition(
      organizationId,
      invoiceId,
      actorId,
      'issuing',
      '财务审核通过',
      input.expectedUpdatedAt,
      {
        reviewedAt: new Date(),
        reviewedBy: actorId,
        rejectionReason: null,
      },
      eventId,
    );
  }

  reject(
    organizationId: string,
    invoiceId: string,
    actorId: string,
    input: InvoiceAction,
    eventId?: EventId,
  ) {
    return this.transition(
      organizationId,
      invoiceId,
      actorId,
      'rejected',
      input.reason,
      input.expectedUpdatedAt,
      {
        reviewedAt: new Date(),
        reviewedBy: actorId,
        rejectionReason: input.reason,
      },
      eventId,
    );
  }

  retry(
    organizationId: string,
    invoiceId: string,
    actorId: string,
    input: InvoiceAction,
    eventId?: EventId,
  ) {
    return this.transition(
      organizationId,
      invoiceId,
      actorId,
      'issuing',
      input.reason,
      input.expectedUpdatedAt,
      {},
      eventId,
    );
  }

  markIssueFailed(
    organizationId: string,
    invoiceId: string,
    actorId: string,
    input: InvoiceAction,
    eventId?: EventId,
  ) {
    return this.transition(
      organizationId,
      invoiceId,
      actorId,
      'issue_failed',
      input.reason,
      input.expectedUpdatedAt,
      {},
      eventId,
    );
  }

  cancel(
    organizationId: string,
    invoiceId: string,
    actorId: string,
    input: InvoiceAction,
    eventId?: EventId,
  ) {
    return this.transition(
      organizationId,
      invoiceId,
      actorId,
      'cancelled',
      input.reason,
      input.expectedUpdatedAt,
      {},
      eventId,
    );
  }

  async addDocument(
    organizationId: string,
    invoiceId: string,
    actorId: string,
    input: CreateInvoiceDocument,
    eventId?: EventId,
  ) {
    await this.assertStoredDocument(organizationId, invoiceId, input, eventId);
    const db = this.db();
    await db.transaction(async (tx) => {
      const conditions = [
        eq(invoiceRequests.id, invoiceId),
        eq(invoiceRequests.organizationId, organizationId),
      ];
      if (eventId) conditions.push(eq(invoiceRequests.eventId, eventId));
      const [invoice] = await tx
        .select()
        .from(invoiceRequests)
        .where(and(...conditions))
        .for('update')
        .limit(1);
      if (!invoice) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '发票申请不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (invoice.status !== 'issuing') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '发票处于开具中时才能登记开票文件',
          HttpStatus.CONFLICT,
          { currentStatus: invoice.status, allowed: allowedInvoiceTransitions(invoice.status) },
        );
      }
      if (invoice.netPaidAmount <= 0 || invoice.amount > invoice.netPaidAmount) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '开票金额必须大于零且不能超过订单净支付金额',
          HttpStatus.CONFLICT,
          { amount: invoice.amount, netPaidAmount: invoice.netPaidAmount },
        );
      }
      const [activeDocument] = await tx
        .select({ id: invoiceDocuments.id })
        .from(invoiceDocuments)
        .where(
          and(eq(invoiceDocuments.invoiceRequestId, invoice.id), isNull(invoiceDocuments.voidedAt)),
        )
        .limit(1);
      if (activeDocument) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前申请仍有有效发票文件，请先作废后再登记调整或重开文件',
          HttpStatus.CONFLICT,
        );
      }
      const [priorDocument] = await tx
        .select({ id: invoiceDocuments.id })
        .from(invoiceDocuments)
        .where(eq(invoiceDocuments.invoiceRequestId, invoice.id))
        .limit(1);
      if (priorDocument && input.documentType === 'original') {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '已有历史发票文件时，请选择调整或重开类型',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (input.documentType !== 'original' && !input.replacesDocumentId) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '调整或重开发票必须选择被替代的历史文件',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (input.replacesDocumentId) {
        const [replaced] = await tx
          .select({ id: invoiceDocuments.id, voidedAt: invoiceDocuments.voidedAt })
          .from(invoiceDocuments)
          .where(
            and(
              eq(invoiceDocuments.id, input.replacesDocumentId),
              eq(invoiceDocuments.invoiceRequestId, invoice.id),
            ),
          )
          .limit(1);
        if (!replaced) {
          throw new DomainError(
            API_ERROR_CODES.VALIDATION_ERROR,
            '被替代的发票文件不属于当前申请',
            HttpStatus.BAD_REQUEST,
          );
        }
        if (!replaced.voidedAt) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '被替代的发票文件需要先完成作废',
            HttpStatus.CONFLICT,
          );
        }
      }
      const [document] = await tx
        .insert(invoiceDocuments)
        .values({
          invoiceRequestId: invoice.id,
          ...input,
          invoiceCode: input.invoiceCode ?? null,
          externalReference: input.externalReference ?? null,
          replacesDocumentId: input.replacesDocumentId ?? null,
          issuedBy: actorId,
        })
        .returning();
      await tx
        .update(invoiceRequests)
        .set({
          status: 'issued',
          rejectionReason: null,
          deliveryStatus: 'queued',
          updatedAt: new Date(),
        })
        .where(eq(invoiceRequests.id, invoice.id));
      await tx.insert(invoiceStateLogs).values({
        invoiceRequestId: invoice.id,
        fromStatus: invoice.status,
        toStatus: 'issued',
        reason: `登记发票文件 ${input.invoiceNumber}`,
        actorId,
        metadata: { documentId: document!.id },
      });
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId: invoice.eventId,
        eventType: 'InvoiceIssued',
        correlationId: `invoice:issued:${document!.id}`,
        payload: { invoiceId: invoice.id, documentId: document!.id },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: invoice.eventId,
        actorId,
        action: 'invoice.document.create',
        resourceType: 'invoice_document',
        resourceId: document!.id,
        after: { invoiceId: invoice.id, invoiceNumber: input.invoiceNumber },
        traceId: crypto.randomUUID(),
      });
    });
    return this.detail(organizationId, invoiceId, true, eventId);
  }

  async voidDocument(
    organizationId: string,
    invoiceId: string,
    documentId: string,
    actorId: string,
    input: InvoiceAction,
    eventId?: EventId,
  ) {
    const db = this.db();
    await db.transaction(async (tx) => {
      const conditions = [
        eq(invoiceRequests.id, invoiceId),
        eq(invoiceRequests.organizationId, organizationId),
      ];
      if (eventId) conditions.push(eq(invoiceRequests.eventId, eventId));
      const [invoice] = await tx
        .select()
        .from(invoiceRequests)
        .where(and(...conditions))
        .for('update')
        .limit(1);
      if (!invoice) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '发票申请不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (invoice.updatedAt.toISOString() !== input.expectedUpdatedAt) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '发票资料已经更新，请刷新详情后重新操作',
          HttpStatus.CONFLICT,
          {
            currentStatus: invoice.status,
            currentUpdatedAt: invoice.updatedAt.toISOString(),
          },
        );
      }
      if (!['issued', 'adjustment_required'].includes(invoice.status)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前发票状态不允许作废文件',
          HttpStatus.CONFLICT,
        );
      }
      const [document] = await tx
        .update(invoiceDocuments)
        .set({
          voidedBy: actorId,
          voidedAt: new Date(),
          voidReason: input.reason,
        })
        .where(
          and(
            eq(invoiceDocuments.id, documentId),
            eq(invoiceDocuments.invoiceRequestId, invoice.id),
            isNull(invoiceDocuments.voidedAt),
          ),
        )
        .returning();
      if (!document) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '可作废的发票文件不存在',
          HttpStatus.NOT_FOUND,
        );
      }
      await tx
        .update(invoiceRequests)
        .set({ status: 'voided', updatedAt: new Date() })
        .where(eq(invoiceRequests.id, invoice.id));
      await tx.insert(invoiceStateLogs).values({
        invoiceRequestId: invoice.id,
        fromStatus: invoice.status,
        toStatus: 'voided',
        reason: input.reason,
        actorId,
        metadata: { documentId },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: invoice.eventId,
        actorId,
        action: 'invoice.document.void',
        resourceType: 'invoice_document',
        resourceId: documentId,
        before: { status: invoice.status },
        after: { status: 'voided', reason: input.reason },
        traceId: crypto.randomUUID(),
      });
    });
    return this.detail(organizationId, invoiceId, true, eventId);
  }

  async replaceDocumentFile(
    organizationId: string,
    invoiceId: string,
    documentId: string,
    actorId: string,
    input: ReplaceInvoiceDocumentFileInput,
    eventId?: EventId,
  ) {
    await this.assertStoredDocument(organizationId, invoiceId, input, eventId);
    const db = this.db();
    await db.transaction(async (tx) => {
      const conditions = [
        eq(invoiceRequests.id, invoiceId),
        eq(invoiceRequests.organizationId, organizationId),
      ];
      if (eventId) conditions.push(eq(invoiceRequests.eventId, eventId));
      const [invoice] = await tx
        .select()
        .from(invoiceRequests)
        .where(and(...conditions))
        .for('update')
        .limit(1);
      if (!invoice) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '发票申请不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (invoice.updatedAt.toISOString() !== input.expectedUpdatedAt) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '发票资料已经更新，请刷新详情后重新操作',
          HttpStatus.CONFLICT,
          {
            currentStatus: invoice.status,
            currentUpdatedAt: invoice.updatedAt.toISOString(),
          },
        );
      }
      const [document] = await tx
        .select()
        .from(invoiceDocuments)
        .where(
          and(
            eq(invoiceDocuments.id, documentId),
            eq(invoiceDocuments.invoiceRequestId, invoice.id),
          ),
        )
        .for('update')
        .limit(1);
      if (!document) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '待重新上传的发票文件不存在',
          HttpStatus.NOT_FOUND,
        );
      }
      const replacingActiveDocument = invoice.status === 'issued' && !document.voidedAt;
      const restoringDeletedDocument = invoice.status === 'voided' && Boolean(document.voidedAt);
      if (!replacingActiveDocument && !restoringDeletedDocument) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前发票文件不可重新上传，请刷新详情后重试',
          HttpStatus.CONFLICT,
        );
      }
      const [otherActiveDocument] = await tx
        .select({ id: invoiceDocuments.id })
        .from(invoiceDocuments)
        .where(
          and(
            eq(invoiceDocuments.invoiceRequestId, invoice.id),
            isNull(invoiceDocuments.voidedAt),
            sql`${invoiceDocuments.id} <> ${document.id}`,
          ),
        )
        .limit(1);
      if (otherActiveDocument) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前申请已经存在其他有效发票文件',
          HttpStatus.CONFLICT,
        );
      }
      const replacedAt = new Date();
      await tx
        .update(invoiceDocuments)
        .set({
          storageKey: input.storageKey,
          mediaType: input.mediaType,
          size: input.size,
          contentDigest: input.contentDigest,
          issuedBy: actorId,
          issuedAt: replacedAt,
          voidedBy: null,
          voidedAt: null,
          voidReason: null,
        })
        .where(eq(invoiceDocuments.id, document.id));
      await tx
        .update(invoiceRequests)
        .set({
          status: 'issued',
          deliveryStatus: 'not_sent',
          lastSentAt: null,
          updatedAt: replacedAt,
        })
        .where(eq(invoiceRequests.id, invoice.id));
      await tx.insert(invoiceStateLogs).values({
        invoiceRequestId: invoice.id,
        fromStatus: invoice.status,
        toStatus: 'issued',
        reason: input.reason,
        actorId,
        metadata: {
          documentId: document.id,
          operation: 'file_replaced',
          previousContentDigest: document.contentDigest,
        },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: invoice.eventId,
        actorId,
        action: 'invoice.document.file.replace',
        resourceType: 'invoice_document',
        resourceId: document.id,
        before: {
          storageKey: document.storageKey,
          mediaType: document.mediaType,
          size: document.size,
          contentDigest: document.contentDigest,
          voidedAt: document.voidedAt?.toISOString() ?? null,
        },
        after: {
          storageKey: input.storageKey,
          mediaType: input.mediaType,
          size: input.size,
          contentDigest: input.contentDigest,
          status: 'issued',
        },
        traceId: crypto.randomUUID(),
      });
    });
    return this.detail(organizationId, invoiceId, true, eventId);
  }

  async send(organizationId: string, invoiceId: string, actorId: string, eventId?: EventId) {
    await this.db().transaction(async (tx) => {
      const conditions = [
        eq(invoiceRequests.id, invoiceId),
        eq(invoiceRequests.organizationId, organizationId),
      ];
      if (eventId) conditions.push(eq(invoiceRequests.eventId, eventId));
      const [invoice] = await tx
        .select()
        .from(invoiceRequests)
        .where(and(...conditions))
        .for('update')
        .limit(1);
      if (!invoice) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '发票申请不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const [activeDocument] = await tx
        .select({ id: invoiceDocuments.id })
        .from(invoiceDocuments)
        .where(
          and(eq(invoiceDocuments.invoiceRequestId, invoice.id), isNull(invoiceDocuments.voidedAt)),
        )
        .orderBy(desc(invoiceDocuments.issuedAt))
        .limit(1);
      if (invoice.status !== 'issued' || !activeDocument || !invoice.email) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '已开具且接收邮箱完整时才能发送发票',
          HttpStatus.CONFLICT,
        );
      }
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId: invoice.eventId,
        eventType: 'InvoiceDeliveryRequested',
        correlationId: `invoice:send:${invoiceId}:${crypto.randomUUID()}`,
        payload: {
          invoiceId,
          documentId: activeDocument.id,
          recipient: invoice.email,
          requestedBy: actorId,
        },
      });
      await tx
        .update(invoiceRequests)
        .set({ deliveryStatus: 'queued', updatedAt: new Date() })
        .where(eq(invoiceRequests.id, invoiceId));
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: invoice.eventId,
        actorId,
        action: 'invoice.send',
        resourceType: 'invoice_request',
        resourceId: invoiceId,
        after: { documentId: activeDocument.id },
        traceId: crypto.randomUUID(),
      });
    });
    return { queued: true };
  }

  async requestDetailsReminder(
    organizationId: string,
    invoiceId: string,
    actorId: string,
    eventId?: EventId,
  ) {
    const queued = await this.db().transaction(async (tx) => {
      const conditions = [
        eq(invoiceRequests.id, invoiceId),
        eq(invoiceRequests.organizationId, organizationId),
      ];
      if (eventId) conditions.push(eq(invoiceRequests.eventId, eventId));
      const [invoice] = await tx
        .select()
        .from(invoiceRequests)
        .where(and(...conditions))
        .for('update')
        .limit(1);
      if (!invoice) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '发票申请不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (!['awaiting_details', 'rejected'].includes(invoice.status)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前发票状态不需要补充资料',
          HttpStatus.CONFLICT,
        );
      }
      const [recentReminder] = await tx
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.eventId, invoice.eventId),
            eq(auditLogs.action, 'invoice.details-reminder.send'),
            eq(auditLogs.resourceType, 'invoice_request'),
            eq(auditLogs.resourceId, invoiceId),
            gte(auditLogs.createdAt, new Date(Date.now() - 10 * 60_000)),
          ),
        )
        .limit(1);
      if (recentReminder) return false;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId: invoice.eventId,
        eventType: 'InvoiceDetailsRequested',
        correlationId: `invoice:details-reminder:${invoiceId}:${crypto.randomUUID()}`,
        payload: {
          invoiceId,
          orderId: invoice.orderId,
          expiresAt: expiresAt.toISOString(),
          requestedBy: actorId,
        },
      });
      await tx
        .update(invoiceRequests)
        .set({ deliveryStatus: 'queued', updatedAt: new Date() })
        .where(eq(invoiceRequests.id, invoiceId));
      await tx.insert(invoiceStateLogs).values({
        invoiceRequestId: invoiceId,
        fromStatus: invoice.status,
        toStatus: invoice.status,
        reason: '运营人员重新发送发票资料填写入口',
        actorId,
        metadata: { expiresAt: expiresAt.toISOString() },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: invoice.eventId,
        actorId,
        action: 'invoice.details-reminder.send',
        resourceType: 'invoice_request',
        resourceId: invoiceId,
        after: { expiresAt: expiresAt.toISOString() },
        traceId: crypto.randomUUID(),
      });
      return true;
    });
    return { queued: true, alreadyQueued: !queued };
  }

  async requestOrderAccessLink(input: RequestOrderAccessLink) {
    const generic = {
      accepted: true,
      message: '如果订单号与报名邮箱匹配，新的访问链接会发送到该邮箱。',
    };
    const [match] = await this.db()
      .select({
        order: orders,
        attendee: registrations.attendee,
        invoiceId: invoiceRequests.id,
      })
      .from(orders)
      .innerJoin(registrations, eq(registrations.id, orders.registrationId))
      .leftJoin(invoiceRequests, eq(invoiceRequests.orderId, orders.id))
      .where(eq(orders.orderNo, input.orderNo))
      .limit(1);
    if (!match || match.attendee.email.trim().toLowerCase() !== input.email.trim().toLowerCase()) {
      return generic;
    }

    const combination = createHash('sha256')
      .update(`${input.orderNo}:${input.email.trim().toLowerCase()}`)
      .digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const accepted = await this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`order-access-link:${combination}`}, 0))`,
      );
      const since = new Date(Date.now() - 60 * 60_000);
      await tx
        .delete(orderAccessLinkAttempts)
        .where(
          and(
            eq(orderAccessLinkAttempts.combinationHash, combination),
            lt(orderAccessLinkAttempts.createdAt, since),
          ),
        );
      const [attemptCount] = await tx
        .select({ value: count() })
        .from(orderAccessLinkAttempts)
        .where(eq(orderAccessLinkAttempts.combinationHash, combination));
      if (Number(attemptCount?.value ?? 0) >= 5) return false;
      await tx.insert(orderAccessLinkAttempts).values({ combinationHash: combination });
      await tx.insert(outboxEvents).values({
        organizationId: match.order.organizationId,
        eventId: match.order.eventId,
        eventType: 'OrderAccessLinkRequested',
        correlationId: `order:access-link:${match.order.id}:${crypto.randomUUID()}`,
        payload: {
          orderId: match.order.id,
          ...(match.invoiceId ? { invoiceId: match.invoiceId } : {}),
          recipient: input.email.trim().toLowerCase(),
          expiresAt: expiresAt.toISOString(),
        },
      });
      return true;
    });
    if (!accepted) return generic;
    return generic;
  }

  async readOrderInvoice(orderId: string, accessToken: string) {
    await this.orderToken(accessToken, orderId, 'invoice:read');
    const [invoice] = await this.db()
      .select({
        id: invoiceRequests.id,
        organizationId: invoiceRequests.organizationId,
      })
      .from(invoiceRequests)
      .where(eq(invoiceRequests.orderId, orderId))
      .limit(1);
    if (!invoice) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '当前订单没有发票申请',
        HttpStatus.NOT_FOUND,
      );
    }
    const detail = await this.customerInvoiceDetail(invoice.organizationId, orderId, invoice.id);
    await this.db().insert(auditLogs).values({
      organizationId: invoice.organizationId,
      eventId: detail.eventId,
      action: 'invoice.attendee.read',
      resourceType: 'invoice_request',
      resourceId: detail.id,
      after: { orderId },
      traceId: crypto.randomUUID(),
    });
    return detail;
  }

  private async customerOrderScope(
    organizationId: string,
    customerUserId: string,
    orderId: string,
  ) {
    const [scope] = await this.db()
      .select({ order: orders, registration: registrations })
      .from(orders)
      .innerJoin(registrations, eq(registrations.id, orders.registrationId))
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.organizationId, organizationId),
          eq(registrations.customerUserId, customerUserId),
        ),
      )
      .limit(1);
    if (!scope) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
    }
    return scope;
  }

  async customerOrderInvoiceContext(
    organizationId: string,
    customerUserId: string,
    orderId: string,
  ): Promise<CustomerInvoiceOrderContext> {
    const [scope] = await this.db()
      .select({
        order: orders,
        eventId: events.id,
        eventName: events.name,
        startsAt: events.startsAt,
        invoiceId: invoiceRequests.id,
      })
      .from(orders)
      .innerJoin(registrations, eq(registrations.id, orders.registrationId))
      .innerJoin(events, eq(events.id, orders.eventId))
      .leftJoin(invoiceRequests, eq(invoiceRequests.orderId, orders.id))
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.organizationId, organizationId),
          eq(registrations.customerUserId, customerUserId),
        ),
      )
      .limit(1);
    if (!scope) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
    }
    const [refundTotal] = await this.db()
      .select({ amount: sum(refunds.amount) })
      .from(refunds)
      .where(and(eq(refunds.orderId, orderId), eq(refunds.status, 'succeeded')));
    const eligibility = customerInvoicePaymentEligibility({
      orderStatus: scope.order.status,
      orderAmount: scope.order.amount,
      refundedAmount: Number(refundTotal?.amount ?? 0),
    });
    const canApply = !scope.invoiceId && eligibility.canApply;
    const unavailableReason = canApply
      ? null
      : scope.invoiceId
        ? '该订单已有发票申请，请查看当前申请进度。'
        : eligibility.unavailableReason;
    return {
      orderId: scope.order.id,
      orderNo: scope.order.orderNo,
      eventId: scope.eventId,
      eventName: scope.eventName,
      startsAt: scope.startsAt.toISOString(),
      orderAmount: scope.order.amount,
      eligibleAmount: eligibility.eligibleAmount,
      currency: scope.order.currency,
      canApply,
      unavailableReason,
    };
  }

  async readCustomerOrderInvoice(organizationId: string, customerUserId: string, orderId: string) {
    await this.customerOrderScope(organizationId, customerUserId, orderId);
    const [invoice] = await this.db()
      .select({ id: invoiceRequests.id })
      .from(invoiceRequests)
      .where(
        and(
          eq(invoiceRequests.orderId, orderId),
          eq(invoiceRequests.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!invoice) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '当前订单没有发票申请',
        HttpStatus.NOT_FOUND,
      );
    }
    const detail = await this.customerInvoiceDetail(organizationId, orderId, invoice.id);
    await this.db().insert(auditLogs).values({
      organizationId,
      eventId: detail.eventId,
      actorId: customerUserId,
      actorType: 'customer',
      action: 'invoice.customer.read',
      resourceType: 'invoice_request',
      resourceId: detail.id,
      after: { orderId },
      traceId: crypto.randomUUID(),
    });
    return detail;
  }

  private async customerInvoiceDetail(organizationId: string, orderId: string, invoiceId: string) {
    const detail = await this.detail(organizationId, invoiceId);
    const expires = Date.now() + 10 * 60_000;
    return CustomerInvoiceDetailSchema.parse({
      ...detail,
      documents: detail.documents.map(({ storageKey: _storageKey, ...document }) => ({
        ...document,
        downloadUrl: document.voidedAt
          ? null
          : `/orders/${encodeURIComponent(orderId)}/invoice-documents/${encodeURIComponent(document.id)}/download?expires=${expires}&signature=${this.downloadSignature(orderId, document.id, expires)}`,
      })),
      timeline: detail.logs.map((log) => {
        const copy = CUSTOMER_INVOICE_STATUS_COPY[log.toStatus];
        const description =
          log.toStatus === 'rejected'
            ? `需要修改：${log.reason}`
            : log.toStatus === 'pending_review' && log.fromStatus === 'pending_review'
              ? '开票资料已经更新，主办方将按最新信息审核。'
              : copy.description;
        return {
          id: log.id,
          status: log.toStatus,
          label: copy.label,
          description,
          tone: copy.tone,
          occurredAt: log.createdAt,
        };
      }),
    });
  }

  private async applyInvoiceBuyer(
    tx: DatabaseTransaction,
    invoice: typeof invoiceRequests.$inferSelect,
    input: InvoiceBuyer,
    metadata: Record<string, unknown>,
  ) {
    const unchangedPendingSubmission =
      invoice.status === 'pending_review' &&
      invoice.buyerType === input.buyerType &&
      invoice.title === input.title &&
      (invoice.taxId ?? '') === input.taxId &&
      invoice.email === input.email &&
      invoice.mobile === input.mobile &&
      invoice.content === input.content;
    if (unchangedPendingSubmission) return false;
    if (!isCustomerInvoiceEditableStatus(invoice.status)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '当前发票状态不允许修改购买方资料',
        HttpStatus.CONFLICT,
      );
    }
    const requestedAt = new Date();
    const pendingRevision = invoice.status === 'pending_review';
    await tx
      .update(invoiceRequests)
      .set({
        buyerType: input.buyerType,
        title: input.title,
        taxId: input.taxId || null,
        email: input.email,
        mobile: input.mobile,
        content: input.content,
        status: 'pending_review',
        rejectionReason: null,
        reviewedAt: null,
        reviewedBy: null,
        requestedAt,
        updatedAt: requestedAt,
      })
      .where(eq(invoiceRequests.id, invoice.id));
    if (!pendingRevision) {
      await tx.insert(invoiceStateLogs).values({
        invoiceRequestId: invoice.id,
        fromStatus: invoice.status,
        toStatus: 'pending_review',
        reason: '参会人已提交完整开票资料',
        metadata,
      });
      await tx.insert(outboxEvents).values({
        organizationId: invoice.organizationId,
        eventId: invoice.eventId,
        eventType: 'InvoiceDetailsSubmitted',
        correlationId: `invoice:details:${invoice.id}:${requestedAt.getTime()}`,
        payload: { invoiceId: invoice.id },
      });
    }
    return true;
  }

  createCustomerOrderInvoice(
    organizationId: string,
    customerUserId: string,
    orderId: string,
    input: CustomerCreateInvoice,
  ) {
    return this.persistCustomerOrderInvoice(
      organizationId,
      customerUserId,
      orderId,
      input,
      'create',
    );
  }

  updateCustomerOrderInvoice(
    organizationId: string,
    customerUserId: string,
    orderId: string,
    input: CustomerUpdateInvoice,
  ) {
    return this.persistCustomerOrderInvoice(
      organizationId,
      customerUserId,
      orderId,
      input,
      'update',
    );
  }

  private async persistCustomerOrderInvoice(
    organizationId: string,
    customerUserId: string,
    orderId: string,
    input: CustomerCreateInvoice | CustomerUpdateInvoice,
    operation: 'create' | 'update',
  ) {
    const db = this.db();
    const invoiceId = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`customer-invoice:${orderId}`}, 0))`,
      );
      const [scope] = await tx
        .select({ order: orders, registration: registrations })
        .from(orders)
        .innerJoin(registrations, eq(registrations.id, orders.registrationId))
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.organizationId, organizationId),
            eq(registrations.customerUserId, customerUserId),
          ),
        )
        .for('update')
        .limit(1);
      if (!scope) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
      }
      const [refundTotal] = await tx
        .select({ amount: sum(refunds.amount) })
        .from(refunds)
        .where(and(eq(refunds.orderId, orderId), eq(refunds.status, 'succeeded')));
      const eligibility = customerInvoicePaymentEligibility({
        orderStatus: scope.order.status,
        orderAmount: scope.order.amount,
        refundedAmount: Number(refundTotal?.amount ?? 0),
      });
      if (!eligibility.canApply) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          eligibility.unavailableReason ?? '当前订单暂时无法申请发票',
          HttpStatus.CONFLICT,
        );
      }
      const netPaidAmount = eligibility.eligibleAmount;
      let [invoice] = await tx
        .select()
        .from(invoiceRequests)
        .where(eq(invoiceRequests.orderId, orderId))
        .for('update')
        .limit(1);
      if (operation === 'create' && invoice) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该订单已有发票申请，请查看当前申请进度',
          HttpStatus.CONFLICT,
          {
            currentStatus: invoice.status,
            currentUpdatedAt: invoice.updatedAt.toISOString(),
          },
        );
      }
      if (operation === 'update' && !invoice) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '当前订单没有发票申请',
          HttpStatus.NOT_FOUND,
        );
      }
      const expectedUpdatedAt =
        operation === 'update' && 'expectedUpdatedAt' in input ? input.expectedUpdatedAt : null;
      if (invoice && expectedUpdatedAt !== invoice.updatedAt.toISOString()) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '发票状态或资料已经更新，请刷新后重新确认',
          HttpStatus.CONFLICT,
          {
            currentStatus: invoice.status,
            currentUpdatedAt: invoice.updatedAt.toISOString(),
          },
        );
      }
      if (operation === 'create') {
        [invoice] = await tx
          .insert(invoiceRequests)
          .values({
            requestNo: `INV${new Date().getFullYear()}${randomBytes(6).toString('hex').toUpperCase()}`,
            organizationId,
            eventId: scope.order.eventId,
            orderId,
            registrationId: scope.registration.id,
            amount: netPaidAmount,
            netPaidAmount,
            currency: 'CNY',
            status: 'awaiting_details',
          })
          .returning();
        await tx.insert(invoiceStateLogs).values({
          invoiceRequestId: invoice!.id,
          fromStatus: null,
          toStatus: 'awaiting_details',
          reason: '用户中心创建发票申请',
          metadata: { source: 'customer_account', customerUserId },
        });
      }
      const changed = await this.applyInvoiceBuyer(tx, invoice!, input, {
        source: 'customer_account',
        customerUserId,
      });
      if (changed) {
        await tx.insert(auditLogs).values({
          organizationId,
          eventId: scope.order.eventId,
          actorId: customerUserId,
          actorType: 'customer',
          action:
            invoice!.status === 'pending_review'
              ? 'invoice.customer.details.update'
              : 'invoice.customer.submit',
          resourceType: 'invoice_request',
          resourceId: invoice!.id,
          after: { orderId, buyerType: input.buyerType },
          traceId: crypto.randomUUID(),
        });
      }
      return invoice!.id;
    });
    return this.customerInvoiceDetail(organizationId, orderId, invoiceId);
  }

  async sendCustomerOrderInvoice(
    organizationId: string,
    customerUserId: string,
    orderId: string,
  ): Promise<CustomerInvoiceSendResult> {
    const db = this.db();
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`customer-invoice-send:${orderId}`}, 0))`,
      );
      const [scope] = await tx
        .select({ invoice: invoiceRequests })
        .from(invoiceRequests)
        .innerJoin(orders, eq(orders.id, invoiceRequests.orderId))
        .innerJoin(registrations, eq(registrations.id, orders.registrationId))
        .where(
          and(
            eq(invoiceRequests.orderId, orderId),
            eq(invoiceRequests.organizationId, organizationId),
            eq(registrations.customerUserId, customerUserId),
          ),
        )
        .for('update')
        .limit(1);
      if (!scope) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '发票申请不存在', HttpStatus.NOT_FOUND);
      }
      const invoice = scope.invoice;
      const [activeDocument] = await tx
        .select({ id: invoiceDocuments.id })
        .from(invoiceDocuments)
        .where(
          and(eq(invoiceDocuments.invoiceRequestId, invoice.id), isNull(invoiceDocuments.voidedAt)),
        )
        .orderBy(desc(invoiceDocuments.issuedAt))
        .limit(1);
      if (invoice.status !== 'issued' || !activeDocument || !invoice.email) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '已开具且接收邮箱完整时才能重新发送发票',
          HttpStatus.CONFLICT,
        );
      }
      if (invoice.deliveryStatus === 'queued') {
        return { queued: true, alreadyQueued: true, retryAfterSeconds: 0 };
      }
      const cooldownEndsAt = invoice.lastSentAt ? invoice.lastSentAt.getTime() + 10 * 60_000 : 0;
      const retryAfterSeconds = Math.max(0, Math.ceil((cooldownEndsAt - Date.now()) / 1000));
      if (retryAfterSeconds > 0) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          `发票刚刚发送过，请在 ${Math.ceil(retryAfterSeconds / 60)} 分钟后重试`,
          HttpStatus.TOO_MANY_REQUESTS,
          { retryAfterSeconds },
        );
      }
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId: invoice.eventId,
        eventType: 'InvoiceDeliveryRequested',
        correlationId: `invoice:customer-send:${invoice.id}:${Date.now()}`,
        payload: {
          invoiceId: invoice.id,
          documentId: activeDocument.id,
          recipient: invoice.email,
          requestedBy: customerUserId,
          requestedByType: 'customer',
        },
      });
      await tx
        .update(invoiceRequests)
        .set({ deliveryStatus: 'queued', updatedAt: new Date() })
        .where(eq(invoiceRequests.id, invoice.id));
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: invoice.eventId,
        actorId: customerUserId,
        actorType: 'customer',
        action: 'invoice.customer.send',
        resourceType: 'invoice_request',
        resourceId: invoice.id,
        after: { documentId: activeDocument.id },
        traceId: crypto.randomUUID(),
      });
      return { queued: true, alreadyQueued: false, retryAfterSeconds: 0 };
    });
  }

  async submitOrderInvoice(orderId: string, accessToken: string, input: InvoiceBuyer) {
    await this.orderToken(accessToken, orderId, 'invoice:write');
    const [invoice] = await this.db()
      .select({ id: invoiceRequests.id })
      .from(invoiceRequests)
      .where(eq(invoiceRequests.orderId, orderId))
      .limit(1);
    if (!invoice) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '当前订单没有发票申请',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.submitDetails(invoice.id, { ...input, accessToken });
  }

  async resolveInvoiceDownload(
    orderId: string,
    documentId: string,
    expires: number,
    signature: string,
  ) {
    if (
      !Number.isSafeInteger(expires) ||
      expires <= Date.now() ||
      expires > Date.now() + 11 * 60_000
    ) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '发票下载链接无效或已经过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const expected = Buffer.from(this.downloadSignature(orderId, documentId, expires), 'hex');
    const received = Buffer.from(signature, 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '发票下载链接签名无效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const [document] = await this.db()
      .select({
        document: invoiceDocuments,
        invoice: invoiceRequests,
      })
      .from(invoiceDocuments)
      .innerJoin(invoiceRequests, eq(invoiceRequests.id, invoiceDocuments.invoiceRequestId))
      .where(
        and(
          eq(invoiceDocuments.id, documentId),
          eq(invoiceRequests.orderId, orderId),
          isNull(invoiceDocuments.voidedAt),
        ),
      )
      .limit(1);
    if (!document) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '可下载的发票文件不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    const downloadUrl = this.s3Presigned(document.document.storageKey, 'GET');
    if (!downloadUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法下载发票文件',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.db().insert(auditLogs).values({
      organizationId: document.invoice.organizationId,
      eventId: document.invoice.eventId,
      action: 'invoice.document.download',
      resourceType: 'invoice_document',
      resourceId: document.document.id,
      after: { orderId },
      traceId: crypto.randomUUID(),
    });
    return downloadUrl;
  }

  async submitDetails(invoiceId: string, input: SubmitInvoiceDetails) {
    const tokenHash = this.tokenHash(input.accessToken);
    const db = this.db();
    const result = await db.transaction(async (tx) => {
      const [token] = await tx
        .select()
        .from(orderAccessTokens)
        .where(and(eq(orderAccessTokens.tokenHash, tokenHash), isNull(orderAccessTokens.revokedAt)))
        .for('update')
        .limit(1);
      if (!token || token.expiresAt <= new Date() || !token.scopes.includes('invoice:write')) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '发票访问链接无效或已经过期',
          HttpStatus.UNAUTHORIZED,
        );
      }
      const [invoice] = await tx
        .select()
        .from(invoiceRequests)
        .where(and(eq(invoiceRequests.id, invoiceId), eq(invoiceRequests.orderId, token.orderId)))
        .for('update')
        .limit(1);
      if (!invoice) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '发票申请不存在', HttpStatus.NOT_FOUND);
      }
      await this.applyInvoiceBuyer(tx, invoice, input, { source: 'attendee' });
      await tx
        .update(orderAccessTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(orderAccessTokens.id, token.id));
      return { organizationId: invoice.organizationId, orderId: invoice.orderId };
    });
    return this.customerInvoiceDetail(result.organizationId, result.orderId, invoiceId);
  }
}
