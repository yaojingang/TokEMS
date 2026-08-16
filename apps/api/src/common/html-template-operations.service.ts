import { createHash, createHmac, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  ConferenceTemplateDefinitionSchema,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  DEMO_EVENT,
  HtmlTemplateAiProposalOutputSchema,
  HtmlTemplateBindingManifestSchema,
  OrganizationSettingsSchema,
  normalizeConferenceTemplateDefinition,
  publicEventHomePath,
  publicEventScopedPath,
  type HtmlTemplateBindingManifest,
  type HtmlTemplateVariablePath,
} from '@conference/contracts';
import {
  HTML_TEMPLATE_VARIABLE_CATALOG,
  HTML_TEMPLATE_VARIABLE_CATALOG_VERSION,
  compileHtmlTemplate,
  renderHtmlTemplate,
  sanitizeHtmlTemplate,
  sha256Digest,
  suggestTemplateBindings,
  templateAssetIdFromUrl,
  type HtmlTemplateNode,
  type HtmlTemplateSecurityReport,
} from '@conference/html-template';
import {
  aiRuns,
  auditLogs,
  conferenceTemplateDrafts,
  conferenceTemplateVersions,
  conferenceTemplates,
  eventReleases,
  events,
  organizations,
  outboxEvents,
  templateAiMappingActions,
  templateAssets,
  templateHtmlDocuments,
  templateHtmlImportAssets,
  templateHtmlImports,
  templatePackages,
} from '@conference/database';
import { and, count, desc, eq, gte, inArray, sql, sum } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { ConferenceRepository } from './conference.repository.js';
import { readUploadWithinLimit } from './object-storage-verification.js';

type Database = NonNullable<DatabaseService['db']>;
type HtmlImportRow = typeof templateHtmlImports.$inferSelect;

interface PrepareHtmlImportInput {
  fileName: string;
  size: number;
  sourceDigest: string;
  mode: 'create' | 'replace';
  templateId?: string | undefined;
  requestedMetadata: {
    name?: string | undefined;
    description?: string | undefined;
    tags?: string[] | undefined;
    sourceUrl?: string | undefined;
  };
}

interface CommitHtmlImportInput {
  revision?: number | undefined;
  bindings: HtmlTemplateBindingManifest;
  confirmWarnings: boolean;
  name?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
}

const HTML_SOURCE_MEDIA_TYPE = 'text/html; charset=utf-8';
const IMPORT_TTL_MS = 24 * 60 * 60_000;
const MAX_PENDING_IMPORT_COUNT = 20;
const MAX_PENDING_IMPORT_BYTES = 20 * 1024 * 1024;

function deterministicUuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4]!;
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function normalizedDigest(value: string): string {
  const stripped = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, '');
  return `sha256:${stripped}`;
}

export function publishedHtmlEtag(html: string) {
  return `"${createHash('sha256').update(html).digest('hex')}"`;
}

export function redactRemoteResourceUrl(value: string) {
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

export function htmlImportStagedAssetIds(row: Pick<HtmlImportRow, 'assetManifest'>) {
  return (row.assetManifest as Array<{ assetId?: unknown; staged?: unknown }>)
    .filter((item) => item.staged === true)
    .map((item) => item.assetId)
    .filter((assetId): assetId is string => typeof assetId === 'string');
}

function usedVariables(manifest: HtmlTemplateBindingManifest) {
  const used = new Set<HtmlTemplateVariablePath>();
  const required = new Set<HtmlTemplateVariablePath>();
  for (const binding of manifest.bindings) {
    if (binding.kind === 'text') {
      for (const segment of binding.segments) {
        if (segment.kind !== 'variable') continue;
        used.add(segment.path);
        if (binding.missingPolicy === 'error') required.add(segment.path);
      }
    } else if (binding.kind === 'attribute') {
      used.add(binding.variablePath);
      required.add(binding.variablePath);
    } else if (binding.kind === 'conditional') {
      used.add(binding.variablePath);
    } else {
      used.add(binding.collectionPath);
      binding.children.forEach((child) => used.add(child.variablePath));
    }
  }
  return { used: [...used].sort(), required: [...required].sort() };
}

export function htmlTemplateSampleContext(): Record<string, unknown> {
  return {
    event: {
      name: DEMO_EVENT.name,
      shortName: DEMO_EVENT.shortName,
      tagline: DEMO_EVENT.tagline,
      description: DEMO_EVENT.description,
      startsAt: DEMO_EVENT.startsAt,
      endsAt: DEMO_EVENT.endsAt,
      timezone: DEMO_EVENT.timezone,
      venue: DEMO_EVENT.venue,
      city: DEMO_EVENT.city,
      address: DEMO_EVENT.address,
      stats: DEMO_EVENT.stats,
    },
    tickets: DEMO_EVENT.tickets,
    speakers: DEMO_EVENT.speakers,
    sessions: DEMO_EVENT.sessions,
    faqs: DEMO_EVENT.faqs,
    routes: { registration: '/register', faq: '/faq', account: '/account' },
    site: {
      footerText: 'GEO大会组委会',
      supportEmail: '',
      icpNumber: '',
    },
  };
}

@Injectable()
export class HtmlTemplateOperationsService {
  private readonly compiledCache = new Map<string, ReturnType<typeof compileHtmlTemplate>>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConferenceRepository) private readonly conference: ConferenceRepository,
  ) {}

  private db(): Database {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'HTML 模板需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private assertFeatureEnabled(organizationId: string) {
    if (process.env.HTML_TEMPLATE_IMPORT_ENABLED === 'false') {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'HTML 模板导入尚未开放',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const allowlist = (process.env.HTML_TEMPLATE_IMPORT_ORG_ALLOWLIST ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (allowlist.length && !allowlist.includes(organizationId)) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '当前组织尚未进入 HTML 模板灰度名单',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private s3Presigned(
    storageKey: string,
    method: 'GET' | 'PUT',
    mediaType?: string,
    endpointOverride?: string,
    contentLength?: number,
  ) {
    const endpoint = endpointOverride ?? process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT;
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
        ? contentLength
          ? 'content-length;content-type;host;if-none-match'
          : 'content-type;host;if-none-match'
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
    const canonicalHeaders = `${contentLength ? `content-length:${contentLength}\n` : ''}${mediaType ? `content-type:${mediaType}\n` : ''}host:${endpointUrl.host}\n${method === 'PUT' ? 'if-none-match:*\n' : ''}`;
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

  private async scopedImport(organizationId: string, importId: string) {
    const [row] = await this.db()
      .select()
      .from(templateHtmlImports)
      .where(
        and(
          eq(templateHtmlImports.id, importId),
          eq(templateHtmlImports.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, 'HTML 导入任务不存在', HttpStatus.NOT_FOUND);
    }
    if (row.expiresAt.getTime() <= Date.now() && row.status !== 'committed') {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'HTML 导入任务已经过期，请重新上传',
        HttpStatus.GONE,
      );
    }
    return row;
  }

  private importResult(row: HtmlImportRow) {
    const nodes = row.nodeManifest as unknown as HtmlTemplateNode[];
    return {
      id: row.id,
      templateId: row.templateId,
      mode: row.mode,
      status: row.status,
      originalFilename: row.originalFilename,
      sourceDigest: row.sourceDigest,
      sourceSize: row.sourceSize,
      sanitizedDigest: row.sanitizedDigest,
      nodeManifest: nodes,
      assetManifest: row.assetManifest,
      securityReport: row.securityReport,
      requestedMetadata: row.requestedMetadata,
      suggestions: row.sanitizedHtml ? suggestTemplateBindings(nodes) : [],
      committedTemplateId: row.committedTemplateId,
      committedDocumentId: row.committedDocumentId,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async prepareImport(
    organizationId: string,
    actorId: string,
    input: PrepareHtmlImportInput,
    commandKey?: string,
  ) {
    this.assertFeatureEnabled(organizationId);
    if (input.mode === 'replace' && !input.templateId) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '替换 HTML 时需要指定模板',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (input.templateId) {
      const [template] = await this.db()
        .select({ id: conferenceTemplates.id })
        .from(conferenceTemplates)
        .where(
          and(
            eq(conferenceTemplates.id, input.templateId),
            eq(conferenceTemplates.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!template) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '目标模板不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
    }
    const importId = commandKey
      ? deterministicUuid(
          `template-html-import:prepare:${organizationId}:${commandKey}:${sha256Digest(JSON.stringify(input))}`,
        )
      : randomUUID();
    const storageKey = `template-imports/${organizationId}/${importId}/source.html`;
    const uploadUrl = this.s3Presigned(
      storageKey,
      'PUT',
      HTML_SOURCE_MEDIA_TYPE,
      undefined,
      input.size,
    );
    if (!uploadUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法导入 HTML',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const row = await this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`template-html-imports:${organizationId}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(templateHtmlImports)
        .where(
          and(
            eq(templateHtmlImports.id, importId),
            eq(templateHtmlImports.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.expiresAt <= new Date() || existing.status === 'expired') {
          throw new DomainError(
            API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            '原 HTML 导入任务已经过期，请使用新的 Idempotency-Key',
            HttpStatus.CONFLICT,
          );
        }
        return existing;
      }
      const [pending] = await tx
        .select({ count: count(), bytes: sum(templateHtmlImports.sourceSize) })
        .from(templateHtmlImports)
        .where(
          and(
            eq(templateHtmlImports.organizationId, organizationId),
            inArray(templateHtmlImports.status, [
              'awaiting_upload',
              'queued',
              'scanning',
              'needs_review',
              'ready',
              'failed',
            ]),
            gte(templateHtmlImports.expiresAt, new Date()),
          ),
        );
      if (
        (pending?.count ?? 0) >= MAX_PENDING_IMPORT_COUNT ||
        Number(pending?.bytes ?? 0) + input.size > MAX_PENDING_IMPORT_BYTES
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前组织待处理的 HTML 导入已达上限，请先完成或取消已有任务',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const [created] = await tx
        .insert(templateHtmlImports)
        .values({
          id: importId,
          organizationId,
          templateId: input.templateId,
          mode: input.mode,
          originalFilename: input.fileName,
          sourceStorageKey: storageKey,
          sourceDigest: normalizedDigest(input.sourceDigest),
          sourceSize: input.size,
          requestedMetadata: {
            ...input.requestedMetadata,
            ...(input.requestedMetadata.sourceUrl
              ? { sourceUrl: redactRemoteResourceUrl(input.requestedMetadata.sourceUrl) }
              : {}),
          },
          expiresAt: new Date(Date.now() + IMPORT_TTL_MS),
          createdBy: actorId,
        })
        .returning();
      return created!;
    });
    return {
      import: this.importResult(row),
      upload: {
        uploadUrl,
        method: 'PUT' as const,
        headers: { 'Content-Type': HTML_SOURCE_MEDIA_TYPE, 'If-None-Match': '*' },
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
  }

  async readImport(organizationId: string, importId: string) {
    return this.importResult(await this.scopedImport(organizationId, importId));
  }

  async listImports(organizationId: string) {
    const rows = await this.db()
      .select()
      .from(templateHtmlImports)
      .where(eq(templateHtmlImports.organizationId, organizationId))
      .orderBy(desc(templateHtmlImports.createdAt))
      .limit(50);
    return rows.map((row) => this.importResult(row));
  }

  async cancelImport(organizationId: string, importId: string, actorId: string) {
    return this.db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(templateHtmlImports)
        .where(
          and(
            eq(templateHtmlImports.id, importId),
            eq(templateHtmlImports.organizationId, organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!row) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          'HTML 导入任务不存在',
          HttpStatus.NOT_FOUND,
        );
      }
      if (row.status === 'committed') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '已创建模板的导入任务不能取消',
          HttpStatus.CONFLICT,
        );
      }
      if (row.status === 'expired') return this.importResult(row);
      const leasedAssets = await tx
        .select({ assetId: templateHtmlImportAssets.assetId })
        .from(templateHtmlImportAssets)
        .where(
          and(
            eq(templateHtmlImportAssets.importId, row.id),
            eq(templateHtmlImportAssets.organizationId, organizationId),
          ),
        );
      const [updated] = await tx
        .update(templateHtmlImports)
        .set({ status: 'expired', scanLeaseToken: null, updatedAt: new Date() })
        .where(
          and(
            eq(templateHtmlImports.id, row.id),
            eq(templateHtmlImports.organizationId, organizationId),
          ),
        )
        .returning();
      await tx.insert(outboxEvents).values({
        organizationId,
        eventType: 'TemplateHtmlImportCleanupRequested',
        correlationId: `template-html-import-cleanup:${row.id}`,
        payload: {
          importId: row.id,
          organizationId,
          storageKey: row.sourceStorageKey,
          assetIds: leasedAssets.map((asset) => asset.assetId),
        },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.html_import.cancel',
        resourceType: 'template_html_import',
        resourceId: row.id,
        after: { storageKey: row.sourceStorageKey },
        traceId: randomUUID(),
      });
      return this.importResult(updated!);
    });
  }

  async scanImport(organizationId: string, importId: string, actorId: string) {
    return this.db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(templateHtmlImports)
        .where(
          and(
            eq(templateHtmlImports.id, importId),
            eq(templateHtmlImports.organizationId, organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!row) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          'HTML 导入任务不存在',
          HttpStatus.NOT_FOUND,
        );
      }
      if (row.expiresAt.getTime() <= Date.now() && row.status !== 'committed') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'HTML 导入任务已经过期，请重新上传',
          HttpStatus.GONE,
        );
      }
      if (['queued', 'scanning', 'ready', 'needs_review', 'committed'].includes(row.status)) {
        return this.importResult(row);
      }
      if (!['awaiting_upload', 'failed'].includes(row.status)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前导入状态不能开始扫描',
          HttpStatus.CONFLICT,
        );
      }
      const [queued] = await tx
        .update(templateHtmlImports)
        .set({
          status: 'queued',
          scanLeaseToken: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(and(eq(templateHtmlImports.id, row.id), eq(templateHtmlImports.status, row.status)))
        .returning();
      await tx.insert(outboxEvents).values({
        organizationId,
        eventType: 'TemplateHtmlImportScanRequested',
        correlationId: `template-html-import-scan:${row.id}:${randomUUID()}`,
        payload: { importId: row.id },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.html_import.scan_requested',
        resourceType: 'template_html_import',
        resourceId: row.id,
        after: { previousStatus: row.status },
        traceId: randomUUID(),
      });
      return this.importResult(queued!);
    });
  }

  private async htmlRenderer(db: Database) {
    const [renderer] = await db
      .select()
      .from(templatePackages)
      .where(
        and(eq(templatePackages.key, 'html-liquid-v1'), eq(templatePackages.status, 'published')),
      )
      .orderBy(desc(templatePackages.version))
      .limit(1);
    if (!renderer) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '系统尚未安装 HTML 智能模板渲染器，请先执行最新种子或迁移',
        HttpStatus.CONFLICT,
      );
    }
    return renderer;
  }

  private validateCommit(row: HtmlImportRow, input: CommitHtmlImportInput) {
    if (!row.sanitizedHtml || !row.sanitizedDigest || !row.sourceDigest || !row.sourceSize) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'HTML 扫描尚未完成',
        HttpStatus.CONFLICT,
      );
    }
    if (!['ready', 'needs_review'].includes(row.status)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '当前导入状态不能提交',
        HttpStatus.CONFLICT,
      );
    }
    const report = row.securityReport as unknown as HtmlTemplateSecurityReport;
    if (report.blockers?.length) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'HTML 仍有阻塞项，请先处理资源或安全问题',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { blockers: report.blockers },
      );
    }
    if (row.status === 'needs_review' && !input.confirmWarnings) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '请确认扫描告警后再创建模板',
        HttpStatus.CONFLICT,
      );
    }
    const bindings = HtmlTemplateBindingManifestSchema.parse(input.bindings);
    const compiled = compileHtmlTemplate(row.sanitizedHtml, bindings);
    return { bindings, compiled };
  }

  async commitImport(
    organizationId: string,
    importId: string,
    actorId: string,
    input: CommitHtmlImportInput,
  ) {
    const renderer = await this.htmlRenderer(this.db());
    return this.db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(templateHtmlImports)
        .where(
          and(
            eq(templateHtmlImports.id, importId),
            eq(templateHtmlImports.organizationId, organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!row) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          'HTML 导入任务不存在',
          HttpStatus.NOT_FOUND,
        );
      }
      if (row.expiresAt.getTime() <= Date.now() && row.status !== 'committed') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'HTML 导入任务已经过期，请重新上传',
          HttpStatus.GONE,
        );
      }
      if (row.status === 'committed' && row.committedTemplateId) {
        return { templateId: row.committedTemplateId, documentId: row.committedDocumentId };
      }

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
      );
      const manifestAssets = (row.assetManifest as Array<Record<string, unknown>>).map((item) => {
        const assetId = typeof item.assetId === 'string' ? item.assetId : null;
        const targetUrl = typeof item.targetUrl === 'string' ? item.targetUrl : '';
        const urlAssetId = templateAssetIdFromUrl(targetUrl);
        if (!assetId || urlAssetId !== assetId) {
          throw new DomainError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'HTML 导入包含无效的内部资产引用，请重新扫描',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        return assetId;
      });
      const uniqueAssetIds = [...new Set(manifestAssets)];
      if (uniqueAssetIds.length) {
        const persistedAssets = await tx
          .select({ id: templateAssets.id })
          .from(templateAssets)
          .where(
            and(
              eq(templateAssets.organizationId, organizationId),
              inArray(templateAssets.id, uniqueAssetIds),
            ),
          );
        if (persistedAssets.length !== uniqueAssetIds.length) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            'HTML 导入引用的资产已经变化，请重新扫描',
            HttpStatus.CONFLICT,
          );
        }
      }

      const { bindings, compiled } = this.validateCommit(row, input);
      await renderHtmlTemplate(compiled, htmlTemplateSampleContext());
      const variables = usedVariables(bindings);
      const templateId = row.mode === 'replace' ? row.templateId! : randomUUID();
      const documentId = randomUUID();

      if (row.mode === 'create') {
        const metadata = row.requestedMetadata as PrepareHtmlImportInput['requestedMetadata'] & {
          extracted?: { title?: string };
        };
        const name =
          input.name?.trim() ||
          metadata.name?.trim() ||
          metadata.extracted?.title?.trim() ||
          'HTML 大会模板';
        const description =
          input.description?.trim() ||
          metadata.description?.trim() ||
          '通过 HTML 文件导入的大会首页模板。';
        await tx.insert(conferenceTemplates).values({
          id: templateId,
          organizationId,
          code: `html-${nanoid(10).toLowerCase()}`,
          name,
          description,
          tags: [...new Set(input.tags ?? metadata.tags ?? ['HTML 模板'])],
          createdBy: actorId,
          updatedBy: actorId,
        });
      } else {
        const [root] = await tx
          .select({ id: conferenceTemplates.id })
          .from(conferenceTemplates)
          .where(
            and(
              eq(conferenceTemplates.id, templateId),
              eq(conferenceTemplates.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!root) {
          throw new DomainError(
            API_ERROR_CODES.NOT_FOUND,
            '目标模板不存在或无权访问',
            HttpStatus.NOT_FOUND,
          );
        }
      }

      await tx.insert(templateHtmlDocuments).values({
        id: documentId,
        organizationId,
        templateId,
        originalFilename: row.originalFilename,
        sourceStorageKey: row.sourceStorageKey,
        sourceDigest: row.sourceDigest!,
        sourceSize: row.sourceSize!,
        sanitizedHtml: row.sanitizedHtml!,
        sanitizedDigest: row.sanitizedDigest!,
        nodeManifest: row.nodeManifest,
        assetManifest: row.assetManifest,
        securityReport: row.securityReport,
        metadata: row.requestedMetadata,
        compilerVersion: compiled.compilerVersion,
        createdBy: actorId,
      });

      const existingDraft =
        row.mode === 'replace'
          ? (
              await tx
                .select()
                .from(conferenceTemplateDrafts)
                .where(eq(conferenceTemplateDrafts.templateId, templateId))
                .for('update')
                .limit(1)
            )[0]
          : undefined;
      if (existingDraft && existingDraft.revision !== input.revision) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '模板草稿已经被其他成员更新',
          HttpStatus.CONFLICT,
          { currentRevision: existingDraft.revision },
        );
      }
      const base = existingDraft
        ? normalizeConferenceTemplateDefinition(existingDraft.definition)
        : structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
      const definition = ConferenceTemplateDefinitionSchema.parse({
        ...base,
        presentation: {
          kind: 'html',
          documentId,
          engine: 'liquid-v1',
          catalogVersion: HTML_TEMPLATE_VARIABLE_CATALOG_VERSION,
          bindings,
          bindingDigest: compiled.bindingDigest,
          sanitizedDigest: row.sanitizedDigest,
          sourceDigest: row.sourceDigest,
          compilerVersion: compiled.compilerVersion,
          usedVariables: variables.used,
          requiredVariables: variables.required,
          actions: bindings.bindings
            .filter((binding) => binding.kind === 'attribute')
            .map((binding) => ({
              nodeId: binding.nodeId,
              kind: binding.variablePath.split('.')[1] as 'registration' | 'faq' | 'account',
              href: binding.variablePath,
            })),
          securityReportDigest: sha256Digest(JSON.stringify(row.securityReport)),
        },
      });
      const contentDigest = sha256Digest(
        JSON.stringify({
          definition,
          document: row.sanitizedDigest,
          bindings: compiled.bindingDigest,
        }),
      );
      if (existingDraft) {
        await tx
          .update(conferenceTemplateDrafts)
          .set({
            rendererPackageId: renderer.id,
            schemaVersion: 2,
            definition,
            revision: existingDraft.revision + 1,
            contentDigest,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(eq(conferenceTemplateDrafts.templateId, templateId));
      } else {
        await tx.insert(conferenceTemplateDrafts).values({
          templateId,
          rendererPackageId: renderer.id,
          schemaVersion: 2,
          definition,
          revision: 0,
          contentDigest,
          updatedBy: actorId,
        });
      }
      await tx
        .update(templateHtmlImports)
        .set({
          status: 'committed',
          scanLeaseToken: null,
          committedTemplateId: templateId,
          committedDocumentId: documentId,
          updatedAt: new Date(),
        })
        .where(eq(templateHtmlImports.id, row.id));
      await tx
        .update(templateHtmlImportAssets)
        .set({ releasedAt: new Date() })
        .where(
          and(
            eq(templateHtmlImportAssets.importId, row.id),
            eq(templateHtmlImportAssets.organizationId, organizationId),
          ),
        );
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action:
          row.mode === 'create' ? 'template.html_import.create' : 'template.html_import.replace',
        resourceType: 'conference_template',
        resourceId: templateId,
        after: {
          importId: row.id,
          documentId,
          sanitizedDigest: row.sanitizedDigest,
          bindingDigest: compiled.bindingDigest,
          bindingCount: bindings.bindings.length,
        },
        traceId: crypto.randomUUID(),
      });
      return { templateId, documentId };
    });
  }

  async htmlDocument(organizationId: string, templateId: string) {
    const [draft] = await this.db()
      .select({
        definition: conferenceTemplateDrafts.definition,
        revision: conferenceTemplateDrafts.revision,
      })
      .from(conferenceTemplateDrafts)
      .innerJoin(
        conferenceTemplates,
        eq(conferenceTemplates.id, conferenceTemplateDrafts.templateId),
      )
      .where(
        and(
          eq(conferenceTemplateDrafts.templateId, templateId),
          eq(conferenceTemplates.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!draft) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '模板草稿不存在', HttpStatus.NOT_FOUND);
    }
    const definition = normalizeConferenceTemplateDefinition(draft.definition);
    if (definition.presentation.kind !== 'html') {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '当前模板使用结构化首页',
        HttpStatus.CONFLICT,
      );
    }
    const [document] = await this.db()
      .select()
      .from(templateHtmlDocuments)
      .where(
        and(
          eq(templateHtmlDocuments.id, definition.presentation.documentId),
          eq(templateHtmlDocuments.organizationId, organizationId),
          eq(templateHtmlDocuments.templateId, templateId),
        ),
      )
      .limit(1);
    if (!document) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, 'HTML 文档不存在', HttpStatus.NOT_FOUND);
    }
    return { document, definition, revision: draft.revision };
  }

  async documentDetail(organizationId: string, templateId: string) {
    const { document, definition, revision } = await this.htmlDocument(organizationId, templateId);
    return {
      id: document.id,
      templateId,
      originalFilename: document.originalFilename,
      sourceDigest: document.sourceDigest,
      sourceSize: document.sourceSize,
      sanitizedHtml: document.sanitizedHtml,
      sanitizedDigest: document.sanitizedDigest,
      nodeManifest: document.nodeManifest,
      assetManifest: document.assetManifest,
      securityReport: document.securityReport,
      metadata: document.metadata,
      compilerVersion: document.compilerVersion,
      bindings: definition.presentation.kind === 'html' ? definition.presentation.bindings : null,
      bindingDigest:
        definition.presentation.kind === 'html' ? definition.presentation.bindingDigest : null,
      revision,
      createdAt: document.createdAt.toISOString(),
    };
  }

  async saveBindings(
    organizationId: string,
    templateId: string,
    actorId: string,
    revision: number,
    manifestInput: HtmlTemplateBindingManifest,
  ) {
    const { document, definition } = await this.htmlDocument(organizationId, templateId);
    const manifest = HtmlTemplateBindingManifestSchema.parse(manifestInput);
    const compiled = compileHtmlTemplate(document.sanitizedHtml, manifest);
    await renderHtmlTemplate(compiled, htmlTemplateSampleContext());
    const variables = usedVariables(manifest);
    const nextDefinition = ConferenceTemplateDefinitionSchema.parse({
      ...definition,
      presentation: {
        ...definition.presentation,
        bindings: manifest,
        bindingDigest: compiled.bindingDigest,
        usedVariables: variables.used,
        requiredVariables: variables.required,
        actions: manifest.bindings
          .filter((binding) => binding.kind === 'attribute')
          .map((binding) => ({
            nodeId: binding.nodeId,
            kind: binding.variablePath.split('.')[1] as 'registration' | 'faq' | 'account',
            href: binding.variablePath,
          })),
      },
    });
    const contentDigest = sha256Digest(
      JSON.stringify({
        definition: nextDefinition,
        document: document.sanitizedDigest,
        bindings: compiled.bindingDigest,
      }),
    );
    const [updated] = await this.db()
      .update(conferenceTemplateDrafts)
      .set({
        definition: nextDefinition,
        schemaVersion: 2,
        contentDigest,
        revision: revision + 1,
        updatedBy: actorId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(conferenceTemplateDrafts.templateId, templateId),
          eq(conferenceTemplateDrafts.revision, revision),
        ),
      )
      .returning({ revision: conferenceTemplateDrafts.revision });
    if (!updated) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '模板草稿已经被其他成员更新，请重新加载',
        HttpStatus.CONFLICT,
      );
    }
    await this.db()
      .insert(auditLogs)
      .values({
        organizationId,
        actorId,
        action: 'template.html_bindings.save',
        resourceType: 'conference_template',
        resourceId: templateId,
        after: { bindingDigest: compiled.bindingDigest, bindingCount: manifest.bindings.length },
        traceId: crypto.randomUUID(),
      });
    return {
      revision: updated.revision,
      bindings: manifest,
      bindingDigest: compiled.bindingDigest,
      usedVariables: variables.used,
      requiredVariables: variables.required,
    };
  }

  async renderPreview(
    organizationId: string,
    templateId: string,
    manifestInput?: HtmlTemplateBindingManifest,
  ) {
    const { document, definition, revision } = await this.htmlDocument(organizationId, templateId);
    const manifest = HtmlTemplateBindingManifestSchema.parse(
      manifestInput ??
        (definition.presentation.kind === 'html'
          ? definition.presentation.bindings
          : { version: 1, bindings: [] }),
    );
    const compiled = compileHtmlTemplate(document.sanitizedHtml, manifest);
    const html = await renderHtmlTemplate(compiled, htmlTemplateSampleContext());
    return {
      html,
      revision,
      documentDigest: document.sanitizedDigest,
      bindingDigest: compiled.bindingDigest,
    };
  }

  async validatePublish(organizationId: string, templateId: string) {
    const [draft] = await this.db()
      .select({ definition: conferenceTemplateDrafts.definition })
      .from(conferenceTemplateDrafts)
      .innerJoin(
        conferenceTemplates,
        eq(conferenceTemplates.id, conferenceTemplateDrafts.templateId),
      )
      .where(
        and(
          eq(conferenceTemplateDrafts.templateId, templateId),
          eq(conferenceTemplates.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!draft) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '模板草稿不存在', HttpStatus.NOT_FOUND);
    }
    const definition = normalizeConferenceTemplateDefinition(draft.definition);
    if (definition.presentation.kind !== 'html') return { kind: 'structured' as const };
    const { document } = await this.htmlDocument(organizationId, templateId);
    const report = document.securityReport as unknown as HtmlTemplateSecurityReport;
    if (report.blockers?.length) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'HTML 模板仍有安全或资源阻塞项',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { blockers: report.blockers },
      );
    }
    const assetManifest = document.assetManifest as Array<{ url?: unknown; assetId?: unknown }>;
    const invalidResources = assetManifest.filter((resource) => {
      if (typeof resource.url !== 'string') return true;
      const assetId = templateAssetIdFromUrl(resource.url);
      return !assetId || resource.assetId !== assetId;
    });
    if (invalidResources.length) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'HTML 模板仍有未内化或无效的资源',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { resourceCount: invalidResources.length },
      );
    }
    const assetIds = [
      ...new Set(
        assetManifest.flatMap((resource) =>
          typeof resource.url === 'string' && templateAssetIdFromUrl(resource.url)
            ? [templateAssetIdFromUrl(resource.url)!]
            : [],
        ),
      ),
    ];
    if (assetIds.length) {
      const organizationAssets = await this.db()
        .select({ id: templateAssets.id })
        .from(templateAssets)
        .where(
          and(
            eq(templateAssets.organizationId, organizationId),
            inArray(templateAssets.id, assetIds),
          ),
        );
      if (organizationAssets.length !== assetIds.length) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'HTML 模板引用的资源不存在或不属于当前组织',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
    const compiled = compileHtmlTemplate(document.sanitizedHtml, definition.presentation.bindings);
    if (compiled.bindingDigest !== definition.presentation.bindingDigest) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '变量清单摘要与编译结果不一致',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const typical = htmlTemplateSampleContext();
    const minimal = structuredClone(typical) as Record<string, unknown> & {
      tickets: unknown[];
      speakers: unknown[];
      sessions: unknown[];
      faqs: unknown[];
    };
    minimal.tickets = [];
    minimal.speakers = [];
    minimal.sessions = [];
    minimal.faqs = [];
    const maximum = structuredClone(typical) as typeof minimal;
    const repeat = <T>(items: T[], count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...(items[index % items.length] as T & object),
      }));
    maximum.tickets = repeat(typical.tickets as object[], 20);
    maximum.speakers = repeat(typical.speakers as object[], 100);
    maximum.sessions = repeat(typical.sessions as object[], 200);
    maximum.faqs = repeat(typical.faqs as object[], 100);
    const outputs = await Promise.all(
      [minimal, typical, maximum].map((context) => renderHtmlTemplate(compiled, context)),
    );
    for (const output of outputs) {
      if (output.includes('{{') || output.includes('{%')) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'HTML 模板渲染后仍包含未解析变量',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const finalScan = sanitizeHtmlTemplate(output);
      if (
        finalScan.securityReport.removedTags.length ||
        finalScan.securityReport.removedAttributes.length ||
        finalScan.securityReport.blockers.length
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'HTML 模板最终渲染安全校验未通过',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
    return {
      kind: 'html' as const,
      compilerVersion: compiled.compilerVersion,
      bindingCount: definition.presentation.bindings.bindings.length,
      resourceCount: document.assetManifest.length,
      sampleCount: outputs.length,
    };
  }

  variableCatalog() {
    return {
      version: HTML_TEMPLATE_VARIABLE_CATALOG_VERSION,
      variables: HTML_TEMPLATE_VARIABLE_CATALOG,
      ai: {
        enabled: process.env.HTML_TEMPLATE_AI_MAPPING_ENABLED === 'true',
        configured: Boolean(
          process.env.AI_API_URL && process.env.AI_API_KEY && process.env.AI_MODEL,
        ),
        provider: process.env.AI_API_URL ? '平台配置的 AI 服务' : '',
        model: process.env.AI_MODEL ?? '',
      },
    };
  }

  private cacheCompiled(key: string, value: ReturnType<typeof compileHtmlTemplate>) {
    this.compiledCache.delete(key);
    this.compiledCache.set(key, value);
    while (this.compiledCache.size > 128) {
      const oldest = this.compiledCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.compiledCache.delete(oldest);
    }
    return value;
  }

  private systemHead(
    html: string,
    settings: ReturnType<typeof OrganizationSettingsSchema.parse>,
    eventName: string,
    eventSlug: string,
  ) {
    const escape = (value: string) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    const website = settings.website;
    const title = website.seoTitle || eventName;
    const canonicalPath = publicEventHomePath(eventSlug);
    const publicOrigin = (process.env.PUBLIC_ORIGIN ?? process.env.PUBLIC_SITE_URL ?? '').replace(
      /\/+$/u,
      '',
    );
    const canonicalUrl = publicOrigin ? `${publicOrigin}${canonicalPath}` : canonicalPath;
    const headParts = [
      `<title>${escape(title)}</title>`,
      `<link rel="canonical" href="${escape(canonicalUrl)}">`,
      `<meta property="og:url" content="${escape(canonicalUrl)}">`,
      website.seoDescription
        ? `<meta name="description" content="${escape(website.seoDescription)}">`
        : '',
      website.faviconUrl ? `<link rel="icon" href="${escape(website.faviconUrl)}">` : '',
    ];
    const cleaned = html
      .replace(/<title[\s\S]*?<\/title>/iu, '')
      .replace(/<meta\s+name=["']description["'][^>]*>/giu, '')
      .replace(/<meta\s+property=["']og:url["'][^>]*>/giu, '')
      .replace(/<link\s+[^>]*rel=["']canonical["'][^>]*>/giu, '')
      .replace(/<link\s+[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/giu, '');
    const injected = cleaned.replace(
      /<\/head>/iu,
      `${headParts.filter(Boolean).join('')}\n</head>`,
    );
    const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
    const assetOrigin = publicEndpoint ? new URL(publicEndpoint).origin : null;
    const csp = [
      "default-src 'none'",
      "script-src 'none'",
      "script-src-attr 'none'",
      "style-src 'unsafe-inline'",
      `img-src ${["'self'", ...(assetOrigin ? [assetOrigin] : [])].join(' ')}`,
      "font-src 'self'",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join('; ');
    return { html: injected, csp };
  }

  async renderPublishedHome(slug: string, organizationSlug: string) {
    const event = await this.conference.getPublicEvent(slug, organizationSlug);
    const presentation = event.experience?.presentation;
    if (!presentation || presentation.kind !== 'html') return null;
    const [version] = await this.db()
      .select()
      .from(conferenceTemplateVersions)
      .where(eq(conferenceTemplateVersions.id, event.experience!.template.versionId))
      .limit(1);
    if (!version) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会发布版本引用的 HTML 模板不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    const definition = normalizeConferenceTemplateDefinition(version.definition);
    if (definition.presentation.kind !== 'html') return null;
    const [document, organization] = await Promise.all([
      this.db()
        .select()
        .from(templateHtmlDocuments)
        .where(
          and(
            eq(templateHtmlDocuments.id, definition.presentation.documentId),
            eq(templateHtmlDocuments.organizationId, event.organizationId),
            eq(templateHtmlDocuments.templateId, version.templateId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]),
      this.db()
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, event.organizationId))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    if (!document || !organization) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会 HTML 发布文档不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    const cacheKey = `${version.id}:${definition.presentation.compilerVersion}:${definition.presentation.bindingDigest}`;
    const compiled =
      this.compiledCache.get(cacheKey) ??
      this.cacheCompiled(
        cacheKey,
        compileHtmlTemplate(document.sanitizedHtml, definition.presentation.bindings),
      );
    const context = {
      event: {
        name: event.name,
        shortName: event.shortName,
        tagline: event.tagline,
        description: event.description,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timezone: event.timezone,
        venue: event.venue,
        city: event.city,
        address: event.address,
        stats: event.stats,
      },
      tickets: event.tickets,
      speakers: event.speakers,
      sessions: event.sessions,
      faqs: event.faqs,
      routes: {
        registration: publicEventScopedPath('/register', event.slug),
        faq: publicEventScopedPath('/faq', event.slug),
        account: publicEventScopedPath('/account', event.slug),
      },
      site: OrganizationSettingsSchema.parse(organization.settings).website,
    };
    const rendered = (await renderHtmlTemplate(compiled, context)).replace(
      /\sdata-tok-[a-z0-9-]+=(?:"[^"]*"|'[^']*')/giu,
      '',
    );
    const settings = OrganizationSettingsSchema.parse(organization.settings);
    const result = this.systemHead(rendered, settings, event.name, event.slug);
    const etag = publishedHtmlEtag(result.html);
    return { ...result, etag };
  }

  async renderPublishedArtifactFallback(slug: string, organizationSlug: string) {
    const [scope] = await this.db()
      .select({
        eventId: events.id,
        eventName: events.name,
        eventStatus: events.status,
        eventSettings: events.settings,
        organizationSettings: organizations.settings,
      })
      .from(events)
      .innerJoin(organizations, eq(organizations.id, events.organizationId))
      .where(and(eq(events.slug, slug), eq(organizations.slug, organizationSlug)))
      .limit(1);
    if (
      !scope ||
      !['prepublished', 'registration_open', 'in_progress', 'ended'].includes(scope.eventStatus)
    ) {
      return null;
    }
    const currentReleaseId = (scope.eventSettings as { currentReleaseId?: string })
      .currentReleaseId;
    if (!currentReleaseId) return null;
    const [release] = await this.db()
      .select({ artifactKey: eventReleases.artifactKey })
      .from(eventReleases)
      .where(and(eq(eventReleases.id, currentReleaseId), eq(eventReleases.eventId, scope.eventId)))
      .limit(1);
    if (!release?.artifactKey.endsWith('.html')) return null;
    const downloadUrl = this.s3Presigned(
      release.artifactKey,
      'GET',
      undefined,
      process.env.S3_ENDPOINT,
    );
    if (!downloadUrl) return null;
    try {
      const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const artifactSize = Number(response.headers.get('content-length'));
      if (
        !Number.isSafeInteger(artifactSize) ||
        artifactSize <= 0 ||
        artifactSize > 2 * 1024 * 1024
      ) {
        return null;
      }
      const artifact = (await readUploadWithinLimit(response, artifactSize)).toString('utf8');
      const result = this.systemHead(
        artifact,
        OrganizationSettingsSchema.parse(scope.organizationSettings),
        scope.eventName,
        slug,
      );
      const etag = publishedHtmlEtag(result.html);
      return { ...result, etag };
    } catch {
      return null;
    }
  }

  async createAiMappingRun(
    organizationId: string,
    templateId: string,
    actorId: string,
    commandKey?: string,
    commandDigest = sha256Digest(JSON.stringify({ templateId })),
  ) {
    const runId = commandKey
      ? deterministicUuid(
          `template-ai-mapping:create:${organizationId}:${templateId}:${commandKey}:${commandDigest}`,
        )
      : randomUUID();
    if (commandKey) {
      const [existing] = await this.db()
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.id, runId),
            eq(aiRuns.organizationId, organizationId),
            eq(aiRuns.templateId, templateId),
          ),
        )
        .limit(1);
      if (existing) return this.aiRunResult(existing);
    }
    if (process.env.HTML_TEMPLATE_AI_MAPPING_ENABLED !== 'true') {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'AI 变量识别尚未开放',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const apiUrl = process.env.AI_API_URL;
    const apiKey = process.env.AI_API_KEY;
    const model = process.env.AI_MODEL;
    if (!apiUrl || !apiKey || !model) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'AI 服务未配置，仍可使用规则建议和人工映射',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const { document, definition, revision } = await this.htmlDocument(organizationId, templateId);
    if (definition.presentation.kind !== 'html') {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '当前模板不支持 HTML 变量识别',
        HttpStatus.CONFLICT,
      );
    }
    const htmlPresentation = definition.presentation;
    const now = new Date();
    const minuteLimit = Number(process.env.HTML_TEMPLATE_AI_ORG_MINUTE_LIMIT ?? 5);
    const dailyLimit = Number(process.env.HTML_TEMPLATE_AI_ORG_DAILY_LIMIT ?? 100);
    const sampleDigest = sha256Digest(JSON.stringify(htmlTemplateSampleContext()));
    const candidates = (document.nodeManifest as unknown as HtmlTemplateNode[])
      .filter((node) => node.bindable && node.text)
      .slice(0, 400)
      .map((node) => ({
        id: node.id,
        tag: node.tagName,
        text: node.text,
        href: node.attributes.href,
      }));
    const run = await this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`template-ai-quota:${organizationId}`}, 0))`,
      );
      const [existingByCommand] = await tx
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.id, runId),
            eq(aiRuns.organizationId, organizationId),
            eq(aiRuns.templateId, templateId),
          ),
        )
        .limit(1);
      if (existingByCommand) return existingByCommand;
      const [cached] = await tx
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.organizationId, organizationId),
            eq(aiRuns.templateId, templateId),
            eq(aiRuns.task, 'template_variable_mapping'),
            eq(aiRuns.status, 'review_ready'),
            eq(aiRuns.model, model),
            eq(aiRuns.documentDigest, document.sanitizedDigest),
            eq(aiRuns.bindingDigest, htmlPresentation.bindingDigest),
            eq(aiRuns.baseRevision, revision),
            eq(aiRuns.catalogVersion, HTML_TEMPLATE_VARIABLE_CATALOG_VERSION),
            eq(aiRuns.sampleDigest, sampleDigest),
            eq(aiRuns.promptVersion, 1),
          ),
        )
        .orderBy(desc(aiRuns.createdAt))
        .limit(1);
      if (cached) return cached;

      const [active] = await tx
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.organizationId, organizationId),
            eq(aiRuns.templateId, templateId),
            eq(aiRuns.task, 'template_variable_mapping'),
            inArray(aiRuns.status, ['queued', 'running']),
          ),
        )
        .limit(1);
      if (active) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前模板已有 AI 识别任务正在运行',
          HttpStatus.CONFLICT,
          { runId: active.id },
        );
      }

      const [minuteUsage] = await tx
        .select({ value: count() })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.organizationId, organizationId),
            eq(aiRuns.task, 'template_variable_mapping'),
            gte(aiRuns.createdAt, new Date(now.getTime() - 60_000)),
          ),
        );
      const [dailyUsage] = await tx
        .select({ value: count() })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.organizationId, organizationId),
            eq(aiRuns.task, 'template_variable_mapping'),
            gte(aiRuns.createdAt, new Date(now.getTime() - 24 * 60 * 60_000)),
          ),
        );
      if ((minuteUsage?.value ?? 0) >= minuteLimit || (dailyUsage?.value ?? 0) >= dailyLimit) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'AI 变量识别额度暂时用完，请稍后再试',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const [created] = await tx
        .insert(aiRuns)
        .values({
          id: runId,
          organizationId,
          templateId,
          createdBy: actorId,
          task: 'template_variable_mapping',
          input: { candidates, catalogVersion: HTML_TEMPLATE_VARIABLE_CATALOG_VERSION },
          output: '',
          status: 'queued',
          provider: 'configured-api',
          model,
          documentDigest: document.sanitizedDigest,
          bindingDigest: htmlPresentation.bindingDigest,
          baseRevision: revision,
          catalogVersion: HTML_TEMPLATE_VARIABLE_CATALOG_VERSION,
          sampleDigest,
          promptVersion: 1,
        })
        .returning();
      await tx.insert(outboxEvents).values({
        organizationId,
        eventType: 'TemplateVariableMappingRequested',
        correlationId: `template-ai-mapping:${runId}`,
        payload: { runId, templateId },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.ai_mapping.request',
        resourceType: 'ai_run',
        resourceId: runId,
        after: {
          templateId,
          documentDigest: document.sanitizedDigest,
          bindingDigest: htmlPresentation.bindingDigest,
          model,
        },
        traceId: randomUUID(),
      });
      return created!;
    });
    return this.aiRunResult(run);
  }

  private aiRunResult(row: typeof aiRuns.$inferSelect) {
    return {
      id: row.id,
      templateId: row.templateId,
      task: row.task,
      status: row.status,
      provider: row.provider,
      model: row.model,
      output: row.outputJson,
      documentDigest: row.documentDigest,
      bindingDigest: row.bindingDigest,
      baseRevision: row.baseRevision,
      catalogVersion: row.catalogVersion,
      sampleDigest: row.sampleDigest,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  async listAiRuns(organizationId: string, templateId: string) {
    const rows = await this.db()
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.organizationId, organizationId),
          eq(aiRuns.templateId, templateId),
          eq(aiRuns.task, 'template_variable_mapping'),
        ),
      )
      .orderBy(desc(aiRuns.createdAt))
      .limit(30);
    return rows.map((row) => this.aiRunResult(row));
  }

  async cancelAiMappingRun(
    organizationId: string,
    templateId: string,
    runId: string,
    actorId: string,
  ) {
    return this.db().transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.id, runId),
            eq(aiRuns.organizationId, organizationId),
            eq(aiRuns.templateId, templateId),
            eq(aiRuns.task, 'template_variable_mapping'),
          ),
        )
        .for('update')
        .limit(1);
      if (!run) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, 'AI 识别任务不存在', HttpStatus.NOT_FOUND);
      }
      if (!['queued', 'running'].includes(run.status)) return this.aiRunResult(run);
      const [updated] = await tx
        .update(aiRuns)
        .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(aiRuns.id, runId), inArray(aiRuns.status, ['queued', 'running'])))
        .returning();
      if (!updated) throw new Error('AI 识别任务取消状态更新失败');
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.ai_mapping.cancel',
        resourceType: 'ai_run',
        resourceId: runId,
        after: { templateId },
        traceId: randomUUID(),
      });
      return this.aiRunResult(updated);
    });
  }

  async rejectAiMappingRun(
    organizationId: string,
    templateId: string,
    runId: string,
    actorId: string,
  ) {
    const [run] = await this.db()
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.id, runId),
          eq(aiRuns.organizationId, organizationId),
          eq(aiRuns.templateId, templateId),
          eq(aiRuns.task, 'template_variable_mapping'),
        ),
      )
      .limit(1);
    if (run?.status === 'rejected') return { id: runId, status: 'rejected' as const };
    if (!run || run.status !== 'review_ready' || !run.outputJson) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'AI 建议不存在或已经处理',
        HttpStatus.CONFLICT,
      );
    }
    const output = HtmlTemplateAiProposalOutputSchema.parse(run.outputJson);
    await this.db().transaction(async (tx) => {
      const [claimed] = await tx
        .update(aiRuns)
        .set({ status: 'rejected', completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, 'review_ready')))
        .returning({ id: aiRuns.id });
      if (!claimed) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'AI 建议已经被其他成员处理',
          HttpStatus.CONFLICT,
        );
      }
      if (output.proposals.length) {
        await tx
          .insert(templateAiMappingActions)
          .values(
            output.proposals.map((proposal) => ({
              organizationId,
              templateId,
              runId,
              proposalId: proposal.proposalId,
              action: 'rejected',
              actorId,
              beforeBindingDigest: output.bindingDigest,
            })),
          )
          .onConflictDoNothing();
      }
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.ai_mapping.reject',
        resourceType: 'ai_run',
        resourceId: runId,
        after: { templateId, proposalCount: output.proposals.length },
        traceId: randomUUID(),
      });
    });
    return { id: runId, status: 'rejected' as const };
  }

  async applyAiProposals(
    organizationId: string,
    templateId: string,
    runId: string,
    actorId: string,
    proposalIds: string[],
  ) {
    const [run] = await this.db()
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.id, runId),
          eq(aiRuns.organizationId, organizationId),
          eq(aiRuns.templateId, templateId),
        ),
      )
      .limit(1);
    if (run?.outputJson && (run.status === 'completed' || run.status === 'partially_applied')) {
      const accepted = await this.db()
        .select()
        .from(templateAiMappingActions)
        .where(
          and(
            eq(templateAiMappingActions.runId, runId),
            eq(templateAiMappingActions.action, 'accepted'),
          ),
        );
      const requested = [...new Set(proposalIds)].sort();
      const recorded = accepted.map((action) => action.proposalId).sort();
      const snapshot = accepted[0]?.bindingSnapshot;
      const resultRevision = accepted[0]?.resultRevision;
      const resultDigest = accepted[0]?.afterBindingDigest;
      if (
        requested.length === recorded.length &&
        requested.every((proposalId, index) => proposalId === recorded[index]) &&
        snapshot &&
        resultRevision !== null &&
        resultRevision !== undefined &&
        resultDigest
      ) {
        const variables = usedVariables(snapshot);
        return {
          revision: resultRevision,
          bindings: snapshot,
          bindingDigest: resultDigest,
          usedVariables: variables.used,
          requiredVariables: variables.required,
        };
      }
    }
    if (!run || run.status !== 'review_ready' || !run.outputJson) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        'AI 建议不存在或已经处理',
        HttpStatus.CONFLICT,
      );
    }
    const output = HtmlTemplateAiProposalOutputSchema.parse(run.outputJson);
    const { definition, revision } = await this.htmlDocument(organizationId, templateId);
    if (
      definition.presentation.kind !== 'html' ||
      revision !== output.baseRevision ||
      definition.presentation.sanitizedDigest !== output.documentDigest ||
      definition.presentation.bindingDigest !== output.bindingDigest
    ) {
      await this.db()
        .update(aiRuns)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, 'review_ready')));
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '模板在 AI 识别后已经变化，请重新生成建议',
        HttpStatus.CONFLICT,
      );
    }
    const selected = output.proposals.filter((proposal) =>
      proposalIds.includes(proposal.proposalId),
    );
    if (selected.length !== new Set(proposalIds).size) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '包含不存在的 AI 建议',
        HttpStatus.BAD_REQUEST,
      );
    }
    const replacedTargets = new Set(
      selected.map(
        (proposal) =>
          `${proposal.binding.nodeId}:${proposal.binding.kind === 'attribute' ? 'attribute' : proposal.binding.kind}`,
      ),
    );
    const nextBindings = definition.presentation.bindings.bindings.filter(
      (binding) =>
        !replacedTargets.has(
          `${binding.nodeId}:${binding.kind === 'attribute' ? 'attribute' : binding.kind}`,
        ),
    );
    nextBindings.push(...selected.map((proposal) => proposal.binding));
    const manifest = HtmlTemplateBindingManifestSchema.parse({
      version: 1,
      bindings: nextBindings,
    });
    const { document } = await this.htmlDocument(organizationId, templateId);
    const compiled = compileHtmlTemplate(document.sanitizedHtml, manifest);
    await renderHtmlTemplate(compiled, htmlTemplateSampleContext());
    const variables = usedVariables(manifest);
    const nextDefinition = ConferenceTemplateDefinitionSchema.parse({
      ...definition,
      presentation: {
        ...definition.presentation,
        bindings: manifest,
        bindingDigest: compiled.bindingDigest,
        usedVariables: variables.used,
        requiredVariables: variables.required,
        actions: manifest.bindings
          .filter((binding) => binding.kind === 'attribute')
          .map((binding) => ({
            nodeId: binding.nodeId,
            kind: binding.variablePath.split('.')[1] as 'registration' | 'faq' | 'account',
            href: binding.variablePath,
          })),
      },
    });
    const contentDigest = sha256Digest(
      JSON.stringify({
        definition: nextDefinition,
        document: document.sanitizedDigest,
        bindings: compiled.bindingDigest,
      }),
    );
    const saved = {
      revision: revision + 1,
      bindings: manifest,
      bindingDigest: compiled.bindingDigest,
      usedVariables: variables.used,
      requiredVariables: variables.required,
    };
    await this.db().transaction(async (tx) => {
      const [lockedRun] = await tx
        .select({ status: aiRuns.status })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.id, runId),
            eq(aiRuns.organizationId, organizationId),
            eq(aiRuns.templateId, templateId),
          ),
        )
        .for('update')
        .limit(1);
      if (lockedRun?.status !== 'review_ready') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'AI 建议已经被其他成员处理',
          HttpStatus.CONFLICT,
        );
      }
      const [lockedDraft] = await tx
        .select({
          definition: conferenceTemplateDrafts.definition,
          revision: conferenceTemplateDrafts.revision,
        })
        .from(conferenceTemplateDrafts)
        .where(eq(conferenceTemplateDrafts.templateId, templateId))
        .for('update')
        .limit(1);
      const currentDefinition = lockedDraft
        ? normalizeConferenceTemplateDefinition(lockedDraft.definition)
        : null;
      if (
        !lockedDraft ||
        currentDefinition?.presentation.kind !== 'html' ||
        lockedDraft.revision !== output.baseRevision ||
        currentDefinition.presentation.sanitizedDigest !== output.documentDigest ||
        currentDefinition.presentation.bindingDigest !== output.bindingDigest
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '模板在应用 AI 建议前已经变化，请重新生成建议',
          HttpStatus.CONFLICT,
        );
      }
      const [updatedDraft] = await tx
        .update(conferenceTemplateDrafts)
        .set({
          definition: nextDefinition,
          schemaVersion: 2,
          contentDigest,
          revision: saved.revision,
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(conferenceTemplateDrafts.templateId, templateId),
            eq(conferenceTemplateDrafts.revision, revision),
          ),
        )
        .returning({ revision: conferenceTemplateDrafts.revision });
      if (!updatedDraft) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '模板草稿已经被其他成员更新，请重新加载',
          HttpStatus.CONFLICT,
        );
      }
      await tx
        .insert(templateAiMappingActions)
        .values(
          selected.map((proposal) => ({
            organizationId,
            templateId,
            runId,
            proposalId: proposal.proposalId,
            action: 'accepted',
            actorId,
            beforeBindingDigest: output.bindingDigest,
            afterBindingDigest: saved.bindingDigest,
            resultRevision: saved.revision,
            bindingSnapshot: saved.bindings,
          })),
        )
        .onConflictDoNothing();
      const [completed] = await tx
        .update(aiRuns)
        .set({
          status: selected.length === output.proposals.length ? 'completed' : 'partially_applied',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, 'review_ready')))
        .returning({ id: aiRuns.id });
      if (!completed) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          'AI 建议已经被其他成员处理',
          HttpStatus.CONFLICT,
        );
      }
      await tx.insert(auditLogs).values([
        {
          organizationId,
          actorId,
          action: 'template.html_bindings.save',
          resourceType: 'conference_template',
          resourceId: templateId,
          after: { bindingDigest: compiled.bindingDigest, bindingCount: manifest.bindings.length },
          traceId: randomUUID(),
        },
        {
          organizationId,
          actorId,
          action: 'template.ai_mapping.apply',
          resourceType: 'ai_run',
          resourceId: runId,
          after: { templateId, proposalCount: selected.length, revision: saved.revision },
          traceId: randomUUID(),
        },
      ]);
    });
    return saved;
  }
}
