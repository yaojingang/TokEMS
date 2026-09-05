import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  orders,
  payments,
  refunds,
  refundRequests,
  refundNotificationInbox,
  refundMerchantSchedules,
  outboxEvents,
  idempotencyKeys,
} from '@conference/database';
import { and, asc, eq, inArray, isNull, isNotNull, lte, or, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { RefundWorkflowService } from './refund-workflow.service.js';
import {
  RefundGatewayError,
  REFUND_RETRY_MS,
  REFUND_CHANNEL_WINDOW_MS,
  REFUND_SUBMIT_STATES,
} from './refund-policy.js';

type Execution = typeof refunds.$inferSelect;

@Injectable()
export class WeChatRefundService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(WeChatRefundService.name);
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WeChatPayService) private readonly wechat: WeChatPayService,
    @Inject(RefundWorkflowService) private readonly workflow: RefundWorkflowService,
  ) {}

  onApplicationBootstrap() {
    if (!this.database.db) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 10_000);
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running || !this.database.db) return;
    this.running = true;
    try {
      await this.processInbox();
      const due = await this.database.db
        .select({ id: refunds.id, orderId: refunds.orderId })
        .from(refunds)
        .where(
          and(
            sql`(${refunds.status} not in ('queued', 'waiting_funds') or exists (
            select 1 from ${orders} inner join ${refundRequests} on ${refundRequests.orderId} = ${orders.id}
            where ${orders.id} = ${refunds.orderId} and ${orders.refundExecutionMode} = 'automatic'
              and ${refundRequests.id} = ${refunds.requestId} and ${refundRequests.reviewStatus} = 'approved'
              and ${refundRequests.terminatedAt} is null and ${refundRequests.reservedAmount} = ${refunds.amount}
              and ${refunds.currentAttempt} = true))`,
            lte(refunds.nextAttemptAt, new Date()),
            or(isNull(refunds.leaseUntil), lte(refunds.leaseUntil, new Date())),
          ),
        )
        .orderBy(asc(refunds.nextAttemptAt), asc(refunds.createdAt))
        .limit(20);
      for (const item of due) {
        const claim = await this.claim(item.id, item.orderId);
        if (claim) await this.execute(claim);
      }
      const repairs = await this.database.db
        .select({ id: refunds.id, organizationId: refunds.organizationId })
        .from(refunds)
        .where(
          and(
            eq(refunds.status, 'succeeded'),
            isNotNull(refunds.fulfillmentAttention),
            lte(refunds.updatedAt, new Date(Date.now() - REFUND_RETRY_MS)),
          ),
        )
        .limit(10);
      for (const repair of repairs) {
        try {
          await this.workflow.repairFulfillment(repair.organizationId, repair.id);
        } catch {
          this.logger.error('退款权益同步等待重试');
        }
      }
      await this.workflow.emitOverdueAlerts();
    } catch {
      this.logger.error('退款维护任务未完成，将从持久化记录恢复');
    } finally {
      this.running = false;
    }
  }

  private async claim(id: string, orderId: string) {
    return this.database.db!.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update')
        .limit(1);
      const [row] = await tx
        .select()
        .from(refunds)
        .where(
          and(
            eq(refunds.id, id),
            lte(refunds.nextAttemptAt, new Date()),
            or(isNull(refunds.leaseUntil), lte(refunds.leaseUntil, new Date())),
          ),
        )
        .for('update')
        .limit(1);
      if (
        !order ||
        !row?.merchantId ||
        !row.outRefundNo ||
        ['succeeded', 'closed', 'failed', 'superseded'].includes(row.status)
      )
        return;
      const submit = (REFUND_SUBMIT_STATES as readonly string[]).includes(row.status);
      const now = new Date();
      if (submit) {
        if (
          order.refundExecutionMode !== 'automatic' ||
          !row.currentAttempt ||
          !row.requestSnapshot
        )
          return;
        const [request] = await tx
          .select()
          .from(refundRequests)
          .where(eq(refundRequests.id, row.requestId!))
          .limit(1);
        if (
          !request ||
          request.reviewStatus !== 'approved' ||
          request.terminatedAt ||
          request.reservedAmount !== row.amount
        )
          return;
        const [payment] = await tx
          .select()
          .from(payments)
          .where(eq(payments.id, row.paymentId!))
          .limit(1);
        if (
          !payment?.succeededAt ||
          now.getTime() - payment.succeededAt.getTime() >= REFUND_CHANNEL_WINDOW_MS
        ) {
          await tx
            .update(refunds)
            .set({
              status: 'failed',
              nextAttemptAt: null,
              lastErrorCode: 'REFUND_EXPIRED',
              lastError: '已超过微信退款技术期限，需要财务处理',
              updatedAt: now,
            })
            .where(eq(refunds.id, row.id));
          await tx
            .update(refundRequests)
            .set({
              fulfillmentStatus: 'manual_required',
              attentionReason: '已超过微信退款技术期限，需要财务处理',
              updatedAt: now,
            })
            .where(eq(refundRequests.id, request.id));
          await tx.insert(outboxEvents).values({
            organizationId: row.organizationId,
            eventId: row.eventId,
            eventType: 'RefundAttentionRequired',
            correlationId: `refund:${request.id}:expired`,
            payload: { requestId: request.id, orderId, kind: 'REFUND_EXPIRED' },
          });
          return;
        }
        if (row.lastSubmittedAt && now.getTime() - row.lastSubmittedAt.getTime() < 60_000) return;
        await tx
          .insert(refundMerchantSchedules)
          .values({ merchantId: row.merchantId })
          .onConflictDoNothing();
        const [slot] = await tx
          .update(refundMerchantSchedules)
          .set({ nextSubmitAt: new Date(now.getTime() + 1000) })
          .where(
            and(
              eq(refundMerchantSchedules.merchantId, row.merchantId),
              lte(refundMerchantSchedules.nextSubmitAt, now),
            ),
          )
          .returning();
        if (!slot) return;
      }
      const [claimed] = await tx
        .update(refunds)
        .set({
          status: submit ? 'submitting' : 'query_pending',
          lastSubmittedAt: submit ? now : row.lastSubmittedAt,
          leaseUntil: new Date(now.getTime() + 30_000),
          leaseVersion: row.leaseVersion + 1,
          attemptCount: row.attemptCount + 1,
          updatedAt: now,
        })
        .where(eq(refunds.id, id))
        .returning();
      return { row: claimed!, submit };
    });
  }

  private async execute(claim: { row: Execution; submit: boolean }) {
    const { row, submit } = claim;
    try {
      const result = submit
        ? await this.wechat.submitRefund(row.organizationId, row.merchantId!, row.requestSnapshot!)
        : await this.wechat.queryRefund(row.organizationId, row.merchantId!, row.outRefundNo!);
      await this.workflow.observe(row.organizationId, row.merchantId!, result);
    } catch (error) {
      await this.recordFailure(row, submit, error);
    }
  }

  private async recordFailure(row: Execution, submit: boolean, error: unknown) {
    const known = error instanceof RefundGatewayError;
    const code = known ? error.code : 'UNKNOWN_ERROR';
    const verifiedMissing =
      !submit && known && error.verifiedResponse && code === 'RESOURCE_NOT_EXISTS';
    const unaccepted = (submit && known && error.knownRejected) || verifiedMissing;
    let status = 'query_pending';
    if (known && error.knownRejected && submit)
      status = code === 'NOT_ENOUGH' ? 'waiting_funds' : 'failed';
    else if (verifiedMissing && row.source === 'wechat_api') status = 'queued';
    const delay = status === 'waiting_funds' ? REFUND_RETRY_MS : 60_000;
    await this.database.db!.transaction(async (tx) => {
      await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.id, row.orderId))
        .for('update');
      let retired = false;
      if (unaccepted && row.requestId) {
        const [request] = await tx
          .select()
          .from(refundRequests)
          .where(eq(refundRequests.id, row.requestId))
          .limit(1);
        if (request && (request.terminatedAt || request.reservedAmount !== row.amount)) {
          status = 'superseded';
          retired = Boolean(request.terminatedAt);
        }
      }
      const [updated] = await tx
        .update(refunds)
        .set({
          status,
          ...(retired ? { currentAttempt: false } : {}),
          lastErrorCode: code,
          lastError: known ? error.message : '退款结果暂未确认，将继续查单',
          nextAttemptAt: ['failed', 'superseded'].includes(status)
            ? null
            : new Date(Date.now() + delay),
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(refunds.id, row.id),
            eq(refunds.leaseVersion, row.leaseVersion),
            eq(refunds.status, row.status),
            sql`${refunds.leaseUntil} is not null`,
          ),
        )
        .returning();
      if (!updated || !row.requestId || !['waiting_funds', 'failed'].includes(status)) return;
      if (status === 'failed')
        await tx
          .update(refundRequests)
          .set({
            fulfillmentStatus: 'manual_required',
            attentionReason: updated.lastError,
            updatedAt: new Date(),
          })
          .where(and(eq(refundRequests.id, row.requestId), isNull(refundRequests.terminatedAt)));
      const key = `${row.requestId}:${code}`;
      const [emitted] = await tx
        .insert(idempotencyKeys)
        .values({
          scope: 'refund:first_failure',
          key,
          requestHash: code,
          responseCode: 200,
          responseBody: { emitted: true },
          expiresAt: new Date(Date.now() + 366 * 86_400_000),
        })
        .onConflictDoNothing({ target: [idempotencyKeys.scope, idempotencyKeys.key] })
        .returning();
      if (emitted)
        await tx.insert(outboxEvents).values({
          organizationId: row.organizationId,
          eventId: row.eventId,
          eventType: 'RefundAttentionRequired',
          correlationId: `refund:${row.requestId}`,
          payload: {
            requestId: row.requestId,
            orderId: row.orderId,
            amount: row.amount,
            kind: code,
          },
        });
    });
  }

  private async processInbox() {
    const db = this.database.db!;
    const items = await db
      .select()
      .from(refundNotificationInbox)
      .where(
        and(
          inArray(refundNotificationInbox.status, ['received', 'quarantined']),
          lte(refundNotificationInbox.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(asc(refundNotificationInbox.nextAttemptAt))
      .limit(10);
    for (const item of items) {
      const [claimed] = await db
        .update(refundNotificationInbox)
        .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
        .where(
          and(
            eq(refundNotificationInbox.id, item.id),
            eq(refundNotificationInbox.nextAttemptAt, item.nextAttemptAt),
          ),
        )
        .returning();
      if (!claimed) continue;
      try {
        const result = await this.wechat.queryRefund(
          item.organizationId,
          item.merchantId,
          item.outRefundNo,
        );
        await this.workflow.observe(item.organizationId, item.merchantId, result);
        await db
          .update(refundNotificationInbox)
          .set({ status: 'processed', processedAt: new Date(), lastError: null })
          .where(eq(refundNotificationInbox.id, item.id));
      } catch {
        await db.transaction(async (tx) => {
          await tx
            .update(refundNotificationInbox)
            .set({
              status: 'quarantined',
              lastError: '退款通知待查单或关联核验',
              nextAttemptAt: new Date(Date.now() + REFUND_RETRY_MS),
            })
            .where(eq(refundNotificationInbox.id, item.id));
          const [alert] = await tx
            .insert(idempotencyKeys)
            .values({
              scope: 'refund:inbox-alert',
              key: item.id,
              requestHash: item.id,
              responseCode: 200,
              responseBody: {},
              expiresAt: new Date(Date.now() + 366 * 86400000),
            })
            .onConflictDoNothing()
            .returning();
          if (alert)
            await tx.insert(outboxEvents).values({
              organizationId: item.organizationId,
              eventType: 'RefundNotificationQuarantined',
              correlationId: `refund-inbox:${item.id}`,
              payload: { organizationId: item.organizationId, outRefundNo: item.outRefundNo },
            });
        });
      }
    }
  }
}
