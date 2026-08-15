import { describe, expect, it } from 'vitest';
import {
  pruneRegistrationDrafts,
  registrationDraftIdentityTransition,
  readRegistrationDraft,
  REGISTRATION_DRAFT_MAX_AGE_MS,
  registrationDraftStorageKey,
  removeRegistrationDraft,
  removeRegistrationDraftVersions,
  type RegistrationDraftScope,
  type RegistrationDraftStorage,
  writeRegistrationDraft,
} from './registration-draft';

const fields = [
  { key: 'name', type: 'text' },
  { key: 'mobile', type: 'tel' },
  { key: 'city', type: 'select', options: ['深圳', '上海'] },
] as const;

const scope: RegistrationDraftScope = {
  organizationId: 'geo-conference',
  eventId: 101,
  ownerId: 'customer:201',
  purchaseFor: 'self',
  purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c034891791a7',
};

function createStorage() {
  const values = new Map<string, string>();
  const storage: RegistrationDraftStorage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  return { storage, values };
}

describe('registration draft storage', () => {
  it('clears customer answers synchronously before entering an anonymous draft context', () => {
    expect(registrationDraftIdentityTransition('customer:201', 'anonymous')).toEqual({
      kind: 'customer_to_anonymous',
      clearAnswers: true,
      restoreTargetDraft: false,
      migrateCurrentAnswers: false,
    });
    expect(registrationDraftIdentityTransition('anonymous', 'customer:202')).toEqual({
      kind: 'anonymous_to_customer',
      clearAnswers: false,
      restoreTargetDraft: true,
      migrateCurrentAnswers: true,
    });
    expect(registrationDraftIdentityTransition('customer:201', 'customer:202')).toEqual({
      kind: 'customer_to_customer',
      clearAnswers: true,
      restoreTargetDraft: true,
      migrateCurrentAnswers: false,
    });
  });

  it('scopes drafts by organization, event, and customer identity', () => {
    const { storage } = createStorage();
    writeRegistrationDraft(
      storage,
      scope,
      3,
      { name: '张三', mobile: '13800138000', internal: 'hidden' },
      fields,
      1_000,
    );

    expect(readRegistrationDraft(storage, scope, 3, fields, 2_000)).toEqual({
      name: '张三',
      mobile: '13800138000',
    });
    expect(
      readRegistrationDraft(storage, { ...scope, ownerId: 'customer:202' }, 3, fields, 2_000),
    ).toEqual({});
    expect(
      readRegistrationDraft(storage, { ...scope, purchaseFor: 'other' }, 3, fields, 2_000),
    ).toEqual({});
    expect(
      readRegistrationDraft(
        storage,
        { ...scope, purchaseIntentId: '503d251a-7a43-43e8-99c3-708d2a0f4f0d' },
        3,
        fields,
        2_000,
      ),
    ).toEqual({});
  });

  it('drops old form versions and select values removed from the current form', () => {
    const { storage } = createStorage();
    writeRegistrationDraft(
      storage,
      scope,
      2,
      { name: '李四', city: '广州' },
      [fields[0], { ...fields[2], options: ['广州'] }],
      1_000,
    );

    expect(readRegistrationDraft(storage, scope, 3, fields, 2_000)).toEqual({});
    expect(
      readRegistrationDraft(
        storage,
        scope,
        2,
        [fields[0], { ...fields[2], options: ['广州'] }],
        2_000,
      ),
    ).toEqual({ name: '李四', city: '广州' });
    writeRegistrationDraft(storage, scope, 3, { name: '李四', city: '广州' }, fields, 3_000);
    expect(readRegistrationDraft(storage, scope, 3, fields, 4_000)).toEqual({ name: '李四' });
  });

  it('cleans expired and malformed drafts even when their events are not reopened', () => {
    const { storage, values } = createStorage();
    writeRegistrationDraft(storage, scope, 3, { name: '王五' }, fields, 1_000);
    values.set(
      registrationDraftStorageKey({ ...scope, eventId: 102 }, 1),
      JSON.stringify({ version: 1, formVersion: 1, savedAt: 1_000, answers: { name: '赵六' } }),
    );
    values.set(registrationDraftStorageKey({ ...scope, eventId: 103 }, 1), '{broken');

    pruneRegistrationDrafts(storage, 1_000 + REGISTRATION_DRAFT_MAX_AGE_MS + 1);

    expect(values.size).toBe(0);
  });

  it('removes drafts after the form is cleared or the flow completes', () => {
    const { storage, values } = createStorage();
    writeRegistrationDraft(storage, scope, 3, { name: '孙七' }, fields, 1_000);
    writeRegistrationDraft(storage, scope, 3, { name: '' }, fields, 2_000);
    expect(values.has(registrationDraftStorageKey(scope, 3))).toBe(false);

    writeRegistrationDraft(storage, scope, 3, { name: '孙七' }, fields, 3_000);
    removeRegistrationDraft(storage, scope, 3);
    expect(values.has(registrationDraftStorageKey(scope, 3))).toBe(false);

    writeRegistrationDraft(storage, scope, 2, { name: '孙七' }, fields, 4_000);
    writeRegistrationDraft(storage, scope, 3, { name: '孙七' }, fields, 5_000);
    removeRegistrationDraftVersions(storage, scope);
    expect(values.has(registrationDraftStorageKey(scope, 2))).toBe(false);
    expect(values.has(registrationDraftStorageKey(scope, 3))).toBe(false);
  });

  it('reports failed writes so identity migration can retain its source draft', () => {
    const { storage } = createStorage();
    const blockedStorage: RegistrationDraftStorage = {
      ...storage,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };

    expect(writeRegistrationDraft(blockedStorage, scope, 3, { name: '周八' }, fields, 1_000)).toBe(
      false,
    );
  });
});
