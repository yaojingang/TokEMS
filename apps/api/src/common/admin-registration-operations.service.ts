import { OrderItemsService } from './order-items.service.js';
import { registrationOrderJoin } from './customer-order-ownership.js';
import { eraseUnavailableClaimInvitationReplays, attendeeClaimTokens, orderItems, tickets } from '@conference/database';
import { guardRefundWrite } from './refund-write-guard.js';
import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AdminRegistrationOperationsInvoiceRequestSchema } from '@conference/contracts';
import type {
  AdminRegistrationOperationsDetail,
  CreateRegistrationNote,
  EventId,
  InvoiceRequest,
  Ticket,
  UpdateAdminRegistrationAttendee,
} from '@conference/contracts';
import { API_ERROR_CODES } from '@conference/contracts';
import {
  auditLogs,
  checkinLists,
  checkinRecords,
  invoiceRequests,
  orders,
  refundRequests,
  payments,
  registrations,
  refunds,
  users,
} from '@conference/database';
import { normalizeMainlandMobile } from '@conference/security';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { grantAllows, grantsAllowAll } from './auth.guard.js';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { InvoiceOperationsService } from './invoice-operations.service.js';
import { registrationSnapshotFields, validateRegistrationAttendeeName } from './registration-attendee-validation.js';

@Injectable()
export class AdminRegistrationOperationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConferenceRepository) private readonly registrations: ConferenceRepository,
    @Inject(InvoiceOperationsService) private readonly invoices: InvoiceOperationsService,
  ) {}

  async detail(
    eventId: EventId,
    registrationId: string,
    organizationId: string,
    grants: string[],
  ): Promise<AdminRegistrationOperationsDetail> {
    const canReadCustomer = grantAllows(grants, 'customer.read');
    const canReadCommerce = grantAllows(grants, 'event.order.read');
    const canReadInvoice = grantsAllowAll(grants, ['event.read', 'org.invoice.read']);
    const detail = await this.registrations.getRegistrationDetail(
      eventId,
      registrationId,
      organizationId,
      canReadCustomer,
    );
    const { order, customerRelation, customer, ...registration } = detail;

    let ticket: Ticket | null;
    try {
      ticket = await this.registrations.getTicket(registrationId);
    } catch {
      ticket = null;
    }

    const paidAmount =
      order && ['paid', 'partially_refunded', 'refunded'].includes(order.status) ? order.amount : 0;
    const customerContext =
      customerRelation === 'included' && customer
        ? ({ access: 'included', customer } as const)
        : ({ access: customerRelation } as const);

    let fulfillment: AdminRegistrationOperationsDetail['fulfillment'] = {
      ticket: ticket
        ? {
            id: ticket.id,
            code: ticket.code,
            status: ticket.status,
            issuedAt: ticket.issuedAt,
          }
        : null,
      checkins: [],
    };
    let commerce: AdminRegistrationOperationsDetail['commerce'] = canReadCommerce
      ? {
          access: 'included',
          order: order ?? null,
          successfulPayment: null,
          paymentAttempts: [],
          refunds: [],
          totals: {
            paidAmount,
            succeededRefundAmount: 0,
            processingRefundAmount: 0,
            refundableAmount: paidAmount,
          },
        }
      : { access: 'restricted' };
    let invoice: AdminRegistrationOperationsDetail['invoice'] = canReadInvoice
      ? { access: 'included', request: null }
      : { access: 'restricted' };
    let notes: AdminRegistrationOperationsDetail['notes'] = [];
    let batchReview: AdminRegistrationOperationsDetail['batchReview'] = null;

    const db = this.database.db;
    if (db) {
      if (order?.modelVersion === 2 && grantAllows(grants, 'event.registration.manage')) {
        batchReview = await db.transaction(async (tx) => {
          const [current] = await tx.select().from(orders).where(and(
            eq(orders.id, order.id), eq(orders.eventId, eventId), eq(orders.organizationId, organizationId),
          )).for('share').limit(1);
          if (!current) return null;
          const rows = await tx.select({ item: orderItems, registration: registrations })
            .from(orderItems).innerJoin(registrations, eq(registrations.id, orderItems.registrationId))
            .where(eq(orderItems.orderId, current.id)).orderBy(orderItems.position);
          if (rows.length !== current.quantity)
            throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION,
              '订单报名资料需要核验，请刷新后联系主办方', HttpStatus.CONFLICT);
          return {
            orderId: current.id,
            version: current.version,
            status: current.status,
            quantity: current.quantity,
            items: await Promise.all(rows.map(async ({ item, registration: attendee }) => ({
              registrationId: attendee.id,
              position: item.position,
              registrationCode: attendee.registrationCode,
              attendee: attendee.attendee,
              fields: await registrationSnapshotFields(tx, attendee),
              formAnswers: attendee.formAnswers,
            }))),
          };
        });
      }
      if (ticket) {
        const checkinRows = await db
          .select({
            record: checkinRecords,
            listName: checkinLists.name,
            operatorName: users.name,
          })
          .from(checkinRecords)
          .innerJoin(checkinLists, eq(checkinLists.id, checkinRecords.checkinListId))
          .leftJoin(users, eq(users.id, checkinRecords.operatorId))
          .where(and(eq(checkinRecords.eventId, eventId), eq(checkinRecords.ticketId, ticket.id)))
          .orderBy(desc(checkinRecords.checkedInAt));
        fulfillment = {
          ...fulfillment,
          checkins: checkinRows.map(({ record, listName, operatorName }) => ({
            id: record.id,
            result: record.result,
            listName,
            deviceName: record.deviceId,
            operatorName,
            checkedInAt: record.checkedInAt.toISOString(),
          })),
        };
      }

      if (canReadCommerce && order) {
        const [financialOrder] = await db.select({ settledPaymentId: orders.settledPaymentId }).from(orders).where(eq(orders.id, order.id)).limit(1);
        const primaryPaymentId = financialOrder?.settledPaymentId;
        const [paymentRows, refundRows] = await Promise.all([
          db
            .select()
            .from(payments)
            .where(eq(payments.orderId, order.id))
            .orderBy(desc(payments.createdAt))
            .limit(10),
          db
            .select()
            .from(refunds)
            .where(
              and(
                eq(refunds.organizationId, organizationId),
                eq(refunds.eventId, eventId),
                eq(refunds.orderId, order.id),
              ),
            )
            .orderBy(desc(refunds.createdAt)),
        ]);
        if (order.modelVersion === 2 && primaryPaymentId && !paymentRows.some((payment) => payment.id === primaryPaymentId)) {
          const [primary] = await db.select().from(payments).where(and(eq(payments.id, primaryPaymentId), eq(payments.orderId, order.id))).limit(1);
          if (primary) paymentRows.push(primary);
        }
        const paymentAttempts = paymentRows.map((payment) => ({
          id: payment.id,
          provider: payment.provider,
          channel: payment.channel,
          outTradeNo: payment.outTradeNo,
          externalId: payment.externalId,
          status: payment.status,
          amount: payment.amount,
          currency: payment.currency,
          preparedAt: payment.preparedAt?.toISOString() ?? null,
          succeededAt: payment.succeededAt?.toISOString() ?? null,
          closedAt: payment.closedAt?.toISOString() ?? null,
          lastQueriedAt: payment.lastQueriedAt?.toISOString() ?? null,
          createdAt: payment.createdAt.toISOString(),
          updatedAt: payment.updatedAt.toISOString(),
        }));
        const successfulPayment = paymentAttempts.find((payment) =>
          ['succeeded', 'refunded'].includes(payment.status) && (order.modelVersion !== 2 || payment.id === primaryPaymentId),
        );
        const mappedRefunds = refundRows.map((refund) => ({
          id: refund.id,
          refundNo: refund.refundNo,
          orderId: refund.orderId,
          amount: refund.amount,
          currency: refund.currency,
          status: refund.status,
          reason: refund.reason,
          createdAt: refund.createdAt.toISOString(),
          updatedAt: refund.updatedAt.toISOString(),
        }));
        const succeededRefundAmount = refundRows
          .filter((refund) => refund.status === 'succeeded' && (order.modelVersion !== 2 || refund.paymentId === primaryPaymentId))
          .reduce((sum, refund) => sum + refund.amount, 0);
        const [reserved] = await db
          .select({ amount: sql<number>`coalesce(sum(${refundRequests.reservedAmount}), 0)::int` })
          .from(refundRequests)
          .where(and(eq(refundRequests.orderId, order.id), isNull(refundRequests.terminatedAt)));
        const processingRefundAmount =
          Number(reserved?.amount ?? 0) +
          refundRows
            .filter(
              (refund) =>
                !refund.requestId && (order.modelVersion !== 2 || refund.paymentId === primaryPaymentId) &&
                ['processing', 'query_pending', 'abnormal'].includes(refund.status),
            )
            .reduce((sum, refund) => sum + refund.amount, 0);
        const persistedPaidAmount = successfulPayment?.amount ?? 0;
        commerce = {
          access: 'included',
          order,
          successfulPayment: successfulPayment ?? null,
          paymentAttempts,
          refunds: mappedRefunds,
          totals: {
            paidAmount: persistedPaidAmount,
            succeededRefundAmount,
            processingRefundAmount,
            refundableAmount: Math.max(
              0,
              persistedPaidAmount - succeededRefundAmount - processingRefundAmount,
            ),
          },
        };
      }

      if (canReadInvoice) {
        const [invoiceRow] = await db
          .select({ id: invoiceRequests.id })
          .from(invoiceRequests)
          .where(
            and(
              eq(invoiceRequests.organizationId, organizationId),
              eq(invoiceRequests.eventId, eventId),
              order ? eq(invoiceRequests.orderId, order.id) : eq(invoiceRequests.registrationId, registrationId),
            ),
          )
          .limit(1);
        const request = invoiceRow
          ? await this.invoices.detail(organizationId, invoiceRow.id, true, eventId)
          : null;
        invoice = {
          access: 'included',
          request: request ? this.safeInvoiceRequest(request) : null,
        };
      }

      const noteRows = await db
        .select({ note: auditLogs, authorName: users.name })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorId))
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.eventId, eventId),
            eq(auditLogs.resourceType, 'registration'),
            eq(auditLogs.resourceId, registrationId),
            eq(auditLogs.action, 'registration.note.added'),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(50);
      notes = noteRows.flatMap(({ note, authorName }) => {
        const body = typeof note.after?.body === 'string' ? note.after.body : '';
        return body
          ? [
              {
                id: note.id,
                body,
                authorName,
                createdAt: note.createdAt.toISOString(),
              },
            ]
          : [];
      });
    }

    const refundCapability = this.refundCapability(grants, commerce);

    return {
      snapshotAt: new Date().toISOString(),
      traceId: randomUUID(),
      registration,
      batchReview,
      customer: customerContext,
      fulfillment,
      commerce,
      invoice,
      notes,
      capabilities: {
        review_registration: {
          allowed: grantAllows(grants, 'event.registration.manage'),
        },
        refund_order: refundCapability,
        close_unpaid_order: {
          allowed:
            grantsAllowAll(grants, ['event.registration.manage', 'event.order.read']) &&
            Boolean(order && ['pending_payment', 'processing'].includes(order.status)),
        },
        manage_invoice: {
          allowed: grantsAllowAll(grants, ['event.read', 'org.invoice.manage']),
        },
      },
    };
  }

  async updateAttendee(
    eventId: EventId,
    registrationId: string,
    organizationId: string,
    actorId: string,
    input: UpdateAdminRegistrationAttendee,
  ) {
    const db = this.database.db;
    if (!db) {
      throw new Error('报名资料修改需要数据库连接');
    }
    let normalizedMobile: string;
    try {
      normalizedMobile = normalizeMainlandMobile(input.attendee.mobile);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '请输入有效的中国大陆手机号',
        HttpStatus.BAD_REQUEST,
      );
    }
    const attendee = {
      ...input.attendee,
      mobile: normalizedMobile,
      email: input.attendee.email.trim().toLocaleLowerCase(),
    };
    const traceId = randomUUID();
    await db.transaction(async (tx) => {
      const [identity] = await tx.select({ mobile: registrations.attendeeMobileE164 }).from(registrations)
        .where(and(eq(registrations.id, registrationId), eq(registrations.eventId, eventId), eq(registrations.organizationId, organizationId))).limit(1);
      for (const mobile of [...new Set([attendee.mobile, ...(identity ? [identity.mobile] : [])])].sort()) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`registration-mobile:${eventId}:${mobile}`},0))`);
      }
      const [refundOrder] = await tx.select({ order: orders }).from(registrations).innerJoin(orders, registrationOrderJoin())
        .where(and(eq(registrations.id, registrationId), eq(orders.eventId, eventId), eq(orders.organizationId, organizationId))).limit(1);
      if (refundOrder) await guardRefundWrite(tx, refundOrder.order.id, false, { purpose: 'rights', registrationId });
      const [selected] = refundOrder ? await tx.select().from(orderItems).where(eq(orderItems.registrationId, registrationId)).limit(1) : [];
      const [current] = await tx
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.id, registrationId),
            eq(registrations.eventId, eventId),
            eq(registrations.organizationId, organizationId),
            isNull(registrations.supersededAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!current) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名不存在', HttpStatus.NOT_FOUND);
      }
      if (identity?.mobile !== current.attendeeMobileE164 || (input.expectedUpdatedAt && input.expectedUpdatedAt !== current.updatedAt.toISOString()) || (refundOrder?.order.modelVersion === 2 && !input.expectedUpdatedAt)) {
        throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION, '参会资料已经更新，请刷新后修改', HttpStatus.CONFLICT);
      }
      if (refundOrder?.order.modelVersion === 2) {
        const [ticket] = await tx.select().from(tickets).where(eq(tickets.registrationId, registrationId)).limit(1);
        if (!selected || selected.state === 'cancelled' || ticket?.status === 'used' || ['closed','processing'].includes(refundOrder.order.status)) throw new DomainError(API_ERROR_CODES.INVALID_STATE_TRANSITION, '该名额当前不可修改资料', HttpStatus.CONFLICT);
      }
      await validateRegistrationAttendeeName(tx, current, attendee.name);
      const [duplicate] = await tx
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.organizationId, organizationId),
            eq(registrations.eventId, eventId),
            eq(registrations.attendeeMobileE164, attendee.mobile),
            ne(registrations.id, registrationId),
            isNull(registrations.supersededAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该手机号已关联本场大会的另一条有效报名',
          HttpStatus.CONFLICT,
        );
      }
      await tx
        .update(registrations)
        .set({
          attendee,
          attendeeMobileE164: attendee.mobile,
          attendeeEmailNormalized: attendee.email,
          formAnswers: { ...current.formAnswers, ...Object.fromEntries(Object.entries(attendee).filter(([key]) => Object.hasOwn(current.formAnswers, key))) },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(registrations.id, registrationId),
            eq(registrations.eventId, eventId),
            eq(registrations.organizationId, organizationId),
            isNull(registrations.supersededAt),
          ),
        );
      if (selected && refundOrder?.order.modelVersion === 2) {
        const now = new Date();
        await tx.update(orderItems).set({ version: sql`${orderItems.version}+1`, updatedAt: now }).where(eq(orderItems.id, selected.id));
        await tx.update(orders).set({ version: sql`${orders.version}+1`, updatedAt: now }).where(eq(orders.id, selected.orderId));
        if (current.attendeeMobileE164 !== attendee.mobile || current.attendeeEmailNormalized !== attendee.email) {
          await tx.update(attendeeClaimTokens).set({ revokedAt: now }).where(and(eq(attendeeClaimTokens.registrationId, registrationId), isNull(attendeeClaimTokens.revokedAt)));
          await eraseUnavailableClaimInvitationReplays(tx, now, [registrationId]);
          if (!current.customerUserId && selected.state === 'active' && refundOrder.order.settledPaymentId) await new OrderItemsService(this.database).createInvitation(tx, refundOrder.order, selected, { ...current, attendee, attendeeMobileE164: attendee.mobile, attendeeEmailNormalized: attendee.email }, now);
        }
      }
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        actorType: 'staff',
        action: 'registration.attendee.updated',
        resourceType: 'registration',
        resourceId: registrationId,
        before: { attendee: current.attendee },
        after: { attendee, reason: input.reason },
        traceId,
      });
    });
    return { attendee, updatedAt: new Date().toISOString(), traceId };
  }

  async addNote(
    eventId: EventId,
    registrationId: string,
    organizationId: string,
    actorId: string,
    input: CreateRegistrationNote,
  ) {
    const db = this.database.db;
    if (!db) {
      throw new Error('报名备注需要数据库连接');
    }
    await this.registrations.getRegistrationDetail(eventId, registrationId, organizationId, false);
    const traceId = randomUUID();
    const [note] = await db
      .insert(auditLogs)
      .values({
        organizationId,
        eventId,
        actorId,
        actorType: 'staff',
        action: 'registration.note.added',
        resourceType: 'registration',
        resourceId: registrationId,
        after: { body: input.body },
        traceId,
      })
      .returning({ id: auditLogs.id, createdAt: auditLogs.createdAt });
    const [author] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1);
    return {
      id: note!.id,
      body: input.body,
      authorName: author?.name ?? null,
      createdAt: note!.createdAt.toISOString(),
    };
  }

  private refundCapability(
    grants: string[],
    commerce: AdminRegistrationOperationsDetail['commerce'],
  ) {
    if (!grantAllows(grants, 'event.order.refund')) {
      return { allowed: false, reasonCode: 'permission_required' };
    }
    if (commerce.access === 'restricted' || !commerce.order) {
      return { allowed: false, reasonCode: 'order_unavailable' };
    }
    if (!['paid', 'partially_refunded'].includes(commerce.order.status)) {
      return { allowed: false, reasonCode: 'order_state_not_refundable' };
    }
    if (commerce.totals.refundableAmount <= 0) {
      return { allowed: false, reasonCode: 'no_refundable_balance' };
    }
    return { allowed: true };
  }

  private safeInvoiceRequest(
    request: InvoiceRequest,
  ): NonNullable<
    Extract<AdminRegistrationOperationsDetail['invoice'], { access: 'included' }>['request']
  > {
    return AdminRegistrationOperationsInvoiceRequestSchema.parse({
      ...request,
      documents: request.documents.slice(0, 20),
      logs: request.logs.slice(-50),
    });
  }
}
