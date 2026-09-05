import { z } from 'zod';
import { EventRefundPolicySchema } from '@conference/contracts';
import { HttpStatus } from '@nestjs/common';
import { DomainError } from './domain-error.js';

export const REFUND_RETRY_MS = 5 * 60_000;
export const REFUND_REVIEW_SLA_MS = 24 * 60 * 60_000;
export const REFUND_CHANNEL_WINDOW_MS = 365 * 24 * 60 * 60_000;
export const REFUND_QUERY_STATES = [
  'submitting',
  'query_pending',
  'processing',
  'abnormal',
] as const;
export const REFUND_SUBMIT_STATES = ['queued', 'waiting_funds'] as const;

export function refundPolicy(settings: Record<string, unknown>) {
  const parsed = EventRefundPolicySchema.safeParse(settings.refunds);
  return parsed.success ? parsed.data : EventRefundPolicySchema.parse({ enabled: false });
}

export function refundDeadline(paidAt: Date | null, days = 7): Date | null {
  return paidAt ? new Date(paidAt.getTime() + days * 86_400_000) : null;
}

export function refundQueryDelay(acceptedAt: Date | null, now = new Date()) {
  const elapsed = acceptedAt ? now.getTime() - acceptedAt.getTime() : 0;
  if (elapsed < 5 * 60_000) return 60_000;
  if (elapsed < 10 * 60_000) return 5 * 60_000;
  if (elapsed < 20 * 60_000) return 10 * 60_000;
  if (elapsed < 40 * 60_000) return 20 * 60_000;
  return 30 * 60_000;
}

export const WeChatRefundOutcomeSchema = z.object({
  refund_id: z.string().min(1).max(64),
  out_refund_no: z.string().min(1).max(64),
  transaction_id: z.string().min(1).max(64),
  out_trade_no: z.string().min(1).max(64),
  status: z.enum(['SUCCESS', 'PROCESSING', 'CLOSED', 'ABNORMAL']),
  channel: z.enum(['ORIGINAL', 'BALANCE', 'OTHER_BALANCE', 'OTHER_BANKCARD']),
  user_received_account: z.string().max(200),
  create_time: z.iso.datetime({ offset: true }),
  success_time: z.iso.datetime({ offset: true }).optional(),
  amount: z.object({
    total: z.number().int().positive(),
    refund: z.number().int().positive(),
    payer_total: z.number().int().nonnegative().optional(),
    payer_refund: z.number().int().nonnegative().optional(),
    discount_refund: z.number().int().nonnegative().optional(),
    currency: z.literal('CNY'),
  }),
});
export type WeChatRefundOutcome = z.infer<typeof WeChatRefundOutcomeSchema>;

/** Classify only documented destinations. Unrecognized destinations require reconciliation. */
export function refundRecipient(result: WeChatRefundOutcome): 'payer' | 'merchant' | 'unknown' {
  const account = result.user_received_account;
  if (account.includes('商户基本账户') || account.includes('商户结算银行账户')) return 'merchant';
  if (!account) return 'unknown';
  if (result.channel === 'ORIGINAL') return 'payer';
  if (/支付用户|用户经营账户|信用卡|借记卡|储蓄卡|微银通/u.test(account)) return 'payer';
  return 'unknown';
}

export class RefundGatewayError extends DomainError {
  constructor(
    code: string,
    readonly knownRejected: boolean,
    readonly httpStatus?: number,
    readonly verifiedResponse = false,
  ) {
    super(
      code,
      refundErrorMessage(code),
      knownRejected ? HttpStatus.CONFLICT : HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

export function refundErrorMessage(code: string) {
  const messages: Record<string, string> = {
    NOT_ENOUGH: '退款出资账户资金不足，系统将继续重试',
    NO_AUTH: '商户退款权限不可用，请核对商户配置',
    SIGN_ERROR: '退款签名验证失败，请核对商户凭据',
    PARAM_ERROR: '退款参数被渠道拒绝，需要人工核验',
    INVALID_REQUEST: '渠道拒绝退款请求，需要核对交易期限、次数和金额',
    USER_ACCOUNT_ABNORMAL: '原付款账户异常，需要财务在微信商户平台处理',
    RESOURCE_NOT_EXISTS: '微信尚未查询到该退款单',
    MERCHANT_MISMATCH: '原支付商户与当前配置不一致',
    REFUND_NOT_CONFIGURED: '尚未确认微信退款出资配置',
  };
  return messages[code] ?? '退款结果暂未确认，系统将继续核验';
}

export function channelReason(reason: string) {
  let result = '';
  for (const character of reason.trim() || '用户申请退款') {
    if (Buffer.byteLength(result + character, 'utf8') > 80) break;
    result += character;
  }
  return result;
}
