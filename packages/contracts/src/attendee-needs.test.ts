import { describe, expect, it } from 'vitest';
import {
  ATTENDEE_NEED_CONSENT_VERSION,
  ATTENDEE_NEED_TOPIC_OPTIONS,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  PublicAttendeeNeedItemSchema,
  UpdateAdminAttendeeNeedQuestionSchema,
  UpdateAttendeeNeedsSchema,
} from './index.js';

const validQuestion = {
  content: '企业内部应该由哪个部门牵头 GEO？',
  tagCodes: ['enterprise-adoption', 'geo-team-talent'],
};

describe('attendee needs contracts', () => {
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

  it('adds disabled attendee-needs nodes to the structured template', () => {
    expect(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.kind).toBe('structured');
    if (DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.kind !== 'structured') return;

    expect(
      DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.registrationFlow.steps.some(
        (step) => step.nodeKey === 'flow.attendee-needs' && !step.enabled,
      ),
    ).toBe(true);
    expect(
      DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.home.blocks.some(
        (block) => block.nodeKey === 'home.attendee-needs' && !block.enabled,
      ),
    ).toBe(true);
  });
});
