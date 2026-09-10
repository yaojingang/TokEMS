import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS, type EventId } from '@conference/contracts';
import {
  auditLogs,
  conferenceTemplates,
  conferenceTemplateVersions,
  customerProfiles,
  customerUsers,
  eventReleases,
  events,
  inventoryReservations,
  orderItems,
  orders,
  organizations,
  payments,
  registrations,
  ticketTypes,
  waitlistEntries,
} from '@conference/database';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { ConferenceRepository } from './conference.repository.js';
import { CustomerAccountService } from './customer-account.service.js';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import { DatabaseService } from './database.service.js';
import { EventOperationsService } from './event-operations.service.js';
import { EventReleaseActivationService } from './event-release-activation.service.js';
import { OrderItemsService } from './order-items.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('live event settings activation', () => {
  const database = new DatabaseService();
  const activation = new EventReleaseActivationService(database);
  const operations = new EventOperationsService(database, activation);
  const repository = new ConferenceRepository(database, activation);
  const account = new CustomerAccountService(database);
  const slug = `live-settings-${randomUUID().slice(0, 8)}`;
  let eventId: EventId;
  let organizationSlug: string;

  async function deleteOrderFixture(orderId: string) {
    await database.db!.transaction(async (tx) => {
      await tx.delete(inventoryReservations).where(eq(inventoryReservations.orderId, orderId));
      await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await tx.delete(orders).where(eq(orders.id, orderId));
    });
  }

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
      socialLinks: [],
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
    const createdSpeaker = await operations.createSpeaker(
      DEMO_IDS.organization,
      eventId,
      DEMO_IDS.adminUser,
      {
        name: '离线编辑嘉宾',
        role: '大会测试嘉宾',
        topic: '重新上线采用完整草稿',
        initials: '离线',
        accentFrom: '#2448a8',
        accentTo: '#102759',
        tags: ['回归测试'],
        bio: '长期参与大会内容与增长实践。',
        topicAbstract: '介绍完整草稿重新上线后的公开资料行为。',
        websiteUrl: 'https://example.com/speakers/offline-editor',
        socialLinks: [{ label: '公开主页', url: 'https://example.com/offline-editor' }],
        sortOrder: 100,
      },
    );

    await repository.updateEvent(
      eventId,
      { status: 'prepublished' },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );

    const publicEvent = await repository.getPublicEvent(slug, organizationSlug);
    expect(publicEvent.city).toBe('苏州');
    expect(publicEvent.speakers.some((item) => item.name === '离线编辑嘉宾')).toBe(true);
    await expect(
      repository.getPublicSpeaker(slug, organizationSlug, createdSpeaker.id),
    ).resolves.toMatchObject({
      name: '离线编辑嘉宾',
      bio: '长期参与大会内容与增长实践。',
      topicAbstract: '介绍完整草稿重新上线后的公开资料行为。',
      eventSlug: slug,
      socialLinks: [{ label: '公开主页' }],
    });
    await expect(
      repository.getPublicSpeaker(slug, organizationSlug, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('edits, orders, isolates, and removes public speaker profiles transactionally', async () => {
    const managedSpeaker = await operations.createSpeaker(
      DEMO_IDS.organization,
      eventId,
      DEMO_IDS.adminUser,
      {
        publicCode: 'qwer',
        name: '嘉宾管理验收',
        role: '大会内容负责人',
        topic: '嘉宾资料管理与发布',
        accentFrom: '#2448a8',
        accentTo: '#102759',
        tags: ['管理验收'],
        socialLinks: [],
        sortOrder: 101,
      },
    );
    await operations.updateSpeaker(
      DEMO_IDS.organization,
      eventId,
      managedSpeaker.id,
      DEMO_IDS.adminUser,
      { publicCode: 'asdf', bio: '保存后立即进入当前生效快照。' },
    );
    const updatedManagedSpeaker = await operations.getSpeaker(
      DEMO_IDS.organization,
      eventId,
      managedSpeaker.id,
    );
    expect(managedSpeaker.publicCode).toBe('qwer');
    expect(updatedManagedSpeaker.publicCode).toBe('asdf');
    const [speakerAudit] = await database
      .db!.select({ before: auditLogs.before, after: auditLogs.after })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'speaker.update'), eq(auditLogs.resourceId, managedSpeaker.id)),
      )
      .limit(1);
    expect(speakerAudit?.before).toMatchObject({ publicCode: 'qwer' });
    expect(speakerAudit?.after).toMatchObject({ publicCode: 'asdf' });

    const collisionSpeaker = await operations.createSpeaker(
      DEMO_IDS.organization,
      eventId,
      DEMO_IDS.adminUser,
      {
        publicCode: 'tsta',
        name: '嘉宾短地址冲突验收',
        role: '大会测试嘉宾',
        topic: '公开地址冲突回滚',
        accentFrom: '#2448a8',
        accentTo: '#102759',
        tags: ['管理验收'],
        socialLinks: [],
        sortOrder: 102,
      },
    );
    expect(collisionSpeaker.publicCode).toBe('tsta');
    await expect(
      operations.updateSpeaker(
        DEMO_IDS.organization,
        eventId,
        managedSpeaker.id,
        DEMO_IDS.adminUser,
        { publicCode: collisionSpeaker.publicCode, bio: '这段内容应随冲突一起回滚。' },
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      operations.getSpeaker(DEMO_IDS.organization, eventId, managedSpeaker.id),
    ).resolves.toMatchObject({
      publicCode: 'asdf',
      bio: '保存后立即进入当前生效快照。',
    });
    await expect(
      repository.getPublicSpeaker(slug, organizationSlug, managedSpeaker.id),
    ).resolves.toMatchObject({ bio: '保存后立即进入当前生效快照。' });
    await expect(
      repository.getPublicSpeakerByCode(organizationSlug, updatedManagedSpeaker.publicCode),
    ).resolves.toMatchObject({
      id: managedSpeaker.id,
      publicCode: updatedManagedSpeaker.publicCode,
      bio: '保存后立即进入当前生效快照。',
    });
    await expect(
      repository.getPublicSpeakerByCode(
        `other-${organizationSlug}`,
        updatedManagedSpeaker.publicCode,
      ),
    ).rejects.toMatchObject({ status: 404 });

    const currentSpeakers = await operations.listSpeakers(DEMO_IDS.organization, eventId);
    const reversedIds = currentSpeakers.map((speaker) => speaker.id).reverse();
    const releaseCount = (await operations.listReleases(DEMO_IDS.organization, eventId)).length;
    await operations.reorderSpeakers(
      DEMO_IDS.organization,
      eventId,
      DEMO_IDS.adminUser,
      reversedIds,
    );
    expect(
      (await operations.listSpeakers(DEMO_IDS.organization, eventId)).map((speaker) => speaker.id),
    ).toEqual(reversedIds);
    expect(await operations.listReleases(DEMO_IDS.organization, eventId)).toHaveLength(
      releaseCount + 1,
    );

    await expect(
      operations.reorderSpeakers(
        DEMO_IDS.organization,
        eventId,
        DEMO_IDS.adminUser,
        reversedIds.slice(1),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await operations.listReleases(DEMO_IDS.organization, eventId)).toHaveLength(
      releaseCount + 1,
    );
    await expect(
      operations.getSpeaker(randomUUID(), eventId, managedSpeaker.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      operations.updateSpeaker(
        DEMO_IDS.organization,
        eventId,
        managedSpeaker.id,
        DEMO_IDS.adminUser,
        { avatarAssetId: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 400 });

    const restorableRelease = (await operations.listReleases(DEMO_IDS.organization, eventId))[0]!;
    await operations.deleteSpeaker(
      DEMO_IDS.organization,
      eventId,
      managedSpeaker.id,
      DEMO_IDS.adminUser,
    );
    await expect(
      repository.getPublicSpeaker(slug, organizationSlug, managedSpeaker.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      repository.getPublicSpeakerByCode(organizationSlug, updatedManagedSpeaker.publicCode),
    ).rejects.toMatchObject({ status: 404 });

    await operations.rollbackRelease(
      DEMO_IDS.organization,
      eventId,
      restorableRelease.id,
      DEMO_IDS.adminUser,
    );
    await expect(
      repository.getPublicSpeakerByCode(organizationSlug, updatedManagedSpeaker.publicCode),
    ).resolves.toMatchObject({ id: managedSpeaker.id });
  });

  it('publishes configurable profile fields to the public registration and payment flow', async () => {
    const [current] = await operations.listForms(DEMO_IDS.organization, eventId);
    const fieldLabel = `参会姓名 ${randomUUID().slice(0, 4)}`;
    const published = await operations.publishForm(
      DEMO_IDS.organization,
      eventId,
      DEMO_IDS.adminUser,
      {
        name: current!.name,
        fields: current!.fields
          .filter((field) => field.key !== 'title' && field.key !== 'city')
          .map((field) => {
            if (field.key === 'name') return { ...field, label: fieldLabel };
            if (field.key === 'company') return { ...field, required: false };
            return field;
          }),
        termsVersion: current!.termsVersion,
        termsContent: current!.termsContent,
      },
    );

    const publicEvent = await repository.getPublicEvent(slug, organizationSlug);
    expect(publicEvent.registrationForm).toMatchObject({ version: published.version });
    expect(publicEvent.registrationForm?.fields.find((field) => field.key === 'name')?.label).toBe(
      fieldLabel,
    );
    expect(
      publicEvent.registrationForm?.fields.find((field) => field.key === 'company'),
    ).toMatchObject({ required: false });
    expect(publicEvent.registrationForm?.fields.some((field) => field.key === 'title')).toBe(false);
    expect(publicEvent.registrationForm?.fields.some((field) => field.key === 'city')).toBe(false);
    expect((await operations.listReleases(DEMO_IDS.organization, eventId))[0]).toMatchObject({
      changeScope: 'form',
      active: true,
    });

    const releaseCount = (await operations.listReleases(DEMO_IDS.organization, eventId)).length;
    const unchanged = await operations.publishForm(
      DEMO_IDS.organization,
      eventId,
      DEMO_IDS.adminUser,
      {
        name: published.name,
        fields: published.fields,
        termsVersion: published.termsVersion,
        termsContent: published.termsContent,
      },
    );
    expect(unchanged.version).toBe(published.version);
    expect(await operations.listReleases(DEMO_IDS.organization, eventId)).toHaveLength(
      releaseCount,
    );
  });

  it('identifies the active form and repairs drift when the saved form is submitted again', async () => {
    const forms = await operations.listForms(DEMO_IDS.organization, eventId);
    const saved = forms[0]!;
    const active = (await operations.listReleases(DEMO_IDS.organization, eventId)).find(
      (release) => release.active,
    )!;
    const oldForm = forms[1]!;
    await database
      .db!.update(eventReleases)
      .set({
        snapshot: sql`jsonb_set(${eventReleases.snapshot}, '{registrationForm}', ${JSON.stringify(oldForm)}::jsonb)`,
      })
      .where(and(eq(eventReleases.eventId, eventId), eq(eventReleases.id, active.id)));
    const before = await operations.listForms(DEMO_IDS.organization, eventId);
    expect(before.find((form) => form.active)?.version).toBe(oldForm.version);
    const repaired = await operations.publishForm(
      DEMO_IDS.organization,
      eventId,
      DEMO_IDS.adminUser,
      saved,
    );
    expect(repaired.version).toBe(saved.version);
    expect(
      (await repository.getPublicEvent(slug, organizationSlug)).registrationForm?.version,
    ).toBe(saved.version);
    expect(
      (await operations.listForms(DEMO_IDS.organization, eventId)).find((form) => form.active)
        ?.version,
    ).toBe(saved.version);
  });

  it('protects ownership and preserves closed purchase intents while replacing ended seats', async () => {
    const currentEvent = await repository.getAdminEvent(eventId, DEMO_IDS.organization);
    if (currentEvent.status === 'configuring') {
      await repository.updateEvent(
        eventId,
        { status: 'prepublished' },
        DEMO_IDS.adminUser,
        DEMO_IDS.organization,
      );
    }
    const publishableEvent = await repository.getAdminEvent(eventId, DEMO_IDS.organization);
    if (publishableEvent.status === 'prepublished') {
      await repository.updateEvent(
        eventId,
        { status: 'registration_open' },
        DEMO_IDS.adminUser,
        DEMO_IDS.organization,
      );
    }
    await repository.updateEvent(
      eventId,
      { settings: { registration: { registrationOpen: true } } },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    const publicEvent = await repository.getPublicEvent(slug, organizationSlug);
    const ticket = publicEvent.tickets[0]!;
    const form = publicEvent.registrationForm!;
    const ownerId = randomUUID();
    const otherCustomerId = randomUUID();
    const suffix = String(Date.now()).slice(-8);
    const ownerMobile = `+86138${suffix}`;
    const otherMobile = `+86139${suffix}`;
    const db = database.db!;
    await db.insert(customerUsers).values([
      {
        id: ownerId,
        organizationId: DEMO_IDS.organization,
        mobileE164: ownerMobile,
        verifiedAt: new Date(),
      },
      {
        id: otherCustomerId,
        organizationId: DEMO_IDS.organization,
        mobileE164: otherMobile,
        verifiedAt: new Date(),
      },
    ]);
    await db.insert(customerProfiles).values([
      { customerUserId: ownerId, realName: '报名归属验收用户' },
      { customerUserId: otherCustomerId, realName: '报名归属冲突用户' },
    ]);
    const input = {
      eventId,
      ticketTypeId: ticket.id,
      attendee: {
        name: '报名归属验收用户',
        mobile: ownerMobile,
        email: `registration-owner-${suffix}@example.com`,
        company: '报名归属验收公司',
        title: '验收负责人',
        city: '深圳',
      },
      invoiceRequired: false,
      marketingConsent: false,
      termsAccepted: true as const,
      purchaseFor: 'self' as const,
      purchaseIntentId: randomUUID(),
      proxyAuthorizationAccepted: false,
      formVersion: form.version,
      termsVersion: form.termsVersion,
    };
    const owner: AuthenticatedCustomer & {
      mobile: string;
      profile: {
        nickname: null;
        realName: string;
        email: null;
        company: null;
        title: null;
        city: null;
      };
    } = {
      sessionId: randomUUID(),
      customerUserId: ownerId,
      organizationId: DEMO_IDS.organization,
      tokenHash: 'registration-owner-token-hash',
      expiresAt: new Date(Date.now() + 60_000),
      csrfToken: 'registration-owner-csrf-token',
      mobile: ownerMobile,
      profile: {
        nickname: null,
        realName: '报名归属验收用户',
        email: null,
        company: null,
        title: null,
        city: null,
      },
      customer: {
        id: 101,
        organizationId: DEMO_IDS.organization,
        mobile: ownerMobile,
        maskedMobile: ownerMobile,
        status: 'active',
        verifiedAt: new Date().toISOString(),
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
        profile: {
          nickname: null,
          realName: '报名归属验收用户',
          email: null,
          company: null,
          title: null,
          city: null,
          version: 1,
        },
      },
    };
    const otherCustomer = {
      customerUserId: otherCustomerId,
      organizationId: DEMO_IDS.organization,
      mobile: otherMobile,
      profile: {
        nickname: null,
        realName: '报名归属冲突用户',
        email: null,
        company: null,
        title: null,
        city: null,
      },
    };
    let orderId: string | undefined;
    let registrationId: string | undefined;
    const fixtureOrderIds = new Set<string>();
    const fixtureRegistrationIds = new Set<string>();
    try {
      const concurrentCheckouts = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          repository.createCheckout(input, `registration-owner-create-${suffix}-${index}`, owner),
        ),
      );
      expect(new Set(concurrentCheckouts.map((checkout) => checkout.registration.id))).toHaveLength(
        1,
      );
      expect(new Set(concurrentCheckouts.map((checkout) => checkout.order.id))).toHaveLength(1);
      const checkout = concurrentCheckouts[0]!;
      orderId = checkout.order.id;
      registrationId = checkout.registration.id;
      fixtureOrderIds.add(orderId);
      fixtureRegistrationIds.add(registrationId);
      await db
        .update(registrations)
        .set({ attendeeMobileE164: otherMobile, updatedAt: new Date() })
        .where(eq(registrations.id, registrationId));

      await expect(
        repository.createCheckout(
          { ...input, attendee: { ...input.attendee, mobile: otherMobile } },
          `registration-owner-conflict-${suffix}`,
          otherCustomer,
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'INVALID_STATE_TRANSITION',
          details: { clientId: input.purchaseIntentId, field: 'mobile' },
        },
        status: 409,
      });
      const [protectedRegistration] = await db
        .select()
        .from(registrations)
        .where(eq(registrations.id, registrationId));
      expect(protectedRegistration).toMatchObject({ customerUserId: ownerId, supersededAt: null });
      expect(
        await db.select().from(orders).where(eq(orders.purchaserCustomerUserId, otherCustomerId)),
      ).toHaveLength(0);

      await db
        .update(orders)
        .set({ expiresAt: new Date(Date.now() - 60_000), updatedAt: new Date() })
        .where(eq(orders.id, orderId));
      const expiredContext = await account.purchaseContext(owner, eventId);
      expect(expiredContext).toMatchObject({
        myAttendance: { registrationId, registrationStatus: 'pending_payment' },
        selfRegistrationState: 'closed',
        resumePaymentOrderId: null,
      });
      expect(expiredContext.recommendedActions).toContain('register_self');

      const [oldPayment] = await db
        .insert(payments)
        .values({
          orderId,
          provider: 'wechatpay',
          channel: 'native',
          outTradeNo: `OLD${suffix}`,
          status: 'pending',
          amount: checkout.order.amount,
          currency: checkout.order.currency,
          prepayExpiresAt: new Date(Date.now() + 60_000),
          payload: { codeUrl: `weixin://wxpay/bizpayurl?pr=closed-${suffix}` },
        })
        .returning({ id: payments.id });
      const confirmingContext = await account.purchaseContext(owner, eventId);
      expect(confirmingContext.selfRegistrationState).toBe('active');
      expect(confirmingContext.myPurchases).toMatchObject({
        pendingCount: 1,
        activeSeatCount: 1,
      });
      expect(confirmingContext.recommendedActions).not.toContain('register_self');
      const confirmingPublicEvent = await repository.getPublicEvent(slug, organizationSlug);
      expect(confirmingPublicEvent.tickets.find((item) => item.id === ticket.id)?.remaining).toBe(
        ticket.remaining - 1,
      );
      const [ticketInventory] = await db
        .select({ sold: ticketTypes.sold })
        .from(ticketTypes)
        .where(eq(ticketTypes.id, ticket.id))
        .limit(1);
      await expect(
        operations.updateTicketType(DEMO_IDS.organization, eventId, ticket.id, DEMO_IDS.adminUser, {
          capacity: ticketInventory!.sold,
        }),
      ).rejects.toMatchObject({
        response: { code: 'INVENTORY_UNAVAILABLE' },
        status: 409,
      });
      await expect(
        repository.createCheckout(
          {
            ...input,
            attendee: {
              ...input.attendee,
              name: '延迟支付期间的代购参会人',
              mobile: `+86137${suffix}`,
              email: `registration-delayed-proxy-${suffix}@example.com`,
            },
            purchaseFor: 'other',
            purchaseIntentId: randomUUID(),
            proxyAuthorizationAccepted: true,
          },
          `registration-delayed-proxy-${suffix}`,
          owner,
        ),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_STATE_TRANSITION' },
        status: 409,
      });
      await db
        .update(payments)
        .set({
          status: 'closed',
          prepayExpiresAt: new Date(Date.now() - 60_000),
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(payments.id, oldPayment!.id));

      await db
        .update(registrations)
        .set({ attendeeMobileE164: ownerMobile, updatedAt: new Date() })
        .where(eq(registrations.id, registrationId));
      await db.transaction(async (tx) => {
        const [lockedOrder] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, orderId!))
          .for('update');
        await new OrderItemsService(database).cancelUnpaidItems(tx, lockedOrder!);
      });

      const closedContext = await account.purchaseContext(owner, eventId);
      expect(closedContext).toMatchObject({
        myAttendance: { registrationId, registrationStatus: 'cancelled' },
        selfRegistrationState: 'closed',
        resumePaymentOrderId: null,
      });
      expect(closedContext.recommendedActions).toContain('register_self');
      expect(closedContext.recommendedActions).not.toContain('resume_payment');

      const blockingRegistrationId = randomUUID();
      const blockingOrderId = randomUUID();
      fixtureRegistrationIds.add(blockingRegistrationId);
      fixtureOrderIds.add(blockingOrderId);
      await db.insert(registrations).values({
        id: blockingRegistrationId,
        organizationId: DEMO_IDS.organization,
        eventId,
        ticketTypeId: ticket.id,
        customerUserId: null,
        registrationCode: `BLOCK-${suffix}`,
        status: 'pending_payment',
        attendee: {
          name: '待支付代购参会人',
          mobile: otherMobile,
          email: `registration-blocking-${suffix}@example.com`,
          company: '',
          title: '',
          city: '深圳',
        },
        attendeeMobileE164: otherMobile,
        attendeeEmailNormalized: `registration-blocking-${suffix}@example.com`,
        consentSnapshot: { purchaseFor: 'other' },
      });
      await db.insert(orders).values({
        id: blockingOrderId,
        organizationId: DEMO_IDS.organization,
        eventId,
        registrationId: blockingRegistrationId,
        purchaserCustomerUserId: ownerId,
        purchaseIntentId: randomUUID(),
        orderNo: `BLOCK-${suffix}`,
        status: 'pending_payment',
        amount: checkout.order.amount,
        currency: checkout.order.currency,
        pricingSnapshot: {},
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      const blockedContext = await account.purchaseContext(owner, eventId);
      expect(blockedContext.recommendedActions).not.toContain('register_self');
      const replacementInput = { ...input, purchaseIntentId: randomUUID() };
      await expect(
        repository.createCheckout(replacementInput, `blocked-replacement-${suffix}`, owner),
      ).rejects.toMatchObject({ response: { code: 'INVALID_STATE_TRANSITION' }, status: 409 });
      await deleteOrderFixture(blockingOrderId);
      await db.delete(registrations).where(eq(registrations.id, blockingRegistrationId));

      const replayedClosed = await repository.createCheckout(
        input,
        `registration-owner-create-${suffix}-0`,
        owner,
      );
      expect(replayedClosed.registration.id).toBe(registrationId);
      expect(replayedClosed.order).toMatchObject({
        id: orderId,
        orderNo: checkout.order.orderNo,
        status: 'closed',
      });
      expect(new Date(replayedClosed.order.expiresAt).getTime()).toBeLessThan(Date.now());
      const replacements = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          repository.createCheckout(replacementInput, `replacement-${suffix}-${index}`, owner),
        ),
      );
      const replacement = replacements[0]!;
      fixtureOrderIds.add(replacement.order.id);
      fixtureRegistrationIds.add(replacement.registration.id);
      expect(new Set(replacements.map((result) => result.order.id))).toHaveLength(1);
      expect(new Set(replacements.map((result) => result.registration.id))).toHaveLength(1);
      expect(replacement.order.id).not.toBe(orderId);
      expect(replacement.registration.id).not.toBe(registrationId);
      expect(replacement.order.orderNo).not.toBe(checkout.order.orderNo);
      expect(replacement.order.status).toBe('pending_payment');
      expect(new Date(replacement.order.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const [endedRegistration] = await db
        .select()
        .from(registrations)
        .where(eq(registrations.id, registrationId));
      expect(endedRegistration).toMatchObject({
        customerUserId: ownerId,
        status: 'cancelled',
        supersededAt: expect.any(Date),
        supersededByRegistrationId: replacement.registration.id,
      });
      const [endedOrder] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(endedOrder).toMatchObject({
        status: 'closed',
        purchaseIntentId: input.purchaseIntentId,
        purchaserCustomerUserId: ownerId,
      });
      expect(await db.select().from(payments).where(eq(payments.id, oldPayment!.id))).toMatchObject(
        [{ orderId, status: 'closed' }],
      );
      await expect(repository.getOrder(orderId, checkout.orderAccessToken!)).resolves.toMatchObject(
        { id: orderId, status: 'closed' },
      );
      await expect(
        repository.getOrder(replacement.order.id, checkout.orderAccessToken!),
      ).rejects.toMatchObject({ response: { code: 'UNAUTHORIZED' }, status: 401 });
      await expect(
        repository.getOrder(replacement.order.id, replacement.orderAccessToken!),
      ).resolves.not.toHaveProperty('paymentUrl');
      const [activeReservationCount] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(inventoryReservations)
        .where(
          and(
            sql`${inventoryReservations.orderId} in (${orderId}, ${replacement.order.id})`,
            isNull(inventoryReservations.releasedAt),
            isNull(inventoryReservations.convertedAt),
          ),
        );
      expect(Number(activeReservationCount?.value ?? 0)).toBe(1);
      const replacementContext = await account.purchaseContext(owner, eventId);
      expect(replacementContext).toMatchObject({
        myAttendance: {
          registrationId: replacement.registration.id,
          registrationStatus: 'pending_payment',
        },
        selfRegistrationState: 'active',
        resumePaymentOrderId: replacement.order.id,
        myPurchases: { pendingCount: 1, activeSeatCount: 1 },
      });
      expect(replacementContext.recommendedActions).toContain('resume_payment');
      expect(replacementContext.recommendedActions).not.toContain('register_self');

      const paid = await repository.confirmMockPayment(
        replacement.order.id,
        `registration-owner-paid-${suffix}`,
      );
      expect(paid.order.status).toBe('paid');
      await db.update(events).set({ status: 'prepublished' }).where(eq(events.id, eventId));

      const repeatedPaid = await repository.createCheckout(
        replacementInput,
        `registration-owner-paid-repeat-${suffix}`,
        owner,
      );
      expect(repeatedPaid.registration.id).toBe(replacement.registration.id);
      expect(repeatedPaid.order.id).toBe(replacement.order.id);
      expect(repeatedPaid.order.status).toBe('paid');

      await expect(
        repository.createCheckout(input, `closed-history-${suffix}`, owner),
      ).resolves.toMatchObject({
        registration: { id: registrationId, status: 'cancelled' },
        order: { id: orderId, status: 'closed' },
      });
      await expect(
        repository.getOrder(orderId, repeatedPaid.orderAccessToken!),
      ).rejects.toMatchObject({ status: 401 });

      const eventRegistrations = await db
        .select({ id: registrations.id, supersededAt: registrations.supersededAt })
        .from(registrations)
        .where(and(eq(registrations.eventId, eventId), eq(registrations.customerUserId, ownerId)));
      expect(eventRegistrations).toHaveLength(2);
      expect(eventRegistrations.filter((row) => !row.supersededAt)).toEqual([
        { id: replacement.registration.id, supersededAt: null },
      ]);
    } finally {
      for (const id of fixtureOrderIds) await deleteOrderFixture(id);
      for (const id of fixtureRegistrationIds)
        await db.delete(registrations).where(eq(registrations.id, id));
      await db
        .delete(customerUsers)
        .where(sql`${customerUsers.id} in (${ownerId}, ${otherCustomerId})`);
    }
  });

  it('replaces an ended legacy claimed proxy seat without transferring its claim to the new purchase', async () => {
    const currentEvent = await repository.getAdminEvent(eventId, DEMO_IDS.organization);
    if (currentEvent.status !== 'registration_open') {
      await repository.updateEvent(
        eventId,
        { status: 'registration_open' },
        DEMO_IDS.adminUser,
        DEMO_IDS.organization,
      );
    }
    await repository.updateEvent(
      eventId,
      {
        settings: {
          registration: { registrationOpen: true, additionalPurchaseEnabled: true },
        },
      },
      DEMO_IDS.adminUser,
      DEMO_IDS.organization,
    );
    const publicEvent = await repository.getPublicEvent(slug, organizationSlug);
    const ticket = publicEvent.tickets[0]!;
    const form = publicEvent.registrationForm!;
    const purchaserId = randomUUID();
    const attendeeId = randomUUID();
    const suffix = String(Date.now()).slice(-8);
    const purchaserMobile = `+86136${suffix}`;
    const attendeeMobile = `+86137${suffix}`;
    const db = database.db!;
    await db.insert(customerUsers).values([
      {
        id: purchaserId,
        organizationId: DEMO_IDS.organization,
        mobileE164: purchaserMobile,
        verifiedAt: new Date(),
      },
      {
        id: attendeeId,
        organizationId: DEMO_IDS.organization,
        mobileE164: attendeeMobile,
        verifiedAt: new Date(),
      },
    ]);
    await db.insert(customerProfiles).values([
      { customerUserId: purchaserId, realName: '代购恢复验收购票人' },
      { customerUserId: attendeeId, realName: '代购恢复验收参会人' },
    ]);
    const input = {
      eventId,
      ticketTypeId: ticket.id,
      attendee: {
        name: '代购恢复验收参会人',
        mobile: attendeeMobile,
        email: `claimed-proxy-${suffix}@example.com`,
        company: '代购恢复验收公司',
        title: '验收负责人',
        city: '深圳',
      },
      invoiceRequired: false,
      marketingConsent: false,
      termsAccepted: true as const,
      purchaseFor: 'other' as const,
      purchaseIntentId: randomUUID(),
      proxyAuthorizationAccepted: true,
      formVersion: form.version,
      termsVersion: form.termsVersion,
    };
    const purchaser = {
      customerUserId: purchaserId,
      organizationId: DEMO_IDS.organization,
      mobile: purchaserMobile,
      profile: {
        nickname: null,
        realName: '代购恢复验收购票人',
        email: null,
        company: null,
        title: null,
        city: null,
      },
    };
    const orderId = randomUUID();
    const registrationId = randomUUID();
    let replacementOrderId: string | undefined;
    let replacementRegistrationId: string | undefined;
    try {
      const expiredAt = new Date(Date.now() - 60_000);
      // Legacy checkout allowed claiming before payment; migration preserves that ended ownership.
      await db.insert(registrations).values({
        id: registrationId,
        organizationId: DEMO_IDS.organization,
        eventId,
        ticketTypeId: ticket.id,
        customerUserId: attendeeId,
        registrationCode: `LEGACY-CLAIM-${suffix}`,
        status: 'cancelled',
        attendee: input.attendee,
        attendeeMobileE164: attendeeMobile,
        attendeeEmailNormalized: input.attendee.email,
        consentSnapshot: { purchaseFor: 'other', proxyAuthorizationAccepted: true },
      });
      await db.insert(orders).values({
        id: orderId,
        organizationId: DEMO_IDS.organization,
        eventId,
        registrationId,
        purchaserCustomerUserId: purchaserId,
        purchaseIntentId: input.purchaseIntentId,
        modelVersion: 1,
        orderNo: `LEGACY-CLAIM-${suffix}`,
        status: 'closed',
        amount: ticket.price,
        currency: ticket.currency,
        pricingSnapshot: {},
        expiresAt: expiredAt,
      });
      await db.insert(orderItems).values({
        orderId,
        registrationId,
        organizationId: DEMO_IDS.organization,
        eventId,
        ticketTypeId: ticket.id,
        position: 1,
        unitPrice: ticket.price,
        allocatedAmount: ticket.price,
        pricingSnapshot: {},
        state: 'cancelled',
        cancelledAt: expiredAt,
        inventoryReleasedAt: expiredAt,
      });

      const claimedAttendeeContext = await account.purchaseContext(
        {
          customerUserId: attendeeId,
          organizationId: DEMO_IDS.organization,
        } as AuthenticatedCustomer,
        eventId,
      );
      expect(claimedAttendeeContext.selfRegistrationState).toBe('closed');
      expect(claimedAttendeeContext.recommendedActions).toContain('register_self');
      expect(claimedAttendeeContext.resumePaymentOrderId).toBeNull();

      const replacementInput = { ...input, purchaseIntentId: randomUUID() };
      const replacement = await repository.createCheckout(
        replacementInput,
        `claimed-proxy-replacement-${suffix}`,
        purchaser,
      );
      replacementOrderId = replacement.order.id;
      replacementRegistrationId = replacement.registration.id;
      expect(replacementRegistrationId).not.toBe(registrationId);
      expect(replacementOrderId).not.toBe(orderId);
      expect(replacement.order.status).toBe('pending_payment');
      const [persistedRegistration] = await db
        .select()
        .from(registrations)
        .where(eq(registrations.id, registrationId))
        .limit(1);
      expect(persistedRegistration).toMatchObject({
        customerUserId: attendeeId,
        status: 'cancelled',
        supersededAt: expect.any(Date),
        supersededByRegistrationId: replacementRegistrationId,
      });
      const [newRegistration] = await db
        .select()
        .from(registrations)
        .where(eq(registrations.id, replacementRegistrationId));
      expect(newRegistration).toMatchObject({
        customerUserId: null,
        status: 'pending_payment',
        supersededAt: null,
      });
      expect(await db.select().from(orders).where(eq(orders.id, orderId))).toMatchObject([
        {
          modelVersion: 1,
          status: 'closed',
          purchaserCustomerUserId: purchaserId,
          purchaseIntentId: input.purchaseIntentId,
        },
      ]);
      expect(await db.select().from(orders).where(eq(orders.id, replacementOrderId))).toMatchObject(
        [
          {
            modelVersion: 2,
            status: 'pending_payment',
            purchaserCustomerUserId: purchaserId,
            purchaseIntentId: replacementInput.purchaseIntentId,
          },
        ],
      );
      await expect(
        new OrderItemsService(database).detail(replacementOrderId, {
          organizationId: DEMO_IDS.organization,
          customerUserId: attendeeId,
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        repository.createCheckout(replacementInput, `claimed-proxy-replay-${suffix}`, purchaser),
      ).resolves.toMatchObject({
        registration: { id: replacementRegistrationId },
        order: { id: replacementOrderId },
      });
    } finally {
      if (replacementOrderId) await deleteOrderFixture(replacementOrderId);
      await deleteOrderFixture(orderId);
      if (replacementRegistrationId)
        await db.delete(registrations).where(eq(registrations.id, replacementRegistrationId));
      await db.delete(registrations).where(eq(registrations.id, registrationId));
      await db
        .delete(customerUsers)
        .where(sql`${customerUsers.id} in (${purchaserId}, ${attendeeId})`);
    }
  });
  it('keeps cleared optional fields empty and uses SMS for waitlist when email is disabled', async () => {
    const db = database.db!;
    const customerId = randomUUID();
    const mobile = `+86135${String(Date.now()).slice(-8)}`;
    let orderId: string | undefined;
    let registrationId: string | undefined;
    await db.insert(customerUsers).values({
      id: customerId,
      organizationId: DEMO_IDS.organization,
      mobileE164: mobile,
      verifiedAt: new Date(),
    });
    const actor = {
      customerUserId: customerId,
      organizationId: DEMO_IDS.organization,
      mobile,
      profile: {
        realName: '已有姓名',
        nickname: '已有昵称',
        email: 'profile@example.com',
        company: '已有公司',
        title: '已有职位',
        city: '已有城市',
      },
    };
    try {
      await repository.updateEvent(
        eventId,
        { status: 'registration_open' },
        DEMO_IDS.adminUser,
        DEMO_IDS.organization,
      );
      const [saved] = await operations.listForms(DEMO_IDS.organization, eventId);
      const optionalForm = await operations.publishForm(
        DEMO_IDS.organization,
        eventId,
        DEMO_IDS.adminUser,
        {
          name: saved!.name,
          termsVersion: saved!.termsVersion,
          termsContent: saved!.termsContent,
          fields: saved!.fields.map((field) => ({
            ...field,
            enabled: true,
            required: field.key === 'mobile',
          })),
        },
      );
      const event = await repository.getPublicEvent(slug, organizationSlug);
      const ticket = event.tickets[0]!;
      const checkout = await repository.createCheckout(
        {
          eventId,
          ticketTypeId: ticket.id,
          attendee: { name: '', mobile, email: '', company: '', title: '', city: '' },
          invoiceRequired: false,
          marketingConsent: false,
          termsAccepted: true,
          purchaseFor: 'self',
          purchaseIntentId: randomUUID(),
          proxyAuthorizationAccepted: false,
          formVersion: optionalForm.version,
          termsVersion: optionalForm.termsVersion,
        },
        randomUUID(),
        actor,
      );
      orderId = checkout.order.id;
      registrationId = checkout.registration.id;
      expect(checkout.registration.attendee).toEqual({
        name: '',
        mobile,
        email: '',
        company: '',
        title: '',
        city: '',
      });
      await operations.publishForm(DEMO_IDS.organization, eventId, DEMO_IDS.adminUser, {
        name: saved!.name,
        termsVersion: saved!.termsVersion,
        termsContent: saved!.termsContent,
        fields: [
          { key: 'mobile', label: '手机号', type: 'tel', required: true },
          { key: 'email', label: '邮箱', type: 'email', required: false, enabled: false },
        ],
      });
      // Fill this disposable event's capacity so the contact policy runs through the waitlist path.
      await db
        .update(ticketTypes)
        .set({ sold: ticket.remaining })
        .where(eq(ticketTypes.id, ticket.id));
      const entry = await repository.joinWaitlist(
        { eventId, ticketTypeId: ticket.id, name: '隐藏姓名', email: 'hidden@example.com', mobile },
        randomUUID(),
        actor,
      );
      expect(entry).toMatchObject({ name: '', email: '', mobile });
      const [stored] = await db
        .select()
        .from(waitlistEntries)
        .where(eq(waitlistEntries.id, entry.id));
      expect(stored).toMatchObject({ email: '', notificationChannel: 'sms', mobileE164: mobile });
    } finally {
      await db.delete(waitlistEntries).where(eq(waitlistEntries.customerUserId, customerId));
      if (orderId) await deleteOrderFixture(orderId);
      if (registrationId)
        await db.delete(registrations).where(eq(registrations.id, registrationId));
      await db.delete(customerUsers).where(eq(customerUsers.id, customerId));
    }
  });
});
