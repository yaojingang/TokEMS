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
    amount: z.number().int().positive(),
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
export const VerifyExternalRefundSchema = z
  .object({
    outRefundNo: z.string().regex(/^[A-Za-z0-9_\-|@]{1,64}$/u),
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
export const RefundContextSchema = z.object({
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
