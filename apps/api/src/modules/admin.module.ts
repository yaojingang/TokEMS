import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_ERROR_CODES,
  AdminCooperationRequestListQuerySchema,
  AdminDashboardQuerySchema,
  AdminOrderListQuerySchema,
  AdminRegistrationListQuerySchema,
  AttendeeServiceQrUploadSchema,
  ConfirmAttendeeServiceQrAssetSchema,
  CreateRegistrationNoteSchema,
  DEMO_IDS,
  ReviewRegistrationSchema,
  UpdateAdminRegistrationAttendeeSchema,
  UpdateCooperationRequestSchema,
  UpdateEventSchema,
  UpdateEventAttendeeServiceConfigurationSchema,
  type EventId,
} from '@conference/contracts';
import {
  AuthGuard,
  grantAllows,
  RequireGrant,
  type AuthenticatedUser,
} from '../common/auth.guard.js';
import { ConferenceRepository } from '../common/conference.repository.js';
import { AdminRegistrationOperationsService } from '../common/admin-registration-operations.service.js';
import { DomainError } from '../common/domain-error.js';
import { EventIdPipe, OptionalEventIdPipe } from '../common/event-id.pipe.js';
import { CooperationRequestService } from '../common/cooperation-request.service.js';
import { AgentSurface } from '../common/agent-operation-catalog.js';
import { AttendeeServiceHubService } from '../common/attendee-service-hub.service.js';

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

function cooperationRequestId(value: string) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) {
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '合作申请 ID 格式不正确',
      HttpStatus.BAD_REQUEST,
    );
  }
  return parsed.data;
}

export const ADMIN_EVENT_READ_GRANTS = [
  'event.read',
  'event.manage',
  'event.registration.manage',
  'event.inventory.read',
  'event.inventory.manage',
  'event.site.read',
] as const;

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@AgentSurface({
  defaultExclusionReason: 'Unlisted handlers remain human-only until added to the Agent catalog',
})
@Controller('admin')
class AdminController {
  constructor(
    @Inject(ConferenceRepository) private readonly repository: ConferenceRepository,
    @Inject(AdminRegistrationOperationsService)
    private readonly registrationOperations: AdminRegistrationOperationsService,
    @Inject(CooperationRequestService)
    private readonly cooperationRequests: CooperationRequestService,
    @Inject(AttendeeServiceHubService)
    private readonly attendeeServiceHub: AttendeeServiceHubService,
  ) {}

  @Get(['dashboard', 'events/:eventId/dashboard'])
  @RequireGrant('event.dashboard.read')
  dashboard(
    @Param('eventId', OptionalEventIdPipe) scopedEventId: EventId | undefined,
    @Query('eventId', OptionalEventIdPipe) queryEventId: EventId = DEMO_IDS.event,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
    @Query() query?: Record<string, unknown>,
  ) {
    const parsed = AdminDashboardQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '报名趋势日期区间校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.repository.getDashboard(
      scopedEventId ?? queryEventId,
      request.user!.organizationId,
      parsed.data,
    );
  }

  @Get(['registrations', 'events/:eventId/registrations'])
  @RequireGrant('event.registration.read')
  registrations(
    @Param('eventId', OptionalEventIdPipe) scopedEventId: EventId | undefined,
    @Query('eventId', OptionalEventIdPipe) queryEventId: EventId = DEMO_IDS.event,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
    @Query() query?: Record<string, unknown>,
  ) {
    const parsed = AdminRegistrationListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '报名列表查询条件校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.repository.listRegistrations(
      scopedEventId ?? queryEventId,
      parsed.data,
      request.user!.organizationId,
    );
  }

  @Get('events/:eventId/cooperation-requests')
  @RequireGrant('event.registration.read')
  cooperationRequestList(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    const parsed = AdminCooperationRequestListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '合作申请查询条件校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.cooperationRequests.list(request.user!.organizationId, eventId, parsed.data);
  }

  @Get('events/:eventId/attendee-services')
  @RequireGrant('event.registration.manage')
  attendeeServiceConfiguration(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.attendeeServiceHub.adminConfiguration(request.user!.organizationId, eventId);
  }

  @Patch('events/:eventId/attendee-services')
  @RequireGrant('event.registration.manage')
  updateAttendeeServiceConfiguration(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    const parsed = UpdateEventAttendeeServiceConfigurationSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '参会者服务配置校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.attendeeServiceHub.updateAdminConfiguration(
      request.user!.organizationId,
      eventId,
      request.user!.sub,
      parsed.data,
    );
  }

  @Post('events/:eventId/attendee-services/qr-uploads')
  @RequireGrant('event.registration.manage')
  prepareAttendeeServiceQrUpload(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    const parsed = AttendeeServiceQrUploadSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '二维码上传信息校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.attendeeServiceHub.prepareQrUpload(
      request.user!.organizationId,
      eventId,
      request.user!.sub,
      parsed.data,
      idempotencyKey(key),
    );
  }

  @Post('events/:eventId/attendee-services/qr-assets')
  @RequireGrant('event.registration.manage')
  confirmAttendeeServiceQrAsset(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() body: unknown,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    const parsed = ConfirmAttendeeServiceQrAssetSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '二维码文件确认信息校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.attendeeServiceHub.confirmQrAsset(
      request.user!.organizationId,
      eventId,
      request.user!.sub,
      parsed.data,
    );
  }

  @Get('events/:eventId/cooperation-requests/:requestId')
  @RequireGrant('event.registration.read')
  cooperationRequestDetail(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('requestId') requestId: string,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.cooperationRequests.detail(
      request.user!.organizationId,
      eventId,
      cooperationRequestId(requestId),
    );
  }

  @Patch('events/:eventId/cooperation-requests/:requestId')
  @RequireGrant('event.registration.manage')
  updateCooperationRequest(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    const parsed = UpdateCooperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '合作申请跟进内容校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.cooperationRequests.update(
      request.user!.organizationId,
      eventId,
      cooperationRequestId(requestId),
      request.user!.sub,
      parsed.data,
    );
  }

  @Get('events/:eventId/registrations/:registrationId')
  @RequireGrant('event.registration.read')
  registrationDetail(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('registrationId') registrationId: string,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    return this.repository.getRegistrationDetail(
      eventId,
      registrationId,
      request.user!.organizationId,
      grantAllows(request.user!.grants, 'customer.read'),
    );
  }

  @Get('events/:eventId/registrations/:registrationId/operations-detail')
  @RequireGrant('event.registration.read')
  registrationOperationsDetail(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('registrationId') registrationId: string,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.registrationOperations.detail(
      eventId,
      registrationId,
      request.user!.organizationId,
      request.user!.grants,
    );
  }

  @Patch('events/:eventId/registrations/:registrationId/attendee')
  @RequireGrant('event.registration.manage')
  updateRegistrationAttendee(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('registrationId') registrationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    const parsed = UpdateAdminRegistrationAttendeeSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '参会人资料校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.registrationOperations.updateAttendee(
      eventId,
      registrationId,
      request.user!.organizationId,
      request.user!.sub,
      parsed.data,
    );
  }

  @Post('events/:eventId/registrations/:registrationId/notes')
  @RequireGrant('event.registration.manage')
  addRegistrationNote(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('registrationId') registrationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    const parsed = CreateRegistrationNoteSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '报名备注校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.registrationOperations.addNote(
      eventId,
      registrationId,
      request.user!.organizationId,
      request.user!.sub,
      parsed.data,
    );
  }

  @Post('events/:eventId/registrations/:registrationId/review')
  @RequireGrant('event.registration.manage')
  reviewRegistration(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Param('registrationId') registrationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    const parsed = ReviewRegistrationSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '报名审核内容校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.repository.reviewRegistration(
      eventId,
      registrationId,
      request.user!.organizationId,
      request.user!.sub,
      parsed.data,
      idempotencyKey(key),
    );
  }

  @Get(['orders', 'events/:eventId/orders'])
  @RequireGrant('event.order.read')
  orders(
    @Param('eventId', OptionalEventIdPipe) scopedEventId: EventId | undefined,
    @Query('eventId', OptionalEventIdPipe) queryEventId: EventId = DEMO_IDS.event,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
    @Query() query?: Record<string, unknown>,
  ) {
    const parsed = AdminOrderListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '订单列表查询条件校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.repository.listOrders(
      scopedEventId ?? queryEventId,
      parsed.data,
      request.user!.organizationId,
    );
  }

  @Get('events/:eventId')
  @RequireGrant(...ADMIN_EVENT_READ_GRANTS)
  event(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    return this.repository.getAdminEvent(eventId, request.user!.organizationId);
  }

  @Get('events/:eventId/waitlist')
  @RequireGrant('event.registration.read')
  waitlist(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    return this.repository.listWaitlist(eventId, request.user!.organizationId);
  }

  @Patch('events/:eventId')
  @RequireGrant('event.manage', 'event.registration.manage')
  updateEvent(
    @Param('eventId', EventIdPipe) eventId: EventId,
    @Body() patch: Record<string, unknown>,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
  ) {
    const parsed = UpdateEventSchema.safeParse(patch);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '大会信息校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    if (
      !grantAllows(request.user!.grants, 'event.manage') &&
      Object.keys(parsed.data).some((key) => key !== 'settings')
    ) {
      throw new ForbiddenException('报名运营只能修改大会报名方式');
    }
    return this.repository.updateEvent(
      eventId,
      parsed.data,
      request.user!.sub,
      request.user!.organizationId,
    );
  }
}

@Module({
  controllers: [AdminController],
  providers: [AuthGuard],
})
export class AdminModule {}
