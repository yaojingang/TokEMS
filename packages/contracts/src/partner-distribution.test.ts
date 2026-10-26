import { describe, expect, it } from 'vitest';
import {
  AdminEditPartnerDetailsSchema,
  AdminEnablePartnerSchema,
  ConfirmPartnerPayoutSettlementSchema,
  CreatePartnerCommissionAdjustmentSchema,
  CreatePartnerPayoutSchema,
  CreatePartnerReconciliationSchema,
  PartnerProgramDraftSchema,
  PartnerTransferConfigurationSchema,
  ReviewPartnerPayoutSchema,
  UpdatePartnerPrivacySchema,
} from './partner-distribution.js';

describe('partner distribution contracts', () => {
  it('uses the approved program defaults', () => {
    const program = PartnerProgramDraftSchema.parse({
      termsTitle: '合作伙伴规则',
      termsContent: '本规则用于大会合作伙伴推广与佣金结算。',
      promotionPolicy: '请使用真实信息推广大会。',
    });
    expect(program.fixedRateBps).toBe(1000);
    expect(program.attributionDays).toBe(30);
    expect(program.settlementDelayDays).toBe(7);
    expect(program.minimumPayoutAmount).toBe(1000);
    expect(program.payoutCadence).toBe('weekly');
  });

  it('rejects tiered rules without a tier', () => {
    expect(
      PartnerProgramDraftSchema.safeParse({
        mode: 'order_count_tiered',
        termsTitle: '合作伙伴规则',
        termsContent: '本规则用于大会合作伙伴推广与佣金结算。',
        promotionPolicy: '请使用真实信息推广大会。',
      }).success,
    ).toBe(false);
  });

  it('keeps public and poster permissions independent', () => {
    const privacy = UpdatePartnerPrivacySchema.parse({
      expectedVersion: 1,
      publicStatus: 'published',
      visibleFields: Object.fromEntries(
        [
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
        ].map((key) => [key, true]),
      ),
      posterFields: Object.fromEntries(
        [
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
        ].map((key) => [key, false]),
      ),
    });
    expect(privacy.visibleFields.contactEmail).toBe(true);
    expect(privacy.posterFields.contactEmail).toBe(false);
    expect(
      UpdatePartnerPrivacySchema.safeParse({
        ...privacy,
        visibleFields: { ...privacy.visibleFields, contactEmail: false },
        posterFields: { ...privacy.posterFields, contactEmail: true },
      }).success,
    ).toBe(false);
  });

  it('uses cents for transfer limits and rate basis points', () => {
    expect(PartnerTransferConfigurationSchema.parse({}).singleTransferLimit).toBe(20_000);
    expect(
      AdminEnablePartnerSchema.parse({ customerUserId: crypto.randomUUID() }).personalRateBps,
    ).toBeNull();
  });

  it('accepts one mobile identity for partner invitations', () => {
    expect(
      AdminEnablePartnerSchema.parse({
        mobile: ' 13800138000 ',
        displayName: ' 张三 ',
        company: ' 示例科技 ',
        title: ' 市场总监 ',
      }),
    ).toMatchObject({
      mobile: '13800138000',
      displayName: '张三',
      company: '示例科技',
      title: '市场总监',
      personalRateBps: null,
      sendInvitation: true,
    });
    expect(AdminEnablePartnerSchema.safeParse({}).success).toBe(false);
    expect(
      AdminEnablePartnerSchema.safeParse({
        mobile: '13800138000',
        customerUserId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      AdminEnablePartnerSchema.safeParse({ mobile: '13800138000', sendInvitation: false }).success,
    ).toBe(false);
  });

  it('validates the admin partner details editor payload', () => {
    expect(
      AdminEditPartnerDetailsSchema.parse({
        expectedVersion: 2,
        displayName: ' 李四 ',
        personalRateBps: 0,
      }),
    ).toMatchObject({
      displayName: '李四',
      company: '',
      title: '',
      industry: '',
      businessIntro: '',
      businessUrl: '',
      personalRateBps: 0,
      sortOrder: 0,
      internalNote: '',
    });
    expect(
      AdminEditPartnerDetailsSchema.safeParse({
        expectedVersion: 2,
        displayName: '',
        personalRateBps: null,
      }).success,
    ).toBe(false);
    expect(
      AdminEditPartnerDetailsSchema.safeParse({
        expectedVersion: 1,
        displayName: '合作伙伴',
        businessUrl: `https://example.com/${'a'.repeat(500)}`,
        personalRateBps: null,
      }).success,
    ).toBe(false);
  });

  it('keeps financial inputs inside persistent integer and merchant-limit boundaries', () => {
    expect(
      CreatePartnerPayoutSchema.safeParse({
        amount: 1_000_000_001,
        recipientId: crypto.randomUUID(),
        idempotencyKey: 'payout-too-large',
      }).success,
    ).toBe(false);
    expect(
      PartnerTransferConfigurationSchema.safeParse({
        singleTransferLimit: 20_000,
        dailyUserLimit: 10_000,
      }).success,
    ).toBe(false);
  });

  it('validates tax finalization and customer settlement confirmation', () => {
    expect(
      ReviewPartnerPayoutSchema.parse({
        expectedVersion: 2,
        decision: 'approve',
        reason: '资料与税额已经完成核验',
        taxAmount: 125,
      }).taxAmount,
    ).toBe(125);
    expect(ConfirmPartnerPayoutSettlementSchema.parse({ expectedVersion: 3 })).toEqual({
      expectedVersion: 3,
    });
  });

  it('validates ledger adjustments and reconciliations as integer financial facts', () => {
    expect(
      CreatePartnerCommissionAdjustmentSchema.parse({
        partnerId: crypto.randomUUID(),
        amount: -1250,
        reason: '人工复核后冲减重复佣金',
      }).amount,
    ).toBe(-1250);
    expect(
      CreatePartnerReconciliationSchema.parse({
        windowStart: '2026-09-01T00:00:00.000Z',
        windowEnd: '2026-09-02T00:00:00.000Z',
        checkedCount: 20,
        differenceCount: 1,
        differenceAmount: -500,
        evidenceReference: 'wechat-fund-bill-20260901',
        evidenceDigest: 'a'.repeat(64),
      }).kind,
    ).toBe('payouts');
    expect(
      CreatePartnerReconciliationSchema.safeParse({
        windowStart: '2026-09-02T00:00:00.000Z',
        windowEnd: '2026-09-01T00:00:00.000Z',
        checkedCount: 1,
        differenceCount: 0,
        differenceAmount: 500,
        evidenceReference: 'invalid-window',
        evidenceDigest: 'b'.repeat(64),
      }).success,
    ).toBe(false);
  });
  it('accepts optional atomic avatar and poster fields while preserving omissions', () => {
    const base = { expectedVersion: 1, displayName: '伙伴', personalRateBps: null };
    const original = AdminEditPartnerDetailsSchema.parse(base);
    expect(original).not.toHaveProperty('avatarAssetId');
    expect(original).not.toHaveProperty('posterCopy');
    expect(original).not.toHaveProperty('posterFields');
    const fields = { avatar: true, displayName: true, company: true, title: true, industry: false,
      businessIntro: false, businessUrl: false, contactPhone: false, contactEmail: false, wechatId: false, gallery: false };
    expect(AdminEditPartnerDetailsSchema.parse({ ...base, avatarAssetId: null, posterCopy: { invitation: '现场见', introduction: '合作交流' }, posterFields: fields })).toMatchObject({ avatarAssetId: null, posterFields: fields });
    expect(AdminEditPartnerDetailsSchema.safeParse({ ...base, avatarAssetId: 'invalid' }).success).toBe(false);
    expect(AdminEditPartnerDetailsSchema.safeParse({ ...base, posterCopy: { invitation: '<script>', introduction: '介绍' } }).success).toBe(false);
  });

});
