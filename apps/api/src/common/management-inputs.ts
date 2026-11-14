import { z } from 'zod';
import {
  InvoiceActionSchema,
  HtmlTemplateBindingManifestSchema,
  ConferenceTemplateDefinitionSchema,
} from '@conference/contracts';
export const SpeakerImageSchema = z.object({
  storageKey: z.string().trim().min(3).max(500),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  contentDigest: z.string().trim().min(16).max(128),
  altText: z.string().trim().max(500).default(''),
});

export const PrepareSpeakerImageUploadSchema = SpeakerImageSchema.pick({
  mediaType: true,
  size: true,
  contentDigest: true,
  altText: true,
}).extend({ fileName: z.string().trim().min(1).max(240) });

const sessionInputFields = {
  day: z.number().int().min(1).max(30),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  title: z.string().trim().min(1).max(240),
  summary: z.string().max(2000).optional(),
  speaker: z.string().max(160).optional(),
  kind: z.enum(['talk', 'break', 'workshop']).default('talk'),
  sortOrder: z.number().int().min(0).default(0),
};

const validSessionRange = (session: {
  startsAt?: string | undefined;
  endsAt?: string | undefined;
}) => !session.startsAt || !session.endsAt || new Date(session.endsAt) > new Date(session.startsAt);

export const SessionInputSchema = z
  .object(sessionInputFields)
  .refine(validSessionRange, { path: ['endsAt'], message: '议程结束时间必须晚于开始时间' });
export const SessionPatchSchema = z
  .object(sessionInputFields)
  .partial()
  .refine(validSessionRange, {
    path: ['endsAt'],
    message: '议程结束时间必须晚于开始时间',
  });

export const DeviceInputSchema = z.object({
  deviceCode: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(120),
});

export const TicketTypeInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_]+$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  price: z.number().int().nonnegative(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('CNY'),
  capacity: z.number().int().positive(),
  recommended: z.boolean().default(false),
  benefits: z.array(z.string().max(120)).max(30).default([]),
});

export const ArchiveSchema = z.object({ revision: z.number().int().nonnegative() });
export const DuplicateSchema = z.object({
  revision: z.number().int().nonnegative(),
  name: z.string().trim().min(2).max(160).optional(),
});
export const AssetSchema = z.object({
  storageKey: z.string().trim().min(3).max(500),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  contentDigest: z.string().trim().min(16).max(128),
  altText: z.string().trim().max(500).default(''),
});
export const PrepareTemplateAssetUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  contentDigest: z.string().trim().min(16).max(128),
  altText: z.string().trim().max(500).default(''),
});
export const PrepareInvoiceDocumentUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  mediaType: z.enum(['application/pdf', 'application/ofd']),
  size: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  contentDigest: z.string().trim().min(16).max(128),
  replaceDocumentId: z.string().uuid().optional(),
});
export const ReplaceInvoiceDocumentFileSchema = InvoiceActionSchema.extend({
  storageKey: z.string().trim().min(3).max(500),
  mediaType: z.enum(['application/pdf', 'application/ofd']),
  size: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  contentDigest: z.string().trim().min(16).max(128),
});
export const SaveEventAsTemplateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().min(2).max(2000),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  includeContent: z.boolean().default(false),
});
export const PrepareHtmlImportSchema = z
  .object({
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/\.html?$/iu),
    size: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024),
    sourceDigest: z
      .string()
      .trim()
      .regex(/^(?:sha256:)?[a-f0-9]{64}$/iu),
    mode: z.enum(['create', 'replace']).default('create'),
    templateId: z.string().uuid().optional(),
    requestedMetadata: z
      .object({
        name: z.string().trim().min(2).max(160).optional(),
        description: z.string().trim().min(2).max(2000).optional(),
        tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
        sourceUrl: z.url().max(1000).optional(),
      })
      .default({}),
  })
  .superRefine((value, context) => {
    if (value.mode === 'replace' && !value.templateId) {
      context.addIssue({ code: 'custom', path: ['templateId'], message: '替换模式需要模板 ID' });
    }
  });
export const CommitHtmlImportSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  bindings: HtmlTemplateBindingManifestSchema,
  confirmWarnings: z.boolean().default(false),
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().min(2).max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});
export const SaveHtmlBindingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  bindings: HtmlTemplateBindingManifestSchema,
});
export const ApplyHtmlAiProposalsSchema = z.object({
  proposalIds: z.array(z.string().min(1).max(120)).min(1).max(400),
});

export const TemplateCandidatePreviewSchema = z
  .object({
    eventId: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    definition: ConferenceTemplateDefinitionSchema.optional(),
  })
  .strict();
