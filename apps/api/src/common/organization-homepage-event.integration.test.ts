import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  DEMO_IDS,
  EventExperienceSchema,
  type EventId,
} from '@conference/contracts';
import {
  conferenceTemplates,
  conferenceTemplateVersions,
  eventSlugAliases,
  eventTemplateOverrides,
  events,
  organizationHomepageEvents,
  organizations,
} from '@conference/database';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { EventOperationsService } from './event-operations.service.js';
import { EventReleaseActivationService } from './event-release-activation.service.js';
import { OrganizationAdminService } from './organization-admin.service.js';
import { TemplateOperationsService } from './template-operations.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('organization homepage event', () => {
  const database = new DatabaseService();
  const activation = new EventReleaseActivationService(database);
  const eventsService = new EventOperationsService(database, activation);
  const repository = new ConferenceRepository(database, activation);
  const organizationsService = new OrganizationAdminService(database);
  const templatesService = new TemplateOperationsService(database, activation);
  const createdVersionIds: string[] = [];
  const createdEventIds: EventId[] = [];
  const publicSlug = `homepage-public-${randomUUID().slice(0, 8)}`;
  const draftSlug = `homepage-draft-${randomUUID().slice(0, 8)}`;
  let publicEventId: EventId;
  let draftEventId: EventId;
  let organizationSlug: string;
  let generatedSlug: string;
  let previousHomepage: typeof organizationHomepageEvents.$inferSelect | undefined;
  let previousHomepageSettings: unknown;

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
        .db!.select({ slug: organizations.slug, settings: organizations.settings })
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
    previousHomepageSettings = organization!.settings.homepage;

    const baseInput = {
      startsAt: '2028-04-12T01:00:00.000Z',
      endsAt: '2028-04-12T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
      venue: '深圳国际会议中心',
      city: '深圳',
      address: '深圳市南山区测试路 8 号',
      templateVersionId: template!.versionId,
    };
    const publicEvent = await eventsService.createEvent(DEMO_IDS.organization, DEMO_IDS.adminUser, {
      ...baseInput,
      name: '首页默认大会验收场',
      shortName: '首页验收',
      slug: publicSlug,
    });
    publicEventId = publicEvent.id;
    createdEventIds.push(publicEventId);
    const draftEvent = await eventsService.createEvent(DEMO_IDS.organization, DEMO_IDS.adminUser, {
      ...baseInput,
      name: '首页草稿大会验收场',
      shortName: '草稿验收',
      slug: draftSlug,
    });
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
    await database
      .db!.update(organizations)
      .set({
        settings:
          previousHomepageSettings === undefined
            ? sql`${organizations.settings} - 'homepage'`
            : sql`jsonb_set(${organizations.settings}, '{homepage}', ${JSON.stringify(previousHomepageSettings)}::jsonb, true)`,
      })
      .where(eq(organizations.id, DEMO_IDS.organization));
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
    for (const versionId of createdVersionIds) {
      await database
        .db!.delete(conferenceTemplateVersions)
        .where(eq(conferenceTemplateVersions.id, versionId));
    }
    await database.onModuleDestroy();
  });

  it('reports and discards navigation targets removed by a replacement template in a draft', async () => {
    const binding = await templatesService.binding(DEMO_IDS.organization, draftEventId);
    const [original] = await database
      .db!.select()
      .from(conferenceTemplateVersions)
      .where(eq(conferenceTemplateVersions.id, binding.templateVersionId));
    const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    if (definition.presentation.kind !== 'structured')
      throw new Error('Expected structured fixture');
    definition.presentation.home.blocks = definition.presentation.home.blocks.filter(
      (item) => item.nodeKey !== 'home.upgrade',
    );
    const legacyCopy = definition.presentation.home.blocks.find(
      (item) => item.nodeKey === 'home.navigation',
    )!.content;
    legacyCopy.whyLabel = '旧'.repeat(17);
    legacyCopy.editionLabel = '';
    const versionId = randomUUID();
    await database
      .db!.insert(conferenceTemplateVersions)
      .values({ ...original!, id: versionId, version: Math.floor(Date.now() / 1000), definition });
    createdVersionIds.push(versionId);
    await database.db!.insert(eventTemplateOverrides).values({
      eventId: draftEventId,
      surface: 'home',
      revision: 1,
      contentDigest: 'test',
      document: {
        'home.navigation': {
          content: {
            items: [
              {
                id: 'upgrade',
                label: '本届升级',
                kind: 'section',
                target: 'home.upgrade',
                enabled: true,
                newWindow: false,
              },
            ],
          },
        },
      },
    });
    const input = {
      templateVersionId: versionId,
      revision: binding.revision,
      conflictResolutions: {},
    };
    await expect(
      templatesService.updateBinding(
        DEMO_IDS.organization,
        draftEventId,
        DEMO_IDS.adminUser,
        input,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await templatesService.binding(DEMO_IDS.organization, draftEventId)).templateVersionId,
    ).toBe(binding.templateVersionId);
    await templatesService.updateBinding(DEMO_IDS.organization, draftEventId, DEMO_IDS.adminUser, {
      ...input,
      conflictResolutions: { home: 'discard' },
    });
    await expect(
      templatesService.experience(DEMO_IDS.organization, draftEventId),
    ).resolves.toMatchObject({ validation: { valid: true } });
    expect(
      EventExperienceSchema.safeParse(
        await templatesService.experience(DEMO_IDS.organization, draftEventId),
      ).success,
    ).toBe(true);
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

  it('keeps default business routing while the root homepage is empty', async () => {
    const current = await organizationsService.getHomepageConfiguration(DEMO_IDS.organization);
    const empty = await organizationsService.updateHomepageConfiguration(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      {
        mode: 'empty',
        revision: current.revision,
      },
    );
    expect(empty).toMatchObject({
      mode: 'empty',
      eventId: publicEventId,
      revision: current.revision + 1,
    });
    await expect(repository.getPublicHomepageEvent(organizationSlug)).resolves.toMatchObject({
      id: publicEventId,
    });
    const summaries = await eventsService.listEvents(DEMO_IDS.organization);
    expect(summaries.find((event) => event.id === publicEventId)).toMatchObject({
      isHomepageDefault: false,
      isDefaultEvent: true,
    });
    await expect(
      organizationsService.updateHomepageConfiguration(DEMO_IDS.organization, DEMO_IDS.adminUser, {
        mode: 'event',
        revision: current.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      organizationsService.getHomepageConfiguration(DEMO_IDS.organization),
    ).resolves.toMatchObject(empty);
  });

  it('restores root display through the existing set-as-homepage operation', async () => {
    await organizationsService.setHomepageEvent(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      publicEventId,
    );
    await expect(
      organizationsService.getHomepageConfiguration(DEMO_IDS.organization),
    ).resolves.toMatchObject({ mode: 'event', eventId: publicEventId });
  });

  it('rejects draft defaults even in empty mode and serializes simultaneous updates', async () => {
    const current = await organizationsService.getHomepageConfiguration(DEMO_IDS.organization);
    await expect(
      organizationsService.updateHomepageConfiguration(DEMO_IDS.organization, DEMO_IDS.adminUser, {
        mode: 'empty',
        eventId: draftEventId,
        revision: current.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const updates = await Promise.allSettled(
      [0, 1].map(() =>
        organizationsService.updateHomepageConfiguration(
          DEMO_IDS.organization,
          DEMO_IDS.adminUser,
          {
            mode: 'empty',
            revision: current.revision,
          },
        ),
      ),
    );
    expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(updates.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await organizationsService.setHomepageEvent(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      publicEventId,
    );
  });

  it('allows a fresh organization to remain empty and rejects showing a missing default', async () => {
    const id = randomUUID();
    await database
      .db!.insert(organizations)
      .values({ id, slug: `empty-${id}`, name: '空白首页验收', settings: {} });
    try {
      await expect(organizationsService.getHomepageConfiguration(id)).resolves.toMatchObject({
        mode: 'empty',
        eventId: null,
        revision: 0,
      });
      await expect(
        organizationsService.updateHomepageConfiguration(id, DEMO_IDS.adminUser, {
          mode: 'event',
          revision: 0,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        organizationsService.updateHomepageConfiguration(id, DEMO_IDS.adminUser, {
          mode: 'event',
          eventId: publicEventId,
          revision: 0,
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await database.db!.delete(organizations).where(eq(organizations.id, id));
    }
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
    await expect(repository.resolvePublicEventRoute(publicSlug, organizationSlug)).resolves.toEqual(
      {
        eventId: publicEventId,
        slug: nextSlug,
        isAlias: true,
      },
    );
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
