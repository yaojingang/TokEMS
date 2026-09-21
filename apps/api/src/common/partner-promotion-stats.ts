import type { PartnerPromotionStats } from '@conference/contracts';
import {
  partnerCommissions,
  partnerReferralVisitDays,
  type ConferenceDatabase,
} from '@conference/database';
import { and, eq, sql, sum } from 'drizzle-orm';

/** Cumulative promotion totals. Daily unique visits are not unique people across dates. */
export async function readPartnerPromotionStats(
  db: ConferenceDatabase,
  organizationId: string,
  eventId: number,
  partnerId?: string,
): Promise<PartnerPromotionStats> {
  const [[visits], [sales]] = await Promise.all([
    db
      .select({
        visits: sum(partnerReferralVisitDays.visits),
        uniqueDailyVisits: sum(partnerReferralVisitDays.uniqueVisits),
      })
      .from(partnerReferralVisitDays)
      .where(
        and(
          eq(partnerReferralVisitDays.organizationId, organizationId),
          eq(partnerReferralVisitDays.eventId, eventId),
          partnerId ? eq(partnerReferralVisitDays.partnerId, partnerId) : undefined,
        ),
      ),
    db
      .select({
        paidOrders: sql<number>`count(*) filter (where ${partnerCommissions.eligibleAmount} > 0)`,
        netSalesAmount: sql<string>`coalesce(sum(greatest(0, ${partnerCommissions.eligibleAmount})), 0)`,
        netCommissionAmount: sql<string>`coalesce(sum(greatest(0, ${partnerCommissions.commissionAmount} - ${partnerCommissions.reversedAmount})), 0)`,
      })
      .from(partnerCommissions)
      .where(
        and(
          eq(partnerCommissions.organizationId, organizationId),
          eq(partnerCommissions.eventId, eventId),
          partnerId ? eq(partnerCommissions.partnerId, partnerId) : undefined,
        ),
      ),
  ]);
  return {
    visits: Number(visits?.visits ?? 0),
    uniqueDailyVisits: Number(visits?.uniqueDailyVisits ?? 0),
    paidOrders: Number(sales?.paidOrders ?? 0),
    netSalesAmount: Number(sales?.netSalesAmount ?? 0),
    netCommissionAmount: Number(sales?.netCommissionAmount ?? 0),
  };
}
