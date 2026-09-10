import { createRequire } from 'node:module';

const requireFromDatabase = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
);
const { Pool } = requireFromDatabase('pg');

const defaultDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://conference:conference@localhost:15432/conference';

export async function cleanupTestEvents(eventIds, databaseUrl = defaultDatabaseUrl) {
  const uniqueEventIds = [...new Set(eventIds.filter(Boolean))];
  if (uniqueEventIds.length === 0) return;
  if (uniqueEventIds.some((id) => !Number.isInteger(id) || id <= 0 || id > 2147483647)) {
    throw new TypeError('Test cleanup requires explicit positive integer event IDs');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const client = await pool.connect();
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          await client.query('begin');
          await client.query(
            'select id from events where id = any($1::integer[]) order by id for update',
            [uniqueEventIds],
          );
          // Clear restrictive child references before the event cascade, in one
          // transaction so deferred order/item invariants see their parent deleted too.
          const tables = [
            'notification_deliveries',
            'invoice_document_access_links',
            'invoice_requests',
            'refund_item_allocations',
            'refund_request_items',
            'inventory_reservations',
            'order_items',
          ];
          const { rows } = await client.query(
            `select name from unnest($1::text[]) as requested(name)
             where to_regclass('public.' || name) is not null`,
            [tables],
          );
          const existingTables = new Set(rows.map((row) => row.name));
          // Resolve encrypted invitation replays through their exact registration;
          // the claim tokens themselves cascade when those registrations are deleted.
          await client.query(
            `delete from idempotency_keys replay
             using attendee_claim_tokens claim, registrations registration
             where replay.scope like 'claim-invitation:%'
               and replay.response_body->>'tokenId' = claim.id::text
               and claim.registration_id = registration.id
               and registration.event_id = any($1::integer[])`,
            [uniqueEventIds],
          );
          for (const table of tables) {
            if (!existingTables.has(table)) continue;
            await client.query(`delete from public.${table} where event_id = any($1::integer[])`, [
              uniqueEventIds,
            ]);
          }
          await client.query('delete from events where id = any($1::integer[])', [uniqueEventIds]);
          await client.query('commit');
          break;
        } catch (error) {
          await client.query('rollback').catch(() => {});
          const retryable = error?.code === '40P01' || error?.code === '40001';
          if (!retryable || attempt === 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 150));
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
