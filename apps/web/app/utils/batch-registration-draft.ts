import {
  REGISTRATION_DRAFT_MAX_AGE_MS,
  readRegistrationDraftState,
  sanitizeRegistrationDraftAnswers,
  type RegistrationDraftField,
  type RegistrationDraftScope,
  type RegistrationDraftStorage,
} from './registration-draft';

const PREFIX = 'conference.batchRegistrationDraft.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface BatchDraftCard {
  clientId: string;
  isSelf: boolean;
  answers: Record<string, string>;
  editedKeys: string[];
}
export interface BatchDraft {
  version: 2;
  savedAt: number;
  formVersion: number;
  ticketTypeId: string;
  cards: BatchDraftCard[];
}
export type BatchDraftScope = Omit<RegistrationDraftScope, 'purchaseFor'>;

export function batchDraftKey(scope: BatchDraftScope) {
  return (
    PREFIX +
    [scope.organizationId, scope.eventId, scope.ownerId, scope.purchaseIntentId]
      .map((part) => encodeURIComponent(String(part)))
      .join('.')
  );
}

export function createBatchDraftCard(isSelf = false): BatchDraftCard {
  return { clientId: crypto.randomUUID(), isSelf, answers: {}, editedKeys: [] };
}

export function sanitizeBatchCards(cards: unknown, fields: readonly RegistrationDraftField[]) {
  if (!Array.isArray(cards) || !cards.length || cards.length > 20) return null;
  const ids = new Set<string>();
  let selfSeen = false;
  const result: BatchDraftCard[] = [];
  for (const card of cards) {
    if (!card || typeof card !== 'object' || !UUID.test(card.clientId) || ids.has(card.clientId))
      return null;
    ids.add(card.clientId);
    if (card.isSelf === true && selfSeen) return null;
    if (card.isSelf === true) selfSeen = true;
    const answers = sanitizeRegistrationDraftAnswers(card.answers, fields);
    result.push({
      clientId: card.clientId,
      isSelf: card.isSelf === true,
      answers,
      editedKeys: Array.isArray(card.editedKeys)
        ? card.editedKeys.filter(
            (key: unknown): key is string => typeof key === 'string' && Object.hasOwn(answers, key),
          )
        : Object.keys(answers),
    });
  }
  return result;
}

export function readBatchDraft(
  storage: RegistrationDraftStorage,
  scope: BatchDraftScope,
  fields: readonly RegistrationDraftField[],
  now = Date.now(),
): BatchDraft | null {
  const key = batchDraftKey(scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as BatchDraft;
    const cards = sanitizeBatchCards(draft.cards, fields);
    if (
      draft.version !== 2 ||
      !Number.isFinite(draft.savedAt) ||
      draft.savedAt > now ||
      now - draft.savedAt > REGISTRATION_DRAFT_MAX_AGE_MS ||
      !Number.isInteger(draft.formVersion) ||
      draft.formVersion < 1 ||
      typeof draft.ticketTypeId !== 'string' ||
      !cards
    ) {
      storage.removeItem(key);
      return null;
    }
    return {
      version: 2,
      savedAt: draft.savedAt,
      formVersion: draft.formVersion,
      ticketTypeId: draft.ticketTypeId,
      cards,
    };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* Current in-memory form remains usable. */
    }
    return null;
  }
}

export function writeBatchDraft(
  storage: RegistrationDraftStorage,
  scope: BatchDraftScope,
  draft: Omit<BatchDraft, 'version' | 'savedAt'>,
  fields: readonly RegistrationDraftField[],
  now = Date.now(),
) {
  const cards = sanitizeBatchCards(draft.cards, fields);
  if (!cards) return false;
  try {
    storage.setItem(
      batchDraftKey(scope),
      JSON.stringify({
        version: 2,
        savedAt: now,
        formVersion: draft.formVersion,
        ticketTypeId: draft.ticketTypeId,
        cards,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function removeBatchDraft(storage: RegistrationDraftStorage, scope: BatchDraftScope) {
  try {
    storage.removeItem(batchDraftKey(scope));
  } catch {
    /* Deleting unavailable storage cannot block checkout. */
  }
}

export function clearBatchDraftOwner(storage: RegistrationDraftStorage, ownerId: string) {
  try {
    const owner = encodeURIComponent(ownerId);
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys)
      if (key?.startsWith(PREFIX) && key.slice(PREFIX.length).split('.')[2] === owner)
        storage.removeItem(key);
  } catch {
    /* The visible form is cleared independently. */
  }
}

export function pruneBatchDrafts(storage: RegistrationDraftStorage, now = Date.now()) {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const draft = JSON.parse(storage.getItem(key) ?? 'null');
        if (
          !draft ||
          draft.version !== 2 ||
          !Number.isFinite(draft.savedAt) ||
          draft.savedAt > now ||
          now - draft.savedAt > REGISTRATION_DRAFT_MAX_AGE_MS
        )
          storage.removeItem(key);
      } catch {
        storage.removeItem(key);
      }
    }
  } catch {
    /* The form also works with unavailable browser storage. */
  }
}

export function migrateSingleRegistrationDraft(
  storage: RegistrationDraftStorage,
  scope: RegistrationDraftScope,
  formVersion: number,
  ticketTypeId: string,
  fields: readonly RegistrationDraftField[],
): BatchDraft | null {
  const single = readRegistrationDraftState(storage, scope, formVersion, fields);
  if (!Object.keys(single.answers).length && !single.editedKeys.length) return null;
  return {
    version: 2,
    savedAt: Date.now(),
    formVersion,
    ticketTypeId,
    cards: [
      {
        ...createBatchDraftCard(scope.purchaseFor === 'self'),
        answers: single.answers,
        editedKeys: single.editedKeys,
      },
    ],
  };
}

export function normalizedRegistrationMobile(value: string) {
  return value
    .trim()
    .replace(/[\s()-]/g, '')
    .replace(/^(?:\+86|0086)/, '');
}

export function batchCardHasData(card: BatchDraftCard) {
  return Object.values(card.answers).some((value) => value.trim().length > 0);
}
