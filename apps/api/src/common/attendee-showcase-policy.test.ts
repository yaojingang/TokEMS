import { describe, expect, it } from 'vitest';
import {
  attendeeAvatarInitial,
  attendeeShowcaseConsentMetadata,
  attendeeShowcaseQualification,
  attendeeShowcaseVersionMatches,
} from './attendee-showcase-policy.js';

describe('attendee avatar initial', () => {
  it.each([
    ['姚金刚', '姚'],
    ['  张三', '张'],
    ['Alice', 'A'],
    ['🧑‍💻开发者', '🧑'],
  ])('uses the first entered character from %s', (displayName, expected) => {
    expect(attendeeAvatarInitial(displayName)).toBe(expected);
  });

  it('returns null for a blank name', () => {
    expect(attendeeAvatarInitial('   ')).toBeNull();
  });
});

describe('attendee showcase consent metadata', () => {
  const acceptedAt = new Date('2026-08-15T01:00:00.000Z');
  const editedAt = new Date('2026-08-15T02:00:00.000Z');

  it('preserves the original consent time during an ordinary public profile edit', () => {
    expect(
      attendeeShowcaseConsentMetadata({
        nextIsPublic: true,
        currentIsPublic: true,
        currentVersion: '2026-08',
        currentConsentAt: acceptedAt,
        requiredVersion: '2026-08',
        now: editedAt,
      }),
    ).toEqual({ consentVersion: '2026-08', consentAt: acceptedAt });
  });

  it('records a new acceptance when publishing or accepting a new consent version', () => {
    expect(
      attendeeShowcaseConsentMetadata({
        nextIsPublic: true,
        currentIsPublic: false,
        currentVersion: null,
        currentConsentAt: null,
        requiredVersion: '2026-08',
        now: editedAt,
      }),
    ).toEqual({ consentVersion: '2026-08', consentAt: editedAt });
  });
});

const eligible = {
  eventStatus: 'registration_open',
  customerStatus: 'active',
  registrationStatus: 'confirmed',
  orderStatus: 'paid',
  paymentSatisfied: true,
  ticketStatus: 'valid',
  isPublic: true,
  adminHiddenAt: null,
};

describe('attendee showcase qualification', () => {
  it('keeps paid and partially refunded registrations public', () => {
    expect(attendeeShowcaseQualification(eligible).qualified).toBe(true);
    expect(
      attendeeShowcaseQualification({ ...eligible, orderStatus: 'partially_refunded' }).qualified,
    ).toBe(true);
  });

  it.each([
    ['draft event', { eventStatus: 'draft' }],
    ['blocked account', { customerStatus: 'blocked' }],
    ['cancelled registration', { registrationStatus: 'cancelled' }],
    ['full refund', { orderStatus: 'refunded' }],
    ['missing payment', { paymentSatisfied: false }],
    ['cancelled ticket', { ticketStatus: 'cancelled' }],
    ['private profile', { isPublic: false }],
    ['moderated profile', { adminHiddenAt: new Date('2026-08-15T00:00:00Z') }],
  ])('hides a profile for %s', (_label, change) => {
    expect(attendeeShowcaseQualification({ ...eligible, ...change }).qualified).toBe(false);
  });
});

describe('attendee showcase optimistic version', () => {
  it('accepts version zero only for the profile created by the same update', () => {
    expect(attendeeShowcaseVersionMatches(0, 1, true)).toBe(true);
    expect(attendeeShowcaseVersionMatches(0, 2, false)).toBe(false);
    expect(attendeeShowcaseVersionMatches(2, 2, false)).toBe(true);
    expect(attendeeShowcaseVersionMatches(1, 2, false)).toBe(false);
  });
});
