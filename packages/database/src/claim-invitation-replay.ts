import { sql } from 'drizzle-orm';
import type { ConferenceDatabase } from './index.js';

/** Keep replay metadata while erasing expired or revoked invitation secrets. */
export async function eraseUnavailableClaimInvitationReplays(
  db: Pick<ConferenceDatabase, 'execute'>,
  now = new Date(),
  registrationIds?: string[],
) {
  if (registrationIds?.length === 0) return;
  await db.execute(sql`update idempotency_keys replay
    set response_body = replay.response_body - 'sealedToken'
    where replay.scope like 'claim-invitation:%'
      and replay.response_body ? 'sealedToken'
      ${
        registrationIds
          ? sql`and exists (select 1 from attendee_claim_tokens scoped_token where scoped_token.id::text = replay.response_body->>'tokenId' and scoped_token.registration_id in (${sql.join(
              registrationIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}))`
          : sql``
      }
      and ((replay.response_body->>'replayUntil')::timestamptz <= ${now}
        or not exists (select 1 from attendee_claim_tokens token
          where token.id::text = replay.response_body->>'tokenId'
            and token.revoked_at is null and token.consumed_at is null
            and token.expires_at > ${now}))`);
}
