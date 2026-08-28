import { describe, expect, it } from 'vitest';
import type { PublicEventMemberItem, Speaker } from '@conference/contracts';
import {
  buildPartnershipOrganizationGroups,
  speakerOrganizationNames,
} from './partnership-organizations';

const speaker = (role: string): Speaker => ({
  id: crypto.randomUUID(),
  name: '嘉宾',
  role,
  topic: '大会主题',
  initials: '嘉',
  accentFrom: '#2563eb',
  accentTo: '#1d4ed8',
  tags: [],
});

const member = (company?: string): PublicEventMemberItem => ({
  publicSlug: crypto.randomUUID(),
  sequence: 1,
  ...(company ? { company } : {}),
});

describe('speakerOrganizationNames', () => {
  it('extracts organization names and drops personal role descriptions', () => {
    expect(speakerOrganizationNames('猎河科技创始人 · 移山科技 COO')).toEqual([
      '猎河科技',
      '移山科技',
    ]);
    expect(speakerOrganizationNames('海外 SEO 专家 · AI 出海公司创始人')).toEqual([]);
    expect(speakerOrganizationNames('每经科技首席产品官 · GEO 媒体沙龙主持人')).toEqual([
      '每经科技',
    ]);
  });
});

describe('buildPartnershipOrganizationGroups', () => {
  it('groups public organizations and removes duplicates across member data', () => {
    const groups = buildPartnershipOrganizationGroups(
      [speaker('猎河科技创始人 · 移山科技 COO'), speaker('媒介匣 CEO'), speaker('北京日报社副总')],
      [member('猎河科技'), member('未来商业实验室'), member('未来商业实验室'), member()],
    );

    expect(groups).toEqual([
      {
        key: 'speaker',
        index: '01',
        label: '嘉宾所属机构',
        meta: 'SPEAKER NETWORK',
        organizations: ['猎河科技', '移山科技'],
      },
      {
        key: 'media',
        index: '02',
        label: '媒体机构',
        meta: 'MEDIA NETWORK',
        organizations: ['媒介匣', '北京日报社'],
      },
      {
        key: 'member',
        index: '03',
        label: '参会会员机构',
        meta: 'ATTENDEE NETWORK',
        organizations: ['未来商业实验室'],
      },
    ]);
  });

  it('omits empty groups', () => {
    expect(buildPartnershipOrganizationGroups([], [])).toEqual([]);
  });

  it('uses configured groups in template order', () => {
    const groups = buildPartnershipOrganizationGroups(
      [speaker('猎河科技创始人'), speaker('媒介匣 CEO')],
      [member('未来商业实验室')],
      [
        {
          key: 'member',
          label: '同行机构',
          meta: 'PEER NETWORK',
          organizations: ['机构乙', '机构甲'],
        },
        {
          key: 'speaker',
          label: '分享机构',
          meta: 'SPEAKER NETWORK',
          organizations: ['机构丙'],
        },
        {
          key: 'media',
          label: '媒体伙伴',
          meta: 'MEDIA NETWORK',
          organizations: ['机构丁'],
        },
      ],
    );

    expect(groups.map(({ key, index, organizations }) => ({ key, index, organizations }))).toEqual([
      { key: 'member', index: '01', organizations: ['机构乙', '机构甲'] },
      { key: 'speaker', index: '02', organizations: ['机构丙'] },
      { key: 'media', index: '03', organizations: ['机构丁'] },
    ]);
  });

  it('appends derived groups when a configured group is omitted', () => {
    const groups = buildPartnershipOrganizationGroups(
      [speaker('猎河科技创始人 · 媒介匣 CEO')],
      [member('未来商业实验室')],
      [
        {
          key: 'media',
          label: '媒体伙伴',
          meta: 'MEDIA NETWORK',
          organizations: ['大会观察'],
        },
      ],
    );

    expect(groups.map(({ key, organizations }) => ({ key, organizations }))).toEqual([
      { key: 'media', organizations: ['大会观察'] },
      { key: 'speaker', organizations: ['猎河科技'] },
      { key: 'member', organizations: ['未来商业实验室'] },
    ]);
  });

  it('uses an explicit empty list to hide a group', () => {
    const groups = buildPartnershipOrganizationGroups(
      [speaker('猎河科技创始人')],
      [member('未来商业实验室')],
      [
        {
          key: 'speaker',
          label: '嘉宾所属机构',
          meta: 'SPEAKER NETWORK',
          organizations: [],
        },
      ],
    );

    expect(groups.map(({ key, index }) => ({ key, index }))).toEqual([
      { key: 'member', index: '01' },
    ]);
  });

  it('deduplicates organizations across groups using first group precedence', () => {
    const groups = buildPartnershipOrganizationGroups(
      [],
      [],
      [
        {
          key: 'media',
          label: '媒体伙伴',
          meta: 'MEDIA NETWORK',
          organizations: ['共同机构', '媒体甲'],
        },
        {
          key: 'speaker',
          label: '嘉宾所属机构',
          meta: 'SPEAKER NETWORK',
          organizations: ['共同机构', '嘉宾机构'],
        },
      ],
    );

    expect(groups.map(({ key, organizations }) => ({ key, organizations }))).toEqual([
      { key: 'media', organizations: ['共同机构', '媒体甲'] },
      { key: 'speaker', organizations: ['嘉宾机构'] },
    ]);
  });

  it('falls back to derived groups for invalid configuration', () => {
    const groups = buildPartnershipOrganizationGroups(
      [speaker('猎河科技创始人')],
      [],
      [{ key: 'unknown', organizations: [] }],
    );

    expect(groups.map(({ key, organizations }) => ({ key, organizations }))).toEqual([
      { key: 'speaker', organizations: ['猎河科技'] },
    ]);
  });
});
