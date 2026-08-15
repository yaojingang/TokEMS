import { describe, expect, it } from 'vitest';
import type { EventContextOption, EventId, EventStatus } from '@conference/contracts';
import { eventSwitcherGroups, filterEventOptions } from './event-switcher.js';

function event(
  id: EventId,
  status: EventStatus,
  startsAt: string,
  endsAt: string,
  name = `大会 ${id}`,
): EventContextOption {
  return {
    id,
    slug: `event-${id}`,
    name,
    shortName: name,
    status,
    startsAt,
    endsAt,
    city: '深圳',
    registrationCount: 0,
  };
}

describe('event switcher options', () => {
  const events = [
    event(101, 'ended', '2026-01-01T01:00:00.000Z', '2026-01-02T10:00:00.000Z'),
    event(102, 'registration_open', '2026-10-01T01:00:00.000Z', '2026-10-02T10:00:00.000Z'),
    event(103, 'in_progress', '2026-08-01T01:00:00.000Z', '2026-08-02T10:00:00.000Z'),
    event(104, 'archived', '2025-01-01T01:00:00.000Z', '2025-01-02T10:00:00.000Z'),
    event(105, 'configuring', '2026-09-01T01:00:00.000Z', '2026-09-02T10:00:00.000Z'),
    event(106, 'ended', '2026-02-01T01:00:00.000Z', '2026-02-02T10:00:00.000Z'),
  ];

  it('groups active, operational, and completed events while omitting archives', () => {
    expect(eventSwitcherGroups(events)).toEqual([
      { key: 'live', label: '进行中', events: [events[2]] },
      { key: 'operational', label: '筹备与开放', events: [events[4], events[1]] },
      { key: 'completed', label: '已结束', events: [events[5], events[0]] },
    ]);
  });

  it('searches names, short names, and cities without changing group order', () => {
    const named = [
      event(
        201,
        'in_progress',
        '2026-08-01T01:00:00.000Z',
        '2026-08-02T10:00:00.000Z',
        '深圳人工智能大会',
      ),
      { ...events[1]!, name: '未来论坛', shortName: '北京场', city: '北京' },
    ];

    expect(filterEventOptions(named, '人工智能').map((item) => item.id)).toEqual([201]);
    expect(filterEventOptions(named, '北京').map((item) => item.id)).toEqual([102]);
    expect(filterEventOptions(named, '  ').map((item) => item.id)).toEqual([201, 102]);
  });
});
