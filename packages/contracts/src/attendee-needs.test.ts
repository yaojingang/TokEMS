import { describe, expect, it } from 'vitest';
import {
  ATTENDEE_NEED_CONSENT_VERSION,
  ATTENDEE_NEED_TOPIC_OPTIONS,
  AdminAttendeeNeedItemSchema,
  AdminAttendeeNeedListQuerySchema,
  ConferenceTemplateDefinitionSchema,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  PublicAttendeeNeedItemSchema,
  PublicAttendeeNeedListQuerySchema,
  PublicAttendeeNeedListSchema,
  ModerateAttendeeNeedQuestionSchema,
  UpdateAdminAttendeeNeedQuestionSchema,
  UpdateAttendeeNeedsSchema,
  normalizeConferenceTemplateDefinition,
} from './index.js';

const validQuestion = {
  content: '企业内部应该由哪个部门牵头 GEO？',
  tagCodes: ['enterprise-adoption', 'geo-team-talent'],
};

describe('attendee needs contracts', () => {
  it('supports exact question targeting for governed admin verification', () => {
    const questionId = crypto.randomUUID();
    expect(AdminAttendeeNeedListQuerySchema.parse({ questionId })).toMatchObject({
      questionId,
      page: 1,
      pageSize: 20,
    });
  });

  it('rejects unclassified moderation fields', () => {
    expect(
      ModerateAttendeeNeedQuestionSchema.safeParse({
        version: 1,
        action: 'hide',
        reason: '等待复核',
        publishImmediately: true,
      }).success,
    ).toBe(false);
  });

  it('ships exactly twenty stable topics', () => {
    expect(ATTENDEE_NEED_TOPIC_OPTIONS).toHaveLength(20);
    expect(new Set(ATTENDEE_NEED_TOPIC_OPTIONS.map((item) => item.code)).size).toBe(20);
  });

  it('accepts one to three questions with one to three topics each', () => {
    expect(
      UpdateAttendeeNeedsSchema.parse({
        version: 0,
        questions: [validQuestion],
        isPublic: true,
        isAnonymous: true,
        attributionName: null,
        consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
      }).questions,
    ).toHaveLength(1);

    expect(
      UpdateAttendeeNeedsSchema.safeParse({
        version: 0,
        questions: [validQuestion, validQuestion, validQuestion, validQuestion],
        isPublic: false,
        isAnonymous: true,
        attributionName: null,
        consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
      }).success,
    ).toBe(false);

    expect(
      UpdateAttendeeNeedsSchema.safeParse({
        version: 0,
        questions: [{ ...validQuestion, tagCodes: [] }],
        isPublic: false,
        isAnonymous: true,
        attributionName: null,
        consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
      }).success,
    ).toBe(false);
  });

  it('requires an attribution when public display is not anonymous', () => {
    const result = UpdateAttendeeNeedsSchema.safeParse({
      version: 0,
      questions: [validQuestion],
      isPublic: true,
      isAnonymous: false,
      attributionName: null,
      consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('attributionName');
    }
  });

  it('rejects repeated existing question identifiers in one save', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(
      UpdateAttendeeNeedsSchema.safeParse({
        version: 3,
        questions: [
          { ...validQuestion, id },
          { ...validQuestion, id, content: '海外 GEO 应该怎样评估投入产出？' },
        ],
        isPublic: true,
        isAnonymous: true,
        attributionName: null,
        consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
      }).success,
    ).toBe(false);
  });

  it.each([
    [4, false],
    [5, true],
    [200, true],
    [201, false],
  ])('validates a %i-character question at the contract boundary', (length, accepted) => {
    expect(
      UpdateAttendeeNeedsSchema.safeParse({
        version: 0,
        questions: [{ ...validQuestion, content: '问'.repeat(length) }],
        isPublic: false,
        isAnonymous: true,
        attributionName: null,
        consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
      }).success,
    ).toBe(accepted);
  });

  it('counts Unicode characters consistently with the database', () => {
    expect(
      UpdateAttendeeNeedsSchema.safeParse({
        version: 0,
        questions: [{ ...validQuestion, content: '🙂'.repeat(200) }],
        isPublic: true,
        isAnonymous: false,
        attributionName: '🙂'.repeat(120),
        consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
      }).success,
    ).toBe(true);
  });

  it('strips identity fields from anonymous public items', () => {
    const item = PublicAttendeeNeedItemSchema.parse({
      questionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      content: '海外 GEO 如何评估投入产出？',
      tags: [{ code: 'geo-global', label: '海外 GEO' }],
      firstPublishedAt: '2026-08-22T00:00:00.000Z',
      attribution: undefined,
      customerUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      registrationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    expect(item).not.toHaveProperty('customerUserId');
    expect(item).not.toHaveProperty('registrationId');
    expect(item).not.toHaveProperty('attribution');
  });

  it('carries the server publication cutoff across public result pages', () => {
    const snapshotAt = '2026-08-23T08:00:00.000Z';
    expect(PublicAttendeeNeedListQuerySchema.parse({ page: '2', snapshotAt })).toEqual({
      page: 2,
      snapshotAt,
    });
    expect(
      PublicAttendeeNeedListSchema.parse({
        items: [],
        total: 0,
        page: 2,
        pageSize: 10,
        totalPages: 1,
        snapshotAt,
      }).snapshotAt,
    ).toBe(snapshotAt);
  });

  it('rejects attempts by administrators to replace a user-confirmed attribution', () => {
    expect(
      UpdateAdminAttendeeNeedQuestionSchema.safeParse({
        version: 1,
        content: validQuestion.content,
        tagCodes: validQuestion.tagCodes,
        attributionName: '另一个身份',
        reason: '调整问题表达',
      }).success,
    ).toBe(false);
  });

  it.each(['hide', 'delete', 'anonymize'] as const)(
    'requires an administrator reason for %s governance',
    (action) => {
      expect(
        ModerateAttendeeNeedQuestionSchema.safeParse({ version: 2, action, reason: null }).success,
      ).toBe(false);
    },
  );

  it('shares a typed administrator item contract across the API and dashboard', () => {
    const base = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      submissionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      registrationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      registrationCode: 'TOKEMS-001',
      attendeeName: '参会者',
      registrationStatus: 'confirmed',
      orderStatus: 'paid',
      ticketStatus: 'valid',
      customerUserId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      content: validQuestion.content,
      tagCodes: ['enterprise-adoption'],
      isPublic: true,
      isAnonymous: true,
      attributionName: null,
      effectivePublic: true,
      qualificationReason: null,
      adminEdited: false,
      adminEditReason: null,
      adminHidden: false,
      adminHiddenReason: null,
      deleted: false,
      deletedByType: null,
      deletedReason: null,
      version: 2,
      firstPublishedAt: '2026-08-23T08:00:00.000Z',
      createdAt: '2026-08-23T08:00:00.000Z',
      updatedAt: '2026-08-23T08:00:00.000Z',
    };
    expect(AdminAttendeeNeedItemSchema.parse(base).tagCodes).toEqual(['enterprise-adoption']);
    expect(
      AdminAttendeeNeedItemSchema.safeParse({ ...base, tagCodes: ['unknown-topic'] }).success,
    ).toBe(false);
  });

  it('publishes attendee questions before tickets and enables the submission flow', () => {
    expect(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.kind).toBe('structured');
    if (DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.kind !== 'structured') return;

    const attendeeNeedsStep = DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.registrationFlow.steps.find(
      (step) => step.nodeKey === 'flow.attendee-needs',
    );
    const homeBlocks = DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.home.blocks;
    const attendeeNeedsIndex = homeBlocks.findIndex(
      (block) => block.nodeKey === 'home.attendee-needs',
    );
    const ticketsIndex = homeBlocks.findIndex((block) => block.nodeKey === 'home.tickets');

    expect(attendeeNeedsStep?.enabled).toBe(true);
    expect(attendeeNeedsIndex).toBeGreaterThanOrEqual(0);
    expect(attendeeNeedsIndex + 1).toBe(ticketsIndex);
    expect(homeBlocks[attendeeNeedsIndex]).toMatchObject({
      enabled: true,
      label: '大家关心的问题',
      content: { title: '大家关心的问题' },
    });
  });

  it('upgrades an existing structured template with disabled attendee-needs nodes', () => {
    const older = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    if (older.presentation.kind !== 'structured') throw new Error('expected structured template');
    older.presentation.home.blocks = older.presentation.home.blocks.filter(
      (block) => block.nodeKey !== 'home.attendee-needs',
    );
    older.registrationFlow.steps = older.registrationFlow.steps.filter(
      (step) => step.nodeKey !== 'flow.attendee-needs',
    );

    const normalized = normalizeConferenceTemplateDefinition(older);
    if (normalized.presentation.kind !== 'structured') {
      throw new Error('expected structured template');
    }
    expect(
      normalized.presentation.home.blocks.find((block) => block.nodeKey === 'home.attendee-needs'),
    ).toMatchObject({ type: 'attendee-needs', enabled: false });
    expect(
      normalized.registrationFlow.steps.find((step) => step.nodeKey === 'flow.attendee-needs'),
    ).toMatchObject({ type: 'attendee-needs', enabled: false });
  });

  it('keeps a previously valid eight-step flow compatible when adding the new node', () => {
    const older = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    if (older.presentation.kind !== 'structured') throw new Error('expected structured template');
    older.registrationFlow.steps = older.registrationFlow.steps.filter(
      (step) => step.nodeKey !== 'flow.attendee-needs',
    );
    while (older.registrationFlow.steps.length < 8) {
      const index = older.registrationFlow.steps.length;
      older.registrationFlow.steps.push({
        nodeKey: `flow.compat-${index}`,
        type: 'attendee-form',
        title: `兼容步骤 ${index}`,
        helpText: '',
        variant: 'default',
        enabled: false,
      });
    }

    const normalized = normalizeConferenceTemplateDefinition(older);
    expect(normalized.registrationFlow.steps).toHaveLength(9);
    expect(
      normalized.registrationFlow.steps.some((step) => step.nodeKey === 'flow.attendee-needs'),
    ).toBe(true);
  });

  it('reserves the ninth flow slot for the compatibility node', () => {
    const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    definition.registrationFlow.steps = definition.registrationFlow.steps.filter(
      (step) => step.nodeKey !== 'flow.attendee-needs',
    );
    while (definition.registrationFlow.steps.length < 9) {
      const index = definition.registrationFlow.steps.length;
      definition.registrationFlow.steps.push({
        nodeKey: `flow.invalid-compat-${index}`,
        type: 'attendee-form',
        title: `占位步骤 ${index}`,
        helpText: '',
        variant: 'default',
        enabled: false,
      });
    }

    expect(ConferenceTemplateDefinitionSchema.safeParse(definition).success).toBe(false);
  });

  it('repairs a compatibility node whose stable key has the wrong type', () => {
    const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    if (definition.presentation.kind !== 'structured') {
      throw new Error('expected structured template');
    }
    const homeNode = definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.attendee-needs',
    )!;
    homeNode.type = 'faq-summary';
    const flowNode = definition.registrationFlow.steps.find(
      (step) => step.nodeKey === 'flow.attendee-needs',
    )!;
    flowNode.type = 'member-profile';

    const normalized = normalizeConferenceTemplateDefinition(definition);
    if (normalized.presentation.kind !== 'structured') {
      throw new Error('expected structured template');
    }
    expect(
      normalized.presentation.home.blocks.find((block) => block.nodeKey === 'home.attendee-needs'),
    ).toMatchObject({ type: 'attendee-needs', enabled: false });
    expect(
      normalized.registrationFlow.steps.find((step) => step.nodeKey === 'flow.attendee-needs'),
    ).toMatchObject({ type: 'attendee-needs', enabled: false });
  });

  it('upgrades a legacy template at the old thirty-block capacity', () => {
    const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    if (definition.presentation.kind !== 'structured') {
      throw new Error('expected structured template');
    }
    definition.presentation.home.blocks = definition.presentation.home.blocks.filter(
      (block) => !['home.cooperation', 'home.attendee-needs'].includes(block.nodeKey),
    );
    while (definition.presentation.home.blocks.length < 30) {
      const index = definition.presentation.home.blocks.length;
      definition.presentation.home.blocks.push({
        nodeKey: `home.compat-${index}`,
        type: 'value',
        label: `兼容区块 ${index}`,
        enabled: false,
        variant: 'default',
        content: {},
      });
    }

    const normalized = normalizeConferenceTemplateDefinition(definition);
    if (normalized.presentation.kind !== 'structured') {
      throw new Error('expected structured template');
    }
    expect(normalized.presentation.home.blocks).toHaveLength(32);
    expect(normalized.presentation.home.blocks.map((block) => block.nodeKey)).toEqual(
      expect.arrayContaining(['home.cooperation', 'home.attendee-needs']),
    );
  });
});
