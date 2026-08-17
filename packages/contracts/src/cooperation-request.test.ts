import { describe, expect, it } from 'vitest';
import {
  AdminCooperationRequestListQuerySchema,
  CreateCooperationRequestSchema,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  normalizeConferenceTemplateDefinition,
  UpdateCooperationRequestSchema,
} from './index.js';

describe('cooperation request contracts', () => {
  it('accepts one to three cooperation directions and a reachable contact', () => {
    const result = CreateCooperationRequestSchema.parse({
      eventId: 101,
      cooperationTypes: ['brand_sponsorship', 'media'],
      companyName: '深圳南山品牌增长研究院',
      contactName: '陈思远',
      contactTitle: '品牌合作负责人',
      mobile: '13800138000',
      email: '',
      wechatId: 'geo-chen',
      message: '希望围绕年度白皮书发布和现场品牌展示开展联合合作。',
      consentAccepted: true,
    });

    expect(result.cooperationTypes).toEqual(['brand_sponsorship', 'media']);
    expect(result.mobile).toBe('13800138000');
  });

  it('requires at least one usable contact channel', () => {
    const result = CreateCooperationRequestSchema.safeParse({
      eventId: 101,
      cooperationTypes: ['community'],
      companyName: '湾区人工智能产业联盟',
      contactName: '林书宁',
      mobile: '',
      email: '',
      wechatId: '',
      message: '希望组织会员企业共同参会，并协助大会内容传播。',
      consentAccepted: true,
    });

    expect(result.success).toBe(false);
  });

  it('rejects more than three directions and missing consent', () => {
    expect(
      CreateCooperationRequestSchema.safeParse({
        eventId: 101,
        cooperationTypes: ['brand_sponsorship', 'exhibition', 'media', 'content'],
        companyName: '深圳湾数字商业中心',
        contactName: '梁一凡',
        mobile: '13900139000',
        message: '希望了解本届大会多种合作资源的组合方式和现场权益。',
        consentAccepted: false,
      }).success,
    ).toBe(false);
  });

  it('parses admin filters and optimistic status updates', () => {
    expect(
      AdminCooperationRequestListQuerySchema.parse({
        q: '南山',
        status: 'new',
        type: 'media',
        page: '2',
        pageSize: '20',
      }),
    ).toMatchObject({ page: 2, pageSize: 20, status: 'new', type: 'media' });

    expect(
      UpdateCooperationRequestSchema.parse({
        status: 'contacted',
        internalNote: '已通过微信建立联系，等待对方提供合作方案。',
        expectedUpdatedAt: '2026-08-17T08:30:00.000Z',
      }).status,
    ).toBe('contacted');
  });

  it('adds the cooperation home block to an older structured template', () => {
    const older = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    if (older.presentation.kind !== 'structured') throw new Error('expected structured template');
    older.presentation.home.blocks = older.presentation.home.blocks.filter(
      (block) => block.nodeKey !== 'home.cooperation',
    );

    const normalized = normalizeConferenceTemplateDefinition(older);
    if (normalized.presentation.kind !== 'structured')
      throw new Error('expected structured template');
    expect(
      normalized.presentation.home.blocks.some((block) => block.nodeKey === 'home.cooperation'),
    ).toBe(true);
  });
});
