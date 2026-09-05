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
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  API_ERROR_CODES,
  CustomerRefundApplicationSchema,
  RefundVersionSchema,
  RejectRefundApplicationSchema,
  RefundApplicationQuerySchema,
  RefundExecutionModeSchema,
  VerifyExternalRefundSchema,
} from '@conference/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthGuard, RequireGrant, type AuthenticatedUser } from '../common/auth.guard.js';
import { AgentSurface } from '../common/agent-operation-catalog.js';
import { CustomerAuthGuard, type CustomerRequest } from '../common/customer-auth.guard.js';
import { DomainError } from '../common/domain-error.js';
import { RefundWorkflowService } from '../common/refund-workflow.service.js';
import { WeChatPayService } from '../common/wechat-pay.service.js';

type AdminRequest = FastifyRequest & { user: AuthenticatedUser };
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '退款请求参数无效，请刷新后重试',
      HttpStatus.BAD_REQUEST,
    );
  return parsed.data;
}
function idempotency(key?: string) {
  if (!key || !/^[A-Za-z0-9_.:/-]{8,120}$/u.test(key))
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '缺少有效的操作标识',
      HttpStatus.BAD_REQUEST,
    );
  return key;
}

@ApiTags('customer-refunds')
@Controller('customer')
@UseGuards(CustomerAuthGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class CustomerRefundController {
  constructor(@Inject(RefundWorkflowService) private readonly workflow: RefundWorkflowService) {}
  @Get('orders/:orderId/refund-context')
  context(
    @Req() request: CustomerRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.workflow.customerContext(request.customerSession, orderId);
  }
  @Post('orders/:orderId/refund-requests')
  create(
    @Req() request: CustomerRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.workflow.createCustomer(
      request.customerSession,
      orderId,
      idempotency(key),
      parse(CustomerRefundApplicationSchema, body),
    );
  }
  @Post('refund-requests/:requestId/withdraw')
  withdraw(
    @Req() request: CustomerRequest,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.workflow.withdraw(
      request.customerSession,
      requestId,
      idempotency(key),
      parse(RefundVersionSchema, body).version,
    );
  }
}

@ApiTags('admin-refunds')
@Controller('admin')
@UseGuards(AuthGuard)
@AgentSurface({
  defaultExclusionReason:
    'Refund workflow operations require human review until explicitly catalogued',
})
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminRefundController {
  constructor(@Inject(RefundWorkflowService) private readonly workflow: RefundWorkflowService) {}
  @Get('events/:eventId/refund-policy')
  @RequireGrant('event.registration.read')
  policy(@Req() request: AdminRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.workflow.eventPolicy(request.user.organizationId, eventId);
  }
  @Get('events/:eventId/refund-exceptions')
  @RequireGrant('event.order.read')
  exceptions(@Req() request: AdminRequest, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.workflow.adminExceptions(request.user.organizationId, eventId);
  }
  @Get('integrations/wechat-pay/refund-notifications')
  @RequireGrant('org.settings.manage')
  unmatched(@Req() request: AdminRequest) {
    return this.workflow.unmatchedNotifications(request.user.organizationId);
  }
  @Get('events/:eventId/refund-requests')
  @RequireGrant('event.order.read')
  list(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.workflow.adminList(
      request.user.organizationId,
      eventId,
      parse(RefundApplicationQuerySchema, query),
    );
  }
  @Post('events/:eventId/refund-requests/:requestId/approve')
  @RequireGrant('event.order.refund')
  approve(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.workflow.review(
      request.user.organizationId,
      eventId,
      requestId,
      request.user.sub,
      idempotency(key),
      parse(RefundVersionSchema, body),
      'approve',
    );
  }
  @Post('events/:eventId/refund-requests/:requestId/reject')
  @RequireGrant('event.order.refund')
  reject(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.workflow.review(
      request.user.organizationId,
      eventId,
      requestId,
      request.user.sub,
      idempotency(key),
      parse(RejectRefundApplicationSchema, body),
      'reject',
    );
  }
  @Post('events/:eventId/refund-requests/:requestId/reconcile')
  @RequireGrant('event.order.refund')
  reconcile(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.workflow.schedule(
      request.user.organizationId,
      eventId,
      requestId,
      request.user.sub,
      idempotency(key),
      parse(RefundVersionSchema, body).version,
      'reconcile',
    );
  }
  @Post('events/:eventId/refund-requests/:requestId/retry')
  @RequireGrant('event.order.refund')
  retry(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.workflow.schedule(
      request.user.organizationId,
      eventId,
      requestId,
      request.user.sub,
      idempotency(key),
      parse(RefundVersionSchema, body).version,
      'retry',
    );
  }
  @Post('events/:eventId/refund-requests/:requestId/continue')
  @RequireGrant('event.order.refund')
  continueRefund(
    @Req() request: AdminRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.workflow.schedule(
      request.user.organizationId,
      eventId,
      requestId,
      request.user.sub,
      idempotency(key),
      parse(RefundVersionSchema, body).version,
      'continue',
    );
  }
  @Post('orders/:orderId/refund-execution-mode')
  @RequireGrant('event.order.refund')
  mode(
    @Req() request: AdminRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.workflow.executionMode(
      request.user.organizationId,
      orderId,
      request.user.sub,
      idempotency(key),
      parse(RefundExecutionModeSchema, body),
    );
  }
  @Post('orders/:orderId/external-refunds/verify')
  @RequireGrant('event.order.refund')
  verify(
    @Req() request: AdminRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.workflow.verifyExternal(
      request.user.organizationId,
      orderId,
      request.user.sub,
      idempotency(key),
      parse(VerifyExternalRefundSchema, body).outRefundNo,
    );
  }
}

@Controller('payments/wechat')
@ApiTags('wechat-refund-notifications')
export class WeChatRefundNotificationController {
  constructor(@Inject(WeChatPayService) private readonly wechat: WeChatPayService) {}
  @Post('refund-notify/:organizationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @SkipThrottle()
  async notify(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
  ) {
    if (!request.rawBody)
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '退款通知缺少原始请求体',
        HttpStatus.BAD_REQUEST,
      );
    const header = (name: string) =>
      typeof request.headers[name] === 'string' ? (request.headers[name] as string) : '';
    await this.wechat.receiveRefundNotification(organizationId, request.rawBody, {
      timestamp: header('wechatpay-timestamp'),
      nonce: header('wechatpay-nonce'),
      signature: header('wechatpay-signature'),
      serial: header('wechatpay-serial'),
    });
  }
}

@Module({
  controllers: [
    CustomerRefundController,
    AdminRefundController,
    WeChatRefundNotificationController,
  ],
})
export class RefundModule {}
