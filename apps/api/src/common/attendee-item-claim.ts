import { eraseUnavailableClaimInvitationReplays } from '@conference/database';
import { HttpStatus } from '@nestjs/common';
import { API_ERROR_CODES, type AttendeeClaimInput } from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  attendeeClaimTokens,
  auditLogs,
  customerUsers,
  idempotencyKeys,
  orderItems,
  orders,
  outboxEvents,
  payments,
  registrations,
  tickets,
} from '@conference/database';
import { sha256 } from '@conference/security';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import { DomainError } from './domain-error.js';
import { guardRefundWrite } from './refund-write-guard.js';
import { OrderItemsService, type BatchDatabase } from './order-items.service.js';
import { withPostgresTransactionRetry } from './transaction-retry.js';

function conflict(message: string): never {
  throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION, message, HttpStatus.CONFLICT);
}
function invalid(): never {
  throw new DomainError(
    API_ERROR_CODES.UNAUTHORIZED,
    '参会名额认领凭证无效或已经过期',
    HttpStatus.UNAUTHORIZED,
  );
}

/** Claim the selected attendee only; account ownership never grants access to the purchaser's finances. */
export async function claimAttendeeItem(
  db: BatchDatabase,
  items: OrderItemsService,
  session: AuthenticatedCustomer,
  input: AttendeeClaimInput,
) {
  return withPostgresTransactionRetry(() =>
    db.transaction(async (tx) => {
      const now = new Date();
      const [identity] = await tx
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.id, input.registrationId),
            eq(registrations.organizationId, session.organizationId),
            isNull(registrations.supersededAt),
          ),
        )
        .limit(1);
      if (!identity) invalid();
      const keys = [
        `customer-user:${session.organizationId}:${session.customer.mobile}`,
        `registration-customer:${identity.eventId}:${session.customerUserId}`,
        `registration-mobile:${identity.eventId}:${identity.attendeeMobileE164}`,
      ].sort();
      for (const key of keys)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
      const orderRows = await tx
        .select({ order: orders, item: orderItems })
        .from(orders)
        .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(
          and(
            eq(orders.organizationId, session.organizationId),
            eq(orders.eventId, identity.eventId),
            or(eq(orderItems.registrationId, identity.id), eq(orders.registrationId, identity.id)),
          ),
        );
      const observed =
        orderRows.find((row) => row.item?.registrationId === identity.id) ?? orderRows[0];
      if (!observed) invalid();
      const previousIdentityRows = await tx
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.organizationId, session.organizationId),
            eq(registrations.eventId, identity.eventId),
            eq(registrations.customerUserId, session.customerUserId),
            isNull(registrations.supersededAt),
            sql`${registrations.id} <> ${identity.id}`,
          ),
        );
      const previousScopes = previousIdentityRows.length
        ? await tx
            .select({ orderId: orderItems.orderId })
            .from(orderItems)
            .where(
              inArray(
                orderItems.registrationId,
                previousIdentityRows.map((row) => row.id),
              ),
            )
        : [];
      const relatedOrderIds = [
        ...new Set([observed.order.id, ...previousScopes.map((row) => row.orderId)]),
      ].sort();
      for (const id of relatedOrderIds)
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`wechatpay:prepare:${id}`},0))`,
        );
      await tx
        .select({ id: orders.id })
        .from(orders)
        .where(inArray(orders.id, relatedOrderIds))
        .orderBy(asc(orders.id))
        .for('update');
      await items.lockOrderItems(tx, relatedOrderIds);
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, observed.order.id))
        .for('update')
        .limit(1);
      if (!order) invalid();

      const [registration] = await tx
        .select()
        .from(registrations)
        .where(and(eq(registrations.id, identity.id), isNull(registrations.supersededAt)))
        .for('update')
        .limit(1);
      const [claim] = await tx
        .select()
        .from(attendeeClaimTokens)
        .where(
          and(
            eq(attendeeClaimTokens.registrationId, identity.id),
            eq(attendeeClaimTokens.tokenHash, sha256(input.claimToken)),
          ),
        )
        .for('update')
        .limit(1);
      if (!registration || !claim || claim.consumedAt || claim.revokedAt || claim.expiresAt <= now)
        invalid();
      if (
        claim.mobileDigest !== sha256(session.customer.mobile) ||
        registration.attendeeMobileE164 !== session.customer.mobile
      )
        throw new DomainError(
          API_ERROR_CODES.FORBIDDEN,
          '请使用参会人报名手机号登录后认领',
          HttpStatus.FORBIDDEN,
        );
      if (registration.customerUserId && registration.customerUserId !== session.customerUserId)
        conflict('该参会名额已经被其他账号认领');
      await guardRefundWrite(tx, order.id, false, {
        purpose: 'admission',
        registrationId: registration.id,
      });
      if (order.modelVersion === 2) {
        const [item] = await tx
          .select()
          .from(orderItems)
          .where(
            and(eq(orderItems.orderId, order.id), eq(orderItems.registrationId, registration.id)),
          )
          .limit(1);
        const [ticket] = await tx
          .select()
          .from(tickets)
          .where(eq(tickets.registrationId, registration.id))
          .limit(1);
        if (
          !order.settledPaymentId ||
          item?.state !== 'active' ||
          !ticket ||
          ticket.status === 'cancelled' ||
          ticket.refundPausedBy
        )
          conflict('该名额尚未完成支付或已经关闭，暂不能认领');
      } else if (['draft', 'cancelled'].includes(registration.status))
        conflict('当前报名状态无法认领');
      const previous = await tx
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.organizationId, session.organizationId),
            eq(registrations.eventId, registration.eventId),
            eq(registrations.customerUserId, session.customerUserId),
            isNull(registrations.supersededAt),
            sql`${registrations.id} <> ${registration.id}`,
          ),
        )
        .orderBy(asc(registrations.id));
      for (const old of previous) {
        // Ended attendance can be replaced only after its money and selected rights have settled.
        const [oldScope] = await tx
          .select({ item: orderItems, order: orders })
          .from(orderItems)
          .innerJoin(orders, eq(orders.id, orderItems.orderId))
          .where(eq(orderItems.registrationId, old.id));
        if (
          !oldScope ||
          !relatedOrderIds.includes(oldScope.order.id) ||
          oldScope.item.state !== 'cancelled' ||
          oldScope.order.entitlementsOnHold ||
          oldScope.order.refundExecutionMode === 'external_hold'
        )
          conflict('当前账号已经拥有本场大会的报名记录');
        const [pending] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(
            and(
              eq(payments.orderId, oldScope.order.id),
              inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
            ),
          )
          .limit(1);
        if (pending) conflict('原报名订单仍在处理，请稍后再认领');
        await guardRefundWrite(tx, oldScope.order.id, false, {
          purpose: 'rights',
          orderItemId: oldScope.item.id,
        });
        await tx
          .update(registrations)
          .set({ supersededAt: now, supersededByRegistrationId: registration.id, updatedAt: now })
          .where(eq(registrations.id, old.id));
        await tx
          .update(attendeeClaimTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(attendeeClaimTokens.registrationId, old.id),
              isNull(attendeeClaimTokens.revokedAt),
            ),
          );
      }
      const [user] = await tx
        .select({ id: customerUsers.id, status: customerUsers.status })
        .from(customerUsers)
        .where(
          and(
            eq(customerUsers.id, session.customerUserId),
            eq(customerUsers.organizationId, session.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!user || user.status !== 'active') invalid();
      await tx
        .update(attendeeClaimTokens)
        .set({ consumedAt: now })
        .where(eq(attendeeClaimTokens.id, claim.id));
      await tx
        .update(attendeeClaimTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(attendeeClaimTokens.registrationId, registration.id),
            isNull(attendeeClaimTokens.consumedAt),
            isNull(attendeeClaimTokens.revokedAt),
          ),
        );
      await eraseUnavailableClaimInvitationReplays(tx, now, [
        registration.id,
        ...previous.map((row) => row.id),
      ]);
      await tx
        .update(registrations)
        .set({ customerUserId: session.customerUserId, updatedAt: now })
        .where(eq(registrations.id, registration.id));
      if (observed.item) {
        await tx
          .update(orderItems)
          .set({ version: sql`${orderItems.version} + 1`, updatedAt: now })
          .where(eq(orderItems.id, observed.item.id));
        await tx
          .update(idempotencyKeys)
          .set({ responseBody: sql`${idempotencyKeys.responseBody} - 'sealedToken'` })
          .where(eq(sql`${idempotencyKeys.responseBody}->>'tokenId'`, claim.id));
      }
      if (order.modelVersion === 2) {
        const [ticket] = await tx
          .select({ id: tickets.id })
          .from(tickets)
          .where(eq(tickets.registrationId, registration.id))
          .limit(1);
        if (ticket)
          await tx
            .insert(outboxEvents)
            .values({
              organizationId: order.organizationId,
              eventId: order.eventId,
              eventType: 'TicketIssued',
              correlationId: `claimed:ticket:${claim.id}`,
              payload: {
                orderId: order.id,
                orderItemId: observed.item?.id,
                registrationId: registration.id,
                ticketId: ticket.id,
                recipientRole: 'attendee',
              },
            });
      }
      await tx
        .update(customerUsers)
        .set({
          lastRegistrationAt: sql`greatest(coalesce(${customerUsers.lastRegistrationAt}, '-infinity'::timestamptz), ${registration.createdAt})`,
          updatedAt: now,
        })
        .where(eq(customerUsers.id, session.customerUserId));
      await tx
        .insert(auditLogs)
        .values({
          organizationId: session.organizationId,
          eventId: registration.eventId,
          actorId: session.customerUserId,
          actorType: 'customer',
          action: 'customer.attendee.claim',
          resourceType: 'registration',
          resourceId: registration.id,
          before: { customerUserId: registration.customerUserId },
          after: { customerUserId: session.customerUserId, claimTokenId: claim.id },
          traceId: crypto.randomUUID(),
        });
      return now;
    }),
  );
}
