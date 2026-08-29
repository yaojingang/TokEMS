import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type ConferenceDatabase = ReturnType<typeof drizzle<typeof schema>>;

export function createDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to create the PostgreSQL connection');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return {
    db: drizzle({ client: pool, schema }),
    pool,
  };
}

export * from './schema.js';
export * from './migration-status.js';
export * from './feishu-digest.js';
export * from './inventory-reservation-policy.js';
