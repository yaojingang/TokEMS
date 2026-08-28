import { z } from 'zod';

export const FeishuBotStatusSchema = z.enum([
  'unconfigured',
  'configured',
  'verified',
  'error',
  'disabled',
]);

export const FeishuBotConfigurationSchema = z.object({
  enabled: z.boolean(),
  appId: z.string(),
  appName: z.string(),
  botOpenId: z.string(),
  status: FeishuBotStatusSchema,
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  secretsPresent: z.object({ appSecret: z.boolean() }),
});

export const UpdateFeishuBotConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    appId: z
      .string()
      .trim()
      .min(6)
      .max(128)
      .regex(/^cli_[A-Za-z0-9]+$/u, 'App ID 应以 cli_ 开头'),
    appSecret: z.string().trim().min(8).max(512).optional(),
  })
  .strict();

export const FeishuBotVerificationSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['verified', 'error']),
  message: z.string(),
  verifiedAt: z.string(),
  bot: z
    .object({
      appName: z.string(),
      openId: z.string(),
    })
    .nullable(),
});

export const FeishuChatSchema = z.object({
  chatId: z.string(),
  name: z.string(),
  description: z.string(),
  ownerId: z.string(),
  external: z.boolean(),
});

export const FeishuChatListSchema = z.object({
  items: z.array(FeishuChatSchema),
  refreshedAt: z.string(),
  setupHint: z.string(),
});

export const FeishuDigestDeliveryStatusSchema = z.enum([
  'queued',
  'generating',
  'sending',
  'retrying',
  'sent',
  'unknown',
  'failed',
  'skipped',
  'cancelled',
]);

export const FeishuDigestDeliveryKindSchema = z.enum(['scheduled', 'manual_test', 'manual_resend']);

export const FeishuDigestDailyMetricsSchema = z.object({
  pageViews: z.number().int().nonnegative().nullable(),
  newRegistrations: z.number().int().nonnegative(),
  paidOrders: z.number().int().nonnegative(),
  grossReceipts: z.number().int().nonnegative(),
  successfulRefunds: z.number().int().nonnegative(),
  refundAmount: z.number().int().nonnegative(),
  netCash: z.number().int(),
  invoiceRequests: z.number().int().nonnegative(),
  checkins: z.number().int().nonnegative(),
});

export const FeishuDigestCumulativeMetricsSchema = z.object({
  pageViews: z.number().int().nonnegative(),
  validRegistrations: z.number().int().nonnegative(),
  paidOrders: z.number().int().nonnegative(),
  paidSeats: z.number().int().nonnegative(),
  confirmedAttendees: z.number().int().nonnegative(),
  netRevenue: z.number().int().nonnegative(),
  remainingInventory: z.number().int().nonnegative(),
  checkins: z.number().int().nonnegative(),
});

export const FeishuDigestTodoMetricsSchema = z.object({
  pendingRegistrationReview: z.number().int().nonnegative(),
  invoiceActionable: z.number().int().nonnegative(),
  paymentExceptions: z.number().int().nonnegative(),
  cooperationRequests: z.number().int().nonnegative(),
  lowStockTicketTypes: z.number().int().nonnegative(),
});

export const FeishuDigestMonitoringMetricsSchema = z.object({
  invoiceAwaitingDetails: z.number().int().nonnegative(),
  invoiceIssuing: z.number().int().nonnegative(),
  pendingPayments: z.number().int().nonnegative(),
});

export const FeishuDigestSnapshotSchema = z.object({
  metricVersion: z.literal(1),
  event: z.object({
    id: z.number().int().min(101),
    slug: z.string(),
    name: z.string(),
    status: z.enum([
      'draft',
      'configuring',
      'prepublished',
      'registration_open',
      'in_progress',
      'ended',
      'archived',
    ]),
    timezone: z.string(),
  }),
  reportDate: z.iso.date(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  currency: z.string().length(3),
  pageViewsAvailable: z.boolean(),
  daily: FeishuDigestDailyMetricsSchema,
  cumulative: FeishuDigestCumulativeMetricsSchema,
  todos: FeishuDigestTodoMetricsSchema,
  monitoring: FeishuDigestMonitoringMetricsSchema,
});

export const UpdateFeishuDigestSubscriptionSchema = z
  .object({
    enabled: z.boolean(),
    chatId: z
      .string()
      .trim()
      .regex(/^oc_[A-Za-z0-9]+$/u, '请选择有效的飞书群')
      .nullable(),
    chatName: z.string().trim().max(200).nullable(),
    sendLocalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, '发送时间格式应为 HH:mm'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled && !value.chatId) {
      context.addIssue({
        code: 'custom',
        path: ['chatId'],
        message: '开启自动推送前需要选择并验证目标群',
      });
    }
  });

export const FeishuDigestSubscriptionSchema = z.object({
  eventId: z.number().int().min(101),
  eventName: z.string(),
  eventStatus: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  chatId: z.string().nullable(),
  chatName: z.string().nullable(),
  sendLocalTime: z.string(),
  nextRunAt: z.string().nullable(),
  lastSuccessfulAt: z.string().nullable(),
  testVerifiedAt: z.string().nullable(),
  targetGroupVerified: z.boolean(),
  connectionStatus: FeishuBotStatusSchema,
});

export const FeishuDigestTestMessageSchema = z
  .object({
    chatId: z
      .string()
      .trim()
      .regex(/^oc_[A-Za-z0-9]+$/u),
    chatName: z.string().trim().min(1).max(200).optional(),
    dataVisibilityConfirmed: z.literal(true, {
      error: '发送前需要确认目标群成员可以查看大会聚合经营数据',
    }),
  })
  .strict();

export const FeishuDigestSendResultSchema = z.object({
  ok: z.boolean(),
  deliveryId: z.uuid(),
  status: FeishuDigestDeliveryStatusSchema,
  message: z.string(),
  providerMessageId: z.string(),
  sentAt: z.string().nullable(),
});

export const FeishuDigestDeliverySchema = z.object({
  id: z.uuid(),
  sourceDeliveryId: z.uuid().nullable(),
  kind: FeishuDigestDeliveryKindSchema,
  reportDate: z.string(),
  chatName: z.string(),
  status: FeishuDigestDeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  scheduledAt: z.string().nullable(),
  generatedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  providerMessageId: z.string(),
  lastErrorCode: z.string(),
  lastError: z.string(),
  createdAt: z.string(),
});

export type FeishuBotConfiguration = z.infer<typeof FeishuBotConfigurationSchema>;
export type UpdateFeishuBotConfiguration = z.infer<typeof UpdateFeishuBotConfigurationSchema>;
export type FeishuBotVerification = z.infer<typeof FeishuBotVerificationSchema>;
export type FeishuChat = z.infer<typeof FeishuChatSchema>;
export type FeishuChatList = z.infer<typeof FeishuChatListSchema>;
export type FeishuDigestDeliveryStatus = z.infer<typeof FeishuDigestDeliveryStatusSchema>;
export type FeishuDigestDeliveryKind = z.infer<typeof FeishuDigestDeliveryKindSchema>;
export type FeishuDigestSnapshot = z.infer<typeof FeishuDigestSnapshotSchema>;
export type FeishuDigestSubscription = z.infer<typeof FeishuDigestSubscriptionSchema>;
export type UpdateFeishuDigestSubscription = z.infer<typeof UpdateFeishuDigestSubscriptionSchema>;
export type FeishuDigestTestMessage = z.infer<typeof FeishuDigestTestMessageSchema>;
export type FeishuDigestSendResult = z.infer<typeof FeishuDigestSendResultSchema>;
export type FeishuDigestDelivery = z.infer<typeof FeishuDigestDeliverySchema>;

function checkedTimeZone(timeZone: string) {
  new Intl.DateTimeFormat('en', { timeZone }).format();
  return timeZone;
}

export function dateInTimeZone(value: Date, requestedTimeZone: string) {
  const timeZone = checkedTimeZone(requestedTimeZone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.valueOf()) || !Number.isSafeInteger(days)) {
    throw new Error('日期或天数无效');
  }
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function zonedDateTimeToDate(date: string, time: string, requestedTimeZone: string) {
  const matched = `${date}T${time}`.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u,
  );
  if (!matched) throw new Error('日期时间格式无效');
  const timeZone = checkedTimeZone(requestedTimeZone);
  const target = Date.UTC(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
    Number(matched[6] ?? 0),
  );
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const represented = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
    const correction = target - represented;
    instant += correction;
    if (!correction) break;
  }
  const result = new Date(instant);
  const represented = Object.fromEntries(
    formatter
      .formatToParts(result)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  if (
    Date.UTC(
      represented.year!,
      represented.month! - 1,
      represented.day!,
      represented.hour!,
      represented.minute!,
      represented.second!,
    ) !== target
  ) {
    throw new Error('所选时区在该时刻不存在，请调整时间');
  }
  return result;
}

export function feishuDigestReportWindow(now: Date, timeZone: string, reportDate?: string) {
  const date = reportDate ?? addCalendarDays(dateInTimeZone(now, timeZone), -1);
  return {
    reportDate: date,
    windowStart: scheduledDateTimeToDate(date, '00:00', timeZone),
    windowEnd: scheduledDateTimeToDate(addCalendarDays(date, 1), '00:00', timeZone),
  };
}

function scheduledDateTimeToDate(date: string, time: string, timeZone: string) {
  const matched = `${date}T${time}`.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u);
  if (!matched) throw new Error('日期时间格式无效');
  const local = new Date(
    Date.UTC(
      Number(matched[1]),
      Number(matched[2]) - 1,
      Number(matched[3]),
      Number(matched[4]),
      Number(matched[5]),
    ),
  );
  for (let offsetMinutes = 0; offsetMinutes <= 180; offsetMinutes += 1) {
    const candidate = new Date(local.valueOf() + offsetMinutes * 60_000);
    const candidateDate = candidate.toISOString().slice(0, 10);
    const candidateTime = candidate.toISOString().slice(11, 16);
    try {
      return zonedDateTimeToDate(candidateDate, candidateTime, timeZone);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== '所选时区在该时刻不存在，请调整时间') {
        throw error;
      }
    }
  }
  throw new Error('所选时区的发送时间连续三小时不可用');
}

export function nextFeishuDigestRun(now: Date, timeZone: string, sendLocalTime: string) {
  const today = dateInTimeZone(now, timeZone);
  const todayRun = scheduledDateTimeToDate(today, sendLocalTime, timeZone);
  return todayRun > now
    ? todayRun
    : scheduledDateTimeToDate(addCalendarDays(today, 1), sendLocalTime, timeZone);
}
