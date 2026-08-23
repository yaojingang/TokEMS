import { describe, expect, it } from 'vitest';
import {
  attendeeNeedAdminEditAuditFacts,
  attendeeNeedAdminEditMetadata,
  attendeeNeedGovernanceRequiresReview,
  attendeeNeedModerationStateError,
  attendeeNeedQuestionIsVisible,
  resolveAttendeeNeedPublicationIdentity,
  attendeeNeedsCanCreate,
  attendeeNeedsFlowEnabled,
  attendeeNeedsForcedAnonymityFromAudit,
  attendeeNeedsHomeEnabled,
  attendeeNeedsReplacementRequiresReview,
  attendeeNeedsSnapshotCutoff,
  attendeeNeedsTotalPages,
  attendeeNeedsQualification,
  attendeeNeedsVersionMatches,
} from './attendee-needs-policy.js';

const eligible = {
  eventStatus: 'registration_open',
  customerStatus: 'active',
  registrationStatus: 'confirmed',
  orderStatus: 'paid',
  paymentSatisfied: true,
  ticketStatus: 'valid',
  isPublic: true,
};

describe('attendee needs qualification', () => {
  it('keeps paid and partially refunded registrations eligible', () => {
    expect(attendeeNeedsQualification(eligible).qualified).toBe(true);
    expect(
      attendeeNeedsQualification({ ...eligible, orderStatus: 'partially_refunded' }).qualified,
    ).toBe(true);
  });

  it.each([
    ['draft event', { eventStatus: 'draft' }],
    ['blocked account', { customerStatus: 'blocked' }],
    ['cancelled registration', { registrationStatus: 'cancelled' }],
    ['full refund', { orderStatus: 'refunded' }],
    ['missing payment', { paymentSatisfied: false }],
    ['cancelled ticket', { ticketStatus: 'cancelled' }],
    ['private submission', { isPublic: false }],
  ])('rejects %s', (_label, change) => {
    expect(attendeeNeedsQualification({ ...eligible, ...change }).qualified).toBe(false);
  });

  it('excludes hidden, deleted, and never-published questions', () => {
    expect(
      attendeeNeedQuestionIsVisible({
        qualified: true,
        publicationEnabled: true,
        consentVersionCurrent: true,
        firstPublishedAt: new Date('2026-08-22T00:00:00Z'),
        adminHiddenAt: null,
        deletedAt: null,
      }),
    ).toBe(true);
    expect(
      attendeeNeedQuestionIsVisible({
        qualified: true,
        publicationEnabled: true,
        consentVersionCurrent: true,
        firstPublishedAt: new Date('2026-08-22T00:00:00Z'),
        adminHiddenAt: new Date('2026-08-22T01:00:00Z'),
        deletedAt: null,
      }),
    ).toBe(false);
    expect(
      attendeeNeedQuestionIsVisible({
        qualified: true,
        publicationEnabled: true,
        consentVersionCurrent: true,
        firstPublishedAt: null,
        adminHiddenAt: null,
        deletedAt: null,
      }),
    ).toBe(false);
  });

  it('stops publishing questions authorized under an older consent version', () => {
    expect(
      attendeeNeedQuestionIsVisible({
        qualified: true,
        publicationEnabled: true,
        consentVersionCurrent: false,
        firstPublishedAt: new Date('2026-08-22T00:00:00Z'),
        adminHiddenAt: null,
        deletedAt: null,
      }),
    ).toBe(false);
  });

  it('keeps qualified questions unpublished while the released home block is closed', () => {
    expect(
      attendeeNeedQuestionIsVisible({
        qualified: true,
        publicationEnabled: false,
        consentVersionCurrent: true,
        firstPublishedAt: new Date('2026-08-22T00:00:00Z'),
        adminHiddenAt: null,
        deletedAt: null,
      }),
    ).toBe(false);
  });
});

describe('attendee needs optimistic version', () => {
  it('accepts version zero only while creating a submission in the same update', () => {
    expect(attendeeNeedsVersionMatches(0, 1, true)).toBe(true);
    expect(attendeeNeedsVersionMatches(0, 2, false)).toBe(false);
    expect(attendeeNeedsVersionMatches(2, 2, false)).toBe(true);
    expect(attendeeNeedsVersionMatches(1, 2, false)).toBe(false);
  });
});

describe('attendee needs release gate', () => {
  const disabledRelease = {
    experience: {
      registrationFlow: {
        steps: [{ nodeKey: 'flow.attendee-needs', type: 'attendee-needs', enabled: false }],
      },
    },
  };
  const enabledRelease = {
    experience: {
      registrationFlow: {
        steps: [{ nodeKey: 'flow.attendee-needs', type: 'attendee-needs', enabled: true }],
      },
    },
  };

  it('requires the active release step for a new submission', () => {
    expect(attendeeNeedsFlowEnabled(null)).toBe(false);
    expect(attendeeNeedsFlowEnabled(disabledRelease)).toBe(false);
    expect(
      attendeeNeedsFlowEnabled({
        experience: {
          registrationFlow: {
            steps: [{ nodeKey: 'flow.custom', type: 'attendee-needs', enabled: true }],
          },
        },
      }),
    ).toBe(false);
    expect(attendeeNeedsCanCreate(false, disabledRelease)).toBe(false);
    expect(attendeeNeedsCanCreate(false, enabledRelease)).toBe(true);
  });

  it('keeps existing submissions editable after the step is closed', () => {
    expect(attendeeNeedsCanCreate(true, disabledRelease)).toBe(true);
  });

  it('uses the released home block as the public publication boundary', () => {
    expect(attendeeNeedsHomeEnabled({ home: { blocks: [] } })).toBe(false);
    expect(
      attendeeNeedsHomeEnabled({
        home: {
          blocks: [{ nodeKey: 'home.attendee-needs', type: 'attendee-needs', enabled: false }],
        },
      }),
    ).toBe(false);
    expect(
      attendeeNeedsHomeEnabled({
        experience: {
          home: {
            blocks: [{ nodeKey: 'home.attendee-needs', type: 'attendee-needs', enabled: true }],
          },
        },
      }),
    ).toBe(true);
  });
});

describe('attendee needs public pagination', () => {
  it('clamps an untrusted future cutoff to the current request time', () => {
    const now = new Date('2026-08-23T08:00:00.000Z');
    expect(attendeeNeedsSnapshotCutoff('2099-01-01T00:00:00.000Z', now)).toEqual(now);
    expect(attendeeNeedsSnapshotCutoff('2026-08-22T00:00:00.000Z', now)).toEqual(
      new Date('2026-08-22T00:00:00.000Z'),
    );
  });

  it.each([
    [0, 1],
    [1, 1],
    [10, 1],
    [11, 2],
    [20, 2],
    [21, 3],
  ])('forms %i questions into %i pages', (total, pages) => {
    expect(attendeeNeedsTotalPages(total)).toBe(pages);
  });
});

describe('attendee needs moderation state', () => {
  const active = { adminHiddenAt: null, deletedAt: null, deletedByType: null };

  it('never turns a user deletion into an administrator-restorable deletion', () => {
    const userDeleted = {
      ...active,
      deletedAt: new Date('2026-08-22T00:00:00Z'),
      deletedByType: 'customer',
    };
    expect(attendeeNeedModerationStateError({ ...userDeleted, action: 'delete' })).toBeTruthy();
    expect(
      attendeeNeedModerationStateError({ ...userDeleted, action: 'restore-delete' }),
    ).toBeTruthy();
  });

  it('allows only a hidden question to be restored and an admin deletion to be recovered', () => {
    expect(attendeeNeedModerationStateError({ ...active, action: 'restore' })).toBeTruthy();
    expect(
      attendeeNeedModerationStateError({
        ...active,
        action: 'restore',
        adminHiddenAt: new Date('2026-08-22T00:00:00Z'),
      }),
    ).toBeNull();
    expect(
      attendeeNeedModerationStateError({
        ...active,
        action: 'restore-delete',
        deletedAt: new Date('2026-08-22T00:00:00Z'),
        deletedByType: 'admin',
      }),
    ).toBeNull();
  });
});

describe('attendee needs administrator edit attribution', () => {
  it('records edit facts without copying question content into the audit log', () => {
    const facts = attendeeNeedAdminEditAuditFacts({
      contentChanged: true,
      tagCodesChanged: true,
      wasAdminEdited: false,
      wasAnonymous: false,
      nextAnonymous: true,
      reason: '统一措辞',
    });

    expect(facts.before).toEqual({ edited: false, isAnonymous: false });
    expect(facts.after).toEqual({
      contentChanged: true,
      tagCodesChanged: true,
      forcedAnonymous: true,
      isAnonymous: true,
      reason: '统一措辞',
    });
    expect(JSON.stringify(facts)).not.toContain('问题正文');
  });

  it('preserves administrator attribution when the customer changes only publication settings', () => {
    const editedAt = new Date('2026-08-23T00:00:00Z');
    expect(
      attendeeNeedAdminEditMetadata({
        currentContent: '管理员调整后的问题',
        currentTagCodes: ['geo-roi'],
        currentEditedAt: editedAt,
        currentEditReason: '统一措辞',
        nextContent: '管理员调整后的问题',
        nextTagCodes: ['geo-roi'],
      }),
    ).toEqual({ adminEditedAt: editedAt, adminEditReason: '统一措辞' });
  });

  it('clears administrator attribution after the customer changes the governed content', () => {
    expect(
      attendeeNeedAdminEditMetadata({
        currentContent: '管理员调整后的问题',
        currentTagCodes: ['geo-roi'],
        currentEditedAt: new Date('2026-08-23T00:00:00Z'),
        currentEditReason: '统一措辞',
        nextContent: '用户重新表达的问题',
        nextTagCodes: ['geo-roi'],
      }),
    ).toEqual({ adminEditedAt: null, adminEditReason: null });
  });
});

describe('attendee needs publication identity', () => {
  it('derives persistent forced anonymity from content-free governance audit facts', () => {
    expect(attendeeNeedsForcedAnonymityFromAudit([])).toEqual({ forced: false, reason: null });
    expect(
      attendeeNeedsForcedAnonymityFromAudit([
        { after: { forcedAnonymous: true, reason: '嘉宾材料统一匿名' } },
      ]),
    ).toEqual({ forced: true, reason: '嘉宾材料统一匿名' });
  });

  it('keeps administrator-forced anonymity after a customer saves again', () => {
    expect(
      resolveAttendeeNeedPublicationIdentity({
        requestedAnonymous: false,
        requestedAttributionName: '参会者姓名',
        canonicalAttributionName: '参会者姓名',
        adminForcedAnonymous: true,
      }),
    ).toEqual({ isAnonymous: true, attributionName: null, validationError: null });
  });

  it('rejects a public attribution that does not match the registration identity', () => {
    expect(
      resolveAttendeeNeedPublicationIdentity({
        requestedAnonymous: false,
        requestedAttributionName: '被冒用的嘉宾',
        canonicalAttributionName: '参会者姓名',
        adminForcedAnonymous: false,
      }).validationError,
    ).toBeTruthy();
  });
});

describe('attendee needs governed-content replacement', () => {
  it('stops carrying a hidden review flag after the user removes that row', () => {
    const hiddenAt = new Date('2026-08-23T00:00:00Z');
    expect(
      attendeeNeedGovernanceRequiresReview({
        adminHiddenAt: hiddenAt,
        deletedAt: null,
        deletedByType: null,
      }),
    ).toBe(true);
    expect(
      attendeeNeedGovernanceRequiresReview({
        adminHiddenAt: hiddenAt,
        deletedAt: new Date('2026-08-23T01:00:00Z'),
        deletedByType: 'customer',
      }),
    ).toBe(false);
    expect(
      attendeeNeedGovernanceRequiresReview({
        adminHiddenAt: null,
        deletedAt: new Date('2026-08-23T01:00:00Z'),
        deletedByType: 'admin',
      }),
    ).toBe(true);
  });

  it('requires review when adding a replacement after administrator governance', () => {
    expect(
      attendeeNeedsReplacementRequiresReview(
        ['企业内部应该如何确定 GEO 第一阶段的目标？'],
        [
          {
            content: '  企业内部应该如何确定   GEO 第一阶段的目标？ ',
          },
        ],
      ),
    ).toBe(true);
    expect(
      attendeeNeedsReplacementRequiresReview(
        ['企业内部应该如何确定 GEO 第一阶段的目标？'],
        [{ content: '这是一个表达完全不同的新问题。' }],
      ),
    ).toBe(true);
  });

  it('allows an existing governed row to keep its identifier while the customer edits it', () => {
    expect(
      attendeeNeedsReplacementRequiresReview(
        ['企业内部应该如何确定 GEO 第一阶段的目标？'],
        [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            content: '企业内部应该如何确定 GEO 第一阶段的目标？',
          },
        ],
      ),
    ).toBe(false);
  });
});
