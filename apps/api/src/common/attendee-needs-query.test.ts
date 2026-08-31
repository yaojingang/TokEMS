import { describe, expect, it } from 'vitest';
import { DEMO_IDS } from '@conference/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AttendeeNeedsService } from './attendee-needs.service.js';
import type { ConferenceRepository } from './conference.repository.js';
import type { DatabaseService } from './database.service.js';

describe('attendee needs admin query', () => {
  it('exposes the forced-anonymity reason from its joined subquery', () => {
    const database = drizzle.mock();
    const service = new AttendeeNeedsService(
      { db: database } as unknown as DatabaseService,
      {} as ConferenceRepository,
    );
    const queryAccess = service as unknown as {
      adminQuery(
        organizationId: string,
        eventId: number,
        source: typeof database,
      ): { toSQL(): { sql: string } };
    };

    const query = queryAccess.adminQuery(DEMO_IDS.organization, DEMO_IDS.event, database);

    const { sql } = query.toSQL();

    expect(sql).toContain('attendee_needs_forced_anonymity');
    expect(sql).toContain('as "reason"');
  });
});
