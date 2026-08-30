import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Module,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  API_ERROR_CODES,
  AdminAttendeeNeedExportQuerySchema,
  AdminAttendeeNeedListQuerySchema,
  AttendeeClaimInputSchema,
  AttendeeAvatarConfirmSchema,
  AttendeeAvatarUploadSchema,
  ClaimCustomerRegistrationSchema,
  CreateCustomerAdminSchema,
  CustomerAdminExportQuerySchema,
  CustomerAdminListQuerySchema,
  CustomerCreateInvoiceSchema,
  CustomerInvoiceCenterListQuerySchema,
  CustomerRegistrationListQuerySchema,
  CustomerPurchasedOrderListQuerySchema,
  CustomerUpdateInvoiceSchema,
  DeleteAttendeeNeedsSchema,
  RequestCustomerOtpSchema,
  ModerateAttendeeShowcaseSchema,
  ModerateAttendeeNeedQuestionSchema,
  UpdateCustomerAdminSchema,
  UpdateCustomerProfileSchema,
  UpdateAttendeeShowcaseSchema,
  UpdateAdminAttendeeNeedQuestionSchema,
  UpdateAttendeeNeedsSchema,
  UpdatePurchasedOrderAttendeeSchema,
  UpdateRegistrationServiceAcknowledgementSchema,
  VerifyCustomerOtpSchema,
} from '@conference/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthGuard,
  grantAllows,
  RequireAllGrants,
  RequireGrant,
  type AuthenticatedUser,
} from '../common/auth.guard.js';
import { AgentSurface } from '../common/agent-operation-catalog.js';
import { CustomerAccountService } from '../common/customer-account.service.js';
import { CustomerAuthGuard, type CustomerRequest } from '../common/customer-auth.guard.js';
import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_LIFETIME_SECONDS,
  CustomerAuthService,
} from '../common/customer-auth.service.js';
import { DomainError } from '../common/domain-error.js';
import { InvoiceOperationsService } from '../common/invoice-operations.service.js';
import { AttendeeShowcaseService } from '../common/attendee-showcase.service.js';
import { AttendeeNeedsService } from '../common/attendee-needs.service.js';
import { AttendeeServiceHubService } from '../common/attendee-service-hub.service.js';

function parse<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(API_ERROR_CODES.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function customerCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || process.env.DEPLOYMENT_MODE === 'production',
    sameSite: 'lax' as const,
    path: '/api/v1',
    maxAge: CUSTOMER_SESSION_LIFETIME_SECONDS,
  };
}

@ApiTags('customer-auth')
@Controller('customer-auth')
class CustomerAuthController {
  constructor(
    @Inject(CustomerAuthService)
    private readonly customerAuth: CustomerAuthService,
  ) {}

  @Post('otp')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  requestOtp(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(RequestCustomerOtpSchema, body, '请输入有效的中国大陆手机号');
    return this.customerAuth.requestOtp(request, input.mobile);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async verify(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(VerifyCustomerOtpSchema, body, '手机号或验证码信息校验失败');
    const result = await this.customerAuth.verifyOtp(request, input);
    reply.setCookie(CUSTOMER_SESSION_COOKIE, result.token, customerCookieOptions());
    return result.session;
  }

  @Get('session')
  async session(@Req() request: FastifyRequest) {
    const session = await this.customerAuth.optionalSession(request);
    if (!session) return { authenticated: false };
    return {
      authenticated: true,
      customer: session.customer,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CustomerAuthGuard)
  async logout(@Req() request: CustomerRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.customerAuth.revokeSession(request.customerSession);
    reply.clearCookie(CUSTOMER_SESSION_COOKIE, { path: '/api/v1' });
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CustomerAuthGuard)
  async logoutAll(
    @Req() request: CustomerRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.customerAuth.revokeAllSessions(request.customerSession);
    reply.clearCookie(CUSTOMER_SESSION_COOKIE, { path: '/api/v1' });
  }
}

@ApiTags('customer-account')
@Controller('customer')
@UseGuards(CustomerAuthGuard)
class CustomerAccountController {
  constructor(
    @Inject(CustomerAccountService)
    private readonly customerAccount: CustomerAccountService,
    @Inject(InvoiceOperationsService)
    private readonly invoices: InvoiceOperationsService,
    @Inject(AttendeeShowcaseService)
    private readonly showcases: AttendeeShowcaseService,
    @Inject(AttendeeNeedsService)
    private readonly attendeeNeeds: AttendeeNeedsService,
    @Inject(AttendeeServiceHubService)
    private readonly attendeeServiceHub: AttendeeServiceHubService,
  ) {}

  @Get('profile')
  profile(@Req() request: CustomerRequest) {
    return this.customerAccount.profile(request.customerSession);
  }

  @Patch('profile')
  updateProfile(@Body() body: unknown, @Req() request: CustomerRequest) {
    const input = parse(UpdateCustomerProfileSchema, body, '用户资料校验失败');
    return this.customerAccount.updateProfile(request.customerSession, input);
  }

  @Get('registrations')
  registrations(@Req() request: CustomerRequest, @Query() query: Record<string, unknown>) {
    const input = parse(CustomerRegistrationListQuerySchema, query, '报名记录分页参数校验失败');
    return this.customerAccount.registrations(request.customerSession, input.cursor, input.limit);
  }

  @Get('events/:eventId/purchase-context')
  purchaseContext(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
  ) {
    return this.customerAccount.purchaseContext(request.customerSession, eventId);
  }

  @Get('orders')
  orders(@Req() request: CustomerRequest, @Query() query: Record<string, unknown>) {
    const input = parse(CustomerPurchasedOrderListQuerySchema, query, '订单分页参数校验失败');
    return this.customerAccount.purchasedOrders(
      request.customerSession,
      input.cursor,
      input.limit,
      input.orderId,
    );
  }

  @Post('orders/:orderId/payment-access')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  createOrderPaymentAccess(
    @Req() request: CustomerRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.customerAccount.createOrderPaymentAccess(request.customerSession, orderId);
  }

  @Patch('orders/:orderId/attendee')
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  updateOrderAttendee(
    @Req() request: CustomerRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: unknown,
  ) {
    return this.customerAccount.updatePurchasedOrderAttendee(
      request.customerSession,
      orderId,
      parse(UpdatePurchasedOrderAttendeeSchema, body, '参会人信息校验失败'),
    );
  }

  @Get('registrations/:registrationId/showcase')
  showcase(@Req() request: CustomerRequest, @Param('registrationId') registrationId: string) {
    return this.showcases.customerShowcase(request.customerSession, registrationId);
  }

  @Get('registrations/:registrationId/service-hub')
  serviceHub(
    @Req() request: CustomerRequest,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.attendeeServiceHub.customerHub(request.customerSession, registrationId);
  }

  @Patch('registrations/:registrationId/service-acknowledgements/organizer-contact')
  @Throttle({ default: { limit: 30, ttl: 60 * 60_000 } })
  updateOrganizerContactAcknowledgement(
    @Req() request: CustomerRequest,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    const input = parse(
      UpdateRegistrationServiceAcknowledgementSchema,
      body,
      '组织者添加状态校验失败',
    );
    return this.attendeeServiceHub.setOrganizerContactConfirmed(
      request.customerSession,
      registrationId,
      input.confirmed,
    );
  }

  @Get('registrations/:registrationId/organizer-contact-qr')
  async organizerContactQr(
    @Req() request: CustomerRequest,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.attendeeServiceHub.customerOrganizerQrContent(
      request.customerSession,
      registrationId,
    );
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Type', result.contentType)
      .header('X-Content-Type-Options', 'nosniff')
      .send(result.body);
  }

  @Get('registrations/:registrationId/needs')
  needs(
    @Req() request: CustomerRequest,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
  ) {
    return this.attendeeNeeds.customerNeeds(request.customerSession, registrationId);
  }

  @Patch('registrations/:registrationId/needs')
  @Throttle({ default: { limit: 30, ttl: 60 * 60_000 } })
  updateNeeds(
    @Req() request: CustomerRequest,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Body() body: unknown,
  ) {
    return this.attendeeNeeds.updateCustomerNeeds(
      request.customerSession,
      registrationId,
      parse(UpdateAttendeeNeedsSchema, body, '参会需求信息校验失败'),
    );
  }

  @Delete('registrations/:registrationId/needs')
  @Throttle({ default: { limit: 30, ttl: 60 * 60_000 } })
  deleteNeeds(
    @Req() request: CustomerRequest,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const input = parse(DeleteAttendeeNeedsSchema, query, '参会需求版本校验失败');
    return this.attendeeNeeds.deleteCustomerNeeds(
      request.customerSession,
      registrationId,
      input.version,
    );
  }

  @Patch('registrations/:registrationId/showcase')
  updateShowcase(
    @Req() request: CustomerRequest,
    @Param('registrationId') registrationId: string,
    @Body() body: unknown,
  ) {
    return this.showcases.updateCustomerShowcase(
      request.customerSession,
      registrationId,
      parse(UpdateAttendeeShowcaseSchema, body, '参会名片信息校验失败'),
    );
  }

  @Post('registrations/:registrationId/showcase/avatar-upload')
  @Throttle({ default: { limit: 10, ttl: 60 * 60_000 } })
  prepareShowcaseAvatar(
    @Req() request: CustomerRequest,
    @Param('registrationId') registrationId: string,
    @Body() body: unknown,
  ) {
    return this.showcases.prepareAvatarUpload(
      request.customerSession,
      registrationId,
      parse(AttendeeAvatarUploadSchema, body, '头像上传信息校验失败'),
    );
  }

  @Post('registrations/:registrationId/showcase/avatar-confirm')
  @Throttle({ default: { limit: 20, ttl: 60 * 60_000 } })
  confirmShowcaseAvatar(
    @Req() request: CustomerRequest,
    @Param('registrationId') registrationId: string,
    @Body() body: unknown,
  ) {
    return this.showcases.confirmAvatar(
      request.customerSession,
      registrationId,
      parse(AttendeeAvatarConfirmSchema, body, '头像确认信息校验失败'),
    );
  }

  @Delete('registrations/:registrationId/showcase/avatar')
  removeShowcaseAvatar(
    @Req() request: CustomerRequest,
    @Param('registrationId') registrationId: string,
  ) {
    return this.showcases.removeAvatar(request.customerSession, registrationId);
  }

  @Get('registrations/:registrationId/showcase/avatar')
  async showcaseAvatar(
    @Req() request: CustomerRequest,
    @Param('registrationId') registrationId: string,
    @Res() reply: FastifyReply,
  ) {
    const body = await this.showcases.customerAvatarContent(
      request.customerSession,
      registrationId,
    );
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Type', 'image/webp')
      .send(body);
  }

  @Get('registrations/:registrationId')
  registration(@Req() request: CustomerRequest, @Param('registrationId') registrationId: string) {
    return this.customerAccount.registration(request.customerSession, registrationId);
  }

  @Post('registration-claims')
  claimRegistration(@Req() request: CustomerRequest, @Body() body: unknown) {
    return this.customerAccount.claimRegistration(
      request.customerSession,
      parse(ClaimCustomerRegistrationSchema, body, '历史报名认领信息校验失败'),
    );
  }

  @Post('attendee-claims')
  claimAttendee(@Req() request: CustomerRequest, @Body() body: unknown) {
    return this.customerAccount.claimAttendee(
      request.customerSession,
      parse(AttendeeClaimInputSchema, body, '参会名额认领信息校验失败'),
    );
  }

  @Get('invoices')
  listInvoices(@Req() request: CustomerRequest, @Query() query: Record<string, unknown>) {
    return this.customerAccount.invoices(
      request.customerSession,
      parse(CustomerInvoiceCenterListQuerySchema, query, '发票列表筛选参数校验失败'),
    );
  }

  @Get('orders/:orderId/invoice')
  invoice(@Req() request: CustomerRequest, @Param('orderId') orderId: string) {
    return this.invoices.readCustomerOrderInvoice(
      request.customerSession.organizationId,
      request.customerSession.customerUserId,
      orderId,
    );
  }

  @Get('orders/:orderId/invoice-context')
  invoiceContext(@Req() request: CustomerRequest, @Param('orderId') orderId: string) {
    return this.invoices.customerOrderInvoiceContext(
      request.customerSession.organizationId,
      request.customerSession.customerUserId,
      orderId,
    );
  }

  @Post('orders/:orderId/invoice')
  createInvoice(
    @Req() request: CustomerRequest,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    return this.invoices.createCustomerOrderInvoice(
      request.customerSession.organizationId,
      request.customerSession.customerUserId,
      orderId,
      parse(CustomerCreateInvoiceSchema, body, '发票信息校验失败'),
    );
  }

  @Patch('orders/:orderId/invoice')
  updateInvoice(
    @Req() request: CustomerRequest,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    return this.invoices.updateCustomerOrderInvoice(
      request.customerSession.organizationId,
      request.customerSession.customerUserId,
      orderId,
      parse(CustomerUpdateInvoiceSchema, body, '发票信息校验失败'),
    );
  }

  @Post('orders/:orderId/invoice/send')
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  sendInvoice(@Req() request: CustomerRequest, @Param('orderId') orderId: string) {
    return this.invoices.sendCustomerOrderInvoice(
      request.customerSession.organizationId,
      request.customerSession.customerUserId,
      orderId,
    );
  }
}

@ApiTags('admin-customers')
@AgentSurface({
  defaultExclusionReason: 'Unlisted handlers remain human-only until added to the Agent catalog',
})
@Controller('admin/customers')
@UseGuards(AuthGuard)
class CustomerAdminController {
  constructor(
    @Inject(CustomerAccountService)
    private readonly customerAccount: CustomerAccountService,
  ) {}

  @Get()
  @RequireGrant('customer.read')
  list(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    return this.customerAccount.adminList(
      request.user.organizationId,
      parse(CustomerAdminListQuerySchema, query, '用户筛选条件校验失败'),
    );
  }

  @Post()
  @RequireGrant('customer.manage')
  create(@Req() request: FastifyRequest & { user: AuthenticatedUser }, @Body() body: unknown) {
    return this.customerAccount.adminCreate(
      request.user.organizationId,
      request.user.sub,
      parse(CreateCustomerAdminSchema, body, '新增用户信息校验失败'),
    );
  }

  @Get('export.csv')
  @RequireAllGrants('customer.read', 'customer.export')
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  async exportCustomers(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Query() query: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.customerAccount.adminExportCsv(
      request.user.organizationId,
      request.user.sub,
      parse(CustomerAdminExportQuerySchema, query, '用户导出筛选条件校验失败'),
    );
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .header('Cache-Control', 'private, no-store, max-age=0')
      .header('X-Export-Row-Count', String(result.count))
      .send(result.csv);
  }

  @Get(':userId')
  @RequireGrant('customer.read')
  detail(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.customerAccount.adminDetail(request.user.organizationId, userId);
  }

  @Get(':userId/registrations')
  @RequireGrant('customer.read')
  registrations(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: Record<string, unknown>,
  ) {
    const input = parse(
      CustomerRegistrationListQuerySchema,
      { ...query, limit: query.limit ?? 50 },
      '报名历史分页参数校验失败',
    );
    return this.customerAccount.adminRegistrations(
      request.user.organizationId,
      userId,
      input.cursor,
      input.limit,
    );
  }

  @Get(':userId/invoices')
  @RequireGrant('customer.read')
  invoices(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: Record<string, unknown>,
  ) {
    const input = parse(
      CustomerRegistrationListQuerySchema,
      { ...query, limit: query.limit ?? 50 },
      '发票历史分页参数校验失败',
    );
    return this.customerAccount.adminInvoices(
      request.user.organizationId,
      userId,
      input.cursor,
      input.limit,
    );
  }

  @Patch(':userId')
  @RequireGrant('customer.manage')
  update(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('userId', ParseIntPipe) userId: number,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateCustomerAdminSchema, body, '用户管理信息校验失败');
    if (input.status && !grantAllows(request.user.grants, 'customer.status.manage')) {
      throw new ForbiddenException('当前角色无权修改普通用户账号状态');
    }
    return this.customerAccount.adminUpdate(
      request.user.organizationId,
      request.user.sub,
      userId,
      input,
    );
  }

  @Delete(':userId')
  @RequireGrant('customer.delete')
  remove(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.customerAccount.adminDelete(request.user.organizationId, request.user.sub, userId);
  }
}

@ApiTags('admin-attendee-showcases')
@AgentSurface({
  defaultExclusionReason: 'Unlisted handlers remain human-only until added to the Agent catalog',
})
@Controller('admin/events')
@UseGuards(AuthGuard)
class AdminAttendeeShowcaseController {
  constructor(
    @Inject(AttendeeShowcaseService)
    private readonly showcases: AttendeeShowcaseService,
  ) {}

  @Patch(':eventId/member-showcases/:showcaseId/moderation')
  @RequireGrant('customer.manage')
  moderate(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('showcaseId') showcaseId: string,
    @Body() body: unknown,
  ) {
    return this.showcases.moderate(
      request.user.organizationId,
      request.user.sub,
      eventId,
      showcaseId,
      parse(ModerateAttendeeShowcaseSchema, body, '名片治理信息校验失败'),
    );
  }
}

@ApiTags('admin-attendee-needs')
@AgentSurface({
  defaultExclusionReason: 'Unlisted handlers remain human-only until added to the Agent catalog',
})
@Controller('admin/events')
@UseGuards(AuthGuard)
export class AdminAttendeeNeedsController {
  constructor(
    @Inject(AttendeeNeedsService)
    private readonly attendeeNeeds: AttendeeNeedsService,
  ) {}

  @Get(':eventId/attendee-needs')
  @RequireGrant('event.registration.read')
  list(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('eventId', ParseIntPipe) eventId: number,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    return this.attendeeNeeds.adminList(
      request.user.organizationId,
      eventId,
      parse(AdminAttendeeNeedListQuerySchema, query, '参会需求筛选条件校验失败'),
    );
  }

  @Patch(':eventId/attendee-needs/:questionId')
  @RequireGrant('event.registration.manage')
  update(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @Body() body: unknown,
  ) {
    return this.attendeeNeeds.updateAdminQuestion(
      request.user.organizationId,
      request.user.sub,
      eventId,
      questionId,
      parse(UpdateAdminAttendeeNeedQuestionSchema, body, '参会问题修改信息校验失败'),
    );
  }

  @Patch(':eventId/attendee-needs/:questionId/moderation')
  @RequireGrant('event.registration.manage')
  moderate(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @Body() body: unknown,
  ) {
    return this.attendeeNeeds.moderateAdminQuestion(
      request.user.organizationId,
      request.user.sub,
      eventId,
      questionId,
      parse(ModerateAttendeeNeedQuestionSchema, body, '参会问题治理信息校验失败'),
    );
  }

  @Get(':eventId/attendee-needs/export.csv')
  @RequireAllGrants('event.registration.read', 'event.registration.export')
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  async export(
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Param('eventId', ParseIntPipe) eventId: number,
    @Query() query: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.attendeeNeeds.exportAdminCsv(
      request.user.organizationId,
      request.user.sub,
      eventId,
      parse(AdminAttendeeNeedExportQuerySchema, query, '参会需求导出条件校验失败'),
    );
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .header('Cache-Control', 'private, no-store, max-age=0')
      .header('X-Export-Row-Count', String(result.count))
      .send(result.csv);
  }
}

@Module({
  controllers: [
    CustomerAuthController,
    CustomerAccountController,
    CustomerAdminController,
    AdminAttendeeShowcaseController,
    AdminAttendeeNeedsController,
  ],
})
export class CustomerModule {}
