import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  API_ERROR_CODES,
  DEMO_EVENT,
  DEMO_IDS,
  type AdminDashboard,
  type AdminRegistrationDetail,
  type AdminRegistrationList,
  type AdminRegistrationListQuery,
  type AdminRegistrationRow,
  type CheckInRequest,
  type CreateRegistration,
  type EventId,
  type Order,
  type PublicEvent,
  type Registration,
  type RegistrationField,
  type RegistrationCheckout,
  type ReviewRegistration,
  type Ticket,
  type UpdateEvent,
  type WaitlistEntry,
  type WaitlistJoin,
  resolveBuildInfo,
} from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  auditLogs,
  checkinLists,
  checkinRecords,
  customerProfiles,
  customerUsers,
  eventReleases,
  events,
  idempotencyKeys,
  inventoryReservations,
  invoiceRequests,
  invoiceStateLogs,
  organizations,
  orders,
  orderAccessTokens,
  orderStateLogs,
  outboxEvents,
  payments,
  publicUserIds,
  registrations,
  registrationForms,
  sessions,
  speakers,
  ticketTypes,
  tickets,
  waitlistEntries,
} from '@conference/database';
import { createTicketCode, normalizeMainlandMobile } from '@conference/security';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  max,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DatabaseService } from './database.service.js';
import { createDemoOperationalState } from './demo-state.js';
import { DomainError } from './domain-error.js';
import {
  EventReleaseActivationService,
  type EventReleaseChangeContext,
  type EventReleaseEventField,
} from './event-release-activation.service.js';

export interface AdminOrderRow extends Order {
  attendeeName: string;
  attendeeCompany: string;
  ticketTypeName: string;
}

export interface CheckInResultPayload {
  result: 'accepted' | 'duplicate' | 'invalid' | 'forbidden' | 'manual_review';
  ticket?: Ticket;
  checkedInAt: string;
  message: string;
}

export interface CustomerRegistrationActor {
  customerUserId: string;
  organizationId: string;
  mobile: string;
  profile: {
    nickname: string | null;
    realName: string | null;
    email: string | null;
    company: string | null;
    title: string | null;
    city: string | null;
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ReleaseEventSnapshot {
  name?: string;
  shortName?: string;
  tagline?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  venue?: string;
  city?: string;
  address?: string;
  settings?: {
    stats?: PublicEvent['stats'];
    faqs?: PublicEvent['faqs'];
    registration?: PublicEvent['registration'];
  };
}

interface ReleaseTicketSnapshot {
  id?: string;
  name?: string;
  description?: string;
  price?: number;
  currency?: string;
  capacity?: number;
  sold?: number;
  remaining?: number;
  benefits?: string[];
  recommended?: boolean;
}

interface ReleaseSpeakerSnapshot {
  id?: string;
  name?: string;
  role?: string;
  topic?: string;
  initials?: string;
  accentFrom?: string;
  accentTo?: string;
  tags?: string[];
}

interface ReleaseSessionSnapshot {
  id?: string;
  day?: number;
  startsAt?: string;
  endsAt?: string;
  title?: string;
  summary?: string | null;
  speaker?: string | null;
  kind?: string;
}

interface ReleaseFormSnapshot {
  id?: string;
  eventId?: EventId;
  name?: string;
  version?: number;
  fields?: NonNullable<PublicEvent['registrationForm']>['fields'];
  termsVersion?: string;
  termsContent?: string;
  publishedAt?: string | null;
}

interface EventReleaseSnapshot {
  event?: ReleaseEventSnapshot;
  tickets?: ReleaseTicketSnapshot[];
  speakers?: ReleaseSpeakerSnapshot[];
  sessions?: ReleaseSessionSnapshot[];
  faqs?: PublicEvent['faqs'];
  registrationForm?: ReleaseFormSnapshot;
  experience?: PublicEvent['experience'];
}

export function releaseFaqsFromSnapshot(value: unknown): PublicEvent['faqs'] | undefined {
  const snapshot = value as EventReleaseSnapshot | undefined;
  const experienceFaqs = snapshot?.experience?.faq.items
    .filter((item) => item.enabled)
    .map((item) => ({ question: item.question, answer: item.answer }));
  return experienceFaqs ?? snapshot?.faqs ?? snapshot?.event?.settings?.faqs;
}

export function effectiveReleasedCapacity(
  releasedTicket: Pick<ReleaseTicketSnapshot, 'capacity'> | undefined,
  liveCapacity: number,
) {
  return releasedTicket?.capacity ?? liveCapacity;
}

const DEFAULT_REGISTRATION_SETTINGS: PublicEvent['registration'] = {
  paymentMode: 'ticketed',
  currency: 'CNY',
  registrationOpen: true,
  accountMode: 'mobile_otp_required',
};

interface PaymentConfirmation {
  provider: string;
  externalId: string;
  amount?: number;
  currency?: string;
  occurredAt?: string;
  paymentId?: string;
  outTradeNo?: string;
  payload: Record<string, unknown>;
  reason: string;
}

interface PaymentCompletion {
  order: Order;
  ticket: Ticket;
  invoice?: {
    id: string;
    requestNo: string;
    status: 'awaiting_details';
    accessToken: string;
    expiresAt: string;
  };
}

const EVENT_TRANSITIONS: Record<PublicEvent['status'], PublicEvent['status'][]> = {
  draft: ['configuring', 'archived'],
  configuring: ['draft', 'prepublished', 'archived'],
  prepublished: ['configuring', 'registration_open', 'archived'],
  registration_open: ['configuring', 'prepublished', 'in_progress', 'ended', 'archived'],
  in_progress: ['ended', 'archived'],
  ended: ['archived'],
  archived: [],
};
const PUBLIC_EVENT_STATUSES = new Set<PublicEvent['status']>([
  'prepublished',
  'registration_open',
  'in_progress',
  'ended',
]);

@Injectable()
export class ConferenceRepository {
  private readonly logger = new Logger(ConferenceRepository.name);
  private readonly memory = createDemoOperationalState();
  private readonly memoryOrderTokens = new Map<string, string>();
  private demoEvent = structuredClone(DEMO_EVENT);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(EventReleaseActivationService)
    private readonly releaseActivation?: EventReleaseActivationService,
  ) {}

  private releases() {
    return this.releaseActivation ?? new EventReleaseActivationService(this.database);
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private tokenHash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private registrationSettings(value: unknown): PublicEvent['registration'] {
    if (!value || typeof value !== 'object') return { ...DEFAULT_REGISTRATION_SETTINGS };
    const settings = value as Partial<PublicEvent['registration']>;
    return {
      paymentMode: settings.paymentMode === 'free' ? 'free' : 'ticketed',
      currency: 'CNY',
      registrationOpen: settings.registrationOpen !== false,
      accountMode:
        settings.accountMode === 'guest_allowed' ? 'guest_allowed' : 'mobile_otp_required',
    };
  }

  private assertEventTransition(
    current: PublicEvent['status'],
    next: PublicEvent['status'] | undefined,
  ) {
    if (!next || next === current) return;
    if (!EVENT_TRANSITIONS[current].includes(next)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        `大会状态不能从 ${current} 直接变更为 ${next}`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private ticketFromRow(row: typeof ticketTypes.$inferSelect) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      price: row.price,
      currency: row.currency,
      remaining: Math.max(0, row.capacity - row.sold),
      benefits: row.benefits,
      recommended: row.recommended,
    };
  }

  private orderFromRow(row: typeof orders.$inferSelect): Order {
    return {
      id: row.id,
      orderNo: row.orderNo,
      registrationId: row.registrationId,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      paymentMethod: row.amount === 0 ? 'free' : 'wechat',
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private normalizeRegistrationAnswers(
    fields: RegistrationField[],
    input: CreateRegistration,
  ): Record<string, string> {
    const submitted: Record<string, string> = {
      ...(input.formAnswers ?? {}),
      name: input.attendee.name,
      mobile: input.attendee.mobile,
      email: input.attendee.email,
      company: input.attendee.company,
      title: input.attendee.title,
      city: input.attendee.city,
    };
    const allowed = new Set(fields.map((field) => field.key));
    const unknown = Object.keys(input.formAnswers ?? {}).find((key) => !allowed.has(key));
    if (unknown) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        `表单字段 ${unknown} 不属于当前发布版本`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalized: Record<string, string> = {};
    for (const field of fields) {
      const value = String(submitted[field.key] ?? '').trim();
      if (field.required && !value) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `请填写必填字段：${field.label}`,
          HttpStatus.BAD_REQUEST,
          { field: field.key },
        );
      }
      if (value.length > 2000) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `字段“${field.label}”内容过长`,
          HttpStatus.BAD_REQUEST,
          { field: field.key },
        );
      }
      if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `字段“${field.label}”需要有效邮箱`,
          HttpStatus.BAD_REQUEST,
          { field: field.key },
        );
      }
      if (value && field.type === 'tel' && (value.length < 7 || value.length > 32)) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `字段“${field.label}”需要有效联系电话`,
          HttpStatus.BAD_REQUEST,
          { field: field.key },
        );
      }
      if (value && field.type === 'select' && !field.options?.includes(value)) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `字段“${field.label}”的选项无效`,
          HttpStatus.BAD_REQUEST,
          { field: field.key },
        );
      }
      normalized[field.key] = value;
    }
    return normalized;
  }

  private waitlistFromRow(
    row: typeof waitlistEntries.$inferSelect,
    ticketTypeName: string,
  ): WaitlistEntry {
    return {
      id: row.id,
      eventId: row.eventId,
      ticketTypeId: row.ticketTypeId,
      ticketTypeName,
      name: row.name,
      email: row.email,
      mobile: row.mobileE164,
      status: row.status as WaitlistEntry['status'],
      position: row.position,
      invitedAt: row.invitedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async getPublicEvent(
    slug = DEMO_EVENT.slug,
    organizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'tokems-demo',
    useActiveRelease = true,
  ): Promise<PublicEvent> {
    const db = this.database.db;
    if (!db) {
      if (useActiveRelease && !PUBLIC_EVENT_STATUSES.has(this.demoEvent.status)) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或尚未发布',
          HttpStatus.NOT_FOUND,
        );
      }
      return {
        ...this.demoEvent,
        tickets: this.demoEvent.tickets.map((ticket) => ({
          ...ticket,
          remaining: this.memory.ticketRemaining.get(ticket.id) ?? ticket.remaining,
        })),
      };
    }

    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, organizationSlug))
      .limit(1);
    if (!organization) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '大会组织不存在', HttpStatus.NOT_FOUND);
    }
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.slug, slug), eq(events.organizationId, organization.id)))
      .limit(1);
    if (!event) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或尚未发布',
        HttpStatus.NOT_FOUND,
      );
    }
    if (useActiveRelease && !PUBLIC_EVENT_STATUSES.has(event.status)) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或尚未发布',
        HttpStatus.NOT_FOUND,
      );
    }

    const [ticketRows, speakerRows, sessionRows, formRows] = await Promise.all([
      db
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, event.id))
        .orderBy(asc(ticketTypes.price)),
      db
        .select()
        .from(speakers)
        .where(eq(speakers.eventId, event.id))
        .orderBy(asc(speakers.sortOrder)),
      db
        .select()
        .from(sessions)
        .where(eq(sessions.eventId, event.id))
        .orderBy(asc(sessions.day), asc(sessions.sortOrder)),
      db
        .select()
        .from(registrationForms)
        .where(
          and(eq(registrationForms.eventId, event.id), eq(registrationForms.status, 'published')),
        )
        .orderBy(desc(registrationForms.version))
        .limit(1),
    ]);
    const settings = event.settings as {
      stats?: PublicEvent['stats'];
      faqs?: PublicEvent['faqs'];
      currentReleaseId?: string;
      registration?: PublicEvent['registration'];
    };
    let releaseSnapshot: EventReleaseSnapshot | undefined;
    if (useActiveRelease && !settings.currentReleaseId) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或尚未发布',
        HttpStatus.NOT_FOUND,
      );
    }
    if (useActiveRelease && settings.currentReleaseId) {
      const [release] = await db
        .select({ snapshot: eventReleases.snapshot })
        .from(eventReleases)
        .where(
          and(eq(eventReleases.id, settings.currentReleaseId), eq(eventReleases.eventId, event.id)),
        )
        .limit(1);
      releaseSnapshot = release?.snapshot as EventReleaseSnapshot | undefined;
      if (!releaseSnapshot) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或发布版本已失效',
          HttpStatus.NOT_FOUND,
        );
      }
    }

    const formatTime = (value: Date | string) => {
      if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return value;
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: releaseSnapshot?.event?.timezone ?? event.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
    };
    const asIso = (value: Date | string | undefined, fallback: Date) => {
      const date = value ? new Date(value) : fallback;
      return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
    };
    const snapshotEvent = releaseSnapshot?.event;
    const visibleTicketRows = useActiveRelease
      ? ticketRows
      : ticketRows.filter((row) => row.active);
    const ticketIds = ticketRows.map((row) => row.id);
    const [reservationRows, waitlistHoldRows] = ticketIds.length
      ? await Promise.all([
          db
            .select({
              ticketTypeId: inventoryReservations.ticketTypeId,
              quantity: sum(inventoryReservations.quantity),
            })
            .from(inventoryReservations)
            .where(
              and(
                inArray(inventoryReservations.ticketTypeId, ticketIds),
                isNull(inventoryReservations.convertedAt),
                isNull(inventoryReservations.releasedAt),
                gt(inventoryReservations.expiresAt, new Date()),
              ),
            )
            .groupBy(inventoryReservations.ticketTypeId),
          db
            .select({ ticketTypeId: waitlistEntries.ticketTypeId, quantity: count() })
            .from(waitlistEntries)
            .where(
              and(
                inArray(waitlistEntries.ticketTypeId, ticketIds),
                eq(waitlistEntries.status, 'invited'),
                gt(waitlistEntries.expiresAt, new Date()),
              ),
            )
            .groupBy(waitlistEntries.ticketTypeId),
        ])
      : [[], []];
    const reservationsByTicket = new Map(
      reservationRows.map((row) => [row.ticketTypeId, Number(row.quantity ?? 0)]),
    );
    const waitlistHoldsByTicket = new Map(
      waitlistHoldRows.map((row) => [row.ticketTypeId, Number(row.quantity ?? 0)]),
    );
    const liveTickets = new Map(ticketRows.map((row) => [row.id, row]));
    const publicTickets = releaseSnapshot?.tickets?.length
      ? releaseSnapshot.tickets
          .filter((row): row is ReleaseTicketSnapshot & { id: string } => Boolean(row.id))
          .map((row) => {
            const live = liveTickets.get(row.id);
            const capacity = effectiveReleasedCapacity(row, live?.capacity ?? row.remaining ?? 0);
            const sold = live?.sold ?? row.sold ?? 0;
            return {
              id: row.id,
              name: row.name ?? live?.name ?? '大会门票',
              description: row.description ?? live?.description ?? '',
              price: row.price ?? live?.price ?? 0,
              currency: row.currency ?? live?.currency ?? 'CNY',
              remaining: live
                ? Math.max(
                    0,
                    capacity -
                      sold -
                      (reservationsByTicket.get(row.id) ?? 0) -
                      (waitlistHoldsByTicket.get(row.id) ?? 0),
                  )
                : Math.max(0, row.remaining ?? capacity - sold),
              benefits: row.benefits ?? live?.benefits ?? [],
              recommended: row.recommended ?? live?.recommended ?? false,
            };
          })
      : visibleTicketRows.map((row) => ({
          ...this.ticketFromRow(row),
          remaining: Math.max(
            0,
            row.capacity -
              row.sold -
              (reservationsByTicket.get(row.id) ?? 0) -
              (waitlistHoldsByTicket.get(row.id) ?? 0),
          ),
        }));
    const snapshotSpeakers = releaseSnapshot?.speakers;
    const publicSpeakers = snapshotSpeakers?.length
      ? snapshotSpeakers
          .filter((row): row is ReleaseSpeakerSnapshot & { id: string; name: string } =>
            Boolean(row.id && row.name),
          )
          .map((row) => ({
            id: row.id,
            name: row.name,
            role: row.role ?? '',
            topic: row.topic ?? '',
            initials: row.initials ?? row.name.slice(0, 2),
            accentFrom: row.accentFrom ?? '#2448a8',
            accentTo: row.accentTo ?? '#102759',
            tags: row.tags ?? [],
          }))
      : speakerRows.map((row) => ({
          id: row.id,
          name: row.name,
          role: row.role,
          topic: row.topic,
          initials: row.initials,
          accentFrom: row.accentFrom,
          accentTo: row.accentTo,
          tags: row.tags,
        }));
    const snapshotSessions = releaseSnapshot?.sessions;
    const publicSessions = snapshotSessions?.length
      ? snapshotSessions
          .filter((row): row is ReleaseSessionSnapshot & { id: string; title: string } =>
            Boolean(row.id && row.title),
          )
          .map((row) => ({
            id: row.id,
            day: row.day ?? 1,
            startsAt: formatTime(row.startsAt ?? ''),
            endsAt: formatTime(row.endsAt ?? ''),
            title: row.title,
            ...(row.summary ? { summary: row.summary } : {}),
            ...(row.speaker ? { speaker: row.speaker } : {}),
            kind: ['talk', 'break', 'workshop'].includes(row.kind ?? '')
              ? (row.kind as 'talk' | 'break' | 'workshop')
              : ('talk' as const),
          }))
      : sessionRows.map((row) => ({
          id: row.id,
          day: row.day,
          startsAt: formatTime(row.startsAt),
          endsAt: formatTime(row.endsAt),
          title: row.title,
          ...(row.summary ? { summary: row.summary } : {}),
          ...(row.speaker ? { speaker: row.speaker } : {}),
          kind: row.kind as 'talk' | 'break' | 'workshop',
        }));
    const liveForm = formRows[0];
    const snapshotForm = releaseSnapshot?.registrationForm;
    const [releasedForm] = snapshotForm?.version
      ? await db
          .select()
          .from(registrationForms)
          .where(
            and(
              eq(registrationForms.eventId, event.id),
              eq(registrationForms.version, snapshotForm.version),
            ),
          )
          .limit(1)
      : [undefined];
    const backingForm = releasedForm ?? liveForm;
    const publicForm = snapshotForm?.version
      ? {
          id: snapshotForm.id ?? backingForm?.id ?? `release-form-${event.id}`,
          eventId: snapshotForm.eventId ?? event.id,
          name: snapshotForm.name ?? backingForm?.name ?? '大会报名表',
          version: snapshotForm.version,
          status: 'published' as const,
          fields: snapshotForm.fields ?? backingForm?.fields ?? [],
          termsVersion: snapshotForm.termsVersion ?? backingForm?.termsVersion ?? '',
          termsContent: snapshotForm.termsContent ?? backingForm?.termsContent ?? '',
          publishedAt: snapshotForm.publishedAt ?? backingForm?.publishedAt?.toISOString() ?? null,
        }
      : liveForm
        ? {
            id: liveForm.id,
            eventId: liveForm.eventId,
            name: liveForm.name,
            version: liveForm.version,
            status: 'published' as const,
            fields: liveForm.fields,
            termsVersion: liveForm.termsVersion,
            termsContent: liveForm.termsContent,
            publishedAt: liveForm.publishedAt?.toISOString() ?? null,
          }
        : undefined;
    const snapshotStats = snapshotEvent?.settings?.stats;
    const snapshotFaqs = releaseFaqsFromSnapshot(releaseSnapshot);
    const storedRegistrationSettings = this.registrationSettings(
      snapshotEvent?.settings?.registration ?? settings.registration,
    );
    const registrationSettings = {
      ...storedRegistrationSettings,
      registrationOpen:
        event.status === 'registration_open' && storedRegistrationSettings.registrationOpen,
    };
    const publicExperience = releaseSnapshot?.experience
      ? structuredClone(releaseSnapshot.experience)
      : undefined;
    const shareAssetId = publicExperience?.home?.seo.shareAssetId;
    if (publicExperience?.home && shareAssetId) {
      publicExperience.home.seo.shareAssetUrl = `/assets/templates/${encodeURIComponent(shareAssetId)}`;
    }

    return {
      id: event.id,
      organizationId: event.organizationId,
      slug: event.slug,
      name: snapshotEvent?.name ?? event.name,
      shortName: snapshotEvent?.shortName ?? event.shortName,
      status: event.status,
      tagline: snapshotEvent?.tagline ?? event.tagline,
      description: snapshotEvent?.description ?? event.description,
      startsAt: asIso(snapshotEvent?.startsAt, event.startsAt),
      endsAt: asIso(snapshotEvent?.endsAt, event.endsAt),
      timezone: snapshotEvent?.timezone ?? event.timezone,
      venue: snapshotEvent?.venue ?? event.venue,
      city: snapshotEvent?.city ?? event.city,
      address: snapshotEvent?.address ?? event.address,
      registration: registrationSettings,
      stats: snapshotStats ?? settings.stats ?? DEMO_EVENT.stats,
      tickets: publicTickets,
      speakers: publicSpeakers,
      sessions: publicSessions,
      faqs: snapshotFaqs ?? settings.faqs ?? DEMO_EVENT.faqs,
      ...(publicForm ? { registrationForm: publicForm } : {}),
      ...(publicExperience ? { experience: publicExperience } : {}),
    };
  }

  async getAdminEvent(
    eventId: EventId,
    organizationId: string = DEMO_IDS.organization,
  ): Promise<PublicEvent> {
    const db = this.database.db;
    if (!db) {
      if (eventId !== this.demoEvent.id || organizationId !== this.demoEvent.organizationId) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      return structuredClone(this.demoEvent);
    }
    const [scope] = await db
      .select({ eventSlug: events.slug, organizationSlug: organizations.slug })
      .from(events)
      .innerJoin(organizations, eq(organizations.id, events.organizationId))
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!scope) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.getPublicEvent(scope.eventSlug, scope.organizationSlug, false);
  }

  async joinWaitlist(
    input: WaitlistJoin,
    idempotencyKey: string,
    customer?: CustomerRegistrationActor,
  ): Promise<WaitlistEntry> {
    const db = this.database.db;
    if (!db) {
      if (this.demoEvent.status !== 'registration_open') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前大会未开放候补申请',
          HttpStatus.CONFLICT,
        );
      }
      if (this.demoEvent.registration.accountMode === 'mobile_otp_required' && !customer) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '本场大会需要先登录',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (!this.demoEvent.registration.registrationOpen) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前大会尚未开放报名或报名已经结束',
          HttpStatus.CONFLICT,
        );
      }
      const ticket = this.demoEvent.tickets.find((item) => item.id === input.ticketTypeId);
      if (!ticket) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '所选票种不存在', HttpStatus.NOT_FOUND);
      }
      if (ticket.remaining > 0) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前票种仍有可售名额，可以直接报名',
          HttpStatus.CONFLICT,
        );
      }
      return {
        id: crypto.randomUUID(),
        eventId: input.eventId,
        ticketTypeId: input.ticketTypeId,
        ticketTypeName: ticket.name,
        name: input.name || customer?.profile.realName || customer?.profile.nickname || '参会人',
        email: input.email || customer?.profile.email || '',
        mobile: customer?.mobile ?? input.mobile,
        status: 'waiting',
        position: 1,
        invitedAt: null,
        expiresAt: null,
        createdAt: new Date().toISOString(),
      };
    }

    return db.transaction(async (tx) => {
      const normalizedEmail = (input.email || customer?.profile.email || '').trim().toLowerCase();
      let normalizedMobile = customer?.mobile ?? '';
      if (!normalizedMobile && input.mobile) {
        try {
          normalizedMobile = normalizeMainlandMobile(input.mobile);
        } catch {
          throw new DomainError(
            API_ERROR_CODES.VALIDATION_ERROR,
            '请输入有效的中国大陆手机号',
            HttpStatus.BAD_REQUEST,
          );
        }
      }
      const identities = [
        ...(normalizedEmail ? [`email:${normalizedEmail}`] : []),
        ...(normalizedMobile ? [`mobile:${normalizedMobile}`] : []),
      ].sort();
      for (const identity of identities) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`waitlist:${input.eventId}:${input.ticketTypeId}:${identity}`}, 0))`,
        );
      }
      const [ticket] = await tx
        .select()
        .from(ticketTypes)
        .where(and(eq(ticketTypes.id, input.ticketTypeId), eq(ticketTypes.eventId, input.eventId)))
        .for('update')
        .limit(1);
      if (!ticket) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '所选票种不存在', HttpStatus.NOT_FOUND);
      }
      const [event] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, input.eventId), eq(events.organizationId, ticket.organizationId)))
        .limit(1);
      const eventSettings = event?.settings as
        | {
            currentReleaseId?: string;
            registration?: PublicEvent['registration'];
          }
        | undefined;
      if (!event || event.status !== 'registration_open' || !eventSettings?.currentReleaseId) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前大会未开放候补申请',
          HttpStatus.CONFLICT,
        );
      }
      const [release] = await tx
        .select({ snapshot: eventReleases.snapshot })
        .from(eventReleases)
        .where(
          and(
            eq(eventReleases.id, eventSettings.currentReleaseId),
            eq(eventReleases.eventId, event.id),
          ),
        )
        .limit(1);
      const releaseSnapshot = release?.snapshot as EventReleaseSnapshot | undefined;
      const releasedRegistration = this.registrationSettings(
        releaseSnapshot?.event?.settings?.registration ?? eventSettings?.registration,
      );
      if (!releasedRegistration.registrationOpen) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前大会未开放候补申请',
          HttpStatus.CONFLICT,
        );
      }
      if (releasedRegistration.accountMode === 'mobile_otp_required' && !customer) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '本场大会需要先登录',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (customer && customer.organizationId !== ticket.organizationId) {
        throw new DomainError(
          API_ERROR_CODES.FORBIDDEN,
          '当前登录账号不属于本场大会',
          HttpStatus.FORBIDDEN,
        );
      }
      const releasedTicket = releaseSnapshot?.tickets?.find((item) => item.id === ticket.id);
      if (!releasedTicket) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前发布版本未开放该票种',
          HttpStatus.CONFLICT,
        );
      }
      const waitlistContacts: SQL[] = [];
      if (normalizedEmail) {
        waitlistContacts.push(eq(waitlistEntries.email, normalizedEmail));
      }
      if (normalizedMobile) {
        waitlistContacts.push(eq(waitlistEntries.mobileE164, normalizedMobile));
      }
      const existingRows = await tx
        .select()
        .from(waitlistEntries)
        .where(
          and(
            eq(waitlistEntries.eventId, event.id),
            eq(waitlistEntries.ticketTypeId, ticket.id),
            or(...waitlistContacts),
          ),
        )
        .limit(2);
      if (existingRows.length > 1) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该联系方式已关联其他候补记录，请更换联系方式或联系大会主办方',
          HttpStatus.CONFLICT,
        );
      }
      const [existing] = existingRows;
      const contactConflict =
        existing &&
        ((normalizedEmail && existing.email !== normalizedEmail) ||
          (normalizedMobile && existing.mobileE164 !== normalizedMobile) ||
          (customer &&
            existing.customerUserId &&
            existing.customerUserId !== customer.customerUserId));
      if (contactConflict) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该联系方式已关联其他候补记录，请更换联系方式或联系大会主办方',
          HttpStatus.CONFLICT,
        );
      }
      if (existing && ['waiting', 'invited', 'claimed'].includes(existing.status)) {
        const result = this.waitlistFromRow(existing, releasedTicket.name ?? ticket.name);
        const ownsEntry = Boolean(
          customer &&
          existing.customerUserId &&
          existing.customerUserId === customer.customerUserId,
        );
        return {
          ...result,
          name: ownsEntry ? result.name : input.name || '候补申请人',
          email: ownsEntry ? result.email : normalizedEmail,
          mobile: ownsEntry ? result.mobile : normalizedMobile,
        };
      }

      const [reservationCount] = await tx
        .select({ quantity: sum(inventoryReservations.quantity) })
        .from(inventoryReservations)
        .where(
          and(
            eq(inventoryReservations.ticketTypeId, ticket.id),
            isNull(inventoryReservations.convertedAt),
            isNull(inventoryReservations.releasedAt),
            gt(inventoryReservations.expiresAt, new Date()),
          ),
        );
      const [offerCount] = await tx
        .select({ quantity: count() })
        .from(waitlistEntries)
        .where(
          and(
            eq(waitlistEntries.ticketTypeId, ticket.id),
            eq(waitlistEntries.status, 'invited'),
            gt(waitlistEntries.expiresAt, new Date()),
          ),
        );
      const available =
        effectiveReleasedCapacity(releasedTicket, ticket.capacity) -
        ticket.sold -
        Number(reservationCount?.quantity ?? 0) -
        Number(offerCount?.quantity ?? 0);
      if (available > 0) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前票种仍有可售名额，可以直接报名',
          HttpStatus.CONFLICT,
        );
      }
      const positions = await tx
        .select({ value: max(waitlistEntries.position) })
        .from(waitlistEntries)
        .where(
          and(eq(waitlistEntries.eventId, event.id), eq(waitlistEntries.ticketTypeId, ticket.id)),
        );
      const position = Number(positions[0]?.value ?? 0) + 1;
      const [entry] = existing
        ? await tx
            .update(waitlistEntries)
            .set({
              name:
                input.name || customer?.profile.realName || customer?.profile.nickname || '参会人',
              customerUserId: customer?.customerUserId,
              email: normalizedEmail,
              mobileE164: normalizedMobile,
              notificationChannel: normalizedEmail ? 'email' : 'sms',
              status: 'waiting',
              position,
              offerTokenHash: null,
              offerTokenLast4: null,
              invitedAt: null,
              expiresAt: null,
              claimedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(waitlistEntries.id, existing.id))
            .returning()
        : await tx
            .insert(waitlistEntries)
            .values({
              organizationId: ticket.organizationId,
              eventId: event.id,
              ticketTypeId: ticket.id,
              customerUserId: customer?.customerUserId,
              email: normalizedEmail,
              mobileE164: normalizedMobile,
              name:
                input.name || customer?.profile.realName || customer?.profile.nickname || '参会人',
              notificationChannel: normalizedEmail ? 'email' : 'sms',
              position,
            })
            .returning();
      await tx.insert(outboxEvents).values({
        organizationId: ticket.organizationId,
        eventId: event.id,
        eventType: 'WaitlistJoined',
        correlationId: idempotencyKey,
        payload: { waitlistEntryId: entry!.id, ticketTypeId: ticket.id, position },
      });
      await tx.insert(auditLogs).values({
        organizationId: ticket.organizationId,
        eventId: event.id,
        action: 'waitlist.join',
        actorId: customer?.customerUserId,
        actorType: customer ? 'customer' : 'anonymous',
        resourceType: 'waitlist_entry',
        resourceId: entry!.id,
        after: { ticketTypeId: ticket.id, position, email: normalizedEmail },
        traceId: idempotencyKey,
      });
      return this.waitlistFromRow(entry!, releasedTicket.name ?? ticket.name);
    });
  }

  async listWaitlist(eventId: EventId, organizationId: string): Promise<WaitlistEntry[]> {
    const db = this.database.db;
    if (!db) return [];
    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!event) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    const rows = await db
      .select({ entry: waitlistEntries, ticketTypeName: ticketTypes.name })
      .from(waitlistEntries)
      .innerJoin(ticketTypes, eq(ticketTypes.id, waitlistEntries.ticketTypeId))
      .where(eq(waitlistEntries.eventId, eventId))
      .orderBy(asc(waitlistEntries.position));
    return rows.map(({ entry, ticketTypeName }) => this.waitlistFromRow(entry, ticketTypeName));
  }

  async createCheckout(
    input: CreateRegistration,
    idempotencyKey: string,
    customer?: CustomerRegistrationActor,
  ): Promise<RegistrationCheckout> {
    const requestHash = this.hash({
      input,
      customerUserId: customer?.customerUserId ?? null,
    });
    const cached = this.memory.idempotency.get(`registration:${idempotencyKey}`) as
      { requestHash: string; response: RegistrationCheckout } | undefined;
    if (cached) {
      if (cached.requestHash !== requestHash) {
        throw new DomainError(
          API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '相同幂等键对应了不同的报名内容',
          HttpStatus.CONFLICT,
        );
      }
      return cached.response;
    }
    const db = this.database.db;

    if (!db) {
      if (this.demoEvent.registration.accountMode === 'mobile_otp_required' && !customer) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '本场大会需要先登录',
          HttpStatus.UNAUTHORIZED,
        );
      }
      const ticket = this.demoEvent.tickets.find((item) => item.id === input.ticketTypeId);
      if (!ticket || ticket.remaining < 1) {
        throw new DomainError(
          API_ERROR_CODES.INVENTORY_UNAVAILABLE,
          '所选票种暂时无可用名额',
          HttpStatus.CONFLICT,
        );
      }
      const remaining = this.memory.ticketRemaining.get(ticket.id) ?? ticket.remaining;
      if (remaining < 1) {
        throw new DomainError(
          API_ERROR_CODES.INVENTORY_UNAVAILABLE,
          '所选票种暂时无可用名额',
          HttpStatus.CONFLICT,
        );
      }
      const now = new Date();
      let attendeeMobile: string;
      try {
        attendeeMobile = normalizeMainlandMobile(input.attendee.mobile);
      } catch {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '请输入有效的中国大陆手机号',
          HttpStatus.BAD_REQUEST,
        );
      }
      const attendee = customer
        ? {
            name:
              input.attendee.name ||
              customer.profile.realName ||
              customer.profile.nickname ||
              '参会人',
            mobile: attendeeMobile,
            email: input.attendee.email || customer.profile.email || '',
            company: input.attendee.company || customer.profile.company || '',
            title: input.attendee.title || customer.profile.title || '',
            city: input.attendee.city || customer.profile.city || '',
          }
        : { ...input.attendee, mobile: attendeeMobile };
      const attendeeEmail = attendee.email.trim().toLowerCase();
      const duplicateRegistration = [...this.memory.registrations.values()].some((registration) => {
        if (registration.eventId !== input.eventId || registration.status === 'cancelled') {
          return false;
        }
        let existingMobile = registration.attendee.mobile;
        try {
          existingMobile = normalizeMainlandMobile(existingMobile);
        } catch {
          // Preserve compatibility with legacy in-memory fixtures while still comparing raw values.
        }
        const existingEmail = registration.attendee.email.trim().toLowerCase();
        return (
          existingMobile === attendeeMobile ||
          Boolean(attendeeEmail && existingEmail === attendeeEmail)
        );
      });
      if (duplicateRegistration) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该邮箱或手机号已经提交过本场大会报名',
          HttpStatus.CONFLICT,
        );
      }
      const checkoutInput = { ...input, attendee };
      const formAnswers = this.normalizeRegistrationAnswers(
        this.demoEvent.registrationForm?.fields ?? [],
        checkoutInput,
      );
      this.memory.ticketRemaining.set(ticket.id, remaining - 1);
      const registration: Registration = {
        id: crypto.randomUUID(),
        eventId: input.eventId,
        registrationCode: `TOK-R-${nanoid(8).toUpperCase()}`,
        status: ticket.price === 0 ? 'confirmed' : 'pending_payment',
        attendee,
        ticketType: { ...ticket, remaining: remaining - 1 },
        formAnswers,
        createdAt: now.toISOString(),
      };
      const order: Order = {
        id: crypto.randomUUID(),
        orderNo: `TOK${now.getFullYear()}${nanoid(10).toUpperCase()}`,
        registrationId: registration.id,
        status: ticket.price === 0 ? 'paid' : 'pending_payment',
        amount: ticket.price,
        currency: ticket.currency,
        paymentMethod: ticket.price === 0 ? 'free' : 'wechat',
        ...(ticket.price > 0 ? { paymentUrl: `/order/${registration.id}` } : {}),
        expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
        createdAt: now.toISOString(),
      };
      this.memory.registrations.set(registration.id, registration);
      this.memory.orders.set(order.id, order);
      let issuedTicket: Ticket | undefined;
      if (ticket.price === 0) {
        const code = createTicketCode();
        issuedTicket = {
          id: crypto.randomUUID(),
          code,
          registrationId: registration.id,
          eventName: this.demoEvent.name,
          attendeeName: registration.attendee.name,
          ticketTypeName: registration.ticketType.name,
          qrPayload: `conference:${registration.eventId}:${code}`,
          status: 'valid',
          issuedAt: now.toISOString(),
        };
        this.memory.tickets.set(issuedTicket.code, issuedTicket);
      }
      const orderAccessToken = randomBytes(32).toString('base64url');
      this.memoryOrderTokens.set(order.id, this.tokenHash(orderAccessToken));
      const response: RegistrationCheckout = {
        registration,
        order,
        orderAccessToken,
        ...(issuedTicket ? { ticket: issuedTicket } : {}),
      };
      this.memory.idempotency.set(`registration:${idempotencyKey}`, { requestHash, response });
      return response;
    }

    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`registration:${idempotencyKey}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.scope, 'registration:create'),
            eq(idempotencyKeys.key, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing && existing.expiresAt <= new Date()) {
        await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
      } else if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new DomainError(
            API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            '相同幂等键对应了不同的报名内容',
            HttpStatus.CONFLICT,
          );
        }
        const durableResponse = existing.responseBody as unknown as Omit<
          RegistrationCheckout,
          'orderAccessToken'
        >;
        const replayAccessToken = randomBytes(32).toString('base64url');
        await tx.insert(orderAccessTokens).values({
          orderId: durableResponse.order.id,
          tokenHash: this.tokenHash(replayAccessToken),
          scopes: ['order:read', ...(!customer ? ['registration:claim'] : [])],
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        });
        return { ...durableResponse, orderAccessToken: replayAccessToken };
      }

      const [ticketRow] = await tx
        .select()
        .from(ticketTypes)
        .where(and(eq(ticketTypes.id, input.ticketTypeId), eq(ticketTypes.eventId, input.eventId)))
        .for('update')
        .limit(1);
      if (!ticketRow) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '所选票种不存在', HttpStatus.NOT_FOUND);
      }
      const [eventRow] = await tx
        .select({ name: events.name, status: events.status, settings: events.settings })
        .from(events)
        .where(
          and(eq(events.id, input.eventId), eq(events.organizationId, ticketRow.organizationId)),
        )
        .limit(1);
      if (!eventRow || eventRow.status !== 'registration_open') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前大会尚未开放报名或报名已经结束',
          HttpStatus.CONFLICT,
        );
      }
      const eventSettings = eventRow.settings as {
        currentReleaseId?: string;
        registration?: PublicEvent['registration'];
      };
      if (!eventSettings.currentReleaseId) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前大会尚未生成可报名的发布版本',
          HttpStatus.CONFLICT,
        );
      }
      const [activeRelease] = await tx
        .select({ snapshot: eventReleases.snapshot })
        .from(eventReleases)
        .where(
          and(
            eq(eventReleases.id, eventSettings.currentReleaseId),
            eq(eventReleases.eventId, input.eventId),
          ),
        )
        .limit(1);
      const releaseSnapshot = activeRelease?.snapshot as EventReleaseSnapshot | undefined;
      const manualReview =
        releaseSnapshot?.experience?.registrationFlow.branches.manualReview === true;
      const releasedRegistration = this.registrationSettings(
        releaseSnapshot?.event?.settings?.registration ?? eventSettings.registration,
      );
      if (releasedRegistration.accountMode === 'mobile_otp_required' && !customer) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '本场大会需要先登录',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (customer && customer.organizationId !== ticketRow.organizationId) {
        throw new DomainError(
          API_ERROR_CODES.FORBIDDEN,
          '当前登录账号不属于本场大会',
          HttpStatus.FORBIDDEN,
        );
      }
      let normalizedInputMobile: string;
      try {
        normalizedInputMobile = normalizeMainlandMobile(input.attendee.mobile);
      } catch {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '请输入有效的中国大陆手机号',
          HttpStatus.BAD_REQUEST,
        );
      }
      const checkoutInput: CreateRegistration = {
        ...input,
        attendee: customer
          ? {
              name:
                input.attendee.name ||
                customer.profile.realName ||
                customer.profile.nickname ||
                '参会人',
              mobile: normalizedInputMobile,
              email: input.attendee.email || customer.profile.email || '',
              company: input.attendee.company || customer.profile.company || '',
              title: input.attendee.title || customer.profile.title || '',
              city: input.attendee.city || customer.profile.city || '',
            }
          : { ...input.attendee, mobile: normalizedInputMobile },
      };
      const releasedTicket = releaseSnapshot?.tickets?.find(
        (ticket) => ticket.id === input.ticketTypeId,
      );
      const releasedForm = releaseSnapshot?.registrationForm;
      if (
        !releasedTicket ||
        !releasedForm?.version ||
        !releasedForm.termsVersion ||
        !releasedForm.fields?.length
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前发布版本缺少票种或报名表配置，请重新发布大会',
          HttpStatus.CONFLICT,
        );
      }
      if (!releasedRegistration.registrationOpen) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前发布版本尚未开放报名',
          HttpStatus.CONFLICT,
        );
      }
      if (
        releasedRegistration.paymentMode === 'free' &&
        (releasedTicket.price ?? ticketRow.price) !== 0
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前免费发布版本包含非零票价，请管理员重新发布大会',
          HttpStatus.CONFLICT,
        );
      }
      const attendeeEmail = checkoutInput.attendee.email.trim().toLowerCase();
      const attendeeMobile = normalizeMainlandMobile(checkoutInput.attendee.mobile);
      if (attendeeEmail) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`registration-email:${input.eventId}:${attendeeEmail}`}, 0))`,
        );
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`registration-mobile:${input.eventId}:${attendeeMobile}`}, 0))`,
      );
      const duplicateContacts: SQL[] = [eq(registrations.attendeeMobileE164, attendeeMobile)];
      if (attendeeEmail) {
        duplicateContacts.push(eq(registrations.attendeeEmailNormalized, attendeeEmail));
      }
      const [duplicateRegistration] = await tx
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.eventId, input.eventId),
            sql`${registrations.status} <> 'cancelled'`,
            or(...duplicateContacts),
          ),
        )
        .limit(1);
      if (duplicateRegistration) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该邮箱或手机号已经提交过本场大会报名',
          HttpStatus.CONFLICT,
        );
      }
      let waitlistOffer: typeof waitlistEntries.$inferSelect | undefined;
      if (checkoutInput.waitlistOfferToken) {
        [waitlistOffer] = await tx
          .select()
          .from(waitlistEntries)
          .where(
            and(
              eq(waitlistEntries.offerTokenHash, this.tokenHash(checkoutInput.waitlistOfferToken)),
              eq(waitlistEntries.eventId, input.eventId),
              eq(waitlistEntries.ticketTypeId, input.ticketTypeId),
              or(
                attendeeEmail ? eq(waitlistEntries.email, attendeeEmail) : undefined,
                eq(waitlistEntries.mobileE164, attendeeMobile),
              ),
              eq(waitlistEntries.status, 'invited'),
            ),
          )
          .for('update')
          .limit(1);
        if (!waitlistOffer || !waitlistOffer.expiresAt || waitlistOffer.expiresAt <= new Date()) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '候补购买资格无效或已经过期',
            HttpStatus.CONFLICT,
          );
        }
      }
      const [form] = await tx
        .select()
        .from(registrationForms)
        .where(
          and(
            eq(registrationForms.eventId, input.eventId),
            eq(registrationForms.version, releasedForm.version),
          ),
        )
        .limit(1);
      if (
        checkoutInput.formVersion !== releasedForm.version ||
        checkoutInput.termsVersion !== releasedForm.termsVersion ||
        (!releasedForm.termsContent && !form?.termsContent)
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '报名表或服务条款版本已经更新，请刷新页面后重新确认',
          HttpStatus.CONFLICT,
        );
      }
      const formAnswers = this.normalizeRegistrationAnswers(releasedForm.fields, checkoutInput);

      const [reservationCount] = await tx
        .select({
          quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int`,
        })
        .from(inventoryReservations)
        .where(
          and(
            eq(inventoryReservations.ticketTypeId, ticketRow.id),
            isNull(inventoryReservations.convertedAt),
            isNull(inventoryReservations.releasedAt),
            gt(inventoryReservations.expiresAt, new Date()),
          ),
        );
      const [waitlistHoldCount] = await tx
        .select({ quantity: count() })
        .from(waitlistEntries)
        .where(
          and(
            eq(waitlistEntries.ticketTypeId, ticketRow.id),
            eq(waitlistEntries.status, 'invited'),
            gt(waitlistEntries.expiresAt, new Date()),
          ),
        );
      const available =
        effectiveReleasedCapacity(releasedTicket, ticketRow.capacity) -
        ticketRow.sold -
        (reservationCount?.quantity ?? 0) -
        Number(waitlistHoldCount?.quantity ?? 0) +
        (waitlistOffer ? 1 : 0);
      if (available < 1) {
        throw new DomainError(
          API_ERROR_CODES.INVENTORY_UNAVAILABLE,
          '所选票种暂时无可用名额',
          HttpStatus.CONFLICT,
        );
      }

      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + (manualReview ? 30 * 24 * 60 * 60_000 : 15 * 60_000),
      );
      const orderAmount =
        releasedRegistration.paymentMode === 'free' ? 0 : (releasedTicket.price ?? ticketRow.price);
      const freeCheckout = orderAmount === 0;
      const [registrationRow] = await tx
        .insert(registrations)
        .values({
          organizationId: ticketRow.organizationId,
          eventId: checkoutInput.eventId,
          ticketTypeId: ticketRow.id,
          customerUserId: customer?.customerUserId,
          registrationCode: `TOK-R-${nanoid(8).toUpperCase()}`,
          status: manualReview ? 'pending_review' : freeCheckout ? 'confirmed' : 'pending_payment',
          attendee: checkoutInput.attendee,
          attendeeMobileE164: attendeeMobile,
          attendeeEmailNormalized: attendeeEmail,
          invoiceRequired: freeCheckout ? false : checkoutInput.invoiceRequired,
          marketingConsent: checkoutInput.marketingConsent,
          formVersion: checkoutInput.formVersion,
          termsVersion: checkoutInput.termsVersion,
          formAnswers,
          consentSnapshot: {
            termsAccepted: checkoutInput.termsAccepted,
            marketingConsent: checkoutInput.marketingConsent,
            acceptedAt: now.toISOString(),
            termsContent: releasedForm.termsContent ?? form!.termsContent,
            fieldDefinitions: releasedForm.fields,
          },
        })
        .returning();
      const [orderRow] = await tx
        .insert(orders)
        .values({
          organizationId: ticketRow.organizationId,
          eventId: input.eventId,
          registrationId: registrationRow!.id,
          orderNo: `TOK${now.getFullYear()}${nanoid(10).toUpperCase()}`,
          status: manualReview ? 'pending_review' : freeCheckout ? 'paid' : 'pending_payment',
          amount: orderAmount,
          currency: releasedRegistration.currency,
          pricingSnapshot: {
            ticketTypeId: ticketRow.id,
            name: releasedTicket.name ?? ticketRow.name,
            amount: orderAmount,
            currency: releasedRegistration.currency,
            paymentMode: releasedRegistration.paymentMode,
            releaseId: eventSettings.currentReleaseId,
          },
          expiresAt,
        })
        .returning();
      await tx.insert(inventoryReservations).values({
        eventId: input.eventId,
        ticketTypeId: ticketRow.id,
        orderId: orderRow!.id,
        quantity: 1,
        expiresAt,
        ...(freeCheckout && !manualReview ? { convertedAt: now } : {}),
      });
      let issuedTicketRow: typeof tickets.$inferSelect | undefined;
      if (freeCheckout && !manualReview) {
        await tx
          .update(ticketTypes)
          .set({ sold: sql`${ticketTypes.sold} + 1`, updatedAt: now })
          .where(eq(ticketTypes.id, ticketRow.id));
        await tx.insert(payments).values({
          orderId: orderRow!.id,
          provider: 'free',
          externalId: `free:${orderRow!.id}`,
          status: 'succeeded',
          amount: 0,
          currency: releasedRegistration.currency,
          payload: {
            paymentMode: releasedRegistration.paymentMode,
            releaseId: eventSettings.currentReleaseId,
          },
        });
        [issuedTicketRow] = await tx
          .insert(tickets)
          .values({
            eventId: input.eventId,
            registrationId: registrationRow!.id,
            ticketTypeId: ticketRow.id,
            code: createTicketCode(),
          })
          .returning();
        await tx.insert(orderStateLogs).values({
          orderId: orderRow!.id,
          fromStatus: null,
          toStatus: 'paid',
          reason: '零元订单创建后自动完成',
          metadata: {
            paymentProvider: 'free',
            releaseId: eventSettings.currentReleaseId,
          },
        });
      }
      if (waitlistOffer) {
        await tx
          .update(waitlistEntries)
          .set({ status: 'claimed', claimedAt: now, updatedAt: now })
          .where(eq(waitlistEntries.id, waitlistOffer.id));
        await tx.insert(outboxEvents).values({
          organizationId: ticketRow.organizationId,
          eventId: input.eventId,
          eventType: 'WaitlistOfferClaimed',
          correlationId: `waitlist:claimed:${waitlistOffer.id}`,
          payload: {
            waitlistEntryId: waitlistOffer.id,
            registrationId: registrationRow!.id,
            orderId: orderRow!.id,
          },
        });
      }
      if (customer) {
        await tx
          .update(customerUsers)
          .set({
            lastRegistrationAt: sql`greatest(
              coalesce(${customerUsers.lastRegistrationAt}, '-infinity'::timestamptz),
              ${now}
            )`,
            updatedAt: now,
          })
          .where(
            and(
              eq(customerUsers.id, customer.customerUserId),
              eq(customerUsers.organizationId, ticketRow.organizationId),
            ),
          );
      }

      const ticketType = {
        ...this.ticketFromRow(ticketRow),
        name: releasedTicket.name ?? ticketRow.name,
        description: releasedTicket.description ?? ticketRow.description,
        price: releasedTicket.price ?? ticketRow.price,
        currency: releasedTicket.currency ?? ticketRow.currency,
        benefits: releasedTicket.benefits ?? ticketRow.benefits,
        recommended: releasedTicket.recommended ?? ticketRow.recommended,
        remaining: available - 1,
      };
      const registration: Registration = {
        id: registrationRow!.id,
        eventId: registrationRow!.eventId,
        registrationCode: registrationRow!.registrationCode,
        status: registrationRow!.status,
        attendee: registrationRow!.attendee,
        ticketType,
        formAnswers: registrationRow!.formAnswers,
        createdAt: registrationRow!.createdAt.toISOString(),
      };
      const order: Order = {
        id: orderRow!.id,
        orderNo: orderRow!.orderNo,
        registrationId: registration.id,
        status: orderRow!.status,
        amount: orderRow!.amount,
        currency: orderRow!.currency,
        paymentMethod: orderRow!.amount === 0 ? 'free' : 'wechat',
        ...(!freeCheckout && !manualReview ? { paymentUrl: `/order/${orderRow!.id}` } : {}),
        expiresAt: orderRow!.expiresAt.toISOString(),
        createdAt: orderRow!.createdAt.toISOString(),
      };
      const issuedTicket: Ticket | undefined = issuedTicketRow
        ? {
            id: issuedTicketRow.id,
            code: issuedTicketRow.code,
            registrationId: issuedTicketRow.registrationId,
            eventName: releaseSnapshot?.event?.name ?? eventRow.name,
            attendeeName: registration.attendee.name,
            ticketTypeName: ticketType.name,
            qrPayload: `conference:${issuedTicketRow.eventId}:${issuedTicketRow.code}`,
            status: issuedTicketRow.status,
            issuedAt: issuedTicketRow.issuedAt.toISOString(),
          }
        : undefined;
      const orderAccessToken = randomBytes(32).toString('base64url');
      const orderAccessExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
      await tx.insert(orderAccessTokens).values({
        orderId: order.id,
        tokenHash: this.tokenHash(orderAccessToken),
        scopes: ['order:read', ...(!customer ? ['registration:claim'] : [])],
        expiresAt: orderAccessExpiresAt,
      });
      const response: RegistrationCheckout = {
        registration,
        order,
        orderAccessToken,
        ...(issuedTicket ? { ticket: issuedTicket } : {}),
      };

      await tx.insert(outboxEvents).values([
        {
          organizationId: ticketRow.organizationId,
          eventId: input.eventId,
          eventType: 'RegistrationSubmitted',
          correlationId: idempotencyKey,
          payload: {
            registrationId: registration.id,
            orderId: order.id,
            recipient: registration.attendee.email || registration.attendee.mobile,
            expiresAt: orderAccessExpiresAt.toISOString(),
          },
        },
        ...(manualReview
          ? [
              {
                organizationId: ticketRow.organizationId,
                eventId: input.eventId,
                eventType: 'RegistrationReviewRequested',
                correlationId: `registration:review-requested:${registration.id}`,
                payload: { registrationId: registration.id, orderId: order.id },
              },
            ]
          : []),
        ...(issuedTicket
          ? [
              {
                organizationId: ticketRow.organizationId,
                eventId: input.eventId,
                eventType: 'FreeOrderCompleted',
                correlationId: idempotencyKey,
                payload: { registrationId: registration.id, orderId: order.id },
              },
              {
                organizationId: ticketRow.organizationId,
                eventId: input.eventId,
                eventType: 'TicketIssued',
                correlationId: idempotencyKey,
                payload: {
                  ticketId: issuedTicket.id,
                  registrationId: registration.id,
                },
              },
            ]
          : []),
      ]);
      await tx.insert(auditLogs).values({
        organizationId: ticketRow.organizationId,
        eventId: input.eventId,
        actorId: customer?.customerUserId,
        actorType: customer ? 'customer' : 'anonymous',
        action: 'registration.create',
        resourceType: 'registration',
        resourceId: registration.id,
        after: {
          registrationCode: registration.registrationCode,
          status: registration.status,
          orderId: order.id,
          orderStatus: order.status,
          ticketId: issuedTicket?.id ?? null,
        },
        traceId: idempotencyKey,
      });
      await tx.insert(idempotencyKeys).values({
        scope: 'registration:create',
        key: idempotencyKey,
        requestHash,
        responseCode: 201,
        responseBody: {
          registration: response.registration,
          order: response.order,
          ...(response.ticket ? { ticket: response.ticket } : {}),
        },
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      });
      return response;
    });
  }

  async confirmMockPayment(orderId: string, idempotencyKey: string): Promise<PaymentCompletion> {
    return this.confirmPayment(orderId, idempotencyKey, {
      provider: 'mock-wechat',
      externalId: idempotencyKey,
      payload: { mode: 'development-simulation' },
      reason: '模拟支付回调确认成功',
    });
  }

  async confirmPayment(
    orderId: string,
    idempotencyKey: string,
    confirmation: PaymentConfirmation,
  ): Promise<PaymentCompletion> {
    const requestHash = this.hash({
      orderId,
      provider: confirmation.provider,
      externalId: confirmation.externalId,
      amount: confirmation.amount,
      currency: confirmation.currency,
      occurredAt: confirmation.occurredAt,
    });
    const cached = this.memory.idempotency.get(`payment:${idempotencyKey}`) as
      { requestHash: string; response: PaymentCompletion } | undefined;
    if (cached) {
      if (cached.requestHash !== requestHash) {
        throw new DomainError(
          API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '相同幂等键对应了不同的支付内容',
          HttpStatus.CONFLICT,
        );
      }
      return cached.response;
    }
    const db = this.database.db;

    if (!db) {
      const current = this.memory.orders.get(orderId);
      if (!current) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
      }
      const registration = this.memory.registrations.get(current.registrationId)!;
      if (registration.status === 'pending_review') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '报名仍在审核中，审核通过后才能支付',
          HttpStatus.CONFLICT,
        );
      }
      const existingTicket = [...this.memory.tickets.values()].find(
        (item) => item.registrationId === registration.id,
      );
      if (current.status === 'paid' && existingTicket) {
        const response = { order: current, ticket: existingTicket };
        this.memory.idempotency.set(`payment:${idempotencyKey}`, { requestHash, response });
        return response;
      }
      if (current.status !== 'pending_payment' && current.status !== 'processing') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前订单状态无法完成支付',
          HttpStatus.CONFLICT,
        );
      }
      const occurredAt = confirmation.occurredAt ? new Date(confirmation.occurredAt) : new Date();
      if (
        Number.isNaN(occurredAt.getTime()) ||
        occurredAt < new Date(current.createdAt) ||
        occurredAt > new Date(current.expiresAt)
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '订单支付窗口已经结束，请重新报名下单',
          HttpStatus.CONFLICT,
        );
      }
      const paidOrder: Order = { ...current, status: 'paid' };
      const confirmedRegistration: Registration = { ...registration, status: 'confirmed' };
      const code = createTicketCode();
      const ticket: Ticket = {
        id: crypto.randomUUID(),
        code,
        registrationId: registration.id,
        eventName: this.demoEvent.name,
        attendeeName: registration.attendee.name,
        ticketTypeName: registration.ticketType.name,
        qrPayload: `conference:${registration.eventId}:${code}`,
        status: 'valid',
        issuedAt: new Date().toISOString(),
      };
      this.memory.orders.set(orderId, paidOrder);
      this.memory.registrations.set(registration.id, confirmedRegistration);
      this.memory.tickets.set(ticket.code, ticket);
      const response = { order: paidOrder, ticket };
      this.memory.idempotency.set(`payment:${idempotencyKey}`, { requestHash, response });
      return response;
    }

    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`payment:${idempotencyKey}`}, 0))`,
      );
      const [cachedPayment] = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.scope, 'payment:confirm'),
            eq(idempotencyKeys.key, idempotencyKey),
          ),
        )
        .limit(1);
      if (cachedPayment && cachedPayment.expiresAt <= new Date()) {
        await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, cachedPayment.id));
      } else if (cachedPayment) {
        if (cachedPayment.requestHash !== requestHash) {
          throw new DomainError(
            API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            '相同幂等键对应了不同的支付内容',
            HttpStatus.CONFLICT,
          );
        }
        const durableResponse = cachedPayment.responseBody as unknown as PaymentCompletion;
        if (!durableResponse.invoice) return durableResponse;
        const replayAccessToken = randomBytes(32).toString('base64url');
        const replayExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
        await tx.insert(orderAccessTokens).values({
          orderId: durableResponse.order.id,
          tokenHash: this.tokenHash(replayAccessToken),
          scopes: ['order:read', 'invoice:read', 'invoice:write'],
          expiresAt: replayExpiresAt,
        });
        return {
          ...durableResponse,
          invoice: {
            ...durableResponse.invoice,
            accessToken: replayAccessToken,
            expiresAt: replayExpiresAt.toISOString(),
          },
        };
      }

      const [orderRow] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update')
        .limit(1);
      if (!orderRow) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
      }
      if (
        (confirmation.amount !== undefined && confirmation.amount !== orderRow.amount) ||
        (confirmation.currency !== undefined && confirmation.currency !== orderRow.currency)
      ) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '支付回调的金额或币种与订单不一致',
          HttpStatus.BAD_REQUEST,
        );
      }
      const [externalPayment] = await tx
        .select({ orderId: payments.orderId })
        .from(payments)
        .where(
          and(
            eq(payments.provider, confirmation.provider),
            eq(payments.externalId, confirmation.externalId),
          ),
        )
        .limit(1);
      if (externalPayment && externalPayment.orderId !== orderRow.id) {
        throw new DomainError(
          API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '支付平台事件已经关联到其他订单',
          HttpStatus.CONFLICT,
        );
      }
      const [registrationRow] = await tx
        .select()
        .from(registrations)
        .where(eq(registrations.id, orderRow.registrationId))
        .limit(1);
      if (!registrationRow) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
      }
      if (registrationRow.status === 'pending_review') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '报名仍在审核中，审核通过后才能支付',
          HttpStatus.CONFLICT,
        );
      }
      const [ticketTypeRow] = await tx
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.id, registrationRow.ticketTypeId))
        .limit(1);
      const [eventRow] = await tx
        .select()
        .from(events)
        .where(eq(events.id, orderRow.eventId))
        .limit(1);
      const [issuedTicket] = await tx
        .select()
        .from(tickets)
        .where(eq(tickets.registrationId, orderRow.registrationId))
        .limit(1);

      const mapOrder = (status = orderRow.status): Order => ({
        id: orderRow.id,
        orderNo: orderRow.orderNo,
        registrationId: orderRow.registrationId,
        status,
        amount: orderRow.amount,
        currency: orderRow.currency,
        paymentMethod: orderRow.amount === 0 ? 'free' : 'wechat',
        expiresAt: orderRow.expiresAt.toISOString(),
        createdAt: orderRow.createdAt.toISOString(),
      });
      const mapTicket = (row: typeof tickets.$inferSelect): Ticket => ({
        id: row.id,
        code: row.code,
        registrationId: row.registrationId,
        eventName: eventRow!.name,
        attendeeName: registrationRow!.attendee.name,
        ticketTypeName: ticketTypeRow!.name,
        qrPayload: `conference:${row.eventId}:${row.code}`,
        status: row.status,
        issuedAt: row.issuedAt.toISOString(),
      });

      if (orderRow.status === 'paid' && issuedTicket) {
        const response = { order: mapOrder('paid'), ticket: mapTicket(issuedTicket) };
        await tx.insert(idempotencyKeys).values({
          scope: 'payment:confirm',
          key: idempotencyKey,
          requestHash,
          responseCode: 200,
          responseBody: response as unknown as Record<string, unknown>,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        });
        return response;
      }
      if (orderRow.status !== 'pending_payment' && orderRow.status !== 'processing') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前订单状态无法完成支付',
          HttpStatus.CONFLICT,
        );
      }
      const occurredAt = confirmation.occurredAt ? new Date(confirmation.occurredAt) : new Date();
      if (
        Number.isNaN(occurredAt.getTime()) ||
        occurredAt < orderRow.createdAt ||
        occurredAt > orderRow.expiresAt
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '订单支付窗口已经结束，请重新报名下单',
          HttpStatus.CONFLICT,
        );
      }

      const now = new Date();
      await tx
        .update(orders)
        .set({ status: 'paid', updatedAt: now })
        .where(eq(orders.id, orderRow.id));
      await tx
        .update(registrations)
        .set({ status: 'confirmed', updatedAt: now })
        .where(eq(registrations.id, registrationRow!.id));
      await tx
        .update(ticketTypes)
        .set({ sold: sql`${ticketTypes.sold} + 1`, updatedAt: now })
        .where(eq(ticketTypes.id, ticketTypeRow!.id));
      await tx
        .update(inventoryReservations)
        .set({ convertedAt: now, updatedAt: now })
        .where(eq(inventoryReservations.orderId, orderRow.id));
      const paymentId = confirmation.paymentId;
      const outTradeNo =
        confirmation.outTradeNo ??
        (typeof confirmation.payload.outTradeNo === 'string'
          ? confirmation.payload.outTradeNo
          : undefined);
      const [preparedPayment] = paymentId
        ? await tx
            .select({ id: payments.id })
            .from(payments)
            .where(and(eq(payments.id, paymentId), eq(payments.orderId, orderRow.id)))
            .limit(1)
        : outTradeNo
          ? await tx
              .select({ id: payments.id })
              .from(payments)
              .where(and(eq(payments.orderId, orderRow.id), eq(payments.outTradeNo, outTradeNo)))
              .limit(1)
          : await tx
              .select({ id: payments.id })
              .from(payments)
              .where(
                and(
                  eq(payments.orderId, orderRow.id),
                  eq(payments.provider, confirmation.provider),
                  inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
                ),
              )
              .limit(1);
      if (preparedPayment) {
        await tx
          .update(payments)
          .set({
            externalId: confirmation.externalId,
            status: 'succeeded',
            amount: orderRow.amount,
            currency: orderRow.currency,
            wechatTradeState: confirmation.provider === 'wechatpay' ? 'SUCCESS' : null,
            payload: confirmation.payload,
            updatedAt: now,
          })
          .where(eq(payments.id, preparedPayment.id));
      } else {
        await tx.insert(payments).values({
          orderId: orderRow.id,
          provider: confirmation.provider,
          externalId: confirmation.externalId,
          status: 'succeeded',
          amount: orderRow.amount,
          currency: orderRow.currency,
          outTradeNo,
          wechatTradeState: confirmation.provider === 'wechatpay' ? 'SUCCESS' : null,
          payload: confirmation.payload,
        });
      }
      const [ticketRow] = await tx
        .insert(tickets)
        .values({
          eventId: orderRow.eventId,
          registrationId: registrationRow!.id,
          ticketTypeId: ticketTypeRow!.id,
          code: createTicketCode(),
        })
        .returning();
      await tx.insert(outboxEvents).values([
        {
          organizationId: orderRow.organizationId,
          eventId: orderRow.eventId,
          eventType: 'PaymentSucceeded',
          correlationId: idempotencyKey,
          payload: { orderId: orderRow.id, amount: orderRow.amount, currency: orderRow.currency },
        },
        {
          organizationId: orderRow.organizationId,
          eventId: orderRow.eventId,
          eventType: 'TicketIssued',
          correlationId: idempotencyKey,
          payload: { ticketId: ticketRow!.id, registrationId: registrationRow!.id },
        },
      ]);
      await tx.insert(auditLogs).values({
        organizationId: orderRow.organizationId,
        eventId: orderRow.eventId,
        action: 'payment.confirm',
        resourceType: 'order',
        resourceId: orderRow.id,
        before: { status: orderRow.status },
        after: {
          status: 'paid',
          ticketId: ticketRow!.id,
          paymentProvider: confirmation.provider,
        },
        traceId: idempotencyKey,
      });
      await tx.insert(orderStateLogs).values({
        orderId: orderRow.id,
        fromStatus: orderRow.status,
        toStatus: 'paid',
        reason: confirmation.reason,
        metadata: {
          paymentProvider: confirmation.provider,
          externalId: confirmation.externalId,
        },
      });
      let invoiceAccess: PaymentCompletion['invoice'];
      if (registrationRow!.invoiceRequired && orderRow.amount > 0) {
        const [existingInvoice] = await tx
          .select({ id: invoiceRequests.id })
          .from(invoiceRequests)
          .where(eq(invoiceRequests.orderId, orderRow.id))
          .limit(1);
        if (!existingInvoice) {
          const accessToken = randomBytes(32).toString('base64url');
          const tokenHash = this.tokenHash(accessToken);
          const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
          const [invoice] = await tx
            .insert(invoiceRequests)
            .values({
              requestNo: `INV${now.getFullYear()}${nanoid(12).toUpperCase()}`,
              organizationId: orderRow.organizationId,
              eventId: orderRow.eventId,
              orderId: orderRow.id,
              registrationId: registrationRow!.id,
              amount: orderRow.amount,
              currency: 'CNY',
              netPaidAmount: orderRow.amount,
              status: 'awaiting_details',
            })
            .returning();
          await tx.insert(invoiceStateLogs).values({
            invoiceRequestId: invoice!.id,
            fromStatus: null,
            toStatus: 'awaiting_details',
            reason: '支付成功，已根据报名开票意向创建申请',
            metadata: { source: 'payment', orderId: orderRow.id },
          });
          await tx.insert(orderAccessTokens).values({
            orderId: orderRow.id,
            tokenHash,
            scopes: ['order:read', 'invoice:read', 'invoice:write'],
            expiresAt,
          });
          await tx.insert(outboxEvents).values({
            organizationId: orderRow.organizationId,
            eventId: orderRow.eventId,
            eventType: 'InvoiceDetailsRequested',
            correlationId: `invoice:details:${invoice!.id}`,
            payload: {
              invoiceId: invoice!.id,
              orderId: orderRow.id,
              recipient: registrationRow!.attendee.email,
              expiresAt: expiresAt.toISOString(),
            },
          });
          invoiceAccess = {
            id: invoice!.id,
            requestNo: invoice!.requestNo,
            status: 'awaiting_details',
            accessToken,
            expiresAt: expiresAt.toISOString(),
          };
        }
      }
      const response: PaymentCompletion = {
        order: mapOrder('paid'),
        ticket: mapTicket(ticketRow!),
        ...(invoiceAccess ? { invoice: invoiceAccess } : {}),
      };
      await tx.insert(idempotencyKeys).values({
        scope: 'payment:confirm',
        key: idempotencyKey,
        requestHash,
        responseCode: 200,
        responseBody: {
          order: response.order,
          ticket: response.ticket,
          ...(response.invoice
            ? {
                invoice: {
                  id: response.invoice.id,
                  requestNo: response.invoice.requestNo,
                  status: response.invoice.status,
                  expiresAt: response.invoice.expiresAt,
                },
              }
            : {}),
        },
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      });
      return response;
    });
  }

  async getOrder(identifier: string, accessToken: string): Promise<Order> {
    const db = this.database.db;
    if (!db) {
      const order =
        this.memory.orders.get(identifier) ??
        [...this.memory.orders.values()].find((item) => item.orderNo === identifier);
      if (!order)
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
      if (this.memoryOrderTokens.get(order.id) !== this.tokenHash(accessToken)) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '订单访问链接无效或已经过期',
          HttpStatus.UNAUTHORIZED,
        );
      }
      return order;
    }

    const condition = UUID_PATTERN.test(identifier)
      ? or(eq(orders.id, identifier), eq(orders.orderNo, identifier))!
      : eq(orders.orderNo, identifier);
    const [row] = await db.select().from(orders).where(condition).limit(1);
    if (!row) throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
    const [token] = await db
      .select()
      .from(orderAccessTokens)
      .where(
        and(
          eq(orderAccessTokens.orderId, row.id),
          eq(orderAccessTokens.tokenHash, this.tokenHash(accessToken)),
          isNull(orderAccessTokens.revokedAt),
          gt(orderAccessTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!token || !token.scopes.includes('order:read')) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '订单访问链接无效或已经过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await db
      .update(orderAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(orderAccessTokens.id, token.id));
    const paymentRows = await db
      .select({
        payload: payments.payload,
        channel: payments.channel,
        status: payments.status,
      })
      .from(payments)
      .where(and(eq(payments.orderId, row.id), eq(payments.provider, 'wechatpay')))
      .orderBy(desc(payments.updatedAt))
      .limit(5);
    const activeNative = paymentRows.find(
      (item) =>
        item.channel === 'native' &&
        ['preparing', 'pending', 'processing', 'query_pending'].includes(item.status) &&
        typeof item.payload?.codeUrl === 'string',
    );
    const anyCodeUrl = paymentRows.find(
      (item) => typeof item.payload?.codeUrl === 'string' && item.payload.codeUrl,
    );
    const paymentUrl =
      (activeNative?.payload && typeof activeNative.payload.codeUrl === 'string'
        ? activeNative.payload.codeUrl
        : undefined) ??
      (anyCodeUrl?.payload && typeof anyCodeUrl.payload.codeUrl === 'string'
        ? anyCodeUrl.payload.codeUrl
        : undefined);
    return {
      id: row.id,
      orderNo: row.orderNo,
      registrationId: row.registrationId,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      paymentMethod: row.amount === 0 ? 'free' : 'wechat',
      ...(paymentUrl ? { paymentUrl } : {}),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async reviewRegistration(
    eventId: EventId,
    registrationId: string,
    organizationId: string,
    actorId: string,
    input: ReviewRegistration,
    idempotencyKey: string,
  ): Promise<RegistrationCheckout> {
    const requestHash = this.hash({ eventId, registrationId, input });
    const memoryKey = `registration-review:${idempotencyKey}`;
    const cached = this.memory.idempotency.get(memoryKey) as
      { requestHash: string; response: RegistrationCheckout } | undefined;
    if (cached) {
      if (cached.requestHash !== requestHash) {
        throw new DomainError(
          API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '相同幂等键对应了不同的审核内容',
          HttpStatus.CONFLICT,
        );
      }
      return cached.response;
    }

    const db = this.database.db;
    if (!db) {
      const registration = this.memory.registrations.get(registrationId);
      const order = [...this.memory.orders.values()].find(
        (item) => item.registrationId === registrationId,
      );
      if (!registration || registration.eventId !== eventId || !order) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
      }
      if (registration.status !== 'pending_review' || order.status !== 'pending_review') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前报名状态无需审核',
          HttpStatus.CONFLICT,
        );
      }
      const now = new Date();
      let ticket: Ticket | undefined;
      const nextRegistration: Registration = {
        ...registration,
        status:
          input.decision === 'reject'
            ? 'cancelled'
            : order.amount === 0
              ? 'confirmed'
              : 'pending_payment',
      };
      const nextOrder: Order = {
        ...order,
        status:
          input.decision === 'reject' ? 'closed' : order.amount === 0 ? 'paid' : 'pending_payment',
        expiresAt:
          input.decision === 'approve'
            ? new Date(now.getTime() + 15 * 60_000).toISOString()
            : order.expiresAt,
        ...(input.decision === 'approve' && order.amount > 0
          ? { paymentUrl: `/order/${order.id}` }
          : {}),
      };
      if (input.decision === 'approve' && order.amount === 0) {
        const code = createTicketCode();
        ticket = {
          id: crypto.randomUUID(),
          code,
          registrationId,
          eventName: this.demoEvent.name,
          attendeeName: registration.attendee.name,
          ticketTypeName: registration.ticketType.name,
          qrPayload: `conference:${eventId}:${code}`,
          status: 'valid',
          issuedAt: now.toISOString(),
        };
        this.memory.tickets.set(code, ticket);
      }
      this.memory.registrations.set(registrationId, nextRegistration);
      this.memory.orders.set(order.id, nextOrder);
      const response = {
        registration: nextRegistration,
        order: nextOrder,
        ...(ticket ? { ticket } : {}),
      };
      this.memory.idempotency.set(memoryKey, { requestHash, response });
      return response;
    }

    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`registration-review:${registrationId}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.scope, 'registration:review'),
            eq(idempotencyKeys.key, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new DomainError(
            API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            '相同幂等键对应了不同的审核内容',
            HttpStatus.CONFLICT,
          );
        }
        return existing.responseBody as unknown as RegistrationCheckout;
      }

      const [registrationRow] = await tx
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.id, registrationId),
            eq(registrations.eventId, eventId),
            eq(registrations.organizationId, organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!registrationRow) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
      }
      const [orderRow] = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.registrationId, registrationRow.id),
            eq(orders.organizationId, organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (
        !orderRow ||
        registrationRow.status !== 'pending_review' ||
        orderRow.status !== 'pending_review'
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前报名状态无需审核',
          HttpStatus.CONFLICT,
        );
      }
      const [[ticketTypeRow], [eventRow]] = await Promise.all([
        tx
          .select()
          .from(ticketTypes)
          .where(eq(ticketTypes.id, registrationRow.ticketTypeId))
          .limit(1),
        tx.select().from(events).where(eq(events.id, eventId)).limit(1),
      ]);
      if (!ticketTypeRow || !eventRow) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '报名关联的大会或票种已失效',
          HttpStatus.CONFLICT,
        );
      }

      const now = new Date();
      const approved = input.decision === 'approve';
      const freeCheckout = orderRow.amount === 0;
      const nextRegistrationStatus = approved
        ? freeCheckout
          ? ('confirmed' as const)
          : ('pending_payment' as const)
        : ('cancelled' as const);
      const nextOrderStatus = approved
        ? freeCheckout
          ? ('paid' as const)
          : ('pending_payment' as const)
        : ('closed' as const);
      const nextExpiresAt =
        approved && !freeCheckout ? new Date(now.getTime() + 15 * 60_000) : orderRow.expiresAt;

      await tx
        .update(registrations)
        .set({ status: nextRegistrationStatus, updatedAt: now })
        .where(eq(registrations.id, registrationRow.id));
      await tx
        .update(orders)
        .set({ status: nextOrderStatus, expiresAt: nextExpiresAt, updatedAt: now })
        .where(eq(orders.id, orderRow.id));

      if (approved) {
        await tx
          .update(inventoryReservations)
          .set({
            expiresAt: nextExpiresAt,
            ...(freeCheckout ? { convertedAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(inventoryReservations.orderId, orderRow.id));
      } else {
        await tx
          .update(inventoryReservations)
          .set({ releasedAt: now, updatedAt: now })
          .where(
            and(
              eq(inventoryReservations.orderId, orderRow.id),
              isNull(inventoryReservations.convertedAt),
              isNull(inventoryReservations.releasedAt),
            ),
          );
      }

      let issuedTicketRow: typeof tickets.$inferSelect | undefined;
      if (approved && freeCheckout) {
        await tx
          .update(ticketTypes)
          .set({ sold: sql`${ticketTypes.sold} + 1`, updatedAt: now })
          .where(eq(ticketTypes.id, ticketTypeRow.id));
        await tx.insert(payments).values({
          orderId: orderRow.id,
          provider: 'free',
          externalId: `free:${orderRow.id}`,
          status: 'succeeded',
          amount: 0,
          currency: orderRow.currency,
          payload: { source: 'registration-review', actorId },
        });
        [issuedTicketRow] = await tx
          .insert(tickets)
          .values({
            eventId,
            registrationId: registrationRow.id,
            ticketTypeId: ticketTypeRow.id,
            code: createTicketCode(),
          })
          .returning();
      }

      await tx.insert(orderStateLogs).values({
        orderId: orderRow.id,
        fromStatus: orderRow.status,
        toStatus: nextOrderStatus,
        reason:
          input.reason ||
          (approved
            ? freeCheckout
              ? '报名审核通过，零元订单自动完成'
              : '报名审核通过，已开放支付窗口'
            : '报名审核未通过'),
        actorId,
        metadata: { decision: input.decision },
      });

      const ticketType = {
        ...this.ticketFromRow(ticketTypeRow),
        remaining: Math.max(
          0,
          ticketTypeRow.capacity - ticketTypeRow.sold - (approved && freeCheckout ? 1 : 0),
        ),
      };
      const registration: Registration = {
        id: registrationRow.id,
        eventId,
        registrationCode: registrationRow.registrationCode,
        status: nextRegistrationStatus,
        attendee: registrationRow.attendee,
        ticketType,
        formAnswers: registrationRow.formAnswers,
        createdAt: registrationRow.createdAt.toISOString(),
      };
      const order: Order = {
        id: orderRow.id,
        orderNo: orderRow.orderNo,
        registrationId,
        status: nextOrderStatus,
        amount: orderRow.amount,
        currency: orderRow.currency,
        paymentMethod: freeCheckout ? 'free' : 'wechat',
        ...(approved && !freeCheckout ? { paymentUrl: `/order/${orderRow.id}` } : {}),
        expiresAt: nextExpiresAt.toISOString(),
        createdAt: orderRow.createdAt.toISOString(),
      };
      const ticket: Ticket | undefined = issuedTicketRow
        ? {
            id: issuedTicketRow.id,
            code: issuedTicketRow.code,
            registrationId,
            eventName: eventRow.name,
            attendeeName: registrationRow.attendee.name,
            ticketTypeName: ticketTypeRow.name,
            qrPayload: `conference:${eventId}:${issuedTicketRow.code}`,
            status: issuedTicketRow.status,
            issuedAt: issuedTicketRow.issuedAt.toISOString(),
          }
        : undefined;
      const response: RegistrationCheckout = {
        registration,
        order,
        ...(ticket ? { ticket } : {}),
      };

      await tx.insert(outboxEvents).values({
        organizationId,
        eventId,
        eventType: approved ? 'RegistrationReviewApproved' : 'RegistrationReviewRejected',
        correlationId: `registration:review:${registrationId}:${input.decision}`,
        payload: {
          registrationId,
          orderId: orderRow.id,
          attendeeEmail: registrationRow.attendee.email,
          reason: input.reason,
          paymentRequired: approved && !freeCheckout,
          ...(ticket ? { ticketId: ticket.id } : {}),
        },
      });
      if (ticket) {
        await tx.insert(outboxEvents).values([
          {
            organizationId,
            eventId,
            eventType: 'FreeOrderCompleted',
            correlationId: `registration:review-free:${registrationId}`,
            payload: { registrationId, orderId: orderRow.id },
          },
          {
            organizationId,
            eventId,
            eventType: 'TicketIssued',
            correlationId: `registration:review-ticket:${registrationId}`,
            payload: { ticketId: ticket.id, registrationId },
          },
        ]);
      }
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: approved ? 'registration.review.approve' : 'registration.review.reject',
        resourceType: 'registration',
        resourceId: registrationId,
        before: { registrationStatus: registrationRow.status, orderStatus: orderRow.status },
        after: {
          registrationStatus: nextRegistrationStatus,
          orderStatus: nextOrderStatus,
          reason: input.reason,
          ticketId: ticket?.id ?? null,
        },
        traceId: idempotencyKey,
      });
      await tx.insert(idempotencyKeys).values({
        scope: 'registration:review',
        key: idempotencyKey,
        requestHash,
        responseCode: 200,
        responseBody: response as unknown as Record<string, unknown>,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      });
      return response;
    });
  }

  async getTicket(codeOrRegistrationId: string): Promise<Ticket> {
    const db = this.database.db;
    if (!db) {
      const ticket =
        this.memory.tickets.get(codeOrRegistrationId) ??
        [...this.memory.tickets.values()].find(
          (item) => item.registrationId === codeOrRegistrationId,
        );
      if (!ticket)
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '电子票尚未签发', HttpStatus.NOT_FOUND);
      return ticket;
    }

    const ticketCondition = UUID_PATTERN.test(codeOrRegistrationId)
      ? or(eq(tickets.code, codeOrRegistrationId), eq(tickets.registrationId, codeOrRegistrationId))
      : eq(tickets.code, codeOrRegistrationId);
    const [row] = await db.select().from(tickets).where(ticketCondition).limit(1);
    if (!row)
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '电子票尚未签发', HttpStatus.NOT_FOUND);
    const [registrationRow, eventRow, ticketTypeRow] = await Promise.all([
      db.select().from(registrations).where(eq(registrations.id, row.registrationId)).limit(1),
      db.select().from(events).where(eq(events.id, row.eventId)).limit(1),
      db.select().from(ticketTypes).where(eq(ticketTypes.id, row.ticketTypeId)).limit(1),
    ]);
    return {
      id: row.id,
      code: row.code,
      registrationId: row.registrationId,
      eventName: eventRow[0]!.name,
      attendeeName: registrationRow[0]!.attendee.name,
      ticketTypeName: ticketTypeRow[0]!.name,
      qrPayload: `conference:${row.eventId}:${row.code}`,
      status: row.status,
      issuedAt: row.issuedAt.toISOString(),
    };
  }

  async getOrderTicket(identifier: string, accessToken: string): Promise<Ticket> {
    const order = await this.getOrder(identifier, accessToken);
    const db = this.database.db;
    if (!db) {
      const ticket = [...this.memory.tickets.values()].find(
        (item) => item.registrationId === order.registrationId,
      );
      if (!ticket) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '电子票尚未签发', HttpStatus.NOT_FOUND);
      }
      return ticket;
    }
    const [ticket] = await db
      .select({ code: tickets.code })
      .from(tickets)
      .where(eq(tickets.registrationId, order.registrationId))
      .limit(1);
    if (!ticket) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '电子票尚未签发', HttpStatus.NOT_FOUND);
    }
    return this.getTicket(ticket.code);
  }

  async listRegistrations(
    eventId: EventId = DEMO_IDS.event,
    filters: Partial<AdminRegistrationListQuery> = {},
    organizationId: string = DEMO_IDS.organization,
  ): Promise<AdminRegistrationList> {
    const requestedPage = Math.max(1, Math.floor(filters.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 10)));
    const db = this.database.db;
    if (!db) {
      const query = filters.q?.trim().toLowerCase();
      const matching = [...this.memory.registrations.values()]
        .filter((registration) => registration.eventId === eventId)
        .filter((registration) => !filters.status || registration.status === filters.status)
        .filter(
          (registration) =>
            !query ||
            [
              registration.attendee.name,
              registration.attendee.company,
              registration.attendee.mobile,
              registration.attendee.email,
              registration.registrationCode,
            ]
              .join(' ')
              .toLowerCase()
              .includes(query),
        )
        .map((registration) => {
          const order = [...this.memory.orders.values()].find(
            (item) => item.registrationId === registration.id,
          );
          return { ...registration, ...(order ? { order } : {}) };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const total = matching.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const start = (page - 1) * pageSize;
      return {
        items: matching.slice(start, start + pageSize),
        total,
        page,
        pageSize,
      };
    }

    const conditions = [
      eq(registrations.eventId, eventId),
      eq(registrations.organizationId, organizationId),
    ];
    if (filters.status) conditions.push(eq(registrations.status, filters.status));
    if (filters.q) {
      const pattern = `%${filters.q.trim()}%`;
      conditions.push(
        or(
          ilike(registrations.registrationCode, pattern),
          sql`${registrations.attendee}->>'name' ilike ${pattern}`,
          sql`${registrations.attendee}->>'company' ilike ${pattern}`,
          sql`${registrations.attendee}->>'mobile' ilike ${pattern}`,
        )!,
      );
    }
    const [totalRow] = await db
      .select({ value: count() })
      .from(registrations)
      .where(and(...conditions));
    const total = Number(totalRow?.value ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = await db
      .select({
        registration: registrations,
        order: orders,
        ticketType: ticketTypes,
      })
      .from(registrations)
      .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
      .leftJoin(orders, eq(orders.registrationId, registrations.id))
      .where(and(...conditions))
      .orderBy(desc(registrations.createdAt), desc(registrations.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const items: AdminRegistrationRow[] = rows.map(({ registration, order, ticketType }) => ({
      id: registration.id,
      eventId: registration.eventId,
      registrationCode: registration.registrationCode,
      status: registration.status,
      attendee: registration.attendee,
      ticketType: this.ticketFromRow(ticketType),
      formAnswers: registration.formAnswers,
      formVersion: registration.formVersion,
      termsVersion: registration.termsVersion,
      createdAt: registration.createdAt.toISOString(),
      ...(order ? { order: this.orderFromRow(order) } : {}),
    }));
    return { items, total, page, pageSize };
  }

  async getRegistrationDetail(
    eventId: EventId,
    registrationId: string,
    organizationId: string = DEMO_IDS.organization,
    includeCustomer = false,
  ): Promise<AdminRegistrationDetail> {
    const db = this.database.db;
    if (!db) {
      const registration = this.memory.registrations.get(registrationId);
      if (!registration || registration.eventId !== eventId) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
      }
      const order = [...this.memory.orders.values()].find(
        (item) => item.registrationId === registration.id,
      );
      return {
        ...registration,
        ...(order ? { order } : {}),
        formVersion: 1,
        termsVersion: '',
        updatedAt: registration.createdAt,
        invoiceRequired: false,
        marketingConsent: false,
        consentSnapshot: {},
        customerRelation: 'unlinked',
      };
    }

    const [row] = await db
      .select({
        registration: registrations,
        order: orders,
        ticketType: ticketTypes,
        customer: customerUsers,
        customerProfile: customerProfiles,
        customerPublicId: publicUserIds.publicId,
      })
      .from(registrations)
      .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
      .leftJoin(orders, eq(orders.registrationId, registrations.id))
      .leftJoin(customerUsers, eq(registrations.customerUserId, customerUsers.id))
      .leftJoin(customerProfiles, eq(customerUsers.id, customerProfiles.customerUserId))
      .leftJoin(
        publicUserIds,
        and(
          eq(publicUserIds.subjectType, 'customer'),
          eq(publicUserIds.subjectUuid, customerUsers.id),
          isNull(publicUserIds.retiredAt),
        ),
      )
      .where(
        and(
          eq(registrations.id, registrationId),
          eq(registrations.eventId, eventId),
          eq(registrations.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
    }

    const { registration, order, ticketType, customer, customerProfile, customerPublicId } = row;
    const detail = {
      id: registration.id,
      eventId: registration.eventId,
      registrationCode: registration.registrationCode,
      status: registration.status,
      attendee: registration.attendee,
      ticketType: this.ticketFromRow(ticketType),
      formAnswers: registration.formAnswers,
      formVersion: registration.formVersion,
      termsVersion: registration.termsVersion,
      updatedAt: registration.updatedAt.toISOString(),
      invoiceRequired: registration.invoiceRequired,
      marketingConsent: registration.marketingConsent,
      consentSnapshot: registration.consentSnapshot,
      createdAt: registration.createdAt.toISOString(),
      ...(order ? { order: this.orderFromRow(order) } : {}),
    };
    if (!registration.customerUserId) return { ...detail, customerRelation: 'unlinked' };
    if (!includeCustomer) return { ...detail, customerRelation: 'restricted' };
    if (!customer || customerPublicId === null) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '关联用户不存在', HttpStatus.NOT_FOUND);
    }
    return {
      ...detail,
      customerRelation: 'included',
      customer: {
        id: customerPublicId,
        mobile: customer.mobileE164,
        status: customer.status,
        verifiedAt: customer.verifiedAt.toISOString(),
        lastLoginAt: customer.lastLoginAt?.toISOString() ?? null,
        lastRegistrationAt: customer.lastRegistrationAt?.toISOString() ?? null,
        createdAt: customer.createdAt.toISOString(),
        internalNote: customer.internalNote,
        tags: customer.tags,
        profile: {
          nickname: customerProfile?.nickname ?? null,
          realName: customerProfile?.realName ?? null,
          email: customerProfile?.email ?? null,
          company: customerProfile?.company ?? null,
          title: customerProfile?.title ?? null,
          city: customerProfile?.city ?? null,
        },
      },
    };
  }

  async listOrders(
    eventId: EventId = DEMO_IDS.event,
    filters: { q?: string; status?: string } = {},
    organizationId: string = DEMO_IDS.organization,
  ) {
    const db = this.database.db;
    if (!db) {
      const query = filters.q?.trim().toLowerCase();
      return [...this.memory.orders.values()]
        .filter((order) => !filters.status || order.status === filters.status)
        .map((order): AdminOrderRow => {
          const registration = this.memory.registrations.get(order.registrationId)!;
          return {
            ...order,
            attendeeName: registration.attendee.name,
            attendeeCompany: registration.attendee.company,
            ticketTypeName: registration.ticketType.name,
          };
        })
        .filter(
          (order) =>
            !query ||
            [order.orderNo, order.attendeeName, order.attendeeCompany, order.ticketTypeName]
              .join(' ')
              .toLowerCase()
              .includes(query),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    const conditions = [eq(orders.eventId, eventId), eq(orders.organizationId, organizationId)];
    if (filters.status) conditions.push(eq(orders.status, filters.status as any));
    if (filters.q) {
      const pattern = `%${filters.q.trim()}%`;
      conditions.push(
        or(
          ilike(orders.orderNo, pattern),
          sql`${registrations.attendee}->>'name' ilike ${pattern}`,
          sql`${registrations.attendee}->>'company' ilike ${pattern}`,
        )!,
      );
    }
    const rows = await db
      .select({ order: orders, registration: registrations, ticketType: ticketTypes })
      .from(orders)
      .innerJoin(registrations, eq(orders.registrationId, registrations.id))
      .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
      .where(and(...conditions))
      .orderBy(desc(orders.createdAt))
      .limit(200);

    return rows.map(({ order, registration, ticketType }): AdminOrderRow => ({
      id: order.id,
      orderNo: order.orderNo,
      registrationId: order.registrationId,
      status: order.status,
      amount: order.amount,
      currency: order.currency,
      paymentMethod: order.amount === 0 ? 'free' : 'wechat',
      expiresAt: order.expiresAt.toISOString(),
      createdAt: order.createdAt.toISOString(),
      attendeeName: registration.attendee.name,
      attendeeCompany: registration.attendee.company,
      ticketTypeName: ticketType.name,
    }));
  }

  async getDashboard(
    eventId: EventId = DEMO_IDS.event,
    organizationId: string = DEMO_IDS.organization,
  ): Promise<AdminDashboard> {
    const db = this.database.db;
    if (!db) {
      const registrationRows = [...this.memory.registrations.values()].filter(
        (registration) => registration.eventId === eventId,
      );
      const orderRows = [...this.memory.orders.values()].filter((order) =>
        registrationRows.some((registration) => registration.id === order.registrationId),
      );
      const paidOrders = orderRows.filter((order) => order.status === 'paid');
      const newCount = Math.max(0, registrationRows.length - 6);
      return {
        eventId,
        eventName: this.demoEvent.name,
        updatedAt: new Date().toISOString(),
        metrics: {
          registrations: 524 + newCount,
          paidOrders: 472 + paidOrders.length - 4,
          revenue: 26_934_500 + paidOrders.reduce((sum, order) => sum + order.amount, 0),
          checkedIn: this.memory.checkins.size,
          conversionRate: 89.7,
          pendingReview: registrationRows.filter((item) => item.status === 'pending_review').length,
        },
        registrationTrend: [18, 24, 31, 27, 38, 42, 55, 49, 63, 68, 74, 82, 77, 91].map(
          (value, index) => ({
            date: new Date(Date.now() - (13 - index) * 86_400_000).toISOString().slice(5, 10),
            value,
          }),
        ),
        ticketBreakdown: this.demoEvent.tickets.map((ticket, index) => ({
          id: ticket.id,
          name: ticket.name,
          sold: [64, 212, 26][index]! + newCount,
          quota: [200, 536, 84][index]!,
        })),
      };
    }

    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!event) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    const [[registrationMetric], [paidMetric], [revenueMetric], [checkinMetric], ticketRows] =
      await Promise.all([
        db.select({ value: count() }).from(registrations).where(eq(registrations.eventId, eventId)),
        db
          .select({ value: count() })
          .from(orders)
          .where(and(eq(orders.eventId, eventId), eq(orders.status, 'paid'))),
        db
          .select({ value: sql<number>`coalesce(sum(${orders.amount}), 0)::int` })
          .from(orders)
          .where(and(eq(orders.eventId, eventId), eq(orders.status, 'paid'))),
        db
          .select({ value: count() })
          .from(checkinRecords)
          .where(and(eq(checkinRecords.eventId, eventId), eq(checkinRecords.result, 'accepted'))),
        db
          .select()
          .from(ticketTypes)
          .where(eq(ticketTypes.eventId, eventId))
          .orderBy(asc(ticketTypes.price)),
      ]);
    const registrationTotal = Number(registrationMetric?.value ?? 0);
    const paidTotal = Number(paidMetric?.value ?? 0);
    const pendingRows = await db
      .select({ value: count() })
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.status, 'pending_review')));

    return {
      eventId,
      eventName: event.name,
      updatedAt: new Date().toISOString(),
      metrics: {
        registrations: registrationTotal,
        paidOrders: paidTotal,
        revenue: Number(revenueMetric?.value ?? 0),
        checkedIn: Number(checkinMetric?.value ?? 0),
        conversionRate: registrationTotal
          ? Number(((paidTotal / registrationTotal) * 100).toFixed(1))
          : 0,
        pendingReview: Number(pendingRows[0]?.value ?? 0),
      },
      registrationTrend: await this.registrationTrend(eventId),
      ticketBreakdown: ticketRows.map((ticket) => ({
        id: ticket.id,
        name: ticket.name,
        sold: ticket.sold,
        quota: ticket.capacity,
      })),
    };
  }

  private async registrationTrend(eventId: EventId) {
    const db = this.database.db;
    if (!db) return [];
    const rows = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${registrations.createdAt}), 'MM-DD')`,
        value: count(),
      })
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, eventId),
          gt(registrations.createdAt, new Date(Date.now() - 14 * 86_400_000)),
        ),
      )
      .groupBy(sql`date_trunc('day', ${registrations.createdAt})`)
      .orderBy(sql`date_trunc('day', ${registrations.createdAt})`);
    return rows.map((row) => ({ date: row.date, value: Number(row.value) }));
  }

  async checkIn(
    input: CheckInRequest,
    organizationId: string = DEMO_IDS.organization,
  ): Promise<CheckInResultPayload> {
    const ticketCode = input.ticketCode.includes(':')
      ? input.ticketCode.split(':').at(-1)!
      : input.ticketCode;
    const db = this.database.db;
    if (!db) {
      if (organizationId !== this.demoEvent.organizationId || input.eventId !== this.demoEvent.id) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const ticket = this.memory.tickets.get(ticketCode);
      if (!ticket || ticket.status === 'cancelled') {
        return {
          result: 'invalid',
          checkedInAt: new Date().toISOString(),
          message: '未找到有效电子票，请核对二维码或票号',
        };
      }
      const key = `${input.checkInListId}:${ticket.code}`;
      const previous = this.memory.checkins.get(key);
      if (previous) {
        return {
          result: 'duplicate',
          ticket: { ...ticket, status: 'used' },
          checkedInAt: previous.checkedInAt,
          message: '该电子票已经完成核销',
        };
      }
      const checkedInAt = new Date().toISOString();
      this.memory.checkins.set(key, { ticketCode, checkedInAt, deviceId: input.deviceId });
      const usedTicket: Ticket = { ...ticket, status: 'used' };
      this.memory.tickets.set(ticketCode, usedTicket);
      const registration = this.memory.registrations.get(ticket.registrationId);
      if (registration) {
        this.memory.registrations.set(registration.id, { ...registration, status: 'checked_in' });
      }
      return { result: 'accepted', ticket: usedTicket, checkedInAt, message: '核销成功，可以入场' };
    }

    return db.transaction(async (tx) => {
      const [scopedEvent] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, input.eventId), eq(events.organizationId, organizationId)))
        .limit(1);
      if (!scopedEvent) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const [ticketRow] = await tx
        .select()
        .from(tickets)
        .where(and(eq(tickets.eventId, input.eventId), eq(tickets.code, ticketCode)))
        .for('update')
        .limit(1);
      if (!ticketRow || ticketRow.status === 'cancelled') {
        return {
          result: 'invalid' as const,
          checkedInAt: new Date().toISOString(),
          message: '未找到有效电子票，请核对二维码或票号',
        };
      }
      const [list] = await tx
        .select()
        .from(checkinLists)
        .where(
          and(eq(checkinLists.eventId, input.eventId), eq(checkinLists.code, input.checkInListId)),
        )
        .limit(1);
      if (!list) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '签到列表不存在', HttpStatus.NOT_FOUND);
      }
      const [registrationRow] = await tx
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.id, ticketRow.registrationId),
            eq(registrations.organizationId, organizationId),
            eq(registrations.eventId, input.eventId),
          ),
        )
        .limit(1);
      const [ticketTypeRow] = await tx
        .select()
        .from(ticketTypes)
        .where(
          and(
            eq(ticketTypes.id, ticketRow.ticketTypeId),
            eq(ticketTypes.organizationId, organizationId),
            eq(ticketTypes.eventId, input.eventId),
          ),
        )
        .limit(1);
      if (!registrationRow || !ticketTypeRow) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '电子票不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const publicTicket: Ticket = {
        id: ticketRow.id,
        code: ticketRow.code,
        registrationId: ticketRow.registrationId,
        eventName: scopedEvent.name,
        attendeeName: registrationRow.attendee.name,
        ticketTypeName: ticketTypeRow.name,
        qrPayload: `conference:${ticketRow.eventId}:${ticketRow.code}`,
        status: ticketRow.status,
        issuedAt: ticketRow.issuedAt.toISOString(),
      };
      const [existing] = await tx
        .select()
        .from(checkinRecords)
        .where(
          and(eq(checkinRecords.ticketId, ticketRow.id), eq(checkinRecords.checkinListId, list.id)),
        )
        .limit(1);
      if (existing) {
        return {
          result: 'duplicate' as const,
          ticket: { ...publicTicket, status: 'used' as const },
          checkedInAt: existing.checkedInAt.toISOString(),
          message: '该电子票已经完成核销',
        };
      }

      const now = new Date();
      await tx.insert(checkinRecords).values({
        eventId: input.eventId,
        checkinListId: list.id,
        ticketId: ticketRow.id,
        deviceId: input.deviceId,
        result: 'accepted',
        checkedInAt: now,
      });
      await tx
        .update(tickets)
        .set({ status: 'used', updatedAt: now })
        .where(eq(tickets.id, ticketRow.id));
      await tx
        .update(registrations)
        .set({ status: 'checked_in', updatedAt: now })
        .where(eq(registrations.id, ticketRow.registrationId));
      await tx.insert(outboxEvents).values({
        organizationId: registrationRow!.organizationId,
        eventId: input.eventId,
        eventType: 'CheckInRecorded',
        correlationId: `checkin:${ticketRow.id}:${list.id}`,
        payload: { ticketId: ticketRow.id, checkinListId: list.id, deviceId: input.deviceId },
      });

      return {
        result: 'accepted' as const,
        ticket: { ...publicTicket, status: 'used' as const },
        checkedInAt: now.toISOString(),
        message: '核销成功，可以入场',
      };
    });
  }

  async updateEvent(
    eventId: EventId,
    patch: UpdateEvent,
    actorId: string = DEMO_IDS.adminUser,
    organizationId: string = DEMO_IDS.organization,
  ) {
    const db = this.database.db;
    if (!db) {
      if (eventId !== this.demoEvent.id) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '大会不存在', HttpStatus.NOT_FOUND);
      }
      let nextStatus = patch.status ?? this.demoEvent.status;
      let nextRegistration = this.registrationSettings({
        ...this.demoEvent.registration,
        ...Object.fromEntries(
          Object.entries(patch.settings?.registration ?? {}).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      });
      if (patch.status === 'registration_open') {
        nextRegistration = { ...nextRegistration, registrationOpen: true };
      } else if (patch.status === 'prepublished') {
        nextRegistration = { ...nextRegistration, registrationOpen: false };
      } else if (patch.settings?.registration?.registrationOpen === true) {
        if (this.demoEvent.status === 'prepublished') nextStatus = 'registration_open';
      } else if (patch.settings?.registration?.registrationOpen === false) {
        if (this.demoEvent.status === 'registration_open') nextStatus = 'prepublished';
      }
      this.assertEventTransition(this.demoEvent.status, nextStatus);
      const startsAt = patch.startsAt ?? this.demoEvent.startsAt;
      const endsAt = patch.endsAt ?? this.demoEvent.endsAt;
      if (new Date(endsAt) <= new Date(startsAt)) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '大会结束时间必须晚于开始时间',
          HttpStatus.BAD_REQUEST,
        );
      }
      const eventFields = Object.fromEntries(
        Object.entries(patch).filter(([key, value]) => key !== 'settings' && value !== undefined),
      ) as Partial<
        Pick<
          PublicEvent,
          | 'name'
          | 'shortName'
          | 'tagline'
          | 'description'
          | 'startsAt'
          | 'endsAt'
          | 'timezone'
          | 'venue'
          | 'city'
          | 'address'
          | 'status'
        >
      >;
      this.demoEvent = {
        ...this.demoEvent,
        ...eventFields,
        status: nextStatus,
        registration: nextRegistration,
      };
      return structuredClone(this.demoEvent);
    }

    const activationContext: EventReleaseChangeContext = {
      organizationId,
      eventId,
      actorId,
      changeScope: 'event',
      changeSummary: '更新大会基本信息',
    };
    const updated = (
      await this.releases().mutate(activationContext, async (tx, current) => {
        const startsAt = patch.startsAt ? new Date(patch.startsAt) : current.startsAt;
        const endsAt = patch.endsAt ? new Date(patch.endsAt) : current.endsAt;
        if (endsAt <= startsAt) {
          throw new DomainError(
            API_ERROR_CODES.VALIDATION_ERROR,
            '大会结束时间必须晚于开始时间',
            HttpStatus.BAD_REQUEST,
          );
        }
        const currentRegistration = this.registrationSettings(current.settings.registration);
        let nextRegistration = patch.settings?.registration
          ? this.registrationSettings({
              ...currentRegistration,
              ...Object.fromEntries(
                Object.entries(patch.settings.registration).filter(
                  ([, value]) => value !== undefined,
                ),
              ),
            })
          : currentRegistration;
        let nextStatus = patch.status ?? current.status;
        if (patch.status === 'registration_open') {
          nextRegistration = { ...nextRegistration, registrationOpen: true };
        } else if (patch.status === 'prepublished') {
          nextRegistration = { ...nextRegistration, registrationOpen: false };
        } else if (patch.settings?.registration?.registrationOpen === true) {
          if (current.status === 'prepublished') nextStatus = 'registration_open';
        } else if (patch.settings?.registration?.registrationOpen === false) {
          if (current.status === 'registration_open') nextStatus = 'prepublished';
        }
        this.assertEventTransition(current.status, nextStatus);
        const changedEventFields: EventReleaseEventField[] = [];
        const addChangedField = (
          field: EventReleaseEventField,
          next: unknown,
          currentValue: unknown,
        ) => {
          if (next !== undefined && next !== currentValue) changedEventFields.push(field);
        };
        addChangedField('name', patch.name, current.name);
        addChangedField('shortName', patch.shortName, current.shortName);
        addChangedField('tagline', patch.tagline, current.tagline);
        addChangedField('description', patch.description, current.description);
        addChangedField('timezone', patch.timezone, current.timezone);
        addChangedField('venue', patch.venue, current.venue);
        addChangedField('city', patch.city, current.city);
        addChangedField('address', patch.address, current.address);
        addChangedField(
          'startsAt',
          patch.startsAt ? startsAt.getTime() : undefined,
          current.startsAt.getTime(),
        );
        addChangedField(
          'endsAt',
          patch.endsAt ? endsAt.getTime() : undefined,
          current.endsAt.getTime(),
        );
        addChangedField(
          'status',
          patch.status !== undefined || nextStatus !== current.status ? nextStatus : undefined,
          current.status,
        );
        const statusChanged = changedEventFields.includes('status');
        const eventFieldsChanged = changedEventFields.some((field) => field !== 'status');
        const registrationChanged =
          JSON.stringify(nextRegistration) !== JSON.stringify(currentRegistration);
        const registrationRequested = patch.settings?.registration !== undefined;
        activationContext.eventFields = changedEventFields;
        activationContext.registrationChanged = registrationChanged;
        if (statusChanged && !eventFieldsChanged && !registrationRequested) {
          activationContext.changeScope = 'lifecycle';
          activationContext.changeSummary = `更新大会状态为“${nextStatus}”`;
        } else if (registrationChanged && !statusChanged && !eventFieldsChanged) {
          activationContext.changeScope = 'registration';
          activationContext.changeSummary = '更新报名方式';
        } else if (statusChanged || registrationChanged) {
          activationContext.changeScope = 'event';
          activationContext.changeSummary = statusChanged
            ? '更新大会状态与基本信息'
            : '更新大会基本信息与报名方式';
        }
        const nextSettings = registrationChanged
          ? {
              ...current.settings,
              registration: nextRegistration,
            }
          : current.settings;
        const updateFields = Object.fromEntries(
          Object.entries(patch).filter(
            ([key, value]) =>
              key !== 'settings' && key !== 'startsAt' && key !== 'endsAt' && value !== undefined,
          ),
        ) as Partial<typeof events.$inferInsert>;
        if (nextStatus !== current.status) updateFields.status = nextStatus;
        const [row] = await tx
          .update(events)
          .set({
            ...updateFields,
            ...(patch.startsAt ? { startsAt } : {}),
            ...(patch.endsAt ? { endsAt } : {}),
            ...(registrationChanged ? { settings: nextSettings } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
          .returning();
        await tx.insert(auditLogs).values({
          organizationId: current.organizationId,
          eventId,
          actorId,
          action: 'event.update',
          resourceType: 'event',
          resourceId: String(eventId),
          before: current as unknown as Record<string, unknown>,
          after: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        return row!;
      })
    ).value;
    const [organization] = await db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return this.getPublicEvent(
      updated.slug,
      organization?.slug ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'tokems-demo',
      false,
    );
  }

  async health() {
    try {
      return {
        status: 'ok',
        database: await this.database.ping(),
        event: this.demoEvent.slug,
        build: resolveBuildInfo('api', process.env),
        time: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(error);
      return {
        status: 'degraded',
        database: { mode: 'postgresql', ok: false },
        event: this.demoEvent.slug,
        build: resolveBuildInfo('api', process.env),
        time: new Date().toISOString(),
      };
    }
  }
}
