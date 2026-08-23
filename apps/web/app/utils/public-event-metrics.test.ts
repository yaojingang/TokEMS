import { describe, expect, it, vi } from 'vitest';
import type { PublicEventMetrics } from '@conference/contracts';
import {
  createPublicViewRecorder,
  formatTrackingStartDate,
  offsetPublicMetric,
  resolvePublicMetricFallbacks,
  shouldRecordPublicView,
  splitMetricNumber,
} from './public-event-metrics';

const emptyMetrics: PublicEventMetrics = {
  pageViews: 0,
  trackingStartedAt: null,
  confirmedAttendees: 0,
  organizationCount: 0,
  cityCount: 0,
};

describe('public event metric display', () => {
  it('records one view for one live event mount', async () => {
    const send = vi.fn().mockResolvedValue({ pageViews: 1 });
    const record = createPublicViewRecorder(send, () => 'page-view-id');
    const input = { slug: 'tokems26', variant: 'live', preview: undefined };

    await record(input);
    await record(input);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('tokems26', 'page-view-id');
  });

  it('skips preview and static variants', async () => {
    const send = vi.fn();
    const record = createPublicViewRecorder(send);

    await record({ slug: 'tokems26', variant: 'live', preview: '1' });
    await record({ slug: 'legacy-event', variant: 'inline', preview: undefined });

    expect(send).not.toHaveBeenCalled();
    expect(shouldRecordPublicView('live', ['0', '1'])).toBe(false);
  });

  it('keeps the initial value when registration fails and does not retry the mount', async () => {
    const send = vi.fn().mockRejectedValue(new Error('network unavailable'));
    const record = createPublicViewRecorder(send, () => 'page-view-id');
    const input = { slug: 'tokems26', variant: 'live', preview: undefined };

    await expect(record(input)).resolves.toBeUndefined();
    await expect(record(input)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it('uses speaker and session fallbacks only for empty dimensions', () => {
    expect(resolvePublicMetricFallbacks(emptyMetrics, { speakers: 40, sessions: 30 })).toEqual({
      organization: { value: 40, unit: '+', fallback: true },
      city: { value: 30, unit: '+', fallback: true },
    });
    expect(
      resolvePublicMetricFallbacks(
        { ...emptyMetrics, organizationCount: 18, cityCount: 7 },
        { speakers: 40, sessions: 30 },
      ),
    ).toEqual({
      organization: { value: 18, unit: '家', fallback: false },
      city: { value: 7, unit: '城', fallback: false },
    });
  });

  it('formats large values and the tracking start date without wrapping tokens', () => {
    expect(splitMetricNumber(123_456)).toEqual({ prefix: '123,45', lastDigit: '6' });
    expect(formatTrackingStartDate('2026-08-16T16:30:00.000Z', 'Asia/Shanghai')).toBe('08.17');
  });

  it('adds the configured public display base without accepting invalid counters', () => {
    expect(offsetPublicMetric(24, '10000')).toBe(10_024);
    expect(offsetPublicMetric(-3, 'invalid')).toBe(10_000);
  });
});
