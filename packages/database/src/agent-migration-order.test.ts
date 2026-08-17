import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../drizzle/0052_hard_rafael_vega.sql', import.meta.url);

describe('Agent Access migration ordering', () => {
  it('creates composite unique indexes before foreign keys that reference them', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    const membershipsIndex = migration.indexOf(
      'CREATE UNIQUE INDEX "memberships_id_org_user_unique"',
    );
    const membershipScopeForeignKey = migration.indexOf(
      'ADD CONSTRAINT "agent_connections_membership_scope_fk"',
    );
    const connectionsIndex = migration.indexOf(
      'CREATE UNIQUE INDEX "agent_connections_id_org_user_unique"',
    );
    const connectionScopeForeignKey = migration.indexOf(
      'ADD CONSTRAINT "agent_operations_connection_scope_fk"',
    );

    expect(membershipsIndex).toBeGreaterThanOrEqual(0);
    expect(membershipScopeForeignKey).toBeGreaterThan(membershipsIndex);
    expect(connectionsIndex).toBeGreaterThanOrEqual(0);
    expect(connectionScopeForeignKey).toBeGreaterThan(connectionsIndex);
  });
});
