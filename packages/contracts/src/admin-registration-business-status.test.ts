import { describe, expect, it } from 'vitest';
import {
  AdminRegistrationListQuerySchema,
  AdminRegistrationRowSchema,
  DEMO_EVENT,
} from './index.js';

describe('admin registration business status', () => {
  it('exposes one operational summary on each registration row', () => {
    const row = AdminRegistrationRowSchema.parse({
      id: 'registration-1',
      eventId: DEMO_EVENT.id,
      registrationCode: 'TOK-R-0001',
      status: 'confirmed',
      attendee: {
        name: '江云舟',
        mobile: '+8613800138000',
        email: 'jiang@example.com',
        company: '湾区品牌实验室',
        title: '增长负责人',
        city: '深圳',
      },
      ticketType: DEMO_EVENT.tickets[0],
      createdAt: '2026-08-04T10:00:00.000Z',
      purchaserName: '林一',
      purchaserMobile: '13800000001',
      isProxyPurchase: true,
      businessStatus: 'partially_refunded',
      latestPaymentStatus: 'succeeded',
      paidAmount: 39900,
      refundedAmount: 10000,
      invoiceSummary: { status: 'issued', requestNo: 'INV2026ABC001' },
      lastBusinessAt: '2026-08-04T11:00:00.000Z',
    });

    expect(row.businessStatus).toBe('partially_refunded');
    expect(row.invoiceSummary.status).toBe('issued');
    expect(row.isProxyPurchase).toBe(true);
  });

  it('accepts business and invoice filters', () => {
    expect(
      AdminRegistrationListQuerySchema.parse({
        businessStatus: 'payment_failed',
        invoiceStatus: 'eligible',
      }),
    ).toMatchObject({ businessStatus: 'payment_failed', invoiceStatus: 'eligible' });
  });
});
