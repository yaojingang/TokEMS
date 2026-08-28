import { describe, expect, it } from 'vitest';
import {
  CANONICAL_HOMEPAGE_PUBLIC,
  CreateEventSchema,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  DEMO_EVENT,
  DEMO_EVENT_EXPERIENCE,
  ConferenceTemplateDefinitionSchema,
  PublicEventSchema,
} from './index.js';

describe('CreateEventSchema', () => {
  it('requires an explicit published template version', () => {
    const result = CreateEventSchema.safeParse({
      name: 'TokEMS 全球活动运营峰会',
      shortName: 'TokEMS 2027',
      slug: 'tokems-2027',
      startsAt: '2027-06-18T01:00:00.000Z',
      endsAt: '2027-06-19T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
      venue: '深圳国际会展中心',
      city: '深圳',
      address: '宝安区福海街道展城路 1 号',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join('.') === 'templateVersionId')).toBe(
      true,
    );
  });

  it('rejects unsupported event timezones', () => {
    const result = CreateEventSchema.safeParse({
      name: '无效时区大会',
      shortName: '无效时区',
      startsAt: '2027-06-18T01:00:00.000Z',
      endsAt: '2027-06-19T01:00:00.000Z',
      timezone: 'Not/A_Timezone',
      venue: '上海国际会议中心',
      city: '上海',
      address: '浦东新区滨江大道 2727 号',
      templateVersionId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result.success).toBe(false);
  });
});

describe('DEMO_EVENT', () => {
  it('ships with the published default conference experience', () => {
    const event = PublicEventSchema.parse(DEMO_EVENT);

    expect(event.experience).toEqual(DEMO_EVENT_EXPERIENCE);
    expect(event.experience?.template.versionId).toBe(CANONICAL_HOMEPAGE_PUBLIC.template.versionId);
    expect(event.experience?.home.blocks.map((block) => block.nodeKey)).toContain('home.hero');
    expect(event.experience?.home.blocks.map((block) => block.nodeKey)).toContain('home.members');
  });

  it('uses the committed canonical homepage as the system default template', () => {
    const definition = DEFAULT_CONFERENCE_TEMPLATE_DEFINITION;
    const event = PublicEventSchema.parse(DEMO_EVENT);
    const canonicalDefinition = ConferenceTemplateDefinitionSchema.parse(
      CANONICAL_HOMEPAGE_PUBLIC.template.definition,
    );
    const canonicalEvent = PublicEventSchema.parse(CANONICAL_HOMEPAGE_PUBLIC.publicEvent);

    expect(definition).toEqual(canonicalDefinition);
    expect(event).toEqual(canonicalEvent);
    expect(CANONICAL_HOMEPAGE_PUBLIC.source.organizationSlug).toBe('geo-conference');
    expect(event.slug).toBe('tokems26');
  });

  it('publishes the canonical agenda and valid session times', () => {
    const event = PublicEventSchema.parse(DEMO_EVENT);
    const definition = DEFAULT_CONFERENCE_TEMPLATE_DEFINITION;
    const canonicalDefinition = ConferenceTemplateDefinitionSchema.parse(
      CANONICAL_HOMEPAGE_PUBLIC.template.definition,
    );
    expect(definition.presentation.kind).toBe('structured');
    expect(canonicalDefinition.presentation.kind).toBe('structured');
    if (
      definition.presentation.kind !== 'structured' ||
      canonicalDefinition.presentation.kind !== 'structured'
    )
      return;

    const agenda = definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.agenda',
    );
    const canonicalAgenda = canonicalDefinition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.agenda',
    );
    expect(agenda).toEqual(canonicalAgenda);
    expect(event.sessions).toEqual(
      PublicEventSchema.parse(CANONICAL_HOMEPAGE_PUBLIC.publicEvent).sessions,
    );

    const toMinutes = (value: string) => {
      const [hours, minutes] = value.split(':').map(Number);
      return hours! * 60 + minutes!;
    };
    for (const session of event.sessions) {
      expect(toMinutes(session.endsAt ?? session.startsAt)).toBeGreaterThanOrEqual(
        toMinutes(session.startsAt),
      );
    }
  });
});

describe('conference template partnership organizations', () => {
  it('accepts ordered overrides and explicit empty groups', () => {
    const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    expect(definition.presentation.kind).toBe('structured');
    if (definition.presentation.kind !== 'structured') return;
    const cooperation = definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.cooperation',
    );
    expect(cooperation).toBeDefined();
    if (!cooperation) return;
    cooperation.content.organizationGroups = [
      {
        key: 'media',
        label: '媒体伙伴',
        meta: 'MEDIA NETWORK',
        organizations: ['媒体甲'],
      },
      {
        key: 'speaker',
        label: '嘉宾所属机构',
        meta: 'SPEAKER NETWORK',
        organizations: [],
      },
    ];

    expect(ConferenceTemplateDefinitionSchema.safeParse(definition).success).toBe(true);
  });

  it('rejects duplicate and unknown organization group keys', () => {
    const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    expect(definition.presentation.kind).toBe('structured');
    if (definition.presentation.kind !== 'structured') return;
    const cooperation = definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.cooperation',
    );
    expect(cooperation).toBeDefined();
    if (!cooperation) return;
    cooperation.content.organizationGroups = [
      {
        key: 'speaker',
        label: '嘉宾所属机构',
        meta: 'SPEAKER NETWORK',
        organizations: ['机构甲'],
      },
      {
        key: 'speaker',
        label: '重复分组',
        meta: 'DUPLICATE',
        organizations: ['机构乙'],
      },
    ];

    const duplicate = ConferenceTemplateDefinitionSchema.safeParse(definition);
    expect(duplicate.success).toBe(false);
    if (duplicate.success) return;
    expect(duplicate.error.issues.some((issue) => issue.message.includes('机构分组键重复'))).toBe(
      true,
    );

    cooperation.content.organizationGroups = [
      { key: 'sponsor', label: '赞助商', meta: 'SPONSOR', organizations: ['机构甲'] },
    ];
    expect(ConferenceTemplateDefinitionSchema.safeParse(definition).success).toBe(false);
  });
});
