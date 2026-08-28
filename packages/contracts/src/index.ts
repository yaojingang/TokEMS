import { z } from 'zod';
import {
  CURRENT_ANALYTICS_ACTIVATION_VERSION,
  DEFAULT_ANALYTICS_SETTINGS,
  MAX_ANALYTICS_SNIPPET_LENGTH,
  isAnalyticsConfigurationSafe,
} from './analytics.js';
import canonicalHomepagePublicData from './canonical-homepage.public.json' with { type: 'json' };

export * from './agent.js';
export * from './analytics.js';
export * from './feishu.js';

export const BuildInfoSchema = z.object({
  service: z.string().regex(/^[a-z0-9-]+$/u),
  sha: z.union([z.string().regex(/^[a-f0-9]{7,64}$/u), z.literal('unknown')]),
  builtAt: z.union([z.iso.datetime(), z.literal('unknown')]),
  migration: z.union([z.string().regex(/^\d{4}_[A-Za-z0-9_-]+\.sql$/u), z.literal('unknown')]),
  migrationHash: z.union([z.string().regex(/^[a-f0-9]{64}$/u), z.literal('unknown')]),
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;

export function resolveBuildInfo(
  service: string,
  environment: Record<string, string | undefined>,
): BuildInfo {
  const shaCandidate = environment.BUILD_SHA?.trim().toLowerCase() ?? '';
  const builtAtCandidate = environment.BUILD_TIME?.trim() ?? '';
  const migrationCandidate = environment.BUILD_MIGRATION?.trim() ?? '';
  const migrationHashCandidate = environment.BUILD_MIGRATION_HASH?.trim().toLowerCase() ?? '';
  const candidate = {
    service,
    sha: /^[a-f0-9]{7,64}$/u.test(shaCandidate) ? shaCandidate : 'unknown',
    builtAt: z.iso.datetime().safeParse(builtAtCandidate).success ? builtAtCandidate : 'unknown',
    migration: /^\d{4}_[A-Za-z0-9_-]+\.sql$/u.test(migrationCandidate)
      ? migrationCandidate
      : 'unknown',
    migrationHash: /^[a-f0-9]{64}$/u.test(migrationHashCandidate)
      ? migrationHashCandidate
      : 'unknown',
  };
  return BuildInfoSchema.parse(candidate);
}

export const EVENT_ID_MIN = 101;
export const EVENT_ID_MAX = 2_147_483_647;

export const EventIdSchema = z.number().int().min(EVENT_ID_MIN).max(EVENT_ID_MAX);
export const EventIdParamSchema = z
  .string()
  .regex(/^[1-9]\d{2,9}$/, '大会 ID 必须是 101–2147483647 的整数')
  .transform(Number)
  .pipe(EventIdSchema);

export const EventStatusSchema = z.enum([
  'draft',
  'configuring',
  'prepublished',
  'registration_open',
  'in_progress',
  'ended',
  'archived',
]);

export const PUBLIC_EVENT_STATUSES = [
  'prepublished',
  'registration_open',
  'in_progress',
  'ended',
] as const satisfies ReadonlyArray<z.infer<typeof EventStatusSchema>>;

const publicEventStatusSet = new Set<z.infer<typeof EventStatusSchema>>(PUBLIC_EVENT_STATUSES);

export function isPublicEventStatus(status: z.infer<typeof EventStatusSchema>) {
  return publicEventStatusSet.has(status);
}

export const RESERVED_PUBLIC_EVENT_SLUGS = [
  'account',
  'admin',
  'api',
  'apply',
  'assets',
  'faq',
  'healthz',
  'invoice',
  'order',
  'pay',
  'register',
  'ticket',
] as const;

const reservedPublicEventSlugSet = new Set<string>(RESERVED_PUBLIC_EVENT_SLUGS);

const EventSlugBaseSchema = z
  .string()
  .trim()
  .min(3)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '大会路径只能包含小写字母、数字和连字符');

export const EventSlugSchema = EventSlugBaseSchema.max(100).refine(
  (slug) => !reservedPublicEventSlugSet.has(slug),
  '该路径由系统保留，请更换大会路径',
);

export const EventShortSlugSchema = EventSlugBaseSchema.max(
  24,
  '大会短地址不能超过 24 个字符',
).refine((slug) => !reservedPublicEventSlugSet.has(slug), '该路径由系统保留，请更换大会路径');

export function publicEventHomePath(slug: string) {
  return `/${encodeURIComponent(EventSlugSchema.parse(slug))}`;
}

export function publicEventSlugFromPathSegment(segment: string) {
  try {
    const parsed = EventSlugSchema.safeParse(decodeURIComponent(segment));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function publicEventScopedPath(
  pathname: string,
  slug: string,
  parameters: Record<string, string | number | boolean | null | undefined> = {},
) {
  if (!pathname.startsWith('/') || pathname.includes('?') || pathname.includes('#')) {
    throw new Error('公开大会业务路径必须是以 / 开头且不含查询参数或片段的站内路径');
  }
  const query = new URLSearchParams({ event: EventSlugSchema.parse(slug) });
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) query.set(key, String(value));
  });
  return `${pathname}?${query.toString()}`;
}

export const RegistrationStatusSchema = z.enum([
  'draft',
  'pending_review',
  'pending_payment',
  'confirmed',
  'cancelled',
  'checked_in',
  'completed',
]);

export const OrderStatusSchema = z.enum([
  'pending_review',
  'pending_payment',
  'processing',
  'paid',
  'partially_refunded',
  'refunded',
  'closed',
]);

export const OrganizationRoleSchema = z.enum([
  'organization_admin',
  'event_owner',
  'finance',
  'content_manager',
  'operator',
  'viewer',
]);

export const MembershipStatusSchema = z.enum(['active', 'disabled']);
export const EventPaymentModeSchema = z.enum(['free', 'ticketed']);
export const CustomerAccountModeSchema = z.enum(['mobile_otp_required']);
const StoredOrganizationAccountModeSchema = z.enum(['mobile_otp_required', 'guest_allowed']);
export const CustomerStatusSchema = z.enum(['active', 'blocked', 'closed']);
export const TemplateSurfaceSchema = z.enum(['home', 'faq', 'registration_flow']);
export const TemplateFlowPresetSchema = z.enum(['standard', 'quick', 'free']);
export const InvoiceRequestStatusSchema = z.enum([
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
export const RegistrationBusinessStatusSchema = z.enum([
  'pending_review',
  'pending_payment',
  'payment_processing',
  'payment_failed',
  'paid',
  'partially_refunded',
  'refunded',
  'closed',
  'confirmed',
]);
export const RegistrationLatestPaymentStatusSchema = z.enum([
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
export const RegistrationInvoiceSummaryStatusSchema = z.enum([
  'not_eligible',
  'eligible',
  ...InvoiceRequestStatusSchema.options,
]);

export const EventRegistrationSettingsSchema = z.object({
  paymentMode: EventPaymentModeSchema.default('ticketed'),
  currency: z.literal('CNY').default('CNY'),
  registrationOpen: z.boolean().default(true),
  accountMode: CustomerAccountModeSchema.default('mobile_otp_required'),
  additionalPurchaseEnabled: z.boolean().default(false),
  maxActiveSeatsPerPurchaser: z.number().int().min(1).max(20).default(5),
});

export const EventSettingsSchema = z.object({
  locale: z.string().min(2).max(20).default('zh-CN'),
  templateKey: z.string().min(1).max(80).optional(),
  currentReleaseId: z.string().optional(),
  sourceBlueprintId: z.string().optional(),
  registration: EventRegistrationSettingsSchema.default({
    paymentMode: 'ticketed',
    currency: 'CNY',
    registrationOpen: true,
    accountMode: 'mobile_otp_required',
    additionalPurchaseEnabled: false,
    maxActiveSeatsPerPurchaser: 5,
  }),
  stats: z
    .object({
      seats: z.number().int().nonnegative(),
      speakers: z.number().int().nonnegative(),
      days: z.number().int().positive(),
      attendeeSatisfaction: z.number().min(0).max(100),
    })
    .optional(),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
});

export const WebsiteSettingsSchema = z.object({
  siteName: z.string().trim().min(1).max(160).default('大会报名中心'),
  seoTitle: z.string().trim().min(1).max(180).default('大会报名中心'),
  seoDescription: z.string().trim().max(500).default(''),
  faviconUrl: z.union([z.url(), z.literal('')]).default(''),
  footerText: z.string().trim().max(300).default(''),
  icpNumber: z.string().trim().max(80).default(''),
  supportEmail: z.union([z.email(), z.literal('')]).default(''),
});

export const AnalyticsSettingsSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_ANALYTICS_SETTINGS.enabled),
    activationVersion: z
      .literal(CURRENT_ANALYTICS_ACTIVATION_VERSION)
      .nullable()
      .default(DEFAULT_ANALYTICS_SETTINGS.activationVersion),
    provider: z.enum(['baidu', 'google', 'umami']).default(DEFAULT_ANALYTICS_SETTINGS.provider),
    trackingId: z.string().trim().max(160).default(DEFAULT_ANALYTICS_SETTINGS.trackingId),
    scriptUrl: z.union([z.url(), z.literal('')]).default(DEFAULT_ANALYTICS_SETTINGS.scriptUrl),
    siteId: z.string().trim().max(200).default(DEFAULT_ANALYTICS_SETTINGS.siteId),
  })
  .superRefine((value, context) => {
    if (!value.enabled) return;
    if (['baidu', 'google'].includes(value.provider) && !value.trackingId) {
      context.addIssue({
        code: 'custom',
        path: ['trackingId'],
        message: '启用统计后需要填写统计 ID',
      });
    }
    if (value.provider === 'umami' && !value.scriptUrl) {
      context.addIssue({
        code: 'custom',
        path: ['scriptUrl'],
        message: '启用统计后需要填写 HTTPS 脚本地址',
      });
    }
    if (value.provider === 'umami' && !value.siteId) {
      context.addIssue({
        code: 'custom',
        path: ['siteId'],
        message: '启用 Umami 后需要填写 Website ID',
      });
    }
    if (value.scriptUrl && new URL(value.scriptUrl).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['scriptUrl'],
        message: '统计脚本必须使用 HTTPS 地址',
      });
    }
    if (
      value.activationVersion === CURRENT_ANALYTICS_ACTIVATION_VERSION &&
      !isAnalyticsConfigurationSafe(value)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: '已激活的统计配置结构无效，请重新粘贴平台标准代码',
      });
    }
  });

const OptionalHttpsUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => !value || /^https:\/\//i.test(value), '链接必须使用 HTTPS 地址');

export const OrganizationSettingsSchema = z.object({
  brandName: z.string().trim().min(1).max(160),
  defaultTimezone: z.string().trim().min(1).max(80).default('Asia/Shanghai'),
  defaultCurrency: z.literal('CNY').default('CNY'),
  defaultBlueprintId: z.string().nullable().default(null),
  defaultTemplateId: z.string().nullable().default(null),
  customerAccounts: z
    .object({
      defaultAccountMode: StoredOrganizationAccountModeSchema.default('mobile_otp_required'),
      termsUrl: OptionalHttpsUrlSchema.default(''),
      termsVersion: z.string().trim().max(40).default(''),
      privacyUrl: OptionalHttpsUrlSchema.default(''),
      privacyVersion: z.string().trim().max(40).default(''),
    })
    .default({
      defaultAccountMode: 'mobile_otp_required',
      termsUrl: '',
      termsVersion: '',
      privacyUrl: '',
      privacyVersion: '',
    }),
  website: WebsiteSettingsSchema.default({
    siteName: '大会报名中心',
    seoTitle: '大会报名中心',
    seoDescription: '',
    faviconUrl: '',
    footerText: '',
    icpNumber: '',
    supportEmail: '',
  }),
  analytics: AnalyticsSettingsSchema.default(DEFAULT_ANALYTICS_SETTINGS),
});

export const TemplatePartnershipOrganizationGroupKeySchema = z.enum(['speaker', 'media', 'member']);

export const TemplatePartnershipOrganizationGroupSchema = z
  .object({
    key: TemplatePartnershipOrganizationGroupKeySchema,
    label: z.string().trim().min(1).max(80),
    meta: z.string().trim().min(1).max(80),
    organizations: z.array(z.string().trim().min(2).max(120)).max(100),
  })
  .strict();

export const TemplatePartnershipOrganizationGroupsSchema = z
  .array(TemplatePartnershipOrganizationGroupSchema)
  .max(3)
  .superRefine((groups, context) => {
    const seen = new Set<string>();
    groups.forEach((group, index) => {
      if (seen.has(group.key)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'key'],
          message: `机构分组键重复：${group.key}`,
        });
      }
      seen.add(group.key);
    });
  });

export const TemplateHomeBlockSchema = z.object({
  nodeKey: z
    .string()
    .min(3)
    .max(100)
    .regex(/^home\.[a-z0-9-]+$/),
  type: z.enum([
    'navigation',
    'hero',
    'stats',
    'value',
    'agenda',
    'speakers',
    'members',
    'attendee-needs',
    'cooperation',
    'tickets',
    'faq-summary',
    'organizer',
    'registration-cta',
    'footer',
  ]),
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  variant: z.string().trim().min(1).max(80).default('default'),
  content: z.record(z.string(), z.unknown()).default({}),
});

export const TemplateFaqItemSchema = z.object({
  nodeKey: z
    .string()
    .min(3)
    .max(100)
    .regex(/^faq\.[a-z0-9-]+$/),
  category: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(240),
  answer: z.string().trim().min(1).max(4000),
  enabled: z.boolean().default(true),
});

export const TemplateFlowStepSchema = z.object({
  nodeKey: z
    .string()
    .min(3)
    .max(100)
    .regex(/^flow\.[a-z0-9-]+$/),
  type: z.enum([
    'ticket-selection',
    'attendee-form',
    'review-payment',
    'success-ticket',
    'member-profile',
    'attendee-needs',
    'waitlist',
    'manual-review',
    'invoice-details',
  ]),
  title: z.string().trim().min(1).max(80),
  helpText: z.string().trim().max(500).default(''),
  variant: z.string().trim().min(1).max(80).default('default'),
  enabled: z.boolean().default(true),
});

export const TemplateHomeSchema = z.object({
  seo: z.object({
    title: z.string().trim().max(120).default(''),
    description: z.string().trim().max(300).default(''),
    shareAssetId: z.string().nullable().default(null),
    shareAssetUrl: z.string().max(500).nullable().optional(),
    indexable: z.boolean().default(true),
  }),
  blocks: z.array(TemplateHomeBlockSchema).min(1).max(32),
});

const DEFAULT_COOPERATION_HOME_BLOCK = TemplateHomeBlockSchema.parse({
  nodeKey: 'home.cooperation',
  type: 'cooperation',
  label: '大会合作',
  enabled: true,
  variant: 'editorial-band',
  content: {
    kicker: 'PARTNERSHIP',
    title: '让合作，成为大会内容的一部分',
    subtitle: '品牌、媒体、内容与社群伙伴，都可以在这里提出合作设想。',
    directions: '品牌赞助 · 展位展示 · 媒体合作 · 内容共创 · 社群渠道 · 团队购票',
    actionLabel: '提交合作申请',
    note: '提交后，大会团队将在 2 个工作日内与你联系。',
  },
});

const DEFAULT_ATTENDEE_NEEDS_HOME_BLOCK = TemplateHomeBlockSchema.parse({
  nodeKey: 'home.attendee-needs',
  type: 'attendee-needs',
  label: '参会需求',
  enabled: false,
  variant: 'editorial-list',
  content: {
    kicker: 'ATTENDEE QUESTIONS',
    title: '这届大会，大家最想解决什么？',
    subtitle: '这些问题来自已报名参会者，大会团队会按主题整理给相关嘉宾',
    countLabel: '已收集',
    emptyText: '参会问题正在陆续提交',
  },
});

const DEFAULT_ATTENDEE_NEEDS_FLOW_STEP = TemplateFlowStepSchema.parse({
  nodeKey: 'flow.attendee-needs',
  type: 'attendee-needs',
  title: '提交参会需求',
  helpText: '告诉大会团队你最想解决的问题，帮助嘉宾调整分享重点。',
  variant: 'focused-question',
  enabled: false,
});

export const TemplateFaqSchema = z.object({
  mode: z.enum(['home', 'page']).default('home'),
  title: z.string().trim().min(1).max(120).default('常见问题'),
  introduction: z.string().trim().max(500).default(''),
  searchEnabled: z.boolean().default(true),
  contactLabel: z.string().trim().max(80).default('联系大会组委会'),
  contactUrl: z.string().trim().max(500).default(''),
  items: z.array(TemplateFaqItemSchema).max(100).default([]),
});

export const TemplateRegistrationFlowSchema = z.object({
  preset: TemplateFlowPresetSchema,
  progressVariant: z.enum(['steps', 'compact', 'minimal']).default('steps'),
  summaryCardEnabled: z.boolean().default(true),
  branches: z.object({
    waitlist: z.boolean().default(true),
    invoiceAfterPayment: z.boolean().default(true),
    manualReview: z.boolean().default(false),
    successActions: z.boolean().default(true),
  }),
  steps: z.array(TemplateFlowStepSchema).min(2).max(9),
});

export const TemplateInitializationSchema = z.object({
  copyPolicy: z.record(z.string(), z.enum(['COPY', 'RESET', 'REFERENCE', 'EXCLUDE'])).default({}),
  ticketTypes: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  registrationFields: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-z][a-z0-9_]*$/),
        label: z.string().min(1).max(120),
        type: z.enum(['text', 'email', 'tel', 'select']),
        required: z.boolean(),
        placeholder: z.string().max(160).optional(),
        options: z.array(z.string().max(120)).optional(),
      }),
    )
    .max(60)
    .default([]),
  termsContent: z.string().max(30_000).default(''),
});

const LegacyConferenceTemplateDefinitionSchema = z
  .object({
    home: TemplateHomeSchema,
    faq: TemplateFaqSchema,
    registrationFlow: TemplateRegistrationFlowSchema,
    initialization: TemplateInitializationSchema,
  })
  .superRefine((definition, context) => {
    const keys = [
      ...definition.home.blocks.map((item) => item.nodeKey),
      ...definition.faq.items.map((item) => item.nodeKey),
      ...definition.registrationFlow.steps.map((item) => item.nodeKey),
    ];
    const seen = new Set<string>();
    keys.forEach((key) => {
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', message: `稳定节点键重复：${key}` });
      }
      seen.add(key);
    });
    const enabledSteps = definition.registrationFlow.steps.filter((item) => item.enabled);
    if (!enabledSteps.some((item) => item.type === 'attendee-form')) {
      context.addIssue({
        code: 'custom',
        path: ['registrationFlow', 'steps'],
        message: '报名流程必须包含参会资料步骤',
      });
    }
    if (!enabledSteps.some((item) => item.type === 'success-ticket')) {
      context.addIssue({
        code: 'custom',
        path: ['registrationFlow', 'steps'],
        message: '报名流程必须包含成功与电子票步骤',
      });
    }
    for (const key of ['ticketTypes', 'registrationForm'] as const) {
      if (definition.initialization.copyPolicy[key] === 'REFERENCE') {
        context.addIssue({
          code: 'custom',
          path: ['initialization', 'copyPolicy', key],
          message: `${key} 需要在大会内独立保存，不能使用引用策略`,
        });
      }
    }
    for (const key of ['registrations', 'orders', 'invoices', 'checkins'] as const) {
      const policy = definition.initialization.copyPolicy[key];
      if (policy && policy !== 'EXCLUDE') {
        context.addIssue({
          code: 'custom',
          path: ['initialization', 'copyPolicy', key],
          message: `${key} 属于大会运行数据，只能使用排除策略`,
        });
      }
    }
  });

export const HtmlTemplateVariablePathSchema = z.enum([
  'event.name',
  'event.shortName',
  'event.tagline',
  'event.description',
  'event.startsAt',
  'event.endsAt',
  'event.timezone',
  'event.venue',
  'event.city',
  'event.address',
  'event.stats.seats',
  'event.stats.speakers',
  'event.stats.days',
  'event.stats.attendeeSatisfaction',
  'tickets',
  'tickets[].name',
  'tickets[].description',
  'tickets[].price',
  'tickets[].currency',
  'tickets[].remaining',
  'tickets[].benefits',
  'tickets[].recommended',
  'speakers',
  'speakers[].name',
  'speakers[].role',
  'speakers[].topic',
  'sessions',
  'sessions[].day',
  'sessions[].startsAt',
  'sessions[].endsAt',
  'sessions[].title',
  'sessions[].summary',
  'sessions[].speaker',
  'faqs',
  'faqs[].question',
  'faqs[].answer',
  'routes.registration',
  'routes.cooperation',
  'routes.faq',
  'routes.account',
  'site.footerText',
  'site.supportEmail',
  'site.icpNumber',
]);

export const HtmlTemplateVariableFormatSchema = z.enum([
  'plain',
  'date-long',
  'date-short',
  'time',
  'datetime',
  'currency',
  'integer',
  'decimal',
]);

const HtmlTemplateMissingPolicySchema = z.enum(['error', 'empty', 'fallback', 'hide']);
const HtmlTemplateNodeIdSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^tok-[a-z0-9-]+$/);

export const HtmlTemplateTextSegmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('static'), value: z.string().max(2000) }),
  z.object({
    kind: z.literal('variable'),
    path: HtmlTemplateVariablePathSchema,
    format: HtmlTemplateVariableFormatSchema.default('plain'),
    fallback: z.string().max(500).optional(),
  }),
]);

const HtmlTemplateTextBindingSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.literal('text'),
  nodeId: HtmlTemplateNodeIdSchema,
  missingPolicy: HtmlTemplateMissingPolicySchema.default('empty'),
  segments: z.array(HtmlTemplateTextSegmentSchema).min(1).max(20),
});

const HtmlTemplateAttributeBindingSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.literal('attribute'),
  nodeId: HtmlTemplateNodeIdSchema,
  attributeName: z.literal('href'),
  variablePath: z.enum([
    'routes.registration',
    'routes.cooperation',
    'routes.faq',
    'routes.account',
  ]),
  missingPolicy: HtmlTemplateMissingPolicySchema.default('error'),
});

const HtmlTemplateConditionalBindingSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.literal('conditional'),
  nodeId: HtmlTemplateNodeIdSchema,
  variablePath: HtmlTemplateVariablePathSchema,
  truthyWhen: z.enum(['present', 'nonzero', 'true']).default('present'),
  missingPolicy: HtmlTemplateMissingPolicySchema.default('hide'),
});

const HtmlTemplateRepeatChildBindingSchema = z.object({
  nodeId: HtmlTemplateNodeIdSchema,
  kind: z.enum(['text', 'attribute']),
  attributeName: z.literal('href').optional(),
  variablePath: HtmlTemplateVariablePathSchema,
  format: HtmlTemplateVariableFormatSchema.default('plain'),
  fallback: z.string().max(500).optional(),
});

const HtmlTemplateRepeatBindingSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.literal('repeat'),
  nodeId: HtmlTemplateNodeIdSchema,
  collectionPath: z.enum(['tickets', 'speakers', 'sessions', 'faqs']),
  itemAlias: z
    .string()
    .min(1)
    .max(30)
    .regex(/^[a-z][a-z0-9_]*$/),
  children: z.array(HtmlTemplateRepeatChildBindingSchema).min(1).max(30),
  emptyPolicy: z.enum(['hide', 'keep-sample']).default('hide'),
});

export const HtmlTemplateBindingSchema = z.discriminatedUnion('kind', [
  HtmlTemplateTextBindingSchema,
  HtmlTemplateAttributeBindingSchema,
  HtmlTemplateConditionalBindingSchema,
  HtmlTemplateRepeatBindingSchema,
]);

export const HtmlTemplateBindingManifestSchema = z
  .object({
    version: z.literal(1),
    bindings: z.array(HtmlTemplateBindingSchema).max(500),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const targets = new Set<string>();
    manifest.bindings.forEach((binding, index) => {
      if (ids.has(binding.id)) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'id'],
          message: `绑定标识重复：${binding.id}`,
        });
      }
      ids.add(binding.id);
      const target = `${binding.nodeId}:${binding.kind === 'attribute' ? binding.attributeName : binding.kind}`;
      if (targets.has(target)) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'nodeId'],
          message: `绑定目标重复：${target}`,
        });
      }
      targets.add(target);
    });
  });

export const HtmlTemplateBindingProposalSchema = z.object({
  proposalId: z.string().min(1).max(120),
  nodeId: HtmlTemplateNodeIdSchema,
  operation: z.enum(['text', 'attribute', 'conditional', 'repeat']),
  binding: HtmlTemplateBindingSchema,
  originalValue: z.string().max(2000),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
  source: z.enum(['rules', 'ai']),
});

export const HtmlTemplateAiProposalOutputSchema = z.object({
  documentDigest: z.string().min(8).max(128),
  bindingDigest: z.string().min(8).max(128),
  baseRevision: z.number().int().nonnegative(),
  catalogVersion: z.number().int().positive(),
  sampleDigest: z.string().min(8).max(128),
  proposals: z.array(HtmlTemplateBindingProposalSchema).max(400),
});

export const StructuredTemplatePresentationSchema = z.object({
  kind: z.literal('structured'),
  home: TemplateHomeSchema,
});

export const HtmlTemplatePresentationSchema = z.object({
  kind: z.literal('html'),
  documentId: z.string().uuid(),
  engine: z.literal('liquid-v1'),
  catalogVersion: z.number().int().positive(),
  bindings: HtmlTemplateBindingManifestSchema,
  bindingDigest: z.string().min(8).max(128),
  sanitizedDigest: z.string().min(8).max(128),
  sourceDigest: z.string().min(8).max(128),
  compilerVersion: z.number().int().positive(),
  usedVariables: z.array(HtmlTemplateVariablePathSchema).max(200),
  requiredVariables: z.array(HtmlTemplateVariablePathSchema).max(200),
  actions: z
    .array(
      z.object({
        nodeId: HtmlTemplateNodeIdSchema,
        kind: z.enum(['registration', 'faq', 'account', 'external']),
        href: z.string().max(500),
      }),
    )
    .max(100),
  securityReportDigest: z.string().min(8).max(128),
});

const ConferenceTemplateDefinitionV2BaseSchema = z.object({
  presentation: z.discriminatedUnion('kind', [
    StructuredTemplatePresentationSchema,
    HtmlTemplatePresentationSchema,
  ]),
  faq: TemplateFaqSchema,
  registrationFlow: TemplateRegistrationFlowSchema,
  initialization: TemplateInitializationSchema,
});

export const ConferenceTemplateDefinitionSchema =
  ConferenceTemplateDefinitionV2BaseSchema.superRefine((definition, context) => {
    const structuredBlocks =
      definition.presentation.kind === 'structured' ? definition.presentation.home.blocks : [];
    if (
      structuredBlocks.length > 30 &&
      !['home.cooperation', 'home.attendee-needs'].every((nodeKey) =>
        structuredBlocks.some((block) => block.nodeKey === nodeKey),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['presentation', 'home', 'blocks'],
        message: '旧上限之外的首页区块名额保留给兼容节点',
      });
    }
    if (
      definition.registrationFlow.steps.length > 8 &&
      !definition.registrationFlow.steps.some((item) => item.nodeKey === 'flow.attendee-needs')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['registrationFlow', 'steps'],
        message: '第九个流程节点保留给参会需求兼容节点',
      });
    }
    const homeKeys =
      definition.presentation.kind === 'structured'
        ? definition.presentation.home.blocks.map((item) => item.nodeKey)
        : [];
    const keys = [
      ...homeKeys,
      ...definition.faq.items.map((item) => item.nodeKey),
      ...definition.registrationFlow.steps.map((item) => item.nodeKey),
    ];
    const seen = new Set<string>();
    keys.forEach((key) => {
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', message: `稳定节点键重复：${key}` });
      }
      seen.add(key);
    });
    if (definition.presentation.kind === 'structured') {
      definition.presentation.home.blocks.forEach((block, blockIndex) => {
        if (block.nodeKey !== 'home.cooperation') return;
        const organizationGroups = block.content.organizationGroups;
        if (organizationGroups === undefined) return;
        const result = TemplatePartnershipOrganizationGroupsSchema.safeParse(organizationGroups);
        if (result.success) return;
        result.error.issues.forEach((issue) => {
          context.addIssue({
            code: 'custom',
            path: [
              'presentation',
              'home',
              'blocks',
              blockIndex,
              'content',
              'organizationGroups',
              ...issue.path,
            ],
            message: issue.message,
          });
        });
      });
    }
    const enabledSteps = definition.registrationFlow.steps.filter((item) => item.enabled);
    if (!enabledSteps.some((item) => item.type === 'attendee-form')) {
      context.addIssue({
        code: 'custom',
        path: ['registrationFlow', 'steps'],
        message: '报名流程必须包含参会资料步骤',
      });
    }
    if (!enabledSteps.some((item) => item.type === 'success-ticket')) {
      context.addIssue({
        code: 'custom',
        path: ['registrationFlow', 'steps'],
        message: '报名流程必须包含成功与电子票步骤',
      });
    }
    for (const key of ['ticketTypes', 'registrationForm'] as const) {
      if (definition.initialization.copyPolicy[key] === 'REFERENCE') {
        context.addIssue({
          code: 'custom',
          path: ['initialization', 'copyPolicy', key],
          message: `${key} 需要在大会内独立保存，不能使用引用策略`,
        });
      }
    }
    for (const key of ['registrations', 'orders', 'invoices', 'checkins'] as const) {
      const policy = definition.initialization.copyPolicy[key];
      if (policy && policy !== 'EXCLUDE') {
        context.addIssue({
          code: 'custom',
          path: ['initialization', 'copyPolicy', key],
          message: `${key} 属于大会运行数据，只能使用排除策略`,
        });
      }
    }
  });

export function normalizeConferenceTemplateDefinition(
  definition: unknown,
): z.infer<typeof ConferenceTemplateDefinitionSchema> {
  const v2 = ConferenceTemplateDefinitionSchema.safeParse(definition);
  if (v2.success) {
    return withCompatibleFeatureNodes(v2.data);
  }
  const legacy = LegacyConferenceTemplateDefinitionSchema.parse(definition);
  return withCompatibleFeatureNodes(
    ConferenceTemplateDefinitionSchema.parse({
      presentation: { kind: 'structured', home: legacy.home },
      faq: legacy.faq,
      registrationFlow: legacy.registrationFlow,
      initialization: legacy.initialization,
    }),
  );
}

function withCompatibleFeatureNodes(
  definition: z.infer<typeof ConferenceTemplateDefinitionSchema>,
): z.infer<typeof ConferenceTemplateDefinitionSchema> {
  return ConferenceTemplateDefinitionSchema.parse(
    withAttendeeNeedsNodes(withCooperationHomeBlock(definition)),
  );
}

function withCooperationHomeBlock(
  definition: z.infer<typeof ConferenceTemplateDefinitionSchema>,
): z.infer<typeof ConferenceTemplateDefinitionSchema> {
  if (definition.presentation.kind !== 'structured') return definition;
  const blocks = [...definition.presentation.home.blocks];
  const existingIndex = blocks.findIndex((block) => block.nodeKey === 'home.cooperation');
  if (existingIndex >= 0 && blocks[existingIndex]?.type === 'cooperation') return definition;
  if (existingIndex >= 0) {
    blocks.splice(existingIndex, 1, DEFAULT_COOPERATION_HOME_BLOCK);
  } else {
    const ticketsIndex = blocks.findIndex((block) => block.nodeKey === 'home.tickets');
    const attendeeNeedsIndex = blocks.findIndex((block) => block.nodeKey === 'home.attendee-needs');
    const insertionIndex =
      attendeeNeedsIndex >= 0 && (ticketsIndex < 0 || attendeeNeedsIndex < ticketsIndex)
        ? attendeeNeedsIndex
        : ticketsIndex < 0
          ? blocks.length
          : ticketsIndex;
    blocks.splice(insertionIndex, 0, DEFAULT_COOPERATION_HOME_BLOCK);
  }
  return {
    ...definition,
    presentation: {
      ...definition.presentation,
      home: { ...definition.presentation.home, blocks },
    },
  };
}

function withAttendeeNeedsNodes(
  definition: z.infer<typeof ConferenceTemplateDefinitionSchema>,
): z.infer<typeof ConferenceTemplateDefinitionSchema> {
  let changed = false;
  const blocks =
    definition.presentation.kind === 'structured' ? [...definition.presentation.home.blocks] : null;
  if (blocks) {
    const existingBlockIndex = blocks.findIndex(
      (block) => block.nodeKey === DEFAULT_ATTENDEE_NEEDS_HOME_BLOCK.nodeKey,
    );
    if (existingBlockIndex >= 0 && blocks[existingBlockIndex]?.type !== 'attendee-needs') {
      blocks.splice(existingBlockIndex, 1, DEFAULT_ATTENDEE_NEEDS_HOME_BLOCK);
      changed = true;
    } else if (existingBlockIndex < 0) {
      const registrationCtaIndex = blocks.findIndex(
        (block) => block.nodeKey === 'home.registration-cta',
      );
      blocks.splice(
        registrationCtaIndex < 0 ? blocks.length : registrationCtaIndex,
        0,
        DEFAULT_ATTENDEE_NEEDS_HOME_BLOCK,
      );
      changed = true;
    }
  }

  const steps = [...definition.registrationFlow.steps];
  const existingStepIndex = steps.findIndex(
    (step) => step.nodeKey === DEFAULT_ATTENDEE_NEEDS_FLOW_STEP.nodeKey,
  );
  if (existingStepIndex >= 0 && steps[existingStepIndex]?.type !== 'attendee-needs') {
    steps.splice(existingStepIndex, 1, DEFAULT_ATTENDEE_NEEDS_FLOW_STEP);
    changed = true;
  } else if (existingStepIndex < 0) {
    const memberProfileIndex = steps.findIndex((step) => step.nodeKey === 'flow.member-profile');
    steps.splice(
      memberProfileIndex < 0 ? steps.length : memberProfileIndex + 1,
      0,
      DEFAULT_ATTENDEE_NEEDS_FLOW_STEP,
    );
    changed = true;
  }

  if (!changed) return definition;
  return ConferenceTemplateDefinitionSchema.parse({
    ...definition,
    presentation:
      definition.presentation.kind === 'structured' && blocks
        ? {
            ...definition.presentation,
            home: { ...definition.presentation.home, blocks },
          }
        : definition.presentation,
    registrationFlow: { ...definition.registrationFlow, steps },
  });
}

export const DEFAULT_CONFERENCE_TEMPLATE_DEFINITION = normalizeConferenceTemplateDefinition(
  canonicalHomepagePublicData.template.definition,
);

export const TicketTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  price: z.number().int().nonnegative(),
  currency: z.string().length(3),
  remaining: z.number().int().nonnegative(),
  benefits: z.array(z.string()),
  recommended: z.boolean().default(false),
});

const PublicHttpUrlSchema = z
  .url()
  .max(500)
  .refine(
    (value) => ['http:', 'https:'].includes(new URL(value).protocol),
    '仅支持 HTTP 或 HTTPS 地址',
  );

export const SpeakerSocialLinkSchema = z.object({
  label: z.string().trim().min(1).max(40),
  url: PublicHttpUrlSchema,
});

export const SpeakerRouteCodeSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{4}$/u, '嘉宾短地址必须是 4 位小写字母');

const SPEAKER_ROUTE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const SPEAKER_ROUTE_CAPACITY = SPEAKER_ROUTE_ALPHABET.length ** 4;
const SPEAKER_ROUTE_MULTIPLIER = 104_729;
const SPEAKER_ROUTE_OFFSET = 350_819;

export function encodeSpeakerRouteCode(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > SPEAKER_ROUTE_CAPACITY) {
    throw new RangeError('嘉宾短地址编号无效');
  }
  let encoded =
    ((value - 1) * SPEAKER_ROUTE_MULTIPLIER + SPEAKER_ROUTE_OFFSET) % SPEAKER_ROUTE_CAPACITY;
  let code = '';
  for (let index = 0; index < 4; index += 1) {
    code = SPEAKER_ROUTE_ALPHABET[encoded % SPEAKER_ROUTE_ALPHABET.length] + code;
    encoded = Math.floor(encoded / SPEAKER_ROUTE_ALPHABET.length);
  }
  return code;
}

export function publicSpeakerPath(publicCode: string) {
  return `/speakers/${SpeakerRouteCodeSchema.parse(publicCode)}`;
}

const SpeakerPublicFieldsSchema = z.object({
  id: z.uuid(),
  publicCode: SpeakerRouteCodeSchema.optional(),
  name: z.string(),
  role: z.string(),
  topic: z.string(),
  initials: z.string(),
  accentFrom: z.string(),
  accentTo: z.string(),
  tags: z.array(z.string()),
  avatarUrl: z.string().optional(),
});

export const SpeakerSchema = SpeakerPublicFieldsSchema;

export function speakerAvatarText(name: string, initials?: string | null) {
  const value = initials?.trim() || Array.from(name.trim())[0] || '嘉';
  return Array.from(value).slice(0, 2).join('');
}

const SpeakerProfileFieldSchemas = {
  publicCode: SpeakerRouteCodeSchema.optional(),
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(240),
  topic: z.string().trim().min(1).max(240),
  initials: z.string().trim().min(1).max(8).optional(),
  accentFrom: z.string().regex(/^#[0-9a-f]{6}$/i),
  accentTo: z.string().regex(/^#[0-9a-f]{6}$/i),
  tags: z.array(z.string().trim().min(1).max(60)).max(12),
  avatarAssetId: z.uuid().nullable().optional(),
  bio: z.string().trim().max(5000).nullable().optional(),
  topicAbstract: z.string().trim().max(5000).nullable().optional(),
  websiteUrl: PublicHttpUrlSchema.nullable().optional(),
  socialLinks: z.array(SpeakerSocialLinkSchema).max(6),
  sortOrder: z.number().int().min(0),
};

export const CreateSpeakerSchema = z
  .object({
    ...SpeakerProfileFieldSchemas,
    accentFrom: SpeakerProfileFieldSchemas.accentFrom.default('#2448a8'),
    accentTo: SpeakerProfileFieldSchemas.accentTo.default('#102759'),
    tags: SpeakerProfileFieldSchemas.tags.default([]),
    socialLinks: SpeakerProfileFieldSchemas.socialLinks.default([]),
    sortOrder: SpeakerProfileFieldSchemas.sortOrder.default(0),
  })
  .strict();

export const UpdateSpeakerSchema = z
  .object(SpeakerProfileFieldSchemas)
  .partial()
  .strict()
  .refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    '至少提交一个可修改字段',
  );

export const ReorderSpeakersSchema = z
  .object({ speakerIds: z.array(z.uuid()).min(1).max(500) })
  .strict()
  .refine(
    ({ speakerIds }) => new Set(speakerIds).size === speakerIds.length,
    '嘉宾排序中不能包含重复项',
  );

export const AdminSpeakerSummarySchema = SpeakerPublicFieldsSchema.extend({
  publicCode: SpeakerRouteCodeSchema,
  avatarAssetId: z.uuid().nullable(),
  bio: z.string().nullable(),
  topicAbstract: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  socialLinks: z.array(SpeakerSocialLinkSchema),
  sortOrder: z.number().int().min(0),
  avatarPreviewUrl: z.string().nullable(),
  updatedAt: z.string(),
});

export const AdminSpeakerDetailSchema = AdminSpeakerSummarySchema;

export const PublicEventSpeakerDetailSchema = SpeakerPublicFieldsSchema.extend({
  publicCode: SpeakerRouteCodeSchema,
  eventName: z.string(),
  eventSlug: z.string(),
  eventStartsAt: z.string(),
  eventEndsAt: z.string(),
  eventTimezone: z.string(),
  eventCity: z.string(),
  bio: z.string().optional(),
  topicAbstract: z.string().optional(),
  websiteUrl: PublicHttpUrlSchema.optional(),
  socialLinks: z.array(SpeakerSocialLinkSchema),
});

export const SessionSchema = z.object({
  id: z.string(),
  day: z.number().int().min(1),
  startsAt: z.string(),
  endsAt: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  speaker: z.string().optional(),
  kind: z.enum(['talk', 'break', 'workshop']),
});

export const RegistrationFieldSchema = z.object({
  key: z
    .string()
    .min(1, '字段键不能为空')
    .max(80, '字段键不能超过 80 个字符')
    .regex(/^[a-z][a-z0-9_]*$/, '字段键只能使用小写字母、数字和下划线，并以字母开头'),
  label: z.string().min(1, '需要填写显示名称').max(120, '显示名称不能超过 120 个字符'),
  type: z.enum(['text', 'email', 'tel', 'select']),
  required: z.boolean(),
  placeholder: z.string().max(160, '占位提示不能超过 160 个字符').optional(),
  options: z.array(z.string().max(120, '单个可选值不能超过 120 个字符')).optional(),
});

export const CORE_REGISTRATION_FIELDS = [
  { key: 'name', label: '姓名', type: 'text' },
  { key: 'mobile', label: '手机号码', type: 'tel' },
  { key: 'email', label: '电子邮箱', type: 'email' },
] as const;

export const RegistrationFormPublishSchema = z
  .object({
    name: z.string().trim().min(1, '请填写表单名称').max(120, '表单名称不能超过 120 个字符'),
    fields: z
      .array(RegistrationFieldSchema)
      .min(1, '报名表至少需要一个字段')
      .max(60, '报名表最多可以配置 60 个字段'),
    termsVersion: z.string().min(1, '请填写条款版本').max(32, '条款版本不能超过 32 个字符'),
    termsContent: z
      .string()
      .min(10, '条款正文至少需要 10 个字符')
      .max(30_000, '条款正文不能超过 30000 个字符'),
  })
  .superRefine((input, context) => {
    const keys = new Set<string>();
    input.fields.forEach((field, index) => {
      if (keys.has(field.key)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: '字段键必须唯一',
        });
      }
      keys.add(field.key);
      if (field.type === 'select' && !field.options?.length) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'options'],
          message: '选项字段至少需要一个可选值',
        });
      }
      if (field.options && new Set(field.options).size !== field.options.length) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'options'],
          message: '同一字段的选项必须唯一',
        });
      }
    });
    for (const coreField of CORE_REGISTRATION_FIELDS) {
      const field = input.fields.find((item) => item.key === coreField.key);
      if (!field || field.type !== coreField.type || !field.required) {
        context.addIssue({
          code: 'custom',
          path: ['fields'],
          message: `${coreField.label}是系统核心字段，需保留键名 ${coreField.key}、${coreField.type} 类型并设为必填`,
        });
      }
    }
  });

export const RegistrationFormSchema = z.object({
  id: z.string(),
  eventId: EventIdSchema,
  name: z.string(),
  version: z.number().int().positive(),
  status: z.enum(['draft', 'published', 'archived']),
  fields: z.array(RegistrationFieldSchema),
  termsVersion: z.string(),
  termsContent: z.string(),
  publishedAt: z.string().nullable(),
});

export const PublicEventMetricsSchema = z.object({
  pageViews: z.number().int().nonnegative().safe(),
  trackingStartedAt: z.iso.datetime().nullable(),
  confirmedAttendees: z.number().int().nonnegative().safe(),
  organizationCount: z.number().int().nonnegative().safe(),
  cityCount: z.number().int().nonnegative().safe(),
});

export const RecordPublicEventViewSchema = z
  .object({
    pageViewId: z.uuid(),
  })
  .strict();

export const PublicEventViewResultSchema = PublicEventMetricsSchema.pick({
  pageViews: true,
  trackingStartedAt: true,
}).extend({
  updatedAt: z.iso.datetime().nullable(),
});

export const RegistrationAnswersSchema = z
  .record(z.string().min(1).max(80), z.string().trim().max(2000))
  .refine((answers) => Object.keys(answers).length <= 60, '表单回答字段不能超过 60 个');

export const PublicEventSchema = z.object({
  id: EventIdSchema,
  organizationId: z.string(),
  slug: z.string(),
  name: z.string(),
  shortName: z.string(),
  status: EventStatusSchema,
  tagline: z.string(),
  description: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  timezone: z.string(),
  venue: z.string(),
  city: z.string(),
  address: z.string(),
  registration: EventRegistrationSettingsSchema,
  stats: z.object({
    seats: z.number().int(),
    speakers: z.number().int(),
    days: z.number().int(),
    attendeeSatisfaction: z.number(),
  }),
  publicMetrics: PublicEventMetricsSchema,
  tickets: z.array(TicketTypeSchema),
  speakers: z.array(SpeakerSchema),
  sessions: z.array(SessionSchema),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })),
  registrationForm: RegistrationFormSchema.optional(),
  experience: z
    .object({
      renderer: z.object({
        key: z.string(),
        version: z.number().int().positive(),
      }),
      template: z.object({
        id: z.string(),
        versionId: z.string(),
        version: z.number().int().positive(),
      }),
      presentation: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('structured') }),
        z.object({
          kind: z.literal('html'),
          documentId: z.string().uuid(),
          sanitizedDigest: z.string(),
          bindingDigest: z.string(),
          compilerVersion: z.number().int().positive(),
        }),
      ]),
      home: TemplateHomeSchema.optional(),
      faq: TemplateFaqSchema,
      registrationFlow: TemplateRegistrationFlowSchema,
    })
    .optional(),
});

export const REGISTRATION_PREFERENCE_DEFAULTS = {
  invoiceRequired: false,
  marketingConsent: false,
  termsAccepted: false,
} as const;

export const CreateRegistrationSchema = z
  .object({
    eventId: EventIdSchema,
    ticketTypeId: z.string().min(1),
    attendee: z.object({
      name: z.string().trim().max(80).default(''),
      mobile: z.string().trim().min(7).max(24),
      email: z.union([z.email(), z.literal('')]).default(''),
      company: z.string().trim().max(120).default(''),
      title: z.string().trim().max(80).default(''),
      city: z.string().trim().max(60).default(''),
    }),
    invoiceRequired: z.boolean().default(REGISTRATION_PREFERENCE_DEFAULTS.invoiceRequired),
    marketingConsent: z.boolean().default(REGISTRATION_PREFERENCE_DEFAULTS.marketingConsent),
    termsAccepted: z.literal(true),
    purchaseFor: z.enum(['self', 'other']).default('self'),
    purchaseIntentId: z.uuid().default(() => globalThis.crypto.randomUUID()),
    proxyAuthorizationAccepted: z.boolean().default(false),
    formVersion: z.number().int().positive().default(1),
    termsVersion: z.string().min(1).max(32).default('2026-07-16'),
    formAnswers: RegistrationAnswersSchema.optional(),
    waitlistOfferToken: z.string().min(32).max(200).optional(),
  })
  .superRefine((input, context) => {
    if (input.purchaseFor === 'other' && !input.proxyAuthorizationAccepted) {
      context.addIssue({
        code: 'custom',
        path: ['proxyAuthorizationAccepted'],
        message: '代他人购票需要确认已获得参会人授权',
      });
    }
  });

export const WaitlistJoinSchema = z
  .object({
    eventId: EventIdSchema,
    ticketTypeId: z.string().min(1),
    name: z.string().trim().max(120).default(''),
    email: z.union([z.email(), z.literal('')]).default(''),
    mobile: z.string().trim().max(24).default(''),
  })
  .refine((value) => Boolean(value.email || value.mobile), {
    message: '候补需要填写邮箱或手机号',
    path: ['mobile'],
  });

export const WaitlistEntrySchema = z.object({
  id: z.string(),
  eventId: EventIdSchema,
  ticketTypeId: z.string(),
  ticketTypeName: z.string(),
  name: z.string(),
  email: z.union([z.email(), z.literal('')]),
  mobile: z.string().default(''),
  status: z.enum(['waiting', 'invited', 'claimed', 'expired', 'cancelled']),
  position: z.number().int().positive(),
  invitedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export const RegistrationSchema = z.object({
  id: z.string(),
  eventId: EventIdSchema,
  registrationCode: z.string(),
  status: RegistrationStatusSchema,
  attendee: CreateRegistrationSchema.shape.attendee,
  ticketType: TicketTypeSchema,
  formAnswers: RegistrationAnswersSchema.optional(),
  createdAt: z.string(),
});

export const OrderSchema = z.object({
  id: z.string(),
  orderNo: z.string(),
  registrationId: z.string(),
  status: OrderStatusSchema,
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  paymentMethod: z.enum(['wechat', 'alipay', 'bank', 'free']),
  paymentUrl: z.string().optional(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

export const CustomerOrderAccessSchema = OrderSchema.extend({
  isProxyPurchase: z.boolean(),
});

export const PaymentCallbackSchema = z.object({
  orderId: z.string().min(1),
  externalId: z.string().trim().min(6).max(120),
  status: z.literal('succeeded'),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  occurredAt: z.iso.datetime(),
});

export const TicketSchema = z.object({
  id: z.string(),
  code: z.string(),
  registrationId: z.string(),
  eventName: z.string(),
  attendeeName: z.string(),
  ticketTypeName: z.string(),
  qrPayload: z.string(),
  status: z.enum(['valid', 'used', 'cancelled']),
  issuedAt: z.string(),
});

export const RegistrationCheckoutSchema = z.object({
  isProxyPurchase: z.boolean(),
  registration: RegistrationSchema,
  order: OrderSchema,
  orderAccessToken: z.string().min(32).max(500).optional(),
  ticket: TicketSchema.optional(),
});

export const ReviewRegistrationSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(500).default(''),
  })
  .superRefine((value, context) => {
    if (value.decision === 'reject' && value.reason.length < 2) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: '拒绝报名时需要填写原因',
      });
    }
  });

export const CheckInRequestSchema = z.object({
  eventId: EventIdSchema,
  ticketCode: z.string().min(6),
  checkInListId: z.string().default('main-entrance'),
  deviceId: z.string().min(3),
});

export const AdminDashboardSchema = z.object({
  eventId: EventIdSchema,
  eventName: z.string(),
  updatedAt: z.string(),
  metrics: z.object({
    registrations: z.number().int(),
    paidOrders: z.number().int(),
    paidSeats: z.number().int(),
    confirmedAttendees: z.number().int(),
    purchasers: z.number().int(),
    revenue: z.number().int(),
    checkedIn: z.number().int(),
    conversionRate: z.number(),
    pendingReview: z.number().int(),
  }),
  registrationTrend: z.array(z.object({ date: z.string(), value: z.number().int() })),
  ticketBreakdown: z.array(
    z.object({ id: z.string(), name: z.string(), sold: z.number().int(), quota: z.number().int() }),
  ),
});

const AdminDashboardDateSchema = z.iso
  .date()
  .refine((value) => value >= '0001-01-01', '趋势日期必须晚于公元 1 年 1 月 1 日');

export const AdminDashboardQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(366).optional(),
    from: AdminDashboardDateSchema.optional(),
    to: AdminDashboardDateSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.days && (value.from || value.to)) {
      context.addIssue({
        code: 'custom',
        path: ['days'],
        message: '预设天数与自定义日期区间不能同时使用',
      });
      return;
    }
    if (Boolean(value.from) !== Boolean(value.to)) {
      context.addIssue({
        code: 'custom',
        path: value.from ? ['to'] : ['from'],
        message: '自定义趋势需要同时提供开始和结束日期',
      });
      return;
    }
    if (!value.from || !value.to) return;
    const from = Date.parse(`${value.from}T00:00:00.000Z`);
    const to = Date.parse(`${value.to}T00:00:00.000Z`);
    if (from > to) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: '结束日期不能早于开始日期',
      });
      return;
    }
    if ((to - from) / 86_400_000 + 1 > 366) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: '单次趋势查询最多支持 366 天',
      });
    }
  });

export const StaffUsernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少需要 3 个字符')
  .max(32, '用户名最多 32 个字符')
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, '用户名需以字母开头，只能包含字母、数字、下划线和短横线')
  .transform((value) => value.toLowerCase());

const LoginCredentialsSchema = z.object({
  username: z.string().trim().min(1).max(255),
  password: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => new TextEncoder().encode(value).length <= 72, '密码最多 72 个 UTF-8 字节'),
  organizationSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80)
    .optional(),
});

export const LoginSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (typeof input.username === 'string' || typeof input.email !== 'string') return value;
  return { ...input, username: input.email };
}, LoginCredentialsSchema);

export const LoginResultSchema = z.object({
  accessToken: z.string(),
  user: z.object({
    id: z.number().int().min(101),
    email: z.email().nullable(),
    username: StaffUsernameSchema.nullable().optional(),
    name: z.string(),
    role: OrganizationRoleSchema,
  }),
});

export const AdminPreferencesSchema = z.object({
  lastEventId: EventIdSchema.nullable(),
});

export const UpdateAdminPreferencesSchema = AdminPreferencesSchema.strict();

export const AuthMeSchema = z.object({
  user: z.object({
    id: z.number().int().min(101),
    email: z.email().nullable(),
    username: StaffUsernameSchema.nullable().optional(),
    name: z.string(),
  }),
  organization: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    settings: OrganizationSettingsSchema,
  }),
  membership: z.object({
    id: z.string(),
    role: OrganizationRoleSchema,
    grants: z.array(z.string()),
    status: MembershipStatusSchema,
    isSuperAdministrator: z.boolean().default(false),
  }),
  adminPreferences: AdminPreferencesSchema.default({ lastEventId: null }),
});

export const MainlandMobileSchema = z
  .string()
  .trim()
  .regex(/^(?:\+?86)?1[3-9]\d{9}$/, '请输入有效的中国大陆手机号');

export const COOPERATION_TYPE_OPTIONS = [
  { value: 'brand_sponsorship', label: '品牌赞助' },
  { value: 'exhibition', label: '展位 / 产品展示' },
  { value: 'media', label: '媒体合作' },
  { value: 'content', label: '嘉宾 / 内容共创' },
  { value: 'community', label: '社群 / 渠道合作' },
  { value: 'group_ticket', label: '团队购票' },
  { value: 'other', label: '其他合作' },
] as const;

export const CooperationTypeSchema = z.enum(
  COOPERATION_TYPE_OPTIONS.map((item) => item.value) as [
    (typeof COOPERATION_TYPE_OPTIONS)[number]['value'],
    ...(typeof COOPERATION_TYPE_OPTIONS)[number]['value'][],
  ],
);

export const CooperationRequestStatusSchema = z.enum(['new', 'contacted', 'converted', 'closed']);

export const CreateCooperationRequestSchema = z
  .object({
    eventId: EventIdSchema,
    cooperationTypes: z
      .array(CooperationTypeSchema)
      .min(1, '请选择至少一个合作方向')
      .max(3, '最多选择三个合作方向')
      .refine((items) => new Set(items).size === items.length, '合作方向不能重复'),
    companyName: z.string().trim().min(2, '请填写公司或机构名称').max(160),
    contactName: z.string().trim().min(2, '请填写联系人姓名').max(80),
    contactTitle: z.string().trim().max(80).default(''),
    mobile: z.union([MainlandMobileSchema, z.literal('')]).default(''),
    email: z.union([z.email().max(255), z.literal('')]).default(''),
    wechatId: z.string().trim().max(80).default(''),
    message: z.string().trim().min(10, '请至少填写 10 个字的合作想法').max(1000),
    consentAccepted: z.literal(true),
  })
  .strict()
  .refine((input) => Boolean(input.mobile || input.email || input.wechatId), {
    message: '手机、邮箱或微信号至少填写一项',
    path: ['mobile'],
  });

export const PublicCooperationRequestResultSchema = z.object({
  requestNo: z.string(),
  eventName: z.string(),
  submittedAt: z.string(),
});

export const AdminCooperationRequestSchema = z.object({
  id: z.uuid(),
  eventId: EventIdSchema,
  requestNo: z.string(),
  cooperationTypes: z.array(CooperationTypeSchema).min(1).max(3),
  companyName: z.string(),
  contactName: z.string(),
  contactTitle: z.string(),
  mobile: z.string(),
  email: z.string(),
  wechatId: z.string(),
  message: z.string(),
  status: CooperationRequestStatusSchema,
  internalNote: z.string(),
  firstContactedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const AdminCooperationRequestListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: CooperationRequestStatusSchema.optional(),
  type: CooperationTypeSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const AdminCooperationRequestListSchema = z.object({
  items: z.array(AdminCooperationRequestSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  counts: z.object({
    all: z.number().int().nonnegative(),
    new: z.number().int().nonnegative(),
    contacted: z.number().int().nonnegative(),
    converted: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
  }),
});

export const UpdateCooperationRequestSchema = z
  .object({
    status: CooperationRequestStatusSchema.optional(),
    internalNote: z.string().trim().max(2000).optional(),
    expectedUpdatedAt: z.iso.datetime(),
  })
  .strict()
  .refine((input) => input.status !== undefined || input.internalNote !== undefined, {
    message: '至少提交一个可修改字段',
  });

export const ATTENDEE_INDUSTRY_OPTIONS = [
  { code: 'ai', label: 'AI / 大模型 / Agent' },
  { code: 'brand-marketing-geo', label: '品牌 / 市场 / GEO' },
  { code: 'internet-software-it', label: '互联网 / 软件 / IT' },
  { code: 'ecommerce-retail-consumer', label: '电商 / 零售 / 消费品牌' },
  { code: 'enterprise-service-consulting', label: '企业服务 / 咨询' },
  { code: 'advertising-media-content', label: '广告 / 媒体 / 内容' },
  { code: 'education-training', label: '教育 / 培训' },
  { code: 'finance-investment', label: '金融 / 投资' },
  { code: 'healthcare', label: '医疗 / 健康' },
  { code: 'manufacturing-supply-chain', label: '制造 / 供应链' },
  { code: 'real-estate-construction', label: '房地产 / 建筑' },
  { code: 'government-association-public', label: '政府 / 协会 / 公共服务' },
  { code: 'other', label: '其他' },
] as const;

export const AttendeeIndustryCodeSchema = z.enum(
  ATTENDEE_INDUSTRY_OPTIONS.map((item) => item.code) as [
    (typeof ATTENDEE_INDUSTRY_OPTIONS)[number]['code'],
    ...(typeof ATTENDEE_INDUSTRY_OPTIONS)[number]['code'][],
  ],
);

export const AttendeeShowcaseVisibleFieldsSchema = z.object({
  avatar: z.boolean().default(true),
  displayName: z.boolean().default(true),
  company: z.boolean().default(true),
  title: z.boolean().default(true),
  industry: z.boolean().default(true),
  businessIntro: z.boolean().default(true),
  businessUrl: z.boolean().default(true),
  contactPhone: z.boolean().default(false),
  contactEmail: z.boolean().default(false),
  wechatId: z.boolean().default(false),
});

export const DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS = AttendeeShowcaseVisibleFieldsSchema.parse(
  {},
);

export const ATTENDEE_SHOWCASE_CONSENT_VERSION = 'attendee-showcase-2026-08-15' as const;

const NullableTrimmedText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().max(max).nullable(),
  );

function normalizeOptionalHttpUrl(value: unknown) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z\d+.-]*:/iu.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export const UpdateAttendeeShowcaseSchema = z
  .object({
    version: z.number().int().nonnegative(),
    displayName: NullableTrimmedText(120),
    company: NullableTrimmedText(160),
    title: NullableTrimmedText(100),
    industryCode: AttendeeIndustryCodeSchema.nullable(),
    businessIntro: NullableTrimmedText(2000),
    businessUrl: z.preprocess(
      normalizeOptionalHttpUrl,
      z
        .url()
        .refine((value) => /^https?:\/\//i.test(value), '网址仅支持 HTTP 或 HTTPS')
        .nullable(),
    ),
    contactPhone: NullableTrimmedText(40),
    contactEmail: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
      z.email().nullable(),
    ),
    wechatId: NullableTrimmedText(80),
    isPublic: z.boolean(),
    visibleFields: AttendeeShowcaseVisibleFieldsSchema,
    consentVersion: z.literal(ATTENDEE_SHOWCASE_CONSENT_VERSION),
  })
  .superRefine((value, context) => {
    if (!value.isPublic) return;
    if (!value.displayName) {
      context.addIssue({ code: 'custom', path: ['displayName'], message: '公开名片需要填写姓名' });
    }
    if (!value.industryCode) {
      context.addIssue({ code: 'custom', path: ['industryCode'], message: '公开名片需要选择行业' });
    }
  });

export const AttendeeShowcaseCompletionSchema = z.object({
  score: z.number().int().min(0).max(100),
  completedFields: z.number().int().nonnegative(),
  totalFields: z.number().int().positive(),
});

export const AttendeeShowcaseProfileSchema = z.object({
  id: z.string().uuid().nullable(),
  registrationId: z.string().uuid(),
  orderId: z.string().uuid(),
  ticketCode: z.string().nullable(),
  eventId: EventIdSchema,
  eventName: z.string(),
  eventSlug: z.string(),
  displayName: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  industryCode: AttendeeIndustryCodeSchema.nullable(),
  businessIntro: z.string().nullable(),
  businessUrl: z.string().nullable(),
  contactPhone: z.string().nullable(),
  contactEmail: z.string().nullable(),
  wechatId: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  avatarStatus: z.enum(['none', 'processing', 'ready', 'failed']),
  isPublic: z.boolean(),
  effectivePublic: z.boolean(),
  publicSlug: z.string().nullable(),
  publicPreviewUrl: z.string().nullable(),
  visibleFields: AttendeeShowcaseVisibleFieldsSchema,
  consentVersion: z.string().nullable(),
  consentAt: z.string().nullable(),
  adminHidden: z.boolean(),
  adminHiddenReason: z.string().nullable(),
  qualified: z.boolean(),
  qualificationReason: z.string().nullable(),
  qualifiedAt: z.string().nullable(),
  sequence: z.number().int().positive().nullable(),
  completion: AttendeeShowcaseCompletionSchema,
  invoiceAvailable: z.boolean(),
  paymentRequired: z.boolean(),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
});

export const AttendeeAvatarUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const AttendeeAvatarUploadResultSchema = z.object({
  uploadToken: z.string().uuid(),
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});

export const AttendeeAvatarConfirmSchema = z.object({
  uploadToken: z.string().uuid(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const PublicEventMemberListQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(10_000).default(1),
  industry: AttendeeIndustryCodeSchema.optional(),
});

export const PublicEventMemberItemSchema = z.object({
  publicSlug: z.string(),
  sequence: z.number().int().positive(),
  displayName: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  industryCode: AttendeeIndustryCodeSchema.optional(),
  industryLabel: z.string().optional(),
  avatarUrl: z.string().optional(),
  initials: z.string().optional(),
});

export const PublicEventMemberListSchema = z.object({
  items: z.array(PublicEventMemberItemSchema),
  total: z.number().int().nonnegative(),
  overallTotal: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.literal(40),
  totalPages: z.number().int().positive(),
  categoryMode: z.boolean(),
  industries: z.array(
    z.object({
      code: AttendeeIndustryCodeSchema,
      label: z.string(),
      count: z.number().int().positive(),
    }),
  ),
});

export const PublicEventMemberDetailSchema = PublicEventMemberItemSchema.extend({
  eventName: z.string(),
  eventSlug: z.string(),
  businessIntro: z.string().optional(),
  businessUrl: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().optional(),
  wechatId: z.string().optional(),
});

export const ModerateAttendeeShowcaseSchema = z.object({
  hidden: z.boolean(),
  reason: z.string().trim().max(500).nullable().optional(),
});

export const AdminAttendeeShowcaseSchema = AttendeeShowcaseProfileSchema.extend({
  customerUserId: z.number().int().min(101),
  moderationUpdatedAt: z.string().nullable(),
});

export const ATTENDEE_NEED_CONSENT_VERSION = 'attendee-needs-2026-08-22' as const;

export const ATTENDEE_NEED_TOPIC_OPTIONS = [
  { code: 'geo-monetization', label: 'GEO 如何赚钱' },
  { code: 'geo-domestic', label: '国内 GEO' },
  { code: 'geo-global', label: '海外 GEO' },
  { code: 'enterprise-adoption', label: '企业内部落地' },
  { code: 'geo-strategy-budget', label: 'GEO 战略与预算' },
  { code: 'geo-roi', label: 'GEO 效果评估 / ROI' },
  { code: 'ai-search-citations', label: 'AI 搜索引用机制' },
  { code: 'model-platform-rules', label: '大模型平台规则' },
  { code: 'geo-monitoring', label: 'GEO 数据监测' },
  { code: 'content-assets', label: '内容资产建设' },
  { code: 'enterprise-knowledge-base', label: '企业知识库' },
  { code: 'structured-data-implementation', label: '结构化数据 / 技术实现' },
  { code: 'brand-authority', label: '品牌心智与可信源' },
  { code: 'ai-marketing', label: 'AI 营销' },
  { code: 'agent-marketing-distribution', label: 'Agent 营销与分发' },
  { code: 'fde', label: 'FDE' },
  { code: 'customer-acquisition-growth', label: '企业获客与品牌增长' },
  { code: 'service-delivery-pricing', label: '服务商交付与定价' },
  { code: 'geo-team-talent', label: 'GEO 团队与人才' },
  { code: 'other-geo-ai', label: '其他 GEO / AI 议题' },
] as const;

export const AttendeeNeedTagCodeSchema = z.enum(
  ATTENDEE_NEED_TOPIC_OPTIONS.map((item) => item.code) as [
    (typeof ATTENDEE_NEED_TOPIC_OPTIONS)[number]['code'],
    ...(typeof ATTENDEE_NEED_TOPIC_OPTIONS)[number]['code'][],
  ],
);

const AttendeeNeedContentSchema = z
  .string()
  .trim()
  .refine((value) => Array.from(value).length >= 5, '问题正文至少需要 5 个字符')
  .refine((value) => Array.from(value).length <= 200, '问题正文最多可以填写 200 个字符');

const AttendeeNeedAttributionSchema = z
  .string()
  .trim()
  .refine((value) => Array.from(value).length >= 1, '公开署名不能为空')
  .refine((value) => Array.from(value).length <= 120, '公开署名最多可以填写 120 个字符');

export const AttendeeNeedQuestionInputSchema = z.object({
  id: z.uuid().optional(),
  content: AttendeeNeedContentSchema,
  tagCodes: z
    .array(AttendeeNeedTagCodeSchema)
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length, '同一问题不能重复选择标签'),
});

export const UpdateAttendeeNeedsSchema = z
  .object({
    version: z.number().int().nonnegative(),
    questions: z.array(AttendeeNeedQuestionInputSchema).min(1).max(3),
    isPublic: z.boolean(),
    isAnonymous: z.boolean(),
    attributionName: AttendeeNeedAttributionSchema.nullable(),
    consentVersion: z.literal(ATTENDEE_NEED_CONSENT_VERSION),
  })
  .superRefine((value, context) => {
    const normalized = value.questions.map((question) =>
      question.content.trim().toLocaleLowerCase(),
    );
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: 'custom', path: ['questions'], message: '请勿重复提交相同问题' });
    }
    const existingIds = value.questions.flatMap((question) => (question.id ? [question.id] : []));
    if (new Set(existingIds).size !== existingIds.length) {
      context.addIssue({ code: 'custom', path: ['questions'], message: '同一问题不能重复保存' });
    }
    if (value.isPublic && !value.isAnonymous && !value.attributionName) {
      context.addIssue({
        code: 'custom',
        path: ['attributionName'],
        message: '实名公开时需要确认公开署名',
      });
    }
  });

export const DeleteAttendeeNeedsSchema = z.object({
  version: z.coerce.number().int().positive(),
});

export const AttendeeNeedQuestionSchema = z.object({
  id: z.uuid().nullable(),
  position: z.number().int().min(1).max(3),
  content: z.string(),
  tagCodes: z.array(AttendeeNeedTagCodeSchema),
  adminEdited: z.boolean(),
  adminEditReason: z.string().nullable(),
  adminHidden: z.boolean(),
  adminHiddenReason: z.string().nullable(),
  deletedByAdmin: z.boolean(),
  firstPublishedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const AttendeeNeedsProfileSchema = z.object({
  id: z.uuid().nullable(),
  featureEnabled: z.boolean(),
  canCreate: z.boolean(),
  canPublish: z.boolean(),
  registrationId: z.uuid(),
  orderId: z.uuid(),
  ticketCode: z.string().nullable(),
  eventId: EventIdSchema,
  eventName: z.string(),
  eventSlug: z.string(),
  questions: z.array(AttendeeNeedQuestionSchema).max(3),
  adminRemovedCount: z.number().int().nonnegative(),
  isPublic: z.boolean(),
  effectivePublic: z.boolean(),
  isAnonymous: z.boolean(),
  adminForcedAnonymous: z.boolean().default(false),
  adminForcedAnonymousReason: z.string().nullable().default(null),
  attributionName: z.string().nullable(),
  consentVersion: z.string().nullable(),
  consentAt: z.string().nullable(),
  qualified: z.boolean(),
  qualificationReason: z.string().nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
});

export const PublicAttendeeNeedListQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(10_000).default(1),
  snapshotAt: z.iso.datetime().optional(),
});

const PublicAttendeeNeedItemBaseSchema = z.object({
  questionId: z.uuid(),
  content: z.string(),
  tags: z.array(
    z.object({
      code: AttendeeNeedTagCodeSchema,
      label: z.string(),
    }),
  ),
  attribution: z.string().optional(),
  firstPublishedAt: z.string(),
});

type PublicAttendeeNeedItemOutput = Omit<
  z.infer<typeof PublicAttendeeNeedItemBaseSchema>,
  'attribution'
> & { attribution?: string };

export const PublicAttendeeNeedItemSchema = PublicAttendeeNeedItemBaseSchema.transform(
  ({ attribution, ...item }): PublicAttendeeNeedItemOutput =>
    attribution ? { ...item, attribution } : item,
);

export const PublicAttendeeNeedListSchema = z.object({
  items: z.array(PublicAttendeeNeedItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.literal(10),
  totalPages: z.number().int().positive(),
  snapshotAt: z.iso.datetime(),
});

export const AdminAttendeeNeedListQuerySchema = z.object({
  questionId: z.uuid().optional(),
  query: z.string().trim().max(200).optional(),
  tag: AttendeeNeedTagCodeSchema.optional(),
  visibility: z.enum(['public', 'private', 'anonymous', 'named', 'ineligible']).optional(),
  moderationStatus: z.enum(['visible', 'hidden', 'deleted']).optional(),
  submittedFrom: z.iso.datetime().optional(),
  submittedTo: z.iso.datetime().optional(),
  page: z.coerce.number().int().positive().max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(20),
});

export const AdminAttendeeNeedItemSchema = z.object({
  id: z.uuid(),
  submissionId: z.uuid(),
  registrationId: z.uuid(),
  registrationCode: z.string(),
  attendeeName: z.string(),
  registrationStatus: z.string(),
  orderStatus: z.string(),
  ticketStatus: z.string().nullable(),
  customerUserId: z.uuid(),
  content: z.string(),
  tagCodes: z.array(AttendeeNeedTagCodeSchema),
  isPublic: z.boolean(),
  isAnonymous: z.boolean(),
  adminForcedAnonymous: z.boolean().default(false),
  adminForcedAnonymousReason: z.string().nullable().default(null),
  attributionName: z.string().nullable(),
  effectivePublic: z.boolean(),
  qualificationReason: z.string().nullable(),
  adminEdited: z.boolean(),
  adminEditReason: z.string().nullable(),
  adminHidden: z.boolean(),
  adminHiddenReason: z.string().nullable(),
  deleted: z.boolean(),
  deletedByType: z.enum(['customer', 'admin']).nullable(),
  deletedReason: z.string().nullable(),
  version: z.number().int().positive(),
  firstPublishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const AdminAttendeeNeedListSchema = z.object({
  items: z.array(AdminAttendeeNeedItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalPages: z.number().int().positive(),
  counts: z.object({
    submitters: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    public: z.number().int().nonnegative(),
    anonymous: z.number().int().nonnegative(),
    hidden: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }),
});

export const UpdateAdminAttendeeNeedQuestionSchema = z
  .object({
    version: z.number().int().positive(),
    content: AttendeeNeedContentSchema,
    tagCodes: z
      .array(AttendeeNeedTagCodeSchema)
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length, '同一问题不能重复选择标签'),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const ModerateAttendeeNeedQuestionSchema = z
  .object({
    version: z.number().int().positive(),
    action: z.enum(['hide', 'restore', 'delete', 'restore-delete', 'anonymize']),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (['hide', 'delete', 'anonymize'].includes(value.action) && !value.reason?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: '执行治理操作时需要填写原因',
      });
    }
  });

export const AdminAttendeeNeedExportQuerySchema = AdminAttendeeNeedListQuerySchema.omit({
  page: true,
  pageSize: true,
}).extend({
  variant: z.enum(['internal', 'speaker']).default('speaker'),
  forceAnonymous: z
    .preprocess(
      (value) => (value === 'true' ? true : value === 'false' ? false : value),
      z.boolean(),
    )
    .default(true),
});

export const CustomerProfileSchema = z.object({
  nickname: z.string().nullable(),
  realName: z.string().nullable(),
  email: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  city: z.string().nullable(),
  version: z.number().int().positive(),
});

export const CustomerIdentitySchema = z.object({
  id: z.number().int().min(101),
  organizationId: z.string(),
  mobile: z.string(),
  maskedMobile: z.string(),
  status: CustomerStatusSchema,
  verifiedAt: z.string(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  profile: CustomerProfileSchema,
});

export const AdminRegistrationCustomerSchema = z.object({
  id: z.number().int().min(101),
  mobile: z.string(),
  status: CustomerStatusSchema,
  verifiedAt: z.string(),
  lastLoginAt: z.string().nullable(),
  lastRegistrationAt: z.string().nullable(),
  createdAt: z.string(),
  internalNote: z.string(),
  tags: z.array(z.string()),
  profile: CustomerProfileSchema.omit({ version: true }),
});

export const AdminRegistrationRowSchema = RegistrationSchema.extend({
  order: OrderSchema.optional(),
  purchaserName: z.string(),
  purchaserMobile: z.string(),
  isProxyPurchase: z.boolean(),
  formVersion: z.number().int().positive().optional(),
  termsVersion: z.string().optional(),
  businessStatus: RegistrationBusinessStatusSchema,
  latestPaymentStatus: RegistrationLatestPaymentStatusSchema.nullable(),
  paidAmount: z.number().int().nonnegative(),
  refundedAmount: z.number().int().nonnegative(),
  invoiceSummary: z.object({
    status: RegistrationInvoiceSummaryStatusSchema,
    requestNo: z.string().nullable(),
  }),
  lastBusinessAt: z.string(),
});

const AdminRegistrationDetailBaseSchema = AdminRegistrationRowSchema.omit({
  businessStatus: true,
  latestPaymentStatus: true,
  paidAmount: true,
  refundedAmount: true,
  invoiceSummary: true,
  lastBusinessAt: true,
}).extend({
  updatedAt: z.string(),
  invoiceRequired: z.boolean(),
  marketingConsent: z.boolean(),
  consentSnapshot: z.record(z.string(), z.unknown()),
});

export const AdminRegistrationDetailSchema = z.discriminatedUnion('customerRelation', [
  AdminRegistrationDetailBaseSchema.extend({
    customerRelation: z.literal('unlinked'),
    customer: z.never().optional(),
  }),
  AdminRegistrationDetailBaseSchema.extend({
    customerRelation: z.literal('restricted'),
    customer: z.never().optional(),
  }),
  AdminRegistrationDetailBaseSchema.extend({
    customerRelation: z.literal('included'),
    customer: AdminRegistrationCustomerSchema,
  }),
]);

export const AdminRegistrationListSchema = z.object({
  items: z.array(AdminRegistrationRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
});

export const AdminRegistrationListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: RegistrationStatusSchema.optional(),
  businessStatus: RegistrationBusinessStatusSchema.optional(),
  invoiceStatus: RegistrationInvoiceSummaryStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

export const AdminOrderRowSchema = OrderSchema.extend({
  purchaserName: z.string(),
  purchaserMobile: z.string(),
  attendeeName: z.string(),
  attendeeMobile: z.string(),
  attendeeCompany: z.string(),
  ticketTypeName: z.string(),
  isProxyPurchase: z.boolean(),
  fullRefundBlockedReason: z.string().nullable(),
});

export const AdminOrderListSchema = z.object({
  items: z.array(AdminOrderRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.literal(20),
});

export const AdminOrderListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: OrderStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
});

export const RequestCustomerOtpSchema = z.object({
  mobile: MainlandMobileSchema,
});

export const RequestCustomerOtpResultSchema = z.object({
  challengeId: z.string(),
  accepted: z.literal(true),
  retryAfterSeconds: z.number().int().nonnegative(),
  expiresAt: z.string(),
  developmentCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export const VerifyCustomerOtpSchema = z.object({
  challengeId: z.string().uuid(),
  mobile: MainlandMobileSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  termsVersion: z.string().trim().max(40).default(''),
  privacyVersion: z.string().trim().max(40).default(''),
  consentAccepted: z.literal(true),
});

export const CustomerSessionSchema = z.object({
  authenticated: z.literal(true),
  customer: CustomerIdentitySchema,
  csrfToken: z.string().min(32),
  expiresAt: z.string(),
});

export const UpdateCustomerProfileSchema = z.object({
  version: z.number().int().positive(),
  nickname: z.string().trim().max(80).nullable(),
  realName: z.string().trim().max(120).nullable(),
  email: z.union([z.email(), z.literal(''), z.null()]).transform((value) => value || null),
  company: z.string().trim().max(160).nullable(),
  title: z.string().trim().max(100).nullable(),
  city: z.string().trim().max(80).nullable(),
});

export const EventPurchaseContextSchema = z.object({
  eventId: EventIdSchema,
  additionalPurchaseEnabled: z.boolean(),
  maxActiveSeatsPerPurchaser: z.number().int().min(1).max(20),
  activeSeatCount: z.number().int().nonnegative(),
  remainingSeatCount: z.number().int().nonnegative(),
  canPurchaseAdditional: z.boolean(),
  myAttendance: z
    .object({
      registrationId: z.string().uuid(),
      registrationStatus: RegistrationStatusSchema,
      ticketCode: z.string().nullable(),
      ticketStatus: z.enum(['valid', 'used', 'cancelled']).nullable(),
    })
    .nullable(),
  myPurchases: z.object({
    paidCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    activeSeatCount: z.number().int().nonnegative(),
  }),
  resumePaymentOrderId: z.string().uuid().nullable(),
  recommendedActions: z.array(
    z.enum(['resume_payment', 'view_ticket', 'buy_more', 'register_self']),
  ),
});

const CustomerRegistrationSummaryCommonSchema = z.object({
  id: z.string(),
  eventId: EventIdSchema,
  eventName: z.string(),
  eventSlug: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  registrationCode: z.string(),
  registrationStatus: RegistrationStatusSchema,
  attendeeName: z.string(),
  ticketTypeName: z.string(),
  ticketCode: z.string().nullable(),
  ticketStatus: z.enum(['valid', 'used', 'cancelled']).nullable(),
  createdAt: z.string(),
});

const CustomerManagedRegistrationSummarySchema = CustomerRegistrationSummaryCommonSchema.extend({
  canManageOrder: z.literal(true),
  orderId: z.string(),
  orderNo: z.string(),
  orderStatus: OrderStatusSchema,
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  invoiceId: z.string().nullable(),
  invoiceStatus: InvoiceRequestStatusSchema.nullable(),
});

const CustomerAttendeeRegistrationSummarySchema = CustomerRegistrationSummaryCommonSchema.extend({
  canManageOrder: z.literal(false),
  orderId: z.null(),
  orderNo: z.null(),
  orderStatus: z.null(),
  amount: z.null(),
  currency: z.null(),
  invoiceId: z.null(),
  invoiceStatus: z.null(),
});

const normalizeLegacyRegistrationOrderAccess = (value: unknown) => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'canManageOrder')
  ) {
    return { ...value, canManageOrder: true };
  }
  return value;
};

export const CustomerRegistrationSummarySchema = z.preprocess(
  normalizeLegacyRegistrationOrderAccess,
  z.discriminatedUnion('canManageOrder', [
    CustomerManagedRegistrationSummarySchema,
    CustomerAttendeeRegistrationSummarySchema,
  ]),
);

const CustomerRegistrationAttendeeSchema = z.object({
  name: z.string(),
  mobile: z.string(),
  email: z.string(),
  company: z.string(),
  title: z.string(),
  city: z.string(),
});

export const CustomerRegistrationDetailSchema = z.preprocess(
  normalizeLegacyRegistrationOrderAccess,
  z.discriminatedUnion('canManageOrder', [
    CustomerManagedRegistrationSummarySchema.extend({
      attendee: CustomerRegistrationAttendeeSchema,
    }),
    CustomerAttendeeRegistrationSummarySchema.extend({
      attendee: CustomerRegistrationAttendeeSchema,
    }),
  ]),
);

export const CustomerRegistrationListSchema = z.object({
  items: z.array(CustomerRegistrationSummarySchema),
  nextCursor: z.string().nullable(),
});

export const CustomerPurchasedOrderSchema = z.object({
  id: z.string(),
  orderNo: z.string(),
  registrationId: z.string(),
  eventId: EventIdSchema,
  eventName: z.string(),
  eventSlug: z.string(),
  attendeeName: z.string(),
  attendeeMobile: z.string(),
  isProxyPurchase: z.boolean(),
  attendeeClaimed: z.boolean(),
  canEditAttendee: z.boolean(),
  ticketTypeName: z.string(),
  status: OrderStatusSchema,
  paymentStatus: RegistrationLatestPaymentStatusSchema.nullable(),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  ticketCode: z.string().nullable(),
  ticketStatus: z.enum(['valid', 'used', 'cancelled']).nullable(),
  invoiceId: z.string().nullable(),
  invoiceStatus: InvoiceRequestStatusSchema.nullable(),
  createdAt: z.string(),
});

export const CustomerPurchasedOrderListSchema = z.object({
  items: z.array(CustomerPurchasedOrderSchema),
  nextCursor: z.string().nullable(),
});

export const AttendeeClaimInputSchema = z.object({
  registrationId: z.string().uuid(),
  claimToken: z.string().min(32).max(500),
});

export const UpdatePurchasedOrderAttendeeSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    mobile: MainlandMobileSchema.optional(),
    email: z.union([z.email(), z.literal('')]).optional(),
    company: z.string().trim().max(160).optional(),
    title: z.string().trim().max(100).optional(),
    city: z.string().trim().max(80).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少修改一个参会人字段');

export const AttendeeClaimResultSchema = z.object({
  claimed: z.literal(true),
  claimedAt: z.string(),
  registration: CustomerRegistrationSummarySchema,
});

export const ClaimCustomerRegistrationSchema = z.object({
  orderId: z.string().uuid(),
  accessToken: z.string().min(32).max(500),
});

export const CustomerAdminDisplayNameSourceSchema = z.enum([
  'profile',
  'registration',
  'nickname',
  'missing',
]);

export const CustomerAdminDisplayCompanySourceSchema = z.enum([
  'profile',
  'registration',
  'missing',
]);

export const CustomerAdminLatestRegistrationSchema = z.object({
  id: z.string(),
  eventId: EventIdSchema,
  eventName: z.string(),
  eventStartsAt: z.string(),
  ticketTypeName: z.string(),
  registrationCode: z.string(),
  registrationStatus: RegistrationStatusSchema,
  attendeeName: z.string(),
  attendeeCompany: z.string(),
  createdAt: z.string(),
});

export function resolveCustomerAdminDisplay(
  profile: {
    realName?: string | null;
    nickname?: string | null;
    company?: string | null;
  },
  latestRegistration?: {
    attendeeName: string;
    attendeeCompany: string;
  } | null,
): {
  displayName: string;
  displayNameSource: CustomerAdminDisplayNameSource;
  displayCompany: string;
  displayCompanySource: CustomerAdminDisplayCompanySource;
} {
  const profileName = profile.realName?.trim();
  const registrationName = latestRegistration?.attendeeName.trim();
  const nickname = profile.nickname?.trim();
  const profileCompany = profile.company?.trim();
  const registrationCompany = latestRegistration?.attendeeCompany.trim();
  return {
    displayName: profileName || registrationName || nickname || '未填写',
    displayNameSource: profileName
      ? 'profile'
      : registrationName
        ? 'registration'
        : nickname
          ? 'nickname'
          : 'missing',
    displayCompany: profileCompany || registrationCompany || '未填写',
    displayCompanySource: profileCompany
      ? 'profile'
      : registrationCompany
        ? 'registration'
        : 'missing',
  };
}

export const CustomerAdminSummarySchema = z.object({
  id: z.number().int().min(101),
  mobile: z.string(),
  maskedMobile: z.string(),
  status: CustomerStatusSchema,
  nickname: z.string().nullable(),
  realName: z.string().nullable(),
  email: z.string().nullable(),
  company: z.string().nullable(),
  displayName: z.string(),
  displayNameSource: CustomerAdminDisplayNameSourceSchema,
  displayCompany: z.string(),
  displayCompanySource: CustomerAdminDisplayCompanySourceSchema,
  registrationsCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  activeEventCount: z.number().int().nonnegative(),
  invoiceCount: z.number().int().nonnegative(),
  showcaseCount: z.number().int().nonnegative(),
  publicShowcaseCount: z.number().int().nonnegative(),
  latestEventName: z.string().nullable(),
  latestRegistration: CustomerAdminLatestRegistrationSchema.nullable(),
  lastRegistrationAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export const CustomerAdminListSchema = z.object({
  items: z.array(CustomerAdminSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.literal(20),
  totalPages: z.number().int().positive(),
});

export const CustomerInvoiceSummarySchema = z.object({
  id: z.string(),
  requestNo: z.string(),
  eventName: z.string(),
  title: z.string().nullable(),
  amount: z.number().int().nonnegative(),
  status: InvoiceRequestStatusSchema,
  requestedAt: z.string(),
});

export const CustomerInvoiceListSchema = z.object({
  items: z.array(CustomerInvoiceSummarySchema),
  nextCursor: z.string().nullable(),
});

export const CustomerInvoiceCenterCategorySchema = z.enum([
  'all',
  'eligible',
  'action_required',
  'processing',
  'issued',
  'history',
]);

export const CustomerInvoiceCenterActionSchema = z.enum([
  'apply',
  'edit',
  'view',
  'download',
  'resend',
]);

export const CUSTOMER_INVOICE_ACTION_REQUIRED_STATUSES = [
  'awaiting_details',
  'rejected',
] as const satisfies readonly z.infer<typeof InvoiceRequestStatusSchema>[];
export const CUSTOMER_INVOICE_PROCESSING_STATUSES = [
  'pending_review',
  'issuing',
  'issue_failed',
  'adjustment_required',
] as const satisfies readonly z.infer<typeof InvoiceRequestStatusSchema>[];
export const CUSTOMER_INVOICE_HISTORY_STATUSES = [
  'voided',
  'cancelled',
] as const satisfies readonly z.infer<typeof InvoiceRequestStatusSchema>[];
export const CUSTOMER_EDITABLE_INVOICE_STATUSES = [
  'awaiting_details',
  'pending_review',
  'rejected',
] as const satisfies readonly z.infer<typeof InvoiceRequestStatusSchema>[];

export function customerInvoiceCenterCategoryForStatus(
  status: z.infer<typeof InvoiceRequestStatusSchema> | null,
): z.infer<typeof CustomerInvoiceCenterCategorySchema> {
  if (!status) return 'eligible';
  if ((CUSTOMER_INVOICE_ACTION_REQUIRED_STATUSES as readonly string[]).includes(status)) {
    return 'action_required';
  }
  if ((CUSTOMER_INVOICE_PROCESSING_STATUSES as readonly string[]).includes(status)) {
    return 'processing';
  }
  if (status === 'issued') return 'issued';
  return 'history';
}

export function customerInvoiceCenterActionsForStatus(
  status: z.infer<typeof InvoiceRequestStatusSchema> | null,
  hasActiveDocument: boolean,
  hasEmail: boolean,
): z.infer<typeof CustomerInvoiceCenterActionSchema>[] {
  if (!status) return ['apply'];
  const actions: z.infer<typeof CustomerInvoiceCenterActionSchema>[] = ['view'];
  if ((CUSTOMER_EDITABLE_INVOICE_STATUSES as readonly string[]).includes(status)) {
    actions.unshift('edit');
  }
  if (hasActiveDocument && (status === 'issued' || status === 'adjustment_required')) {
    actions.push('download');
  }
  if (hasActiveDocument && hasEmail && status === 'issued') actions.push('resend');
  return actions;
}

export const CustomerInvoiceCenterCountsSchema = z.object({
  all: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  actionRequired: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  issued: z.number().int().nonnegative(),
  history: z.number().int().nonnegative(),
});

export const CustomerInvoiceCenterItemSchema = z
  .object({
    orderId: z.string(),
    orderNo: z.string(),
    eventId: EventIdSchema,
    eventName: z.string(),
    eventSlug: z.string(),
    startsAt: z.string(),
    orderAmount: z.number().int().nonnegative(),
    eligibleAmount: z.number().int().nonnegative(),
    invoiceAmount: z.number().int().nonnegative().nullable(),
    currency: z.string(),
    invoiceId: z.string().nullable(),
    requestNo: z.string().nullable(),
    title: z.string().nullable(),
    status: InvoiceRequestStatusSchema.nullable(),
    category: CustomerInvoiceCenterCategorySchema.exclude(['all']),
    requestedAt: z.string().nullable(),
    updatedAt: z.string(),
    availableActions: z.array(CustomerInvoiceCenterActionSchema),
  })
  .superRefine((item, context) => {
    const expectedCategory = customerInvoiceCenterCategoryForStatus(item.status);
    if (item.category !== expectedCategory) {
      context.addIssue({
        code: 'custom',
        path: ['category'],
        message: '发票分类与当前状态不一致',
      });
    }
    const uniqueActions = new Set(item.availableActions);
    if (uniqueActions.size !== item.availableActions.length) {
      context.addIssue({
        code: 'custom',
        path: ['availableActions'],
        message: '发票操作不可重复',
      });
    }
    if (
      !item.invoiceId &&
      (item.status ||
        item.requestNo ||
        item.availableActions.length !== 1 ||
        item.availableActions[0] !== 'apply')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['availableActions'],
        message: '未申请记录只能提供申请操作',
      });
    }
    if (
      item.invoiceId &&
      (!item.status ||
        !item.requestNo ||
        item.availableActions.includes('apply') ||
        !item.availableActions.includes('view'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['invoiceId'],
        message: '已申请记录需要完整的申请状态和编号',
      });
    }
    if (
      item.availableActions.includes('edit') &&
      !['awaiting_details', 'pending_review', 'rejected'].includes(item.status ?? '')
    ) {
      context.addIssue({ code: 'custom', path: ['availableActions'], message: '当前状态不可编辑' });
    }
    if (
      item.availableActions.includes('download') &&
      !['issued', 'adjustment_required'].includes(item.status ?? '')
    ) {
      context.addIssue({ code: 'custom', path: ['availableActions'], message: '当前状态不可下载' });
    }
    if (item.availableActions.includes('resend') && item.status !== 'issued') {
      context.addIssue({ code: 'custom', path: ['availableActions'], message: '当前状态不可补发' });
    }
  });

export const CustomerInvoiceCenterListSchema = z.object({
  items: z.array(CustomerInvoiceCenterItemSchema),
  counts: CustomerInvoiceCenterCountsSchema,
  nextCursor: z.string().nullable(),
});

export const CustomerInvoiceCenterListQuerySchema = z.object({
  category: CustomerInvoiceCenterCategorySchema.default('all'),
  cursor: z.string().trim().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const CustomerInvoiceOrderContextSchema = z.object({
  orderId: z.string(),
  orderNo: z.string(),
  eventId: EventIdSchema,
  eventName: z.string(),
  startsAt: z.string(),
  orderAmount: z.number().int().nonnegative(),
  eligibleAmount: z.number().int().nonnegative(),
  currency: z.string(),
  canApply: z.boolean(),
  unavailableReason: z.string().nullable(),
});

export const CustomerAdminDetailSchema = z.object({
  customer: CustomerIdentitySchema,
  internalNote: z.string(),
  tags: z.array(z.string()),
  registrations: z.array(CustomerRegistrationSummarySchema),
  registrationNextCursor: z.string().nullable(),
  invoices: z.array(CustomerInvoiceSummarySchema),
  invoiceNextCursor: z.string().nullable(),
  showcases: z.array(AdminAttendeeShowcaseSchema),
});

export const DeleteCustomerAdminResultSchema = z.object({
  deleted: z.literal(true),
  detachedRegistrations: z.number().int().nonnegative(),
  detachedWaitlistEntries: z.number().int().nonnegative(),
  detachedPurchaserOrders: z.number().int().nonnegative().optional(),
});

export const CreateCustomerAdminSchema = z.object({
  mobile: MainlandMobileSchema,
  nickname: z.string().trim().max(80).nullable().optional(),
  realName: z.string().trim().max(120).nullable().optional(),
  email: z.email().nullable().optional(),
  company: z.string().trim().max(160).nullable().optional(),
  title: z.string().trim().max(100).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
});

export const CreateCustomerAdminResultSchema = z.object({
  customerId: CustomerIdentitySchema.shape.id,
});

export const UpdateCustomerAdminSchema = z
  .object({
    profile: UpdateCustomerProfileSchema.optional(),
    status: CustomerStatusSchema.optional(),
    internalNote: z.string().trim().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: '至少提交一个用户字段',
  });

export const CustomerAdminListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: CustomerStatusSchema.optional(),
  eventId: EventIdParamSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
});

export const CustomerAdminExportQuerySchema = CustomerAdminListQuerySchema.pick({
  q: true,
  status: true,
  eventId: true,
});

export const CustomerRegistrationListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const OrganizationMemberSchema = z.object({
  id: z.string(),
  userId: z.number().int().min(101),
  email: z.email().nullable(),
  username: StaffUsernameSchema.nullable().optional(),
  name: z.string(),
  mobile: z.string().nullable(),
  role: OrganizationRoleSchema,
  grants: z.array(z.string()),
  status: MembershipStatusSchema,
  isSuperAdministrator: z.boolean().default(false),
  profile: z
    .object({
      company: z.string().nullable(),
      title: z.string().nullable(),
      city: z.string().nullable(),
      bio: z.string().nullable(),
      tags: z.array(z.string()),
    })
    .nullable(),
});

export const AccountProfileSchema = z.object({
  user: z.object({
    id: z.number().int().min(101),
    email: z.email().nullable(),
    username: StaffUsernameSchema.nullable().optional(),
    name: z.string(),
    mobile: z.string().nullable(),
  }),
  organization: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
  membership: z.object({
    id: z.string(),
    role: OrganizationRoleSchema,
    grants: z.array(z.string()),
    status: MembershipStatusSchema,
  }),
  profile: z
    .object({
      company: z.string().nullable(),
      title: z.string().nullable(),
      city: z.string().nullable(),
      bio: z.string().nullable(),
      tags: z.array(z.string()),
    })
    .nullable(),
});

const GrantSchema = z.union([z.literal('*'), z.string().trim().min(3).max(120)]);

export const UpdateOrganizationMemberSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mobile: z.string().trim().min(7).max(32).nullable(),
  role: OrganizationRoleSchema,
  grants: z.array(GrantSchema).max(100),
  profile: z.object({
    company: z.string().trim().max(160).nullable(),
    title: z.string().trim().max(100).nullable(),
    city: z.string().trim().max(80).nullable(),
    bio: z.string().trim().max(2000).nullable(),
    tags: z.array(z.string().trim().min(1).max(60)).max(30),
  }),
});

export const UpdateAccountProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mobile: z.string().trim().min(7).max(32).nullable(),
  profile: z.object({
    company: z.string().trim().max(160).nullable(),
    title: z.string().trim().max(100).nullable(),
    city: z.string().trim().max(80).nullable(),
    bio: z.string().trim().max(2000).nullable(),
    tags: z.array(z.string().trim().min(1).max(60)).max(30),
  }),
});

export const UpdateMembershipStatusSchema = z.object({
  status: MembershipStatusSchema,
});

export const CreateOrganizationInvitationSchema = z.object({
  email: z.email(),
  role: OrganizationRoleSchema,
  grants: z.array(GrantSchema).max(100),
});

const StaffPasswordSchema = z
  .string()
  .min(8, '密码至少需要 8 个字符')
  .max(200)
  .refine((value) => new TextEncoder().encode(value).length <= 72, '密码最多 72 个 UTF-8 字节');

export const CreateOrganizationAdministratorSchema = z.object({
  username: StaffUsernameSchema,
  password: StaffPasswordSchema,
});

export const UpdateOrganizationAdministratorSchema = z
  .object({
    username: StaffUsernameSchema.optional(),
    password: StaffPasswordSchema.optional(),
  })
  .refine((value) => Boolean(value.username || value.password), {
    message: '用户名或密码至少需要修改一项',
  });

export const OrganizationInvitationSchema = z.object({
  id: z.string(),
  email: z.email(),
  role: OrganizationRoleSchema,
  grants: z.array(z.string()),
  status: z.enum(['pending', 'accepted', 'expired', 'cancelled']),
  invitedBy: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const CreateOrganizationInvitationResultSchema = z.object({
  invitation: OrganizationInvitationSchema,
  acceptanceToken: z.string(),
});

export const AcceptOrganizationInvitationSchema = z.object({
  token: z.string().min(32).max(200),
  name: z.string().trim().min(1).max(120),
  password: StaffPasswordSchema,
});

export const OrganizationSettingsResultSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  settings: OrganizationSettingsSchema,
});

export const UpdateOrganizationSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    settings: OrganizationSettingsSchema.omit({ analytics: true }).partial().strict().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      (value.settings !== undefined &&
        Object.values(value.settings).some((item) => item !== undefined)),
    {
      message: '至少提交一个组织设置字段',
    },
  );

export const UpdateOrganizationAnalyticsSchema = z
  .object({
    enabled: z.boolean(),
    snippet: z.string().trim().max(MAX_ANALYTICS_SNIPPET_LENGTH),
  })
  .strict()
  .refine((value) => !value.enabled || Boolean(value.snippet), {
    path: ['snippet'],
    message: '启用统计时必须填写统计代码',
  });

const IntegrationConnectionSchema = z.object({
  configured: z.boolean(),
  status: z.enum(['configured', 'unconfigured']),
});

export const IntegrationStatusSchema = z.object({
  payment: IntegrationConnectionSchema,
  notification: IntegrationConnectionSchema,
  ai: IntegrationConnectionSchema,
  objectStorage: IntegrationConnectionSchema,
});

export const WeChatPayConfigurationSchema = z.object({
  enabled: z.boolean(),
  appId: z.string(),
  mchId: z.string(),
  merchantCertificateSerial: z.string(),
  platformPublicKeyId: z.string(),
  notifyUrl: z.url(),
  oauthRedirectUri: z.string().optional(),
  oauthEnabled: z.boolean().default(false),
  channels: z
    .object({
      native: z.boolean().default(true),
      jsapi: z.boolean().default(false),
      h5: z.boolean().default(false),
    })
    .default({ native: true, jsapi: false, h5: false }),
  status: z.enum(['unconfigured', 'configured', 'verified', 'error']),
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  secretsPresent: z.object({
    merchantPrivateKey: z.boolean(),
    apiV3Key: z.boolean(),
    platformPublicKey: z.boolean(),
    appSecret: z.boolean(),
  }),
});

export const UpdateWeChatPayConfigurationSchema = z
  .object({
    enabled: z.boolean().default(true),
    appId: z.string().trim().min(6).max(64),
    mchId: z
      .string()
      .trim()
      .regex(/^[0-9]{6,32}$/),
    merchantCertificateSerial: z.string().trim().min(8).max(128),
    merchantPrivateKey: z.string().min(100).max(10_000).optional(),
    apiV3Key: z
      .string()
      .regex(/^[\x21-\x7E]{32}$/, 'APIv3 密钥必须是 32 个 ASCII 可见字符')
      .optional(),
    platformPublicKeyId: z.string().trim().min(8).max(128),
    platformPublicKey: z.string().min(100).max(10_000).optional(),
    appSecret: z.string().trim().min(8).max(128).optional(),
    oauthEnabled: z.boolean().default(false),
    channels: z
      .object({
        native: z.boolean().default(true),
        jsapi: z.boolean().default(false),
        h5: z.boolean().default(false),
      })
      .optional(),
  })
  .strict();

export const WeChatPayConnectionTestSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['verified', 'error']),
  message: z.string(),
  verifiedAt: z.string(),
});

export const WeChatPaymentChannelSchema = z.enum(['native', 'jsapi', 'h5']);

export const WeChatNativePaymentSchema = z.object({
  orderId: z.string(),
  channel: z.literal('native'),
  attemptId: z.string(),
  outTradeNo: z.string(),
  codeUrl: z.url(),
  expiresAt: z.string(),
});

export const WeChatJsapiPaymentSchema = z.object({
  orderId: z.string(),
  channel: z.literal('jsapi'),
  attemptId: z.string(),
  outTradeNo: z.string(),
  expiresAt: z.string(),
  jsapiParams: z.object({
    appId: z.string(),
    timeStamp: z.string(),
    nonceStr: z.string(),
    package: z.string(),
    signType: z.literal('RSA'),
    paySign: z.string(),
  }),
});

export const WeChatH5PaymentSchema = z.object({
  orderId: z.string(),
  channel: z.literal('h5'),
  attemptId: z.string(),
  outTradeNo: z.string(),
  h5Url: z.url(),
  expiresAt: z.string(),
  redirectUrl: z.url(),
});

export const WeChatPaymentPrepareResultSchema = z.discriminatedUnion('channel', [
  WeChatNativePaymentSchema,
  WeChatJsapiPaymentSchema,
  WeChatH5PaymentSchema,
]);

export const WeChatOAuthStartSchema = z.object({
  authorizeUrl: z.url(),
  stateExpiresAt: z.string(),
});

export const WeChatOAuthHandoffSchema = z.object({
  handoffCode: z.string().min(16).max(128),
  expiresAt: z.string(),
});

export const WeChatOAuthSessionSchema = z.object({
  sessionToken: z.string().min(16).max(200),
  expiresAt: z.string(),
  orderId: z.string(),
});

export const AliyunSmsTemplateKeySchema = z.enum([
  'customerOtp',
  'registrationSubmitted',
  'registrationApproved',
  'registrationRejected',
  'paymentSucceeded',
  'waitlistAvailable',
  'invoiceDetailsRequested',
  'invoiceReady',
  'eventReminder',
]);

const AliyunSmsTemplateConfigurationSchema = z.object({
  enabled: z.boolean(),
  templateCode: z.string(),
  status: z.enum(['unverified', 'verified', 'error']),
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

const AliyunSmsTemplatesSchema = z.object({
  customerOtp: AliyunSmsTemplateConfigurationSchema,
  registrationSubmitted: AliyunSmsTemplateConfigurationSchema,
  registrationApproved: AliyunSmsTemplateConfigurationSchema,
  registrationRejected: AliyunSmsTemplateConfigurationSchema,
  paymentSucceeded: AliyunSmsTemplateConfigurationSchema,
  waitlistAvailable: AliyunSmsTemplateConfigurationSchema,
  invoiceDetailsRequested: AliyunSmsTemplateConfigurationSchema,
  invoiceReady: AliyunSmsTemplateConfigurationSchema,
  eventReminder: AliyunSmsTemplateConfigurationSchema,
});

export const AliyunSmsConfigurationSchema = z.object({
  enabled: z.boolean(),
  signName: z.string(),
  endpoint: z.literal('dysmsapi.aliyuncs.com'),
  status: z.enum(['unconfigured', 'configured', 'verified', 'error']),
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  secretsPresent: z.object({
    accessKeyId: z.boolean(),
    accessKeySecret: z.boolean(),
  }),
  templates: AliyunSmsTemplatesSchema,
});

const UpdateAliyunSmsTemplateConfigurationSchema = z.object({
  enabled: z.boolean(),
  templateCode: z
    .string()
    .trim()
    .max(40)
    .refine(
      (value) => value === '' || /^SMS_[0-9A-Za-z]+$/.test(value),
      '模板 CODE 格式应为 SMS_ 开头',
    ),
});

export const UpdateAliyunSmsConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    signName: z.string().trim().min(2).max(100),
    accessKeyId: z.string().trim().min(12).max(128).optional(),
    accessKeySecret: z.string().trim().min(16).max(256).optional(),
    templates: z.object({
      customerOtp: UpdateAliyunSmsTemplateConfigurationSchema,
      registrationSubmitted: UpdateAliyunSmsTemplateConfigurationSchema,
      registrationApproved: UpdateAliyunSmsTemplateConfigurationSchema,
      registrationRejected: UpdateAliyunSmsTemplateConfigurationSchema,
      paymentSucceeded: UpdateAliyunSmsTemplateConfigurationSchema,
      waitlistAvailable: UpdateAliyunSmsTemplateConfigurationSchema,
      invoiceDetailsRequested: UpdateAliyunSmsTemplateConfigurationSchema,
      invoiceReady: UpdateAliyunSmsTemplateConfigurationSchema,
      eventReminder: UpdateAliyunSmsTemplateConfigurationSchema,
    }),
  })
  .strict()
  .superRefine((input, context) => {
    for (const [key, template] of Object.entries(input.templates)) {
      if (template.enabled && !template.templateCode) {
        context.addIssue({
          code: 'custom',
          path: ['templates', key, 'templateCode'],
          message: '启用场景前需要填写模板 CODE',
        });
      }
    }
    if (input.enabled && !Object.values(input.templates).some((template) => template.enabled)) {
      context.addIssue({
        code: 'custom',
        path: ['templates'],
        message: '启用短信服务时至少需要启用一个通知场景',
      });
    }
  });

export const TestAliyunSmsConfigurationSchema = z
  .object({
    phoneNumber: z
      .string()
      .trim()
      .regex(/^(?:\+?86)?1[3-9]\d{9}$/, '请输入有效的中国大陆手机号'),
    templateKey: AliyunSmsTemplateKeySchema,
  })
  .strict();

export const AliyunSmsConnectionTestSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['verified', 'error']),
  message: z.string(),
  verifiedAt: z.string(),
  bizId: z.string(),
  maskedPhone: z.string(),
});

export const PublicSiteConfigurationSchema = z.object({
  website: WebsiteSettingsSchema,
  analytics: AnalyticsSettingsSchema,
  customerAccounts: z.object({
    termsUrl: z.string(),
    termsVersion: z.string(),
    privacyUrl: z.string(),
    privacyVersion: z.string(),
  }),
});

export const EventContextOptionSchema = z.object({
  id: EventIdSchema,
  slug: EventSlugSchema,
  name: z.string(),
  shortName: z.string(),
  status: EventStatusSchema,
  startsAt: z.string(),
  endsAt: z.string(),
  city: z.string(),
  registrationCount: z.number().int().nonnegative(),
});

export const EventSummarySchema = EventContextOptionSchema.extend({
  currentReleaseId: z.string().nullable(),
  templateKey: z.string().nullable(),
  templateName: z.string().nullable().default(null),
  templateVersion: z.number().int().positive().nullable().default(null),
  templateUpgradeAvailable: z.boolean().default(false),
  isHomepageDefault: z.boolean().default(false),
});

export const SetOrganizationHomepageEventSchema = z.object({
  eventId: EventIdSchema,
});

export const OrganizationHomepageEventSchema = z.object({
  organizationId: z.string().uuid(),
  eventId: EventIdSchema,
  slug: EventSlugSchema,
  name: z.string(),
  updatedAt: z.string(),
});

export const EventSlugAvailabilitySchema = z.object({
  slug: EventShortSlugSchema,
  available: z.boolean(),
  current: z.boolean().default(false),
});

export const UpdateEventSlugSchema = z.object({
  slug: EventShortSlugSchema,
});

export const EventSlugUpdateResultSchema = z.object({
  eventId: EventIdSchema,
  slug: EventShortSlugSchema,
  previousSlug: EventSlugSchema,
  updatedAt: z.string(),
});

const EventTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, '请输入有效的 IANA 时区');

export const CreateEventSchema = z
  .object({
    name: z.string().trim().min(2).max(180),
    shortName: z.string().trim().min(2).max(80),
    slug: EventShortSlugSchema.optional(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    timezone: EventTimezoneSchema.optional(),
    venue: z.string().trim().min(1).max(160),
    city: z.string().trim().min(1).max(80),
    address: z.string().trim().min(1).max(240),
    templateVersionId: z.string().uuid(),
    blueprintId: z.string().optional(),
  })
  .refine((event) => new Date(event.endsAt) > new Date(event.startsAt), {
    path: ['endsAt'],
    message: '结束时间必须晚于开始时间',
  });

export const UpdateEventSchema = z
  .object({
    name: z.string().trim().min(2).max(180).optional(),
    shortName: z.string().trim().min(2).max(80).optional(),
    tagline: z.string().trim().min(2).max(240).optional(),
    description: z.string().trim().min(10).max(20_000).optional(),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
    timezone: EventTimezoneSchema.optional(),
    venue: z.string().trim().min(1).max(160).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    address: z.string().trim().min(1).max(240).optional(),
    status: EventStatusSchema.optional(),
    settings: z
      .object({
        registration: EventRegistrationSettingsSchema.partial().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.entries(value).some(
        ([key, item]) =>
          item !== undefined &&
          (key !== 'settings' ||
            (value.settings?.registration !== undefined &&
              Object.values(value.settings.registration).some(
                (registrationItem) => registrationItem !== undefined,
              ))),
      ),
    '至少提交一个可修改字段',
  )
  .refine(
    (value) =>
      !value.startsAt ||
      !value.endsAt ||
      new Date(value.endsAt).getTime() > new Date(value.startsAt).getTime(),
    {
      path: ['endsAt'],
      message: '结束时间必须晚于开始时间',
    },
  );

export const EventBlueprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  status: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
  clonePolicy: z.record(z.string(), z.enum(['COPY', 'RESET', 'REFERENCE', 'EXCLUDE'])),
});

export const TemplatePackageSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  status: z.string(),
  description: z.string(),
  manifest: z.record(z.string(), z.unknown()),
});

export const ConferenceTemplateSummarySchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  status: z.enum(['draft', 'published', 'archived']),
  rootStatus: z.enum(['active', 'archived']),
  currentPublishedVersionId: z.string().nullable(),
  currentVersion: z.number().int().positive().nullable(),
  rendererName: z.string(),
  rendererKey: z.string(),
  rendererVersion: z.number().int().positive(),
  presentationKind: z.enum(['structured', 'html']),
  usageCount: z.number().int().nonnegative(),
  upgradeCount: z.number().int().nonnegative(),
  previewAssetKey: z.string().nullable(),
  updatedByName: z.string().nullable(),
  updatedAt: z.string(),
});

export const ConferenceTemplateOptionSchema = ConferenceTemplateSummarySchema.pick({
  id: true,
  name: true,
  description: true,
  tags: true,
  currentPublishedVersionId: true,
  currentVersion: true,
  presentationKind: true,
  previewAssetKey: true,
  updatedAt: true,
});

export const ConferenceTemplateDraftSchema = z.object({
  templateId: z.string(),
  rendererPackageId: z.string(),
  schemaVersion: z.number().int().positive(),
  definition: ConferenceTemplateDefinitionSchema,
  revision: z.number().int().nonnegative(),
  contentDigest: z.string(),
  updatedByName: z.string().nullable(),
  updatedAt: z.string(),
});

export const ConferenceTemplateVersionSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  version: z.number().int().positive(),
  rendererPackageId: z.string(),
  rendererKey: z.string(),
  rendererVersion: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  definition: ConferenceTemplateDefinitionSchema,
  contentDigest: z.string(),
  previewAssetKey: z.string().nullable(),
  changeSummary: z.string(),
  publishedAt: z.string(),
  createdByName: z.string().nullable(),
});

export const CreateConferenceTemplateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().min(2).max(2000),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  sourceTemplateVersionId: z.string().uuid().optional(),
  rendererPackageId: z.string().uuid().optional(),
  publishImmediately: z.boolean().default(false),
});

export const UpdateConferenceTemplateSchema = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    description: z.string().trim().min(2).max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    revision: z.number().int().nonnegative(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.description !== undefined || value.tags !== undefined,
    '至少提交一个可修改字段',
  );

export const SaveConferenceTemplateDraftSchema = z.object({
  definition: ConferenceTemplateDefinitionSchema,
  revision: z.number().int().nonnegative(),
});

export const PublishConferenceTemplateSchema = z.object({
  revision: z.number().int().nonnegative(),
  changeSummary: z.string().trim().min(2).max(1000),
});

export const EventTemplateBindingSchema = z.object({
  eventId: EventIdSchema,
  templateId: z.string(),
  templateName: z.string(),
  templateVersionId: z.string(),
  templateVersion: z.number().int().positive(),
  currentPublishedVersionId: z.string().nullable(),
  currentPublishedVersion: z.number().int().positive().nullable(),
  updatePolicy: z.literal('manual'),
  revision: z.number().int().nonnegative(),
  upgradeAvailable: z.boolean(),
  boundAt: z.string(),
  updatedAt: z.string(),
});

export const UpdateEventTemplateBindingSchema = z.object({
  templateVersionId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  conflictResolutions: z.record(z.string(), z.enum(['keep', 'discard'])).default({}),
});

export const EventExperienceSchema = z.object({
  binding: EventTemplateBindingSchema,
  renderer: z.object({
    key: z.string(),
    version: z.number().int().positive(),
  }),
  definition: ConferenceTemplateDefinitionSchema,
  overrides: z.record(
    TemplateSurfaceSchema,
    z.object({
      revision: z.number().int().nonnegative(),
      document: z.record(z.string(), z.unknown()),
    }),
  ),
  validation: z.object({
    valid: z.boolean(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })),
    warnings: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
});

export const SaveEventExperienceOverrideSchema = z.object({
  revision: z.number().int().nonnegative(),
  document: z.record(z.string(), z.unknown()),
});

export const EventReleaseSchema = z.object({
  id: z.string(),
  eventId: EventIdSchema,
  version: z.number().int().positive(),
  templateKey: z.string(),
  templateVersionId: z.string().nullable(),
  status: z.string(),
  artifactKey: z.string(),
  changeSummary: z.string(),
  changeScope: z.enum([
    'site',
    'event',
    'experience',
    'registration',
    'ticket',
    'content',
    'form',
    'lifecycle',
  ]),
  activationKind: z.enum(['initial', 'save', 'manual']),
  createdByName: z.string().nullable(),
  publishedAt: z.string(),
  rolledBackAt: z.string().nullable(),
  active: z.boolean(),
});

export const PublishEventSchema = z.object({
  templateKey: z.string().min(1).max(80).optional(),
});

export const RefundRequestSchema = z.object({
  amount: z.number().int().positive(),
  reason: z.string().trim().min(2).max(240),
});

export const RefundSchema = z.object({
  id: z.string(),
  refundNo: z.string(),
  orderId: z.string(),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  status: z.string(),
  reason: z.string(),
  createdAt: z.string(),
});

export const InvoiceBuyerSchema = z
  .object({
    buyerType: z.enum(['individual', 'company']),
    title: z.string().trim().min(2).max(200),
    taxId: z.string().trim().max(40).default(''),
    email: z.email().max(255),
    mobile: z.string().trim().min(7).max(24),
    content: z.string().trim().min(2).max(120).default('会务费'),
  })
  .superRefine((buyer, context) => {
    if (buyer.buyerType === 'company' && buyer.taxId.length < 8) {
      context.addIssue({
        code: 'custom',
        path: ['taxId'],
        message: '企业发票需要填写有效统一社会信用代码',
      });
    }
  });

export const CustomerInvoiceBuyerSchema = z
  .object({
    companyName: z.string().trim().min(2).max(200),
    taxId: z.string().trim().min(8).max(40),
    email: z.email().max(255),
  })
  .strict();

const CustomerLegacyInvoiceBuyerSchema = InvoiceBuyerSchema.strict();

export const CustomerCreateInvoiceSchema = z.union([
  CustomerInvoiceBuyerSchema,
  CustomerLegacyInvoiceBuyerSchema,
]);

export const CustomerUpdateInvoiceSchema = z.union([
  CustomerInvoiceBuyerSchema.extend({
    expectedUpdatedAt: z.iso.datetime(),
  }).strict(),
  CustomerLegacyInvoiceBuyerSchema.extend({
    expectedUpdatedAt: z.iso.datetime(),
  }).strict(),
]);

export const CustomerSubmitInvoiceSchema = z.union([
  CustomerUpdateInvoiceSchema,
  CustomerCreateInvoiceSchema,
]);

export const SubmitInvoiceDetailsSchema = InvoiceBuyerSchema.extend({
  accessToken: z.string().min(32).max(500),
});

export const InvoiceBatchManifestItemSchema = z
  .object({
    requestNo: z.string().trim().min(6).max(48),
    invoiceNumber: z.string().trim().min(1).max(80),
    invoiceCode: z.string().trim().max(80).default(''),
    uploadFile: z
      .string()
      .trim()
      .min(11)
      .max(300)
      .regex(/^files\/[A-Za-z0-9._-]+\.(?:pdf|ofd)$/i, '文件必须位于 files/ 目录'),
    mediaType: z.enum(['application/pdf', 'application/ofd']),
    size: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

export const InvoiceBatchPreflightSchema = z
  .object({ items: z.array(InvoiceBatchManifestItemSchema).min(1).max(1000) })
  .strict()
  .superRefine((value, context) => {
    const requestNos = new Set<string>();
    const uploadFiles = new Set<string>();
    const contentDigests = new Set<string>();
    value.items.forEach((item, index) => {
      if (requestNos.has(item.requestNo)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'requestNo'],
          message: '同一批次的申请单号不能重复',
        });
      }
      if (uploadFiles.has(item.uploadFile)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'uploadFile'],
          message: '同一批次的文件路径不能重复',
        });
      }
      if (contentDigests.has(item.contentDigest.toLowerCase())) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'contentDigest'],
          message: '同一批次的文件内容不能重复',
        });
      }
      const extension = item.uploadFile.toLowerCase().endsWith('.ofd') ? 'ofd' : 'pdf';
      const expectedMediaType = extension === 'ofd' ? 'application/ofd' : 'application/pdf';
      if (item.mediaType !== expectedMediaType) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'mediaType'],
          message: '文件扩展名与媒体类型不一致',
        });
      }
      requestNos.add(item.requestNo);
      uploadFiles.add(item.uploadFile);
      contentDigests.add(item.contentDigest.toLowerCase());
    });
  });

export const InvoiceBatchPreflightResultSchema = z.object({
  items: z.array(
    z.object({
      requestNo: z.string(),
      invoiceId: z.string().nullable(),
      status: z.enum(['ready', 'error']),
      message: z.string(),
    }),
  ),
  readyCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
});

export const RequestOrderAccessLinkSchema = z.object({
  orderNo: z.string().trim().min(6).max(48),
  email: z.email(),
});

export const InvoiceDocumentSchema = z.object({
  id: z.string(),
  documentType: z.enum(['original', 'adjustment', 'reissue']),
  invoiceNumber: z.string(),
  invoiceCode: z.string().nullable(),
  externalReference: z.string().nullable(),
  storageKey: z.string(),
  mediaType: z.enum(['application/pdf', 'application/ofd']),
  size: z.number().int().positive(),
  contentDigest: z.string(),
  replacesDocumentId: z.string().nullable(),
  issuedAt: z.string(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
});

export const InvoiceStateLogSchema = z.object({
  id: z.string(),
  fromStatus: InvoiceRequestStatusSchema.nullable(),
  toStatus: InvoiceRequestStatusSchema,
  reason: z.string(),
  actorName: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const InvoiceRequestSchema = z.object({
  id: z.string(),
  requestNo: z.string(),
  organizationId: z.string(),
  eventId: EventIdSchema,
  eventName: z.string(),
  orderId: z.string(),
  orderNo: z.string(),
  registrationId: z.string(),
  attendeeName: z.string(),
  buyerType: z.enum(['individual', 'company']).nullable(),
  title: z.string().nullable(),
  maskedTaxId: z.string().nullable(),
  taxId: z.string().nullable().optional(),
  maskedEmail: z.string().nullable(),
  email: z.string().nullable().optional(),
  maskedMobile: z.string().nullable(),
  mobile: z.string().nullable().optional(),
  content: z.string().nullable(),
  amount: z.number().int().nonnegative(),
  currency: z.literal('CNY'),
  netPaidAmount: z.number().int().nonnegative(),
  status: InvoiceRequestStatusSchema,
  rejectionReason: z.string().nullable(),
  deliveryStatus: z.enum(['not_sent', 'queued', 'sent', 'failed']),
  lastSentAt: z.string().nullable(),
  requestedAt: z.string(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  documents: z.array(InvoiceDocumentSchema).default([]),
  logs: z.array(InvoiceStateLogSchema).default([]),
});

export const AdminRegistrationOperationsRegistrationSchema = RegistrationSchema.extend({
  purchaserName: z.string(),
  purchaserMobile: z.string(),
  isProxyPurchase: z.boolean(),
  formVersion: z.number().int().positive().optional(),
  termsVersion: z.string().optional(),
  updatedAt: z.string(),
  invoiceRequired: z.boolean(),
  marketingConsent: z.boolean(),
  consentSnapshot: z.record(z.string(), z.unknown()),
});

export const AdminRegistrationOperationsCustomerSchema = z.discriminatedUnion('access', [
  z.object({ access: z.literal('unlinked') }).strict(),
  z.object({ access: z.literal('restricted') }).strict(),
  z
    .object({
      access: z.literal('included'),
      customer: AdminRegistrationCustomerSchema,
    })
    .strict(),
]);

export const AdminRegistrationOperationsTicketSchema = z.object({
  id: z.string(),
  code: z.string(),
  status: z.enum(['valid', 'used', 'cancelled']),
  issuedAt: z.string(),
});

export const AdminRegistrationOperationsCheckinSchema = z.object({
  id: z.string(),
  result: z.enum(['accepted', 'duplicate', 'invalid', 'forbidden', 'manual_review']),
  listName: z.string(),
  deviceName: z.string(),
  operatorName: z.string().nullable(),
  checkedInAt: z.string(),
});

export const AdminRegistrationOperationsPaymentSchema = z.object({
  id: z.string(),
  provider: z.string(),
  channel: z.enum(['native', 'jsapi', 'h5', 'free', 'mock']).nullable(),
  outTradeNo: z.string().nullable(),
  externalId: z.string().nullable(),
  status: z.enum([
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
  ]),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  preparedAt: z.string().nullable(),
  succeededAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  lastQueriedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const AdminRegistrationOperationsRefundSchema = RefundSchema.extend({
  updatedAt: z.string().optional(),
});

const AdminRegistrationOperationsCommerceIncludedSchema = z
  .object({
    access: z.literal('included'),
    order: OrderSchema.nullable(),
    successfulPayment: AdminRegistrationOperationsPaymentSchema.nullable(),
    paymentAttempts: z.array(AdminRegistrationOperationsPaymentSchema).max(10),
    refunds: z.array(AdminRegistrationOperationsRefundSchema),
    totals: z.object({
      paidAmount: z.number().int().nonnegative(),
      succeededRefundAmount: z.number().int().nonnegative(),
      processingRefundAmount: z.number().int().nonnegative(),
      refundableAmount: z.number().int().nonnegative(),
    }),
  })
  .strict();

export const AdminRegistrationOperationsCommerceSchema = z.discriminatedUnion('access', [
  z.object({ access: z.literal('restricted') }).strict(),
  AdminRegistrationOperationsCommerceIncludedSchema,
]);

export const AdminRegistrationOperationsInvoiceRequestSchema = InvoiceRequestSchema.omit({
  documents: true,
  logs: true,
}).extend({
  documents: z.array(InvoiceDocumentSchema.omit({ storageKey: true, contentDigest: true })).max(20),
  logs: z.array(InvoiceStateLogSchema).max(50),
});

export const AdminRegistrationOperationsInvoiceSchema = z.discriminatedUnion('access', [
  z.object({ access: z.literal('restricted') }).strict(),
  z
    .object({
      access: z.literal('included'),
      request: AdminRegistrationOperationsInvoiceRequestSchema.nullable(),
    })
    .strict(),
]);

export const RegistrationNoteSchema = z.object({
  id: z.string(),
  body: z.string().max(2000),
  authorName: z.string().nullable(),
  createdAt: z.string(),
});

export const UpdateAdminRegistrationAttendeeSchema = z
  .object({
    attendee: z
      .object({
        name: z.string().trim().min(1).max(80),
        mobile: z.string().trim().min(7).max(24),
        email: z.union([z.email(), z.literal('')]),
        company: z.string().trim().max(120),
        title: z.string().trim().max(80),
        city: z.string().trim().max(60),
      })
      .strict(),
    reason: z.string().trim().min(2).max(500),
  })
  .strict();

export const CreateRegistrationNoteSchema = z
  .object({ body: z.string().trim().min(1).max(2000) })
  .strict();

export const AdminRegistrationCapabilitySchema = z.object({
  allowed: z.boolean(),
  reasonCode: z.string().optional(),
});

export const AdminRegistrationOperationsDetailSchema = z.object({
  snapshotAt: z.string(),
  traceId: z.string(),
  registration: AdminRegistrationOperationsRegistrationSchema,
  customer: AdminRegistrationOperationsCustomerSchema,
  fulfillment: z.object({
    ticket: AdminRegistrationOperationsTicketSchema.nullable(),
    checkins: z.array(AdminRegistrationOperationsCheckinSchema),
  }),
  commerce: AdminRegistrationOperationsCommerceSchema,
  invoice: AdminRegistrationOperationsInvoiceSchema,
  notes: z.array(RegistrationNoteSchema),
  capabilities: z.record(z.string(), AdminRegistrationCapabilitySchema),
});

export const CustomerInvoiceDetailSchema = InvoiceRequestSchema.omit({
  organizationId: true,
  logs: true,
}).extend({
  documents: z
    .array(
      InvoiceDocumentSchema.omit({ storageKey: true }).extend({
        downloadUrl: z.string().nullable(),
      }),
    )
    .default([]),
  timeline: z
    .array(
      z.object({
        id: z.string(),
        status: InvoiceRequestStatusSchema,
        label: z.string(),
        description: z.string(),
        tone: z.enum(['neutral', 'info', 'warning', 'success']),
        occurredAt: z.string(),
      }),
    )
    .default([]),
});

export function isCustomerInvoiceEditableStatus(
  status: InvoiceRequestStatus,
): status is (typeof CUSTOMER_EDITABLE_INVOICE_STATUSES)[number] {
  return CUSTOMER_EDITABLE_INVOICE_STATUSES.includes(
    status as (typeof CUSTOMER_EDITABLE_INVOICE_STATUSES)[number],
  );
}

export const CustomerInvoiceSendResultSchema = z.object({
  queued: z.literal(true),
  alreadyQueued: z.boolean(),
  retryAfterSeconds: z.number().int().nonnegative(),
});

export const InvoiceVersionSchema = z.object({
  expectedUpdatedAt: z.iso.datetime(),
});

export const InvoiceActionSchema = InvoiceVersionSchema.extend({
  reason: z.string().trim().min(2).max(500),
});

export const CreateInvoiceDocumentSchema = z.object({
  documentType: z.enum(['original', 'adjustment', 'reissue']).default('original'),
  invoiceNumber: z.string().trim().min(2).max(80),
  invoiceCode: z.string().trim().max(80).optional(),
  externalReference: z.string().trim().max(160).optional(),
  storageKey: z.string().trim().min(3).max(500),
  mediaType: z.enum(['application/pdf', 'application/ofd']),
  size: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  contentDigest: z.string().trim().min(16).max(128),
  replacesDocumentId: z.string().uuid().optional(),
});

export const InvoiceListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  eventId: EventIdParamSchema.optional(),
  status: InvoiceRequestStatusSchema.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  dateField: z.enum(['requested', 'issued']).default('requested').optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
});

export const NotificationTemplateSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  channel: z.enum(['email', 'sms', 'wechat']),
  subject: z.string(),
  body: z.string(),
  status: z.string(),
  version: z.number().int().positive(),
});

export const QueueNotificationSchema = z.object({
  templateId: z.string(),
  eventId: EventIdSchema.optional(),
  registrationId: z.string().optional(),
  recipient: z.string().min(3).max(255),
  variables: z.record(z.string(), z.string()).default({}),
  aiRunId: z.string().optional(),
});

export const AiGenerateSchema = z.object({
  eventId: EventIdSchema,
  task: z.enum(['event_tagline', 'event_description', 'notification_subject', 'notification_body']),
  brief: z.string().trim().min(5).max(2000),
  knowledge: z.array(z.string().max(1200)).max(12).default([]),
});

export const AiRunSchema = z.object({
  id: z.string(),
  eventId: EventIdSchema.nullable(),
  task: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.string(),
  status: z.enum(['draft', 'approved', 'rejected']),
  provider: z.string(),
  model: z.string(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
});

export const CheckInDeviceSchema = z.object({
  id: z.string(),
  eventId: EventIdSchema,
  deviceCode: z.string(),
  name: z.string(),
  status: z.string(),
  capabilities: z.array(z.string()),
  lastSeenAt: z.string().nullable(),
});

export const OfflineCheckInRecordSchema = z.object({
  localId: z.string().min(1).max(120),
  ticketCode: z.string().min(6),
  checkedInAt: z.iso.datetime(),
});

export const OfflineCheckInSyncSchema = z.object({
  eventId: EventIdSchema,
  checkInListId: z.string().default('main-entrance'),
  deviceCode: z.string().min(3).max(80),
  batchKey: z.string().min(8).max(120),
  records: z.array(OfflineCheckInRecordSchema).min(1).max(500),
});

export type EventStatus = z.infer<typeof EventStatusSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type RegistrationStatus = z.infer<typeof RegistrationStatusSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;
export type EventPaymentMode = z.infer<typeof EventPaymentModeSchema>;
export type CustomerAccountMode = z.infer<typeof CustomerAccountModeSchema>;
export type CustomerStatus = z.infer<typeof CustomerStatusSchema>;
export type CooperationType = z.infer<typeof CooperationTypeSchema>;
export type CooperationRequestStatus = z.infer<typeof CooperationRequestStatusSchema>;
export type CreateCooperationRequest = z.infer<typeof CreateCooperationRequestSchema>;
export type PublicCooperationRequestResult = z.infer<typeof PublicCooperationRequestResultSchema>;
export type AdminCooperationRequest = z.infer<typeof AdminCooperationRequestSchema>;
export type AdminCooperationRequestListQuery = z.infer<
  typeof AdminCooperationRequestListQuerySchema
>;
export type AdminCooperationRequestList = z.infer<typeof AdminCooperationRequestListSchema>;
export type UpdateCooperationRequest = z.infer<typeof UpdateCooperationRequestSchema>;
export type TemplateSurface = z.infer<typeof TemplateSurfaceSchema>;
export type TemplateFlowPreset = z.infer<typeof TemplateFlowPresetSchema>;
export type TemplateFlowStep = z.infer<typeof TemplateFlowStepSchema>;
export type TemplateHome = z.infer<typeof TemplateHomeSchema>;
export type TemplatePartnershipOrganizationGroupKey = z.infer<
  typeof TemplatePartnershipOrganizationGroupKeySchema
>;
export type TemplatePartnershipOrganizationGroup = z.infer<
  typeof TemplatePartnershipOrganizationGroupSchema
>;
export type HtmlTemplateVariablePath = z.infer<typeof HtmlTemplateVariablePathSchema>;
export type HtmlTemplateTextSegment = z.infer<typeof HtmlTemplateTextSegmentSchema>;
export type HtmlTemplateBinding = z.infer<typeof HtmlTemplateBindingSchema>;
export type HtmlTemplateBindingManifest = z.infer<typeof HtmlTemplateBindingManifestSchema>;
export type HtmlTemplateBindingProposal = z.infer<typeof HtmlTemplateBindingProposalSchema>;
export type HtmlTemplateAiProposalOutput = z.infer<typeof HtmlTemplateAiProposalOutputSchema>;
export type HtmlTemplatePresentation = z.infer<typeof HtmlTemplatePresentationSchema>;
export type InvoiceRequestStatus = z.infer<typeof InvoiceRequestStatusSchema>;
export type EventRegistrationSettings = z.infer<typeof EventRegistrationSettingsSchema>;
export type EventSettings = z.infer<typeof EventSettingsSchema>;
export type WebsiteSettings = z.infer<typeof WebsiteSettingsSchema>;
export type AnalyticsSettings = z.infer<typeof AnalyticsSettingsSchema>;
export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;
export type ConferenceTemplateDefinition = z.infer<typeof ConferenceTemplateDefinitionSchema>;
export type TicketType = z.infer<typeof TicketTypeSchema>;
export type Speaker = z.infer<typeof SpeakerSchema>;
export type SpeakerSocialLink = z.infer<typeof SpeakerSocialLinkSchema>;
export type CreateSpeaker = z.infer<typeof CreateSpeakerSchema>;
export type UpdateSpeaker = z.infer<typeof UpdateSpeakerSchema>;
export type ReorderSpeakers = z.infer<typeof ReorderSpeakersSchema>;
export type AdminSpeakerSummary = z.infer<typeof AdminSpeakerSummarySchema>;
export type AdminSpeakerDetail = z.infer<typeof AdminSpeakerDetailSchema>;
export type PublicEventSpeakerDetail = z.infer<typeof PublicEventSpeakerDetailSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type RegistrationField = z.infer<typeof RegistrationFieldSchema>;
export type RegistrationFormPublish = z.infer<typeof RegistrationFormPublishSchema>;
export type RegistrationForm = z.infer<typeof RegistrationFormSchema>;
export type PublicEventMetrics = z.infer<typeof PublicEventMetricsSchema>;
export type RecordPublicEventView = z.infer<typeof RecordPublicEventViewSchema>;
export type PublicEventViewResult = z.infer<typeof PublicEventViewResultSchema>;
export type PublicEvent = z.infer<typeof PublicEventSchema>;
export type CreateRegistration = z.infer<typeof CreateRegistrationSchema>;
export type Registration = z.infer<typeof RegistrationSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type CustomerOrderAccess = z.infer<typeof CustomerOrderAccessSchema>;
export type PaymentCallback = z.infer<typeof PaymentCallbackSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type RegistrationCheckout = z.infer<typeof RegistrationCheckoutSchema>;
export type ReviewRegistration = z.infer<typeof ReviewRegistrationSchema>;
export type WaitlistJoin = z.infer<typeof WaitlistJoinSchema>;
export type WaitlistEntry = z.infer<typeof WaitlistEntrySchema>;
export type CheckInRequest = z.infer<typeof CheckInRequestSchema>;
export type AdminDashboard = z.infer<typeof AdminDashboardSchema>;
export type AdminDashboardQuery = z.infer<typeof AdminDashboardQuerySchema>;
export type Login = z.infer<typeof LoginSchema>;
export type LoginResult = z.infer<typeof LoginResultSchema>;
export type AdminPreferences = z.infer<typeof AdminPreferencesSchema>;
export type UpdateAdminPreferences = z.infer<typeof UpdateAdminPreferencesSchema>;
export type AuthMe = z.infer<typeof AuthMeSchema>;
export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;
export type AttendeeIndustryCode = z.infer<typeof AttendeeIndustryCodeSchema>;
export type AttendeeShowcaseVisibleFields = z.infer<typeof AttendeeShowcaseVisibleFieldsSchema>;
export type UpdateAttendeeShowcase = z.infer<typeof UpdateAttendeeShowcaseSchema>;
export type AttendeeShowcaseProfile = z.infer<typeof AttendeeShowcaseProfileSchema>;
export type AttendeeNeedTagCode = z.infer<typeof AttendeeNeedTagCodeSchema>;
export type AttendeeNeedQuestionInput = z.infer<typeof AttendeeNeedQuestionInputSchema>;
export type UpdateAttendeeNeeds = z.infer<typeof UpdateAttendeeNeedsSchema>;
export type DeleteAttendeeNeeds = z.infer<typeof DeleteAttendeeNeedsSchema>;
export type AttendeeNeedsProfile = z.infer<typeof AttendeeNeedsProfileSchema>;
export type PublicAttendeeNeedListQuery = z.infer<typeof PublicAttendeeNeedListQuerySchema>;
export type PublicAttendeeNeedItem = z.infer<typeof PublicAttendeeNeedItemSchema>;
export type PublicAttendeeNeedList = z.infer<typeof PublicAttendeeNeedListSchema>;
export type AdminAttendeeNeedListQuery = z.infer<typeof AdminAttendeeNeedListQuerySchema>;
export type AdminAttendeeNeedItem = z.infer<typeof AdminAttendeeNeedItemSchema>;
export type AdminAttendeeNeedList = z.infer<typeof AdminAttendeeNeedListSchema>;
export type UpdateAdminAttendeeNeedQuestion = z.infer<typeof UpdateAdminAttendeeNeedQuestionSchema>;
export type ModerateAttendeeNeedQuestion = z.infer<typeof ModerateAttendeeNeedQuestionSchema>;
export type AdminAttendeeNeedExportQuery = z.infer<typeof AdminAttendeeNeedExportQuerySchema>;
export type AttendeeAvatarUpload = z.infer<typeof AttendeeAvatarUploadSchema>;
export type AttendeeAvatarUploadResult = z.infer<typeof AttendeeAvatarUploadResultSchema>;
export type AttendeeAvatarConfirm = z.infer<typeof AttendeeAvatarConfirmSchema>;
export type PublicEventMemberListQuery = z.infer<typeof PublicEventMemberListQuerySchema>;
export type PublicEventMemberItem = z.infer<typeof PublicEventMemberItemSchema>;
export type PublicEventMemberList = z.infer<typeof PublicEventMemberListSchema>;
export type PublicEventMemberDetail = z.infer<typeof PublicEventMemberDetailSchema>;
export type ModerateAttendeeShowcase = z.infer<typeof ModerateAttendeeShowcaseSchema>;
export type AdminAttendeeShowcase = z.infer<typeof AdminAttendeeShowcaseSchema>;
export type CustomerIdentity = z.infer<typeof CustomerIdentitySchema>;
export type AdminRegistrationCustomer = z.infer<typeof AdminRegistrationCustomerSchema>;
export type AdminRegistrationRow = z.infer<typeof AdminRegistrationRowSchema>;
export type RegistrationBusinessStatus = z.infer<typeof RegistrationBusinessStatusSchema>;
export type RegistrationInvoiceSummaryStatus = z.infer<
  typeof RegistrationInvoiceSummaryStatusSchema
>;
export type AdminRegistrationDetail = z.infer<typeof AdminRegistrationDetailSchema>;
export type AdminRegistrationOperationsDetail = z.infer<
  typeof AdminRegistrationOperationsDetailSchema
>;
export type UpdateAdminRegistrationAttendee = z.infer<typeof UpdateAdminRegistrationAttendeeSchema>;
export type CreateRegistrationNote = z.infer<typeof CreateRegistrationNoteSchema>;
export type AdminRegistrationOperationsPayment = z.infer<
  typeof AdminRegistrationOperationsPaymentSchema
>;
export type AdminRegistrationOperationsCheckin = z.infer<
  typeof AdminRegistrationOperationsCheckinSchema
>;
export type RegistrationNote = z.infer<typeof RegistrationNoteSchema>;
export type AdminRegistrationList = z.infer<typeof AdminRegistrationListSchema>;
export type AdminRegistrationListQuery = z.infer<typeof AdminRegistrationListQuerySchema>;
export type AdminOrderRow = z.infer<typeof AdminOrderRowSchema>;
export type AdminOrderList = z.infer<typeof AdminOrderListSchema>;
export type AdminOrderListQuery = z.infer<typeof AdminOrderListQuerySchema>;
export type RequestCustomerOtp = z.infer<typeof RequestCustomerOtpSchema>;
export type RequestCustomerOtpResult = z.infer<typeof RequestCustomerOtpResultSchema>;
export type VerifyCustomerOtp = z.infer<typeof VerifyCustomerOtpSchema>;
export type CustomerSession = z.infer<typeof CustomerSessionSchema>;
export type UpdateCustomerProfile = z.infer<typeof UpdateCustomerProfileSchema>;
export type EventPurchaseContext = z.infer<typeof EventPurchaseContextSchema>;
export type CustomerRegistrationSummary = z.infer<typeof CustomerRegistrationSummarySchema>;
export type CustomerRegistrationDetail = z.infer<typeof CustomerRegistrationDetailSchema>;
export type CustomerRegistrationList = z.infer<typeof CustomerRegistrationListSchema>;
export type CustomerPurchasedOrder = z.infer<typeof CustomerPurchasedOrderSchema>;
export type CustomerPurchasedOrderList = z.infer<typeof CustomerPurchasedOrderListSchema>;
export type AttendeeClaimInput = z.infer<typeof AttendeeClaimInputSchema>;
export type AttendeeClaimResult = z.infer<typeof AttendeeClaimResultSchema>;
export type UpdatePurchasedOrderAttendee = z.infer<typeof UpdatePurchasedOrderAttendeeSchema>;
export type ClaimCustomerRegistration = z.infer<typeof ClaimCustomerRegistrationSchema>;
export type CustomerAdminDisplayNameSource = z.infer<typeof CustomerAdminDisplayNameSourceSchema>;
export type CustomerAdminDisplayCompanySource = z.infer<
  typeof CustomerAdminDisplayCompanySourceSchema
>;
export type CustomerAdminLatestRegistration = z.infer<typeof CustomerAdminLatestRegistrationSchema>;
export type CustomerAdminSummary = z.infer<typeof CustomerAdminSummarySchema>;
export type CustomerAdminList = z.infer<typeof CustomerAdminListSchema>;
export type CustomerInvoiceSummary = z.infer<typeof CustomerInvoiceSummarySchema>;
export type CustomerInvoiceList = z.infer<typeof CustomerInvoiceListSchema>;
export type CustomerInvoiceCenterCategory = z.infer<typeof CustomerInvoiceCenterCategorySchema>;
export type CustomerInvoiceCenterAction = z.infer<typeof CustomerInvoiceCenterActionSchema>;
export type CustomerInvoiceCenterCounts = z.infer<typeof CustomerInvoiceCenterCountsSchema>;
export type CustomerInvoiceCenterItem = z.infer<typeof CustomerInvoiceCenterItemSchema>;
export type CustomerInvoiceCenterList = z.infer<typeof CustomerInvoiceCenterListSchema>;
export type CustomerInvoiceCenterListQuery = z.infer<typeof CustomerInvoiceCenterListQuerySchema>;
export type CustomerInvoiceOrderContext = z.infer<typeof CustomerInvoiceOrderContextSchema>;
export type CustomerAdminDetail = z.infer<typeof CustomerAdminDetailSchema>;
export type DeleteCustomerAdminResult = z.infer<typeof DeleteCustomerAdminResultSchema>;
export type CreateCustomerAdmin = z.infer<typeof CreateCustomerAdminSchema>;
export type CreateCustomerAdminResult = z.infer<typeof CreateCustomerAdminResultSchema>;
export type UpdateCustomerAdmin = z.infer<typeof UpdateCustomerAdminSchema>;
export type CustomerAdminListQuery = z.infer<typeof CustomerAdminListQuerySchema>;
export type CustomerAdminExportQuery = z.infer<typeof CustomerAdminExportQuerySchema>;
export type CustomerRegistrationListQuery = z.infer<typeof CustomerRegistrationListQuerySchema>;
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;
export type AccountProfile = z.infer<typeof AccountProfileSchema>;
export type UpdateAccountProfile = z.infer<typeof UpdateAccountProfileSchema>;
export type UpdateOrganizationMember = z.infer<typeof UpdateOrganizationMemberSchema>;
export type UpdateMembershipStatus = z.infer<typeof UpdateMembershipStatusSchema>;
export type CreateOrganizationAdministrator = z.infer<typeof CreateOrganizationAdministratorSchema>;
export type UpdateOrganizationAdministrator = z.infer<typeof UpdateOrganizationAdministratorSchema>;
export type CreateOrganizationInvitation = z.infer<typeof CreateOrganizationInvitationSchema>;
export type OrganizationInvitation = z.infer<typeof OrganizationInvitationSchema>;
export type CreateOrganizationInvitationResult = z.infer<
  typeof CreateOrganizationInvitationResultSchema
>;
export type AcceptOrganizationInvitation = z.infer<typeof AcceptOrganizationInvitationSchema>;
export type OrganizationSettingsResult = z.infer<typeof OrganizationSettingsResultSchema>;
export type UpdateOrganizationSettings = z.infer<typeof UpdateOrganizationSettingsSchema>;
export type UpdateOrganizationAnalytics = z.infer<typeof UpdateOrganizationAnalyticsSchema>;
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;
export type WeChatPayConfiguration = z.infer<typeof WeChatPayConfigurationSchema>;
export type UpdateWeChatPayConfiguration = z.infer<typeof UpdateWeChatPayConfigurationSchema>;
export type WeChatPayConnectionTest = z.infer<typeof WeChatPayConnectionTestSchema>;
export type WeChatPaymentChannel = z.infer<typeof WeChatPaymentChannelSchema>;
export type WeChatNativePayment = z.infer<typeof WeChatNativePaymentSchema>;
export type WeChatJsapiPayment = z.infer<typeof WeChatJsapiPaymentSchema>;
export type WeChatH5Payment = z.infer<typeof WeChatH5PaymentSchema>;
export type WeChatPaymentPrepareResult = z.infer<typeof WeChatPaymentPrepareResultSchema>;
export type WeChatPaymentSwitchResult =
  WeChatPaymentPrepareResult | { paid: true; orderId: string };
export type WeChatOAuthStart = z.infer<typeof WeChatOAuthStartSchema>;
export type WeChatOAuthHandoff = z.infer<typeof WeChatOAuthHandoffSchema>;
export type WeChatOAuthSession = z.infer<typeof WeChatOAuthSessionSchema>;
export type AliyunSmsTemplateKey = z.infer<typeof AliyunSmsTemplateKeySchema>;
export type AliyunSmsConfiguration = z.infer<typeof AliyunSmsConfigurationSchema>;
export type UpdateAliyunSmsConfiguration = z.infer<typeof UpdateAliyunSmsConfigurationSchema>;
export type TestAliyunSmsConfiguration = z.infer<typeof TestAliyunSmsConfigurationSchema>;
export type AliyunSmsConnectionTest = z.infer<typeof AliyunSmsConnectionTestSchema>;
export type PublicSiteConfiguration = z.infer<typeof PublicSiteConfigurationSchema>;
export type EventContextOption = z.infer<typeof EventContextOptionSchema>;
export type EventSummary = z.infer<typeof EventSummarySchema>;
export type CreateEvent = z.infer<typeof CreateEventSchema>;
export type UpdateEvent = z.infer<typeof UpdateEventSchema>;
export type EventSlugAvailability = z.infer<typeof EventSlugAvailabilitySchema>;
export type UpdateEventSlug = z.infer<typeof UpdateEventSlugSchema>;
export type EventSlugUpdateResult = z.infer<typeof EventSlugUpdateResultSchema>;
export type SetOrganizationHomepageEvent = z.infer<typeof SetOrganizationHomepageEventSchema>;
export type OrganizationHomepageEvent = z.infer<typeof OrganizationHomepageEventSchema>;
export type EventBlueprint = z.infer<typeof EventBlueprintSchema>;
export type TemplatePackage = z.infer<typeof TemplatePackageSchema>;
export type ConferenceTemplateSummary = z.infer<typeof ConferenceTemplateSummarySchema>;
export type ConferenceTemplateOption = z.infer<typeof ConferenceTemplateOptionSchema>;
export type ConferenceTemplateDraft = z.infer<typeof ConferenceTemplateDraftSchema>;
export type ConferenceTemplateVersion = z.infer<typeof ConferenceTemplateVersionSchema>;
export type CreateConferenceTemplate = z.infer<typeof CreateConferenceTemplateSchema>;
export type UpdateConferenceTemplate = z.infer<typeof UpdateConferenceTemplateSchema>;
export type SaveConferenceTemplateDraft = z.infer<typeof SaveConferenceTemplateDraftSchema>;
export type PublishConferenceTemplate = z.infer<typeof PublishConferenceTemplateSchema>;
export type EventTemplateBinding = z.infer<typeof EventTemplateBindingSchema>;
export type UpdateEventTemplateBinding = z.infer<typeof UpdateEventTemplateBindingSchema>;
export type EventExperience = z.infer<typeof EventExperienceSchema>;
export type SaveEventExperienceOverride = z.infer<typeof SaveEventExperienceOverrideSchema>;
export type EventRelease = z.infer<typeof EventReleaseSchema>;
export type PublishEvent = z.infer<typeof PublishEventSchema>;
export type RefundRequest = z.infer<typeof RefundRequestSchema>;
export type Refund = z.infer<typeof RefundSchema>;
export type InvoiceBuyer = z.infer<typeof InvoiceBuyerSchema>;
export type InvoiceBatchManifestItem = z.infer<typeof InvoiceBatchManifestItemSchema>;
export type InvoiceBatchPreflight = z.infer<typeof InvoiceBatchPreflightSchema>;
export type InvoiceBatchPreflightResult = z.infer<typeof InvoiceBatchPreflightResultSchema>;
export type CustomerCreateInvoice = z.infer<typeof CustomerCreateInvoiceSchema>;
export type CustomerUpdateInvoice = z.infer<typeof CustomerUpdateInvoiceSchema>;
export type CustomerSubmitInvoice = z.infer<typeof CustomerSubmitInvoiceSchema>;
export type SubmitInvoiceDetails = z.infer<typeof SubmitInvoiceDetailsSchema>;
export type RequestOrderAccessLink = z.infer<typeof RequestOrderAccessLinkSchema>;
export type InvoiceDocument = z.infer<typeof InvoiceDocumentSchema>;
export type InvoiceStateLog = z.infer<typeof InvoiceStateLogSchema>;
export type InvoiceRequest = z.infer<typeof InvoiceRequestSchema>;
export type CustomerInvoiceDetail = z.infer<typeof CustomerInvoiceDetailSchema>;
export type CustomerInvoiceSendResult = z.infer<typeof CustomerInvoiceSendResultSchema>;
export type InvoiceVersion = z.infer<typeof InvoiceVersionSchema>;
export type InvoiceAction = z.infer<typeof InvoiceActionSchema>;
export type CreateInvoiceDocument = z.infer<typeof CreateInvoiceDocumentSchema>;
export type InvoiceListQuery = z.infer<typeof InvoiceListQuerySchema>;
export type NotificationTemplate = z.infer<typeof NotificationTemplateSchema>;
export type QueueNotification = z.infer<typeof QueueNotificationSchema>;
export type AiGenerate = z.infer<typeof AiGenerateSchema>;
export type AiRun = z.infer<typeof AiRunSchema>;
export type CheckInDevice = z.infer<typeof CheckInDeviceSchema>;
export type OfflineCheckInSync = z.infer<typeof OfflineCheckInSyncSchema>;

export const API_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INVENTORY_UNAVAILABLE: 'INVENTORY_UNAVAILABLE',
  REGISTRATION_IDENTITY_CONFLICT: 'REGISTRATION_IDENTITY_CONFLICT',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  DUPLICATE_CHECKIN: 'DUPLICATE_CHECKIN',
  AGENT_ACCESS_DISABLED: 'AGENT_ACCESS_DISABLED',
  AGENT_CONNECTION_REVOKED: 'AGENT_CONNECTION_REVOKED',
  AGENT_SCOPE_REQUIRED: 'AGENT_SCOPE_REQUIRED',
  AGENT_ACTION_NOT_CLASSIFIED: 'AGENT_ACTION_NOT_CLASSIFIED',
  AGENT_APPROVAL_REQUIRED: 'AGENT_APPROVAL_REQUIRED',
  AGENT_OPERATION_STALE: 'AGENT_OPERATION_STALE',
  AGENT_IDEMPOTENCY_CONFLICT: 'AGENT_IDEMPOTENCY_CONFLICT',
  AGENT_DPOP_REPLAY: 'AGENT_DPOP_REPLAY',
  AGENT_VERSION_UNSUPPORTED: 'AGENT_VERSION_UNSUPPORTED',
  AGENT_RESULT_UNKNOWN: 'AGENT_RESULT_UNKNOWN',
  AGENT_SECRET_HANDOFF_REQUIRED: 'AGENT_SECRET_HANDOFF_REQUIRED',
  AGENT_OPERATION_LIMIT: 'AGENT_OPERATION_LIMIT',
} as const;

export type CanonicalHomepagePublic = {
  schemaVersion: 1;
  source: {
    organizationId: string;
    organizationSlug: string;
    eventId: number;
    eventSlug: string;
  };
  publicEvent: PublicEvent;
  speakerProfiles: Array<
    Record<string, unknown> & {
      id: string;
      bio?: string;
      topicAbstract?: string;
      websiteUrl?: string;
      socialLinks?: SpeakerSocialLink[];
    }
  >;
  template: {
    rootId: string;
    versionId: string;
    version: number;
    definition: ConferenceTemplateDefinition;
  };
};

export const CANONICAL_HOMEPAGE_PUBLIC =
  canonicalHomepagePublicData as unknown as CanonicalHomepagePublic;
const canonicalDemoEvent = PublicEventSchema.parse(CANONICAL_HOMEPAGE_PUBLIC.publicEvent);

export const DEMO_IDS = {
  organization: CANONICAL_HOMEPAGE_PUBLIC.source.organizationId,
  event: CANONICAL_HOMEPAGE_PUBLIC.source.eventId,
  adminUser: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  template: {
    root: CANONICAL_HOMEPAGE_PUBLIC.template.rootId,
    version: CANONICAL_HOMEPAGE_PUBLIC.template.versionId,
  },
  tickets: {
    earlyBird: '33333333-3333-4333-8333-333333333331',
    standard: '33333333-3333-4333-8333-333333333332',
    team: '33333333-3333-4333-8333-333333333333',
  },
  checkinList: '44444444-4444-4444-8444-444444444444',
} as const;

export const DEMO_EVENT: PublicEvent = canonicalDemoEvent;
export const DEMO_EVENT_EXPERIENCE: NonNullable<PublicEvent['experience']> =
  canonicalDemoEvent.experience!;
export const DEMO_SPEAKER_PROFILES: Record<
  string,
  {
    bio: string;
    topicAbstract: string;
    websiteUrl?: string;
    socialLinks?: SpeakerSocialLink[];
  }
> = Object.fromEntries(
  CANONICAL_HOMEPAGE_PUBLIC.speakerProfiles.map((speaker) => [
    String(speaker.id),
    {
      bio: String(speaker.bio ?? ''),
      topicAbstract: String(speaker.topicAbstract ?? ''),
      ...(typeof speaker.websiteUrl === 'string' ? { websiteUrl: speaker.websiteUrl } : {}),
      socialLinks: Array.isArray(speaker.socialLinks) ? speaker.socialLinks : [],
    },
  ]),
);
