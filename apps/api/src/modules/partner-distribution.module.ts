import {
  Body,
  Controller,
  Get,
  Headers,
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
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_ERROR_CODES,
  AcceptPartnerProgramSchema,
  AdminBatchEnablePartnersSchema,
  AdminEditPartnerDetailsSchema,
  AdminEnablePartnerSchema,
  AdminUpdatePartnerSchema,
  ApprovePartnerPayoutBatchSchema,
  BindPartnerRecipientSchema,
  CompleteManualPartnerPayoutSchema,
  CompletePartnerWechatRecipientBindingSchema,
  ConfirmPartnerPayoutSettlementSchema,
  ConfirmPartnerPayoutDocumentSchema,
  CreatePartnerCommissionAdjustmentSchema,
  CreatePartnerInquirySchema,
  CreatePartnerPayoutBatchSchema,
  CreatePartnerPayoutSchema,
  CreatePartnerReconciliationSchema,
  ExecutePartnerPayoutBatchSchema,
  PublishPartnerProgramSchema,
  PartnerMediaConfirmSchema,
  PartnerMediaUploadSchema,
  PreparePartnerPayoutDocumentSchema,
  QueryPartnerPayoutExecutionSchema,
  ReviewPartnerPayoutSchema,
  ResolvePartnerInquirySchema,
  ResolvePartnerReconciliationSchema,
  StartPartnerWechatRecipientBindingSchema,
  UpdatePartnerPrivacySchema,
  UpdatePartnerProfileSchema,
  UpdatePartnerPosterCopySchema,
  UpdatePartnerTransferConfigurationSchema,
} from '@conference/contracts';
import {
  AuthGuard,
  RequireAllGrants,
  RequireGrant,
  type AuthenticatedUser,
} from '../common/auth.guard.js';
import { AttendeeShowcaseService } from '../common/attendee-showcase.service.js';
import { CustomerAuthGuard, type CustomerRequest } from '../common/customer-auth.guard.js';
import { DomainError } from '../common/domain-error.js';
import { MerchantTransferService } from '../common/merchant-transfer.service.js';
import { AgentSurface } from '../common/agent-operation-catalog.js';
import {
  PARTNER_REFERRAL_COOKIE,
  PartnerDistributionService,
} from '../common/partner-distribution.service.js';

function parse<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
  value: unknown,
  message: string,
) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(API_ERROR_CODES.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function organizationSlug(value: string | undefined) {
  return value ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference';
}

@ApiTags('public-partners')
@Controller('events/:eventSlug/partners')
class PublicPartnerController {
  constructor(
    @Inject(PartnerDistributionService) private readonly partners: PartnerDistributionService,
    @Inject(AttendeeShowcaseService) private readonly showcase: AttendeeShowcaseService,
  ) {}

  @Get()
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  list(
    @Param('eventSlug') eventSlug: string,
    @Headers('x-organization-slug') organization: string | undefined,
    @Query('limit') limitValue: string | undefined,
    @Query('surface') surfaceValue: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const limit = parse(
      z.coerce.number().int().min(1).max(100).default(24),
      limitValue,
      '分页参数无效',
    );
    const surface = parse(
      z.enum(['directory', 'homepage']).default('directory'),
      surfaceValue,
      '展示位置无效',
    );
    reply.header('Cache-Control', 'no-cache, must-revalidate');
    return this.partners.publicPartners(eventSlug, organizationSlug(organization), limit, surface);
  }

  @Get(':publicSlug')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async detail(
    @Param('eventSlug') eventSlug: string,
    @Param('publicSlug') publicSlug: string,
    @Headers('x-organization-slug') organization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'no-cache, must-revalidate');
    const partner = await this.partners.publicPartner(
      eventSlug,
      publicSlug,
      organizationSlug(organization),
    );
    if (!partner.searchIndexingEnabled) reply.header('X-Robots-Tag', 'noindex, nofollow');
    return partner;
  }

  @Get(':publicSlug/avatar')
  @Throttle({ default: { limit: 1_200, ttl: 60_000 } })
  async avatar(
    @Param('eventSlug') eventSlug: string,
    @Param('publicSlug') publicSlug: string,
    @Headers('x-organization-slug') organization: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const scope = await this.partners.publicPartnerMediaScope(
      eventSlug,
      publicSlug,
      organizationSlug(organization),
    );
    const body = await this.showcase.partnerMediaContent(
      scope.organizationId,
      scope.customerUserId,
      scope.assetId,
    );
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .header('Content-Type', 'image/webp')
      .header('X-Content-Type-Options', 'nosniff')
      .send(body);
  }

  @Get(':publicSlug/media/:assetId')
  @Throttle({ default: { limit: 1_200, ttl: 60_000 } })
  async media(
    @Param('eventSlug') eventSlug: string,
    @Param('publicSlug') publicSlug: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Headers('x-organization-slug') organization: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const scope = await this.partners.publicPartnerMediaScope(
      eventSlug,
      publicSlug,
      organizationSlug(organization),
      assetId,
    );
    const body = await this.showcase.partnerMediaContent(
      scope.organizationId,
      scope.customerUserId,
      scope.assetId,
    );
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .header('Content-Type', 'image/webp')
      .header('X-Content-Type-Options', 'nosniff')
      .send(body);
  }
}

@ApiTags('partner-referrals')
@Controller('r')
class PartnerReferralController {
  constructor(
    @Inject(PartnerDistributionService) private readonly partners: PartnerDistributionService,
  ) {}

  @Get(':code')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async resolve(
    @Param('code') code: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const userAgent = request.headers['user-agent'] ?? '';
    const result = await this.partners.resolveReferral(code, `${request.ip}:${userAgent}`);
    reply
      .header('Cache-Control', 'private, no-store')
      .setCookie(PARTNER_REFERRAL_COOKIE, result.cookie, {
        httpOnly: true,
        secure:
          process.env.NODE_ENV === 'production' || process.env.DEPLOYMENT_MODE === 'production',
        sameSite: 'lax',
        path: '/api/v1',
        maxAge: result.maxAge,
      });
    return { destinationPath: result.destinationPath };
  }
}

@ApiTags('customer-partnerships')
@Controller('customer/partnerships')
@UseGuards(CustomerAuthGuard)
class CustomerPartnerController {
  constructor(
    @Inject(PartnerDistributionService) private readonly partners: PartnerDistributionService,
    @Inject(AttendeeShowcaseService) private readonly showcase: AttendeeShowcaseService,
    @Inject(MerchantTransferService) private readonly transfers: MerchantTransferService,
  ) {}

  @Get()
  list(@Req() request: CustomerRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'private, no-store');
    return this.partners.accountPartnerships(request.customerSession);
  }

  @Get(':eventId')
  detail(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.partners.accountPartnership(request.customerSession, eventId);
  }

  @Post(':eventId/rule-acceptances')
  accept(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    const input = parse(AcceptPartnerProgramSchema, body, '规则确认信息校验失败');
    return this.partners.acceptProgram(
      request.customerSession,
      eventId,
      input.programVersionId,
      input.expectedPartnerVersion,
      request.ip,
      request.headers['user-agent'] ?? '',
    );
  }

  @Patch(':eventId/profile')
  profile(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.updateOwnProfile(
      request.customerSession,
      eventId,
      parse(UpdatePartnerProfileSchema, body, '合作伙伴资料校验失败'),
    );
  }

  @Patch(':eventId/poster-copy')
  posterCopy(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.updateOwnPosterCopy(
      request.customerSession,
      eventId,
      parse(UpdatePartnerPosterCopySchema, body, '海报文案校验失败'),
    );
  }

  @Patch(':eventId/privacy')
  privacy(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.updateOwnPrivacy(
      request.customerSession,
      eventId,
      parse(UpdatePartnerPrivacySchema, body, '公开设置校验失败'),
    );
  }

  @Post(':eventId/media-uploads')
  async prepareMedia(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    await this.partners.accountPartnership(request.customerSession, eventId);
    return this.showcase.preparePartnerMediaUpload(
      request.customerSession,
      eventId,
      parse(PartnerMediaUploadSchema, body, '图片上传信息校验失败'),
    );
  }

  @Post(':eventId/media-confirmations')
  async confirmMedia(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    await this.partners.accountPartnership(request.customerSession, eventId);
    return this.showcase.confirmPartnerMedia(
      request.customerSession,
      eventId,
      parse(PartnerMediaConfirmSchema, body, '图片确认信息校验失败'),
    );
  }

  @Get(':eventId/media/:assetId')
  async media(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Res() reply: FastifyReply,
  ) {
    const scope = await this.partners.accountPartnerMediaScope(
      request.customerSession,
      eventId,
      assetId,
    );
    const body = await this.showcase.partnerMediaContent(
      scope.organizationId,
      scope.customerUserId,
      scope.assetId,
    );
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Type', 'image/webp')
      .header('X-Content-Type-Options', 'nosniff')
      .send(body);
  }

  @Get(':eventId/commissions')
  commissions(@Req() request: CustomerRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.partners.commissionList(request.customerSession, eventId);
  }

  @Get(':eventId/payouts')
  payouts(@Req() request: CustomerRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.partners.payoutList(request.customerSession, eventId);
  }

  @Post(':eventId/payout-documents/:documentId/access-token')
  payoutDocumentAccess(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.partners.createPayoutDocumentAccessToken(
      request.customerSession,
      eventId,
      documentId,
    );
  }

  @Post(':eventId/recipients')
  bindRecipient(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.bindRecipient(
      request.customerSession,
      eventId,
      parse(BindPartnerRecipientSchema, body, '收款人信息校验失败'),
    );
  }

  @Post(':eventId/recipients/wechat/oauth/start')
  startRecipientOAuth(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    const input = parse(
      StartPartnerWechatRecipientBindingSchema,
      body,
      '微信收款人绑定信息校验失败',
    );
    return this.transfers.startRecipientOAuth(request.customerSession, eventId, input.displayName);
  }

  @Post(':eventId/recipients/wechat/oauth/complete')
  completeRecipientOAuth(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    const input = parse(
      CompletePartnerWechatRecipientBindingSchema,
      body,
      '微信授权交接信息校验失败',
    );
    return this.transfers.completeRecipientOAuth(
      request.customerSession,
      eventId,
      input.handoffCode,
    );
  }

  @Post(':eventId/payouts')
  createPayout(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.createPayout(
      request.customerSession,
      eventId,
      parse(CreatePartnerPayoutSchema, body, '提现申请校验失败'),
    );
  }

  @Post(':eventId/payouts/:requestId/settlement-confirmation')
  settlementConfirmation(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: unknown,
  ) {
    const input = parse(ConfirmPartnerPayoutSettlementSchema, body, '结算金额确认信息校验失败');
    return this.partners.confirmPayoutSettlement(
      request.customerSession,
      eventId,
      requestId,
      input.expectedVersion,
    );
  }

  @Get(':eventId/payouts/:requestId/wechat-confirmation')
  confirmation(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.transfers.customerConfirmation(request.customerSession, eventId, requestId);
  }

  @Post(':eventId/payouts/:requestId/user-confirmed')
  userConfirmed(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: unknown,
  ) {
    const input = parse(QueryPartnerPayoutExecutionSchema, body, '用户确认信息校验失败');
    return this.transfers.markCustomerConfirmed(
      request.customerSession,
      eventId,
      requestId,
      input.expectedVersion,
    );
  }

  @Get(':eventId/inquiries')
  inquiries(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.partners.inquiryList(request.customerSession, eventId);
  }

  @Post(':eventId/inquiries')
  inquiry(
    @Req() request: CustomerRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.createInquiry(
      request.customerSession,
      eventId,
      parse(CreatePartnerInquirySchema, body, '佣金申诉信息校验失败'),
    );
  }
}

@ApiTags('partner-payout-documents')
@Controller('partner-payout-documents')
class PartnerPayoutDocumentController {
  constructor(
    @Inject(PartnerDistributionService) private readonly partners: PartnerDistributionService,
  ) {}

  @Get(':documentId/download')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async download(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query('token') token: string,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.partners.downloadPayoutDocument(documentId, token);
    const extension =
      result.mediaType === 'application/pdf'
        ? 'pdf'
        : result.mediaType === 'image/png'
          ? 'png'
          : 'jpg';
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Type', result.mediaType)
      .header(
        'Content-Disposition',
        `attachment; filename="partner-payout-${result.kind}.${extension}"`,
      )
      .header('X-Content-Type-Options', 'nosniff')
      .send(result.body);
  }
}

type AdminRequest = FastifyRequest & { user: AuthenticatedUser };

@ApiTags('admin-partner-distribution')
@Controller('admin/events/:eventId/distribution')
@UseGuards(AuthGuard)
@AgentSurface({
  defaultExclusionReason: 'Partner financial administration is reserved for human operators',
})
export class AdminPartnerController {
  constructor(
    @Inject(PartnerDistributionService) private readonly partners: PartnerDistributionService,
    @Inject(MerchantTransferService) private readonly transfers: MerchantTransferService,
  ) {}

  @Get('overview')
  @RequireGrant('event.partner.read', 'event.commission.read')
  overview(@Req() request: AdminRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.partners.adminOverview(request.user.organizationId, eventId);
  }

  @Get('partners')
  @RequireGrant('event.partner.read')
  list(@Req() request: AdminRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.partners.adminPartners(request.user.organizationId, eventId);
  }

  @Post('partners')
  @RequireGrant('event.partner.manage')
  enable(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.enablePartner(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(AdminEnablePartnerSchema, body, '合作伙伴开通信息校验失败'),
    );
  }

  @Post('partners/batch')
  @RequireGrant('event.partner.manage')
  batchEnable(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    const input = parse(AdminBatchEnablePartnersSchema, body, '合作伙伴批量开通信息校验失败');
    return this.partners.batchEnablePartners(
      request.user.organizationId,
      eventId,
      request.user.sub,
      input.customerUserIds,
      input.customerPublicUserIds,
      input.personalRateBps,
      input.sendInvitation,
    );
  }

  @Patch('partners/:partnerId')
  @RequireGrant('event.partner.manage')
  update(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('partnerId', ParseUUIDPipe) partnerId: string,
    @Body() body: unknown,
  ) {
    return this.partners.updatePartner(
      request.user.organizationId,
      eventId,
      partnerId,
      request.user.sub,
      parse(AdminUpdatePartnerSchema, body, '合作伙伴设置校验失败'),
    );
  }

  @Patch('partners/:partnerId/details')
  @RequireGrant('event.partner.manage')
  updateDetails(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('partnerId', ParseUUIDPipe) partnerId: string,
    @Body() body: unknown,
  ) {
    return this.partners.updatePartnerDetails(
      request.user.organizationId,
      eventId,
      partnerId,
      request.user.sub,
      parse(AdminEditPartnerDetailsSchema, body, '合作伙伴资料校验失败'),
    );
  }

  @Post('programs')
  @RequireGrant('event.partner.rules.manage')
  publishProgram(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.publishProgram(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(PublishPartnerProgramSchema, body, '分销规则校验失败'),
    );
  }

  @Get('programs')
  @RequireGrant('event.partner.read')
  programs(@Req() request: AdminRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.partners.adminPrograms(request.user.organizationId, eventId);
  }

  @Get('commissions')
  @RequireGrant('event.commission.read')
  commissions(@Req() request: AdminRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.partners.adminCommissions(request.user.organizationId, eventId);
  }

  @Post('commission-adjustments')
  @RequireGrant('event.commission.manage')
  adjustCommission(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.createCommissionAdjustment(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(CreatePartnerCommissionAdjustmentSchema, body, '佣金调整信息校验失败'),
    );
  }

  @Get('commission-inquiries')
  @RequireGrant('event.commission.read')
  inquiries(@Req() request: AdminRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.partners.adminInquiries(request.user.organizationId, eventId);
  }

  @Get('payouts')
  @RequireGrant('event.payout.review')
  payouts(@Req() request: AdminRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.partners.adminPayouts(request.user.organizationId, eventId);
  }

  @Get('payouts/export')
  @RequireGrant('event.payout.export')
  async exportPayouts(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Res() reply: FastifyReply,
  ) {
    const rows = await this.partners.exportPayouts(
      request.user.organizationId,
      eventId,
      request.user.sub,
    );
    const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const header = [
      '提现申请ID',
      '合作伙伴路径',
      '结算渠道',
      '状态',
      '税前金额（分）',
      '税额（分）',
      '实付金额（分）',
      '币种',
      '申请时间',
      '审核时间',
      '完成时间',
    ];
    const csv = [
      header,
      ...rows.map((row) => [
        row.requestId,
        row.partnerSlug,
        row.channel,
        row.status,
        row.grossAmount,
        row.taxAmount,
        row.netAmount,
        row.currency,
        row.createdAt.toISOString(),
        row.reviewedAt?.toISOString() ?? '',
        row.completedAt?.toISOString() ?? '',
      ]),
    ]
      .map((row) => row.map(escape).join(','))
      .join('\n');
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="partner-payouts-${eventId}.csv"`)
      .header('X-Export-Row-Count', String(rows.length))
      .send(`\uFEFF${csv}`);
  }

  @Post('payout-documents/uploads')
  @RequireGrant('event.payout.execute')
  preparePayoutDocument(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.preparePayoutDocument(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(PreparePartnerPayoutDocumentSchema, body, '结算文件上传信息校验失败'),
    );
  }

  @Post('payout-documents/confirmations')
  @RequireGrant('event.payout.execute')
  confirmPayoutDocument(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    const input = parse(ConfirmPartnerPayoutDocumentSchema, body, '结算文件确认信息校验失败');
    return this.partners.confirmPayoutDocument(
      request.user.organizationId,
      eventId,
      request.user.sub,
      input.uploadToken,
    );
  }

  @Post('reconciliations/:reconciliationId/resolve')
  @RequireGrant('event.payout.execute')
  resolveReconciliation(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('reconciliationId', ParseUUIDPipe) reconciliationId: string,
    @Body() body: unknown,
  ) {
    const input = parse(ResolvePartnerReconciliationSchema, body, '对账销账信息校验失败');
    return this.partners.resolveReconciliation(
      request.user.organizationId,
      eventId,
      reconciliationId,
      request.user.sub,
      input.reason,
    );
  }

  @Post('reconciliations')
  @RequireGrant('event.payout.execute')
  createReconciliation(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.createReconciliation(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(CreatePartnerReconciliationSchema, body, '对账导入信息校验失败'),
    );
  }

  @Post('inquiries/:inquiryId/resolve')
  @RequireGrant('event.commission.manage')
  resolveInquiry(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('inquiryId', ParseUUIDPipe) inquiryId: string,
    @Body() body: unknown,
  ) {
    return this.partners.resolveInquiry(
      request.user.organizationId,
      eventId,
      inquiryId,
      request.user.sub,
      parse(ResolvePartnerInquirySchema, body, '佣金申诉处理信息校验失败'),
    );
  }

  @Post('payouts/:requestId/review')
  @RequireGrant('event.payout.review')
  reviewPayout(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: unknown,
  ) {
    return this.partners.reviewPayout(
      request.user.organizationId,
      eventId,
      requestId,
      request.user.sub,
      parse(ReviewPartnerPayoutSchema, body, '提现审核信息校验失败'),
    );
  }

  @Post('payout-batches')
  @RequireAllGrants('event.payout.review', 'event.payout.execute')
  createBatch(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() body: unknown,
  ) {
    return this.partners.createPayoutBatch(
      request.user.organizationId,
      eventId,
      request.user.sub,
      parse(CreatePartnerPayoutBatchSchema, body, '出款批次信息校验失败'),
    );
  }

  @Post('payout-batches/:batchId/review')
  @RequireGrant('event.payout.review')
  reviewBatch(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: unknown,
  ) {
    return this.partners.approvePayoutBatch(
      request.user.organizationId,
      eventId,
      batchId,
      request.user.sub,
      parse(ApprovePartnerPayoutBatchSchema, body, '出款批次复核信息校验失败'),
    );
  }

  @Post('payout-batches/:batchId/execute')
  @RequireGrant('event.payout.execute')
  executeBatch(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: unknown,
  ) {
    const input = parse(ExecutePartnerPayoutBatchSchema, body, '出款执行信息校验失败');
    return this.transfers.executeBatch(
      request.user.organizationId,
      eventId,
      batchId,
      request.user.sub,
      input.expectedVersion,
    );
  }

  @Post('payout-executions/:executionId/query')
  @RequireGrant('event.payout.execute')
  queryExecution(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Body() body: unknown,
  ) {
    const input = parse(QueryPartnerPayoutExecutionSchema, body, '转账查单信息校验失败');
    return this.transfers.queryExecution(
      request.user.organizationId,
      eventId,
      executionId,
      input.expectedVersion,
    );
  }

  @Post('payouts/:requestId/manual-completion')
  @RequireGrant('event.payout.execute')
  completeManual(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: unknown,
  ) {
    const input = parse(CompleteManualPartnerPayoutSchema, body, '人工结算信息校验失败');
    return this.partners.completeManualPayout(
      request.user.organizationId,
      eventId,
      requestId,
      request.user.sub,
      input,
    );
  }

  @Post('recipients/:recipientId/details')
  @HttpCode(HttpStatus.OK)
  @RequireGrant('event.payout.review', 'event.payout.execute')
  recipientDetails(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store').header('Pragma', 'no-cache');
    return this.partners.recipientDetails(
      request.user.organizationId,
      eventId,
      recipientId,
      request.user.sub,
    );
  }

  @Post('recipients/:recipientId/verify')
  @RequireGrant('event.payout.review')
  verifyRecipient(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    return this.partners.verifyRecipient(
      request.user.organizationId,
      eventId,
      recipientId,
      request.user.sub,
    );
  }
}

@ApiTags('organization-payout-settings')
@Controller('admin/organization/payout-settings')
@UseGuards(AuthGuard)
@AgentSurface({
  defaultExclusionReason: 'Merchant transfer configuration is reserved for human operators',
})
class OrganizationPayoutSettingsController {
  constructor(
    @Inject(PartnerDistributionService) private readonly partners: PartnerDistributionService,
  ) {}

  @Get()
  @RequireGrant('org.payout.settings.read')
  get(@Req() request: AdminRequest) {
    return this.partners.getTransferConfiguration(request.user.organizationId);
  }

  @Patch()
  @RequireGrant('org.payout.settings.manage')
  update(@Req() request: AdminRequest, @Body() body: unknown) {
    const input = parse(UpdatePartnerTransferConfigurationSchema, body, '商家转账配置校验失败');
    const { expectedRevision, ...configuration } = input;
    return this.partners.updateTransferConfiguration(
      request.user.organizationId,
      request.user.sub,
      expectedRevision,
      configuration,
    );
  }
}

@ApiTags('wechat-partner-payout-notifications')
@Controller('partner-payouts/wechat')
class MerchantTransferNotificationController {
  constructor(
    @Inject(MerchantTransferService) private readonly transfers: MerchantTransferService,
  ) {}

  @Get('recipient-oauth/callback')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async recipientOAuthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() reply: FastifyReply,
  ) {
    const redirectUrl = await this.transfers.consumeRecipientOAuthCallback(code, state);
    return reply.redirect(redirectUrl);
  }

  @Post('notify/:organizationId')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async notify(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
  ) {
    if (!request.rawBody) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '微信转账通知缺少原始请求体',
        HttpStatus.BAD_REQUEST,
      );
    }
    const header = (name: string) =>
      typeof request.headers[name] === 'string' ? (request.headers[name] as string) : undefined;
    await this.transfers.receiveNotification(organizationId, request.rawBody, {
      timestamp: header('wechatpay-timestamp'),
      nonce: header('wechatpay-nonce'),
      signature: header('wechatpay-signature'),
      serial: header('wechatpay-serial'),
    });
    return { code: 'SUCCESS', message: '成功' };
  }
}

@Module({
  controllers: [
    PublicPartnerController,
    PartnerReferralController,
    PartnerPayoutDocumentController,
    CustomerPartnerController,
    AdminPartnerController,
    OrganizationPayoutSettingsController,
    MerchantTransferNotificationController,
  ],
})
export class PartnerDistributionModule {}
