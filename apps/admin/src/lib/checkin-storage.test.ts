import { describe, expect, it } from 'vitest';
import { clearLegacyCheckInStorage } from './checkin-storage.js';

describe('legacy check-in storage cleanup', () => {
  it('removes unscoped keys and preserves event-scoped offline state', () => {
    const values = new Map([
      ['conference.checkin.offlineQueue', '[]'],
      ['conference.checkin.batchKey', 'old-batch'],
      ['conference.checkin.deviceCode', 'GATE-1'],
      ['conference.checkin.deviceToken', 'token'],
      ['conference.checkin.device', 'desk-1'],
      ['conference.checkin.101.offlineQueue', '[{"ticketCode":"safe"}]'],
    ]);

    clearLegacyCheckInStorage({ removeItem: (key) => values.delete(key) });

    expect([...values.keys()]).toEqual(['conference.checkin.101.offlineQueue']);
  });
});
