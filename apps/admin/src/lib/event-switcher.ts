import type { EventContextOption } from '@conference/contracts';

export interface EventSwitcherGroup {
  key: 'live' | 'operational' | 'completed';
  label: string;
  events: EventContextOption[];
}

const operationalStatuses = new Set<EventContextOption['status']>([
  'draft',
  'configuring',
  'prepublished',
  'registration_open',
]);

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function filterEventOptions(events: EventContextOption[], query: string) {
  const normalized = query.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return events;
  return events.filter((event) =>
    [event.name, event.shortName, event.city].some((value) =>
      value.toLocaleLowerCase('zh-CN').includes(normalized),
    ),
  );
}

export function eventSwitcherGroups(events: EventContextOption[]): EventSwitcherGroup[] {
  const visible = events.filter((event) => event.status !== 'archived');
  const groups: EventSwitcherGroup[] = [
    {
      key: 'live',
      label: '进行中',
      events: visible
        .filter((event) => event.status === 'in_progress')
        .sort((a, b) => timestamp(a.startsAt) - timestamp(b.startsAt)),
    },
    {
      key: 'operational',
      label: '筹备与开放',
      events: visible
        .filter((event) => operationalStatuses.has(event.status))
        .sort((a, b) => timestamp(a.startsAt) - timestamp(b.startsAt)),
    },
    {
      key: 'completed',
      label: '已结束',
      events: visible
        .filter((event) => event.status === 'ended')
        .sort((a, b) => timestamp(b.endsAt) - timestamp(a.endsAt)),
    },
  ];
  return groups.filter((group) => group.events.length);
}
