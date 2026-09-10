import { describe, expect, it } from 'vitest';
import {
  batchDraftKey,
  clearBatchDraftOwner,
  createBatchDraftCard,
  migrateSingleRegistrationDraft,
  normalizedRegistrationMobile,
  pruneBatchDrafts,
  readBatchDraft,
  sanitizeBatchCards,
  writeBatchDraft,
} from './batch-registration-draft';
import {
  REGISTRATION_DRAFT_MAX_AGE_MS,
  writeRegistrationDraft,
  type RegistrationDraftStorage,
} from './registration-draft';

const fields = [
  { key: 'name', type: 'text' },
  { key: 'mobile', type: 'tel' },
  { key: 'company', type: 'text' },
  { key: 'city', type: 'select', options: ['深圳', '上海'] },
] as const;
const scope = {
  organizationId: 'org-geo',
  eventId: 101,
  ownerId: 'customer:201',
  purchaseIntentId: 'a6391ad3-5d6c-4424-b596-d5d47d3b553e',
};
function storage() {
  const values = new Map<string, string>();
  const result: RegistrationDraftStorage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return result;
}
const draft = () => ({
  formVersion: 3,
  ticketTypeId: 'ticket-1',
  cards: Array.from({ length: 5 }, (_, index) => ({
    ...createBatchDraftCard(index === 0),
    answers: { name: `参会人${index + 1}`, mobile: `1380013800${index}`, company: '移山科技' },
    editedKeys: ['name', 'mobile'],
  })),
});

describe('batch registration private drafts', () => {
  it('restores five stable identities and explicitly cleared fields without consent material', () => {
    const store = storage();
    const input = draft();
    input.cards[2]!.answers.name = '';
    expect(writeBatchDraft(store, scope, input, fields, 1_000)).toBe(true);
    expect(readBatchDraft(store, scope, fields, 2_000)?.cards).toEqual(input.cards);
    const raw = JSON.parse(store.getItem(batchDraftKey(scope))!);
    expect(raw).not.toHaveProperty('termsAccepted');
    expect(raw).not.toHaveProperty('quoteFingerprint');
  });
  it('isolates organizations, conferences, purchasers, and purchase intents', () => {
    const store = storage();
    writeBatchDraft(store, scope, draft(), fields, 1_000);
    for (const changed of [
      { organizationId: 'other' },
      { eventId: 102 },
      { ownerId: 'customer:202' },
      { purchaseIntentId: crypto.randomUUID() },
    ])
      expect(readBatchDraft(store, { ...scope, ...changed }, fields, 2_000)).toBeNull();
  });
  it('removes unpublished fields and incompatible selections while preserving all people', () => {
    const store = storage();
    const input = draft();
    writeBatchDraft(store, scope, input, fields, 1_000);
    const current = [
      { key: 'name', type: 'text' },
      { key: 'company', type: 'text', enabled: false },
    ] as const;
    expect(
      readBatchDraft(store, scope, current, 2_000)?.cards.every(
        (card) => Object.keys(card.answers).join() === 'name',
      ),
    ).toBe(true);
  });
  it('rejects duplicate stable IDs, repeated self cards, and excessive batch size', () => {
    const input = draft();
    expect(sanitizeBatchCards([input.cards[0], input.cards[0]], fields)).toBeNull();
    input.cards[1]!.isSelf = true;
    expect(sanitizeBatchCards(input.cards, fields)).toBeNull();
    expect(
      sanitizeBatchCards(
        Array.from({ length: 21 }, () => createBatchDraftCard()),
        fields,
      ),
    ).toBeNull();
  });
  it('expires inactive drafts after thirty days and clears only the requested owner', () => {
    const store = storage();
    writeBatchDraft(store, scope, draft(), fields, 1_000);
    writeBatchDraft(store, { ...scope, ownerId: 'customer:202' }, draft(), fields, 2_000);
    clearBatchDraftOwner(store, scope.ownerId);
    expect(store.length).toBe(1);
    expect(
      readBatchDraft(store, { ...scope, ownerId: 'customer:202' }, fields, 2_500),
    ).not.toBeNull();
    pruneBatchDrafts(store, REGISTRATION_DRAFT_MAX_AGE_MS + 2_001);
    expect(store.length).toBe(0);
  });
  it('upgrades old single-person drafts including intentional blanks', () => {
    const store = storage();
    const legacy = { ...scope, purchaseFor: 'self' as const };
    writeRegistrationDraft(
      store,
      legacy,
      3,
      { name: '', mobile: '13800138000' },
      fields,
      Date.now(),
      ['name'],
    );
    const upgraded = migrateSingleRegistrationDraft(store, legacy, 3, 'ticket-1', fields);
    expect(upgraded?.cards).toHaveLength(1);
    expect(upgraded?.cards[0]).toMatchObject({
      isSelf: true,
      answers: { name: '', mobile: '13800138000' },
      editedKeys: ['name'],
    });
  });
  it('normalizes supported mainland mobile spellings consistently', () => {
    expect(normalizedRegistrationMobile('+86 138-0013-8000')).toBe('13800138000');
    expect(normalizedRegistrationMobile('0086(138)00138000')).toBe('13800138000');
  });
});
