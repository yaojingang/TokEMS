import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  ATTENDEE_NEED_CONSENT_VERSION,
  ATTENDEE_NEED_TOPIC_OPTIONS,
  AdminAttendeeNeedItemSchema,
  AdminAttendeeNeedListSchema,
  AttendeeNeedsProfileSchema,
  PUBLIC_EVENT_STATUSES,
  PublicAttendeeNeedListSchema,
  type AdminAttendeeNeedExportQuery,
  type AdminAttendeeNeedListQuery,
  type AttendeeNeedsProfile,
  type ModerateAttendeeNeedQuestion,
  type PublicAttendeeNeedList,
  type PublicAttendeeNeedListQuery,
  type UpdateAdminAttendeeNeedQuestion,
  type UpdateAttendeeNeeds,
} from '@conference/contracts';
import {
  attendeeNeedQuestions,
  attendeeNeedSubmissions,
  auditLogs,
  customerProfiles,
  customerUsers,
  eventReleases,
  events,
  orders,
  payments,
  registrations,
  tickets,
} from '@conference/database';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  or,
  sql,
} from 'drizzle-orm';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { escapeCsvCell } from './registration-export-csv.js';
import {
  ATTENDEE_NEEDS_PUBLIC_PAGE_SIZE,
  attendeeNeedAdminEditAuditFacts,
  attendeeNeedAdminEditMetadata,
  attendeeNeedModerationStateError,
  attendeeNeedQuestionIsVisible,
  attendeeNeedsCanCreate,
  attendeeNeedsConsentMetadata,
  attendeeNeedsFlowEnabled,
  attendeeNeedsForcedAnonymityFromAudit,
  attendeeNeedsReplacementRequiresReview,
  attendeeNeedsSnapshotCutoff,
  attendeeNeedsHomeEnabled,
  attendeeNeedsQualification,
  attendeeNeedsTotalPages,
  attendeeNeedsVersionMatches,
  resolveAttendeeNeedPublicationIdentity,
} from './attendee-needs-policy.js';
import {
  PUBLIC_ORDER_STATUSES,
  PUBLIC_REGISTRATION_STATUSES,
  PUBLIC_TICKET_STATUSES,
} from './attendee-showcase-policy.js';

const topicLabels = new Map<string, string>(
  ATTENDEE_NEED_TOPIC_OPTIONS.map((item) => [item.code, item.label]),
);
const ATTENDEE_NEEDS_EXPORT_MAX_ROWS = 5_000;

type Database = NonNullable<DatabaseService['db']>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function asIso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function submissionEligibilitySql() {
  return and(
    eq(attendeeNeedSubmissions.isPublic, true),
    eq(attendeeNeedSubmissions.consentVersion, ATTENDEE_NEED_CONSENT_VERSION),
    isNotNull(attendeeNeedSubmissions.consentAt),
    inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
    eq(customerUsers.status, 'active'),
    isNull(registrations.supersededAt),
    inArray(registrations.status, [...PUBLIC_REGISTRATION_STATUSES]),
    inArray(orders.status, [...PUBLIC_ORDER_STATUSES]),
    sql`(${orders.amount} = 0 or exists (
      select 1 from ${payments} attendee_needs_payment
      where attendee_needs_payment.order_id = ${orders.id}
        and attendee_needs_payment.status = 'succeeded'
    ))`,
    and(isNotNull(tickets.id), inArray(tickets.status, [...PUBLIC_TICKET_STATUSES])),
  )!;
}

function publicEligibilitySql() {
  return and(
    submissionEligibilitySql(),
    isNotNull(attendeeNeedQuestions.firstPublishedAt),
    isNull(attendeeNeedQuestions.adminHiddenAt),
    isNull(attendeeNeedQuestions.deletedAt),
  )!;
}

@Injectable()
export class AttendeeNeedsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConferenceRepository) private readonly conference: ConferenceRepository,
  ) {}

  private db() {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '参会需求需要启用数据库后使用',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private async ownedContext(session: AuthenticatedCustomer, registrationId: string) {
    const [row] = await this.db()
      .select({
        registration: registrations,
        event: events,
        order: orders,
        ticket: tickets,
        customer: customerUsers,
        commonProfile: customerProfiles,
        submission: attendeeNeedSubmissions,
        releaseSnapshot: eventReleases.snapshot,
        successfulPaymentAt: sql<Date | null>`min(${payments.succeededAt})`,
      })
      .from(registrations)
      .innerJoin(events, eq(events.id, registrations.eventId))
      .innerJoin(orders, eq(orders.registrationId, registrations.id))
      .innerJoin(customerUsers, eq(customerUsers.id, registrations.customerUserId))
      .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
      .leftJoin(customerProfiles, eq(customerProfiles.customerUserId, customerUsers.id))
      .leftJoin(
        attendeeNeedSubmissions,
        eq(attendeeNeedSubmissions.registrationId, registrations.id),
      )
      .leftJoin(
        eventReleases,
        and(
          eq(eventReleases.eventId, events.id),
          sql`${eventReleases.id}::text = ${events.settings}->>'currentReleaseId'`,
        ),
      )
      .leftJoin(payments, and(eq(payments.orderId, orders.id), eq(payments.status, 'succeeded')))
      .where(
        and(
          eq(registrations.id, registrationId),
          eq(registrations.organizationId, session.organizationId),
          eq(registrations.customerUserId, session.customerUserId),
          isNull(registrations.supersededAt),
        ),
      )
      .groupBy(
        registrations.id,
        events.id,
        orders.id,
        tickets.id,
        customerUsers.id,
        customerProfiles.customerUserId,
        attendeeNeedSubmissions.id,
        eventReleases.id,
      )
      .limit(1);
    if (!row) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
    }
    return row;
  }

  private qualification(
    row: Awaited<ReturnType<AttendeeNeedsService['ownedContext']>>,
    isPublic: boolean,
  ) {
    return attendeeNeedsQualification({
      eventStatus: row.event.status,
      customerStatus: row.customer.status,
      registrationStatus: row.registration.status,
      orderStatus: row.order.status,
      paymentSatisfied: row.order.amount === 0 || Boolean(row.successfulPaymentAt),
      ticketStatus: row.ticket?.status ?? null,
      isPublic,
    });
  }

  private async activeQuestions(submissionId: string) {
    return this.db()
      .select()
      .from(attendeeNeedQuestions)
      .where(
        and(
          eq(attendeeNeedQuestions.submissionId, submissionId),
          isNull(attendeeNeedQuestions.deletedAt),
        ),
      )
      .orderBy(asc(attendeeNeedQuestions.position), asc(attendeeNeedQuestions.id));
  }

  private async adminForcedAnonymity(
    submissionId: string,
    organizationId: string,
    eventId: number,
  ) {
    const rows = await this.db()
      .select({ after: auditLogs.after })
      .from(auditLogs)
      .innerJoin(
        attendeeNeedQuestions,
        sql`${auditLogs.resourceId} = ${attendeeNeedQuestions.id}::text`,
      )
      .where(
        and(
          eq(attendeeNeedQuestions.submissionId, submissionId),
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.eventId, eventId),
          eq(auditLogs.resourceType, 'attendee_need_question'),
          inArray(auditLogs.action, ['attendee_needs.admin_edit', 'attendee_needs.anonymize']),
          sql`${auditLogs.after}->>'forcedAnonymous' = 'true'`,
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    return attendeeNeedsForcedAnonymityFromAudit(rows);
  }

  private forcedAnonymityBySubmission(
    database: Database | Transaction,
    organizationId: string,
    eventId: number,
  ) {
    return database
      .select({
        submissionId: attendeeNeedQuestions.submissionId,
        reason: sql<string | null>`(
          array_agg(${auditLogs.after}->>'reason' order by ${auditLogs.createdAt} desc)
        )[1]`.as('reason'),
      })
      .from(auditLogs)
      .innerJoin(
        attendeeNeedQuestions,
        sql`${auditLogs.resourceId} = ${attendeeNeedQuestions.id}::text`,
      )
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.eventId, eventId),
          eq(auditLogs.resourceType, 'attendee_need_question'),
          inArray(auditLogs.action, ['attendee_needs.admin_edit', 'attendee_needs.anonymize']),
          sql`${auditLogs.after}->>'forcedAnonymous' = 'true'`,
        ),
      )
      .groupBy(attendeeNeedQuestions.submissionId)
      .as('attendee_needs_forced_anonymity');
  }

  private async profileResponse(
    row: Awaited<ReturnType<AttendeeNeedsService['ownedContext']>>,
  ): Promise<AttendeeNeedsProfile> {
    const submission = row.submission;
    const questions = submission ? await this.activeQuestions(submission.id) : [];
    const forcedAnonymity = submission
      ? await this.adminForcedAnonymity(
          submission.id,
          submission.organizationId,
          submission.eventId,
        )
      : { forced: false, reason: null };
    const [adminRemoved] = submission
      ? await this.db()
          .select({ total: count() })
          .from(attendeeNeedQuestions)
          .where(
            and(
              eq(attendeeNeedQuestions.submissionId, submission.id),
              eq(attendeeNeedQuestions.deletedByType, 'admin'),
              isNotNull(attendeeNeedQuestions.deletedAt),
            ),
          )
      : [{ total: 0 }];
    const status = this.qualification(row, true);
    const publicDisplayEnabled = attendeeNeedsHomeEnabled(row.releaseSnapshot);
    const effectivePublic = questions.some((question) =>
      attendeeNeedQuestionIsVisible({
        qualified: Boolean(submission?.isPublic) && status.qualified,
        publicationEnabled: publicDisplayEnabled,
        consentVersionCurrent: submission?.consentVersion === ATTENDEE_NEED_CONSENT_VERSION,
        firstPublishedAt: question.firstPublishedAt,
        adminHiddenAt: question.adminHiddenAt,
        deletedAt: question.deletedAt,
      }),
    );
    const defaultName =
      row.registration.attendee.name ||
      row.commonProfile?.realName ||
      row.commonProfile?.nickname ||
      null;
    const featureEnabled = attendeeNeedsFlowEnabled(row.releaseSnapshot);
    const canCreate = !submission && featureEnabled && status.qualified;

    return AttendeeNeedsProfileSchema.parse({
      id: submission?.id ?? null,
      featureEnabled,
      canCreate,
      canPublish: status.qualified,
      registrationId: row.registration.id,
      orderId: row.order.id,
      ticketCode: row.ticket?.code ?? null,
      eventId: row.event.id,
      eventName: row.event.name,
      eventSlug: row.event.slug,
      questions:
        questions.length > 0
          ? questions.map((question) => ({
              id: question.id,
              position: question.position,
              content: question.content,
              tagCodes: question.tagCodes,
              adminEdited: Boolean(question.adminEditedAt),
              adminEditReason: question.adminEditReason,
              adminHidden: Boolean(question.adminHiddenAt),
              adminHiddenReason: question.adminHiddenReason,
              deletedByAdmin: false,
              firstPublishedAt: asIso(question.firstPublishedAt),
              updatedAt: asIso(question.updatedAt),
            }))
          : [
              {
                id: null,
                position: 1,
                content: '',
                tagCodes: [],
                adminEdited: false,
                adminEditReason: null,
                adminHidden: false,
                adminHiddenReason: null,
                deletedByAdmin: false,
                firstPublishedAt: null,
                updatedAt: null,
              },
            ],
      adminRemovedCount: Number(adminRemoved?.total ?? 0),
      isPublic: submission?.isPublic ?? true,
      effectivePublic,
      isAnonymous: Boolean(submission?.isAnonymous ?? true) || forcedAnonymity.forced,
      adminForcedAnonymous: forcedAnonymity.forced,
      adminForcedAnonymousReason: forcedAnonymity.reason,
      attributionName: forcedAnonymity.forced ? null : defaultName,
      consentVersion: submission?.consentVersion ?? null,
      consentAt: asIso(submission?.consentAt),
      qualified: status.qualified,
      qualificationReason: status.reason,
      version: submission?.version ?? 0,
      updatedAt: asIso(submission?.updatedAt),
    });
  }

  async customerNeeds(session: AuthenticatedCustomer, registrationId: string) {
    return this.profileResponse(await this.ownedContext(session, registrationId));
  }

  private assertNewSubmissionAllowed(
    row: Awaited<ReturnType<AttendeeNeedsService['ownedContext']>>,
  ) {
    if (!attendeeNeedsCanCreate(false, row.releaseSnapshot)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '参会需求收集暂未开放',
        HttpStatus.CONFLICT,
      );
    }
    const status = this.qualification(row, true);
    if (!status.qualified) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '完成报名并取得有效电子票后才可提交参会需求',
        HttpStatus.CONFLICT,
      );
    }
  }

  async updateCustomerNeeds(
    session: AuthenticatedCustomer,
    registrationId: string,
    input: UpdateAttendeeNeeds,
  ) {
    const owned = await this.ownedContext(session, registrationId);
    const existingSubmission = owned.submission;
    if (!existingSubmission) {
      this.assertNewSubmissionAllowed(owned);
      if (input.questions.some((question) => question.id)) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '首次提交不能引用已有问题',
          HttpStatus.BAD_REQUEST,
        );
      }
    } else if (!attendeeNeedsVersionMatches(input.version, existingSubmission.version, false)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '参会需求已在其他页面更新，请刷新后再保存',
        HttpStatus.CONFLICT,
      );
    }
    const currentQuestions = existingSubmission
      ? await this.activeQuestions(existingSubmission.id)
      : [];
    const providedIds = input.questions.flatMap((question) => (question.id ? [question.id] : []));
    if (new Set(providedIds).size !== providedIds.length) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '同一问题不能重复保存',
        HttpStatus.BAD_REQUEST,
      );
    }
    const currentIds = new Set(currentQuestions.map((question) => question.id));
    if (input.questions.some((question) => question.id && !currentIds.has(question.id))) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '参会问题不存在或已经被移除',
        HttpStatus.BAD_REQUEST,
      );
    }
    const governedQuestions = existingSubmission
      ? await this.db()
          .select({ content: attendeeNeedQuestions.content })
          .from(attendeeNeedQuestions)
          .where(
            and(
              eq(attendeeNeedQuestions.submissionId, existingSubmission.id),
              or(
                and(
                  isNotNull(attendeeNeedQuestions.adminHiddenAt),
                  isNull(attendeeNeedQuestions.deletedAt),
                ),
                and(
                  isNotNull(attendeeNeedQuestions.deletedAt),
                  eq(attendeeNeedQuestions.deletedByType, 'admin'),
                ),
              ),
            ),
          )
      : [];
    const replacementRequiresReview = attendeeNeedsReplacementRequiresReview(
      governedQuestions.map((question) => question.content),
      input.questions,
    );
    const nextQualification = this.qualification(owned, input.isPublic);
    if (input.isPublic && !nextQualification.qualified) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        nextQualification.reason ?? '当前报名暂时不能公开参会需求',
        HttpStatus.CONFLICT,
      );
    }
    const forcedAnonymity = existingSubmission
      ? await this.adminForcedAnonymity(
          existingSubmission.id,
          existingSubmission.organizationId,
          existingSubmission.eventId,
        )
      : { forced: false, reason: null };
    const publicationIdentity = resolveAttendeeNeedPublicationIdentity({
      requestedAnonymous: input.isAnonymous,
      requestedAttributionName: input.attributionName,
      canonicalAttributionName: owned.registration.attendee.name || null,
      adminForcedAnonymous: forcedAnonymity.forced,
    });
    if (input.isPublic && publicationIdentity.validationError) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        publicationIdentity.validationError,
        HttpStatus.BAD_REQUEST,
      );
    }
    const now = new Date();

    await this.db().transaction(async (tx) => {
      let submission = existingSubmission;
      let createdForThisUpdate = false;
      if (!submission) {
        const [created] = await tx
          .insert(attendeeNeedSubmissions)
          .values({
            organizationId: session.organizationId,
            eventId: owned.event.id,
            registrationId,
            customerUserId: session.customerUserId,
            isPublic: false,
            isAnonymous: true,
          })
          .onConflictDoNothing({ target: attendeeNeedSubmissions.registrationId })
          .returning();
        if (!created) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '参会需求已在其他页面创建，请刷新后再保存',
            HttpStatus.CONFLICT,
          );
        }
        submission = created;
        createdForThisUpdate = true;
      }
      if (!attendeeNeedsVersionMatches(input.version, submission.version, createdForThisUpdate)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '参会需求已在其他页面更新，请刷新后再保存',
          HttpStatus.CONFLICT,
        );
      }
      const consent = attendeeNeedsConsentMetadata({
        nextIsPublic: input.isPublic,
        currentIsPublic: submission.isPublic,
        currentVersion: submission.consentVersion,
        currentConsentAt: submission.consentAt,
        requiredVersion: ATTENDEE_NEED_CONSENT_VERSION,
        now,
      });
      const [updated] = await tx
        .update(attendeeNeedSubmissions)
        .set({
          isPublic: input.isPublic,
          isAnonymous: publicationIdentity.isAnonymous,
          attributionName: publicationIdentity.attributionName,
          consentVersion: consent.consentVersion,
          consentAt: consent.consentAt,
          version: sql`${attendeeNeedSubmissions.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(attendeeNeedSubmissions.id, submission.id),
            eq(attendeeNeedSubmissions.version, submission.version),
          ),
        )
        .returning({ id: attendeeNeedSubmissions.id });
      if (!updated) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '参会需求已在其他页面更新，请刷新后再保存',
          HttpStatus.CONFLICT,
        );
      }

      await tx
        .update(attendeeNeedQuestions)
        .set({
          deletedAt: now,
          deletedByType: 'customer',
          deletedReason: '用户在编辑时移除',
          updatedAt: now,
        })
        .where(
          and(
            eq(attendeeNeedQuestions.submissionId, submission.id),
            isNull(attendeeNeedQuestions.deletedAt),
          ),
        );

      for (const [index, question] of input.questions.entries()) {
        const currentQuestion = question.id
          ? currentQuestions.find((item) => item.id === question.id)
          : undefined;
        const adminEditMetadata = currentQuestion
          ? attendeeNeedAdminEditMetadata({
              currentContent: currentQuestion.content,
              currentTagCodes: currentQuestion.tagCodes,
              currentEditedAt: currentQuestion.adminEditedAt,
              currentEditReason: currentQuestion.adminEditReason,
              nextContent: question.content,
              nextTagCodes: [...question.tagCodes],
            })
          : { adminEditedAt: null, adminEditReason: null };
        const values = {
          position: index + 1,
          content: question.content,
          tagCodes: [...question.tagCodes],
          firstPublishedAt: input.isPublic ? now : null,
          ...adminEditMetadata,
          deletedAt: null,
          deletedByType: null,
          deletedReason: null,
          updatedAt: now,
        };
        if (question.id) {
          await tx
            .update(attendeeNeedQuestions)
            .set({
              ...values,
              firstPublishedAt: sql`coalesce(${attendeeNeedQuestions.firstPublishedAt}, ${
                input.isPublic ? now : null
              })`,
            })
            .where(
              and(
                eq(attendeeNeedQuestions.id, question.id),
                eq(attendeeNeedQuestions.submissionId, submission.id),
              ),
            );
        } else {
          await tx.insert(attendeeNeedQuestions).values({
            submissionId: submission.id,
            ...values,
            ...(replacementRequiresReview
              ? {
                  adminHiddenAt: now,
                  adminHiddenReason: '管理员治理后新增的问题需要重新审核',
                }
              : {}),
          });
        }
      }

      await tx.insert(auditLogs).values({
        organizationId: session.organizationId,
        eventId: submission.eventId,
        actorId: session.customerUserId,
        actorType: 'customer',
        action: 'attendee_needs.update',
        resourceType: 'attendee_need_submission',
        resourceId: submission.id,
        before: { isPublic: submission.isPublic, isAnonymous: submission.isAnonymous },
        after: {
          isPublic: input.isPublic,
          isAnonymous: publicationIdentity.isAnonymous,
          questionCount: input.questions.length,
        },
        traceId: randomUUID(),
      });
    });
    return this.customerNeeds(session, registrationId);
  }

  async deleteCustomerNeeds(
    session: AuthenticatedCustomer,
    registrationId: string,
    version: number,
  ) {
    const owned = await this.ownedContext(session, registrationId);
    if (!owned.submission) return this.profileResponse(owned);
    if (owned.submission.version !== version) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '参会需求已在其他页面更新，请刷新后再删除',
        HttpStatus.CONFLICT,
      );
    }
    const now = new Date();
    await this.db().transaction(async (tx) => {
      const [updated] = await tx
        .update(attendeeNeedSubmissions)
        .set({
          isPublic: false,
          version: sql`${attendeeNeedSubmissions.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(attendeeNeedSubmissions.id, owned.submission!.id),
            eq(attendeeNeedSubmissions.version, version),
          ),
        )
        .returning({ id: attendeeNeedSubmissions.id });
      if (!updated) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '参会需求已在其他页面更新，请刷新后再删除',
          HttpStatus.CONFLICT,
        );
      }
      await tx
        .update(attendeeNeedQuestions)
        .set({
          deletedAt: now,
          deletedByType: 'customer',
          deletedReason: '用户删除全部参会需求',
          updatedAt: now,
        })
        .where(
          and(
            eq(attendeeNeedQuestions.submissionId, owned.submission!.id),
            isNull(attendeeNeedQuestions.deletedAt),
          ),
        );
      await tx.insert(auditLogs).values({
        organizationId: session.organizationId,
        eventId: owned.event.id,
        actorId: session.customerUserId,
        actorType: 'customer',
        action: 'attendee_needs.delete',
        resourceType: 'attendee_need_submission',
        resourceId: owned.submission!.id,
        before: { isPublic: owned.submission!.isPublic },
        after: { deleted: true },
        traceId: randomUUID(),
      });
    });
    return this.customerNeeds(session, registrationId);
  }

  async publicNeeds(
    eventSlug: string,
    organizationSlug: string,
    query: PublicAttendeeNeedListQuery,
  ): Promise<PublicAttendeeNeedList> {
    const snapshotAt = attendeeNeedsSnapshotCutoff(query.snapshotAt, new Date());
    const event = await this.conference.getPublicEventScope(eventSlug, organizationSlug);
    const [release] = this.database.db
      ? await this.db()
          .select({
            snapshot: eventReleases.snapshot,
            organizationId: events.organizationId,
          })
          .from(events)
          .innerJoin(
            eventReleases,
            and(
              eq(eventReleases.eventId, events.id),
              sql`${eventReleases.id}::text = ${events.settings}->>'currentReleaseId'`,
            ),
          )
          .where(eq(events.id, event.id))
          .limit(1)
      : [];
    if (!this.database.db || !attendeeNeedsHomeEnabled(release?.snapshot)) {
      return PublicAttendeeNeedListSchema.parse({
        items: [],
        total: 0,
        page: query.page,
        pageSize: ATTENDEE_NEEDS_PUBLIC_PAGE_SIZE,
        totalPages: 1,
        snapshotAt: snapshotAt.toISOString(),
      });
    }
    const condition = and(
      eq(attendeeNeedSubmissions.eventId, event.id),
      publicEligibilitySql(),
      lte(attendeeNeedQuestions.firstPublishedAt, snapshotAt),
    )!;
    const [totalRows, rows] = await this.db().transaction(
      async (tx) => {
        const forcedAnonymity = this.forcedAnonymityBySubmission(
          tx,
          release!.organizationId,
          event.id,
        );
        const totalRows = await tx
          .select({ value: count(attendeeNeedQuestions.id) })
          .from(attendeeNeedQuestions)
          .innerJoin(
            attendeeNeedSubmissions,
            eq(attendeeNeedSubmissions.id, attendeeNeedQuestions.submissionId),
          )
          .innerJoin(registrations, eq(registrations.id, attendeeNeedSubmissions.registrationId))
          .innerJoin(orders, eq(orders.registrationId, registrations.id))
          .innerJoin(tickets, eq(tickets.registrationId, registrations.id))
          .innerJoin(customerUsers, eq(customerUsers.id, attendeeNeedSubmissions.customerUserId))
          .innerJoin(events, eq(events.id, attendeeNeedSubmissions.eventId))
          .where(condition);
        const rows = await tx
          .select({
            question: attendeeNeedQuestions,
            submission: attendeeNeedSubmissions,
            attendeeName: sql<string>`${registrations.attendee}->>'name'`,
            forcedAnonymous: sql<boolean>`${forcedAnonymity.submissionId} is not null`,
          })
          .from(attendeeNeedQuestions)
          .innerJoin(
            attendeeNeedSubmissions,
            eq(attendeeNeedSubmissions.id, attendeeNeedQuestions.submissionId),
          )
          .innerJoin(registrations, eq(registrations.id, attendeeNeedSubmissions.registrationId))
          .innerJoin(orders, eq(orders.registrationId, registrations.id))
          .innerJoin(tickets, eq(tickets.registrationId, registrations.id))
          .innerJoin(customerUsers, eq(customerUsers.id, attendeeNeedSubmissions.customerUserId))
          .innerJoin(events, eq(events.id, attendeeNeedSubmissions.eventId))
          .leftJoin(forcedAnonymity, eq(forcedAnonymity.submissionId, attendeeNeedSubmissions.id))
          .where(condition)
          .orderBy(desc(attendeeNeedQuestions.firstPublishedAt), asc(attendeeNeedQuestions.id))
          .limit(ATTENDEE_NEEDS_PUBLIC_PAGE_SIZE)
          .offset((query.page - 1) * ATTENDEE_NEEDS_PUBLIC_PAGE_SIZE);
        return [totalRows, rows] as const;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const total = Number(totalRows[0]?.value ?? 0);
    return PublicAttendeeNeedListSchema.parse({
      items: rows.map(({ question, submission, attendeeName, forcedAnonymous }) => {
        const effectivelyAnonymous = submission.isAnonymous || forcedAnonymous;
        return {
          questionId: question.id,
          content: question.content,
          tags: question.tagCodes.map((code) => ({ code, label: topicLabels.get(code) ?? code })),
          ...(!effectivelyAnonymous && submission.attributionName === attendeeName
            ? { attribution: attendeeName }
            : {}),
          firstPublishedAt: question.firstPublishedAt!.toISOString(),
        };
      }),
      total,
      page: query.page,
      pageSize: ATTENDEE_NEEDS_PUBLIC_PAGE_SIZE,
      totalPages: attendeeNeedsTotalPages(total),
      snapshotAt: snapshotAt.toISOString(),
    });
  }

  private adminBaseCondition(organizationId: string, eventId: number) {
    return and(
      eq(attendeeNeedSubmissions.organizationId, organizationId),
      eq(attendeeNeedSubmissions.eventId, eventId),
    )!;
  }

  private adminFilterCondition(
    organizationId: string,
    eventId: number,
    query: AdminAttendeeNeedListQuery,
  ) {
    const visibility =
      query.visibility === 'public'
        ? eq(attendeeNeedSubmissions.isPublic, true)
        : query.visibility === 'private'
          ? eq(attendeeNeedSubmissions.isPublic, false)
          : query.visibility === 'anonymous'
            ? eq(attendeeNeedSubmissions.isAnonymous, true)
            : query.visibility === 'named'
              ? eq(attendeeNeedSubmissions.isAnonymous, false)
              : query.visibility === 'ineligible'
                ? and(eq(attendeeNeedSubmissions.isPublic, true), not(submissionEligibilitySql()))
                : undefined;
    const moderation =
      query.moderationStatus === 'visible'
        ? and(isNull(attendeeNeedQuestions.adminHiddenAt), isNull(attendeeNeedQuestions.deletedAt))
        : query.moderationStatus === 'hidden'
          ? and(
              isNotNull(attendeeNeedQuestions.adminHiddenAt),
              isNull(attendeeNeedQuestions.deletedAt),
            )
          : query.moderationStatus === 'deleted'
            ? isNotNull(attendeeNeedQuestions.deletedAt)
            : undefined;
    const pattern = query.query ? `%${query.query}%` : null;
    return and(
      this.adminBaseCondition(organizationId, eventId),
      query.questionId ? eq(attendeeNeedQuestions.id, query.questionId) : undefined,
      visibility,
      moderation,
      query.tag ? sql`${attendeeNeedQuestions.tagCodes} ? ${query.tag}` : undefined,
      query.submittedFrom
        ? gte(attendeeNeedQuestions.createdAt, new Date(query.submittedFrom))
        : undefined,
      query.submittedTo
        ? lte(attendeeNeedQuestions.createdAt, new Date(query.submittedTo))
        : undefined,
      pattern
        ? or(
            ilike(attendeeNeedQuestions.content, pattern),
            ilike(attendeeNeedSubmissions.attributionName, pattern),
            ilike(registrations.registrationCode, pattern),
            sql`${registrations.attendee}->>'name' ilike ${pattern}`,
          )
        : undefined,
    )!;
  }

  private adminQuery(
    organizationId: string,
    eventId: number,
    database: Database | Transaction = this.db(),
  ) {
    const forcedAnonymity = this.forcedAnonymityBySubmission(database, organizationId, eventId);
    return database
      .select({
        question: attendeeNeedQuestions,
        submission: attendeeNeedSubmissions,
        registration: registrations,
        order: orders,
        ticket: tickets,
        customer: customerUsers,
        event: events,
        publicationEnabled: sql<boolean>`coalesce(exists (
          select 1
          from jsonb_array_elements(coalesce(
            ${eventReleases.snapshot}->'experience'->'home'->'blocks',
            ${eventReleases.snapshot}->'home'->'blocks',
            '[]'::jsonb
          )) released_block
          where released_block->>'nodeKey' = 'home.attendee-needs'
            and released_block->>'type' = 'attendee-needs'
            and released_block->>'enabled' = 'true'
        ), false)`,
        adminForcedAnonymous: sql<boolean>`${forcedAnonymity.submissionId} is not null`,
        adminForcedAnonymousReason: forcedAnonymity.reason,
        paymentSatisfied: sql<boolean>`${orders.amount} = 0 or exists (
          select 1 from ${payments} attendee_needs_admin_payment
          where attendee_needs_admin_payment.order_id = ${orders.id}
            and attendee_needs_admin_payment.status = 'succeeded'
        )`,
      })
      .from(attendeeNeedQuestions)
      .innerJoin(
        attendeeNeedSubmissions,
        eq(attendeeNeedSubmissions.id, attendeeNeedQuestions.submissionId),
      )
      .innerJoin(registrations, eq(registrations.id, attendeeNeedSubmissions.registrationId))
      .innerJoin(orders, eq(orders.registrationId, registrations.id))
      .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
      .innerJoin(customerUsers, eq(customerUsers.id, attendeeNeedSubmissions.customerUserId))
      .innerJoin(events, eq(events.id, attendeeNeedSubmissions.eventId))
      .leftJoin(
        eventReleases,
        and(
          eq(eventReleases.eventId, events.id),
          sql`${eventReleases.id}::text = ${events.settings}->>'currentReleaseId'`,
        ),
      )
      .leftJoin(forcedAnonymity, eq(forcedAnonymity.submissionId, attendeeNeedSubmissions.id));
  }

  private adminItem(row: Awaited<ReturnType<AttendeeNeedsService['adminQuery']>>[number]) {
    const qualification = attendeeNeedsQualification({
      eventStatus: row.event.status,
      customerStatus: row.customer.status,
      registrationStatus: row.registration.status,
      orderStatus: row.order.status,
      paymentSatisfied: row.paymentSatisfied,
      ticketStatus: row.ticket?.status ?? null,
      isPublic: row.submission.isPublic,
    });
    const effectivePublic = attendeeNeedQuestionIsVisible({
      qualified: qualification.qualified,
      publicationEnabled: row.publicationEnabled,
      consentVersionCurrent: row.submission.consentVersion === ATTENDEE_NEED_CONSENT_VERSION,
      firstPublishedAt: row.question.firstPublishedAt,
      adminHiddenAt: row.question.adminHiddenAt,
      deletedAt: row.question.deletedAt,
    });
    const publicationEnabled = row.publicationEnabled;
    const consentVersionCurrent = row.submission.consentVersion === ATTENDEE_NEED_CONSENT_VERSION;
    return AdminAttendeeNeedItemSchema.parse({
      id: row.question.id,
      submissionId: row.submission.id,
      registrationId: row.registration.id,
      registrationCode: row.registration.registrationCode,
      attendeeName: row.registration.attendee.name,
      registrationStatus: row.registration.status,
      orderStatus: row.order.status,
      ticketStatus: row.ticket?.status ?? null,
      customerUserId: row.submission.customerUserId,
      content: row.question.content,
      tagCodes: row.question.tagCodes,
      isPublic: row.submission.isPublic,
      isAnonymous: row.submission.isAnonymous || row.adminForcedAnonymous,
      adminForcedAnonymous: row.adminForcedAnonymous,
      adminForcedAnonymousReason: row.adminForcedAnonymousReason,
      attributionName: row.adminForcedAnonymous ? null : row.submission.attributionName,
      effectivePublic,
      qualificationReason:
        qualification.reason ??
        (!publicationEnabled
          ? '首页参会需求模块尚未发布'
          : !consentVersionCurrent
            ? '需要重新确认公开授权'
            : null),
      adminEdited: Boolean(row.question.adminEditedAt),
      adminEditReason: row.question.adminEditReason,
      adminHidden: Boolean(row.question.adminHiddenAt),
      adminHiddenReason: row.question.adminHiddenReason,
      deleted: Boolean(row.question.deletedAt),
      deletedByType: row.question.deletedByType,
      deletedReason: row.question.deletedReason,
      version: row.submission.version,
      firstPublishedAt: asIso(row.question.firstPublishedAt),
      createdAt: row.question.createdAt.toISOString(),
      updatedAt: row.question.updatedAt.toISOString(),
    });
  }

  async adminList(organizationId: string, eventId: number, query: AdminAttendeeNeedListQuery) {
    const condition = this.adminFilterCondition(organizationId, eventId, query);
    const baseCondition = this.adminBaseCondition(organizationId, eventId);
    const [totalRows, rows, countRows, publicationEnabled] = await this.db().transaction(
      async (tx) => {
        const [release] = await tx
          .select({ snapshot: eventReleases.snapshot })
          .from(events)
          .leftJoin(
            eventReleases,
            and(
              eq(eventReleases.eventId, events.id),
              sql`${eventReleases.id}::text = ${events.settings}->>'currentReleaseId'`,
            ),
          )
          .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
          .limit(1);
        const [totals, pageRows, aggregates] = await Promise.all([
          tx
            .select({ value: count(attendeeNeedQuestions.id) })
            .from(attendeeNeedQuestions)
            .innerJoin(
              attendeeNeedSubmissions,
              eq(attendeeNeedSubmissions.id, attendeeNeedQuestions.submissionId),
            )
            .innerJoin(registrations, eq(registrations.id, attendeeNeedSubmissions.registrationId))
            .innerJoin(orders, eq(orders.registrationId, registrations.id))
            .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
            .innerJoin(customerUsers, eq(customerUsers.id, attendeeNeedSubmissions.customerUserId))
            .innerJoin(events, eq(events.id, attendeeNeedSubmissions.eventId))
            .where(condition),
          this.adminQuery(organizationId, eventId, tx)
            .where(condition)
            .orderBy(desc(attendeeNeedQuestions.createdAt), desc(attendeeNeedQuestions.id))
            .limit(query.pageSize)
            .offset((query.page - 1) * query.pageSize),
          tx
            .select({
              total: count(attendeeNeedQuestions.id),
              public: sql<number>`count(*) filter (where ${publicEligibilitySql()})::int`,
              anonymous: sql<number>`count(*) filter (where ${publicEligibilitySql()} and ${attendeeNeedSubmissions.isAnonymous} = true)::int`,
              hidden: sql<number>`count(*) filter (where ${attendeeNeedQuestions.adminHiddenAt} is not null and ${attendeeNeedQuestions.deletedAt} is null)::int`,
              deleted: sql<number>`count(*) filter (where ${attendeeNeedQuestions.deletedAt} is not null)::int`,
              submitters: sql<number>`count(distinct ${attendeeNeedSubmissions.id})::int`,
            })
            .from(attendeeNeedQuestions)
            .innerJoin(
              attendeeNeedSubmissions,
              eq(attendeeNeedSubmissions.id, attendeeNeedQuestions.submissionId),
            )
            .innerJoin(registrations, eq(registrations.id, attendeeNeedSubmissions.registrationId))
            .innerJoin(orders, eq(orders.registrationId, registrations.id))
            .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
            .innerJoin(customerUsers, eq(customerUsers.id, attendeeNeedSubmissions.customerUserId))
            .innerJoin(events, eq(events.id, attendeeNeedSubmissions.eventId))
            .where(baseCondition),
        ]);
        return [totals, pageRows, aggregates, attendeeNeedsHomeEnabled(release?.snapshot)] as const;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const total = Number(totalRows[0]?.value ?? 0);
    const counts = countRows[0];
    return AdminAttendeeNeedListSchema.parse({
      items: rows.map((row) => this.adminItem(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      counts: {
        submitters: Number(counts?.submitters ?? 0),
        total: Number(counts?.total ?? 0),
        public: publicationEnabled ? Number(counts?.public ?? 0) : 0,
        anonymous: publicationEnabled ? Number(counts?.anonymous ?? 0) : 0,
        hidden: Number(counts?.hidden ?? 0),
        deleted: Number(counts?.deleted ?? 0),
      },
    });
  }

  private async adminQuestionContext(organizationId: string, eventId: number, questionId: string) {
    const [row] = await this.adminQuery(organizationId, eventId)
      .where(
        and(
          this.adminBaseCondition(organizationId, eventId),
          eq(attendeeNeedQuestions.id, questionId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '参会问题不存在', HttpStatus.NOT_FOUND);
    }
    return row;
  }

  async updateAdminQuestion(
    organizationId: string,
    actorId: string,
    eventId: number,
    questionId: string,
    input: UpdateAdminAttendeeNeedQuestion,
  ) {
    const row = await this.adminQuestionContext(organizationId, eventId, questionId);
    if (row.submission.version !== input.version) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '参会需求已被更新，请刷新后再保存',
        HttpStatus.CONFLICT,
      );
    }
    if (row.question.deletedAt) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '请先恢复已删除的问题，再修改正文或标签',
        HttpStatus.CONFLICT,
      );
    }
    const now = new Date();
    const contentChanged = row.question.content !== input.content;
    const tagCodesChanged =
      row.question.tagCodes.length !== input.tagCodes.length ||
      row.question.tagCodes.some((code, index) => code !== input.tagCodes[index]);
    const administratorChangedQuestion = contentChanged || tagCodesChanged;
    const auditFacts = attendeeNeedAdminEditAuditFacts({
      contentChanged,
      tagCodesChanged,
      wasAdminEdited: Boolean(row.question.adminEditedAt),
      wasAnonymous: row.submission.isAnonymous,
      nextAnonymous: administratorChangedQuestion ? true : row.submission.isAnonymous,
      reason: input.reason,
    });
    await this.db().transaction(async (tx) => {
      const [updated] = await tx
        .update(attendeeNeedSubmissions)
        .set({
          ...(administratorChangedQuestion
            ? {
                isAnonymous: true,
                attributionName: null,
              }
            : {}),
          version: sql`${attendeeNeedSubmissions.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(attendeeNeedSubmissions.id, row.submission.id),
            eq(attendeeNeedSubmissions.version, input.version),
          ),
        )
        .returning({ id: attendeeNeedSubmissions.id });
      if (!updated) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '参会需求已被更新，请刷新后再保存',
          HttpStatus.CONFLICT,
        );
      }
      await tx
        .update(attendeeNeedQuestions)
        .set({
          content: input.content,
          tagCodes: [...input.tagCodes],
          adminEditedAt: now,
          adminEditReason: input.reason,
          updatedAt: now,
        })
        .where(eq(attendeeNeedQuestions.id, row.question.id));
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: 'attendee_needs.admin_edit',
        resourceType: 'attendee_need_question',
        resourceId: row.question.id,
        ...auditFacts,
        traceId: randomUUID(),
      });
    });
    return this.adminQuestionContext(organizationId, eventId, questionId).then((item) =>
      this.adminItem(item),
    );
  }

  async moderateAdminQuestion(
    organizationId: string,
    actorId: string,
    eventId: number,
    questionId: string,
    input: ModerateAttendeeNeedQuestion,
  ) {
    const row = await this.adminQuestionContext(organizationId, eventId, questionId);
    if (row.submission.version !== input.version) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '参会需求已被更新，请刷新后再处理',
        HttpStatus.CONFLICT,
      );
    }
    if (['hide', 'delete', 'anonymize'].includes(input.action) && !input.reason?.trim()) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '执行治理操作时需要填写原因',
        HttpStatus.BAD_REQUEST,
      );
    }
    const stateError = attendeeNeedModerationStateError({
      action: input.action,
      adminHiddenAt: row.question.adminHiddenAt,
      deletedAt: row.question.deletedAt,
      deletedByType: row.question.deletedByType,
    });
    if (stateError) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        stateError,
        HttpStatus.CONFLICT,
      );
    }
    const now = new Date();
    let restorePosition = row.question.position;
    if (input.action === 'restore-delete') {
      const active = await this.activeQuestions(row.submission.id);
      const positions = new Set(active.map((question) => question.position));
      const available = [1, 2, 3].find((position) => !positions.has(position));
      if (!available) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前已有 3 个有效问题，请先删除一个问题再恢复',
          HttpStatus.CONFLICT,
        );
      }
      restorePosition = available;
    }
    await this.db().transaction(async (tx) => {
      const [updated] = await tx
        .update(attendeeNeedSubmissions)
        .set({
          ...(input.action === 'anonymize'
            ? {
                isAnonymous: true,
                attributionName: null,
              }
            : {}),
          version: sql`${attendeeNeedSubmissions.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(attendeeNeedSubmissions.id, row.submission.id),
            eq(attendeeNeedSubmissions.version, input.version),
          ),
        )
        .returning({ id: attendeeNeedSubmissions.id });
      if (!updated) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '参会需求已被更新，请刷新后再处理',
          HttpStatus.CONFLICT,
        );
      }
      if (input.action !== 'anonymize') {
        await tx
          .update(attendeeNeedQuestions)
          .set({
            ...(input.action === 'hide'
              ? { adminHiddenAt: now, adminHiddenReason: input.reason?.trim() ?? null }
              : input.action === 'restore'
                ? { adminHiddenAt: null, adminHiddenReason: null }
                : input.action === 'delete'
                  ? {
                      deletedAt: now,
                      deletedByType: 'admin' as const,
                      deletedReason: input.reason?.trim() ?? null,
                    }
                  : {
                      position: restorePosition,
                      deletedAt: null,
                      deletedByType: null,
                      deletedReason: null,
                    }),
            updatedAt: now,
          })
          .where(eq(attendeeNeedQuestions.id, row.question.id));
      }
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: `attendee_needs.${input.action}`,
        resourceType: 'attendee_need_question',
        resourceId: row.question.id,
        before: {
          isAnonymous: row.submission.isAnonymous,
          hidden: Boolean(row.question.adminHiddenAt),
          deleted: Boolean(row.question.deletedAt),
        },
        after: {
          action: input.action,
          reason: input.reason ?? null,
          forcedAnonymous: input.action === 'anonymize',
        },
        traceId: randomUUID(),
      });
    });
    return this.adminQuestionContext(organizationId, eventId, questionId).then((item) =>
      this.adminItem(item),
    );
  }

  async exportAdminCsv(
    organizationId: string,
    actorId: string,
    eventId: number,
    query: AdminAttendeeNeedExportQuery,
  ) {
    const speaker = query.variant === 'speaker';
    const sourceRows = await this.db().transaction(
      async (tx) => {
        if (speaker) {
          const [release] = await tx
            .select({ snapshot: eventReleases.snapshot })
            .from(events)
            .leftJoin(
              eventReleases,
              and(
                eq(eventReleases.eventId, events.id),
                sql`${eventReleases.id}::text = ${events.settings}->>'currentReleaseId'`,
              ),
            )
            .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
            .limit(1);
          if (!attendeeNeedsHomeEnabled(release?.snapshot)) return [];
        }
        return this.adminQuery(organizationId, eventId, tx)
          .where(
            and(
              this.adminFilterCondition(organizationId, eventId, {
                ...query,
                page: 1,
                pageSize: 100,
              }),
              speaker ? publicEligibilitySql() : undefined,
            ),
          )
          .orderBy(desc(attendeeNeedQuestions.createdAt), desc(attendeeNeedQuestions.id))
          .limit(ATTENDEE_NEEDS_EXPORT_MAX_ROWS + 1);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (sourceRows.length > ATTENDEE_NEEDS_EXPORT_MAX_ROWS) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        `单次最多导出 ${ATTENDEE_NEEDS_EXPORT_MAX_ROWS} 条参会需求，请缩小筛选范围`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const items = sourceRows.map((row) => this.adminItem(row));
    const rows = speaker ? items.filter((item) => item.effectivePublic) : items;
    const headers = speaker
      ? ['问题', '主题标签', '公开署名', '首次公开日期']
      : [
          '问题 ID',
          '问题',
          '主题标签',
          '状态',
          '报名编号',
          '内部用户 ID',
          '报名姓名',
          '提交时间',
          '更新时间',
        ];
    const bodyRows = rows.map((item) =>
      speaker
        ? [
            item.content,
            item.tagCodes.map((code) => topicLabels.get(code) ?? code).join(' / '),
            query.forceAnonymous || item.isAnonymous
              ? '匿名参会者'
              : (item.attributionName ?? '匿名参会者'),
            item.firstPublishedAt?.slice(0, 10) ?? '',
          ]
        : [
            item.id,
            item.content,
            item.tagCodes.map((code) => topicLabels.get(code) ?? code).join(' / '),
            item.deleted
              ? '已删除'
              : item.adminHidden
                ? '已隐藏'
                : item.effectivePublic
                  ? '公开'
                  : item.isPublic
                    ? `资格失效${item.qualificationReason ? `：${item.qualificationReason}` : ''}`
                    : '私有',
            item.registrationCode,
            item.customerUserId,
            item.attendeeName,
            item.createdAt,
            item.updatedAt,
          ],
    );
    const csv = `\uFEFF${[headers, ...bodyRows]
      .map((row) => row.map(escapeCsvCell).join(','))
      .join('\r\n')}\r\n`;
    await this.db()
      .insert(auditLogs)
      .values({
        organizationId,
        eventId,
        actorId,
        action: speaker ? 'attendee_needs.export_speaker' : 'attendee_needs.export_internal',
        resourceType: 'attendee_need_export',
        resourceId: randomUUID(),
        after: {
          variant: query.variant,
          forceAnonymous: query.forceAnonymous,
          count: rows.length,
          filters: {
            ...(query.query
              ? {
                  queryDigest: createHash('sha256').update(query.query).digest('hex'),
                  queryLength: Array.from(query.query).length,
                }
              : {}),
            tag: query.tag ?? null,
            visibility: query.visibility ?? null,
            moderationStatus: query.moderationStatus ?? null,
            submittedFrom: query.submittedFrom ?? null,
            submittedTo: query.submittedTo ?? null,
          },
        },
        traceId: randomUUID(),
      });
    return {
      filename: `attendee-needs-${eventId}-${query.variant}-${new Date().toISOString().slice(0, 10)}.csv`,
      count: rows.length,
      csv,
    };
  }
}
