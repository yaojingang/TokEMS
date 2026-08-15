import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS, type EventId } from '@conference/contracts';
import {
  conferenceTemplates,
  conferenceTemplateVersions,
  eventSlugAliases,
  events,
  organizationHomepageEvents,
  organizations,
} from '@conference/database';
import { and, eq, isNotNull } from 'drizzle-orm';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { EventOperationsService } from './event-operations.service.js';
import { EventReleaseActivationService } from './event-release-activation.service.js';
import { OrganizationAdminService } from './organization-admin.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('organization homepage event', () => {
  const database = new DatabaseService();
  const activation = new EventReleaseActivationService(database);
  const eventsService = new EventOperationsService(database, activation);
  const repository = new ConferenceRepository(database, activation);
  const organizationsService = new OrganizationAdminService(database);
  const createdEventIds: EventId[] = [];
  const publicSlug = `homepage-public-${randomUUID().slice(0, 8)}`;
  const draftSlug = `homepage-draft-${randomUUID().slice(0, 8)}`;
  let publicEventId: EventId;
  let draftEventId: EventId;
  let organizationSlug: string;
  let generatedSlug: string;
  let previousHomepage: typeof organizationHomepageEvents.$inferSelect | undefined;

  beforeAll(async () => {
    const [templateRows, organizationRows, homepageRows] = await Promise.all([
      database
        .db!.select({ versionId: conferenceTemplateVersions.id })
        .from(conferenceTemplates)
        .innerJoin(
          conferenceTemplateVersions,
          eq(conferenceTemplateVersions.id, conferenceTemplates.currentPublishedVersionId),
        )
        .where(
          and(
            eq(conferenceTemplates.id, DEMO_IDS.template.root),
            eq(conferenceTemplates.organizationId, DEMO_IDS.organization),
            eq(conferenceTemplates.status, 'active'),
            isNotNull(conferenceTemplates.currentPublishedVersionId),
          ),
        )
        .limit(1),
      database
        .db!.select({ slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.id, DEMO_IDS.organization))
        .limit(1),
      database
        .db!.select()
        .from(organizationHomepageEvents)
        .where(eq(organizationHomepageEvents.organizationId, DEMO_IDS.organization))
        .limit(1),
    ]);
    const template = templateRows[0];
    const organization = organizationRows[0];
    expect(template?.versionId).toBeTruthy();
    expect(organization?.slug).toBeTruthy();
    organizationSlug = organization!.slug;
    previousHomepage = homepageRows[0];

    const baseInput = {
      startsAt: '2028-04-12T01:00:00.000Z',
      endsAt: '2028-04-12T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
      venue: '深圳国际会议中心',
      city: '深圳',
      address: '深圳市南山区测试路 8 号',
      templateVersionId: template!.versionId,
    };
    const publicEvent = await eventsService.createEvent(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      {
        ...baseInput,
        name: '首页默认大会验收场',
        shortName: '首页验收',
        slug: publicSlug,
      },
    );
    publicEventId = publicEvent.id;
    createdEventIds.push(publicEventId);
    const draftEvent = await eventsService.createEvent(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      {
        ...baseInput,
        name: '首页草稿大会验收场',
        shortName: '草稿验收',
        slug: draftSlug,
      },
    );
    draftEventId = draftEvent.id;
    createdEventIds.push(draftEventId);
    const generatedEvent = await eventsService.createEvent(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      {
        ...baseInput,
        name: '自动短地址大会验收场',
        shortName: '自动短址',
      },
    );
    generatedSlug = generatedEvent.slug;
    createdEventIds.push(generatedEvent.id);

    const [draftForm] = await eventsService.listForms(DEMO_IDS.organization, publicEventId);
    await eventsService.publishForm(DEMO_IDS.organization, publicEventId, DEMO_IDS.adminUser, {
      name: draftForm!.name,
      fields: draftForm!.fields,
      termsVersion: draftForm!.termsVersion,
      termsContent: draftForm!.termsContent,
    });
    await repository.updateEvent(
      publicEventId,
      { status: 'prepublished' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
  });

  afterAll(async () => {
    if (previousHomepage) {
      await database
        .db!.insert(organizationHomepageEvents)
        .values(previousHomepage)
        .onConflictDoUpdate({
          target: organizationHomepageEvents.organizationId,
          set: {
            eventId: previousHomepage.eventId,
            updatedBy: previousHomepage.updatedBy,
            updatedAt: previousHomepage.updatedAt,
          },
        });
    } else {
      await database
        .db!.delete(organizationHomepageEvents)
        .where(eq(organizationHomepageEvents.organizationId, DEMO_IDS.organization));
    }
    for (const eventId of createdEventIds) {
      await database.db!.delete(events).where(eq(events.id, eventId));
    }
    await database.onModuleDestroy();
  });

  it('sets one published event as the organization homepage and resolves it publicly', async () => {
    const selected = await organizationsService.setHomepageEvent(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      publicEventId,
    );
    expect(selected).toMatchObject({ eventId: publicEventId, slug: publicSlug });
    await expect(repository.getPublicHomepageEvent(organizationSlug)).resolves.toMatchObject({
      id: publicEventId,
      slug: publicSlug,
    });

    const summaries = await eventsService.listEvents(DEMO_IDS.organization);
    expect(summaries.filter((event) => event.isHomepageDefault)).toEqual([
      expect.objectContaining({ id: publicEventId }),
    ]);
  });

  it('rejects a draft target and keeps the active homepage unchanged', async () => {
    await expect(
      organizationsService.setHomepageEvent(
        DEMO_IDS.organization,
        DEMO_IDS.adminUser,
        draftEventId,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(repository.getPublicHomepageEvent(organizationSlug)).resolves.toMatchObject({
      id: publicEventId,
    });
  });

  it('prevents the active homepage event from being taken offline', async () => {
    await expect(
      repository.updateEvent(
        publicEventId,
        { status: 'configuring' },
        DEMO_IDS.adminUser,
        DEMO_IDS.organization,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(repository.getPublicHomepageEvent(organizationSlug)).resolves.toMatchObject({
      status: 'prepublished',
    });
  });

  it('generates a short default URL and preserves old URLs after customization', async () => {
    expect(generatedSlug).toMatch(/^e[a-z0-9]{6}$/);
    const nextSlug = `h${randomUUID().replaceAll('-', '').slice(0, 7)}`;
    const updated = await eventsService.updateEventSlug(
      DEMO_IDS.organization,
      publicEventId,
      DEMO_IDS.adminUser,
      { slug: nextSlug },
    );
    expect(updated).toMatchObject({ previousSlug: publicSlug, slug: nextSlug });
    await expect(repository.resolvePublicEventRoute(publicSlug, organizationSlug)).resolves.toEqual({
      eventId: publicEventId,
      slug: nextSlug,
      isAlias: true,
    });
    await expect(repository.getPublicEvent(publicSlug, organizationSlug)).resolves.toMatchObject({
      id: publicEventId,
      slug: nextSlug,
    });
    await expect(
      eventsService.updateEventSlug(DEMO_IDS.organization, publicEventId, DEMO_IDS.adminUser, {
        slug: draftSlug,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      database
        .db!.select({ eventId: eventSlugAliases.eventId })
        .from(eventSlugAliases)
        .where(
          and(
            eq(eventSlugAliases.organizationId, DEMO_IDS.organization),
            eq(eventSlugAliases.slug, publicSlug),
          ),
        )
        .limit(1),
    ).resolves.toEqual([{ eventId: publicEventId }]);
  });
});
