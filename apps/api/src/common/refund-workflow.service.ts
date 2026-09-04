import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  EventRefundPolicySchema,
  type CustomerRefundApplication,
  type RefundApplicationView,
  type RefundApplicationQuery,
  type RefundContext,
} from '@conference/contracts';
import {
  auditLogs,
  events,
  idempotencyKeys,
  invoiceRequests,
  invoiceStateLogs,
  orders,
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
    const ticketQuery = db
      .select()
      .from(tickets)
      .where(
        and(eq(tickets.registrationId, order.registrationId), eq(tickets.eventId, order.eventId)),
      )
      .limit(1);
    const [ticket] = await (lock ? ticketQuery.for('update') : ticketQuery);
    const registrationQuery = db
      .select()
      .from(registrations)
      .where(
        and(
          eq(registrations.id, order.registrationId),
          eq(registrations.organizationId, organizationId),
        ),
      )
      .limit(1);
    const [registration] = await (lock ? registrationQuery.for('update') : registrationQuery);
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, order.eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!registration || !event) missing();
    const [ticketType] = await db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, registration.ticketTypeId))
      .limit(1);
    const paid = await db
      .select()
      .from(payments)
      .where(
        and(eq(payments.orderId, orderId), inArray(payments.status, ['succeeded', 'refunded'])),
      );
    const applications = await db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.orderId, orderId))
      .orderBy(desc(refundRequests.createdAt));
    const executions = await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, orderId))
      .orderBy(desc(refunds.createdAt));
    const payment = paid.length === 1 ? paid[0] : undefined;
    const totalRefunded = executions
      .filter((row) => row.status === 'succeeded')
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
    if (!currentPolicy.enabled) blockedReason = '本活动尚未开放自助退款，请联系主办方';
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
    else if (ticket?.status === 'used' || registration.status === 'checked_in')
      blockedReason = '票券已使用，请联系主办方核验';
    else if (registration.supersededAt || ticket?.refundPausedBy)
      blockedReason = '参会资格正在变更，请联系主办方';
    else if (Date.now() > deadline.getTime()) blockedReason = '已超过购票后 7 天自助退款期限';
    return {
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
        state.registration.customerUserId,
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
      orderNo: state.order.orderNo,
      eventId: state.event.id,
      eventName: state.event.name,
      ticketName: state.ticketType?.name ?? '',
      attendeeName: state.registration.attendee.name,
      paymentMethod: state.payment?.provider === 'wechatpay' ? '微信支付' : '其他支付方式',
      paidAmount: state.paid.reduce((sum, row) => sum + row.amount, 0),
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
    input: CustomerRefundApplication,
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
        if (!refundPolicy(state.event.settings).enabled) conflict('本活动尚未启用微信退款');
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
          input.amount > state.remaining ||
          input.amount <= 0
        )
          conflict('退款金额或订单状态已变化，请刷新后重新确认');
        if (
          customerUserId &&
          (input.amount !== state.remaining || input.policyVersion !== state.policy.version)
        )
          conflict('退款金额或规则已变化，请刷新后重新确认');
        const fullRefund = input.amount === state.remaining;
        if (
          fullRefund &&
          (state.ticket?.status === 'used' || state.registration.status === 'checked_in')
        )
          conflict('票券已使用，无法批准全额退款');
        if (state.registration.supersededAt) conflict('报名已变更，需要人工核验');
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
            amount: input.amount,
            reservedAmount: input.amount,
            currency: state.order.currency,
            reason: input.reason,
            policySnapshot: {
              ...state.policy,
              paidAt: state.payment.succeededAt.toISOString(),
              deadline: iso(state.deadline),
            },
            businessSnapshot: {
              fullRefund,
              ticketId: state.ticket?.id ?? null,
              registrationId: state.registration.id,
              ticketTypeId: state.ticket?.ticketTypeId ?? state.registration.ticketTypeId,
              inventoryOwned:
                state.ticket?.status === 'valid' && state.registration.status !== 'cancelled',
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
        if (actorId && funding)
          await this.approveExecution(tx, application, state, actorId, currentFunding);
        await this.audit(tx, application, actorId ?? null, 'refund.request', {
          source: application.source,
          customerUserId,
          amount: input.amount,
        });
        const executions = actorId
          ? await tx.select().from(refunds).where(eq(refunds.requestId, application.id))
          : [];
        return this.view(application, executions);
      }),
    );
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
            if (!refundPolicy(state.event.settings).enabled) conflict('本活动尚未启用新的退款审批');
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
    if (state.registration.supersededAt) conflict('报名已变更，需要人工核验');
    const fullRefund = application.businessSnapshot.fullRefund === true;
    if (
      fullRefund &&
      (state.ticket?.status === 'used' || state.registration.status === 'checked_in')
    )
      conflict('参会人已签到或电子票已使用，无法批准全额退款');
    if (state.ticket?.refundPausedBy && state.ticket.refundPausedBy !== application.id)
      conflict('票券已有其他退款暂停');
    if (fullRefund && state.ticket)
      await tx
        .update(tickets)
        .set({ refundPausedBy: application.id, updatedAt: new Date() })
        .where(eq(tickets.id, state.ticket.id));
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
    if (query.status === 'attention')
      conditions.push(
        sql`(${refundRequests.fulfillmentStatus} = 'manual_required' or ${refundRequests.attentionReason} is not null or (${refundRequests.terminatedAt} is null and coalesce(${refundRequests.reviewedAt}, ${refundRequests.createdAt}) < now() - interval '24 hours'))`,
      );
    if (query.status === 'waiting_funds' || query.status === 'processing')
      conditions.push(
        sql`exists (select 1 from ${refunds} where ${refunds.requestId} = ${refundRequests.id} and ${refunds.currentAttempt} = true and ${refunds.status} = ${query.status})`,
      );
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
        { outRefundNo },
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
              requestId: approved?.id,
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
    return this.observe(organizationId, provenance.merchantId, outcome);
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
    if (state.paid.length !== 1 || state.paid[0]?.amount !== state.order.amount)
      return '退款资金已确认，订单存在多笔或异常支付，需要财务核验后处理票券、库存和发票';
    const fullRefund = totalRefunded >= state.order.amount;
    let fulfillmentAttention: string | null = null;
    const snapshot = application?.businessSnapshot;
    const now = new Date();
    if (
      fullRefund &&
      (state.registration.supersededAt ||
        state.ticket?.status === 'used' ||
        state.registration.status === 'checked_in' ||
        (snapshot?.ticketId && snapshot.ticketId !== state.ticket?.id) ||
        (snapshot?.ticketTypeId && snapshot.ticketTypeId !== state.ticket?.ticketTypeId))
    ) {
      fulfillmentAttention = '退款已确认，报名或票券存在变更，需要人工核对权益和库存';
    }
    if (fullRefund && !fulfillmentAttention) {
      if (state.ticket?.status === 'valid' && state.registration.status !== 'cancelled') {
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
        .where(eq(registrations.id, state.registration.id));
    }
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
        .set({ netPaidAmount: net, amount: Math.min(invoice.amount, net), status, updatedAt: now })
        .where(eq(invoiceRequests.id, invoice.id));
      if (status !== invoice.status)
        await tx.insert(invoiceStateLogs).values({
          invoiceRequestId: invoice.id,
          fromStatus: invoice.status,
          toStatus: status,
          reason: '订单退款后调整发票',
          metadata: { refundId: execution.id },
        });
    }
    return fulfillmentAttention;
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
      const attention = await this.fulfill(tx, state, current, application, state.totalRefunded);
      await tx
        .update(refunds)
        .set({ fulfillmentAttention: attention, updatedAt: new Date() })
        .where(eq(refunds.id, current.id));
      if (application)
        await tx
          .update(refundRequests)
          .set({ attentionReason: attention, updatedAt: new Date() })
          .where(eq(refundRequests.id, application.id));
      if (!attention) {
        await tx.insert(outboxEvents).values({
          organizationId,
          eventId: state.event.id,
          eventType: 'RefundFulfillmentRepaired',
          correlationId: `refund-repair:${current.id}`,
          payload: {
            orderId: current.orderId,
            refundId: current.id,
            fullRefund: state.totalRefunded >= state.order.amount,
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
        requestId: application?.id,
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
          requestId: application?.id,
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
        const totalRefunded = state.totalRefunded + execution.amount;
        const ambiguousPayments = state.paid.length !== 1 || payment?.amount !== state.order.amount;
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
        let fulfillmentAttention: string | null;
        try {
          fulfillmentAttention = await tx.transaction((savepoint) =>
            this.fulfill(savepoint, state, execution, application, totalRefunded),
          );
        } catch {
          fulfillmentAttention = '退款已确认，权益或发票同步未完成，系统将重试';
        }
        if (fulfillmentAttention) {
          await tx
            .update(refunds)
            .set({ fulfillmentAttention })
            .where(eq(refunds.id, execution.id));
          await tx
            .update(orders)
            .set({
              refundExecutionMode: 'external_hold',
              refundExecutionReason: fulfillmentAttention,
              updatedAt: now,
            })
            .where(eq(orders.id, execution.orderId));
        }
        if (application) {
          const completedAmount = Math.min(
            application.amount,
            application.completedAmount + execution.amount,
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
        if (!application) {
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
            fullRefund: fullRefund && !fulfillmentAttention,
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
