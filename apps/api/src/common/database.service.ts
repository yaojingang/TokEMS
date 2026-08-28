import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  createDatabase,
  readDatabaseMigrationStatus,
  type ConferenceDatabase,
} from '@conference/database';
import type { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db?: ConferenceDatabase;
  private readonly pool?: Pool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor() {
    if (process.env.DATABASE_URL) {
      const connection = createDatabase(process.env.DATABASE_URL);
      this.db = connection.db;
      this.pool = connection.pool;
      this.logger.log('PostgreSQL persistence is enabled');
    } else {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_URL is required in production');
      }
      this.logger.warn('DATABASE_URL is not set, using the in-memory operational store');
    }
  }

  get persistent() {
    return Boolean(this.db);
  }

  async ping() {
    if (!this.pool) {
      return {
        mode: 'memory' as const,
        ok: true,
        migration: { ok: true, expected: 'memory', applied: 'memory' },
      };
    }
    await this.pool.query('select 1');
    return {
      mode: 'postgresql' as const,
      ok: true,
      migration: await readDatabaseMigrationStatus(this.pool),
    };
  }

  async canonicalIdentityProof(challenge: string) {
    if (!this.pool) throw new Error('Canonical export requires PostgreSQL persistence');
    const identityResult = await this.pool.query<{
      systemIdentifier: string;
      databaseName: string;
      databaseOid: string;
      startedAt: string;
    }>(
      `select system_identifier::text as "systemIdentifier",
              current_database() as "databaseName",
              (select oid::text from pg_database where datname = current_database()) as "databaseOid",
              extract(epoch from pg_postmaster_start_time())::text as "startedAt"
       from pg_control_system()`,
    );
    const identity = identityResult.rows[0];
    if (!identity) throw new Error('PostgreSQL instance identity is unavailable');
    return createHash('sha256')
      .update(
        `${challenge}\n${identity.systemIdentifier}\n${identity.databaseName}\n${identity.databaseOid}\n${identity.startedAt}`,
      )
      .digest('hex');
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }
}
