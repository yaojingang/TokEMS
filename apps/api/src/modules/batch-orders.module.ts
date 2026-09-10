import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  API_ERROR_CODES,
  CancelCustomerOrderSchema,
  GenerateClaimInvitationSchema,
  ReviewBatchOrderSchema,
  SelectedOrderItemsSchema,
  UpdatePurchasedOrderAttendeeSchema,
} from '@conference/contracts';
import { BatchOrderManagementService } from '../common/batch-order-management.service.js';
import { BatchClaimInvitationService } from '../common/batch-claim-invitation.service.js';
import { OrderItemsService } from '../common/order-items.service.js';
import { CustomerAccountService } from '../common/customer-account.service.js';
import { CustomerAuthGuard, type CustomerRequest } from '../common/customer-auth.guard.js';
import { AuthGuard, RequireGrant, type AuthenticatedUser } from '../common/auth.guard.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { AgentSurface } from '../common/agent-operation-catalog.js';
import { DomainError } from '../common/domain-error.js';
import type { FastifyRequest } from 'fastify';
import { orders } from '@conference/database';
import { and, eq } from 'drizzle-orm';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '操作参数无效，请刷新后重试',
      HttpStatus.BAD_REQUEST,
      { issues: result.error.issues },
    );
  return result.data;
}
function writeKey(key?: string) {
  if (!key || key.length < 8 || key.length > 160)
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '操作需要有效的请求标识',
      HttpStatus.BAD_REQUEST,
    );
  return key;
}

@Controller('customer/orders')
@UseGuards(CustomerAuthGuard)
export class CustomerBatchOrdersController {
  constructor(
    @Inject(OrderItemsService) private readonly items: OrderItemsService,
    @Inject(BatchOrderManagementService) private readonly management: BatchOrderManagementService,
    @Inject(BatchClaimInvitationService) private readonly invitations: BatchClaimInvitationService,
    @Inject(CustomerAccountService) private readonly customer: CustomerAccountService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Get(':orderId')
  detail(@Param('orderId', ParseUUIDPipe) orderId: string, @Req() request: CustomerRequest) {
    return this.items.detail(orderId, request.customerSession);
  }

  @Post(':orderId/cancel')
  async cancel(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: unknown,
    @Req() request: CustomerRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    const input = parse(CancelCustomerOrderSchema, body);
    await this.items.requireOrder(this.items.db(), orderId, request.customerSession);
    return this.idempotency.execute(
      `customer-order-cancel:${request.customerSession.customerUserId}:${orderId}`,
      writeKey(key),
      input,
      () => this.management.cancel(orderId, input, request.customerSession),
    );
  }

  @Post(':orderId/items/cancel-free')
  async cancelFree(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: unknown,
    @Req() request: CustomerRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    const input = parse(SelectedOrderItemsSchema, body);
    await this.items.requireOrder(this.items.db(), orderId, request.customerSession);
    return this.idempotency.execute(
      `customer-free-cancel:${request.customerSession.customerUserId}:${orderId}`,
      writeKey(key),
      input,
      () => this.management.cancelFree(orderId, input, request.customerSession),
    );
  }

  @Patch(':orderId/items/:itemId/attendee')
  async update(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: unknown,
    @Req() request: CustomerRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    const { expectedVersion } = parse(
      z.object({ expectedVersion: z.number().int().positive() }),
      body,
    );
    const input = parse(UpdatePurchasedOrderAttendeeSchema, body);
    await this.items.requireOrder(this.items.db(), orderId, request.customerSession);
    return this.idempotency.execute(
      `customer-item-edit:${request.customerSession.customerUserId}:${itemId}`,
      writeKey(key),
      { orderId, itemId, expectedVersion, input },
      async () => {
        await this.customer.updatePurchasedOrderAttendee(request.customerSession, orderId, input, {
          id: itemId,
          version: expectedVersion,
        });
        return this.items.detail(orderId, request.customerSession);
      },
    );
  }

  @Post(':orderId/items/:itemId/claim-invitation')
  invitation(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: unknown,
    @Req() request: CustomerRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.invitations.generate(
      orderId,
      itemId,
      parse(GenerateClaimInvitationSchema, body),
      writeKey(key),
      request.customerSession,
    );
  }
}

@Controller('admin/events/:eventId/orders')
@UseGuards(AuthGuard)
@AgentSurface({
  defaultExclusionReason: 'Batch order operations require human review until explicitly catalogued',
})
export class AdminBatchOrdersController {
  constructor(
    @Inject(BatchOrderManagementService) private readonly management: BatchOrderManagementService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(OrderItemsService) private readonly items: OrderItemsService,
  ) {}

  @Get(':orderId/items')
  @RequireGrant('event.order.read')
  async detail(
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
  ) {
    const [order] = await this.items
      .db()
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.eventId, eventId),
          eq(orders.organizationId, request.user.organizationId),
        ),
      )
      .limit(1);
    if (!order)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '订单不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    return this.items.checkout(this.items.db(), order, order.purchaserCustomerUserId ?? '');
  }

  @Post(':orderId/review')
  @RequireGrant('event.registration.manage')
  async review(
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
    @Headers('idempotency-key') key?: string,
  ) {
    const input = parse(ReviewBatchOrderSchema, body);
    const [order] = await this.items
      .db()
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.eventId, eventId),
          eq(orders.organizationId, request.user.organizationId),
        ),
      )
      .limit(1);
    if (!order)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '订单不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    const result = await this.idempotency.execute(
      `batch-order-review:${request.user.organizationId}:${orderId}`,
      writeKey(key),
      input,
      () =>
        this.management.review(
          orderId,
          eventId,
          request.user.organizationId,
          request.user.sub,
          input,
        ),
    );
    // Keep cached and fresh review responses within the registration permission boundary.
    return { orderId: result.order.id, status: result.order.status, version: result.order.version! };
  }
}

@Module({ controllers: [CustomerBatchOrdersController, AdminBatchOrdersController] })
export class BatchOrdersModule {}
