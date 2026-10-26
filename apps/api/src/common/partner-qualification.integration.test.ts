import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PARTNER_POSTER_FIELDS,
  DEFAULT_PARTNER_VISIBLE_FIELDS,
  PartnerProgramDraftSchema,
} from '@conference/contracts';
import {
  createDatabase,
  customerUsers,
  eventPartnerProfileVersions,
  eventPartnerRuleAcceptances,
  eventPartners,
  events,
  organizations,
  users,
} from '@conference/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import type { DatabaseService } from './database.service.js';
import { PartnerDistributionService } from './partner-distribution.service.js';
import type { RedisService } from './redis.service.js';

const persistent = process.env.PARTNER_TEST_DATABASE_URL ? describe : describe.skip;

persistent('partner qualification authorization with real PostgreSQL', () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(() => {
    connection = createDatabase(process.env.PARTNER_TEST_DATABASE_URL);
  });
  afterAll(async () => {
    await connection.pool.end();
  });

  async function fixture() {
    const db = connection.db;
    const organizationId = randomUUID();
    const actorId = randomUUID();
    await db.insert(organizations).values({
      id: organizationId,
      slug: `partner-qualification-${organizationId}`,
      name: '合作伙伴资格授权测试',
    });
    await db.insert(users).values({
      id: actorId,
      email: `partner-qualification-${actorId}@example.com`,
      name: '资格管理员',
    });
    const [event] = await db
      .insert(events)
      .values({
        organizationId,
        slug: `partner-qualification-${organizationId}`,
        name: '伙伴资格测试大会',
        shortName: '资格测试',
        tagline: '资格状态授权验收',
        description: '验证管理员对伙伴资格与归因的独立控制。',
        status: 'registration_open',
        startsAt: new Date('2027-11-01T01:00:00Z'),
        endsAt: new Date('2027-11-01T10:00:00Z'),
        timezone: 'Asia/Shanghai',
        venue: '测试会场',
        city: '深圳',
        address: '测试地址',
      })
      .returning();
    const service = new PartnerDistributionService({ db } as DatabaseService, {} as RedisService);
    const draft = PartnerProgramDraftSchema.parse({
      termsTitle: '合作伙伴规则',
      termsContent: '确认后可以使用专属推广链接。',
      promotionPolicy: '推广内容需真实准确。',
    });
    const program = (await service.publishProgram(organizationId, event!.id, actorId, draft))!;
    let customerSequence = 0;
    async function partner(
      qualificationStatus: (typeof eventPartners.$inferSelect)['qualificationStatus'],
      attributionEnabled: boolean,
    ) {
      const customerUserId = randomUUID();
      const partnerId = randomUUID();
      customerSequence += 1;
      await db.insert(customerUsers).values({
        id: customerUserId,
        organizationId,
        mobileE164: `+861380000${String(customerSequence).padStart(4, '0')}`,
      });
      const [row] = await db
        .insert(eventPartners)
        .values({
          id: partnerId,
          organizationId,
          eventId: event!.id,
          customerUserId,
          publicSlug: `qualification-${partnerId.slice(0, 12)}`,
          currentProgramVersionId: program.id,
          acceptedProgramVersionId:
            qualificationStatus === 'pending_confirmation' ? null : program.id,
          qualificationStatus,
          attributionEnabled,
        })
        .returning();
      await db.insert(eventPartnerProfileVersions).values({
        partnerId,
        organizationId,
        eventId: event!.id,
        version: 1,
        displayName: '资格测试伙伴',
        visibleFields: DEFAULT_PARTNER_VISIBLE_FIELDS,
        posterFields: DEFAULT_PARTNER_POSTER_FIELDS,
        actorType: 'system',
      });
      const session = {
        sessionId: randomUUID(),
        customerUserId,
        organizationId,
        tokenHash: 'qualification-test',
        expiresAt: new Date(Date.now() + 60_000),
        customer: {} as AuthenticatedCustomer['customer'],
        csrfToken: 'qualification-test',
      } satisfies AuthenticatedCustomer;
      return { row: row!, session };
    }
    return { organizationId, actorId, event: event!, draft, program, service, partner };
  }

  it('keeps repeated acceptance requests compatible for an active partner', async () => {
    const scope = await fixture();
    const { row, session } = await scope.partner('active', true);
    const result = await scope.service.acceptProgram(session, scope.event.id, scope.program.id, row.version, '127.0.0.1', 'test');
    expect(result).toMatchObject({ qualificationStatus: 'active', attributionEnabled: true, version: row.version });
  });

  it.each([
    ['paused', false],
    ['closed', false],
    ['active', false],
    ['pending_confirmation', false],
  ] as const)(
    'rejects a fresh rule acceptance for %s with attribution=%s',
    async (status, attribution) => {
      const scope = await fixture();
      const { row, session } = await scope.partner(status, attribution);
      const visible = await scope.service.accountPartnership(session, scope.event.id);
      await expect(
        scope.service.acceptProgram(
          session,
          scope.event.id,
          visible.currentProgram!.id,
          visible.version,
          '127.0.0.1',
          'qualification-test',
        ),
      ).rejects.toThrow();
      const [stored] = await connection.db
        .select()
        .from(eventPartners)
        .where(eq(eventPartners.id, row.id));
      expect(stored).toMatchObject({
        qualificationStatus: status,
        attributionEnabled: attribution,
        version: row.version,
      });
      expect(
        await connection.db
          .select()
          .from(eventPartnerRuleAcceptances)
          .where(eq(eventPartnerRuleAcceptances.partnerId, row.id)),
      ).toHaveLength(0);
    },
  );

  it('preserves paused, closed and attribution-disabled relationships when publishing new rules', async () => {
    const scope = await fixture();
    const restricted = await Promise.all([
      scope.partner('paused', false),
      scope.partner('closed', false),
      scope.partner('active', false),
    ]);
    const enabled = await scope.partner('active', true);
    const invited = await scope.partner('pending_confirmation', false);
    const next = (await scope.service.publishProgram(
      scope.organizationId,
      scope.event.id,
      scope.actorId,
      {
        ...scope.draft,
        termsTitle: '新版合作伙伴规则',
      },
    ))!;
    for (const { row } of restricted) {
      const [stored] = await connection.db
        .select()
        .from(eventPartners)
        .where(eq(eventPartners.id, row.id));
      expect(stored).toMatchObject({
        qualificationStatus: row.qualificationStatus,
        attributionEnabled: false,
        currentProgramVersionId: next.id,
        acceptedProgramVersionId: scope.program.id,
        version: row.version + 1,
      });
    }
    for (const { row } of [enabled, invited]) {
      const [stored] = await connection.db
        .select()
        .from(eventPartners)
        .where(eq(eventPartners.id, row.id));
      expect(stored).toMatchObject({
        qualificationStatus: row.qualificationStatus,
        attributionEnabled: row.attributionEnabled,
        currentProgramVersionId: next.id,
        acceptedProgramVersionId: row.acceptedProgramVersionId,
        version: row.version + 1,
      });
    }
  });

  it.each(['paused', 'active'] as const)(
    'binds current rules and activates immediately when an administrator resumes a %s partner',
    async (status) => {
      const scope = await fixture();
      const { row, session } = await scope.partner(status, false);
      const next = (await scope.service.publishProgram(
        scope.organizationId,
        scope.event.id,
        scope.actorId,
        {
          ...scope.draft,
          termsTitle: '恢复资格前生效的新规则',
        },
      ))!;
      const observed = await scope.service.accountPartnership(session, scope.event.id);
      const reopened = await scope.service.updatePartner(
        scope.organizationId,
        scope.event.id,
        row.id,
        scope.actorId,
        {
          expectedVersion: observed.version,
          ...(status === 'paused' ? { qualificationStatus: 'active' as const } : {}),
          attributionEnabled: true,
        },
      );
      expect(reopened).toMatchObject({
        qualificationStatus: 'active',
        attributionEnabled: true,
        currentProgram: { id: next.id },
        acceptedProgramVersionId: scope.program.id,
      });
      const activated = await scope.service.acceptProgram(
        session,
        scope.event.id,
        next.id,
        reopened.version,
        '127.0.0.1',
        'qualification-test',
      );
      expect(activated).toMatchObject({
        qualificationStatus: 'active',
        attributionEnabled: true,
        acceptedProgramVersionId: next.id,
      });
    },
  );
});
