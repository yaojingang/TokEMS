import {
  feishuDigestReportWindow,
  type FeishuDigestSnapshot,
  type EventId,
} from '@conference/contracts';
import { and, count, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { ConferenceDatabase } from './index.js';
import {
  checkinRecords,
  cooperationRequests,
  eventPublicMetricDays,
  eventPublicMetrics,
  events,
  invoiceRequests,
  inventoryReservations,
  orders,
  payments,
  refunds,
  registrations,
  ticketTypes,
  waitlistEntries,
} from './schema.js';

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
): Promise<FeishuDigestSnapshot> {
  return db.transaction(
    async (snapshotDb) => {
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
        where ${inventoryReservations.ticketTypeId} = ${ticketTypes.id}
          and ${inventoryReservations.convertedAt} is null
          and ${inventoryReservations.releasedAt} is null
          and ${inventoryReservations.expiresAt} > ${generatedAt}
      ), 0)
      - coalesce((
        select count(*)
        from ${waitlistEntries}
        where ${waitlistEntries.ticketTypeId} = ${ticketTypes.id}
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
        [invoiceTodo],
        [dailyCheckin],
        [cumulativeCheckin],
        [paymentTodo],
        [cooperationTodo],
        [inventory],
      ] = await Promise.all([
        snapshotDb
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
        snapshotDb
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
        snapshotDb
          .select({ value: count() })
          .from(registrations)
          .where(
            and(
              eq(registrations.organizationId, organizationId),
              eq(registrations.eventId, eventId),
              isNull(registrations.supersededAt),
              gte(registrations.createdAt, window.windowStart),
              lt(registrations.createdAt, window.windowEnd),
            ),
          ),
        snapshotDb
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
        snapshotDb
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
        snapshotDb
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
        snapshotDb
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
              gte(refunds.createdAt, window.windowStart),
              lt(refunds.createdAt, window.windowEnd),
            ),
          ),
        snapshotDb
          .select({ value: count() })
          .from(invoiceRequests)
          .where(
            and(
              eq(invoiceRequests.organizationId, organizationId),
              eq(invoiceRequests.eventId, eventId),
              gte(invoiceRequests.requestedAt, window.windowStart),
              lt(invoiceRequests.requestedAt, window.windowEnd),
            ),
          ),
        snapshotDb
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
        snapshotDb
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
        snapshotDb
          .select({ value: count() })
          .from(checkinRecords)
          .where(and(eq(checkinRecords.eventId, eventId), eq(checkinRecords.result, 'accepted'))),
        snapshotDb
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
        snapshotDb
          .select({ value: count() })
          .from(cooperationRequests)
          .where(
            and(
              eq(cooperationRequests.organizationId, organizationId),
              eq(cooperationRequests.eventId, eventId),
              eq(cooperationRequests.status, 'new'),
            ),
          ),
        snapshotDb
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
      ]);

      const pageViewsAvailable = hasCompleteFeishuPageViewDay({
        dailyTrackingStartedAt: publicMetric?.dailyTrackingStartedAt,
        windowStart: window.windowStart,
        eventTimezone: event.timezone,
        metricTimezone: dailyPublicMetric?.timezoneSnapshot,
      });
      const grossReceipts = numeric(dailyPayment?.grossReceipts);
      const refundAmount = numeric(dailyRefund?.refundAmount);

      return {
        metricVersion: 1,
        event,
        reportDate: window.reportDate,
        windowStart: window.windowStart.toISOString(),
        windowEnd: window.windowEnd.toISOString(),
        generatedAt: generatedAt.toISOString(),
        currency: inventory?.currency ?? 'CNY',
        pageViewsAvailable,
        daily: {
          pageViews: pageViewsAvailable ? numeric(dailyPublicMetric?.pageViews) : null,
          newRegistrations: numeric(dailyRegistration?.value),
          paidOrders: numeric(dailyPayment?.paidOrders),
          grossReceipts,
          successfulRefunds: numeric(dailyRefund?.successfulRefunds),
          refundAmount,
          netCash: grossReceipts - refundAmount,
          invoiceRequests: numeric(dailyInvoice?.value),
          checkins: numeric(dailyCheckin?.value),
        },
        cumulative: {
          pageViews: numeric(publicMetric?.pageViews),
          validRegistrations: numeric(cumulativeRegistration?.validRegistrations),
          paidOrders: numeric(cumulativeOrder?.paidOrders),
          paidSeats: numeric(cumulativeOrder?.paidSeats),
          confirmedAttendees: numeric(cumulativeRegistration?.confirmedAttendees),
          netRevenue: numeric(cumulativeOrder?.netRevenue),
          remainingInventory: numeric(inventory?.remainingInventory),
          checkins: numeric(cumulativeCheckin?.value),
        },
        todos: {
          pendingRegistrationReview: numeric(cumulativeRegistration?.pendingReview),
          invoiceActionable: numeric(invoiceTodo?.actionable),
          paymentExceptions: numeric(paymentTodo?.exceptions),
          cooperationRequests: numeric(cooperationTodo?.value),
          lowStockTicketTypes: numeric(inventory?.lowStockTicketTypes),
        },
        monitoring: {
          invoiceAwaitingDetails: numeric(invoiceTodo?.awaitingDetails),
          invoiceIssuing: numeric(invoiceTodo?.issuing),
          pendingPayments: numeric(paymentTodo?.pending),
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
