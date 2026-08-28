import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AdminAttendeeNeedsController } from './customer.module.js';

const REQUIRED_GRANTS_METADATA = 'conference.required_grants';
const REQUIRED_ALL_GRANTS_METADATA = 'conference.required_all_grants';

describe('attendee-needs administration permissions', () => {
  it('requires the dedicated registration export grant for CSV downloads', () => {
    const handler = AdminAttendeeNeedsController.prototype.export;
    expect(Reflect.getMetadata(REQUIRED_GRANTS_METADATA, handler)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_ALL_GRANTS_METADATA, handler)).toEqual([
      'event.registration.read',
      'event.registration.export',
    ]);
  });
});
