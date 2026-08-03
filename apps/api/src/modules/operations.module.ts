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
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AiGenerateSchema,
  API_ERROR_CODES,
  CreateOrganizationInvitationSchema,
  CreateEventSchema,
  EventShortSlugSchema,
  OfflineCheckInSyncSchema,
  PublishEventSchema,
  QueueNotificationSchema,
  RefundRequestSchema,
  RegistrationFieldSchema,
  SetOrganizationHomepageEventSchema,
  TestAliyunSmsConfigurationSchema,
  UpdateAliyunSmsConfigurationSchema,
  UpdateMembershipStatusSchema,
  UpdateEventSlugSchema,
  UpdateOrganizationMemberSchema,
  UpdateOrganizationSettingsSchema,
  UpdateWeChatPayConfigurationSchema,
  type EventId,
} from '@conference/contracts';
import { z } from 'zod';
import {
  AuthGuard,
  RequireAllGrants,
  RequireGrant,
  type AuthenticatedUser,
} from '../common/auth.guard.js';
import { CommerceOperationsService } from '../common/commerce-operations.service.js';
import { AliyunSmsService } from '../common/aliyun-sms.service.js';
import { DomainError } from '../common/domain-error.js';
import { EngagementOperationsService } from '../common/engagement-operations.service.js';
import { EventIdPipe, OptionalEventIdPipe } from '../common/event-id.pipe.js';
import { EventOperationsService } from '../common/event-operations.service.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { OrganizationAdminService } from '../common/organization-admin.service.js';
import { WeChatPayService } from '../common/wechat-pay.service.js';

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

function idempotencyKey(value: string | undefined) {
  if (!value || value.length < 8 || value.length > 160) {
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '写操作需要 8 到 160 字符的 Idempotency-Key',
      HttpStatus.BAD_REQUEST,
    );
  }
  return value;
}

const SpeakerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(240),
  topic: z.string().trim().min(1).max(240),
  initials: z.string().trim().min(1).max(8),
  accentFrom: z.string().regex(/^#[0-9a-f]{6}$/i),
  accentTo: z.string().regex(/^#[0-9a-f]{6}$/i),
  tags: z.array(z.string().max(60)).max(12).default([]),
  sortOrder: z.number().int().min(0).default(0),
});

const sessionInputFields = {
  day: z.number().int().min(1).max(30),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  title: z.string().trim().min(1).max(240),
  summary: z.string().max(2000).optional(),
  speaker: z.string().max(160).optional(),
  kind: z.enum(['talk', 'break', 'workshop']).default('talk'),
  sortOrder: z.number().int().min(0).default(0),
};

const validSessionRange = (session: {
  startsAt?: string | undefined;
  endsAt?: string | undefined;
}) => !session.startsAt || !session.endsAt || new Date(session.endsAt) > new Date(session.startsAt);

const SessionInputSchema = z
  .object(sessionInputFields)
  .refine(validSessionRange, { path: ['endsAt'], message: '议程结束时间必须晚于开始时间' });
const SessionPatchSchema = z
  .object(sessionInputFields)
  .partial()
  .refine(validSessionRange, {
    path: ['endsAt'],
    message: '议程结束时间必须晚于开始时间',
  });

const requiredRegistrationFields = new Map([
  ['name', 'text'],
  ['mobile', 'tel'],
  ['email', 'email'],
  ['company', 'text'],
  ['title', 'text'],
  ['city', 'text'],
]);

const FormPublishSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    fields: z.array(RegistrationFieldSchema).min(1).max(60),
    termsVersion: z.string().min(1).max(32),
    termsContent: z.string().min(10).max(30_000),
  })
  .superRefine((input, context) => {
    const keys = new Set<string>();
    input.fields.forEach((field, index) => {
      if (keys.has(field.key)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: '字段键必须唯一',
        });
      }
      keys.add(field.key);
      if (field.type === 'select' && !field.options?.length) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'options'],
          message: '选项字段至少需要一个可选值',
        });
      }
      if (field.options && new Set(field.options).size !== field.options.length) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'options'],
          message: '同一字段的选项必须唯一',
        });
      }
    });
    for (const [key, type] of requiredRegistrationFields) {
      const field = input.fields.find((item) => item.key === key);
      if (!field || field.type !== type || !field.required) {
        context.addIssue({
          code: 'custom',
          path: ['fields'],
          message: `必须保留必填核心字段 ${key}，类型为 ${type}`,
        });
      }
    }
  });

const DeviceInputSchema = z.object({
  deviceCode: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(120),
});

const TicketTypeInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_]+$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  price: z.number().int().nonnegative(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('CNY'),
  capacity: z.number().int().positive(),
  recommended: z.boolean().default(false),
  benefits: z.array(z.string().max(120)).max(30).default([]),
});

@ApiTags('organization-and-events')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('admin')
class OrganizationEventsController {
  constructor(
    @Inject(EventOperationsService) private readonly operations: EventOperationsService,
    @Inject(OrganizationAdminService)
    private readonly organizationAdmin: OrganizationAdminService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(WeChatPayService)
    private readonly weChatPay: WeChatPayService,
    @Inject(AliyunSmsService)
    private readonly aliyunSms: AliyunSmsService,
  ) {}

  @Get('organization/members')
  @RequireGrant('org.member.read')
  members(@Req() request: AuthenticatedRequest) {
    return this.organizationAdmin.listMembers(request.user.organizationId);
  }

  @Patch('organization/members/:membershipId')
  @RequireGrant('org.member.manage')
  updateMember(
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.organizationAdmin.updateMember(
      request.user.organizationId,
      membershipId,
      request.user.sub,
      parse(UpdateOrganizationMemberSchema, body),
    );
  }

  @Patch('organization/members/:membershipId/status')
  @RequireGrant('org.member.manage')
  updateMemberStatus(
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.organizationAdmin.updateMemberStatus(
      request.user.organizationId,
      membershipId,
      request.user.sub,
      parse(UpdateMembershipStatusSchema, body),
    );
  }

  @Delete('organization/members/:membershipId')
  @RequireGrant('org.member.manage')
  removeMember(@Param('membershipId') membershipId: string, @Req() request: AuthenticatedRequest) {
    return this.organizationAdmin.removeMember(
      request.user.organizationId,
      membershipId,
      request.user.sub,
    );
  }

  @Get('organization/invitations')
  @RequireGrant('org.member.read')
  invitations(@Req() request: AuthenticatedRequest) {
    return this.organizationAdmin.listInvitations(request.user.organizationId);
  }

  @Post('organization/invitations')
  @RequireGrant('org.member.manage')
  createInvitation(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.organizationAdmin.createInvitation(
      request.user.organizationId,
      request.user.sub,
      parse(CreateOrganizationInvitationSchema, body),
    );
  }

  @Delete('organization/invitations/:invitationId')
  @RequireGrant('org.member.manage')
  cancelInvitation(
    @Param('invitationId') invitationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.organizationAdmin.cancelInvitation(
      request.user.organizationId,
      invitationId,
      request.user.sub,
    );
  }

  @Get('organization/settings')
  @RequireGrant('org.settings.read', 'org.member.manage')
  organizationSettings(@Req() request: AuthenticatedRequest) {
    return this.organizationAdmin.getSettings(request.user.organizationId);
  }

  @Patch('organization/settings')
  @RequireGrant('org.settings.manage')
  updateOrganizationSettings(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.organizationAdmin.updateSettings(
      request.user.organizationId,
      request.user.sub,
      parse(UpdateOrganizationSettingsSchema, body),
    );
  }

  @Put('organization/homepage-event')
  @RequireGrant('org.settings.manage')
  setOrganizationHomepageEvent(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = parse(SetOrganizationHomepageEventSchema, body);
    return this.organizationAdmin.setHomepageEvent(
      request.user.organizationId,
      request.user.sub,
      input.eventId,
    );
  }

  @Get('integrations/status')
  @RequireGrant('org.settings.read', 'org.member.manage')
  integrationStatus(@Req() request: AuthenticatedRequest) {
    return this.organizationAdmin.getIntegrationStatus(request.user.organizationId);
  }

  @Get('integrations/wechat-pay')
  @RequireGrant('org.settings.read', 'org.member.manage')
  weChatPayConfiguration(@Req() request: AuthenticatedRequest) {
    return this.weChatPay.getConfiguration(request.user.organizationId);
  }

  @Patch('integrations/wechat-pay')
  @RequireGrant('org.settings.manage')
  updateWeChatPayConfiguration(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.weChatPay.updateConfiguration(
      request.user.organizationId,
      request.user.sub,
      parse(UpdateWeChatPayConfigurationSchema, body),
    );
  }

  @Post('integrations/wechat-pay/test')
  @RequireGrant('org.settings.manage')
  testWeChatPayConfiguration(@Req() request: AuthenticatedRequest) {
    return this.weChatPay.testConnection(request.user.organizationId, request.user.sub);
  }

  @Get('integrations/aliyun-sms')
  @RequireGrant('org.settings.read', 'org.member.manage')
  aliyunSmsConfiguration(@Req() request: AuthenticatedRequest) {
    return this.aliyunSms.getConfiguration(request.user.organizationId);
  }

  @Patch('integrations/aliyun-sms')
  @RequireGrant('org.settings.manage')
  updateAliyunSmsConfiguration(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.aliyunSms.updateConfiguration(
      request.user.organizationId,
      request.user.sub,
      parse(UpdateAliyunSmsConfigurationSchema, body),
    );
  }

  @Post('integrations/aliyun-sms/test')
  @RequireGrant('org.settings.manage')
  @Throttle({ default: { limit: 3, ttl: 60 * 60_000 } })
  testAliyunSmsConfiguration(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(TestAliyunSmsConfigurationSchema, body);
    const requestKey = idempotencyKey(key);
    return this.idempotency.execute(
      `aliyun-sms:test:${request.user.organizationId}:${request.user.sub}`,
      requestKey,
      input,
      () =>
        this.aliyunSms.testConnection(
          request.user.organizationId,
          request.user.sub,
          input,
          requestKey,
        ),
      60 * 60_000,
    );
  }

  @Get('events')
  @RequireGrant('event.read')
  events(@Req() request: AuthenticatedRequest) {
    return this.operations.listEvents(request.user.organizationId);
  }

  @Get('event-options')
  @RequireGrant('event.read')
  eventOptions(@Req() request: AuthenticatedRequest) {
    return this.operations.listEventOptions(request.user.organizationId);
  }

  @Get('event-slugs/availability')
  @RequireGrant('event.manage')
  eventSlugAvailability(
    @Query('slug') slugValue: string,
    @Query('eventId', OptionalEventIdPipe) eventId: EventId | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const slug = parse(EventShortSlugSchema, slugValue);
    return this.operations.eventSlugAvailability(request.user.organizationId, slug, eventId);
  }

  @Patch('events/:eventId/public-url')
  @RequireGrant('event.manage')
  updateEventSlug(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.updateEventSlug(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(UpdateEventSlugSchema, body),
    );
  }

  @Post('events')
  @RequireAllGrants('event.manage', 'org.template.use')
  createEvent(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(CreateEventSchema, body);
    return this.idempotency.execute(
      `event:create:${request.user.organizationId}`,
      idempotencyKey(key),
      input,
      () => this.operations.createEvent(request.user.organizationId, request.user.sub, input),
    );
  }

  @Get('event-blueprints')
  @RequireGrant('event.read')
  blueprints(@Req() request: AuthenticatedRequest) {
    return this.operations.listBlueprints(request.user.organizationId);
  }

  @Get('template-packages')
  @RequireGrant('event.site.read')
  templates() {
    return this.operations.listTemplates();
  }

  @Get('events/:eventId/releases')
  @RequireGrant('event.site.read')
  releases(@Param('eventId', EventIdPipe) eventId: EventId, @Req() request: AuthenticatedRequest) {
    return this.operations.listReleases(request.user.organizationId, eventId);
  }

  @Post('events/:eventId/releases')
  @RequireGrant('event.site.publish')
  publish(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(PublishEventSchema, body);
    return this.operations.publishEvent(
      request.user.organizationId,
      eventId,
      request.user.sub,
      input.templateKey,
    );
  }

  @Post('events/:eventId/releases/:releaseId/rollback')
  @RequireGrant('event.site.publish')
  rollback(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('releaseId') releaseId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.rollbackRelease(
      request.user.organizationId,
      eventId,
      releaseId,
      request.user.sub,
    );
  }
}

@ApiTags('content-and-forms')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@RequireGrant('event.content.manage')
@Controller('admin/events/:eventId')
class ContentFormsController {
  constructor(
    @Inject(EventOperationsService) private readonly operations: EventOperationsService,
  ) {}

  @Get('content')
  content(@Param('eventId', EventIdPipe) eventId: EventId, @Req() request: AuthenticatedRequest) {
    return this.operations.listContent(request.user.organizationId, eventId);
  }

  @Post('ticket-types')
  @RequireGrant('event.inventory.manage')
  createTicketType(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.createTicketType(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(TicketTypeInputSchema, body),
    );
  }

  @Get('ticket-types/archived')
  @RequireGrant('event.inventory.manage')
  archivedTicketTypes(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.listArchivedTicketTypes(request.user.organizationId, eventId);
  }

  @Post('ticket-types/:ticketTypeId/restore')
  @RequireGrant('event.inventory.manage')
  restoreTicketType(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('ticketTypeId') ticketTypeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.restoreTicketType(
      request.user.organizationId,
      eventId,
      ticketTypeId,
      request.user.sub,
    );
  }

  @Patch('ticket-types/:ticketTypeId')
  @RequireGrant('event.inventory.manage')
  updateTicketType(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('ticketTypeId') ticketTypeId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(TicketTypeInputSchema.partial(), body);
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    return this.operations.updateTicketType(
      request.user.organizationId,
      eventId,
      ticketTypeId,
      request.user.sub,
      patch,
    );
  }

  @Delete('ticket-types/:ticketTypeId')
  @RequireGrant('event.inventory.manage')
  deleteTicketType(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('ticketTypeId') ticketTypeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.deleteTicketType(
      request.user.organizationId,
      eventId,
      ticketTypeId,
      request.user.sub,
    );
  }

  @Post('speakers')
  createSpeaker(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.createSpeaker(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(SpeakerInputSchema, body),
    );
  }

  @Patch('speakers/:speakerId')
  updateSpeaker(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('speakerId') speakerId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(SpeakerInputSchema.partial(), body);
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    return this.operations.updateSpeaker(
      request.user.organizationId,
      eventId,
      speakerId,
      request.user.sub,
      patch,
    );
  }

  @Delete('speakers/:speakerId')
  deleteSpeaker(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('speakerId') speakerId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.deleteSpeaker(
      request.user.organizationId,
      eventId,
      speakerId,
      request.user.sub,
    );
  }

  @Post('sessions')
  createSession(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(SessionInputSchema, body);
    return this.operations.createSession(request.user.organizationId, eventId, request.user.sub, {
      ...input,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
    });
  }

  @Patch('sessions/:sessionId')
  updateSession(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(SessionPatchSchema, body);
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    return this.operations.updateSession(
      request.user.organizationId,
      eventId,
      sessionId,
      request.user.sub,
      {
        ...patch,
        ...(input.startsAt ? { startsAt: new Date(input.startsAt) } : {}),
        ...(input.endsAt ? { endsAt: new Date(input.endsAt) } : {}),
      },
    );
  }

  @Delete('sessions/:sessionId')
  deleteSession(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('sessionId') sessionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.deleteSession(
      request.user.organizationId,
      eventId,
      sessionId,
      request.user.sub,
    );
  }

  @Get('registration-forms')
  @RequireGrant('event.registration.manage')
  forms(@Param('eventId', EventIdPipe) eventId: EventId, @Req() request: AuthenticatedRequest) {
    return this.operations.listForms(request.user.organizationId, eventId);
  }

  @Post('registration-forms/publish')
  @RequireGrant('event.registration.manage')
  publishForm(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operations.publishForm(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(FormPublishSchema, body),
    );
  }
}

@ApiTags('commerce-operations')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('admin')
class CommerceController {
  constructor(
    @Inject(CommerceOperationsService) private readonly commerce: CommerceOperationsService,
  ) {}

  @Post('orders/:orderId/refunds')
  @RequireGrant('event.order.refund')
  refund(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commerce.refundOrder(
      request.user.organizationId,
      orderId,
      request.user.sub,
      idempotencyKey(key),
      parse(RefundRequestSchema, body),
    );
  }

  @Get('refunds')
  @RequireGrant('event.order.read')
  refunds(
    @Query('eventId', OptionalEventIdPipe) eventId: EventId | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commerce.listRefunds(request.user.organizationId, eventId);
  }

  @Get('events/:eventId/inventory')
  @RequireGrant('event.inventory.read', 'event.inventory.manage')
  inventory(@Param('eventId', EventIdPipe) eventId: EventId, @Req() request: AuthenticatedRequest) {
    return this.commerce.inventorySummary(request.user.organizationId, eventId);
  }

  @Post('inventory/release-expired')
  @RequireGrant('event.inventory.manage')
  releaseExpired(@Query('limit') limit?: string) {
    return this.commerce.releaseExpiredReservations(limit ? Number(limit) : 100);
  }
}

@ApiTags('engagement-and-checkin')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('admin')
class EngagementController {
  constructor(
    @Inject(EngagementOperationsService) private readonly engagement: EngagementOperationsService,
  ) {}

  @Get('ai/runs')
  @RequireGrant('event.ai.read')
  aiRuns(
    @Query('eventId', OptionalEventIdPipe) eventId: EventId | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagement.listAiRuns(request.user.organizationId, eventId);
  }

  @Post('ai/generate')
  @RequireGrant('event.ai.generate')
  generate(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.engagement.generateCopy(
      request.user.organizationId,
      request.user.sub,
      parse(AiGenerateSchema, body),
    );
  }

  @Post('ai/runs/:runId/approve')
  @RequireGrant('event.ai.approve')
  approve(@Param('runId') runId: string, @Req() request: AuthenticatedRequest) {
    return this.engagement.approveAiRun(request.user.organizationId, runId, request.user.sub);
  }

  @Get('notification-templates')
  @RequireGrant('event.notification.read')
  notificationTemplates(@Req() request: AuthenticatedRequest) {
    return this.engagement.listNotificationTemplates(request.user.organizationId);
  }

  @Get('notification-deliveries')
  @RequireGrant('event.notification.read')
  deliveries(
    @Query('eventId', OptionalEventIdPipe) eventId: EventId | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagement.listDeliveries(request.user.organizationId, eventId);
  }

  @Post('notifications/queue')
  @RequireGrant('event.notification.send')
  queue(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.engagement.queueNotification(
      request.user.organizationId,
      request.user.sub,
      parse(QueueNotificationSchema, body),
    );
  }

  @Get('events/:eventId/checkin-devices')
  @RequireGrant('event.checkin.manage')
  devices(@Param('eventId', EventIdPipe) eventId: EventId, @Req() request: AuthenticatedRequest) {
    return this.engagement.listDevices(request.user.organizationId, eventId);
  }

  @Post('events/:eventId/checkin-devices')
  @RequireGrant('event.checkin.manage')
  registerDevice(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagement.registerDevice(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(DeviceInputSchema, body),
    );
  }

  @Post('checkins/sync')
  @RequireGrant('event.checkin.execute')
  sync(
    @Body() body: unknown,
    @Headers('x-device-token') deviceToken: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagement.syncOfflineCheckins(
      request.user.organizationId,
      parse(OfflineCheckInSyncSchema, body),
      deviceToken,
    );
  }

  @Get('audit-logs')
  @RequireGrant('event.audit.read')
  auditLogs(
    @Query('eventId', OptionalEventIdPipe) eventId: EventId | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!eventId) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '查看操作记录时需要指定大会',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.engagement.listAuditLogs(request.user.organizationId, eventId);
  }

  @Get('events/:eventId/registrations/export.csv')
  @RequireGrant('event.registration.export')
  async exportRegistrations(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.engagement.exportRegistrationsCsv(
      request.user.organizationId,
      eventId,
      request.user.sub,
    );
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .send(result.csv);
  }
}

@Module({
  controllers: [
    OrganizationEventsController,
    ContentFormsController,
    CommerceController,
    EngagementController,
  ],
})
export class OperationsModule {}
