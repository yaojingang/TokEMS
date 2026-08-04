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
  payments,
  registrations,
  refunds,
  users,
} from '@conference/database';
import { normalizeMainlandMobile } from '@conference/security';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { grantAllows, grantsAllowAll } from './auth.guard.js';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { InvoiceOperationsService } from './invoice-operations.service.js';

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

    const db = this.database.db;
    if (db) {
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
          succeededAt: null,
          closedAt: payment.closedAt?.toISOString() ?? null,
          lastQueriedAt: payment.lastQueriedAt?.toISOString() ?? null,
          createdAt: payment.createdAt.toISOString(),
          updatedAt: payment.updatedAt.toISOString(),
        }));
        const successfulPayment = paymentAttempts.find((payment) => payment.status === 'succeeded');
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
        const succeededRefundAmount = mappedRefunds
          .filter((refund) => refund.status === 'succeeded')
          .reduce((sum, refund) => sum + refund.amount, 0);
        const processingRefundAmount = mappedRefunds
          .filter((refund) => refund.status === 'processing')
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
              eq(invoiceRequests.registrationId, registrationId),
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
    const current = await this.registrations.getRegistrationDetail(
      eventId,
      registrationId,
      organizationId,
      false,
    );
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
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`registration-mobile:${eventId}:${attendee.mobile}`}, 0))`,
      );
      const [duplicate] = await tx
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.organizationId, organizationId),
            eq(registrations.eventId, eventId),
            eq(registrations.attendeeMobileE164, attendee.mobile),
            ne(registrations.id, registrationId),
            ne(registrations.status, 'cancelled'),
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
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(registrations.id, registrationId),
            eq(registrations.eventId, eventId),
            eq(registrations.organizationId, organizationId),
          ),
        );
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
    if (commerce.successfulPayment?.provider === 'wechatpay') {
      return { allowed: false, reasonCode: 'wechat_refund_unavailable' };
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
