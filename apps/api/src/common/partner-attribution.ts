import {
  eventPartnerProgramVersions,
  eventPartners,
  partnerAttributionRevisions,
  partnerReferralLinks,
} from '@conference/database';
import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { BatchReader } from './order-items.service.js';
import type { PartnerReferralContext } from './partner-distribution.service.js';

export async function partnerAttributionForOrder(reader: BatchReader, orderId: string) {
  const [revision] = await reader
    .select({ id: partnerAttributionRevisions.id })
    .from(partnerAttributionRevisions)
    .where(eq(partnerAttributionRevisions.orderId, orderId))
    .orderBy(desc(partnerAttributionRevisions.orderVersion))
    .limit(1);
  return revision?.id ?? null;
}

export async function lockPartnerAttribution(
  writer: BatchReader,
  order: {
    id: string;
    organizationId: string;
    eventId: number;
    purchaseIntentId: string | null;
    version: number;
    purchaserCustomerUserId: string | null;
    quantity: number;
    amount: number;
    currency: string;
  },
  context: PartnerReferralContext | null,
) {
  let decision: 'attributed' | 'ineligible' | 'expired' | 'no_source' = 'no_source';
  let decisionReason = '订单创建时没有有效推广来源';
  let partnerId: string | null = null;
  let referralLinkId: string | null = null;
  let programVersionId: string | null = null;
  let personalRateBps: number | null = null;
  let attributionExpiresAt: Date | null = null;

  if (context) {
    if (context.organizationId !== order.organizationId || context.eventId !== order.eventId) {
      decision = 'ineligible';
      decisionReason = '推广来源与当前大会不一致';
    } else if (new Date(context.expiresAt).getTime() <= Date.now()) {
      decision = 'expired';
      decisionReason = '推广来源已超过有效期';
    } else {
      const [scope] = await writer
        .select({
          partner: eventPartners,
          link: partnerReferralLinks,
          program: eventPartnerProgramVersions,
        })
        .from(partnerReferralLinks)
        .innerJoin(eventPartners, eq(eventPartners.id, partnerReferralLinks.partnerId))
        .innerJoin(
          eventPartnerProgramVersions,
          eq(eventPartnerProgramVersions.id, eventPartners.currentProgramVersionId),
        )
        .where(
          and(
            eq(partnerReferralLinks.id, context.referralLinkId),
            eq(partnerReferralLinks.partnerId, context.partnerId),
            eq(partnerReferralLinks.status, 'active'),
            isNull(partnerReferralLinks.disabledAt),
            or(isNull(partnerReferralLinks.expiresAt), gt(partnerReferralLinks.expiresAt, new Date())),
            eq(eventPartners.organizationId, order.organizationId),
            eq(eventPartners.eventId, order.eventId),
            eq(eventPartners.qualificationStatus, 'active'),
            eq(eventPartners.attributionEnabled, true),
            eq(eventPartnerProgramVersions.status, 'active'),
            or(isNull(eventPartnerProgramVersions.effectiveAt), lte(eventPartnerProgramVersions.effectiveAt, new Date())),
          ),
        )
        .limit(1);
      if (!scope) {
        decision = 'ineligible';
        decisionReason = '合作伙伴资格或当前规则已变化';
      } else {
        partnerId = scope.partner.id;
        referralLinkId = scope.link.id;
        programVersionId = scope.program.id;
        personalRateBps = scope.partner.personalRateBps;
        attributionExpiresAt = new Date(context.expiresAt);
        if (scope.partner.customerUserId === order.purchaserCustomerUserId) {
          decision = 'ineligible';
          decisionReason = '合作伙伴本人购买的订单不计佣金';
        } else {
          decision = 'attributed';
          decisionReason = '订单使用最后一次有效主动点击来源';
        }
      }
    }
  }

  const [revision] = await writer
    .insert(partnerAttributionRevisions)
    .values({
      organizationId: order.organizationId,
      eventId: order.eventId,
      orderId: order.id,
      purchaseIntentId: order.purchaseIntentId,
      orderVersion: order.version,
      partnerId,
      referralLinkId,
      programVersionId,
      decision,
      decisionReason,
      attributionExpiresAt,
      purchaserCustomerUserId: order.purchaserCustomerUserId,
      personalRateBps,
      orderSnapshot: {
        quantity: order.quantity,
        amount: order.amount,
        currency: order.currency,
        capturedAt: new Date().toISOString(),
      },
      createdBy: 'checkout',
    })
    .onConflictDoNothing()
    .returning({ id: partnerAttributionRevisions.id });
  return revision?.id ?? (await partnerAttributionForOrder(writer, order.id));
}
