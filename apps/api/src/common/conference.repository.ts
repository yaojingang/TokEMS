import { syncLegacyOrderItemState } from '@conference/database';
import { registrationOrderJoin } from './customer-order-ownership.js';
import { guardRefundWrite } from './refund-write-guard.js';
import { BatchRegistrationService } from './batch-registration.service.js';
import { BatchPaymentService } from './batch-payment.service.js';
import { OrderItemsService } from './order-items.service.js';
import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  API_ERROR_CODES,
  DEMO_EVENT,
  DEMO_IDS,
  DEMO_SPEAKER_PROFILES,
  PUBLIC_EVENT_STATUSES,
  dateInTimeZone,
  encodeSpeakerRouteCode,
  isPublicEventStatus,
  nextFeishuDigestRun,
  SpeakerRouteCodeSchema,
  speakerAvatarText,
  type AdminDashboard,
  type AdminDashboardQuery,
  type AdminOrderList,
  type AdminOrderListQuery,
  type AdminOrderRow,
  type AdminRegistrationDetail,
  type AdminRegistrationList,
  type AdminRegistrationListQuery,
  type AdminRegistrationRow,
  type CheckInRequest,
  type CreateRegistration,
  type CustomerOrderAccess,
  type EventId,
  type Order,
  type PublicEvent,
  type PublicEventMetrics,
  type PublicEventSpeakerDetail,
  type PublicEventViewResult,
  type Registration,
  type RegistrationBusinessStatus,
  type RegistrationField,
  type RegistrationCheckout,
  type ReviewRegistration,
  type SpeakerSocialLink,
  type Ticket,
  type UpdateEvent,
  type WaitlistEntry,
  type WaitlistJoin,
  resolveBuildInfo,
} from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  activeInventoryReservationAt,
  auditLogs,
  checkinLists,
  checkinRecords,
  customerProfiles,
  customerUsers,
  eventFeishuDigestSubscriptions,
  feishuDigestDeliveries,
  eventReleases,
  eventPublicMetricDays,
  eventPublicMetrics,
  eventSlugAliases,
  events,
  idempotencyKeys,
  inventoryReservations,
  invoiceRequests,
  invoiceStateLogs,
  organizations,
  organizationHomepageEvents,
  orders,
  orderAccessTokens,
  orderStateLogs,
  outboxEvents,
  payments,
  publicUserIds,
  refunds,
  registrations,
  registrationForms,
  sessions,
  speakerPublicRoutes,
  speakers,
  ticketTypes,
  tickets,
  waitlistEntries,
} from '@conference/database';
import { createTicketCode, normalizeMainlandMobile, sealSecret } from '@conference/security';
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
  normalizeRegistrationSettings,
  resolvePublishedRegistrationSettings,
} from './purchase-registration-policy.js';
import { withPostgresTransactionRetry } from './transaction-retry.js';
import {
  EventReleaseActivationService,
  type EventReleaseChangeContext,
  type EventReleaseEventField,
} from './event-release-activation.service.js';

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

function singleRegistrationId(order: Pick<Order, 'registrationId'>): string {
  if (!order.registrationId) throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION, '请通过多人订单详情执行此操作', HttpStatus.CONFLICT);
  return order.registrationId;
}

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
  avatarAssetId?: string | null;
  bio?: string | null;
  topicAbstract?: string | null;
  websiteUrl?: string | null;
  socialLinks?: SpeakerSocialLink[];
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

export interface PaymentConfirmation {
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

export interface PaymentCompletion {
  order: Order;
  ticket?: Ticket;
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

export function deriveRegistrationBusinessStatus(input: {
  registrationStatus: Registration['status'];
  orderStatus: Order['status'] | undefined;
  orderAmount: number | undefined;
  latestPaymentStatus: AdminRegistrationRow['latestPaymentStatus'];
  paidAmount?: number;
  refundedAmount?: number;
}): RegistrationBusinessStatus {
  const paidAmount = input.paidAmount ?? 0;
  const refundedAmount = input.refundedAmount ?? 0;
  if (input.orderStatus === 'refunded' || (paidAmount > 0 && refundedAmount >= paidAmount)) {
    return 'refunded';
  }
  if (input.orderStatus === 'partially_refunded' || refundedAmount > 0) {
    return 'partially_refunded';
  }
  if (input.orderStatus === 'paid') {
    return (input.orderAmount ?? 0) === 0 ? 'confirmed' : 'paid';
  }
  if (
    input.latestPaymentStatus &&
    ['pending', 'processing', 'preparing', 'query_pending', 'close_pending', 'unknown'].includes(
      input.latestPaymentStatus,
    )
  ) {
    return 'payment_processing';
  }
  if (input.latestPaymentStatus === 'failed') return 'payment_failed';
  if (input.orderStatus === 'closed') return 'closed';
  if (input.registrationStatus === 'pending_review') return 'pending_review';
  if (input.orderStatus === 'pending_payment') return 'pending_payment';
  if (input.registrationStatus === 'confirmed' || input.registrationStatus === 'checked_in') {
    return 'confirmed';
  }
  return 'closed';
}

export function registrationHasOwnershipConflict(
  existingCustomerUserId: string | null,
  currentCustomerUserId: string,
) {
  return Boolean(existingCustomerUserId && existingCustomerUserId !== currentCustomerUserId);
}
@Injectable()
export class ConferenceRepository {
  private readonly logger = new Logger(ConferenceRepository.name);
  private readonly memory = createDemoOperationalState();
  private readonly memoryOrderTokens = new Map<string, string>();
  private readonly memoryRegistrationCustomers = new Map<string, string>();
  private readonly memoryOrderPurchasers = new Map<
    string,
    {
      customerUserId: string;
      purchaseIntentId: string;
      purchaseRequestHash: string;
      snapshot: CustomerRegistrationActor['profile'] & { customerUserId: string; mobile: string };
    }
  >();
  private readonly memoryPurchaseAttempts: Array<{
    eventId: EventId;
    customerUserId: string;
    purchaseIntentId: string;
    createdAt: Date;
  }> = [];
  private readonly memoryAttendeeClaims = new Map<
    string,
    { tokenHash: string; mobileDigest: string; expiresAt: Date }
  >();
  private readonly memoryOutboxEvents: Array<{
    eventType: string;
    payload: Record<string, unknown>;
  }> = [];
  private readonly memoryPublicMetrics = new Map<
    EventId,
    { pageViews: number; trackingStartedAt: Date; updatedAt: Date }
  >();
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

  private notificationSecret() {
    return (
      process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET ??
      process.env.JWT_SECRET ??
      'conference-notification-payload-development-secret'
    );
  }

  private sealNotificationSecret(value: string) {
    return sealSecret(value, this.notificationSecret());
  }

  private registrationSettings(value: unknown): PublicEvent['registration'] {
    return normalizeRegistrationSettings(value);
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
      modelVersion: row.modelVersion, quantity: row.quantity, version: row.version,
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
    for (const field of fields.filter((field) => field.enabled !== false)) {
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

  private attendeeForRegistrationForm(
    fields: RegistrationField[],
    attendee: CreateRegistration['attendee'],
  ) {
    const visible = new Set(
      fields.filter((field) => field.enabled !== false).map((field) => field.key),
    );
    const result = { ...attendee };
    for (const key of ['name', 'email', 'company', 'title', 'city'] as const) {
      if (!visible.has(key)) result[key] = '';
    }
    return result;
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

  async resolvePublicEventRoute(
    slug: string,
    organizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
  ): Promise<{ eventId: EventId; slug: string; isAlias: boolean }> {
    const db = this.database.db;
    if (!db) {
      if (slug !== this.demoEvent.slug) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或尚未发布',
          HttpStatus.NOT_FOUND,
        );
      }
      return { eventId: this.demoEvent.id, slug: this.demoEvent.slug, isAlias: false };
    }
    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, organizationSlug))
      .limit(1);
    if (!organization) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '大会组织不存在', HttpStatus.NOT_FOUND);
    }
    const [current] = await db
      .select({ eventId: events.id, slug: events.slug })
      .from(events)
      .where(and(eq(events.slug, slug), eq(events.organizationId, organization.id)))
      .limit(1);
    if (current) return { ...current, isAlias: false };
    const [alias] = await db
      .select({ eventId: events.id, slug: events.slug })
      .from(eventSlugAliases)
      .innerJoin(
        events,
        and(
          eq(events.id, eventSlugAliases.eventId),
          eq(events.organizationId, eventSlugAliases.organizationId),
        ),
      )
      .where(
        and(eq(eventSlugAliases.organizationId, organization.id), eq(eventSlugAliases.slug, slug)),
      )
      .limit(1);
    if (!alias) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或尚未发布',
        HttpStatus.NOT_FOUND,
      );
    }
    return { ...alias, isAlias: true };
  }

  async getPublicEvent(
    slug = DEMO_EVENT.slug,
    organizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
    useActiveRelease = true,
  ): Promise<PublicEvent> {
    const db = this.database.db;
    if (!db) {
      if (useActiveRelease && !isPublicEventStatus(this.demoEvent.status)) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或尚未发布',
          HttpStatus.NOT_FOUND,
        );
      }
      return {
        ...this.demoEvent,
        publicMetrics: await this.getPublicMetrics(
          this.demoEvent.id,
          this.demoEvent.organizationId,
        ),
        tickets: this.demoEvent.tickets.map((ticket) => ({
          ...ticket,
          remaining: this.memory.ticketRemaining.get(ticket.id) ?? ticket.remaining,
        })),
        speakers: this.demoEvent.speakers.map((speaker, index) => ({
          ...speaker,
          publicCode: encodeSpeakerRouteCode(index + 1),
        })),
      };
    }

    const route = await this.resolvePublicEventRoute(slug, organizationSlug);
    const [event] = await db.select().from(events).where(eq(events.id, route.eventId)).limit(1);
    if (!event) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或尚未发布',
        HttpStatus.NOT_FOUND,
      );
    }
    if (useActiveRelease && !isPublicEventStatus(event.status)) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或尚未发布',
        HttpStatus.NOT_FOUND,
      );
    }

    const [ticketRows, speakerRows, speakerRouteRows, sessionRows, formRows] = await Promise.all([
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
        .select({
          publicCode: speakerPublicRoutes.publicCode,
          speakerId: speakerPublicRoutes.speakerId,
        })
        .from(speakerPublicRoutes)
        .where(
          and(
            eq(speakerPublicRoutes.organizationId, event.organizationId),
            eq(speakerPublicRoutes.eventId, event.id),
          ),
        ),
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
                activeInventoryReservationAt(new Date()),
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
    const publicCodeBySpeakerId = new Map(
      speakerRouteRows.map((row) => [row.speakerId, row.publicCode]),
    );
    const publicSpeakers = snapshotSpeakers?.length
      ? snapshotSpeakers
          .filter((row): row is ReleaseSpeakerSnapshot & { id: string; name: string } =>
            Boolean(row.id && row.name),
          )
          .map((row) => ({
            id: row.id,
            ...(publicCodeBySpeakerId.get(row.id)
              ? { publicCode: publicCodeBySpeakerId.get(row.id) }
              : {}),
            name: row.name,
            role: row.role ?? '',
            topic: row.topic ?? '',
            initials: speakerAvatarText(row.name, row.initials),
            accentFrom: row.accentFrom ?? '#2448a8',
            accentTo: row.accentTo ?? '#102759',
            tags: row.tags ?? [],
            ...(row.avatarAssetId
              ? { avatarUrl: `/assets/templates/${encodeURIComponent(row.avatarAssetId)}` }
              : {}),
          }))
      : speakerRows.map((row) => ({
          id: row.id,
          ...(publicCodeBySpeakerId.get(row.id)
            ? { publicCode: publicCodeBySpeakerId.get(row.id) }
            : {}),
          name: row.name,
          role: row.role,
          topic: row.topic,
          initials: row.initials,
          accentFrom: row.accentFrom,
          accentTo: row.accentTo,
          tags: row.tags,
          ...(row.avatarAssetId
            ? { avatarUrl: `/assets/templates/${encodeURIComponent(row.avatarAssetId)}` }
            : {}),
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
    const publicMetrics = await this.getPublicMetrics(event.id, event.organizationId);

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
      publicMetrics,
      tickets: publicTickets,
      speakers: publicSpeakers,
      sessions: publicSessions,
      faqs: snapshotFaqs ?? settings.faqs ?? DEMO_EVENT.faqs,
      ...(publicForm ? { registrationForm: publicForm } : {}),
      ...(publicExperience ? { experience: publicExperience } : {}),
    };
  }

  async getPublicMetrics(eventId: EventId, organizationId: string): Promise<PublicEventMetrics> {
    const db = this.database.db;
    if (!db) {
      if (eventId !== this.demoEvent.id || organizationId !== this.demoEvent.organizationId) {
        return {
          pageViews: 0,
          trackingStartedAt: null,
          confirmedAttendees: 0,
          organizationCount: 0,
          cityCount: 0,
        };
      }
      const registrationsForEvent = [...this.memory.registrations.values()].filter(
        (registration) =>
          registration.eventId === eventId &&
          ['confirmed', 'checked_in', 'completed'].includes(registration.status),
      );
      const normalizeDimension = (value: string) =>
        value.trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
      const distinctNonEmpty = (values: string[]) =>
        new Set(values.map(normalizeDimension).filter(Boolean)).size;
      const counter = this.memoryPublicMetrics.get(eventId);
      return {
        pageViews: counter?.pageViews ?? 0,
        trackingStartedAt: counter?.trackingStartedAt.toISOString() ?? null,
        confirmedAttendees: registrationsForEvent.length,
        organizationCount: distinctNonEmpty(
          registrationsForEvent.map((registration) => registration.attendee.company),
        ),
        cityCount: distinctNonEmpty(
          registrationsForEvent.map((registration) => registration.attendee.city),
        ),
      };
    }

    const [counterRows, aggregateRows] = await Promise.all([
      db
        .select({
          pageViews: eventPublicMetrics.pageViews,
          trackingStartedAt: eventPublicMetrics.trackingStartedAt,
        })
        .from(eventPublicMetrics)
        .where(
          and(
            eq(eventPublicMetrics.organizationId, organizationId),
            eq(eventPublicMetrics.eventId, eventId),
          ),
        )
        .limit(1),
      db
        .select({
          confirmedAttendees: sql<number>`count(*)::int`,
          organizationCount: sql<number>`count(distinct nullif(lower(regexp_replace(btrim(coalesce(${registrations.attendee}->>'company', '')), '[[:space:]]+', ' ', 'g')), ''))::int`,
          cityCount: sql<number>`count(distinct nullif(lower(regexp_replace(btrim(coalesce(${registrations.attendee}->>'city', '')), '[[:space:]]+', ' ', 'g')), ''))::int`,
        })
        .from(registrations)
        .where(
          and(
            eq(registrations.organizationId, organizationId),
            eq(registrations.eventId, eventId),
            inArray(registrations.status, ['confirmed', 'checked_in', 'completed']),
            isNull(registrations.supersededAt),
          ),
        ),
    ]);
    const counter = counterRows[0];
    const aggregates = aggregateRows[0];
    return {
      pageViews: Number(counter?.pageViews ?? 0),
      trackingStartedAt: counter?.trackingStartedAt.toISOString() ?? null,
      confirmedAttendees: Number(aggregates?.confirmedAttendees ?? 0),
      organizationCount: Number(aggregates?.organizationCount ?? 0),
      cityCount: Number(aggregates?.cityCount ?? 0),
    };
  }

  async recordPublicEventView(
    eventId: EventId,
    organizationId: string,
  ): Promise<PublicEventViewResult> {
    const now = new Date();
    const db = this.database.db;
    if (!db) {
      if (eventId !== this.demoEvent.id || organizationId !== this.demoEvent.organizationId) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或尚未发布',
          HttpStatus.NOT_FOUND,
        );
      }
      const previous = this.memoryPublicMetrics.get(eventId);
      const next = {
        pageViews: (previous?.pageViews ?? 0) + 1,
        trackingStartedAt: previous?.trackingStartedAt ?? now,
        updatedAt: now,
      };
      this.memoryPublicMetrics.set(eventId, next);
      return {
        pageViews: next.pageViews,
        trackingStartedAt: next.trackingStartedAt.toISOString(),
        updatedAt: next.updatedAt.toISOString(),
      };
    }

    const [event] = await db
      .select({ status: events.status, timezone: events.timezone })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!event || !isPublicEventStatus(event.status)) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或尚未发布',
        HttpStatus.NOT_FOUND,
      );
    }

    let metricTimeZone = event.timezone;
    let localDate: string;
    try {
      localDate = dateInTimeZone(now, metricTimeZone);
    } catch {
      metricTimeZone = 'UTC';
      localDate = dateInTimeZone(now, metricTimeZone);
    }
    const counter = await db.transaction(async (tx) => {
      const [updatedCounter] = await tx
        .insert(eventPublicMetrics)
        .values({
          organizationId,
          eventId,
          pageViews: 1,
          trackingStartedAt: now,
          dailyTrackingStartedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [eventPublicMetrics.organizationId, eventPublicMetrics.eventId],
          set: {
            pageViews: sql`${eventPublicMetrics.pageViews} + 1`,
            dailyTrackingStartedAt: sql`coalesce(${eventPublicMetrics.dailyTrackingStartedAt}, ${now})`,
            updatedAt: now,
          },
        })
        .returning({
          pageViews: eventPublicMetrics.pageViews,
          trackingStartedAt: eventPublicMetrics.trackingStartedAt,
          updatedAt: eventPublicMetrics.updatedAt,
        });
      await tx
        .insert(eventPublicMetricDays)
        .values({
          organizationId,
          eventId,
          localDate,
          pageViews: 1,
          timezoneSnapshot: metricTimeZone,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            eventPublicMetricDays.organizationId,
            eventPublicMetricDays.eventId,
            eventPublicMetricDays.localDate,
          ],
          set: {
            pageViews: sql`${eventPublicMetricDays.pageViews} + 1`,
            updatedAt: now,
          },
        });
      return updatedCounter;
    });
    if (!counter) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '大会访问量登记失败',
        HttpStatus.CONFLICT,
      );
    }
    return {
      pageViews: Number(counter.pageViews),
      trackingStartedAt: counter.trackingStartedAt.toISOString(),
      updatedAt: counter.updatedAt.toISOString(),
    };
  }

  async getPublicEventViewResult(
    eventId: EventId,
    organizationId: string,
  ): Promise<PublicEventViewResult> {
    const db = this.database.db;
    if (!db) {
      if (eventId !== this.demoEvent.id || organizationId !== this.demoEvent.organizationId) {
        return { pageViews: 0, trackingStartedAt: null, updatedAt: null };
      }
      const counter = this.memoryPublicMetrics.get(eventId);
      return {
        pageViews: counter?.pageViews ?? 0,
        trackingStartedAt: counter?.trackingStartedAt.toISOString() ?? null,
        updatedAt: counter?.updatedAt.toISOString() ?? null,
      };
    }
    const [counter] = await db
      .select({
        pageViews: eventPublicMetrics.pageViews,
        trackingStartedAt: eventPublicMetrics.trackingStartedAt,
        updatedAt: eventPublicMetrics.updatedAt,
      })
      .from(eventPublicMetrics)
      .where(
        and(
          eq(eventPublicMetrics.organizationId, organizationId),
          eq(eventPublicMetrics.eventId, eventId),
        ),
      )
      .limit(1);
    return {
      pageViews: Number(counter?.pageViews ?? 0),
      trackingStartedAt: counter?.trackingStartedAt.toISOString() ?? null,
      updatedAt: counter?.updatedAt.toISOString() ?? null,
    };
  }

  async getPublicSpeaker(
    slug: string,
    organizationSlug: string,
    speakerId: string,
  ): Promise<PublicEventSpeakerDetail> {
    const event = await this.getPublicEvent(slug, organizationSlug);
    const speaker = event.speakers.find((item) => item.id === speakerId);
    if (!speaker?.publicCode) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '嘉宾不存在或已停止公开',
        HttpStatus.NOT_FOUND,
      );
    }

    let profile: ReleaseSpeakerSnapshot | undefined = DEMO_SPEAKER_PROFILES[speakerId];
    let releasedEvent: ReleaseEventSnapshot | undefined;
    const db = this.database.db;
    if (db) {
      const [eventRow] = await db
        .select({ settings: events.settings })
        .from(events)
        .where(eq(events.id, event.id))
        .limit(1);
      const currentReleaseId = (eventRow?.settings as { currentReleaseId?: string } | undefined)
        ?.currentReleaseId;
      if (!currentReleaseId) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或发布版本已失效',
          HttpStatus.NOT_FOUND,
        );
      }
      const [release] = await db
        .select({ snapshot: eventReleases.snapshot })
        .from(eventReleases)
        .where(and(eq(eventReleases.id, currentReleaseId), eq(eventReleases.eventId, event.id)))
        .limit(1);
      const snapshot = release?.snapshot as EventReleaseSnapshot | undefined;
      releasedEvent = snapshot?.event;
      profile = snapshot?.speakers?.find((item) => item.id === speakerId);
      if (!profile) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '嘉宾不存在或已停止公开',
          HttpStatus.NOT_FOUND,
        );
      }
    }

    const releasedSpeaker = profile
      ? {
          ...speaker,
          name: profile.name ?? speaker.name,
          role: profile.role ?? speaker.role,
          topic: profile.topic ?? speaker.topic,
          initials: profile.initials ?? speaker.initials,
          accentFrom: profile.accentFrom ?? speaker.accentFrom,
          accentTo: profile.accentTo ?? speaker.accentTo,
          tags: profile.tags ?? speaker.tags,
          ...(profile.avatarAssetId
            ? { avatarUrl: `/assets/templates/${encodeURIComponent(profile.avatarAssetId)}` }
            : { avatarUrl: undefined }),
        }
      : speaker;
    return {
      ...releasedSpeaker,
      publicCode: speaker.publicCode,
      eventName: releasedEvent?.name ?? event.name,
      eventSlug: event.slug,
      eventStartsAt: releasedEvent?.startsAt ?? event.startsAt,
      eventEndsAt: releasedEvent?.endsAt ?? event.endsAt,
      eventTimezone: releasedEvent?.timezone ?? event.timezone,
      eventCity: releasedEvent?.city ?? event.city,
      ...(profile?.bio ? { bio: profile.bio } : {}),
      ...(profile?.topicAbstract ? { topicAbstract: profile.topicAbstract } : {}),
      ...(profile?.websiteUrl ? { websiteUrl: profile.websiteUrl } : {}),
      socialLinks: profile?.socialLinks ?? [],
    };
  }

  async getPublicSpeakerByCode(
    organizationSlug: string,
    publicCode: string,
  ): Promise<PublicEventSpeakerDetail> {
    const parsedCode = SpeakerRouteCodeSchema.safeParse(publicCode);
    if (!parsedCode.success) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '嘉宾不存在或已停止公开',
        HttpStatus.NOT_FOUND,
      );
    }

    const db = this.database.db;
    if (!db) {
      const speaker = this.demoEvent.speakers.find(
        (_item, index) => encodeSpeakerRouteCode(index + 1) === parsedCode.data,
      );
      if (!speaker) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '嘉宾不存在或已停止公开',
          HttpStatus.NOT_FOUND,
        );
      }
      return this.getPublicSpeaker(this.demoEvent.slug, organizationSlug, speaker.id);
    }

    const [route] = await db
      .select({ speakerId: speakerPublicRoutes.speakerId, eventSlug: events.slug })
      .from(speakerPublicRoutes)
      .innerJoin(
        events,
        and(
          eq(events.id, speakerPublicRoutes.eventId),
          eq(events.organizationId, speakerPublicRoutes.organizationId),
        ),
      )
      .innerJoin(organizations, eq(organizations.id, speakerPublicRoutes.organizationId))
      .where(
        and(
          eq(speakerPublicRoutes.publicCode, parsedCode.data),
          eq(organizations.slug, organizationSlug),
        ),
      )
      .limit(1);
    if (!route) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '嘉宾不存在或已停止公开',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.getPublicSpeaker(route.eventSlug, organizationSlug, route.speakerId);
  }

  async getPublicEventScope(
    slug = DEMO_EVENT.slug,
    organizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
  ): Promise<{ id: EventId; slug: string; name: string }> {
    const db = this.database.db;
    if (!db) {
      if (slug !== this.demoEvent.slug || !isPublicEventStatus(this.demoEvent.status)) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或尚未发布',
          HttpStatus.NOT_FOUND,
        );
      }
      return { id: this.demoEvent.id, slug: this.demoEvent.slug, name: this.demoEvent.name };
    }
    const findCanonical = (canonicalSlug: string) =>
      db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
        })
        .from(events)
        .innerJoin(organizations, eq(organizations.id, events.organizationId))
        .where(
          and(
            eq(events.slug, canonicalSlug),
            eq(organizations.slug, organizationSlug),
            inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
            sql`exists (
            select 1 from ${eventReleases} public_scope_release
            where public_scope_release.id::text = ${events.settings}->>'currentReleaseId'
              and public_scope_release.event_id = ${events.id}
          )`,
          ),
        )
        .limit(1);
    const [current] = await findCanonical(slug);
    if (current) return current;
    const route = await this.resolvePublicEventRoute(slug, organizationSlug);
    const [aliased] = await findCanonical(route.slug);
    if (!aliased) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或尚未发布',
        HttpStatus.NOT_FOUND,
      );
    }
    return aliased;
  }

  async getPublicHomepageEvent(
    organizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
  ): Promise<PublicEvent> {
    if (!this.database.db) return this.getPublicEvent(DEMO_EVENT.slug, organizationSlug);
    const [scope] = await this.database.db
      .select({ slug: events.slug })
      .from(organizationHomepageEvents)
      .innerJoin(events, eq(events.id, organizationHomepageEvents.eventId))
      .innerJoin(organizations, eq(organizations.id, organizationHomepageEvents.organizationId))
      .where(eq(organizations.slug, organizationSlug))
      .limit(1);
    if (!scope) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '组织尚未设置首页默认大会',
        HttpStatus.NOT_FOUND,
        { reason: 'homepage_unconfigured' },
      );
    }
    return this.getPublicEvent(scope.slug, organizationSlug);
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
      const attendee = this.attendeeForRegistrationForm(
        this.demoEvent.registrationForm?.fields ?? [],
        {
          name: input.name,
          email: input.email,
          mobile: customer?.mobile ?? input.mobile,
          company: '',
          title: '',
          city: '',
        },
      );
      return {
        id: crypto.randomUUID(),
        eventId: input.eventId,
        ticketTypeId: input.ticketTypeId,
        ticketTypeName: ticket.name,
        name: attendee.name,
        email: attendee.email,
        mobile: attendee.mobile,
        status: 'waiting',
        position: 1,
        invitedAt: null,
        expiresAt: null,
        createdAt: new Date().toISOString(),
      };
    }

    return db.transaction(async (tx) => {
      let normalizedEmail = input.email.trim().toLowerCase();
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
      const releasedRegistration = resolvePublishedRegistrationSettings(
        eventSettings,
        releaseSnapshot,
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
      const attendee = this.attendeeForRegistrationForm(
        releaseSnapshot?.registrationForm?.fields ?? [],
        {
          name: input.name,
          email: normalizedEmail,
          mobile: normalizedMobile,
          company: '',
          title: '',
          city: '',
        },
      );
      normalizedEmail = attendee.email;
      if (!normalizedEmail && !normalizedMobile) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '候补需要提供有效的手机号',
          HttpStatus.BAD_REQUEST,
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
            activeInventoryReservationAt(new Date()),
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
              name: attendee.name,
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
              name: attendee.name,
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
    if (!customer) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '请先使用手机号验证码登录',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const requestHash = this.hash({
      input,
      customerUserId: customer.customerUserId,
    });
    const db = this.database.db;
    const memoryIdempotencyKey = `registration:${idempotencyKey}`;
    if (!db) {
      const cached = this.memory.idempotency.get(memoryIdempotencyKey) as
        { requestHash: string; response: RegistrationCheckout } | undefined;
      if (cached) {
        if (cached.requestHash !== requestHash) {
          throw new DomainError(
            API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            '相同幂等键对应了不同的报名内容',
            HttpStatus.CONFLICT,
          );
        }
        const currentRegistration = this.memory.registrations.get(cached.response.registration.id);
        const currentOrder = this.memory.orders.get(cached.response.order.id);
        const replayStateIsCurrent =
          currentRegistration &&
          currentOrder &&
          currentRegistration.status === cached.response.registration.status &&
          currentOrder.status === cached.response.order.status &&
          currentOrder.expiresAt === cached.response.order.expiresAt &&
          !(
            currentOrder.status === 'pending_payment' &&
            new Date(currentOrder.expiresAt) <= new Date()
          );
        if (replayStateIsCurrent) {
          const orderAccessToken = randomBytes(32).toString('base64url');
          this.memoryOrderTokens.set(currentOrder.id, this.tokenHash(orderAccessToken));
          const response = { ...cached.response, orderAccessToken };
          this.memory.idempotency.set(memoryIdempotencyKey, {
            requestHash: cached.requestHash,
            response,
          });
          return response;
        }
        this.memory.idempotency.delete(memoryIdempotencyKey);
      }
    }

    if (!db) {
      const ticket = this.demoEvent.tickets.find((item) => item.id === input.ticketTypeId);
      if (!ticket || ticket.remaining < 1) {
        throw new DomainError(
          API_ERROR_CODES.INVENTORY_UNAVAILABLE,
          '所选票种暂时无可用名额',
          HttpStatus.CONFLICT,
        );
      }
      let loginMobile: string;
      let attendeeMobile: string;
      try {
        loginMobile = normalizeMainlandMobile(customer.mobile);
        attendeeMobile =
          input.purchaseFor === 'self'
            ? loginMobile
            : normalizeMainlandMobile(input.attendee.mobile);
      } catch {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          input.purchaseFor === 'self' ? '当前登录手机号无效，请重新登录' : '参会人手机号无效',
          HttpStatus.BAD_REQUEST,
        );
      }
      const attendee = this.attendeeForRegistrationForm(
        this.demoEvent.registrationForm?.fields ?? [],
        { ...input.attendee, mobile: attendeeMobile },
      );
      const purchaseRequestHash = this.hash({ input, customerUserId: customer.customerUserId });
      const intentMatch = [...this.memoryOrderPurchasers.entries()].find(
        ([, purchaser]) =>
          purchaser.customerUserId === customer.customerUserId &&
          purchaser.purchaseIntentId === input.purchaseIntentId,
      );
      if (intentMatch) {
        const [intentOrderId, purchaser] = intentMatch;
        if (purchaser.purchaseRequestHash !== purchaseRequestHash) {
          throw new DomainError(
            API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            '相同购买意图对应了不同的报名内容',
            HttpStatus.CONFLICT,
          );
        }
        const intentOrder = this.memory.orders.get(intentOrderId);
        const intentRegistration = intentOrder
          ? this.memory.registrations.get(singleRegistrationId(intentOrder))
          : undefined;
        const intentOrderNeedsResume =
          intentOrder &&
          (intentOrder.status === 'closed' ||
            (intentOrder.status === 'pending_payment' &&
              new Date(intentOrder.expiresAt) <= new Date()));
        if (intentOrder && intentRegistration && !intentOrderNeedsResume) {
          const intentTicket = [...this.memory.tickets.values()].find(
            (item) => item.registrationId === intentRegistration.id,
          );
          const orderAccessToken = randomBytes(32).toString('base64url');
          this.memoryOrderTokens.set(intentOrder.id, this.tokenHash(orderAccessToken));
          const response: RegistrationCheckout = {
            isProxyPurchase: input.purchaseFor === 'other',
            registration: intentRegistration,
            order: intentOrder,
            orderAccessToken,
            ...(input.purchaseFor === 'self' && intentTicket ? { ticket: intentTicket } : {}),
          };
          this.memory.idempotency.set(memoryIdempotencyKey, { requestHash, response });
          return response;
        }
      }
      const attemptCutoff = Date.now() - 10 * 60_000;
      const repeatedFailedIntent = this.memoryPurchaseAttempts.some(
        (attempt) =>
          attempt.eventId === input.eventId &&
          attempt.customerUserId === customer.customerUserId &&
          attempt.purchaseIntentId === input.purchaseIntentId,
      );
      const recentAttempts = this.memoryPurchaseAttempts.filter(
        (attempt) =>
          attempt.eventId === input.eventId &&
          attempt.customerUserId === customer.customerUserId &&
          attempt.createdAt.getTime() > attemptCutoff,
      );
      if (!repeatedFailedIntent && recentAttempts.length >= 10) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '报名尝试过于频繁，请10分钟后再试',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (!repeatedFailedIntent) {
        this.memoryPurchaseAttempts.push({
          eventId: input.eventId,
          customerUserId: customer.customerUserId,
          purchaseIntentId: input.purchaseIntentId,
          createdAt: new Date(),
        });
      }
      const hasExistingTarget = [...this.memory.registrations.values()].some((registration) => {
        if (registration.eventId !== input.eventId) return false;
        try {
          return normalizeMainlandMobile(registration.attendee.mobile) === attendeeMobile;
        } catch {
          return registration.attendee.mobile === attendeeMobile;
        }
      });
      if (
        input.purchaseFor === 'other' &&
        !hasExistingTarget &&
        !this.demoEvent.registration.additionalPurchaseEnabled
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前大会未开放代他人购票',
          HttpStatus.CONFLICT,
        );
      }
      if (input.purchaseFor === 'other' && input.waitlistOfferToken) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '候补购买资格仅限本人使用',
          HttpStatus.CONFLICT,
        );
      }
      const existingRegistrations = [...this.memory.registrations.values()].filter(
        (registration) => {
          if (registration.eventId !== input.eventId) return false;
          let registrationMobile = registration.attendee.mobile;
          try {
            registrationMobile = normalizeMainlandMobile(registrationMobile);
          } catch {
            // Legacy demo fixtures can contain intentionally non-normalized contact values.
          }
          return (
            registrationMobile === attendeeMobile ||
            (input.purchaseFor === 'self' &&
              this.memoryRegistrationCustomers.get(registration.id) === customer.customerUserId)
          );
        },
      );
      if (existingRegistrations.length > 1) {
        throw new DomainError(
          API_ERROR_CODES.REGISTRATION_IDENTITY_CONFLICT,
          '该报名身份存在多条历史记录，请联系大会管理员处理',
          HttpStatus.CONFLICT,
        );
      }
      const existingRegistration = existingRegistrations[0];
      if (existingRegistration) {
        const existingCustomerUserId =
          this.memoryRegistrationCustomers.get(existingRegistration.id) ?? null;
        const existingOrder = [...this.memory.orders.values()].find(
          (order) => order.registrationId === existingRegistration.id,
        );
        const existingPurchaser = existingOrder
          ? this.memoryOrderPurchasers.get(existingOrder.id)?.customerUserId
          : undefined;
        if (
          (input.purchaseFor === 'self' &&
            registrationHasOwnershipConflict(existingCustomerUserId, customer.customerUserId)) ||
          (input.purchaseFor === 'other' && existingPurchaser !== customer.customerUserId)
        ) {
          throw new DomainError(
            API_ERROR_CODES.REGISTRATION_IDENTITY_CONFLICT,
            '该手机号的历史报名归属异常，请联系大会管理员处理',
            HttpStatus.CONFLICT,
          );
        }
        if (!existingOrder) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '报名记录缺少订单，请联系大会管理员处理',
            HttpStatus.CONFLICT,
          );
        }
        const now = new Date();
        const shouldResume =
          existingOrder.status === 'closed' ||
          (existingOrder.status === 'pending_payment' && new Date(existingOrder.expiresAt) <= now);
        if (shouldResume) {
          if (
            input.purchaseFor === 'other' &&
            !this.demoEvent.registration.additionalPurchaseEnabled
          ) {
            throw new DomainError(
              API_ERROR_CODES.INVALID_STATE_TRANSITION,
              '当前大会未开放代他人购票',
              HttpStatus.CONFLICT,
            );
          }
          const otherPurchaserOrders = [...this.memory.orders.values()].filter(
            (order) =>
              order.id !== existingOrder.id &&
              this.memoryOrderPurchasers.get(order.id)?.customerUserId ===
                customer.customerUserId &&
              (order.status !== 'pending_payment' || new Date(order.expiresAt) > now),
          );
          const otherPendingOrder = otherPurchaserOrders.find((order) =>
            ['pending_review', 'pending_payment', 'processing'].includes(order.status),
          );
          if (otherPendingOrder) {
            throw new DomainError(
              API_ERROR_CODES.INVALID_STATE_TRANSITION,
              `您已有待处理订单 ${otherPendingOrder.orderNo}，请先完成或关闭原订单`,
              HttpStatus.CONFLICT,
            );
          }
          const otherActiveSeatCount = otherPurchaserOrders.filter((order) =>
            [
              'pending_review',
              'pending_payment',
              'processing',
              'paid',
              'partially_refunded',
            ].includes(order.status),
          ).length;
          if (otherActiveSeatCount >= this.demoEvent.registration.maxActiveSeatsPerPurchaser) {
            throw new DomainError(
              API_ERROR_CODES.INVALID_STATE_TRANSITION,
              `本场大会每位购票人最多可持有 ${this.demoEvent.registration.maxActiveSeatsPerPurchaser} 个有效名额`,
              HttpStatus.CONFLICT,
            );
          }
          const amount = ticket.price;
          const resumedRegistration: Registration = {
            ...existingRegistration,
            status: amount === 0 ? 'confirmed' : 'pending_payment',
            attendee,
            formAnswers: this.normalizeRegistrationAnswers(
              this.demoEvent.registrationForm?.fields ?? [],
              { ...input, attendee },
            ),
          };
          const resumedOrder: Order = {
            ...existingOrder,
            status: amount === 0 ? 'paid' : 'pending_payment',
            amount,
            currency: ticket.currency,
            paymentMethod: amount === 0 ? 'free' : 'wechat',
            ...(amount > 0 ? { paymentUrl: `/order/${existingOrder.id}` } : {}),
            expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
          };
          this.memory.registrations.set(resumedRegistration.id, resumedRegistration);
          this.memory.orders.set(resumedOrder.id, resumedOrder);
          this.memoryOrderPurchasers.set(resumedOrder.id, {
            customerUserId: customer.customerUserId,
            purchaseIntentId: input.purchaseIntentId,
            purchaseRequestHash,
            snapshot: {
              customerUserId: customer.customerUserId,
              mobile: loginMobile,
              ...customer.profile,
            },
          });
          if (input.purchaseFor === 'other' && existingCustomerUserId === null) {
            const attendeeClaimToken = randomBytes(32).toString('base64url');
            this.memoryAttendeeClaims.set(resumedRegistration.id, {
              tokenHash: this.tokenHash(attendeeClaimToken),
              mobileDigest: this.tokenHash(attendeeMobile),
              expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
            });
            this.memoryOutboxEvents.push({
              eventType: 'AttendeeClaimInvitationRequested',
              payload: {
                registrationId: resumedRegistration.id,
                recipientRole: 'attendee',
                recipient:
                  resumedRegistration.attendee.email || resumedRegistration.attendee.mobile,
                sealedAttendeeClaimToken: this.sealNotificationSecret(attendeeClaimToken),
              },
            });
          }
          const orderAccessToken = randomBytes(32).toString('base64url');
          this.memoryOrderTokens.set(resumedOrder.id, this.tokenHash(orderAccessToken));
          const response: RegistrationCheckout = {
            isProxyPurchase: input.purchaseFor === 'other',
            registration: resumedRegistration,
            order: resumedOrder,
            orderAccessToken,
          };
          this.memory.idempotency.set(memoryIdempotencyKey, { requestHash, response });
          return response;
        }
        const existingTicket = [...this.memory.tickets.values()].find(
          (ticket) => ticket.registrationId === existingRegistration.id,
        );
        const orderAccessToken = randomBytes(32).toString('base64url');
        this.memoryOrderTokens.set(existingOrder.id, this.tokenHash(orderAccessToken));
        const response: RegistrationCheckout = {
          isProxyPurchase: input.purchaseFor === 'other',
          registration: existingRegistration,
          order: existingOrder,
          orderAccessToken,
          ...(input.purchaseFor === 'self' && existingTicket ? { ticket: existingTicket } : {}),
        };
        this.memory.idempotency.set(memoryIdempotencyKey, { requestHash, response });
        return response;
      }
      const purchaserOrders = [...this.memory.orders.values()].filter(
        (order) =>
          this.memoryOrderPurchasers.get(order.id)?.customerUserId === customer.customerUserId,
      );
      const purchaserEvaluationAt = new Date();
      const purchaserOrderIsActive = (order: (typeof purchaserOrders)[number]) =>
        order.status !== 'pending_payment' || new Date(order.expiresAt) > purchaserEvaluationAt;
      const activePurchaserOrders = purchaserOrders.filter(purchaserOrderIsActive);
      const pendingOrder = activePurchaserOrders.find((order) =>
        ['pending_review', 'pending_payment', 'processing'].includes(order.status),
      );
      if (pendingOrder) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          `您已有待处理订单 ${pendingOrder.orderNo}，请先完成或关闭原订单`,
          HttpStatus.CONFLICT,
        );
      }
      const activeSeatCount = activePurchaserOrders.filter((order) =>
        ['pending_review', 'pending_payment', 'processing', 'paid', 'partially_refunded'].includes(
          order.status,
        ),
      ).length;
      if (activeSeatCount >= this.demoEvent.registration.maxActiveSeatsPerPurchaser) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          `本场大会每位购票人最多可持有 ${this.demoEvent.registration.maxActiveSeatsPerPurchaser} 个有效名额`,
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
      if (input.purchaseFor === 'self') {
        this.memoryRegistrationCustomers.set(registration.id, customer.customerUserId);
      }
      this.memory.orders.set(order.id, order);
      this.memoryOrderPurchasers.set(order.id, {
        customerUserId: customer.customerUserId,
        purchaseIntentId: input.purchaseIntentId,
        purchaseRequestHash,
        snapshot: {
          customerUserId: customer.customerUserId,
          mobile: loginMobile,
          ...customer.profile,
        },
      });
      this.memoryOutboxEvents.push({
        eventType: 'RegistrationSubmitted',
        payload: {
          registrationId: registration.id,
          orderId: order.id,
          recipientRole: 'purchaser',
          recipient: customer.profile.email || loginMobile,
        },
      });
      if (input.purchaseFor === 'other') {
        const attendeeClaimToken = randomBytes(32).toString('base64url');
        this.memoryAttendeeClaims.set(registration.id, {
          tokenHash: this.tokenHash(attendeeClaimToken),
          mobileDigest: this.tokenHash(attendeeMobile),
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
        });
        this.memoryOutboxEvents.push({
          eventType: 'AttendeeClaimInvitationRequested',
          payload: {
            registrationId: registration.id,
            recipientRole: 'attendee',
            recipient: registration.attendee.email || registration.attendee.mobile,
            sealedAttendeeClaimToken: this.sealNotificationSecret(attendeeClaimToken),
          },
        });
      }
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
        isProxyPurchase: input.purchaseFor === 'other',
        registration,
        order,
        orderAccessToken,
        ...(input.purchaseFor === 'self' && issuedTicket ? { ticket: issuedTicket } : {}),
      };
      this.memory.idempotency.set(memoryIdempotencyKey, { requestHash, response });
      return response;
    }

    return new BatchRegistrationService(this.database, new OrderItemsService(this.database)).createSingle(input, idempotencyKey, customer);
  }

  async confirmMockPayment(orderId: string, idempotencyKey: string): Promise<PaymentCompletion> {
    return this.confirmPayment(orderId, idempotencyKey, {
      provider: 'mock-wechat',
      externalId: idempotencyKey,
      payload: { mode: 'development-simulation' },
      reason: '模拟支付回调确认成功',
    });
  }

  async canUseLocalPaymentSimulation(
    orderId: string,
    accessToken: string,
    allowedMobileE164s: readonly string[],
  ): Promise<boolean> {
    const order = await this.getOrder(orderId, accessToken);
    const allowed = new Set(allowedMobileE164s);
    if (!allowed.size) return false;

    const db = this.database.db;
    if (!db) {
      const registration = this.memory.registrations.get(singleRegistrationId(order));
      const customerUserId = this.memoryRegistrationCustomers.get(singleRegistrationId(order));
      if (!registration || !customerUserId) return false;
      try {
        return allowed.has(normalizeMainlandMobile(registration.attendee.mobile));
      } catch {
        return false;
      }
    }

    if (order.modelVersion === 2) {
      const [buyer] = await db.select({ mobile: customerUsers.mobileE164 }).from(customerUsers).where(and(eq(customerUsers.id, sql`(select purchaser_customer_user_id from orders where id = ${order.id})`), eq(customerUsers.status, 'active'))).limit(1);
      return Boolean(buyer && allowed.has(buyer.mobile));
    }
    const [owner] = await db
      .select({
        attendeeMobileE164: registrations.attendeeMobileE164,
        customerMobileE164: customerUsers.mobileE164,
      })
      .from(orders)
      .innerJoin(registrations, eq(registrations.id, orders.registrationId))
      .innerJoin(
        customerUsers,
        and(
          eq(customerUsers.id, registrations.customerUserId),
          eq(customerUsers.organizationId, registrations.organizationId),
        ),
      )
      .where(
        and(
          eq(orders.id, order.id),
          isNull(registrations.supersededAt),
          eq(customerUsers.status, 'active'),
        ),
      )
      .limit(1);
    return Boolean(
      owner &&
      owner.attendeeMobileE164 === owner.customerMobileE164 &&
      allowed.has(owner.customerMobileE164),
    );
  }

  async confirmLocalPaymentSimulation(
    orderId: string,
    accessToken: string,
    idempotencyKey: string,
    allowedMobileE164s: readonly string[],
  ): Promise<PaymentCompletion> {
    if (!(await this.canUseLocalPaymentSimulation(orderId, accessToken, allowedMobileE164s))) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '当前订单没有本机模拟支付权限',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.confirmMockPayment(orderId, idempotencyKey);
  }

  async confirmPayment(
    orderId: string,
    idempotencyKey: string,
    confirmation: PaymentConfirmation,
  ): Promise<PaymentCompletion> {
    if (this.database.db) {
      const [current] = await this.database.db.select({ modelVersion: orders.modelVersion }).from(orders).where(eq(orders.id, orderId)).limit(1);
      if (current?.modelVersion === 2) return new BatchPaymentService(new OrderItemsService(this.database)).confirm(orderId, confirmation);
    }
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
      const registration = this.memory.registrations.get(singleRegistrationId(current))!;
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
      const purchaserCustomerUserId = this.memoryOrderPurchasers.get(current.id)?.customerUserId;
      const registrationCustomerUserId = this.memoryRegistrationCustomers.get(registration.id);
      const isProxyPurchase = Boolean(
        purchaserCustomerUserId && purchaserCustomerUserId !== registrationCustomerUserId,
      );
      if (current.status === 'paid' && existingTicket) {
        const response: PaymentCompletion = {
          order: current,
          ...(!isProxyPurchase ? { ticket: existingTicket } : {}),
        };
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
      const response: PaymentCompletion = {
        order: paidOrder,
        ...(!isProxyPurchase ? { ticket } : {}),
      };
      this.memory.idempotency.set(`payment:${idempotencyKey}`, { requestHash, response });
      return response;
    }

    return withPostgresTransactionRetry(() =>
      db.transaction(async (tx) => {
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
        if (!orderRow.registrationId) throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION, '订单报名关系需要核验', HttpStatus.CONFLICT);
        const [registrationRow] = await tx
          .select()
          .from(registrations)
          .where(
            and(eq(registrations.id, orderRow.registrationId), isNull(registrations.supersededAt)),
          )
          .limit(1);
        if (!registrationRow) {
          throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
        }
        const isProxyPurchase =
          registrationRow.consentSnapshot.purchaseFor === 'other' ||
          Boolean(
            orderRow.purchaserCustomerUserId &&
            registrationRow.customerUserId !== orderRow.purchaserCustomerUserId,
          );
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
          const response: PaymentCompletion = {
            order: mapOrder('paid'),
            ...(!isProxyPurchase ? { ticket: mapTicket(issuedTicket) } : {}),
          };
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
        let settledPaymentId = preparedPayment?.id;
        if (preparedPayment) {
          await tx
            .update(payments)
            .set({
              externalId: confirmation.externalId,
              status: 'succeeded',
              succeededAt: occurredAt,
              amount: orderRow.amount,
              currency: orderRow.currency,
              wechatTradeState: confirmation.provider === 'wechatpay' ? 'SUCCESS' : null,
              payload: confirmation.payload,
              updatedAt: now,
            })
            .where(eq(payments.id, preparedPayment.id));
        } else {
          const [receivedPayment] = await tx.insert(payments).values({
            orderId: orderRow.id,
            provider: confirmation.provider,
            externalId: confirmation.externalId,
            status: 'succeeded',
            succeededAt: occurredAt,
            amount: orderRow.amount,
            currency: orderRow.currency,
            outTradeNo,
            wechatTradeState: confirmation.provider === 'wechatpay' ? 'SUCCESS' : null,
            payload: confirmation.payload,
          }).returning({ id: payments.id });
          settledPaymentId = receivedPayment!.id;
        }
        await tx.update(orders).set({ settledPaymentId }).where(eq(orders.id, orderRow.id));
        await syncLegacyOrderItemState(tx, orderRow, 'active', now);
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
            payload: {
              orderId: orderRow.id,
              amount: orderRow.amount,
              currency: orderRow.currency,
              recipientRole: 'purchaser',
            },
          },
          {
            organizationId: orderRow.organizationId,
            eventId: orderRow.eventId,
            eventType: 'TicketIssued',
            correlationId: idempotencyKey,
            payload: {
              ticketId: ticketRow!.id,
              registrationId: registrationRow!.id,
              recipientRole: 'attendee',
            },
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
                recipient:
                  orderRow.purchaserSnapshot?.email ||
                  (orderRow.purchaserCustomerUserId === null && orderRow.purchaseIntentId === null
                    ? registrationRow!.attendee.email
                    : ''),
                recipientRole: 'purchaser',
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
          ...(!isProxyPurchase ? { ticket: mapTicket(ticketRow!) } : {}),
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
      }),
    );
  }

  async getOrder(identifier: string, accessToken: string): Promise<CustomerOrderAccess> {
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
      const registrationCustomerUserId = this.memoryRegistrationCustomers.get(singleRegistrationId(order));
      const purchaserCustomerUserId = this.memoryOrderPurchasers.get(order.id)?.customerUserId;
      return {
        ...order,
        isProxyPurchase: Boolean(
          purchaserCustomerUserId && registrationCustomerUserId !== purchaserCustomerUserId,
        ),
      };
    }

    const condition = UUID_PATTERN.test(identifier)
      ? or(eq(orders.id, identifier), eq(orders.orderNo, identifier))!
      : eq(orders.orderNo, identifier);
    const [row] = await db.select().from(orders).where(condition).limit(1);
    if (!row) throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
    const [activeRegistration] = row.registrationId ? await db
      .select({
        id: registrations.id,
        customerUserId: registrations.customerUserId,
        consentSnapshot: registrations.consentSnapshot,
      })
      .from(registrations)
      .where(eq(registrations.id, row.registrationId))
      .limit(1) : [];
    if (row.modelVersion === 1 && !activeRegistration) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
    }
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
    const paymentUrl =
      activeNative?.payload && typeof activeNative.payload.codeUrl === 'string'
        ? activeNative.payload.codeUrl
        : undefined;
    return {
      id: row.id,
      modelVersion: row.modelVersion,
      quantity: row.quantity,
      version: row.version,
      isProxyPurchase:
        !activeRegistration || activeRegistration.consentSnapshot.purchaseFor === 'other' ||
        Boolean(
          row.purchaserCustomerUserId &&
          activeRegistration.customerUserId !== row.purchaserCustomerUserId,
        ),
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
      if (
        input.decision === 'approve' &&
        (this.memory.ticketRemaining.get(registration.ticketType.id) ??
          registration.ticketType.remaining) < 1
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVENTORY_UNAVAILABLE,
          '审核期间名额已售罄，报名保持待审核',
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
        isProxyPurchase: Boolean(
          this.memoryOrderPurchasers.get(order.id)?.customerUserId &&
          this.memoryRegistrationCustomers.get(registrationId) !==
            this.memoryOrderPurchasers.get(order.id)?.customerUserId,
        ),
        registration: nextRegistration,
        order: nextOrder,
        ...(ticket ? { ticket } : {}),
      };
      this.memory.idempotency.set(memoryKey, { requestHash, response });
      return response;
    }

    const [batch] = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.organizationId, organizationId), eq(orders.eventId, eventId), eq(orders.modelVersion, 2), sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.registration_id = ${registrationId})`)).limit(1);
    if (batch) throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION, '请刷新页面，在订单详情统一审核全部名额', HttpStatus.CONFLICT, { orderId: batch.id, reason: 'batch_review_required' });

    return withPostgresTransactionRetry(() =>
      db.transaction(async (tx) => {
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
              isNull(registrations.supersededAt),
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
        const [ticketTypeRow] = await tx
          .select()
          .from(ticketTypes)
          .where(eq(ticketTypes.id, registrationRow.ticketTypeId))
          .for('update')
          .limit(1);
        const [eventRow] = await tx.select().from(events).where(eq(events.id, eventId)).limit(1);
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
        if (approved) {
          const eventSettings = eventRow.settings as { currentReleaseId?: string };
          let reviewCapacity = ticketTypeRow.capacity;
          if (eventSettings.currentReleaseId) {
            const [release] = await tx
              .select({ snapshot: eventReleases.snapshot })
              .from(eventReleases)
              .where(
                and(
                  eq(eventReleases.id, eventSettings.currentReleaseId),
                  eq(eventReleases.eventId, eventId),
                ),
              )
              .limit(1);
            const snapshot = release?.snapshot as EventReleaseSnapshot | undefined;
            reviewCapacity = effectiveReleasedCapacity(
              snapshot?.tickets?.find((item) => item.id === ticketTypeRow.id),
              ticketTypeRow.capacity,
            );
          }
          const [activeReservationCount] = await tx
            .select({
              quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int`,
            })
            .from(inventoryReservations)
            .where(
              and(
                eq(inventoryReservations.ticketTypeId, ticketTypeRow.id),
                isNull(inventoryReservations.convertedAt),
                isNull(inventoryReservations.releasedAt),
                activeInventoryReservationAt(now),
                sql`${inventoryReservations.orderId} <> ${orderRow.id}`,
              ),
            );
          const availableForApproval =
            reviewCapacity - ticketTypeRow.sold - (activeReservationCount?.quantity ?? 0);
          if (availableForApproval < 1) {
            throw new DomainError(
              API_ERROR_CODES.INVENTORY_UNAVAILABLE,
              '审核期间名额已售罄，报名保持待审核',
              HttpStatus.CONFLICT,
            );
          }
        }
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
        await syncLegacyOrderItemState(tx, orderRow,
          approved ? (freeCheckout ? 'active' : 'pending') : 'cancelled', now);

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
          const [freePayment] = await tx.insert(payments).values({
            orderId: orderRow.id,
            provider: 'free',
            externalId: `free:${orderRow.id}`,
            status: 'succeeded',
            succeededAt: now,
            amount: 0,
            currency: orderRow.currency,
            payload: { source: 'registration-review', actorId },
          }).returning({ id: payments.id });
          await tx.update(orders).set({ settledPaymentId: freePayment!.id }).where(eq(orders.id, orderRow.id));
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
          isProxyPurchase:
            registrationRow.consentSnapshot.purchaseFor === 'other' ||
            Boolean(
              orderRow.purchaserCustomerUserId &&
              registrationRow.customerUserId !== orderRow.purchaserCustomerUserId,
            ),
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
            recipientRole: 'attendee',
            recipient: registrationRow.attendee.email || registrationRow.attendee.mobile,
            reason: input.reason,
            paymentRequired: approved && !freeCheckout,
            ...(ticket ? { ticketId: ticket.id } : {}),
          },
        });
        if (approved && !freeCheckout) {
          await tx.insert(outboxEvents).values({
            organizationId,
            eventId,
            eventType: 'OrderAccessLinkRequested',
            correlationId: `registration:review-payment:${registrationId}`,
            payload: {
              registrationId,
              orderId: orderRow.id,
              recipientRole: 'purchaser',
              expiresAt: nextExpiresAt.toISOString(),
            },
          });
        }
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
              payload: { ticketId: ticket.id, registrationId, recipientRole: 'attendee' },
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
      }),
    );
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
      db
        .select()
        .from(registrations)
        .where(and(eq(registrations.id, row.registrationId), isNull(registrations.supersededAt)))
        .limit(1),
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
      refundPending: Boolean(row.refundPausedBy),
      issuedAt: row.issuedAt.toISOString(),
    };
  }

  async getOrderTicket(identifier: string, accessToken: string): Promise<Ticket> {
    const order = await this.getOrder(identifier, accessToken);
    if (order.modelVersion === 2) throw new DomainError(API_ERROR_CODES.FORBIDDEN, '请登录参会人账号查看电子票', HttpStatus.FORBIDDEN);
    if (!order.registrationId) throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单报名关系需要核验', HttpStatus.NOT_FOUND);
    if (order.isProxyPurchase) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '代购订单的电子票仅向参会人账号开放',
        HttpStatus.FORBIDDEN,
      );
    }
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
        .filter((registration) => {
          if (!query) return true;
          const order = [...this.memory.orders.values()].find(
            (item) => item.registrationId === registration.id,
          );
          const purchaser = order ? this.memoryOrderPurchasers.get(order.id)?.snapshot : undefined;
          return [
            purchaser?.realName,
            purchaser?.nickname,
            purchaser?.mobile,
            registration.attendee.name,
            registration.attendee.company,
            registration.attendee.mobile,
            registration.attendee.email,
            registration.registrationCode,
            order?.orderNo,
          ]
            .join(' ')
            .toLowerCase()
            .includes(query);
        })
        .map((registration) => {
          const order = [...this.memory.orders.values()].find(
            (item) => item.registrationId === registration.id,
          );
          const purchaser = order ? this.memoryOrderPurchasers.get(order.id)?.snapshot : undefined;
          const paidAmount =
            order && ['paid', 'partially_refunded', 'refunded'].includes(order.status)
              ? order.amount
              : 0;
          const refundedAmount = order?.status === 'refunded' ? order.amount : 0;
          return {
            ...registration,
            ...(order ? { order } : {}),
            purchaserName: purchaser?.realName || purchaser?.nickname || registration.attendee.name,
            purchaserMobile: purchaser?.mobile || registration.attendee.mobile,
            isProxyPurchase: Boolean(
              purchaser && purchaser.mobile !== registration.attendee.mobile,
            ),
            businessStatus: deriveRegistrationBusinessStatus({
              registrationStatus: registration.status,
              orderStatus: order?.status,
              orderAmount: order?.amount,
              latestPaymentStatus: order?.status === 'paid' ? 'succeeded' : null,
              paidAmount,
              refundedAmount,
            }),
            latestPaymentStatus: order?.status === 'paid' ? ('succeeded' as const) : null,
            paidAmount,
            refundedAmount,
            invoiceSummary: {
              status:
                order && ['paid', 'partially_refunded'].includes(order.status)
                  ? ('eligible' as const)
                  : ('not_eligible' as const),
              requestNo: null,
            },
            lastBusinessAt: order?.createdAt ?? registration.createdAt,
          };
        })
        .filter(
          (registration) =>
            !filters.businessStatus || registration.businessStatus === filters.businessStatus,
        )
        .filter(
          (registration) =>
            !filters.invoiceStatus || registration.invoiceSummary.status === filters.invoiceStatus,
        )
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

    const latestPaymentStatusExpression = sql<AdminRegistrationRow['latestPaymentStatus']>`(
      select ${payments.status}
      from ${payments}
      where ${payments.orderId} = ${orders.id}
      order by ${payments.createdAt} desc, ${payments.id} desc
      limit 1
    )`;
    const orderPaidAmountExpression = sql<number>`coalesce((
      select max(${payments.amount})
      from ${payments}
      where ${payments.orderId} = ${orders.id}
        and ${payments.status} in ('succeeded', 'refunded')
        and (${orders.modelVersion} = 1 or ${payments.id} = ${orders.settledPaymentId})
    ), 0)::int`;
    const orderRefundedAmountExpression = sql<number>`coalesce((
      select sum(${refunds.amount})
      from ${refunds}
      where ${refunds.orderId} = ${orders.id}
        and ${refunds.status} = 'succeeded'
        and (${orders.modelVersion} = 1 or ${refunds.paymentId} = ${orders.settledPaymentId})
    ), 0)::int`;
    const itemAmountExpression = sql<number>`coalesce((select oi.allocated_amount from order_items oi where oi.order_id = ${orders.id} and oi.registration_id = ${registrations.id}),0)::int`;
    const paidAmountExpression = sql<number>`case when ${orders.modelVersion} = 2 then case when ${orders.settledPaymentId} is not null then ${itemAmountExpression} else 0 end else ${orderPaidAmountExpression} end`;
    const refundedAmountExpression = sql<number>`case when ${orders.modelVersion} = 2 then coalesce((select sum(a.amount) from refund_item_allocations a join order_items oi on oi.id = a.order_item_id where oi.order_id = ${orders.id} and oi.registration_id = ${registrations.id}),0)::int else ${orderRefundedAmountExpression} end`;
    const businessStatusExpression = sql<RegistrationBusinessStatus>`case
      when ${orders.modelVersion} = 2 and exists (select 1 from order_items oi where oi.registration_id = ${registrations.id} and oi.state = 'cancelled') then case when ${refundedAmountExpression} > 0 then 'refunded' else 'closed' end
      when ${orders.modelVersion} = 2 and ${orders.settledPaymentId} is not null then case
        when ${paidAmountExpression} > 0 and ${refundedAmountExpression} >= ${paidAmountExpression} then 'refunded'
        when ${refundedAmountExpression} > 0 then 'partially_refunded'
        when ${paidAmountExpression} = 0 then 'confirmed' else 'paid' end
      when ${orders.status} = 'refunded'
        or ((${orderPaidAmountExpression}) > 0 and (${orderRefundedAmountExpression}) >= (${orderPaidAmountExpression}))
        then 'refunded'
      when ${orders.status} = 'partially_refunded' or (${orderRefundedAmountExpression}) > 0
        then 'partially_refunded'
      when ${orders.status} = 'paid' and ${orders.amount} = 0 then 'confirmed'
      when ${orders.status} = 'paid' then 'paid'
      when (${latestPaymentStatusExpression}) in ('pending', 'processing', 'preparing', 'query_pending', 'close_pending', 'unknown')
        then 'payment_processing'
      when (${latestPaymentStatusExpression}) = 'failed' then 'payment_failed'
      when ${orders.status} = 'closed' then 'closed'
      when ${registrations.status} = 'pending_review' then 'pending_review'
      when ${orders.status} = 'pending_payment' then 'pending_payment'
      when ${registrations.status} in ('confirmed', 'checked_in') then 'confirmed'
      else 'closed'
    end`;
    const invoiceStatusExpression = sql<AdminRegistrationRow['invoiceSummary']['status']>`case
      when ${invoiceRequests.id} is not null then ${invoiceRequests.status}::text
      when ${orders.status} in ('paid', 'partially_refunded')
        and (${orderPaidAmountExpression}) > (${orderRefundedAmountExpression})
        then 'eligible'
      else 'not_eligible'
    end`;
    const lastBusinessAtExpression = sql`greatest(
      ${registrations.updatedAt},
      coalesce(${orders.updatedAt}, ${registrations.updatedAt}),
      coalesce((select max(${payments.updatedAt}) from ${payments} where ${payments.orderId} = ${orders.id}), ${registrations.updatedAt}),
      coalesce((select max(${refunds.updatedAt}) from ${refunds} where ${refunds.orderId} = ${orders.id}), ${registrations.updatedAt}),
      coalesce(${invoiceRequests.updatedAt}, ${registrations.updatedAt})
    )`.mapWith(registrations.updatedAt);
    const conditions = [
      eq(registrations.eventId, eventId),
      eq(registrations.organizationId, organizationId),
      isNull(registrations.supersededAt),
    ];
    if (filters.status) conditions.push(eq(registrations.status, filters.status));
    if (filters.businessStatus) {
      conditions.push(sql`${businessStatusExpression} = ${filters.businessStatus}`);
    }
    if (filters.invoiceStatus) {
      conditions.push(sql`${invoiceStatusExpression} = ${filters.invoiceStatus}`);
    }
    if (filters.q) {
      const pattern = `%${filters.q.trim()}%`;
      conditions.push(
        or(
          ilike(registrations.registrationCode, pattern),
          ilike(orders.orderNo, pattern),
          sql`${registrations.attendee}->>'name' ilike ${pattern}`,
          sql`${registrations.attendee}->>'company' ilike ${pattern}`,
          sql`${registrations.attendee}->>'mobile' ilike ${pattern}`,
          sql`${orders.purchaserSnapshot}->>'name' ilike ${pattern}`,
          sql`${orders.purchaserSnapshot}->>'mobile' ilike ${pattern}`,
        )!,
      );
    }
    const [totalRow] = await db
      .select({ value: count() })
      .from(registrations)
      .leftJoin(orders, registrationOrderJoin())
      .leftJoin(invoiceRequests, eq(invoiceRequests.orderId, orders.id))
      .where(and(...conditions));
    const total = Number(totalRow?.value ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = await db
      .select({
        registration: registrations,
        order: orders,
        ticketType: ticketTypes,
        latestPaymentStatus: latestPaymentStatusExpression,
        paidAmount: paidAmountExpression,
        refundedAmount: refundedAmountExpression,
        businessStatus: businessStatusExpression,
        invoiceStatus: invoiceStatusExpression,
        invoiceRequestNo: invoiceRequests.requestNo,
        lastBusinessAt: lastBusinessAtExpression,
      })
      .from(registrations)
      .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
      .leftJoin(orders, registrationOrderJoin())
      .leftJoin(invoiceRequests, eq(invoiceRequests.orderId, orders.id))
      .where(and(...conditions))
      .orderBy(desc(registrations.createdAt), desc(registrations.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const items: AdminRegistrationRow[] = rows.map(
      ({
        registration,
        order,
        ticketType,
        latestPaymentStatus,
        paidAmount,
        refundedAmount,
        businessStatus,
        invoiceStatus,
        invoiceRequestNo,
        lastBusinessAt,
      }) => ({
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
        purchaserName: order?.purchaserSnapshot?.name || registration.attendee.name,
        purchaserMobile: order?.purchaserSnapshot?.mobile || registration.attendee.mobile,
        isProxyPurchase:
          registration.consentSnapshot.purchaseFor === 'other' ||
          Boolean(
            order?.purchaserSnapshot?.mobile &&
            order.purchaserSnapshot.mobile !== registration.attendee.mobile,
          ),
        ...(order ? { order: this.orderFromRow(order) } : {}),
        businessStatus,
        latestPaymentStatus,
        paidAmount,
        refundedAmount,
        invoiceSummary: { status: invoiceStatus, requestNo: invoiceRequestNo },
        lastBusinessAt: lastBusinessAt.toISOString(),
      }),
    );
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
      const purchaser = order ? this.memoryOrderPurchasers.get(order.id)?.snapshot : undefined;
      return {
        ...registration,
        ...(order ? { order } : {}),
        purchaserName: purchaser?.realName || purchaser?.nickname || registration.attendee.name,
        purchaserMobile: purchaser?.mobile || registration.attendee.mobile,
        isProxyPurchase: Boolean(purchaser && purchaser.mobile !== registration.attendee.mobile),
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
      .leftJoin(orders, registrationOrderJoin())
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
          isNull(registrations.supersededAt),
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
      purchaserName: order?.purchaserSnapshot?.name || registration.attendee.name,
      purchaserMobile: order?.purchaserSnapshot?.mobile || registration.attendee.mobile,
      isProxyPurchase:
        registration.consentSnapshot.purchaseFor === 'other' ||
        Boolean(
          order?.purchaserSnapshot?.mobile &&
          order.purchaserSnapshot.mobile !== registration.attendee.mobile,
        ),
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
    filters: Partial<AdminOrderListQuery> = {},
    organizationId: string = DEMO_IDS.organization,
  ): Promise<AdminOrderList> {
    const requestedPage = Math.max(1, Math.floor(filters.page ?? 1));
    const pageSize = 20 as const;
    const db = this.database.db;
    if (!db) {
      const query = filters.q?.trim().toLowerCase();
      const matching = [...this.memory.orders.values()]
        .filter((order) => this.memory.registrations.get(singleRegistrationId(order))?.eventId === eventId)
        .filter((order) => !filters.status || order.status === filters.status)
        .map((order): AdminOrderRow => {
          const registration = this.memory.registrations.get(singleRegistrationId(order))!;
          const purchaser = this.memoryOrderPurchasers.get(order.id)?.snapshot;
          const ticket = [...this.memory.tickets.values()].find(
            (item) => item.registrationId === registration.id,
          );
          return {
            ...order,
            purchaserName: purchaser?.realName || purchaser?.nickname || registration.attendee.name,
            purchaserMobile: purchaser?.mobile || registration.attendee.mobile,
            attendeeName: registration.attendee.name,
            attendeeMobile: registration.attendee.mobile,
            attendeeCompany: registration.attendee.company,
            ticketTypeName: registration.ticketType.name,
            isProxyPurchase: Boolean(
              purchaser && purchaser.mobile !== registration.attendee.mobile,
            ),
            fullRefundBlockedReason:
              registration.status === 'checked_in'
                ? '参会人已签到，无法整单退款'
                : ticket?.status === 'used'
                  ? '电子票已使用，无法整单退款'
                  : null,
          };
        })
        .filter(
          (order) =>
            !query ||
            [
              order.orderNo,
              order.purchaserName,
              order.purchaserMobile,
              order.attendeeName,
              order.attendeeMobile,
              order.attendeeCompany,
            ]
              .join(' ')
              .toLowerCase()
              .includes(query),
        )
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
      eq(orders.eventId, eventId),
      eq(orders.organizationId, organizationId),
    ];
    if (filters.status) conditions.push(eq(orders.status, filters.status as any));
    if (filters.q) {
      const pattern = `%${filters.q.trim()}%`;
      conditions.push(
        or(
          ilike(orders.orderNo, pattern),
          sql`${registrations.attendee}->>'name' ilike ${pattern}`,
          sql`${registrations.attendee}->>'company' ilike ${pattern}`,
          sql`${registrations.attendee}->>'mobile' ilike ${pattern}`,
          ilike(registrations.attendeeMobileE164, pattern),
          sql`exists (select 1 from order_items oi join registrations attendee on attendee.id = oi.registration_id where oi.order_id = ${orders.id} and (attendee.attendee->>'name' ilike ${pattern} or attendee.attendee->>'company' ilike ${pattern} or attendee.attendee_mobile_e164 ilike ${pattern}))`,
          sql`${orders.purchaserSnapshot}->>'name' ilike ${pattern}`,
          sql`${orders.purchaserSnapshot}->>'mobile' ilike ${pattern}`,
        )!,
      );
    }
    const [totalRow] = await db
      .select({ value: count() })
      .from(orders)
      .leftJoin(registrations, sql`${registrations.id} = coalesce(${orders.registrationId}, (select first_item.registration_id from order_items first_item where first_item.order_id = ${orders.id} order by first_item.position limit 1))`)
      .where(and(...conditions));
    const total = Number(totalRow?.value ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = await db
      .select({
        order: orders,
        registration: registrations,
        ticketType: ticketTypes,
        ticket: tickets,
      })
      .from(orders)
      .leftJoin(registrations, sql`${registrations.id} = coalesce(${orders.registrationId}, (select first_item.registration_id from order_items first_item where first_item.order_id = ${orders.id} order by first_item.position limit 1))`)
      .leftJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
      .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
      .where(and(...conditions))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const items = rows.map(({ order, registration, ticketType, ticket }): AdminOrderRow => ({
      id: order.id,
      modelVersion: order.modelVersion, quantity: order.quantity, version: order.version,
      orderNo: order.orderNo,
      registrationId: order.registrationId,
      status: order.status,
      amount: order.amount,
      currency: order.currency,
      paymentMethod: order.amount === 0 ? 'free' : 'wechat',
      expiresAt: order.expiresAt.toISOString(),
      createdAt: order.createdAt.toISOString(),
      purchaserName: order.purchaserSnapshot?.name || (registration?.attendee.name ?? ''),
      purchaserMobile: order.purchaserSnapshot?.mobile || (registration?.attendee.mobile ?? ''),
      attendeeName: order.quantity > 1 ? `${registration?.attendee.name ?? ''} 等 ${order.quantity} 位` : registration?.attendee.name ?? '',
      attendeeMobile: (registration?.attendee.mobile ?? ''),
      attendeeCompany: (registration?.attendee.company ?? ''),
      ticketTypeName: (ticketType?.name ?? String(order.pricingSnapshot.name ?? '大会门票')),
      isProxyPurchase:
        registration?.consentSnapshot.purchaseFor === 'other' ||
        Boolean(
          order.purchaserSnapshot?.mobile &&
          order.purchaserSnapshot.mobile !== (registration?.attendee.mobile ?? ''),
        ),
      fullRefundBlockedReason:
        registration?.status === 'checked_in'
          ? '参会人已签到，无法整单退款'
          : ticket?.status === 'used'
            ? '电子票已使用，无法整单退款'
            : null,
    }));
    return { items, total, page, pageSize };
  }

  async getDashboard(
    eventId: EventId = DEMO_IDS.event,
    organizationId: string = DEMO_IDS.organization,
    trendQuery: AdminDashboardQuery = {},
  ): Promise<AdminDashboard> {
    const db = this.database.db;
    if (!db) {
      const registrationRows = [...this.memory.registrations.values()].filter(
        (registration) => registration.eventId === eventId,
      );
      const orderRows = [...this.memory.orders.values()].filter((order) =>
        registrationRows.some((registration) => registration.id === order.registrationId),
      );
      const paidOrders = orderRows.filter((order) =>
        ['paid', 'partially_refunded'].includes(order.status),
      );
      const refundedOrders = orderRows.filter((order) => order.status === 'refunded');
      const paidRegistrationIds = new Set(
        paidOrders
          .filter((order) => {
            const registration = this.memory.registrations.get(singleRegistrationId(order));
            return registration && registration.status !== 'cancelled';
          })
          .map((order) => order.registrationId),
      );
      const confirmedAttendees = registrationRows.filter((registration) =>
        ['confirmed', 'checked_in', 'completed'].includes(registration.status),
      ).length;
      const purchaserKeys = new Set(
        paidOrders.map((order) => {
          const purchaser = this.memoryOrderPurchasers.get(order.id);
          const registration = this.memory.registrations.get(singleRegistrationId(order));
          return (
            purchaser?.customerUserId ||
            registration?.attendee.mobile ||
            registration?.attendee.email ||
            order.id
          );
        }),
      );
      const trendRange = this.dashboardTrendRange(trendQuery, this.demoEvent.timezone);
      const sampleTrend = [18, 24, 31, 27, 38, 42, 55, 49, 63, 68, 74, 82, 77, 91];
      return {
        eventId,
        eventName: this.demoEvent.name,
        updatedAt: new Date().toISOString(),
        metrics: {
          registrations: registrationRows.length,
          paidOrders: paidOrders.length,
          paidSeats: paidRegistrationIds.size,
          confirmedAttendees,
          purchasers: purchaserKeys.size,
          revenue: paidOrders.reduce((total, order) => total + order.amount, 0),
          refundedOrders: refundedOrders.length,
          refundedAmount: refundedOrders.reduce((total, order) => total + order.amount, 0),
          checkedIn: this.memory.checkins.size,
          conversionRate: registrationRows.length
            ? Number(((paidRegistrationIds.size / registrationRows.length) * 100).toFixed(1))
            : 0,
          pendingReview: registrationRows.filter((item) => item.status === 'pending_review').length,
        },
        registrationTrend: this.dashboardTrendDates(trendRange).map((date, index, dates) => ({
          date,
          value:
            sampleTrend[
              (((sampleTrend.length - dates.length + index) % sampleTrend.length) +
                sampleTrend.length) %
                sampleTrend.length
            ] ?? 0,
        })),
        ticketBreakdown: this.demoEvent.tickets.map((ticket, index) => ({
          id: ticket.id,
          name: ticket.name,
          sold: [64, 212, 26][index]!,
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
    const [[registrationMetric], [orderMetric], [refundMetric], [checkinMetric], ticketRows] =
      await Promise.all([
        db
          .select({
            registrations: count(),
            activeSubmitted: sql<number>`count(*) filter (where ${registrations.status} in ('pending_review', 'pending_payment', 'confirmed', 'checked_in', 'completed'))::int`,
            confirmedAttendees: sql<number>`count(*) filter (where ${registrations.status} in ('confirmed', 'checked_in', 'completed'))::int`,
            pendingReview: sql<number>`count(*) filter (where ${registrations.status} = 'pending_review')::int`,
          })
          .from(registrations)
          .where(
            and(
              eq(registrations.organizationId, organizationId),
              eq(registrations.eventId, eventId),
              isNull(registrations.supersededAt),
            ),
          ),
        db
          .select({
            paidOrders: sql<number>`count(*) filter (where ${orders.status} in ('paid', 'partially_refunded', 'refunded'))::int`,
            paidSeats: sql<number>`coalesce(sum(case when ${orders.modelVersion} = 2 then (select count(*) from order_items oi where oi.order_id = ${orders.id} and oi.state = 'active') when ${orders.status} in ('paid', 'partially_refunded') and ${registrations.status} <> 'cancelled' and ${registrations.supersededAt} is null then 1 else 0 end),0)::int`,
            purchasers: sql<number>`count(distinct case
              when ${orders.status} in ('paid', 'partially_refunded') then coalesce(
                case when ${orders.purchaserCustomerUserId} is not null then 'customer:' || ${orders.purchaserCustomerUserId}::text end,
                case when nullif(${orders.purchaserSnapshot}->>'customerUserId', '') is not null then 'customer:' || (${orders.purchaserSnapshot}->>'customerUserId') end,
                case when ${orders.purchaseIntentId} is null and ${registrations.customerUserId} is not null then 'customer:' || ${registrations.customerUserId}::text end,
                case when nullif(${orders.purchaserSnapshot}->>'mobile', '') is not null then 'mobile:' || (${orders.purchaserSnapshot}->>'mobile') end,
                case when nullif(${orders.purchaserSnapshot}->>'email', '') is not null then 'email:' || lower(${orders.purchaserSnapshot}->>'email') end,
                'order:' || ${orders.id}::text
              )
          end)::int`,
            revenue: sql<number>`coalesce(sum(
              case when ${orders.status} in ('paid', 'partially_refunded', 'refunded')
                then greatest(
                  ${orders.amount} - coalesce((
                    select sum(successful_refund.amount)
                    from ${refunds} successful_refund
                    where successful_refund.order_id = ${orders.id}
                      and successful_refund.status = 'succeeded'
                      and (${orders.modelVersion} = 1 or successful_refund.payment_id = ${orders.settledPaymentId})
                  ), 0),
                  0
                )
                else 0
              end
          ), 0)::int`,
          })
          .from(orders)
          .leftJoin(registrations, eq(registrations.id, orders.registrationId))
          .where(and(eq(orders.organizationId, organizationId), eq(orders.eventId, eventId))),
        db
          .select({
            refundedOrders: sql<number>`count(distinct ${refunds.orderId})::int`,
            refundedAmount: sql<number>`coalesce(sum(${refunds.amount}), 0)::int`,
          })
          .from(refunds)
          .where(
            and(
              eq(refunds.organizationId, organizationId),
              eq(refunds.eventId, eventId),
              eq(refunds.status, 'succeeded'),
            ),
          ),
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
    const registrationTotal = Number(registrationMetric?.registrations ?? 0);
    const activeSubmitted = Number(registrationMetric?.activeSubmitted ?? 0);
    const paidSeats = Number(orderMetric?.paidSeats ?? 0);

    return {
      eventId,
      eventName: event.name,
      updatedAt: new Date().toISOString(),
      metrics: {
        registrations: registrationTotal,
        paidOrders: Number(orderMetric?.paidOrders ?? 0),
        paidSeats,
        confirmedAttendees: Number(registrationMetric?.confirmedAttendees ?? 0),
        purchasers: Number(orderMetric?.purchasers ?? 0),
        revenue: Number(orderMetric?.revenue ?? 0),
        refundedOrders: Number(refundMetric?.refundedOrders ?? 0),
        refundedAmount: Number(refundMetric?.refundedAmount ?? 0),
        checkedIn: Number(checkinMetric?.value ?? 0),
        conversionRate: activeSubmitted
          ? Number(((paidSeats / activeSubmitted) * 100).toFixed(1))
          : 0,
        pendingReview: Number(registrationMetric?.pendingReview ?? 0),
      },
      registrationTrend: await this.registrationTrend(eventId, trendQuery, event.timezone),
      ticketBreakdown: ticketRows.map((ticket) => ({
        id: ticket.id,
        name: ticket.name,
        sold: ticket.sold,
        quota: ticket.capacity,
      })),
    };
  }

  private dashboardTimeZone(timeZone: string) {
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format();
      return timeZone;
    } catch {
      return 'UTC';
    }
  }

  private dashboardDateInTimeZone(date: Date, timeZone: string) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  private dashboardTrendRange(query: AdminDashboardQuery, requestedTimeZone: string) {
    if (query.from && query.to) return { from: query.from, to: query.to };
    const timeZone = this.dashboardTimeZone(requestedTimeZone);
    const to = this.dashboardDateInTimeZone(new Date(), timeZone);
    const from = new Date(`${to}T00:00:00.000Z`);
    from.setUTCDate(from.getUTCDate() - (query.days ?? 14) + 1);
    return {
      from: from.toISOString().slice(0, 10),
      to,
    };
  }

  private dashboardTrendDates(range: { from: string; to: string }) {
    const dates: string[] = [];
    const cursor = new Date(`${range.from}T00:00:00.000Z`);
    const end = new Date(`${range.to}T00:00:00.000Z`);
    while (cursor <= end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  }

  private async registrationTrend(
    eventId: EventId,
    query: AdminDashboardQuery,
    requestedTimeZone: string,
  ) {
    const db = this.database.db;
    if (!db) return [];
    const timeZone = this.dashboardTimeZone(requestedTimeZone);
    const range = this.dashboardTrendRange(query, timeZone);
    const rows = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', timezone(${timeZone}, ${registrations.createdAt})), 'YYYY-MM-DD')`,
        value: count(),
      })
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, eventId),
          isNull(registrations.supersededAt),
          sql`date(timezone(${timeZone}, ${registrations.createdAt})) between ${range.from}::date and ${range.to}::date`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const valuesByDate = new Map(rows.map((row) => [row.date, Number(row.value)]));
    return this.dashboardTrendDates(range).map((date) => ({
      date,
      value: valuesByDate.get(date) ?? 0,
    }));
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
      const registration = this.memory.registrations.get(singleRegistrationId(ticket));
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
      // Rights checks lock the order and its items before registration and ticket rows.
      const [ticketIdentity] = await tx
        .select({ registrationId: tickets.registrationId })
        .from(tickets)
        .where(and(eq(tickets.eventId, input.eventId), eq(tickets.code, ticketCode)))
        .limit(1);
      const [ticketOrder] = ticketIdentity
        ? await tx
            .select()
            .from(orders)
            .where(
              and(
                or(eq(orders.registrationId, ticketIdentity.registrationId), sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.registration_id = ${ticketIdentity.registrationId})`),
                eq(orders.organizationId, organizationId),
                eq(orders.eventId, input.eventId),
              ),
            )
            .for('update')
            .limit(1)
        : [];
      if (ticketOrder) {
        try {
          if (ticketOrder.modelVersion === 1 && ticketOrder.status === 'refunded') throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION, '原订单已退款', HttpStatus.CONFLICT);
          await guardRefundWrite(tx, ticketOrder.id, false, { purpose: 'admission', registrationId: ticketIdentity!.registrationId });
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          return { result: 'invalid' as const, checkedInAt: new Date().toISOString(), message: '该名额正在退款或权益核验，暂不能核销，请联系工作人员' };
        }
      }
      const [ticketRow] = await tx
        .select()
        .from(tickets)
        .where(and(eq(tickets.eventId, input.eventId), eq(tickets.code, ticketCode)))
        .for('update')
        .limit(1);
      if (!ticketRow || ticketRow.status === 'cancelled' || ticketRow.refundPausedBy) {
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
            isNull(registrations.supersededAt),
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
        if (nextStatus !== current.status && !isPublicEventStatus(nextStatus)) {
          const [homepage] = await tx
            .select({ eventId: organizationHomepageEvents.eventId })
            .from(organizationHomepageEvents)
            .where(
              and(
                eq(organizationHomepageEvents.organizationId, organizationId),
                eq(organizationHomepageEvents.eventId, eventId),
              ),
            )
            .limit(1);
          if (homepage) {
            throw new DomainError(
              API_ERROR_CODES.INVALID_STATE_TRANSITION,
              '当前大会是首页默认大会，请先将另一场已发布大会设为首页',
              HttpStatus.CONFLICT,
            );
          }
        }
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
        const refundSettingsChanged = patch.settings?.refunds !== undefined;
        const nextSettings =
          registrationChanged || refundSettingsChanged
            ? {
                ...current.settings,
                registration: nextRegistration,
                ...(patch.settings?.refunds ? { refunds: patch.settings.refunds } : {}),
              }
            : current.settings;
        const updateFields = Object.fromEntries(
          Object.entries(patch).filter(
            ([key, value]) =>
              key !== 'settings' && key !== 'startsAt' && key !== 'endsAt' && value !== undefined,
          ),
        ) as Partial<typeof events.$inferInsert>;
        if (nextStatus !== current.status) updateFields.status = nextStatus;
        const changedAt = new Date();
        const [row] = await tx
          .update(events)
          .set({
            ...updateFields,
            ...(patch.startsAt ? { startsAt } : {}),
            ...(patch.endsAt ? { endsAt } : {}),
            ...(registrationChanged || refundSettingsChanged ? { settings: nextSettings } : {}),
            updatedAt: changedAt,
          })
          .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
          .returning();
        if (row && row.timezone !== current.timezone) {
          await tx
            .update(eventPublicMetrics)
            .set({ dailyTrackingStartedAt: changedAt, updatedAt: changedAt })
            .where(
              and(
                eq(eventPublicMetrics.organizationId, organizationId),
                eq(eventPublicMetrics.eventId, eventId),
              ),
            );
        }
        if (row && (row.timezone !== current.timezone || (nextStatus === 'archived' && current.status !== 'archived'))) {
          const [digest] = await tx
            .select({
              id: eventFeishuDigestSubscriptions.id,
              enabled: eventFeishuDigestSubscriptions.enabled,
              sendLocalTime: eventFeishuDigestSubscriptions.sendLocalTime,
            })
            .from(eventFeishuDigestSubscriptions)
            .where(
              and(
                eq(eventFeishuDigestSubscriptions.organizationId, organizationId),
                eq(eventFeishuDigestSubscriptions.eventId, eventId),
              ),
            )
            .limit(1);
          if (digest) {
            const archived = nextStatus === 'archived';
            await tx
              .update(eventFeishuDigestSubscriptions)
              .set({
                timezoneSnapshot: row.timezone,
                enabled: archived ? false : digest.enabled,
                nextRunAt:
                  archived || !digest.enabled
                    ? null
                    : nextFeishuDigestRun(changedAt, row.timezone, digest.sendLocalTime),
                configVersion: sql`${eventFeishuDigestSubscriptions.configVersion} + 1`,
                pauseReason: archived ? 'event_archived' : null,
                revision: sql`${eventFeishuDigestSubscriptions.revision} + 1`,
                updatedAt: changedAt,
              })
              .where(eq(eventFeishuDigestSubscriptions.id, digest.id));
            await tx.update(feishuDigestDeliveries).set({ status: 'cancelled', leaseToken: null, leaseUntil: null, lastErrorCode: archived ? 'EVENT_ARCHIVED' : 'EVENT_TIMEZONE_CHANGED', lastError: '大会状态或时区已变化，原发送任务已取消', updatedAt: changedAt }).where(and(eq(feishuDigestDeliveries.organizationId, organizationId), eq(feishuDigestDeliveries.eventId, eventId), inArray(feishuDigestDeliveries.status, ['queued', 'generating', 'retrying'])));
          }
        }
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
      organization?.slug ?? process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
      false,
    );
  }

  async health() {
    try {
      const database = await this.database.ping();
      return {
        status: database.ok && database.migration.ok ? 'ok' : 'degraded',
        database,
        event: this.demoEvent.slug,
        build: resolveBuildInfo('api', process.env),
        time: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(error);
      return {
        status: 'degraded',
        database: {
          mode: 'postgresql',
          ok: false,
          migration: {
            ok: false,
            expected: process.env.BUILD_MIGRATION_HASH ?? 'unknown',
            applied: 'unknown',
          },
        },
        event: this.demoEvent.slug,
        build: resolveBuildInfo('api', process.env),
        time: new Date().toISOString(),
      };
    }
  }
}
