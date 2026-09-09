import {
  feishuDigestReportWindow,
  type FeishuDigestSnapshotV2,
  type EventId,
} from '@conference/contracts';
import { and, count, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { ConferenceDatabase } from './index.js';
import {
  checkinRecords,
  cooperationRequests,
  eventPublicMetricDays,
  eventPublicMetrics,
  events,
  invoiceRequests,
  invoiceStateLogs,
  inventoryReservations,
  orders,
  payments,
  refunds,
  refundRequests,
  registrations,
  ticketTypes,
  waitlistEntries,
} from './schema.js';
import {
  refundAttentionCondition,
  refundCurrentExecutionCondition,
  refundReportingSuccessTime,
  refundReportingSuccessLowerBound,
  refundReportingSuccessUpperBound,
} from './refund-reporting-policy.js';
import { activeInventoryReservationAt } from './inventory-reservation-policy.js';

export class FeishuDigestEventNotFoundError extends Error {
  constructor() {
    super('大会不存在或无权访问');
    this.name = 'FeishuDigestEventNotFoundError';
  }
}

export function feishuMetricInteger(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('飞书日报指标超出 JavaScript 安全整数范围');
  }
  return parsed;
}

function numeric(value: unknown) {
  return feishuMetricInteger(value);
}

export function hasCompleteFeishuPageViewDay(input: {
  dailyTrackingStartedAt: Date | null | undefined;
  windowStart: Date;
  eventTimezone: string;
  metricTimezone: string | null | undefined;
}) {
  return Boolean(
    input.dailyTrackingStartedAt &&
    input.dailyTrackingStartedAt <= input.windowStart &&
    (!input.metricTimezone || input.metricTimezone === input.eventTimezone),
  );
}

export async function loadFeishuDigestSnapshot(
  db: ConferenceDatabase,
  organizationId: string,
  eventId: EventId,
  options: { now?: Date; reportDate?: string } = {},
): Promise<FeishuDigestSnapshotV2> {
  return db.transaction(
    async (snapshotDb) => {
      await snapshotDb.execute(sql`set local statement_timeout = '30s'`);
      const generatedAt = options.now ?? new Date();
      const [event] = await snapshotDb
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          status: events.status,
          timezone: events.timezone,
        })
        .from(events)
        .where(and(eq(events.organizationId, organizationId), eq(events.id, eventId)))
        .limit(1);
      if (!event) throw new FeishuDigestEventNotFoundError();

      const window = feishuDigestReportWindow(generatedAt, event.timezone, options.reportDate);
      const paymentExceptionCutoff = new Date(generatedAt.valueOf() - 10 * 60_000);
      const availableInventory = sql<number>`greatest(
    ${ticketTypes.capacity} - ${ticketTypes.sold}
      - coalesce((
        select sum(${inventoryReservations.quantity})
        from ${inventoryReservations}
        where inventory_reservations.ticket_type_id = ticket_types.id
          and ${inventoryReservations.convertedAt} is null
          and ${inventoryReservations.releasedAt} is null
          and (${activeInventoryReservationAt(generatedAt)})
      ), 0)
      - coalesce((
        select count(*)
        from ${waitlistEntries}
        where waitlist_entries.ticket_type_id = ticket_types.id
          and ${waitlistEntries.status} = 'invited'
          and ${waitlistEntries.expiresAt} > ${generatedAt}
      ), 0),
    0
  )`;

      const [
        [dailyPublicMetric],
        [publicMetric],
        [dailyRegistration],
        [cumulativeRegistration],
        [dailyPayment],
        [cumulativeOrder],
        [dailyRefund],
        [dailyInvoice],
        [invoiceSubmissions],
        [refundApplications],
        [refundQuality],
        [currencyQuality],
        [invoiceTodo],
        [dailyCheckin],
        [cumulativeCheckin],
        [paymentTodo],
        [cooperationTodo],
        [inventory],
      ] = [
        await snapshotDb
          .select({
            pageViews: eventPublicMetricDays.pageViews,
            timezoneSnapshot: eventPublicMetricDays.timezoneSnapshot,
          })
          .from(eventPublicMetricDays)
          .where(
            and(
              eq(eventPublicMetricDays.organizationId, organizationId),
              eq(eventPublicMetricDays.eventId, eventId),
              eq(eventPublicMetricDays.localDate, window.reportDate),
            ),
          )
          .limit(1),
        await snapshotDb
          .select({
            pageViews: eventPublicMetrics.pageViews,
            dailyTrackingStartedAt: eventPublicMetrics.dailyTrackingStartedAt,
          })
          .from(eventPublicMetrics)
          .where(
            and(
              eq(eventPublicMetrics.organizationId, organizationId),
              eq(eventPublicMetrics.eventId, eventId),
            ),
          )
          .limit(1),
        await snapshotDb
          .select({ value: count() })
          .from(registrations)
          .where(
            and(
              eq(registrations.organizationId, organizationId),
              eq(registrations.eventId, eventId),
              or(
                isNull(registrations.supersededAt),
                gte(registrations.supersededAt, window.windowEnd),
              ),
              gte(registrations.createdAt, window.windowStart),
              lt(registrations.createdAt, window.windowEnd),
            ),
          ),
        await snapshotDb
          .select({
            validRegistrations: sql<number>`count(*) filter (where ${registrations.status} in ('pending_review', 'pending_payment', 'confirmed', 'checked_in', 'completed'))::int`,
            confirmedAttendees: sql<number>`count(*) filter (where ${registrations.status} in ('confirmed', 'checked_in', 'completed'))::int`,
            pendingReview: sql<number>`count(*) filter (where ${registrations.status} = 'pending_review')::int`,
          })
          .from(registrations)
          .where(
            and(
              eq(registrations.organizationId, organizationId),
              eq(registrations.eventId, eventId),
              isNull(registrations.supersededAt),
            ),
          ),
        await snapshotDb
          .select({
            paidOrders: sql<number>`count(distinct ${payments.orderId})::int`,
            grossReceipts: sql<string>`coalesce(sum(${payments.amount}), 0)`,
          })
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .where(
            and(
              eq(orders.organizationId, organizationId),
              eq(orders.eventId, eventId),
              inArray(payments.status, ['succeeded', 'refunded']),
              gte(payments.succeededAt, window.windowStart),
              lt(payments.succeededAt, window.windowEnd),
            ),
          ),
        await snapshotDb
          .select({
            paidOrders: sql<number>`count(*) filter (where ${orders.status} in ('paid', 'partially_refunded'))::int`,
            paidSeats: sql<number>`count(*) filter (where ${orders.status} in ('paid', 'partially_refunded') and ${registrations.status} <> 'cancelled' and ${registrations.supersededAt} is null)::int`,
            netRevenue: sql<string>`coalesce(sum(
          case when ${orders.status} in ('paid', 'partially_refunded', 'refunded')
            then greatest(
              ${orders.amount} - coalesce((
                select sum(successful_refund.amount)
                from ${refunds} successful_refund
                where successful_refund.order_id = ${orders.id}
                  and successful_refund.status = 'succeeded'
              ), 0),
              0
            )
            else 0
          end
        ), 0)`,
          })
          .from(orders)
          .innerJoin(registrations, eq(registrations.id, orders.registrationId))
          .where(and(eq(orders.organizationId, organizationId), eq(orders.eventId, eventId))),
        await snapshotDb
          .select({
            successfulRefunds: count(),
            refundAmount: sql<string>`coalesce(sum(${refunds.amount}), 0)`,
          })
          .from(refunds)
          .where(
            and(
              eq(refunds.organizationId, organizationId),
              eq(refunds.eventId, eventId),
              eq(refunds.status, 'succeeded'),
              sql`${refundReportingSuccessTime()} >= ${window.windowStart}`,
              sql`${refundReportingSuccessTime()} < ${window.windowEnd}`,
            ),
          ),
        await snapshotDb
          .select({ value: count() })
          .from(invoiceRequests)
          .where(
            and(
              eq(invoiceRequests.organizationId, organizationId),
              eq(invoiceRequests.eventId, eventId),
              gte(invoiceRequests.createdAt, window.windowStart),
              lt(invoiceRequests.createdAt, window.windowEnd),
            ),
          ),
        await snapshotDb
          .select({ value: sql<number>`count(distinct ${invoiceStateLogs.invoiceRequestId})::int` })
          .from(invoiceStateLogs)
          .innerJoin(invoiceRequests, eq(invoiceRequests.id, invoiceStateLogs.invoiceRequestId))
          .where(
            and(
              eq(invoiceRequests.organizationId, organizationId),
              eq(invoiceRequests.eventId, eventId),
              eq(invoiceStateLogs.toStatus, 'pending_review'),
              sql`${invoiceStateLogs.fromStatus} is distinct from 'pending_review'`,
              gte(invoiceStateLogs.createdAt, window.windowStart),
              lt(invoiceStateLogs.createdAt, window.windowEnd),
            ),
          ),
        await snapshotDb
          .select({
            daily: sql<number>`count(*) filter (where ${refundRequests.createdAt} >= ${window.windowStart} and ${refundRequests.createdAt} < ${window.windowEnd})::int`,
            pendingReview: sql<number>`count(*) filter (where ${refundRequests.reviewStatus} = 'pending_review')::int`,
            waitingFunds: sql<number>`count(*) filter (where ${refundCurrentExecutionCondition('waiting_funds')})::int`,
            processing: sql<number>`count(*) filter (where ${refundCurrentExecutionCondition('processing')})::int`,
            attention: sql<number>`count(*) filter (where ${refundAttentionCondition(generatedAt)})::int`,
          })
          .from(refundRequests)
          .where(
            and(
              eq(refundRequests.organizationId, organizationId),
              eq(refundRequests.eventId, eventId),
            ),
          ),
        await snapshotDb
          .select({ missing: count() })
          .from(refunds)
          .where(
            and(
              eq(refunds.organizationId, organizationId),
              eq(refunds.eventId, eventId),
              eq(refunds.status, 'succeeded'),
              sql`${refundReportingSuccessTime()} is null`,
              sql`(${refundReportingSuccessLowerBound()} is null or ${refundReportingSuccessLowerBound()} < ${window.windowEnd})`,
              sql`(${refundReportingSuccessUpperBound()} is null or ${refundReportingSuccessUpperBound()} >= ${window.windowStart})`,
            ),
          ),
        await snapshotDb
          .select({
            currencies: sql<string[]>`array(select distinct currency from (
              select o.currency from orders o where o.organization_id = ${organizationId} and o.event_id = ${eventId}
              union select p.currency from payments p join orders o on o.id = p.order_id where o.organization_id = ${organizationId} and o.event_id = ${eventId} and p.status in ('succeeded', 'refunded')
              union select r.currency from refunds r where r.organization_id = ${organizationId} and r.event_id = ${eventId} and r.status = 'succeeded'
            ) currencies order by currency)`,
            invalidAmounts: sql<number>`(select count(*) from orders o where o.organization_id = ${organizationId} and o.event_id = ${eventId} and (
              ((o.status in ('paid', 'partially_refunded', 'refunded') or exists (select 1 from refunds r where r.order_id = o.id and r.status = 'succeeded'))
                and (select count(*) from payments p where p.order_id = o.id and p.status in ('succeeded', 'refunded')) <> 1)
              or exists (select 1 from payments p where p.order_id = o.id and p.status in ('succeeded', 'refunded') and p.amount <> o.amount)
              or coalesce((select sum(r.amount) from refunds r where r.order_id = o.id and r.status = 'succeeded'), 0) > coalesce((select sum(p.amount) from payments p where p.order_id = o.id and p.status in ('succeeded', 'refunded')), 0)
            ))::int`,
          })
          .from(events)
          .where(eq(events.id, eventId)),
        await snapshotDb
          .select({
            actionable: sql<number>`count(*) filter (where ${invoiceRequests.status} in ('pending_review', 'issue_failed', 'adjustment_required'))::int`,
            awaitingDetails: sql<number>`count(*) filter (where ${invoiceRequests.status} = 'awaiting_details')::int`,
            issuing: sql<number>`count(*) filter (where ${invoiceRequests.status} = 'issuing')::int`,
          })
          .from(invoiceRequests)
          .where(
            and(
              eq(invoiceRequests.organizationId, organizationId),
              eq(invoiceRequests.eventId, eventId),
            ),
          ),
        await snapshotDb
          .select({ value: count() })
          .from(checkinRecords)
          .where(
            and(
              eq(checkinRecords.eventId, eventId),
              eq(checkinRecords.result, 'accepted'),
              gte(checkinRecords.checkedInAt, window.windowStart),
              lt(checkinRecords.checkedInAt, window.windowEnd),
            ),
          ),
        await snapshotDb
          .select({ value: count() })
          .from(checkinRecords)
          .where(and(eq(checkinRecords.eventId, eventId), eq(checkinRecords.result, 'accepted'))),
        await snapshotDb
          .select({
            exceptions: sql<number>`count(distinct ${payments.orderId}) filter (
          where ${payments.status} in ('query_pending', 'close_pending', 'unknown')
            and ${payments.updatedAt} <= ${paymentExceptionCutoff}
        )::int`,
            pending: sql<number>`count(distinct ${payments.orderId}) filter (
          where ${payments.status} in ('preparing', 'pending', 'processing')
        )::int`,
          })
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .where(and(eq(orders.organizationId, organizationId), eq(orders.eventId, eventId))),
        await snapshotDb
          .select({ value: count() })
          .from(cooperationRequests)
          .where(
            and(
              eq(cooperationRequests.organizationId, organizationId),
              eq(cooperationRequests.eventId, eventId),
              eq(cooperationRequests.status, 'new'),
            ),
          ),
        await snapshotDb
          .select({
            remainingInventory: sql<string>`coalesce(sum(${availableInventory}) filter (where ${ticketTypes.active}), 0)`,
            lowStockTicketTypes: sql<number>`count(*) filter (
          where ${ticketTypes.active}
            and (
              ${availableInventory} <= 20
              or ${availableInventory}::numeric / greatest(${ticketTypes.capacity}, 1) <= 0.1
            )
        )::int`,
            currency: sql<string>`coalesce(min(${ticketTypes.currency}) filter (where ${ticketTypes.active}), 'CNY')`,
          })
          .from(ticketTypes)
          .where(
            and(eq(ticketTypes.organizationId, organizationId), eq(ticketTypes.eventId, eventId)),
          ),
      ];

      const pageViewsAvailable = hasCompleteFeishuPageViewDay({
        dailyTrackingStartedAt: publicMetric?.dailyTrackingStartedAt,
        windowStart: window.windowStart,
        eventTimezone: event.timezone,
        metricTimezone: dailyPublicMetric?.timezoneSnapshot,
      });
      const grossReceipts = numeric(dailyPayment?.grossReceipts);
      const refundAmount = numeric(dailyRefund?.refundAmount);
      const qualityIssues: FeishuDigestSnapshotV2['qualityIssues'] = [];
      const moneyInvalid =
        (currencyQuality?.currencies?.length ?? 0) > 1 ||
        numeric(currencyQuality?.invalidAmounts) > 0;
      const refundTimeMissing = numeric(refundQuality?.missing) > 0;
      const issue = (category: string, paths: string[], description: string) =>
        paths.forEach((metricPath) => qualityIssues.push({ category, metricPath, description }));
      if (!pageViewsAvailable)
        issue(
          'incomplete_day',
          ['daily.pageViews'],
          '昨日访问统计尚未覆盖完整一天，其他指标正常展示。',
        );
      if (moneyInvalid)
        issue(
          'money_quality',
          ['daily.grossReceipts', 'daily.refundAmount', 'daily.netCash', 'cumulative.netRevenue'],
          '金额涉及多币种或异常流水，请到后台按币种核对，数量继续展示。',
        );
      if (refundTimeMissing)
        issue(
          'refund_time_missing',
          ['daily.successfulRefunds', 'daily.refundAmount', 'daily.netCash'],
          '部分退款缺少可信成功时间，本日退款及支付净额暂不可用。',
        );

      return {
        metricVersion: 2,
        event,
        reportDate: window.reportDate,
        windowStart: window.windowStart.toISOString(),
        windowEnd: window.windowEnd.toISOString(),
        generatedAt: generatedAt.toISOString(),
        currency: currencyQuality?.currencies?.[0] ?? inventory?.currency ?? 'CNY',
        qualityIssues,
        pageViewsAvailable,
        daily: {
          pageViews: pageViewsAvailable ? numeric(dailyPublicMetric?.pageViews) : null,
          newRegistrations: numeric(dailyRegistration?.value),
          paidOrders: numeric(dailyPayment?.paidOrders),
          grossReceipts: moneyInvalid ? null : grossReceipts,
          successfulRefunds: refundTimeMissing ? null : numeric(dailyRefund?.successfulRefunds),
          refundAmount: moneyInvalid || refundTimeMissing ? null : refundAmount,
          netCash: moneyInvalid || refundTimeMissing ? null : grossReceipts - refundAmount,
          refundRequests: numeric(refundApplications?.daily),
          invoiceDemands: numeric(dailyInvoice?.value),
          invoiceSubmissions: numeric(invoiceSubmissions?.value),
          checkins: numeric(dailyCheckin?.value),
        },
        cumulative: {
          pageViews: numeric(publicMetric?.pageViews),
          validRegistrations: numeric(cumulativeRegistration?.validRegistrations),
          paidOrders: numeric(cumulativeOrder?.paidOrders),
          paidSeats: numeric(cumulativeOrder?.paidSeats),
          confirmedAttendees: numeric(cumulativeRegistration?.confirmedAttendees),
          netRevenue: moneyInvalid ? null : numeric(cumulativeOrder?.netRevenue),
          remainingInventory: numeric(inventory?.remainingInventory),
          checkins: numeric(cumulativeCheckin?.value),
        },
        todos: {
          refundPendingReview: numeric(refundApplications?.pendingReview),
          refundWaitingFunds: numeric(refundApplications?.waitingFunds),
          refundAttention: numeric(refundApplications?.attention),
          pendingRegistrationReview: numeric(cumulativeRegistration?.pendingReview),
          invoiceActionable: numeric(invoiceTodo?.actionable),
          paymentExceptions: numeric(paymentTodo?.exceptions),
          cooperationRequests: numeric(cooperationTodo?.value),
          lowStockTicketTypes: numeric(inventory?.lowStockTicketTypes),
        },
        monitoring: {
          refundProcessing: numeric(refundApplications?.processing),
          invoiceAwaitingDetails: numeric(invoiceTodo?.awaitingDetails),
          invoiceIssuing: numeric(invoiceTodo?.issuing),
          pendingPayments: numeric(paymentTodo?.pending),
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
