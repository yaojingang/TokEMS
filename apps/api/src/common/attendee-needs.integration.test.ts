import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTENDEE_NEED_CONSENT_VERSION,
  DEMO_EVENT,
  DEMO_IDS,
  type AttendeeNeedsProfile,
} from '@conference/contracts';
import {
  attendeeNeedSubmissions,
  attendeeNeedQuestions,
  auditLogs,
  customerProfiles,
  customerUsers,
  eventReleases,
  events,
  orders,
  publicUserIds,
  registrations,
  tickets,
} from '@conference/database';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { AttendeeNeedsService } from './attendee-needs.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('attendee needs persistence', () => {
  const database = new DatabaseService();
  const conference = new ConferenceRepository(database);
  const service = new AttendeeNeedsService(database, conference);
  const customerUserId = randomUUID();
  const registrationId = randomUUID();
  const orderId = randomUUID();
  const ticketId = randomUUID();
  const registrationCode = `NEEDS-${registrationId.slice(0, 8)}`;
  let profile: AttendeeNeedsProfile;
  let questionId = '';
  let submissionId = '';
  let exportAuditResourceId = '';
  let activeReleaseId = '';
  let originalReleaseSnapshot: Record<string, unknown> | null = null;

  const session = {
    sessionId: randomUUID(),
    customerUserId,
    organizationId: DEMO_IDS.organization,
    tokenHash: randomUUID().replaceAll('-', ''),
    expiresAt: new Date('2028-01-01T00:00:00.000Z'),
    customer: {},
    csrfToken: 'attendee-needs-integration-csrf',
  } as AuthenticatedCustomer;

  async function setReleaseNodes(flowEnabled: boolean, homeEnabled: boolean) {
    const snapshot = structuredClone(originalReleaseSnapshot ?? {}) as {
      experience?: {
        registrationFlow?: { steps?: Array<Record<string, unknown>> };
        home?: { blocks?: Array<Record<string, unknown>> };
      };
    };
    const steps = snapshot.experience?.registrationFlow?.steps;
    const blocks = snapshot.experience?.home?.blocks;
    if (!steps || !blocks) throw new Error('Attendee needs release fixture is incomplete');
    snapshot.experience!.registrationFlow!.steps = steps.map((step) =>
      step.type === 'attendee-needs' ? { ...step, enabled: flowEnabled } : step,
    );
    snapshot.experience!.home!.blocks = blocks.map((block) =>
      block.nodeKey === 'home.attendee-needs' ? { ...block, enabled: homeEnabled } : block,
    );
    await database
      .db!.update(eventReleases)
      .set({ snapshot })
      .where(eq(eventReleases.id, activeReleaseId));
  }

  beforeAll(async () => {
    const [event] = await database
      .db!.select({ settings: events.settings })
      .from(events)
      .where(eq(events.id, DEMO_IDS.event))
      .limit(1);
    activeReleaseId = String((event?.settings as { currentReleaseId?: string }).currentReleaseId);
    const [release] = await database
      .db!.select({ snapshot: eventReleases.snapshot })
      .from(eventReleases)
      .where(eq(eventReleases.id, activeReleaseId))
      .limit(1);
    originalReleaseSnapshot = structuredClone(release?.snapshot ?? {});
    await setReleaseNodes(false, false);

    const mobile = `+86137${String(Date.now()).slice(-8)}`;
    await database.db!.insert(customerUsers).values({
      id: customerUserId,
      organizationId: DEMO_IDS.organization,
      mobileE164: mobile,
    });
    await database.db!.insert(customerProfiles).values({
      customerUserId,
      nickname: '需求验收用户',
      realName: '参会需求验收',
    });
    await database.db!.insert(registrations).values({
      id: registrationId,
      organizationId: DEMO_IDS.organization,
      eventId: DEMO_IDS.event,
      ticketTypeId: DEMO_IDS.tickets.earlyBird,
      customerUserId,
      registrationCode,
      status: 'confirmed',
      attendee: {
        name: '参会需求验收',
        mobile,
        email: `needs-${registrationId.slice(0, 8)}@example.com`,
        company: '需求验收公司',
        title: '负责人',
        city: '深圳',
      },
      attendeeMobileE164: mobile,
      attendeeEmailNormalized: `needs-${registrationId.slice(0, 8)}@example.com`,
    });
    await database.db!.insert(orders).values({
      id: orderId,
      organizationId: DEMO_IDS.organization,
      eventId: DEMO_IDS.event,
      registrationId,
      purchaserCustomerUserId: customerUserId,
      purchaserSnapshot: {
        customerUserId,
        mobile,
        name: '参会需求验收',
        email: `needs-${registrationId.slice(0, 8)}@example.com`,
        company: '需求验收公司',
        title: '负责人',
        city: '深圳',
      },
      orderNo: `NEEDS-${orderId.slice(0, 8)}`,
      status: 'paid',
      amount: 0,
      currency: 'CNY',
      pricingSnapshot: {},
      expiresAt: new Date('2028-01-01T00:00:00.000Z'),
    });
    await database.db!.insert(tickets).values({
      id: ticketId,
      eventId: DEMO_IDS.event,
      registrationId,
      ticketTypeId: DEMO_IDS.tickets.earlyBird,
      code: `TOK-NEEDS-${ticketId.slice(0, 8)}`,
      status: 'valid',
    });
  });

  afterAll(async () => {
    const ids = [questionId, submissionId, exportAuditResourceId].filter(Boolean);
    if (ids.length > 0) {
      await database.db!.delete(auditLogs).where(inArray(auditLogs.resourceId, ids));
    }
    await database.db!.delete(orders).where(eq(orders.id, orderId));
    await database.db!.delete(registrations).where(eq(registrations.id, registrationId));
    await database.db!.delete(customerUsers).where(eq(customerUsers.id, customerUserId));
    if (activeReleaseId && originalReleaseSnapshot) {
      await database
        .db!.update(eventReleases)
        .set({ snapshot: originalReleaseSnapshot })
        .where(eq(eventReleases.id, activeReleaseId));
    }
    await database
      .db!.delete(publicUserIds)
      .where(
        and(
          eq(publicUserIds.subjectType, 'customer'),
          eq(publicUserIds.subjectUuid, customerUserId),
        ),
      );
    await database.onModuleDestroy();
  });

  it('covers user, public, admin, concurrency, export, governance, and supersede behavior', async () => {
    const empty = await service.customerNeeds(session, registrationId);
    expect(empty).toMatchObject({
      id: null,
      featureEnabled: false,
      canCreate: false,
      canPublish: true,
      isPublic: true,
      isAnonymous: true,
      qualified: true,
      version: 0,
    });
    await expect(
      service.customerNeeds({ ...session, customerUserId: randomUUID() }, registrationId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.customerNeeds({ ...session, organizationId: randomUUID() }, registrationId),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      service.updateCustomerNeeds(session, registrationId, {
        version: 0,
        questions: [
          {
            content: '关闭流程节点时不能通过接口提前提交问题。',
            tagCodes: ['enterprise-adoption'],
          },
        ],
        isPublic: true,
        isAnonymous: true,
        attributionName: null,
        consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await database
        .db!.select({ id: attendeeNeedSubmissions.id })
        .from(attendeeNeedSubmissions)
        .where(eq(attendeeNeedSubmissions.registrationId, registrationId)),
    ).toHaveLength(0);
    await setReleaseNodes(true, false);

    await expect(
      service.updateCustomerNeeds(session, registrationId, {
        version: 0,
        questions: [
          {
            id: randomUUID(),
            content: '首次提交不能携带其他问题的标识。',
            tagCodes: ['enterprise-adoption'],
          },
        ],
        isPublic: true,
        isAnonymous: true,
        attributionName: null,
        consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await database
        .db!.select({ id: attendeeNeedSubmissions.id })
        .from(attendeeNeedSubmissions)
        .where(eq(attendeeNeedSubmissions.registrationId, registrationId)),
    ).toHaveLength(0);

    profile = await service.updateCustomerNeeds(session, registrationId, {
      version: 0,
      questions: [
        {
          content: '企业内部应该如何确定 GEO 第一阶段的目标？',
          tagCodes: ['enterprise-adoption', 'geo-strategy-budget'],
        },
      ],
      isPublic: true,
      isAnonymous: true,
      attributionName: null,
      consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
    });
    submissionId = profile.id!;
    questionId = profile.questions[0]!.id!;
    expect(profile).toMatchObject({ effectivePublic: false, version: 2 });
    await expect(
      database.db!.insert(attendeeNeedQuestions).values({
        submissionId,
        position: 2,
        content: '数据库不能接受未知主题标签。',
        tagCodes: ['unknown-topic'],
      }),
    ).rejects.toBeTruthy();
    await expect(
      database.db!.insert(attendeeNeedQuestions).values({
        submissionId,
        position: 2,
        content: '数据库不能接受重复主题标签。',
        tagCodes: ['geo-roi', 'geo-roi'],
      }),
    ).rejects.toBeTruthy();

    const disabledHome = await service.publicNeeds(DEMO_EVENT.slug, 'geo-conference', { page: 1 });
    expect(disabledHome).toMatchObject({ items: [], total: 0, totalPages: 1 });
    await setReleaseNodes(true, true);
    expect(await service.customerNeeds(session, registrationId)).toMatchObject({
      effectivePublic: true,
    });

    const anonymousPublic = await service.publicNeeds(DEMO_EVENT.slug, 'geo-conference', {
      page: 1,
    });
    const anonymousItem = anonymousPublic.items.find((item) => item.questionId === questionId);
    expect(anonymousItem).toBeTruthy();
    expect(anonymousItem).not.toHaveProperty('attribution');
    expect(anonymousItem).not.toHaveProperty('registrationId');

    const named = await service.updateCustomerNeeds(session, registrationId, {
      version: profile.version,
      questions: [
        {
          id: questionId,
          content: profile.questions[0]!.content,
          tagCodes: profile.questions[0]!.tagCodes,
        },
      ],
      isPublic: true,
      isAnonymous: false,
      attributionName: '用户确认署名',
      consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
    });

    for (const lifecycle of [
      {
        table: customerUsers,
        id: customerUserId,
        blocked: { status: 'blocked' },
        active: { status: 'active' },
      },
      {
        table: registrations,
        id: registrationId,
        blocked: { status: 'cancelled' },
        active: { status: 'confirmed' },
      },
      { table: orders, id: orderId, blocked: { status: 'refunded' }, active: { status: 'paid' } },
      {
        table: tickets,
        id: ticketId,
        blocked: { status: 'cancelled' },
        active: { status: 'valid' },
      },
    ] as const) {
      await database
        .db!.update(lifecycle.table)
        .set(lifecycle.blocked)
        .where(eq(lifecycle.table.id, lifecycle.id));
      expect(
        (await service.publicNeeds(DEMO_EVENT.slug, 'geo-conference', { page: 1 })).items.some(
          (item) => item.questionId === questionId,
        ),
      ).toBe(false);
      await database
        .db!.update(lifecycle.table)
        .set(lifecycle.active)
        .where(eq(lifecycle.table.id, lifecycle.id));
    }

    await expect(
      service.updateCustomerNeeds(session, registrationId, {
        version: profile.version,
        questions: [
          {
            id: questionId,
            content: '这个旧页面不应覆盖已经保存的新内容。',
            tagCodes: ['geo-roi'],
          },
        ],
        isPublic: true,
        isAnonymous: false,
        attributionName: '旧页面署名',
        consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      service.updateAdminQuestion(randomUUID(), DEMO_IDS.adminUser, DEMO_IDS.event, questionId, {
        version: named.version,
        content: '跨组织管理员不能修改这个问题。',
        tagCodes: ['enterprise-adoption'],
        reason: '验证组织隔离',
      }),
    ).rejects.toMatchObject({ status: 404 });

    const adminEdited = await service.updateAdminQuestion(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      DEMO_IDS.event,
      questionId,
      {
        version: named.version,
        content: '=HYPERLINK("https://example.com","问题正文")',
        tagCodes: ['enterprise-adoption'],
        reason: '统一问题表述',
      },
    );
    expect(adminEdited).toMatchObject({ attributionName: '用户确认署名', adminEdited: true });
    const [adminEditAudit] = await database
      .db!.select({ before: auditLogs.before, after: auditLogs.after })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, questionId),
          eq(auditLogs.action, 'attendee_needs.admin_edit'),
        ),
      )
      .limit(1);
    expect(adminEditAudit?.after).toMatchObject({ contentChanged: true });
    expect(JSON.stringify(adminEditAudit)).not.toContain('HYPERLINK');
    expect(JSON.stringify(adminEditAudit)).not.toContain('企业内部应该如何确定');
    expect(JSON.stringify(adminEditAudit)).not.toContain('enterprise-adoption');

    const exportResult = await service.exportAdminCsv(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      DEMO_IDS.event,
      {
        variant: 'speaker',
        forceAnonymous: true,
        query: registrationCode,
      },
    );
    expect(exportResult.count).toBe(1);
    expect(exportResult.csv).toContain(`"'=HYPERLINK`);
    expect(exportResult.csv).toContain('匿名参会者');
    expect(exportResult.csv).not.toContain(registrationCode);
    const [exportAudit] = await database
      .db!.select({ after: auditLogs.after, resourceId: auditLogs.resourceId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.eventId, DEMO_IDS.event),
          eq(auditLogs.action, 'attendee_needs.export_speaker'),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    exportAuditResourceId = exportAudit?.resourceId ?? '';
    expect(exportAudit?.after).toMatchObject({
      variant: 'speaker',
      filters: { queryLength: registrationCode.length },
    });
    expect(JSON.stringify(exportAudit)).not.toContain(registrationCode);

    const anonymized = await service.moderateAdminQuestion(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      DEMO_IDS.event,
      questionId,
      { version: adminEdited.version, action: 'anonymize', reason: '嘉宾材料统一匿名' },
    );
    const hidden = await service.moderateAdminQuestion(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      DEMO_IDS.event,
      questionId,
      { version: anonymized.version, action: 'hide', reason: '等待内容复核' },
    );
    expect(
      (await service.publicNeeds(DEMO_EVENT.slug, 'geo-conference', { page: 1 })).items.some(
        (item) => item.questionId === questionId,
      ),
    ).toBe(false);
    const restored = await service.moderateAdminQuestion(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      DEMO_IDS.event,
      questionId,
      { version: hidden.version, action: 'restore', reason: '内容复核通过' },
    );
    const deleted = await service.moderateAdminQuestion(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      DEMO_IDS.event,
      questionId,
      { version: restored.version, action: 'delete', reason: '验证软删除' },
    );
    const restoredDelete = await service.moderateAdminQuestion(
      DEMO_IDS.organization,
      DEMO_IDS.adminUser,
      DEMO_IDS.event,
      questionId,
      { version: deleted.version, action: 'restore-delete', reason: '验证恢复删除' },
    );
    expect(restoredDelete.deleted).toBe(false);

    await database
      .db!.update(registrations)
      .set({ supersededAt: new Date() })
      .where(eq(registrations.id, registrationId));
    const [supersededSubmission] = await database
      .db!.select()
      .from(attendeeNeedSubmissions)
      .where(eq(attendeeNeedSubmissions.id, submissionId))
      .limit(1);
    expect(supersededSubmission).toMatchObject({
      isPublic: false,
      isAnonymous: true,
      attributionName: null,
    });
    expect(
      (await service.publicNeeds(DEMO_EVENT.slug, 'geo-conference', { page: 1 })).items.some(
        (item) => item.questionId === questionId,
      ),
    ).toBe(false);
  });
});
