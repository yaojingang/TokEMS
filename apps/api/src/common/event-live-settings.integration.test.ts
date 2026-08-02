import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS, type EventId } from '@conference/contracts';
import {
  conferenceTemplates,
  conferenceTemplateVersions,
  eventReleases,
  events,
  organizations,
  ticketTypes,
} from '@conference/database';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { EventOperationsService } from './event-operations.service.js';
import { EventReleaseActivationService } from './event-release-activation.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('live event settings activation', () => {
  const database = new DatabaseService();
  const activation = new EventReleaseActivationService(database);
  const operations = new EventOperationsService(database, activation);
  const repository = new ConferenceRepository(database, activation);
  const slug = `live-settings-${randomUUID().slice(0, 8)}`;
  let eventId: EventId;
  let organizationSlug: string;

  beforeAll(async () => {
    const [template] = await database
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
      .limit(1);
    expect(template?.versionId).toBeTruthy();
    const [organization] = await database
      .db!.select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, DEMO_IDS.organization))
      .limit(1);
    expect(organization?.slug).toBeTruthy();
    organizationSlug = organization!.slug;
    const created = await operations.createEvent(DEMO_IDS.organization, DEMO_IDS.adminUser, {
      name: '保存即生效验收大会',
      shortName: '实时生效',
      slug,
      startsAt: '2027-08-20T01:00:00.000Z',
      endsAt: '2027-08-20T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
      venue: '深圳国际会议中心',
      city: '深圳',
      address: '深圳市南山区测试路 1 号',
      templateVersionId: template!.versionId,
    });
    eventId = created.id;
    await database
      .db!.update(events)
      .set({
        settings: sql`${events.settings} #- '{registration,accountMode}'`,
      })
      .where(eq(events.id, eventId));
    const [draftForm] = await operations.listForms(DEMO_IDS.organization, eventId);
    await operations.publishForm(DEMO_IDS.organization, eventId, DEMO_IDS.adminUser, {
      name: draftForm!.name,
      fields: draftForm!.fields,
      termsVersion: draftForm!.termsVersion,
      termsContent: draftForm!.termsContent,
    });
  });

  afterAll(async () => {
    if (eventId) await database.db!.delete(events).where(eq(events.id, eventId));
    await database.onModuleDestroy();
  });

  it('creates the first release when the lifecycle first becomes public', async () => {
    await repository.updateEvent(
      eventId,
      { status: 'prepublished' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );

    const releases = await operations.listReleases(DEMO_IDS.organization, eventId);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      version: 1,
      changeScope: 'lifecycle',
      activationKind: 'initial',
      active: true,
    });
    const publicEvent = await repository.getPublicEvent(slug, organizationSlug);
    expect(publicEvent.registration.accountMode).toBe('mobile_otp_required');
  });

  it('hides an existing release immediately while the lifecycle is not public', async () => {
    await repository.updateEvent(
      eventId,
      { status: 'configuring' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    await expect(repository.getPublicEvent(slug, organizationSlug)).rejects.toMatchObject({
      status: 404,
    });
    await expect(repository.getAdminEvent(eventId, DEMO_IDS.organization)).resolves.toMatchObject({
      status: 'configuring',
    });
    await repository.updateEvent(
      eventId,
      { status: 'prepublished' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
  });

  it('activates a saved change immediately and skips an identical save', async () => {
    const tagline = `保存即生效 ${randomUUID().slice(0, 8)}`;
    await repository.updateEvent(
      eventId,
      { tagline, status: 'prepublished' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    const publicEvent = await repository.getPublicEvent(slug, organizationSlug);
    expect(publicEvent.tagline).toBe(tagline);
    const releases = await operations.listReleases(DEMO_IDS.organization, eventId);
    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({
      changeScope: 'event',
      changeSummary: '更新大会基本信息',
    });

    await repository.updateEvent(
      eventId,
      { tagline, status: 'prepublished' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    expect(await operations.listReleases(DEMO_IDS.organization, eventId)).toHaveLength(2);
  });

  it('rolls the domain mutation back when the live snapshot is invalid', async () => {
    await expect(
      repository.updateEvent(
        eventId,
        { settings: { registration: { paymentMode: 'free' } } },
        DEMO_IDS.adminUser,
        DEMO_IDS.organization,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const [stored] = await database
      .db!.select({ settings: events.settings })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    expect(stored?.settings.registration?.paymentMode).toBe('ticketed');
    expect(await operations.listReleases(DEMO_IDS.organization, eventId)).toHaveLength(2);
  });

  it('serializes concurrent saves into complete monotonic releases', async () => {
    await Promise.all([
      repository.updateEvent(eventId, { city: '上海' }, DEMO_IDS.adminUser, DEMO_IDS.organization),
      repository.updateEvent(
        eventId,
        { venue: '上海国际会议中心' },
        DEMO_IDS.adminUser,
        DEMO_IDS.organization,
      ),
    ]);

    const rows = await database
      .db!.select({ version: eventReleases.version })
      .from(eventReleases)
      .where(eq(eventReleases.eventId, eventId));
    expect(rows.map((row) => row.version).sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4,
    ]);
    const publicEvent = await repository.getPublicEvent(slug, organizationSlug);
    expect(publicEvent.city).toBe('上海');
    expect(publicEvent.venue).toBe('上海国际会议中心');
  });

  it('keeps the rolled-back snapshot as the baseline for later module saves', async () => {
    const releases = await operations.listReleases(DEMO_IDS.organization, eventId);
    const firstRelease = releases.find((release) => release.version === 1)!;
    await operations.rollbackRelease(
      DEMO_IDS.organization,
      eventId,
      firstRelease.id,
      DEMO_IDS.adminUser,
    );
    await expect(repository.getAdminEvent(eventId, DEMO_IDS.organization)).resolves.toMatchObject({
      status: 'prepublished',
    });
    const rolledBack = await repository.getPublicEvent(slug, organizationSlug);

    await repository.updateEvent(
      eventId,
      { city: '杭州' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    const afterSave = await repository.getPublicEvent(slug, organizationSlug);
    expect(afterSave.city).toBe('杭州');
    expect(afterSave.tagline).toBe(rolledBack.tagline);
    expect(afterSave.venue).toBe(rolledBack.venue);
    expect(afterSave.tickets).toEqual(rolledBack.tickets);
  });

  it('keeps an offline lifecycle during rollback', async () => {
    await repository.updateEvent(
      eventId,
      { status: 'configuring' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    const releases = await operations.listReleases(DEMO_IDS.organization, eventId);
    const firstRelease = releases.find((release) => release.version === 1)!;

    await operations.rollbackRelease(
      DEMO_IDS.organization,
      eventId,
      firstRelease.id,
      DEMO_IDS.adminUser,
    );

    await expect(repository.getAdminEvent(eventId, DEMO_IDS.organization)).resolves.toMatchObject({
      status: 'configuring',
    });
    await expect(repository.getPublicEvent(slug, organizationSlug)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('validates the final scoped snapshot after a rollback', async () => {
    await repository.updateEvent(
      eventId,
      { status: 'prepublished' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    const adminEvent = await repository.getAdminEvent(eventId, DEMO_IDS.organization);
    for (const ticket of adminEvent.tickets) {
      await operations.updateTicketType(
        DEMO_IDS.organization,
        eventId,
        ticket.id,
        DEMO_IDS.adminUser,
        { price: 0 },
      );
    }
    await repository.updateEvent(
      eventId,
      { settings: { registration: { paymentMode: 'free' } } },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    const freeRelease = (await operations.listReleases(DEMO_IDS.organization, eventId)).find(
      (release) => release.active,
    )!;
    await repository.updateEvent(
      eventId,
      { settings: { registration: { paymentMode: 'ticketed' } } },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    const [ticket] = adminEvent.tickets;
    expect(ticket?.id).toBeTruthy();
    await operations.updateTicketType(
      DEMO_IDS.organization,
      eventId,
      ticket!.id,
      DEMO_IDS.adminUser,
      { price: 100 },
    );
    await operations.rollbackRelease(
      DEMO_IDS.organization,
      eventId,
      freeRelease.id,
      DEMO_IDS.adminUser,
    );

    await operations.createSpeaker(DEMO_IDS.organization, eventId, DEMO_IDS.adminUser, {
      name: '回滚基线嘉宾',
      role: '大会测试嘉宾',
      topic: '局部保存保持完整版本',
      initials: '回滚',
      accentFrom: '#2448a8',
      accentTo: '#102759',
      tags: ['回归测试'],
      sortOrder: 99,
    });

    const publicEvent = await repository.getPublicEvent(slug, organizationSlug);
    expect(publicEvent.status).toBe('prepublished');
    expect(publicEvent.tickets.find((item) => item.id === ticket!.id)?.price).toBe(0);
    expect(publicEvent.speakers.some((item) => item.name === '回滚基线嘉宾')).toBe(true);

    await repository.updateEvent(
      eventId,
      { settings: { registration: { paymentMode: 'ticketed' } } },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    await operations.updateTicketType(
      DEMO_IDS.organization,
      eventId,
      ticket!.id,
      DEMO_IDS.adminUser,
      { price: 100 },
    );
  });

  it('uses the rolled-back ticket capacity for public inventory', async () => {
    const before = await repository.getPublicEvent(slug, organizationSlug);
    const [ticket] = before.tickets;
    expect(ticket?.id).toBeTruthy();
    const target = (await operations.listReleases(DEMO_IDS.organization, eventId)).find(
      (release) => release.active,
    )!;
    const [current] = await database
      .db!.select({ capacity: ticketTypes.capacity })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticket!.id))
      .limit(1);
    expect(current?.capacity).toBeTruthy();

    await operations.updateTicketType(
      DEMO_IDS.organization,
      eventId,
      ticket!.id,
      DEMO_IDS.adminUser,
      { capacity: current!.capacity + 5 },
    );
    expect(
      (await repository.getPublicEvent(slug, organizationSlug)).tickets.find(
        (item) => item.id === ticket!.id,
      )?.remaining,
    ).toBe(ticket!.remaining + 5);

    await operations.rollbackRelease(DEMO_IDS.organization, eventId, target.id, DEMO_IDS.adminUser);
    expect(
      (await repository.getPublicEvent(slug, organizationSlug)).tickets.find(
        (item) => item.id === ticket!.id,
      )?.remaining,
    ).toBe(ticket!.remaining);
  });

  it('updates lifecycle and registration availability atomically', async () => {
    await repository.updateEvent(
      eventId,
      { settings: { registration: { registrationOpen: true } } },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    await expect(repository.getAdminEvent(eventId, DEMO_IDS.organization)).resolves.toMatchObject({
      status: 'registration_open',
      registration: { registrationOpen: true },
    });
    await expect(repository.getPublicEvent(slug, organizationSlug)).resolves.toMatchObject({
      status: 'registration_open',
      registration: { registrationOpen: true },
    });

    await repository.updateEvent(
      eventId,
      { settings: { registration: { registrationOpen: false } } },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    await expect(repository.getAdminEvent(eventId, DEMO_IDS.organization)).resolves.toMatchObject({
      status: 'prepublished',
      registration: { registrationOpen: false },
    });
  });

  it('publishes the complete draft when an offline event returns online', async () => {
    await repository.updateEvent(
      eventId,
      { status: 'configuring' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    await repository.updateEvent(
      eventId,
      { city: '苏州' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    await operations.createSpeaker(DEMO_IDS.organization, eventId, DEMO_IDS.adminUser, {
      name: '离线编辑嘉宾',
      role: '大会测试嘉宾',
      topic: '重新上线采用完整草稿',
      initials: '离线',
      accentFrom: '#2448a8',
      accentTo: '#102759',
      tags: ['回归测试'],
      sortOrder: 100,
    });

    await repository.updateEvent(
      eventId,
      { status: 'prepublished' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );

    const publicEvent = await repository.getPublicEvent(slug, organizationSlug);
    expect(publicEvent.city).toBe('苏州');
    expect(publicEvent.speakers.some((item) => item.name === '离线编辑嘉宾')).toBe(true);
  });
});
