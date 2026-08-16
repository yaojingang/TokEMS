import { createHmac, timingSafeEqual } from 'node:crypto';
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
  CheckInRequestSchema,
  CreateRegistrationSchema,
  isPublicEventStatus,
  PaymentCallbackSchema,
  PublicEventMemberListQuerySchema,
  publicEventHomePath,
  publicEventScopedPath,
  WaitlistJoinSchema,
  WeChatPaymentChannelSchema,
} from '@conference/contracts';
import { isReadableTicketCode } from '@conference/security';
import { ConferenceRepository } from '../common/conference.repository.js';
import { DomainError } from '../common/domain-error.js';
import { AuthGuard, RequireGrant, type AuthenticatedUser } from '../common/auth.guard.js';
import { OrganizationAdminService } from '../common/organization-admin.service.js';
import { TemplateOperationsService } from '../common/template-operations.service.js';
import { resolveTrustedClientIp, WeChatPayService } from '../common/wechat-pay.service.js';
import { CustomerAuthService } from '../common/customer-auth.service.js';
import { HtmlTemplateOperationsService } from '../common/html-template-operations.service.js';
import { AttendeeShowcaseService } from '../common/attendee-showcase.service.js';
import { resolveLocalPaymentSimulationPolicy } from '../common/local-payment-simulation.js';

const WeChatSwitchChannelBodySchema = z
  .object({
    channel: WeChatPaymentChannelSchema,
    oauthSession: z.string().trim().min(16).max(500).optional(),
  })
  .strict();

const PublicOrganizationSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);

const WeChatJsapiPrepareBodySchema = z
  .object({
    oauthSession: z.string().trim().min(16).max(500).optional(),
  })
  .strict();

const WeChatOAuthStartBodySchema = z
  .object({
    returnPath: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const WeChatOAuthHandoffBodySchema = z
  .object({
    handoffCode: z.string().trim().min(16).max(128),
  })
  .strict();

/**
 * Reads an OAuth session token from the dedicated header or JSON body.
 *
 * @param headerValue - Optional X-Wechat-OAuth-Session header
 * @param bodyToken - Optional oauthSession field from the body
 * @returns Non-empty session token
 */
function oauthSessionToken(headerValue: string | undefined, bodyToken: string | undefined) {
  const token = (headerValue?.trim() || bodyToken?.trim() || '').trim();
  if (token.length < 16 || token.length > 500) {
    throw new DomainError(
      API_ERROR_CODES.UNAUTHORIZED,
      '微信 OAuth 会话无效或已过期',
      HttpStatus.UNAUTHORIZED,
    );
  }
  return token;
}

/**
 * Resolves a trusted payer client IP for H5 scene_info.
 *
 * @param request - Incoming Fastify request
 * @returns Best-effort client IP string
 */
function trustedClientIp(request: FastifyRequest) {
  const forwarded = request.headers['x-forwarded-for'];
  return resolveTrustedClientIp(
    request.ip,
    typeof forwarded === 'string' ? forwarded : Array.isArray(forwarded) ? forwarded[0] : undefined,
  );
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

function orderAccessToken(authorization: string | undefined) {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (token.length < 32 || token.length > 500) {
    throw new DomainError(
      API_ERROR_CODES.UNAUTHORIZED,
      '订单访问链接无效或已经过期',
      HttpStatus.UNAUTHORIZED,
    );
  }
  return token;
}

function verifyPaymentSignature(
  provider: string,
  body: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
) {
  const providerKey = `PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase().replaceAll('-', '_')}`;
  const secret =
    process.env[providerKey] ??
    process.env.PAYMENT_WEBHOOK_SECRET ??
    (process.env.NODE_ENV === 'production' ? undefined : 'conference-webhook-development-secret');
  if (
    !secret ||
    (process.env.NODE_ENV === 'production' &&
      [
        'conference-webhook-development-secret',
        'conference-local-payment-webhook-secret-2026',
        'replace-with-a-random-provider-webhook-secret',
      ].includes(secret))
  ) {
    throw new DomainError(
      API_ERROR_CODES.INVALID_STATE_TRANSITION,
      '支付回调密钥尚未配置',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  const timestampValue = Number(timestamp);
  if (
    !timestamp ||
    !Number.isFinite(timestampValue) ||
    Math.abs(Date.now() - timestampValue) > 5 * 60_000
  ) {
    throw new DomainError(
      API_ERROR_CODES.UNAUTHORIZED,
      '支付回调时间戳无效或已经过期',
      HttpStatus.UNAUTHORIZED,
    );
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  const receivedBuffer = Buffer.from(signature ?? '', 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw new DomainError(
      API_ERROR_CODES.UNAUTHORIZED,
      '支付回调签名校验失败',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

async function servePublishedHomeDocument(
  htmlTemplates: HtmlTemplateOperationsService,
  repository: ConferenceRepository,
  slug: string,
  organizationSlug: string,
  ifNoneMatch: string | undefined,
  reply: FastifyReply,
) {
  try {
    const document = await htmlTemplates.renderPublishedHome(slug, organizationSlug);
    if (!document) {
      return reply
        .code(HttpStatus.NO_CONTENT)
        .header('Cache-Control', 'no-cache, must-revalidate')
        .header('Vary', 'X-Organization-Slug, Accept-Encoding')
        .send();
    }
    if (ifNoneMatch && ifNoneMatch === document.etag) {
      return reply
        .code(HttpStatus.NOT_MODIFIED)
        .header('Cache-Control', 'no-cache, must-revalidate')
        .header('ETag', document.etag)
        .header('Vary', 'X-Organization-Slug, Accept-Encoding')
        .send();
    }
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', document.csp)
      .header('Cache-Control', 'no-cache, must-revalidate')
      .header('ETag', document.etag)
      .header('Vary', 'X-Organization-Slug, Accept-Encoding')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), usb=(), bluetooth=()',
      )
      .send(document.html);
  } catch (error) {
    if (error instanceof DomainError && error.getStatus() === HttpStatus.NOT_FOUND) throw error;
    const artifact = await htmlTemplates.renderPublishedArtifactFallback(slug, organizationSlug);
    if (artifact) {
      if (ifNoneMatch && ifNoneMatch === artifact.etag) {
        return reply
          .code(HttpStatus.NOT_MODIFIED)
          .header('Cache-Control', 'no-cache, must-revalidate')
          .header('ETag', artifact.etag)
          .header('Vary', 'X-Organization-Slug, Accept-Encoding')
          .send();
      }
      return reply
        .type('text/html; charset=utf-8')
        .header('Content-Security-Policy', artifact.csp)
        .header('Cache-Control', 'no-cache, must-revalidate')
        .header('ETag', artifact.etag)
        .header('Vary', 'X-Organization-Slug, Accept-Encoding')
        .header('Referrer-Policy', 'strict-origin-when-cross-origin')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Warning', '110 - "Response served from release artifact"')
        .send(artifact.html);
    }
    const event = await repository.getPublicEvent(slug, organizationSlug);
    const escape = (value: string) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    const registrationPath = publicEventScopedPath('/register', event.slug);
    const canonicalPath = publicEventHomePath(event.slug);
    const publicOrigin = (process.env.PUBLIC_ORIGIN ?? process.env.PUBLIC_SITE_URL ?? '').replace(
      /\/+$/u,
      '',
    );
    const canonicalUrl = publicOrigin ? `${publicOrigin}${canonicalPath}` : canonicalPath;
    const fallback = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(event.name)}</title><link rel="canonical" href="${escape(canonicalUrl)}"><meta property="og:url" content="${escape(canonicalUrl)}"></head><body><main><h1>${escape(event.name)}</h1><p>${escape(event.startsAt)} · ${escape(event.venue)}</p><p>页面正在恢复，请稍后刷新。</p><a href="${registrationPath}">进入报名</a></main></body></html>`;
    return reply
      .code(HttpStatus.SERVICE_UNAVAILABLE)
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
      )
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), usb=(), bluetooth=()',
      )
      .send(fallback);
  }
}

@ApiTags('public-events')
@Controller('events')
class EventsController {
  constructor(
    @Inject(ConferenceRepository) private readonly repository: ConferenceRepository,
    @Inject(HtmlTemplateOperationsService)
    private readonly htmlTemplates: HtmlTemplateOperationsService,
    @Inject(AttendeeShowcaseService)
    private readonly showcases: AttendeeShowcaseService,
  ) {}

  @Get(':slug/home-document')
  async getHomeDocument(
    @Param('slug') slug: string,
    @Headers('x-organization-slug') organizationSlugValue: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const organizationSlug =
      organizationSlugValue ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference';
    const route = await this.repository.resolvePublicEventRoute(slug, organizationSlug);
    if (route.isAlias) reply.header('X-Canonical-Event-Slug', route.slug);
    return servePublishedHomeDocument(
      this.htmlTemplates,
      this.repository,
      route.slug,
      organizationSlug,
      ifNoneMatch,
      reply,
    );
  }

  @Get(':slug/members')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async getMembers(
    @Param('slug') slug: string,
    @Headers('x-organization-slug') organizationSlugValue: string | undefined,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = PublicEventMemberListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '报名会员分页参数校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    reply.header('Cache-Control', 'no-cache, must-revalidate');
    return this.showcases.publicMembers(
      slug,
      organizationSlugValue ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
      parsed.data,
    );
  }

  @Get(':slug/members/:publicSlug/avatar')
  @Throttle({ default: { limit: 1_200, ttl: 60_000 } })
  async getMemberAvatar(
    @Param('slug') slug: string,
    @Param('publicSlug') publicSlug: string,
    @Headers('x-organization-slug') organizationSlugValue: string | undefined,
    @Query('organization') organizationSlugQuery: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const organizationSlug = PublicOrganizationSlugSchema.safeParse(
      organizationSlugValue ??
        organizationSlugQuery ??
        process.env.PUBLIC_ORGANIZATION_SLUG ??
        'geo-conference',
    );
    if (!organizationSlug.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '大会组织标识无效',
        HttpStatus.BAD_REQUEST,
      );
    }
    const body = await this.showcases.publicAvatarContent(slug, organizationSlug.data, publicSlug);
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Type', 'image/webp')
      .send(body);
  }

  @Get(':slug/members/:publicSlug')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getMember(
    @Param('slug') slug: string,
    @Param('publicSlug') publicSlug: string,
    @Headers('x-organization-slug') organizationSlugValue: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'no-cache, must-revalidate');
    return this.showcases.publicMember(
      slug,
      organizationSlugValue ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
      publicSlug,
    );
  }

  @Get(':slug')
  async getEvent(
    @Param('slug') slug: string,
    @Headers('x-organization-slug') organizationSlug?: string,
    @Res({ passthrough: true }) reply?: FastifyReply,
  ) {
    reply?.header('Cache-Control', 'no-cache, must-revalidate');
    const resolved = await this.repository.resolvePublicEventRoute(
      slug,
      organizationSlug ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
    );
    if (resolved.isAlias) {
      reply?.header('Content-Location', publicEventHomePath(resolved.slug));
    }
    const event = await this.repository.getPublicEvent(
      resolved.slug,
      organizationSlug ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
    );
    if (!isPublicEventStatus(event.status)) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或尚未发布',
        HttpStatus.NOT_FOUND,
      );
    }
    return event;
  }
}

@ApiTags('public-homepage')
@Controller('homepage')
class HomepageController {
  constructor(
    @Inject(ConferenceRepository) private readonly repository: ConferenceRepository,
    @Inject(HtmlTemplateOperationsService)
    private readonly htmlTemplates: HtmlTemplateOperationsService,
  ) {}

  @Get('home-document')
  async getHomeDocument(
    @Headers('x-organization-slug') organizationSlugValue: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const organizationSlug =
      organizationSlugValue ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference';
    const event = await this.repository.getPublicHomepageEvent(organizationSlug);
    return servePublishedHomeDocument(
      this.htmlTemplates,
      this.repository,
      event.slug,
      organizationSlug,
      ifNoneMatch,
      reply,
    );
  }

  @Get()
  getHomepage(
    @Headers('x-organization-slug') organizationSlug: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'no-cache, must-revalidate');
    return this.repository.getPublicHomepageEvent(
      organizationSlug ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
    );
  }
}

@ApiTags('public-site')
@Controller('site-config')
class SiteConfigurationController {
  constructor(
    @Inject(OrganizationAdminService)
    private readonly organizationAdmin: OrganizationAdminService,
  ) {}

  @Get()
  getConfiguration(
    @Headers('x-organization-slug') organizationSlug: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'no-cache, must-revalidate');
    return this.organizationAdmin.getPublicSiteConfiguration(
      organizationSlug ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
    );
  }
}

@ApiTags('public-template-assets')
@Controller('assets/templates')
class TemplateAssetsController {
  constructor(
    @Inject(TemplateOperationsService)
    private readonly templates: TemplateOperationsService,
  ) {}

  @Get(':assetId')
  async asset(@Param('assetId') assetId: string, @Res() reply: FastifyReply) {
    const url = await this.templates.publicAssetUrl(assetId);
    return reply.code(HttpStatus.FOUND).redirect(url);
  }
}

@ApiTags('registrations')
@Controller('registrations')
class RegistrationsController {
  constructor(
    @Inject(ConferenceRepository) private readonly repository: ConferenceRepository,
    @Inject(CustomerAuthService) private readonly customerAuth: CustomerAuthService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    const parsed = CreateRegistrationSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '报名信息校验失败，请检查必填项',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    const session = await this.customerAuth.optionalSession(request);
    return this.repository.createCheckout(
      parsed.data,
      idempotencyKey(key),
      session
        ? {
            customerUserId: session.customerUserId,
            organizationId: session.organizationId,
            mobile: session.customer.mobile,
            profile: session.customer.profile,
          }
        : undefined,
    );
  }
}

@ApiTags('waitlist')
@Controller('waitlist')
class WaitlistController {
  constructor(
    @Inject(ConferenceRepository) private readonly repository: ConferenceRepository,
    @Inject(CustomerAuthService) private readonly customerAuth: CustomerAuthService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async join(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    const parsed = WaitlistJoinSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '候补信息校验失败，请检查姓名和邮箱',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    const session = await this.customerAuth.optionalSession(request);
    return this.repository.joinWaitlist(
      parsed.data,
      idempotencyKey(key),
      session
        ? {
            customerUserId: session.customerUserId,
            organizationId: session.organizationId,
            mobile: session.customer.mobile,
            profile: session.customer.profile,
          }
        : undefined,
    );
  }
}

@ApiTags('orders-and-tickets')
@Controller()
class OrdersController {
  constructor(
    @Inject(ConferenceRepository) private readonly repository: ConferenceRepository,
    @Inject(WeChatPayService) private readonly weChatPay: WeChatPayService,
  ) {}

  @Get('orders/:identifier')
  async getOrder(
    @Param('identifier') identifier: string,
    @Headers('authorization') authorization?: string,
    @Query('sync') sync?: string,
  ) {
    const accessToken = orderAccessToken(authorization);
    const current = await this.repository.getOrder(identifier, accessToken);
    if (['pending_payment', 'processing'].includes(current.status)) {
      try {
        const forceSync = sync === '1' || sync === 'true';
        const transaction = await this.weChatPay.queryPayment(current.id, accessToken, {
          force: forceSync,
        });
        if (transaction) {
          await this.repository.confirmPayment(
            transaction.orderId,
            `wechatpay:query:${transaction.externalId}`,
            {
              provider: 'wechatpay',
              externalId: transaction.externalId,
              amount: transaction.amount,
              currency: transaction.currency,
              occurredAt: transaction.occurredAt,
              paymentId: transaction.paymentId,
              outTradeNo: transaction.outTradeNo,
              payload: {
                source: 'transaction-query',
                outTradeNo: transaction.outTradeNo,
                occurredAt: transaction.occurredAt,
                receivedAt: new Date().toISOString(),
              },
              reason: '微信支付主动查单确认成功',
            },
          );
          return this.repository.getOrder(identifier, accessToken);
        }
      } catch {
        // 回调仍是主确认路径；查单暂时失败时继续返回本地订单供用户重试。
      }
    }
    return current;
  }

  @Get('orders/:identifier/ticket')
  getOrderTicket(
    @Param('identifier') identifier: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.repository.getOrderTicket(identifier, orderAccessToken(authorization));
  }

  @Post('payments/mock/:orderId/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  confirmMockPayment(
    @Param('orderId') orderId: string,
    @Headers('authorization') authorization?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    const policy = resolveLocalPaymentSimulationPolicy();
    if (!policy.enabled) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '当前环境未启用模拟支付确认',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.repository.confirmLocalPaymentSimulation(
      orderId,
      orderAccessToken(authorization),
      idempotencyKey(key),
      policy.allowedMobileE164s,
    );
  }

  @Get('payments/mock/:orderId/capability')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async localPaymentSimulationCapability(
    @Param('orderId') orderId: string,
    @Headers('authorization') authorization?: string,
  ) {
    const policy = resolveLocalPaymentSimulationPolicy();
    if (!policy.enabled) return { allowed: false };
    const allowed = await this.repository.canUseLocalPaymentSimulation(
      orderId,
      orderAccessToken(authorization),
      policy.allowedMobileE164s,
    );
    return { allowed };
  }

  @Post('payments/wechat/:orderId/native')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  prepareWeChatNativePayment(
    @Param('orderId') orderId: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.weChatPay.prepareNativePayment(orderId, orderAccessToken(authorization));
  }

  @Post('payments/wechat/:orderId/jsapi')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  prepareWeChatJsapiPayment(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
    @Headers('x-wechat-oauth-session') oauthSessionHeader?: string,
  ) {
    const parsed = WeChatJsapiPrepareBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'JSAPI 支付参数校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.weChatPay.prepareJsapiPayment(
      orderId,
      orderAccessToken(authorization),
      oauthSessionToken(oauthSessionHeader, parsed.data.oauthSession),
    );
  }

  @Post('payments/wechat/:orderId/h5')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  prepareWeChatH5Payment(
    @Param('orderId') orderId: string,
    @Req() request: FastifyRequest,
    @Headers('authorization') authorization?: string,
  ) {
    return this.weChatPay.prepareH5Payment(
      orderId,
      orderAccessToken(authorization),
      trustedClientIp(request),
    );
  }

  @Post('payments/wechat/:orderId/switch')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async switchWeChatPaymentChannel(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Headers('authorization') authorization?: string,
    @Headers('x-wechat-oauth-session') oauthSessionHeader?: string,
  ) {
    return this.switchWeChatPaymentChannelHandler(
      orderId,
      body,
      request,
      authorization,
      oauthSessionHeader,
    );
  }

  @Post('payments/wechat/:orderId/switch-channel')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async switchWeChatPaymentChannelAlias(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Headers('authorization') authorization?: string,
    @Headers('x-wechat-oauth-session') oauthSessionHeader?: string,
  ) {
    return this.switchWeChatPaymentChannelHandler(
      orderId,
      body,
      request,
      authorization,
      oauthSessionHeader,
    );
  }

  @Post('payments/wechat/:orderId/channel')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async switchWeChatPaymentChannelFrontendAlias(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Headers('authorization') authorization?: string,
    @Headers('x-wechat-oauth-session') oauthSessionHeader?: string,
  ) {
    return this.switchWeChatPaymentChannelHandler(
      orderId,
      body,
      request,
      authorization,
      oauthSessionHeader,
    );
  }

  /**
   * Shared channel-switch handler used by /switch, /switch-channel, and /channel.
   *
   * @param orderId - Order UUID
   * @param body - Request body with target channel
   * @param request - Fastify request for client IP
   * @param authorization - Bearer order access token
   * @param oauthSessionHeader - Optional OAuth session header
   * @returns Paid confirmation or fresh prepare result
   */
  private async switchWeChatPaymentChannelHandler(
    orderId: string,
    body: unknown,
    request: FastifyRequest,
    authorization: string | undefined,
    oauthSessionHeader: string | undefined,
  ) {
    const parsed = WeChatSwitchChannelBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '切换支付通道参数校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    const accessToken = orderAccessToken(authorization);
    const switchOptions: { clientIp: string; oauthSessionToken?: string } = {
      clientIp: trustedClientIp(request),
    };
    if (parsed.data.channel === 'jsapi') {
      switchOptions.oauthSessionToken = oauthSessionToken(
        oauthSessionHeader,
        parsed.data.oauthSession,
      );
    }
    const result = await this.weChatPay.switchChannel(
      orderId,
      accessToken,
      parsed.data.channel,
      switchOptions,
    );
    if (result.paid) {
      await this.repository.confirmPayment(
        result.payment.orderId,
        `wechatpay:switch:${result.payment.externalId}`,
        {
          provider: 'wechatpay',
          externalId: result.payment.externalId,
          amount: result.payment.amount,
          currency: result.payment.currency,
          occurredAt: result.payment.occurredAt,
          paymentId: result.payment.paymentId,
          outTradeNo: result.payment.outTradeNo,
          payload: {
            source: 'channel-switch',
            outTradeNo: result.payment.outTradeNo,
            occurredAt: result.payment.occurredAt,
            receivedAt: new Date().toISOString(),
          },
          reason: '切换通道时发现订单已支付',
        },
      );
      return { paid: true, orderId: result.payment.orderId };
    }
    return result.payment;
  }

  @Post('payments/wechat/:orderId/oauth/start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  startWeChatOAuth(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const parsed = WeChatOAuthStartBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'OAuth 启动参数校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.weChatPay.startOAuth(
      orderId,
      orderAccessToken(authorization),
      parsed.data.returnPath ?? `/order/${orderId}`,
    );
  }

  @Get('payments/wechat/oauth/callback')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async weChatOAuthCallback(
    @Res() reply: FastifyReply,
    @Req() request: FastifyRequest<{ Querystring: { code?: string; state?: string } }>,
  ) {
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const result = await this.weChatPay.consumeOAuthCallback(code, state);
    return reply.redirect(result.redirectUrl, 302);
  }

  @Post('payments/wechat/oauth/handoff')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  exchangeWeChatOAuthHandoff(@Body() body: unknown) {
    const parsed = WeChatOAuthHandoffBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'OAuth handoff 参数校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.weChatPay.exchangeHandoff(parsed.data.handoffCode);
  }

  @Post('payments/wechat/notify/:organizationId')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async weChatPaymentNotification(
    @Param('organizationId') organizationId: string,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
    @Headers('wechatpay-timestamp') timestamp?: string,
    @Headers('wechatpay-nonce') nonce?: string,
    @Headers('wechatpay-signature') signature?: string,
    @Headers('wechatpay-serial') serial?: string,
  ) {
    if (!request.rawBody) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '微信支付回调缺少原始请求内容',
        HttpStatus.BAD_REQUEST,
      );
    }
    const transaction = await this.weChatPay.parseNotification(organizationId, request.rawBody, {
      timestamp,
      nonce,
      signature,
      serial,
    });
    // Fast ACK after durable inbox write; confirm asynchronously for worker/retry safety.
    if (!transaction.alreadyProcessed) {
      void this.weChatPay.processPaymentNotificationAsync(transaction.inboxId).catch(() => {
        // Worker/ops can retry failed inbox rows; notify must still return SUCCESS.
      });
    }
    return { code: 'SUCCESS', message: '成功' };
  }

  @Post('payments/webhook/:provider')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  paymentWebhook(
    @Param('provider') provider: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
    @Headers('x-payment-timestamp') timestamp?: string,
    @Headers('x-payment-signature') signature?: string,
  ) {
    if (!/^[a-z0-9-]{2,40}$/.test(provider)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '支付渠道标识格式不正确',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (provider === 'wechatpay') {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '微信支付必须使用专用的签名回调地址',
        HttpStatus.BAD_REQUEST,
      );
    }
    const parsed = PaymentCallbackSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '支付回调内容校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    verifyPaymentSignature(
      provider,
      request.rawBody ?? Buffer.from(JSON.stringify(body)),
      timestamp,
      signature,
    );
    return this.repository.confirmPayment(
      parsed.data.orderId,
      `payment:${provider}:${parsed.data.externalId}`,
      {
        provider,
        externalId: parsed.data.externalId,
        amount: parsed.data.amount,
        currency: parsed.data.currency,
        occurredAt: parsed.data.occurredAt,
        payload: {
          status: parsed.data.status,
          occurredAt: parsed.data.occurredAt,
          receivedAt: new Date().toISOString(),
        },
        reason: `${provider} 支付回调确认成功`,
      },
    );
  }

  @Get('tickets/:code')
  getTicket(@Param('code') code: string) {
    if (!isReadableTicketCode(code)) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '电子票尚未签发', HttpStatus.NOT_FOUND);
    }
    return this.repository.getTicket(code);
  }
}

@ApiTags('checkin')
@UseGuards(AuthGuard)
@Controller('checkins')
class CheckInController {
  constructor(@Inject(ConferenceRepository) private readonly repository: ConferenceRepository) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireGrant('event.checkin.execute')
  checkIn(@Body() body: unknown, @Req() request: FastifyRequest & { user: AuthenticatedUser }) {
    const parsed = CheckInRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '核销参数校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.repository.checkIn(parsed.data, request.user.organizationId);
  }
}

@Module({
  controllers: [
    EventsController,
    HomepageController,
    SiteConfigurationController,
    TemplateAssetsController,
    RegistrationsController,
    WaitlistController,
    OrdersController,
    CheckInController,
  ],
})
export class PublicModule {}
