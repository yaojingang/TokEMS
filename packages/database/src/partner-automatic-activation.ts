import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export const PARTNER_AUTOMATIC_ACTIVATION_VERSION = 'automatic-activation-v1';

type Candidate = {
  id: string;
  organizationId: string;
  eventId: number;
  qualificationStatus: string;
  attributionEnabled: boolean;
  settlementHold: boolean;
  currentProgramVersionId: string | null;
  acceptedProgramVersionId: string | null;
  activatedAt: Date | null;
  version: number;
  customerStatus: string | null;
  programId: string | null;
  linkId: string | null;
  latestAction: string | null;
  latestAfter: Record<string, unknown> | null;
};

export function partnerAutomaticActivationExclusions(row: Candidate): string[] {
  const reasons: string[] = [];
  if (row.qualificationStatus !== 'pending_confirmation') reasons.push('qualification_preserved');
  if (row.qualificationStatus === 'pending_confirmation' && row.attributionEnabled) reasons.push('ambiguous_pending_attribution');
  if (row.settlementHold) reasons.push('financial_hold');
  if (row.customerStatus !== 'active') reasons.push('customer_unavailable');
  if (!row.programId) reasons.push('active_program_missing');
  if (!row.linkId) reasons.push('valid_link_missing');
  if (row.latestAction && !['partner.enabled', 'partner.details.updated'].includes(row.latestAction)) {
    const after = row.latestAfter ?? {};
    if (row.latestAction !== 'partner.updated' ||
        'qualificationStatus' in after || 'attributionEnabled' in after ||
        'settlementHold' in after || Object.keys(after).length === 0) {
      reasons.push('explicit_or_ambiguous_administrator_restriction');
    }
  }
  return reasons;
}

// Restriction audits stay relevant across later commercial-only or profile edits.
const candidatesSql = `
select p.id, p.organization_id as "organizationId", p.event_id as "eventId",
 p.qualification_status as "qualificationStatus", p.attribution_enabled as "attributionEnabled",
 p.settlement_hold as "settlementHold", p.current_program_version_id as "currentProgramVersionId",
 p.accepted_program_version_id as "acceptedProgramVersionId", p.activated_at as "activatedAt", p.version,
 c.status as "customerStatus", program.id as "programId", link.id as "linkId",
 control.action as "latestAction", control.after as "latestAfter"
from event_partners p
left join customer_users c on c.id = p.customer_user_id and c.organization_id = p.organization_id
left join lateral (
 select id from event_partner_program_versions
 where organization_id = p.organization_id and event_id = p.event_id and status = 'active'
 and (effective_at is null or effective_at <= now()) order by version desc limit 1
) program on true
left join lateral (
 select id from partner_referral_links where partner_id = p.id
 and organization_id = p.organization_id and event_id = p.event_id and status = 'active'
 and disabled_at is null and (expires_at is null or expires_at > now()) limit 1
) link on true
left join lateral (
 select action, after from audit_logs where organization_id = p.organization_id and event_id = p.event_id
 and resource_type = 'event_partner' and resource_id = p.id::text
 and action <> 'partner.details.updated'
 and (action <> 'partner.updated' or after ?| array['qualificationStatus','attributionEnabled','settlementHold'] or after = '{}'::jsonb)
 order by created_at desc, id desc limit 1
) control on true
order by p.organization_id, p.event_id, p.id`;

export async function upgradePartnerAutomaticActivation(pool: Pool, apply = false) {
  const client = await pool.connect();
  try {
    await client.query(apply ? 'begin isolation level serializable' : 'begin read only');
    if (apply) await client.query('select id from event_partners order by id for update');
    const { rows } = await client.query<Candidate>(candidatesSql);
    const candidates = rows.filter(row => partnerAutomaticActivationExclusions(row).length === 0);
    const report = {
      conversionVersion: PARTNER_AUTOMATIC_ACTIVATION_VERSION,
      mode: apply ? 'apply' : 'read_only',
      candidates: candidates.map(row => ({ partnerId: row.id, eventId: row.eventId, version: row.version, programId: row.programId,
        before: { qualificationStatus: row.qualificationStatus, attributionEnabled: row.attributionEnabled,
          currentProgramVersionId: row.currentProgramVersionId, acceptedProgramVersionId: row.acceptedProgramVersionId,
          settlementHold: row.settlementHold, activatedAt: row.activatedAt } })),
      exclusions: rows.filter(row => !candidates.includes(row)).map(row => ({
        partnerId: row.id, eventId: row.eventId, reasons: partnerAutomaticActivationExclusions(row),
      })),
      converted: 0,
    };
    if (apply) for (const row of candidates) {
      const result = await client.query(`update event_partners set qualification_status = 'active', attribution_enabled = true,
        current_program_version_id = $2, activated_at = coalesce(activated_at, now()), version = version + 1, updated_at = now()
        where id = $1 and version = $3 and qualification_status = 'pending_confirmation' returning version`,
      [row.id, row.programId, row.version]);
      if (result.rowCount !== 1) throw new Error('Partner activation changed concurrently; rerun the read-only report.');
      await client.query(`insert into audit_logs
        (organization_id,event_id,actor_type,action,resource_type,resource_id,before,after,trace_id)
        values ($1,$2,'system','partner.activation.upgraded','event_partner',$3,$4::jsonb,$5::jsonb,$6)`,
      [row.organizationId, row.eventId, row.id, JSON.stringify({
        qualificationStatus: row.qualificationStatus, attributionEnabled: row.attributionEnabled,
        settlementHold: row.settlementHold, currentProgramVersionId: row.currentProgramVersionId,
        acceptedProgramVersionId: row.acceptedProgramVersionId, activatedAt: row.activatedAt, version: row.version,
      }), JSON.stringify({ conversionVersion: PARTNER_AUTOMATIC_ACTIVATION_VERSION,
        qualificationStatus: 'active', attributionEnabled: true, currentProgramVersionId: row.programId,
        acceptedProgramVersionId: row.acceptedProgramVersionId, version: row.version + 1 }), randomUUID()]);
      report.converted++;
    }
    await client.query('commit');
    return report;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
