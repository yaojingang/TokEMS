import { createSign, createVerify, randomBytes, randomUUID } from 'node:crypto';
import {
  MerchantTransferStateSchema,
  calculateCommissionLine,
  merchantTransferStateDisposition,
  shouldApplyMerchantTransferState,
  resolveCommissionReleaseAt,
  resolvePartnerCommissionRate,
} from '@conference/contracts';
import {
  eventPartnerProgramVersions,
  eventPartners,
  orderItems,
  orders,
  organizationIntegrations,
  partnerAttributionRevisions,
  partnerCommissionItems,
  partnerCommissions,
  partnerFinancialEventInbox,
  partnerLedgerEntries,
  partnerPayoutBatches,
  partnerPayoutExecutions,
  partnerPayoutRequests,
  partnerReconciliationRuns,
  payments,
  refundItemAllocations,
  refunds,
  registrations,
  type ConferenceDatabase,
} from '@conference/database';
import { decryptIntegrationCredentials } from '@conference/security';
import { and, asc, count, eq, gte, inArray, isNull, lt, lte, max, or, sql, sum } from 'drizzle-orm';

type FinancialEventType = 'PaymentSucceeded' | 'RefundSucceeded' | 'PartnerAttendeeClaimed';

function stringField(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} is required`);
  return value;
}

async function consumeWechatTransferState(
  db: ConferenceDatabase,
  payload: Record<string, unknown>,
) {
  const executionId = stringField(payload, 'executionId');
  const state = MerchantTransferStateSchema.parse(payload.state);
  const response =
    payload.response && typeof payload.response === 'object'
      ? (payload.response as TransferResponse)
      : {};
  await applyQueriedTransferState(db, executionId, state, response);
}

export async function enqueuePartnerFinancialEvent(
  db: ConferenceDatabase,
  input: {
    sourceEventId: string;
    organizationId: string;
    eventId?: number | null;
    eventType: FinancialEventType;
    payload: Record<string, unknown>;
  },
) {
  await db
    .insert(partnerFinancialEventInbox)
    .values({
      organizationId: input.organizationId,
      eventId: input.eventId ?? null,
      sourceEventId: input.sourceEventId,
      eventType: input.eventType,
      eventKey: `outbox:${input.sourceEventId}:${input.eventType}`,
      payload: input.payload,
    })
    .onConflictDoNothing();
}

function refundWindowEnd(paidAt: Date, pricingSnapshot: Record<string, unknown>) {
  const policy = pricingSnapshot.refundPolicy;
  if (!policy || typeof policy !== 'object') return null;
  const record = policy as Record<string, unknown>;
  if (record.enabled !== true) return null;
  const days = typeof record.windowDays === 'number' ? record.windowDays : 7;
  return new Date(paidAt.getTime() + days * 24 * 60 * 60_000);
}

async function consumePayment(
  db: ConferenceDatabase,
  inboxId: string,
  payload: Record<string, unknown>,
) {
  const orderId = stringField(payload, 'orderId');
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`partner-commission:${orderId}`}, 0))`,
    );
    const [scope] = await tx
      .select({ order: orders, payment: payments, attribution: partnerAttributionRevisions })
      .from(orders)
      .innerJoin(payments, eq(payments.id, orders.settledPaymentId))
      .innerJoin(
        partnerAttributionRevisions,
        eq(partnerAttributionRevisions.id, payments.partnerAttributionRevisionId),
      )
      .where(
        and(
          eq(orders.id, orderId),
          inArray(payments.status, ['succeeded', 'refunded']),
          eq(partnerAttributionRevisions.decision, 'attributed'),
        ),
      )
      .limit(1);
    if (!scope?.attribution.partnerId || !scope.attribution.programVersionId) return;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`partner-commission-sequence:${scope.attribution.partnerId}`}, 0))`,
    );
    const [existing] = await tx
      .select({ id: partnerCommissions.id })
      .from(partnerCommissions)
      .where(
        and(
          eq(partnerCommissions.orderId, orderId),
          eq(partnerCommissions.attributionRevisionId, scope.attribution.id),
        ),
      )
      .limit(1);
    if (existing) return;
    const [partner] = await tx
      .select()
      .from(eventPartners)
      .where(eq(eventPartners.id, scope.attribution.partnerId))
      .limit(1);
    const [program] = await tx
      .select()
      .from(eventPartnerProgramVersions)
      .where(eq(eventPartnerProgramVersions.id, scope.attribution.programVersionId))
      .limit(1);
    const lines = await tx
      .select({ item: orderItems, registration: registrations })
      .from(orderItems)
      .innerJoin(registrations, eq(registrations.id, orderItems.registrationId))
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.position));
    const [history] = await tx
      .select({
        lastSequence: max(partnerCommissions.sequence),
        eligibleOrderCount: sql<number>`count(*) filter (where ${partnerCommissions.eligibleAmount} > 0)`,
      })
      .from(partnerCommissions)
      .where(eq(partnerCommissions.partnerId, scope.attribution.partnerId));
    if (!partner || !program || !scope.payment.succeededAt) return;
    // The immutable ledger sequence also includes excluded and fully reversed orders.
    const sequence = Number(history?.lastSequence ?? 0) + 1;
    const rateBps = resolvePartnerCommissionRate(
      program,
      Number(history?.eligibleOrderCount ?? 0) + 1,
      scope.attribution.personalRateBps,
    );
    const eligibleTickets = new Set(program.eligibleTicketTypeIds);
    const calculated = lines.map((line) => {
      const ticketEligible =
        eligibleTickets.size === 0 || eligibleTickets.has(line.item.ticketTypeId);
      const selfAttendee = line.registration.customerUserId === partner.customerUserId;
      const eligibility = !ticketEligible
        ? ('ticket_excluded' as const)
        : selfAttendee
          ? ('self_attendee' as const)
          : ('eligible' as const);
      return {
        line,
        eligibility,
        result: calculateCommissionLine({
          grossAmount: line.item.allocatedAmount,
          rateBps,
          eligible: eligibility === 'eligible',
        }),
      };
    });
    const eligibleAmount = calculated.reduce(
      (total, item) => total + item.result.eligibleAmount,
      0,
    );
    const commissionAmount = calculated.reduce(
      (total, item) => total + item.result.commissionAmount,
      0,
    );
    const releaseAt = resolveCommissionReleaseAt(
      scope.payment.succeededAt,
      program.settlementDelayDays,
      refundWindowEnd(scope.payment.succeededAt, scope.order.pricingSnapshot),
    );
    const [commission] = await tx
      .insert(partnerCommissions)
      .values({
        organizationId: scope.order.organizationId,
        eventId: scope.order.eventId,
        partnerId: partner.id,
        orderId,
        paymentId: scope.payment.id,
        attributionRevisionId: scope.attribution.id,
        programVersionId: program.id,
        sequence,
        rateBps,
        eligibleAmount,
        commissionAmount,
        status: 'pending',
        releaseAt,
      })
      .returning();
    const commissionLines = await tx
      .insert(partnerCommissionItems)
      .values(
        calculated.map((item) => ({
          commissionId: commission!.id,
          partnerId: partner.id,
          organizationId: scope.order.organizationId,
          eventId: scope.order.eventId,
          orderId,
          orderItemId: item.line.item.id,
          ticketTypeId: item.line.item.ticketTypeId,
          grossAmount: item.result.grossAmount,
          eligibleAmount: item.result.eligibleAmount,
          rateBps,
          commissionAmount: item.result.commissionAmount,
          eligibility: item.eligibility,
          eligibilityReason:
            item.eligibility === 'eligible'
              ? '符合当前规则'
              : item.eligibility === 'self_attendee'
                ? '合作伙伴认领该参会名额'
                : '票种未纳入佣金范围',
          identityProvisional: !item.line.registration.customerUserId,
        })),
      )
      .returning();
    const ledgerRows = commissionLines
      .filter((line) => line.commissionAmount > 0)
      .map((line) => ({
        organizationId: line.organizationId,
        eventId: line.eventId,
        partnerId: line.partnerId,
        commissionId: commission!.id,
        commissionItemId: line.id,
        entryType: 'commission' as const,
        balanceBucket: 'pending' as const,
        amount: line.commissionAmount,
        businessKey: `commission:${line.id}:pending`,
        sourceEventId: inboxId,
        reason: '支付成功后生成待结算佣金',
        evidence: { orderId, paymentId: scope.payment.id },
      }));
    if (ledgerRows.length)
      await tx.insert(partnerLedgerEntries).values(ledgerRows).onConflictDoNothing();
  });
}

async function recalculateCommission(
  db: Pick<ConferenceDatabase, 'select' | 'update'>,
  commissionId: string,
) {
  const [totals] = await db
    .select({
      eligible: sum(partnerCommissionItems.eligibleAmount),
      refunded: sum(partnerCommissionItems.refundedAmount),
      commission: sum(partnerCommissionItems.commissionAmount),
      reversed: sum(partnerCommissionItems.reversedAmount),
    })
    .from(partnerCommissionItems)
    .where(eq(partnerCommissionItems.commissionId, commissionId));
  const commissionAmount = Number(totals?.commission ?? 0);
  const reversedAmount = Number(totals?.reversed ?? 0);
  const eligibleAmount = Number(totals?.eligible ?? 0);
  const refundedAmount = Number(totals?.refunded ?? 0);
  const [current] = await db
    .select()
    .from(partnerCommissions)
    .where(eq(partnerCommissions.id, commissionId))
    .limit(1);
  if (
    !current ||
    (current.eligibleAmount === eligibleAmount &&
      current.refundedAmount === refundedAmount &&
      current.commissionAmount === commissionAmount &&
      current.reversedAmount === reversedAmount)
  ) {
    return;
  }
  const [recovery] = await db
    .select({ value: sum(partnerLedgerEntries.amount) })
    .from(partnerLedgerEntries)
    .where(
      and(
        eq(partnerLedgerEntries.commissionId, commissionId),
        eq(partnerLedgerEntries.balanceBucket, 'recovery_due'),
      ),
    );
  const recoveryAmount = Math.max(0, Number(recovery?.value ?? 0));
  const status =
    recoveryAmount > 0
      ? 'recovery_due'
      : reversedAmount >= commissionAmount
        ? 'reversed'
        : reversedAmount > 0
          ? 'partially_reversed'
          : current.status;
  await db
    .update(partnerCommissions)
    .set({
      eligibleAmount,
      refundedAmount,
      commissionAmount,
      reversedAmount,
      status,
      version: sql`${partnerCommissions.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(partnerCommissions.id, commissionId));
}

async function consumeRefund(
  db: ConferenceDatabase,
  inboxId: string,
  payload: Record<string, unknown>,
) {
  const refundId = stringField(payload, 'refundId');
  const allocations = await db
    .select({
      allocation: refundItemAllocations,
      line: partnerCommissionItems,
      commission: partnerCommissions,
    })
    .from(refundItemAllocations)
    .innerJoin(
      partnerCommissionItems,
      eq(partnerCommissionItems.orderItemId, refundItemAllocations.orderItemId),
    )
    .innerJoin(partnerCommissions, eq(partnerCommissions.id, partnerCommissionItems.commissionId))
    .where(eq(refundItemAllocations.refundId, refundId));
  if (!allocations.length) {
    const [attributedRefund] = await db
      .select({ orderId: refunds.orderId })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(
        partnerAttributionRevisions,
        eq(partnerAttributionRevisions.id, payments.partnerAttributionRevisionId),
      )
      .where(
        and(
          eq(refunds.id, refundId),
          eq(refunds.status, 'succeeded'),
          eq(partnerAttributionRevisions.decision, 'attributed'),
        ),
      )
      .limit(1);
    if (attributedRefund) {
      throw new Error(`Partner commission is not ready for refund ${refundId}`);
    }
    return;
  }
  for (const row of allocations) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`partner-balance:${row.line.partnerId}`}, 0))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`partner-commission-item:${row.line.id}`}, 0))`,
      );
      const [line] = await tx
        .select()
        .from(partnerCommissionItems)
        .where(eq(partnerCommissionItems.id, row.line.id))
        .for('update')
        .limit(1);
      if (!line) return;
      const [commission] = await tx
        .select({ status: partnerCommissions.status, availableAt: partnerCommissions.availableAt })
        .from(partnerCommissions)
        .where(eq(partnerCommissions.id, line.commissionId))
        .for('update')
        .limit(1);
      const [refundTotal] = await tx
        .select({ value: sum(refundItemAllocations.amount) })
        .from(refundItemAllocations)
        .innerJoin(refunds, eq(refunds.id, refundItemAllocations.refundId))
        .where(
          and(
            eq(refundItemAllocations.orderItemId, line.orderItemId),
            eq(refunds.status, 'succeeded'),
          ),
        );
      if (!commission) return;
      const nextRefunded = Math.min(line.grossAmount, Number(refundTotal?.value ?? 0));
      const commissionEligible = line.eligibility === 'eligible' || line.eligibility === 'refunded';
      const next = commissionEligible
        ? calculateCommissionLine({
            grossAmount: line.grossAmount,
            refundedAmount: nextRefunded,
            rateBps: line.rateBps,
            eligible: true,
          })
        : null;
      const targetReversedAmount = next
        ? Math.max(line.reversedAmount, line.commissionAmount - next.commissionAmount)
        : line.reversedAmount;
      const delta = Math.max(0, targetReversedAmount - line.reversedAmount);
      if (nextRefunded === line.refundedAmount && delta === 0) {
        await recalculateCommission(tx, line.commissionId);
        return;
      }
      await tx
        .update(partnerCommissionItems)
        .set({
          eligibleAmount: next?.eligibleAmount ?? line.eligibleAmount,
          refundedAmount: nextRefunded,
          reversedAmount: targetReversedAmount,
          eligibility: next
            ? next.eligibleAmount === 0
              ? 'refunded'
              : 'eligible'
            : line.eligibility,
          eligibilityReason: next
            ? next.eligibleAmount === 0
              ? '订单明细已全额退款'
              : '订单明细发生部分退款'
            : line.eligibilityReason,
          version: line.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(partnerCommissionItems.id, line.id));
      if (delta > 0) {
        const [available] = await tx
          .select({ value: sum(partnerLedgerEntries.amount) })
          .from(partnerLedgerEntries)
          .where(
            and(
              eq(partnerLedgerEntries.partnerId, line.partnerId),
              eq(partnerLedgerEntries.balanceBucket, 'available'),
            ),
          );
        const availableAmount = Math.max(0, Number(available?.value ?? 0));
        const pendingSettlement = !commission.availableAt;
        const debitAmount = pendingSettlement ? delta : Math.min(delta, availableAmount);
        const recoveryAmount = pendingSettlement ? 0 : delta - debitAmount;
        await tx
          .insert(partnerLedgerEntries)
          .values([
            ...(debitAmount > 0
              ? [
                  {
                    organizationId: line.organizationId,
                    eventId: line.eventId,
                    partnerId: line.partnerId,
                    commissionId: line.commissionId,
                    commissionItemId: line.id,
                    entryType: 'refund_reversal' as const,
                    balanceBucket: pendingSettlement
                      ? ('pending' as const)
                      : ('available' as const),
                    amount: -debitAmount,
                    businessKey: `refund:${row.allocation.id}:commission:${line.id}:debit`,
                    sourceEventId: inboxId,
                    reason: '订单明细退款冲正佣金',
                    evidence: {
                      refundId,
                      allocationId: row.allocation.id,
                      amount: row.allocation.amount,
                      cumulativeRefundedAmount: nextRefunded,
                    },
                  },
                ]
              : []),
            ...(recoveryAmount > 0
              ? [
                  {
                    organizationId: line.organizationId,
                    eventId: line.eventId,
                    partnerId: line.partnerId,
                    commissionId: line.commissionId,
                    commissionItemId: line.id,
                    entryType: 'recovery' as const,
                    balanceBucket: 'recovery_due' as const,
                    amount: recoveryAmount,
                    businessKey: `refund:${row.allocation.id}:commission:${line.id}:recovery`,
                    sourceEventId: inboxId,
                    reason: '退款冲正超过当前可提现余额，登记待追偿',
                    evidence: {
                      refundId,
                      allocationId: row.allocation.id,
                      amount: row.allocation.amount,
                      cumulativeRefundedAmount: nextRefunded,
                    },
                  },
                ]
              : []),
          ])
          .onConflictDoNothing();
        if (recoveryAmount > 0) {
          await tx
            .update(partnerCommissions)
            .set({ status: 'recovery_due', updatedAt: new Date() })
            .where(eq(partnerCommissions.id, line.commissionId));
        }
      }
      await recalculateCommission(tx, line.commissionId);
    });
  }
}

async function consumeClaim(
  db: ConferenceDatabase,
  inboxId: string,
  payload: Record<string, unknown>,
) {
  const orderItemId = stringField(payload, 'orderItemId');
  const customerUserId = stringField(payload, 'customerUserId');
  const [scope] = await db
    .select({ line: partnerCommissionItems, partner: eventPartners })
    .from(partnerCommissionItems)
    .innerJoin(eventPartners, eq(eventPartners.id, partnerCommissionItems.partnerId))
    .where(eq(partnerCommissionItems.orderItemId, orderItemId))
    .limit(1);
  if (!scope) {
    const [attributedOrder] = await db
      .select({ partnerCustomerUserId: eventPartners.customerUserId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(payments, eq(payments.id, orders.settledPaymentId))
      .innerJoin(
        partnerAttributionRevisions,
        eq(partnerAttributionRevisions.id, payments.partnerAttributionRevisionId),
      )
      .innerJoin(eventPartners, eq(eventPartners.id, partnerAttributionRevisions.partnerId))
      .where(
        and(eq(orderItems.id, orderItemId), eq(partnerAttributionRevisions.decision, 'attributed')),
      )
      .limit(1);
    if (attributedOrder?.partnerCustomerUserId === customerUserId) {
      throw new Error(`Partner commission is not ready for attendee claim ${orderItemId}`);
    }
    return;
  }
  if (scope.partner.customerUserId !== customerUserId) return;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`partner-balance:${scope.line.partnerId}`}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`partner-commission-item:${scope.line.id}`}, 0))`,
    );
    const [line] = await tx
      .select()
      .from(partnerCommissionItems)
      .where(eq(partnerCommissionItems.id, scope.line.id))
      .for('update')
      .limit(1);
    if (!line) return;
    if (line.eligibility !== 'eligible') {
      await recalculateCommission(tx, line.commissionId);
      return;
    }
    const [commission] = await tx
      .select({ status: partnerCommissions.status, availableAt: partnerCommissions.availableAt })
      .from(partnerCommissions)
      .where(eq(partnerCommissions.id, line.commissionId))
      .for('update')
      .limit(1);
    const [identity] = await tx
      .select({
        partnerCustomerUserId: eventPartners.customerUserId,
        attendeeCustomerUserId: registrations.customerUserId,
      })
      .from(eventPartners)
      .innerJoin(partnerCommissionItems, eq(partnerCommissionItems.partnerId, eventPartners.id))
      .innerJoin(orderItems, eq(orderItems.id, partnerCommissionItems.orderItemId))
      .innerJoin(registrations, eq(registrations.id, orderItems.registrationId))
      .where(eq(partnerCommissionItems.id, line.id))
      .limit(1);
    if (
      !commission ||
      identity?.partnerCustomerUserId !== customerUserId ||
      identity.attendeeCustomerUserId !== customerUserId
    ) {
      return;
    }
    const delta = line.commissionAmount - line.reversedAmount;
    await tx
      .update(partnerCommissionItems)
      .set({
        eligibleAmount: 0,
        reversedAmount: line.commissionAmount,
        eligibility: 'self_attendee',
        eligibilityReason: '合作伙伴在支付后认领该参会名额',
        identityProvisional: false,
        version: line.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(partnerCommissionItems.id, line.id),
          eq(partnerCommissionItems.version, line.version),
        ),
      );
    if (delta <= 0) {
      await recalculateCommission(tx, line.commissionId);
      return;
    }
    const [available] = await tx
      .select({ value: sum(partnerLedgerEntries.amount) })
      .from(partnerLedgerEntries)
      .where(
        and(
          eq(partnerLedgerEntries.partnerId, line.partnerId),
          eq(partnerLedgerEntries.balanceBucket, 'available'),
        ),
      );
    const availableAmount = Math.max(0, Number(available?.value ?? 0));
    const pendingSettlement = !commission.availableAt;
    const debitAmount = pendingSettlement ? delta : Math.min(delta, availableAmount);
    const recoveryAmount = pendingSettlement ? 0 : delta - debitAmount;
    await tx
      .insert(partnerLedgerEntries)
      .values([
        ...(debitAmount > 0
          ? [
              {
                organizationId: line.organizationId,
                eventId: line.eventId,
                partnerId: line.partnerId,
                commissionId: line.commissionId,
                commissionItemId: line.id,
                entryType: 'self_referral_reversal' as const,
                balanceBucket: pendingSettlement ? ('pending' as const) : ('available' as const),
                amount: -debitAmount,
                businessKey: `claim:${orderItemId}:commission:${line.id}:debit`,
                sourceEventId: inboxId,
                reason: '支付后认领触发自购冲正',
                evidence: { orderItemId, customerUserId },
              },
            ]
          : []),
        ...(recoveryAmount > 0
          ? [
              {
                organizationId: line.organizationId,
                eventId: line.eventId,
                partnerId: line.partnerId,
                commissionId: line.commissionId,
                commissionItemId: line.id,
                entryType: 'recovery' as const,
                balanceBucket: 'recovery_due' as const,
                amount: recoveryAmount,
                businessKey: `claim:${orderItemId}:commission:${line.id}:recovery`,
                sourceEventId: inboxId,
                reason: '认领冲正超过当前可提现余额，登记待追偿',
                evidence: { orderItemId, customerUserId },
              },
            ]
          : []),
      ])
      .onConflictDoNothing();
    if (recoveryAmount > 0) {
      await tx
        .update(partnerCommissions)
        .set({ status: 'recovery_due', updatedAt: new Date() })
        .where(eq(partnerCommissions.id, line.commissionId));
    }
    await recalculateCommission(tx, line.commissionId);
  });
}

export async function processPartnerFinancialInbox(db: ConferenceDatabase) {
  let processed = 0;
  for (let index = 0; index < 100; index += 1) {
    const leaseToken = randomUUID();
    const row = await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(partnerFinancialEventInbox)
        .where(
          or(
            and(
              inArray(partnerFinancialEventInbox.status, ['pending', 'retrying']),
              or(
                isNull(partnerFinancialEventInbox.nextAttemptAt),
                lte(partnerFinancialEventInbox.nextAttemptAt, new Date()),
              ),
            ),
            and(
              eq(partnerFinancialEventInbox.status, 'processing'),
              lte(partnerFinancialEventInbox.leaseExpiresAt, new Date()),
            ),
          ),
        )
        .orderBy(asc(partnerFinancialEventInbox.createdAt))
        .for('update', { skipLocked: true })
        .limit(1);
      if (!candidate) return null;
      const [claimed] = await tx
        .update(partnerFinancialEventInbox)
        .set({
          status: 'processing',
          attempts: candidate.attempts + 1,
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(partnerFinancialEventInbox.id, candidate.id),
            or(
              inArray(partnerFinancialEventInbox.status, ['pending', 'retrying']),
              and(
                eq(partnerFinancialEventInbox.status, 'processing'),
                lte(partnerFinancialEventInbox.leaseExpiresAt, new Date()),
              ),
            ),
          ),
        )
        .returning();
      return claimed ?? null;
    });
    if (!row) break;
    try {
      if (row.eventType === 'PaymentSucceeded') await consumePayment(db, row.id, row.payload);
      if (row.eventType === 'RefundSucceeded') await consumeRefund(db, row.id, row.payload);
      if (row.eventType === 'PartnerAttendeeClaimed') await consumeClaim(db, row.id, row.payload);
      if (row.eventType === 'WechatTransferStateChanged') {
        await consumeWechatTransferState(db, row.payload);
      }
      await db
        .update(partnerFinancialEventInbox)
        .set({
          status: 'processed',
          processedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(partnerFinancialEventInbox.id, row.id),
            eq(partnerFinancialEventInbox.leaseToken, leaseToken),
          ),
        );
      processed += 1;
    } catch (error) {
      const failed = row.attempts >= 20;
      await db
        .update(partnerFinancialEventInbox)
        .set({
          status: failed ? 'failed' : 'retrying',
          nextAttemptAt: failed
            ? null
            : new Date(Date.now() + Math.min(6 * 60 * 60_000, 2 ** row.attempts * 5_000)),
          leaseToken: null,
          leaseExpiresAt: null,
          lastError:
            error instanceof Error ? error.message.slice(0, 1000) : 'Unknown financial error',
          updatedAt: new Date(),
        })
        .where(eq(partnerFinancialEventInbox.id, row.id));
    }
  }
  return processed;
}

export async function releasePartnerCommissions(db: ConferenceDatabase) {
  const due = await db
    .select({ id: partnerCommissions.id, partnerId: partnerCommissions.partnerId })
    .from(partnerCommissions)
    .innerJoin(eventPartners, eq(eventPartners.id, partnerCommissions.partnerId))
    .where(
      and(
        inArray(partnerCommissions.status, ['pending', 'partially_reversed']),
        isNull(partnerCommissions.availableAt),
        lte(partnerCommissions.releaseAt, new Date()),
        eq(eventPartners.settlementHold, false),
      ),
    )
    .orderBy(asc(partnerCommissions.releaseAt))
    .limit(200);
  let released = 0;
  for (const candidate of due) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`partner-balance:${candidate.partnerId}`}, 0))`,
      );
      const [partner] = await tx
        .select({ settlementHold: eventPartners.settlementHold })
        .from(eventPartners)
        .where(eq(eventPartners.id, candidate.partnerId))
        .limit(1);
      if (!partner || partner.settlementHold) return;
      const [commission] = await tx
        .select()
        .from(partnerCommissions)
        .where(eq(partnerCommissions.id, candidate.id))
        .for('update')
        .limit(1);
      if (
        !commission ||
        !['pending', 'partially_reversed'].includes(commission.status) ||
        commission.availableAt ||
        commission.releaseAt > new Date()
      ) {
        return;
      }
      const amount = commission.commissionAmount - commission.reversedAmount;
      const [recovery] = await tx
        .select({ value: sum(partnerLedgerEntries.amount) })
        .from(partnerLedgerEntries)
        .where(
          and(
            eq(partnerLedgerEntries.partnerId, commission.partnerId),
            eq(partnerLedgerEntries.balanceBucket, 'recovery_due'),
          ),
        );
      const recoveryAmount = Math.max(0, Number(recovery?.value ?? 0));
      const recoveredAmount = Math.min(amount, recoveryAmount);
      const availableAmount = amount - recoveredAmount;
      if (amount > 0) {
        await tx
          .insert(partnerLedgerEntries)
          .values([
            {
              organizationId: commission.organizationId,
              eventId: commission.eventId,
              partnerId: commission.partnerId,
              commissionId: commission.id,
              entryType: 'commission',
              balanceBucket: 'pending',
              amount: -amount,
              businessKey: `commission:${commission.id}:release:pending`,
              reason: '佣金结算等待期结束',
            },
            ...(recoveredAmount > 0
              ? [
                  {
                    organizationId: commission.organizationId,
                    eventId: commission.eventId,
                    partnerId: commission.partnerId,
                    commissionId: commission.id,
                    entryType: 'recovery' as const,
                    balanceBucket: 'recovery_due' as const,
                    amount: -recoveredAmount,
                    businessKey: `commission:${commission.id}:release:recovery`,
                    reason: '新结算佣金抵扣待追偿金额',
                  },
                ]
              : []),
            ...(availableAmount > 0
              ? [
                  {
                    organizationId: commission.organizationId,
                    eventId: commission.eventId,
                    partnerId: commission.partnerId,
                    commissionId: commission.id,
                    entryType: 'commission' as const,
                    balanceBucket: 'available' as const,
                    amount: availableAmount,
                    businessKey: `commission:${commission.id}:release:available`,
                    reason: '佣金转入可提现余额',
                  },
                ]
              : []),
          ])
          .onConflictDoNothing();
      }
      if (recoveryAmount > 0 && recoveredAmount === recoveryAmount) {
        await tx
          .update(partnerCommissions)
          .set({
            status: sql`case
              when ${partnerCommissions.reversedAmount} >= ${partnerCommissions.commissionAmount} then 'reversed'
              when ${partnerCommissions.reversedAmount} > 0 then 'partially_reversed'
              else ${partnerCommissions.status}
            end`,
            version: sql`${partnerCommissions.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(partnerCommissions.partnerId, commission.partnerId),
              eq(partnerCommissions.status, 'recovery_due'),
            ),
          );
      }
      await tx
        .update(partnerCommissions)
        .set({
          status: amount <= 0 ? 'reversed' : availableAmount > 0 ? 'available' : 'paid',
          availableAt: new Date(),
          version: commission.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(partnerCommissions.id, commission.id));
      released += 1;
    });
  }
  return released;
}

export async function reconcilePartnerFinancialFacts(db: ConferenceDatabase) {
  const startedAt = new Date();
  const windowStart = new Date(startedAt.getTime() - 24 * 60 * 60_000);
  const dayStart = new Date(startedAt);
  dayStart.setHours(0, 0, 0, 0);
  const scopes = await db
    .select({
      organizationId: eventPartnerProgramVersions.organizationId,
      eventId: eventPartnerProgramVersions.eventId,
    })
    .from(eventPartnerProgramVersions)
    .where(eq(eventPartnerProgramVersions.status, 'active'))
    .groupBy(eventPartnerProgramVersions.organizationId, eventPartnerProgramVersions.eventId);
  const missingPayments = await db
    .select({
      organizationId: orders.organizationId,
      eventId: orders.eventId,
      orderId: orders.id,
      paymentId: payments.id,
    })
    .from(orders)
    .innerJoin(payments, eq(payments.id, orders.settledPaymentId))
    .innerJoin(
      partnerAttributionRevisions,
      eq(partnerAttributionRevisions.id, payments.partnerAttributionRevisionId),
    )
    .leftJoin(partnerCommissions, eq(partnerCommissions.orderId, orders.id))
    .where(
      and(
        eq(partnerAttributionRevisions.decision, 'attributed'),
        isNull(partnerCommissions.id),
        inArray(payments.status, ['succeeded', 'refunded']),
      ),
    )
    .limit(500);
  for (const item of missingPayments) {
    await db
      .insert(partnerFinancialEventInbox)
      .values({
        organizationId: item.organizationId,
        eventId: item.eventId,
        eventType: 'PaymentSucceeded',
        eventKey: `reconcile:payment:${item.paymentId}`,
        payload: { orderId: item.orderId },
      })
      .onConflictDoNothing();
  }

  const missingRefunds = await db
    .selectDistinct({
      organizationId: refunds.organizationId,
      eventId: refunds.eventId,
      refundId: refunds.id,
      amount: refunds.amount,
    })
    .from(refunds)
    .innerJoin(refundItemAllocations, eq(refundItemAllocations.refundId, refunds.id))
    .innerJoin(
      partnerCommissionItems,
      eq(partnerCommissionItems.orderItemId, refundItemAllocations.orderItemId),
    )
    .where(
      and(
        eq(refunds.status, 'succeeded'),
        sql`${partnerCommissionItems.refundedAmount} < (
          select least(
            ${partnerCommissionItems.grossAmount},
            coalesce(sum(allocation.amount), 0)
          )
          from refund_item_allocations allocation
          inner join refunds completed_refund on completed_refund.id = allocation.refund_id
          where allocation.order_item_id = ${partnerCommissionItems.orderItemId}
            and completed_refund.status = 'succeeded'
        )`,
      ),
    )
    .limit(500);
  for (const item of missingRefunds) {
    await db
      .insert(partnerFinancialEventInbox)
      .values({
        organizationId: item.organizationId,
        eventId: item.eventId,
        eventType: 'RefundSucceeded',
        eventKey: `reconcile:refund:${item.refundId}`,
        payload: { refundId: item.refundId },
      })
      .onConflictDoNothing();
  }

  for (const scope of scopes) {
    const existingRuns = await db
      .select({ kind: partnerReconciliationRuns.kind })
      .from(partnerReconciliationRuns)
      .where(
        and(
          eq(partnerReconciliationRuns.organizationId, scope.organizationId),
          eq(partnerReconciliationRuns.eventId, scope.eventId),
          inArray(partnerReconciliationRuns.kind, ['payments', 'refunds']),
          gte(partnerReconciliationRuns.createdAt, dayStart),
        ),
      );
    const recorded = new Set(existingRuns.map((item) => item.kind));
    const paymentDifferences = missingPayments.filter(
      (item) => item.organizationId === scope.organizationId && item.eventId === scope.eventId,
    );
    const refundDifferences = missingRefunds.filter(
      (item) => item.organizationId === scope.organizationId && item.eventId === scope.eventId,
    );
    const [[paymentCount], [refundCount]] = await Promise.all([
      db
        .select({ value: count(orders.id) })
        .from(orders)
        .innerJoin(payments, eq(payments.id, orders.settledPaymentId))
        .innerJoin(
          partnerAttributionRevisions,
          eq(partnerAttributionRevisions.id, payments.partnerAttributionRevisionId),
        )
        .where(
          and(
            eq(orders.organizationId, scope.organizationId),
            eq(orders.eventId, scope.eventId),
            eq(partnerAttributionRevisions.decision, 'attributed'),
            inArray(payments.status, ['succeeded', 'refunded']),
          ),
        ),
      db
        .select({ value: sql<number>`count(distinct ${refunds.id})` })
        .from(refunds)
        .innerJoin(refundItemAllocations, eq(refundItemAllocations.refundId, refunds.id))
        .innerJoin(
          partnerCommissionItems,
          eq(partnerCommissionItems.orderItemId, refundItemAllocations.orderItemId),
        )
        .where(
          and(
            eq(refunds.organizationId, scope.organizationId),
            eq(refunds.eventId, scope.eventId),
            eq(refunds.status, 'succeeded'),
          ),
        ),
    ]);
    if (!recorded.has('payments')) {
      await db.insert(partnerReconciliationRuns).values({
        organizationId: scope.organizationId,
        eventId: scope.eventId,
        kind: 'payments',
        status: paymentDifferences.length ? 'difference' : 'matched',
        windowStart,
        windowEnd: startedAt,
        checkedCount: Number(paymentCount?.value ?? 0),
        differenceCount: paymentDifferences.length,
        evidence: { missingCommissionOrderIds: paymentDifferences.map((item) => item.orderId) },
      });
    }
    if (!recorded.has('refunds')) {
      await db.insert(partnerReconciliationRuns).values({
        organizationId: scope.organizationId,
        eventId: scope.eventId,
        kind: 'refunds',
        status: refundDifferences.length ? 'difference' : 'matched',
        windowStart,
        windowEnd: startedAt,
        checkedCount: Number(refundCount?.value ?? 0),
        differenceCount: refundDifferences.length,
        differenceAmount: refundDifferences.reduce((total, item) => total + item.amount, 0),
        evidence: { missingRefundIds: refundDifferences.map((item) => item.refundId) },
      });
    }
  }
  return { missingPayments: missingPayments.length, missingRefunds: missingRefunds.length };
}

type TransferResponse = {
  transfer_bill_no?: string;
  state?: string;
  package_info?: string;
  fail_reason?: string;
};

function sanitizedTransferResponse(response: TransferResponse) {
  return {
    ...(response.transfer_bill_no ? { transfer_bill_no: response.transfer_bill_no } : {}),
    ...(response.state ? { state: response.state } : {}),
    ...(response.package_info ? { package_info: response.package_info } : {}),
    ...(response.fail_reason ? { fail_reason: response.fail_reason } : {}),
  };
}

function wechatTransferCredentials(integration: typeof organizationIntegrations.$inferSelect) {
  if (!integration.encryptedCredentials) return null;
  const secrets = decryptIntegrationCredentials(
    integration.organizationId,
    'wechatpay',
    integration.encryptedCredentials,
  );
  const config = integration.config;
  const value = {
    mchId: typeof config.mchId === 'string' ? config.mchId : '',
    certificateSerial:
      typeof config.merchantCertificateSerial === 'string' ? config.merchantCertificateSerial : '',
    platformPublicKeyId:
      typeof config.platformPublicKeyId === 'string' ? config.platformPublicKeyId : '',
    merchantPrivateKey: secrets.merchantPrivateKey ?? '',
    platformPublicKey: secrets.platformPublicKey ?? '',
  };
  return Object.values(value).every(Boolean) ? value : null;
}

function signWechatQuery(
  canonicalUrl: string,
  credentials: NonNullable<ReturnType<typeof wechatTransferCredentials>>,
) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const signer = createSign('RSA-SHA256');
  signer.update(`GET\n${canonicalUrl}\n${timestamp}\n${nonce}\n\n`);
  signer.end();
  const signature = signer.sign(credentials.merchantPrivateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${credentials.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${credentials.certificateSerial}",signature="${signature}"`;
}

function verifyWechatResponse(
  raw: string,
  response: Response,
  credentials: NonNullable<ReturnType<typeof wechatTransferCredentials>>,
) {
  const timestamp = response.headers.get('wechatpay-timestamp') ?? '';
  const nonce = response.headers.get('wechatpay-nonce') ?? '';
  const signature = response.headers.get('wechatpay-signature') ?? '';
  const serial = response.headers.get('wechatpay-serial') ?? '';
  if (!timestamp || !nonce || !signature || serial !== credentials.platformPublicKeyId)
    return false;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${timestamp}\n${nonce}\n${raw}\n`);
  verifier.end();
  return verifier.verify(credentials.platformPublicKey, signature, 'base64');
}

async function applyQueriedTransferState(
  db: ConferenceDatabase,
  executionId: string,
  state: ReturnType<typeof MerchantTransferStateSchema.parse> | 'unknown',
  response: TransferResponse,
) {
  const [scope] = await db
    .select({ partnerId: partnerPayoutExecutions.partnerId })
    .from(partnerPayoutExecutions)
    .where(eq(partnerPayoutExecutions.id, executionId))
    .limit(1);
  if (!scope) return;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`partner-balance:${scope.partnerId}`}, 0))`,
    );
    const [execution] = await tx
      .select()
      .from(partnerPayoutExecutions)
      .where(eq(partnerPayoutExecutions.id, executionId))
      .for('update')
      .limit(1);
    if (
      !execution ||
      !shouldApplyMerchantTransferState(
        execution.status as
          ReturnType<typeof MerchantTransferStateSchema.parse> | 'prepared' | 'unknown',
        state,
      )
    ) {
      return;
    }
    const [request] = await tx
      .select({
        grossAmount: partnerPayoutRequests.grossAmount,
        taxAmount: partnerPayoutRequests.taxAmount,
        netAmount: partnerPayoutRequests.netAmount,
      })
      .from(partnerPayoutRequests)
      .where(eq(partnerPayoutRequests.id, execution.payoutRequestId))
      .for('update')
      .limit(1);
    if (!request) throw new Error(`Payout request ${execution.payoutRequestId} is missing`);
    const disposition = state === 'unknown' ? null : merchantTransferStateDisposition(state);
    const now = new Date();
    const requestStatus =
      state === 'SUCCESS'
        ? 'succeeded'
        : disposition?.terminal
          ? 'failed'
          : state === 'unknown'
            ? 'unknown'
            : 'executing';
    await tx
      .update(partnerPayoutExecutions)
      .set({
        status: state,
        providerTransferBillNo: response.transfer_bill_no ?? execution.providerTransferBillNo,
        responseSnapshot: sanitizedTransferResponse(response),
        confirmationPackage: response.package_info ?? execution.confirmationPackage,
        confirmationExpiresAt:
          state === 'WAIT_USER_CONFIRM'
            ? new Date(Date.now() + 24 * 60 * 60_000)
            : execution.confirmationExpiresAt,
        lastQueriedAt: now,
        queryCount: execution.queryCount + 1,
        failureCode: disposition?.terminal && !disposition.succeeded ? state : null,
        failureReason: response.fail_reason ?? null,
        ...(state === 'SUCCESS' ? { succeededAt: now } : {}),
        ...(disposition?.terminal && !disposition.succeeded ? { failedAt: now } : {}),
        version: execution.version + 1,
        updatedAt: now,
      })
      .where(eq(partnerPayoutExecutions.id, execution.id));
    await tx
      .update(partnerPayoutRequests)
      .set({
        status: requestStatus,
        ...(disposition?.terminal ? { completedAt: now } : {}),
        version: sql`${partnerPayoutRequests.version} + 1`,
        updatedAt: now,
      })
      .where(eq(partnerPayoutRequests.id, execution.payoutRequestId));
    if (disposition?.terminal) {
      const [recovery] =
        state === 'SUCCESS'
          ? [{ value: 0 }]
          : await tx
              .select({ value: sum(partnerLedgerEntries.amount) })
              .from(partnerLedgerEntries)
              .where(
                and(
                  eq(partnerLedgerEntries.partnerId, execution.partnerId),
                  eq(partnerLedgerEntries.balanceBucket, 'recovery_due'),
                ),
              );
      const recoveryAmount = Math.max(0, Number(recovery?.value ?? 0));
      const recoveredAmount = Math.min(request.grossAmount, recoveryAmount);
      const availableAmount = request.grossAmount - recoveredAmount;
      await tx
        .insert(partnerLedgerEntries)
        .values(
          state === 'SUCCESS'
            ? [
                {
                  organizationId: execution.organizationId,
                  eventId: execution.eventId,
                  partnerId: execution.partnerId,
                  payoutRequestId: execution.payoutRequestId,
                  payoutExecutionId: execution.id,
                  entryType: 'payout' as const,
                  balanceBucket: 'reserved' as const,
                  amount: -request.grossAmount,
                  businessKey: `payout:${execution.payoutRequestId}:wechat:reserved`,
                  reason: '微信商家转账到账',
                },
                {
                  organizationId: execution.organizationId,
                  eventId: execution.eventId,
                  partnerId: execution.partnerId,
                  payoutRequestId: execution.payoutRequestId,
                  payoutExecutionId: execution.id,
                  entryType: 'payout' as const,
                  balanceBucket: 'paid' as const,
                  amount: request.netAmount,
                  businessKey: `payout:${execution.payoutRequestId}:wechat:paid`,
                  reason: '微信商家转账净额到账',
                },
                ...(request.taxAmount > 0
                  ? [
                      {
                        organizationId: execution.organizationId,
                        eventId: execution.eventId,
                        partnerId: execution.partnerId,
                        payoutRequestId: execution.payoutRequestId,
                        payoutExecutionId: execution.id,
                        entryType: 'tax_withholding' as const,
                        balanceBucket: 'paid' as const,
                        amount: request.taxAmount,
                        businessKey: `payout:${execution.payoutRequestId}:wechat:tax`,
                        reason: '微信商家转账代扣税费',
                      },
                    ]
                  : []),
              ]
            : [
                {
                  organizationId: execution.organizationId,
                  eventId: execution.eventId,
                  partnerId: execution.partnerId,
                  payoutRequestId: execution.payoutRequestId,
                  payoutExecutionId: execution.id,
                  entryType: 'payout_release' as const,
                  balanceBucket: 'reserved' as const,
                  amount: -request.grossAmount,
                  businessKey: `payout:${execution.payoutRequestId}:wechat:release:reserved`,
                  reason: '微信商家转账未到账，释放占用金额',
                },
                ...(recoveredAmount > 0
                  ? [
                      {
                        organizationId: execution.organizationId,
                        eventId: execution.eventId,
                        partnerId: execution.partnerId,
                        payoutRequestId: execution.payoutRequestId,
                        payoutExecutionId: execution.id,
                        entryType: 'recovery' as const,
                        balanceBucket: 'recovery_due' as const,
                        amount: -recoveredAmount,
                        businessKey: `payout:${execution.payoutRequestId}:wechat:release:recovery`,
                        reason: '释放的微信转账占用金额优先抵扣待追偿金额',
                      },
                    ]
                  : []),
                ...(availableAmount > 0
                  ? [
                      {
                        organizationId: execution.organizationId,
                        eventId: execution.eventId,
                        partnerId: execution.partnerId,
                        payoutRequestId: execution.payoutRequestId,
                        payoutExecutionId: execution.id,
                        entryType: 'payout_release' as const,
                        balanceBucket: 'available' as const,
                        amount: availableAmount,
                        businessKey: `payout:${execution.payoutRequestId}:wechat:release:available`,
                        reason: '微信商家转账未到账，释放占用金额',
                      },
                    ]
                  : []),
              ],
        )
        .onConflictDoNothing();
      if (state !== 'SUCCESS' && recoveryAmount > 0 && recoveredAmount === recoveryAmount) {
        await tx
          .update(partnerCommissions)
          .set({
            status: sql`case
              when ${partnerCommissions.reversedAmount} >= ${partnerCommissions.commissionAmount} then 'reversed'
              when ${partnerCommissions.reversedAmount} > 0 then 'partially_reversed'
              else ${partnerCommissions.status}
            end`,
            version: sql`${partnerCommissions.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(partnerCommissions.partnerId, execution.partnerId),
              eq(partnerCommissions.status, 'recovery_due'),
            ),
          );
      }
    }
    const unfinished = await tx
      .select({ id: partnerPayoutRequests.id })
      .from(partnerPayoutRequests)
      .where(
        and(
          eq(partnerPayoutRequests.batchId, execution.batchId),
          inArray(partnerPayoutRequests.status, ['batched', 'executing', 'unknown']),
        ),
      )
      .limit(1);
    if (!unfinished.length) {
      await tx
        .update(partnerPayoutBatches)
        .set({
          status: 'completed',
          completedAt: now,
          version: sql`${partnerPayoutBatches.version} + 1`,
          updatedAt: now,
        })
        .where(eq(partnerPayoutBatches.id, execution.batchId));
    }
  });
}

export async function queryPendingPartnerPayouts(db: ConferenceDatabase) {
  const candidates = await db
    .select()
    .from(partnerPayoutExecutions)
    .where(
      and(
        eq(partnerPayoutExecutions.channel, 'wechat_transfer'),
        inArray(partnerPayoutExecutions.status, [
          'prepared',
          'ACCEPTED',
          'PROCESSING',
          'WAIT_USER_CONFIRM',
          'TRANSFERING',
          'CANCELING',
          'unknown',
        ]),
        or(
          isNull(partnerPayoutExecutions.lastQueriedAt),
          lt(partnerPayoutExecutions.lastQueriedAt, new Date(Date.now() - 5 * 60_000)),
        ),
      ),
    )
    .orderBy(asc(partnerPayoutExecutions.updatedAt))
    .limit(50);
  const integrations = new Map<string, typeof organizationIntegrations.$inferSelect | null>();
  let queried = 0;
  for (const execution of candidates) {
    if (!execution.merchantBillNo) continue;
    let integration = integrations.get(execution.organizationId);
    if (integration === undefined) {
      [integration] = await db
        .select()
        .from(organizationIntegrations)
        .where(
          and(
            eq(organizationIntegrations.organizationId, execution.organizationId),
            eq(organizationIntegrations.provider, 'wechatpay'),
          ),
        )
        .limit(1);
      integrations.set(execution.organizationId, integration ?? null);
    }
    if (!integration) continue;
    const credentials = wechatTransferCredentials(integration);
    if (!credentials) continue;
    const url = `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(execution.merchantBillNo)}`;
    let responseBody: TransferResponse = {};
    let state: ReturnType<typeof MerchantTransferStateSchema.parse> | 'unknown' = 'unknown';
    try {
      const response = await fetch(`https://api.mch.weixin.qq.com${url}`, {
        headers: {
          Accept: 'application/json',
          Authorization: signWechatQuery(url, credentials),
          'Wechatpay-Serial': credentials.platformPublicKeyId,
          'User-Agent': 'TokEMS/partner-payout-worker',
        },
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await response.text();
      if (response.ok && verifyWechatResponse(raw, response, credentials)) {
        responseBody = JSON.parse(raw) as TransferResponse;
        const parsed = MerchantTransferStateSchema.safeParse(responseBody.state);
        if (parsed.success) state = parsed.data;
      }
    } catch {
      state = 'unknown';
    }
    await applyQueriedTransferState(db, execution.id, state, responseBody);
    queried += 1;
  }
  return queried;
}

export async function activateScheduledPartnerPrograms(db: ConferenceDatabase) {
  const due = await db
    .select({ id: eventPartnerProgramVersions.id, organizationId: eventPartnerProgramVersions.organizationId, eventId: eventPartnerProgramVersions.eventId })
    .from(eventPartnerProgramVersions)
    .where(
      and(
        eq(eventPartnerProgramVersions.status, 'scheduled'),
        lte(eventPartnerProgramVersions.effectiveAt, new Date()),
      ),
    )
    .orderBy(asc(eventPartnerProgramVersions.effectiveAt))
    .limit(100);
  for (const candidate of due) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`partner-program:${candidate.organizationId}:${candidate.eventId}`}, 0))`);
      const [program] = await tx
        .select()
        .from(eventPartnerProgramVersions)
        .where(eq(eventPartnerProgramVersions.id, candidate.id))
        .for('update')
        .limit(1);
      if (
        !program ||
        program.status !== 'scheduled' ||
        !program.effectiveAt ||
        program.effectiveAt > new Date()
      )
        return;
      await tx
        .update(eventPartnerProgramVersions)
        .set({ status: 'retired', updatedAt: new Date() })
        .where(
          and(
            eq(eventPartnerProgramVersions.organizationId, program.organizationId),
            eq(eventPartnerProgramVersions.eventId, program.eventId),
            eq(eventPartnerProgramVersions.status, 'active'),
          ),
        );
      await tx
        .update(eventPartnerProgramVersions)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(eventPartnerProgramVersions.id, program.id));
      await tx
        .update(eventPartners)
        .set({
          currentProgramVersionId: program.id,
          version: sql`${eventPartners.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(eventPartners.organizationId, program.organizationId),
            eq(eventPartners.eventId, program.eventId),
          ),
        );
    });
  }
  return due.length;
}

export async function reconcileAgedPartnerPayouts(db: ConferenceDatabase) {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const aged = await db
    .select()
    .from(partnerPayoutExecutions)
    .where(
      and(
        eq(partnerPayoutExecutions.channel, 'wechat_transfer'),
        inArray(partnerPayoutExecutions.status, [
          'prepared',
          'ACCEPTED',
          'PROCESSING',
          'WAIT_USER_CONFIRM',
          'TRANSFERING',
          'CANCELING',
          'unknown',
        ]),
        lt(partnerPayoutExecutions.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60_000)),
      ),
    )
    .limit(500);
  const grouped = new Map<string, typeof aged>();
  for (const item of aged) {
    const key = `${item.organizationId}:${item.eventId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  for (const executions of grouped.values()) {
    const organizationId = executions[0]!.organizationId;
    const eventId = executions[0]!.eventId;
    const [existing] = await db
      .select({ id: partnerReconciliationRuns.id })
      .from(partnerReconciliationRuns)
      .where(
        and(
          eq(partnerReconciliationRuns.organizationId, organizationId),
          eq(partnerReconciliationRuns.eventId, eventId),
          eq(partnerReconciliationRuns.kind, 'payouts'),
          gte(partnerReconciliationRuns.createdAt, dayStart),
        ),
      )
      .limit(1);
    if (existing) continue;
    await db.insert(partnerReconciliationRuns).values({
      organizationId,
      eventId,
      kind: 'payouts',
      status: executions.length ? 'difference' : 'matched',
      windowStart: new Date(Date.now() - 31 * 24 * 60 * 60_000),
      windowEnd: now,
      checkedCount: executions.length,
      differenceCount: executions.length,
      differenceAmount: executions.reduce((total, item) => total + item.amount, 0),
      evidence: {
        source: 'wechat-fund-bill-required',
        merchantBillNumbers: executions.map((item) => item.merchantBillNo).filter(Boolean),
      },
    });
  }
  return aged.length;
}
