export type DatabaseMigrationStatus = {
  ok: boolean;
  expected: string;
  applied: string;
};

type MigrationPool = {
  query: (text: string) => Promise<{ rows: Array<{ hash?: string | null }> }>;
};

const MIGRATION_HASH_PATTERN = /^[a-f0-9]{64}$/u;

export async function readDatabaseMigrationStatus(
  pool: MigrationPool,
  expectedHash = process.env.BUILD_MIGRATION_HASH,
): Promise<DatabaseMigrationStatus> {
  const expected = expectedHash?.trim().toLowerCase() ?? 'unknown';
  const result = await pool.query(
    'select hash from "drizzle"."__drizzle_migrations" order by created_at desc limit 1',
  );
  const appliedCandidate = result.rows[0]?.hash?.trim().toLowerCase() ?? '';
  const applied = MIGRATION_HASH_PATTERN.test(appliedCandidate) ? appliedCandidate : 'unknown';
  return {
    ok: MIGRATION_HASH_PATTERN.test(expected) && applied === expected,
    expected: MIGRATION_HASH_PATTERN.test(expected) ? expected : 'unknown',
    applied,
  };
}

export function assertDatabaseMigrationCurrent(status: DatabaseMigrationStatus) {
  if (!status.ok) {
    throw new Error(
      `Database migration hash mismatch: expected=${status.expected} applied=${status.applied}`,
    );
  }
}
