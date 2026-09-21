import { describe, expect, it } from 'vitest';
import type { PartnerProfileView } from '@conference/contracts';
import { partnerPosterFilename, resolvePartnerPosterContent } from './partner-poster';

const profile: PartnerProfileView = {
  version: 1,
  displayName: ' 合作伙伴 ',
  company: ' 示例公司 ',
  title: ' 负责人 ',
  industry: ' 企业服务 ',
  businessIntro: ' 期待交流合作 ',
  businessUrl: 'https://example.com',
  contactPhone: '13800138000',
  contactEmail: 'private@example.com',
  wechatId: 'private-wechat',
  avatarUrl: '/avatar.webp',
  gallery: [],
  publicStatus: 'published',
  searchIndexingEnabled: false,
  visibleFields: {
    avatar: true,
    displayName: true,
    company: true,
    title: true,
    industry: true,
    businessIntro: true,
    businessUrl: true,
    contactPhone: true,
    contactEmail: true,
    wechatId: true,
    gallery: true,
  },
  posterFields: {
    avatar: true,
    displayName: true,
    company: true,
    title: true,
    industry: true,
    businessIntro: true,
    businessUrl: true,
    contactPhone: true,
    contactEmail: true,
    wechatId: true,
    gallery: true,
  },
};

describe('partner poster authorization', () => {
  it('includes only the member-style poster fields', () => {
    expect(resolvePartnerPosterContent(profile)).toEqual({
      invitation: null,
      callToAction: null,
      scanHint: null,
      displayName: '合作伙伴',
      company: '示例公司',
      title: '负责人',
      industryLabel: '企业服务',
      businessIntro: '期待交流合作',
      avatarUrl: '/avatar.webp',
    });
  });

  it.each(['visibleFields', 'posterFields'] as const)(
    'requires %s authorization for every field',
    (scope) => {
      const source = {
        ...profile,
        [scope]: Object.fromEntries(Object.keys(profile[scope]).map((key) => [key, false])),
      };
      expect(resolvePartnerPosterContent(source)).toEqual({
        invitation: null,
      callToAction: null,
      scanHint: null,
        displayName: null,
        company: null,
        title: null,
        industryLabel: null,
        businessIntro: null,
        avatarUrl: null,
      });
    },
  );

  it('uses explicitly authored sharing copy while keeping profile authorization separate', () => {
    const source = { ...profile, posterCopy: { invitation: '欢迎同行', introduction: '定制合作介绍' } };
    expect(resolvePartnerPosterContent(source).invitation).toBe('欢迎同行');
    expect(resolvePartnerPosterContent(source).businessIntro).toBe('定制合作介绍');
    expect(resolvePartnerPosterContent({ ...source, posterFields: { ...source.posterFields, businessIntro: false } }).businessIntro).toBe('定制合作介绍');
  });

  it('keeps an unshared name out of the download filename', () => {
    expect(partnerPosterFilename(null, 'GEO / AI 大会')).toBe(
      '大会合作伙伴-GEO - AI 大会-推广海报.png',
    );
  });
});
