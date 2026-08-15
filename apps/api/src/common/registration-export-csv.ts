interface RegistrationExportAttendee {
  name: string;
  mobile: string;
  email: string;
  company: string;
  title: string;
  city: string;
}

export interface RegistrationExportRow {
  registration: {
    customerUserId?: string | null;
    registrationCode: string;
    status: string;
    attendee: RegistrationExportAttendee;
    formVersion: number;
    termsVersion: string;
    formAnswers: Record<string, unknown>;
    consentSnapshot: Record<string, unknown>;
    createdAt: Date;
  };
  order: {
    orderNo: string;
    status: string;
    amount: number;
    currency: string;
    purchaserCustomerUserId: string | null;
    purchaserSnapshot: { name?: string; mobile?: string; email?: string } | null;
    purchaseIntentId: string | null;
  } | null;
}

export interface RegistrationExportMetadata {
  eventName: string;
  actorPublicId: number;
  exportedAt: string;
  scope: string;
}

export function escapeCsvCell(value: unknown) {
  const raw = String(value ?? '');
  const safe = /^(?:\uFEFF)?[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function registrationOrderOwnership(row: RegistrationExportRow) {
  if (!row.order || !row.order.purchaseIntentId) return 'legacy' as const;
  const purchaseFor = row.registration.consentSnapshot.purchaseFor;
  if (
    purchaseFor === 'other' ||
    (row.registration.customerUserId !== undefined &&
      row.order.purchaserCustomerUserId !== row.registration.customerUserId) ||
    (row.order.purchaserSnapshot?.mobile &&
      row.order.purchaserSnapshot.mobile !== row.registration.attendee.mobile)
  ) {
    return 'proxy' as const;
  }
  return 'self' as const;
}

export function buildRegistrationExportCsv(
  metadata: RegistrationExportMetadata,
  rows: RegistrationExportRow[],
) {
  const headers = [
    '购票人姓名',
    '购票人手机号',
    '购票人邮箱',
    '参会人姓名',
    '参会人手机号',
    '参会人邮箱',
    '订单归属',
    '购买意图 ID',
    '订单总额（分）',
    '报名编号',
    '报名状态',
    '订单号',
    '订单状态',
    '币种',
    '支付方式',
    '参会人公司',
    '参会人职位',
    '参会人城市',
    '表单版本',
    '条款版本',
    '表单回答 JSON',
    '报名时间',
  ];
  const lines = [
    '# 大会报名数据导出',
    `# 大会,${escapeCsvCell(metadata.eventName)}`,
    `# 导出用户 ID,${escapeCsvCell(metadata.actorPublicId)}`,
    `# 导出时间,${escapeCsvCell(metadata.exportedAt)}`,
    `# 数据范围,${escapeCsvCell(metadata.scope)}`,
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => {
      const legacy = !row.order?.purchaseIntentId;
      const purchaser = row.order?.purchaserSnapshot;
      const attendee = row.registration.attendee;
      return [
        purchaser?.name || (legacy ? attendee.name : ''),
        purchaser?.mobile || (legacy ? attendee.mobile : ''),
        purchaser?.email || (legacy ? attendee.email : ''),
        attendee.name,
        attendee.mobile,
        attendee.email,
        registrationOrderOwnership(row),
        row.order?.purchaseIntentId,
        row.order?.amount,
        row.registration.registrationCode,
        row.registration.status,
        row.order?.orderNo,
        row.order?.status,
        row.order?.currency,
        row.order ? (row.order.amount === 0 ? 'free' : 'wechat') : undefined,
        attendee.company,
        attendee.title,
        attendee.city,
        row.registration.formVersion,
        row.registration.termsVersion,
        JSON.stringify(row.registration.formAnswers),
        row.registration.createdAt.toISOString(),
      ]
        .map(escapeCsvCell)
        .join(',');
    }),
  ];
  return `\uFEFF${lines.join('\n')}`;
}
