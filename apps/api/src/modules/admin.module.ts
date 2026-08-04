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
import {
  API_ERROR_CODES,
  AdminDashboardQuerySchema,
  AdminOrderListQuerySchema,
  AdminRegistrationListQuerySchema,
  CreateRegistrationNoteSchema,
  DEMO_IDS,
  ReviewRegistrationSchema,
  UpdateAdminRegistrationAttendeeSchema,
  UpdateEventSchema,
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

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('admin')
class AdminController {
  constructor(
    @Inject(ConferenceRepository) private readonly repository: ConferenceRepository,
    @Inject(AdminRegistrationOperationsService)
    private readonly registrationOperations: AdminRegistrationOperationsService,
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
  @RequireGrant(
    'event.read',
    'event.manage',
    'event.registration.manage',
    'event.inventory.read',
    'event.inventory.manage',
  )
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
