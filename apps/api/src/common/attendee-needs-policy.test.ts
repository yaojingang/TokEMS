import { describe, expect, it } from 'vitest';
import {
  attendeeNeedModerationStateError,
  attendeeNeedQuestionIsVisible,
  attendeeNeedsCanCreate,
  attendeeNeedsFlowEnabled,
  attendeeNeedsHomeEnabled,
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
        firstPublishedAt: new Date('2026-08-22T00:00:00Z'),
        adminHiddenAt: null,
        deletedAt: null,
      }),
    ).toBe(true);
    expect(
      attendeeNeedQuestionIsVisible({
        qualified: true,
        firstPublishedAt: new Date('2026-08-22T00:00:00Z'),
        adminHiddenAt: new Date('2026-08-22T01:00:00Z'),
        deletedAt: null,
      }),
    ).toBe(false);
    expect(
      attendeeNeedQuestionIsVisible({
        qualified: true,
        firstPublishedAt: null,
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
        steps: [{ type: 'attendee-needs', enabled: false }],
      },
    },
  };
  const enabledRelease = {
    experience: {
      registrationFlow: {
        steps: [{ type: 'attendee-needs', enabled: true }],
      },
    },
  };

  it('requires the active release step for a new submission', () => {
    expect(attendeeNeedsFlowEnabled(null)).toBe(false);
    expect(attendeeNeedsFlowEnabled(disabledRelease)).toBe(false);
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
