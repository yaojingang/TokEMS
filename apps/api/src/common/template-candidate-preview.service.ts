import { inertHtmlTemplatePreview } from '@conference/html-template';
import { TemplateCandidatePreviewSchema } from './management-inputs.js';
import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { API_ERROR_CODES, publicEventScopedPath, type EventId } from '@conference/contracts';
import { z } from 'zod';
import { ConferenceRepository } from './conference.repository.js';
import { OrganizationAdminService } from './organization-admin.service.js';
import { HtmlTemplateOperationsService } from './html-template-operations.service.js';
import { TemplateOperationsService } from './template-operations.service.js';
import { RedisService } from './redis.service.js';
import { DomainError } from './domain-error.js';
import { mergeTemplateDefinition } from './template-definition.js';
import { stableCanonicalJson } from '@conference/security';

const PREVIEW_TTL_SECONDS = 1800;
const MAX_ORGANIZATION_PREVIEWS = 50;
const MAX_ORGANIZATION_PREVIEW_BYTES = 64 * 1024 * 1024;
const STORE_PREVIEW = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local active = redis.call('ZRANGE', KEYS[2], 0, -1)
local bytes = 0
for _, member in ipairs(active) do
  bytes = bytes + tonumber(string.match(member, ':(%d+)$'))
end
if #active >= tonumber(ARGV[4]) or bytes + string.len(ARGV[1]) > tonumber(ARGV[5]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]) * 1000, ARGV[2] .. ':' .. string.len(ARGV[1]))
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`;

@Injectable()
export class TemplateCandidatePreviewService {
  constructor(
    @Inject(TemplateOperationsService) private readonly templates: TemplateOperationsService,
    @Inject(ConferenceRepository) private readonly repository: ConferenceRepository,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(HtmlTemplateOperationsService)
    private readonly htmlTemplates: HtmlTemplateOperationsService,
    @Inject(OrganizationAdminService) private readonly organizationAdmin: OrganizationAdminService,
  ) {}

  private async cacheSnapshot(organizationId: string, snapshotId: string, serialized: string) {
    const stored = await this.redis
      .getClient()
      .eval(
        STORE_PREVIEW,
        2,
        `tokems:template-preview:${snapshotId}`,
        `tokems:template-preview:budget:${organizationId}`,
        serialized,
        snapshotId,
        PREVIEW_TTL_SECONDS,
        MAX_ORGANIZATION_PREVIEWS,
        MAX_ORGANIZATION_PREVIEW_BYTES,
      );
    if (stored !== 1) {
      throw new DomainError(
        API_ERROR_CODES.TEMPLATE_PREVIEW_LIMIT,
        '预览数量或总大小已达上限，请等待已有预览到期后重试',
        HttpStatus.TOO_MANY_REQUESTS,
        { maxPreviews: MAX_ORGANIZATION_PREVIEWS, maxBytes: MAX_ORGANIZATION_PREVIEW_BYTES },
      );
    }
  }

  async create(organizationId: string, actorId: string, templateId: string, body: unknown) {
    const parsed = TemplateCandidatePreviewSchema.safeParse(body);
    if (!parsed.success)
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '候选模板预览参数无效',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    const input = parsed.data;
    const draft = await this.templates.draft(organizationId, templateId);
    if (draft.revision !== input.revision) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        '模板草稿已经变化，请重新拉取后预览',
        HttpStatus.CONFLICT,
      );
    }
    const definition = input.definition ?? draft.definition;
    const eventId = input.eventId as EventId;
    const event = await this.repository.getAdminEvent(eventId, organizationId);
    const current = await this.templates.experience(organizationId, eventId);
    let snapshot: Record<string, unknown>;
    if (definition.presentation.kind === 'html') {
      if (
        draft.definition.presentation.kind !== 'html' ||
        draft.definition.presentation.documentId !== definition.presentation.documentId ||
        draft.definition.presentation.sanitizedDigest !== definition.presentation.sanitizedDigest
      ) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'HTML 文档替换需要先完成导入扫描',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const organization = await this.organizationAdmin.getSettings(organizationId);
      const rendered = await this.htmlTemplates.renderPreview(
        organizationId,
        templateId,
        definition.presentation.bindings,
        {
          event: { ...event, stats: event.stats },
          tickets: event.tickets,
          speakers: event.speakers,
          sessions: event.sessions,
          faqs: event.faqs,
          routes: {
            registration: publicEventScopedPath('/register', event.slug),
            cooperation: publicEventScopedPath('/apply/cooperation', event.slug),
            faq: publicEventScopedPath('/faq', event.slug),
            account: publicEventScopedPath('/account', event.slug),
          },
          site: organization.settings.website,
        },
      );
      snapshot = {
        kind: 'html',
        html: inertHtmlTemplatePreview(rendered.html),
        eventId,
        templateId,
        revision: draft.revision,
      };
    } else {
      const resolved = mergeTemplateDefinition(definition, {
        home: current.overrides.home.document,
        faq: current.overrides.faq.document,
        registration_flow: current.overrides.registration_flow.document,
      });
      if (resolved.presentation.kind !== 'structured')
        throw new Error('Structured preview expected');
      snapshot = {
        ...event,
        experience: {
          ...event.experience,
          renderer: current.renderer,
          template: {
            id: current.binding.templateId,
            versionId: current.binding.templateVersionId,
            version: current.binding.templateVersion,
          },
          presentation: { kind: 'structured' },
          home: resolved.presentation.home,
          faq: resolved.faq,
          registrationFlow: resolved.registrationFlow,
        },
        preview: {
          watermark: '候选模板预览',
          candidateTemplateId: templateId,
          revision: draft.revision,
          submissionsDisabled: true,
        },
      };
    }
    const snapshotId = randomUUID();
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '预览内容超过大小限制',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.cacheSnapshot(organizationId, snapshotId, serialized);
    const previewToken = await this.jwt.signAsync(
      {
        purpose: 'event-experience-preview',
        eventId,
        organizationId,
        requestedBy: actorId,
        snapshotId,
      },
      { expiresIn: PREVIEW_TTL_SECONDS },
    );
    return {
      previewToken,
      previewUrl: `${definition.presentation.kind === 'html' ? '/api/v1' : ''}/previews/events/${eventId}?token=${encodeURIComponent(previewToken)}`,
      eventId,
      snapshotId,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
      contentDigest: createHash('sha256').update(stableCanonicalJson(snapshot)).digest('hex'),
      noIndex: true,
      submissionsDisabled: true,
    };
  }

  async read(snapshotId: string) {
    if (!z.uuid().safeParse(snapshotId).success) {
      throw new DomainError(API_ERROR_CODES.UNAUTHORIZED, '预览凭证无效', HttpStatus.UNAUTHORIZED);
    }
    const snapshot = await this.redis.getClient().get(`tokems:template-preview:${snapshotId}`);
    if (!snapshot)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '预览已到期，请重新生成',
        HttpStatus.NOT_FOUND,
      );
    return JSON.parse(snapshot) as Record<string, unknown>;
  }
}
