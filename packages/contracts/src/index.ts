import { z } from 'zod';

export const BuildInfoSchema = z.object({
  service: z.string().regex(/^[a-z0-9-]+$/u),
  sha: z.union([z.string().regex(/^[a-f0-9]{7,64}$/u), z.literal('unknown')]),
  builtAt: z.union([z.iso.datetime(), z.literal('unknown')]),
  migration: z.union([z.string().regex(/^\d{4}_[A-Za-z0-9_-]+\.sql$/u), z.literal('unknown')]),
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;

export function resolveBuildInfo(
  service: string,
  environment: Record<string, string | undefined>,
): BuildInfo {
  const shaCandidate = environment.BUILD_SHA?.trim().toLowerCase() ?? '';
  const builtAtCandidate = environment.BUILD_TIME?.trim() ?? '';
  const migrationCandidate = environment.BUILD_MIGRATION?.trim() ?? '';
  const candidate = {
    service,
    sha: /^[a-f0-9]{7,64}$/u.test(shaCandidate) ? shaCandidate : 'unknown',
    builtAt: z.iso.datetime().safeParse(builtAtCandidate).success ? builtAtCandidate : 'unknown',
    migration: /^\d{4}_[A-Za-z0-9_-]+\.sql$/u.test(migrationCandidate)
      ? migrationCandidate
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

export const EventSlugSchema = EventSlugBaseSchema.max(100)
  .refine((slug) => !reservedPublicEventSlugSet.has(slug), '该路径由系统保留，请更换大会路径');

export const EventShortSlugSchema = EventSlugBaseSchema.max(24, '大会短地址不能超过 24 个字符')
  .refine((slug) => !reservedPublicEventSlugSet.has(slug), '该路径由系统保留，请更换大会路径');

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
export const CustomerAccountModeSchema = z.enum(['mobile_otp_required', 'guest_allowed']);
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

export const EventRegistrationSettingsSchema = z.object({
  paymentMode: EventPaymentModeSchema.default('ticketed'),
  currency: z.literal('CNY').default('CNY'),
  registrationOpen: z.boolean().default(true),
  accountMode: CustomerAccountModeSchema.default('mobile_otp_required'),
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
    enabled: z.boolean().default(false),
    provider: z.enum(['baidu', 'google', 'umami']).default('baidu'),
    trackingId: z.string().trim().max(160).default(''),
    scriptUrl: z.union([z.url(), z.literal('')]).default(''),
    siteId: z.string().trim().max(200).default(''),
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
      defaultAccountMode: CustomerAccountModeSchema.default('mobile_otp_required'),
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
  analytics: AnalyticsSettingsSchema.default({
    enabled: false,
    provider: 'baidu',
    trackingId: '',
    scriptUrl: '',
    siteId: '',
  }),
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
  blocks: z.array(TemplateHomeBlockSchema).min(1).max(30),
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
  steps: z.array(TemplateFlowStepSchema).min(2).max(8),
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
  variablePath: z.enum(['routes.registration', 'routes.faq', 'routes.account']),
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
    return v2.data;
  }
  const legacy = LegacyConferenceTemplateDefinitionSchema.parse(definition);
  return ConferenceTemplateDefinitionSchema.parse({
    presentation: { kind: 'structured', home: legacy.home },
    faq: legacy.faq,
    registrationFlow: legacy.registrationFlow,
    initialization: legacy.initialization,
  });
}

const LEGACY_DEFAULT_CONFERENCE_TEMPLATE_DEFINITION =
  LegacyConferenceTemplateDefinitionSchema.parse({
    home: {
      seo: {
        title: '',
        description: '',
        shareAssetId: null,
        indexable: true,
      },
      blocks: [
        {
          nodeKey: 'home.navigation',
          type: 'navigation',
          label: '顶部导航',
          enabled: true,
          variant: 'minimal',
          content: {},
        },
        {
          nodeKey: 'home.hero',
          type: 'hero',
          label: '首屏介绍',
          enabled: true,
          variant: 'editorial',
          content: {
            eyebrow: 'ANNUAL CONFERENCE',
            titlePrefix: '2026 全球',
            titleEvent: '大会运营峰会',
            slogan: '让每一次相聚都顺利发生',
            primaryAction: '立即报名 ¥399',
            secondaryAction: '查看两日议程',
          },
        },
        {
          nodeKey: 'home.stats',
          type: 'stats',
          label: '大会数据',
          enabled: true,
          variant: 'inline',
          content: {},
        },
        {
          nodeKey: 'home.value',
          type: 'value',
          label: '大会价值',
          enabled: true,
          variant: 'three-column',
          content: {},
        },
        {
          nodeKey: 'home.agenda',
          type: 'agenda',
          label: '大会议程',
          enabled: true,
          variant: 'timeline',
          content: {},
        },
        {
          nodeKey: 'home.speakers',
          type: 'speakers',
          label: '演讲嘉宾',
          enabled: true,
          variant: 'editorial-grid',
          content: {},
        },
        {
          nodeKey: 'home.organizer',
          type: 'organizer',
          label: '主办方',
          enabled: true,
          variant: 'compact',
          content: {},
        },
        {
          nodeKey: 'home.tickets',
          type: 'tickets',
          label: '参会票种',
          enabled: true,
          variant: 'single-pass',
          content: {},
        },
        {
          nodeKey: 'home.faq-summary',
          type: 'faq-summary',
          label: '常见问题',
          enabled: true,
          variant: 'accordion',
          content: {},
        },
        {
          nodeKey: 'home.registration-cta',
          type: 'registration-cta',
          label: '报名行动区',
          enabled: true,
          variant: 'band',
          content: { actionLabel: '选择参会票' },
        },
        {
          nodeKey: 'home.footer',
          type: 'footer',
          label: '页脚',
          enabled: true,
          variant: 'simple',
          content: {},
        },
      ],
    },
    faq: {
      mode: 'home',
      title: '常见问题',
      introduction: '解决你最后的犹豫',
      searchEnabled: true,
      contactLabel: '联系大会组委会',
      contactUrl: '',
      items: [
        {
          nodeKey: 'faq.platform',
          category: '大会介绍',
          question: '这场示例大会会展示哪些能力？',
          answer:
            '示例大会覆盖官网发布、报名、支付、候补、发票、电子票、通知、现场核销和运营复盘，帮助团队理解 TokEMS 的完整业务链路。',
          enabled: true,
        },
        {
          nodeKey: 'faq.beginner',
          category: '大会介绍',
          question: '我没有大会运营经验，能听懂吗？',
          answer:
            '可以。Day 1 面向主办方、运营负责人和技术团队讲解核心流程，Day 2 工作坊会带领参与者完成一条从报名到核销的演练。',
          enabled: true,
        },
        {
          nodeKey: 'faq.returning',
          category: '大会介绍',
          question: '哪些人适合参加？',
          answer:
            '活动主办方、会议运营团队、票务和现场服务团队、活动技术服务商，以及关注自托管活动基础设施的开发者都可以从议程中找到对应内容。',
          enabled: true,
        },
        {
          nodeKey: 'faq.workshop',
          category: '参会准备',
          question: '工作坊需要什么准备？',
          answer:
            '建议携带笔记本电脑。会前会发送本地演示环境和练习清单，工作坊将使用虚构数据完成配置、报名与核销流程。',
          enabled: true,
        },
        {
          nodeKey: 'faq.materials',
          category: '参会权益',
          question: '资料包包含什么，多久发放？',
          answer:
            '包含嘉宾演示文档、运营检查清单、通知模板、现场核销手册和《大会运营实践手册 2026》电子版。会后 3 个工作日内通过大会通知渠道发放。',
          enabled: true,
        },
        {
          nodeKey: 'faq.refund',
          category: '报名',
          question: '能退票吗？转让规则是什么？',
          answer:
            '购票后 7 天内可无理由全额退款；超过 7 天不退但支持免费转让，开幕 3 天前联系主办方更换参会人信息即可。',
          enabled: true,
        },
        {
          nodeKey: 'faq.invoice',
          category: '发票',
          question: '可以开发票吗？团队购票有优惠吗？',
          answer:
            '支持开具增值税普通发票与专用发票，购票后在个人中心申请即可。同一企业 5 人及以上团购，可联系组委会获取团队专属价与连座安排。',
          enabled: true,
        },
      ],
    },
    registrationFlow: {
      preset: 'standard',
      progressVariant: 'steps',
      summaryCardEnabled: true,
      branches: {
        waitlist: true,
        invoiceAfterPayment: true,
        manualReview: false,
        successActions: true,
      },
      steps: [
        {
          nodeKey: 'flow.ticket-selection',
          type: 'ticket-selection',
          title: '选择票种',
          helpText: '选择适合你的参会方式。',
          variant: 'cards',
          enabled: true,
        },
        {
          nodeKey: 'flow.attendee-form',
          type: 'attendee-form',
          title: '填写资料',
          helpText: '请填写参会人与联系信息。',
          variant: 'sectioned',
          enabled: true,
        },
        {
          nodeKey: 'flow.review-payment',
          type: 'review-payment',
          title: '确认并支付',
          helpText: '确认票种、资料和应付金额。',
          variant: 'summary',
          enabled: true,
        },
        {
          nodeKey: 'flow.success-ticket',
          type: 'success-ticket',
          title: '报名成功',
          helpText: '查看电子票与参会安排。',
          variant: 'ticket',
          enabled: true,
        },
      ],
    },
    initialization: {
      copyPolicy: {
        home: 'COPY',
        faq: 'COPY',
        registrationForm: 'COPY',
        ticketTypes: 'COPY',
        registrations: 'EXCLUDE',
        orders: 'EXCLUDE',
        invoices: 'EXCLUDE',
        checkins: 'EXCLUDE',
      },
      ticketTypes: [],
      registrationFields: [],
      termsContent: '提交报名即表示参会人同意大会报名服务条款与个人信息处理说明。',
    },
  });

export const DEFAULT_CONFERENCE_TEMPLATE_DEFINITION = normalizeConferenceTemplateDefinition(
  LEGACY_DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
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

export const SpeakerSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  topic: z.string(),
  initials: z.string(),
  accentFrom: z.string(),
  accentTo: z.string(),
  tags: z.array(z.string()),
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
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'email', 'tel', 'select']),
  required: z.boolean(),
  placeholder: z.string().max(160).optional(),
  options: z.array(z.string().max(120)).optional(),
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

export const CreateRegistrationSchema = z.object({
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
  invoiceRequired: z.boolean().default(false),
  marketingConsent: z.boolean().default(false),
  termsAccepted: z.literal(true),
  formVersion: z.number().int().positive().default(1),
  termsVersion: z.string().min(1).max(32).default('2026-07-16'),
  formAnswers: RegistrationAnswersSchema.optional(),
  waitlistOfferToken: z.string().min(32).max(200).optional(),
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

const LoginCredentialsSchema = z.object({
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(255),
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
    email: z.email(),
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
    email: z.email(),
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
  }),
  adminPreferences: AdminPreferencesSchema.default({ lastEventId: null }),
});

export const MainlandMobileSchema = z
  .string()
  .trim()
  .regex(/^(?:\+?86)?1[3-9]\d{9}$/, '请输入有效的中国大陆手机号');

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
  formVersion: z.number().int().positive().optional(),
  termsVersion: z.string().optional(),
});

const AdminRegistrationDetailBaseSchema = AdminRegistrationRowSchema.extend({
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
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
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

export const CustomerRegistrationSummarySchema = z.object({
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
  orderId: z.string(),
  orderNo: z.string(),
  orderStatus: OrderStatusSchema,
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  ticketCode: z.string().nullable(),
  ticketStatus: z.enum(['valid', 'used', 'cancelled']).nullable(),
  invoiceId: z.string().nullable(),
  invoiceStatus: InvoiceRequestStatusSchema.nullable(),
  createdAt: z.string(),
});

export const CustomerRegistrationDetailSchema = CustomerRegistrationSummarySchema.extend({
  attendee: z.object({
    name: z.string(),
    mobile: z.string(),
    email: z.string(),
    company: z.string(),
    title: z.string(),
    city: z.string(),
  }),
});

export const CustomerRegistrationListSchema = z.object({
  items: z.array(CustomerRegistrationSummarySchema),
  nextCursor: z.string().nullable(),
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
});

export const DeleteCustomerAdminResultSchema = z.object({
  deleted: z.literal(true),
  detachedRegistrations: z.number().int().nonnegative(),
  detachedWaitlistEntries: z.number().int().nonnegative(),
});

export const UpdateCustomerAdminSchema = z.object({
  profile: UpdateCustomerProfileSchema.optional(),
  status: CustomerStatusSchema.optional(),
  internalNote: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
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
  email: z.email(),
  name: z.string(),
  mobile: z.string().nullable(),
  role: OrganizationRoleSchema,
  grants: z.array(z.string()),
  status: MembershipStatusSchema,
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
    email: z.email(),
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
  password: z.string().min(8).max(200),
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
    settings: OrganizationSettingsSchema.partial().optional(),
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

export const CreateEventSchema = z
  .object({
    name: z.string().trim().min(2).max(180),
    shortName: z.string().trim().min(2).max(80),
    slug: EventShortSlugSchema.optional(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    timezone: z.string().min(1).optional(),
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
    timezone: z.string().trim().min(1).max(80).optional(),
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

export const CustomerCreateInvoiceSchema = InvoiceBuyerSchema.strict();

export const CustomerUpdateInvoiceSchema = InvoiceBuyerSchema.extend({
  expectedUpdatedAt: z.iso.datetime(),
}).strict();

export const CustomerSubmitInvoiceSchema = z.union([
  CustomerUpdateInvoiceSchema,
  CustomerCreateInvoiceSchema,
]);

export const SubmitInvoiceDetailsSchema = InvoiceBuyerSchema.extend({
  accessToken: z.string().min(32).max(500),
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
export type TemplateSurface = z.infer<typeof TemplateSurfaceSchema>;
export type TemplateFlowPreset = z.infer<typeof TemplateFlowPresetSchema>;
export type TemplateFlowStep = z.infer<typeof TemplateFlowStepSchema>;
export type TemplateHome = z.infer<typeof TemplateHomeSchema>;
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
export type Session = z.infer<typeof SessionSchema>;
export type RegistrationField = z.infer<typeof RegistrationFieldSchema>;
export type RegistrationForm = z.infer<typeof RegistrationFormSchema>;
export type PublicEvent = z.infer<typeof PublicEventSchema>;
export type CreateRegistration = z.infer<typeof CreateRegistrationSchema>;
export type Registration = z.infer<typeof RegistrationSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type PaymentCallback = z.infer<typeof PaymentCallbackSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type RegistrationCheckout = z.infer<typeof RegistrationCheckoutSchema>;
export type ReviewRegistration = z.infer<typeof ReviewRegistrationSchema>;
export type WaitlistJoin = z.infer<typeof WaitlistJoinSchema>;
export type WaitlistEntry = z.infer<typeof WaitlistEntrySchema>;
export type CheckInRequest = z.infer<typeof CheckInRequestSchema>;
export type AdminDashboard = z.infer<typeof AdminDashboardSchema>;
export type Login = z.infer<typeof LoginSchema>;
export type LoginResult = z.infer<typeof LoginResultSchema>;
export type AdminPreferences = z.infer<typeof AdminPreferencesSchema>;
export type UpdateAdminPreferences = z.infer<typeof UpdateAdminPreferencesSchema>;
export type AuthMe = z.infer<typeof AuthMeSchema>;
export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;
export type CustomerIdentity = z.infer<typeof CustomerIdentitySchema>;
export type AdminRegistrationCustomer = z.infer<typeof AdminRegistrationCustomerSchema>;
export type AdminRegistrationRow = z.infer<typeof AdminRegistrationRowSchema>;
export type AdminRegistrationDetail = z.infer<typeof AdminRegistrationDetailSchema>;
export type AdminRegistrationList = z.infer<typeof AdminRegistrationListSchema>;
export type AdminRegistrationListQuery = z.infer<typeof AdminRegistrationListQuerySchema>;
export type RequestCustomerOtp = z.infer<typeof RequestCustomerOtpSchema>;
export type RequestCustomerOtpResult = z.infer<typeof RequestCustomerOtpResultSchema>;
export type VerifyCustomerOtp = z.infer<typeof VerifyCustomerOtpSchema>;
export type CustomerSession = z.infer<typeof CustomerSessionSchema>;
export type UpdateCustomerProfile = z.infer<typeof UpdateCustomerProfileSchema>;
export type CustomerRegistrationSummary = z.infer<typeof CustomerRegistrationSummarySchema>;
export type CustomerRegistrationDetail = z.infer<typeof CustomerRegistrationDetailSchema>;
export type CustomerRegistrationList = z.infer<typeof CustomerRegistrationListSchema>;
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
export type UpdateCustomerAdmin = z.infer<typeof UpdateCustomerAdminSchema>;
export type CustomerAdminListQuery = z.infer<typeof CustomerAdminListQuerySchema>;
export type CustomerAdminExportQuery = z.infer<typeof CustomerAdminExportQuerySchema>;
export type CustomerRegistrationListQuery = z.infer<typeof CustomerRegistrationListQuerySchema>;
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;
export type AccountProfile = z.infer<typeof AccountProfileSchema>;
export type UpdateAccountProfile = z.infer<typeof UpdateAccountProfileSchema>;
export type UpdateOrganizationMember = z.infer<typeof UpdateOrganizationMemberSchema>;
export type UpdateMembershipStatus = z.infer<typeof UpdateMembershipStatusSchema>;
export type CreateOrganizationInvitation = z.infer<typeof CreateOrganizationInvitationSchema>;
export type OrganizationInvitation = z.infer<typeof OrganizationInvitationSchema>;
export type CreateOrganizationInvitationResult = z.infer<
  typeof CreateOrganizationInvitationResultSchema
>;
export type AcceptOrganizationInvitation = z.infer<typeof AcceptOrganizationInvitationSchema>;
export type OrganizationSettingsResult = z.infer<typeof OrganizationSettingsResultSchema>;
export type UpdateOrganizationSettings = z.infer<typeof UpdateOrganizationSettingsSchema>;
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
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  DUPLICATE_CHECKIN: 'DUPLICATE_CHECKIN',
} as const;

export const DEMO_IDS = {
  organization: '11111111-1111-4111-8111-111111111111',
  event: 101,
  adminUser: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  template: {
    root: '18181818-1818-4181-8181-181818181818',
    version: '19191919-1919-4191-8191-191919191919',
  },
  tickets: {
    earlyBird: '33333333-3333-4333-8333-333333333331',
    standard: '33333333-3333-4333-8333-333333333332',
    team: '33333333-3333-4333-8333-333333333333',
  },
  checkinList: '44444444-4444-4444-8444-444444444444',
} as const;

export const DEMO_EVENT_EXPERIENCE: NonNullable<PublicEvent['experience']> = {
  renderer: {
    key: 'editorial-blue',
    version: 1,
  },
  template: {
    id: DEMO_IDS.template.root,
    versionId: DEMO_IDS.template.version,
    version: 1,
  },
  presentation: { kind: 'structured' },
  home: {
    ...LEGACY_DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.home,
    seo: {
      ...LEGACY_DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.home.seo,
      title: 'TokEMS Demo Conference 2026 · 官方报名',
      description: '两天密集分享，40+ 大会运营实践者，覆盖官网、报名、票务、通知、发票与现场核销。',
    },
  },
  faq: DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.faq,
  registrationFlow: DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.registrationFlow,
};

export const DEMO_EVENT: PublicEvent = {
  id: DEMO_IDS.event,
  organizationId: DEMO_IDS.organization,
  slug: 'tokems26',
  name: 'TokEMS Demo Conference 2026',
  shortName: 'TokEMS Demo 2026',
  status: 'registration_open',
  tagline: '让每一次相聚都顺利发生',
  description: '两天密集分享，40+ 大会运营实践者，覆盖官网、报名、票务、通知、发票与现场核销。',
  startsAt: '2026-11-21T01:00:00.000Z',
  endsAt: '2026-11-22T09:30:00.000Z',
  timezone: 'Asia/Shanghai',
  venue: '深圳湾科技生态园',
  city: '深圳',
  address: '广东省深圳市南山区深圳湾科技生态园',
  registration: {
    paymentMode: 'ticketed',
    currency: 'CNY',
    registrationOpen: true,
    accountMode: 'guest_allowed',
  },
  stats: {
    seats: 500,
    speakers: 40,
    days: 2,
    attendeeSatisfaction: 96.8,
  },
  tickets: [
    {
      id: DEMO_IDS.tickets.earlyBird,
      name: '两日通票',
      description: '统一票价，一张票全程参与两天大会',
      price: 39900,
      currency: 'CNY',
      remaining: 500,
      benefits: [
        '两日大会全通票',
        'Day 2 实战工作坊席位',
        '《大会运营实践手册 2026》',
        '大会运营实战手册 1 本',
        '1 套大会运营线上课程',
        '40+ 嘉宾干货资料包',
        '大会运营者社群',
        '会后 7 天回放',
      ],
      recommended: true,
    },
  ],
  speakers: [
    {
      id: '55555555-5555-4555-8555-555555555551',
      name: 'Alex Chen',
      role: '大型活动运营作者 · 大会发起人',
      topic: '把大会运营流程变成可复用的系统能力',
      initials: 'AC',
      accentFrom: '#7a5cd6',
      accentTo: '#3a2d6b',
      tags: ['运营体系', '活动科技'],
    },
    {
      id: '55555555-5555-4555-8555-555555555552',
      name: 'Maya Lee',
      role: '大会发起人 · 企业数字增长专家',
      topic: '大会运营的下一程：行业全景',
      initials: 'ML',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['行业趋势', '数字增长'],
    },
    {
      id: '55555555-5555-4555-8555-555555555553',
      name: 'Jordan Kim',
      role: 'Demo Labs 创始人',
      topic: '2027 全球大会运营新趋势',
      initials: 'JK',
      accentFrom: '#059669',
      accentTo: '#064e3b',
      tags: ['全球活动', '内容运营'],
    },
    {
      id: '55555555-5555-4555-8555-555555555554',
      name: 'Priya Shah',
      role: 'Example Works 全球活动负责人',
      topic: '跨时区活动的数据与协作设计',
      initials: 'PS',
      accentFrom: '#d97706',
      accentTo: '#78350f',
      tags: ['数据研究', 'AEO'],
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Noah Williams',
      role: 'AI 自媒体 · 摇滚乐爱好者',
      topic: 'AI 产品推广三部曲 · 2026 版',
      initials: 'NW',
      accentFrom: '#db2777',
      accentTo: '#701a75',
      tags: ['产品营销', '冷启动'],
    },
    {
      id: '55555555-5555-4555-8555-555555555556',
      name: 'Sofia Garcia',
      role: '自媒体 · AI产品经理 · 设计师',
      topic: '产品视角下的大会运营策略',
      initials: 'SG',
      accentFrom: '#0891b2',
      accentTo: '#164e63',
      tags: ['产品思维', '设计策略'],
    },
    {
      id: '55555555-5555-4555-8555-555555555557',
      name: 'Ethan Brown',
      role: 'Open Events Lab 创始人 & CEO',
      topic: 'AI Agent 时代的内容分发',
      initials: 'EB',
      accentFrom: '#65a30d',
      accentTo: '#365314',
      tags: ['AI Agent', '内容分发'],
    },
    {
      id: '55555555-5555-4555-8555-555555555558',
      name: 'AJ',
      role: 'Community Stack 创始人',
      topic: 'AGI 时代的品牌建设',
      initials: 'AJ',
      accentFrom: '#9333ea',
      accentTo: '#581c87',
      tags: ['AGI', '品牌建设'],
    },
    {
      id: '55555555-5555-4555-8555-555555555559',
      name: 'Leo Wilson',
      role: '海外营销增长黑客 · AI产品经理',
      topic: '海外市场大会增长策略',
      initials: 'LW',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['海外增长', '增长黑客'],
    },
    {
      id: '55555555-5555-4555-8555-555555555560',
      name: 'Emma Davis',
      role: 'Data Studio 合伙人',
      topic: '数据底座驱动大会运营：从监控到增长',
      initials: 'ED',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['数据驱动', '引用监测'],
    },
    {
      id: '55555555-5555-4555-8555-555555555561',
      name: 'Kai Morgan',
      role: 'Knowledge Works创始人',
      topic: '活动内容如何保持一致、及时和可信',
      initials: 'KM',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['知识库工程', '可信度'],
    },
    {
      id: '55555555-5555-4555-8555-555555555562',
      name: 'Mina Park',
      role: 'Community Lab 主理人',
      topic: '社区运营与大会运营的协同',
      initials: 'MP',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['社群运营', 'AGI Bar'],
    },
    {
      id: '55555555-5555-4555-8555-555555555563',
      name: 'Oliver Smith',
      role: 'Demo Studio创始人',
      topic: '企业大会运营实战经验分享',
      initials: 'OS',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['企业实战', '落地经验'],
    },
    {
      id: '55555555-5555-4555-8555-555555555564',
      name: '大模型平台嘉宾',
      role: '国内头部 AI 平台 · 敬请期待',
      topic: '活动平台如何保障高峰期体验',
      initials: 'AI',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['平台视角', '引用排序'],
    },
    {
      id: '55555555-5555-4555-8555-555555555565',
      name: '上市企业 CMO',
      role: '标杆品牌方 · 敬请期待',
      topic: '12 个月大会运营投入产出全复盘',
      initials: 'CMO',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['真实数据', '预算复盘'],
    },
    {
      id: '55555555-5555-4555-8555-555555555566',
      name: '更多重磅嘉宾',
      role: '持续官宣中',
      topic: '关注大会社群，第一时间获取嘉宾更新',
      initials: '＋',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['40+ 阵容', '陆续揭晓'],
    },
  ],
  sessions: [
    {
      id: '66666666-6666-4666-8666-666666666601',
      day: 1,
      startsAt: '08:30',
      endsAt: '09:00',
      title: '签到入场 · 领取资料包与白皮书 · 展区开放',
      kind: 'break',
    },
    {
      id: '66666666-6666-4666-8666-666666666602',
      day: 1,
      startsAt: '09:00',
      endsAt: '09:20',
      title: '开幕致辞：大会运营的下一程',
      summary: '从概念元年到落地元年，行业全景与本届大会导览',
      speaker: 'Alex Chen · Maya Lee',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666603',
      day: 1,
      startsAt: '09:20',
      endsAt: '10:00',
      title: '《大会运营实践手册 2026》首发',
      summary: '年度行业数据、交付流程与运营基准集中发布',
      speaker: '实践手册联合编委会',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666604',
      day: 1,
      startsAt: '10:00',
      endsAt: '10:40',
      title: '跨时区活动的数据与协作设计',
      summary: '多语言内容、权限边界和全球团队交付实践',
      speaker: 'Priya Shah\nExample Works',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666605',
      day: 1,
      startsAt: '10:40',
      endsAt: '11:20',
      title: '把大会运营流程变成可复用的系统能力',
      summary: '从一次性交付到流程资产：主办方的大会运营设计',
      speaker: 'Alex Chen',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666606',
      day: 1,
      startsAt: '11:20',
      endsAt: '12:10',
      title: '活动平台视角：如何保障高峰期体验',
      summary: '平台嘉宾分享容量规划、可观测性与应急恢复策略',
      speaker: '大模型平台嘉宾\n敬请期待',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666607',
      day: 1,
      startsAt: '12:10',
      endsAt: '13:30',
      title: '午间休息 · 自由交流',
      kind: 'break',
    },
    {
      id: '66666666-6666-4666-8666-666666666608',
      day: 1,
      startsAt: '13:30',
      endsAt: '14:10',
      title: '12 个月大会运营投入产出全复盘',
      summary: '企业真实账本：预算、人力、转化率与到场率曲线',
      speaker: '标杆企业 CMO',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666609',
      day: 1,
      startsAt: '14:10',
      endsAt: '14:50',
      title: '数据底座驱动大会运营：从监控到增长',
      summary: '运营指标、归因模型与增长闭环实战方法论',
      speaker: 'Emma Davis\nData Studio',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666610',
      day: 1,
      startsAt: '14:50',
      endsAt: '15:30',
      title: '活动内容如何保持一致、及时和可信',
      summary: '共享内容、结构化数据与发布快照的三步实践',
      speaker: 'Kai Morgan\nKnowledge Works',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666611',
      day: 1,
      startsAt: '15:30',
      endsAt: '16:10',
      title: 'AI 产品推广三部曲 · 2026 版',
      summary: '从冷启动到口碑飞轮：AI 时代产品营销完整路径',
      speaker: 'Noah Williams',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666612',
      day: 1,
      startsAt: '16:10',
      endsAt: '17:00',
      title: '大会运营效果之辩：什么是真增长，什么是伪指标',
      summary: '品牌方、服务商、数据方三方同台交锋',
      speaker: '多位嘉宾联合',
      kind: 'workshop',
    },
    {
      id: '66666666-6666-4666-8666-666666666613',
      day: 1,
      startsAt: '17:00',
      endsAt: '18:00',
      title: 'AI 圆桌：Agent 时代的内容分发与品牌建设',
      summary: '当 Agent 替用户做决策，品牌该和谁对话',
      speaker: 'Sofia Garcia · AJ · Ethan · Mina Park',
      kind: 'workshop',
    },
    {
      id: '66666666-6666-4666-8666-666666666614',
      day: 1,
      startsAt: '18:30',
      endsAt: '18:30',
      title: 'Day 1 议程结束',
      kind: 'break',
    },
    {
      id: '66666666-6666-4666-8666-666666666615',
      day: 2,
      startsAt: '08:30',
      endsAt: '09:00',
      title: '签到入场 · 自由交流 · 展区开放',
      kind: 'break',
    },
    {
      id: '66666666-6666-4666-8666-666666666616',
      day: 2,
      startsAt: '09:00',
      endsAt: '10:00',
      title: '工作坊 ①：你的品牌 AI 可见度诊断',
      summary: '现场跑通多平台提问矩阵，量化品牌当前引用率与情感倾向',
      speaker: '导师团带练',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666617',
      day: 2,
      startsAt: '10:00',
      endsAt: '11:10',
      title: '工作坊 ②：大会内容发布流水线',
      summary: '从议程、嘉宾到 FAQ：结构化内容与发布快照演练',
      speaker: '导师团带练',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666618',
      day: 2,
      startsAt: '11:10',
      endsAt: '12:30',
      title: '工作坊 ③：90 天大会运营行动计划',
      summary: '现场产出你企业的执行排期、指标体系与汇报模板',
      speaker: '导师团带练',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666619',
      day: 2,
      startsAt: '09:00',
      endsAt: '09:50',
      title: '2027 全球大会运营新趋势',
      summary: '跨语言体验、跨时区协作与区域支付的机会地图',
      speaker: 'Jordan Kim\nDemo Labs',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666620',
      day: 2,
      startsAt: '09:50',
      endsAt: '10:40',
      title: '海外市场大会增长策略',
      summary: '从内容本地化到合作伙伴：国际活动获客实战手册',
      speaker: 'Leo Wilson',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666621',
      day: 2,
      startsAt: '10:40',
      endsAt: '11:30',
      title: '中国品牌如何占领全球 AI 答案',
      summary: '跨语言知识库、本地化背书与多市场引用监测',
      speaker: '出海品牌操盘手',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666622',
      day: 2,
      startsAt: '11:30',
      endsAt: '12:30',
      title: '全球圆桌：跨区域活动的增长与交付',
      speaker: '多位嘉宾联合',
      kind: 'workshop',
    },
    {
      id: '66666666-6666-4666-8666-666666666623',
      day: 2,
      startsAt: '12:30',
      endsAt: '14:00',
      title: '午间休息 · 自由交流',
      kind: 'break',
    },
    {
      id: '66666666-6666-4666-8666-666666666624',
      day: 2,
      startsAt: '14:00',
      endsAt: '14:50',
      title: 'AI Agent 时代的内容分发',
      summary: '当 Agent 成为新的「用户」，内容该为谁而写',
      speaker: 'Ethan Brown\nOpen Events Lab',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666625',
      day: 2,
      startsAt: '14:50',
      endsAt: '15:40',
      title: 'AGI 时代的品牌建设',
      summary: '从流量思维到资产思维：品牌在模型记忆中的长期主义',
      speaker: 'AJ\nCommunity Stack',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666626',
      day: 2,
      startsAt: '15:40',
      endsAt: '16:30',
      title: '大会运营服务标准与行业协作倡议',
      summary: '联合发布服务规范，让甲方敢买、乙方敢承诺',
      speaker: '行业联合发起方',
      kind: 'talk',
    },
    {
      id: '66666666-6666-4666-8666-666666666627',
      day: 2,
      startsAt: '16:30',
      endsAt: '17:20',
      title: '终场圆桌：大会运营的下一个十二个月',
      summary: '核心嘉宾压轴预判，现场开放提问',
      speaker: '核心嘉宾全员',
      kind: 'workshop',
    },
    {
      id: '66666666-6666-4666-8666-666666666628',
      day: 2,
      startsAt: '17:20',
      endsAt: '17:30',
      title: '闭幕致辞 · 第三届启动仪式',
      speaker: '大会组委会',
      kind: 'talk',
    },
  ],
  faqs: [
    {
      question: '这场示例大会会展示哪些能力？',
      answer:
        '示例大会覆盖官网发布、报名、支付、候补、发票、电子票、通知、现场核销和运营复盘，帮助团队理解 TokEMS 的完整业务链路。',
    },
    {
      question: '我没有大会运营经验，能听懂吗？',
      answer:
        '可以。Day 1 面向主办方、运营负责人和技术团队讲解核心流程，Day 2 工作坊会带领参与者完成一条从报名到核销的演练。',
    },
    {
      question: '哪些人适合参加？',
      answer:
        '活动主办方、会议运营团队、票务和现场服务团队、活动技术服务商，以及关注自托管活动基础设施的开发者都可以从议程中找到对应内容。',
    },
    {
      question: '工作坊需要什么准备？',
      answer:
        '建议携带笔记本电脑。会前会发送本地演示环境和练习清单，工作坊将使用虚构数据完成配置、报名与核销流程。',
    },
    {
      question: '资料包包含什么，多久发放？',
      answer:
        '包含嘉宾演示文档、运营检查清单、通知模板、现场核销手册和《大会运营实践手册 2026》电子版。会后 3 个工作日内通过大会通知渠道发放。',
    },
    {
      question: '能退票吗？转让规则是什么？',
      answer:
        '购票后 7 天内可无理由全额退款；超过 7 天不退但支持免费转让，开幕 3 天前联系主办方更换参会人信息即可。',
    },
    {
      question: '可以开发票吗？团队购票有优惠吗？',
      answer:
        '支持开具增值税普通发票与专用发票，购票后在个人中心申请即可。同一企业 5 人及以上团购，可联系组委会获取团队专属价与连座安排。',
    },
  ],
  experience: DEMO_EVENT_EXPERIENCE,
};
