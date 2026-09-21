import type {
  CustomerPartnerInquiryList,
  CustomerPartnerInquiryView,
  PartnerPayoutChannelAvailability,
} from '@conference/contracts';
import { partnerCommissionInquiries, type ConferenceDatabase } from '@conference/database';
import { and, desc, eq } from 'drizzle-orm';

const inquiryFields = {
  id: partnerCommissionInquiries.id,
  type: partnerCommissionInquiries.type,
  status: partnerCommissionInquiries.status,
  orderReference: partnerCommissionInquiries.orderReference,
  purchasedAt: partnerCommissionInquiries.purchasedAt,
  description: partnerCommissionInquiries.description,
  decision: partnerCommissionInquiries.decision,
  decisionReason: partnerCommissionInquiries.decisionReason,
  adjustmentAmount: partnerCommissionInquiries.adjustmentAmount,
  resolvedAt: partnerCommissionInquiries.resolvedAt,
  createdAt: partnerCommissionInquiries.createdAt,
  updatedAt: partnerCommissionInquiries.updatedAt,
};

type InquiryRow = Pick<typeof partnerCommissionInquiries.$inferSelect, keyof typeof inquiryFields>;

export function mapCustomerPartnerInquiry(row: InquiryRow): CustomerPartnerInquiryView {
  const terminal = row.status === 'resolved' || row.status === 'rejected';
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    orderReference: row.orderReference,
    purchasedAt: row.purchasedAt?.toISOString() ?? null,
    description: row.description,
    decision: terminal ? row.decision : null,
    decisionReason: terminal ? row.decisionReason : null,
    adjustmentAmount: terminal ? row.adjustmentAmount : null,
    resolvedAt: terminal ? (row.resolvedAt?.toISOString() ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function readCustomerPartnerInquiries(
  db: ConferenceDatabase,
  scope: { organizationId: string; eventId: number; partnerId: string; customerUserId: string },
): Promise<CustomerPartnerInquiryList> {
  const rows = await db
    .select(inquiryFields)
    .from(partnerCommissionInquiries)
    .where(
      and(
        eq(partnerCommissionInquiries.organizationId, scope.organizationId),
        eq(partnerCommissionInquiries.eventId, scope.eventId),
        eq(partnerCommissionInquiries.partnerId, scope.partnerId),
        eq(partnerCommissionInquiries.customerUserId, scope.customerUserId),
      ),
    )
    .orderBy(desc(partnerCommissionInquiries.createdAt), desc(partnerCommissionInquiries.id))
    .limit(101);
  return { items: rows.slice(0, 100).map(mapCustomerPartnerInquiry), hasMore: rows.length > 100 };
}

export function customerPayoutChannels(transfer: {
  configuration: { enabled: boolean; verifiedAt: string | null };
  merchantConfigured: boolean;
  status: string;
}): PartnerPayoutChannelAvailability[] {
  const wechatEnabled =
    transfer.configuration.enabled &&
    Boolean(transfer.configuration.verifiedAt) &&
    transfer.merchantConfigured &&
    transfer.status === 'verified';
  return [
    { channel: 'manual_bank', enabled: true, reason: null },
    {
      channel: 'wechat_transfer',
      enabled: wechatEnabled,
      reason: wechatEnabled ? null : '主办方暂未开通微信转账，请使用银行账户结算。',
    },
  ];
}
