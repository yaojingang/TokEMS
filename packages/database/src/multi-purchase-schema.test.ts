import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  attendeeClaimTokens,
  events,
  orders,
  registrationPurchaseAttempts,
} from './schema.js';

describe('multi-purchase database boundary', () => {
  it('stores purchaser identity and a retry-safe purchase intent on each order', () => {
    expect(orders.purchaserCustomerUserId.name).toBe('purchaser_customer_user_id');
    expect(orders.purchaserSnapshot.name).toBe('purchaser_snapshot');
    expect(orders.purchaseIntentId.name).toBe('purchase_intent_id');

    const config = getTableConfig(orders);
    expect(config.indexes.map((item) => item.config.name)).toContain(
      'orders_purchaser_intent_unique',
    );
  });

  it('scopes purchaser identity to the order tenant while preserving purchaser nullification', () => {
    const config = getTableConfig(orders);
    const purchaserScope = config.foreignKeys.find(
      (foreignKey) => foreignKey.getName() === 'orders_purchaser_customer_org_fk',
    );
    const purchaserDelete = config.foreignKeys.find(
      (foreignKey) =>
        foreignKey.getName() === 'orders_purchaser_customer_user_id_customer_users_id_fk',
    );

    expect(purchaserScope?.reference().columns.map((column) => column.name)).toEqual([
      'purchaser_customer_user_id',
      'organization_id',
    ]);
    expect(purchaserScope?.reference().foreignColumns.map((column) => column.name)).toEqual([
      'id',
      'organization_id',
    ]);
    expect(purchaserScope?.onDelete).toBe('no action');
    expect(purchaserDelete?.onDelete).toBe('set null');
  });

  it('stores expiring one-time attendee claim tokens without raw mobile numbers', () => {
    expect(attendeeClaimTokens.registrationId.name).toBe('registration_id');
    expect(attendeeClaimTokens.tokenHash.name).toBe('token_hash');
    expect(attendeeClaimTokens.mobileDigest.name).toBe('mobile_digest');
    expect(attendeeClaimTokens.expiresAt.name).toBe('expires_at');
    expect(attendeeClaimTokens.consumedAt.name).toBe('consumed_at');
    expect(attendeeClaimTokens.revokedAt.name).toBe('revoked_at');
  });

  it('stores durable purchaser attempt timestamps for account-level throttling', () => {
    expect(registrationPurchaseAttempts.organizationId.name).toBe('organization_id');
    expect(registrationPurchaseAttempts.eventId.name).toBe('event_id');
    expect(registrationPurchaseAttempts.purchaserCustomerUserId.name).toBe(
      'purchaser_customer_user_id',
    );
    expect(registrationPurchaseAttempts.createdAt.name).toBe('created_at');
    expect(registrationPurchaseAttempts.purchaseIntentId.name).toBe('purchase_intent_id');
    expect(
      getTableConfig(registrationPurchaseAttempts).indexes.map((item) => item.config.name),
    ).toContain('registration_purchase_attempts_purchaser_time_idx');
    expect(
      getTableConfig(registrationPurchaseAttempts).indexes.map((item) => item.config.name),
    ).toContain('registration_purchase_attempts_intent_unique');
    const eventScope = getTableConfig(registrationPurchaseAttempts).foreignKeys.find(
      (foreignKey) =>
        foreignKey.getName() === 'registration_purchase_attempts_event_org_fk',
    );
    expect(eventScope?.reference().columns.map((column) => column.name)).toEqual([
      'event_id',
      'organization_id',
    ]);
    expect(eventScope?.reference().foreignColumns.map((column) => column.name)).toEqual([
      'id',
      'organization_id',
    ]);
    expect(getTableConfig(events).indexes.map((item) => item.config.name)).toContain(
      'events_id_org_unique',
    );
  });

  it('publishes an additive 0048 migration for account-level purchase throttling', async () => {
    const migration = await readFile(
      fileURLToPath(new URL('../drizzle/0048_registration_purchase_attempts.sql', import.meta.url)),
      'utf8',
    );
    expect(migration).toContain('registration_purchase_attempts');
    expect(migration).toContain('purchaser_customer_user_id');
    expect(migration).toContain('purchase_intent_id');
    expect(migration).toContain('registration_purchase_attempts_intent_unique');
    expect(migration).toContain('registration_purchase_attempts_event_org_fk');
    expect(migration).toContain('events_id_org_unique');
    expect(migration).not.toMatch(/\bdrop\s+(?:table|column)\b/iu);
  });

  it('records purchase-intent deduplication in the 0048 schema snapshot', async () => {
    const snapshot = JSON.parse(
      await readFile(
        fileURLToPath(new URL('../drizzle/meta/0048_snapshot.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<string, unknown>;
          indexes: Record<string, { isUnique: boolean }>;
          foreignKeys: Record<
            string,
            { columnsFrom: string[]; columnsTo: string[]; tableTo: string }
          >;
        }
      >;
    };
    const attempts = snapshot.tables['public.registration_purchase_attempts'];
    expect(attempts?.columns).toHaveProperty('purchase_intent_id');
    expect(attempts?.indexes.registration_purchase_attempts_intent_unique?.isUnique).toBe(true);
    expect(attempts?.foreignKeys.registration_purchase_attempts_event_org_fk).toEqual(
      expect.objectContaining({
        tableTo: 'events',
        columnsFrom: ['event_id', 'organization_id'],
        columnsTo: ['id', 'organization_id'],
      }),
    );
  });

  it('publishes a non-destructive 0047 migration with legacy purchaser backfill', async () => {
    const migration = await readFile(
      fileURLToPath(new URL('../drizzle/0047_multi_purchase_foundation.sql', import.meta.url)),
      'utf8',
    );
    expect(migration).toContain('purchaser_customer_user_id');
    expect(migration).toContain('purchaser_snapshot');
    expect(migration).toContain('attendee_claim_tokens');
    expect(migration).toContain('registrations.customer_user_id');
    expect(migration).toContain('orders_purchaser_customer_org_fk');
    expect(migration).not.toMatch(/\bdrop\s+(?:table|column)\b/iu);
  });

  it('records the purchaser tenant foreign key in the 0047 schema snapshot', async () => {
    const snapshot = JSON.parse(
      await readFile(
        fileURLToPath(new URL('../drizzle/meta/0047_snapshot.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      tables: Record<
        string,
        {
          foreignKeys: Record<
            string,
            { columnsFrom: string[]; columnsTo: string[]; onDelete: string }
          >;
        }
      >;
    };
    expect(snapshot.tables['public.orders']?.foreignKeys.orders_purchaser_customer_org_fk).toEqual(
      expect.objectContaining({
        columnsFrom: ['purchaser_customer_user_id', 'organization_id'],
        columnsTo: ['id', 'organization_id'],
        onDelete: 'no action',
      }),
    );
  });
});
