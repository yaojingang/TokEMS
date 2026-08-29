import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type {
  AttendeeClaimInput,
  AttendeeClaimResult,
  CreateCustomerAdmin,
  CreateCustomerAdminResult,
  CustomerAdminDetail,
  CustomerAdminExportQuery,
  CustomerAdminList,
  CustomerAdminListQuery,
  CustomerAdminSummary,
  CustomerInvoiceCenterCategory,
  CustomerInvoiceCenterList,
  CustomerInvoiceCenterListQuery,
  CustomerInvoiceList,
  CustomerPurchasedOrder,
  CustomerPurchasedOrderList,
  CustomerRegistrationDetail,
  CustomerRegistrationList,
  CustomerRegistrationSummary,
  CustomerSession,
  EventPurchaseContext,
  PublicEvent,
  ClaimCustomerRegistration,
  UpdateCustomerAdmin,
  UpdateCustomerProfile,
  UpdatePurchasedOrderAttendee,
} from '@conference/contracts';
import {
  API_ERROR_CODES,
  CUSTOMER_INVOICE_ACTION_REQUIRED_STATUSES,
  CUSTOMER_INVOICE_HISTORY_STATUSES,
  CUSTOMER_INVOICE_PROCESSING_STATUSES,
  CustomerInvoiceCenterListSchema,
  customerInvoiceCenterActionsForStatus,
  customerInvoiceCenterCategoryForStatus,
  resolveCustomerAdminDisplay,
} from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  attendeeClaimTokens,
  attendeeNeedQuestions,
  attendeeNeedSubmissions,
  attendeeShowcaseProfiles,
  auditLogs,
  customerAuthChallenges,
  customerMediaAssets,
  customerProfiles,
  customerSessions,
  customerUsers,
  eventReleases,
  events,
  invoiceRequests,
  orders,
  orderAccessTokens,
  outboxEvents,
  payments,
  publicUserIds,
  registrations,
  tickets,
  ticketTypes,
  waitlistEntries,
} from '@conference/database';
import { maskMobile, normalizeMainlandMobile, sealSecret, sha256 } from '@conference/security';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import { CUSTOMER_INVOICE_PAYMENT_ELIGIBLE_ORDER_STATUSES } from './customer-invoice-policy.js';
import {
  customerCanManageOrder,
  customerPurchaserScopeSql,
  purchaserCanAccessTicket,
} from './customer-order-ownership.js';
import { AttendeeShowcaseService } from './attendee-showcase.service.js';
import { attendeeShowcasePublicEligibilitySql } from './attendee-showcase-policy.js';
import { attendeeUpdateDiff } from './attendee-update-policy.js';
import {
  resolvePublishedRegistrationSettings,
  type RegistrationReleaseSnapshot,
} from './purchase-registration-policy.js';
import { withPostgresTransactionRetry } from './transaction-retry.js';

type RegistrationRow = Awaited<ReturnType<CustomerAccountService['registrationRows']>>[number];
type Database = NonNullable<DatabaseService['db']>;
type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type CustomerListDatabase = Database | DatabaseTransaction;

const ADMIN_CUSTOMER_PAGE_SIZE = 20 as const;
const MAX_CUSTOMER_EXPORT_ROWS = 10_000;

const customerStatusLabel: Record<string, string> = {
  active: '正常',
  blocked: '已封禁',
  closed: '已关闭',
};

const registrationStatusLabel: Record<string, string> = {
  draft: '草稿',
  pending_payment: '待支付',
  pending_review: '待审核',
  confirmed: '报名成功',
  cancelled: '已取消',
  checked_in: '已签到',
  completed: '已完成',
};

const displaySourceLabel: Record<string, string> = {
  profile: '账号资料',
  registration: '最近报名',
  nickname: '用户名',
  missing: '未填写',
};

const CUSTOMER_EXPORT_HEADER = [
  '用户 ID',
  '手机号',
  '姓名',
  '姓名来源',
  '用户名',
  '邮箱',
  '公司',
  '公司来源',
  '账号注册时间',
  '账号状态',
  '报名记录数',
  '报名大会数',
  '最新大会',
  '最新大会时间',
  '最新票种',
  '最新报名编号',
  '最新报名状态',
  '最新报名时间',
  '最近登录时间',
] as const;

function domesticMobile(value: string) {
  return value.startsWith('+86') ? value.slice(3) : value;
}

function escapeLikePattern(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  const guarded = '=+-@'.includes(text.trimStart().charAt(0)) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function customerExportCsvLine(item: CustomerAdminSummary) {
  return [
    item.id,
    domesticMobile(item.mobile),
    item.displayName,
    displaySourceLabel[item.displayNameSource],
    item.nickname,
    item.email,
    item.displayCompany,
    displaySourceLabel[item.displayCompanySource],
    item.createdAt,
    customerStatusLabel[item.status],
    item.registrationsCount,
    item.eventCount,
    item.latestRegistration?.eventName,
    item.latestRegistration?.eventStartsAt,
    item.latestRegistration?.ticketTypeName,
    item.latestRegistration?.registrationCode,
    item.latestRegistration
      ? registrationStatusLabel[item.latestRegistration.registrationStatus]
      : null,
    item.latestRegistration?.createdAt,
    item.lastLoginAt,
  ]
    .map(csvCell)
    .join(',');
}

@Injectable()
export class CustomerAccountService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(AttendeeShowcaseService)
    private readonly attendeeShowcases?: AttendeeShowcaseService,
  ) {}

  private db() {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '用户中心需要启用数据库后使用',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private async resolveCustomerUserUuid(
    organizationId: string,
    publicUserId: number,
    database: CustomerListDatabase = this.db(),
  ) {
    const [row] = await database
      .select({ customerUserUuid: customerUsers.id })
      .from(customerUsers)
      .innerJoin(
        publicUserIds,
        and(
          eq(publicUserIds.subjectType, 'customer'),
          eq(publicUserIds.subjectUuid, customerUsers.id),
          isNull(publicUserIds.retiredAt),
        ),
      )
      .where(
        and(
          eq(customerUsers.organizationId, organizationId),
          eq(publicUserIds.publicId, publicUserId),
        ),
      )
      .limit(1);
    return row?.customerUserUuid ?? null;
  }

  private encodeCursor(date: Date, id: string) {
    return Buffer.from(`${date.toISOString()}|${id}`, 'utf8').toString('base64url');
  }

  private decodeCursor(value: string) {
    try {
      const [dateValue, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
      const date = new Date(dateValue ?? '');
      if (!id || !Number.isFinite(date.getTime())) throw new Error('invalid cursor');
      return { date, id };
    } catch {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '分页游标无效',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private databaseDate(value: unknown) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (!Number.isFinite(date.getTime())) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '数据库时间字段格式无效',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return date;
  }

  private purchaserScope(customerUserId: string) {
    return customerPurchaserScopeSql(customerUserId);
  }

  private notificationSecret() {
    return (
      process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET ??
      process.env.JWT_SECRET ??
      'conference-notification-payload-development-secret'
    );
  }

  private async registrationRows(
    organizationId: string,
    customerUserId: string,
    options: { registrationId?: string; cursor?: string; limit?: number } = {},
  ) {
    const conditions: SQL[] = [
      eq(registrations.organizationId, organizationId),
      eq(registrations.customerUserId, customerUserId),
      isNull(registrations.supersededAt),
    ];
    if (options.registrationId) conditions.push(eq(registrations.id, options.registrationId));
    if (options.cursor) {
      const cursor = this.decodeCursor(options.cursor);
      conditions.push(
        or(
          lt(registrations.createdAt, cursor.date),
          and(eq(registrations.createdAt, cursor.date), lt(registrations.id, cursor.id)),
        )!,
      );
    }
    return this.db()
      .select({
        registration: registrations,
        event: {
          id: events.id,
          name: events.name,
          slug: events.slug,
          startsAt: events.startsAt,
          endsAt: events.endsAt,
        },
        ticketTypeName: ticketTypes.name,
        order: orders,
        ticket: {
          code: tickets.code,
          status: tickets.status,
        },
        invoice: {
          id: invoiceRequests.id,
          status: invoiceRequests.status,
        },
      })
      .from(registrations)
      .innerJoin(events, eq(events.id, registrations.eventId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
      .innerJoin(orders, eq(orders.registrationId, registrations.id))
      .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
      .leftJoin(invoiceRequests, eq(invoiceRequests.registrationId, registrations.id))
      .where(and(...conditions))
      .orderBy(desc(registrations.createdAt), desc(registrations.id))
      .limit(options.limit ?? 51);
  }

  private registrationSummary(
    row: RegistrationRow,
    customerUserId: string,
  ): CustomerRegistrationSummary {
    const common = {
      id: row.registration.id,
      eventId: row.event.id,
      eventName: row.event.name,
      eventSlug: row.event.slug,
      startsAt: row.event.startsAt.toISOString(),
      endsAt: row.event.endsAt.toISOString(),
      registrationCode: row.registration.registrationCode,
      registrationStatus: row.registration.status,
      attendeeName: row.registration.attendee.name,
      ticketTypeName: row.ticketTypeName,
      ticketCode: row.ticket?.code ?? null,
      ticketStatus: row.ticket?.status ?? null,
      createdAt: row.registration.createdAt.toISOString(),
    };
    const canManageOrder = customerCanManageOrder(
      row.order.purchaserCustomerUserId,
      row.order.purchaseIntentId,
      row.registration.customerUserId,
      customerUserId,
    );
    return canManageOrder
      ? {
          ...common,
          canManageOrder: true,
          orderId: row.order.id,
          orderNo: row.order.orderNo,
          orderStatus: row.order.status,
          amount: row.order.amount,
          currency: row.order.currency,
          invoiceId: row.invoice?.id ?? null,
          invoiceStatus: row.invoice?.status ?? null,
        }
      : {
          ...common,
          canManageOrder: false,
          orderId: null,
          orderNo: null,
          orderStatus: null,
          amount: null,
          currency: null,
          invoiceId: null,
          invoiceStatus: null,
        };
  }

  async profile(session: AuthenticatedCustomer): Promise<CustomerSession> {
    return {
      authenticated: true,
      customer: session.customer,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  async updateProfile(
    session: AuthenticatedCustomer,
    input: UpdateCustomerProfile,
  ): Promise<CustomerSession> {
    const db = this.db();
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(customerProfiles)
        .where(eq(customerProfiles.customerUserId, session.customerUserId))
        .for('update')
        .limit(1);
      if (!current) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '用户档案不存在', HttpStatus.NOT_FOUND);
      }
      if (current.version !== input.version) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '用户资料已在其他页面更新，请刷新后重试',
          HttpStatus.CONFLICT,
        );
      }
      const [profile] = await tx
        .update(customerProfiles)
        .set({
          nickname: input.nickname || null,
          realName: input.realName || null,
          email: input.email,
          company: input.company || null,
          title: input.title || null,
          city: input.city || null,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(customerProfiles.customerUserId, session.customerUserId),
            eq(customerProfiles.version, current.version),
          ),
        )
        .returning();
      await tx.insert(auditLogs).values({
        organizationId: session.organizationId,
        actorId: session.customerUserId,
        actorType: 'customer',
        action: 'customer.profile.update',
        resourceType: 'customer_profile',
        resourceId: String(session.customer.id),
        before: { version: current.version },
        after: {
          version: profile!.version,
          changedFields: (
            ['nickname', 'realName', 'email', 'company', 'title', 'city'] as const
          ).filter((field) => current[field] !== profile![field]),
        },
        traceId: crypto.randomUUID(),
      });
      return profile!;
    });
    return {
      authenticated: true,
      customer: {
        ...session.customer,
        profile: {
          nickname: updated.nickname,
          realName: updated.realName,
          email: updated.email,
          company: updated.company,
          title: updated.title,
          city: updated.city,
          version: updated.version,
        },
      },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  private async registrationPage(
    organizationId: string,
    customerUserId: string,
    cursor?: string,
    limit = 20,
  ): Promise<CustomerRegistrationList> {
    const normalizedLimit = Math.min(Math.max(limit, 1), 50);
    const rows = await this.registrationRows(organizationId, customerUserId, {
      ...(cursor ? { cursor } : {}),
      limit: normalizedLimit + 1,
    });
    const hasMore = rows.length > normalizedLimit;
    const items = rows
      .slice(0, normalizedLimit)
      .map((row) => this.registrationSummary(row, customerUserId));
    return {
      items,
      nextCursor: hasMore
        ? this.encodeCursor(rows[normalizedLimit - 1]!.registration.createdAt, items.at(-1)!.id)
        : null,
    };
  }

  async registrations(
    session: AuthenticatedCustomer,
    cursor?: string,
    limit = 20,
  ): Promise<CustomerRegistrationList> {
    return this.registrationPage(session.organizationId, session.customerUserId, cursor, limit);
  }

  async purchaseContext(
    session: AuthenticatedCustomer,
    eventId: number,
  ): Promise<EventPurchaseContext> {
    const db = this.db();
    const { event, eventSettings, releaseSnapshot, attendance, purchaseSummary } =
      await db.transaction(
        async (tx) => {
          const [event] = await tx
            .select({
              id: events.id,
              status: events.status,
              settings: events.settings,
            })
            .from(events)
            .where(and(eq(events.id, eventId), eq(events.organizationId, session.organizationId)))
            .limit(1);
          if (!event) {
            throw new DomainError(API_ERROR_CODES.NOT_FOUND, '大会不存在', HttpStatus.NOT_FOUND);
          }
          const eventSettings = event.settings as {
            currentReleaseId?: string;
            registration?: PublicEvent['registration'];
          };
          let releaseSnapshot: RegistrationReleaseSnapshot | undefined;
          if (eventSettings.currentReleaseId) {
            const [release] = await tx
              .select({ snapshot: eventReleases.snapshot })
              .from(eventReleases)
              .where(
                and(
                  eq(eventReleases.id, eventSettings.currentReleaseId),
                  eq(eventReleases.eventId, event.id),
                ),
              )
              .limit(1);
            if (!release) {
              throw new DomainError(
                API_ERROR_CODES.NOT_FOUND,
                '大会发布版本已失效',
                HttpStatus.NOT_FOUND,
              );
            }
            releaseSnapshot = release.snapshot as RegistrationReleaseSnapshot;
          }
          const attendance = await tx
            .select({
              registrationId: registrations.id,
              registrationStatus: registrations.status,
              ticketCode: tickets.code,
              ticketStatus: tickets.status,
              canManageOrder: this.purchaserScope(session.customerUserId),
              orderIsActive: sql<boolean>`
                ${orders.id} is null
                or ${orders.status} in ('pending_review', 'processing', 'paid', 'partially_refunded')
                or (${orders.status} = 'pending_payment' and ${orders.expiresAt} > now())
                or exists (
                  select 1
                  from ${payments}
                  where ${payments.orderId} = ${orders.id}
                    and ${payments.provider} = 'wechatpay'
                    and ${inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES])}
                )
              `,
            })
            .from(registrations)
            .leftJoin(orders, eq(orders.registrationId, registrations.id))
            .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
            .where(
              and(
                eq(registrations.organizationId, session.organizationId),
                eq(registrations.eventId, eventId),
                eq(registrations.customerUserId, session.customerUserId),
                isNull(registrations.supersededAt),
              ),
            )
            .orderBy(desc(registrations.createdAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          const purchaseSummary = await tx
            .select({
              paidCount: sql<number>`count(*) filter (where ${orders.status} in ('paid', 'partially_refunded'))::int`,
              pendingCount: sql<number>`count(*) filter (
                where ${orders.status} in ('pending_review', 'processing')
                  or (
                    ${orders.status} = 'pending_payment'
                    and (
                      ${orders.expiresAt} > now()
                      or exists (
                        select 1 from ${payments}
                        where ${payments.orderId} = ${orders.id}
                          and ${payments.provider} = 'wechatpay'
                          and ${inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES])}
                      )
                    )
                  )
              )::int`,
              activeSeatCount: sql<number>`count(*) filter (
                where ${orders.status} in ('pending_review', 'processing', 'paid', 'partially_refunded')
                  or (
                    ${orders.status} = 'pending_payment'
                    and (
                      ${orders.expiresAt} > now()
                      or exists (
                        select 1 from ${payments}
                        where ${payments.orderId} = ${orders.id}
                          and ${payments.provider} = 'wechatpay'
                          and ${inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES])}
                      )
                    )
                  )
              )::int`,
              resumePaymentOrderId: sql<string | null>`(
                array_agg(${orders.id} order by ${orders.createdAt} desc)
                filter (where ${orders.status} = 'pending_payment' and ${orders.expiresAt} > now())
              )[1]`,
            })
            .from(orders)
            .innerJoin(registrations, eq(registrations.id, orders.registrationId))
            .where(
              and(
                eq(orders.organizationId, session.organizationId),
                eq(orders.eventId, eventId),
                this.purchaserScope(session.customerUserId),
                isNull(registrations.supersededAt),
              ),
            )
            .then(
              (rows) =>
                rows[0] ?? {
                  paidCount: 0,
                  pendingCount: 0,
                  activeSeatCount: 0,
                  resumePaymentOrderId: null,
                },
            );
          return { event, eventSettings, releaseSnapshot, attendance, purchaseSummary };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    const registrationSettings = resolvePublishedRegistrationSettings(
      eventSettings,
      releaseSnapshot,
    );
    const maxActiveSeatsPerPurchaser = registrationSettings.maxActiveSeatsPerPurchaser;
    const paidCount = Number(purchaseSummary.paidCount);
    const pendingCount = Number(purchaseSummary.pendingCount);
    const activeSeatCount = Number(purchaseSummary.activeSeatCount);
    const additionalPurchaseEnabled = registrationSettings.additionalPurchaseEnabled;
    const checkoutAvailable =
      event.status === 'registration_open' &&
      registrationSettings.registrationOpen &&
      Boolean(eventSettings.currentReleaseId);
    const canPurchaseAdditional =
      checkoutAvailable &&
      additionalPurchaseEnabled &&
      pendingCount === 0 &&
      activeSeatCount < maxActiveSeatsPerPurchaser;
    const selfRegistrationState: EventPurchaseContext['selfRegistrationState'] = !attendance
      ? 'none'
      : !['draft', 'cancelled'].includes(attendance.registrationStatus) && attendance.orderIsActive
        ? 'active'
        : 'closed';
    const hasActiveSelfAttendance = selfRegistrationState === 'active';
    const canRegisterSelf =
      checkoutAvailable &&
      pendingCount === 0 &&
      activeSeatCount < maxActiveSeatsPerPurchaser &&
      (!attendance || attendance.canManageOrder) &&
      !hasActiveSelfAttendance;
    const recommendedActions: EventPurchaseContext['recommendedActions'] = [];
    if (purchaseSummary.resumePaymentOrderId) {
      recommendedActions.push('resume_payment');
    }
    if (attendance?.ticketCode && attendance.ticketStatus !== 'cancelled') {
      recommendedActions.push('view_ticket');
    }
    if (canPurchaseAdditional) recommendedActions.push('buy_more');
    if (canRegisterSelf) recommendedActions.push('register_self');
    return {
      eventId,
      additionalPurchaseEnabled,
      maxActiveSeatsPerPurchaser,
      activeSeatCount,
      remainingSeatCount: Math.max(maxActiveSeatsPerPurchaser - activeSeatCount, 0),
      canPurchaseAdditional,
      myAttendance: attendance
        ? {
            registrationId: attendance.registrationId,
            registrationStatus: attendance.registrationStatus,
            ticketCode: attendance.ticketCode,
            ticketStatus: attendance.ticketStatus,
          }
        : null,
      selfRegistrationState,
      myPurchases: { paidCount, pendingCount, activeSeatCount },
      resumePaymentOrderId: purchaseSummary.resumePaymentOrderId,
      recommendedActions,
    };
  }

  private purchasedOrder(row: {
    order: typeof orders.$inferSelect;
    registration: typeof registrations.$inferSelect;
    event: { name: string; slug: string };
    ticketTypeName: string;
    paymentStatus: string | null;
    ticket: { code: string; status: 'valid' | 'used' | 'cancelled' } | null;
    invoice: { id: string; status: (typeof invoiceRequests.$inferSelect)['status'] } | null;
  }): CustomerPurchasedOrder {
    const isProxyPurchase =
      row.registration.consentSnapshot.purchaseFor === 'other' ||
      Boolean(
        row.order.purchaserCustomerUserId &&
        row.registration.customerUserId !== row.order.purchaserCustomerUserId,
      );
    const canAccessTicket = purchaserCanAccessTicket(
      row.order.purchaserCustomerUserId,
      row.order.purchaseIntentId,
      row.registration.customerUserId,
      row.registration.consentSnapshot.purchaseFor,
    );
    return {
      id: row.order.id,
      orderNo: row.order.orderNo,
      registrationId: row.registration.id,
      eventId: row.order.eventId,
      eventName: row.event.name,
      eventSlug: row.event.slug,
      attendeeName: row.registration.attendee.name,
      attendeeMobile: row.registration.attendee.mobile,
      isProxyPurchase,
      attendeeClaimed: Boolean(row.registration.customerUserId),
      canEditAttendee:
        !row.registration.customerUserId &&
        !['refunded', 'closed'].includes(row.order.status) &&
        !['checked_in', 'cancelled'].includes(row.registration.status) &&
        row.ticket?.status !== 'used',
      ticketTypeName: row.ticketTypeName,
      status: row.order.status,
      paymentStatus: row.paymentStatus as CustomerPurchasedOrder['paymentStatus'],
      amount: row.order.amount,
      currency: row.order.currency,
      ticketCode: canAccessTicket ? (row.ticket?.code ?? null) : null,
      ticketStatus: canAccessTicket ? (row.ticket?.status ?? null) : null,
      invoiceId: row.invoice?.id ?? null,
      invoiceStatus: row.invoice?.status ?? null,
      expiresAt: row.order.expiresAt.toISOString(),
      createdAt: row.order.createdAt.toISOString(),
    };
  }

  async purchasedOrders(
    session: AuthenticatedCustomer,
    cursor?: string,
    limit = 20,
    orderId?: string,
  ): Promise<CustomerPurchasedOrderList> {
    const normalizedLimit = Math.min(Math.max(limit, 1), 50);
    const conditions: SQL[] = [
      eq(orders.organizationId, session.organizationId),
      this.purchaserScope(session.customerUserId),
      isNull(registrations.supersededAt),
    ];
    const sortAt = sql<Date>`date_trunc('milliseconds', ${orders.createdAt})`;
    if (orderId) conditions.push(eq(orders.id, orderId));
    if (cursor) {
      const decoded = this.decodeCursor(cursor);
      conditions.push(
        or(lt(sortAt, decoded.date), and(eq(sortAt, decoded.date), lt(orders.id, decoded.id)))!,
      );
    }
    const rows = await this.db()
      .select({
        order: orders,
        registration: registrations,
        event: { name: events.name, slug: events.slug },
        ticketTypeName: ticketTypes.name,
        paymentStatus: sql<string | null>`(
          select customer_order_payment.status::text
          from ${payments} customer_order_payment
          where customer_order_payment.order_id = ${orders.id}
          order by customer_order_payment.created_at desc, customer_order_payment.id desc
          limit 1
        )`,
        ticket: { code: tickets.code, status: tickets.status },
        invoice: { id: invoiceRequests.id, status: invoiceRequests.status },
      })
      .from(orders)
      .innerJoin(registrations, eq(registrations.id, orders.registrationId))
      .innerJoin(events, eq(events.id, orders.eventId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
      .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
      .leftJoin(invoiceRequests, eq(invoiceRequests.orderId, orders.id))
      .where(and(...conditions))
      .orderBy(desc(sortAt), desc(orders.id))
      .limit(normalizedLimit + 1);
    const hasMore = rows.length > normalizedLimit;
    const page = rows.slice(0, normalizedLimit);
    return {
      items: page.map((row) => this.purchasedOrder(row)),
      nextCursor: hasMore
        ? this.encodeCursor(page.at(-1)!.order.createdAt, page.at(-1)!.order.id)
        : null,
    };
  }

  async createOrderPaymentAccess(session: AuthenticatedCustomer, orderId: string) {
    return this.db().transaction(async (tx) => {
      const [order] = await tx
        .select({ id: orders.id, status: orders.status, expiresAt: orders.expiresAt })
        .from(orders)
        .innerJoin(registrations, eq(registrations.id, orders.registrationId))
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.organizationId, session.organizationId),
            this.purchaserScope(session.customerUserId),
            isNull(registrations.supersededAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!order) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
      }
      if (order.status !== 'pending_payment') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          order.status === 'processing' ? '支付结果正在确认中，请稍后刷新' : '当前订单无需继续支付',
          HttpStatus.CONFLICT,
        );
      }
      if (order.expiresAt <= new Date()) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '订单保留时间已结束，请返回报名页重新提交',
          HttpStatus.CONFLICT,
        );
      }

      const orderAccessToken = randomBytes(32).toString('base64url');
      await tx.insert(orderAccessTokens).values({
        orderId: order.id,
        tokenHash: sha256(orderAccessToken),
        scopes: ['order:read'],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      });
      return { orderId: order.id, orderAccessToken };
    });
  }

  async registration(
    session: AuthenticatedCustomer,
    registrationId: string,
  ): Promise<CustomerRegistrationDetail> {
    const [row] = await this.registrationRows(session.organizationId, session.customerUserId, {
      registrationId,
      limit: 1,
    });
    if (!row) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
    }
    return {
      ...this.registrationSummary(row, session.customerUserId),
      attendee: row.registration.attendee,
    };
  }

  private invoiceCenterConditions(category: CustomerInvoiceCenterCategory) {
    const successfulRefundAmount = sql<number>`coalesce((
      select sum(customer_invoice_refunds.amount)
      from refunds customer_invoice_refunds
      where customer_invoice_refunds.order_id = ${orders.id}
        and customer_invoice_refunds.status = 'succeeded'
    ), 0)`;
    const eligibleAmount = sql<number>`greatest(${orders.amount} - ${successfulRefundAmount}, 0)`;
    const eligible = and(
      isNull(invoiceRequests.id),
      inArray(orders.status, [...CUSTOMER_INVOICE_PAYMENT_ELIGIBLE_ORDER_STATUSES]),
      sql`exists (
        select 1
        from ${payments} customer_invoice_payments
        where customer_invoice_payments.order_id = ${orders.id}
          and customer_invoice_payments.status in ('succeeded', 'refunded')
          and customer_invoice_payments.succeeded_at is not null
      )`,
      gt(orders.amount, 0),
      gt(eligibleAmount, 0),
    )!;
    const actionRequired = inArray(invoiceRequests.status, [
      ...CUSTOMER_INVOICE_ACTION_REQUIRED_STATUSES,
    ]);
    const processing = inArray(invoiceRequests.status, [...CUSTOMER_INVOICE_PROCESSING_STATUSES]);
    const issued = eq(invoiceRequests.status, 'issued');
    const history = inArray(invoiceRequests.status, [...CUSTOMER_INVOICE_HISTORY_STATUSES]);
    const all = or(sql`${invoiceRequests.id} is not null`, eligible)!;
    const byCategory: Record<CustomerInvoiceCenterCategory, SQL> = {
      all,
      eligible,
      action_required: actionRequired,
      processing,
      issued,
      history,
    };
    return {
      successfulRefundAmount,
      eligibleAmount,
      eligible,
      actionRequired,
      processing,
      issued,
      history,
      all,
      selected: byCategory[category],
    };
  }

  async invoices(
    session: AuthenticatedCustomer,
    query: CustomerInvoiceCenterListQuery,
  ): Promise<CustomerInvoiceCenterList> {
    const normalizedLimit = Math.min(Math.max(query.limit, 1), 50);
    const conditions = this.invoiceCenterConditions(query.category);
    const baseScope = and(
      eq(registrations.organizationId, session.organizationId),
      this.purchaserScope(session.customerUserId),
      isNull(registrations.supersededAt),
    )!;
    const sortAt = sql<Date>`date_trunc('milliseconds', ${orders.createdAt})`;
    const pageConditions: SQL[] = [baseScope, conditions.selected];
    if (query.cursor) {
      const cursor = this.decodeCursor(query.cursor);
      pageConditions.push(
        or(lt(sortAt, cursor.date), and(eq(sortAt, cursor.date), lt(orders.id, cursor.id)))!,
      );
    }

    const [rows, countRow] = await this.db().transaction(
      async (tx) => {
        const pageRows = await tx
          .select({
            orderId: orders.id,
            orderNo: orders.orderNo,
            eventId: events.id,
            eventName: events.name,
            eventSlug: events.slug,
            startsAt: events.startsAt,
            orderAmount: orders.amount,
            eligibleAmount: conditions.eligibleAmount,
            currency: orders.currency,
            invoiceId: invoiceRequests.id,
            requestNo: invoiceRequests.requestNo,
            title: invoiceRequests.title,
            invoiceAmount: invoiceRequests.amount,
            status: invoiceRequests.status,
            requestedAt: invoiceRequests.requestedAt,
            updatedAt: invoiceRequests.updatedAt,
            sortAt,
            hasActiveDocument: sql<boolean>`exists (
              select 1
              from invoice_documents customer_invoice_documents
              where customer_invoice_documents.invoice_request_id = ${invoiceRequests.id}
                and customer_invoice_documents.voided_at is null
            )`,
            hasEmail: sql<boolean>`${invoiceRequests.email} is not null and btrim(${invoiceRequests.email}) <> ''`,
          })
          .from(registrations)
          .innerJoin(orders, eq(orders.registrationId, registrations.id))
          .innerJoin(events, eq(events.id, registrations.eventId))
          .leftJoin(invoiceRequests, eq(invoiceRequests.orderId, orders.id))
          .where(and(...pageConditions))
          .orderBy(desc(sortAt), desc(orders.id))
          .limit(normalizedLimit + 1);
        const [aggregate] = await tx
          .select({
            all: sql<number>`count(*) filter (where ${conditions.all})::int`,
            eligible: sql<number>`count(*) filter (where ${conditions.eligible})::int`,
            actionRequired: sql<number>`count(*) filter (where ${conditions.actionRequired})::int`,
            processing: sql<number>`count(*) filter (where ${conditions.processing})::int`,
            issued: sql<number>`count(*) filter (where ${conditions.issued})::int`,
            history: sql<number>`count(*) filter (where ${conditions.history})::int`,
          })
          .from(registrations)
          .innerJoin(orders, eq(orders.registrationId, registrations.id))
          .leftJoin(invoiceRequests, eq(invoiceRequests.orderId, orders.id))
          .where(baseScope);
        return [pageRows, aggregate] as const;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const hasMore = rows.length > normalizedLimit;
    const page = rows.slice(0, normalizedLimit);
    return CustomerInvoiceCenterListSchema.parse({
      items: page.map((row) => {
        const updatedAt = this.databaseDate(row.updatedAt ?? row.sortAt);
        return {
          orderId: row.orderId,
          orderNo: row.orderNo,
          eventId: row.eventId,
          eventName: row.eventName,
          eventSlug: row.eventSlug,
          startsAt: row.startsAt.toISOString(),
          orderAmount: row.orderAmount,
          eligibleAmount: Number(row.eligibleAmount),
          invoiceAmount: row.invoiceAmount,
          currency: row.currency,
          invoiceId: row.invoiceId,
          requestNo: row.requestNo,
          title: row.title,
          status: row.status,
          category: customerInvoiceCenterCategoryForStatus(row.status),
          requestedAt: row.requestedAt?.toISOString() ?? null,
          updatedAt: updatedAt.toISOString(),
          availableActions: customerInvoiceCenterActionsForStatus(
            row.status,
            Boolean(row.hasActiveDocument),
            Boolean(row.hasEmail),
          ),
        };
      }),
      counts: {
        all: Number(countRow?.all ?? 0),
        eligible: Number(countRow?.eligible ?? 0),
        actionRequired: Number(countRow?.actionRequired ?? 0),
        processing: Number(countRow?.processing ?? 0),
        issued: Number(countRow?.issued ?? 0),
        history: Number(countRow?.history ?? 0),
      },
      nextCursor: hasMore
        ? this.encodeCursor(this.databaseDate(page.at(-1)!.sortAt), page.at(-1)!.orderId)
        : null,
    });
  }

  async claimRegistration(
    session: AuthenticatedCustomer,
    input: ClaimCustomerRegistration,
  ): Promise<CustomerRegistrationDetail> {
    const db = this.db();
    const registrationId = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`customer-user:${session.organizationId}:${session.customer.mobile}`}, 0))`,
      );
      const [claimingUser] = await tx
        .select({
          id: customerUsers.id,
          status: customerUsers.status,
        })
        .from(customerUsers)
        .where(
          and(
            eq(customerUsers.id, session.customerUserId),
            eq(customerUsers.organizationId, session.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!claimingUser || claimingUser.status !== 'active') {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '用户会话已经失效，请重新登录',
          HttpStatus.UNAUTHORIZED,
        );
      }
      const [proof] = await tx
        .select({ token: orderAccessTokens, order: orders, registration: registrations })
        .from(orderAccessTokens)
        .innerJoin(orders, eq(orders.id, orderAccessTokens.orderId))
        .innerJoin(registrations, eq(registrations.id, orders.registrationId))
        .where(
          and(
            eq(orderAccessTokens.tokenHash, sha256(input.accessToken)),
            eq(orderAccessTokens.orderId, input.orderId),
            isNull(orderAccessTokens.revokedAt),
            gt(orderAccessTokens.expiresAt, new Date()),
            eq(orders.organizationId, session.organizationId),
            isNull(registrations.supersededAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!proof || !proof.token.scopes.includes('registration:claim')) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '报名认领凭证无效或已经过期',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (proof.registration.attendeeMobileE164 !== session.customer.mobile) {
        throw new DomainError(
          API_ERROR_CODES.FORBIDDEN,
          '请先登录后认领报名记录',
          HttpStatus.FORBIDDEN,
        );
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`registration-claim:${proof.registration.eventId}:${session.customerUserId}`}, 0))`,
      );
      if (
        proof.registration.customerUserId &&
        proof.registration.customerUserId !== session.customerUserId
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该报名记录已经属于其他账号',
          HttpStatus.CONFLICT,
        );
      }
      if (!proof.registration.customerUserId) {
        await tx
          .update(registrations)
          .set({
            customerUserId: session.customerUserId,
            attendeeMobileE164: session.customer.mobile,
            attendeeEmailNormalized: proof.registration.attendee.email.trim().toLowerCase(),
            updatedAt: new Date(),
          })
          .where(eq(registrations.id, proof.registration.id));
        await tx
          .update(customerUsers)
          .set({
            lastRegistrationAt: sql`greatest(
              coalesce(${customerUsers.lastRegistrationAt}, '-infinity'::timestamptz),
              ${proof.registration.createdAt}
            )`,
            updatedAt: new Date(),
          })
          .where(eq(customerUsers.id, session.customerUserId));
        await tx.insert(auditLogs).values({
          organizationId: session.organizationId,
          eventId: proof.registration.eventId,
          actorId: session.customerUserId,
          actorType: 'customer',
          action: 'customer.registration.claim',
          resourceType: 'registration',
          resourceId: proof.registration.id,
          before: { customerUserId: null },
          after: { customerUserId: session.customerUserId, orderId: input.orderId },
          traceId: crypto.randomUUID(),
        });
      }
      await tx
        .update(orderAccessTokens)
        .set({
          lastUsedAt: new Date(),
          scopes: proof.token.scopes.filter((scope) => scope !== 'registration:claim'),
        })
        .where(eq(orderAccessTokens.id, proof.token.id));
      return proof.registration.id;
    });
    return this.registration(session, registrationId);
  }

  async claimAttendee(
    session: AuthenticatedCustomer,
    input: AttendeeClaimInput,
  ): Promise<AttendeeClaimResult> {
    const db = this.db();
    const claimedAt = await db.transaction(async (tx) => {
      const now = new Date();
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`attendee-claim:${input.registrationId}:${session.customerUserId}`}, 0))`,
      );
      const [claimingUser] = await tx
        .select({ id: customerUsers.id, status: customerUsers.status })
        .from(customerUsers)
        .where(
          and(
            eq(customerUsers.id, session.customerUserId),
            eq(customerUsers.organizationId, session.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!claimingUser || claimingUser.status !== 'active') {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '用户会话已经失效，请重新登录',
          HttpStatus.UNAUTHORIZED,
        );
      }
      const [registration] = await tx
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.id, input.registrationId),
            eq(registrations.organizationId, session.organizationId),
            isNull(registrations.supersededAt),
          ),
        )
        .for('update')
        .limit(1);
      const [claim] = registration
        ? await tx
            .select()
            .from(attendeeClaimTokens)
            .where(
              and(
                eq(attendeeClaimTokens.registrationId, registration.id),
                eq(attendeeClaimTokens.tokenHash, sha256(input.claimToken)),
              ),
            )
            .for('update')
            .limit(1)
        : [];
      const proof = registration && claim ? { registration, claim } : null;
      if (
        !proof ||
        proof.claim.consumedAt ||
        proof.claim.revokedAt ||
        proof.claim.expiresAt <= now
      ) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '参会名额认领凭证无效或已经过期',
          HttpStatus.UNAUTHORIZED,
        );
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`attendee-claim-event:${proof.registration.eventId}:${session.customerUserId}`}, 0))`,
      );
      if (
        proof.claim.mobileDigest !== sha256(session.customer.mobile) ||
        proof.registration.attendeeMobileE164 !== session.customer.mobile
      ) {
        throw new DomainError(
          API_ERROR_CODES.FORBIDDEN,
          '请使用参会人报名手机号登录后认领',
          HttpStatus.FORBIDDEN,
        );
      }
      if (['draft', 'cancelled'].includes(proof.registration.status)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前报名状态无法认领',
          HttpStatus.CONFLICT,
        );
      }
      if (
        proof.registration.customerUserId &&
        proof.registration.customerUserId !== session.customerUserId
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该参会名额已经被其他账号认领',
          HttpStatus.CONFLICT,
        );
      }
      const [existingAttendance] = await tx
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.organizationId, session.organizationId),
            eq(registrations.eventId, proof.registration.eventId),
            eq(registrations.customerUserId, session.customerUserId),
            isNull(registrations.supersededAt),
            sql`${registrations.id} <> ${proof.registration.id}`,
          ),
        )
        .limit(1);
      if (existingAttendance) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前账号已经拥有本场大会的报名记录',
          HttpStatus.CONFLICT,
        );
      }
      const [consumed] = await tx
        .update(attendeeClaimTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(attendeeClaimTokens.id, proof.claim.id),
            isNull(attendeeClaimTokens.consumedAt),
            isNull(attendeeClaimTokens.revokedAt),
            gt(attendeeClaimTokens.expiresAt, now),
          ),
        )
        .returning({ id: attendeeClaimTokens.id });
      if (!consumed) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '参会名额认领凭证已经使用',
          HttpStatus.UNAUTHORIZED,
        );
      }
      await tx
        .update(registrations)
        .set({ customerUserId: session.customerUserId, updatedAt: now })
        .where(eq(registrations.id, proof.registration.id));
      await tx
        .update(customerUsers)
        .set({
          lastRegistrationAt: sql`greatest(
            coalesce(${customerUsers.lastRegistrationAt}, '-infinity'::timestamptz),
            ${proof.registration.createdAt}
          )`,
          updatedAt: now,
        })
        .where(eq(customerUsers.id, session.customerUserId));
      await tx.insert(auditLogs).values({
        organizationId: session.organizationId,
        eventId: proof.registration.eventId,
        actorId: session.customerUserId,
        actorType: 'customer',
        action: 'customer.attendee.claim',
        resourceType: 'registration',
        resourceId: proof.registration.id,
        before: { customerUserId: proof.registration.customerUserId },
        after: { customerUserId: session.customerUserId, claimTokenId: proof.claim.id },
        traceId: crypto.randomUUID(),
      });
      return now;
    });
    return {
      claimed: true,
      claimedAt: claimedAt.toISOString(),
      registration: await this.registration(session, input.registrationId),
    };
  }

  async updatePurchasedOrderAttendee(
    session: AuthenticatedCustomer,
    orderId: string,
    input: UpdatePurchasedOrderAttendee,
  ): Promise<CustomerPurchasedOrder> {
    const db = this.db();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          const [orderIdentity] = await tx
            .select({ eventId: orders.eventId })
            .from(orders)
            .where(and(eq(orders.id, orderId), eq(orders.organizationId, session.organizationId)))
            .limit(1);
          let requestedMobile: string | undefined;
          if (input.mobile !== undefined) {
            try {
              requestedMobile = normalizeMainlandMobile(input.mobile);
            } catch {
              throw new DomainError(
                API_ERROR_CODES.VALIDATION_ERROR,
                '请输入有效的中国大陆手机号',
                HttpStatus.BAD_REQUEST,
              );
            }
          }
          if (orderIdentity && requestedMobile) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`registration-mobile:${orderIdentity.eventId}:${requestedMobile}`}, 0))`,
            );
          }
          const [order] = await tx
            .select()
            .from(orders)
            .where(and(eq(orders.id, orderId), eq(orders.organizationId, session.organizationId)))
            .for('update')
            .limit(1);
          const [registration] = order
            ? await tx
                .select()
                .from(registrations)
                .where(
                  and(
                    eq(registrations.id, order.registrationId),
                    eq(registrations.organizationId, session.organizationId),
                    isNull(registrations.supersededAt),
                  ),
                )
                .for('update')
                .limit(1)
            : [];
          if (
            !order ||
            !registration ||
            !customerCanManageOrder(
              order.purchaserCustomerUserId,
              order.purchaseIntentId,
              registration.customerUserId,
              session.customerUserId,
            )
          ) {
            throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
          }
          const scope = { order, registration };
          const [ticket] = await tx
            .select()
            .from(tickets)
            .where(eq(tickets.registrationId, scope.registration.id))
            .for('update')
            .limit(1);
          const activeClaims = await tx
            .select()
            .from(attendeeClaimTokens)
            .where(
              and(
                eq(attendeeClaimTokens.registrationId, scope.registration.id),
                isNull(attendeeClaimTokens.consumedAt),
                isNull(attendeeClaimTokens.revokedAt),
              ),
            )
            .for('update');
          if (scope.registration.customerUserId) {
            throw new DomainError(
              API_ERROR_CODES.INVALID_STATE_TRANSITION,
              '参会人已认领该名额，请由参会人维护个人信息',
              HttpStatus.CONFLICT,
            );
          }
          if (
            ['refunded', 'closed'].includes(scope.order.status) ||
            scope.registration.status === 'checked_in' ||
            ticket?.status === 'used'
          ) {
            throw new DomainError(
              API_ERROR_CODES.INVALID_STATE_TRANSITION,
              '当前订单或票券状态无法修改参会人',
              HttpStatus.CONFLICT,
            );
          }
          const currentAttendee = {
            ...scope.registration.attendee,
            mobile: scope.registration.attendeeMobileE164,
            email: scope.registration.attendeeEmailNormalized,
          };
          const normalizedEmail = input.email?.trim().toLowerCase();
          const {
            attendee: normalizedAttendee,
            changedFields,
            contactChanged,
          } = attendeeUpdateDiff(currentAttendee, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(requestedMobile !== undefined ? { mobile: requestedMobile } : {}),
            ...(normalizedEmail !== undefined ? { email: normalizedEmail } : {}),
            ...(input.company !== undefined ? { company: input.company } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.city !== undefined ? { city: input.city } : {}),
          });
          if (changedFields.length === 0) return;
          const attendee = {
            ...scope.registration.attendee,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(requestedMobile !== undefined ? { mobile: requestedMobile } : {}),
            ...(normalizedEmail !== undefined ? { email: normalizedEmail } : {}),
            ...(input.company !== undefined ? { company: input.company } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.city !== undefined ? { city: input.city } : {}),
          };

          const now = new Date();
          if (contactChanged) {
            const [recentContactUpdate] = await tx
              .select({ id: auditLogs.id })
              .from(auditLogs)
              .where(
                and(
                  eq(auditLogs.organizationId, session.organizationId),
                  eq(auditLogs.actorId, session.customerUserId),
                  eq(auditLogs.action, 'customer.order.attendee.update'),
                  eq(auditLogs.resourceType, 'registration'),
                  eq(auditLogs.resourceId, scope.registration.id),
                  gt(auditLogs.createdAt, new Date(now.getTime() - 10 * 60_000)),
                  sql`(${auditLogs.after}->'changedFields') ?| array['mobile', 'email']`,
                ),
              )
              .limit(1);
            if (recentContactUpdate) {
              throw new DomainError(
                API_ERROR_CODES.INVALID_STATE_TRANSITION,
                '参会人联系方式10分钟内只能修改一次，请稍后再试',
                HttpStatus.TOO_MANY_REQUESTS,
              );
            }
          }
          if (changedFields.includes('mobile')) {
            const [duplicate] = await tx
              .select({ id: registrations.id })
              .from(registrations)
              .where(
                and(
                  eq(registrations.organizationId, session.organizationId),
                  eq(registrations.eventId, scope.registration.eventId),
                  eq(registrations.attendeeMobileE164, normalizedAttendee.mobile),
                  isNull(registrations.supersededAt),
                  sql`${registrations.id} <> ${scope.registration.id}`,
                ),
              )
              .limit(1);
            if (duplicate) {
              throw new DomainError(
                API_ERROR_CODES.REGISTRATION_IDENTITY_CONFLICT,
                '该手机号已经报名本场大会',
                HttpStatus.CONFLICT,
              );
            }
          }
          await tx
            .update(registrations)
            .set({
              attendee,
              attendeeMobileE164: normalizedAttendee.mobile,
              attendeeEmailNormalized: normalizedAttendee.email,
              updatedAt: now,
            })
            .where(eq(registrations.id, scope.registration.id));
          if (contactChanged) {
            if (activeClaims.length > 0) {
              await tx
                .update(attendeeClaimTokens)
                .set({ revokedAt: now })
                .where(
                  inArray(
                    attendeeClaimTokens.id,
                    activeClaims.map((claim) => claim.id),
                  ),
                );
            }
            const claimToken = randomBytes(32).toString('base64url');
            const [claim] = await tx
              .insert(attendeeClaimTokens)
              .values({
                registrationId: scope.registration.id,
                tokenHash: sha256(claimToken),
                mobileDigest: sha256(normalizedAttendee.mobile),
                expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
              })
              .returning({ id: attendeeClaimTokens.id });
            await tx.insert(outboxEvents).values({
              organizationId: session.organizationId,
              eventId: scope.registration.eventId,
              eventType: 'AttendeeClaimInvitationRequested',
              correlationId: `attendee-claim:update:${scope.registration.id}:${claim!.id}`,
              payload: {
                registrationId: scope.registration.id,
                recipientRole: 'attendee',
                recipient: normalizedAttendee.email || normalizedAttendee.mobile,
                sealedAttendeeClaimToken: sealSecret(claimToken, this.notificationSecret()),
              },
            });
          }
          await tx.insert(auditLogs).values({
            organizationId: session.organizationId,
            eventId: scope.registration.eventId,
            actorId: session.customerUserId,
            actorType: 'customer',
            action: 'customer.order.attendee.update',
            resourceType: 'registration',
            resourceId: scope.registration.id,
            before: { attendee: currentAttendee },
            after: { attendee, changedFields },
            traceId: crypto.randomUUID(),
          });
        });
        break;
      } catch (error) {
        const errorCode =
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : error &&
                typeof error === 'object' &&
                'cause' in error &&
                error.cause &&
                typeof error.cause === 'object' &&
                'code' in error.cause
              ? String(error.cause.code)
              : '';
        if (errorCode === '40P01' && attempt === 0) continue;
        if (errorCode === '23505') {
          throw new DomainError(
            API_ERROR_CODES.REGISTRATION_IDENTITY_CONFLICT,
            '该手机号已经报名本场大会',
            HttpStatus.CONFLICT,
          );
        }
        throw error;
      }
    }
    const ordersPage = await this.purchasedOrders(session, undefined, 1, orderId);
    const updated = ordersPage.items.find((order) => order.id === orderId);
    if (!updated) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '订单不存在', HttpStatus.NOT_FOUND);
    }
    return updated;
  }

  adminList(organizationId: string, query: CustomerAdminListQuery): Promise<CustomerAdminList> {
    return this.adminListPage(organizationId, query, this.db()).then((result) => ({
      ...result,
      pageSize: ADMIN_CUSTOMER_PAGE_SIZE,
    }));
  }

  async adminCreate(
    organizationId: string,
    actorId: string,
    input: CreateCustomerAdmin,
  ): Promise<CreateCustomerAdminResult> {
    let mobile: string;
    try {
      mobile = normalizeMainlandMobile(input.mobile);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '请输入有效的中国大陆手机号',
        HttpStatus.BAD_REQUEST,
      );
    }

    const db = this.db();
    const publicUserId = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`customer-user:${organizationId}:${mobile}`}, 0))`,
      );
      const [existing] = await tx
        .select({ id: customerUsers.id })
        .from(customerUsers)
        .where(
          and(
            eq(customerUsers.organizationId, organizationId),
            eq(customerUsers.mobileE164, mobile),
          ),
        )
        .limit(1);
      if (existing) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该手机号已经是普通用户',
          HttpStatus.CONFLICT,
        );
      }

      const now = new Date();
      const [user] = await tx
        .insert(customerUsers)
        .values({
          organizationId,
          mobileE164: mobile,
          verifiedAt: now,
        })
        .returning({ id: customerUsers.id });
      await tx.insert(customerProfiles).values({
        customerUserId: user!.id,
        nickname: input.nickname || null,
        realName: input.realName || null,
        email: input.email || null,
        company: input.company || null,
        title: input.title || null,
        city: input.city || null,
      });
      const [publicIdRow] = await tx
        .select({ publicId: publicUserIds.publicId })
        .from(publicUserIds)
        .where(
          and(
            eq(publicUserIds.subjectType, 'customer'),
            eq(publicUserIds.subjectUuid, user!.id),
            isNull(publicUserIds.retiredAt),
          ),
        )
        .limit(1);
      if (!publicIdRow) throw new Error('新建用户缺少数字用户 ID');

      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        actorType: 'staff',
        action: 'customer.admin.create',
        resourceType: 'customer_user',
        resourceId: String(publicIdRow.publicId),
        after: {
          status: 'active',
          hasEmail: Boolean(input.email),
          profileFields: ['nickname', 'realName', 'email', 'company', 'title', 'city'].filter(
            (field) => Boolean(input[field as keyof CreateCustomerAdmin]),
          ),
        },
        traceId: crypto.randomUUID(),
      });
      return publicIdRow.publicId;
    });

    return { customerId: publicUserId };
  }

  private async adminListPage(
    organizationId: string,
    query: CustomerAdminListQuery,
    database: CustomerListDatabase,
    pageSize: number = ADMIN_CUSTOMER_PAGE_SIZE,
    knownTotal?: number,
  ) {
    const baseConditions: SQL[] = [
      eq(customerUsers.organizationId, organizationId),
      eq(publicUserIds.subjectType, 'customer'),
      isNull(publicUserIds.retiredAt),
    ];
    if (query.status) baseConditions.push(eq(customerUsers.status, query.status));
    if (query.q) {
      const numericId = /^\d+$/.test(query.q) ? Number(query.q) : null;
      if (
        numericId !== null &&
        Number.isSafeInteger(numericId) &&
        numericId >= 101 &&
        numericId <= 2_147_483_647
      ) {
        baseConditions.push(eq(publicUserIds.publicId, numericId));
      } else {
        const pattern = `%${escapeLikePattern(query.q)}%`;
        baseConditions.push(
          or(
            ilike(customerUsers.mobileE164, pattern),
            ilike(customerProfiles.nickname, pattern),
            ilike(customerProfiles.realName, pattern),
            ilike(customerProfiles.email, pattern),
            ilike(customerProfiles.company, pattern),
          )!,
        );
      }
    }
    if (query.eventId) {
      baseConditions.push(
        sql`exists (
          select 1 from registrations customer_registration_filter
          where customer_registration_filter.customer_user_id = ${customerUsers.id}
            and customer_registration_filter.event_id = ${query.eventId}
        )`,
      );
    }
    const totalRow =
      knownTotal === undefined
        ? await database
            .select({ value: sql<number>`count(*)::int` })
            .from(customerUsers)
            .leftJoin(customerProfiles, eq(customerProfiles.customerUserId, customerUsers.id))
            .innerJoin(publicUserIds, eq(publicUserIds.subjectUuid, customerUsers.id))
            .where(and(...baseConditions))
            .then((result) => result[0])
        : { value: knownTotal };
    const total = Number(totalRow?.value ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(query.page, totalPages);
    const page = await database
      .select({
        user: customerUsers,
        profile: customerProfiles,
        publicUserId: publicUserIds.publicId,
      })
      .from(customerUsers)
      .leftJoin(customerProfiles, eq(customerProfiles.customerUserId, customerUsers.id))
      .innerJoin(publicUserIds, eq(publicUserIds.subjectUuid, customerUsers.id))
      .where(and(...baseConditions))
      .orderBy(
        sql`coalesce(${customerUsers.lastRegistrationAt}, ${customerUsers.createdAt}) desc`,
        desc(publicUserIds.publicId),
      )
      .limit(pageSize)
      .offset((currentPage - 1) * pageSize);
    const pageUserIds = page.map(({ user }) => user.id);
    const invoiceOwner = sql<string | null>`case
      when ${orders.purchaserCustomerUserId} is not null then ${orders.purchaserCustomerUserId}
      when ${orders.purchaseIntentId} is null then ${registrations.customerUserId}
      else null
    end`;
    const [statistics, latestRegistrations, invoiceStatistics] =
      pageUserIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            database
              .select({
                customerUserId: registrations.customerUserId,
                registrationsCount: sql<number>`count(distinct ${registrations.id})::int`,
                eventCount: sql<number>`count(distinct ${registrations.eventId})::int`,
                activeEventCount: sql<number>`count(distinct ${registrations.eventId}) filter (where ${registrations.status} <> 'cancelled')::int`,
                showcaseCount: sql<number>`count(distinct ${attendeeShowcaseProfiles.id})::int`,
                publicShowcaseCount: sql<number>`count(distinct ${attendeeShowcaseProfiles.id}) filter (
                  where ${attendeeShowcasePublicEligibilitySql()}
                )::int`,
                latestEventName: sql<
                  string | null
                >`(array_agg(${events.name} order by ${registrations.createdAt} desc))[1]`,
              })
              .from(registrations)
              .innerJoin(events, eq(events.id, registrations.eventId))
              .leftJoin(
                attendeeShowcaseProfiles,
                eq(attendeeShowcaseProfiles.registrationId, registrations.id),
              )
              .leftJoin(orders, eq(orders.registrationId, registrations.id))
              .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
              .innerJoin(customerUsers, eq(customerUsers.id, registrations.customerUserId))
              .where(
                and(
                  inArray(registrations.customerUserId, pageUserIds),
                  isNull(registrations.supersededAt),
                ),
              )
              .groupBy(registrations.customerUserId),
            database
              .selectDistinctOn([registrations.customerUserId], {
                customerUserId: registrations.customerUserId,
                id: registrations.id,
                eventId: registrations.eventId,
                eventName: events.name,
                eventStartsAt: events.startsAt,
                ticketTypeName: ticketTypes.name,
                registrationCode: registrations.registrationCode,
                registrationStatus: registrations.status,
                attendee: registrations.attendee,
                createdAt: registrations.createdAt,
              })
              .from(registrations)
              .innerJoin(events, eq(events.id, registrations.eventId))
              .innerJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
              .where(
                and(
                  inArray(registrations.customerUserId, pageUserIds),
                  isNull(registrations.supersededAt),
                ),
              )
              .orderBy(
                asc(registrations.customerUserId),
                desc(registrations.createdAt),
                desc(registrations.id),
              ),
            database
              .select({
                customerUserId: invoiceOwner,
                invoiceCount: sql<number>`count(distinct ${invoiceRequests.id})::int`,
              })
              .from(invoiceRequests)
              .innerJoin(orders, eq(orders.id, invoiceRequests.orderId))
              .innerJoin(registrations, eq(registrations.id, orders.registrationId))
              .where(
                and(
                  eq(invoiceRequests.organizationId, organizationId),
                  inArray(invoiceOwner, pageUserIds),
                  isNull(registrations.supersededAt),
                ),
              )
              .groupBy(invoiceOwner),
          ]);
    const statisticsByUser = new Map(statistics.map((row) => [row.customerUserId, row] as const));
    const invoiceStatisticsByUser = new Map(
      invoiceStatistics.flatMap((row) =>
        row.customerUserId ? ([[row.customerUserId, row]] as const) : [],
      ),
    );
    const latestByUser = new Map(
      latestRegistrations.flatMap((row) =>
        row.customerUserId ? ([[row.customerUserId, row]] as const) : [],
      ),
    );
    const items: CustomerAdminSummary[] = page.map(({ user, profile, publicUserId }) => {
      const userStatistics = statisticsByUser.get(user.id);
      const latest = latestByUser.get(user.id);
      const latestRegistration = latest
        ? {
            id: latest.id,
            eventId: latest.eventId,
            eventName: latest.eventName,
            eventStartsAt: latest.eventStartsAt.toISOString(),
            ticketTypeName: latest.ticketTypeName,
            registrationCode: latest.registrationCode,
            registrationStatus: latest.registrationStatus,
            attendeeName: latest.attendee.name,
            attendeeCompany: latest.attendee.company,
            createdAt: latest.createdAt.toISOString(),
          }
        : null;
      const display = resolveCustomerAdminDisplay(profile ?? {}, latestRegistration);
      return {
        id: publicUserId,
        mobile: user.mobileE164,
        maskedMobile: maskMobile(user.mobileE164),
        status: user.status,
        nickname: profile?.nickname ?? null,
        realName: profile?.realName ?? null,
        email: profile?.email ?? null,
        company: profile?.company ?? null,
        ...display,
        registrationsCount: Number(userStatistics?.registrationsCount ?? 0),
        eventCount: Number(userStatistics?.eventCount ?? 0),
        activeEventCount: Number(userStatistics?.activeEventCount ?? 0),
        invoiceCount: Number(invoiceStatisticsByUser.get(user.id)?.invoiceCount ?? 0),
        showcaseCount: Number(userStatistics?.showcaseCount ?? 0),
        publicShowcaseCount: Number(userStatistics?.publicShowcaseCount ?? 0),
        latestEventName: userStatistics?.latestEventName ?? null,
        latestRegistration,
        lastRegistrationAt: user.lastRegistrationAt?.toISOString() ?? null,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
      };
    });
    return {
      items,
      total,
      page: currentPage,
      pageSize,
      totalPages,
    };
  }

  async adminExportCsv(organizationId: string, actorId: string, query: CustomerAdminExportQuery) {
    const baseQuery: CustomerAdminListQuery = { ...query, page: 1 };
    const exported = await this.db().transaction(
      async (tx) => {
        let page = await this.adminListPage(organizationId, baseQuery, tx, 1_000);
        if (page.total > MAX_CUSTOMER_EXPORT_ROWS) {
          throw new DomainError(
            API_ERROR_CODES.VALIDATION_ERROR,
            `当前筛选结果为 ${page.total} 条，单次最多导出 ${MAX_CUSTOMER_EXPORT_ROWS} 条，请增加筛选条件后重试`,
            HttpStatus.BAD_REQUEST,
          );
        }

        const lines = [CUSTOMER_EXPORT_HEADER.map(csvCell).join(',')];
        let count = 0;
        for (let pageNumber = 1; pageNumber <= page.totalPages; pageNumber += 1) {
          if (pageNumber > 1) {
            page = await this.adminListPage(
              organizationId,
              { ...baseQuery, page: pageNumber },
              tx,
              1_000,
              page.total,
            );
          }
          lines.push(...page.items.map(customerExportCsvLine));
          count += page.items.length;
        }
        return { count, csv: `\uFEFF${lines.join('\r\n')}` };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    await this.db()
      .insert(auditLogs)
      .values({
        organizationId,
        actorId,
        actorType: 'staff',
        action: 'customer.export',
        resourceType: 'customer_directory',
        resourceId: organizationId,
        after: {
          status: query.status ?? null,
          eventId: query.eventId ?? null,
          hasSearch: Boolean(query.q),
          count: exported.count,
        },
        traceId: crypto.randomUUID(),
      });
    return {
      csv: exported.csv,
      count: exported.count,
      filename: `customers-${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }

  async adminDetail(organizationId: string, publicUserId: number): Promise<CustomerAdminDetail> {
    const customerUserId = await this.resolveCustomerUserUuid(organizationId, publicUserId);
    if (!customerUserId) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '用户不存在', HttpStatus.NOT_FOUND);
    }
    const [row] = await this.db()
      .select({ user: customerUsers, profile: customerProfiles })
      .from(customerUsers)
      .innerJoin(customerProfiles, eq(customerProfiles.customerUserId, customerUsers.id))
      .where(
        and(eq(customerUsers.id, customerUserId), eq(customerUsers.organizationId, organizationId)),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '用户不存在', HttpStatus.NOT_FOUND);
    }
    const registrationPage = await this.registrationPage(
      organizationId,
      customerUserId,
      undefined,
      50,
    );
    const [invoicePage, showcases] = await Promise.all([
      this.invoicePage(organizationId, customerUserId),
      this.attendeeShowcases?.adminShowcases(organizationId, publicUserId) ?? Promise.resolve([]),
    ]);
    return {
      customer: {
        id: publicUserId,
        organizationId: row.user.organizationId,
        mobile: row.user.mobileE164,
        maskedMobile: maskMobile(row.user.mobileE164),
        status: row.user.status,
        verifiedAt: row.user.verifiedAt.toISOString(),
        lastLoginAt: row.user.lastLoginAt?.toISOString() ?? null,
        createdAt: row.user.createdAt.toISOString(),
        profile: {
          nickname: row.profile.nickname,
          realName: row.profile.realName,
          email: row.profile.email,
          company: row.profile.company,
          title: row.profile.title,
          city: row.profile.city,
          version: row.profile.version,
        },
      },
      internalNote: row.user.internalNote,
      tags: row.user.tags,
      registrations: registrationPage.items,
      registrationNextCursor: registrationPage.nextCursor,
      invoices: invoicePage.items,
      invoiceNextCursor: invoicePage.nextCursor,
      showcases,
    };
  }

  private async invoicePage(
    organizationId: string,
    customerUserId: string,
    cursor?: string,
    limit = 50,
  ): Promise<CustomerInvoiceList> {
    const normalizedLimit = Math.min(Math.max(limit, 1), 50);
    const conditions: SQL[] = [
      eq(invoiceRequests.organizationId, organizationId),
      this.purchaserScope(customerUserId),
      isNull(registrations.supersededAt),
    ];
    if (cursor) {
      const decoded = this.decodeCursor(cursor);
      conditions.push(
        or(
          lt(invoiceRequests.requestedAt, decoded.date),
          and(eq(invoiceRequests.requestedAt, decoded.date), lt(invoiceRequests.id, decoded.id)),
        )!,
      );
    }
    const rows = await this.db()
      .select({
        id: invoiceRequests.id,
        requestNo: invoiceRequests.requestNo,
        eventName: events.name,
        title: invoiceRequests.title,
        amount: invoiceRequests.amount,
        status: invoiceRequests.status,
        requestedAt: invoiceRequests.requestedAt,
      })
      .from(invoiceRequests)
      .innerJoin(events, eq(events.id, invoiceRequests.eventId))
      .innerJoin(registrations, eq(registrations.id, invoiceRequests.registrationId))
      .innerJoin(orders, eq(orders.id, invoiceRequests.orderId))
      .where(and(...conditions))
      .orderBy(desc(invoiceRequests.requestedAt), desc(invoiceRequests.id))
      .limit(normalizedLimit + 1);
    const hasMore = rows.length > normalizedLimit;
    const page = rows.slice(0, normalizedLimit);
    return {
      items: page.map((invoice) => ({
        ...invoice,
        requestedAt: invoice.requestedAt.toISOString(),
      })),
      nextCursor: hasMore ? this.encodeCursor(page.at(-1)!.requestedAt, page.at(-1)!.id) : null,
    };
  }

  async adminRegistrations(
    organizationId: string,
    publicUserId: number,
    cursor?: string,
    limit = 50,
  ) {
    const customerUserId = await this.resolveCustomerUserUuid(organizationId, publicUserId);
    if (!customerUserId) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '用户不存在', HttpStatus.NOT_FOUND);
    }
    return this.registrationPage(organizationId, customerUserId, cursor, limit);
  }

  async adminInvoices(organizationId: string, publicUserId: number, cursor?: string, limit = 50) {
    const customerUserId = await this.resolveCustomerUserUuid(organizationId, publicUserId);
    if (!customerUserId) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '用户不存在', HttpStatus.NOT_FOUND);
    }
    return this.invoicePage(organizationId, customerUserId, cursor, limit);
  }

  async adminUpdate(
    organizationId: string,
    actorId: string,
    publicUserId: number,
    input: UpdateCustomerAdmin,
  ) {
    const db = this.db();
    const customerUserId = await this.resolveCustomerUserUuid(organizationId, publicUserId, db);
    if (!customerUserId) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '用户不存在', HttpStatus.NOT_FOUND);
    }
    await db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(customerUsers)
        .where(
          and(
            eq(customerUsers.id, customerUserId),
            eq(customerUsers.organizationId, organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!user) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '用户不存在', HttpStatus.NOT_FOUND);
      }
      if (input.profile) {
        const [profile] = await tx
          .select()
          .from(customerProfiles)
          .where(eq(customerProfiles.customerUserId, customerUserId))
          .for('update')
          .limit(1);
        if (!profile || profile.version !== input.profile.version) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '用户资料已更新，请刷新后重试',
            HttpStatus.CONFLICT,
          );
        }
        await tx
          .update(customerProfiles)
          .set({
            nickname: input.profile.nickname || null,
            realName: input.profile.realName || null,
            email: input.profile.email,
            company: input.profile.company || null,
            title: input.profile.title || null,
            city: input.profile.city || null,
            version: profile.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(customerProfiles.customerUserId, customerUserId));
      }
      await tx
        .update(customerUsers)
        .set({
          ...(input.status ? { status: input.status } : {}),
          ...(input.internalNote !== undefined ? { internalNote: input.internalNote } : {}),
          ...(input.tags ? { tags: [...new Set(input.tags)] } : {}),
          updatedAt: new Date(),
        })
        .where(eq(customerUsers.id, customerUserId));
      if (input.status === 'blocked' && user.status !== 'blocked') {
        await tx
          .update(customerSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(customerSessions.customerUserId, customerUserId),
              eq(customerSessions.organizationId, organizationId),
              isNull(customerSessions.revokedAt),
            ),
          );
      }
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        actorType: 'staff',
        action: 'customer.admin.update',
        resourceType: 'customer_user',
        resourceId: String(publicUserId),
        before: {
          status: user.status,
        },
        after: {
          status: input.status ?? user.status,
          profileFieldsChanged: input.profile
            ? ['nickname', 'realName', 'email', 'company', 'title', 'city']
            : [],
          internalNoteChanged: input.internalNote !== undefined,
          tagCount: input.tags?.length ?? user.tags.length,
        },
        traceId: crypto.randomUUID(),
      });
    });
    return this.adminDetail(organizationId, publicUserId);
  }

  async adminDelete(organizationId: string, actorId: string, publicUserId: number) {
    const db = this.db();
    const customerUserId = await this.resolveCustomerUserUuid(organizationId, publicUserId, db);
    if (!customerUserId) {
      return {
        deleted: true as const,
        detachedRegistrations: 0,
        detachedWaitlistEntries: 0,
        detachedPurchaserOrders: 0,
      };
    }
    return withPostgresTransactionRetry(() =>
      db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({
            mobileE164: customerUsers.mobileE164,
          })
          .from(customerUsers)
          .where(
            and(
              eq(customerUsers.id, customerUserId),
              eq(customerUsers.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!candidate) {
          return {
            deleted: true as const,
            detachedRegistrations: 0,
            detachedWaitlistEntries: 0,
            detachedPurchaserOrders: 0,
          };
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`customer-user:${organizationId}:${candidate.mobileE164}`}, 0))`,
        );
        const [user] = await tx
          .select({
            id: customerUsers.id,
            mobileE164: customerUsers.mobileE164,
            status: customerUsers.status,
          })
          .from(customerUsers)
          .where(
            and(
              eq(customerUsers.id, customerUserId),
              eq(customerUsers.organizationId, organizationId),
            ),
          )
          .for('update')
          .limit(1);
        if (!user) {
          return {
            deleted: true as const,
            detachedRegistrations: 0,
            detachedWaitlistEntries: 0,
            detachedPurchaserOrders: 0,
          };
        }

        const avatarAssets = await tx
          .select()
          .from(customerMediaAssets)
          .where(
            and(
              eq(customerMediaAssets.organizationId, organizationId),
              eq(customerMediaAssets.customerUserId, customerUserId),
            ),
          )
          .for('update');
        if (avatarAssets.length > 0) {
          await tx.insert(outboxEvents).values(
            avatarAssets.map((asset) => ({
              organizationId,
              eventType: 'CustomerAvatarDeletionRequested',
              correlationId: `customer-avatar:account-delete:${asset.id}`,
              payload: {
                assetId: asset.id,
                organizationId,
                customerUserId,
                sourceStorageKey: asset.sourceStorageKey,
                outputStorageKey:
                  asset.outputStorageKey ??
                  `customers/${organizationId}/${customerUserId}/avatars/${asset.id}/avatar.webp`,
              },
            })),
          );
        }

        const attendeeNeedResources = await tx
          .select({
            submissionId: attendeeNeedSubmissions.id,
            questionId: attendeeNeedQuestions.id,
          })
          .from(attendeeNeedSubmissions)
          .leftJoin(
            attendeeNeedQuestions,
            eq(attendeeNeedQuestions.submissionId, attendeeNeedSubmissions.id),
          )
          .where(
            and(
              eq(attendeeNeedSubmissions.organizationId, organizationId),
              eq(attendeeNeedSubmissions.customerUserId, customerUserId),
            ),
          );
        const attendeeNeedResourceIds = [
          ...new Set(
            attendeeNeedResources.flatMap((item) =>
              item.questionId ? [item.submissionId, item.questionId] : [item.submissionId],
            ),
          ),
        ];
        if (attendeeNeedResourceIds.length > 0) {
          await tx
            .update(auditLogs)
            .set({ before: { contentRemoved: true }, after: { contentRemoved: true } })
            .where(
              and(
                eq(auditLogs.organizationId, organizationId),
                inArray(auditLogs.resourceId, attendeeNeedResourceIds),
                inArray(auditLogs.resourceType, [
                  'attendee_need_submission',
                  'attendee_need_question',
                ]),
              ),
            );
        }

        await tx
          .update(customerAuthChallenges)
          .set({
            invalidatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(customerAuthChallenges.organizationId, organizationId),
              eq(customerAuthChallenges.mobileE164, user.mobileE164),
              isNull(customerAuthChallenges.consumedAt),
              isNull(customerAuthChallenges.invalidatedAt),
            ),
          );
        const detachedPurchaserOrders = await tx
          .update(orders)
          .set({ purchaserCustomerUserId: null, updatedAt: new Date() })
          .where(
            and(
              eq(orders.organizationId, organizationId),
              eq(orders.purchaserCustomerUserId, customerUserId),
            ),
          )
          .returning({ id: orders.id });
        const detachedRegistrations = await tx
          .update(registrations)
          .set({
            customerUserId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(registrations.organizationId, organizationId),
              eq(registrations.customerUserId, customerUserId),
            ),
          )
          .returning({ id: registrations.id });
        const detachedWaitlistEntries = await tx
          .update(waitlistEntries)
          .set({
            customerUserId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(waitlistEntries.organizationId, organizationId),
              eq(waitlistEntries.customerUserId, customerUserId),
            ),
          )
          .returning({ id: waitlistEntries.id });

        await tx
          .delete(customerSessions)
          .where(
            and(
              eq(customerSessions.organizationId, organizationId),
              eq(customerSessions.customerUserId, customerUserId),
            ),
          );
        await tx.insert(auditLogs).values({
          organizationId,
          actorId,
          actorType: 'staff',
          action: 'customer.admin.delete',
          resourceType: 'customer_user',
          resourceId: String(publicUserId),
          before: {
            status: user.status,
            maskedMobile: maskMobile(user.mobileE164),
          },
          after: {
            deleted: true,
            detachedRegistrations: detachedRegistrations.length,
            detachedWaitlistEntries: detachedWaitlistEntries.length,
            detachedPurchaserOrders: detachedPurchaserOrders.length,
          },
          traceId: crypto.randomUUID(),
        });
        await tx
          .delete(customerUsers)
          .where(
            and(
              eq(customerUsers.id, customerUserId),
              eq(customerUsers.organizationId, organizationId),
            ),
          );

        return {
          deleted: true as const,
          detachedRegistrations: detachedRegistrations.length,
          detachedWaitlistEntries: detachedWaitlistEntries.length,
          detachedPurchaserOrders: detachedPurchaserOrders.length,
        };
      }),
    );
  }
}
