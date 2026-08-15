import { describe, expect, it } from 'vitest';
import {
  CustomerCreateInvoiceSchema,
  CustomerInvoiceCenterListQuerySchema,
  CustomerInvoiceCenterListSchema,
  CustomerInvoiceDetailSchema,
  CustomerInvoiceOrderContextSchema,
  CustomerUpdateInvoiceSchema,
  CustomerRegistrationListQuerySchema,
  DeleteCustomerAdminResultSchema,
  isCustomerInvoiceEditableStatus,
  OrganizationSettingsSchema,
  UpdateAccountProfileSchema,
} from './index.js';

describe('UpdateAccountProfileSchema', () => {
  it('accepts self-service profile fields without role or grant mutations', () => {
    const result = UpdateAccountProfileSchema.parse({
      name: '大会运营管理员',
      mobile: '13800138000',
      profile: {
        company: 'TokEMS Demo Team',
        title: '大会运营负责人',
        city: '深圳',
        bio: '负责大会统筹、内容发布与现场协作。',
        tags: ['大会运营', '内容管理'],
      },
    });

    expect(result.name).toBe('大会运营管理员');
    expect(result.profile.tags).toEqual(['大会运营', '内容管理']);
    expect(result).not.toHaveProperty('role');
    expect(result).not.toHaveProperty('grants');
  });

  it('rejects empty names and oversized tag collections', () => {
    const result = UpdateAccountProfileSchema.safeParse({
      name: ' ',
      mobile: null,
      profile: {
        company: null,
        title: null,
        city: null,
        bio: null,
        tags: Array.from({ length: 31 }, (_, index) => `标签${index + 1}`),
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('customer account configuration contracts', () => {
  it('accepts the customer deletion result with preserved history counts', () => {
    expect(
      DeleteCustomerAdminResultSchema.parse({
        deleted: true,
        detachedRegistrations: 2,
        detachedWaitlistEntries: 1,
      }),
    ).toEqual({
      deleted: true,
      detachedRegistrations: 2,
      detachedWaitlistEntries: 1,
    });
    expect(
      DeleteCustomerAdminResultSchema.safeParse({
        deleted: true,
        detachedRegistrations: -1,
        detachedWaitlistEntries: 0,
      }).success,
    ).toBe(false);
  });

  it('accepts bounded registration pagination and rejects malformed values', () => {
    expect(CustomerRegistrationListQuerySchema.parse({ limit: '25' })).toEqual({
      limit: 25,
    });
    expect(CustomerRegistrationListQuerySchema.safeParse({ limit: 'NaN' }).success).toBe(false);
    expect(CustomerRegistrationListQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(CustomerRegistrationListQuerySchema.safeParse({ cursor: 'x'.repeat(301) }).success).toBe(
      false,
    );
  });

  it('only accepts HTTPS agreement links exposed on the public site', () => {
    const settings = {
      brandName: '大会管理中心',
      customerAccounts: {
        termsUrl: 'https://conference.example.com/terms',
        privacyUrl: '',
      },
    };

    expect(OrganizationSettingsSchema.safeParse(settings).success).toBe(true);
    expect(
      OrganizationSettingsSchema.safeParse({
        ...settings,
        customerAccounts: {
          termsUrl: 'javascript:alert(document.domain)',
          privacyUrl: 'https://conference.example.com/privacy',
        },
      }).success,
    ).toBe(false);
    expect(
      OrganizationSettingsSchema.safeParse({
        ...settings,
        customerAccounts: {
          termsUrl: 'http://conference.example.com/terms',
          privacyUrl: '',
        },
      }).success,
    ).toBe(false);
  });

  it('keeps customer invoice editability and zero-balance details in one contract', () => {
    expect(isCustomerInvoiceEditableStatus('rejected')).toBe(true);
    expect(isCustomerInvoiceEditableStatus('pending_review')).toBe(true);
    expect(isCustomerInvoiceEditableStatus('issue_failed')).toBe(false);
    expect(
      CustomerInvoiceDetailSchema.safeParse({
        id: 'invoice-1',
        requestNo: 'INV-1',
        eventId: 101,
        eventName: '测试大会',
        orderId: 'order-1',
        orderNo: 'ORDER-1',
        registrationId: 'registration-1',
        attendeeName: '测试用户',
        buyerType: 'company',
        title: '测试公司',
        maskedTaxId: '91**********01',
        taxId: '911100001234567801',
        maskedEmail: 't***@example.com',
        email: 'test@example.com',
        maskedMobile: '138****8000',
        mobile: '13800138000',
        content: '会务费',
        amount: 0,
        currency: 'CNY',
        netPaidAmount: 0,
        status: 'cancelled',
        rejectionReason: null,
        deliveryStatus: 'not_sent',
        lastSentAt: null,
        requestedAt: new Date().toISOString(),
        reviewedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        documents: [],
        logs: [],
      }).success,
    ).toBe(true);
  });

  it('validates customer invoice center filters and server-provided actions', () => {
    expect(CustomerInvoiceCenterListQuerySchema.parse({ category: 'action_required' })).toEqual({
      category: 'action_required',
      limit: 20,
    });
    expect(CustomerInvoiceCenterListQuerySchema.safeParse({ category: 'unknown' }).success).toBe(
      false,
    );
    expect(
      CustomerInvoiceCenterListSchema.safeParse({
        items: [
          {
            orderId: 'order-1',
            orderNo: 'ORDER-1',
            eventId: 101,
            eventName: '测试大会',
            eventSlug: 'test-event',
            startsAt: new Date().toISOString(),
            orderAmount: 39900,
            eligibleAmount: 39900,
            invoiceAmount: null,
            currency: 'CNY',
            invoiceId: null,
            requestNo: null,
            title: null,
            status: null,
            category: 'eligible',
            requestedAt: null,
            updatedAt: new Date().toISOString(),
            availableActions: ['apply'],
          },
        ],
        counts: {
          all: 1,
          eligible: 1,
          actionRequired: 0,
          processing: 0,
          issued: 0,
          history: 0,
        },
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      CustomerInvoiceOrderContextSchema.safeParse({
        orderId: 'order-1',
        orderNo: 'ORDER-1',
        eventId: 101,
        eventName: '测试大会',
        startsAt: new Date().toISOString(),
        orderAmount: 39900,
        eligibleAmount: 29900,
        currency: 'CNY',
        canApply: true,
        unavailableReason: null,
      }).success,
    ).toBe(true);
    expect(
      CustomerInvoiceCenterListSchema.safeParse({
        items: [
          {
            orderId: 'order-1',
            orderNo: 'ORDER-1',
            eventId: 101,
            eventName: '测试大会',
            eventSlug: 'test-event',
            startsAt: new Date().toISOString(),
            orderAmount: 39900,
            eligibleAmount: 39900,
            invoiceAmount: null,
            currency: 'CNY',
            invoiceId: null,
            requestNo: null,
            title: null,
            status: null,
            category: 'eligible',
            requestedAt: null,
            updatedAt: new Date().toISOString(),
            availableActions: ['apply', 'resend'],
          },
        ],
        counts: {
          all: 1,
          eligible: 1,
          actionRequired: 0,
          processing: 0,
          issued: 0,
          history: 0,
        },
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it('uses separate contracts for creating and updating customer invoices', () => {
    const expectedUpdatedAt = new Date().toISOString();
    expect(
      CustomerUpdateInvoiceSchema.parse({
        companyName: '测试公司',
        taxId: '911100001234567801',
        email: 'invoice@example.com',
        expectedUpdatedAt,
      }).expectedUpdatedAt,
    ).toBe(expectedUpdatedAt);
    expect(
      CustomerCreateInvoiceSchema.safeParse({
        companyName: '测试公司',
        taxId: '911100001234567801',
        email: 'invoice@example.com',
        expectedUpdatedAt,
      }).success,
    ).toBe(false);
    expect(
      CustomerCreateInvoiceSchema.safeParse({
        companyName: '测试公司',
        taxId: '',
        email: `${'a'.repeat(250)}@example.com`,
      }).success,
    ).toBe(false);
    expect(
      CustomerCreateInvoiceSchema.safeParse({
        buyerType: 'company',
        title: '旧版企业抬头',
        taxId: '911100001234567801',
        email: 'legacy-company@example.com',
        mobile: '13800138000',
        content: '会务费',
      }).success,
    ).toBe(true);
    expect(
      CustomerCreateInvoiceSchema.safeParse({
        buyerType: 'individual',
        title: '旧版个人抬头',
        taxId: '',
        email: 'legacy-person@example.com',
        mobile: '13800138000',
        content: '会务费',
      }).success,
    ).toBe(true);
  });
});
