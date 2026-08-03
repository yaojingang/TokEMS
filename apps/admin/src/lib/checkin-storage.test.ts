import { describe, expect, it } from 'vitest';
import { checkInStorageKey, clearLegacyCheckInStorage } from './checkin-storage.js';

describe('event-scoped check-in storage', () => {
  it('isolates offline state by event ID', () => {
    expect(checkInStorageKey(101, 'offlineQueue')).toBe('conference.checkin.101.offlineQueue');
    expect(checkInStorageKey(102, 'offlineQueue')).toBe('conference.checkin.102.offlineQueue');
  });

  it('removes legacy keys whose event ownership cannot be verified', () => {
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
