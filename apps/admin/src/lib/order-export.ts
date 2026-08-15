import type { AdminOrderRow } from '@conference/contracts';

export function adminOrderExportTable(rows: AdminOrderRow[]) {
  return {
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
    rows: rows.map((row) => [
      row.orderNo,
      row.purchaserName,
      row.purchaserMobile,
      row.attendeeName,
      row.attendeeMobile,
      row.attendeeCompany,
      row.ticketTypeName,
      row.status,
      row.amount,
      row.currency,
      row.paymentMethod,
      row.createdAt,
    ]),
  };
}
