import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  AdminAttendeeShowcase,
  AttendeeAvatarConfirm,
  AttendeeAvatarUpload,
  AttendeeAvatarUploadResult,
  AttendeeShowcaseProfile,
  ModerateAttendeeShowcase,
  PublicEventMemberDetail,
  PublicEventMemberList,
  PublicEventMemberListQuery,
  UpdateAttendeeShowcase,
} from '@conference/contracts';
import {
  API_ERROR_CODES,
  ATTENDEE_INDUSTRY_OPTIONS,
  ATTENDEE_SHOWCASE_CONSENT_VERSION,
  AttendeeShowcaseProfileSchema,
  DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
  PublicEventMemberDetailSchema,
  PublicEventMemberListSchema,
} from '@conference/contracts';
import {
  attendeeShowcaseProfiles,
  auditLogs,
  customerMediaAssets,
  customerProfiles,
  customerUsers,
  events,
  orders,
  outboxEvents,
  payments,
  publicUserIds,
  registrations,
  tickets,
} from '@conference/database';
import { and, asc, count, eq, gte, inArray, isNull, min, sql } from 'drizzle-orm';
import { ConferenceRepository } from './conference.repository.js';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { matchesDeclaredMediaType, readUploadWithinLimit } from './object-storage-verification.js';
import {
  attendeeAvatarInitial,
  attendeeShowcaseConsentMetadata,
  attendeeShowcaseQualification,
  attendeeShowcasePublicEligibilitySql,
  attendeeShowcaseVersionMatches,
  PUBLIC_ORDER_STATUSES,
  PUBLIC_REGISTRATION_STATUSES,
  PUBLIC_TICKET_STATUSES,
} from './attendee-showcase-policy.js';
const PAGE_SIZE = 40 as const;
const industryLabels = new Map(ATTENDEE_INDUSTRY_OPTIONS.map((item) => [item.code, item.label]));
const industryOrder = new Map(ATTENDEE_INDUSTRY_OPTIONS.map((item, index) => [item.code, index]));

function asIso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function avatarDeletionPayload(asset: typeof customerMediaAssets.$inferSelect) {
  return {
    assetId: asset.id,
    organizationId: asset.organizationId,
    customerUserId: asset.customerUserId,
    sourceStorageKey: asset.sourceStorageKey,
    outputStorageKey:
      asset.outputStorageKey ??
      `customers/${asset.organizationId}/${asset.customerUserId}/avatars/${asset.id}/avatar.webp`,
  };
}

function completionScore(row: {
  displayName: string | null;
  company: string | null;
  title: string | null;
  industryCode: string | null;
  businessIntro: string | null;
  businessUrl: string | null;
  avatarStatus: string;
}) {
  const values = [
    row.displayName,
    row.company,
    row.title,
    row.industryCode,
    row.businessIntro,
    row.businessUrl,
    row.avatarStatus === 'ready' ? 'avatar' : null,
  ];
  const completedFields = values.filter(Boolean).length;
  return {
    completedFields,
    totalFields: values.length,
    score: Math.round((completedFields / values.length) * 100),
  };
}

@Injectable()
export class AttendeeShowcaseService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConferenceRepository) private readonly conference: ConferenceRepository,
  ) {}

  private db() {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '参会名片需要启用数据库后使用',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private s3Presigned(
    storageKey: string,
    method: 'GET' | 'PUT',
    mediaType?: string,
    endpointOverride?: string,
    contentLength?: number,
  ) {
    const endpoint = endpointOverride ?? process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT;
    const accessKey = process.env.S3_ACCESS_KEY;
    const secretKey = process.env.S3_SECRET_KEY;
    const bucket = process.env.S3_BUCKET;
    if (!endpoint || !accessKey || !secretKey || !bucket) return null;
    const region = process.env.S3_REGION ?? 'us-east-1';
    const now = new Date();
    const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const endpointUrl = new URL(endpoint);
    const encodePath = (value: string) =>
      value
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    const canonicalUri = `${endpointUrl.pathname.replace(/\/$/, '')}/${encodePath(bucket)}/${encodePath(storageKey)}`;
    const credential = `${accessKey}/${day}/${region}/s3/aws4_request`;
    const signedHeaders = mediaType
      ? method === 'PUT'
        ? contentLength
          ? 'content-length;content-type;host;if-none-match'
          : 'content-type;host;if-none-match'
        : 'content-type;host'
      : method === 'PUT'
        ? 'host;if-none-match'
        : 'host';
    const params = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': credential,
      'X-Amz-Date': date,
      'X-Amz-Expires': '600',
      'X-Amz-SignedHeaders': signedHeaders,
    });
    params.sort();
    const canonicalHeaders = `${contentLength ? `content-length:${contentLength}\n` : ''}${mediaType ? `content-type:${mediaType}\n` : ''}host:${endpointUrl.host}\n${method === 'PUT' ? 'if-none-match:*\n' : ''}`;
    const canonicalRequest = [
      method,
      canonicalUri,
      params.toString(),
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      date,
      `${day}/${region}/s3/aws4_request`,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const hmac = (key: Buffer | string, value: string) =>
      createHmac('sha256', key).update(value).digest();
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'),
      'aws4_request',
    );
    params.set(
      'X-Amz-Signature',
      createHmac('sha256', signingKey).update(stringToSign).digest('hex'),
    );
    return `${endpointUrl.origin}${canonicalUri}?${params.toString()}`;
  }

  private async avatarContent(storageKey: string) {
    const internalUrl = this.s3Presigned(storageKey, 'GET', undefined, process.env.S3_ENDPOINT);
    if (!internalUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    let response: Response;
    try {
      response = await fetch(internalUrl, { signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '头像暂时无法读取',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!response.ok) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '头像不存在', HttpStatus.NOT_FOUND);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > 2 * 1024 * 1024) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '头像文件异常',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > 2 * 1024 * 1024 || !matchesDeclaredMediaType(body, 'image/webp')) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '头像文件异常',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return body;
  }

  async ownedRow(session: AuthenticatedCustomer, registrationId: string) {
    const [row] = await this.db()
      .select({
        registration: registrations,
        event: events,
        order: orders,
        ticket: tickets,
        customer: customerUsers,
        commonProfile: customerProfiles,
        showcase: attendeeShowcaseProfiles,
        avatar: customerMediaAssets,
        successfulPaymentAt: min(payments.succeededAt),
      })
      .from(registrations)
      .innerJoin(events, eq(events.id, registrations.eventId))
      .innerJoin(orders, eq(orders.registrationId, registrations.id))
      .innerJoin(customerUsers, eq(customerUsers.id, registrations.customerUserId))
      .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
      .leftJoin(customerProfiles, eq(customerProfiles.customerUserId, customerUsers.id))
      .leftJoin(
        attendeeShowcaseProfiles,
        eq(attendeeShowcaseProfiles.registrationId, registrations.id),
      )
      .leftJoin(
        customerMediaAssets,
        eq(customerMediaAssets.id, attendeeShowcaseProfiles.avatarAssetId),
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
        attendeeShowcaseProfiles.id,
        customerMediaAssets.id,
      )
      .limit(1);
    if (!row) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '报名记录不存在', HttpStatus.NOT_FOUND);
    }
    return row;
  }

  private async ensureProfile(
    session: AuthenticatedCustomer,
    registrationId: string,
    owned?: Awaited<ReturnType<AttendeeShowcaseService['ownedRow']>>,
  ) {
    const row = owned ?? (await this.ownedRow(session, registrationId));
    if (row.showcase) return { profile: row.showcase, created: false };
    if (
      !PUBLIC_REGISTRATION_STATUSES.includes(row.registration.status as never) ||
      !PUBLIC_ORDER_STATUSES.includes(row.order.status as never) ||
      !row.ticket ||
      !PUBLIC_TICKET_STATUSES.includes(row.ticket.status as never) ||
      (row.order.amount > 0 && !row.successfulPaymentAt)
    ) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '完成报名并取得有效电子票后才可创建参会名片',
        HttpStatus.CONFLICT,
      );
    }
    const qualifiedAt = row.successfulPaymentAt ?? row.order.updatedAt ?? row.order.createdAt;
    const [position] = await this.db()
      .select({ value: count(registrations.id) })
      .from(registrations)
      .innerJoin(orders, eq(orders.registrationId, registrations.id))
      .innerJoin(tickets, eq(tickets.registrationId, registrations.id))
      .where(
        and(
          eq(registrations.eventId, row.registration.eventId),
          isNull(registrations.supersededAt),
          inArray(registrations.status, [...PUBLIC_REGISTRATION_STATUSES]),
          inArray(orders.status, [...PUBLIC_ORDER_STATUSES]),
          inArray(tickets.status, [...PUBLIC_TICKET_STATUSES]),
          sql`(${orders.amount} = 0 or exists (
            select 1 from ${payments} attendee_sequence_payment
            where attendee_sequence_payment.order_id = ${orders.id}
              and attendee_sequence_payment.status = 'succeeded'
          ))`,
          sql`(
            coalesce(
              (select min(attendee_sequence_paid.succeeded_at)
                from ${payments} attendee_sequence_paid
                where attendee_sequence_paid.order_id = ${orders.id}
                  and attendee_sequence_paid.status = 'succeeded'),
              ${orders.updatedAt},
              ${orders.createdAt}
            ),
            ${registrations.id}
          ) <= (${qualifiedAt}, ${row.registration.id})`,
        ),
      );
    const publicSlug = randomBytes(12).toString('base64url');
    const [created] = await this.db()
      .insert(attendeeShowcaseProfiles)
      .values({
        organizationId: session.organizationId,
        eventId: row.event.id,
        registrationId,
        customerUserId: session.customerUserId,
        publicSlug,
        qualifiedAt,
        sequence: Math.max(1, Number(position?.value ?? 1)),
        displayName:
          row.registration.attendee.name ||
          row.commonProfile?.realName ||
          row.commonProfile?.nickname ||
          null,
        company: row.registration.attendee.company || row.commonProfile?.company || null,
        title: row.registration.attendee.title || row.commonProfile?.title || null,
        contactPhone: row.registration.attendee.mobile || session.customer.mobile || null,
        contactEmail: row.registration.attendee.email || row.commonProfile?.email || null,
        visibleFields: DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
      })
      .onConflictDoNothing({ target: attendeeShowcaseProfiles.registrationId })
      .returning();
    if (created) return { profile: created, created: true };
    return { profile: (await this.ownedRow(session, registrationId)).showcase!, created: false };
  }

  private profileResponse(
    row: Awaited<ReturnType<AttendeeShowcaseService['ownedRow']>>,
  ): AttendeeShowcaseProfile {
    const profile = row.showcase;
    const visibleFields = profile?.visibleFields ?? DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS;
    const displayName = profile?.displayName ?? row.registration.attendee.name ?? null;
    const company = profile?.company ?? row.registration.attendee.company ?? null;
    const title = profile?.title ?? row.registration.attendee.title ?? null;
    const avatarStatus = profile?.avatarAssetId
      ? row.avatar?.status === 'ready'
        ? 'ready'
        : row.avatar?.status === 'failed'
          ? 'failed'
          : 'processing'
      : 'none';
    const status = attendeeShowcaseQualification({
      eventStatus: row.event.status,
      customerStatus: row.customer.status,
      registrationStatus: row.registration.status,
      orderStatus: row.order.status,
      paymentSatisfied: row.order.amount === 0 || Boolean(row.successfulPaymentAt),
      ticketStatus: row.ticket?.status ?? null,
      isPublic: profile?.isPublic ?? false,
      adminHiddenAt: profile?.adminHiddenAt ?? null,
    });
    return AttendeeShowcaseProfileSchema.parse({
      id: profile?.id ?? null,
      registrationId: row.registration.id,
      orderId: row.order.id,
      ticketCode: row.ticket?.code ?? null,
      eventId: row.event.id,
      eventName: row.event.name,
      eventSlug: row.event.slug,
      displayName,
      company,
      title,
      industryCode: profile?.industryCode ?? null,
      businessIntro: profile?.businessIntro ?? null,
      businessUrl: profile?.businessUrl ?? null,
      contactPhone: profile?.contactPhone ?? row.registration.attendee.mobile ?? null,
      contactEmail: profile?.contactEmail ?? row.registration.attendee.email ?? null,
      wechatId: profile?.wechatId ?? null,
      avatarUrl:
        avatarStatus === 'ready'
          ? `/customer/registrations/${row.registration.id}/showcase/avatar`
          : null,
      avatarStatus,
      isPublic: profile?.isPublic ?? false,
      effectivePublic: status.qualified,
      publicSlug: profile?.publicSlug ?? null,
      publicPreviewUrl: profile?.publicSlug
        ? `${(process.env.PUBLIC_WEB_URL ?? '').replace(/\/$/, '')}/members/${encodeURIComponent(profile.publicSlug)}?event=${encodeURIComponent(row.event.slug)}`
        : null,
      visibleFields,
      consentVersion: profile?.consentVersion ?? null,
      consentAt: asIso(profile?.consentAt),
      adminHidden: Boolean(profile?.adminHiddenAt),
      adminHiddenReason: profile?.adminHiddenReason ?? null,
      qualified: status.qualified,
      qualificationReason: status.reason,
      qualifiedAt: asIso(profile?.qualifiedAt),
      sequence: profile?.sequence ?? null,
      completion: completionScore({
        displayName,
        company,
        title,
        industryCode: profile?.industryCode ?? null,
        businessIntro: profile?.businessIntro ?? null,
        businessUrl: profile?.businessUrl ?? null,
        avatarStatus,
      }),
      invoiceAvailable: ['paid', 'partially_refunded'].includes(row.order.status),
      paymentRequired: row.order.amount > 0,
      version: profile?.version ?? 0,
      updatedAt: asIso(profile?.updatedAt),
    });
  }

  async customerShowcase(session: AuthenticatedCustomer, registrationId: string) {
    return this.profileResponse(await this.ownedRow(session, registrationId));
  }

  async updateCustomerShowcase(
    session: AuthenticatedCustomer,
    registrationId: string,
    input: UpdateAttendeeShowcase,
  ) {
    const ensured = await this.ensureProfile(session, registrationId);
    const profile = ensured.profile;
    if (!attendeeShowcaseVersionMatches(input.version, profile.version, ensured.created)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '参会名片已在其他页面更新，请刷新后再保存',
        HttpStatus.CONFLICT,
      );
    }
    const changedFields = [
      'displayName',
      'company',
      'title',
      'industryCode',
      'businessIntro',
      'businessUrl',
      'contactPhone',
      'contactEmail',
      'wechatId',
    ].filter(
      (field) =>
        input[field as keyof UpdateAttendeeShowcase] !== profile[field as keyof typeof profile],
    );
    if (input.isPublic !== profile.isPublic) changedFields.push('isPublic');
    if (JSON.stringify(input.visibleFields) !== JSON.stringify(profile.visibleFields)) {
      changedFields.push('visibleFields');
    }
    const updatedAt = new Date();
    const consent = attendeeShowcaseConsentMetadata({
      nextIsPublic: input.isPublic,
      currentIsPublic: profile.isPublic,
      currentVersion: profile.consentVersion,
      currentConsentAt: profile.consentAt,
      requiredVersion: ATTENDEE_SHOWCASE_CONSENT_VERSION,
      now: updatedAt,
    });
    await this.db().transaction(async (tx) => {
      const [updated] = await tx
        .update(attendeeShowcaseProfiles)
        .set({
          displayName: input.displayName,
          company: input.company,
          title: input.title,
          industryCode: input.industryCode,
          businessIntro: input.businessIntro,
          businessUrl: input.businessUrl,
          contactPhone: input.contactPhone,
          contactEmail: input.contactEmail,
          wechatId: input.wechatId,
          isPublic: input.isPublic,
          visibleFields: input.visibleFields,
          consentVersion: consent.consentVersion,
          consentAt: consent.consentAt,
          version: sql`${attendeeShowcaseProfiles.version} + 1`,
          updatedAt,
        })
        .where(
          and(
            eq(attendeeShowcaseProfiles.id, profile.id),
            eq(attendeeShowcaseProfiles.version, profile.version),
          ),
        )
        .returning({ id: attendeeShowcaseProfiles.id });
      if (!updated) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '参会名片已在其他页面更新，请刷新后再保存',
          HttpStatus.CONFLICT,
        );
      }
      await tx.insert(auditLogs).values({
        organizationId: session.organizationId,
        eventId: profile.eventId,
        actorId: session.customerUserId,
        actorType: 'customer',
        action: 'attendee_showcase.update',
        resourceType: 'attendee_showcase',
        resourceId: profile.id,
        before: { isPublic: profile.isPublic, visibleFields: profile.visibleFields },
        after: { isPublic: input.isPublic, visibleFields: input.visibleFields, changedFields },
        traceId: randomUUID(),
      });
    });
    return this.customerShowcase(session, registrationId);
  }

  async prepareAvatarUpload(
    session: AuthenticatedCustomer,
    registrationId: string,
    input: AttendeeAvatarUpload,
  ): Promise<AttendeeAvatarUploadResult> {
    await this.ensureProfile(session, registrationId);
    const uploadToken = randomUUID();
    const storageKey = `customers/${session.organizationId}/${session.customerUserId}/avatars/${uploadToken}/original`;
    const uploadUrl = this.s3Presigned(storageKey, 'PUT', input.mediaType, undefined, input.size);
    if (!uploadUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法上传头像',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${session.organizationId}), hashtext(${session.customerUserId}))`,
      );
      const [recentUploads] = await tx
        .select({ value: count(customerMediaAssets.id) })
        .from(customerMediaAssets)
        .where(
          and(
            eq(customerMediaAssets.organizationId, session.organizationId),
            eq(customerMediaAssets.customerUserId, session.customerUserId),
            gte(customerMediaAssets.createdAt, new Date(Date.now() - 60 * 60_000)),
          ),
        );
      if (Number(recentUploads?.value ?? 0) >= 10) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '头像上传过于频繁，请一小时后再试',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await tx.insert(customerMediaAssets).values({
        id: uploadToken,
        organizationId: session.organizationId,
        customerUserId: session.customerUserId,
        sourceStorageKey: storageKey,
        mediaType: input.mediaType,
        size: input.size,
        contentDigest: input.contentDigest.toLowerCase(),
        status: 'processing',
      });
    });
    return {
      uploadToken,
      uploadUrl,
      headers: {
        'Content-Type': input.mediaType,
        'Content-Length': String(input.size),
        'If-None-Match': '*',
      },
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }

  async confirmAvatar(
    session: AuthenticatedCustomer,
    registrationId: string,
    input: AttendeeAvatarConfirm,
  ) {
    const { profile } = await this.ensureProfile(session, registrationId);
    const [asset] = await this.db()
      .select()
      .from(customerMediaAssets)
      .where(
        and(
          eq(customerMediaAssets.id, input.uploadToken),
          eq(customerMediaAssets.organizationId, session.organizationId),
          eq(customerMediaAssets.customerUserId, session.customerUserId),
        ),
      )
      .limit(1);
    if (!asset || asset.contentDigest !== input.contentDigest.toLowerCase()) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '头像上传登记信息不一致',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (asset.status === 'failed') {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '头像文件已经失效，请重新上传',
        HttpStatus.CONFLICT,
      );
    }
    const [existingBinding] = await this.db()
      .select({ registrationId: attendeeShowcaseProfiles.registrationId })
      .from(attendeeShowcaseProfiles)
      .where(eq(attendeeShowcaseProfiles.avatarAssetId, asset.id))
      .limit(1);
    if (existingBinding && existingBinding.registrationId !== registrationId) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '该头像上传记录已经使用，请重新上传',
        HttpStatus.CONFLICT,
      );
    }
    const [existingRequest] = await this.db()
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, session.organizationId),
          eq(outboxEvents.eventType, 'CustomerAvatarProcessingRequested'),
          eq(outboxEvents.correlationId, `customer-avatar:${asset.id}`),
        ),
      )
      .limit(1);
    if (
      profile.avatarAssetId === asset.id &&
      (asset.confirmedAt || existingRequest || asset.status === 'ready')
    ) {
      return this.customerShowcase(session, registrationId);
    }
    if (asset.confirmedAt || existingRequest || asset.status === 'ready') {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '该头像上传记录已经确认，请重新上传',
        HttpStatus.CONFLICT,
      );
    }
    if (asset.sourceDeletedAt || asset.createdAt.getTime() < Date.now() - 10 * 60_000) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '头像上传确认已过期，请重新上传',
        HttpStatus.CONFLICT,
      );
    }
    const internalUrl = this.s3Presigned(
      asset.sourceStorageKey,
      'GET',
      undefined,
      process.env.S3_ENDPOINT,
    );
    if (!internalUrl) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '对象存储尚未配置，暂时无法校验头像',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    let response: Response;
    try {
      response = await fetch(internalUrl, { signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '头像暂时无法读取，请重新上传',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!response.ok) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '头像尚未上传成功',
        HttpStatus.BAD_REQUEST,
      );
    }
    let file: Buffer;
    try {
      file = await readUploadWithinLimit(response, asset.size);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '头像文件大小与登记信息不一致',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const digest = createHash('sha256').update(file).digest('hex');
    if (digest !== asset.contentDigest || !matchesDeclaredMediaType(file, asset.mediaType)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '头像文件内容校验失败',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.db().transaction(async (tx) => {
      const [lockedAsset] = await tx
        .select({
          confirmedAt: customerMediaAssets.confirmedAt,
          sourceDeletedAt: customerMediaAssets.sourceDeletedAt,
          status: customerMediaAssets.status,
        })
        .from(customerMediaAssets)
        .where(eq(customerMediaAssets.id, asset.id))
        .for('update')
        .limit(1);
      if (
        !lockedAsset ||
        lockedAsset.confirmedAt ||
        lockedAsset.sourceDeletedAt ||
        lockedAsset.status !== 'processing'
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该头像上传记录已经确认或失效，请重新上传',
          HttpStatus.CONFLICT,
        );
      }
      const [concurrentBinding] = await tx
        .select({ registrationId: attendeeShowcaseProfiles.registrationId })
        .from(attendeeShowcaseProfiles)
        .where(eq(attendeeShowcaseProfiles.avatarAssetId, asset.id))
        .limit(1);
      if (concurrentBinding && concurrentBinding.registrationId !== registrationId) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该头像上传记录已经使用，请重新上传',
          HttpStatus.CONFLICT,
        );
      }
      const [updated] = await tx
        .update(attendeeShowcaseProfiles)
        .set({
          avatarAssetId: asset.id,
          version: sql`${attendeeShowcaseProfiles.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(attendeeShowcaseProfiles.id, profile.id),
            eq(attendeeShowcaseProfiles.version, profile.version),
          ),
        )
        .returning({ id: attendeeShowcaseProfiles.id });
      if (!updated) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '头像设置已在其他页面更新，请刷新后重试',
          HttpStatus.CONFLICT,
        );
      }
      if (profile.avatarAssetId && profile.avatarAssetId !== asset.id) {
        const [replacedAsset] = await tx
          .select()
          .from(customerMediaAssets)
          .where(eq(customerMediaAssets.id, profile.avatarAssetId))
          .for('update')
          .limit(1);
        if (replacedAsset) {
          await tx
            .update(customerMediaAssets)
            .set({
              status: 'failed',
              failureReason: '头像已被替换，等待清理',
              updatedAt: new Date(),
            })
            .where(eq(customerMediaAssets.id, replacedAsset.id));
          await tx.insert(outboxEvents).values({
            organizationId: session.organizationId,
            eventId: profile.eventId,
            eventType: 'CustomerAvatarDeletionRequested',
            correlationId: `customer-avatar:delete:${replacedAsset.id}:${randomUUID()}`,
            payload: avatarDeletionPayload(replacedAsset),
          });
        }
      }
      await tx
        .update(customerMediaAssets)
        .set({ confirmedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(customerMediaAssets.id, asset.id),
            isNull(customerMediaAssets.confirmedAt),
            isNull(customerMediaAssets.sourceDeletedAt),
          ),
        );
      await tx.insert(outboxEvents).values({
        organizationId: session.organizationId,
        eventId: profile.eventId,
        eventType: 'CustomerAvatarProcessingRequested',
        correlationId: `customer-avatar:${asset.id}`,
        payload: { assetId: asset.id },
      });
    });
    return this.customerShowcase(session, registrationId);
  }

  async removeAvatar(session: AuthenticatedCustomer, registrationId: string) {
    const { profile } = await this.ensureProfile(session, registrationId);
    await this.db().transaction(async (tx) => {
      const [updated] = await tx
        .update(attendeeShowcaseProfiles)
        .set({
          avatarAssetId: null,
          version: sql`${attendeeShowcaseProfiles.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(attendeeShowcaseProfiles.id, profile.id),
            eq(attendeeShowcaseProfiles.version, profile.version),
          ),
        )
        .returning({ id: attendeeShowcaseProfiles.id });
      if (!updated) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '头像设置已在其他页面更新，请刷新后重试',
          HttpStatus.CONFLICT,
        );
      }
      if (!profile.avatarAssetId) return;
      const [removedAsset] = await tx
        .select()
        .from(customerMediaAssets)
        .where(eq(customerMediaAssets.id, profile.avatarAssetId))
        .for('update')
        .limit(1);
      if (!removedAsset) return;
      await tx
        .update(customerMediaAssets)
        .set({
          status: 'failed',
          failureReason: '头像已被用户移除，等待清理',
          updatedAt: new Date(),
        })
        .where(eq(customerMediaAssets.id, removedAsset.id));
      await tx.insert(outboxEvents).values({
        organizationId: session.organizationId,
        eventId: profile.eventId,
        eventType: 'CustomerAvatarDeletionRequested',
        correlationId: `customer-avatar:delete:${removedAsset.id}:${randomUUID()}`,
        payload: avatarDeletionPayload(removedAsset),
      });
    });
    return this.customerShowcase(session, registrationId);
  }

  async customerAvatarContent(session: AuthenticatedCustomer, registrationId: string) {
    const row = await this.ownedRow(session, registrationId);
    if (!row.avatar?.outputStorageKey || row.avatar.status !== 'ready') {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '头像不存在', HttpStatus.NOT_FOUND);
    }
    return this.avatarContent(row.avatar.outputStorageKey);
  }

  private async publicEvent(eventSlug: string, organizationSlug: string) {
    return this.conference.getPublicEventScope(eventSlug, organizationSlug);
  }

  async publicMembers(
    eventSlug: string,
    organizationSlug: string,
    query: PublicEventMemberListQuery,
  ): Promise<PublicEventMemberList> {
    const event = await this.publicEvent(eventSlug, organizationSlug);
    const baseCondition = and(
      eq(attendeeShowcaseProfiles.eventId, event.id),
      attendeeShowcasePublicEligibilitySql({ eventAlreadyValidated: true }),
    )!;
    const visibleIndustryCondition = sql`coalesce((${attendeeShowcaseProfiles.visibleFields}->>'industry')::boolean, false) = true`;
    const [overall, industries] = await Promise.all([
      this.db()
        .select({ value: count(attendeeShowcaseProfiles.id) })
        .from(attendeeShowcaseProfiles)
        .innerJoin(registrations, eq(registrations.id, attendeeShowcaseProfiles.registrationId))
        .innerJoin(orders, eq(orders.registrationId, registrations.id))
        .innerJoin(tickets, eq(tickets.registrationId, registrations.id))
        .innerJoin(customerUsers, eq(customerUsers.id, attendeeShowcaseProfiles.customerUserId))
        .where(baseCondition),
      this.db()
        .select({
          code: attendeeShowcaseProfiles.industryCode,
          value: count(attendeeShowcaseProfiles.id),
        })
        .from(attendeeShowcaseProfiles)
        .innerJoin(registrations, eq(registrations.id, attendeeShowcaseProfiles.registrationId))
        .innerJoin(orders, eq(orders.registrationId, registrations.id))
        .innerJoin(tickets, eq(tickets.registrationId, registrations.id))
        .innerJoin(customerUsers, eq(customerUsers.id, attendeeShowcaseProfiles.customerUserId))
        .where(
          and(
            baseCondition,
            visibleIndustryCondition,
            sql`${attendeeShowcaseProfiles.industryCode} is not null`,
          ),
        )
        .groupBy(attendeeShowcaseProfiles.industryCode),
    ]);
    const totalAll = Number(overall[0]?.value ?? 0);
    const categoryMode = totalAll >= 101;
    const selectedIndustry = categoryMode ? query.industry : undefined;
    const listCondition = selectedIndustry
      ? and(
          baseCondition,
          visibleIndustryCondition,
          eq(attendeeShowcaseProfiles.industryCode, selectedIndustry),
        )!
      : baseCondition;
    const [selectedRows, rows] = await Promise.all([
      this.db()
        .select({ value: count(attendeeShowcaseProfiles.id) })
        .from(attendeeShowcaseProfiles)
        .innerJoin(registrations, eq(registrations.id, attendeeShowcaseProfiles.registrationId))
        .innerJoin(orders, eq(orders.registrationId, registrations.id))
        .innerJoin(tickets, eq(tickets.registrationId, registrations.id))
        .innerJoin(customerUsers, eq(customerUsers.id, attendeeShowcaseProfiles.customerUserId))
        .where(listCondition)
        .then((value) => value),
      this.db()
        .select({ profile: attendeeShowcaseProfiles, avatar: customerMediaAssets })
        .from(attendeeShowcaseProfiles)
        .innerJoin(registrations, eq(registrations.id, attendeeShowcaseProfiles.registrationId))
        .innerJoin(orders, eq(orders.registrationId, registrations.id))
        .innerJoin(tickets, eq(tickets.registrationId, registrations.id))
        .innerJoin(customerUsers, eq(customerUsers.id, attendeeShowcaseProfiles.customerUserId))
        .leftJoin(
          customerMediaAssets,
          eq(customerMediaAssets.id, attendeeShowcaseProfiles.avatarAssetId),
        )
        .where(listCondition)
        .orderBy(
          asc(attendeeShowcaseProfiles.qualifiedAt),
          asc(attendeeShowcaseProfiles.registrationId),
        )
        .limit(PAGE_SIZE)
        .offset((query.page - 1) * PAGE_SIZE),
    ]);
    const total = Number(selectedRows[0]?.value ?? 0);
    return PublicEventMemberListSchema.parse({
      items: rows.map(({ profile, avatar }) => {
        const visible = profile.visibleFields;
        const displayName = visible.displayName ? profile.displayName : null;
        return {
          publicSlug: profile.publicSlug,
          sequence: profile.sequence,
          ...(displayName
            ? { displayName, initials: attendeeAvatarInitial(displayName) ?? undefined }
            : {}),
          ...(visible.company && profile.company ? { company: profile.company } : {}),
          ...(visible.title && profile.title ? { title: profile.title } : {}),
          ...(visible.industry && profile.industryCode
            ? {
                industryCode: profile.industryCode,
                industryLabel: industryLabels.get(profile.industryCode) ?? profile.industryCode,
              }
            : {}),
          ...(visible.avatar && avatar?.status === 'ready'
            ? {
                avatarUrl: `/events/${event.slug}/members/${profile.publicSlug}/avatar?organization=${encodeURIComponent(organizationSlug)}`,
              }
            : {}),
        };
      }),
      total,
      overallTotal: totalAll,
      page: query.page,
      pageSize: PAGE_SIZE,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      categoryMode,
      industries: industries
        .filter((item): item is typeof item & { code: NonNullable<typeof item.code> } =>
          Boolean(item.code),
        )
        .map((item) => ({
          code: item.code,
          label: industryLabels.get(item.code) ?? item.code,
          count: Number(item.value),
        }))
        .sort(
          (a, b) =>
            (industryOrder.get(a.code) ?? Number.MAX_SAFE_INTEGER) -
            (industryOrder.get(b.code) ?? Number.MAX_SAFE_INTEGER),
        ),
    });
  }

  private async publicRow(eventSlug: string, organizationSlug: string, publicSlug: string) {
    const event = await this.publicEvent(eventSlug, organizationSlug);
    const [row] = await this.db()
      .select({ profile: attendeeShowcaseProfiles, avatar: customerMediaAssets })
      .from(attendeeShowcaseProfiles)
      .innerJoin(registrations, eq(registrations.id, attendeeShowcaseProfiles.registrationId))
      .innerJoin(orders, eq(orders.registrationId, registrations.id))
      .innerJoin(tickets, eq(tickets.registrationId, registrations.id))
      .innerJoin(customerUsers, eq(customerUsers.id, attendeeShowcaseProfiles.customerUserId))
      .leftJoin(
        customerMediaAssets,
        eq(customerMediaAssets.id, attendeeShowcaseProfiles.avatarAssetId),
      )
      .where(
        and(
          eq(attendeeShowcaseProfiles.eventId, event.id),
          eq(attendeeShowcaseProfiles.publicSlug, publicSlug),
          attendeeShowcasePublicEligibilitySql({ eventAlreadyValidated: true }),
        ),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '参会名片不存在或已停止公开',
        HttpStatus.NOT_FOUND,
      );
    }
    return { event, ...row };
  }

  async publicMember(
    eventSlug: string,
    organizationSlug: string,
    publicSlug: string,
  ): Promise<PublicEventMemberDetail> {
    const { event, profile, avatar } = await this.publicRow(
      eventSlug,
      organizationSlug,
      publicSlug,
    );
    const visible = profile.visibleFields;
    const displayName = visible.displayName ? profile.displayName : null;
    return PublicEventMemberDetailSchema.parse({
      publicSlug: profile.publicSlug,
      sequence: profile.sequence,
      eventName: event.name,
      eventSlug: event.slug,
      ...(displayName
        ? { displayName, initials: attendeeAvatarInitial(displayName) ?? undefined }
        : {}),
      ...(visible.company && profile.company ? { company: profile.company } : {}),
      ...(visible.title && profile.title ? { title: profile.title } : {}),
      ...(visible.industry && profile.industryCode
        ? {
            industryCode: profile.industryCode,
            industryLabel: industryLabels.get(profile.industryCode) ?? profile.industryCode,
          }
        : {}),
      ...(visible.avatar && avatar?.status === 'ready'
        ? {
            avatarUrl: `/events/${event.slug}/members/${profile.publicSlug}/avatar?organization=${encodeURIComponent(organizationSlug)}`,
          }
        : {}),
      ...(visible.businessIntro && profile.businessIntro
        ? { businessIntro: profile.businessIntro }
        : {}),
      ...(visible.businessUrl && profile.businessUrl ? { businessUrl: profile.businessUrl } : {}),
      ...(visible.contactPhone && profile.contactPhone
        ? { contactPhone: profile.contactPhone }
        : {}),
      ...(visible.contactEmail && profile.contactEmail
        ? { contactEmail: profile.contactEmail }
        : {}),
      ...(visible.wechatId && profile.wechatId ? { wechatId: profile.wechatId } : {}),
    });
  }

  async publicAvatarContent(eventSlug: string, organizationSlug: string, publicSlug: string) {
    const row = await this.publicRow(eventSlug, organizationSlug, publicSlug);
    if (
      !row.profile.visibleFields.avatar ||
      row.avatar?.status !== 'ready' ||
      !row.avatar.outputStorageKey
    ) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '头像不存在', HttpStatus.NOT_FOUND);
    }
    return this.avatarContent(row.avatar.outputStorageKey);
  }

  async adminShowcases(
    organizationId: string,
    publicCustomerId: number,
  ): Promise<AdminAttendeeShowcase[]> {
    const [identity] = await this.db()
      .select({ customerUserId: publicUserIds.subjectUuid })
      .from(publicUserIds)
      .innerJoin(customerUsers, eq(customerUsers.id, publicUserIds.subjectUuid))
      .where(
        and(
          eq(publicUserIds.publicId, publicCustomerId),
          eq(publicUserIds.subjectType, 'customer'),
          eq(customerUsers.organizationId, organizationId),
          isNull(publicUserIds.retiredAt),
        ),
      )
      .limit(1);
    if (!identity) return [];
    const rows = await this.db()
      .select({
        registration: registrations,
        event: events,
        order: orders,
        ticket: tickets,
        customer: customerUsers,
        commonProfile: customerProfiles,
        showcase: attendeeShowcaseProfiles,
        avatar: customerMediaAssets,
        successfulPaymentAt: min(payments.succeededAt),
      })
      .from(attendeeShowcaseProfiles)
      .innerJoin(registrations, eq(registrations.id, attendeeShowcaseProfiles.registrationId))
      .innerJoin(events, eq(events.id, attendeeShowcaseProfiles.eventId))
      .innerJoin(orders, eq(orders.registrationId, registrations.id))
      .innerJoin(customerUsers, eq(customerUsers.id, attendeeShowcaseProfiles.customerUserId))
      .leftJoin(tickets, eq(tickets.registrationId, registrations.id))
      .leftJoin(customerProfiles, eq(customerProfiles.customerUserId, customerUsers.id))
      .leftJoin(
        customerMediaAssets,
        eq(customerMediaAssets.id, attendeeShowcaseProfiles.avatarAssetId),
      )
      .leftJoin(payments, and(eq(payments.orderId, orders.id), eq(payments.status, 'succeeded')))
      .where(
        and(
          eq(attendeeShowcaseProfiles.organizationId, organizationId),
          eq(attendeeShowcaseProfiles.customerUserId, identity.customerUserId),
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
        attendeeShowcaseProfiles.id,
        customerMediaAssets.id,
      )
      .orderBy(asc(registrations.createdAt));
    const profiles = rows.map((row) => this.profileResponse(row));
    return profiles
      .filter((item) => item.id)
      .map((item) => ({
        ...item,
        customerUserId: publicCustomerId,
        moderationUpdatedAt: item.adminHidden ? item.updatedAt : null,
      }));
  }

  async adminCounts(organizationId: string, customerUserIds: string[]) {
    if (customerUserIds.length === 0) return new Map<string, { total: number; public: number }>();
    const rows = await this.db()
      .select({
        customerUserId: attendeeShowcaseProfiles.customerUserId,
        total: count(attendeeShowcaseProfiles.id),
        public: sql<number>`count(*) filter (where ${attendeeShowcaseProfiles.isPublic} = true and ${attendeeShowcaseProfiles.adminHiddenAt} is null)::int`,
      })
      .from(attendeeShowcaseProfiles)
      .where(
        and(
          eq(attendeeShowcaseProfiles.organizationId, organizationId),
          inArray(attendeeShowcaseProfiles.customerUserId, customerUserIds),
        ),
      )
      .groupBy(attendeeShowcaseProfiles.customerUserId);
    return new Map(
      rows.map((row) => [
        row.customerUserId,
        { total: Number(row.total), public: Number(row.public) },
      ]),
    );
  }

  async moderate(
    organizationId: string,
    actorId: string,
    eventId: number,
    showcaseId: string,
    input: ModerateAttendeeShowcase,
  ) {
    const [profile] = await this.db()
      .select()
      .from(attendeeShowcaseProfiles)
      .where(
        and(
          eq(attendeeShowcaseProfiles.id, showcaseId),
          eq(attendeeShowcaseProfiles.organizationId, organizationId),
          eq(attendeeShowcaseProfiles.eventId, eventId),
        ),
      )
      .limit(1);
    if (!profile) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '参会名片不存在', HttpStatus.NOT_FOUND);
    }
    if (input.hidden && !input.reason?.trim()) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '下架参会名片时需要填写原因',
        HttpStatus.BAD_REQUEST,
      );
    }
    const now = new Date();
    await this.db().transaction(async (tx) => {
      await tx
        .update(attendeeShowcaseProfiles)
        .set({
          adminHiddenAt: input.hidden ? now : null,
          adminHiddenReason: input.hidden ? (input.reason?.trim() ?? null) : null,
          version: sql`${attendeeShowcaseProfiles.version} + 1`,
          updatedAt: now,
        })
        .where(eq(attendeeShowcaseProfiles.id, profile.id));
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: input.hidden ? 'attendee_showcase.hide' : 'attendee_showcase.restore',
        resourceType: 'attendee_showcase',
        resourceId: profile.id,
        before: { adminHidden: Boolean(profile.adminHiddenAt) },
        after: { adminHidden: input.hidden, reason: input.hidden ? input.reason : null },
        traceId: randomUUID(),
      });
    });
    return { updated: true };
  }
}
