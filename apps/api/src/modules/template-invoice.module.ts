import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_ERROR_CODES,
  CreateConferenceTemplateSchema,
  CreateInvoiceDocumentSchema,
  InvoiceActionSchema,
  InvoiceBatchPreflightSchema,
  InvoiceVersionSchema,
  InvoiceBuyerSchema,
  InvoiceListQuerySchema,
  PublishConferenceTemplateSchema,
  SaveConferenceTemplateDraftSchema,
  SaveEventExperienceOverrideSchema,
  SubmitInvoiceDetailsSchema,
  RequestOrderAccessLinkSchema,
  TemplateSurfaceSchema,
  UpdateConferenceTemplateSchema,
  UpdateEventTemplateBindingSchema,
  HtmlTemplateBindingManifestSchema,
  type EventId,
} from '@conference/contracts';
import { z } from 'zod';
import {
  AuthGuard,
  grantAllows,
  RequireAllGrants,
  RequireGrant,
  type AuthenticatedUser,
} from '../common/auth.guard.js';
import { DomainError } from '../common/domain-error.js';
import { EventIdPipe } from '../common/event-id.pipe.js';
import {
  buildInvoiceExportCsv,
  InvoiceOperationsService,
} from '../common/invoice-operations.service.js';
import { TemplateOperationsService } from '../common/template-operations.service.js';
import { IdempotencyService, idempotencyRequestHash } from '../common/idempotency.service.js';
import { ConferenceRepository } from '../common/conference.repository.js';
import { HtmlTemplateOperationsService } from '../common/html-template-operations.service.js';

type AuthenticatedRequest = FastifyRequest & { user: AuthenticatedUser };

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '提交内容校验失败',
      HttpStatus.BAD_REQUEST,
      { issues: result.error.issues },
    );
  }
  return result.data;
}

function requireIdempotencyKey(value: string | undefined) {
  if (!value || value.length < 8 || value.length > 160) {
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '写操作需要 8 到 160 字符的 Idempotency-Key',
      HttpStatus.BAD_REQUEST,
    );
  }
  return value;
}

function requireAccessToken(authorization: string | undefined) {
  const value = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (value.length < 32 || value.length > 500) {
    throw new DomainError(
      API_ERROR_CODES.UNAUTHORIZED,
      '订单访问链接无效或已经过期',
      HttpStatus.UNAUTHORIZED,
    );
  }
  return value;
}

const ArchiveSchema = z.object({ revision: z.number().int().nonnegative() });
const DuplicateSchema = z.object({
  revision: z.number().int().nonnegative(),
  name: z.string().trim().min(2).max(160).optional(),
});
const AssetSchema = z.object({
  storageKey: z.string().trim().min(3).max(500),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  contentDigest: z.string().trim().min(16).max(128),
  altText: z.string().trim().max(500).default(''),
});
const PrepareTemplateAssetUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  contentDigest: z.string().trim().min(16).max(128),
  altText: z.string().trim().max(500).default(''),
});
const PrepareInvoiceDocumentUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  mediaType: z.enum(['application/pdf', 'application/ofd']),
  size: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  contentDigest: z.string().trim().min(16).max(128),
  replaceDocumentId: z.string().uuid().optional(),
});
const ReplaceInvoiceDocumentFileSchema = InvoiceActionSchema.extend({
  storageKey: z.string().trim().min(3).max(500),
  mediaType: z.enum(['application/pdf', 'application/ofd']),
  size: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  contentDigest: z.string().trim().min(16).max(128),
});
const SaveEventAsTemplateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().min(2).max(2000),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  includeContent: z.boolean().default(false),
});
const PrepareHtmlImportSchema = z
  .object({
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/\.html?$/iu),
    size: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024),
    sourceDigest: z
      .string()
      .trim()
      .regex(/^(?:sha256:)?[a-f0-9]{64}$/iu),
    mode: z.enum(['create', 'replace']).default('create'),
    templateId: z.string().uuid().optional(),
    requestedMetadata: z
      .object({
        name: z.string().trim().min(2).max(160).optional(),
        description: z.string().trim().min(2).max(2000).optional(),
        tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
        sourceUrl: z.url().max(1000).optional(),
      })
      .default({}),
  })
  .superRefine((value, context) => {
    if (value.mode === 'replace' && !value.templateId) {
      context.addIssue({ code: 'custom', path: ['templateId'], message: '替换模式需要模板 ID' });
    }
  });
const CommitHtmlImportSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  bindings: HtmlTemplateBindingManifestSchema,
  confirmWarnings: z.boolean().default(false),
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().min(2).max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});
const SaveHtmlBindingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  bindings: HtmlTemplateBindingManifestSchema,
});
const ApplyHtmlAiProposalsSchema = z.object({
  proposalIds: z.array(z.string().min(1).max(120)).min(1).max(400),
});

@ApiTags('conference-templates')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('admin')
class TemplateController {
  constructor(
    @Inject(TemplateOperationsService)
    private readonly templates: TemplateOperationsService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(JwtService)
    private readonly jwt: JwtService,
    @Inject(HtmlTemplateOperationsService)
    private readonly htmlTemplates: HtmlTemplateOperationsService,
  ) {}

  @Get('templates')
  @RequireGrant('org.template.read')
  list(@Req() request: AuthenticatedRequest) {
    return this.templates.list(request.user.organizationId);
  }

  @Get('template-options')
  @RequireGrant('org.template.use')
  options(@Req() request: AuthenticatedRequest) {
    return this.templates.options(request.user.organizationId);
  }

  @Get('template-variable-catalog')
  @RequireGrant('org.template.read')
  variableCatalog() {
    return this.htmlTemplates.variableCatalog();
  }

  @Get('template-html-imports')
  @RequireGrant('org.template.read')
  htmlImports(@Req() request: AuthenticatedRequest) {
    return this.htmlTemplates.listImports(request.user.organizationId);
  }

  @Post('template-html-imports')
  @RequireGrant('org.template.manage')
  prepareHtmlImport(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(PrepareHtmlImportSchema, body);
    const idempotencyKey = requireIdempotencyKey(key);
    return this.idempotency.execute(
      `template:html-import:prepare:${request.user.organizationId}`,
      idempotencyKey,
      input,
      () =>
        this.htmlTemplates.prepareImport(
          request.user.organizationId,
          request.user.sub,
          input,
          idempotencyKey,
        ),
      { ttlMs: 9 * 60_000, allowLeaseTakeover: true },
    );
  }

  @Get('template-html-imports/:importId')
  @RequireGrant('org.template.read')
  htmlImport(@Param('importId') importId: string, @Req() request: AuthenticatedRequest) {
    return this.htmlTemplates.readImport(request.user.organizationId, importId);
  }

  @Post('template-html-imports/:importId/scan')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireGrant('org.template.manage')
  scanHtmlImport(
    @Param('importId') importId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.idempotency.execute(
      `template:html-import:scan:${request.user.organizationId}:${importId}`,
      requireIdempotencyKey(key),
      { importId },
      () => this.htmlTemplates.scanImport(request.user.organizationId, importId, request.user.sub),
      { ttlMs: 15 * 60_000, allowLeaseTakeover: true },
    );
  }

  @Post('template-html-imports/:importId/retry')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireGrant('org.template.manage')
  retryHtmlImport(
    @Param('importId') importId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.idempotency.execute(
      `template:html-import:retry:${request.user.organizationId}:${importId}`,
      requireIdempotencyKey(key),
      { importId },
      () => this.htmlTemplates.scanImport(request.user.organizationId, importId, request.user.sub),
      { ttlMs: 15 * 60_000, allowLeaseTakeover: true },
    );
  }

  @Delete('template-html-imports/:importId')
  @RequireGrant('org.template.manage')
  cancelHtmlImport(
    @Param('importId') importId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.idempotency.execute(
      `template:html-import:cancel:${request.user.organizationId}:${importId}`,
      requireIdempotencyKey(key),
      { importId },
      () =>
        this.htmlTemplates.cancelImport(request.user.organizationId, importId, request.user.sub),
    );
  }

  @Post('template-html-imports/:importId/commit')
  @RequireGrant('org.template.manage')
  commitHtmlImport(
    @Param('importId') importId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(CommitHtmlImportSchema, body);
    return this.idempotency.execute(
      `template:html-import:commit:${request.user.organizationId}:${importId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.htmlTemplates.commitImport(
          request.user.organizationId,
          importId,
          request.user.sub,
          input,
        ),
      { ttlMs: 15 * 60_000, allowLeaseTakeover: true },
    );
  }

  @Post('templates')
  @RequireGrant('org.template.manage')
  create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(CreateConferenceTemplateSchema, body);
    if (input.publishImmediately && !grantAllows(request.user.grants, 'org.template.publish')) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '当前角色缺少发布模板所需的权限',
        HttpStatus.FORBIDDEN,
      );
    }
    const idempotencyKey = requireIdempotencyKey(key);
    return this.idempotency.execute(
      `template:create:${request.user.organizationId}`,
      idempotencyKey,
      input,
      () =>
        this.templates.create(request.user.organizationId, request.user.sub, input, idempotencyKey),
      { allowLeaseTakeover: true },
    );
  }

  @Get('templates/:templateId')
  @RequireGrant('org.template.read')
  detail(@Param('templateId') templateId: string, @Req() request: AuthenticatedRequest) {
    return this.templates.detail(request.user.organizationId, templateId);
  }

  @Get('templates/:templateId/html-document')
  @RequireGrant('org.template.read')
  htmlDocument(@Param('templateId') templateId: string, @Req() request: AuthenticatedRequest) {
    return this.htmlTemplates.documentDetail(request.user.organizationId, templateId);
  }

  @Put('templates/:templateId/html-bindings')
  @RequireGrant('org.template.manage')
  saveHtmlBindings(
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(SaveHtmlBindingsSchema, body);
    return this.htmlTemplates.saveBindings(
      request.user.organizationId,
      templateId,
      request.user.sub,
      input.revision,
      input.bindings,
    );
  }

  @Post('templates/:templateId/html-preview')
  @RequireGrant('org.template.read')
  async htmlPreview(@Param('templateId') templateId: string, @Req() request: AuthenticatedRequest) {
    const preview = await this.htmlTemplates.renderPreview(request.user.organizationId, templateId);
    const channelId = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const previewToken = await this.jwt.signAsync(
      {
        purpose: 'html-template-preview',
        organizationId: request.user.organizationId,
        templateId,
        revision: preview.revision,
        documentDigest: preview.documentDigest,
        bindingDigest: preview.bindingDigest,
        channelId,
      },
      { expiresIn: '10m' },
    );
    return {
      previewUrl: `/api/v1/template-previews?token=${encodeURIComponent(previewToken)}`,
      expiresAt: expiresAt.toISOString(),
      revision: preview.revision,
      documentDigest: preview.documentDigest,
      bindingDigest: preview.bindingDigest,
      channelId,
    };
  }

  @Get('templates/:templateId/ai-variable-mappings')
  @RequireGrant('org.template.read')
  htmlAiRuns(@Param('templateId') templateId: string, @Req() request: AuthenticatedRequest) {
    return this.htmlTemplates.listAiRuns(request.user.organizationId, templateId);
  }

  @Post('templates/:templateId/ai-variable-mappings')
  @RequireGrant('org.template.ai.generate')
  createHtmlAiRun(
    @Param('templateId') templateId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.idempotency.execute(
      `template:ai-mapping:create:${request.user.organizationId}:${templateId}`,
      idempotencyKey,
      { templateId },
      () =>
        this.htmlTemplates.createAiMappingRun(
          request.user.organizationId,
          templateId,
          request.user.sub,
          idempotencyKey,
          idempotencyRequestHash({ templateId }),
        ),
      { allowLeaseTakeover: true },
    );
  }

  @Post('templates/:templateId/ai-variable-mappings/:runId/apply')
  @RequireGrant('org.template.manage')
  applyHtmlAiRun(
    @Param('templateId') templateId: string,
    @Param('runId') runId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(ApplyHtmlAiProposalsSchema, body);
    return this.idempotency.execute(
      `template:ai-mapping:apply:${request.user.organizationId}:${templateId}:${runId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.htmlTemplates.applyAiProposals(
          request.user.organizationId,
          templateId,
          runId,
          request.user.sub,
          input.proposalIds,
        ),
      { allowLeaseTakeover: true },
    );
  }

  @Post('templates/:templateId/ai-variable-mappings/:runId/cancel')
  @RequireGrant('org.template.ai.generate')
  cancelHtmlAiRun(
    @Param('templateId') templateId: string,
    @Param('runId') runId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.idempotency.execute(
      `template:ai-mapping:cancel:${request.user.organizationId}:${templateId}:${runId}`,
      requireIdempotencyKey(key),
      { runId },
      () =>
        this.htmlTemplates.cancelAiMappingRun(
          request.user.organizationId,
          templateId,
          runId,
          request.user.sub,
        ),
    );
  }

  @Post('templates/:templateId/ai-variable-mappings/:runId/reject')
  @RequireGrant('org.template.manage')
  rejectHtmlAiRun(
    @Param('templateId') templateId: string,
    @Param('runId') runId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.idempotency.execute(
      `template:ai-mapping:reject:${request.user.organizationId}:${templateId}:${runId}`,
      requireIdempotencyKey(key),
      { runId },
      () =>
        this.htmlTemplates.rejectAiMappingRun(
          request.user.organizationId,
          templateId,
          runId,
          request.user.sub,
        ),
      { allowLeaseTakeover: true },
    );
  }

  @Patch('templates/:templateId')
  @RequireGrant('org.template.manage')
  update(
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.templates.update(
      request.user.organizationId,
      templateId,
      request.user.sub,
      parse(UpdateConferenceTemplateSchema, body),
    );
  }

  @Get('templates/:templateId/draft')
  @RequireGrant('org.template.read')
  draft(@Param('templateId') templateId: string, @Req() request: AuthenticatedRequest) {
    return this.templates.draft(request.user.organizationId, templateId);
  }

  @Put('templates/:templateId/draft')
  @RequireGrant('org.template.manage')
  saveDraft(
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.templates.saveDraft(
      request.user.organizationId,
      templateId,
      request.user.sub,
      parse(SaveConferenceTemplateDraftSchema, body),
    );
  }

  @Post('templates/:templateId/publish')
  @RequireGrant('org.template.publish')
  publish(
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(PublishConferenceTemplateSchema, body);
    const idempotencyKey = requireIdempotencyKey(key);
    return this.idempotency.execute(
      `template:publish:${request.user.organizationId}:${templateId}`,
      idempotencyKey,
      input,
      async () => {
        await this.htmlTemplates.validatePublish(request.user.organizationId, templateId);
        return this.templates.publish(
          request.user.organizationId,
          templateId,
          request.user.sub,
          input,
          idempotencyKey,
        );
      },
      { allowLeaseTakeover: true },
    );
  }

  @Get('templates/:templateId/versions')
  @RequireGrant('org.template.read')
  versions(@Param('templateId') templateId: string, @Req() request: AuthenticatedRequest) {
    return this.templates.versions(request.user.organizationId, templateId);
  }

  @Get('templates/:templateId/usages')
  @RequireGrant('org.template.read')
  usages(@Param('templateId') templateId: string, @Req() request: AuthenticatedRequest) {
    return this.templates.usages(request.user.organizationId, templateId);
  }

  @Post('templates/:templateId/duplicate')
  @RequireGrant('org.template.manage')
  duplicate(
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(DuplicateSchema, body);
    const idempotencyKey = requireIdempotencyKey(key);
    return this.idempotency.execute(
      `template:duplicate:${request.user.organizationId}:${templateId}`,
      idempotencyKey,
      input,
      () =>
        this.templates.duplicate(
          request.user.organizationId,
          templateId,
          request.user.sub,
          input.revision,
          input.name,
          idempotencyKey,
        ),
      { allowLeaseTakeover: true },
    );
  }

  @Post('templates/:templateId/archive')
  @RequireGrant('org.template.manage')
  archive(
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(ArchiveSchema, body);
    return this.idempotency.execute(
      `template:archive:${request.user.organizationId}:${templateId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.templates.setArchived(
          request.user.organizationId,
          templateId,
          request.user.sub,
          true,
          input.revision,
        ),
    );
  }

  @Post('templates/:templateId/restore')
  @RequireGrant('org.template.manage')
  restore(
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(ArchiveSchema, body);
    return this.idempotency.execute(
      `template:restore:${request.user.organizationId}:${templateId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.templates.setArchived(
          request.user.organizationId,
          templateId,
          request.user.sub,
          false,
          input.revision,
        ),
    );
  }

  @Get('template-assets')
  @RequireGrant('org.template.read')
  assets(@Req() request: AuthenticatedRequest) {
    return this.templates.listAssets(request.user.organizationId);
  }

  @Post('template-assets/uploads')
  @RequireGrant('org.template.manage')
  prepareAssetUpload(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(PrepareTemplateAssetUploadSchema, body);
    const idempotencyKey = requireIdempotencyKey(key);
    return this.idempotency.execute(
      `template:asset:upload:${request.user.organizationId}`,
      idempotencyKey,
      input,
      () =>
        this.templates.prepareAssetUpload(
          request.user.organizationId,
          request.user.sub,
          input,
          idempotencyKey,
        ),
      { ttlMs: 9 * 60_000, allowLeaseTakeover: true },
    );
  }

  @Post('template-assets')
  @RequireGrant('org.template.manage')
  createAsset(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(AssetSchema, body);
    return this.idempotency.execute(
      `template:asset:create:${request.user.organizationId}`,
      requireIdempotencyKey(key),
      input,
      () => this.templates.createAsset(request.user.organizationId, request.user.sub, input),
    );
  }

  @Delete('template-assets/:assetId')
  @RequireGrant('org.template.manage')
  deleteAsset(
    @Param('assetId') assetId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.idempotency.execute(
      `template:asset:delete:${request.user.organizationId}:${assetId}`,
      requireIdempotencyKey(key),
      { assetId },
      () => this.templates.deleteAsset(request.user.organizationId, assetId, request.user.sub),
    );
  }

  @Get('events/:eventId/template-binding')
  @RequireGrant('event.site.read')
  binding(@Param('eventId', EventIdPipe) eventId: EventId, @Req() request: AuthenticatedRequest) {
    return this.templates.binding(request.user.organizationId, eventId);
  }

  @Post('events/:eventId/save-as-template')
  @RequireAllGrants('event.manage', 'org.template.manage', 'org.template.publish')
  saveEventAsTemplate(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(SaveEventAsTemplateSchema, body);
    const commandKey = requireIdempotencyKey(key);
    return this.idempotency.execute(
      `event:save-as-template:${request.user.organizationId}:${eventId}`,
      commandKey,
      input,
      () =>
        this.templates.saveEventAsTemplate(
          request.user.organizationId,
          eventId,
          request.user.sub,
          input,
          commandKey,
        ),
      { allowLeaseTakeover: true },
    );
  }

  @Put('events/:eventId/template-binding')
  @RequireAllGrants('event.manage', 'org.template.use')
  updateBinding(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.templates.updateBinding(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(UpdateEventTemplateBindingSchema, body),
    );
  }

  @Get('events/:eventId/experience')
  @RequireGrant('event.site.read')
  experience(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.templates.experience(request.user.organizationId, eventId);
  }

  @Put('events/:eventId/experience/:surface')
  @RequireGrant('event.content.manage')
  saveExperience(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('surface') surfaceValue: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const surface = parse(TemplateSurfaceSchema, surfaceValue);
    return this.templates.saveOverride(
      request.user.organizationId,
      eventId,
      surface,
      request.user.sub,
      parse(SaveEventExperienceOverrideSchema, body),
    );
  }

  @Post('events/:eventId/experience/validate')
  @RequireGrant('event.content.manage')
  async validateExperience(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Req() request: AuthenticatedRequest,
  ) {
    return (await this.templates.experience(request.user.organizationId, eventId)).validation;
  }

  @Post('events/:eventId/experience/preview')
  @RequireGrant('event.site.read')
  async preview(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.templates.experience(request.user.organizationId, eventId);
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const previewToken = await this.jwt.signAsync(
      {
        purpose: 'event-experience-preview',
        eventId,
        organizationId: request.user.organizationId,
        requestedBy: request.user.sub,
      },
      { expiresIn: '30m' },
    );
    return {
      previewToken,
      previewUrl: `/previews/events/${encodeURIComponent(eventId)}?token=${encodeURIComponent(previewToken)}`,
      eventId,
      expiresAt: expiresAt.toISOString(),
      noIndex: true,
      submissionsDisabled: true,
    };
  }
}

@ApiTags('invoice-operations')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('admin/events/:eventId/invoices')
class InvoiceController {
  constructor(
    @Inject(InvoiceOperationsService)
    private readonly invoices: InvoiceOperationsService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @RequireAllGrants('event.read', 'org.invoice.read')
  list(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.invoices.page(
      request.user.organizationId,
      parse(InvoiceListQuerySchema, { ...query, eventId: String(eventId) }),
    );
  }

  @Get('pending-count')
  @RequireAllGrants('event.read', 'org.invoice.read')
  async pendingCount(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Req() request: AuthenticatedRequest,
  ) {
    const statuses = ['pending_review', 'issue_failed', 'adjustment_required'] as const;
    const groups = await Promise.all(
      statuses.map((status) =>
        this.invoices.exportRowCount(request.user.organizationId, { eventId, status }),
      ),
    );
    return { count: groups.reduce((sum, group) => sum + group, 0) };
  }

  @Post('batch-imports/preflight')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  preflightBatchImport(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.invoices.preflightBatchImport(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(InvoiceBatchPreflightSchema, body),
    );
  }

  @Get('export.csv')
  @RequireAllGrants('event.read', 'org.invoice.export')
  async exportCsv(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Query() query: Record<string, unknown>,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = parse(InvoiceListQuerySchema, { ...query, eventId: String(eventId) });
    const parsedQuery = { ...parsed, cursor: undefined, limit: undefined };
    const exportKey = requireIdempotencyKey(key);
    const rowCount = await this.invoices.exportRowCount(request.user.organizationId, parsedQuery);
    if (this.invoices.requiresAsyncExport(rowCount)) {
      const job = await this.idempotency.execute(
        `invoice:export:${request.user.organizationId}:${eventId}`,
        exportKey,
        parsedQuery,
        () =>
          this.invoices.queueExport(
            request.user.organizationId,
            eventId,
            request.user.sub,
            parsedQuery,
            rowCount,
          ),
      );
      return reply.code(HttpStatus.ACCEPTED).send(job);
    }
    const rows = await this.invoices.exportRows(request.user.organizationId, parsedQuery);
    await this.invoices.auditExport(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parsedQuery,
      rows.length,
    );
    const csv = buildInvoiceExportCsv(rows);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="invoice-requests.csv"')
      .header('X-Export-Row-Count', String(rows.length))
      .send(`\uFEFF${csv}`);
  }

  @Get('export-jobs/:exportJobId')
  @RequireAllGrants('event.read', 'org.invoice.export')
  exportJob(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('exportJobId') exportJobId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.invoices.exportJob(request.user.organizationId, eventId, exportJobId);
  }

  @Post('export-jobs/:exportJobId/retry')
  @RequireAllGrants('event.read', 'org.invoice.export')
  retryExport(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('exportJobId') exportJobId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.idempotency.execute(
      `invoice:export:retry:${request.user.organizationId}:${eventId}:${exportJobId}`,
      requireIdempotencyKey(key),
      { exportJobId },
      () =>
        this.invoices.retryExport(
          request.user.organizationId,
          eventId,
          exportJobId,
          request.user.sub,
        ),
    );
  }

  @Get('export-jobs/:exportJobId/download')
  @RequireAllGrants('event.read', 'org.invoice.export')
  async downloadExport(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('exportJobId') exportJobId: string,
    @Query('expires') expiresValue: string,
    @Query('signature') signature: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.invoices.downloadExport(
      request.user.organizationId,
      eventId,
      exportJobId,
      Number(expiresValue),
      signature,
      request.user.sub,
    );
    if (result.downloadUrl) {
      const upstream = await fetch(result.downloadUrl, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!upstream.ok || !upstream.body) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '发票导出文件暂时无法读取，请稍后重试',
          HttpStatus.BAD_GATEWAY,
        );
      }
      if (result.size) reply.header('Content-Length', String(result.size));
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="${result.filename.replaceAll('"', '')}"`,
        )
        .send(
          Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream),
        );
    }
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="${result.filename.replaceAll('"', '')}"`,
      )
      .send(`\uFEFF${result.content ?? ''}`);
  }

  @Get(':invoiceId')
  @RequireAllGrants('event.read', 'org.invoice.read')
  async detail(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await this.invoices.detail(
      request.user.organizationId,
      invoiceId,
      true,
      eventId,
    );
    await this.invoices.auditRead(
      request.user.organizationId,
      eventId,
      invoiceId,
      request.user.sub,
    );
    return result;
  }

  @Get(':invoiceId/documents/:documentId/download')
  @RequireAllGrants('event.read', 'org.invoice.read')
  async downloadDocument(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Param('documentId') documentId: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const downloadUrl = await this.invoices.adminDocumentDownload(
      request.user.organizationId,
      eventId,
      invoiceId,
      documentId,
      request.user.sub,
    );
    return reply.code(HttpStatus.FOUND).redirect(downloadUrl);
  }

  @Post(':invoiceId/approve')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  approve(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(InvoiceVersionSchema, body);
    return this.idempotency.execute(
      `invoice:approve:${request.user.organizationId}:${eventId}:${invoiceId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.invoices.approve(
          request.user.organizationId,
          invoiceId,
          request.user.sub,
          input,
          eventId,
        ),
    );
  }

  @Post(':invoiceId/reject')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  reject(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(InvoiceActionSchema, body);
    return this.idempotency.execute(
      `invoice:reject:${request.user.organizationId}:${eventId}:${invoiceId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.invoices.reject(
          request.user.organizationId,
          invoiceId,
          request.user.sub,
          input,
          eventId,
        ),
    );
  }

  @Post(':invoiceId/retry')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  retry(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(InvoiceActionSchema, body);
    return this.idempotency.execute(
      `invoice:retry:${request.user.organizationId}:${eventId}:${invoiceId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.invoices.retry(
          request.user.organizationId,
          invoiceId,
          request.user.sub,
          input,
          eventId,
        ),
    );
  }

  @Post(':invoiceId/issue-failed')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  issueFailed(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(InvoiceActionSchema, body);
    return this.idempotency.execute(
      `invoice:issue-failed:${request.user.organizationId}:${eventId}:${invoiceId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.invoices.markIssueFailed(
          request.user.organizationId,
          invoiceId,
          request.user.sub,
          input,
          eventId,
        ),
    );
  }

  @Post(':invoiceId/cancel')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  cancel(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(InvoiceActionSchema, body);
    return this.idempotency.execute(
      `invoice:cancel:${request.user.organizationId}:${eventId}:${invoiceId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.invoices.cancel(
          request.user.organizationId,
          invoiceId,
          request.user.sub,
          input,
          eventId,
        ),
    );
  }

  @Post(':invoiceId/documents')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  document(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(CreateInvoiceDocumentSchema, body);
    return this.idempotency.execute(
      `invoice:document:create:${request.user.organizationId}:${eventId}:${invoiceId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.invoices.addDocument(
          request.user.organizationId,
          invoiceId,
          request.user.sub,
          input,
          eventId,
        ),
    );
  }

  @Post(':invoiceId/document-uploads')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  prepareDocumentUpload(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(PrepareInvoiceDocumentUploadSchema, body);
    return this.idempotency.execute(
      `invoice:document-upload:${request.user.organizationId}:${eventId}:${invoiceId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.invoices.prepareDocumentUpload(
          request.user.organizationId,
          invoiceId,
          request.user.sub,
          input,
          eventId,
        ),
      9 * 60_000,
    );
  }

  @Post(':invoiceId/documents/:documentId/void')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  voidDocument(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(InvoiceActionSchema, body);
    return this.idempotency.execute(
      `invoice:document:void:${request.user.organizationId}:${eventId}:${invoiceId}:${documentId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.invoices.voidDocument(
          request.user.organizationId,
          invoiceId,
          documentId,
          request.user.sub,
          input,
          eventId,
        ),
    );
  }

  @Post(':invoiceId/documents/:documentId/replace-file')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  replaceDocumentFile(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(ReplaceInvoiceDocumentFileSchema, body);
    return this.idempotency.execute(
      `invoice:document:replace-file:${request.user.organizationId}:${eventId}:${invoiceId}:${documentId}`,
      requireIdempotencyKey(key),
      input,
      () =>
        this.invoices.replaceDocumentFile(
          request.user.organizationId,
          invoiceId,
          documentId,
          request.user.sub,
          input,
          eventId,
        ),
    );
  }

  @Post(':invoiceId/send')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  send(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.idempotency.execute(
      `invoice:send:${request.user.organizationId}:${eventId}:${invoiceId}`,
      requireIdempotencyKey(key),
      { invoiceId },
      () => this.invoices.send(request.user.organizationId, invoiceId, request.user.sub, eventId),
    );
  }

  @Post(':invoiceId/details-reminder')
  @RequireAllGrants('event.read', 'org.invoice.manage')
  requestDetailsReminder(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('invoiceId') invoiceId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.idempotency.execute(
      `invoice:details-reminder:${request.user.organizationId}:${eventId}:${invoiceId}`,
      requireIdempotencyKey(key),
      { invoiceId },
      () =>
        this.invoices.requestDetailsReminder(
          request.user.organizationId,
          invoiceId,
          request.user.sub,
          eventId,
        ),
    );
  }
}

@ApiTags('public-invoices')
@Controller('invoices')
class PublicInvoiceController {
  constructor(
    @Inject(InvoiceOperationsService)
    private readonly invoices: InvoiceOperationsService,
  ) {}

  @Post(':invoiceId/details')
  submit(@Param('invoiceId') invoiceId: string, @Body() body: unknown) {
    return this.invoices.submitDetails(invoiceId, parse(SubmitInvoiceDetailsSchema, body));
  }
}

@ApiTags('public-order-invoices')
@Controller('orders')
class OrderInvoiceAccessController {
  constructor(
    @Inject(InvoiceOperationsService)
    private readonly invoices: InvoiceOperationsService,
  ) {}

  @Post('access-links')
  @Throttle({ default: { limit: 20, ttl: 60 * 60_000 } })
  requestLink(@Body() body: unknown) {
    return this.invoices.requestOrderAccessLink(parse(RequestOrderAccessLinkSchema, body));
  }

  @Get(':orderId/invoice-request')
  read(
    @Param('orderId') orderId: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.invoices.readOrderInvoice(orderId, requireAccessToken(authorization));
  }

  @Post(':orderId/invoice-request')
  submit(
    @Param('orderId') orderId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    return this.invoices.submitOrderInvoice(
      orderId,
      requireAccessToken(authorization),
      parse(InvoiceBuyerSchema, body),
    );
  }

  @Get(':orderId/invoice-documents/:documentId/download')
  async download(
    @Param('orderId') orderId: string,
    @Param('documentId') documentId: string,
    @Query('expires') expiresValue: string,
    @Query('signature') signature: string,
    @Res() reply: FastifyReply,
  ) {
    const expires = Number(expiresValue);
    const downloadUrl = await this.invoices.resolveInvoiceDownload(
      orderId,
      documentId,
      expires,
      signature,
    );
    return reply.code(HttpStatus.FOUND).redirect(downloadUrl);
  }
}

@ApiTags('event-previews')
@Controller('previews')
class EventPreviewController {
  constructor(
    @Inject(JwtService)
    private readonly jwt: JwtService,
    @Inject(ConferenceRepository)
    private readonly repository: ConferenceRepository,
    @Inject(TemplateOperationsService)
    private readonly templates: TemplateOperationsService,
  ) {}

  @Get('events/:eventId')
  async eventPreview(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Query('token') token: string,
    @Res() reply: FastifyReply,
  ) {
    let claims: {
      purpose?: string;
      eventId?: EventId;
      organizationId?: string;
    };
    try {
      claims = await this.jwt.verifyAsync(token);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '草稿预览凭证无效或已经过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (
      claims.purpose !== 'event-experience-preview' ||
      claims.eventId !== eventId ||
      !claims.organizationId
    ) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '草稿预览凭证与当前大会不匹配',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const [event, experience] = await Promise.all([
      this.repository.getAdminEvent(eventId, claims.organizationId),
      this.templates.experience(claims.organizationId, eventId),
    ]);
    return reply
      .header('Cache-Control', 'private, no-store, max-age=0')
      .header('X-Robots-Tag', 'noindex, nofollow, noarchive')
      .send({
        ...event,
        experience: {
          renderer: experience.renderer,
          template: {
            id: experience.binding.templateId,
            versionId: experience.binding.templateVersionId,
            version: experience.binding.templateVersion,
          },
          presentation:
            experience.definition.presentation.kind === 'structured'
              ? { kind: 'structured' }
              : {
                  kind: 'html',
                  documentId: experience.definition.presentation.documentId,
                  sanitizedDigest: experience.definition.presentation.sanitizedDigest,
                  bindingDigest: experience.definition.presentation.bindingDigest,
                  compilerVersion: experience.definition.presentation.compilerVersion,
                },
          ...(experience.definition.presentation.kind === 'structured'
            ? { home: experience.definition.presentation.home }
            : {}),
          faq: experience.definition.faq,
          registrationFlow: experience.definition.registrationFlow,
        },
        preview: {
          watermark: '草稿预览',
          submissionsDisabled: true,
        },
      });
  }
}

@ApiTags('template-previews')
@Controller('template-previews')
class HtmlTemplatePreviewController {
  constructor(
    @Inject(JwtService)
    private readonly jwt: JwtService,
    @Inject(HtmlTemplateOperationsService)
    private readonly htmlTemplates: HtmlTemplateOperationsService,
  ) {}

  @Get()
  async preview(@Query('token') token: string, @Res() reply: FastifyReply) {
    let claims: {
      purpose?: string;
      organizationId?: string;
      templateId?: string;
      revision?: number;
      documentDigest?: string;
      bindingDigest?: string;
      channelId?: string;
    };
    try {
      claims = await this.jwt.verifyAsync(token);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '模板预览凭证无效或已经过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (
      claims.purpose !== 'html-template-preview' ||
      !claims.organizationId ||
      !claims.templateId ||
      !claims.channelId
    ) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '模板预览凭证范围无效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const rendered = await this.htmlTemplates.renderPreview(
      claims.organizationId,
      claims.templateId,
    );
    if (
      rendered.revision !== claims.revision ||
      rendered.documentDigest !== claims.documentDigest ||
      rendered.bindingDigest !== claims.bindingDigest
    ) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '模板草稿已经变化，请重新打开预览',
        HttpStatus.CONFLICT,
      );
    }
    const adminOrigin = process.env.ADMIN_ORIGIN ?? process.env.ADMIN_WEB_URL ?? "'self'";
    const channelId = JSON.stringify(claims.channelId);
    const bridge = `(()=>{const c=${channelId},q='[data-tok-node]';document.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const n=e.target instanceof Element?e.target.closest(q):null;if(n)parent.postMessage({type:'tok-template-node-selected',channelId:c,nodeId:n.getAttribute('data-tok-node')},'*')},true);window.addEventListener('message',e=>{if(e.source!==parent||!e.data||e.data.type!=='tok-template-highlight'||e.data.channelId!==c)return;document.querySelectorAll(q).forEach(n=>{n.style.removeProperty('outline');n.style.removeProperty('outline-offset')});const n=document.querySelector('[data-tok-node="'+CSS.escape(String(e.data.nodeId||''))+'"]');if(n){n.style.outline='3px solid #ef8d32';n.style.outlineOffset='3px';n.scrollIntoView({block:'center',behavior:'smooth'})}})})();`;
    const scriptHash = `'sha256-${createHash('sha256').update(bridge).digest('base64')}'`;
    const assetOrigin = process.env.S3_PUBLIC_ENDPOINT
      ? new URL(process.env.S3_PUBLIC_ENDPOINT).origin
      : '';
    const previewHtml = rendered.html
      .replace(
        /<body([^>]*)>/iu,
        '<body$1><div style="position:sticky;top:0;z-index:2147483647;padding:7px 12px;color:#fff;background:#1b416f;font:600 11px/1.4 system-ui;letter-spacing:.08em;text-align:center">TokEMS 草稿预览 · 页面操作已停用</div>',
      )
      .replace(/<\/body>/iu, `<script>${bridge}</script></body>`);
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'private, no-store, max-age=0')
      .header('X-Robots-Tag', 'noindex, nofollow, noarchive')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'${assetOrigin ? ` ${assetOrigin}` : ''}; font-src 'self'${assetOrigin ? ` ${assetOrigin}` : ''}; script-src ${scriptHash}; script-src-attr 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${adminOrigin}`,
      )
      .send(previewHtml);
  }
}

@Module({
  controllers: [
    TemplateController,
    InvoiceController,
    PublicInvoiceController,
    OrderInvoiceAccessController,
    EventPreviewController,
    HtmlTemplatePreviewController,
  ],
})
export class TemplateInvoiceModule {}
