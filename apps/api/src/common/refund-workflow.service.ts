import { invalidateInvoiceFileAccess } from '@conference/database';
import { refundAttentionCondition, refundCurrentExecutionCondition } from '@conference/database';
import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  EventRefundPolicySchema,
  type CustomerRefundApplication,
  type RefundApplicationView,
  type RefundApplicationQuery,
  type RefundContext,
  type ExternalRefundAllocation,
  type AdminItemRefund,
} from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  auditLogs,
  events,
  idempotencyKeys,
  invoiceRequests,
  invoiceStateLogs,
  orders,
  orderItems,
  inventoryReservations,
  refundRequestItems,
  refundItemAllocations,
  orderStateLogs,
  outboxEvents,
  payments,
  refundRequests,
  refundNotificationInbox,
  refunds,
  registrations,
  tickets,
  ticketTypes,
} from '@conference/database';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  allocateApprovedRefund,
  fulfillRefundItems,
  itemRefunded,
  itemRefundReason,
  refundFingerprint,
  refundItemLedger,
  refundRights,
} from './batch-refund-items.js';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { customerCanManageOrder } from './customer-order-ownership.js';
import { idempotencyRequestHash } from './idempotency.service.js';
import {
  channelReason,
  refundDeadline,
  refundPolicy,
  refundQueryDelay,
  refundRecipient,
  REFUND_CHANNEL_WINDOW_MS,
  RefundGatewayError,
  type WeChatRefundOutcome,
} from './refund-policy.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { withPostgresTransactionRetry } from './transaction-retry.js';
import { lockWeChatConfiguration } from './wechat-configuration-lock.js';

type Database = NonNullable<DatabaseService['db']>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Reader = Database | Tx;
type Application = typeof refundRequests.$inferSelect;
type Execution = typeof refunds.$inferSelect;
type Customer = { organizationId: string; customerUserId: string };
type Funding = Awaited<ReturnType<WeChatPayService['refundConfiguration']>>;

function conflict(message: string): never {
  throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION, message, HttpStatus.CONFLICT);
}
function missing(): never {
  throw new DomainError(
    API_ERROR_CODES.NOT_FOUND,
    '订单或退款申请不存在或无权访问',
    HttpStatus.NOT_FOUND,
  );
}
const iso = (date: Date | null) => date?.toISOString() ?? null;

@Injectable()
export class RefundWorkflowService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WeChatPayService) private readonly wechat: WeChatPayService,
  ) {}

  private db(): Database {
    if (!this.database.db) conflict('退款需要数据库持久化服务');
    return this.database.db;
  }

  private async lockOrder(tx: Tx, organizationId: string, orderId: string) {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.organizationId, organizationId)))
      .for('update')
      .limit(1);
    if (!order) missing();
    return order;
  }

  private async state(db: Reader, organizationId: string, orderId: string, lock = false) {
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.organizationId, organizationId)))
      .limit(1);
    if (!order) missing();
    const rights = await refundRights(db, order, lock);
    const registration = rights.registrations.find((row) => row.id === order.registrationId);
    const ticket = rights.tickets.find((row) => row.registrationId === registration?.id);
    const ticketType = rights.ticketTypes.find((row) => row.id === registration?.ticketTypeId);
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, order.eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!event || (order.modelVersion === 1 && !registration)) missing();
    const paid = await db
      .select()
      .from(payments)
      .where(
        and(eq(payments.orderId, orderId), inArray(payments.status, ['succeeded', 'refunded'])),
      );
    const applicationQuery = db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.orderId, orderId))
      .orderBy(desc(refundRequests.createdAt));
    const applications = await (lock ? applicationQuery.for('update') : applicationQuery);
    const executionQuery = db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, orderId))
      .orderBy(desc(refunds.createdAt));
    const executions = await (lock ? executionQuery.for('update') : executionQuery);
    const ledger = await refundItemLedger(db, orderId, lock);
    const payment =
      order.modelVersion === 2
        ? paid.find((row) => row.id === order.settledPaymentId)
        : paid.length === 1
          ? paid[0]
          : undefined;
    const totalRefunded = executions
      .filter((row) => row.status === 'succeeded' && (order.modelVersion !== 2 || row.paymentId === order.settledPaymentId))
      .reduce((total, row) => total + row.amount, 0);
    const reserved = applications
      .filter((row) => !row.terminatedAt)
      .reduce((total, row) => total + row.reservedAmount, 0);
    const currentPolicy = refundPolicy(event.settings);
    const frozenPolicy = EventRefundPolicySchema.safeParse(order.pricingSnapshot.refundPolicy);
    const policy = frozenPolicy.success ? frozenPolicy.data : currentPolicy;
    const historyKnown = frozenPolicy.success || event.slug === 'tokems26';
    const deadline = refundDeadline(payment?.succeededAt ?? null, policy.windowDays);
    const remaining = Math.max(0, (payment?.amount ?? order.amount) - totalRefunded);
    let blockedReason: string | null = null;
    if (!policy.enabled) blockedReason = '本活动尚未开放自助退款，请联系主办方';
    else if (order.refundExecutionMode !== 'automatic')
      blockedReason = '该订单正在由财务核验，请联系主办方';
    else if (
      !payment ||
      payment.provider !== 'wechatpay' ||
      payment.amount !== order.amount ||
      payment.currency !== 'CNY'
    )
      blockedReason = '原支付记录需要人工核验';
    else if (!historyKnown || !deadline) blockedReason = '购票时的退款规则或付款时间需要人工核验';
    else if (!['paid', 'partially_refunded'].includes(order.status) || remaining === 0)
      blockedReason = '订单没有可退金额';
    else if (applications.some((row) => !row.terminatedAt))
      blockedReason = '已有退款申请，请查看处理进度';
    else if (
      order.modelVersion === 1 &&
      (ticket?.status === 'used' || registration?.status === 'checked_in')
    )
      blockedReason = '票券已使用，请联系主办方核验';
    else if (order.modelVersion === 1 && (registration?.supersededAt || ticket?.refundPausedBy))
      blockedReason = '参会资格正在变更，请联系主办方';
    else if (Date.now() > deadline.getTime()) blockedReason = '已超过购票后 7 天自助退款期限';
    if (
      !blockedReason &&
      (order.entitlementsOnHold ||
        !this.externalSafe(executions) ||
        executions.some((row) => row.fulfillmentAttention && row.protectionScope === 'order'))
    )
      blockedReason = '订单资金或权益需要人工核验';
    if (
      !blockedReason &&
      order.modelVersion === 2 &&
      (rights.items.length !== order.quantity ||
        rights.items.reduce((sum, item) => sum + item.allocatedAmount, 0) !== order.amount)
    )
      blockedReason = '订单名额明细需要人工核验';
    const contextItems = [...rights.items]
      .sort((a, b) => a.position - b.position)
      .map((item) => {
        const refundableAmount = Math.max(0, item.allocatedAmount - itemRefunded(ledger, item.id));
        const itemReason =
          blockedReason ??
          itemRefundReason(rights, item) ??
          (refundableAmount <= 0 ? '该名额没有可退金额' : null);
        return {
          id: item.id,
          registrationId: item.registrationId,
          name:
            rights.registrations.find((row) => row.id === item.registrationId)?.attendee.name ?? '',
          ticketName: rights.ticketTypes.find((row) => row.id === item.ticketTypeId)?.name ?? '',
          refundableAmount,
          eligible: itemReason === null,
          blockedReason: itemReason,
          version: item.version,
        };
      });
    if (!blockedReason && order.modelVersion === 2 && !contextItems.some((item) => item.eligible))
      blockedReason = '当前没有可退款名额';
    const contextVersion = refundFingerprint({
      order: [
        order.id,
        order.version,
        order.settledPaymentId,
        order.status,
        order.refundExecutionMode,
        order.entitlementsOnHold,
      ],
      policy,
      deadline,
      payment: payment?.id,
      items: rights.items.map((item) => [item.id, item.version, item.state, item.allocatedAmount]),
      registrations: rights.registrations.map((row) => [
        row.id,
        row.updatedAt,
        row.status,
        row.supersededAt,
      ]),
      tickets: rights.tickets.map((row) => [
        row.id,
        row.status,
        row.refundPausedBy,
        row.ticketTypeId,
      ]),
      allocations: ledger.allocations.map((row) => [row.id, row.amount]),
      applications: applications.map((row) => [row.id, row.version, row.terminatedAt]),
      executions: executions.map((row) => [row.id, row.status, row.amount]),
    });
    return {
      rights,
      ledger,
      contextItems,
      contextVersion,
      order,
      ticket,
      ticketType,
      registration,
      event,
      payment,
      paid,
      applications,
      executions,
      policy,
      deadline,
      remaining,
      totalRefunded,
      reserved,
      blockedReason,
    };
  }

  private requirePurchaser(
    state: Awaited<ReturnType<RefundWorkflowService['state']>>,
    customer: Customer,
  ) {
    if (
      !customerCanManageOrder(
        state.order.purchaserCustomerUserId,
        state.order.purchaseIntentId,
        state.order.modelVersion === 1 ? (state.registration?.customerUserId ?? null) : null,
        customer.customerUserId,
      )
    )
      missing();
  }

  private confirmedRefundTotal(executions: Execution[], field: 'payerRefund' | 'discountRefund') {
    const succeeded = executions.filter((row) => row.status === 'succeeded');
    return succeeded.length && succeeded.every((row) => row[field] !== null)
      ? succeeded.reduce((total, row) => total + row[field]!, 0)
      : null;
  }

  private view(row: Application, executions: Execution[]): RefundApplicationView {
    const related = executions.filter((execution) => execution.requestId === row.id);
    const current = related.find((execution) => execution.currentAttempt) ?? related[0];
    return {
      id: row.id,
      selectedItemIds: (
        (row.businessSnapshot.items as Array<{ id: string }> | undefined) ?? []
      ).map((item) => item.id),
      orderId: row.orderId,
      eventId: row.eventId,
      amount: row.amount,
      completedAmount: row.completedAmount,
      currency: row.currency,
      reviewStatus: row.reviewStatus as RefundApplicationView['reviewStatus'],
      fulfillmentStatus: row.fulfillmentStatus as RefundApplicationView['fulfillmentStatus'],
      executionStatus: current?.status ?? null,
      reason: row.reason,
      reviewReason: row.reviewReason,
      createdAt: row.createdAt.toISOString(),
      reviewedAt: iso(row.reviewedAt),
      completedAt: row.fulfillmentStatus === 'completed' ? iso(row.terminatedAt) : null,
      version: row.version,
      fullRefund: row.businessSnapshot.fullRefund === true,
      payerTotal: related.find((execution) => execution.payerTotal !== null)?.payerTotal ?? null,
      payerRefund: this.confirmedRefundTotal(related, 'payerRefund'),
      discountRefund: this.confirmedRefundTotal(related, 'discountRefund'),
    };
  }

  async eventPolicy(organizationId: string, eventId: number) {
    const [event] = await this.db()
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!event) missing();
    return refundPolicy(event.settings);
  }

  async customerContext(customer: Customer, orderId: string): Promise<RefundContext> {
    const state = await this.state(this.db(), customer.organizationId, orderId);
    this.requirePurchaser(state, customer);
    return {
      orderId,
      quantity: state.order.quantity,
      contextVersion: state.contextVersion,
      items: state.contextItems,
      orderNo: state.order.orderNo,
      eventId: state.event.id,
      eventName: state.event.name,
      ticketName:
        state.ticketType?.name ??
        [...new Set(state.rights.ticketTypes.map((row) => row.name))].join(' / '),
      attendeeName:
        state.order.quantity > 1
          ? `${state.order.quantity} 位参会人`
          : (state.registration?.attendee.name ?? ''),
      paymentMethod: state.payment?.provider === 'wechatpay' ? '微信支付' : '其他支付方式',
      paidAmount:
        state.order.modelVersion === 2
          ? (state.payment?.amount ?? 0)
          : state.paid.reduce((sum, row) => sum + row.amount, 0),
      payerTotal: state.payment
        ? (state.executions.find(
            (row) => row.paymentId === state.payment!.id && row.payerTotal !== null,
          )?.payerTotal ?? null)
        : null,
      refundedAmount: state.totalRefunded,
      refundableAmount: Math.max(0, state.remaining - state.reserved),
      currency: state.order.currency,
      eligible: state.blockedReason === null,
      blockedReason: state.blockedReason,
      policyVersion: state.policy.version,
      deadline: iso(state.deadline),
      applications: state.applications.map((row) => this.view(row, state.executions)),
    };
  }

  async createCustomer(
    customer: Customer,
    orderId: string,
    key: string,
    input: CustomerRefundApplication,
  ) {
    return this.create(customer.organizationId, orderId, key, input, customer.customerUserId);
  }

  private async create(
    organizationId: string,
    orderId: string,
    key: string,
    input: CustomerRefundApplication & { adminAllocations?: AdminItemRefund['allocations'] },
    customerUserId?: string,
    actorId?: string,
    funding?: Funding,
  ) {
    const scopedKey = idempotencyRequestHash({
      organizationId,
      orderId,
      actor: customerUserId ?? actorId,
      key,
      operation: 'refund.create',
    });
    const requestHash = idempotencyRequestHash(input);
    return withPostgresTransactionRetry(() =>
      this.db().transaction(async (tx) => {
        await lockWeChatConfiguration(tx, organizationId);
        await this.lockOrder(tx, organizationId, orderId);
        const state = await this.state(tx, organizationId, orderId, true);
        if (customerUserId) this.requirePurchaser(state, { organizationId, customerUserId });
        const [cached] = await tx
          .select()
          .from(refundRequests)
          .where(eq(refundRequests.idempotencyKey, scopedKey))
          .limit(1);
        if (cached) {
          if (cached.requestHash !== requestHash) conflict('相同幂等键对应了不同退款内容');
          return this.view(cached, state.executions);
        }
        if (customerUserId && state.blockedReason) conflict(state.blockedReason);
        if (customerUserId && !state.policy.enabled) conflict('购票时未开放自助退款，请联系主办方');
        if (state.order.refundExecutionMode !== 'automatic') conflict('财务核验期间暂停提交退款');
        if (state.applications.some((row) => !row.terminatedAt))
          conflict('该订单已有未结束的退款申请');
        if (
          !state.payment ||
          state.payment.provider !== 'wechatpay' ||
          !state.payment.succeededAt ||
          !state.payment.externalId ||
          state.payment.amount !== state.order.amount ||
          state.payment.currency !== 'CNY'
        )
          conflict('原支付记录需要人工核验');
        const batch = state.order.modelVersion === 2;
        if (batch && !customerUserId && !input.adminAllocations?.length)
          conflict('多人订单退款需要明确名额及权益处理方式，请使用逐名额退款申请');
        if (
          batch &&
          (!input.selectedItemIds?.length || input.contextVersion !== state.contextVersion)
        )
          conflict('请选择退款名额并刷新最新退款信息');
        const selected = batch
          ? state.rights.items.filter((item) => input.selectedItemIds!.includes(item.id))
          : [];
        if (
          batch &&
          (selected.length !== input.selectedItemIds!.length ||
            new Set(input.selectedItemIds).size !== selected.length)
        )
          conflict('退款名额不属于此订单或重复');
        if (
          batch &&
          customerUserId && selected.some((item) => !state.contextItems.find((row) => row.id === item.id)?.eligible)
        )
          conflict('所选名额状态已变化，暂不能退款');
        const allocations = input.adminAllocations;
        if (batch && allocations) {
          for (const allocation of allocations) {
            const item = selected.find((row) => row.id === allocation.orderItemId);
            if (!item || allocation.version !== item.version || allocation.amount > item.allocatedAmount - itemRefunded(state.ledger, item.id)) conflict('补偿名额、版本或可退金额已变化');
            const reason = itemRefundReason(state.rights, item);
            if (reason && !(allocation.rightsEffect === 'retain' && reason === '该票券已使用')) conflict(reason);
          }
        }
        const amount = batch
          ? allocations ? allocations.reduce((sum, row) => sum + row.amount, 0) : selected.reduce((sum, item) => sum + item.allocatedAmount - itemRefunded(state.ledger, item.id), 0)
          : input.amount;
        if (amount === undefined || (input.amount !== undefined && input.amount !== amount)) conflict('退款金额与所选名额不一致');
        const currentFunding = await this.wechat.refundConfiguration(organizationId, tx);
        if (
          (state.payment.merchantId && state.payment.merchantId !== currentFunding.merchantId) ||
          (funding &&
            (funding.merchantId !== currentFunding.merchantId ||
              funding.funding !== currentFunding.funding ||
              funding.notifyUrl !== currentFunding.notifyUrl))
        )
          conflict('微信支付配置已变化，请刷新并重新核验原支付商户');
        if (
          !['paid', 'partially_refunded'].includes(state.order.status) ||
          amount > state.remaining ||
          amount <= 0
        )
          conflict('退款金额或订单状态已变化，请刷新后重新确认');
        if (
          customerUserId &&
          ((!batch && amount !== state.remaining) || input.policyVersion !== state.policy.version)
        )
          conflict('退款金额或规则已变化，请刷新后重新确认');
        const fullRefund = amount === state.remaining;
        if (
          !batch &&
          fullRefund &&
          (state.ticket?.status === 'used' || state.registration?.status === 'checked_in')
        )
          conflict('票券已使用，无法批准全额退款');
        if (!batch && state.registration?.supersededAt) conflict('报名已变更，需要人工核验');
        const now = new Date();
        const [application] = await tx
          .insert(refundRequests)
          .values({
            organizationId,
            eventId: state.event.id,
            orderId,
            paymentId: state.payment.id,
            source: customerUserId ? 'customer' : 'admin',
            customerUserId,
            requestedBy: actorId,
            amount,
            reservedAmount: amount,
            currency: state.order.currency,
            reason: input.reason,
            policySnapshot: {
              ...state.policy,
              paidAt: state.payment.succeededAt.toISOString(),
              deadline: iso(state.deadline),
            },
            businessSnapshot: {
              fullRefund,
              ...(batch
                ? {
                    modelVersion: 2,
                    contextVersion: state.contextVersion,
                    items: selected.map((item) => ({
                      id: item.id,
                      version: item.version,
                      registrationId: item.registrationId,
                      ticketTypeId: item.ticketTypeId,
                      ticketId: state.rights.tickets.find(
                        (row) => row.registrationId === item.registrationId,
                      )?.id,
                    })),
                  }
                : {}),
              ticketId: state.ticket?.id ?? null,
              registrationId: state.registration?.id ?? null,
              ticketTypeId: state.ticket?.ticketTypeId ?? state.registration?.ticketTypeId,
              inventoryOwned:
                state.ticket?.status === 'valid' && state.registration?.status !== 'cancelled',
            },
            idempotencyKey: scopedKey,
            requestHash,
            ...(actorId
              ? {
                  reviewStatus: 'approved',
                  fulfillmentStatus: 'open',
                  reviewedBy: actorId,
                  reviewedAt: now,
                }
              : {}),
          })
          .returning();
        if (!application) throw new Error('Refund application was not persisted');
        if (batch)
          await tx.insert(refundRequestItems).values(
            selected.map((item) => ({
              refundRequestId: application.id,
              paymentId: state.payment!.id,
              orderId,
              orderItemId: item.id,
              organizationId,
              eventId: state.event.id,
              requestedAmount: allocations?.find((row) => row.orderItemId === item.id)?.amount ?? item.allocatedAmount - itemRefunded(state.ledger, item.id),
              rightsEffect: allocations?.find((row) => row.orderItemId === item.id)?.rightsEffect ?? 'revoke' as const,
              version: item.version,
            })),
          );
        if (actorId && funding)
          await this.approveExecution(tx, application, batch ? await this.state(tx, organizationId, orderId, true) : state, actorId, currentFunding);
        await this.audit(tx, application, actorId ?? null, 'refund.request', {
          source: application.source,
          customerUserId,
          amount,
        });
        const executions = actorId
          ? await tx.select().from(refunds).where(eq(refunds.requestId, application.id))
          : [];
        return this.view(application, executions);
      }),
    );
  }

  async adminItemContext(organizationId: string, eventId: number, orderId: string) {
    const state = await this.state(this.db(), organizationId, orderId);
    if (state.event.id !== eventId || state.order.modelVersion !== 2) missing();
    return { orderId, quantity: state.order.quantity, contextVersion: state.contextVersion, currency: state.order.currency, remaining: state.remaining, items: state.contextItems.map((row) => {
      const item = state.rights.items.find((item) => item.id === row.id)!;
      const reason = itemRefundReason(state.rights, item);
      const moneyAvailable = row.refundableAmount > 0 && !state.order.entitlementsOnHold && state.order.refundExecutionMode === 'automatic' && !state.applications.some((application) => !application.terminatedAt);
      return { ...row, version: item.version, canRetain: moneyAvailable && (!reason || reason === '该票券已使用'), canRevoke: moneyAvailable && !reason };
    }) };
  }

  async createAdminItems(organizationId: string, eventId: number, orderId: string, actorId: string, key: string, input: AdminItemRefund) {
    const state = await this.state(this.db(), organizationId, orderId);
    if (state.event.id !== eventId || state.order.modelVersion !== 2 || !state.payment) missing();
    await this.wechat.verifyRefundPayment(organizationId, state.payment.id);
    const funding = await this.wechat.refundConfiguration(organizationId);
    return this.create(organizationId, orderId, key, { reason: input.reason, policyVersion: state.policy.version, contextVersion: input.contextVersion, selectedItemIds: input.allocations.map((row) => row.orderItemId), adminAllocations: input.allocations }, undefined, actorId, funding);
  }

  async createAdmin(
    organizationId: string,
    orderId: string,
    actorId: string,
    key: string,
    input: { amount: number; reason: string },
  ) {
    const state = await this.state(this.db(), organizationId, orderId);
    if (!state.payment) conflict('原支付记录需要人工核验');
    await this.wechat.verifyRefundPayment(organizationId, state.payment.id);
    const funding = await this.wechat.refundConfiguration(organizationId);
    const view = await this.create(
      organizationId,
      orderId,
      key,
      { ...input, policyVersion: state.policy.version },
      undefined,
      actorId,
      funding,
    );
    const [execution] = await this.db()
      .select()
      .from(refunds)
      .where(eq(refunds.requestId, view.id))
      .orderBy(desc(refunds.createdAt))
      .limit(1);
    if (!execution) conflict('退款执行记录尚未创建');
    return {
      id: execution.id,
      refundNo: execution.refundNo,
      orderId,
      amount: execution.amount,
      currency: execution.currency,
      status: execution.status,
      reason: execution.reason,
      createdAt: execution.createdAt.toISOString(),
    };
  }

  private async application(organizationId: string, requestId: string, eventId?: number) {
    const [row] = await this.db()
      .select()
      .from(refundRequests)
      .where(
        and(
          eq(refundRequests.id, requestId),
          eq(refundRequests.organizationId, organizationId),
          eventId === undefined ? undefined : eq(refundRequests.eventId, eventId),
        ),
      )
      .limit(1);
    if (!row) missing();
    return row;
  }

  private async once<T extends Record<string, unknown>>(
    tx: Tx,
    scope: string,
    key: string,
    body: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    const requestHash = idempotencyRequestHash(body);
    const [cached] = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (cached) {
      if (cached.requestHash !== requestHash) conflict('相同幂等键对应不同操作');
      return cached.responseBody as T;
    }
    const result = await operation();
    await tx.insert(idempotencyKeys).values({
      scope,
      key,
      requestHash,
      responseCode: 200,
      responseBody: result,
      expiresAt: new Date(Date.now() + 366 * 86_400_000),
    });
    return result;
  }

  async review(
    organizationId: string,
    eventId: number,
    requestId: string,
    actorId: string,
    key: string,
    input: { version: number; reason?: string },
    action: 'approve' | 'reject',
  ) {
    const initial = await this.application(organizationId, requestId, eventId);
    let funding: Funding | undefined;
    if (action === 'approve') {
      await this.wechat.verifyRefundPayment(organizationId, initial.paymentId);
      funding = await this.wechat.refundConfiguration(organizationId);
    }
    return withPostgresTransactionRetry(() =>
      this.db().transaction(async (tx) => {
        await lockWeChatConfiguration(tx, organizationId);
        await this.lockOrder(tx, organizationId, initial.orderId);
        return this.once(tx, `refund:${requestId}:${actorId}:${action}`, key, input, async () => {
          const state = await this.state(tx, organizationId, initial.orderId, true);
          const application = state.applications.find((row) => row.id === requestId)!;
          if (
            application.version !== input.version ||
            application.reviewStatus !== 'pending_review'
          )
            conflict('退款申请已更新，请刷新后确认');
          if (action === 'approve') {
            const currentFunding = await this.wechat.refundConfiguration(organizationId, tx);
            if (
              funding!.merchantId !== currentFunding.merchantId ||
              funding!.funding !== currentFunding.funding ||
              funding!.notifyUrl !== currentFunding.notifyUrl
            )
              conflict('微信支付配置已变化，请刷新后重新确认退款');
            await this.approveExecution(tx, application, state, actorId, currentFunding);
          }
          const now = new Date();
          const [updated] = await tx
            .update(refundRequests)
            .set({
              reviewStatus: action === 'approve' ? 'approved' : 'rejected',
              reviewedBy: actorId,
              reviewedAt: now,
              reviewReason: input.reason ?? null,
              fulfillmentStatus: action === 'approve' ? 'open' : null,
              reservedAmount: action === 'approve' ? application.reservedAmount : 0,
              terminatedAt: action === 'reject' ? now : null,
              version: application.version + 1,
              updatedAt: now,
            })
            .where(eq(refundRequests.id, requestId))
            .returning();
          await this.audit(tx, application, actorId, `refund.${action}`, {
            amount: application.amount,
            reason: input.reason,
          });
          await this.event(tx, application, 'RefundReviewed', {
            approved: action === 'approve',
            reason: input.reason ?? '',
          });
          const executions = await tx
            .select()
            .from(refunds)
            .where(eq(refunds.orderId, initial.orderId));
          return this.view(updated!, executions);
        });
      }),
    );
  }

  private async approveExecution(
    tx: Tx,
    application: Application,
    state: Awaited<ReturnType<RefundWorkflowService['state']>>,
    actorId: string,
    funding: Funding,
  ) {
    if (state.order.refundExecutionMode !== 'automatic') conflict('外部处理期间暂停退款审批');
    if (
      !state.payment ||
      state.payment.id !== application.paymentId ||
      state.payment.merchantId !== funding.merchantId ||
      !state.payment.succeededAt ||
      Date.now() - state.payment.succeededAt.getTime() >= REFUND_CHANNEL_WINDOW_MS
    )
      conflict('原支付商户、时间或流水需要核验');
    if (application.amount > state.remaining || state.reserved > state.remaining)
      conflict('可退金额与申请不符，需要核验外部退款');
    if (state.order.modelVersion === 2) {
      if (
        (application.source === 'customer' && (
          !state.deadline || !state.policy.enabled ||
          application.policySnapshot.paidAt !== state.payment.succeededAt.toISOString() ||
          application.createdAt > state.deadline
        )) ||
        state.order.entitlementsOnHold ||
        !this.externalSafe(state.executions)
      )
        conflict('退款期限或资金状态已变化，请人工核验');
      const targets = state.ledger.requestItems.filter(
        (row) => row.refundRequestId === application.id,
      );
      if (
        !targets.length ||
        targets.reduce((sum, row) => sum + row.requestedAmount, 0) !== application.amount
      )
        conflict('退款申请名额需要核验');
      for (const target of targets) {
        const item = state.rights.items.find((row) => row.id === target.orderItemId);
        if (
          !item ||
          target.version !== item.version ||
          target.paymentId !== state.payment.id ||
          (application.source === 'customer' ? target.requestedAmount !== item.allocatedAmount - itemRefunded(state.ledger, item.id) : target.requestedAmount > item.allocatedAmount - itemRefunded(state.ledger, item.id))
        )
          conflict('退款名额或金额已更新，请重新申请');
        const reason = itemRefundReason(state.rights, item, application.id);
        if (reason && !(application.source === 'admin' && target.rightsEffect === 'retain' && reason === '该票券已使用')) conflict(reason);
        const snapshot = (
          application.businessSnapshot.items as
            Array<{ id: string; ticketId: string; ticketTypeId: string }> | undefined
        )?.find((row) => row.id === item.id);
        const ticket = state.rights.tickets.find(
          (row) => row.registrationId === item.registrationId,
        )!;
        if (
          !snapshot ||
          snapshot.ticketId !== ticket.id ||
          snapshot.ticketTypeId !== item.ticketTypeId
        )
          conflict('退款票券历史已变化，请重新核验');
        await tx
          .update(refundRequestItems)
          .set({ approvedAmount: target.requestedAmount, updatedAt: new Date() })
          .where(eq(refundRequestItems.id, target.id));
        if (target.rightsEffect === 'revoke')
          await tx
            .update(tickets)
            .set({ refundPausedBy: application.id, updatedAt: new Date() })
            .where(eq(tickets.id, ticket.id));
      }
    } else {
      if (state.registration?.supersededAt) conflict('报名已变更，需要人工核验');
      const fullRefund = application.businessSnapshot.fullRefund === true;
      if (
        fullRefund &&
        (state.ticket?.status === 'used' || state.registration?.status === 'checked_in')
      )
        conflict('参会人已签到或电子票已使用，无法批准全额退款');
      if (state.ticket?.refundPausedBy && state.ticket.refundPausedBy !== application.id)
        conflict('票券已有其他退款暂停');
      if (fullRefund && state.ticket)
        await tx
          .update(tickets)
          .set({ refundPausedBy: application.id, updatedAt: new Date() })
          .where(eq(tickets.id, state.ticket.id));
    }
    await this.insertExecution(tx, application, state.payment, actorId, funding);
  }

  private async insertExecution(
    tx: Tx,
    application: Application,
    payment: typeof payments.$inferSelect,
    actorId: string,
    funding: Funding,
  ) {
    const refundNo = `RF${randomUUID().replaceAll('-', '')}`;
    const requestSnapshot = {
      transaction_id: payment.externalId,
      out_refund_no: refundNo,
      reason: channelReason(application.reason),
      notify_url: funding.notifyUrl,
      amount: { refund: application.reservedAmount, total: payment.amount, currency: 'CNY' },
      ...(funding.funding === 'available' ? { funds_account: 'AVAILABLE' } : {}),
    };
    await tx.insert(refunds).values({
      organizationId: application.organizationId,
      eventId: application.eventId,
      orderId: application.orderId,
      paymentId: payment.id,
      requestId: application.id,
      source: 'wechat_api',
      protectionScope: application.businessSnapshot.modelVersion === 2 ? 'items' : 'order',
      refundNo,
      outRefundNo: refundNo,
      merchantId: funding.merchantId,
      amount: application.reservedAmount,
      currency: 'CNY',
      status: 'queued',
      currentAttempt: true,
      requestSnapshot,
      reason: channelReason(application.reason),
      idempotencyKey: refundNo,
      nextAttemptAt: new Date(),
      createdBy: actorId,
    });
  }

  async withdraw(customer: Customer, requestId: string, key: string, version: number) {
    const initial = await this.application(customer.organizationId, requestId);
    return this.db().transaction(async (tx) => {
      await this.lockOrder(tx, customer.organizationId, initial.orderId);
      const state = await this.state(tx, customer.organizationId, initial.orderId);
      this.requirePurchaser(state, customer);
      return this.once(
        tx,
        `refund:${requestId}:${customer.customerUserId}:withdraw`,
        key,
        { version },
        async () => {
          const application = state.applications.find((row) => row.id === requestId)!;
          if (application.reviewStatus !== 'pending_review' || application.version !== version)
            conflict('该申请已审核或更新，无法撤回');
          const [updated] = await tx
            .update(refundRequests)
            .set({
              reviewStatus: 'withdrawn',
              reservedAmount: 0,
              terminatedAt: new Date(),
              version: application.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(refundRequests.id, requestId))
            .returning();
          await this.audit(tx, application, null, 'refund.withdraw', {
            customerUserId: customer.customerUserId,
          });
          return this.view(updated!, state.executions);
        },
      );
    });
  }

  async adminExceptions(organizationId: string, eventId: number) {
    return this.db()
      .select({
        orderId: orders.id,
        registrationId: orders.registrationId,
        orderNo: orders.orderNo,
        reason: orders.refundExecutionReason,
      })
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, organizationId),
          eq(orders.eventId, eventId),
          eq(orders.refundExecutionMode, 'external_hold'),
        ),
      )
      .orderBy(desc(orders.updatedAt))
      .limit(100);
  }

  async unmatchedNotifications(organizationId: string) {
    return this.db()
      .select({
        id: refundNotificationInbox.id,
        outRefundNo: refundNotificationInbox.outRefundNo,
        lastError: refundNotificationInbox.lastError,
        createdAt: refundNotificationInbox.createdAt,
      })
      .from(refundNotificationInbox)
      .where(
        and(
          eq(refundNotificationInbox.organizationId, organizationId),
          eq(refundNotificationInbox.status, 'quarantined'),
        ),
      )
      .orderBy(desc(refundNotificationInbox.createdAt))
      .limit(100);
  }

  async adminList(organizationId: string, eventId: number, query: RefundApplicationQuery) {
    const conditions = [
      eq(refundRequests.organizationId, organizationId),
      eq(refundRequests.eventId, eventId),
    ];
    if (query.orderId) conditions.push(eq(refundRequests.orderId, query.orderId));
    if (query.status === 'pending_review')
      conditions.push(eq(refundRequests.reviewStatus, 'pending_review'));
    if (query.status === 'completed')
      conditions.push(eq(refundRequests.fulfillmentStatus, 'completed'));
    if (query.status === 'attention') conditions.push(refundAttentionCondition());
    if (query.status === 'waiting_funds' || query.status === 'processing')
      conditions.push(refundCurrentExecutionCondition(query.status));
    const rows = await this.db()
      .select({
        request: refundRequests,
        orderNo: orders.orderNo,
        executionMode: orders.refundExecutionMode,
      })
      .from(refundRequests)
      .innerJoin(orders, eq(orders.id, refundRequests.orderId))
      .where(and(...conditions))
      .orderBy(desc(refundRequests.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    return Promise.all(
      rows.map(async (row) => {
        const executions = await this.db()
          .select()
          .from(refunds)
          .where(eq(refunds.requestId, row.request.id))
          .orderBy(desc(refunds.createdAt));
        return {
          ...this.view(row.request, executions),
          orderNo: row.orderNo,
          executionMode: row.executionMode,
          attentionReason: row.request.attentionReason,
          executions: executions.map((execution) => ({
            id: execution.id,
            refundNo: execution.outRefundNo ?? execution.refundNo,
            status: execution.status,
            channelStatus: execution.channelStatus,
            amount: execution.amount,
            recipientKind: execution.recipientKind,
            lastError: execution.lastError,
            nextAttemptAt: iso(execution.nextAttemptAt),
            acceptedAt: iso(execution.acceptedAt),
            fulfillmentAttention: execution.fulfillmentAttention,
            currentAttempt: execution.currentAttempt,
          })),
        };
      }),
    );
  }

  private async audit(
    tx: Tx,
    application: Application,
    actorId: string | null,
    action: string,
    after: Record<string, unknown>,
  ) {
    await tx.insert(auditLogs).values({
      organizationId: application.organizationId,
      eventId: application.eventId,
      actorId,
      action,
      resourceType: 'refund_request',
      resourceId: application.id,
      after,
      traceId: randomUUID(),
    });
  }

  private async event(
    tx: Tx,
    application: Application,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    await tx.insert(outboxEvents).values({
      organizationId: application.organizationId,
      eventId: application.eventId,
      eventType,
      correlationId: `refund:${application.id}`,
      payload: {
        requestId: application.id,
        orderId: application.orderId,
        recipientRole: 'purchaser',
        ...payload,
      },
    });
  }

  async schedule(
    organizationId: string,
    eventId: number,
    requestId: string,
    actorId: string,
    key: string,
    version: number,
    action: 'retry' | 'reconcile' | 'continue',
  ) {
    const application = await this.application(organizationId, requestId, eventId);
    const [cached] = await this.db()
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, `refund:${requestId}:${actorId}:${action}`),
          eq(idempotencyKeys.key, key),
        ),
      )
      .limit(1);
    if (cached) {
      if (cached.requestHash !== idempotencyRequestHash({ version }))
        conflict('相同幂等键对应不同操作');
      return cached.responseBody;
    }
    const [execution] = await this.db()
      .select()
      .from(refunds)
      .where(and(eq(refunds.requestId, requestId), eq(refunds.currentAttempt, true)))
      .limit(1);
    if (!execution?.merchantId || !execution.outRefundNo) conflict('暂无可查询的退款执行单');
    if (action === 'reconcile' && execution.status === 'succeeded')
      return this.repairFulfillment(organizationId, execution.id);
    let unusedExecutionConfirmed = false;
    if (action === 'continue') {
      try {
        const outcome = await this.wechat.queryRefund(
          organizationId,
          execution.merchantId,
          execution.outRefundNo,
        );
        await this.observe(organizationId, execution.merchantId, outcome);
        if (outcome.status !== 'CLOSED') conflict('原退款尚未明确关闭，不能新建退款单');
      } catch (error) {
        if (
          !(error instanceof RefundGatewayError) ||
          error.code !== 'RESOURCE_NOT_EXISTS' ||
          !error.verifiedResponse ||
          execution.amount === application.reservedAmount ||
          !['superseded', 'queued', 'waiting_funds', 'failed'].includes(execution.status)
        )
          throw error;
        unusedExecutionConfirmed = true;
      }
    }
    return this.db().transaction(async (tx) => {
      await lockWeChatConfiguration(tx, organizationId);
      const funding =
        action === 'continue'
          ? await this.wechat.refundConfiguration(organizationId, tx)
          : undefined;
      await this.lockOrder(tx, organizationId, application.orderId);
      return this.once(
        tx,
        `refund:${requestId}:${actorId}:${action}`,
        key,
        { version },
        async () => {
          const state = await this.state(tx, organizationId, application.orderId, true);
          const latest = state.applications.find((row) => row.id === requestId)!;
          const current = state.executions.find(
            (row) => row.currentAttempt && row.requestId === requestId,
          )!;
          const otherExecutionsSafe = this.externalSafe(
            unusedExecutionConfirmed
              ? state.executions.filter((row) => row.id !== execution.id)
              : state.executions,
          );
          if (
            latest.version !== version ||
            latest.reviewStatus !== 'approved' ||
            latest.terminatedAt
          )
            conflict('申请状态已变化，请刷新后确认');
          if (current.leaseUntil && current.leaseUntil > new Date())
            conflict('退款正在核验，请稍后刷新');
          if (
            action !== 'reconcile' &&
            state.order.refundExecutionMode !== 'automatic' &&
            !(action === 'continue' && unusedExecutionConfirmed && otherExecutionsSafe)
          )
            conflict('外部处理期间仅支持查询');
          if (action === 'continue') {
            if (
              (current.status !== 'closed' &&
                !(
                  unusedExecutionConfirmed &&
                  current.id === execution.id &&
                  ['superseded', 'queued', 'waiting_funds', 'failed'].includes(current.status)
                )) ||
              latest.reservedAmount <= 0 ||
              latest.reservedAmount > state.remaining ||
              !state.payment ||
              state.payment.id !== latest.paymentId ||
              state.payment.merchantId !== funding?.merchantId ||
              !otherExecutionsSafe
            )
              conflict('原单状态或可退余额需要核验');
            await tx
              .update(refunds)
              .set({
                currentAttempt: false,
                nextAttemptAt: null,
                ...(unusedExecutionConfirmed ? { status: 'superseded' } : {}),
              })
              .where(eq(refunds.id, current.id));
            if (unusedExecutionConfirmed)
              await tx
                .update(orders)
                .set({
                  refundExecutionMode: 'automatic',
                  refundExecutionReason: '已核验原执行未受理，管理员确认继续剩余退款',
                  updatedAt: new Date(),
                })
                .where(eq(orders.id, application.orderId));
            await this.insertExecution(tx, latest, state.payment, actorId, funding!);
            await tx
              .update(refundRequests)
              .set({ fulfillmentStatus: 'open', attentionReason: null })
              .where(eq(refundRequests.id, latest.id));
          } else {
            if (
              action === 'retry' &&
              !['waiting_funds', 'failed', 'queued', 'query_pending'].includes(current.status)
            )
              conflict('当前状态只允许查询退款结果');
            const earliest = current.lastSubmittedAt
              ? current.lastSubmittedAt.getTime() + 60_000
              : Date.now();
            await tx
              .update(refunds)
              .set({
                status:
                  action === 'reconcile' || current.status === 'failed'
                    ? 'query_pending'
                    : current.status,
                nextAttemptAt: new Date(Math.max(Date.now(), earliest)),
                updatedAt: new Date(),
              })
              .where(eq(refunds.id, current.id));
          }
          await tx
            .update(refundRequests)
            .set({ version: latest.version + 1, updatedAt: new Date() })
            .where(eq(refundRequests.id, requestId));
          await this.audit(tx, latest, actorId, `refund.${action}`, { executionId: current.id });
          return { scheduled: true };
        },
      );
    });
  }

  private externalSafe(executions: Execution[]) {
    return !executions.some(
      (row) =>
        (row.leaseUntil && row.leaseUntil > new Date()) ||
        ['processing', 'submitting', 'query_pending', 'abnormal'].includes(row.status) ||
        (row.lastSubmittedAt &&
          !['succeeded', 'closed'].includes(row.status) &&
          ![
            'NOT_ENOUGH',
            'RESOURCE_NOT_EXISTS',
            'NO_AUTH',
            'SIGN_ERROR',
            'PARAM_ERROR',
            'INVALID_REQUEST',
            'USER_ACCOUNT_ABNORMAL',
          ].includes(row.lastErrorCode ?? '')),
    );
  }

  private batchPaymentRightsSafe(state: Awaited<ReturnType<RefundWorkflowService['state']>>) {
    if (state.order.modelVersion !== 2) return true;
    if (!state.order.settledPaymentId || !state.payment || state.payment.amount !== state.order.amount || state.rights.items.length !== state.order.quantity || state.rights.items.some((item) => !state.rights.tickets.some((ticket) => ticket.registrationId === item.registrationId))) return false;
    return state.paid.filter((payment) => payment.id !== state.order.settledPaymentId).every((payment) => state.executions.filter((execution) => execution.paymentId === payment.id && execution.status === 'succeeded').reduce((sum, execution) => sum + execution.amount, 0) === payment.amount);
  }

  async executionMode(
    organizationId: string,
    orderId: string,
    actorId: string,
    key: string,
    input: { mode: 'automatic' | 'external_hold'; reason: string },
  ) {
    return this.db().transaction(async (tx) => {
      await this.lockOrder(tx, organizationId, orderId);
      return this.once(tx, `refund:mode:${orderId}:${actorId}`, key, input, async () => {
        const state = await this.state(tx, organizationId, orderId);
        if (input.mode === 'automatic') {
          const [activePayment] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.orderId, orderId), inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]))).limit(1);
          if (!this.batchPaymentRightsSafe(state) || (state.order.modelVersion === 2 && activePayment)) conflict('仍有未结清的付款或出票异常，不能恢复自动退款或解除名额保护');
          if (
            state.order.modelVersion === 2 &&
            state.executions.some(
              (row) =>
                row.status === 'succeeded' && row.paymentId === state.order.settledPaymentId &&
                state.ledger.allocations
                  .filter((allocation) => allocation.refundId === row.id)
                  .reduce((sum, allocation) => sum + allocation.amount, 0) !== row.amount,
            )
          )
            conflict('存在尚未归属名额的退款资金，请先完成财务核验');
          if (
            !this.externalSafe(state.executions) ||
            state.reserved > state.remaining ||
            state.executions.some(
              (row) =>
                row.channelStatus === 'SUCCESS' &&
                row.recipientKind !== 'payer' &&
                row.source !== 'legacy',
            )
          )
            conflict('存在未核实的外部退款或资金差异，不能恢复自动处理');
          const active = state.executions.find(
            (row) =>
              row.currentAttempt &&
              ['queued', 'waiting_funds', 'failed', 'superseded'].includes(row.status),
          );
          const activeApplication = state.applications.find((row) => row.id === active?.requestId);
          if (
            active &&
            (active.amount > state.remaining || active.amount !== activeApplication?.reservedAmount)
          )
            conflict('原执行金额已与剩余申请金额不符，请核验后确认继续退款');
        }
        await tx
          .update(orders)
          .set({
            refundExecutionMode: input.mode,
            ...(input.mode === 'automatic' ? { entitlementsOnHold: false } : {}),
            refundExecutionReason: input.reason,
            refundExecutionUpdatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, orderId));
        await tx.insert(auditLogs).values({
          organizationId,
          eventId: state.event.id,
          actorId,
          action: 'refund.execution_mode',
          resourceType: 'order',
          resourceId: orderId,
          after: input,
          traceId: key,
        });
        return {
          mode: input.mode,
          externalReady: input.mode === 'external_hold' && this.externalSafe(state.executions),
        };
      });
    });
  }

  async verifyExternal(
    organizationId: string,
    orderId: string,
    actorId: string,
    key: string,
    outRefundNo: string,
    allocations?: ExternalRefundAllocation[],
  ) {
    const state = await this.state(this.db(), organizationId, orderId);
    if (state.order.refundExecutionMode !== 'external_hold')
      conflict('请先暂停自动提交，再核验外部退款');
    if (!state.payment) conflict('原支付记录需要人工核验');
    const provenance = await this.wechat.verifyRefundPayment(organizationId, state.payment.id);
    const outcome = await this.wechat.queryRefund(
      organizationId,
      provenance.merchantId,
      outRefundNo,
    );
    if (
      outcome.transaction_id !== state.payment.externalId ||
      outcome.amount.total !== state.payment.amount
    )
      conflict('该退款不属于此订单');
    await this.db().transaction(async (tx) => {
      await lockWeChatConfiguration(tx, organizationId);
      if ((await this.wechat.refundMerchantId(organizationId, tx)) !== provenance.merchantId)
        conflict('原支付商户配置已变化，请重新核验');
      await this.lockOrder(tx, organizationId, orderId);
      await this.once(
        tx,
        `refund:external:${orderId}:${actorId}`,
        key,
        { outRefundNo, allocations },
        async () => {
          const latest = await this.state(tx, organizationId, orderId);
          if (latest.order.refundExecutionMode !== 'external_hold') conflict('订单处理方式已变化');
          const [existing] = await tx
            .select()
            .from(refunds)
            .where(
              and(
                eq(refunds.merchantId, provenance.merchantId),
                eq(refunds.outRefundNo, outRefundNo),
              ),
            )
            .limit(1);
          if (existing && existing.orderId !== orderId) conflict('该退款已关联其他订单');
          if (!existing) {
            const approved = latest.applications.find(
              (row) =>
                row.reviewStatus === 'approved' &&
                !row.terminatedAt &&
                row.paymentId === state.payment!.id,
            );
            await tx.insert(refunds).values({
              organizationId,
              eventId: state.event.id,
              orderId,
              paymentId: state.payment!.id,
              requestId: latest.order.modelVersion === 2 ? null : approved?.id,
              source: 'external',
              refundNo: `RF${randomUUID().replaceAll('-', '')}`,
              outRefundNo,
              merchantId: provenance.merchantId,
              amount: outcome.amount.refund,
              currency: 'CNY',
              status: 'query_pending',
              reason: '核验外部退款',
              createdBy: actorId,
              idempotencyKey: idempotencyRequestHash({
                merchantId: provenance.merchantId,
                outRefundNo,
              }),
              nextAttemptAt: new Date(),
            });
          }
          await tx.insert(auditLogs).values({
            organizationId,
            eventId: state.event.id,
            actorId,
            action: 'refund.external_verified',
            resourceType: 'order',
            resourceId: orderId,
            after: { outRefundNo, amount: outcome.amount.refund },
            traceId: key,
          });
          return { imported: true };
        },
      );
    });
    const result = await this.observe(organizationId, provenance.merchantId, outcome);
    if (allocations)
      return this.assignExternalItems(
        organizationId,
        orderId,
        actorId,
        key,
        outRefundNo,
        allocations,
      );
    return result;
  }

  /** Attribute an already verified external cash fact; this path never submits a channel refund. */
  private async assignExternalItems(
    organizationId: string,
    orderId: string,
    actorId: string,
    key: string,
    outRefundNo: string,
    allocations: ExternalRefundAllocation[],
  ) {
    return this.db().transaction(async (tx) => {
      await this.lockOrder(tx, organizationId, orderId);
      return this.once(
        tx,
        `refund:allocation:${orderId}:${actorId}`,
        key,
        { outRefundNo, allocations },
        async () => {
          const state = await this.state(tx, organizationId, orderId, true);
          const execution = state.executions.find((row) => row.outRefundNo === outRefundNo);
          if (
            state.order.modelVersion !== 2 ||
            state.order.refundExecutionMode !== 'external_hold' ||
            !execution ||
            execution.source !== 'external' ||
            execution.status !== 'succeeded' ||
            execution.paymentId !== state.order.settledPaymentId ||
            execution.currency !== state.order.currency
          )
            conflict('请先核验该订单的外部退款成功记录');
          if (
            !allocations.length ||
            allocations.length > 20 ||
            new Set(allocations.map((row) => row.orderItemId)).size !== allocations.length ||
            allocations.some(
              (row) =>
                !Number.isSafeInteger(row.amount) ||
                row.amount <= 0 ||
                !['retain', 'revoke'].includes(row.rightsEffect),
            ) ||
            allocations.reduce((sum, row) => sum + row.amount, 0) !== execution.amount
          )
            conflict('请逐名额完整分配该笔已确认退款金额');
          if (state.ledger.allocations.some((row) => row.refundId === execution.id))
            conflict('该退款已归属名额，请刷新查看');
          for (const allocation of allocations) {
            const item = state.rights.items.find((row) => row.id === allocation.orderItemId);
            if (
              !item ||
              allocation.amount > item.allocatedAmount - itemRefunded(state.ledger, item.id)
            )
              conflict('退款归属名额或剩余金额不符');
          }
          let application = state.applications.find(
            (row) =>
              row.reviewStatus === 'approved' &&
              !row.terminatedAt &&
              row.paymentId === execution.paymentId,
          );
          const now = new Date();
          if (application) {
            for (const allocation of allocations) {
              const target = state.ledger.requestItems.find(
                (row) =>
                  row.refundRequestId === application!.id &&
                  row.orderItemId === allocation.orderItemId,
              );
              const completed = state.ledger.allocations
                .filter((row) => row.refundRequestItemId === target?.id)
                .reduce((sum, row) => sum + row.amount, 0);
              if (
                !target ||
                target.rightsEffect !== allocation.rightsEffect ||
                target.approvedAmount === null ||
                allocation.amount > target.approvedAmount - completed
              )
                conflict('外部退款与当前已批准名额不符，请先核验原申请');
            }
          } else {
            [application] = await tx
              .insert(refundRequests)
              .values({
                organizationId,
                eventId: state.order.eventId,
                orderId,
                paymentId: execution.paymentId!,
                source: 'admin',
                requestedBy: actorId,
                reviewedBy: actorId,
                amount: execution.amount,
                reservedAmount: 0,
                completedAmount: execution.amount,
                currency: execution.currency,
                reviewStatus: 'approved',
                fulfillmentStatus: 'completed',
                reason: '已核验外部退款名额归属',
                policySnapshot: state.policy,
                businessSnapshot: { modelVersion: 2, externalAllocation: true, fullRefund: false },
                idempotencyKey: refundFingerprint({
                  executionId: execution.id,
                  operation: 'external_allocation',
                }),
                requestHash: idempotencyRequestHash(allocations),
                reviewedAt: now,
                terminatedAt: now,
              })
              .returning();
            await tx.insert(refundRequestItems).values(
              allocations.map((allocation) => ({
                refundRequestId: application!.id,
                paymentId: execution.paymentId!,
                orderId,
                orderItemId: allocation.orderItemId,
                organizationId,
                eventId: state.order.eventId,
                requestedAmount: allocation.amount,
                approvedAmount: allocation.amount,
                rightsEffect: allocation.rightsEffect,
                version: state.rights.items.find((item) => item.id === allocation.orderItemId)!
                  .version,
              })),
            );
          }
          await tx
            .update(refunds)
            .set({ requestId: application!.id, protectionScope: 'items', updatedAt: now })
            .where(eq(refunds.id, execution.id));
          const targets = await tx
            .select()
            .from(refundRequestItems)
            .where(eq(refundRequestItems.refundRequestId, application!.id));
          for (const allocation of allocations) {
            const target = targets.find((row) => row.orderItemId === allocation.orderItemId)!;
            await tx.insert(refundItemAllocations).values({
              refundId: execution.id,
              paymentId: execution.paymentId!,
              orderId,
              orderItemId: allocation.orderItemId,
              refundRequestItemId: target.id,
              organizationId,
              eventId: state.order.eventId,
              amount: allocation.amount,
              basis: 'admin_verified_external_allocation',
            });
            if (target.rightsEffect === 'revoke') {
              const item = state.rights.items.find((row) => row.id === allocation.orderItemId)!;
              const ticket = state.rights.tickets.find(
                (row) => row.registrationId === item.registrationId,
              );
              if (ticket && item.state !== 'cancelled') {
                await tx
                  .update(tickets)
                  .set({ refundPausedBy: application!.id, updatedAt: now })
                  .where(eq(tickets.id, ticket.id));
                ticket.refundPausedBy = application!.id;
              }
            }
          }
          const updatedExecution = {
            ...execution,
            requestId: application!.id,
            protectionScope: 'items' as const,
          };
          let attention: string | null;
          try {
            attention = await tx.transaction((savepoint) =>
              this.fulfill(savepoint, state, updatedExecution, application, state.totalRefunded),
            );
          } catch {
            attention = '已完成退款名额归属，权益或发票同步未完成，请重试权益同步';
          }
          await tx
            .update(refunds)
            .set({ fulfillmentAttention: attention, updatedAt: now })
            .where(eq(refunds.id, execution.id));
          const ledger = await refundItemLedger(tx, orderId);
          const targetIds = targets.map((row) => row.id);
          const completedAmount = ledger.allocations
            .filter((row) => row.refundRequestItemId && targetIds.includes(row.refundRequestItemId))
            .reduce((sum, row) => sum + row.amount, 0);
          const complete = completedAmount >= application!.amount;
          await tx
            .update(refundRequests)
            .set({
              completedAmount,
              reservedAmount: Math.max(0, application!.amount - completedAmount),
              fulfillmentStatus: complete ? 'completed' : 'manual_required',
              terminatedAt: complete ? now : null,
              attentionReason:
                attention ?? (complete ? null : '外部退款已改变原执行金额，请核验后继续剩余退款'),
              version: sql`${refundRequests.version} + 1`,
              updatedAt: now,
            })
            .where(eq(refundRequests.id, application!.id));
          // The original channel attempt stays query-only until the operator confirms its unused identity.
          for (const prior of state.executions.filter(
            (row) =>
              row.id !== execution.id && row.requestId === application!.id && row.currentAttempt,
          )) {
            if (
              ['queued', 'waiting_funds', 'failed', 'superseded'].includes(prior.status) &&
              !prior.leaseUntil
            )
              await tx
                .update(refunds)
                .set({
                  status: prior.lastSubmittedAt ? 'query_pending' : 'superseded',
                  currentAttempt: !complete || Boolean(prior.lastSubmittedAt),
                  nextAttemptAt: prior.lastSubmittedAt ? now : null,
                  lastError: '外部退款已改变申请金额，核验后确认剩余退款',
                  updatedAt: now,
                })
                .where(eq(refunds.id, prior.id));
          }
          const unresolved = state.executions.some(
            (row) =>
              row.id !== execution.id &&
              ((row.protectionScope === 'order' && row.fulfillmentAttention) ||
                row.status === 'abnormal' ||
                (row.status === 'succeeded' &&
                  ledger.allocations
                    .filter((allocation) => allocation.refundId === row.id)
                    .reduce((sum, allocation) => sum + allocation.amount, 0) !== row.amount)),
          );
          if (!unresolved && this.batchPaymentRightsSafe(state))
            await tx
              .update(orders)
              .set({ entitlementsOnHold: false, updatedAt: now })
              .where(eq(orders.id, orderId));
          await this.audit(tx, application!, actorId, 'refund.external_items_allocated', {
            refundId: execution.id,
            allocations,
            fulfillmentAttention: attention,
          });
          return { status: 'succeeded', allocated: true, fulfillmentAttention: attention };
        },
      );
    });
  }

  async emitOverdueAlerts() {
    const candidates = await this.db()
      .select()
      .from(refundRequests)
      .where(
        and(
          isNull(refundRequests.terminatedAt),
          sql`coalesce(${refundRequests.reviewedAt}, ${refundRequests.createdAt}) < now() - interval '24 hours'`,
          sql`not exists (select 1 from ${idempotencyKeys} where ${idempotencyKeys.scope} = 'refund:alert'
            and ${idempotencyKeys.key} = ${refundRequests.id}::text || ':' || case when ${refundRequests.reviewStatus} = 'pending_review' then 'review_overdue' else 'refund_overdue' end)`,
        ),
      )
      .orderBy(asc(refundRequests.createdAt))
      .limit(100);
    for (const row of candidates)
      await this.db().transaction(async (tx) => {
        await this.lockOrder(tx, row.organizationId, row.orderId);
        const [current] = await tx
          .select()
          .from(refundRequests)
          .where(eq(refundRequests.id, row.id))
          .limit(1);
        if (!current || current.terminatedAt) return;
        if ((current.reviewedAt ?? current.createdAt).getTime() > Date.now() - 24 * 60 * 60_000)
          return;
        const kind =
          current.reviewStatus === 'pending_review' ? 'review_overdue' : 'refund_overdue';
        await this.once(tx, 'refund:alert', `${row.id}:${kind}`, {}, async () => {
          await this.event(tx, current, 'RefundAttentionRequired', {
            kind,
            amount: current.reservedAmount,
          });
          return { emitted: true };
        });
      });
  }

  private async fulfill(
    tx: Tx,
    state: Awaited<ReturnType<RefundWorkflowService['state']>>,
    execution: Execution,
    application: Application | undefined,
    totalRefunded: number,
  ) {
    if (state.order.modelVersion === 2) {
      const attention = await fulfillRefundItems(tx, state.order, state.rights, execution);
      await this.adjustInvoice(tx, state, execution, totalRefunded);
      return attention;
    }
    if (state.paid.length !== 1 || state.paid[0]?.amount !== state.order.amount)
      return '退款资金已确认，订单存在多笔或异常支付，需要财务核验后处理票券、库存和发票';
    const fullRefund = totalRefunded >= state.order.amount;
    let fulfillmentAttention: string | null = null;
    const snapshot = application?.businessSnapshot;
    const now = new Date();
    if (
      fullRefund &&
      (state.registration!.supersededAt ||
        state.ticket?.status === 'used' ||
        state.registration!.status === 'checked_in' ||
        (snapshot?.ticketId && snapshot.ticketId !== state.ticket?.id) ||
        (snapshot?.ticketTypeId && snapshot.ticketTypeId !== state.ticket?.ticketTypeId))
    ) {
      fulfillmentAttention = '退款已确认，报名或票券存在变更，需要人工核对权益和库存';
    }
    if (fullRefund && !fulfillmentAttention) {
      if (state.ticket?.status === 'valid' && state.registration!.status !== 'cancelled') {
        const inventoryId =
          typeof snapshot?.ticketTypeId === 'string'
            ? snapshot.ticketTypeId
            : state.ticket.ticketTypeId;
        await tx
          .update(ticketTypes)
          .set({ sold: sql`greatest(${ticketTypes.sold} - 1, 0)`, updatedAt: now })
          .where(eq(ticketTypes.id, inventoryId));
      }
      if (state.ticket)
        await tx
          .update(tickets)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(tickets.id, state.ticket.id));
      await tx
        .update(registrations)
        .set({ status: 'cancelled', updatedAt: now })
        .where(eq(registrations.id, state.registration!.id));
      const endedItems = await tx.update(orderItems).set({ state: 'cancelled', cancelledAt: now, inventoryReleasedAt: now, version: sql`${orderItems.version} + 1`, updatedAt: now }).where(and(eq(orderItems.orderId, state.order.id), eq(orderItems.registrationId, state.registration!.id), sql`${orderItems.state} <> 'cancelled'`)).returning({ id: orderItems.id });
      if (endedItems.length) await tx.update(inventoryReservations).set({ releasedAt: now, updatedAt: now }).where(and(eq(inventoryReservations.orderId, state.order.id), inArray(inventoryReservations.orderItemId, endedItems.map((item) => item.id)), isNull(inventoryReservations.releasedAt)));
    }
    await this.adjustInvoice(tx, state, execution, totalRefunded);
    return fulfillmentAttention;
  }

  private async adjustInvoice(
    tx: Tx,
    state: Awaited<ReturnType<RefundWorkflowService['state']>>,
    execution: Execution,
    totalRefunded: number,
  ) {
    if (state.order.modelVersion === 2 && execution.paymentId !== state.order.settledPaymentId) return;
    const now = new Date();
    const [invoice] = await tx
      .select()
      .from(invoiceRequests)
      .where(eq(invoiceRequests.orderId, execution.orderId))
      .for('update')
      .limit(1);
    if (invoice) {
      const net = Math.max(0, state.order.amount - totalRefunded);
      const status =
        invoice.status === 'issued'
          ? 'adjustment_required'
          : net === 0 && !['voided', 'cancelled', 'adjustment_required'].includes(invoice.status)
            ? 'cancelled'
            : invoice.status;
      await tx
        .update(invoiceRequests)
        .set({ netPaidAmount: net, ...(['issued', 'adjustment_required', 'voided'].includes(invoice.status) ? {} : { amount: Math.min(invoice.amount, net) }), status, updatedAt: now })
        .where(eq(invoiceRequests.id, invoice.id));
      if (status !== invoice.status) await invalidateInvoiceFileAccess(tx, invoice.id);
      if (status !== invoice.status)
        await tx.insert(invoiceStateLogs).values({
          invoiceRequestId: invoice.id,
          fromStatus: invoice.status,
          toStatus: status,
          reason: '订单退款后调整发票',
          metadata: { refundId: execution.id },
        });
    }
  }

  async repairFulfillment(organizationId: string, executionId: string) {
    const [execution] = await this.db()
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.id, executionId),
          eq(refunds.organizationId, organizationId),
          eq(refunds.status, 'succeeded'),
        ),
      )
      .limit(1);
    if (!execution?.fulfillmentAttention) return { repaired: false };
    return this.db().transaction(async (tx) => {
      await this.lockOrder(tx, organizationId, execution.orderId);
      const state = await this.state(tx, organizationId, execution.orderId, true);
      const current = state.executions.find((row) => row.id === executionId)!;
      if (!current.fulfillmentAttention) return { repaired: false };
      const application = state.applications.find((row) => row.id === current.requestId);
      const surplusPaymentRefund = state.order.modelVersion === 2 && state.order.settledPaymentId !== null && current.paymentId !== state.order.settledPaymentId;
      const allocationAttention =
        (state.order.modelVersion === 2 && !surplusPaymentRefund) ||
        (state.rights.items.length === 1 &&
          state.paid.length === 1 &&
          state.paid[0]?.amount === state.order.amount)
          ? await allocateApprovedRefund(tx, state.order, state.rights, current)
          : null;
      const attention = surplusPaymentRefund ? null :
        allocationAttention ??
        (await this.fulfill(tx, state, current, application, state.totalRefunded));
      await tx
        .update(refunds)
        .set({ fulfillmentAttention: attention, updatedAt: new Date() })
        .where(eq(refunds.id, current.id));
      if (application) {
        const ledger = state.order.modelVersion === 2 ? await refundItemLedger(tx, current.orderId) : null;
        const targetIds = ledger?.requestItems.filter((item) => item.refundRequestId === application.id).map((item) => item.id) ?? [];
        const completedAmount = Math.min(application.amount, ledger ? ledger.allocations.filter((allocation) => allocation.refundRequestItemId && targetIds.includes(allocation.refundRequestItemId)).reduce((sum, allocation) => sum + allocation.amount, 0) : application.completedAmount);
        const complete = completedAmount === application.amount;
        await tx.update(refundRequests).set({ completedAmount, reservedAmount: Math.max(0, application.amount - completedAmount), fulfillmentStatus: attention ? 'manual_required' : complete ? 'completed' : 'open', terminatedAt: complete ? (application.terminatedAt ?? new Date()) : null, attentionReason: attention, version: application.version + 1, updatedAt: new Date() }).where(eq(refundRequests.id, application.id));
      }
      if (!attention) {
        await tx.insert(outboxEvents).values({
          organizationId,
          eventId: state.event.id,
          eventType: 'RefundFulfillmentRepaired',
          correlationId: `refund-repair:${current.id}`,
          payload: {
            orderId: current.orderId,
            refundId: current.id,
            fullRefund: state.order.modelVersion === 1 && state.totalRefunded >= state.order.amount,
            modelVersion: state.order.modelVersion,
          },
        });
        await tx.insert(auditLogs).values({
          organizationId,
          eventId: state.event.id,
          action: 'refund.fulfillment_repaired',
          resourceType: 'refund',
          resourceId: current.id,
          after: {},
          traceId: randomUUID(),
        });
      }
      return { repaired: !attention };
    });
  }

  private async discoverExternalObservation(
    organizationId: string,
    merchantId: string,
    outcome: WeChatRefundOutcome,
  ): Promise<{ status: string }> {
    const [scope] = await this.db()
      .select({ payment: payments, order: orders })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          eq(orders.organizationId, organizationId),
          eq(payments.externalId, outcome.transaction_id),
          eq(payments.provider, 'wechatpay'),
        ),
      )
      .limit(1);
    if (!scope) conflict('退款通知待财务关联原订单');
    await this.db().transaction(async (tx) => {
      await lockWeChatConfiguration(tx, organizationId);
      if ((await this.wechat.refundMerchantId(organizationId, tx)) !== merchantId)
        conflict('微信支付配置已变化，请重新核验外部退款商户');
      await this.lockOrder(tx, organizationId, scope.order.id);
      await tx
        .update(orders)
        .set({
          refundExecutionMode: 'external_hold',
          refundExecutionReason: '发现系统外退款，自动提交已暂停，请财务核验',
          entitlementsOnHold: scope.order.modelVersion === 2,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, scope.order.id));
      const state = await this.state(tx, organizationId, scope.order.id);
      if (
        state.executions.some(
          (row) => row.merchantId === merchantId && row.outRefundNo === outcome.out_refund_no,
        )
      )
        return;
      const application = state.applications.find(
        (row) =>
          row.reviewStatus === 'approved' &&
          !row.terminatedAt &&
          row.paymentId === scope.payment.id,
      );
      // Persist the unresolved observation in the same transaction as the hold. It blocks unsafe resume.
      await tx.insert(refunds).values({
        organizationId,
        eventId: scope.order.eventId,
        orderId: scope.order.id,
        paymentId: scope.payment.id,
        requestId: scope.order.modelVersion === 2 ? null : application?.id,
        source: 'external',
        refundNo: `RF${randomUUID().replaceAll('-', '')}`,
        outRefundNo: outcome.out_refund_no,
        merchantId,
        amount: outcome.amount.refund,
        currency: outcome.amount.currency,
        status: 'query_pending',
        reason: '签名通知发现外部退款',
        idempotencyKey: idempotencyRequestHash({
          merchantId,
          outRefundNo: outcome.out_refund_no,
        }),
        nextAttemptAt: new Date(Date.now() + 60_000),
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: scope.order.eventId,
        action: 'refund.external_discovered',
        resourceType: 'order',
        resourceId: scope.order.id,
        after: { outRefundNo: outcome.out_refund_no, amount: outcome.amount.refund },
        traceId: randomUUID(),
      });
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId: scope.order.eventId,
        eventType: 'RefundAttentionRequired',
        correlationId: `external-refund:${outcome.out_refund_no}`,
        payload: {
          requestId: scope.order.modelVersion === 2 ? null : application?.id,
          orderId: scope.order.id,
          amount: outcome.amount.refund,
          kind: 'external_discovered',
        },
      });
    });
    const provenance = await this.wechat.verifyRefundPayment(organizationId, scope.payment.id);
    if (provenance.merchantId !== merchantId || scope.payment.amount !== outcome.amount.total)
      conflict('外部退款商户或金额待核验');
    return this.observe(organizationId, merchantId, outcome);
  }

  /** Apply trusted channel facts under the same order/ticket/registration lock order as approval. */
  async observe(
    organizationId: string,
    merchantId: string,
    outcome: WeChatRefundOutcome,
  ): Promise<{ status: string }> {
    const [initial] = await this.db()
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.organizationId, organizationId),
          eq(refunds.merchantId, merchantId),
          eq(refunds.outRefundNo, outcome.out_refund_no),
        ),
      )
      .limit(1);
    if (!initial) return this.discoverExternalObservation(organizationId, merchantId, outcome);
    return withPostgresTransactionRetry(() =>
      this.db().transaction(async (tx) => {
        await this.lockOrder(tx, organizationId, initial.orderId);
        const state = await this.state(tx, organizationId, initial.orderId, true);
        const execution = state.executions.find((row) => row.id === initial.id)!;
        if (execution.status === 'succeeded') return { status: 'succeeded' };
        if (['closed', 'abnormal'].includes(execution.status) && outcome.status === 'PROCESSING')
          return { status: execution.status };
        const payment = state.paid.find((row) => row.id === execution.paymentId);
        const application = state.applications.find((row) => row.id === execution.requestId);
        const recipient = refundRecipient(outcome);
        const matches =
          payment?.merchantId === merchantId &&
          payment?.externalId === outcome.transaction_id &&
          payment?.outTradeNo === outcome.out_trade_no &&
          payment.amount === outcome.amount.total &&
          payment.currency === outcome.amount.currency &&
          execution.amount === outcome.amount.refund &&
          execution.currency === outcome.amount.currency;
        const now = new Date();
        const next = !matches
          ? 'abnormal'
          : outcome.status === 'SUCCESS'
            ? recipient === 'payer'
              ? 'succeeded'
              : 'abnormal'
            : outcome.status === 'PROCESSING'
              ? 'processing'
              : outcome.status === 'CLOSED'
                ? 'closed'
                : 'abnormal';
        const attention = !matches
          ? '渠道退款与原支付或申请金额不一致，需要财务核验'
          : outcome.status === 'SUCCESS' && recipient !== 'payer'
            ? '退款未确认到达原付款人，需要核验资金去向'
            : null;
        await tx
          .update(refunds)
          .set({
            status: next,
            providerRefundId: outcome.refund_id,
            channelStatus: outcome.status,
            recipientKind: recipient,
            payerTotal: matches ? (outcome.amount.payer_total ?? null) : null,
            payerRefund: matches ? (outcome.amount.payer_refund ?? null) : null,
            discountRefund: matches ? (outcome.amount.discount_refund ?? null) : null,
            acceptedAt: new Date(outcome.create_time),
            succeededAt: outcome.success_time ? new Date(outcome.success_time) : null,
            leaseUntil: null,
            lastError: attention,
            lastErrorCode: attention ? 'RECONCILIATION_REQUIRED' : null,
            providerPayload: {
              verifiedAmount: outcome.amount.refund,
              total: outcome.amount.total,
              recipientKind: recipient,
              channel: outcome.channel,
              verifiedAt: now.toISOString(),
            },
            nextAttemptAt:
              ['processing', 'abnormal'].includes(next) && !attention
                ? new Date(now.getTime() + refundQueryDelay(new Date(outcome.create_time)))
                : null,
            updatedAt: now,
          })
          .where(eq(refunds.id, execution.id));
        if (attention) {
          await tx
            .update(orders)
            .set({
              refundExecutionMode: 'external_hold',
              refundExecutionReason: attention,
              entitlementsOnHold: state.order.modelVersion === 2,
              updatedAt: now,
            })
            .where(eq(orders.id, initial.orderId));
        }
        if (
          application &&
          !application.terminatedAt &&
          (execution.currentAttempt || execution.source === 'external') &&
          ['closed', 'abnormal'].includes(next)
        ) {
          await tx
            .update(refundRequests)
            .set({
              fulfillmentStatus: 'manual_required',
              attentionReason: attention ?? '微信退款需要人工处理',
              updatedAt: now,
            })
            .where(eq(refundRequests.id, application.id));
        }
        if (
          application &&
          !application.terminatedAt &&
          (execution.currentAttempt || execution.source === 'external') &&
          ['closed', 'abnormal'].includes(next)
        )
          await this.once(tx, 'refund:channel-alert', `${execution.id}:${next}`, {}, async () => {
            await this.event(tx, application, 'RefundAttentionRequired', {
              kind: next,
              amount: application.reservedAmount,
            });
            return { emitted: true };
          });
        if (next !== 'succeeded') return { status: next };
        const surplusPaymentRefund = state.order.modelVersion === 2 && state.order.settledPaymentId !== null && execution.paymentId !== state.order.settledPaymentId;
        const totalRefunded = state.totalRefunded + (surplusPaymentRefund ? 0 : execution.amount);
        const ambiguousPayments =
          state.order.modelVersion === 2
            ? payment?.id !== state.order.settledPaymentId || payment?.amount !== state.order.amount
            : state.paid.length !== 1 || payment?.amount !== state.order.amount;
        const paymentRefunded = state.executions
          .filter((row) => row.paymentId === execution.paymentId && row.status === 'succeeded')
          .reduce((sum, row) => sum + row.amount, execution.amount);
        const fullRefund = !ambiguousPayments && totalRefunded >= state.order.amount;
        const nextOrderStatus = ambiguousPayments
          ? state.order.status
          : fullRefund
            ? 'refunded'
            : 'partially_refunded';
        await tx
          .update(orders)
          .set({ status: nextOrderStatus, updatedAt: now })
          .where(eq(orders.id, execution.orderId));
        await tx.insert(orderStateLogs).values({
          orderId: execution.orderId,
          fromStatus: state.order.status,
          toStatus: nextOrderStatus,
          reason: '微信退款结果已核验',
          metadata: { refundId: execution.id, amount: execution.amount },
        });
        if (payment && paymentRefunded >= payment.amount)
          await tx
            .update(payments)
            .set({ status: 'refunded', updatedAt: now })
            .where(eq(payments.id, payment.id));
        let allocationAttention: string | null = null;
        if (
          (state.order.modelVersion === 2 && !surplusPaymentRefund) ||
          (state.order.modelVersion === 1 && state.rights.items.length === 1 &&
            state.paid.length === 1 &&
            payment?.amount === state.order.amount)
        ) {
          try {
            allocationAttention = await tx.transaction((savepoint) =>
              allocateApprovedRefund(savepoint, state.order, state.rights, execution),
            );
          } catch {
            allocationAttention = '退款资金已确认，名额金额归属写入未完成，请重试核验';
          }
        }
        let fulfillmentAttention: string | null;
        try {
          fulfillmentAttention = surplusPaymentRefund ? null :
            allocationAttention ??
            (await tx.transaction((savepoint) =>
              this.fulfill(savepoint, state, execution, application, totalRefunded),
            ));
          if (allocationAttention) await tx.transaction((savepoint) => this.adjustInvoice(savepoint, state, execution, totalRefunded));
        } catch {
          fulfillmentAttention = '退款已确认，权益或发票同步未完成，系统将重试';
        }
        if (fulfillmentAttention) {
          await tx
            .update(refunds)
            .set({ fulfillmentAttention })
            .where(eq(refunds.id, execution.id));
          if (state.order.modelVersion === 1 || allocationAttention)
            await tx
              .update(orders)
              .set({
                entitlementsOnHold: state.order.modelVersion === 2,
                refundExecutionMode: 'external_hold',
                refundExecutionReason: fulfillmentAttention,
                updatedAt: now,
              })
              .where(eq(orders.id, execution.orderId));
        }
        if (application) {
          const currentLedger =
            state.order.modelVersion === 2 ? await refundItemLedger(tx, state.order.id) : null;
          const targetIds =
            currentLedger?.requestItems
              .filter((row) => row.refundRequestId === application.id)
              .map((row) => row.id) ?? [];
          const completedAmount = Math.min(
            application.amount,
            currentLedger
              ? currentLedger.allocations
                  .filter(
                    (row) => row.refundRequestItemId && targetIds.includes(row.refundRequestItemId),
                  )
                  .reduce((sum, row) => sum + row.amount, 0)
              : application.completedAmount + execution.amount,
          );
          const complete = completedAmount === application.amount;
          const executionChanged =
            execution.source === 'external' && completedAmount > application.completedAmount;
          if (executionChanged) {
            const prior = state.executions.find(
              (row) =>
                row.requestId === application.id && row.currentAttempt && row.id !== execution.id,
            );
            if (
              prior &&
              ['queued', 'waiting_funds', 'failed', 'superseded'].includes(prior.status) &&
              !prior.leaseUntil
            ) {
              const neverSubmitted = !prior.lastSubmittedAt;
              await tx
                .update(refunds)
                .set({
                  status: neverSubmitted ? 'superseded' : 'query_pending',
                  currentAttempt: !complete || !neverSubmitted,
                  nextAttemptAt: neverSubmitted ? null : now,
                  lastError: '外部退款已改变申请金额，原执行暂停；核验后可确认剩余退款',
                  updatedAt: now,
                })
                .where(eq(refunds.id, prior.id));
            }
          }
          const applicationAttention =
            fulfillmentAttention ??
            (executionChanged && !complete
              ? '外部退款已改变原执行金额，请先核验并确认剩余退款'
              : null);
          await tx
            .update(refundRequests)
            .set({
              completedAmount,
              reservedAmount: Math.max(0, application.amount - completedAmount),
              fulfillmentStatus: complete
                ? 'completed'
                : applicationAttention
                  ? 'manual_required'
                  : 'open',
              terminatedAt: complete ? now : null,
              attentionReason: applicationAttention,
              version: application.version + 1,
              updatedAt: now,
            })
            .where(eq(refundRequests.id, application.id));
        }
        if (!application && !surplusPaymentRefund) {
          const pending = state.applications.find(
            (row) => row.reviewStatus === 'pending_review' && !row.terminatedAt,
          );
          if (pending)
            await tx
              .update(refundRequests)
              .set({
                reviewStatus: 'rejected',
                reviewReason: '已核验系统外退款，原申请金额已变化，请联系主办方查看资金核验结果',
                reservedAmount: 0,
                reviewedAt: now,
                terminatedAt: now,
                version: pending.version + 1,
                updatedAt: now,
              })
              .where(eq(refundRequests.id, pending.id));
        }
        if (fulfillmentAttention && application)
          await this.event(tx, application, 'RefundAttentionRequired', {
            kind: 'fulfillment_repair',
            amount: execution.amount,
          });
        await tx.insert(outboxEvents).values({
          organizationId,
          eventId: execution.eventId,
          eventType: 'RefundSucceeded',
          correlationId: `refund:${execution.id}`,
          payload: {
            refundId: execution.id,
            orderId: execution.orderId,
            amount: execution.amount,
            fullRefund: state.order.modelVersion === 1 && fullRefund && !fulfillmentAttention,
            modelVersion: state.order.modelVersion,
            recipientRole: 'purchaser',
            suppressNotification: execution.source === 'external',
          },
        });
        await tx.insert(auditLogs).values({
          organizationId,
          eventId: execution.eventId,
          action: 'refund.reconciled',
          resourceType: 'refund',
          resourceId: execution.id,
          after: { amount: execution.amount, recipientKind: recipient, fulfillmentAttention },
          traceId: `refund:${execution.id}`,
        });
        return { status: next };
      }),
    );
  }
}
