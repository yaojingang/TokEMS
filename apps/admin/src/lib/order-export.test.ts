import { describe, expect, it } from 'vitest';
import type { AdminOrderRow } from '@conference/contracts';
import { adminOrderExportTable } from './order-export';

describe('admin order export', () => {
  it('keeps purchaser and attendee identities in separate columns', () => {
    const row = {
      orderNo: 'ORDER-1',
      purchaserName: '购票人',
      purchaserMobile: '13800138000',
      attendeeName: '参会人',
      attendeeMobile: '13900139000',
      attendeeCompany: '参会公司',
      ticketTypeName: '标准票',
      status: 'paid',
      amount: 39_900,
      currency: 'CNY',
      paymentMethod: 'wechat',
      createdAt: '2026-08-15T00:00:00.000Z',
    } as AdminOrderRow;

    expect(adminOrderExportTable([row])).toEqual({
      headers: [
        '订单号',
        '购票人姓名',
        '购票人手机号',
        '参会人姓名',
        '参会人手机号',
        '参会人公司',
        '票种',
        '状态',
        '金额（分）',
        '币种',
        '支付方式',
        '创建时间',
      ],
      rows: [
        [
          'ORDER-1',
          '购票人',
          '13800138000',
          '参会人',
          '13900139000',
          '参会公司',
          '标准票',
          'paid',
          39_900,
          'CNY',
          'wechat',
          '2026-08-15T00:00:00.000Z',
        ],
      ],
    });
  });
});
