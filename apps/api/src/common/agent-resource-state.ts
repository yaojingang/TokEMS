import {
  conferenceTemplates,
  conferenceTemplateDrafts,
  conferenceTemplateVersions,
  templateAssets,
  templateHtmlImports,
  templateHtmlImportAssets,
  templateHtmlDocuments,
  events,
  eventTemplateBindings,
  eventTemplateOverrides,
  speakers,
  sessions,
  registrationForms,
  ticketTypes,
  organizations,
  registrations,
  customerUsers,
  customerProfiles,
  invoiceRequests,
  invoiceDocuments,
  checkinDevices,
  publicUserIds,
  organizationHomepageEvents,
  type ConferenceDatabase,
} from '@conference/database';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

export async function captureAgentResourceState(
  db: ConferenceDatabase,
  actionId: string,
  organizationId: string,
  target: Record<string, string>,
  lock = false,
): Promise<unknown | undefined> {
  const rows = async (table: PgTable, condition: SQL | undefined) => {
    const query = db
      .select()
      .from(table)
      .where(condition)
      .orderBy(sql`1`)
      .$dynamic();
    return lock ? query.for('update') : query;
  };
  const org = eq(organizations.id, organizationId);
  if (actionId.startsWith('organization.') && !actionId.startsWith('organization.members')) {
    return {
      organization: await rows(organizations, org),
      homepage: await rows(
        organizationHomepageEvents,
        eq(organizationHomepageEvents.organizationId, organizationId),
      ),
    };
  }
  if (actionId === 'templates.list' || actionId === 'templates.assets.list') {
    await rows(organizations, org);
    return actionId === 'templates.list'
      ? rows(conferenceTemplates, eq(conferenceTemplates.organizationId, organizationId))
      : rows(templateAssets, eq(templateAssets.organizationId, organizationId));
  }
  if (
    [
      'templates.get',
      'templates.draft.get',
      'templates.versions.list',
      'templates.usages.list',
      'templates.html-document.get',
    ].includes(actionId) &&
    target.templateId
  ) {
    const roots = await rows(
      conferenceTemplates,
      and(
        eq(conferenceTemplates.id, target.templateId),
        eq(conferenceTemplates.organizationId, organizationId),
      ),
    );
    if (!roots.length) return [];
    const draft = await rows(
      conferenceTemplateDrafts,
      eq(conferenceTemplateDrafts.templateId, target.templateId),
    );
    if (actionId === 'templates.draft.get') return draft;
    const versionId = roots[0]?.currentPublishedVersionId;
    const versions =
      typeof versionId === 'string'
        ? await rows(conferenceTemplateVersions, eq(conferenceTemplateVersions.id, versionId))
        : [];
    if (actionId === 'templates.html-document.get') {
      return {
        roots,
        draft,
        versions,
        documents: await rows(
          templateHtmlDocuments,
          and(
            eq(templateHtmlDocuments.organizationId, organizationId),
            eq(templateHtmlDocuments.templateId, target.templateId),
          ),
        ),
      };
    }
    return { roots, draft, versions };
  }
  if (actionId.startsWith('templates.html-imports.')) {
    const imports = await rows(
      templateHtmlImports,
      and(
        eq(templateHtmlImports.organizationId, organizationId),
        target.importId ? eq(templateHtmlImports.id, target.importId) : undefined,
      ),
    );
    return {
      imports,
      assets: target.importId
        ? await rows(
            templateHtmlImportAssets,
            eq(templateHtmlImportAssets.importId, target.importId),
          )
        : [],
    };
  }
  if (target.eventId) {
    const eventId = Number(target.eventId);
    if (!Number.isSafeInteger(eventId)) return undefined;
    const event = await rows(
      events,
      and(eq(events.id, eventId), eq(events.organizationId, organizationId)),
    );
    if (!event.length) return [];
    if (actionId === 'events.get' || actionId === 'events.releases.list') return event;
    if (['templates.event-binding.get', 'events.experience.get'].includes(actionId)) {
      return {
        event,
        bindings: await rows(eventTemplateBindings, eq(eventTemplateBindings.eventId, eventId)),
        overrides: await rows(eventTemplateOverrides, eq(eventTemplateOverrides.eventId, eventId)),
      };
    }
    if (
      [
        'content.get',
        'content.speakers.list',
        'content.speakers.get',
        'content.registration-forms.get',
        'content.ticket-types.list',
      ].includes(actionId)
    ) {
      const context = event.map((item) => ({ id: item.id, slug: item.slug, status: item.status }));
      if (actionId.startsWith('content.speakers.'))
        return {
          event: context,
          speakers: await rows(
            speakers,
            and(
              eq(speakers.eventId, eventId),
              target.speakerId ? eq(speakers.id, target.speakerId) : undefined,
            ),
          ),
        };
      if (target.sessionId)
        return {
          event: context,
          sessions: await rows(
            sessions,
            and(eq(sessions.eventId, eventId), eq(sessions.id, target.sessionId)),
          ),
        };
      if (target.ticketTypeId)
        return {
          event: context,
          tickets: await rows(
            ticketTypes,
            and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.id, target.ticketTypeId)),
          ),
        };
      const ticketRows = await rows(ticketTypes, eq(ticketTypes.eventId, eventId));
      return {
        event: context,
        speakers: await rows(speakers, eq(speakers.eventId, eventId)),
        sessions: await rows(sessions, eq(sessions.eventId, eventId)),
        tickets: ticketRows.map((item) =>
          Object.fromEntries(
            Object.entries(item).filter(([key]) => !['sold', 'updatedAt'].includes(key)),
          ),
        ),
        forms: await rows(registrationForms, eq(registrationForms.eventId, eventId)),
      };
    }
    if (actionId === 'registrations.get' && target.registrationId) {
      return rows(
        registrations,
        and(eq(registrations.id, target.registrationId), eq(registrations.eventId, eventId)),
      );
    }
    if (actionId === 'invoices.get' && target.invoiceId) {
      return {
        invoices: await rows(
          invoiceRequests,
          and(eq(invoiceRequests.eventId, eventId), eq(invoiceRequests.id, target.invoiceId)),
        ),
        documents: await rows(
          invoiceDocuments,
          eq(invoiceDocuments.invoiceRequestId, target.invoiceId),
        ),
      };
    }
    if (actionId === 'checkin.devices.list') {
      return rows(checkinDevices, eq(checkinDevices.eventId, eventId));
    }
  }
  if (actionId === 'customers.get' && target.userId) {
    const [identity] = await db
      .select()
      .from(publicUserIds)
      .where(
        and(
          eq(publicUserIds.publicId, Number(target.userId)),
          eq(publicUserIds.subjectType, 'customer'),
        ),
      );
    if (!identity) return [];
    const userId = identity.subjectUuid;
    const user = await rows(
      customerUsers,
      and(eq(customerUsers.organizationId, organizationId), eq(customerUsers.id, userId)),
    );
    if (!user.length) return [];
    return {
      user,
      profile: await rows(customerProfiles, eq(customerProfiles.customerUserId, userId)),
    };
  }

  return undefined;
}
