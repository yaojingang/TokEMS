import { describe, expect, it } from 'vitest';
import {
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
    expect(event.experience?.template.versionId).toBe('29292929-2929-4292-8292-292929292929');
    expect(event.experience?.home.blocks.map((block) => block.nodeKey)).toContain('home.hero');
    expect(event.experience?.home.blocks.map((block) => block.nodeKey)).toContain('home.members');
  });

  it('keeps the GEO 2026 public copy in the system default template', () => {
    const definition = DEFAULT_CONFERENCE_TEMPLATE_DEFINITION;
    const event = PublicEventSchema.parse(DEMO_EVENT);
    expect(definition.presentation.kind).toBe('structured');
    if (definition.presentation.kind !== 'structured') return;

    const hero = definition.presentation.home.blocks.find((block) => block.nodeKey === 'home.hero');
    const upgrade = definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.upgrade',
    );
    const tickets = definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.tickets',
    );
    const navigation = definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.navigation',
    );
    const stats = definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.stats',
    );
    const expectedBenefits = [
      '2 天大会 VIP 门票',
      'Day 2 出海与实操专场席位',
      '大会 VIP 会员社群',
      '2 本 AI 与 GEO 签名书籍',
      '个人信息展示权益',
      '《中国 GEO 行业白皮书 2026》',
      '20+ 嘉宾干货资料包',
      '大会回放视频',
    ];

    expect(hero?.content).toMatchObject({
      titlePrefix: '第二届中国',
      titleEvent: 'GEO & AI 营销大会',
      slogan: '让好的品牌被 AI 正确推荐',
      viewsLabel: '大会访问量',
      viewsBase: '10000',
    });
    expect(upgrade?.content.titleLine2).toBe('第二届回答「GEO 怎么赢」');
    expect(navigation?.content).toMatchObject({ whyLabel: '背景', membersLabel: '会员' });
    expect(stats?.enabled).toBe(true);
    expect(stats?.variant).toBe('inline');
    expect(tickets?.content.title).toBe('会员报名权益');
    expect(definition.initialization.ticketTypes[0]).toMatchObject({
      name: '大会通票',
      price: 39900,
      capacity: 500,
      benefits: expectedBenefits,
    });
    expect(event.tickets[0]?.benefits).toEqual(expectedBenefits);
    expect(event.name).toBe('第二届中国 GEO & AI 营销大会');
    expect(event.venue).toBe('南山区（具体酒店待定）');
    expect(event.address).toBe('广东省深圳市南山区（具体酒店待定）');
    expect(event.speakers[0]?.name).toBe('姚金刚');
    expect(event.faqs[0]?.question).toBe('GEO 到底是什么，和 SEO 有什么关系？');
  });

  it('publishes a continuous single-track agenda on both days', () => {
    const event = PublicEventSchema.parse(DEMO_EVENT);
    const definition = DEFAULT_CONFERENCE_TEMPLATE_DEFINITION;
    expect(definition.presentation.kind).toBe('structured');
    if (definition.presentation.kind !== 'structured') return;

    const agenda = definition.presentation.home.blocks.find(
      (block) => block.nodeKey === 'home.agenda',
    );
    const publicAgendaCopy = JSON.stringify({ agenda: agenda?.content, sessions: event.sessions });
    expect(publicAgendaCopy).not.toMatch(/分会场|多会场|A 会场|B 会场/u);
    expect(agenda?.content).toMatchObject({
      day1Subtitle: '主会场 · 战略、增长与前沿',
      day2Subtitle: '主会场 · 上午出海，下午实操',
      day2MorningTitle: '出海专场 · 全球 AI 增长',
      day2AfternoonTitle: '实操专场 · 诊断、Agent 与 FDE',
    });
    expect(event.sessions.filter((session) => session.kind !== 'break')).toHaveLength(20);

    const toMinutes = (value: string) => {
      const [hours, minutes] = value.split(':').map(Number);
      return hours! * 60 + minutes!;
    };
    for (const day of [1, 2]) {
      const sessions = event.sessions.filter((session) => session.day === day);
      for (let index = 1; index < sessions.length; index += 1) {
        const previous = sessions[index - 1]!;
        const current = sessions[index]!;
        expect(toMinutes(previous.endsAt ?? previous.startsAt)).toBeLessThanOrEqual(
          toMinutes(current.startsAt),
        );
      }
    }

    const day2Topics = event.sessions
      .filter((session) => session.day === 2)
      .map((session) => `${session.title} ${session.summary ?? ''}`)
      .join(' ');
    expect(day2Topics).toContain('出海 GEO');
    expect(day2Topics).toContain('Agent');
    expect(day2Topics).toContain('FDE');
    expect(day2Topics).toContain('AI 营销');
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
