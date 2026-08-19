import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventId } from '@conference/contracts';
import {
  eventPublicMetricDays,
  eventPublicMetrics,
  events,
  organizations,
  registrations,
  ticketTypes,
} from '@conference/database';
import { and, count, eq } from 'drizzle-orm';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('PostgreSQL public event metrics', () => {
  const database = new DatabaseService();
  const repository = new ConferenceRepository(database);
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const ticketTypeId = randomUUID();
  let eventId: EventId;

  beforeAll(async () => {
    const db = database.db!;
    await db.insert(organizations).values([
      {
        id: organizationId,
        slug: `public-metrics-${randomUUID().slice(0, 8)}`,
        name: '公开指标测试组织',
      },
      {
        id: otherOrganizationId,
        slug: `public-metrics-other-${randomUUID().slice(0, 8)}`,
        name: '公开指标隔离组织',
      },
    ]);
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `public-metrics-event-${randomUUID().slice(0, 8)}`,
        name: '公开指标测试大会',
        shortName: '公开指标',
        tagline: '验证公开大会首页指标',
        description: '验证访问量、确认参会、企业和城市聚合口径。',
        status: 'registration_open',
        startsAt: new Date('2027-10-01T01:00:00.000Z'),
        endsAt: new Date('2027-10-01T10:00:00.000Z'),
        timezone: 'Asia/Shanghai',
        venue: '深圳测试会场',
        city: '深圳',
        address: '深圳测试地址',
        settings: {},
      })
      .returning({ id: events.id });
    eventId = event!.id;
    await db.insert(ticketTypes).values({
      id: ticketTypeId,
      organizationId,
      eventId,
      code: 'PUBLIC_METRICS',
      name: '指标测试票',
      description: '公开指标测试票',
      price: 0,
      capacity: 20,
    });

    const fixtures = [
      { status: 'confirmed', company: ' Atlas AI ', city: '深圳' },
      { status: 'checked_in', company: 'atlas   ai', city: ' 深圳 ' },
      { status: 'completed', company: '星河科技', city: '广州' },
      { status: 'confirmed', company: '', city: '' },
      { status: 'pending_review', company: '待审核公司', city: '北京' },
      { status: 'cancelled', company: '已取消公司', city: '杭州' },
      {
        status: 'confirmed',
        company: '已归并公司',
        city: '上海',
        supersededAt: new Date(),
      },
    ] as const;
    await db.insert(registrations).values(
      fixtures.map((fixture, index) => ({
        id: randomUUID(),
        organizationId,
        eventId,
        ticketTypeId,
        registrationCode: `PUBLIC-METRIC-${index}-${randomUUID().slice(0, 8)}`,
        status: fixture.status,
        attendee: {
          name: `指标参会人 ${index + 1}`,
          mobile: `1380013810${index}`,
          email: `public-metric-${index}@example.com`,
          company: fixture.company,
          title: '负责人',
          city: fixture.city,
        },
        ...('supersededAt' in fixture ? { supersededAt: fixture.supersededAt } : {}),
      })),
    );
  });

  afterAll(async () => {
    const db = database.db!;
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(organizations).where(eq(organizations.id, otherOrganizationId));
    await database.onModuleDestroy();
  });

  it('creates once, increments continuously, and preserves the start time', async () => {
    const first = await repository.recordPublicEventView(eventId, organizationId);
    const second = await repository.recordPublicEventView(eventId, organizationId);

    expect(first.pageViews).toBe(1);
    expect(second.pageViews).toBe(2);
    expect(second.trackingStartedAt).toBe(first.trackingStartedAt);
    const [metric] = await database
      .db!.select({ dailyTrackingStartedAt: eventPublicMetrics.dailyTrackingStartedAt })
      .from(eventPublicMetrics)
      .where(
        and(
          eq(eventPublicMetrics.organizationId, organizationId),
          eq(eventPublicMetrics.eventId, eventId),
        ),
      );
    expect(metric?.dailyTrackingStartedAt?.toISOString()).toBe(first.trackingStartedAt);
  });

  it('increments atomically under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repository.recordPublicEventView(eventId, organizationId)),
    );

    expect(Math.max(...results.map((result) => result.pageViews))).toBe(22);
    await expect(
      repository.getPublicEventViewResult(eventId, organizationId),
    ).resolves.toMatchObject({ pageViews: 22 });

    const [daily] = await database
      .db!.select({ pageViews: eventPublicMetricDays.pageViews })
      .from(eventPublicMetricDays)
      .where(
        and(
          eq(eventPublicMetricDays.organizationId, organizationId),
          eq(eventPublicMetricDays.eventId, eventId),
        ),
      );
    expect(daily).toMatchObject({ pageViews: 22 });
  });

  it('aggregates confirmed registrations and normalized non-empty dimensions', async () => {
    await expect(repository.getPublicMetrics(eventId, organizationId)).resolves.toMatchObject({
      confirmedAttendees: 4,
      organizationCount: 2,
      cityCount: 2,
    });
  });

  it('keeps the counter isolated by organization and cascades on event deletion', async () => {
    await expect(repository.getPublicMetrics(eventId, otherOrganizationId)).resolves.toMatchObject({
      pageViews: 0,
      confirmedAttendees: 0,
      organizationCount: 0,
      cityCount: 0,
    });

    await database
      .db!.delete(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)));
    const [remaining] = await database
      .db!.select({ value: count() })
      .from(eventPublicMetrics)
      .where(eq(eventPublicMetrics.eventId, eventId));
    expect(remaining?.value).toBe(0);
  });
});
