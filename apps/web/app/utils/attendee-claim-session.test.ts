import { describe, expect, it } from 'vitest';
import {
  attendeeClaimCredentialStorageKey,
  consumeAttendeeClaimCredential,
  initializeAttendeeClaimPage,
  isTerminalAttendeeClaimStatus,
  type AttendeeClaimSessionStorage,
} from './attendee-claim-session';

function createStorage(onSet?: (key: string) => void) {
  const values = new Map<string, string>();
  const storage: AttendeeClaimSessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      onSet?.(key);
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  };
  return { storage, values };
}

describe('attendee claim session', () => {
  it('removes the claim fragment before refreshing the customer session', async () => {
    const registrationId = '6da64028-8d52-44ee-9262-9ca5922bc2d9';
    const claimToken = 's'.repeat(48);
    const events: string[] = [];
    const { storage, values } = createStorage((key) => events.push(`store:${key}`));

    const credential = await initializeAttendeeClaimPage({
      fragment: `#registration=${registrationId}&claim=${claimToken}`,
      storage,
      clearFragment: () => events.push('clear-fragment'),
      refreshSession: async () => {
        events.push('refresh-session');
      },
      hasSession: () => false,
      openLogin: () => events.push('open-login'),
    });

    expect(credential).toEqual({ registrationId, claimToken });
    expect(events.indexOf('clear-fragment')).toBeLessThan(events.indexOf('refresh-session'));
    expect(events).toEqual([
      `store:${attendeeClaimCredentialStorageKey(registrationId)}`,
      'store:conference.attendeeClaim.activeRegistration',
      'clear-fragment',
      'refresh-session',
      'open-login',
    ]);
    expect(values.get(attendeeClaimCredentialStorageKey(registrationId))).toContain(claimToken);
    expect(values.get('conference.attendeeClaim.activeRegistration')).toBe(registrationId);
    expect([...values.keys()].some((key) => key.includes(claimToken))).toBe(false);
  });

  it('restores the tab-scoped credential after login navigation without putting it back in the URL', async () => {
    const registrationId = '6da64028-8d52-44ee-9262-9ca5922bc2d9';
    const claimToken = 't'.repeat(48);
    const { storage } = createStorage();
    await initializeAttendeeClaimPage({
      fragment: `#registration=${registrationId}&claim=${claimToken}`,
      storage,
      clearFragment: () => undefined,
      refreshSession: async () => undefined,
      hasSession: () => false,
      openLogin: () => undefined,
    });
    let clearedAgain = false;

    await expect(
      initializeAttendeeClaimPage({
        fragment: '',
        storage,
        clearFragment: () => {
          clearedAgain = true;
        },
        refreshSession: async () => undefined,
        hasSession: () => true,
        openLogin: () => undefined,
      }),
    ).resolves.toEqual({ registrationId, claimToken });
    expect(clearedAgain).toBe(false);
  });

  it('consumes credentials after success and terminal errors while retaining recoverable account mismatches', () => {
    const registrationId = '6da64028-8d52-44ee-9262-9ca5922bc2d9';
    const { storage, values } = createStorage();
    storage.setItem(attendeeClaimCredentialStorageKey(registrationId), 'secret');
    storage.setItem('conference.attendeeClaim.activeRegistration', registrationId);

    expect(isTerminalAttendeeClaimStatus(401)).toBe(true);
    expect(isTerminalAttendeeClaimStatus(409)).toBe(true);
    expect(isTerminalAttendeeClaimStatus(403)).toBe(false);
    expect(isTerminalAttendeeClaimStatus(500)).toBe(false);

    consumeAttendeeClaimCredential(storage, registrationId);
    expect(values.size).toBe(0);
  });
});
