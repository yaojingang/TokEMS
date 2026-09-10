import {
  eraseUnavailableClaimInvitationReplays,
  paymentNotificationInbox,
} from '@conference/database';
import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  CreateRegistrationBatchSchema,
  type CreateRegistration,
  type CreateRegistrationBatch,
  type PublicEvent,
  type RegistrationBatchCheckout,
  type RegistrationBatchQuote,
  type RegistrationBatchQuoteInput,
} from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  activeInventoryReservationAt,
  paymentProtectedOrderSql,
  attendeeClaimTokens,
  auditLogs,
  customerUsers,
  eventReleases,
  events,
  idempotencyKeys,
  inventoryReservations,
  orderItems,
  orders,
  orderStateLogs,
  outboxEvents,
  payments,
  refundRequestItems,
  refundRequests,
  registrations,
  registrationPurchaseAttempts,
  ticketTypes,
  waitlistEntries,
} from '@conference/database';
import { normalizeMainlandMobile } from '@conference/security';
import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { idempotencyRequestHash } from './idempotency.service.js';
import {
  batchAmount,
  batchConflict,
  BATCH_PAYMENT_WINDOW_MS,
  BATCH_REVIEW_WINDOW_MS,
  normalizeBatchAttendees,
} from './batch-purchase-policy.js';
import {
  batchTokenHash,
  OrderItemsService,
  type BatchCustomer,
  type BatchReader,
} from './order-items.service.js';
import { resolvePublishedRegistrationSettings } from './purchase-registration-policy.js';
import { refundPolicy } from './refund-policy.js';
import { customerPurchaserScopeSql } from './customer-order-ownership.js';
import { withPostgresTransactionRetry } from './transaction-retry.js';
import type { CustomerRegistrationActor } from './conference.repository.js';

type Snapshot = {
  event?: { settings?: { registration?: Partial<PublicEvent['registration']> } };
  tickets?: Array<PublicEvent['tickets'][number] & { capacity?: number }>;
  registrationForm?: PublicEvent['registrationForm'];
  experience?: PublicEvent['experience'];
};

@Injectable()
export class BatchRegistrationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OrderItemsService) private readonly items: OrderItemsService,
  ) {}

  private async source(
    reader: BatchReader,
    input: RegistrationBatchQuoteInput,
    customer: BatchCustomer,
  ) {
    const [event] = await reader
      .select()
      .from(events)
      .where(and(eq(events.id, input.eventId), eq(events.organizationId, customer.organizationId)))
      .limit(1);
    if (!event)
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '大会不存在', HttpStatus.NOT_FOUND);
    const currentReleaseId =
      typeof event.settings.currentReleaseId === 'string' ? event.settings.currentReleaseId : '';
    const [release] = currentReleaseId
      ? await reader
          .select()
          .from(eventReleases)
          .where(and(eq(eventReleases.id, currentReleaseId), eq(eventReleases.eventId, event.id)))
          .limit(1)
      : [];
    const snapshot = release?.snapshot as Snapshot | undefined;
    const form = snapshot?.registrationForm;
    const releasedTicket = snapshot?.tickets?.find((ticket) => ticket.id === input.ticketTypeId);
    const [ticket] = await reader
      .select()
      .from(ticketTypes)
      .where(
        and(
          eq(ticketTypes.id, input.ticketTypeId),
          eq(ticketTypes.eventId, event.id),
          eq(ticketTypes.organizationId, customer.organizationId),
        ),
      )
      .limit(1);
    if (!releasedTicket || !ticket || !form?.version || !form.termsVersion || !form.termsContent)
      batchConflict('大会当前发布版本缺少票种或报名表，请刷新后重试');
    const settings = resolvePublishedRegistrationSettings(
      {
        currentReleaseId,
        registration: (event.settings.registration ?? {}) as Partial<PublicEvent['registration']>,
      },
      snapshot,
    );
    const manualReview = snapshot?.experience?.registrationFlow.branches.manualReview === true;
    const unitPrice = releasedTicket.price;
    if (settings.paymentMode === 'free' && unitPrice !== 0)
      batchConflict('免费大会票价配置需要主办方核验');
    const fingerprint = idempotencyRequestHash({
      ticketTypeId: ticket.id,
      quantity: input.quantity,
      unitPrice,
      currency: settings.currency,
      form: {
        version: form.version,
        fields: form.fields,
        termsVersion: form.termsVersion,
        termsContent: form.termsContent,
      },
      refundPolicy: refundPolicy(event.settings),
      manualReview,
    });
    return {
      event,
      ticket,
      releasedTicket,
      form,
      settings,
      manualReview,
      unitPrice,
      fingerprint,
      currentReleaseId,
    };
  }

  async purchaseCounts(reader: BatchReader, eventId: number, customer: BatchCustomer) {
    const rows = await reader
      .select({
        order: orders,
        item: orderItems,
        registration: registrations,
        paymentProtected: paymentProtectedOrderSql(orders.id),
      })
      .from(orders)
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .leftJoin(registrations, eq(registrations.id, orders.registrationId))
      .where(
        and(
          eq(orders.organizationId, customer.organizationId),
          eq(orders.eventId, eventId),
          customerPurchaserScopeSql(customer.customerUserId),
        ),
      );
    const now = new Date();
    const pending = rows.filter(
      ({ order, item, registration, paymentProtected }) =>
        (item?.state === 'pending' ||
          (!item &&
            registration &&
            ['pending_payment', 'pending_review'].includes(registration.status))) &&
        ((order.status === 'pending_review' &&
          (order.modelVersion === 1 || order.expiresAt > now)) ||
          (order.status === 'pending_payment' && order.expiresAt > now) ||
          order.status === 'processing' ||
          paymentProtected),
    );
    const active = rows.filter(({ item, registration }) =>
      item
        ? item.state === 'active'
        : registration &&
          !registration.supersededAt &&
          ['confirmed', 'checked_in'].includes(registration.status),
    );
    const pendingOrders = [...new Set(pending.map(({ order }) => order.id))];
    return {
      activeSeatCount: active.length + pending.length,
      confirmedSeatCount: active.length,
      reservedSeatCount: pending.length,
      paidCount: new Set(
        rows
          .filter(
            ({ order }) =>
              Boolean(order.settledPaymentId) ||
              ['paid', 'partially_refunded', 'refunded'].includes(order.status),
          )
          .map(({ order }) => order.id),
      ).size,
      pendingCount: pendingOrders.length,
      pendingOrderId: pendingOrders[0] ?? null,
    };
  }

  private async availableInventory(
    reader: BatchReader,
    input: RegistrationBatchQuoteInput,
    source: Awaited<ReturnType<BatchRegistrationService['source']>>,
    ownWaitlistOfferId?: string,
  ) {
    const [reserved] = await reader
      .select({ quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}),0)::int` })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.ticketTypeId, input.ticketTypeId),
          isNull(inventoryReservations.convertedAt),
          isNull(inventoryReservations.releasedAt),
          activeInventoryReservationAt(new Date()),
        ),
      );
    const [waitlist] = await reader
      .select({ quantity: sql<number>`count(*)::int` })
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.ticketTypeId, input.ticketTypeId),
          eq(waitlistEntries.status, 'invited'),
          gt(waitlistEntries.expiresAt, new Date()),
          ownWaitlistOfferId ? ne(waitlistEntries.id, ownWaitlistOfferId) : undefined,
        ),
      );
    const capacity = source.releasedTicket.capacity ?? source.ticket.capacity;
    return capacity - source.ticket.sold - (reserved?.quantity ?? 0) - (waitlist?.quantity ?? 0);
  }

  async quote(
    input: RegistrationBatchQuoteInput,
    customer: BatchCustomer,
    reader: BatchReader = this.items.db(),
    snapshot?: Awaited<ReturnType<BatchRegistrationService['source']>>,
  ): Promise<RegistrationBatchQuote> {
    const source = snapshot ?? (await this.source(reader, input, customer));
    const counts = await this.purchaseCounts(reader, input.eventId, customer);
    const inventoryAvailable = await this.availableInventory(reader, input, source);
    const remainingSeatCount = Math.max(
      0,
      source.settings.maxActiveSeatsPerPurchaser - counts.activeSeatCount,
    );
    const availableQuantity = Math.max(
      0,
      Math.min(
        remainingSeatCount,
        inventoryAvailable,
        source.settings.additionalPurchaseEnabled &&
          process.env.BATCH_PURCHASE_CREATION_ENABLED !== 'false'
          ? 20
          : 1,
      ),
    );
    const blockedReason =
      source.event.status !== 'registration_open' || !source.settings.registrationOpen
        ? '当前大会未开放报名'
        : counts.pendingOrderId
          ? '请先处理已有待审核或待支付订单'
          : !source.settings.additionalPurchaseEnabled && counts.activeSeatCount > 0
            ? '当前大会未开放后续增购'
            : input.quantity > availableQuantity
              ? '当前可购买名额不足，请调整数量'
              : null;
    return {
      eventId: input.eventId,
      ticketTypeId: input.ticketTypeId,
      ticketTypeName: source.releasedTicket.name,
      quantity: input.quantity,
      unitPrice: source.unitPrice,
      amount: batchAmount(source.unitPrice, input.quantity),
      currency: source.settings.currency,
      availableQuantity,
      activeSeatCount: counts.activeSeatCount,
      remainingSeatCount,
      maxActiveSeatsPerPurchaser: source.settings.maxActiveSeatsPerPurchaser,
      additionalPurchaseEnabled: source.settings.additionalPurchaseEnabled,
      manualReview: source.manualReview,
      formVersion: source.form.version,
      termsVersion: source.form.termsVersion,
      quoteFingerprint: source.fingerprint,
      blockedReason,
      pendingOrderId: counts.pendingOrderId,
    };
  }

  async createSingle(input: CreateRegistration, key: string, customer: CustomerRegistrationActor) {
    const [existing] = await this.items
      .db()
      .select({ snapshot: orders.pricingSnapshot })
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, customer.organizationId),
          eq(orders.eventId, input.eventId),
          eq(orders.purchaserCustomerUserId, customer.customerUserId),
          eq(orders.purchaseIntentId, input.purchaseIntentId),
        ),
      )
      .limit(1);
    const quoteFingerprint =
      typeof existing?.snapshot.quoteFingerprint === 'string'
        ? existing.snapshot.quoteFingerprint
        : (
            await this.quote(
              { eventId: input.eventId, ticketTypeId: input.ticketTypeId, quantity: 1 },
              customer,
            )
          ).quoteFingerprint;
    const result = await this.create(
      {
        ...input,
        quantity: 1,
        attendees: [
          {
            clientId: input.purchaseIntentId,
            isSelf: input.purchaseFor === 'self',
            attendee: input.attendee,
            formAnswers: input.formAnswers,
            marketingConsent: input.marketingConsent,
          },
        ],
        quoteFingerprint,
      },
      key,
      customer,
    );
    if (!result.registration) batchConflict('当前订单包含多个名额，请升级页面后查看');
    return { ...result, registration: result.registration };
  }

  async create(
    input: CreateRegistrationBatch,
    key: string,
    customer: CustomerRegistrationActor,
  ): Promise<RegistrationBatchCheckout> {
    const parsed = CreateRegistrationBatchSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '请核对购买数量、参会资料及授权条款',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    input = parsed.data;
    const db = this.items.db();
    const requestHash = idempotencyRequestHash({ input, customerUserId: customer.customerUserId });
    const scope = `registration-batch:${customer.organizationId}:${customer.customerUserId}`;
    const normalizedLogin = normalizeMainlandMobile(customer.mobile);
    const [knownIntent] = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, customer.organizationId),
          eq(orders.eventId, input.eventId),
          eq(orders.purchaserCustomerUserId, customer.customerUserId),
          eq(orders.purchaseIntentId, input.purchaseIntentId),
        ),
      )
      .limit(1);
    if (knownIntent) {
      if (knownIntent.pricingSnapshot.purchaseRequestHash !== requestHash)
        batchConflict('相同购买意图对应了不同的报名内容');
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${scope}:${key}`},0))`,
        );
        const [cached] = await tx
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
          .limit(1);
        if (cached && cached.requestHash !== requestHash)
          batchConflict('相同幂等键对应了不同的报名内容');
        await tx
          .select({ id: orders.id })
          .from(orders)
          .where(eq(orders.id, knownIntent.id))
          .for('update');
        const current = await this.items.requireOrder(tx, knownIntent.id, customer);
        if (!cached)
          await tx.insert(idempotencyKeys).values({
            scope,
            key,
            requestHash,
            responseCode: 201,
            responseBody: { orderId: current.id },
            expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
          });
        const checkout = await this.items.checkout(tx, current, customer.customerUserId);
        return { ...checkout, orderAccessToken: await this.items.accessToken(tx, current.id) };
      });
    }
    // Quote reads never reserve. The transaction re-reads the publication and admission state.
    return withPostgresTransactionRetry(() =>
      db.transaction(async (tx) => {
        const observed = await this.source(tx, input, customer);
        let attendees = normalizeBatchAttendees(
          input.attendees,
          normalizedLogin,
          observed.form.fields,
        );
        const identityKeys = [
          ...new Set([
            `customer-user:${customer.organizationId}:${normalizedLogin}`,
            ...attendees.flatMap((row) => [
              `registration-mobile:${input.eventId}:${row.attendee.mobile}`,
              ...(row.isSelf
                ? [`registration-customer:${input.eventId}:${customer.customerUserId}`]
                : []),
            ]),
          ]),
        ].sort();
        for (const identity of identityKeys)
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity},0))`);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`registration-purchaser:${customer.organizationId}:${input.eventId}:${customer.customerUserId}`},0))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${scope}:${key}`},0))`,
        );
        const [cached] = await tx
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
          .limit(1);
        if (cached && cached.requestHash !== requestHash)
          batchConflict('相同幂等键对应了不同的报名内容');
        const [intent] = await tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.organizationId, customer.organizationId),
              eq(orders.eventId, input.eventId),
              eq(orders.purchaserCustomerUserId, customer.customerUserId),
              eq(orders.purchaseIntentId, input.purchaseIntentId),
            ),
          )
          .limit(1);
        if (intent) {
          if (intent.pricingSnapshot.purchaseRequestHash !== requestHash)
            batchConflict('相同购买意图对应了不同的报名内容');
          if (!cached)
            await tx.insert(idempotencyKeys).values({
              scope,
              key,
              requestHash,
              responseCode: 201,
              responseBody: { orderId: intent.id },
              expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
            });
          const checkout = await this.items.checkout(tx, intent, customer.customerUserId);
          return { ...checkout, orderAccessToken: await this.items.accessToken(tx, intent.id) };
        }
        if (cached) batchConflict('原购买结果需要核验，请勿重复提交');
        let prior = await tx
          .select({ registration: registrations, item: orderItems, order: orders })
          .from(registrations)
          .leftJoin(orderItems, eq(orderItems.registrationId, registrations.id))
          .leftJoin(orders, eq(orders.id, orderItems.orderId))
          .where(
            and(
              eq(registrations.organizationId, customer.organizationId),
              eq(registrations.eventId, input.eventId),
              isNull(registrations.supersededAt),
              or(
                inArray(
                  registrations.attendeeMobileE164,
                  attendees.map((row) => row.attendee.mobile),
                ),
                attendees.some((row) => row.isSelf)
                  ? eq(registrations.customerUserId, customer.customerUserId)
                  : undefined,
              ),
            ),
          );
        const priorOrderIds = [
          ...new Set(prior.flatMap((row) => (row.order ? [row.order.id] : []))),
        ].sort();
        for (const orderId of priorOrderIds) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`wechatpay:prepare:${orderId}`},0))`,
          );
          await tx
            .select({ id: orders.id })
            .from(orders)
            .where(eq(orders.id, orderId))
            .for('update');
        }
        await this.items.lockOrderItems(tx, priorOrderIds, [input.ticketTypeId]);
        // Re-read after locks: a refund or cancellation may have changed the selected old rights.
        if (prior.length)
          prior = await tx
            .select({ registration: registrations, item: orderItems, order: orders })
            .from(registrations)
            .leftJoin(orderItems, eq(orderItems.registrationId, registrations.id))
            .leftJoin(orders, eq(orders.id, orderItems.orderId))
            .where(
              inArray(
                registrations.id,
                prior.map((row) => row.registration.id),
              ),
            );
        // This ticket lock serializes the final stock check across purchasers.
        await tx
          .select({ id: ticketTypes.id })
          .from(ticketTypes)
          .where(eq(ticketTypes.id, input.ticketTypeId))
          .for('update');
        const source = await this.source(tx, input, customer);
        const quote = await this.quote(input, customer, tx, source);
        if (
          quote.quoteFingerprint !== input.quoteFingerprint ||
          input.formVersion !== source.form.version ||
          input.termsVersion !== source.form.termsVersion
        )
          batchConflict('票价、报名表或条款已更新，请核对后重新确认', {
            quote,
            code: 'QUOTE_CHANGED',
          });
        attendees = normalizeBatchAttendees(input.attendees, normalizedLogin, source.form.fields);
        let offer: typeof waitlistEntries.$inferSelect | undefined;
        if (input.waitlistOfferToken) {
          [offer] = await tx
            .select()
            .from(waitlistEntries)
            .where(
              and(
                eq(waitlistEntries.offerTokenHash, batchTokenHash(input.waitlistOfferToken)),
                eq(waitlistEntries.eventId, input.eventId),
                eq(waitlistEntries.ticketTypeId, input.ticketTypeId),
                eq(waitlistEntries.status, 'invited'),
                gt(waitlistEntries.expiresAt, new Date()),
                or(
                  eq(waitlistEntries.mobileE164, normalizedLogin),
                  and(
                    eq(waitlistEntries.customerUserId, customer.customerUserId),
                    eq(waitlistEntries.organizationId, customer.organizationId),
                  ),
                ),
              ),
            )
            .for('update')
            .limit(1);
          if (!offer || input.quantity !== 1 || !attendees[0]?.isSelf)
            batchConflict('候补购买资格无效或已经过期');
          // Exchange this invitation's hold and retain the signed balance after a release rollback.
          if ((await this.availableInventory(tx, input, source, offer.id)) < 1)
            batchConflict('当前可购买名额不足，请调整数量', { quote });
        }
        if (
          quote.blockedReason &&
          !(
            offer &&
            !quote.pendingOrderId &&
            quote.remainingSeatCount >= 1 &&
            source.event.status === 'registration_open' &&
            source.settings.registrationOpen &&
            quote.blockedReason === '当前可购买名额不足，请调整数量'
          )
        )
          batchConflict(quote.blockedReason, { quote });
        if (
          !source.settings.additionalPurchaseEnabled &&
          (input.quantity > 1 || attendees.some((row) => !row.isSelf))
        )
          batchConflict('当前大会仅开放本人单名额报名');
        const now = new Date();
        const [attempts] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(registrationPurchaseAttempts)
          .where(
            and(
              eq(registrationPurchaseAttempts.purchaserCustomerUserId, customer.customerUserId),
              eq(registrationPurchaseAttempts.eventId, input.eventId),
              gt(registrationPurchaseAttempts.createdAt, new Date(now.getTime() - 10 * 60_000)),
            ),
          );
        if ((attempts?.count ?? 0) >= 10)
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '报名尝试过于频繁，请10分钟后再试',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        const replacements = new Map<string, string>();
        const newRegistrationIds = attendees.map(() => randomUUID());
        for (const old of prior) {
          const targetIndex = attendees.findIndex(
            (row) =>
              row.attendee.mobile === old.registration.attendeeMobileE164 ||
              (row.isSelf && old.registration.customerUserId === customer.customerUserId),
          );
          const target = attendees[targetIndex];
          if (
            !target ||
            !old.item ||
            !old.order ||
            old.item.state !== 'cancelled' ||
            old.order.refundExecutionMode === 'external_hold'
          )
            batchConflict('该参会人已有报名记录，请核对', {
              clientId: target?.clientId,
              field: 'mobile',
            });
          const [unsettled] = await tx
            .select({ id: payments.id })
            .from(payments)
            .where(
              and(
                eq(payments.orderId, old.order.id),
                inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
              ),
            )
            .limit(1);
          const [refund] = await tx
            .select({ id: refundRequests.id })
            .from(refundRequests)
            .leftJoin(refundRequestItems, eq(refundRequestItems.refundRequestId, refundRequests.id))
            .where(
              and(
                eq(refundRequests.orderId, old.order.id),
                isNull(refundRequests.terminatedAt),
                or(eq(refundRequestItems.orderItemId, old.item.id), isNull(refundRequestItems.id)),
              ),
            )
            .limit(1);
          const [notice] = await tx
            .select({ id: paymentNotificationInbox.id })
            .from(paymentNotificationInbox)
            .where(
              and(
                eq(paymentNotificationInbox.orderId, old.order.id),
                sql`${paymentNotificationInbox.status} <> 'processed'`,
              ),
            )
            .limit(1);
          if (unsettled || refund || notice || old.order.entitlementsOnHold)
            batchConflict('该参会人的原订单仍在处理，请稍后重试', {
              clientId: target.clientId,
              field: 'mobile',
            });
          if (replacements.has(old.registration.id))
            batchConflict('参会身份存在冲突，请联系主办方');
          replacements.set(old.registration.id, newRegistrationIds[targetIndex]!);
          await tx
            .update(registrations)
            .set({ supersededAt: now, updatedAt: now })
            .where(eq(registrations.id, old.registration.id));
          await tx
            .update(attendeeClaimTokens)
            .set({ revokedAt: now })
            .where(
              and(
                eq(attendeeClaimTokens.registrationId, old.registration.id),
                isNull(attendeeClaimTokens.revokedAt),
              ),
            );
        }
        await eraseUnavailableClaimInvitationReplays(tx, now, [...replacements.keys()]);
        const [activeCustomer] = await tx
          .select({ id: customerUsers.id, status: customerUsers.status })
          .from(customerUsers)
          .where(
            and(
              eq(customerUsers.id, customer.customerUserId),
              eq(customerUsers.organizationId, customer.organizationId),
            ),
          )
          .for('update')
          .limit(1);
        if (!activeCustomer || activeCustomer.status !== 'active')
          throw new DomainError(
            API_ERROR_CODES.UNAUTHORIZED,
            '请重新登录后报名',
            HttpStatus.UNAUTHORIZED,
          );
        const expiresAt = new Date(
          now.getTime() + (source.manualReview ? BATCH_REVIEW_WINDOW_MS : BATCH_PAYMENT_WINDOW_MS),
        );
        const amount = batchAmount(source.unitPrice, input.quantity);
        const registrationRows = await tx
          .insert(registrations)
          .values(
            attendees.map((row, index) => ({
              id: newRegistrationIds[index]!,
              organizationId: customer.organizationId,
              eventId: input.eventId,
              ticketTypeId: input.ticketTypeId,
              customerUserId: row.isSelf ? customer.customerUserId : null,
              registrationCode: `TOK-R-${nanoid(8).toUpperCase()}`,
              status: source.manualReview
                ? ('pending_review' as const)
                : ('pending_payment' as const),
              attendee: row.attendee,
              attendeeMobileE164: row.attendee.mobile,
              attendeeEmailNormalized: row.attendee.email,
              invoiceRequired: false,
              marketingConsent: row.marketingConsent,
              formVersion: input.formVersion,
              termsVersion: input.termsVersion,
              formAnswers: row.formAnswers,
              consentSnapshot: {
                termsAccepted: true,
                marketingConsent: row.marketingConsent,
                purchaseFor: row.isSelf ? 'self' : 'other',
                proxyAuthorizationAccepted: input.proxyAuthorizationAccepted,
                acceptedAt: now.toISOString(),
                termsContent: source.form.termsContent,
                fieldDefinitions: source.form.fields,
              },
            })),
          )
          .returning();
        for (const [oldId, newId] of replacements)
          await tx
            .update(registrations)
            .set({ supersededByRegistrationId: newId })
            .where(eq(registrations.id, oldId));
        const pricingSnapshot = {
          refundPolicy: refundPolicy(source.event.settings),
          ticketTypeId: input.ticketTypeId,
          name: source.releasedTicket.name,
          unitPrice: source.unitPrice,
          amount,
          quantity: input.quantity,
          currency: quote.currency,
          paymentMode: source.settings.paymentMode,
          releaseId: source.currentReleaseId,
          purchaseRequestHash: requestHash,
          quoteFingerprint: quote.quoteFingerprint,
          manualReview: source.manualReview,
        };
        const [order] = await tx
          .insert(orders)
          .values({
            modelVersion: 2,
            quantity: input.quantity,
            organizationId: customer.organizationId,
            eventId: input.eventId,
            registrationId: input.quantity === 1 ? newRegistrationIds[0]! : null,
            orderNo: `TOK${now.getFullYear()}${nanoid(10).toUpperCase()}`,
            status: source.manualReview ? 'pending_review' : 'pending_payment',
            amount,
            currency: quote.currency,
            pricingSnapshot,
            purchaserCustomerUserId: customer.customerUserId,
            purchaserSnapshot: {
              customerUserId: customer.customerUserId,
              mobile: normalizedLogin,
              name: customer.profile.realName || customer.profile.nickname || '',
              email: customer.profile.email || '',
              company: customer.profile.company || '',
              title: customer.profile.title || '',
              city: customer.profile.city || '',
            },
            purchaseIntentId: input.purchaseIntentId,
            expiresAt,
          })
          .returning();
        const itemRows = await tx
          .insert(orderItems)
          .values(
            attendees.map((row, index) => ({
              orderId: order!.id,
              registrationId: newRegistrationIds[index]!,
              organizationId: customer.organizationId,
              eventId: input.eventId,
              clientId: row.clientId,
              position: index + 1,
              ticketTypeId: input.ticketTypeId,
              unitPrice: source.unitPrice,
              allocatedAmount: source.unitPrice,
              pricingSnapshot: {
                name: source.releasedTicket.name,
                unitPrice: source.unitPrice,
                currency: quote.currency,
              },
            })),
          )
          .returning();
        await tx.insert(inventoryReservations).values(
          itemRows.map((item) => ({
            orderId: order!.id,
            orderItemId: item.id,
            eventId: input.eventId,
            ticketTypeId: input.ticketTypeId,
            quantity: 1,
            expiresAt,
          })),
        );
        if (offer)
          await tx
            .update(waitlistEntries)
            .set({ status: 'claimed', claimedAt: now, updatedAt: now })
            .where(eq(waitlistEntries.id, offer.id));
        if (amount === 0 && !source.manualReview) {
          const [payment] = await tx
            .insert(payments)
            .values({
              orderId: order!.id,
              provider: 'free',
              externalId: `free:${order!.id}`,
              status: 'succeeded',
              succeededAt: now,
              amount: 0,
              currency: quote.currency,
              payload: { quantity: input.quantity },
            })
            .returning();
          await this.items.issue(tx, order!, payment!.id, now);
        }
        await tx
          .insert(registrationPurchaseAttempts)
          .values({
            organizationId: customer.organizationId,
            eventId: input.eventId,
            purchaserCustomerUserId: customer.customerUserId,
            purchaseIntentId: input.purchaseIntentId,
          })
          .onConflictDoNothing();
        await tx
          .update(customerUsers)
          .set({ lastRegistrationAt: now, updatedAt: now })
          .where(eq(customerUsers.id, customer.customerUserId));
        await tx.insert(orderStateLogs).values({
          orderId: order!.id,
          fromStatus: null,
          toStatus: source.manualReview
            ? 'pending_review'
            : amount === 0
              ? 'paid'
              : 'pending_payment',
          reason: '统一提交参会名额',
          metadata: { quantity: input.quantity },
        });
        await tx.insert(outboxEvents).values({
          organizationId: customer.organizationId,
          eventId: input.eventId,
          eventType: 'RegistrationSubmitted',
          correlationId: `batch:submitted:${order!.id}`,
          payload: {
            orderId: order!.id,
            quantity: input.quantity,
            registrationIds: registrationRows.map((row) => row.id),
            recipient: customer.profile.email || normalizedLogin,
            recipientRole: 'purchaser',
          },
        });
        await tx.insert(auditLogs).values({
          organizationId: customer.organizationId,
          eventId: input.eventId,
          actorId: customer.customerUserId,
          actorType: 'customer',
          action: 'registration.batch.created',
          resourceType: 'order',
          resourceId: order!.id,
          after: { quantity: input.quantity, amount },
          traceId: key,
        });
        const [current] = await tx.select().from(orders).where(eq(orders.id, order!.id));
        const response = await this.items.checkout(tx, current!, customer.customerUserId);
        await tx.insert(idempotencyKeys).values({
          scope,
          key,
          requestHash,
          responseCode: 201,
          responseBody: { orderId: order!.id },
          expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
        });
        return { ...response, orderAccessToken: await this.items.accessToken(tx, order!.id) };
      }),
    );
  }
}
