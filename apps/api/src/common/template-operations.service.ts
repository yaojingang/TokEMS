import { createHash, createHmac, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  API_ERROR_CODES,
  ConferenceTemplateDefinitionSchema,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  normalizeConferenceTemplateDefinition,
  type ConferenceTemplateDefinition,
  type ConferenceTemplateDraft,
  type ConferenceTemplateOption,
  type ConferenceTemplateSummary,
  type ConferenceTemplateVersion,
  type CreateConferenceTemplate,
  type EventId,
  type EventExperience,
  type EventTemplateBinding,
  type PublishConferenceTemplate,
  type SaveConferenceTemplateDraft,
  type SaveEventExperienceOverride,
  type TemplateSurface,
  type UpdateConferenceTemplate,
  type UpdateEventTemplateBinding,
} from '@conference/contracts';
import {
  auditLogs,
  conferenceTemplateDrafts,
  conferenceTemplates,
  conferenceTemplateVersions,
  eventReleases,
  eventTemplateBindings,
  eventTemplateOverrides,
  events,
  outboxEvents,
  speakers,
  templateAssetUploadReservations,
  templateAssets,
  templateHtmlDocuments,
  templateHtmlImportAssets,
  templatePackages,
  users,
} from '@conference/database';
import { and, asc, count, desc, eq, isNull, max, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { EventReleaseActivationService } from './event-release-activation.service.js';
import { matchesDeclaredMediaType, readUploadWithinLimit } from './object-storage-verification.js';
import { mergeTemplateDefinition } from './template-definition.js';

export { mergeTemplateDefinition } from './template-definition.js';

type Database = NonNullable<DatabaseService['db']>;
type SurfaceOverrideDocument = Record<string, unknown>;
const DEFAULT_ORG_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_ORG_ASSET_COUNT = 10_000;
const TEMPLATE_ASSET_UPLOAD_URL_TTL_MS = 10 * 60_000;
const TEMPLATE_ASSET_UPLOAD_CLEANUP_GRACE_MS = 2 * 60_000;

function deterministicUuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4]!;
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

@Injectable()
export class TemplateOperationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(EventReleaseActivationService)
    private readonly releaseActivation?: EventReleaseActivationService,
  ) {}

  private db(): Database {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '模板管理需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private releases() {
    return this.releaseActivation ?? new EventReleaseActivationService(this.database);
  }

  private digest(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
        ? contentLength
          ? 'content-length;content-type;host;if-none-match'
          : 'content-type;host;if-none-match'
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

  private async templateRoot(organizationId: string, templateId: string) {
    const [row] = await this.db()
      .select()
      .from(conferenceTemplates)
      .where(
        and(
          eq(conferenceTemplates.id, templateId),
          eq(conferenceTemplates.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会模板不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async summaryFromRoot(
    root: typeof conferenceTemplates.$inferSelect,
  ): Promise<ConferenceTemplateSummary> {
    const [draft] = await this.db()
      .select()
      .from(conferenceTemplateDrafts)
      .where(eq(conferenceTemplateDrafts.templateId, root.id))
      .limit(1);
    const [version] = root.currentPublishedVersionId
      ? await this.db()
          .select()
          .from(conferenceTemplateVersions)
          .where(eq(conferenceTemplateVersions.id, root.currentPublishedVersionId))
          .limit(1)
      : [];
    const rendererPackageId = version?.rendererPackageId ?? draft?.rendererPackageId;
    const [renderer] = rendererPackageId
      ? await this.db()
          .select()
          .from(templatePackages)
          .where(eq(templatePackages.id, rendererPackageId))
          .limit(1)
      : [];
    const [usage] = await this.db()
      .select({ value: count() })
      .from(eventTemplateBindings)
      .innerJoin(
        conferenceTemplateVersions,
        eq(conferenceTemplateVersions.id, eventTemplateBindings.templateVersionId),
      )
      .where(eq(conferenceTemplateVersions.templateId, root.id));
    const [updatedBy] = root.updatedBy
      ? await this.db()
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, root.updatedBy))
          .limit(1)
      : [];
    const usageCount = Number(usage?.value ?? 0);
    const effectiveDefinition = version?.definition ?? draft?.definition;
    const presentationKind = effectiveDefinition
      ? normalizeConferenceTemplateDefinition(effectiveDefinition).presentation.kind
      : 'structured';
    const boundToCurrent = root.currentPublishedVersionId
      ? (
          await this.db()
            .select({ value: count() })
            .from(eventTemplateBindings)
            .where(eq(eventTemplateBindings.templateVersionId, root.currentPublishedVersionId))
        )[0]
      : undefined;
    return {
      id: root.id,
      code: root.code,
      name: root.name,
      description: root.description,
      tags: root.tags,
      status:
        root.status === 'archived'
          ? 'archived'
          : root.currentPublishedVersionId
            ? 'published'
            : 'draft',
      rootStatus: root.status,
      currentPublishedVersionId: root.currentPublishedVersionId,
      currentVersion: version?.version ?? null,
      rendererName: renderer?.name ?? '未选择渲染器',
      rendererKey: renderer?.key ?? 'unassigned',
      rendererVersion: renderer?.version ?? 1,
      presentationKind,
      usageCount,
      upgradeCount: root.currentPublishedVersionId
        ? Math.max(0, usageCount - Number(boundToCurrent?.value ?? 0))
        : 0,
      previewAssetKey: version?.previewAssetKey ?? null,
      updatedByName: updatedBy?.name ?? null,
      updatedAt: root.updatedAt.toISOString(),
    };
  }

  async list(organizationId: string): Promise<ConferenceTemplateSummary[]> {
    const roots = await this.db()
      .select()
      .from(conferenceTemplates)
      .where(eq(conferenceTemplates.organizationId, organizationId))
      .orderBy(desc(conferenceTemplates.updatedAt));
    return Promise.all(roots.map((root) => this.summaryFromRoot(root)));
  }

  async options(organizationId: string): Promise<ConferenceTemplateOption[]> {
    const summaries = await this.list(organizationId);
    return summaries
      .filter((item) => item.rootStatus === 'active' && item.currentPublishedVersionId)
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        tags: item.tags,
        currentPublishedVersionId: item.currentPublishedVersionId,
        currentVersion: item.currentVersion,
        presentationKind: item.presentationKind,
        previewAssetKey: item.previewAssetKey,
        updatedAt: item.updatedAt,
      }));
  }

  async create(
    organizationId: string,
    actorId: string,
    input: CreateConferenceTemplate,
    commandKey?: string,
    commandDigest = this.digest(input),
    definitionOverride?: ConferenceTemplateDefinition,
  ) {
    const db = this.db();
    const requestedTemplateId = commandKey
      ? deterministicUuid(`template:create:${organizationId}:${commandKey}:${commandDigest}`)
      : randomUUID();
    const templateId = await db.transaction(async (tx) => {
      if (commandKey) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`template-create:${requestedTemplateId}`}, 0))`,
        );
      }
      const [existing] = await tx
        .select({ id: conferenceTemplates.id })
        .from(conferenceTemplates)
        .where(
          and(
            eq(conferenceTemplates.id, requestedTemplateId),
            eq(conferenceTemplates.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (existing) return existing.id;
      let definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
      let rendererPackageId = input.rendererPackageId;
      let sourceHtmlDocument: typeof templateHtmlDocuments.$inferSelect | undefined;
      if (input.sourceTemplateVersionId) {
        const [source] = await tx
          .select({ version: conferenceTemplateVersions, root: conferenceTemplates })
          .from(conferenceTemplateVersions)
          .innerJoin(
            conferenceTemplates,
            eq(conferenceTemplates.id, conferenceTemplateVersions.templateId),
          )
          .where(
            and(
              eq(conferenceTemplateVersions.id, input.sourceTemplateVersionId),
              eq(conferenceTemplates.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!source) {
          throw new DomainError(
            API_ERROR_CODES.NOT_FOUND,
            '复制来源模板版本不存在',
            HttpStatus.NOT_FOUND,
          );
        }
        definition = structuredClone(
          normalizeConferenceTemplateDefinition(source.version.definition),
        );
        if (definition.presentation.kind === 'html') {
          [sourceHtmlDocument] = await tx
            .select()
            .from(templateHtmlDocuments)
            .where(
              and(
                eq(templateHtmlDocuments.id, definition.presentation.documentId),
                eq(templateHtmlDocuments.organizationId, organizationId),
                eq(templateHtmlDocuments.templateId, source.root.id),
              ),
            )
            .limit(1);
          if (!sourceHtmlDocument) {
            throw new DomainError(
              API_ERROR_CODES.NOT_FOUND,
              '复制来源的 HTML 文档不存在',
              HttpStatus.NOT_FOUND,
            );
          }
        }
        rendererPackageId = source.version.rendererPackageId;
      }
      if (definitionOverride) {
        definition = structuredClone(normalizeConferenceTemplateDefinition(definitionOverride));
      }
      if (!rendererPackageId) {
        const [renderer] = await tx
          .select({ id: templatePackages.id })
          .from(templatePackages)
          .where(
            and(
              eq(templatePackages.status, 'published'),
              sql`${templatePackages.key} <> 'html-liquid-v1'`,
            ),
          )
          .orderBy(asc(templatePackages.name))
          .limit(1);
        if (!renderer) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '系统尚未安装可用的前台渲染器',
            HttpStatus.CONFLICT,
          );
        }
        rendererPackageId = renderer.id;
      }
      const [renderer] = await tx
        .select({ id: templatePackages.id, manifest: templatePackages.manifest })
        .from(templatePackages)
        .where(
          and(eq(templatePackages.id, rendererPackageId), eq(templatePackages.status, 'published')),
        )
        .limit(1);
      if (!renderer) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '渲染器版本不存在或未启用',
          HttpStatus.NOT_FOUND,
        );
      }
      const supportedSchemas = Array.isArray(renderer.manifest.schemaVersions)
        ? renderer.manifest.schemaVersions.map(Number)
        : [1];
      const schemaVersion = 2;
      if (!supportedSchemas.includes(schemaVersion)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '渲染器不支持当前模板配置协议版本',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { schemaVersion, supportedSchemas },
        );
      }
      const validatedDefinition = ConferenceTemplateDefinitionSchema.safeParse(definition);
      if (!validatedDefinition.success) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '模板初始配置校验未通过',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { issues: validatedDefinition.error.issues },
        );
      }
      definition = validatedDefinition.data;
      const [root] = await tx
        .insert(conferenceTemplates)
        .values({
          id: requestedTemplateId,
          organizationId,
          code: `template-${nanoid(10).toLowerCase()}`,
          name: input.name,
          description: input.description,
          tags: [...new Set(input.tags)],
          createdBy: actorId,
          updatedBy: actorId,
        })
        .returning();
      if (definition.presentation.kind === 'html' && sourceHtmlDocument) {
        const documentId = randomUUID();
        await tx.insert(templateHtmlDocuments).values({
          id: documentId,
          organizationId,
          templateId: root!.id,
          originalFilename: sourceHtmlDocument.originalFilename,
          sourceStorageKey: sourceHtmlDocument.sourceStorageKey,
          sourceDigest: sourceHtmlDocument.sourceDigest,
          sourceSize: sourceHtmlDocument.sourceSize,
          sanitizedHtml: sourceHtmlDocument.sanitizedHtml,
          sanitizedDigest: sourceHtmlDocument.sanitizedDigest,
          nodeManifest: sourceHtmlDocument.nodeManifest,
          assetManifest: sourceHtmlDocument.assetManifest,
          securityReport: sourceHtmlDocument.securityReport,
          metadata: sourceHtmlDocument.metadata,
          compilerVersion: sourceHtmlDocument.compilerVersion,
          createdBy: actorId,
        });
        definition = {
          ...definition,
          presentation: { ...definition.presentation, documentId },
        };
      }
      const contentDigest = this.digest(definition);
      await tx.insert(conferenceTemplateDrafts).values({
        templateId: root!.id,
        rendererPackageId,
        schemaVersion,
        definition,
        revision: 0,
        contentDigest,
        updatedBy: actorId,
      });
      if (input.publishImmediately) {
        const [version] = await tx
          .insert(conferenceTemplateVersions)
          .values({
            templateId: root!.id,
            version: 1,
            rendererPackageId,
            schemaVersion,
            definition,
            contentDigest,
            changeSummary: '快速创建并发布模板 V1',
            createdBy: actorId,
          })
          .returning();
        await tx
          .update(conferenceTemplates)
          .set({
            currentPublishedVersionId: version!.id,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(eq(conferenceTemplates.id, root!.id));
        await tx.insert(outboxEvents).values({
          organizationId,
          eventType: 'ConferenceTemplatePublished',
          correlationId: `template:publish:${version!.id}`,
          payload: {
            templateId: root!.id,
            templateVersionId: version!.id,
            version: version!.version,
          },
        });
      }
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.create',
        resourceType: 'conference_template',
        resourceId: root!.id,
        after: {
          name: input.name,
          sourceTemplateVersionId: input.sourceTemplateVersionId ?? null,
          publishImmediately: input.publishImmediately,
        },
        traceId: crypto.randomUUID(),
      });
      return root!.id;
    });
    return this.detail(organizationId, templateId);
  }

  async detail(organizationId: string, templateId: string) {
    const root = await this.templateRoot(organizationId, templateId);
    const [summary, draft, versions, usages] = await Promise.all([
      this.summaryFromRoot(root),
      this.draft(organizationId, templateId),
      this.versions(organizationId, templateId),
      this.usages(organizationId, templateId),
    ]);
    return { summary, draft, versions, usages };
  }

  async update(
    organizationId: string,
    templateId: string,
    actorId: string,
    input: UpdateConferenceTemplate,
  ) {
    await this.templateRoot(organizationId, templateId);
    await this.db().transaction(async (tx) => {
      const [draft] = await tx
        .update(conferenceTemplateDrafts)
        .set({
          revision: input.revision + 1,
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(conferenceTemplateDrafts.templateId, templateId),
            eq(conferenceTemplateDrafts.revision, input.revision),
          ),
        )
        .returning({ revision: conferenceTemplateDrafts.revision });
      if (!draft) {
        const [current] = await tx
          .select({ revision: conferenceTemplateDrafts.revision })
          .from(conferenceTemplateDrafts)
          .where(eq(conferenceTemplateDrafts.templateId, templateId))
          .limit(1);
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '模板已经被其他成员更新，请重新载入后再保存',
          HttpStatus.CONFLICT,
          { currentRevision: current?.revision ?? null },
        );
      }
      await tx
        .update(conferenceTemplates)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.tags !== undefined ? { tags: [...new Set(input.tags)] } : {}),
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(eq(conferenceTemplates.id, templateId));
    });
    return this.detail(organizationId, templateId);
  }

  async draft(organizationId: string, templateId: string): Promise<ConferenceTemplateDraft> {
    await this.templateRoot(organizationId, templateId);
    const [row] = await this.db()
      .select({ draft: conferenceTemplateDrafts, updatedByName: users.name })
      .from(conferenceTemplateDrafts)
      .leftJoin(users, eq(users.id, conferenceTemplateDrafts.updatedBy))
      .where(eq(conferenceTemplateDrafts.templateId, templateId))
      .limit(1);
    if (!row) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '模板草稿不存在', HttpStatus.NOT_FOUND);
    }
    return {
      templateId: row.draft.templateId,
      rendererPackageId: row.draft.rendererPackageId,
      schemaVersion: row.draft.schemaVersion,
      definition: normalizeConferenceTemplateDefinition(row.draft.definition),
      revision: row.draft.revision,
      contentDigest: row.draft.contentDigest,
      updatedByName: row.updatedByName,
      updatedAt: row.draft.updatedAt.toISOString(),
    };
  }

  async saveDraft(
    organizationId: string,
    templateId: string,
    actorId: string,
    input: SaveConferenceTemplateDraft,
  ) {
    await this.templateRoot(organizationId, templateId);
    const parsed = ConferenceTemplateDefinitionSchema.safeParse(input.definition);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '模板草稿配置不完整',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { issues: parsed.error.issues },
      );
    }
    await this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
      );
      const [updated] = await tx
        .update(conferenceTemplateDrafts)
        .set({
          schemaVersion: 2,
          definition: parsed.data,
          revision: input.revision + 1,
          contentDigest: this.digest(parsed.data),
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(conferenceTemplateDrafts.templateId, templateId),
            eq(conferenceTemplateDrafts.revision, input.revision),
          ),
        )
        .returning();
      if (!updated) {
        const [current] = await tx
          .select({ revision: conferenceTemplateDrafts.revision })
          .from(conferenceTemplateDrafts)
          .where(eq(conferenceTemplateDrafts.templateId, templateId))
          .limit(1);
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '模板草稿发生版本冲突',
          HttpStatus.CONFLICT,
          { currentRevision: current?.revision ?? null },
        );
      }
      await tx
        .update(conferenceTemplates)
        .set({ updatedBy: actorId, updatedAt: new Date() })
        .where(eq(conferenceTemplates.id, templateId));
    });
    return this.draft(organizationId, templateId);
  }

  async publish(
    organizationId: string,
    templateId: string,
    actorId: string,
    input: PublishConferenceTemplate,
    commandKey?: string,
  ): Promise<ConferenceTemplateVersion> {
    const db = this.db();
    const requestedVersionId = commandKey
      ? deterministicUuid(
          `template:publish:${organizationId}:${templateId}:${commandKey}:${this.digest(input)}`,
        )
      : randomUUID();
    const versionId = await db.transaction(async (tx) => {
      const [root] = await tx
        .select()
        .from(conferenceTemplates)
        .where(
          and(
            eq(conferenceTemplates.id, templateId),
            eq(conferenceTemplates.organizationId, organizationId),
          ),
        )
        .for('update')
        .limit(1);
      const [draft] = await tx
        .select()
        .from(conferenceTemplateDrafts)
        .where(eq(conferenceTemplateDrafts.templateId, templateId))
        .for('update')
        .limit(1);
      if (!root || !draft) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '模板或草稿不存在', HttpStatus.NOT_FOUND);
      }
      const [existingVersion] = await tx
        .select({ id: conferenceTemplateVersions.id })
        .from(conferenceTemplateVersions)
        .where(
          and(
            eq(conferenceTemplateVersions.id, requestedVersionId),
            eq(conferenceTemplateVersions.templateId, templateId),
          ),
        )
        .limit(1);
      if (existingVersion) return existingVersion.id;
      if (root.status === 'archived') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '已归档模板需要恢复后才能发布',
          HttpStatus.CONFLICT,
        );
      }
      if (draft.revision !== input.revision) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '模板草稿发生版本冲突',
          HttpStatus.CONFLICT,
          { currentRevision: draft.revision },
        );
      }
      let normalizedDefinition: ConferenceTemplateDefinition;
      try {
        normalizedDefinition = normalizeConferenceTemplateDefinition(draft.definition);
      } catch (error) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '模板校验未通过',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { message: error instanceof Error ? error.message : '模板定义无法升级' },
        );
      }
      const validation = ConferenceTemplateDefinitionSchema.safeParse(normalizedDefinition);
      if (!validation.success) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '模板校验未通过',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { issues: validation.error.issues },
        );
      }
      const [renderer] = await tx
        .select()
        .from(templatePackages)
        .where(eq(templatePackages.id, draft.rendererPackageId))
        .limit(1);
      if (!renderer || renderer.status !== 'published') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '模板使用的前台渲染器缺失或未发布',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const supportedSchemas = Array.isArray(renderer.manifest.schemaVersions)
        ? renderer.manifest.schemaVersions.map(Number)
        : [1];
      if (!supportedSchemas.includes(2)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '渲染器不支持当前模板配置协议版本',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { schemaVersion: 2, supportedSchemas },
        );
      }
      const shareAssetId =
        validation.data.presentation.kind === 'structured'
          ? validation.data.presentation.home.seo.shareAssetId
          : null;
      if (shareAssetId) {
        const [asset] = await tx
          .select({ id: templateAssets.id })
          .from(templateAssets)
          .where(
            and(
              eq(templateAssets.id, shareAssetId),
              eq(templateAssets.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!asset) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '首页分享图资产缺失或不属于当前组织',
            HttpStatus.UNPROCESSABLE_ENTITY,
            { assetId: shareAssetId },
          );
        }
      }
      const normalizedContentDigest = this.digest(validation.data);
      if (root.currentPublishedVersionId) {
        const [currentPublished] = await tx
          .select({ definition: conferenceTemplateVersions.definition })
          .from(conferenceTemplateVersions)
          .where(eq(conferenceTemplateVersions.id, root.currentPublishedVersionId))
          .limit(1);
        let currentPublishedDigest: string | null = null;
        if (currentPublished) {
          try {
            currentPublishedDigest = this.digest(
              normalizeConferenceTemplateDefinition(currentPublished.definition),
            );
          } catch {
            currentPublishedDigest = null;
          }
        }
        if (currentPublishedDigest === normalizedContentDigest) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '模板草稿与当前发布版本内容一致，无需生成新版本',
            HttpStatus.CONFLICT,
          );
        }
      }
      if (
        draft.schemaVersion !== 2 ||
        draft.contentDigest !== normalizedContentDigest ||
        JSON.stringify(draft.definition) !== JSON.stringify(validation.data)
      ) {
        await tx
          .update(conferenceTemplateDrafts)
          .set({
            schemaVersion: 2,
            definition: validation.data,
            contentDigest: normalizedContentDigest,
            updatedAt: new Date(),
          })
          .where(eq(conferenceTemplateDrafts.templateId, templateId));
      }
      const [latest] = await tx
        .select({ value: max(conferenceTemplateVersions.version) })
        .from(conferenceTemplateVersions)
        .where(eq(conferenceTemplateVersions.templateId, templateId));
      const [version] = await tx
        .insert(conferenceTemplateVersions)
        .values({
          id: requestedVersionId,
          templateId,
          version: Number(latest?.value ?? 0) + 1,
          rendererPackageId: draft.rendererPackageId,
          schemaVersion: 2,
          definition: validation.data,
          contentDigest: normalizedContentDigest,
          changeSummary: input.changeSummary,
          createdBy: actorId,
        })
        .returning();
      await tx
        .update(conferenceTemplates)
        .set({
          currentPublishedVersionId: version!.id,
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(eq(conferenceTemplates.id, templateId));
      await tx.insert(outboxEvents).values({
        organizationId,
        eventType: 'ConferenceTemplatePublished',
        correlationId: `template:publish:${version!.id}`,
        payload: {
          templateId,
          templateVersionId: version!.id,
          version: version!.version,
        },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.publish',
        resourceType: 'conference_template_version',
        resourceId: version!.id,
        after: { version: version!.version, changeSummary: input.changeSummary },
        traceId: crypto.randomUUID(),
      });
      return version!.id;
    });
    const versions = await this.versions(organizationId, templateId);
    return versions.find((version) => version.id === versionId)!;
  }

  async versions(organizationId: string, templateId: string): Promise<ConferenceTemplateVersion[]> {
    await this.templateRoot(organizationId, templateId);
    const rows = await this.db()
      .select({
        version: conferenceTemplateVersions,
        rendererKey: templatePackages.key,
        rendererVersion: templatePackages.version,
        createdByName: users.name,
      })
      .from(conferenceTemplateVersions)
      .innerJoin(
        templatePackages,
        eq(templatePackages.id, conferenceTemplateVersions.rendererPackageId),
      )
      .leftJoin(users, eq(users.id, conferenceTemplateVersions.createdBy))
      .where(eq(conferenceTemplateVersions.templateId, templateId))
      .orderBy(desc(conferenceTemplateVersions.version));
    return rows.map((row) => ({
      id: row.version.id,
      templateId: row.version.templateId,
      version: row.version.version,
      rendererPackageId: row.version.rendererPackageId,
      rendererKey: row.rendererKey,
      rendererVersion: row.rendererVersion,
      schemaVersion: row.version.schemaVersion,
      definition: normalizeConferenceTemplateDefinition(row.version.definition),
      contentDigest: row.version.contentDigest,
      previewAssetKey: row.version.previewAssetKey,
      changeSummary: row.version.changeSummary,
      publishedAt: row.version.publishedAt.toISOString(),
      createdByName: row.createdByName,
    }));
  }

  async usages(organizationId: string, templateId: string) {
    const root = await this.templateRoot(organizationId, templateId);
    const rows = await this.db()
      .select({
        eventId: events.id,
        eventName: events.name,
        eventStatus: events.status,
        versionId: conferenceTemplateVersions.id,
        version: conferenceTemplateVersions.version,
        revision: eventTemplateBindings.revision,
        updatedAt: eventTemplateBindings.updatedAt,
      })
      .from(eventTemplateBindings)
      .innerJoin(events, eq(events.id, eventTemplateBindings.eventId))
      .innerJoin(
        conferenceTemplateVersions,
        eq(conferenceTemplateVersions.id, eventTemplateBindings.templateVersionId),
      )
      .where(
        and(
          eq(events.organizationId, organizationId),
          eq(conferenceTemplateVersions.templateId, templateId),
        ),
      )
      .orderBy(desc(eventTemplateBindings.updatedAt));
    return rows.map((row) => ({
      ...row,
      upgradeAvailable:
        Boolean(root.currentPublishedVersionId) && row.versionId !== root.currentPublishedVersionId,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async duplicate(
    organizationId: string,
    templateId: string,
    actorId: string,
    revision: number,
    name?: string,
    commandKey?: string,
  ) {
    const root = await this.templateRoot(organizationId, templateId);
    const [draft] = await this.db()
      .select({ revision: conferenceTemplateDrafts.revision })
      .from(conferenceTemplateDrafts)
      .where(eq(conferenceTemplateDrafts.templateId, templateId))
      .limit(1);
    if (!draft || draft.revision !== revision) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '复制模板时检测到修订冲突，请重新载入',
        HttpStatus.CONFLICT,
        { currentRevision: draft?.revision ?? null },
      );
    }
    if (!root.currentPublishedVersionId) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '模板发布 V1 后才能复制',
        HttpStatus.CONFLICT,
      );
    }
    return this.create(
      organizationId,
      actorId,
      {
        name: name?.trim() || `${root.name} 副本`,
        description: root.description,
        tags: root.tags,
        sourceTemplateVersionId: root.currentPublishedVersionId,
        publishImmediately: false,
      },
      commandKey,
    );
  }

  async setArchived(
    organizationId: string,
    templateId: string,
    actorId: string,
    archived: boolean,
    revision: number,
  ) {
    const root = await this.templateRoot(organizationId, templateId);
    const [draft] = await this.db()
      .select({ revision: conferenceTemplateDrafts.revision })
      .from(conferenceTemplateDrafts)
      .where(eq(conferenceTemplateDrafts.templateId, templateId))
      .limit(1);
    if (!draft || draft.revision !== revision) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '模板状态更新发生版本冲突',
        HttpStatus.CONFLICT,
        { currentRevision: draft?.revision ?? null },
      );
    }
    await this.db()
      .update(conferenceTemplates)
      .set({
        status: archived ? 'archived' : 'active',
        updatedBy: actorId,
        updatedAt: new Date(),
      })
      .where(eq(conferenceTemplates.id, root.id));
    return this.detail(organizationId, templateId);
  }

  async binding(organizationId: string, eventId: EventId): Promise<EventTemplateBinding> {
    const [row] = await this.db()
      .select({
        binding: eventTemplateBindings,
        eventOrganizationId: events.organizationId,
        version: conferenceTemplateVersions,
        root: conferenceTemplates,
      })
      .from(eventTemplateBindings)
      .innerJoin(events, eq(events.id, eventTemplateBindings.eventId))
      .innerJoin(
        conferenceTemplateVersions,
        eq(conferenceTemplateVersions.id, eventTemplateBindings.templateVersionId),
      )
      .innerJoin(
        conferenceTemplates,
        eq(conferenceTemplates.id, conferenceTemplateVersions.templateId),
      )
      .where(
        and(eq(eventTemplateBindings.eventId, eventId), eq(events.organizationId, organizationId)),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会尚未绑定可用模板',
        HttpStatus.NOT_FOUND,
      );
    }
    const [current] = row.root.currentPublishedVersionId
      ? await this.db()
          .select({ version: conferenceTemplateVersions.version })
          .from(conferenceTemplateVersions)
          .where(eq(conferenceTemplateVersions.id, row.root.currentPublishedVersionId))
          .limit(1)
      : [];
    return {
      eventId,
      templateId: row.root.id,
      templateName: row.root.name,
      templateVersionId: row.version.id,
      templateVersion: row.version.version,
      currentPublishedVersionId: row.root.currentPublishedVersionId,
      currentPublishedVersion: current?.version ?? null,
      updatePolicy: 'manual',
      revision: row.binding.revision,
      upgradeAvailable:
        Boolean(row.root.currentPublishedVersionId) &&
        row.version.id !== row.root.currentPublishedVersionId,
      boundAt: row.binding.boundAt.toISOString(),
      updatedAt: row.binding.updatedAt.toISOString(),
    };
  }

  async updateBinding(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: UpdateEventTemplateBinding,
  ) {
    const [target] = await this.db()
      .select({ version: conferenceTemplateVersions, root: conferenceTemplates })
      .from(conferenceTemplateVersions)
      .innerJoin(
        conferenceTemplates,
        eq(conferenceTemplates.id, conferenceTemplateVersions.templateId),
      )
      .where(
        and(
          eq(conferenceTemplateVersions.id, input.templateVersionId),
          eq(conferenceTemplates.organizationId, organizationId),
          eq(conferenceTemplates.status, 'active'),
        ),
      )
      .limit(1);
    if (!target) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '目标模板版本不存在或不可用',
        HttpStatus.NOT_FOUND,
      );
    }
    const targetDefinition = normalizeConferenceTemplateDefinition(target.version.definition);
    const targetKeys: Record<TemplateSurface, Set<string>> = {
      home: new Set(
        targetDefinition.presentation.kind === 'structured'
          ? targetDefinition.presentation.home.blocks.map((item) => item.nodeKey)
          : [],
      ),
      faq: new Set(targetDefinition.faq.items.map((item) => item.nodeKey)),
      registration_flow: new Set(
        targetDefinition.registrationFlow.steps.map((item) => item.nodeKey),
      ),
    };
    await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'experience',
        changeSummary: `替换大会模板为“${target.root.name}”V${target.version.version}`,
      },
      async (tx) => {
        const [event] = await tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
          .for('update')
          .limit(1);
        const [current] = await tx
          .select()
          .from(eventTemplateBindings)
          .where(eq(eventTemplateBindings.eventId, eventId))
          .for('update')
          .limit(1);
        if (!event || !current) {
          throw new DomainError(
            API_ERROR_CODES.NOT_FOUND,
            '大会模板绑定不存在或无权访问',
            HttpStatus.NOT_FOUND,
          );
        }
        if (current.revision !== input.revision) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '大会模板绑定发生版本冲突',
            HttpStatus.CONFLICT,
            { currentRevision: current.revision },
          );
        }
        const overrideRows = await tx
          .select()
          .from(eventTemplateOverrides)
          .where(eq(eventTemplateOverrides.eventId, eventId))
          .for('update');
        const conflicts = overrideRows.flatMap((row) =>
          Object.keys(row.document)
            .filter((nodeKey) => !nodeKey.startsWith('$') && !targetKeys[row.surface].has(nodeKey))
            .map((nodeKey) => ({
              surface: row.surface,
              nodeKey,
              key: `${row.surface}.${nodeKey}`,
              reason: '目标模板版本中不存在该大会覆盖节点',
            })),
        );
        const unresolved = conflicts.filter((conflict) => {
          const resolution =
            input.conflictResolutions[conflict.key] ?? input.conflictResolutions[conflict.surface];
          return resolution !== 'discard';
        });
        if (unresolved.length) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '模板升级或替换存在需要确认的大会覆盖冲突',
            HttpStatus.CONFLICT,
            { conflicts: unresolved },
          );
        }
        for (const row of overrideRows) {
          const nextDocument = { ...row.document };
          let changed = false;
          for (const conflict of conflicts.filter((item) => item.surface === row.surface)) {
            const resolution =
              input.conflictResolutions[conflict.key] ??
              input.conflictResolutions[conflict.surface];
            if (resolution === 'discard') {
              delete nextDocument[conflict.nodeKey];
              changed = true;
            }
          }
          if (changed) {
            await tx
              .update(eventTemplateOverrides)
              .set({
                document: nextDocument,
                revision: row.revision + 1,
                contentDigest: this.digest(nextDocument),
                updatedBy: actorId,
                updatedAt: new Date(),
              })
              .where(eq(eventTemplateOverrides.id, row.id));
          }
        }
        await tx
          .update(eventTemplateBindings)
          .set({
            templateVersionId: input.templateVersionId,
            revision: input.revision + 1,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(eq(eventTemplateBindings.eventId, eventId));
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'event.template_binding.update',
          resourceType: 'event_template_binding',
          resourceId: String(eventId),
          before: { templateVersionId: current.templateVersionId, revision: current.revision },
          after: {
            templateVersionId: input.templateVersionId,
            revision: input.revision + 1,
            conflicts,
            conflictResolutions: input.conflictResolutions,
          },
          traceId: crypto.randomUUID(),
        });
      },
    );
    return this.binding(organizationId, eventId);
  }

  async experience(organizationId: string, eventId: EventId): Promise<EventExperience> {
    const binding = await this.binding(organizationId, eventId);
    const [version] = await this.db()
      .select({ version: conferenceTemplateVersions, renderer: templatePackages })
      .from(conferenceTemplateVersions)
      .innerJoin(
        templatePackages,
        eq(templatePackages.id, conferenceTemplateVersions.rendererPackageId),
      )
      .where(eq(conferenceTemplateVersions.id, binding.templateVersionId))
      .limit(1);
    const overrideRows = await this.db()
      .select()
      .from(eventTemplateOverrides)
      .where(eq(eventTemplateOverrides.eventId, eventId));
    const overrides: EventExperience['overrides'] = {
      home: { revision: 0, document: {} },
      faq: { revision: 0, document: {} },
      registration_flow: { revision: 0, document: {} },
    };
    for (const row of overrideRows) {
      overrides[row.surface] = { revision: row.revision, document: row.document };
    }
    const resolved = mergeTemplateDefinition(version!.version.definition, {
      home: overrides.home.document as SurfaceOverrideDocument,
      faq: overrides.faq.document as SurfaceOverrideDocument,
      registration_flow: overrides.registration_flow.document as SurfaceOverrideDocument,
    });
    const validation = ConferenceTemplateDefinitionSchema.safeParse(resolved);
    return {
      binding,
      renderer: { key: version!.renderer.key, version: version!.renderer.version },
      definition: resolved,
      overrides,
      validation: validation.success
        ? { valid: true, errors: [], warnings: [] }
        : {
            valid: false,
            errors: validation.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
            warnings: [],
          },
    };
  }

  async saveEventAsTemplate(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: {
      name: string;
      description: string;
      tags: string[];
      includeContent: boolean;
    },
    commandKey?: string,
  ) {
    const experience = await this.experience(organizationId, eventId);
    const recoveryKey = commandKey ? `event:${eventId}:${commandKey}` : undefined;
    let definition = structuredClone(experience.definition);
    if (!input.includeContent) {
      const [baseVersion] = await this.db()
        .select({ definition: conferenceTemplateVersions.definition })
        .from(conferenceTemplateVersions)
        .where(eq(conferenceTemplateVersions.id, experience.binding.templateVersionId))
        .limit(1);
      if (!baseVersion) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会绑定的模板版本不存在',
          HttpStatus.NOT_FOUND,
        );
      }
      definition = structuredClone(baseVersion.definition);
      definition.registrationFlow = structuredClone(experience.definition.registrationFlow);
      definition.faq.mode = experience.definition.faq.mode;
      definition.faq.searchEnabled = experience.definition.faq.searchEnabled;
    }
    const source = await this.create(
      organizationId,
      actorId,
      {
        name: input.name,
        description: input.description,
        tags: input.tags,
        sourceTemplateVersionId: experience.binding.templateVersionId,
        publishImmediately: false,
      },
      recoveryKey,
      this.digest(input),
      definition,
    );
    if (source.summary.currentPublishedVersionId) return source;
    await this.publish(
      organizationId,
      source.summary.id,
      actorId,
      {
        revision: source.draft.revision,
        changeSummary: input.includeContent
          ? '从大会配置另存，已包含确认保留的页面文案'
          : '从大会配置另存，已排除大会专属文案和业务数据',
      },
      recoveryKey,
    );
    return this.detail(organizationId, source.summary.id);
  }

  async saveOverride(
    organizationId: string,
    eventId: EventId,
    surface: TemplateSurface,
    actorId: string,
    input: SaveEventExperienceOverride,
  ) {
    await this.binding(organizationId, eventId);
    await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'experience',
        experienceSurface: surface,
        changeSummary:
          surface === 'home'
            ? '更新首页设置'
            : surface === 'faq'
              ? '更新 FAQ 设置'
              : '更新报名流程设置',
      },
      async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
        );
        const [event] = await tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
          .for('update')
          .limit(1);
        if (!event) {
          throw new DomainError(
            API_ERROR_CODES.NOT_FOUND,
            '大会不存在或无权访问',
            HttpStatus.NOT_FOUND,
          );
        }
        const [activeTemplate] = await tx
          .select({ definition: conferenceTemplateVersions.definition })
          .from(eventTemplateBindings)
          .innerJoin(
            conferenceTemplateVersions,
            eq(conferenceTemplateVersions.id, eventTemplateBindings.templateVersionId),
          )
          .where(eq(eventTemplateBindings.eventId, eventId))
          .limit(1);
        if (!activeTemplate) {
          throw new DomainError(
            API_ERROR_CODES.NOT_FOUND,
            '大会尚未绑定可用模板',
            HttpStatus.NOT_FOUND,
          );
        }
        if (
          surface === 'home' &&
          normalizeConferenceTemplateDefinition(activeTemplate.definition).presentation.kind ===
            'html'
        ) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            'HTML 模板首页由模板变量绑定维护，当前页面不支持大会级首页覆盖',
            HttpStatus.CONFLICT,
          );
        }
        const [existing] = await tx
          .select()
          .from(eventTemplateOverrides)
          .where(
            and(
              eq(eventTemplateOverrides.eventId, eventId),
              eq(eventTemplateOverrides.surface, surface),
            ),
          )
          .limit(1);
        let saved: typeof eventTemplateOverrides.$inferSelect | undefined;
        if (existing) {
          [saved] = await tx
            .update(eventTemplateOverrides)
            .set({
              document: input.document,
              revision: input.revision + 1,
              contentDigest: this.digest(input.document),
              updatedBy: actorId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(eventTemplateOverrides.id, existing.id),
                eq(eventTemplateOverrides.revision, input.revision),
              ),
            )
            .returning();
        } else if (input.revision === 0) {
          [saved] = await tx
            .insert(eventTemplateOverrides)
            .values({
              eventId,
              surface,
              schemaVersion: 1,
              document: input.document,
              revision: 1,
              contentDigest: this.digest(input.document),
              updatedBy: actorId,
            })
            .onConflictDoNothing()
            .returning();
        }
        if (!saved) {
          const [current] = await tx
            .select({ revision: eventTemplateOverrides.revision })
            .from(eventTemplateOverrides)
            .where(
              and(
                eq(eventTemplateOverrides.eventId, eventId),
                eq(eventTemplateOverrides.surface, surface),
              ),
            )
            .limit(1);
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '大会体验覆盖发生版本冲突',
            HttpStatus.CONFLICT,
            { currentRevision: current?.revision ?? 0 },
          );
        }
      },
    );
    return this.experience(organizationId, eventId);
  }

  async listAssets(organizationId: string) {
    const assets = await this.db()
      .select()
      .from(templateAssets)
      .where(eq(templateAssets.organizationId, organizationId))
      .orderBy(desc(templateAssets.createdAt));
    return assets.map((asset) => ({
      ...asset,
      previewUrl: this.s3Presigned(asset.storageKey, 'GET'),
      createdAt: asset.createdAt.toISOString(),
    }));
  }

  async publicAssetUrl(assetId: string) {
    const [asset] = await this.db()
      .select({ storageKey: templateAssets.storageKey })
      .from(templateAssets)
      .where(eq(templateAssets.id, assetId))
      .limit(1);
    if (!asset) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '模板图片不存在', HttpStatus.NOT_FOUND);
    }
    const url = this.s3Presigned(asset.storageKey, 'GET');
    if (!url) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法读取模板图片',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return url;
  }

  async prepareAssetUpload(
    organizationId: string,
    actorId: string,
    input: {
      fileName: string;
      mediaType: string;
      size: number;
      contentDigest: string;
      altText: string;
    },
    commandKey?: string,
  ) {
    const safeName =
      input.fileName
        .normalize('NFKC')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(-120) || 'template-image';
    const uploadToken = commandKey
      ? deterministicUuid(
          `template-asset:upload:${organizationId}:${commandKey}:${this.digest(input)}`,
        )
      : nanoid(16).toLowerCase();
    const storageKey = `templates/${organizationId}/staged/${uploadToken}-${safeName}`;
    const uploadUrl = this.s3Presigned(storageKey, 'PUT', input.mediaType, undefined, input.size);
    if (!uploadUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法上传模板图片',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const uploadExpiresAt = new Date(Date.now() + TEMPLATE_ASSET_UPLOAD_URL_TTL_MS);
    const reservationExpiresAt = new Date(
      uploadExpiresAt.getTime() + TEMPLATE_ASSET_UPLOAD_CLEANUP_GRACE_MS,
    );
    await this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
      );
      const [existingReservation] = await tx
        .select()
        .from(templateAssetUploadReservations)
        .where(
          and(
            eq(templateAssetUploadReservations.organizationId, organizationId),
            eq(templateAssetUploadReservations.storageKey, storageKey),
          ),
        )
        .limit(1);
      if (existingReservation) {
        const now = new Date();
        if (
          existingReservation.consumedAssetId ||
          existingReservation.cleanupRequestedAt ||
          existingReservation.expiresAt <= now ||
          existingReservation.mediaType !== input.mediaType ||
          existingReservation.size !== input.size ||
          existingReservation.contentDigest !== input.contentDigest
        ) {
          throw new DomainError(
            API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            '上传预留已过期或与原请求不一致，请使用新的 Idempotency-Key',
            HttpStatus.CONFLICT,
          );
        }
        await tx
          .update(templateAssetUploadReservations)
          .set({ expiresAt: reservationExpiresAt, cleanupRequestedAt: null })
          .where(eq(templateAssetUploadReservations.id, existingReservation.id));
        return;
      }
      const [[assetUsage], [reservationUsage]] = await Promise.all([
        tx
          .select({ count: count(), bytes: sql<number>`coalesce(sum(${templateAssets.size}), 0)` })
          .from(templateAssets)
          .where(eq(templateAssets.organizationId, organizationId)),
        tx
          .select({
            count: count(),
            bytes: sql<number>`coalesce(sum(${templateAssetUploadReservations.size}), 0)`,
          })
          .from(templateAssetUploadReservations)
          .where(
            and(
              eq(templateAssetUploadReservations.organizationId, organizationId),
              isNull(templateAssetUploadReservations.consumedAssetId),
            ),
          ),
      ]);
      const maxBytes =
        Number(process.env.HTML_TEMPLATE_ORG_ASSET_BYTES ?? DEFAULT_ORG_ASSET_BYTES) ||
        DEFAULT_ORG_ASSET_BYTES;
      const maxCount =
        Number(process.env.HTML_TEMPLATE_ORG_ASSET_COUNT ?? DEFAULT_ORG_ASSET_COUNT) ||
        DEFAULT_ORG_ASSET_COUNT;
      if (
        Number(assetUsage?.count ?? 0) + Number(reservationUsage?.count ?? 0) >= maxCount ||
        Number(assetUsage?.bytes ?? 0) + Number(reservationUsage?.bytes ?? 0) + input.size >
          maxBytes
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '组织模板资产容量已达上限，请清理不再使用的模板图片',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      await tx.insert(templateAssetUploadReservations).values({
        organizationId,
        storageKey,
        mediaType: input.mediaType,
        size: input.size,
        contentDigest: input.contentDigest,
        expiresAt: reservationExpiresAt,
        createdBy: actorId,
      });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.asset.upload.prepare',
        resourceType: 'template_asset',
        resourceId: input.contentDigest.slice(0, 64),
        after: {
          fileName: input.fileName,
          mediaType: input.mediaType,
          size: input.size,
          contentDigest: input.contentDigest,
        },
        traceId: crypto.randomUUID(),
      });
    });
    return {
      uploadUrl,
      method: 'PUT' as const,
      headers: { 'Content-Type': input.mediaType, 'If-None-Match': '*' },
      storageKey,
      expiresAt: uploadExpiresAt.toISOString(),
    };
  }

  private async assertStoredAsset(
    organizationId: string,
    input: {
      storageKey: string;
      mediaType: string;
      size: number;
      contentDigest: string;
    },
  ) {
    if (!input.storageKey.startsWith(`templates/${organizationId}/`)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '模板图片不属于当前组织',
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
        '对象存储尚未配置，暂时无法校验模板图片',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    let response: Response;
    try {
      response = await fetch(internalUrl, { signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '模板图片暂时无法读取，请重新上传',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!response.ok) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '模板图片尚未上传成功',
        HttpStatus.BAD_REQUEST,
      );
    }
    let file: Buffer;
    try {
      file = await readUploadWithinLimit(response, input.size);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '模板图片与上传登记信息不一致',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0];
    const digest = createHash('sha256').update(file).digest('hex');
    if (
      file.byteLength !== input.size ||
      mediaType !== input.mediaType ||
      !matchesDeclaredMediaType(file, input.mediaType) ||
      digest !== input.contentDigest
    ) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '模板图片与上传登记信息不一致',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  async createAsset(
    organizationId: string,
    actorId: string,
    input: {
      storageKey: string;
      mediaType: string;
      size: number;
      width?: number | undefined;
      height?: number | undefined;
      contentDigest: string;
      altText: string;
    },
  ) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(input.mediaType) || input.size > 10 * 1024 * 1024) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '模板资产格式或大小不符合要求',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const result = await this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
      );
      const [reservation] = await tx
        .select()
        .from(templateAssetUploadReservations)
        .where(
          and(
            eq(templateAssetUploadReservations.organizationId, organizationId),
            eq(templateAssetUploadReservations.storageKey, input.storageKey),
          ),
        )
        .limit(1);
      if (
        !reservation ||
        reservation.mediaType !== input.mediaType ||
        reservation.size !== input.size ||
        reservation.contentDigest !== input.contentDigest
      ) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '模板图片上传预留不存在、已过期或登记信息不一致',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (reservation.consumedAssetId) {
        const [consumedAsset] = await tx
          .select()
          .from(templateAssets)
          .where(
            and(
              eq(templateAssets.id, reservation.consumedAssetId),
              eq(templateAssets.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!consumedAsset) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '模板图片登记结果已经失效，请重新上传',
            HttpStatus.CONFLICT,
          );
        }
        return consumedAsset;
      }
      if (reservation.expiresAt <= new Date()) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '模板图片上传预留已过期，请重新上传',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      await this.assertStoredAsset(organizationId, input);
      const [existing] = await tx
        .select()
        .from(templateAssets)
        .where(
          and(
            eq(templateAssets.organizationId, organizationId),
            eq(templateAssets.contentDigest, input.contentDigest),
          ),
        )
        .limit(1);
      let asset: typeof templateAssets.$inferSelect | undefined;
      if (existing) {
        [asset] = await tx
          .update(templateAssets)
          .set({ altText: input.altText })
          .where(eq(templateAssets.id, existing.id))
          .returning();
        if (input.storageKey !== existing.storageKey) {
          await tx.insert(outboxEvents).values({
            organizationId,
            eventType: 'TemplateAssetDeletionRequested',
            correlationId: `template-asset:deduplicate:${randomUUID()}`,
            payload: { organizationId, storageKey: input.storageKey },
          });
        }
      } else {
        const [usage] = await tx
          .select({ count: count(), bytes: sql<number>`coalesce(sum(${templateAssets.size}), 0)` })
          .from(templateAssets)
          .where(eq(templateAssets.organizationId, organizationId));
        const maxBytes =
          Number(process.env.HTML_TEMPLATE_ORG_ASSET_BYTES ?? DEFAULT_ORG_ASSET_BYTES) ||
          DEFAULT_ORG_ASSET_BYTES;
        const maxCount =
          Number(process.env.HTML_TEMPLATE_ORG_ASSET_COUNT ?? DEFAULT_ORG_ASSET_COUNT) ||
          DEFAULT_ORG_ASSET_COUNT;
        if ((usage?.count ?? 0) >= maxCount || Number(usage?.bytes ?? 0) + input.size > maxBytes) {
          await tx.insert(outboxEvents).values({
            organizationId,
            eventType: 'TemplateAssetDeletionRequested',
            correlationId: `template-asset:quota-cleanup:${randomUUID()}`,
            payload: { organizationId, storageKey: input.storageKey },
          });
          return null;
        }
        [asset] = await tx
          .insert(templateAssets)
          .values({ organizationId, createdBy: actorId, ...input })
          .returning();
      }
      if (!asset) throw new Error('模板资产登记失败');
      await tx
        .update(templateAssetUploadReservations)
        .set({
          consumedAssetId: asset.id,
          consumedAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        })
        .where(eq(templateAssetUploadReservations.id, reservation.id));
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.asset.create',
        resourceType: 'template_asset',
        resourceId: asset.id,
        after: {
          storageKey: asset.storageKey,
          mediaType: asset.mediaType,
          size: asset.size,
        },
        traceId: crypto.randomUUID(),
      });
      return asset;
    });
    if (!result) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '组织模板资产容量已达上限，请清理不再使用的模板图片',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return {
      ...result,
      previewUrl: this.s3Presigned(result.storageKey, 'GET'),
      createdAt: result.createdAt.toISOString(),
    };
  }

  async deleteAsset(organizationId: string, assetId: string, actorId: string) {
    const db = this.db();
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
      );
      const [asset] = await tx
        .select()
        .from(templateAssets)
        .where(
          and(eq(templateAssets.id, assetId), eq(templateAssets.organizationId, organizationId)),
        )
        .for('update')
        .limit(1);
      if (!asset) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '模板资产不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const [activeImportLease] = await tx
        .select({ importId: templateHtmlImportAssets.importId })
        .from(templateHtmlImportAssets)
        .where(
          and(
            eq(templateHtmlImportAssets.organizationId, organizationId),
            eq(templateHtmlImportAssets.assetId, assetId),
            isNull(templateHtmlImportAssets.releasedAt),
          ),
        )
        .limit(1);
      if (activeImportLease) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '模板资产仍被待提交的 HTML 导入任务使用',
          HttpStatus.CONFLICT,
          { importId: activeImportLease.importId },
        );
      }

      const [speakerReference] = await tx
        .select({ id: speakers.id })
        .from(speakers)
        .where(
          and(eq(speakers.organizationId, organizationId), eq(speakers.avatarAssetId, assetId)),
        )
        .limit(1);
      if (speakerReference) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '图片仍被嘉宾头像引用',
          HttpStatus.CONFLICT,
          { speakerId: speakerReference.id },
        );
      }

      const drafts = await tx
        .select({
          id: conferenceTemplateDrafts.templateId,
          document: conferenceTemplateDrafts.definition,
        })
        .from(conferenceTemplateDrafts)
        .innerJoin(
          conferenceTemplates,
          eq(conferenceTemplates.id, conferenceTemplateDrafts.templateId),
        )
        .where(eq(conferenceTemplates.organizationId, organizationId));
      const versions = await tx
        .select({
          id: conferenceTemplateVersions.id,
          document: conferenceTemplateVersions.definition,
        })
        .from(conferenceTemplateVersions)
        .innerJoin(
          conferenceTemplates,
          eq(conferenceTemplates.id, conferenceTemplateVersions.templateId),
        )
        .where(eq(conferenceTemplates.organizationId, organizationId));
      const overrides = await tx
        .select({ id: eventTemplateOverrides.id, document: eventTemplateOverrides.document })
        .from(eventTemplateOverrides)
        .innerJoin(events, eq(events.id, eventTemplateOverrides.eventId))
        .where(eq(events.organizationId, organizationId));
      const releases = await tx
        .select({ id: eventReleases.id, document: eventReleases.snapshot })
        .from(eventReleases)
        .innerJoin(events, eq(events.id, eventReleases.eventId))
        .where(eq(events.organizationId, organizationId));
      const htmlDocuments = await tx
        .select({
          id: templateHtmlDocuments.id,
          assetManifest: templateHtmlDocuments.assetManifest,
          sanitizedHtml: templateHtmlDocuments.sanitizedHtml,
        })
        .from(templateHtmlDocuments)
        .where(eq(templateHtmlDocuments.organizationId, organizationId));
      const needles = [asset.id, asset.storageKey];
      const references = [
        ...drafts,
        ...versions,
        ...overrides,
        ...releases,
        ...htmlDocuments.map((document) => ({ id: document.id, document })),
      ].filter((item) => {
        const serialized = JSON.stringify(item.document);
        return needles.some((needle) => serialized.includes(needle));
      });
      if (references.length) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '模板资产仍被草稿、已发布版本或大会覆盖引用',
          HttpStatus.CONFLICT,
          {
            referenceCount: references.length,
            references: references.map((item) => item.id),
          },
        );
      }

      await tx
        .delete(templateAssets)
        .where(
          and(eq(templateAssets.id, assetId), eq(templateAssets.organizationId, organizationId)),
        );
      await tx.insert(outboxEvents).values({
        organizationId,
        eventType: 'TemplateAssetDeletionRequested',
        correlationId: `template-asset:delete:${asset.id}`,
        payload: { assetId: asset.id, organizationId, storageKey: asset.storageKey },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'template.asset.delete',
        resourceType: 'template_asset',
        resourceId: asset.id,
        before: {
          storageKey: asset.storageKey,
          mediaType: asset.mediaType,
          size: asset.size,
        },
        traceId: crypto.randomUUID(),
      });
      return { deleted: true, assetId: asset.id };
    });
  }
}
