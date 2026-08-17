import { describe, expect, it } from 'vitest';
import {
  PublicEventMetricsSchema,
  PublicEventViewResultSchema,
  RecordPublicEventViewSchema,
} from './index.js';

describe('public event metrics contracts', () => {
  it('accepts zero values before tracking starts', () => {
    expect(
      PublicEventMetricsSchema.parse({
        pageViews: 0,
        trackingStartedAt: null,
        confirmedAttendees: 0,
        organizationCount: 0,
        cityCount: 0,
      }),
    ).toEqual({
      pageViews: 0,
      trackingStartedAt: null,
      confirmedAttendees: 0,
      organizationCount: 0,
      cityCount: 0,
    });
  });

  it('accepts safe large counters and ISO timestamps', () => {
    const pageViews = Number.MAX_SAFE_INTEGER;
    expect(
      PublicEventViewResultSchema.parse({
        pageViews,
        trackingStartedAt: '2026-08-17T03:12:00.000Z',
        updatedAt: '2026-08-17T03:12:01.000Z',
      }),
    ).toMatchObject({ pageViews });
  });

  it('requires a strict page-level UUID', () => {
    expect(
      RecordPublicEventViewSchema.parse({
        pageViewId: '8ab2e19d-7204-4a03-b6db-66239a80364c',
      }),
    ).toEqual({ pageViewId: '8ab2e19d-7204-4a03-b6db-66239a80364c' });
    expect(RecordPublicEventViewSchema.safeParse({ pageViewId: 'same-page' }).success).toBe(false);
    expect(
      RecordPublicEventViewSchema.safeParse({
        pageViewId: '8ab2e19d-7204-4a03-b6db-66239a80364c',
        visitorId: 'not-allowed',
      }).success,
    ).toBe(false);
  });
});
