import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  publicEventScopedPath,
  type ClaimInvitationResult,
  type GenerateClaimInvitation,
} from '@conference/contracts';
import {
  attendeeClaimTokens,
  auditLogs,
  events,
  idempotencyKeys,
  orderItems,
  orders,
} from '@conference/database';
import { openSecret, sealSecret } from '@conference/security';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DomainError } from './domain-error.js';
import { batchConflict } from './batch-purchase-policy.js';
import { idempotencyRequestHash } from './idempotency.service.js';
import {
  notificationPayloadSecret,
  OrderItemsService,
  type BatchCustomer,
} from './order-items.service.js';

@Injectable()
export class BatchClaimInvitationService {
  constructor(@Inject(OrderItemsService) private readonly items: OrderItemsService) {}

  async generate(
    orderId: string,
    itemId: string,
    input: GenerateClaimInvitation,
    key: string,
    customer: BatchCustomer,
  ): Promise<ClaimInvitationResult> {
    const scope = `claim-invitation:${idempotencyRequestHash([customer.organizationId, customer.customerUserId, itemId])}`;
    const requestHash = idempotencyRequestHash({ orderId, itemId, input });
    return this.items.db().transaction(async (tx) => {
      await this.items.requireOrder(tx, orderId, customer);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${scope}:${key}`},0))`);
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      await this.items.requireOrder(tx, orderId, customer);
      if (!order || order.modelVersion !== 2) batchConflict('该订单请使用现有认领入口');
      const [event] = await tx
        .select({ slug: events.slug })
        .from(events)
        .where(eq(events.id, order.eventId))
        .limit(1);
      if (!event) batchConflict('大会不存在');
      await this.items.lockItems(tx, orderId);
      const rows = await this.items.rows(tx, orderId);
      const row = rows.find((candidate) => candidate.item.id === itemId);
      if (!row)
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '名额不存在', HttpStatus.NOT_FOUND);
      const now = new Date();
      const [cached] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
        .limit(1);
      if (cached) {
        if (cached.requestHash !== requestHash) batchConflict('相同请求标识对应了不同的邀请操作');
        const response = cached.responseBody as {
          tokenId: string;
          sealedToken?: string;
          replayUntil: string;
          expiresAt: string;
          version: number;
        };
        const [active] = await tx
          .select({ id: attendeeClaimTokens.id })
          .from(attendeeClaimTokens)
          .where(
            and(
              eq(attendeeClaimTokens.id, response.tokenId),
              eq(attendeeClaimTokens.registrationId, row.registration.id),
              isNull(attendeeClaimTokens.revokedAt),
              isNull(attendeeClaimTokens.consumedAt),
              gt(attendeeClaimTokens.expiresAt, now),
            ),
          )
          .limit(1);
        const replayAvailable =
          Boolean(active && response.sealedToken) &&
          !row.registration.customerUserId &&
          row.item.state === 'active' &&
          row.ticket?.status === 'valid' &&
          !row.ticket.refundPausedBy &&
          !order.entitlementsOnHold &&
          order.refundExecutionMode !== 'external_hold' &&
          new Date(response.replayUntil) > now;
        if (!replayAvailable && response.sealedToken)
          await tx
            .update(idempotencyKeys)
            .set({ responseBody: sql`${idempotencyKeys.responseBody} - 'sealedToken'` })
            .where(eq(idempotencyKeys.id, cached.id));
        return {
          itemId,
          version: row.item.version,
          claimUrl: replayAvailable
            ? this.claimUrl(
                event.slug,
                row.registration.id,
                openSecret(response.sealedToken!, notificationPayloadSecret()),
              )
            : null,
          expiresAt: response.expiresAt,
          replayAvailable,
        };
      }
      if (row.item.version !== input.expectedVersion) batchConflict('名额信息已经更新，请刷新');
      const checkout = await this.items.checkout(tx, order, customer.customerUserId);
      if (!checkout.items.find((item) => item.id === itemId)?.canGenerateInvitation)
        batchConflict('当前名额无法生成认领邀请');
      const [recent] = await tx
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.resourceId, itemId),
            eq(auditLogs.action, 'order.item.claim_invitation'),
            gt(auditLogs.createdAt, new Date(now.getTime() - 10 * 60_000)),
          ),
        )
        .limit(1);
      if (recent)
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '认领邀请10分钟内只能重新生成一次',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      const invitation = await this.items.createInvitation(
        tx,
        order,
        row.item,
        row.registration,
        now,
        input.notify,
      );
      const version = row.item.version + 1;
      await tx.update(orderItems).set({ version, updatedAt: now }).where(eq(orderItems.id, itemId));
      await tx
        .insert(auditLogs)
        .values({
          organizationId: order.organizationId,
          eventId: order.eventId,
          actorId: customer.customerUserId,
          actorType: 'customer',
          action: 'order.item.claim_invitation',
          resourceType: 'order_item',
          resourceId: itemId,
          after: { tokenId: invitation.tokenId, notify: input.notify, version },
          traceId: key,
        });
      await tx
        .insert(idempotencyKeys)
        .values({
          scope,
          key,
          requestHash,
          responseCode: 200,
          responseBody: {
            tokenId: invitation.tokenId,
            sealedToken: sealSecret(invitation.token, notificationPayloadSecret()),
            replayUntil: new Date(now.getTime() + 10 * 60_000).toISOString(),
            expiresAt: invitation.expiresAt.toISOString(),
            version,
          },
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
        });
      return {
        itemId,
        version,
        claimUrl: this.claimUrl(event.slug, row.registration.id, invitation.token),
        expiresAt: invitation.expiresAt.toISOString(),
        replayAvailable: true,
      };
    });
  }

  private claimUrl(eventSlug: string, registrationId: string, token: string) {
    return `${publicEventScopedPath('/account/attendee-claim', eventSlug)}#registration=${encodeURIComponent(registrationId)}&claim=${encodeURIComponent(token)}`;
  }
}
