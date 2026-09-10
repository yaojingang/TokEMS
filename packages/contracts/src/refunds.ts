import { z } from 'zod';

export const EventRefundPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    version: z.string().trim().min(1).max(80).default('seven-day-v1'),
    windowDays: z.literal(7).default(7),
  })
  .strict();

export const CustomerRefundApplicationSchema = z
  .object({
    amount: z.number().int().positive().optional(),
    selectedItemIds: z
      .array(z.uuid())
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    contextVersion: z.string().min(1).max(128).optional(),
    policyVersion: z.string().trim().min(1).max(80),
    reason: z.string().trim().max(1000).default(''),
  })
  .strict();
export const RefundVersionSchema = z.object({ version: z.number().int().positive() }).strict();
export const RejectRefundApplicationSchema = RefundVersionSchema.extend({
  reason: z.string().trim().min(2).max(1000),
}).strict();
export const RefundExecutionModeSchema = z
  .object({
    mode: z.enum(['automatic', 'external_hold']),
    reason: z.string().trim().min(2).max(1000),
  })
  .strict();
export const ExternalRefundAllocationSchema = z
  .object({
    orderItemId: z.uuid(),
    amount: z.number().int().positive(),
    rightsEffect: z.enum(['retain', 'revoke']),
  })
  .strict();
export const AdminItemRefundSchema = z.object({
  contextVersion: z.string().min(1).max(128),
  reason: z.string().trim().min(2).max(1000),
  allocations: z.array(ExternalRefundAllocationSchema.extend({ version: z.number().int().positive() })).min(1).max(20).refine((items) => new Set(items.map((item) => item.orderItemId)).size === items.length),
}).strict();
export type AdminItemRefund = z.infer<typeof AdminItemRefundSchema>;
export type ExternalRefundAllocation = z.infer<typeof ExternalRefundAllocationSchema>;
export const VerifyExternalRefundSchema = z
  .object({
    outRefundNo: z.string().regex(/^[A-Za-z0-9_\-|@]{1,64}$/u),
    allocations: z.array(ExternalRefundAllocationSchema).min(1).max(20).optional(),
  })
  .strict();
export const RefundApplicationQuerySchema = z.object({
  status: z
    .enum(['all', 'pending_review', 'waiting_funds', 'processing', 'attention', 'completed'])
    .default('all'),
  orderId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const RefundApplicationViewSchema = z.object({
  selectedItemIds: z.array(z.string()).default([]),
  id: z.string(),
  orderId: z.string(),
  eventId: z.number().int(),
  amount: z.number().int(),
  completedAmount: z.number().int(),
  currency: z.string(),
  reviewStatus: z.enum(['pending_review', 'approved', 'rejected', 'withdrawn']),
  fulfillmentStatus: z.enum(['open', 'completed', 'manual_required']).nullable(),
  executionStatus: z.string().nullable(),
  reason: z.string(),
  reviewReason: z.string().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  version: z.number().int(),
  fullRefund: z.boolean(),
  payerTotal: z.number().int().nullable(),
  payerRefund: z.number().int().nullable(),
  discountRefund: z.number().int().nullable(),
});
export const RefundContextItemSchema = z.object({
  id: z.string(),
  registrationId: z.string(),
  name: z.string(),
  ticketName: z.string(),
  refundableAmount: z.number().int(),
  eligible: z.boolean(),
  blockedReason: z.string().nullable(),
  version: z.number().int(),
});
export const RefundContextSchema = z.object({
  quantity: z.number().int(),
  contextVersion: z.string(),
  items: z.array(RefundContextItemSchema),
  orderId: z.string(),
  orderNo: z.string(),
  eventId: z.number().int(),
  eventName: z.string(),
  ticketName: z.string(),
  attendeeName: z.string(),
  paymentMethod: z.string(),
  paidAmount: z.number().int(),
  payerTotal: z.number().int().nullable(),
  refundedAmount: z.number().int(),
  refundableAmount: z.number().int(),
  currency: z.string(),
  eligible: z.boolean(),
  blockedReason: z.string().nullable(),
  policyVersion: z.string(),
  deadline: z.string().nullable(),
  applications: z.array(RefundApplicationViewSchema),
});
export type CustomerRefundApplication = z.infer<typeof CustomerRefundApplicationSchema>;
export type RefundApplicationQuery = z.infer<typeof RefundApplicationQuerySchema>;
export type RefundApplicationView = z.infer<typeof RefundApplicationViewSchema>;
export type RefundContext = z.infer<typeof RefundContextSchema>;
export type EventRefundPolicy = z.infer<typeof EventRefundPolicySchema>;

export type AdminRefundApplicationView = RefundApplicationView & {
  orderNo: string;
  executionMode: string;
  attentionReason: string | null;
  executions: Array<{
    id: string;
    refundNo: string;
    status: string;
    channelStatus: string | null;
    amount: number;
    recipientKind: string | null;
    lastError: string | null;
    nextAttemptAt: string | null;
    acceptedAt: string | null;
    fulfillmentAttention: string | null;
    currentAttempt: boolean;
  }>;
};
