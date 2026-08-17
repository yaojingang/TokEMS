import { randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  AdminCooperationRequestListSchema,
  AdminCooperationRequestSchema,
  API_ERROR_CODES,
  DEMO_EVENT,
  DEMO_IDS,
  PUBLIC_EVENT_STATUSES,
  PublicCooperationRequestResultSchema,
} from '@conference/contracts';
import type {
  AdminCooperationRequest,
  AdminCooperationRequestList,
  AdminCooperationRequestListQuery,
  CooperationRequestStatus,
  CreateCooperationRequest,
  EventId,
  PublicCooperationRequestResult,
  UpdateCooperationRequest,
} from '@conference/contracts';
import { auditLogs, cooperationRequests, events, organizations } from '@conference/database';
import { normalizeMainlandMobile } from '@conference/security';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';

const REQUEST_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type StoredCooperationRequest = AdminCooperationRequest & { organizationId: string };

function makeRequestNo(now = new Date()) {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const bytes = randomBytes(6);
  let suffix = '';
  for (const byte of bytes) suffix += REQUEST_ALPHABET[byte % REQUEST_ALPHABET.length];
  return `COOP-${date}-${suffix}`;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

@Injectable()
export class CooperationRequestService {
  private readonly memoryRequests: StoredCooperationRequest[] = [];

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async create(
    organizationSlug: string,
    input: CreateCooperationRequest,
  ): Promise<PublicCooperationRequestResult> {
    const db = this.database.db;
    const submittedAt = new Date();
    const mobile = input.mobile ? normalizeMainlandMobile(input.mobile) : '';
    const email = input.email.trim().toLocaleLowerCase();

    if (!db) {
      if (
        organizationSlug !== 'geo-conference' ||
        input.eventId !== DEMO_IDS.event ||
        !PUBLIC_EVENT_STATUSES.includes(DEMO_EVENT.status as (typeof PUBLIC_EVENT_STATUSES)[number])
      ) {
        this.throwPublicEventNotFound();
      }
      const requestNo = makeRequestNo(submittedAt);
      this.memoryRequests.push({
        id: randomUUID(),
        organizationId: DEMO_IDS.organization,
        eventId: input.eventId,
        requestNo,
        cooperationTypes: [...input.cooperationTypes],
        companyName: input.companyName,
        contactName: input.contactName,
        contactTitle: input.contactTitle,
        mobile,
        email,
        wechatId: input.wechatId,
        message: input.message,
        status: 'new',
        internalNote: '',
        firstContactedAt: null,
        resolvedAt: null,
        createdAt: submittedAt.toISOString(),
        updatedAt: submittedAt.toISOString(),
      });
      return PublicCooperationRequestResultSchema.parse({
        requestNo,
        eventName: DEMO_EVENT.name,
        submittedAt: submittedAt.toISOString(),
      });
    }

    const [event] = await db
      .select({ id: events.id, name: events.name, organizationId: events.organizationId })
      .from(events)
      .innerJoin(organizations, eq(organizations.id, events.organizationId))
      .where(
        and(
          eq(organizations.slug, organizationSlug),
          eq(events.id, input.eventId),
          inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
        ),
      )
      .limit(1);
    if (!event) this.throwPublicEventNotFound();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const requestNo = makeRequestNo(submittedAt);
      try {
        await db.insert(cooperationRequests).values({
          organizationId: event.organizationId,
          eventId: event.id,
          requestNo,
          cooperationTypes: [...input.cooperationTypes],
          companyName: input.companyName,
          contactName: input.contactName,
          contactTitle: input.contactTitle,
          mobileE164: mobile,
          emailNormalized: email,
          wechatId: input.wechatId,
          message: input.message,
          createdAt: submittedAt,
          updatedAt: submittedAt,
        });
        return PublicCooperationRequestResultSchema.parse({
          requestNo,
          eventName: event.name,
          submittedAt: submittedAt.toISOString(),
        });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 4) throw error;
      }
    }
    throw new Error('合作申请编号生成失败');
  }

  async list(
    organizationId: string,
    eventId: EventId,
    query: AdminCooperationRequestListQuery,
  ): Promise<AdminCooperationRequestList> {
    const db = this.database.db;
    if (!db) {
      this.assertMemoryEventScope(organizationId, eventId);
      const scoped = this.memoryRequests
        .filter((item) => item.organizationId === organizationId && item.eventId === eventId)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        );
      const q = query.q?.toLocaleLowerCase();
      const filtered = scoped.filter((item) => {
        if (query.status && item.status !== query.status) return false;
        if (query.type && !item.cooperationTypes.includes(query.type)) return false;
        if (
          q &&
          ![
            item.requestNo,
            item.companyName,
            item.contactName,
            item.mobile,
            item.email,
            item.wechatId,
            item.message,
          ].some((value) => value.toLocaleLowerCase().includes(q))
        ) {
          return false;
        }
        return true;
      });
      const start = (query.page - 1) * query.pageSize;
      return AdminCooperationRequestListSchema.parse({
        items: filtered.slice(start, start + query.pageSize),
        total: filtered.length,
        page: query.page,
        pageSize: query.pageSize,
        counts: this.countStatuses(scoped),
      });
    }

    await this.assertDatabaseEventScope(organizationId, eventId);
    const baseCondition = and(
      eq(cooperationRequests.organizationId, organizationId),
      eq(cooperationRequests.eventId, eventId),
    );
    const searchCondition = query.q
      ? or(
          ilike(cooperationRequests.requestNo, `%${query.q}%`),
          ilike(cooperationRequests.companyName, `%${query.q}%`),
          ilike(cooperationRequests.contactName, `%${query.q}%`),
          ilike(cooperationRequests.mobileE164, `%${query.q}%`),
          ilike(cooperationRequests.emailNormalized, `%${query.q}%`),
          ilike(cooperationRequests.wechatId, `%${query.q}%`),
          ilike(cooperationRequests.message, `%${query.q}%`),
        )
      : undefined;
    const listCondition = and(
      baseCondition,
      query.status ? eq(cooperationRequests.status, query.status) : undefined,
      query.type
        ? sql`${cooperationRequests.cooperationTypes} @> ${JSON.stringify([query.type])}::jsonb`
        : undefined,
      searchCondition,
    );

    const [rows, totalRows, statusRows] = await Promise.all([
      db
        .select()
        .from(cooperationRequests)
        .where(listCondition)
        .orderBy(desc(cooperationRequests.createdAt), desc(cooperationRequests.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(cooperationRequests).where(listCondition),
      db
        .select({ status: cooperationRequests.status, value: count() })
        .from(cooperationRequests)
        .where(baseCondition)
        .groupBy(cooperationRequests.status),
    ]);
    const counts = { all: 0, new: 0, contacted: 0, converted: 0, closed: 0 };
    for (const row of statusRows) {
      if (row.status in counts) counts[row.status as CooperationRequestStatus] = row.value;
      counts.all += row.value;
    }
    return AdminCooperationRequestListSchema.parse({
      items: rows.map((row) => this.mapRow(row)),
      total: totalRows[0]?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      counts,
    });
  }

  async detail(
    organizationId: string,
    eventId: EventId,
    requestId: string,
  ): Promise<AdminCooperationRequest> {
    const db = this.database.db;
    if (!db) {
      const item = this.memoryRequests.find(
        (request) =>
          request.id === requestId &&
          request.organizationId === organizationId &&
          request.eventId === eventId,
      );
      if (!item) this.throwRequestNotFound();
      return AdminCooperationRequestSchema.parse(item);
    }
    const [row] = await db
      .select()
      .from(cooperationRequests)
      .where(
        and(
          eq(cooperationRequests.id, requestId),
          eq(cooperationRequests.organizationId, organizationId),
          eq(cooperationRequests.eventId, eventId),
        ),
      )
      .limit(1);
    if (!row) this.throwRequestNotFound();
    return this.mapRow(row);
  }

  async update(
    organizationId: string,
    eventId: EventId,
    requestId: string,
    actorId: string,
    input: UpdateCooperationRequest,
  ): Promise<AdminCooperationRequest> {
    const db = this.database.db;
    if (!db) {
      const index = this.memoryRequests.findIndex(
        (request) =>
          request.id === requestId &&
          request.organizationId === organizationId &&
          request.eventId === eventId,
      );
      if (index < 0) this.throwRequestNotFound();
      const current = this.memoryRequests[index]!;
      if (current.updatedAt !== input.expectedUpdatedAt) this.throwVersionConflict();
      const now = new Date(Math.max(Date.now(), new Date(current.updatedAt).getTime() + 1));
      const status = input.status ?? current.status;
      const next: StoredCooperationRequest = {
        ...current,
        status,
        internalNote: input.internalNote ?? current.internalNote,
        firstContactedAt:
          status !== 'new' && !current.firstContactedAt
            ? now.toISOString()
            : current.firstContactedAt,
        resolvedAt: ['converted', 'closed'].includes(status)
          ? (current.resolvedAt ?? now.toISOString())
          : null,
        updatedAt: now.toISOString(),
      };
      this.memoryRequests[index] = next;
      return AdminCooperationRequestSchema.parse(next);
    }

    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(cooperationRequests)
        .where(
          and(
            eq(cooperationRequests.id, requestId),
            eq(cooperationRequests.organizationId, organizationId),
            eq(cooperationRequests.eventId, eventId),
          ),
        )
        .limit(1);
      if (!current) this.throwRequestNotFound();
      if (current.updatedAt.toISOString() !== input.expectedUpdatedAt) this.throwVersionConflict();

      const now = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
      const status = input.status ?? (current.status as CooperationRequestStatus);
      const [updated] = await tx
        .update(cooperationRequests)
        .set({
          status,
          internalNote: input.internalNote ?? current.internalNote,
          firstContactedAt:
            status !== 'new' && !current.firstContactedAt ? now : current.firstContactedAt,
          resolvedAt: ['converted', 'closed'].includes(status) ? (current.resolvedAt ?? now) : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(cooperationRequests.id, requestId),
            eq(cooperationRequests.organizationId, organizationId),
            eq(cooperationRequests.eventId, eventId),
            eq(cooperationRequests.updatedAt, new Date(input.expectedUpdatedAt)),
          ),
        )
        .returning();
      if (!updated) this.throwVersionConflict();

      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: 'cooperation_request.updated',
        resourceType: 'cooperation_request',
        resourceId: requestId,
        before: { status: current.status, internalNote: current.internalNote },
        after: { status: updated.status, internalNote: updated.internalNote },
        traceId: randomUUID(),
      });
      return this.mapRow(updated);
    });
  }

  private mapRow(row: typeof cooperationRequests.$inferSelect): AdminCooperationRequest {
    return AdminCooperationRequestSchema.parse({
      id: row.id,
      eventId: row.eventId,
      requestNo: row.requestNo,
      cooperationTypes: row.cooperationTypes,
      companyName: row.companyName,
      contactName: row.contactName,
      contactTitle: row.contactTitle,
      mobile: row.mobileE164,
      email: row.emailNormalized,
      wechatId: row.wechatId,
      message: row.message,
      status: row.status,
      internalNote: row.internalNote,
      firstContactedAt: row.firstContactedAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  private countStatuses(items: StoredCooperationRequest[]) {
    const counts = { all: items.length, new: 0, contacted: 0, converted: 0, closed: 0 };
    for (const item of items) counts[item.status] += 1;
    return counts;
  }

  private assertMemoryEventScope(organizationId: string, eventId: EventId) {
    if (organizationId !== DEMO_IDS.organization || eventId !== DEMO_IDS.event) {
      this.throwRequestNotFound();
    }
  }

  private async assertDatabaseEventScope(organizationId: string, eventId: EventId) {
    const db = this.database.db;
    if (!db) return;
    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.organizationId, organizationId), eq(events.id, eventId)))
      .limit(1);
    if (!event) this.throwRequestNotFound();
  }

  private throwPublicEventNotFound(): never {
    throw new DomainError(API_ERROR_CODES.NOT_FOUND, '大会不存在或尚未公开', HttpStatus.NOT_FOUND);
  }

  private throwRequestNotFound(): never {
    throw new DomainError(API_ERROR_CODES.NOT_FOUND, '合作申请不存在', HttpStatus.NOT_FOUND);
  }

  private throwVersionConflict(): never {
    throw new DomainError(
      API_ERROR_CODES.INVALID_STATE_TRANSITION,
      '合作申请已被其他管理员更新，请刷新后重试',
      HttpStatus.CONFLICT,
    );
  }
}
