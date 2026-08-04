import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
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
  CustomerRegistrationDetail,
  CustomerRegistrationList,
  CustomerRegistrationSummary,
  CustomerSession,
  ClaimCustomerRegistration,
  UpdateCustomerAdmin,
  UpdateCustomerProfile,
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
  auditLogs,
  customerAuthChallenges,
  customerProfiles,
  customerSessions,
  customerUsers,
  events,
  invoiceRequests,
  orders,
  orderAccessTokens,
  publicUserIds,
  registrations,
  tickets,
  ticketTypes,
  waitlistEntries,
} from '@conference/database';
import { maskMobile, normalizeMainlandMobile, sha256 } from '@conference/security';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import { CUSTOMER_INVOICE_PAYMENT_ELIGIBLE_ORDER_STATUSES } from './customer-invoice-policy.js';

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
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

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

  private async registrationRows(
    organizationId: string,
    customerUserId: string,
    options: { registrationId?: string; cursor?: string; limit?: number } = {},
  ) {
    const conditions: SQL[] = [
      eq(registrations.organizationId, organizationId),
      eq(registrations.customerUserId, customerUserId),
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

  private registrationSummary(row: RegistrationRow): CustomerRegistrationSummary {
    return {
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
      orderId: row.order.id,
      orderNo: row.order.orderNo,
      orderStatus: row.order.status,
      amount: row.order.amount,
      currency: row.order.currency,
      ticketCode: row.ticket?.code ?? null,
      ticketStatus: row.ticket?.status ?? null,
      invoiceId: row.invoice?.id ?? null,
      invoiceStatus: row.invoice?.status ?? null,
      createdAt: row.registration.createdAt.toISOString(),
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
    const items = rows.slice(0, normalizedLimit).map((row) => this.registrationSummary(row));
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
      ...this.registrationSummary(row),
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
      eq(registrations.customerUserId, session.customerUserId),
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
    const [statistics, latestRegistrations] =
      pageUserIds.length === 0
        ? [[], []]
        : await Promise.all([
            database
              .select({
                customerUserId: registrations.customerUserId,
                registrationsCount: sql<number>`count(distinct ${registrations.id})::int`,
                eventCount: sql<number>`count(distinct ${registrations.eventId})::int`,
                activeEventCount: sql<number>`count(distinct ${registrations.eventId}) filter (where ${registrations.status} <> 'cancelled')::int`,
                invoiceCount: sql<number>`count(distinct ${invoiceRequests.id})::int`,
                latestEventName: sql<
                  string | null
                >`(array_agg(${events.name} order by ${registrations.createdAt} desc))[1]`,
              })
              .from(registrations)
              .innerJoin(events, eq(events.id, registrations.eventId))
              .leftJoin(invoiceRequests, eq(invoiceRequests.registrationId, registrations.id))
              .where(inArray(registrations.customerUserId, pageUserIds))
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
              .where(inArray(registrations.customerUserId, pageUserIds))
              .orderBy(
                asc(registrations.customerUserId),
                desc(registrations.createdAt),
                desc(registrations.id),
              ),
          ]);
    const statisticsByUser = new Map(statistics.map((row) => [row.customerUserId, row] as const));
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
        invoiceCount: Number(userStatistics?.invoiceCount ?? 0),
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
    const invoicePage = await this.invoicePage(organizationId, customerUserId);
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
      eq(registrations.customerUserId, customerUserId),
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
      };
    }
    return db.transaction(async (tx) => {
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
        };
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
      };
    });
  }
}
