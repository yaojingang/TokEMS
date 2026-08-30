import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  eventAttendeeServiceConfigs,
  registrationServiceAcknowledgements,
  templateAssets,
} from './schema.js';

describe('attendee service hub database boundary', () => {
  it('keeps event configuration private and tenant scoped', () => {
    expect(eventAttendeeServiceConfigs.eventId.name).toBe('event_id');
    expect(eventAttendeeServiceConfigs.organizerQrAssetId.name).toBe('organizer_qr_asset_id');
    expect(eventAttendeeServiceConfigs.version.name).toBe('version');
    const config = getTableConfig(eventAttendeeServiceConfigs);
    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'event_attendee_service_configs_event_scope_fk',
    );
    expect(config.checks.map((check) => check.name)).toContain(
      'event_attendee_service_configs_enabled_content',
    );
  });

  it('allows one fixed acknowledgement action for each registration', () => {
    expect(registrationServiceAcknowledgements.actionCode.name).toBe('action_code');
    const config = getTableConfig(registrationServiceAcknowledgements);
    expect(config.indexes.map((index) => index.config.name)).toContain(
      'registration_service_acknowledgements_action_unique',
    );
    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'registration_service_acknowledgements_registration_scope_fk',
        'registration_service_acknowledgements_customer_org_fk',
      ]),
    );
  });

  it('publishes an additive migration without rewriting business history', async () => {
    const migration = await readFile(
      fileURLToPath(new URL('../drizzle/0058_sweet_joseph.sql', import.meta.url)),
      'utf8',
    );
    expect(migration).toContain('event_attendee_service_configs');
    expect(migration).toContain('registration_service_acknowledgements');
    expect(migration).toContain('organizer_contact_confirmed');
    expect(migration).not.toMatch(/^\s*(?:drop|truncate|update|delete)\b/imu);
  });

  it('isolates organizer QR assets from public template assets by immutable purpose', async () => {
    expect(templateAssets.purpose.name).toBe('purpose');
    const config = getTableConfig(templateAssets);
    expect(config.indexes.map((index) => index.config.name)).toContain(
      'template_assets_org_digest_purpose_unique',
    );
    expect(config.checks.map((check) => check.name)).toContain('template_assets_purpose');

    const migration = await readFile(
      fileURLToPath(new URL('../drizzle/0059_green_rictor.sql', import.meta.url)),
      'utf8',
    );
    expect(migration).toContain('ADD COLUMN "purpose"');
    expect(migration).toContain('SET "purpose" = \'attendee_service_qr\'');
    expect(migration).toContain('FROM "event_attendee_service_configs"');
    expect(migration).toContain('template_assets_org_digest_purpose_unique');
    expect(migration).toContain("'attendee_service_qr'");
    expect(migration).not.toMatch(/^\s*(?:truncate|delete)\b/imu);
  });
});
