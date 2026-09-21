import { z } from 'zod';
import { MainlandMobileSchema } from './mobile.js';

export const PartnerQualificationStatusSchema = z.enum([
  'pending_confirmation',
  'active',
  'paused',
  'closed',
]);
export const PartnerPublicStatusSchema = z.enum(['draft', 'published', 'hidden']);
export const PartnerRecipientStatusSchema = z.enum(['unbound', 'pending', 'verified', 'disabled']);
export const PartnerCommissionStatusSchema = z.enum([
  'provisional',
  'pending',
  'available',
  'reserved',
  'paid',
  'held',
  'reversed',
  'partially_reversed',
  'recovery_due',
]);
export const PartnerPayoutStatusSchema = z.enum([
  'submitted',
  'under_review',
  'approved',
  'batched',
  'executing',
  'succeeded',
  'rejected',
  'cancelled',
  'failed',
  'unknown',
]);
export const MerchantTransferStateSchema = z.enum([
  'ACCEPTED',
  'PROCESSING',
  'WAIT_USER_CONFIRM',
  'TRANSFERING',
  'SUCCESS',
  'FAIL',
  'CANCELING',
  'CANCELLED',
]);

export const PARTNER_VISIBLE_FIELD_KEYS = [
  'avatar',
  'displayName',
  'company',
  'title',
  'industry',
  'businessIntro',
  'businessUrl',
  'contactPhone',
  'contactEmail',
  'wechatId',
  'gallery',
] as const;

export const PartnerVisibleFieldsSchema = z.object(
  Object.fromEntries(PARTNER_VISIBLE_FIELD_KEYS.map((key) => [key, z.boolean()])) as Record<
    (typeof PARTNER_VISIBLE_FIELD_KEYS)[number],
    z.ZodBoolean
  >,
);

export const DEFAULT_PARTNER_VISIBLE_FIELDS: PartnerVisibleFields = {
  avatar: true,
  displayName: true,
  company: true,
  title: true,
  industry: true,
  businessIntro: true,
  businessUrl: false,
  contactPhone: false,
  contactEmail: false,
  wechatId: false,
  gallery: false,
};

export const DEFAULT_PARTNER_POSTER_FIELDS: PartnerVisibleFields = {
  avatar: true,
  displayName: true,
  company: true,
  title: true,
  industry: false,
  businessIntro: false,
  businessUrl: false,
  contactPhone: false,
  contactEmail: false,
  wechatId: false,
  gallery: false,
};

const OptionalPublicText = (maximum: number) => z.string().trim().max(maximum).default('');
const OptionalHttpUrl = z
  .union([
    z.literal(''),
    z
      .url()
      .max(500)
      .refine((value) => /^https?:\/\//u.test(value), '请输入 HTTP 或 HTTPS 地址'),
  ])
  .default('');

export const PartnerGalleryItemSchema = z.object({
  assetId: z.uuid(),
  alt: z.string().trim().min(1).max(120),
});

const PosterText = (limit: number) =>
  z
    .string()
    .trim()
    .refine(
      (value) =>
        Array.from(value).length <= limit && !/[<>]/u.test(value) && Array.from(value).every(char => { const code = char.codePointAt(0)!; return code >= 32 && code !== 127 || code === 10; }),
      { message: '文案超出字数限制或包含不支持的字符' },
    );
export const PARTNER_POSTER_DEFAULT_COPY = {
  invitation: '期待在大会现场与你见面',
  introduction: '正在寻找行业伙伴、业务交流与新的合作机会。',
  callToAction: '现场见，一起聊聊',
  scanHint: '扫码查看大会信息，通过我报名',
} as const;

export const PartnerPosterCopySchema = z.object({
  invitation: PosterText(32),
  introduction: PosterText(80),
  callToAction: PosterText(20).refine(value => !value.includes('\n'), '引导标题请使用单行文案').optional(),
  scanHint: PosterText(32).refine(value => !value.includes('\n'), '引导说明请使用单行文案').optional(),
});
export const UpdatePartnerPosterCopySchema = z.object({
  expectedVersion: z.number().int().positive(),
  posterCopy: PartnerPosterCopySchema,
});
export type PartnerPosterCopy = z.infer<typeof PartnerPosterCopySchema>;

export const UpdatePartnerProfileSchema = z.object({
  expectedVersion: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(80),
  company: OptionalPublicText(160),
  title: OptionalPublicText(100),
  industry: OptionalPublicText(80),
  businessIntro: OptionalPublicText(2000),
  businessUrl: OptionalHttpUrl,
  contactPhone: OptionalPublicText(32),
  contactEmail: z.union([z.literal(''), z.email().max(255)]).default(''),
  wechatId: OptionalPublicText(80),
  avatarAssetId: z.uuid().nullable().optional(),
  gallery: z.array(PartnerGalleryItemSchema).max(4).default([]),
});

export const UpdatePartnerPrivacySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    publicStatus: PartnerPublicStatusSchema,
    visibleFields: PartnerVisibleFieldsSchema,
    posterFields: PartnerVisibleFieldsSchema,
    searchIndexingEnabled: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    for (const key of PARTNER_VISIBLE_FIELD_KEYS) {
      if (value.posterFields[key] && !value.visibleFields[key]) {
        context.addIssue({
          code: 'custom',
          path: ['posterFields', key],
          message: '海报字段必须先获得公开展示授权',
        });
      }
    }
  });

export const PartnerTierSchema = z.object({
  minimumOrderCount: z.number().int().positive(),
  rateBps: z.number().int().min(0).max(10_000),
});

export const PartnerProgramDraftSchema = z
  .object({
    mode: z.enum(['fixed', 'order_count_tiered']).default('fixed'),
    fixedRateBps: z.number().int().min(0).max(10_000).default(1000),
    tiers: z.array(PartnerTierSchema).max(20).default([]),
    eligibleTicketTypeIds: z.array(z.uuid()).max(100).default([]),
    attributionDays: z.number().int().min(1).max(365).default(30),
    settlementDelayDays: z.number().int().min(0).max(365).default(7),
    minimumPayoutAmount: z.number().int().safe().min(1).max(1_000_000_000).default(1000),
    payoutCadence: z.enum(['weekly', 'monthly']).default('weekly'),
    termsTitle: z.string().trim().min(1).max(160),
    termsContent: z.string().trim().min(1).max(40_000),
    promotionPolicy: z.string().trim().min(1).max(20_000),
    publicDirectoryEnabled: z.boolean().default(false),
    homepageLimit: z.number().int().min(1).max(24).default(12),
  })
  .superRefine((value, context) => {
    if (value.mode === 'order_count_tiered' && value.tiers.length === 0) {
      context.addIssue({ code: 'custom', path: ['tiers'], message: '阶梯规则至少需要一个档位' });
    }
    const starts = value.tiers.map((tier) => tier.minimumOrderCount);
    if (new Set(starts).size !== starts.length) {
      context.addIssue({ code: 'custom', path: ['tiers'], message: '阶梯起始订单数不能重复' });
    }
  });

export const PublishPartnerProgramSchema = PartnerProgramDraftSchema.extend({
  effectiveAt: z.iso.datetime().optional(),
});

export const AcceptPartnerProgramSchema = z.object({
  programVersionId: z.uuid(),
  expectedPartnerVersion: z.number().int().positive(),
});

export const AdminEnablePartnerSchema = z
  .object({
    customerUserId: z.uuid().optional(),
    customerPublicUserId: z.number().int().min(101).optional(),
    mobile: MainlandMobileSchema.optional(),
    displayName: z.string().trim().max(80).optional(),
    company: z.string().trim().max(160).optional(),
    title: z.string().trim().max(100).optional(),
    personalRateBps: z.number().int().min(0).max(10_000).nullable().default(null),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).default(0),
    internalNote: z.string().trim().max(2000).default(''),
    sendInvitation: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    const identityCount = [value.customerUserId, value.customerPublicUserId, value.mobile].filter(
      (identity) => identity !== undefined,
    ).length;
    if (identityCount !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['mobile'],
        message: '手机号、用户编号和内部用户标识只能指定一项',
      });
    }
    if (value.mobile && !value.sendInvitation) {
      context.addIssue({
        code: 'custom',
        path: ['sendInvitation'],
        message: '手机号邀请必须发送合作伙伴通知',
      });
    }
  });

export const AdminBatchEnablePartnersSchema = z
  .object({
    customerUserIds: z.array(z.uuid()).max(200).default([]),
    customerPublicUserIds: z.array(z.number().int().min(101)).max(200).default([]),
    personalRateBps: z.number().int().min(0).max(10_000).nullable().default(null),
    sendInvitation: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    const count = value.customerUserIds.length + value.customerPublicUserIds.length;
    if (count < 1 || count > 200) {
      context.addIssue({
        code: 'custom',
        path: ['customerUserIds'],
        message: '每次需要选择 1 至 200 位用户',
      });
    }
  });

export const AdminUpdatePartnerSchema = z.object({
  expectedVersion: z.number().int().positive(),
  qualificationStatus: PartnerQualificationStatusSchema.optional(),
  attributionEnabled: z.boolean().optional(),
  settlementHold: z.boolean().optional(),
  settlementHoldReason: z.string().trim().max(1000).optional(),
  personalRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  internalNote: z.string().trim().max(2000).optional(),
});

export const AdminEditPartnerDetailsSchema = z.object({
  expectedVersion: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(80),
  company: OptionalPublicText(160),
  title: OptionalPublicText(100),
  industry: OptionalPublicText(80),
  businessIntro: OptionalPublicText(2000),
  businessUrl: OptionalHttpUrl,
  personalRateBps: z.number().int().min(0).max(10_000).nullable(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).default(0),
  internalNote: z.string().trim().max(2000).default(''),
});

export const PartnerListQuerySchema = z.object({
  event: z.string().trim().min(3).max(100),
  cursor: z.string().trim().max(240).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export const AdminPartnerListQuerySchema = z.object({
  cursor: z.string().trim().max(240).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  query: z.string().trim().max(120).default(''),
  status: PartnerQualificationStatusSchema.optional(),
});

export const PartnerCommissionListQuerySchema = z.object({
  cursor: z.string().trim().max(240).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  status: PartnerCommissionStatusSchema.optional(),
});

export const CreatePartnerPayoutSchema = z.object({
  amount: z.number().int().safe().positive().max(1_000_000_000),
  recipientId: z.uuid(),
  idempotencyKey: z.string().trim().min(12).max(160),
});

export const ConfirmPartnerPayoutSchema = z.object({
  expectedVersion: z.number().int().positive(),
  acceptedGrossAmount: z.number().int().safe().nonnegative().max(1_000_000_000),
  acceptedTaxAmount: z.number().int().safe().nonnegative().max(1_000_000_000),
  acceptedNetAmount: z.number().int().safe().nonnegative().max(1_000_000_000),
});

export const BindPartnerRecipientSchema = z.object({
  type: z.enum(['individual', 'organization']),
  channel: z.enum(['manual_bank', 'wechat_transfer']),
  displayName: z.string().trim().min(1).max(120),
  accountReference: z.string().trim().min(1).max(240),
  idempotencyKey: z.string().trim().min(12).max(160),
});

export const StartPartnerWechatRecipientBindingSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
});

export const CompletePartnerWechatRecipientBindingSchema = z.object({
  handoffCode: z.string().trim().min(16).max(128),
});

export const CreatePartnerInquirySchema = z.object({
  type: z.enum(['missing_order', 'amount_dispute']),
  orderReference: z.string().trim().min(4).max(80),
  purchasedAt: z.iso.datetime().optional(),
  description: z.string().trim().min(10).max(4000),
  evidenceAssetIds: z.array(z.uuid()).max(10).default([]),
});

export const ResolvePartnerInquirySchema = z.object({
  expectedVersion: z.number().int().positive(),
  decision: z.enum(['explained', 'rejected', 'credit_adjustment', 'debit_adjustment']),
  reason: z.string().trim().min(5).max(4000),
  adjustmentAmount: z.number().int().safe().positive().max(1_000_000_000).optional(),
});

export const CreatePartnerCommissionAdjustmentSchema = z.object({
  partnerId: z.uuid(),
  inquiryId: z.uuid().optional(),
  expectedVersion: z.number().int().positive().default(1),
  amount: z
    .number()
    .int()
    .safe()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((value) => value !== 0, '调整金额不能为 0'),
  reason: z.string().trim().min(5).max(2000),
});

export const CreatePartnerPayoutBatchSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(500),
  channel: z.enum(['manual_bank', 'wechat_transfer']),
  cutoffAt: z.iso.datetime(),
  idempotencyKey: z.string().trim().min(12).max(160),
});

export const ReviewPartnerPayoutSchema = z.object({
  expectedVersion: z.number().int().positive(),
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(5).max(2000),
  taxAmount: z.number().int().safe().nonnegative().max(1_000_000_000).optional(),
});

export const ConfirmPartnerPayoutSettlementSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const ApprovePartnerPayoutBatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  decision: z.enum(['approve', 'hold', 'cancel']),
  reason: z.string().trim().min(5).max(2000),
});

export const CompleteManualPartnerPayoutSchema = z.object({
  expectedVersion: z.number().int().positive(),
  externalReference: z.string().trim().min(4).max(160),
  paidAt: z.iso.datetime(),
  documentAssetId: z.uuid().nullable().default(null),
});

export const ExecutePartnerPayoutBatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const QueryPartnerPayoutExecutionSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const PartnerMediaUploadSchema = z.object({
  kind: z.enum(['avatar', 'gallery']),
  fileName: z.string().trim().min(1).max(180),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const PartnerMediaConfirmSchema = z.object({
  uploadToken: z.uuid(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const PreparePartnerPayoutDocumentSchema = z.object({
  payoutRequestId: z.uuid(),
  kind: z.enum(['settlement_statement', 'tax_document', 'manual_receipt', 'wechat_receipt']),
  fileName: z.string().trim().min(1).max(180),
  mediaType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const ConfirmPartnerPayoutDocumentSchema = z.object({
  uploadToken: z.string().min(40).max(4000),
});

export const ResolvePartnerReconciliationSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

export const CreatePartnerReconciliationSchema = z
  .object({
    kind: z.enum(['payments', 'refunds', 'payouts']).default('payouts'),
    batchId: z.uuid().nullable().default(null),
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    checkedCount: z.number().int().safe().nonnegative().max(10_000_000),
    differenceCount: z.number().int().safe().nonnegative().max(10_000_000),
    differenceAmount: z.number().int().safe().min(-1_000_000_000).max(1_000_000_000),
    evidenceReference: z.string().trim().min(3).max(240),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/i),
    note: z.string().trim().max(1000).default(''),
  })
  .superRefine((value, context) => {
    if (new Date(value.windowStart).getTime() >= new Date(value.windowEnd).getTime()) {
      context.addIssue({
        code: 'custom',
        path: ['windowEnd'],
        message: '对账结束时间必须晚于开始时间',
      });
    }
    if (value.differenceCount > value.checkedCount) {
      context.addIssue({
        code: 'custom',
        path: ['differenceCount'],
        message: '差异笔数不能超过检查笔数',
      });
    }
    if ((value.differenceCount === 0) !== (value.differenceAmount === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['differenceAmount'],
        message: '差异笔数和差异金额必须同时为零或同时非零',
      });
    }
  });

export const PartnerTransferConfigurationSchema = z
  .object({
    enabled: z.boolean().default(false),
    sceneId: z.literal('1005').default('1005'),
    jobType: z.string().trim().min(1).max(32).default('推广合作伙伴'),
    remunerationDescription: z.string().trim().min(1).max(32).default('大会推广佣金'),
    payoutCadence: z.enum(['weekly', 'monthly']).default('weekly'),
    singleTransferLimit: z.number().int().safe().positive().max(1_000_000_000).default(20_000),
    dailyUserLimit: z.number().int().safe().positive().max(1_000_000_000).default(200_000),
    dailyMerchantLimit: z
      .number()
      .int()
      .safe()
      .positive()
      .max(9_000_000_000_000)
      .default(5_000_000),
    monthlyMerchantLimit: z
      .number()
      .int()
      .safe()
      .positive()
      .max(9_000_000_000_000)
      .default(3_000_000_000),
    verifiedAt: z.iso.datetime().nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.dailyUserLimit < value.singleTransferLimit) {
      context.addIssue({
        code: 'custom',
        path: ['dailyUserLimit'],
        message: '单用户单日上限不能低于单笔上限',
      });
    }
    if (value.dailyMerchantLimit < value.singleTransferLimit) {
      context.addIssue({
        code: 'custom',
        path: ['dailyMerchantLimit'],
        message: '商户单日上限不能低于单笔上限',
      });
    }
    if (value.monthlyMerchantLimit < value.dailyMerchantLimit) {
      context.addIssue({
        code: 'custom',
        path: ['monthlyMerchantLimit'],
        message: '商户月度上限不能低于商户单日上限',
      });
    }
  });

export const UpdatePartnerTransferConfigurationSchema = PartnerTransferConfigurationSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
});

export type PartnerQualificationStatus = z.infer<typeof PartnerQualificationStatusSchema>;
export type PartnerPublicStatus = z.infer<typeof PartnerPublicStatusSchema>;
export type PartnerRecipientStatus = z.infer<typeof PartnerRecipientStatusSchema>;
export type PartnerCommissionStatus = z.infer<typeof PartnerCommissionStatusSchema>;
export type PartnerPayoutStatus = z.infer<typeof PartnerPayoutStatusSchema>;
export type MerchantTransferState = z.infer<typeof MerchantTransferStateSchema>;
export type PartnerVisibleFields = z.infer<typeof PartnerVisibleFieldsSchema>;
export type UpdatePartnerProfile = z.infer<typeof UpdatePartnerProfileSchema>;
export type UpdatePartnerPrivacy = z.infer<typeof UpdatePartnerPrivacySchema>;
export type PartnerProgramDraft = z.infer<typeof PartnerProgramDraftSchema>;
export type PublishPartnerProgram = z.infer<typeof PublishPartnerProgramSchema>;
export type AdminEnablePartner = z.infer<typeof AdminEnablePartnerSchema>;
export type AdminUpdatePartner = z.infer<typeof AdminUpdatePartnerSchema>;
export type AdminEditPartnerDetails = z.infer<typeof AdminEditPartnerDetailsSchema>;
export type PartnerTransferConfiguration = z.infer<typeof PartnerTransferConfigurationSchema>;

export interface PartnerProgramVersionView extends PartnerProgramDraft {
  id: string;
  version: number;
  status: 'draft' | 'scheduled' | 'active' | 'retired';
  contentHash: string;
  effectiveAt: string | null;
  createdAt: string;
}

export interface PartnerProfileView {
  posterCopy?: PartnerPosterCopy;
  version: number;
  displayName: string;
  company: string;
  title: string;
  industry: string;
  businessIntro: string;
  businessUrl: string;
  contactPhone: string;
  contactEmail: string;
  wechatId: string;
  avatarUrl: string | null;
  gallery: Array<{ assetId: string; url: string; alt: string }>;
  publicStatus: PartnerPublicStatus;
  visibleFields: PartnerVisibleFields;
  posterFields: PartnerVisibleFields;
  searchIndexingEnabled: boolean;
}

export interface PartnerPromotionStats {
  visits: number;
  uniqueDailyVisits: number;
  paidOrders: number;
  netSalesAmount: number;
  netCommissionAmount: number;
}

export interface PartnerRelationshipView {
  promotion?: PartnerPromotionStats;
  directoryEnabled?: boolean;
  id: string;
  eventId: number;
  eventSlug: string;
  eventName: string;
  publicSlug: string;
  referralCode: string;
  referralPath: string;
  qualificationStatus: PartnerQualificationStatus;
  attributionEnabled: boolean;
  settlementHold: boolean;
  currentProgram: PartnerProgramVersionView | null;
  acceptedProgramVersionId: string | null;
  personalRateBps: number | null;
  balances: {
    pending: number;
    available: number;
    reserved: number;
    paid: number;
    recoveryDue: number;
    currency: 'CNY';
  };
  profile: PartnerProfileView;
  version: number;
}

export interface AdminPartnerRelationshipView extends PartnerRelationshipView {
  loginMobile: string;
  sortOrder: number;
  internalNote: string;
}

export interface AdminEnablePartnerResult extends PartnerRelationshipView {
  created: boolean;
}

export interface PublicPartnerSummary {
  publicSlug: string;
  displayName: string;
  company: string;
  title: string;
  industry: string;
  businessIntro: string;
  avatarUrl: string | null;
  searchIndexingEnabled: boolean;
}

export interface PublicPartnerDetail extends PublicPartnerSummary {
  posterCopy?: PartnerPosterCopy;
  businessUrl?: string;
  contactPhone?: string;
  contactEmail?: string;
  wechatId?: string;
  gallery: Array<{ url: string; alt: string }>;
  posterFields: PartnerVisibleFields;
  referralPath: string;
  event: { id: number; slug: string; name: string; startsAt: string; endsAt: string; city: string };
}

export interface CustomerPartnerInquiryView {
  id: string;
  type: 'missing_order' | 'amount_dispute';
  status: 'open' | 'under_review' | 'resolved' | 'rejected';
  orderReference: string;
  purchasedAt: string | null;
  description: string;
  decision: string | null;
  decisionReason: string | null;
  adjustmentAmount: number | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerPartnerInquiryList {
  items: CustomerPartnerInquiryView[];
  hasMore: boolean;
}

export interface PartnerPayoutChannelAvailability {
  channel: 'manual_bank' | 'wechat_transfer';
  enabled: boolean;
  reason: string | null;
}

export interface CustomerPartnerPayoutList {
  requests: Array<Record<string, unknown>>;
  recipients: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  channels: PartnerPayoutChannelAvailability[];
}
