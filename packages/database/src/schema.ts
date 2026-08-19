import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { inArray, isNotNull, sql } from 'drizzle-orm';
import { DEFAULT_ANALYTICS_SETTINGS } from '@conference/contracts';
import type {
  AgentApprovalPolicy,
  AgentDataClass,
  AgentIdempotencyStrategy,
  AgentOperationStatus,
  AgentRisk,
  AgentScope,
  ConferenceTemplateDefinition,
  CooperationType,
  EventSettings,
  FeishuDigestSnapshot,
  HtmlTemplateBindingManifest,
  OrganizationRole,
  OrganizationSettings,
  SpeakerSocialLink,
  TemplateSurface,
} from '@conference/contracts';

type AttendeeIndustryCode =
  | 'ai'
  | 'brand-marketing-geo'
  | 'internet-software-it'
  | 'ecommerce-retail-consumer'
  | 'enterprise-service-consulting'
  | 'advertising-media-content'
  | 'education-training'
  | 'finance-investment'
  | 'healthcare'
  | 'manufacturing-supply-chain'
  | 'real-estate-construction'
  | 'government-association-public'
  | 'other';

type AttendeeShowcaseVisibleFields = Record<
  | 'avatar'
  | 'displayName'
  | 'company'
  | 'title'
  | 'industry'
  | 'businessIntro'
  | 'businessUrl'
  | 'contactPhone'
  | 'contactEmail'
  | 'wechatId',
  boolean
>;

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const eventStatus = pgEnum('event_status', [
  'draft',
  'configuring',
  'prepublished',
  'registration_open',
  'in_progress',
  'ended',
  'archived',
]);

export const registrationStatus = pgEnum('registration_status', [
  'draft',
  'pending_review',
  'pending_payment',
  'confirmed',
  'cancelled',
  'checked_in',
  'completed',
]);

export const orderStatus = pgEnum('order_status', [
  'pending_review',
  'pending_payment',
  'processing',
  'paid',
  'partially_refunded',
  'refunded',
  'closed',
]);

export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'refunded',
  'preparing',
  'query_pending',
  'close_pending',
  'closed',
  'unknown',
]);

/** Payment attempt states that continue to hold provider and inventory coordination. */
export const ACTIVE_WECHAT_PAYMENT_STATUSES = [
  'preparing',
  'pending',
  'processing',
  'query_pending',
  'close_pending',
  'unknown',
] as const;

export const paymentChannel = pgEnum('payment_channel', ['native', 'jsapi', 'h5', 'free', 'mock']);

export const membershipStatus = pgEnum('membership_status', ['active', 'disabled']);
export const customerStatus = pgEnum('customer_status', ['active', 'blocked', 'closed']);
export const invitationStatus = pgEnum('invitation_status', ['pending', 'accepted', 'cancelled']);
export const ticketStatus = pgEnum('ticket_status', ['valid', 'used', 'cancelled']);
export const conferenceTemplateStatus = pgEnum('conference_template_status', [
  'active',
  'archived',
]);
export const invoiceRequestStatus = pgEnum('invoice_request_status', [
  'awaiting_details',
  'pending_review',
  'issuing',
  'issue_failed',
  'issued',
  'rejected',
  'adjustment_required',
  'voided',
  'cancelled',
]);
export const checkInResult = pgEnum('checkin_result', [
  'accepted',
  'duplicate',
  'invalid',
  'forbidden',
  'manual_review',
]);

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 80 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    settings: jsonb('settings')
      .$type<Partial<OrganizationSettings> & Record<string, unknown>>()
      .notNull()
      .default({
        brandName: '大会管理中心',
        defaultTimezone: 'Asia/Shanghai',
        defaultCurrency: 'CNY',
        defaultBlueprintId: null,
        defaultTemplateId: null,
        customerAccounts: {
          defaultAccountMode: 'mobile_otp_required',
          termsUrl: '',
          termsVersion: '',
          privacyUrl: '',
          privacyVersion: '',
        },
        website: {
          siteName: '大会报名中心',
          seoTitle: '大会报名中心',
          seoDescription: '',
          faviconUrl: '',
          footerText: '',
          icpNumber: '',
          supportEmail: '',
        },
        analytics: DEFAULT_ANALYTICS_SETTINGS,
      }),
    ...timestamps,
  },
  (table) => [uniqueIndex('organizations_slug_unique').on(table.slug)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    mobile: varchar('mobile', { length: 32 }),
    passwordHash: text('password_hash'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const customerUsers = pgTable(
  'customer_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    mobileE164: varchar('mobile_e164', { length: 24 }).notNull(),
    status: customerStatus('status').notNull().default('active'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    lastRegistrationAt: timestamp('last_registration_at', { withTimezone: true }),
    internalNote: text('internal_note').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('customer_users_id_org_unique').on(table.id, table.organizationId),
    uniqueIndex('customer_users_org_mobile_unique').on(table.organizationId, table.mobileE164),
    index('customer_users_org_status_created_idx').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index('customer_users_org_last_registration_idx').on(
      table.organizationId,
      table.lastRegistrationAt,
      table.id,
    ),
    index('customer_users_org_effective_activity_idx').on(
      table.organizationId,
      sql`coalesce(${table.lastRegistrationAt}, ${table.createdAt})`,
      table.id,
    ),
    index('customer_users_mobile_trgm_idx').using('gin', table.mobileE164.asc().op('gin_trgm_ops')),
  ],
);

export const userIdAllocators = pgTable(
  'user_id_allocators',
  {
    scope: varchar('scope', { length: 40 }).primaryKey(),
    lastId: integer('last_id').notNull(),
  },
  (table) => [
    check('user_id_allocators_last_id_range', sql`${table.lastId} between 100 and 2147483647`),
  ],
);

export const publicUserIds = pgTable(
  'public_user_ids',
  {
    publicId: integer('public_id')
      .primaryKey()
      .default(sql`allocate_user_public_id()`),
    subjectType: varchar('subject_type', { length: 20 }).$type<'staff' | 'customer'>().notNull(),
    subjectUuid: uuid('subject_uuid').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    check('public_user_ids_id_range', sql`${table.publicId} between 101 and 2147483647`),
    check('public_user_ids_subject_type', sql`${table.subjectType} in ('staff', 'customer')`),
    uniqueIndex('public_user_ids_subject_unique').on(table.subjectType, table.subjectUuid),
    index('public_user_ids_active_subject_idx').on(
      table.subjectType,
      table.subjectUuid,
      table.retiredAt,
    ),
  ],
);

export const customerProfiles = pgTable(
  'customer_profiles',
  {
    customerUserId: uuid('customer_user_id')
      .primaryKey()
      .references(() => customerUsers.id, { onDelete: 'cascade' }),
    nickname: varchar('nickname', { length: 80 }),
    realName: varchar('real_name', { length: 120 }),
    email: varchar('email', { length: 255 }),
    company: varchar('company', { length: 160 }),
    title: varchar('title', { length: 100 }),
    city: varchar('city', { length: 80 }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index('customer_profiles_email_idx').on(table.email),
    index('customer_profiles_nickname_trgm_idx').using(
      'gin',
      table.nickname.asc().op('gin_trgm_ops'),
    ),
    index('customer_profiles_real_name_trgm_idx').using(
      'gin',
      table.realName.asc().op('gin_trgm_ops'),
    ),
    index('customer_profiles_email_trgm_idx').using('gin', table.email.asc().op('gin_trgm_ops')),
    index('customer_profiles_company_trgm_idx').using(
      'gin',
      table.company.asc().op('gin_trgm_ops'),
    ),
  ],
);

export const customerMediaAssets = pgTable(
  'customer_media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => customerUsers.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull().default('avatar'),
    sourceStorageKey: varchar('source_storage_key', { length: 500 }).notNull(),
    outputStorageKey: varchar('output_storage_key', { length: 500 }),
    mediaType: varchar('media_type', { length: 80 }).notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    contentDigest: varchar('content_digest', { length: 64 }).notNull(),
    status: varchar('status', { length: 24 }).notNull().default('processing'),
    failureReason: text('failure_reason'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    sourceDeletedAt: timestamp('source_deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.customerUserId, table.organizationId],
      foreignColumns: [customerUsers.id, customerUsers.organizationId],
      name: 'customer_media_assets_customer_org_fk',
    }),
    check('customer_media_assets_kind_check', sql`${table.kind} in ('avatar')`),
    check(
      'customer_media_assets_status_check',
      sql`${table.status} in ('processing', 'ready', 'failed')`,
    ),
    check('customer_media_assets_size_check', sql`${table.size} between 1 and 5242880`),
    index('customer_media_assets_owner_time_idx').on(
      table.organizationId,
      table.customerUserId,
      table.createdAt,
    ),
    index('customer_media_assets_status_idx').on(table.status, table.updatedAt),
  ],
);

export const customerAuthChallenges = pgTable(
  'customer_auth_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    mobileE164: varchar('mobile_e164', { length: 24 }).notNull(),
    codeDigest: varchar('code_digest', { length: 128 }).notNull(),
    requestIpHash: varchar('request_ip_hash', { length: 64 }).notNull(),
    deliveryId: uuid('delivery_id'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('customer_auth_challenges_mobile_time_idx').on(
      table.organizationId,
      table.mobileE164,
      table.createdAt,
    ),
    index('customer_auth_challenges_ip_time_idx').on(table.requestIpHash, table.createdAt),
    index('customer_auth_challenges_global_mobile_time_idx').on(table.mobileE164, table.createdAt),
    index('customer_auth_challenges_expiry_idx').on(table.expiresAt),
  ],
);

export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => customerUsers.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    userAgentHash: varchar('user_agent_hash', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.customerUserId, table.organizationId],
      foreignColumns: [customerUsers.id, customerUsers.organizationId],
      name: 'customer_sessions_user_org_fk',
    }),
    uniqueIndex('customer_sessions_token_hash_unique').on(table.tokenHash),
    index('customer_sessions_user_expiry_idx').on(table.customerUserId, table.expiresAt),
    index('customer_sessions_expiry_idx').on(table.expiresAt),
    index('customer_sessions_revoked_idx').on(table.revokedAt),
  ],
);

export const customerConsents = pgTable(
  'customer_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => customerUsers.id, { onDelete: 'cascade' }),
    consentType: varchar('consent_type', { length: 32 }).notNull(),
    version: varchar('version', { length: 40 }).notNull(),
    source: varchar('source', { length: 32 }).notNull().default('otp_login'),
    requestIpHash: varchar('request_ip_hash', { length: 64 }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('customer_consents_user_type_version_unique').on(
      table.customerUserId,
      table.consentType,
      table.version,
    ),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 60 }).$type<OrganizationRole>().notNull(),
    grants: jsonb('grants').$type<string[]>().notNull().default([]),
    status: membershipStatus('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('memberships_org_user_unique').on(table.organizationId, table.userId),
    uniqueIndex('memberships_id_org_user_unique').on(table.id, table.organizationId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
);

export const organizationIntegrations = pgTable(
  'organization_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 40 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('unconfigured'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    encryptedCredentials: text('encrypted_credentials'),
    keyVersion: integer('key_version').notNull().default(1),
    revision: integer('revision').notNull().default(0),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastError: text('last_error'),
    updatedBy: uuid('updated_by').references(() => users.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('organization_integrations_org_provider_unique').on(
      table.organizationId,
      table.provider,
    ),
    index('organization_integrations_org_idx').on(table.organizationId),
  ],
);

export const organizationInvitations = pgTable(
  'organization_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    role: varchar('role', { length: 60 }).$type<OrganizationRole>().notNull(),
    grants: jsonb('grants').$type<string[]>().notNull().default([]),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    status: invitationStatus('status').notNull().default('pending'),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('organization_invitations_token_hash_unique').on(table.tokenHash),
    index('organization_invitations_org_status_idx').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index('organization_invitations_email_idx').on(table.email),
  ],
);

export const memberProfiles = pgTable(
  'member_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    company: varchar('company', { length: 160 }),
    title: varchar('title', { length: 100 }),
    city: varchar('city', { length: 80 }),
    bio: text('bio'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('member_profiles_org_user_unique').on(table.organizationId, table.userId),
    index('member_profiles_org_idx').on(table.organizationId),
  ],
);

export const eventIdAllocators = pgTable(
  'event_id_allocators',
  {
    scope: varchar('scope', { length: 40 }).primaryKey(),
    lastId: integer('last_id').notNull(),
  },
  (table) => [
    check('event_id_allocators_last_id_range', sql`${table.lastId} between 100 and 2147483647`),
  ],
);

export const events = pgTable(
  'events',
  {
    id: integer('id')
      .primaryKey()
      .default(sql`allocate_event_id()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 100 }).notNull(),
    name: varchar('name', { length: 180 }).notNull(),
    shortName: varchar('short_name', { length: 80 }).notNull(),
    tagline: varchar('tagline', { length: 240 }).notNull(),
    description: text('description').notNull(),
    status: eventStatus('status').notNull().default('draft'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    timezone: varchar('timezone', { length: 80 }).notNull(),
    venue: varchar('venue', { length: 160 }).notNull(),
    city: varchar('city', { length: 80 }).notNull(),
    address: varchar('address', { length: 240 }).notNull(),
    settings: jsonb('settings')
      .$type<Partial<EventSettings> & Record<string, unknown>>()
      .notNull()
      .default({
        locale: 'zh-CN',
        registration: {
          paymentMode: 'ticketed',
          currency: 'CNY',
          registrationOpen: true,
          accountMode: 'mobile_otp_required',
          additionalPurchaseEnabled: false,
          maxActiveSeatsPerPurchaser: 5,
        },
      }),
    ...timestamps,
  },
  (table) => [
    check('events_id_range', sql`${table.id} between 101 and 2147483647`),
    uniqueIndex('events_org_slug_unique').on(table.organizationId, table.slug),
    uniqueIndex('events_org_id_unique').on(table.organizationId, table.id),
    uniqueIndex('events_id_org_unique').on(table.id, table.organizationId),
    index('events_org_status_idx').on(table.organizationId, table.status),
  ],
);

export const eventPublicMetrics = pgTable(
  'event_public_metrics',
  {
    organizationId: uuid('organization_id').notNull(),
    eventId: integer('event_id').notNull(),
    pageViews: bigint('page_views', { mode: 'number' }).notNull().default(0),
    trackingStartedAt: timestamp('tracking_started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    dailyTrackingStartedAt: timestamp('daily_tracking_started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.eventId] }),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [events.organizationId, events.id],
      name: 'event_public_metrics_event_scope_fk',
    }).onDelete('cascade'),
    check('event_public_metrics_page_views_nonnegative', sql`${table.pageViews} >= 0`),
  ],
);

export const eventPublicMetricDays = pgTable(
  'event_public_metric_days',
  {
    organizationId: uuid('organization_id').notNull(),
    eventId: integer('event_id').notNull(),
    localDate: date('local_date').notNull(),
    pageViews: bigint('page_views', { mode: 'number' }).notNull().default(0),
    timezoneSnapshot: varchar('timezone_snapshot', { length: 80 }).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.eventId, table.localDate] }),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [events.organizationId, events.id],
      name: 'event_public_metric_days_event_scope_fk',
    }).onDelete('cascade'),
    check('event_public_metric_days_page_views_nonnegative', sql`${table.pageViews} >= 0`),
  ],
);

export const eventFeishuDigestSubscriptions = pgTable(
  'event_feishu_digest_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    eventId: integer('event_id').notNull(),
    digestType: varchar('digest_type', { length: 40 }).notNull().default('daily_operations'),
    enabled: boolean('enabled').notNull().default(false),
    chatId: varchar('chat_id', { length: 160 }),
    chatNameSnapshot: varchar('chat_name_snapshot', { length: 200 }),
    sendLocalTime: varchar('send_local_time', { length: 5 }).notNull().default('09:00'),
    timezoneSnapshot: varchar('timezone_snapshot', { length: 80 }).notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastSuccessfulAt: timestamp('last_successful_at', { withTimezone: true }),
    testVerifiedAt: timestamp('test_verified_at', { withTimezone: true }),
    testVerifiedChatId: varchar('test_verified_chat_id', { length: 160 }),
    revision: integer('revision').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [events.organizationId, events.id],
      name: 'event_feishu_digest_subscriptions_event_scope_fk',
    }).onDelete('cascade'),
    uniqueIndex('event_feishu_digest_subscriptions_scope_unique').on(
      table.organizationId,
      table.eventId,
      table.digestType,
    ),
    index('event_feishu_digest_subscriptions_due_idx').on(table.enabled, table.nextRunAt),
    check(
      'event_feishu_digest_subscriptions_type_check',
      sql`${table.digestType} in ('daily_operations')`,
    ),
    check(
      'event_feishu_digest_subscriptions_time_check',
      sql`${table.sendLocalTime} ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
  ],
);

export const feishuDigestDeliveries = pgTable(
  'feishu_digest_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id').references(() => eventFeishuDigestSubscriptions.id, {
      onDelete: 'set null',
    }),
    sourceDeliveryId: uuid('source_delivery_id').references(
      (): AnyPgColumn => feishuDigestDeliveries.id,
      { onDelete: 'set null' },
    ),
    organizationId: uuid('organization_id').notNull(),
    eventId: integer('event_id').notNull(),
    kind: varchar('kind', { length: 24 }).notNull(),
    reportDate: date('report_date').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    aggregateSnapshot: jsonb('aggregate_snapshot').$type<FeishuDigestSnapshot>(),
    cardDigest: varchar('card_digest', { length: 64 }),
    chatIdSnapshot: varchar('chat_id_snapshot', { length: 160 }).notNull(),
    chatNameSnapshot: varchar('chat_name_snapshot', { length: 200 }).notNull(),
    status: varchar('status', { length: 24 }).notNull().default('queued'),
    providerMessageId: varchar('provider_message_id', { length: 160 }),
    attempts: integer('attempts').notNull().default(0),
    lastErrorCode: varchar('last_error_code', { length: 80 }),
    lastError: text('last_error'),
    dedupKey: varchar('dedup_key', { length: 240 }).notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [events.organizationId, events.id],
      name: 'feishu_digest_deliveries_event_scope_fk',
    }).onDelete('cascade'),
    uniqueIndex('feishu_digest_deliveries_dedup_unique').on(table.dedupKey),
    index('feishu_digest_deliveries_event_time_idx').on(
      table.organizationId,
      table.eventId,
      table.createdAt,
    ),
    index('feishu_digest_deliveries_status_time_idx').on(table.status, table.updatedAt),
    check(
      'feishu_digest_deliveries_kind_check',
      sql`${table.kind} in ('scheduled', 'manual_test', 'manual_resend')`,
    ),
    check(
      'feishu_digest_deliveries_status_check',
      sql`${table.status} in ('queued', 'generating', 'sending', 'retrying', 'sent', 'unknown', 'failed', 'skipped', 'cancelled')`,
    ),
    check('feishu_digest_deliveries_attempts_nonnegative', sql`${table.attempts} >= 0`),
  ],
);

export const eventSlugAliases = pgTable(
  'event_slug_aliases',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 100 }).notNull(),
    eventId: integer('event_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.slug] }),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [events.organizationId, events.id],
      name: 'event_slug_aliases_event_scope_fk',
    }).onDelete('cascade'),
    index('event_slug_aliases_event_idx').on(table.eventId),
  ],
);

export const organizationHomepageEvents = pgTable(
  'organization_homepage_events',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [events.organizationId, events.id],
      name: 'organization_homepage_events_event_scope_fk',
    }).onDelete('cascade'),
    index('organization_homepage_events_event_idx').on(table.eventId),
  ],
);

export const eventBlueprints = pgTable(
  'event_blueprints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 160 }).notNull(),
    version: integer('version').notNull().default(1),
    status: varchar('status', { length: 32 }).notNull().default('draft'),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull().default({}),
    clonePolicy: jsonb('clone_policy')
      .$type<Record<string, 'COPY' | 'RESET' | 'REFERENCE' | 'EXCLUDE'>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (table) => [index('event_blueprints_org_idx').on(table.organizationId)],
);

export const templatePackages = pgTable(
  'template_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: varchar('key', { length: 80 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    version: integer('version').notNull().default(1),
    status: varchar('status', { length: 32 }).notNull().default('published'),
    description: text('description').notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [uniqueIndex('template_packages_key_version_unique').on(table.key, table.version)],
);

export const conferenceTemplates = pgTable(
  'conference_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 80 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    description: text('description').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    status: conferenceTemplateStatus('status').notNull().default('active'),
    currentPublishedVersionId: uuid('current_published_version_id').references(
      (): AnyPgColumn => conferenceTemplateVersions.id,
      { onDelete: 'set null' },
    ),
    createdBy: uuid('created_by').references(() => users.id),
    updatedBy: uuid('updated_by').references(() => users.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('conference_templates_org_code_unique').on(table.organizationId, table.code),
    index('conference_templates_org_status_idx').on(table.organizationId, table.status),
  ],
);

export const conferenceTemplateDrafts = pgTable(
  'conference_template_drafts',
  {
    templateId: uuid('template_id')
      .primaryKey()
      .references(() => conferenceTemplates.id, { onDelete: 'cascade' }),
    rendererPackageId: uuid('renderer_package_id')
      .notNull()
      .references(() => templatePackages.id),
    schemaVersion: integer('schema_version').notNull().default(2),
    definition: jsonb('definition').$type<ConferenceTemplateDefinition>().notNull(),
    revision: integer('revision').notNull().default(0),
    contentDigest: varchar('content_digest', { length: 128 }).notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('conference_template_drafts_renderer_idx').on(table.rendererPackageId)],
);

export const conferenceTemplateVersions = pgTable(
  'conference_template_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => conferenceTemplates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    rendererPackageId: uuid('renderer_package_id')
      .notNull()
      .references(() => templatePackages.id),
    schemaVersion: integer('schema_version').notNull().default(2),
    definition: jsonb('definition').$type<ConferenceTemplateDefinition>().notNull(),
    contentDigest: varchar('content_digest', { length: 128 }).notNull(),
    previewAssetKey: varchar('preview_asset_key', { length: 500 }),
    changeSummary: text('change_summary').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('conference_template_versions_template_version_unique').on(
      table.templateId,
      table.version,
    ),
    index('conference_template_versions_template_idx').on(table.templateId, table.publishedAt),
  ],
);

export const templateAssets = pgTable(
  'template_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    storageKey: varchar('storage_key', { length: 500 }).notNull(),
    mediaType: varchar('media_type', { length: 100 }).notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    contentDigest: varchar('content_digest', { length: 128 }).notNull(),
    altText: varchar('alt_text', { length: 500 }).notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('template_assets_org_digest_unique').on(table.organizationId, table.contentDigest),
    index('template_assets_org_created_idx').on(table.organizationId, table.createdAt),
  ],
);

export const templateAssetUploadReservations = pgTable(
  'template_asset_upload_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    storageKey: varchar('storage_key', { length: 500 }).notNull(),
    mediaType: varchar('media_type', { length: 100 }).notNull(),
    size: integer('size').notNull(),
    contentDigest: varchar('content_digest', { length: 128 }).notNull(),
    consumedAssetId: uuid('consumed_asset_id').references(() => templateAssets.id, {
      onDelete: 'cascade',
    }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    cleanupRequestedAt: timestamp('cleanup_requested_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('template_asset_upload_reservations_storage_unique').on(table.storageKey),
    index('template_asset_upload_reservations_org_expiry_idx').on(
      table.organizationId,
      table.expiresAt,
    ),
    index('template_asset_upload_reservations_expiry_idx').on(table.expiresAt),
  ],
);

export const templateHtmlImports = pgTable(
  'template_html_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').references(() => conferenceTemplates.id, {
      onDelete: 'cascade',
    }),
    mode: varchar('mode', { length: 20 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('awaiting_upload'),
    scanLeaseToken: uuid('scan_lease_token'),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    sourceStorageKey: varchar('source_storage_key', { length: 500 }).notNull(),
    sourceDigest: varchar('source_digest', { length: 128 }),
    sourceSize: integer('source_size'),
    stagedHtmlKey: varchar('staged_html_key', { length: 500 }),
    sanitizedHtml: text('sanitized_html'),
    sanitizedDigest: varchar('sanitized_digest', { length: 128 }),
    nodeManifest: jsonb('node_manifest')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    assetManifest: jsonb('asset_manifest')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    securityReport: jsonb('security_report').$type<Record<string, unknown>>().notNull().default({}),
    requestedMetadata: jsonb('requested_metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    committedTemplateId: uuid('committed_template_id').references(() => conferenceTemplates.id, {
      onDelete: 'set null',
    }),
    committedDocumentId: uuid('committed_document_id'),
    errorCode: varchar('error_code', { length: 80 }),
    errorMessage: text('error_message'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (table) => [
    index('template_html_imports_org_status_idx').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index('template_html_imports_expiry_idx').on(table.expiresAt),
  ],
);

export const templateHtmlImportAssets = pgTable(
  'template_html_import_assets',
  {
    importId: uuid('import_id')
      .notNull()
      .references(() => templateHtmlImports.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => templateAssets.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    staged: boolean('staged').notNull().default(false),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.importId, table.assetId] }),
    index('template_html_import_assets_org_asset_idx').on(table.organizationId, table.assetId),
  ],
);

export const templateHtmlDocuments = pgTable(
  'template_html_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => conferenceTemplates.id, { onDelete: 'cascade' }),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    sourceStorageKey: varchar('source_storage_key', { length: 500 }).notNull(),
    sourceDigest: varchar('source_digest', { length: 128 }).notNull(),
    sourceSize: integer('source_size').notNull(),
    sanitizedHtml: text('sanitized_html').notNull(),
    sanitizedDigest: varchar('sanitized_digest', { length: 128 }).notNull(),
    nodeManifest: jsonb('node_manifest')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    assetManifest: jsonb('asset_manifest')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    securityReport: jsonb('security_report').$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    compilerVersion: integer('compiler_version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('template_html_documents_org_digest_idx').on(table.organizationId, table.sanitizedDigest),
    index('template_html_documents_template_idx').on(table.templateId, table.createdAt),
  ],
);

export const eventTemplateBindings = pgTable(
  'event_template_bindings',
  {
    eventId: integer('event_id')
      .primaryKey()
      .references(() => events.id, { onDelete: 'cascade' }),
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => conferenceTemplateVersions.id),
    updatePolicy: varchar('update_policy', { length: 32 }).notNull().default('manual'),
    revision: integer('revision').notNull().default(0),
    boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (table) => [index('event_template_bindings_version_idx').on(table.templateVersionId)],
);

export const eventTemplateOverrides = pgTable(
  'event_template_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    surface: varchar('surface', { length: 40 }).$type<TemplateSurface>().notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    document: jsonb('document').$type<Record<string, unknown>>().notNull().default({}),
    revision: integer('revision').notNull().default(0),
    contentDigest: varchar('content_digest', { length: 128 }).notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('event_template_overrides_event_surface_unique').on(table.eventId, table.surface),
    index('event_template_overrides_event_idx').on(table.eventId),
  ],
);

export const eventReleases = pgTable(
  'event_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    templateKey: varchar('template_key', { length: 80 }).notNull(),
    templateVersionId: uuid('template_version_id').references(() => conferenceTemplateVersions.id),
    status: varchar('status', { length: 32 }).notNull().default('published'),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    artifactKey: varchar('artifact_key', { length: 320 }).notNull(),
    changeSummary: text('change_summary').notNull().default('历史发布版本'),
    changeScope: varchar('change_scope', { length: 32 }).notNull().default('site'),
    activationKind: varchar('activation_kind', { length: 16 }).notNull().default('manual'),
    createdBy: uuid('created_by').references(() => users.id),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('event_releases_event_version_unique').on(table.eventId, table.version),
    index('event_releases_event_published_idx').on(table.eventId, table.publishedAt),
  ],
);

export const ticketTypes = pgTable(
  'ticket_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 40 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description').notNull(),
    price: integer('price').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('CNY'),
    capacity: integer('capacity').notNull(),
    sold: integer('sold').notNull().default(0),
    active: boolean('active').notNull().default(true),
    recommended: boolean('recommended').notNull().default(false),
    benefits: jsonb('benefits').$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('ticket_types_event_code_unique').on(table.eventId, table.code),
    index('ticket_types_event_idx').on(table.eventId),
  ],
);

export const ticketQuotas = pgTable(
  'ticket_quotas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    capacity: integer('capacity').notNull(),
    sold: integer('sold').notNull().default(0),
    ticketTypeIds: jsonb('ticket_type_ids').$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (table) => [index('ticket_quotas_event_idx').on(table.eventId)],
);

export const registrationForms = pgTable(
  'registration_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    version: integer('version').notNull().default(1),
    status: varchar('status', { length: 32 }).notNull().default('draft'),
    fields: jsonb('fields')
      .$type<
        Array<{
          key: string;
          label: string;
          type: 'text' | 'email' | 'tel' | 'select';
          required: boolean;
          placeholder?: string;
          options?: string[];
        }>
      >()
      .notNull()
      .default([]),
    termsVersion: varchar('terms_version', { length: 32 }).notNull(),
    termsContent: text('terms_content').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('registration_forms_event_version_unique').on(table.eventId, table.version),
    index('registration_forms_event_status_idx').on(table.eventId, table.status),
  ],
);

export const registrations = pgTable(
  'registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    ticketTypeId: uuid('ticket_type_id')
      .notNull()
      .references(() => ticketTypes.id),
    customerUserId: uuid('customer_user_id').references(() => customerUsers.id, {
      onDelete: 'set null',
    }),
    supersededByRegistrationId: uuid('superseded_by_registration_id').references(
      (): AnyPgColumn => registrations.id,
      { onDelete: 'set null' },
    ),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    registrationCode: varchar('registration_code', { length: 40 }).notNull(),
    status: registrationStatus('status').notNull().default('pending_payment'),
    attendee: jsonb('attendee')
      .$type<{
        name: string;
        mobile: string;
        email: string;
        company: string;
        title: string;
        city: string;
      }>()
      .notNull(),
    attendeeMobileE164: varchar('attendee_mobile_e164', { length: 24 }).notNull().default(''),
    attendeeEmailNormalized: varchar('attendee_email_normalized', { length: 255 })
      .notNull()
      .default(''),
    invoiceRequired: boolean('invoice_required').notNull().default(false),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    formVersion: integer('form_version').notNull().default(1),
    termsVersion: varchar('terms_version', { length: 32 }).notNull().default('2026-07-16'),
    formAnswers: jsonb('form_answers').$type<Record<string, string>>().notNull().default({}),
    consentSnapshot: jsonb('consent_snapshot')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.customerUserId, table.organizationId],
      foreignColumns: [customerUsers.id, customerUsers.organizationId],
      name: 'registrations_customer_org_fk',
    }),
    uniqueIndex('registrations_code_unique').on(table.registrationCode),
    uniqueIndex('registrations_business_tuple_unique').on(
      table.id,
      table.organizationId,
      table.eventId,
    ),
    index('registrations_event_status_idx').on(table.eventId, table.status),
    index('registrations_customer_time_idx').on(table.customerUserId, table.createdAt),
    index('registrations_org_mobile_idx').on(
      table.organizationId,
      table.attendeeMobileE164,
      table.createdAt,
    ),
    index('registrations_superseded_idx').on(table.eventId, table.supersededAt),
    uniqueIndex('registrations_event_mobile_unique')
      .on(table.eventId, table.attendeeMobileE164)
      .where(sql`${table.attendeeMobileE164} <> '' and ${table.supersededAt} is null`),
    uniqueIndex('registrations_event_customer_unique')
      .on(table.eventId, table.customerUserId)
      .where(sql`${table.customerUserId} is not null and ${table.supersededAt} is null`),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => registrations.id),
    purchaserCustomerUserId: uuid('purchaser_customer_user_id').references(() => customerUsers.id, {
      onDelete: 'set null',
    }),
    purchaserSnapshot: jsonb('purchaser_snapshot').$type<{
      customerUserId: string | null;
      mobile: string;
      name: string;
      email: string;
      company: string;
      title: string;
      city: string;
    }>(),
    purchaseIntentId: uuid('purchase_intent_id'),
    orderNo: varchar('order_no', { length: 40 }).notNull(),
    status: orderStatus('status').notNull().default('pending_payment'),
    amount: integer('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    pricingSnapshot: jsonb('pricing_snapshot').$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.registrationId, table.organizationId, table.eventId],
      foreignColumns: [registrations.id, registrations.organizationId, registrations.eventId],
      name: 'orders_registration_scope_fk',
    }),
    foreignKey({
      columns: [table.purchaserCustomerUserId, table.organizationId],
      foreignColumns: [customerUsers.id, customerUsers.organizationId],
      name: 'orders_purchaser_customer_org_fk',
    }).onDelete('no action'),
    uniqueIndex('orders_no_unique').on(table.orderNo),
    uniqueIndex('orders_registration_unique').on(table.registrationId),
    uniqueIndex('orders_business_tuple_unique').on(
      table.id,
      table.registrationId,
      table.organizationId,
      table.eventId,
    ),
    index('orders_event_status_idx').on(table.eventId, table.status),
    index('orders_purchaser_time_idx').on(table.purchaserCustomerUserId, table.createdAt),
    uniqueIndex('orders_purchaser_intent_unique')
      .on(
        table.organizationId,
        table.eventId,
        table.purchaserCustomerUserId,
        table.purchaseIntentId,
      )
      .where(
        sql`${table.purchaserCustomerUserId} is not null and ${table.purchaseIntentId} is not null`,
      ),
  ],
);

export const attendeeClaimTokens = pgTable(
  'attendee_claim_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    mobileDigest: varchar('mobile_digest', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('attendee_claim_tokens_hash_unique').on(table.tokenHash),
    index('attendee_claim_tokens_registration_time_idx').on(table.registrationId, table.createdAt),
    index('attendee_claim_tokens_active_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} is null and ${table.revokedAt} is null`),
  ],
);

export const registrationPurchaseAttempts = pgTable(
  'registration_purchase_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    purchaserCustomerUserId: uuid('purchaser_customer_user_id').notNull(),
    purchaseIntentId: uuid('purchase_intent_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.purchaserCustomerUserId, table.organizationId],
      foreignColumns: [customerUsers.id, customerUsers.organizationId],
      name: 'registration_purchase_attempts_purchaser_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.eventId, table.organizationId],
      foreignColumns: [events.id, events.organizationId],
      name: 'registration_purchase_attempts_event_org_fk',
    }).onDelete('cascade'),
    index('registration_purchase_attempts_purchaser_time_idx').on(
      table.organizationId,
      table.eventId,
      table.purchaserCustomerUserId,
      table.createdAt,
    ),
    uniqueIndex('registration_purchase_attempts_intent_unique').on(
      table.organizationId,
      table.eventId,
      table.purchaserCustomerUserId,
      table.purchaseIntentId,
    ),
  ],
);

export const orderStateLogs = pgTable(
  'order_state_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: varchar('from_status', { length: 40 }),
    toStatus: varchar('to_status', { length: 40 }).notNull(),
    reason: varchar('reason', { length: 240 }).notNull(),
    actorId: uuid('actor_id').references(() => users.id),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('order_state_logs_order_time_idx').on(table.orderId, table.createdAt)],
);

export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    ticketTypeId: uuid('ticket_type_id')
      .notNull()
      .references(() => ticketTypes.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('inventory_reservations_ticket_expiry_idx').on(table.ticketTypeId, table.expiresAt),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 40 }).notNull(),
    channel: paymentChannel('channel'),
    outTradeNo: varchar('out_trade_no', { length: 32 }),
    externalId: varchar('external_id', { length: 120 }),
    status: paymentStatus('status').notNull().default('pending'),
    amount: integer('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    wechatTradeState: varchar('wechat_trade_state', { length: 32 }),
    credentialVersion: integer('credential_version').notNull().default(1),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    prepayExpiresAt: timestamp('prepay_expires_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lastQueriedAt: timestamp('last_queried_at', { withTimezone: true }),
    queryCount: integer('query_count').notNull().default(0),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('payments_provider_external_unique').on(table.provider, table.externalId),
    uniqueIndex('payments_out_trade_no_unique').on(table.outTradeNo),
    index('payments_order_status_channel_idx').on(table.orderId, table.status, table.channel),
    uniqueIndex('payments_active_attempt_unique')
      .on(table.orderId)
      .where(inArray(table.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES])),
  ],
);

export const attendeeShowcaseProfiles = pgTable(
  'attendee_showcase_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'cascade' }),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => customerUsers.id, { onDelete: 'cascade' }),
    publicSlug: varchar('public_slug', { length: 32 }).notNull(),
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }).notNull(),
    sequence: integer('sequence').notNull(),
    displayName: varchar('display_name', { length: 120 }),
    company: varchar('company', { length: 160 }),
    title: varchar('title', { length: 100 }),
    industryCode: varchar('industry_code', { length: 48 }).$type<AttendeeIndustryCode>(),
    businessIntro: text('business_intro'),
    businessUrl: varchar('business_url', { length: 500 }),
    contactPhone: varchar('contact_phone', { length: 40 }),
    contactEmail: varchar('contact_email', { length: 255 }),
    wechatId: varchar('wechat_id', { length: 80 }),
    avatarAssetId: uuid('avatar_asset_id').references(() => customerMediaAssets.id, {
      onDelete: 'set null',
    }),
    isPublic: boolean('is_public').notNull().default(false),
    visibleFields: jsonb('visible_fields')
      .$type<AttendeeShowcaseVisibleFields>()
      .notNull()
      .default({
        avatar: true,
        displayName: true,
        company: true,
        title: true,
        industry: true,
        businessIntro: true,
        businessUrl: true,
        contactPhone: false,
        contactEmail: false,
        wechatId: false,
      }),
    consentVersion: varchar('consent_version', { length: 40 }),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    adminHiddenAt: timestamp('admin_hidden_at', { withTimezone: true }),
    adminHiddenReason: varchar('admin_hidden_reason', { length: 500 }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.registrationId, table.organizationId, table.eventId],
      foreignColumns: [registrations.id, registrations.organizationId, registrations.eventId],
      name: 'attendee_showcases_registration_scope_fk',
    }),
    foreignKey({
      columns: [table.customerUserId, table.organizationId],
      foreignColumns: [customerUsers.id, customerUsers.organizationId],
      name: 'attendee_showcases_customer_org_fk',
    }),
    uniqueIndex('attendee_showcases_registration_unique').on(table.registrationId),
    uniqueIndex('attendee_showcases_public_slug_unique').on(table.publicSlug),
    uniqueIndex('attendee_showcases_avatar_asset_unique')
      .on(table.avatarAssetId)
      .where(isNotNull(table.avatarAssetId)),
    check('attendee_showcases_sequence_positive', sql`${table.sequence} > 0`),
    check('attendee_showcases_version_positive', sql`${table.version} > 0`),
    index('attendee_showcases_public_list_idx').on(
      table.eventId,
      table.isPublic,
      table.adminHiddenAt,
      table.qualifiedAt,
      table.registrationId,
    ),
    index('attendee_showcases_industry_idx').on(
      table.eventId,
      table.industryCode,
      table.qualifiedAt,
      table.registrationId,
    ),
    index('attendee_showcases_customer_idx').on(table.customerUserId, table.updatedAt),
  ],
);

export const paymentNotificationInbox = pgTable(
  'payment_notification_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    notificationId: varchar('notification_id', { length: 128 }).notNull(),
    outTradeNo: varchar('out_trade_no', { length: 32 }).notNull(),
    paymentId: uuid('payment_id').references(() => payments.id),
    orderId: uuid('order_id').references(() => orders.id),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('received'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('payment_notification_inbox_notification_unique').on(table.notificationId),
    index('payment_notification_inbox_status_idx').on(table.status, table.updatedAt),
    index('payment_notification_inbox_out_trade_no_idx').on(table.outTradeNo),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').references(() => payments.id),
    refundNo: varchar('refund_no', { length: 48 }).notNull(),
    amount: integer('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('succeeded'),
    reason: varchar('reason', { length: 240 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    providerPayload: jsonb('provider_payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('refunds_no_unique').on(table.refundNo),
    uniqueIndex('refunds_idempotency_unique').on(table.idempotencyKey),
    index('refunds_order_idx').on(table.orderId),
  ],
);

export const invoiceRequests = pgTable(
  'invoice_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestNo: varchar('request_no', { length: 48 }).notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'cascade' }),
    buyerType: varchar('buyer_type', { length: 32 }),
    title: varchar('title', { length: 200 }),
    taxId: varchar('tax_id', { length: 40 }),
    email: varchar('email', { length: 255 }),
    mobile: varchar('mobile', { length: 32 }),
    content: varchar('content', { length: 120 }),
    amount: integer('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('CNY'),
    netPaidAmount: integer('net_paid_amount').notNull(),
    status: invoiceRequestStatus('status').notNull().default('awaiting_details'),
    rejectionReason: text('rejection_reason'),
    deliveryStatus: varchar('delivery_status', { length: 32 }).notNull().default('not_sent'),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.orderId, table.registrationId, table.organizationId, table.eventId],
      foreignColumns: [orders.id, orders.registrationId, orders.organizationId, orders.eventId],
      name: 'invoice_requests_order_scope_fk',
    }),
    uniqueIndex('invoice_requests_org_no_unique').on(table.organizationId, table.requestNo),
    uniqueIndex('invoice_requests_order_unique').on(table.orderId),
    index('invoice_requests_org_status_idx').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index('invoice_requests_event_idx').on(table.eventId, table.createdAt),
    index('invoice_requests_registration_time_idx').on(
      table.registrationId,
      table.requestedAt,
      table.id,
    ),
  ],
);

export const invoiceDocuments = pgTable(
  'invoice_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceRequestId: uuid('invoice_request_id')
      .notNull()
      .references(() => invoiceRequests.id, { onDelete: 'cascade' }),
    documentType: varchar('document_type', { length: 32 }).notNull().default('original'),
    invoiceNumber: varchar('invoice_number', { length: 80 }).notNull(),
    invoiceCode: varchar('invoice_code', { length: 80 }),
    externalReference: varchar('external_reference', { length: 160 }),
    storageKey: varchar('storage_key', { length: 500 }).notNull(),
    mediaType: varchar('media_type', { length: 100 }).notNull(),
    size: integer('size').notNull(),
    contentDigest: varchar('content_digest', { length: 128 }).notNull(),
    replacesDocumentId: uuid('replaces_document_id').references(
      (): AnyPgColumn => invoiceDocuments.id,
      { onDelete: 'set null' },
    ),
    issuedBy: uuid('issued_by').references(() => users.id),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    voidedBy: uuid('voided_by').references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('invoice_documents_request_number_unique').on(
      table.invoiceRequestId,
      table.invoiceNumber,
    ),
    uniqueIndex('invoice_documents_one_active_per_request_unique')
      .on(table.invoiceRequestId)
      .where(sql`${table.voidedAt} is null`),
    index('invoice_documents_request_idx').on(table.invoiceRequestId, table.issuedAt),
  ],
);

export const invoiceStateLogs = pgTable(
  'invoice_state_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceRequestId: uuid('invoice_request_id')
      .notNull()
      .references(() => invoiceRequests.id, { onDelete: 'cascade' }),
    fromStatus: varchar('from_status', { length: 40 }),
    toStatus: varchar('to_status', { length: 40 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    actorId: uuid('actor_id').references(() => users.id),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('invoice_state_logs_request_time_idx').on(table.invoiceRequestId, table.createdAt),
  ],
);

export const invoiceExportJobs = pgTable(
  'invoice_export_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id),
    status: varchar('status', { length: 32 }).notNull().default('queued'),
    filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
    rowCount: integer('row_count').notNull().default(0),
    filename: varchar('filename', { length: 240 }),
    csvContent: text('csv_content'),
    storageKey: varchar('storage_key', { length: 500 }),
    contentDigest: varchar('content_digest', { length: 128 }),
    size: integer('size'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('invoice_export_jobs_org_created_idx').on(table.organizationId, table.createdAt),
    index('invoice_export_jobs_status_idx').on(table.status, table.createdAt),
  ],
);

export const orderAccessTokens = pgTable(
  'order_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('order_access_tokens_hash_unique').on(table.tokenHash),
    index('order_access_tokens_order_expiry_idx').on(table.orderId, table.expiresAt),
  ],
);

export const orderAccessLinkAttempts = pgTable(
  'order_access_link_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    combinationHash: varchar('combination_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('order_access_link_attempts_hash_time_idx').on(table.combinationHash, table.createdAt),
  ],
);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'cascade' }),
    ticketTypeId: uuid('ticket_type_id')
      .notNull()
      .references(() => ticketTypes.id),
    code: varchar('code', { length: 80 }).notNull(),
    status: ticketStatus('status').notNull().default('valid'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('tickets_code_unique').on(table.code),
    uniqueIndex('tickets_registration_unique').on(table.registrationId),
  ],
);

export const checkinLists = pgTable(
  'checkin_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 60 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    rules: jsonb('rules').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [uniqueIndex('checkin_lists_event_code_unique').on(table.eventId, table.code)],
);

export const checkinDevices = pgTable(
  'checkin_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    deviceCode: varchar('device_code', { length: 80 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    capabilities: jsonb('capabilities')
      .$type<string[]>()
      .notNull()
      .default(['checkin', 'offline_sync']),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('checkin_devices_event_code_unique').on(table.eventId, table.deviceCode),
    index('checkin_devices_event_status_idx').on(table.eventId, table.status),
  ],
);

export const checkinSyncBatches = pgTable(
  'checkin_sync_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => checkinDevices.id),
    batchKey: varchar('batch_key', { length: 120 }).notNull(),
    payloadHash: varchar('payload_hash', { length: 128 }).notNull(),
    recordsCount: integer('records_count').notNull(),
    acceptedCount: integer('accepted_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    invalidCount: integer('invalid_count').notNull().default(0),
    status: varchar('status', { length: 24 }).notNull().default('processing'),
    results: jsonb('results')
      .$type<
        Array<{
          localId: string;
          result: 'accepted' | 'duplicate' | 'invalid' | 'forbidden' | 'manual_review';
          message: string;
        }>
      >()
      .notNull()
      .default([]),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('checkin_sync_batches_device_key_unique').on(table.deviceId, table.batchKey),
    index('checkin_sync_batches_event_time_idx').on(table.eventId, table.receivedAt),
  ],
);

export const checkinRecords = pgTable(
  'checkin_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    checkinListId: uuid('checkin_list_id')
      .notNull()
      .references(() => checkinLists.id),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    deviceId: varchar('device_id', { length: 120 }).notNull(),
    operatorId: uuid('operator_id').references(() => users.id),
    result: checkInResult('result').notNull(),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }).notNull().defaultNow(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    uniqueIndex('checkin_records_ticket_list_success_unique').on(
      table.ticketId,
      table.checkinListId,
    ),
    index('checkin_records_event_time_idx').on(table.eventId, table.checkedInAt),
  ],
);

export const speakers = pgTable(
  'speakers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    role: varchar('role', { length: 240 }).notNull(),
    topic: varchar('topic', { length: 240 }).notNull(),
    initials: varchar('initials', { length: 8 }).notNull(),
    accentFrom: varchar('accent_from', { length: 16 }).notNull(),
    accentTo: varchar('accent_to', { length: 16 }).notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    avatarAssetId: uuid('avatar_asset_id').references(() => templateAssets.id),
    bio: text('bio'),
    topicAbstract: text('topic_abstract'),
    websiteUrl: varchar('website_url', { length: 500 }),
    socialLinks: jsonb('social_links').$type<SpeakerSocialLink[]>().notNull().default([]),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (table) => [index('speakers_event_order_idx').on(table.eventId, table.sortOrder)],
);

export const cooperationRequests = pgTable(
  'cooperation_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id').notNull(),
    requestNo: varchar('request_no', { length: 32 }).notNull(),
    cooperationTypes: jsonb('cooperation_types').$type<CooperationType[]>().notNull(),
    companyName: varchar('company_name', { length: 160 }).notNull(),
    contactName: varchar('contact_name', { length: 80 }).notNull(),
    contactTitle: varchar('contact_title', { length: 80 }).notNull().default(''),
    mobileE164: varchar('mobile_e164', { length: 24 }).notNull().default(''),
    emailNormalized: varchar('email_normalized', { length: 255 }).notNull().default(''),
    wechatId: varchar('wechat_id', { length: 80 }).notNull().default(''),
    message: text('message').notNull(),
    status: varchar('status', { length: 24 }).notNull().default('new'),
    internalNote: text('internal_note').notNull().default(''),
    firstContactedAt: timestamp('first_contacted_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [events.organizationId, events.id],
      name: 'cooperation_requests_event_scope_fk',
    }).onDelete('cascade'),
    uniqueIndex('cooperation_requests_request_no_unique').on(table.requestNo),
    index('cooperation_requests_event_status_time_idx').on(
      table.organizationId,
      table.eventId,
      table.status,
      table.createdAt,
    ),
    index('cooperation_requests_event_time_idx').on(
      table.organizationId,
      table.eventId,
      table.createdAt,
    ),
    check(
      'cooperation_requests_status_check',
      sql`${table.status} in ('new', 'contacted', 'converted', 'closed')`,
    ),
    check(
      'cooperation_requests_types_count_check',
      sql`jsonb_array_length(${table.cooperationTypes}) between 1 and 3`,
    ),
    check(
      'cooperation_requests_contact_check',
      sql`${table.mobileE164} <> '' or ${table.emailNormalized} <> '' or ${table.wechatId} <> ''`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    title: varchar('title', { length: 240 }).notNull(),
    summary: text('summary'),
    speaker: varchar('speaker', { length: 160 }),
    kind: varchar('kind', { length: 24 }).notNull().default('talk'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (table) => [index('sessions_event_day_order_idx').on(table.eventId, table.day, table.sortOrder)],
);

export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    ticketTypeId: uuid('ticket_type_id')
      .notNull()
      .references(() => ticketTypes.id),
    customerUserId: uuid('customer_user_id').references(() => customerUsers.id, {
      onDelete: 'set null',
    }),
    email: varchar('email', { length: 255 }).notNull().default(''),
    mobileE164: varchar('mobile_e164', { length: 24 }).notNull().default(''),
    name: varchar('name', { length: 120 }).notNull(),
    notificationChannel: varchar('notification_channel', { length: 16 }).notNull().default('email'),
    status: varchar('status', { length: 32 }).notNull().default('waiting'),
    position: integer('position').notNull(),
    offerTokenHash: varchar('offer_token_hash', { length: 64 }),
    offerTokenLast4: varchar('offer_token_last4', { length: 8 }),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.customerUserId, table.organizationId],
      foreignColumns: [customerUsers.id, customerUsers.organizationId],
      name: 'waitlist_customer_org_fk',
    }),
    uniqueIndex('waitlist_event_ticket_email_unique')
      .on(table.eventId, table.ticketTypeId, table.email)
      .where(sql`${table.email} <> ''`),
    uniqueIndex('waitlist_event_ticket_mobile_unique')
      .on(table.eventId, table.ticketTypeId, table.mobileE164)
      .where(sql`${table.mobileE164} <> ''`),
    index('waitlist_customer_idx').on(table.customerUserId, table.createdAt),
    index('waitlist_event_status_position_idx').on(table.eventId, table.status, table.position),
    uniqueIndex('waitlist_offer_token_hash_unique').on(table.offerTokenHash),
  ],
);

export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 80 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    channel: varchar('channel', { length: 32 }).notNull().default('email'),
    subject: varchar('subject', { length: 240 }).notNull(),
    body: text('body').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('notification_templates_org_code_version_unique').on(
      table.organizationId,
      table.code,
      table.version,
    ),
    index('notification_templates_org_status_idx').on(table.organizationId, table.status),
  ],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id').references(() => events.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').references(() => notificationTemplates.id),
    registrationId: uuid('registration_id').references(() => registrations.id, {
      onDelete: 'set null',
    }),
    channel: varchar('channel', { length: 32 }).notNull(),
    recipient: varchar('recipient', { length: 255 }).notNull(),
    subject: varchar('subject', { length: 240 }).notNull(),
    body: text('body').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('queued'),
    providerMessageId: varchar('provider_message_id', { length: 160 }),
    error: text('error'),
    accessTokenId: uuid('access_token_id').references(() => orderAccessTokens.id, {
      onDelete: 'set null',
    }),
    sealedAccessToken: text('sealed_access_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    uncertainAt: timestamp('uncertain_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('notification_deliveries_org_status_idx').on(table.organizationId, table.status),
    index('notification_deliveries_event_time_idx').on(table.eventId, table.createdAt),
    index('notification_deliveries_channel_subject_time_idx').on(
      table.channel,
      table.subject,
      table.createdAt,
    ),
  ],
);

export const aiPrompts = pgTable(
  'ai_prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 80 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    version: integer('version').notNull().default(1),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    systemPrompt: text('system_prompt').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('ai_prompts_org_code_version_unique').on(
      table.organizationId,
      table.code,
      table.version,
    ),
  ],
);

export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: integer('event_id').references(() => events.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').references(() => conferenceTemplates.id, {
      onDelete: 'cascade',
    }),
    promptId: uuid('prompt_id').references(() => aiPrompts.id),
    createdBy: uuid('created_by').references(() => users.id),
    task: varchar('task', { length: 80 }).notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    output: text('output').notNull(),
    outputJson: jsonb('output_json').$type<Record<string, unknown>>(),
    status: varchar('status', { length: 32 }).notNull().default('draft'),
    provider: varchar('provider', { length: 80 }).notNull(),
    model: varchar('model', { length: 120 }).notNull(),
    documentDigest: varchar('document_digest', { length: 128 }),
    bindingDigest: varchar('binding_digest', { length: 128 }),
    baseRevision: integer('base_revision'),
    catalogVersion: integer('catalog_version'),
    sampleDigest: varchar('sample_digest', { length: 128 }),
    promptVersion: integer('prompt_version'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorCode: varchar('error_code', { length: 80 }),
    errorMessage: text('error_message'),
    tokenUsage: integer('token_usage').notNull().default(0),
    costMicros: integer('cost_micros').notNull().default(0),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('ai_runs_org_status_idx').on(table.organizationId, table.status),
    index('ai_runs_event_time_idx').on(table.eventId, table.createdAt),
    index('ai_runs_template_time_idx').on(table.templateId, table.createdAt),
  ],
);

export const templateAiMappingActions = pgTable(
  'template_ai_mapping_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => conferenceTemplates.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    proposalId: varchar('proposal_id', { length: 120 }).notNull(),
    action: varchar('action', { length: 32 }).notNull(),
    actorId: uuid('actor_id').references(() => users.id),
    beforeBindingDigest: varchar('before_binding_digest', { length: 128 }).notNull(),
    afterBindingDigest: varchar('after_binding_digest', { length: 128 }),
    resultRevision: integer('result_revision'),
    bindingSnapshot: jsonb('binding_snapshot').$type<HtmlTemplateBindingManifest>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('template_ai_mapping_actions_run_proposal_action_unique').on(
      table.runId,
      table.proposalId,
      table.action,
    ),
    index('template_ai_mapping_actions_template_time_idx').on(table.templateId, table.createdAt),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    eventId: integer('event_id'),
    eventType: varchar('event_type', { length: 120 }).notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    correlationId: varchar('correlation_id', { length: 120 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    dispatchLeaseToken: uuid('dispatch_lease_token'),
    dispatchLeaseExpiresAt: timestamp('dispatch_lease_expires_at', { withTimezone: true }),
  },
  (table) => [
    index('outbox_unpublished_idx').on(table.publishedAt, table.occurredAt),
    index('outbox_type_published_time_idx').on(
      table.eventType,
      table.publishedAt,
      table.occurredAt,
    ),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    eventId: integer('event_id'),
    actorId: uuid('actor_id'),
    actorType: varchar('actor_type', { length: 24 }).notNull().default('staff'),
    action: varchar('action', { length: 120 }).notNull(),
    resourceType: varchar('resource_type', { length: 80 }).notNull(),
    resourceId: varchar('resource_id', { length: 120 }).notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    traceId: varchar('trace_id', { length: 120 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_scope_time_idx').on(table.organizationId, table.eventId, table.createdAt),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: varchar('scope', { length: 120 }).notNull(),
    key: varchar('key', { length: 160 }).notNull(),
    requestHash: varchar('request_hash', { length: 128 }).notNull(),
    responseCode: integer('response_code').notNull(),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>().notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idempotency_scope_key_unique').on(table.scope, table.key),
    index('idempotency_keys_expiry_idx').on(table.expiresAt),
  ],
);

export const agentConnections = pgTable(
  'agent_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    delegatedUserId: uuid('delegated_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'restrict' }),
    authorizedBy: uuid('authorized_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 120 }).notNull(),
    clientId: varchar('client_id', { length: 120 }).notNull(),
    dpopThumbprint: varchar('dpop_thumbprint', { length: 160 }).notNull(),
    scopes: jsonb('scopes').$type<AgentScope[]>().notNull().default([]),
    approvalPolicy: varchar('approval_policy', { length: 40 })
      .$type<AgentApprovalPolicy>()
      .notNull()
      .default('controlled-and-critical'),
    status: varchar('status', { length: 24 })
      .$type<'active' | 'revoked' | 'expired'>()
      .notNull()
      .default('active'),
    delegatedCredentialVersion: varchar('delegated_credential_version', { length: 160 }).notNull(),
    delegatedMembershipVersion: varchar('delegated_membership_version', { length: 80 }).notNull(),
    catalogVersion: varchar('catalog_version', { length: 32 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'restrict' }),
    revocationReason: text('revocation_reason'),
    ...timestamps,
  },
  (table) => [
    check(
      'agent_connections_approval_policy_check',
      sql`${table.approvalPolicy} in ('controlled-and-critical', 'critical-only')`,
    ),
    check(
      'agent_connections_status_check',
      sql`${table.status} in ('active', 'revoked', 'expired')`,
    ),
    index('agent_connections_org_status_idx').on(
      table.organizationId,
      table.status,
      table.expiresAt,
    ),
    index('agent_connections_membership_idx').on(table.membershipId, table.status),
    index('agent_connections_last_used_idx').on(table.lastUsedAt),
    uniqueIndex('agent_connections_id_org_user_unique').on(
      table.id,
      table.organizationId,
      table.delegatedUserId,
    ),
    foreignKey({
      columns: [table.membershipId, table.organizationId, table.delegatedUserId],
      foreignColumns: [memberships.id, memberships.organizationId, memberships.userId],
      name: 'agent_connections_membership_scope_fk',
    }).onDelete('restrict'),
  ],
);

export const agentDeviceAuthorizations = pgTable(
  'agent_device_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceCodeHash: varchar('device_code_hash', { length: 64 }).notNull(),
    userCodeHmac: varchar('user_code_hmac', { length: 64 }).notNull(),
    clientId: varchar('client_id', { length: 120 }).notNull(),
    clientName: varchar('client_name', { length: 120 }).notNull(),
    skillVersion: varchar('skill_version', { length: 40 }).notNull(),
    resource: varchar('resource', { length: 500 }).notNull(),
    requestedScopes: jsonb('requested_scopes').$type<AgentScope[]>().notNull().default([]),
    approvedScopes: jsonb('approved_scopes').$type<AgentScope[]>(),
    approvalPolicy: varchar('approval_policy', { length: 40 }).$type<AgentApprovalPolicy>(),
    dpopThumbprint: varchar('dpop_thumbprint', { length: 160 }).notNull(),
    status: varchar('status', { length: 24 })
      .$type<'pending' | 'approved' | 'denied' | 'consumed' | 'expired'>()
      .notNull()
      .default('pending'),
    pollingIntervalSeconds: integer('polling_interval_seconds').notNull().default(5),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'restrict' }),
    membershipId: uuid('membership_id').references(() => memberships.id, { onDelete: 'restrict' }),
    stepUpJti: varchar('step_up_jti', { length: 160 }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    deniedAt: timestamp('denied_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('agent_device_authorizations_device_code_unique').on(table.deviceCodeHash),
    uniqueIndex('agent_device_authorizations_user_code_unique').on(table.userCodeHmac),
    check(
      'agent_device_authorizations_status_check',
      sql`${table.status} in ('pending', 'approved', 'denied', 'consumed', 'expired')`,
    ),
    check(
      'agent_device_authorizations_interval_check',
      sql`${table.pollingIntervalSeconds} between 5 and 60`,
    ),
    index('agent_device_authorizations_status_expiry_idx').on(table.status, table.expiresAt),
    foreignKey({
      columns: [table.membershipId, table.organizationId, table.approvedBy],
      foreignColumns: [memberships.id, memberships.organizationId, memberships.userId],
      name: 'agent_device_authorizations_membership_scope_fk',
    }).onDelete('restrict'),
  ],
);

export const agentRefreshTokens = pgTable(
  'agent_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => agentConnections.id, { onDelete: 'restrict' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    familyId: uuid('family_id').notNull(),
    sequence: integer('sequence').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id').references((): AnyPgColumn => agentRefreshTokens.id, {
      onDelete: 'restrict',
    }),
    replacementTokenCiphertext: text('replacement_token_ciphertext'),
    replayExpiresAt: timestamp('replay_expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_refresh_tokens_hash_unique').on(table.tokenHash),
    uniqueIndex('agent_refresh_tokens_family_sequence_unique').on(table.familyId, table.sequence),
    index('agent_refresh_tokens_connection_idx').on(table.connectionId, table.expiresAt),
    index('agent_refresh_tokens_family_idx').on(table.familyId, table.revokedAt),
  ],
);

export const agentOperations = pgTable(
  'agent_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => agentConnections.id, { onDelete: 'restrict' }),
    delegatedUserId: uuid('delegated_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    actionId: varchar('action_id', { length: 160 }).notNull(),
    routeName: varchar('route_name', { length: 120 }).notNull(),
    targetSummary: jsonb('target_summary').$type<Record<string, unknown>>().notNull().default({}),
    dataClass: varchar('data_class', { length: 24 }).$type<AgentDataClass>().notNull(),
    risk: varchar('risk', { length: 24 }).$type<AgentRisk>().notNull(),
    reason: text('reason').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    beforeFingerprint: varchar('before_fingerprint', { length: 64 }).notNull(),
    redactedDiff: jsonb('redacted_diff').$type<Record<string, unknown>>().notNull().default({}),
    impactSummary: jsonb('impact_summary').$type<Record<string, unknown>>().notNull().default({}),
    idempotencyKey: varchar('idempotency_key', { length: 160 }),
    executionStrategy: varchar('execution_strategy', {
      length: 40,
    }).$type<AgentIdempotencyStrategy>(),
    status: varchar('status', { length: 32 })
      .$type<AgentOperationStatus>()
      .notNull()
      .default('prepared'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'restrict' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvalExpiresAt: timestamp('approval_expires_at', { withTimezone: true }),
    executionStartedAt: timestamp('execution_started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    responseStatus: integer('response_status'),
    redactedResult: jsonb('redacted_result').$type<Record<string, unknown>>(),
    oneTimeSecretCiphertext: text('one_time_secret_ciphertext'),
    oneTimeSecretExpiresAt: timestamp('one_time_secret_expires_at', { withTimezone: true }),
    oneTimeSecretClaimedAt: timestamp('one_time_secret_claimed_at', { withTimezone: true }),
    verificationStatus: varchar('verification_status', { length: 24 })
      .$type<'pending' | 'verified' | 'unverified' | 'failed'>()
      .notNull()
      .default('pending'),
    domainAuditIds: jsonb('domain_audit_ids').$type<string[]>().notNull().default([]),
    traceId: varchar('trace_id', { length: 120 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      'agent_operations_data_class_check',
      sql`${table.dataClass} in ('public', 'internal', 'pii', 'secret')`,
    ),
    check(
      'agent_operations_risk_check',
      sql`${table.risk} in ('read', 'sensitive-read', 'routine-write', 'controlled', 'critical')`,
    ),
    check(
      'agent_operations_status_check',
      sql`${table.status} in ('prepared', 'approval_required', 'approved', 'executing', 'queued', 'succeeded', 'failed', 'unknown', 'denied', 'cancelled', 'expired')`,
    ),
    check(
      'agent_operations_verification_status_check',
      sql`${table.verificationStatus} in ('pending', 'verified', 'unverified', 'failed')`,
    ),
    uniqueIndex('agent_operations_connection_idempotency_unique').on(
      table.connectionId,
      table.idempotencyKey,
    ),
    index('agent_operations_connection_status_idx').on(
      table.connectionId,
      table.status,
      table.createdAt,
    ),
    index('agent_operations_org_action_time_idx').on(
      table.organizationId,
      table.actionId,
      table.createdAt,
    ),
    index('agent_operations_expiry_idx').on(table.expiresAt),
    foreignKey({
      columns: [table.connectionId, table.organizationId, table.delegatedUserId],
      foreignColumns: [
        agentConnections.id,
        agentConnections.organizationId,
        agentConnections.delegatedUserId,
      ],
      name: 'agent_operations_connection_scope_fk',
    }).onDelete('restrict'),
  ],
);
