import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type RegistrationIdentityCandidate = {
  id: string;
  organizationId: string;
  eventId: number;
  registrationCode: string;
  status: string;
  customerUserId: string | null;
  attendeeMobileE164: string;
  createdAt: Date;
  orderId: string | null;
  orderStatus: string | null;
  paymentCount: number;
  refundCount: number;
  invoiceCount: number;
  ticketCount: number;
  checkinCount: number;
  showcaseCount?: number;
};

export type RegistrationIdentityRepairGroup = {
  eventId: number;
  canonicalId: string;
  supersededIds: string[];
  candidateIds: string[];
  blockedReasons: string[];
};

export type RegistrationIdentityRepairPlan = {
  groups: RegistrationIdentityRepairGroup[];
  blocked: boolean;
};

const CLOSED_ORDER_STATUSES = new Set(['closed', 'refunded']);

function hasBusinessFacts(candidate: RegistrationIdentityCandidate) {
  return (
    candidate.paymentCount > 0 ||
    candidate.refundCount > 0 ||
    candidate.invoiceCount > 0 ||
    candidate.ticketCount > 0 ||
    candidate.checkinCount > 0 ||
    (candidate.showcaseCount ?? 0) > 0
  );
}

function isClosedFactFree(candidate: RegistrationIdentityCandidate) {
  return (
    candidate.status === 'cancelled' &&
    candidate.orderStatus !== null &&
    CLOSED_ORDER_STATUSES.has(candidate.orderStatus) &&
    !hasBusinessFacts(candidate)
  );
}

export function planRegistrationIdentityRepairs(
  candidates: RegistrationIdentityCandidate[],
): RegistrationIdentityRepairPlan {
  const parent = new Map(candidates.map((candidate) => [candidate.id, candidate.id]));
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  const find = (id: string): string => {
    const current = parent.get(id)!;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  const identityBuckets = new Map<string, string[]>();
  for (const candidate of candidates) {
    const keys = [
      ...(candidate.customerUserId
        ? [`customer:${candidate.eventId}:${candidate.customerUserId}`]
        : []),
      ...(candidate.attendeeMobileE164
        ? [`mobile:${candidate.eventId}:${candidate.attendeeMobileE164}`]
        : []),
    ];
    for (const key of keys) {
      const bucket = identityBuckets.get(key) ?? [];
      bucket.push(candidate.id);
      identityBuckets.set(key, bucket);
    }
  }
  for (const bucket of identityBuckets.values()) {
    if (bucket.length < 2) continue;
    for (const id of bucket.slice(1)) union(bucket[0]!, id);
  }

  const duplicateIds = new Set(
    [...identityBuckets.values()].filter((bucket) => bucket.length > 1).flat(),
  );
  const components = new Map<string, RegistrationIdentityCandidate[]>();
  for (const id of duplicateIds) {
    const root = find(id);
    const component = components.get(root) ?? [];
    component.push(byId.get(id)!);
    components.set(root, component);
  }

  const groups = [...components.values()]
    .map((component): RegistrationIdentityRepairGroup => {
      component.sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      );
      const factful = component.filter(hasBusinessFacts);
      const open = component.filter(
        (candidate) =>
          candidate.orderStatus === null || !CLOSED_ORDER_STATUSES.has(candidate.orderStatus),
      );
      const customerIds = new Set(
        component.map((candidate) => candidate.customerUserId).filter(Boolean),
      );
      const mobileIds = new Set(
        component.map((candidate) => candidate.attendeeMobileE164).filter(Boolean),
      );
      const blockedReasons: string[] = [];
      if (component.some((candidate) => !candidate.orderId || !candidate.orderStatus)) {
        blockedReasons.push('MISSING_ORDER');
      }
      if (factful.length > 1) blockedReasons.push('MULTIPLE_RECORDS_WITH_BUSINESS_FACTS');
      if (open.length > 1) blockedReasons.push('MULTIPLE_OPEN_ORDERS');
      if (customerIds.size > 1 || mobileIds.size > 1) {
        blockedReasons.push('CROSS_IDENTITY_CONFLICT');
      }

      const canonical = factful.length === 1 ? factful[0]! : open.length === 1 ? open[0]! : component[0]!;
      const redundant = component.filter((candidate) => candidate.id !== canonical.id);
      if (redundant.some((candidate) => !isClosedFactFree(candidate))) {
        blockedReasons.push('UNSAFE_REDUNDANT_RECORD');
      }
      return {
        eventId: canonical.eventId,
        canonicalId: canonical.id,
        supersededIds: redundant.map((candidate) => candidate.id),
        candidateIds: component.map((candidate) => candidate.id),
        blockedReasons: [...new Set(blockedReasons)],
      };
    })
    .sort((left, right) => left.eventId - right.eventId || left.canonicalId.localeCompare(right.canonicalId));

  return { groups, blocked: groups.some((group) => group.blockedReasons.length > 0) };
}

const CANDIDATE_SQL = `
  select
    r.id,
    r.organization_id as "organizationId",
    r.event_id as "eventId",
    r.registration_code as "registrationCode",
    r.status,
    r.customer_user_id as "customerUserId",
    r.attendee_mobile_e164 as "attendeeMobileE164",
    r.created_at as "createdAt",
    o.id as "orderId",
    o.status as "orderStatus",
    (select count(*)::int from payments p where p.order_id = o.id) as "paymentCount",
    (select count(*)::int from refunds f where f.order_id = o.id) as "refundCount",
    (select count(*)::int from invoice_requests i where i.registration_id = r.id) as "invoiceCount",
    (select count(*)::int from tickets t where t.registration_id = r.id) as "ticketCount",
    (
      select count(*)::int
      from checkin_records c
      join tickets t on t.id = c.ticket_id
      where t.registration_id = r.id
    ) as "checkinCount"
  from registrations r
  left join orders o on o.registration_id = r.id
  where r.superseded_at is null
  order by r.event_id, r.created_at, r.id
`;

async function readCandidates(client: Pool | PoolClient) {
  const result = await client.query<RegistrationIdentityCandidate>(CANDIDATE_SQL);
  const candidates = result.rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt) }));
  const [showcaseTable] = (
    await client.query<{ exists: boolean }>(
      `select to_regclass('public.attendee_showcase_profiles') is not null as "exists"`,
    )
  ).rows;
  if (!showcaseTable?.exists || candidates.length === 0) return candidates;
  const showcaseCounts = await client.query<{ registrationId: string; count: number }>(
    `select registration_id as "registrationId", count(*)::int as "count"
     from attendee_showcase_profiles
     group by registration_id`,
  );
  const countsByRegistration = new Map(
    showcaseCounts.rows.map((row) => [row.registrationId, row.count]),
  );
  return candidates.map((candidate) => ({
    ...candidate,
    showcaseCount: countsByRegistration.get(candidate.id) ?? 0,
  }));
}

function mask(value: string | null) {
  if (!value) return '-';
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

export function printRegistrationIdentityRepairPlan(
  plan: RegistrationIdentityRepairPlan,
  candidates: RegistrationIdentityCandidate[],
) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  if (!plan.groups.length) {
    console.info('未发现重复报名身份。');
    return;
  }
  for (const group of plan.groups) {
    const canonical = byId.get(group.canonicalId)!;
    console.info(
      `大会 ${group.eventId}：保留 ${canonical.registrationCode}（用户 ${mask(canonical.customerUserId)}，手机号 ${mask(canonical.attendeeMobileE164)}）`,
    );
    console.info(
      `  归并：${group.supersededIds.map((id) => byId.get(id)?.registrationCode ?? id).join('、')}`,
    );
    if (group.blockedReasons.length) console.info(`  阻塞：${group.blockedReasons.join('、')}`);
  }
}

export async function repairRegistrationIdentities(pool: Pool, apply: boolean) {
  if (!apply) {
    const candidates = await readCandidates(pool);
    const plan = planRegistrationIdentityRepairs(candidates);
    printRegistrationIdentityRepairPlan(plan, candidates);
    return plan.blocked ? 2 : 0;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('tokems:registration-identity-repair', 0))`,
    );
    await client.query(
      'lock table registrations, orders, payments, refunds, invoice_requests, tickets, checkin_records in share row exclusive mode',
    );
    const [showcaseTable] = (
      await client.query<{ exists: boolean }>(
        `select to_regclass('public.attendee_showcase_profiles') is not null as "exists"`,
      )
    ).rows;
    if (showcaseTable?.exists) {
      await client.query(
        'lock table attendee_showcase_profiles in share row exclusive mode',
      );
    }
    const candidates = await readCandidates(client);
    const plan = planRegistrationIdentityRepairs(candidates);
    printRegistrationIdentityRepairPlan(plan, candidates);
    if (plan.blocked) {
      await client.query('rollback');
      return 2;
    }
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const traceId = randomUUID();
    for (const group of plan.groups) {
      for (const redundantId of group.supersededIds) {
        const redundant = byId.get(redundantId)!;
        await client.query(
          `update registrations
           set customer_user_id = null,
               attendee_mobile_e164 = '',
               attendee_email_normalized = '',
               status = 'cancelled',
               superseded_by_registration_id = $1,
               superseded_at = now(),
               updated_at = now()
           where id = $2 and superseded_at is null`,
          [group.canonicalId, redundantId],
        );
        await client.query(
          `insert into audit_logs
             (organization_id, event_id, actor_type, action, resource_type, resource_id, before, after, trace_id)
           values ($1, $2, 'system', 'registration.identity_superseded', 'registration', $3,
             $4::jsonb, $5::jsonb, $6)`,
          [
            redundant.organizationId,
            redundant.eventId,
            redundantId,
            JSON.stringify({ registrationId: redundantId, registrationCode: redundant.registrationCode }),
            JSON.stringify({ supersededByRegistrationId: group.canonicalId }),
            traceId,
          ],
        );
      }
    }
    const remaining = planRegistrationIdentityRepairs(await readCandidates(client));
    if (remaining.groups.length) throw new Error('归并后仍存在重复报名身份，事务已回滚');
    await client.query('commit');
    console.info(`报名身份归并完成，共处理 ${plan.groups.length} 组。`);
    return 0;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
