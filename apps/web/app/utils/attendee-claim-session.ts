import { parseAttendeeClaimFragment } from './purchase-journey';

export interface AttendeeClaimSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type AttendeeClaimCredential = NonNullable<ReturnType<typeof parseAttendeeClaimFragment>>;

const ACTIVE_REGISTRATION_KEY = 'conference.attendeeClaim.activeRegistration';
const CREDENTIAL_KEY_PREFIX = 'conference.attendeeClaim.credential.';

export function attendeeClaimCredentialStorageKey(registrationId: string) {
  return `${CREDENTIAL_KEY_PREFIX}${registrationId}`;
}

function persistAttendeeClaimCredential(
  storage: AttendeeClaimSessionStorage,
  credential: AttendeeClaimCredential,
) {
  try {
    storage.setItem(
      attendeeClaimCredentialStorageKey(credential.registrationId),
      JSON.stringify({ version: 1, ...credential }),
    );
    storage.setItem(ACTIVE_REGISTRATION_KEY, credential.registrationId);
  } catch {
    // The credential remains available in memory when tab storage is unavailable.
  }
}

function restoreAttendeeClaimCredential(
  storage: AttendeeClaimSessionStorage,
): AttendeeClaimCredential | null {
  try {
    const registrationId = storage.getItem(ACTIVE_REGISTRATION_KEY);
    if (!registrationId) return null;
    const raw = storage.getItem(attendeeClaimCredentialStorageKey(registrationId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as {
      version?: number;
      registrationId?: string;
      claimToken?: string;
    };
    if (stored.version !== 1) return null;
    return parseAttendeeClaimFragment(
      `#registration=${encodeURIComponent(stored.registrationId ?? '')}&claim=${encodeURIComponent(stored.claimToken ?? '')}`,
    );
  } catch {
    return null;
  }
}

export function consumeAttendeeClaimCredential(
  storage: AttendeeClaimSessionStorage,
  registrationId: string,
) {
  try {
    storage.removeItem(attendeeClaimCredentialStorageKey(registrationId));
    if (storage.getItem(ACTIVE_REGISTRATION_KEY) === registrationId) {
      storage.removeItem(ACTIVE_REGISTRATION_KEY);
    }
  } catch {
    // Clearing in-memory state still prevents reuse by the current page instance.
  }
}

export function isTerminalAttendeeClaimStatus(status: number | undefined) {
  return status === 401 || status === 409;
}

export async function initializeAttendeeClaimPage(input: {
  fragment: string;
  storage: AttendeeClaimSessionStorage;
  clearFragment: () => void;
  refreshSession: () => Promise<unknown>;
  hasSession: () => boolean;
  openLogin: () => void;
}) {
  const hasFragment = input.fragment.length > 0;
  const parsed = hasFragment ? parseAttendeeClaimFragment(input.fragment) : null;
  if (parsed) persistAttendeeClaimCredential(input.storage, parsed);
  if (hasFragment) input.clearFragment();

  const credential = parsed ?? (hasFragment ? null : restoreAttendeeClaimCredential(input.storage));
  await input.refreshSession().catch(() => null);
  if (!input.hasSession() && credential) input.openLogin();
  return credential;
}
