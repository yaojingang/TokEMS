import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type {
  AdminSpeakerDetail,
  AdminSpeakerSummary,
  ConferenceTemplateDefinition,
  CreateSpeaker,
  CreateEvent,
  EventBlueprint,
  EventContextOption,
  EventId,
  EventRelease,
  EventSlugAvailability,
  EventSlugUpdateResult,
  EventSummary,
  OrganizationMember,
  RegistrationField,
  RegistrationForm,
  TemplatePackage,
  UpdateSpeaker,
  UpdateEventSlug,
  UpdateOrganizationMember,
} from '@conference/contracts';
import {
  API_ERROR_CODES,
  DEMO_IDS,
  normalizeConferenceTemplateDefinition,
  speakerAvatarText,
} from '@conference/contracts';
import {
  auditLogs,
  checkinLists,
  conferenceTemplates,
  conferenceTemplateVersions,
  eventBlueprints,
  eventReleases,
  eventSlugAliases,
  eventTemplateBindings,
  eventTemplateOverrides,
  events,
  inventoryReservations,
  memberProfiles,
  memberships,
  organizationHomepageEvents,
  organizations,
  outboxEvents,
  publicUserIds,
  registrationForms,
  registrations,
  sessions,
  speakerPublicRoutes,
  speakers,
  templateAssets,
  templatePackages,
  ticketTypes,
  users,
  waitlistEntries,
} from '@conference/database';
import { and, asc, count, desc, eq, gt, isNull, max, sql, sum } from 'drizzle-orm';
import { customAlphabet, nanoid } from 'nanoid';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import {
  EventReleaseActivationService,
  type EventMutationTransaction,
} from './event-release-activation.service.js';
import { requirePublicUserId } from './public-user-id.js';
import { mergeTemplateDefinition } from './template-definition.js';

type Database = NonNullable<DatabaseService['db']>;

const generateEventShortSlug = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6);
const generateSpeakerPublicCode = customAlphabet('abcdefghijklmnopqrstuvwxyz', 4);

function speakerAssetPath(assetId: string) {
  return `/assets/templates/${encodeURIComponent(assetId)}`;
}

function isConfiguredSuperAdministrator(
  user: { id: string },
  member: { role: string; grants: string[]; status: 'active' | 'disabled' },
) {
  return (
    user.id === (process.env.ADMIN_USER_ID ?? DEMO_IDS.adminUser).trim() &&
    member.status === 'active' &&
    member.role === 'organization_admin' &&
    member.grants.includes('*')
  );
}

interface BlueprintSnapshot {
  event?: { tagline?: string; description?: string; timezone?: string; locale?: string };
  templateKey?: string;
  ticketTypes?: Array<{
    code: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    capacity: number;
    recommended?: boolean;
    benefits?: string[];
  }>;
  registrationForm?: {
    name: string;
    fields: RegistrationField[];
    termsVersion: string;
    termsContent: string;
  };
}

function templateTicketValues(definition: ConferenceTemplateDefinition): Array<{
  code: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  capacity: number;
  recommended?: boolean;
  benefits?: string[];
}> {
  return definition.initialization.ticketTypes.flatMap((item, index) => {
    const code = typeof item.code === 'string' ? item.code : `TICKET_${index + 1}`;
    const name = typeof item.name === 'string' ? item.name : '';
    const description = typeof item.description === 'string' ? item.description : '';
    const price = typeof item.price === 'number' ? item.price : 0;
    const currency = typeof item.currency === 'string' ? item.currency : 'CNY';
    const capacity = typeof item.capacity === 'number' ? item.capacity : 100;
    if (!name || !description || capacity < 1) return [];
    return [
      {
        code,
        name,
        description,
        price,
        currency,
        capacity,
        recommended: item.recommended === true,
        benefits: Array.isArray(item.benefits)
          ? item.benefits.filter((value): value is string => typeof value === 'string')
          : [],
      },
    ];
  });
}

function normalizeFields(fields: RegistrationField[]) {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.options ? { options: field.options } : {}),
  }));
}

@Injectable()
export class EventOperationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(EventReleaseActivationService)
    private readonly releaseActivation?: EventReleaseActivationService,
  ) {}

  private db(): Database {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '此运营能力需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private releases() {
    return this.releaseActivation ?? new EventReleaseActivationService(this.database);
  }

  private async scopedEvent(organizationId: string, eventId: EventId) {
    const [event] = await this.db()
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!event) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '大会不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    return event;
  }

  private async assertSpeakerAsset(
    tx: EventMutationTransaction,
    organizationId: string,
    assetId: string | null | undefined,
  ) {
    if (!assetId) return;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`template-assets:${organizationId}`}, 0))`,
    );
    const [asset] = await tx
      .select({ id: templateAssets.id, mediaType: templateAssets.mediaType })
      .from(templateAssets)
      .where(and(eq(templateAssets.id, assetId), eq(templateAssets.organizationId, organizationId)))
      .limit(1);
    if (!asset || !['image/jpeg', 'image/png', 'image/webp'].includes(asset.mediaType)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '嘉宾头像不存在或不属于当前组织',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private adminSpeaker(row: typeof speakers.$inferSelect, publicCode: string): AdminSpeakerSummary {
    const avatarUrl = row.avatarAssetId ? speakerAssetPath(row.avatarAssetId) : undefined;
    return {
      id: row.id,
      publicCode,
      name: row.name,
      role: row.role,
      topic: row.topic,
      initials: row.initials,
      accentFrom: row.accentFrom,
      accentTo: row.accentTo,
      tags: row.tags,
      ...(avatarUrl ? { avatarUrl } : {}),
      avatarAssetId: row.avatarAssetId,
      bio: row.bio,
      topicAbstract: row.topicAbstract,
      websiteUrl: row.websiteUrl,
      socialLinks: row.socialLinks,
      sortOrder: row.sortOrder,
      avatarPreviewUrl: avatarUrl ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private releaseFromRow(
    row: typeof eventReleases.$inferSelect,
    currentReleaseId: string | null,
    createdByName: string | null = null,
  ): EventRelease {
    return {
      id: row.id,
      eventId: row.eventId,
      version: row.version,
      templateKey: row.templateKey,
      templateVersionId: row.templateVersionId,
      status: row.status,
      artifactKey: row.artifactKey,
      changeSummary: row.changeSummary,
      changeScope: row.changeScope as EventRelease['changeScope'],
      activationKind: row.activationKind as EventRelease['activationKind'],
      createdByName,
      publishedAt: row.publishedAt.toISOString(),
      rolledBackAt: row.rolledBackAt?.toISOString() ?? null,
      active: row.id === currentReleaseId,
    };
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    const rows = await this.db()
      .select({
        membership: memberships,
        user: users,
        profile: memberProfiles,
        publicUserId: publicUserIds.publicId,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(
        publicUserIds,
        and(
          eq(publicUserIds.subjectType, 'staff'),
          eq(publicUserIds.subjectUuid, users.id),
          isNull(publicUserIds.retiredAt),
        ),
      )
      .leftJoin(
        memberProfiles,
        and(
          eq(memberProfiles.userId, memberships.userId),
          eq(memberProfiles.organizationId, memberships.organizationId),
        ),
      )
      .where(eq(memberships.organizationId, organizationId))
      .orderBy(asc(users.name));

    return rows.map(({ membership, user, profile, publicUserId }) => ({
      id: membership.id,
      userId: publicUserId,
      email: user.email,
      name: user.name,
      mobile: user.mobile,
      role: membership.role,
      grants: membership.grants,
      status: membership.status,
      isSuperAdministrator: isConfiguredSuperAdministrator(user, membership),
      profile: profile
        ? {
            company: profile.company,
            title: profile.title,
            city: profile.city,
            bio: profile.bio,
            tags: profile.tags,
          }
        : null,
    }));
  }

  async updateMember(
    organizationId: string,
    membershipId: string,
    actorId: string,
    input: UpdateOrganizationMember,
  ): Promise<OrganizationMember> {
    const db = this.db();
    if (input.grants.some((grant) => grant.includes(' ') || grant.startsWith('.'))) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '权限标识格式不正确',
        HttpStatus.BAD_REQUEST,
      );
    }
    const result = await db.transaction(async (tx) => {
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)),
        )
        .for('update')
        .limit(1);
      if (!membership) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '组织成员不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (
        membership.userId === actorId &&
        !input.grants.includes('*') &&
        !input.grants.includes('event.*')
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前账号需要保留 event.* 权限，避免组织后台失去管理员',
          HttpStatus.CONFLICT,
        );
      }
      const [user] = await tx
        .update(users)
        .set({ name: input.name, mobile: input.mobile, updatedAt: new Date() })
        .where(eq(users.id, membership.userId))
        .returning();
      const [updatedMembership] = await tx
        .update(memberships)
        .set({ role: input.role, grants: input.grants, updatedAt: new Date() })
        .where(eq(memberships.id, membership.id))
        .returning();
      const [profile] = await tx
        .insert(memberProfiles)
        .values({
          organizationId,
          userId: membership.userId,
          ...input.profile,
        })
        .onConflictDoUpdate({
          target: [memberProfiles.organizationId, memberProfiles.userId],
          set: { ...input.profile, updatedAt: new Date() },
        })
        .returning();
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'organization.member.update',
        resourceType: 'membership',
        resourceId: membership.id,
        before: { role: membership.role, grants: membership.grants },
        after: { role: updatedMembership!.role, grants: updatedMembership!.grants },
        traceId: crypto.randomUUID(),
      });
      return { user: user!, membership: updatedMembership!, profile: profile! };
    });

    const publicUserId = await requirePublicUserId(this.db(), 'staff', result.user.id);
    return {
      id: result.membership.id,
      userId: publicUserId,
      email: result.user.email,
      name: result.user.name,
      mobile: result.user.mobile,
      role: result.membership.role,
      grants: result.membership.grants,
      status: result.membership.status,
      isSuperAdministrator: isConfiguredSuperAdministrator(result.user, result.membership),
      profile: {
        company: result.profile.company,
        title: result.profile.title,
        city: result.profile.city,
        bio: result.profile.bio,
        tags: result.profile.tags,
      },
    };
  }

  async listEvents(organizationId: string): Promise<EventSummary[]> {
    const [rows, homepage] = await Promise.all([
      this.db()
        .select({ event: events, registrationCount: count(registrations.id) })
        .from(events)
        .leftJoin(registrations, eq(registrations.eventId, events.id))
        .where(eq(events.organizationId, organizationId))
        .groupBy(events.id)
        .orderBy(desc(events.createdAt)),
      this.db()
        .select({ eventId: organizationHomepageEvents.eventId })
        .from(organizationHomepageEvents)
        .where(eq(organizationHomepageEvents.organizationId, organizationId))
        .limit(1),
    ]);

    return Promise.all(
      rows.map(async ({ event, registrationCount }) => {
        const settings = event.settings as { currentReleaseId?: string; templateKey?: string };
        const [binding] = await this.db()
          .select({
            version: conferenceTemplateVersions.version,
            versionId: conferenceTemplateVersions.id,
            templateName: conferenceTemplates.name,
            currentPublishedVersionId: conferenceTemplates.currentPublishedVersionId,
          })
          .from(eventTemplateBindings)
          .innerJoin(
            conferenceTemplateVersions,
            eq(conferenceTemplateVersions.id, eventTemplateBindings.templateVersionId),
          )
          .innerJoin(
            conferenceTemplates,
            eq(conferenceTemplates.id, conferenceTemplateVersions.templateId),
          )
          .where(eq(eventTemplateBindings.eventId, event.id))
          .limit(1);
        return {
          id: event.id,
          slug: event.slug,
          name: event.name,
          shortName: event.shortName,
          status: event.status,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
          city: event.city,
          registrationCount: Number(registrationCount),
          currentReleaseId: settings.currentReleaseId ?? null,
          templateKey: settings.templateKey ?? null,
          templateName: binding?.templateName ?? null,
          templateVersion: binding?.version ?? null,
          templateUpgradeAvailable:
            Boolean(binding?.currentPublishedVersionId) &&
            binding?.versionId !== binding?.currentPublishedVersionId,
          isHomepageDefault: homepage[0]?.eventId === event.id,
        };
      }),
    );
  }

  async listEventOptions(organizationId: string): Promise<EventContextOption[]> {
    const rows = await this.db()
      .select({ event: events, registrationCount: count(registrations.id) })
      .from(events)
      .leftJoin(registrations, eq(registrations.eventId, events.id))
      .where(eq(events.organizationId, organizationId))
      .groupBy(events.id)
      .orderBy(desc(events.createdAt));

    return rows.map(({ event, registrationCount }) => ({
      id: event.id,
      slug: event.slug,
      name: event.name,
      shortName: event.shortName,
      status: event.status,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      city: event.city,
      registrationCount: Number(registrationCount),
    }));
  }

  async eventSlugAvailability(
    organizationId: string,
    slug: string,
    eventId?: EventId,
  ): Promise<EventSlugAvailability> {
    const [currentRows, aliasRows] = await Promise.all([
      this.db()
        .select({ eventId: events.id })
        .from(events)
        .where(and(eq(events.organizationId, organizationId), eq(events.slug, slug)))
        .limit(1),
      this.db()
        .select({ eventId: eventSlugAliases.eventId })
        .from(eventSlugAliases)
        .where(
          and(eq(eventSlugAliases.organizationId, organizationId), eq(eventSlugAliases.slug, slug)),
        )
        .limit(1),
    ]);
    const currentOwner = currentRows[0]?.eventId;
    const aliasOwner = aliasRows[0]?.eventId;
    return {
      slug,
      available:
        (!currentOwner || currentOwner === eventId) && (!aliasOwner || aliasOwner === eventId),
      current: currentOwner === eventId,
    };
  }

  async updateEventSlug(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: UpdateEventSlug,
  ): Promise<EventSlugUpdateResult> {
    return this.db().transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('update')
        .limit(1);
      if (!organization) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '组织不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const [event] = await tx
        .select({ id: events.id, slug: events.slug })
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
        .for('update')
        .limit(1);
      if (!event) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (event.slug === input.slug) {
        return {
          eventId,
          slug: input.slug,
          previousSlug: event.slug,
          updatedAt: new Date().toISOString(),
        };
      }

      const [currentOwner] = await tx
        .select({ eventId: events.id })
        .from(events)
        .where(and(eq(events.organizationId, organizationId), eq(events.slug, input.slug)))
        .limit(1);
      const [aliasOwner] = await tx
        .select({ eventId: eventSlugAliases.eventId })
        .from(eventSlugAliases)
        .where(
          and(
            eq(eventSlugAliases.organizationId, organizationId),
            eq(eventSlugAliases.slug, input.slug),
          ),
        )
        .limit(1);
      if (currentOwner || (aliasOwner && aliasOwner.eventId !== eventId)) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '当前组织已存在相同短地址，请更换后重试',
          HttpStatus.CONFLICT,
        );
      }

      if (aliasOwner?.eventId === eventId) {
        await tx
          .delete(eventSlugAliases)
          .where(
            and(
              eq(eventSlugAliases.organizationId, organizationId),
              eq(eventSlugAliases.slug, input.slug),
            ),
          );
      }
      await tx
        .insert(eventSlugAliases)
        .values({ organizationId, eventId, slug: event.slug })
        .onConflictDoNothing();
      const now = new Date();
      await tx
        .update(events)
        .set({ slug: input.slug, updatedAt: now })
        .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)));
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: 'event.public_url.update',
        resourceType: 'event',
        resourceId: String(eventId),
        before: { slug: event.slug },
        after: { slug: input.slug },
        traceId: crypto.randomUUID(),
      });
      return {
        eventId,
        slug: input.slug,
        previousSlug: event.slug,
        updatedAt: now.toISOString(),
      };
    });
  }

  async listBlueprints(organizationId: string): Promise<EventBlueprint[]> {
    const rows = await this.db()
      .select()
      .from(eventBlueprints)
      .where(eq(eventBlueprints.organizationId, organizationId))
      .orderBy(desc(eventBlueprints.updatedAt));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      status: row.status,
      snapshot: row.snapshot,
      clonePolicy: row.clonePolicy,
    }));
  }

  async listTemplates(): Promise<TemplatePackage[]> {
    return (
      await this.db().select().from(templatePackages).orderBy(asc(templatePackages.name))
    ).map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      version: row.version,
      status: row.status,
      description: row.description,
      manifest: row.manifest,
    }));
  }

  async createEvent(organizationId: string, actorId: string, input: CreateEvent) {
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '大会结束时间必须晚于开始时间',
        HttpStatus.BAD_REQUEST,
      );
    }

    const db = this.db();
    try {
      return await db.transaction(async (tx) => {
        const [organization] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .for('key share')
          .limit(1);
        if (!organization) {
          throw new DomainError(
            API_ERROR_CODES.NOT_FOUND,
            '组织不存在或无权访问',
            HttpStatus.NOT_FOUND,
          );
        }
        const effectiveTimezone = input.timezone ?? 'Asia/Shanghai';
        const effectiveBlueprintId = input.blueprintId;
        const [selectedTemplate] = await tx
          .select({
            version: conferenceTemplateVersions,
            template: conferenceTemplates,
            renderer: templatePackages,
          })
          .from(conferenceTemplateVersions)
          .innerJoin(
            conferenceTemplates,
            eq(conferenceTemplates.id, conferenceTemplateVersions.templateId),
          )
          .innerJoin(
            templatePackages,
            eq(templatePackages.id, conferenceTemplateVersions.rendererPackageId),
          )
          .where(
            and(
              eq(conferenceTemplateVersions.id, input.templateVersionId),
              eq(conferenceTemplates.organizationId, organizationId),
              eq(conferenceTemplates.status, 'active'),
              eq(templatePackages.status, 'published'),
            ),
          )
          .limit(1);
        if (!selectedTemplate) {
          throw new DomainError(
            API_ERROR_CODES.NOT_FOUND,
            '选择的大会模板版本不存在或不可用',
            HttpStatus.NOT_FOUND,
          );
        }
        const slugAvailable = async (candidate: string) => {
          const [currentRows, aliasRows] = await Promise.all([
            tx
              .select({ eventId: events.id })
              .from(events)
              .where(and(eq(events.organizationId, organizationId), eq(events.slug, candidate)))
              .limit(1),
            tx
              .select({ eventId: eventSlugAliases.eventId })
              .from(eventSlugAliases)
              .where(
                and(
                  eq(eventSlugAliases.organizationId, organizationId),
                  eq(eventSlugAliases.slug, candidate),
                ),
              )
              .limit(1),
          ]);
          return !currentRows[0] && !aliasRows[0];
        };
        let effectiveSlug = input.slug;
        for (let attempt = 0; !effectiveSlug && attempt < 10; attempt += 1) {
          const candidate = `e${generateEventShortSlug()}`;
          if (await slugAvailable(candidate)) effectiveSlug = candidate;
        }
        if (!effectiveSlug) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '暂时无法生成大会短地址，请重试',
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }
        if (!(await slugAvailable(effectiveSlug))) {
          throw new DomainError(
            API_ERROR_CODES.VALIDATION_ERROR,
            '当前组织已存在相同短地址',
            HttpStatus.CONFLICT,
          );
        }

        let blueprint: typeof eventBlueprints.$inferSelect | undefined;
        if (effectiveBlueprintId) {
          [blueprint] = await tx
            .select()
            .from(eventBlueprints)
            .where(
              and(
                eq(eventBlueprints.id, effectiveBlueprintId),
                eq(eventBlueprints.organizationId, organizationId),
              ),
            )
            .limit(1);
          if (!blueprint) {
            throw new DomainError(
              API_ERROR_CODES.NOT_FOUND,
              '大会蓝图不存在',
              HttpStatus.NOT_FOUND,
            );
          }
        }

        const snapshot = (blueprint?.snapshot ?? {}) as BlueprintSnapshot;
        const templateDefinition = normalizeConferenceTemplateDefinition(
          selectedTemplate.version.definition,
        );
        const ticketPolicy = templateDefinition.initialization.copyPolicy.ticketTypes ?? 'COPY';
        const registrationFormPolicy =
          templateDefinition.initialization.copyPolicy.registrationForm ?? 'COPY';
        if (ticketPolicy === 'REFERENCE' || registrationFormPolicy === 'REFERENCE') {
          throw new DomainError(
            API_ERROR_CODES.VALIDATION_ERROR,
            '票种和报名表需要在大会内独立保存，不能使用引用策略',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        const [event] = await tx
          .insert(events)
          .values({
            organizationId,
            slug: effectiveSlug,
            name: input.name,
            shortName: input.shortName,
            tagline: snapshot.event?.tagline ?? `${input.name}，连接行业洞察与增长实践`,
            description: snapshot.event?.description ?? `${input.name} 大会详情与参会信息。`,
            status: 'configuring',
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
            timezone: effectiveTimezone,
            venue: input.venue,
            city: input.city,
            address: input.address,
            settings: {
              locale: snapshot.event?.locale ?? 'zh-CN',
              templateKey: selectedTemplate.renderer.key,
              templateVersionId: selectedTemplate.version.id,
              sourceTemplateId: selectedTemplate.template.id,
              sourceBlueprintId: blueprint?.id,
              registration: {
                paymentMode: 'ticketed',
                currency: 'CNY',
                registrationOpen: true,
                accountMode: 'mobile_otp_required',
                additionalPurchaseEnabled: false,
                maxActiveSeatsPerPurchaser: 5,
              },
              stats: { seats: 0, speakers: 0, days: 1, attendeeSatisfaction: 0 },
              faqs: templateDefinition.faq.items
                .filter((item) => item.enabled)
                .map((item) => ({ question: item.question, answer: item.answer })),
            },
          })
          .returning();

        const eventId = event!.id;
        const initialTickets = templateTicketValues(templateDefinition);
        const ticketSkeleton = initialTickets.length
          ? initialTickets
          : (snapshot.ticketTypes ?? []);
        const effectiveTickets =
          ticketPolicy === 'EXCLUDE'
            ? []
            : ticketPolicy === 'RESET'
              ? ticketSkeleton.map((ticket) => ({ ...ticket, price: 0, capacity: 100 }))
              : ticketSkeleton;
        if (effectiveTickets.length) {
          await tx.insert(ticketTypes).values(
            effectiveTickets.map((ticket) => ({
              organizationId,
              eventId,
              code: ticket.code,
              name: ticket.name,
              description: ticket.description,
              price: ticket.price,
              currency: ticket.currency,
              capacity: ticket.capacity,
              recommended: ticket.recommended ?? false,
              benefits: ticket.benefits ?? [],
            })),
          );
        }

        const blueprintForm = snapshot.registrationForm;
        const templateFields = templateDefinition.initialization.registrationFields;
        const registrationFields =
          registrationFormPolicy === 'EXCLUDE'
            ? []
            : templateFields.length
              ? templateFields
              : (blueprintForm?.fields ?? []);
        const termsContent =
          registrationFormPolicy === 'COPY'
            ? templateDefinition.initialization.termsContent ||
              blueprintForm?.termsContent ||
              '提交报名即表示参会人同意大会报名服务条款。'
            : '请在开放报名之前填写本大会的报名服务条款。';
        await tx.insert(registrationForms).values({
          eventId,
          name: blueprintForm?.name ?? '标准参会报名表',
          version: 1,
          status: 'draft',
          fields: normalizeFields(registrationFields),
          termsVersion: blueprintForm?.termsVersion ?? new Date().toISOString().slice(0, 10),
          termsContent,
        });
        await tx.insert(eventTemplateBindings).values({
          eventId,
          templateVersionId: selectedTemplate.version.id,
          updatePolicy: 'manual',
          revision: 0,
          updatedBy: actorId,
        });
        await tx.insert(checkinLists).values({
          eventId,
          code: 'main-entrance',
          name: '大会主入口',
          rules: { maxEntries: 1, ticketTypes: 'all', offlineAllowed: true },
        });
        await tx.insert(outboxEvents).values({
          organizationId,
          eventId,
          eventType: 'EventCreated',
          correlationId: `event:create:${eventId}`,
          payload: {
            eventId,
            templateVersionId: selectedTemplate.version.id,
            templateId: selectedTemplate.template.id,
            blueprintId: blueprint?.id ?? null,
          },
        });
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'event.create',
          resourceType: 'event',
          resourceId: String(eventId),
          after: event as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        return event!;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '当前组织已存在相同短地址',
          HttpStatus.CONFLICT,
        );
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === '22003') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '大会 ID 已达到 2147483647，无法继续创建大会',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async listReleases(organizationId: string, eventId: EventId): Promise<EventRelease[]> {
    const event = await this.scopedEvent(organizationId, eventId);
    const settings = event.settings as { currentReleaseId?: string };
    return (
      await this.db()
        .select({ release: eventReleases, createdByName: users.name })
        .from(eventReleases)
        .leftJoin(users, eq(users.id, eventReleases.createdBy))
        .where(eq(eventReleases.eventId, eventId))
        .orderBy(desc(eventReleases.version))
    ).map((row) =>
      this.releaseFromRow(row.release, settings.currentReleaseId ?? null, row.createdByName),
    );
  }

  async publishEvent(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    templateKey?: string,
  ): Promise<EventRelease> {
    if (this.releaseActivation) {
      const activation = await this.releaseActivation.activate({
        organizationId,
        eventId,
        actorId,
        changeScope: 'site',
        changeSummary: '手动激活大会站点',
        activationKind: 'manual',
        ...(templateKey ? { templateKey } : {}),
        bringOnlineFromConfiguring: true,
      });
      if (!activation.release) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '大会当前没有可以激活的版本',
          HttpStatus.CONFLICT,
        );
      }
      return this.releaseFromRow(activation.release, activation.release.id);
    }
    const db = this.db();
    return db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
        .for('update')
        .limit(1);
      if (!event) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (!['configuring', 'prepublished', 'registration_open'].includes(event.status)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          `当前大会状态 ${event.status} 不允许发布新版本`,
          HttpStatus.CONFLICT,
        );
      }

      const [boundTemplate] = await tx
        .select({
          binding: eventTemplateBindings,
          version: conferenceTemplateVersions,
          root: conferenceTemplates,
          renderer: templatePackages,
        })
        .from(eventTemplateBindings)
        .innerJoin(
          conferenceTemplateVersions,
          eq(conferenceTemplateVersions.id, eventTemplateBindings.templateVersionId),
        )
        .innerJoin(
          conferenceTemplates,
          eq(conferenceTemplates.id, conferenceTemplateVersions.templateId),
        )
        .innerJoin(
          templatePackages,
          eq(templatePackages.id, conferenceTemplateVersions.rendererPackageId),
        )
        .where(eq(eventTemplateBindings.eventId, eventId))
        .for('update')
        .limit(1);
      const [legacyTemplate] = boundTemplate
        ? []
        : await tx
            .select()
            .from(templatePackages)
            .where(
              and(
                eq(templatePackages.key, templateKey ?? 'editorial-blue'),
                eq(templatePackages.status, 'published'),
              ),
            )
            .orderBy(desc(templatePackages.version))
            .limit(1);
      const template = boundTemplate?.renderer ?? legacyTemplate;
      if (!template) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会模板绑定不存在，或兼容渲染器未启用',
          HttpStatus.NOT_FOUND,
        );
      }

      const ticketRows = await tx
        .select()
        .from(ticketTypes)
        .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.active, true)))
        .orderBy(asc(ticketTypes.price));
      const speakerRows = await tx
        .select()
        .from(speakers)
        .where(eq(speakers.eventId, eventId))
        .orderBy(asc(speakers.sortOrder));
      const sessionRows = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.eventId, eventId))
        .orderBy(asc(sessions.sortOrder));
      const formRows = await tx
        .select()
        .from(registrationForms)
        .where(
          and(eq(registrationForms.eventId, eventId), eq(registrationForms.status, 'published')),
        )
        .orderBy(desc(registrationForms.version))
        .limit(1);
      const previous = await tx
        .select({ version: max(eventReleases.version) })
        .from(eventReleases)
        .where(eq(eventReleases.eventId, eventId));
      if (!ticketRows.length || !formRows[0]) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '发布前需要至少一个票种和一份报名表',
          HttpStatus.CONFLICT,
        );
      }
      const eventRegistration =
        event.settings.registration && typeof event.settings.registration === 'object'
          ? event.settings.registration
          : {};
      const registration = {
        paymentMode:
          'paymentMode' in eventRegistration && eventRegistration.paymentMode === 'free'
            ? ('free' as const)
            : ('ticketed' as const),
        currency: 'CNY' as const,
        registrationOpen:
          !('registrationOpen' in eventRegistration) ||
          eventRegistration.registrationOpen !== false,
        accountMode: 'mobile_otp_required' as const,
        additionalPurchaseEnabled:
          'additionalPurchaseEnabled' in eventRegistration &&
          eventRegistration.additionalPurchaseEnabled === true,
        maxActiveSeatsPerPurchaser:
          'maxActiveSeatsPerPurchaser' in eventRegistration &&
          typeof eventRegistration.maxActiveSeatsPerPurchaser === 'number' &&
          Number.isInteger(eventRegistration.maxActiveSeatsPerPurchaser) &&
          eventRegistration.maxActiveSeatsPerPurchaser >= 1 &&
          eventRegistration.maxActiveSeatsPerPurchaser <= 20
            ? eventRegistration.maxActiveSeatsPerPurchaser
            : 5,
      };
      if (registration.paymentMode === 'free' && ticketRows.some((ticket) => ticket.price !== 0)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '免费大会的所有票种价格需要设置为 0 后再发布',
          HttpStatus.CONFLICT,
        );
      }
      if (ticketRows.some((ticket) => ticket.currency !== registration.currency)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '发布版本的票种币种需要统一为 CNY',
          HttpStatus.CONFLICT,
        );
      }

      const version = (previous[0]?.version ?? 0) + 1;
      const eventSnapshot = {
        ...event,
        settings: {
          ...event.settings,
          registration,
        },
      };
      let experience:
        | {
            renderer: { key: string; version: number };
            template: {
              id: string;
              versionId: string;
              version: number;
              bindingRevision: number;
            };
            overrideRevisions: Record<string, { revision: number; contentDigest: string }>;
            presentation:
              | { kind: 'structured' }
              | {
                  kind: 'html';
                  documentId: string;
                  sanitizedDigest: string;
                  bindingDigest: string;
                  compilerVersion: number;
                };
            home?: Extract<
              ConferenceTemplateDefinition['presentation'],
              { kind: 'structured' }
            >['home'];
            faq: ConferenceTemplateDefinition['faq'];
            registrationFlow: ConferenceTemplateDefinition['registrationFlow'];
          }
        | undefined;
      if (boundTemplate) {
        const overrideRows = await tx
          .select()
          .from(eventTemplateOverrides)
          .where(eq(eventTemplateOverrides.eventId, eventId))
          .for('update');
        const documents = new Map(
          overrideRows.map((row) => [
            row.surface,
            row.document as Record<string, Record<string, unknown>>,
          ]),
        );
        const resolved = mergeTemplateDefinition(boundTemplate.version.definition, {
          home: documents.get('home') ?? {},
          faq: documents.get('faq') ?? {},
          registration_flow: documents.get('registration_flow') ?? {},
        });
        experience = {
          renderer: {
            key: boundTemplate.renderer.key,
            version: boundTemplate.renderer.version,
          },
          template: {
            id: boundTemplate.root.id,
            versionId: boundTemplate.version.id,
            version: boundTemplate.version.version,
            bindingRevision: boundTemplate.binding.revision,
          },
          overrideRevisions: Object.fromEntries(
            overrideRows.map((row) => [
              row.surface,
              { revision: row.revision, contentDigest: row.contentDigest },
            ]),
          ),
          presentation:
            resolved.presentation.kind === 'structured'
              ? { kind: 'structured' }
              : {
                  kind: 'html',
                  documentId: resolved.presentation.documentId,
                  sanitizedDigest: resolved.presentation.sanitizedDigest,
                  bindingDigest: resolved.presentation.bindingDigest,
                  compilerVersion: resolved.presentation.compilerVersion,
                },
          ...(resolved.presentation.kind === 'structured'
            ? { home: resolved.presentation.home }
            : {}),
          faq: resolved.faq,
          registrationFlow: resolved.registrationFlow,
        };
      }
      const snapshot = {
        event: eventSnapshot,
        tickets: ticketRows,
        speakers: speakerRows,
        sessions: sessionRows,
        registrationForm: formRows[0],
        template: { key: template.key, version: template.version, manifest: template.manifest },
        ...(experience ? { experience } : {}),
      };
      const [release] = await tx
        .insert(eventReleases)
        .values({
          eventId,
          version,
          templateKey: template.key,
          templateVersionId: boundTemplate?.version.id,
          snapshot,
          artifactKey: `releases/${eventId}/v${version}/${nanoid(10)}.${
            experience?.presentation.kind === 'html' ? 'html' : 'json'
          }`,
          createdBy: actorId,
        })
        .returning();
      const priorSettings = event.settings as Record<string, unknown>;
      await tx
        .update(events)
        .set({
          status: registration.registrationOpen ? 'registration_open' : 'prepublished',
          settings: {
            ...priorSettings,
            registration,
            currentReleaseId: release!.id,
            templateKey: template.key,
            templateVersionId: boundTemplate?.version.id,
          },
          updatedAt: new Date(),
        })
        .where(eq(events.id, eventId));
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId,
        eventType: 'EventPublished',
        correlationId: `event:publish:${release!.id}`,
        payload: {
          eventId,
          releaseId: release!.id,
          version,
          templateKey: template.key,
          templateVersionId: boundTemplate?.version.id ?? null,
        },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: 'event.publish',
        resourceType: 'event_release',
        resourceId: release!.id,
        after: {
          version,
          templateKey: template.key,
          templateVersionId: boundTemplate?.version.id ?? null,
          artifactKey: release!.artifactKey,
        },
        traceId: crypto.randomUUID(),
      });
      return this.releaseFromRow(release!, release!.id);
    });
  }

  async rollbackRelease(
    organizationId: string,
    eventId: EventId,
    releaseId: string,
    actorId: string,
  ): Promise<EventRelease> {
    const db = this.db();
    return db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
        .for('update')
        .limit(1);
      if (!event) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const [target] = await tx
        .select()
        .from(eventReleases)
        .where(and(eq(eventReleases.id, releaseId), eq(eventReleases.eventId, eventId)))
        .limit(1);
      if (!target) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '目标发布版本不存在',
          HttpStatus.NOT_FOUND,
        );
      }
      const settings = event.settings as Record<string, unknown> & { currentReleaseId?: string };
      const snapshot = target.snapshot as {
        event?: {
          settings?: {
            registration?: {
              paymentMode?: 'free' | 'ticketed';
              registrationOpen?: boolean;
              accountMode?: 'mobile_otp_required' | 'guest_allowed';
              additionalPurchaseEnabled?: boolean;
              maxActiveSeatsPerPurchaser?: number;
            };
          };
        };
      };
      const targetRegistrationOpen =
        snapshot.event?.settings?.registration?.registrationOpen !== false;
      const registrationOpen =
        event.status === 'registration_open'
          ? true
          : ['prepublished', 'in_progress', 'ended'].includes(event.status)
            ? false
            : targetRegistrationOpen;
      if (settings.currentReleaseId && settings.currentReleaseId !== releaseId) {
        await tx
          .update(eventReleases)
          .set({ rolledBackAt: new Date() })
          .where(eq(eventReleases.id, settings.currentReleaseId));
      }
      const nextSettings: Record<string, unknown> = {
        ...settings,
        registration: {
          paymentMode:
            snapshot.event?.settings?.registration &&
            'paymentMode' in snapshot.event.settings.registration &&
            snapshot.event.settings.registration.paymentMode === 'free'
              ? ('free' as const)
              : ('ticketed' as const),
          currency: 'CNY' as const,
          registrationOpen,
          accountMode: 'mobile_otp_required' as const,
          additionalPurchaseEnabled:
            snapshot.event?.settings?.registration?.additionalPurchaseEnabled === true,
          maxActiveSeatsPerPurchaser:
            typeof snapshot.event?.settings?.registration?.maxActiveSeatsPerPurchaser ===
              'number' &&
            Number.isInteger(snapshot.event.settings.registration.maxActiveSeatsPerPurchaser) &&
            snapshot.event.settings.registration.maxActiveSeatsPerPurchaser >= 1 &&
            snapshot.event.settings.registration.maxActiveSeatsPerPurchaser <= 20
              ? snapshot.event.settings.registration.maxActiveSeatsPerPurchaser
              : 5,
        },
        currentReleaseId: target.id,
        templateKey: target.templateKey,
      };
      if (target.templateVersionId) nextSettings.templateVersionId = target.templateVersionId;
      else delete nextSettings.templateVersionId;
      await tx
        .update(events)
        .set({
          settings: nextSettings,
          updatedAt: new Date(),
        })
        .where(eq(events.id, eventId));
      await tx.insert(outboxEvents).values({
        organizationId,
        eventId,
        eventType: 'EventReleaseRolledBack',
        correlationId: `event:rollback:${eventId}:${target.id}`,
        payload: { eventId, releaseId: target.id, version: target.version },
      });
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: 'event.release.rollback',
        resourceType: 'event_release',
        resourceId: target.id,
        before: { currentReleaseId: settings.currentReleaseId ?? null },
        after: { currentReleaseId: target.id, version: target.version },
        traceId: crypto.randomUUID(),
      });
      return this.releaseFromRow(target, target.id);
    });
  }

  async listContent(organizationId: string, eventId: EventId) {
    await this.scopedEvent(organizationId, eventId);
    const [speakerRows, sessionRows] = await Promise.all([
      this.db()
        .select()
        .from(speakers)
        .where(eq(speakers.eventId, eventId))
        .orderBy(asc(speakers.sortOrder)),
      this.db()
        .select()
        .from(sessions)
        .where(eq(sessions.eventId, eventId))
        .orderBy(asc(sessions.day), asc(sessions.sortOrder)),
    ]);
    return { speakers: speakerRows, sessions: sessionRows };
  }

  async listSpeakers(organizationId: string, eventId: EventId): Promise<AdminSpeakerSummary[]> {
    await this.scopedEvent(organizationId, eventId);
    const rows = await this.db()
      .select({ speaker: speakers, publicCode: speakerPublicRoutes.publicCode })
      .from(speakers)
      .innerJoin(
        speakerPublicRoutes,
        and(
          eq(speakerPublicRoutes.organizationId, speakers.organizationId),
          eq(speakerPublicRoutes.eventId, speakers.eventId),
          eq(speakerPublicRoutes.speakerId, speakers.id),
        ),
      )
      .where(and(eq(speakers.eventId, eventId), eq(speakers.organizationId, organizationId)))
      .orderBy(asc(speakers.sortOrder), asc(speakers.createdAt));
    return rows.map((row) => this.adminSpeaker(row.speaker, row.publicCode));
  }

  async getSpeaker(
    organizationId: string,
    eventId: EventId,
    speakerId: string,
  ): Promise<AdminSpeakerDetail> {
    await this.scopedEvent(organizationId, eventId);
    const [row] = await this.db()
      .select({ speaker: speakers, publicCode: speakerPublicRoutes.publicCode })
      .from(speakers)
      .innerJoin(
        speakerPublicRoutes,
        and(
          eq(speakerPublicRoutes.organizationId, speakers.organizationId),
          eq(speakerPublicRoutes.eventId, speakers.eventId),
          eq(speakerPublicRoutes.speakerId, speakers.id),
        ),
      )
      .where(
        and(
          eq(speakers.id, speakerId),
          eq(speakers.eventId, eventId),
          eq(speakers.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '嘉宾不存在', HttpStatus.NOT_FOUND);
    }
    return this.adminSpeaker(row.speaker, row.publicCode);
  }

  async createTicketType(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: Omit<
      typeof ticketTypes.$inferInsert,
      'id' | 'organizationId' | 'eventId' | 'sold' | 'createdAt' | 'updatedAt'
    >,
  ) {
    const result = await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'ticket',
        changeSummary: `新增票种“${input.name}”`,
      },
      async (tx) => {
        const [row] = await tx
          .insert(ticketTypes)
          .values({ ...input, organizationId, eventId })
          .returning();
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'ticket_type.create',
          resourceType: 'ticket_type',
          resourceId: row!.id,
          after: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        return row!;
      },
    );
    return result.value;
  }

  async listArchivedTicketTypes(organizationId: string, eventId: EventId) {
    await this.scopedEvent(organizationId, eventId);
    return this.db()
      .select()
      .from(ticketTypes)
      .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.active, false)))
      .orderBy(asc(ticketTypes.name));
  }

  async restoreTicketType(
    organizationId: string,
    eventId: EventId,
    ticketTypeId: string,
    actorId: string,
  ) {
    const result = await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'ticket',
        changeSummary: '恢复票种',
      },
      async (tx) => {
        const [row] = await tx
          .update(ticketTypes)
          .set({ active: true, updatedAt: new Date() })
          .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
          .returning();
        if (!row) {
          throw new DomainError(API_ERROR_CODES.NOT_FOUND, '票种不存在', HttpStatus.NOT_FOUND);
        }
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'ticket_type.restore',
          resourceType: 'ticket_type',
          resourceId: ticketTypeId,
          after: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        return row;
      },
    );
    return result.value;
  }

  async updateTicketType(
    organizationId: string,
    eventId: EventId,
    ticketTypeId: string,
    actorId: string,
    patch: Record<string, unknown>,
  ) {
    const result = await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'ticket',
        changeSummary: '更新票种配置',
      },
      async (tx) => {
        const [before] = await tx
          .select()
          .from(ticketTypes)
          .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
          .for('update')
          .limit(1);
        if (!before) {
          throw new DomainError(API_ERROR_CODES.NOT_FOUND, '票种不存在', HttpStatus.NOT_FOUND);
        }
        if (typeof patch.capacity === 'number') {
          const [held] = await tx
            .select({ quantity: sum(inventoryReservations.quantity) })
            .from(inventoryReservations)
            .where(
              and(
                eq(inventoryReservations.ticketTypeId, ticketTypeId),
                isNull(inventoryReservations.convertedAt),
                isNull(inventoryReservations.releasedAt),
                gt(inventoryReservations.expiresAt, new Date()),
              ),
            );
          const [waitlistHeld] = await tx
            .select({ quantity: count() })
            .from(waitlistEntries)
            .where(
              and(
                eq(waitlistEntries.ticketTypeId, ticketTypeId),
                eq(waitlistEntries.status, 'invited'),
                gt(waitlistEntries.expiresAt, new Date()),
              ),
            );
          const minimumCapacity =
            before.sold + Number(held?.quantity ?? 0) + Number(waitlistHeld?.quantity ?? 0);
          if (patch.capacity < minimumCapacity) {
            throw new DomainError(
              API_ERROR_CODES.INVENTORY_UNAVAILABLE,
              `容量不能低于已售与占用合计 ${minimumCapacity}`,
              HttpStatus.CONFLICT,
            );
          }
        }
        const [row] = await tx
          .update(ticketTypes)
          .set({ ...(patch as Partial<typeof ticketTypes.$inferInsert>), updatedAt: new Date() })
          .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
          .returning();
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'ticket_type.update',
          resourceType: 'ticket_type',
          resourceId: ticketTypeId,
          before: before as unknown as Record<string, unknown>,
          after: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        return row!;
      },
    );
    return result.value;
  }

  async deleteTicketType(
    organizationId: string,
    eventId: EventId,
    ticketTypeId: string,
    actorId: string,
  ) {
    await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'ticket',
        changeSummary: '下架票种',
      },
      async (tx) => {
        const [row] = await tx
          .update(ticketTypes)
          .set({ active: false, updatedAt: new Date() })
          .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
          .returning();
        if (!row) {
          throw new DomainError(API_ERROR_CODES.NOT_FOUND, '票种不存在', HttpStatus.NOT_FOUND);
        }
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'ticket_type.archive',
          resourceType: 'ticket_type',
          resourceId: ticketTypeId,
          before: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
      },
    );
    return { deleted: true, archived: true };
  }

  async createSpeaker(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: CreateSpeaker,
  ) {
    const result = await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'content',
        changeSummary: `新增嘉宾“${input.name}”`,
      },
      async (tx) => {
        await this.assertSpeakerAsset(tx, organizationId, input.avatarAssetId);
        const [row] = await tx
          .insert(speakers)
          .values({
            ...input,
            organizationId,
            eventId,
            initials: input.initials ?? speakerAvatarText(input.name),
          })
          .returning();
        let publicRoute: { publicCode: string } | undefined;
        for (let attempt = 0; attempt < 16 && !publicRoute; attempt += 1) {
          const [candidate] = await tx
            .insert(speakerPublicRoutes)
            .values({
              organizationId,
              eventId,
              speakerId: row!.id,
              publicCode: generateSpeakerPublicCode(),
            })
            .onConflictDoNothing()
            .returning({ publicCode: speakerPublicRoutes.publicCode });
          publicRoute = candidate;
        }
        if (!publicRoute) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '嘉宾短地址生成失败，请重试',
            HttpStatus.CONFLICT,
          );
        }
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'speaker.create',
          resourceType: 'speaker',
          resourceId: row!.id,
          after: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        return { speaker: row!, publicCode: publicRoute.publicCode };
      },
    );
    return this.adminSpeaker(result.value.speaker, result.value.publicCode);
  }

  async updateSpeaker(
    organizationId: string,
    eventId: EventId,
    speakerId: string,
    actorId: string,
    patch: UpdateSpeaker,
  ) {
    const result = await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'content',
        changeSummary: '更新嘉宾资料',
      },
      async (tx) => {
        await this.assertSpeakerAsset(tx, organizationId, patch.avatarAssetId);
        const [before] = await tx
          .select()
          .from(speakers)
          .where(and(eq(speakers.id, speakerId), eq(speakers.eventId, eventId)))
          .for('update')
          .limit(1);
        if (!before) {
          throw new DomainError(API_ERROR_CODES.NOT_FOUND, '嘉宾不存在', HttpStatus.NOT_FOUND);
        }
        const [row] = await tx
          .update(speakers)
          .set({
            ...patch,
            organizationId: before.organizationId,
            eventId,
            updatedAt: new Date(),
          })
          .where(eq(speakers.id, speakerId))
          .returning();
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'speaker.update',
          resourceType: 'speaker',
          resourceId: speakerId,
          before: before as unknown as Record<string, unknown>,
          after: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        const [publicRoute] = await tx
          .select({ publicCode: speakerPublicRoutes.publicCode })
          .from(speakerPublicRoutes)
          .where(
            and(
              eq(speakerPublicRoutes.organizationId, organizationId),
              eq(speakerPublicRoutes.eventId, eventId),
              eq(speakerPublicRoutes.speakerId, speakerId),
            ),
          )
          .limit(1);
        if (!publicRoute) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '嘉宾公开地址尚未初始化',
            HttpStatus.CONFLICT,
          );
        }
        return { speaker: row!, publicCode: publicRoute.publicCode };
      },
    );
    return this.adminSpeaker(result.value.speaker, result.value.publicCode);
  }

  async reorderSpeakers(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    speakerIds: string[],
  ) {
    const result = await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'content',
        changeSummary: '调整嘉宾展示顺序',
      },
      async (tx) => {
        const rows = await tx
          .select()
          .from(speakers)
          .where(eq(speakers.eventId, eventId))
          .orderBy(asc(speakers.sortOrder))
          .for('update');
        const currentIds = rows.map((row) => row.id).sort();
        const requestedIds = [...speakerIds].sort();
        if (
          currentIds.length !== requestedIds.length ||
          currentIds.some((id, index) => id !== requestedIds[index])
        ) {
          throw new DomainError(
            API_ERROR_CODES.VALIDATION_ERROR,
            '嘉宾排序必须包含当前大会的全部嘉宾',
            HttpStatus.BAD_REQUEST,
          );
        }
        for (const [sortOrder, id] of speakerIds.entries()) {
          await tx
            .update(speakers)
            .set({ sortOrder, updatedAt: new Date() })
            .where(and(eq(speakers.id, id), eq(speakers.eventId, eventId)));
        }
        const reordered = speakerIds.map((id, sortOrder) => ({ id, sortOrder }));
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'speaker.reorder',
          resourceType: 'speaker',
          resourceId: String(eventId),
          before: { order: rows.map((row) => ({ id: row.id, sortOrder: row.sortOrder })) },
          after: { order: reordered },
          traceId: crypto.randomUUID(),
        });
        return reordered;
      },
    );
    return result.value;
  }

  async deleteSpeaker(
    organizationId: string,
    eventId: EventId,
    speakerId: string,
    actorId: string,
  ) {
    await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'content',
        changeSummary: '删除嘉宾',
      },
      async (tx) => {
        const [row] = await tx
          .delete(speakers)
          .where(and(eq(speakers.id, speakerId), eq(speakers.eventId, eventId)))
          .returning();
        if (!row) {
          throw new DomainError(API_ERROR_CODES.NOT_FOUND, '嘉宾不存在', HttpStatus.NOT_FOUND);
        }
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'speaker.delete',
          resourceType: 'speaker',
          resourceId: speakerId,
          before: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
      },
    );
    return { deleted: true };
  }

  async createSession(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: Omit<typeof sessions.$inferInsert, 'id' | 'eventId' | 'createdAt' | 'updatedAt'>,
  ) {
    const result = await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'content',
        changeSummary: `新增议程“${input.title}”`,
      },
      async (tx) => {
        const [row] = await tx
          .insert(sessions)
          .values({ ...input, eventId })
          .returning();
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'session.create',
          resourceType: 'session',
          resourceId: row!.id,
          after: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        return row!;
      },
    );
    return result.value;
  }

  async updateSession(
    organizationId: string,
    eventId: EventId,
    sessionId: string,
    actorId: string,
    patch: Record<string, unknown>,
  ) {
    const result = await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'content',
        changeSummary: '更新议程',
      },
      async (tx) => {
        const [before] = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, sessionId), eq(sessions.eventId, eventId)))
          .for('update')
          .limit(1);
        if (!before) {
          throw new DomainError(API_ERROR_CODES.NOT_FOUND, '议程不存在', HttpStatus.NOT_FOUND);
        }
        const [row] = await tx
          .update(sessions)
          .set({
            ...(patch as Partial<typeof sessions.$inferInsert>),
            eventId,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId))
          .returning();
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'session.update',
          resourceType: 'session',
          resourceId: sessionId,
          before: before as unknown as Record<string, unknown>,
          after: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        return row!;
      },
    );
    return result.value;
  }

  async deleteSession(
    organizationId: string,
    eventId: EventId,
    sessionId: string,
    actorId: string,
  ) {
    await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'content',
        changeSummary: '删除议程',
      },
      async (tx) => {
        const [row] = await tx
          .delete(sessions)
          .where(and(eq(sessions.id, sessionId), eq(sessions.eventId, eventId)))
          .returning();
        if (!row) {
          throw new DomainError(API_ERROR_CODES.NOT_FOUND, '议程不存在', HttpStatus.NOT_FOUND);
        }
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'session.delete',
          resourceType: 'session',
          resourceId: sessionId,
          before: row as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
      },
    );
    return { deleted: true };
  }

  async listForms(organizationId: string, eventId: EventId): Promise<RegistrationForm[]> {
    await this.scopedEvent(organizationId, eventId);
    return (
      await this.db()
        .select()
        .from(registrationForms)
        .where(eq(registrationForms.eventId, eventId))
        .orderBy(desc(registrationForms.version))
    ).map((row) => ({
      id: row.id,
      eventId: row.eventId,
      name: row.name,
      version: row.version,
      status: row.status as 'draft' | 'published' | 'archived',
      fields: row.fields,
      termsVersion: row.termsVersion,
      termsContent: row.termsContent,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    }));
  }

  async publishForm(
    organizationId: string,
    eventId: EventId,
    actorId: string,
    input: {
      name: string;
      fields: RegistrationField[];
      termsVersion: string;
      termsContent: string;
    },
  ): Promise<RegistrationForm> {
    const normalizedFields = normalizeFields(input.fields);
    const result = await this.releases().mutate(
      {
        organizationId,
        eventId,
        actorId,
        changeScope: 'form',
        changeSummary: `更新报名表与条款“${input.termsVersion}”`,
      },
      async (tx) => {
        const [current] = await tx
          .select()
          .from(registrationForms)
          .where(
            and(eq(registrationForms.eventId, eventId), eq(registrationForms.status, 'published')),
          )
          .orderBy(desc(registrationForms.version))
          .for('update')
          .limit(1);
        if (
          current &&
          current.name === input.name &&
          current.termsVersion === input.termsVersion &&
          current.termsContent === input.termsContent &&
          JSON.stringify(normalizeFields(current.fields)) === JSON.stringify(normalizedFields)
        ) {
          return current;
        }
        const versions = await tx
          .select({ version: max(registrationForms.version) })
          .from(registrationForms)
          .where(eq(registrationForms.eventId, eventId));
        await tx
          .update(registrationForms)
          .set({ status: 'archived', updatedAt: new Date() })
          .where(
            and(eq(registrationForms.eventId, eventId), eq(registrationForms.status, 'published')),
          );
        const [created] = await tx
          .insert(registrationForms)
          .values({
            eventId,
            name: input.name,
            version: (versions[0]?.version ?? 0) + 1,
            status: 'published',
            fields: normalizedFields,
            termsVersion: input.termsVersion,
            termsContent: input.termsContent,
            publishedAt: new Date(),
          })
          .returning();
        await tx.insert(outboxEvents).values({
          organizationId,
          eventId,
          eventType: 'RegistrationFormPublished',
          correlationId: `form:publish:${created!.id}`,
          payload: { eventId, formId: created!.id, version: created!.version },
        });
        await tx.insert(auditLogs).values({
          organizationId,
          eventId,
          actorId,
          action: 'registration_form.publish',
          resourceType: 'registration_form',
          resourceId: created!.id,
          after: created as unknown as Record<string, unknown>,
          traceId: crypto.randomUUID(),
        });
        return created!;
      },
    );
    const row = result.value;
    return {
      id: row.id,
      eventId: row.eventId,
      name: row.name,
      version: row.version,
      status: row.status as 'draft' | 'published' | 'archived',
      fields: row.fields,
      termsVersion: row.termsVersion,
      termsContent: row.termsContent,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    };
  }

  async getPublishedForm(eventId: EventId): Promise<RegistrationForm | undefined> {
    const [row] = await this.db()
      .select()
      .from(registrationForms)
      .where(and(eq(registrationForms.eventId, eventId), eq(registrationForms.status, 'published')))
      .orderBy(desc(registrationForms.version))
      .limit(1);
    if (!row) return undefined;
    return {
      id: row.id,
      eventId: row.eventId,
      name: row.name,
      version: row.version,
      status: 'published',
      fields: row.fields,
      termsVersion: row.termsVersion,
      termsContent: row.termsContent,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    };
  }
}
