const REGISTRATION_DRAFT_PREFIX = 'conference.registrationDraft.';
const REGISTRATION_DRAFT_VERSION = 1;
const REGISTRATION_ANSWER_MAX_LENGTH = 2_000;

export const REGISTRATION_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export interface RegistrationDraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RegistrationDraftScope {
  organizationId: string;
  eventId: string | number;
  ownerId: string | number;
  purchaseFor: 'self' | 'other';
  purchaseIntentId: string;
}

export interface RegistrationDraftField {
  key: string;
  enabled?: boolean;
  type: 'text' | 'email' | 'tel' | 'select';
  options?: readonly string[];
}

export function registrationDraftIdentityTransition(
  previousOwnerId: RegistrationDraftScope['ownerId'],
  nextOwnerId: RegistrationDraftScope['ownerId'],
) {
  const previous = String(previousOwnerId);
  const next = String(nextOwnerId);
  const previousIsCustomer = previous.startsWith('customer:');
  const nextIsCustomer = next.startsWith('customer:');

  if (previousIsCustomer && !nextIsCustomer) {
    return {
      kind: 'customer_to_anonymous',
      clearAnswers: true,
      restoreTargetDraft: false,
      migrateCurrentAnswers: false,
    } as const;
  }
  if (!previousIsCustomer && nextIsCustomer) {
    return {
      kind: 'anonymous_to_customer',
      clearAnswers: false,
      restoreTargetDraft: true,
      migrateCurrentAnswers: true,
    } as const;
  }
  if (previousIsCustomer && nextIsCustomer && previous !== next) {
    return {
      kind: 'customer_to_customer',
      clearAnswers: true,
      restoreTargetDraft: true,
      migrateCurrentAnswers: false,
    } as const;
  }
  return {
    kind: 'same_identity',
    clearAnswers: false,
    restoreTargetDraft: true,
    migrateCurrentAnswers: false,
  } as const;
}

interface StoredRegistrationDraft {
  version: typeof REGISTRATION_DRAFT_VERSION;
  formVersion: number;
  savedAt: number;
  answers: Record<string, string>;
}

function registrationDraftStoragePrefix(scope: RegistrationDraftScope) {
  const organization = encodeURIComponent(scope.organizationId);
  const owner = encodeURIComponent(String(scope.ownerId));
  const purchaseFor = encodeURIComponent(scope.purchaseFor);
  const purchaseIntentId = encodeURIComponent(scope.purchaseIntentId);
  return `${REGISTRATION_DRAFT_PREFIX}${organization}.${scope.eventId}.${owner}.${purchaseFor}.${purchaseIntentId}.v`;
}

export function registrationDraftStorageKey(scope: RegistrationDraftScope, formVersion: number) {
  return `${registrationDraftStoragePrefix(scope)}${formVersion}`;
}

export function sanitizeRegistrationDraftAnswers(
  answers: unknown,
  fields: readonly RegistrationDraftField[],
): Record<string, string> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return {};

  const source = answers as Record<string, unknown>;
  return Object.fromEntries(
    fields.flatMap((field) => {
      if (field.enabled === false) return [];
      const value = source[field.key];
      if (typeof value !== 'string') return [];
      if (field.type === 'select' && value && !field.options?.includes(value)) return [];
      return [[field.key, value.slice(0, REGISTRATION_ANSWER_MAX_LENGTH)] as const];
    }),
  );
}

function removeStoredDraft(storage: RegistrationDraftStorage, key: string) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    // Storage can be unavailable in privacy mode; the form should keep working in memory.
    return false;
  }
}

function hasValidTimestamp(draft: Partial<StoredRegistrationDraft>, now: number) {
  return (
    typeof draft.savedAt === 'number' &&
    Number.isFinite(draft.savedAt) &&
    draft.savedAt <= now &&
    now - draft.savedAt <= REGISTRATION_DRAFT_MAX_AGE_MS
  );
}

/**
 * Reads a current-form registration draft and keeps only fields still published for the event.
 */
export function readRegistrationDraft(
  storage: RegistrationDraftStorage,
  scope: RegistrationDraftScope,
  formVersion: number,
  fields: readonly RegistrationDraftField[],
  now = Date.now(),
): Record<string, string> {
  const key = registrationDraftStorageKey(scope, formVersion);

  try {
    const raw = storage.getItem(key);
    if (!raw) return {};

    const draft = JSON.parse(raw) as Partial<StoredRegistrationDraft>;
    if (
      draft.version !== REGISTRATION_DRAFT_VERSION ||
      draft.formVersion !== formVersion ||
      !hasValidTimestamp(draft, now)
    ) {
      removeStoredDraft(storage, key);
      return {};
    }

    return sanitizeRegistrationDraftAnswers(draft.answers, fields);
  } catch {
    removeStoredDraft(storage, key);
    return {};
  }
}

/**
 * Persists a registration draft for one event and browser identity scope.
 */
export function writeRegistrationDraft(
  storage: RegistrationDraftStorage,
  scope: RegistrationDraftScope,
  formVersion: number,
  answers: Record<string, string>,
  fields: readonly RegistrationDraftField[],
  now = Date.now(),
) {
  const key = registrationDraftStorageKey(scope, formVersion);
  const sanitized = sanitizeRegistrationDraftAnswers(answers, fields);

  if (!Object.values(sanitized).some((value) => value.length > 0)) {
    return removeStoredDraft(storage, key);
  }

  const draft: StoredRegistrationDraft = {
    version: REGISTRATION_DRAFT_VERSION,
    formVersion,
    savedAt: now,
    answers: sanitized,
  };

  try {
    storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    // A full or unavailable storage area must not block registration.
    return false;
  }
}

export function removeRegistrationDraft(
  storage: RegistrationDraftStorage,
  scope: RegistrationDraftScope,
  formVersion: number,
) {
  return removeStoredDraft(storage, registrationDraftStorageKey(scope, formVersion));
}

export function removeRegistrationDraftVersions(
  storage: RegistrationDraftStorage,
  scope: RegistrationDraftScope,
) {
  try {
    const prefix = registrationDraftStoragePrefix(scope);
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => Boolean(key?.startsWith(prefix)),
    );
    let removed = true;
    for (const key of keys) {
      if (!removeStoredDraft(storage, key)) removed = false;
    }
    return removed;
  } catch {
    return false;
  }
}

/** Removes expired or malformed registration drafts, including drafts the user never revisits. */
export function pruneRegistrationDrafts(storage: RegistrationDraftStorage, now = Date.now()) {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => Boolean(key?.startsWith(REGISTRATION_DRAFT_PREFIX)),
    );
    for (const key of keys) {
      try {
        const raw = storage.getItem(key);
        const draft = raw ? (JSON.parse(raw) as Partial<StoredRegistrationDraft>) : null;
        if (
          !draft ||
          draft.version !== REGISTRATION_DRAFT_VERSION ||
          !hasValidTimestamp(draft, now)
        ) {
          removeStoredDraft(storage, key);
        }
      } catch {
        removeStoredDraft(storage, key);
      }
    }
  } catch {
    // Reading the storage index may also fail in restricted browsing modes.
  }
}
