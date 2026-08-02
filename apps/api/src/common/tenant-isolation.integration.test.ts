import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS, type EventId } from '@conference/contracts';
import {
  checkinLists,
  events,
  organizations,
  registrationForms,
  registrations,
  tickets,
  ticketTypes,
} from '@conference/database';
import { eq } from 'drizzle-orm';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { EventOperationsService } from './event-operations.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('PostgreSQL tenant isolation', () => {
  const organizationB = randomUUID();
  let eventA: EventId;
  let eventB: EventId;
  const ticketA = randomUUID();
  const ticketB = randomUUID();
  const registrationB = randomUUID();
  const issuedTicketB = randomUUID();
  const slug = `tenant-same-slug-${randomUUID().slice(0, 8)}`;
  const organizationBSlug = `tenant-b-${randomUUID().slice(0, 8)}`;
  let organizationASlug: string;
  const database = new DatabaseService();
  const repository = new ConferenceRepository(database);
  const operations = new EventOperationsService(database);

  beforeAll(async () => {
    const db = database.db!;
    const [organizationA] = await db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, DEMO_IDS.organization))
      .limit(1);
    expect(organizationA?.slug).toBeTruthy();
    organizationASlug = organizationA!.slug;
    await db.insert(organizations).values({
      id: organizationB,
      slug: organizationBSlug,
      name: '租户隔离验收组织 B',
    });
    const insertedEvents = await db
      .insert(events)
      .values([
        {
          organizationId: DEMO_IDS.organization,
          slug,
          name: '租户 A 同路径大会',
          shortName: '租户 A',
          tagline: '租户 A 大会主张',
          description: '用于验证同路径大会的组织隔离。',
          status: 'registration_open',
          startsAt: new Date('2027-08-01T01:00:00.000Z'),
          endsAt: new Date('2027-08-01T10:00:00.000Z'),
          timezone: 'Asia/Shanghai',
          venue: '深圳 A 会场',
          city: '深圳',
          address: '深圳 A 地址',
          settings: {
            stats: { seats: 10, speakers: 0, days: 1, attendeeSatisfaction: 0 },
            faqs: [],
          },
        },
        {
          organizationId: organizationB,
          slug,
          name: '租户 B 同路径大会',
          shortName: '租户 B',
          tagline: '租户 B 大会主张',
          description: '用于验证同路径大会的组织隔离。',
          status: 'registration_open',
          startsAt: new Date('2027-09-01T01:00:00.000Z'),
          endsAt: new Date('2027-09-01T10:00:00.000Z'),
          timezone: 'Asia/Shanghai',
          venue: '上海 B 会场',
          city: '上海',
          address: '上海 B 地址',
          settings: {
            stats: { seats: 20, speakers: 0, days: 1, attendeeSatisfaction: 0 },
            faqs: [],
          },
        },
      ])
      .returning({ id: events.id, name: events.name });
    eventA = insertedEvents.find((event) => event.name === '租户 A 同路径大会')!.id;
    eventB = insertedEvents.find((event) => event.name === '租户 B 同路径大会')!.id;
    await db.insert(ticketTypes).values([
      {
        id: ticketA,
        organizationId: DEMO_IDS.organization,
        eventId: eventA,
        code: 'STANDARD',
        name: '租户 A 门票',
        description: '租户 A 门票',
        price: 100,
        capacity: 10,
      },
      {
        id: ticketB,
        organizationId: organizationB,
        eventId: eventB,
        code: 'STANDARD',
        name: '租户 B 门票',
        description: '租户 B 门票',
        price: 200,
        capacity: 20,
      },
    ]);
    await db.insert(registrationForms).values([
      {
        eventId: eventA,
        name: '租户 A 报名表',
        status: 'published',
        fields: [],
        termsVersion: 'A-1',
        termsContent: '租户 A 的报名服务条款。',
        publishedAt: new Date(),
      },
      {
        eventId: eventB,
        name: '租户 B 报名表',
        status: 'published',
        fields: [],
        termsVersion: 'B-1',
        termsContent: '租户 B 的报名服务条款。',
        publishedAt: new Date(),
      },
    ]);
    await db.insert(checkinLists).values({
      eventId: eventB,
      code: 'main-entrance',
      name: '租户 B 主入口',
    });
    await db.insert(registrations).values({
      id: registrationB,
      organizationId: organizationB,
      eventId: eventB,
      ticketTypeId: ticketB,
      registrationCode: `TENANT-B-${randomUUID().slice(0, 8)}`,
      status: 'confirmed',
      attendee: {
        name: '租户 B 参会人',
        mobile: '13900139000',
        email: 'tenant-b@example.com',
        company: '租户 B 公司',
        title: '负责人',
        city: '上海',
      },
    });
    await db.insert(tickets).values({
      id: issuedTicketB,
      eventId: eventB,
      registrationId: registrationB,
      ticketTypeId: ticketB,
      code: `TENANT-B-${randomUUID().slice(0, 8)}`,
    });
  });

  afterAll(async () => {
    const db = database.db!;
    await db.delete(events).where(eq(events.id, eventA));
    await db.delete(organizations).where(eq(organizations.id, organizationB));
    await database.onModuleDestroy();
  });

  it('resolves the same public slug inside its organization scope', async () => {
    const [publicA, publicB] = await Promise.all([
      repository.getPublicEvent(slug, organizationASlug, false),
      repository.getPublicEvent(slug, organizationBSlug, false),
    ]);
    expect(publicA.id).toBe(eventA);
    expect(publicA.tickets[0]?.id).toBe(ticketA);
    expect(publicB.id).toBe(eventB);
    expect(publicB.tickets[0]?.id).toBe(ticketB);
  });

  it('rejects admin reads and writes across organization boundaries', async () => {
    await expect(repository.getDashboard(eventB, DEMO_IDS.organization)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      repository.updateEvent(
        eventB,
        { tagline: '越权修改' },
        DEMO_IDS.adminUser,
        DEMO_IDS.organization,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(operations.listContent(DEMO_IDS.organization, eventB)).rejects.toMatchObject({
      status: 404,
    });

    expect((await repository.listRegistrations(eventB, {}, DEMO_IDS.organization)).items).toEqual(
      [],
    );
    expect(await repository.listOrders(eventB, {}, DEMO_IDS.organization)).toEqual([]);
    const ownEvent = await repository.getAdminEvent(eventA, DEMO_IDS.organization);
    expect(ownEvent.name).toBe('租户 A 同路径大会');
  });

  it('rejects cross-organization ticket check-in without mutating the ticket', async () => {
    const db = database.db!;
    const [issued] = await db.select().from(tickets).where(eq(tickets.id, issuedTicketB)).limit(1);

    await expect(
      repository.checkIn(
        {
          eventId: eventB,
          ticketCode: issued!.code,
          checkInListId: 'main-entrance',
          deviceId: 'tenant-a-device',
        },
        DEMO_IDS.organization,
      ),
    ).rejects.toMatchObject({ status: 404 });

    const [unchanged] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, issuedTicketB))
      .limit(1);
    expect(unchanged?.status).toBe('valid');
  });
});
