import { describe, expect, it } from 'vitest';
import type { AttendeeNeedsProfile } from '@conference/contracts';
import {
  attendeeNeedsBlockIsEnabled,
  attendeeNeedsRequestIsCurrent,
  attendeeNeedsShouldResetSerializedState,
  attendeeNeedsValidPage,
  resolveAttendeeNeedsAccountState,
  resolveAttendeeNeedsFallback,
  resolveAttendeeNeedsSectionState,
} from './attendee-needs';

describe('attendee needs request ownership', () => {
  it('rejects a response that belongs to the previously viewed event', () => {
    expect(attendeeNeedsRequestIsCurrent('tokems26', 'another-event')).toBe(false);
    expect(attendeeNeedsRequestIsCurrent('tokems26', 'tokems26')).toBe(true);
  });
});

describe('attendee needs serialized page state', () => {
  it('keeps SSR state during hydration and clears it on a later SPA revisit', () => {
    expect(attendeeNeedsShouldResetSerializedState(true, true)).toBe(false);
    expect(attendeeNeedsShouldResetSerializedState(true, false)).toBe(true);
    expect(attendeeNeedsShouldResetSerializedState(false, false)).toBe(false);
  });
});

describe('attendee needs page recovery', () => {
  it.each([
    [1, 1, 1],
    [2, 1, 1],
    [3, 2, 2],
    [2, 3, 2],
    [0, 3, 1],
  ])('maps requested page %i with %i total pages to %i', (requested, total, expected) => {
    expect(attendeeNeedsValidPage(requested, total)).toBe(expected);
  });
});

describe('attendee needs homepage section', () => {
  it('requires the released node key and type before requesting public questions', () => {
    expect(
      attendeeNeedsBlockIsEnabled({
        nodeKey: 'home.attendee-needs',
        type: 'faq-summary',
        enabled: true,
      }),
    ).toBe(false);
    expect(
      attendeeNeedsBlockIsEnabled({
        nodeKey: 'home.attendee-needs',
        type: 'attendee-needs',
        enabled: true,
      }),
    ).toBe(true);
  });
  it.each([
    ['disabled', false, 4, false, false, false, 'hidden'],
    ['loading', true, 0, true, false, true, 'loading'],
    ['empty', true, 0, false, false, true, 'empty'],
    ['ready', true, 2, false, false, true, 'ready'],
    ['error', true, 0, false, true, true, 'error'],
  ] as const)(
    'keeps the %s state aligned with the released block',
    (_label, blockEnabled, total, pending, hasError, visible, status) => {
      expect(resolveAttendeeNeedsSectionState({ blockEnabled, total, pending, hasError })).toEqual({
        visible,
        status,
      });
    },
  );
  it('never reuses questions from a different event or page after a request failure', () => {
    const previous = {
      eventSlug: 'event-a',
      page: 1,
      result: {
        items: [
          {
            questionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            content: '大会 A 的问题',
            tags: [],
            firstPublishedAt: '2026-08-23T00:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10 as const,
        totalPages: 1,
        snapshotAt: '2026-08-23T00:00:00.000Z',
      },
    };

    expect(resolveAttendeeNeedsFallback(previous, 'event-a', 1).total).toBe(1);
    expect(resolveAttendeeNeedsFallback(previous, 'event-b', 1)).toMatchObject({
      items: [],
      total: 0,
      page: 1,
    });
    expect(resolveAttendeeNeedsFallback(previous, 'event-a', 2)).toMatchObject({
      items: [],
      total: 0,
      page: 2,
    });
  });
});

describe('attendee needs personal-center state', () => {
  it('keeps a request failure distinct from an empty submission and offers retry', () => {
    expect(resolveAttendeeNeedsAccountState(undefined, true)).toEqual({
      label: '读取失败',
      canEdit: false,
      canRetry: true,
      hasMaterial: false,
    });
    expect(resolveAttendeeNeedsAccountState(undefined, false)).toEqual({
      label: '正在读取',
      canEdit: false,
      canRetry: false,
      hasMaterial: false,
    });
  });

  it('derives editable and published states from a loaded profile', () => {
    const base = {
      id: null,
      featureEnabled: true,
      canCreate: true,
      qualified: true,
      isPublic: true,
      isAnonymous: true,
      effectivePublic: false,
      adminRemovedCount: 0,
      questions: [],
    } as unknown as AttendeeNeedsProfile;

    expect(resolveAttendeeNeedsAccountState(base, false)).toMatchObject({
      label: '未提交',
      canEdit: true,
      hasMaterial: false,
    });
    expect(
      resolveAttendeeNeedsAccountState(
        {
          ...base,
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          effectivePublic: true,
        },
        false,
      ),
    ).toMatchObject({ label: '匿名公开', canEdit: true, hasMaterial: true });
  });
});
