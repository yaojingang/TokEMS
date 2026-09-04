import { describe, expect, it } from 'vitest';
import {
  AdminRegistrationOperationsDetailSchema,
  CreateRegistrationNoteSchema,
  UpdateAdminRegistrationAttendeeSchema,
} from './index';

const registration = {
  id: 'registration-1',
  eventId: 101,
  registrationCode: 'TOK-R-WOP-Z3EM',
  status: 'checked_in',
  attendee: {
    name: '王欣怡',
    mobile: '13800138000',
    email: 'wang.xinyi@example.com',
    company: '远景科技',
    title: '市场总监',
    city: '上海',
  },
  ticketType: {
    id: 'ticket-type-1',
    name: '两日通票',
    description: '大会通票',
    price: 39900,
    currency: 'CNY',
    remaining: 10,
    benefits: [],
    recommended: false,
  },
  createdAt: '2026-08-04T01:28:00.000Z',
  updatedAt: '2026-08-04T01:35:00.000Z',
  invoiceRequired: true,
  marketingConsent: false,
  consentSnapshot: {},
  purchaserName: '购票人林一',
  purchaserMobile: '13900139000',
  isProxyPurchase: true,
};

describe('AdminRegistrationOperationsDetailSchema', () => {
  it('accepts one bounded, permission-aware operations record', () => {
    const result = AdminRegistrationOperationsDetailSchema.safeParse({
      snapshotAt: '2026-08-04T01:36:00.000Z',
      traceId: 'trace-registration-1',
      registration,
      customer: { access: 'unlinked' },
      fulfillment: {
        ticket: {
          id: 'ticket-1',
          code: 'TOK-TICKET-1',
          status: 'used',
          issuedAt: '2026-08-04T01:30:00.000Z',
        },
        checkins: [
          {
            id: 'checkin-1',
            result: 'accepted',
            listName: '主会场',
            deviceName: '东门签到机',
            operatorName: '周宁',
            checkedInAt: '2026-08-04T01:32:00.000Z',
          },
        ],
      },
      commerce: {
        access: 'included',
        order: {
          id: 'order-1',
          orderNo: 'TOK20260804A001',
          registrationId: 'registration-1',
          status: 'paid',
          amount: 39900,
          currency: 'CNY',
          paymentMethod: 'wechat',
          expiresAt: '2026-08-04T01:43:00.000Z',
          createdAt: '2026-08-04T01:28:00.000Z',
        },
        successfulPayment: {
          id: 'payment-1',
          provider: 'wechatpay',
          channel: 'jsapi',
          status: 'succeeded',
          amount: 39900,
          currency: 'CNY',
          outTradeNo: 'TOK20260804A001',
          externalId: '420000000000000001',
          preparedAt: '2026-08-04T01:28:10.000Z',
          succeededAt: null,
          closedAt: null,
          lastQueriedAt: null,
          createdAt: '2026-08-04T01:28:10.000Z',
          updatedAt: '2026-08-04T01:29:00.000Z',
        },
        paymentAttempts: [],
        refunds: [],
        totals: {
          paidAmount: 39900,
          succeededRefundAmount: 0,
          processingRefundAmount: 0,
          refundableAmount: 39900,
        },
      },
      invoice: { access: 'included', request: null },
      notes: [],
      capabilities: {
        refund_order: { allowed: true },
        manage_invoice: { allowed: true },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.registration).toMatchObject({
        purchaserName: '购票人林一',
        isProxyPurchase: true,
      });
    }
  });

  it('rejects commerce or invoice payloads hidden inside restricted contexts', () => {
    const base = {
      snapshotAt: '2026-08-04T01:36:00.000Z',
      traceId: 'trace-registration-1',
      registration,
      customer: { access: 'unlinked' },
      fulfillment: { ticket: null, checkins: [] },
      notes: [],
      capabilities: {},
    };

    expect(
      AdminRegistrationOperationsDetailSchema.safeParse({
        ...base,
        commerce: { access: 'restricted', order: { amount: 39900 } },
        invoice: { access: 'restricted', request: { taxId: '91440300SENSITIVE' } },
      }).success,
    ).toBe(false);
  });

  it('validates attendee corrections and durable internal notes', () => {
    expect(
      UpdateAdminRegistrationAttendeeSchema.safeParse({
        attendee: registration.attendee,
        reason: '参会人来电更正公司信息',
      }).success,
    ).toBe(true);
    expect(
      UpdateAdminRegistrationAttendeeSchema.safeParse({
        attendee: { ...registration.attendee, name: '' },
        reason: '资料更新',
      }).success,
    ).toBe(true);
    expect(
      CreateRegistrationNoteSchema.safeParse({ body: '会前一天电话确认发票抬头' }).success,
    ).toBe(true);
    expect(CreateRegistrationNoteSchema.safeParse({ body: ' '.repeat(4) }).success).toBe(false);
  });
});
