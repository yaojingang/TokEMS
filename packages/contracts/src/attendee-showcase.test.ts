import { describe, expect, it } from 'vitest';
import {
  ATTENDEE_SHOWCASE_CONSENT_VERSION,
  DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  DEMO_EVENT,
  PublicEventMemberItemSchema,
  UpdateAttendeeShowcaseSchema,
} from './index.js';

describe('attendee showcase contracts', () => {
  it('keeps contact fields private by default', () => {
    expect(DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS).toMatchObject({
      avatar: true,
      displayName: true,
      company: true,
      contactPhone: false,
      contactEmail: false,
      wechatId: false,
    });
  });

  it('requires identity and industry before public display can be enabled', () => {
    const result = UpdateAttendeeShowcaseSchema.safeParse({
      version: 0,
      displayName: null,
      company: null,
      title: null,
      industryCode: null,
      businessIntro: null,
      businessUrl: null,
      contactPhone: null,
      contactEmail: null,
      wechatId: null,
      isPublic: true,
      visibleFields: DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
      consentVersion: ATTENDEE_SHOWCASE_CONSENT_VERSION,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['displayName', 'industryCode']),
      );
    }
  });

  it('accepts a website without a protocol and normalizes it to HTTPS', () => {
    const result = UpdateAttendeeShowcaseSchema.parse({
      version: 0,
      displayName: null,
      company: null,
      title: null,
      industryCode: null,
      businessIntro: null,
      businessUrl: 'www.baidu.com',
      contactPhone: null,
      contactEmail: null,
      wechatId: null,
      isPublic: false,
      visibleFields: DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
      consentVersion: ATTENDEE_SHOWCASE_CONSENT_VERSION,
    });

    expect(result.businessUrl).toBe('https://www.baidu.com');
  });

  it('strips non-card fields from a public list item', () => {
    const result = PublicEventMemberItemSchema.parse({
      publicSlug: 'public-member-id',
      sequence: 1,
      displayName: '参会者',
      company: '示例公司',
      title: '负责人',
      industryCode: 'ai',
      industryLabel: 'AI / 大模型 / Agent',
      initials: '会者',
      contactPhone: '13800000000',
    });
    expect(result).not.toHaveProperty('contactPhone');
  });

  it('ships the member block and profile step in the structured template', () => {
    expect(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.kind).toBe('structured');
    if (DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.kind !== 'structured') return;
    expect(
      DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.home.blocks.some(
        (block) => block.nodeKey === 'home.members' && block.type === 'members',
      ),
    ).toBe(true);
    expect(
      DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.registrationFlow.steps.some(
        (step) => step.type === 'member-profile',
      ),
    ).toBe(true);
  });

  it('publishes exactly one member block in the demo event snapshot', () => {
    expect(
      DEMO_EVENT.experience?.home.blocks.filter((block) => block.nodeKey === 'home.members'),
    ).toHaveLength(1);
  });
});
