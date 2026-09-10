import { z } from 'zod';

export const InvoiceSmsPolicySchema = z.object({
  deliveryMode: z.enum(['legacy', 'direct_file_v1']).default('legacy'),
  activationRevision: z.number().int().nonnegative().default(0),
  enabledAt: z.string().nullable().default(null),
  verifiedFingerprint: z.string().nullable().default(null),
  testDeliveryId: z.string().nullable().default(null),
  verifiedOrigin: z.string().nullable().default(null),
});
export type InvoiceSmsPolicy = z.infer<typeof InvoiceSmsPolicySchema>;
export const InvoiceSmsNotificationSchema = z.object({
  enabled: z.boolean(),
  status: z.string(),
  reason: z.string().nullable(),
  maskedRecipient: z.string().nullable(),
  nextMaskedRecipient: z.string().nullable().optional(),
  recipientSource: z.string().nullable(),
  deliveryId: z.string().nullable(),
  queuedAt: z.string().nullable(),
  attemptedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  canSend: z.boolean(),
  canForceSend: z.boolean(),
  canRevoke: z.boolean(),
  retryAfterSeconds: z.number().int().nonnegative(),
});
export type InvoiceSmsNotification = z.infer<typeof InvoiceSmsNotificationSchema>;
export const InvoiceSmsSendSchema = z
  .object({
    forceAfterUncertain: z.boolean().default(false),
    reason: z.string().trim().max(500).default(''),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.forceAfterUncertain && value.reason.length < 4) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: '结果未知时再次发送需要填写至少 4 字的原因',
      });
    }
  });
export const InvoiceAccessRevokeSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime(),
    reason: z.string().trim().min(4).max(500),
    resend: z.boolean().default(false),
  })
  .strict();
export const InvoiceSmsTestStatusSchema = z.object({
  deliveryId: z.string(),
  status: z.string(),
  maskedPhone: z.string(),
  error: z.string().nullable(),
  configurationMatches: z.boolean(),
  fileReachable: z.boolean(),
  ready: z.boolean(),
});
export type InvoiceSmsTestStatus = z.infer<typeof InvoiceSmsTestStatusSchema>;
