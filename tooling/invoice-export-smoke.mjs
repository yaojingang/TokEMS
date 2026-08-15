import { randomUUID } from 'node:crypto';
import { createDatabase } from '../packages/database/dist/index.js';

const apiBase = process.env.API_BASE_URL ?? 'http://localhost:8088/api/v1';
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://conference:conference@localhost:15432/conference';
const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@tokems.local';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const request = async (path, options = {}) => {
  const response = await fetch(`${apiBase}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${response.status}`);
  }
  return body;
};

const { pool } = createDatabase(databaseUrl);
let exportJobId;
try {
  const login = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: adminEmail,
      password: process.env.ADMIN_PASSWORD ?? 'admin',
    }),
  });
  const organization = await pool.query(
    `select memberships.organization_id as id
     from users
     inner join memberships on memberships.user_id = users.id
     where users.email = $1 and memberships.status = 'active'
     order by memberships.created_at
     limit 1`,
    [adminEmail],
  );
  assert(organization.rows[0]?.id, 'Admin organization does not exist');
  const conference = await pool.query(
    `select id from events where organization_id = $1 order by id limit 1`,
    [organization.rows[0].id],
  );
  const eventId = Number(conference.rows[0]?.id);
  assert(Number.isSafeInteger(eventId), 'Seed conference does not exist');
  exportJobId = randomUUID();
  await pool.query(
    `insert into invoice_export_jobs
      (id, organization_id, requested_by, status, filters, row_count)
     select $1, $2, id, 'queued', $4::jsonb, 0
     from users where email = $3 limit 1`,
    [exportJobId, organization.rows[0].id, adminEmail, JSON.stringify({ eventId })],
  );
  await pool.query(
    `insert into outbox_events
      (organization_id, event_id, event_type, correlation_id, payload)
     values ($1, $2, 'InvoiceExportRequested', $3, $4::jsonb)`,
    [
      organization.rows[0].id,
      eventId,
      `invoice-export-smoke:${exportJobId}`,
      JSON.stringify({ exportJobId }),
    ],
  );

  let job;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    job = await request(`/admin/events/${eventId}/invoices/export-jobs/${exportJobId}`, {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    });
    if (job.status === 'ready' || job.status === 'failed') break;
  }
  assert(job?.status === 'ready' && job.downloadPath, `Async export failed: ${job?.error}`);
  const download = await fetch(`${apiBase}${job.downloadPath}`, {
    headers: { Authorization: `Bearer ${login.accessToken}` },
  });
  const content = Buffer.from(await download.arrayBuffer());
  assert(download.ok && content.length > 20, 'Async export download is empty');
  assert(content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'CSV BOM is missing');

  const stored = await pool.query(
    `select storage_key, content_digest, size, csv_content
     from invoice_export_jobs where id = $1`,
    [exportJobId],
  );
  assert(stored.rows[0]?.storage_key, 'Async export was not stored in object storage');
  assert(stored.rows[0]?.content_digest, 'Async export digest is missing');
  assert(Number(stored.rows[0]?.size) === content.length, 'Stored export size does not match');
  assert(stored.rows[0]?.csv_content === null, 'Sensitive CSV remained in PostgreSQL');
  await pool.query(
    `update invoice_export_jobs set expires_at = now() - interval '1 second' where id = $1`,
    [exportJobId],
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        exportJobId,
        status: job.status,
        rows: job.rowCount,
        size: content.length,
        storage: 'object',
        databaseCsv: 'empty',
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
