import { describe, expect, it, vi } from 'vitest';
import type { EventContextOption, EventId } from '@conference/contracts';
import {
  adminEntryPreferenceNotice,
  clearLegacyEventPreference,
  createEventOptionsLoader,
  createLatestPreferenceWriter,
  eventLandingRouteName,
  hasEventWorkspaceLanding,
  managementLandingRouteName,
  mergeEventContextOption,
  readRecentEventId,
  recentEventStorageKey,
  resolveAdminEntry,
  safeRedirectPath,
  writeRecentEventId,
} from './admin-entry.js';

function event(id: EventId, status: EventContextOption['status']): EventContextOption {
  return {
    id,
    slug: `event-${id}`,
    name: `大会 ${id}`,
    shortName: `大会 ${id}`,
    status,
    startsAt: '2026-08-18T01:00:00.000Z',
    endsAt: '2026-08-20T10:00:00.000Z',
    city: '深圳',
    registrationCount: 0,
  };
}

describe('administrator entry resolution', () => {
  it('does not expose a workspace landing page for check-in-only permissions', () => {
    const grants = ['event.read', 'event.checkin.execute', 'event.checkin.manage'];

    expect(eventLandingRouteName(grants)).toBe('forbidden');
    expect(hasEventWorkspaceLanding(grants)).toBe(false);
  });

  it('routes conference-scoped invoice users into the conference workspace', () => {
    const grants = ['event.read', 'org.invoice.read'];

    expect(eventLandingRouteName(grants)).toBe('event-invoices');
    expect(managementLandingRouteName(['org.invoice.read'])).toBe('forbidden');
    expect(
      resolveAdminEntry({
        grants,
        events: [event(101, 'in_progress')],
      }),
    ).toMatchObject({
      route: { name: 'event-invoices', params: { eventId: 101 } },
      reason: 'single_live',
    });
  });

  it('does not expose a workspace landing page for AI-only permissions', () => {
    const grants = ['event.read', 'event.ai.read'];

    expect(eventLandingRouteName(grants)).toBe('forbidden');
    expect(hasEventWorkspaceLanding(grants)).toBe(false);
  });

  it('routes content managers with website access to general settings', () => {
    expect(eventLandingRouteName(['event.read', 'event.content.manage', 'event.site.read'])).toBe(
      'event-settings-general',
    );
  });

  it('keeps known same-origin redirects and rejects unsafe or looping targets', () => {
    const knownRoute = (path: string) => path.startsWith('/events/') || path === '/manage/events';

    expect(safeRedirectPath('/events/101/orders?q=paid', knownRoute)).toBe(
      '/events/101/orders?q=paid',
    );
    expect(safeRedirectPath('/manage/events', knownRoute)).toBe('/manage/events');
    expect(safeRedirectPath('//example.com', knownRoute)).toBeUndefined();
    expect(safeRedirectPath('/%5cexample.com', knownRoute)).toBeUndefined();
    expect(safeRedirectPath('/login?redirect=/login', () => true)).toBeUndefined();
    expect(safeRedirectPath('/missing', knownRoute)).toBeUndefined();
  });

  it('prefers the current browser selection over an older server preference', () => {
    expect(
      resolveAdminEntry({
        grants: ['event.read', 'event.dashboard.read'],
        events: [event(101, 'registration_open'), event(102, 'in_progress')],
        localEventId: 101,
        serverEventId: 102,
      }),
    ).toEqual({
      route: { name: 'event-overview', params: { eventId: 101 } },
      reason: 'local_recent',
      clearLocalPreference: false,
      clearServerPreference: false,
    });
  });

  it('clears an invalid local preference and seeds a valid server preference', () => {
    const result = resolveAdminEntry({
      grants: ['event.read', 'event.order.read'],
      events: [event(102, 'ended'), event(103, 'archived')],
      localEventId: 999,
      serverEventId: 102,
    });
    expect(result).toEqual({
      route: { name: 'event-orders', params: { eventId: 102 } },
      reason: 'server_recent',
      clearLocalPreference: true,
      clearServerPreference: false,
      seedLocalEventId: 102,
    });
    expect(adminEntryPreferenceNotice(result)).toBe(
      '当前浏览器记录的大会已不可用，已恢复到账号最近使用的大会。',
    );
  });

  it('describes whether an invalid preference was recovered or needs a new choice', () => {
    expect(
      adminEntryPreferenceNotice({
        route: { name: 'event-overview', params: { eventId: 101 } },
        reason: 'single_live',
        clearLocalPreference: true,
        clearServerPreference: false,
      }),
    ).toBe('上次访问的大会已不可用，已进入当前可用大会。');
    expect(
      adminEntryPreferenceNotice({
        route: { name: 'manage-events' },
        reason: 'choose_event',
        clearLocalPreference: true,
        clearServerPreference: true,
      }),
    ).toBe('上次访问的大会已归档或不可用，请重新选择。');
  });

  it.each([
    {
      name: 'the only live event',
      events: [event(101, 'in_progress'), event(102, 'registration_open')],
      expectedId: 101,
      reason: 'single_live',
    },
    {
      name: 'the only operational event when there is no live event',
      events: [event(101, 'registration_open'), event(102, 'ended')],
      expectedId: 101,
      reason: 'single_operational',
    },
    {
      name: 'the only non-archived event',
      events: [event(101, 'ended'), event(102, 'archived')],
      expectedId: 101,
      reason: 'single_event',
    },
  ])('selects $name', ({ events, expectedId, reason }) => {
    expect(
      resolveAdminEntry({
        grants: ['event.read', 'event.dashboard.read'],
        events,
      }),
    ).toMatchObject({
      route: { name: 'event-overview', params: { eventId: expectedId } },
      reason,
    });
  });

  it('opens the chooser when candidates remain ambiguous', () => {
    expect(
      resolveAdminEntry({
        grants: ['event.read', 'event.dashboard.read'],
        events: [event(101, 'in_progress'), event(102, 'in_progress')],
      }),
    ).toMatchObject({ route: { name: 'manage-events' }, reason: 'choose_event' });
  });

  it('keeps event-read-only members in the event list', () => {
    expect(
      resolveAdminEntry({
        grants: ['event.read'],
        events: [event(101, 'in_progress')],
      }),
    ).toMatchObject({ route: { name: 'manage-events' }, reason: 'management_only' });
  });

  it('isolates browser preferences by organization and public user ID', () => {
    const values = new Map<string, string>([
      ['conference.admin.eventId', '888'],
      ['conference.admin.eventSlug', 'legacy-event'],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const scope = { organizationId: 'org-a', publicUserId: 101 };

    expect(recentEventStorageKey(scope)).toBe('conference.admin.lastEventId.org-a.101');
    writeRecentEventId(storage, scope, 102);
    expect(readRecentEventId(storage, scope)).toBe(102);

    writeRecentEventId(storage, scope, undefined);
    expect(readRecentEventId(storage, scope)).toBeUndefined();

    clearLegacyEventPreference(storage);
    expect(values.has('conference.admin.eventId')).toBe(false);
    expect(values.has('conference.admin.eventSlug')).toBe(false);
  });

  it('shares an in-flight event-options request and reloads after invalidation', async () => {
    let resolveRequest: ((value: EventContextOption[]) => void) | undefined;
    const fetchOptions = vi.fn(
      () =>
        new Promise<EventContextOption[]>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const loader = createEventOptionsLoader(fetchOptions);

    const first = loader.load();
    const second = loader.load();
    expect(fetchOptions).toHaveBeenCalledOnce();
    resolveRequest?.([event(101, 'in_progress')]);
    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);

    await loader.load();
    expect(fetchOptions).toHaveBeenCalledOnce();
    loader.invalidate();
    const reloaded = loader.load();
    resolveRequest?.([event(102, 'ended')]);
    await expect(reloaded).resolves.toEqual([event(102, 'ended')]);
    expect(fetchOptions).toHaveBeenCalledTimes(2);
  });

  it('serializes preference writes and coalesces rapid switches to the latest value', async () => {
    let releaseFirst: (() => void) | undefined;
    const writes: Array<EventId | null> = [];
    const write = vi.fn(async (eventId: EventId | null) => {
      writes.push(eventId);
      if (writes.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });
    const writer = createLatestPreferenceWriter(write);

    writer.schedule(101);
    writer.schedule(102);
    writer.schedule(103);
    releaseFirst?.();
    await writer.whenIdle();

    expect(writes).toEqual([101, 103]);
  });

  it('drops queued writes when the authenticated account changes', async () => {
    let releaseFirst: (() => void) | undefined;
    const writes: Array<EventId | null> = [];
    const writer = createLatestPreferenceWriter(async (eventId) => {
      writes.push(eventId);
      if (writes.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });

    writer.schedule(101);
    writer.schedule(102);
    writer.reset();
    writer.schedule(201);
    releaseFirst?.();
    await writer.whenIdle();

    expect(writes).toEqual([101, 201]);
  });

  it('refreshes the validated runtime context after editing the current event', () => {
    const current = event(101, 'registration_open');
    expect(
      mergeEventContextOption(current, {
        id: 101,
        slug: 'renamed-event',
        name: '已更新的大会名称',
        shortName: '更新大会',
        status: 'archived',
        startsAt: '2026-09-01T01:00:00.000Z',
        endsAt: '2026-09-02T10:00:00.000Z',
        city: '上海',
      }),
    ).toMatchObject({
      slug: 'renamed-event',
      name: '已更新的大会名称',
      shortName: '更新大会',
      status: 'archived',
      city: '上海',
      registrationCount: 0,
    });
  });
});
