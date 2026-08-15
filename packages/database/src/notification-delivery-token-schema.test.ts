import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { notificationDeliveries } from './schema.js';

describe('notification delivery access token boundary', () => {
  it('persists the generated access token reference and sealed capability', () => {
    expect(notificationDeliveries.accessTokenId.name).toBe('access_token_id');
    expect(notificationDeliveries.sealedAccessToken.name).toBe('sealed_access_token');
    expect(notificationDeliveries.accessTokenExpiresAt.name).toBe('access_token_expires_at');
    expect(notificationDeliveries.uncertainAt.name).toBe('uncertain_at');

    const foreignKey = getTableConfig(notificationDeliveries).foreignKeys.find(
      (item) =>
        item.getName() === 'notification_deliveries_access_token_id_order_access_tokens_id_fk',
    );
    expect(foreignKey?.reference().columns.map((column) => column.name)).toEqual([
      'access_token_id',
    ]);
    expect(foreignKey?.reference().foreignColumns.map((column) => column.name)).toEqual(['id']);
    expect(foreignKey?.onDelete).toBe('set null');
  });

  it('publishes an additive migration for durable notification token reuse', async () => {
    const migration = await readFile(
      fileURLToPath(new URL('../drizzle/0049_far_ken_ellis.sql', import.meta.url)),
      'utf8',
    );
    expect(migration).toContain('access_token_id');
    expect(migration).toContain('sealed_access_token');
    expect(migration).toContain('access_token_expires_at');
    expect(migration).toContain(
      'notification_deliveries_access_token_id_order_access_tokens_id_fk',
    );
    expect(migration).not.toMatch(/\bdrop\s+(?:table|column)\b/iu);
  });

  it('publishes an additive migration for uncertain delivery history', async () => {
    const migration = await readFile(
      fileURLToPath(new URL('../drizzle/0050_flimsy_thunderbolt_ross.sql', import.meta.url)),
      'utf8',
    );
    expect(migration).toContain('uncertain_at');
    expect(migration).not.toMatch(/\bdrop\s+(?:table|column)\b/iu);
  });
});
