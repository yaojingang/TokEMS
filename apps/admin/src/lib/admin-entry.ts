import { EventIdSchema, type EventContextOption, type EventId } from '@conference/contracts';

interface EventPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}

export interface EventPreferenceScope {
  organizationId: string;
  publicUserId: number;
}

export type AdminEntryReason =
  | 'safe_redirect'
  | 'local_recent'
  | 'server_recent'
  | 'single_live'
  | 'single_operational'
  | 'single_event'
  | 'choose_event'
  | 'management_only';

export interface AdminEntryNamedRoute {
  name: string;
  params?: { eventId: EventId };
}

export interface AdminEntryResult {
  route: string | AdminEntryNamedRoute;
  reason: AdminEntryReason;
  clearLocalPreference: boolean;
  clearServerPreference: boolean;
  seedLocalEventId?: EventId;
}

export interface AdminEntryInput {
  redirect?: string;
  grants: string[];
  events: EventContextOption[];
  localEventId?: EventId;
  serverEventId?: EventId | null;
}

export function adminEntryPreferenceNotice(result: AdminEntryResult) {
  if (!result.clearLocalPreference && !result.clearServerPreference) return '';
  if (result.reason === 'server_recent') {
    return '当前浏览器记录的大会已不可用，已恢复到账号最近使用的大会。';
  }
  if (result.reason === 'local_recent') {
    return '账号中的最近大会已不可用，已继续使用当前浏览器选择。';
  }
  if (['single_live', 'single_operational', 'single_event'].includes(result.reason)) {
    return '上次访问的大会已不可用，已进入当前可用大会。';
  }
  return '上次访问的大会已归档或不可用，请重新选择。';
}

type MutableEventContext = Pick<
  EventContextOption,
  'id' | 'slug' | 'name' | 'shortName' | 'status' | 'startsAt' | 'endsAt' | 'city'
>;

export function mergeEventContextOption(
  current: EventContextOption,
  updated: MutableEventContext,
): EventContextOption {
  return current.id === updated.id ? { ...current, ...updated } : current;
}

export function recentEventStorageKey(scope: EventPreferenceScope) {
  return `conference.admin.lastEventId.${scope.organizationId}.${scope.publicUserId}`;
}

export function readRecentEventId(
  target: EventPreferenceStorage | undefined,
  scope: EventPreferenceScope,
): EventId | undefined {
  if (!target) return undefined;
  const key = recentEventStorageKey(scope);
  const parsed = EventIdSchema.safeParse(Number(target.getItem(key)));
  if (parsed.success) return parsed.data;
  target.removeItem(key);
  return undefined;
}

export function writeRecentEventId(
  target: EventPreferenceStorage | undefined,
  scope: EventPreferenceScope,
  eventId: EventId | undefined,
) {
  if (!target) return;
  const key = recentEventStorageKey(scope);
  if (eventId) target.setItem(key, String(eventId));
  else target.removeItem(key);
}

export function clearLegacyEventPreference(target: EventPreferenceStorage | undefined) {
  target?.removeItem('conference.admin.eventId');
  target?.removeItem('conference.admin.eventSlug');
}

export function createEventOptionsLoader(fetchOptions: () => Promise<EventContextOption[]>) {
  let cached: EventContextOption[] | undefined;
  let inFlight: Promise<EventContextOption[]> | undefined;
  let generation = 0;

  return {
    load() {
      if (cached) return Promise.resolve(cached);
      if (inFlight) return inFlight;
      const requestGeneration = generation;
      const request = fetchOptions()
        .then((events) => {
          if (requestGeneration === generation) cached = events;
          return events;
        })
        .finally(() => {
          if (inFlight === request) inFlight = undefined;
        });
      inFlight = request;
      return request;
    },
    invalidate() {
      generation += 1;
      cached = undefined;
      inFlight = undefined;
    },
  };
}

export function createLatestPreferenceWriter(
  writePreference: (eventId: EventId | null) => Promise<unknown>,
) {
  let pendingValue: EventId | null = null;
  let hasPendingValue = false;
  let running = false;
  let active = Promise.resolve();
  let generation = 0;

  async function drain(runGeneration: number) {
    while (hasPendingValue && runGeneration === generation) {
      const value = pendingValue;
      hasPendingValue = false;
      try {
        await writePreference(value);
      } catch {
        // Navigation preferences are best-effort and never block the current route.
      }
    }
    if (runGeneration === generation) running = false;
  }

  return {
    schedule(eventId: EventId | null) {
      pendingValue = eventId;
      hasPendingValue = true;
      if (running) return;
      running = true;
      active = drain(generation);
    },
    whenIdle() {
      return active;
    },
    reset() {
      generation += 1;
      hasPendingValue = false;
      running = false;
      active = Promise.resolve();
    },
  };
}

export function safeRedirectPath(
  value: unknown,
  isKnownRoute: (path: string) => boolean,
): string | undefined {
  if (typeof value !== 'string' || !value || value !== value.trim()) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\'))
    return undefined;

  const pathname = decoded.split(/[?#]/u, 1)[0]?.replace(/\/+$/u, '') || '/';
  if (pathname === '/login') return undefined;
  return isKnownRoute(value) ? value : undefined;
}

export function hasGrant(grants: string[], required: string) {
  return grants.some(
    (grant) =>
      grant === '*' ||
      grant === required ||
      (grant.endsWith('.*') && required.startsWith(`${grant.slice(0, -2)}.`)),
  );
}

function hasAnyGrant(grants: string[], required: string[]) {
  return required.some((grant) => hasGrant(grants, grant));
}

export function managementLandingRouteName(grants: string[]) {
  if (hasGrant(grants, 'event.read')) return 'manage-events';
  if (hasGrant(grants, 'customer.read')) return 'manage-users';
  if (hasGrant(grants, 'org.invoice.read')) return 'manage-invoices';
  if (hasGrant(grants, 'org.template.read')) return 'manage-templates';
  if (hasAnyGrant(grants, ['org.settings.read', 'org.member.read'])) return 'manage-settings';
  return 'forbidden';
}

export function eventLandingRouteName(grants: string[]) {
  if (hasGrant(grants, 'event.dashboard.read')) return 'event-overview';
  if (hasGrant(grants, 'event.manage')) return 'event-settings-general';
  if (hasGrant(grants, 'event.site.read')) return 'event-settings-site';
  if (
    hasAnyGrant(grants, [
      'event.registration.manage',
      'event.inventory.read',
      'event.inventory.manage',
    ])
  ) {
    return 'event-settings-registration';
  }
  if (hasGrant(grants, 'event.content.manage')) return 'event-content';
  if (hasGrant(grants, 'event.ai.read')) return 'event-ai';
  if (hasGrant(grants, 'event.registration.read')) return 'event-registrations';
  if (hasGrant(grants, 'event.order.read')) return 'event-orders';
  if (hasGrant(grants, 'event.notification.read')) return 'event-notifications';
  if (hasAnyGrant(grants, ['event.checkin.execute', 'event.checkin.manage'])) {
    return 'event-check-in';
  }
  if (hasGrant(grants, 'event.audit.read')) return 'event-activity';
  return 'forbidden';
}

export function hasEventWorkspaceLanding(grants: string[]) {
  return eventLandingRouteName(grants) !== 'forbidden';
}

function rememberedEvent(events: EventContextOption[], eventId: EventId | null | undefined) {
  if (!eventId) return undefined;
  return events.find((event) => event.id === eventId && event.status !== 'archived');
}

function eventRoute(name: string, eventId: EventId): AdminEntryNamedRoute {
  return { name, params: { eventId } };
}

export function resolveAdminEntry(input: AdminEntryInput): AdminEntryResult {
  if (input.redirect) {
    return {
      route: input.redirect,
      reason: 'safe_redirect',
      clearLocalPreference: false,
      clearServerPreference: false,
    };
  }

  const eventLanding = eventLandingRouteName(input.grants);
  if (eventLanding === 'forbidden' || !hasGrant(input.grants, 'event.read')) {
    return {
      route: { name: managementLandingRouteName(input.grants) },
      reason: 'management_only',
      clearLocalPreference: Boolean(input.localEventId),
      clearServerPreference: Boolean(input.serverEventId),
    };
  }

  const localEvent = rememberedEvent(input.events, input.localEventId);
  const serverEvent = rememberedEvent(input.events, input.serverEventId);
  const clearLocalPreference = Boolean(input.localEventId && !localEvent);
  const clearServerPreference = Boolean(input.serverEventId && !serverEvent);

  if (localEvent) {
    return {
      route: eventRoute(eventLanding, localEvent.id),
      reason: 'local_recent',
      clearLocalPreference,
      clearServerPreference,
    };
  }
  if (serverEvent) {
    return {
      route: eventRoute(eventLanding, serverEvent.id),
      reason: 'server_recent',
      clearLocalPreference,
      clearServerPreference,
      seedLocalEventId: serverEvent.id,
    };
  }

  const available = input.events.filter((event) => event.status !== 'archived');
  const live = available.filter((event) => event.status === 'in_progress');
  if (live.length === 1) {
    return {
      route: eventRoute(eventLanding, live[0]!.id),
      reason: 'single_live',
      clearLocalPreference,
      clearServerPreference,
    };
  }

  const operational = available.filter((event) =>
    ['draft', 'configuring', 'prepublished', 'registration_open'].includes(event.status),
  );
  if (operational.length === 1) {
    return {
      route: eventRoute(eventLanding, operational[0]!.id),
      reason: 'single_operational',
      clearLocalPreference,
      clearServerPreference,
    };
  }

  if (available.length === 1) {
    return {
      route: eventRoute(eventLanding, available[0]!.id),
      reason: 'single_event',
      clearLocalPreference,
      clearServerPreference,
    };
  }

  return {
    route: { name: 'manage-events' },
    reason: 'choose_event',
    clearLocalPreference,
    clearServerPreference,
  };
}
