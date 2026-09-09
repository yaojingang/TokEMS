import { sql } from 'drizzle-orm';
import { refundRequests, refunds } from './schema.js';

export function refundAttentionCondition(now: Date = new Date()) {
  return sql`(${refundRequests.fulfillmentStatus} = 'manual_required'
    or ${refundRequests.attentionReason} is not null
    or (${refundRequests.terminatedAt} is null and coalesce(${refundRequests.reviewedAt}, ${refundRequests.createdAt}) < ${new Date(now.valueOf() - 24 * 60 * 60_000)}))`;
}

export function refundCurrentExecutionCondition(status: 'waiting_funds' | 'processing') {
  return sql`exists (select 1 from ${refunds} where refunds.request_id = refund_requests.id and ${refunds.currentAttempt} = true and ${refunds.status} = ${status})`;
}

// Only this server-written manual-refund shape supplies a historical confirmation time.
export function refundReportingSuccessTime() {
  return sql`coalesce(${refunds.succeededAt}, case
    when ${refunds.source} = 'manual'
      and (${refunds.providerPayload}->>'requestHash') ~ '^[0-9a-f]{64}$'
      and pg_input_is_valid(${refunds.providerPayload}->>'processedAt', 'timestamp with time zone')
    then (${refunds.providerPayload}->>'processedAt')::timestamptz end)`;
}

export function refundReportingSuccessUpperBound() {
  return sql`least(case when ${refunds.source} <> 'legacy' then ${refunds.updatedAt} end,
    case when pg_input_is_valid(${refunds.providerPayload}->>'digestSuccessObservedAt', 'timestamp with time zone')
      then (${refunds.providerPayload}->>'digestSuccessObservedAt')::timestamptz end)`;
}

// External refunds can be discovered after creation at the provider; local insertion is not a lower bound.
export function refundReportingSuccessLowerBound() {
  return sql`case when ${refunds.source} = 'external' then ${refunds.acceptedAt} else ${refunds.createdAt} end`;
}
