import { describe, expect, it } from 'vitest';
import { feishuMetricInteger, hasCompleteFeishuPageViewDay } from './feishu-digest.js';

describe('Feishu digest page-view availability', () => {
  const windowStart = new Date('2026-08-18T16:00:00.000Z');

  it('accepts a complete day recorded in the current event timezone', () => {
    expect(
      hasCompleteFeishuPageViewDay({
        dailyTrackingStartedAt: new Date('2026-08-17T00:00:00.000Z'),
        windowStart,
        eventTimezone: 'Asia/Shanghai',
        metricTimezone: 'Asia/Shanghai',
      }),
    ).toBe(true);
  });

  it('marks a day unavailable after the event timezone changes', () => {
    expect(
      hasCompleteFeishuPageViewDay({
        dailyTrackingStartedAt: new Date('2026-08-17T00:00:00.000Z'),
        windowStart,
        eventTimezone: 'Asia/Shanghai',
        metricTimezone: 'UTC',
      }),
    ).toBe(false);
    expect(
      hasCompleteFeishuPageViewDay({
        dailyTrackingStartedAt: new Date('2026-08-19T00:00:00.000Z'),
        windowStart,
        eventTimezone: 'Asia/Shanghai',
        metricTimezone: undefined,
      }),
    ).toBe(false);
  });
});

describe('Feishu digest numeric aggregation', () => {
  it('accepts totals above the PostgreSQL 32-bit integer range', () => {
    expect(feishuMetricInteger('2147483648')).toBe(2_147_483_648);
  });

  it('rejects totals that JavaScript cannot represent exactly', () => {
    expect(() => feishuMetricInteger('9007199254740992')).toThrow(/safe|\u5b89全/u);
  });
});
