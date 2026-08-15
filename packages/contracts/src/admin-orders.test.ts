import { describe, expect, it } from 'vitest';
import { AdminOrderListQuerySchema, AdminOrderListSchema, DEMO_EVENT } from './index.js';

describe('admin order list contracts', () => {
  it('uses fixed 20-item pages and validates order filters', () => {
    expect(AdminOrderListQuerySchema.parse({})).toEqual({ page: 1 });
    expect(
      AdminOrderListQuerySchema.parse({ page: '3', q: '13800002101', status: 'paid' }),
    ).toEqual({ page: 3, q: '13800002101', status: 'paid' });
    expect(AdminOrderListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(AdminOrderListQuerySchema.safeParse({ status: 'unknown' }).success).toBe(false);
    expect(
      AdminOrderListSchema.safeParse({ items: [], total: 0, page: 1, pageSize: 20 }).success,
    ).toBe(true);
    expect(
      AdminOrderListSchema.safeParse({ items: [], total: 0, page: 1, pageSize: 50 }).success,
    ).toBe(false);
  });

  it('keeps purchaser and attendee identities separate and explains full-refund guards', () => {
    const result = AdminOrderListSchema.parse({
      items: [
        {
          id: 'order-1',
          orderNo: 'TOK2026000001',
          registrationId: 'registration-1',
          status: 'paid',
          amount: 39900,
          currency: 'CNY',
          paymentMethod: 'wechat',
          expiresAt: '2026-08-15T10:15:00.000Z',
          createdAt: '2026-08-15T10:00:00.000Z',
          purchaserName: '购票人',
          purchaserMobile: '13800000001',
          attendeeName: '参会人',
          attendeeMobile: '13800000002',
          attendeeCompany: '参会公司',
          ticketTypeName: DEMO_EVENT.tickets[0]!.name,
          isProxyPurchase: true,
          fullRefundBlockedReason: '电子票已使用，无法整单退款',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    expect(result.items[0]).toMatchObject({
      purchaserName: '购票人',
      attendeeName: '参会人',
      isProxyPurchase: true,
      fullRefundBlockedReason: '电子票已使用，无法整单退款',
    });
  });
});
