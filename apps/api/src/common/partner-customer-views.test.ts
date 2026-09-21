import { describe, expect, it } from 'vitest';
import { customerPayoutChannels, mapCustomerPartnerInquiry } from './partner-customer-views.js';

const inquiry = {
  id: 'inquiry-1',
  type: 'amount_dispute' as const,
  status: 'under_review' as const,
  orderReference: 'ORDER-123',
  purchasedAt: null,
  description: '订单金额需要重新核实',
  decision: 'credit_adjustment',
  decisionReason: '申请补发佣金，等待第二人复核',
  adjustmentAmount: 100_000,
  resolvedAt: null,
  createdAt: new Date('2026-09-17T00:00:00Z'),
  updatedAt: new Date('2026-09-17T01:00:00Z'),
  resolvedBy: 'private-staff-id',
  adjustmentProposedBy: 'private-proposer-id',
  evidenceAssetIds: ['private-asset-id'],
};

const verifiedTransfer = {
  configuration: { enabled: true, verifiedAt: '2026-09-17T00:00:00Z' },
  merchantConfigured: true,
  status: 'verified',
};

describe('customer partner financial views', () => {
  it('keeps pending second-review outcomes and staff identifiers private', () => {
    const view = mapCustomerPartnerInquiry(inquiry);
    expect(view.status).toBe('under_review');
    expect(view.decision).toBeNull();
    expect(view.decisionReason).toBeNull();
    expect(view.adjustmentAmount).toBeNull();
    expect(view).not.toHaveProperty('resolvedBy');
    expect(view).not.toHaveProperty('adjustmentProposedBy');
    expect(view).not.toHaveProperty('evidenceAssetIds');
    expect(view.createdAt).toBe('2026-09-17T00:00:00.000Z');
  });

  it('shows the final response and signed adjustment after resolution', () => {
    const view = mapCustomerPartnerInquiry({ ...inquiry, status: 'resolved', adjustmentAmount: -500,
      decision: 'debit_adjustment', decisionReason: '已核实并冲正多计佣金', resolvedAt: inquiry.updatedAt });
    expect(view.decisionReason).toBe('已核实并冲正多计佣金');
    expect(view.adjustmentAmount).toBe(-500);
    expect(view.resolvedAt).toBe('2026-09-17T01:00:00.000Z');
  });

  it.each([
    { ...verifiedTransfer, configuration: { ...verifiedTransfer.configuration, enabled: false } },
    { ...verifiedTransfer, configuration: { ...verifiedTransfer.configuration, verifiedAt: null } },
    { ...verifiedTransfer, merchantConfigured: false },
    { ...verifiedTransfer, status: 'unconfigured' },
  ])('offers manual settlement when a WeChat capability gate is missing', (transfer) => {
    expect(customerPayoutChannels(transfer)).toEqual([
      { channel: 'manual_bank', enabled: true, reason: null },
      { channel: 'wechat_transfer', enabled: false, reason: expect.stringContaining('暂未开通') },
    ]);
  });

  it('exposes only capability metadata when WeChat is enabled', () => {
    expect(customerPayoutChannels(verifiedTransfer)[1]).toEqual({
      channel: 'wechat_transfer', enabled: true, reason: null,
    });
  });
});
