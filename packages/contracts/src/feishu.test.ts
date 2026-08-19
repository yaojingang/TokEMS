import { describe, expect, it } from 'vitest';
import {
  UpdateFeishuBotConfigurationSchema,
  UpdateFeishuDigestSubscriptionSchema,
  FeishuDigestTestMessageSchema,
  dateInTimeZone,
  feishuDigestReportWindow,
  nextFeishuDigestRun,
  zonedDateTimeToDate,
} from './feishu.js';

describe('Feishu digest contracts', () => {
  it('validates bot credentials and target chat configuration', () => {
    expect(
      UpdateFeishuBotConfigurationSchema.parse({
        enabled: true,
        appId: 'cli_tokems123',
        appSecret: 'secret-value',
      }),
    ).toMatchObject({ appId: 'cli_tokems123' });

    expect(
      UpdateFeishuDigestSubscriptionSchema.safeParse({
        enabled: true,
        chatId: null,
        chatName: null,
        sendLocalTime: '09:00',
      }).success,
    ).toBe(false);

    expect(
      FeishuDigestTestMessageSchema.safeParse({
        chatId: 'oc_tokems',
        chatName: '大会运营群',
        dataVisibilityConfirmed: false,
      }).success,
    ).toBe(false);
  });

  it('uses the event timezone for the previous complete calendar day', () => {
    const window = feishuDigestReportWindow(new Date('2026-08-20T01:00:00.000Z'), 'Asia/Shanghai');
    expect(window).toEqual({
      reportDate: '2026-08-19',
      windowStart: new Date('2026-08-18T16:00:00.000Z'),
      windowEnd: new Date('2026-08-19T16:00:00.000Z'),
    });
    expect(dateInTimeZone(new Date('2026-08-19T16:30:00.000Z'), 'Asia/Shanghai')).toBe(
      '2026-08-20',
    );
  });

  it('handles daylight-saving transitions without assuming a fixed offset', () => {
    expect(zonedDateTimeToDate('2026-03-09', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-03-09T13:00:00.000Z',
    );
    expect(
      nextFeishuDigestRun(
        new Date('2026-03-08T13:30:00.000Z'),
        'America/New_York',
        '09:00',
      ).toISOString(),
    ).toBe('2026-03-09T13:00:00.000Z');
  });

  it('moves a nonexistent daylight-saving send time to the first valid local minute', () => {
    expect(
      nextFeishuDigestRun(
        new Date('2026-03-08T06:00:00.000Z'),
        'America/New_York',
        '02:30',
      ).toISOString(),
    ).toBe('2026-03-08T07:00:00.000Z');
  });

  it('starts a report day at the first valid minute when midnight is skipped', () => {
    const window = feishuDigestReportWindow(
      new Date('2026-09-07T12:00:00.000Z'),
      'America/Santiago',
      '2026-09-06',
    );

    expect(window.windowStart.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(window.windowEnd.toISOString()).toBe('2026-09-07T03:00:00.000Z');
  });
});
