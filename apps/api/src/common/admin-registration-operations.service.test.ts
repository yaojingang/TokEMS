import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminRegistrationOperationsDetailSchema, DEMO_EVENT } from '@conference/contracts';
import { AdminRegistrationOperationsService } from './admin-registration-operations.service.js';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { InvoiceOperationsService } from './invoice-operations.service.js';

describe('AdminRegistrationOperationsService', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let database: DatabaseService;
  let service: AdminRegistrationOperationsService;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    database = new DatabaseService();
    const repository = new ConferenceRepository(database);
    service = new AdminRegistrationOperationsService(
      database,
      repository,
      new InvoiceOperationsService(database),
    );
  });

  afterEach(async () => {
    await database.onModuleDestroy();
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  it('returns restricted commerce and invoice contexts without leaking their fields', async () => {
    const detail = await service.detail(
      DEMO_EVENT.id,
      'demo-registration-1',
      DEMO_EVENT.organizationId,
      ['event.registration.read'],
    );

    expect(detail.commerce).toEqual({ access: 'restricted' });
    expect(detail.invoice).toEqual({ access: 'restricted' });
    expect('order' in detail.registration).toBe(false);
    expect(AdminRegistrationOperationsDetailSchema.safeParse(detail).success).toBe(true);
  });
});
