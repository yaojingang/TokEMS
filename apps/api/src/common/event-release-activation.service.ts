import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  type ConferenceTemplateDefinition,
  type EventId,
  type TemplateSurface,
} from '@conference/contracts';
import {
  auditLogs,
  conferenceTemplates,
  conferenceTemplateVersions,
  eventReleases,
  eventTemplateBindings,
  eventTemplateOverrides,
  events,
  outboxEvents,
  registrationForms,
  sessions,
  speakers,
  templatePackages,
  ticketTypes,
} from '@conference/database';
import { and, asc, desc, eq, max } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { mergeTemplateDefinition } from './template-definition.js';

type Database = NonNullable<DatabaseService['db']>;
export type EventMutationTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type LockedEvent = typeof events.$inferSelect;

export type EventReleaseChangeScope =
  'site' | 'event' | 'experience' | 'registration' | 'ticket' | 'content' | 'form' | 'lifecycle';

export type EventReleaseActivationKind = 'initial' | 'save' | 'manual';

export type EventReleaseEventField =
  | 'name'
  | 'shortName'
  | 'tagline'
  | 'description'
  | 'startsAt'
  | 'endsAt'
  | 'timezone'
  | 'venue'
  | 'city'
  | 'address'
  | 'status';

export interface EventReleaseChangeContext {
  organizationId: string;
  eventId: EventId;
  actorId: string;
  changeScope: EventReleaseChangeScope;
  changeSummary: string;
  activationKind?: EventReleaseActivationKind;
  templateKey?: string;
  eventFields?: EventReleaseEventField[];
  registrationChanged?: boolean;
  experienceSurface?: TemplateSurface;
}

export interface EventReleaseActivationResult {
  state: 'draft' | 'unchanged' | 'activated';
  release: typeof eventReleases.$inferSelect | null;
}

const NON_CONTENT_KEYS = new Set([
  'currentReleaseId',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'rolledBackAt',
  'sold',
  'revision',
  'bindingRevision',
]);

function canonicalizeReleaseContent(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalizeReleaseContent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !NON_CONTENT_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeReleaseContent(item)]),
  );
}

export function releaseContentDigest(snapshot: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeReleaseContent(snapshot)))
    .digest('hex');
}

function asSnapshotRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function releaseSnapshotTemplateMetadata(
  snapshotValue: unknown,
  fallback: {
    templateKey: string;
    templateVersionId?: string;
    currentArtifactKey?: string;
  },
) {
  const snapshot = asSnapshotRecord(snapshotValue);
  const snapshotTemplate = asSnapshotRecord(snapshot.template);
  const snapshotEvent = asSnapshotRecord(snapshot.event);
  const snapshotSettings = asSnapshotRecord(snapshotEvent.settings);
  const snapshotExperience = asSnapshotRecord(snapshot.experience);
  const experienceTemplate = asSnapshotRecord(snapshotExperience.template);
  const presentation = asSnapshotRecord(snapshotExperience.presentation);
  return {
    templateKey:
      typeof snapshotTemplate.key === 'string' ? snapshotTemplate.key : fallback.templateKey,
    templateVersionId:
      typeof experienceTemplate.versionId === 'string'
        ? experienceTemplate.versionId
        : typeof snapshotSettings.templateVersionId === 'string'
          ? snapshotSettings.templateVersionId
          : fallback.templateVersionId,
    artifactExtension:
      presentation.kind === 'html' ||
      (presentation.kind !== 'structured' && fallback.currentArtifactKey?.endsWith('.html'))
        ? ('html' as const)
        : ('json' as const),
  };
}

function mergeEventSnapshotFields(
  baseEvent: Record<string, unknown>,
  liveEvent: Record<string, unknown>,
  fields: readonly string[],
) {
  const merged = { ...liveEvent, ...baseEvent };
  for (const field of fields) {
    if (field in liveEvent) merged[field] = liveEvent[field];
  }
  return merged;
}

export function mergeReleaseSnapshotForScope(
  baselineValue: unknown,
  liveValue: unknown,
  scope: EventReleaseChangeScope,
  options: Pick<
    EventReleaseChangeContext,
    'eventFields' | 'registrationChanged' | 'experienceSurface'
  > = {},
): Record<string, unknown> {
  const baseline = asSnapshotRecord(baselineValue);
  const live = asSnapshotRecord(liveValue);
  if (scope === 'site') return live;

  const merged = { ...live, ...baseline };
  const liveEvent = asSnapshotRecord(live.event);
  const baselineEvent = asSnapshotRecord(baseline.event);
  const liveSettings = asSnapshotRecord(liveEvent.settings);
  const baselineSettings = { ...liveSettings, ...asSnapshotRecord(baselineEvent.settings) };
  const baselineEventWithSettings = {
    ...liveEvent,
    ...baselineEvent,
    settings: baselineSettings,
  };

  if (scope === 'ticket') merged.tickets = live.tickets;
  if (scope === 'content') {
    merged.speakers = live.speakers;
    merged.sessions = live.sessions;
  }
  if (scope === 'form') merged.registrationForm = live.registrationForm;
  if (scope === 'registration') {
    merged.event = {
      ...baselineEventWithSettings,
      settings: { ...baselineSettings, registration: liveSettings.registration },
    };
  }
  if (scope === 'event') {
    const eventFields =
      options.eventFields ??
      ([
        'name',
        'shortName',
        'tagline',
        'description',
        'startsAt',
        'endsAt',
        'timezone',
        'venue',
        'city',
        'address',
        'status',
      ] as const);
    merged.event = {
      ...mergeEventSnapshotFields(baselineEvent, liveEvent, eventFields),
      settings: options.registrationChanged
        ? { ...baselineSettings, registration: liveSettings.registration }
        : baselineSettings,
    };
  }
  if (scope === 'lifecycle') {
    merged.event = {
      ...mergeEventSnapshotFields(baselineEventWithSettings, liveEvent, ['status']),
      settings: options.registrationChanged
        ? { ...baselineSettings, registration: liveSettings.registration }
        : baselineSettings,
    };
  }
  if (scope === 'experience') {
    if (options.experienceSurface) {
      const baselineExperience = asSnapshotRecord(baseline.experience);
      const liveExperience = asSnapshotRecord(live.experience);
      const property =
        options.experienceSurface === 'registration_flow'
          ? 'registrationFlow'
          : options.experienceSurface;
      merged.experience = {
        ...liveExperience,
        ...baselineExperience,
        [property]: liveExperience[property],
      };
    } else {
      merged.template = live.template;
      merged.experience = live.experience;
      merged.event = {
        ...baselineEventWithSettings,
        settings: {
          ...baselineSettings,
          templateKey: liveSettings.templateKey,
          templateVersionId: liveSettings.templateVersionId,
        },
      };
    }
  }
  return merged;
}

@Injectable()
export class EventReleaseActivationService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private db(): Database {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '大会版本激活需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private async lockEvent(tx: EventMutationTransaction, organizationId: string, eventId: EventId) {
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
    return event;
  }

  async mutate<T>(
    context: EventReleaseChangeContext,
    mutation: (tx: EventMutationTransaction, event: LockedEvent) => Promise<T>,
  ): Promise<{ value: T; activation: EventReleaseActivationResult }> {
    return this.db().transaction(async (tx) => {
      const event = await this.lockEvent(tx, context.organizationId, context.eventId);
      const value = await mutation(tx, event);
      const activation = await this.activateInTransaction(tx, context, false, event.status);
      return { value, activation };
    });
  }

  async activate(
    context: EventReleaseChangeContext & { bringOnlineFromConfiguring?: boolean },
  ): Promise<EventReleaseActivationResult> {
    return this.db().transaction(async (tx) => {
      const event = await this.lockEvent(tx, context.organizationId, context.eventId);
      if (context.bringOnlineFromConfiguring && event.status === 'configuring') {
        const registration = this.registrationSettings(event);
        await tx
          .update(events)
          .set({
            status: registration.registrationOpen ? 'registration_open' : 'prepublished',
            updatedAt: new Date(),
          })
          .where(eq(events.id, context.eventId));
      }
      return this.activateInTransaction(tx, context, true);
    });
  }

  private registrationSettings(event: LockedEvent) {
    return this.normalizeRegistrationSettings(event.settings.registration);
  }

  private normalizeRegistrationSettings(input: unknown) {
    const value = asSnapshotRecord(input);
    return {
      paymentMode:
        'paymentMode' in value && value.paymentMode === 'free'
          ? ('free' as const)
          : ('ticketed' as const),
      currency: 'CNY' as const,
      registrationOpen: !('registrationOpen' in value) || value.registrationOpen !== false,
      accountMode:
        'accountMode' in value && value.accountMode === 'guest_allowed'
          ? ('guest_allowed' as const)
          : ('mobile_otp_required' as const),
    };
  }

  private async activateInTransaction(
    tx: EventMutationTransaction,
    context: EventReleaseChangeContext,
    force = false,
    previousStatus?: string,
  ): Promise<EventReleaseActivationResult> {
    const event = await this.lockEvent(tx, context.organizationId, context.eventId);
    const currentReleaseId =
      typeof event.settings.currentReleaseId === 'string' ? event.settings.currentReleaseId : null;
    const publicStatuses = new Set(['prepublished', 'registration_open', 'in_progress', 'ended']);
    if (!force && !publicStatuses.has(event.status)) {
      return { state: 'draft', release: null };
    }
    if (force && !['configuring', 'prepublished', 'registration_open'].includes(event.status)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        `当前大会状态 ${event.status} 不允许激活新版本`,
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
      .where(eq(eventTemplateBindings.eventId, context.eventId))
      .for('update')
      .limit(1);
    const [legacyTemplate] = boundTemplate
      ? []
      : await tx
          .select()
          .from(templatePackages)
          .where(
            and(
              eq(templatePackages.key, context.templateKey ?? 'editorial-blue'),
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
      .where(and(eq(ticketTypes.eventId, context.eventId), eq(ticketTypes.active, true)))
      .orderBy(asc(ticketTypes.price), asc(ticketTypes.id));
    const speakerRows = await tx
      .select()
      .from(speakers)
      .where(eq(speakers.eventId, context.eventId))
      .orderBy(asc(speakers.sortOrder), asc(speakers.id));
    const sessionRows = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.eventId, context.eventId))
      .orderBy(asc(sessions.day), asc(sessions.sortOrder), asc(sessions.id));
    const formRows = await tx
      .select()
      .from(registrationForms)
      .where(
        and(
          eq(registrationForms.eventId, context.eventId),
          eq(registrationForms.status, 'published'),
        ),
      )
      .orderBy(desc(registrationForms.version))
      .limit(1);
    const versions = await tx
      .select({ version: max(eventReleases.version) })
      .from(eventReleases)
      .where(eq(eventReleases.eventId, context.eventId));
    const registration = this.registrationSettings(event);
    const eventSnapshot = {
      ...event,
      settings: {
        ...event.settings,
        registration,
        templateKey: template.key,
        ...(boundTemplate ? { templateVersionId: boundTemplate.version.id } : {}),
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
        .where(eq(eventTemplateOverrides.eventId, context.eventId))
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
    const liveSnapshot = {
      event: eventSnapshot,
      tickets: ticketRows,
      speakers: speakerRows,
      sessions: sessionRows,
      registrationForm: formRows[0],
      template: { key: template.key, version: template.version, manifest: template.manifest },
      ...(experience ? { experience } : {}),
    };

    let currentRelease: typeof eventReleases.$inferSelect | undefined;
    if (currentReleaseId) {
      [currentRelease] = await tx
        .select()
        .from(eventReleases)
        .where(
          and(eq(eventReleases.id, currentReleaseId), eq(eventReleases.eventId, context.eventId)),
        )
        .limit(1);
    }
    const returningOnline =
      previousStatus !== undefined &&
      !publicStatuses.has(previousStatus) &&
      publicStatuses.has(event.status);
    const snapshot =
      currentRelease && !returningOnline
        ? mergeReleaseSnapshotForScope(
            currentRelease.snapshot,
            liveSnapshot,
            context.changeScope,
            context,
          )
        : liveSnapshot;
    const snapshotTickets = Array.isArray(snapshot.tickets)
      ? snapshot.tickets.filter((ticket): ticket is Record<string, unknown> =>
          Boolean(ticket && typeof ticket === 'object' && !Array.isArray(ticket)),
        )
      : [];
    const snapshotForm = asSnapshotRecord(snapshot.registrationForm);
    if (!snapshotTickets.length || !Object.keys(snapshotForm).length) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '生效前需要至少一个可用票种和一份报名表',
        HttpStatus.CONFLICT,
      );
    }
    const snapshotEvent = asSnapshotRecord(snapshot.event);
    const snapshotSettings = asSnapshotRecord(snapshotEvent.settings);
    const snapshotRegistration = this.normalizeRegistrationSettings(snapshotSettings.registration);
    if (
      snapshotRegistration.paymentMode === 'free' &&
      snapshotTickets.some((ticket) => Number(ticket.price ?? 0) !== 0)
    ) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '免费大会的所有票种价格需要设置为 0 后再保存',
        HttpStatus.CONFLICT,
      );
    }
    if (snapshotTickets.some((ticket) => (ticket.currency ?? 'CNY') !== 'CNY')) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '生效版本的票种币种需要统一为 CNY',
        HttpStatus.CONFLICT,
      );
    }
    if (currentRelease) {
      if (releaseContentDigest(currentRelease.snapshot) === releaseContentDigest(snapshot)) {
        return { state: 'unchanged', release: currentRelease };
      }
    }

    const version = (versions[0]?.version ?? 0) + 1;
    const activationKind =
      context.activationKind ?? (currentReleaseId ? ('save' as const) : ('initial' as const));
    const {
      templateKey: releaseTemplateKey,
      templateVersionId: releaseTemplateVersionId,
      artifactExtension,
    } = releaseSnapshotTemplateMetadata(snapshot, {
      templateKey: template.key,
      ...(currentRelease
        ? {
            ...(currentRelease.templateVersionId
              ? { templateVersionId: currentRelease.templateVersionId }
              : {}),
            currentArtifactKey: currentRelease.artifactKey,
          }
        : {}),
    });
    const [release] = await tx
      .insert(eventReleases)
      .values({
        eventId: context.eventId,
        version,
        templateKey: releaseTemplateKey,
        templateVersionId: releaseTemplateVersionId,
        snapshot,
        artifactKey: `releases/${context.eventId}/v${version}/${nanoid(10)}.${artifactExtension}`,
        changeSummary: context.changeSummary,
        changeScope: context.changeScope,
        activationKind,
        createdBy: context.actorId,
      })
      .returning();
    const nextSettings: Record<string, unknown> = {
      ...event.settings,
      registration,
      currentReleaseId: release!.id,
      templateKey: releaseTemplateKey,
    };
    if (releaseTemplateVersionId) nextSettings.templateVersionId = releaseTemplateVersionId;
    else delete nextSettings.templateVersionId;
    await tx
      .update(events)
      .set({
        settings: nextSettings,
        updatedAt: new Date(),
      })
      .where(eq(events.id, context.eventId));
    await tx.insert(outboxEvents).values({
      organizationId: context.organizationId,
      eventId: context.eventId,
      eventType: 'EventPublished',
      correlationId: `event:activate:${release!.id}`,
      payload: {
        eventId: context.eventId,
        releaseId: release!.id,
        version,
        artifactKey: release!.artifactKey,
        activationKind,
      },
    });
    await tx.insert(auditLogs).values({
      organizationId: context.organizationId,
      eventId: context.eventId,
      actorId: context.actorId,
      action: 'event.release.activate',
      resourceType: 'event_release',
      resourceId: release!.id,
      before: { currentReleaseId },
      after: {
        currentReleaseId: release!.id,
        version,
        changeScope: context.changeScope,
        changeSummary: context.changeSummary,
        activationKind,
      },
      traceId: randomUUID(),
    });
    return { state: 'activated', release: release! };
  }
}
