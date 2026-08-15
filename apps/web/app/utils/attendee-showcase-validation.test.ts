import {
  ATTENDEE_SHOWCASE_CONSENT_VERSION,
  DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
} from '@conference/contracts';
import { describe, expect, it } from 'vitest';
import {
  attendeeShowcaseApiValidationIssues,
  attendeeShowcaseValidationIssues,
} from './attendee-showcase-validation';

const validInput = {
  version: 4,
  displayName: '姚金刚',
  company: '示例公司',
  title: '负责人',
  industryCode: 'ai' as const,
  businessIntro: '正在建设企业 GEO 内容体系',
  businessUrl: 'https://example.com',
  contactPhone: '+8613800138000',
  contactEmail: 'attendee@example.com',
  wechatId: null,
  isPublic: true,
  visibleFields: DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
  consentVersion: ATTENDEE_SHOWCASE_CONSENT_VERSION,
};

describe('attendee showcase validation guidance', () => {
  it('lists every missing field required for public display with a form target', () => {
    expect(
      attendeeShowcaseValidationIssues({
        ...validInput,
        displayName: null,
        industryCode: null,
      }),
    ).toEqual([
      {
        field: 'displayName',
        label: '姓名',
        message: '公开名片需要填写姓名',
        targetId: 'showcase-display-name',
      },
      {
        field: 'industryCode',
        label: '主行业',
        message: '公开名片需要选择行业',
        targetId: 'showcase-industry-code',
      },
    ]);
  });

  it('allows an unfinished private profile to be saved for later', () => {
    expect(
      attendeeShowcaseValidationIssues({
        ...validInput,
        displayName: null,
        industryCode: null,
        isPublic: false,
      }),
    ).toEqual([]);
  });

  it('turns API validation details into actionable field guidance', () => {
    expect(
      attendeeShowcaseApiValidationIssues([
        { code: 'custom', path: ['industryCode'], message: '公开名片需要选择行业' },
        { code: 'custom', path: ['industryCode'], message: '公开名片需要选择行业' },
      ]),
    ).toEqual([
      {
        field: 'industryCode',
        label: '主行业',
        message: '公开名片需要选择行业',
        targetId: 'showcase-industry-code',
      },
    ]);
  });

  it('uses clear Chinese guidance for invalid website and email values', () => {
    expect(
      attendeeShowcaseValidationIssues({
        ...validInput,
        businessUrl: 'https://example .com',
        contactEmail: 'attendee.example.com',
      }),
    ).toEqual([
      {
        field: 'businessUrl',
        label: '公司或项目网址',
        message: '请输入有效的 HTTP 或 HTTPS 网址',
        targetId: 'showcase-business-url',
      },
      {
        field: 'contactEmail',
        label: '联系邮箱',
        message: '请输入有效的邮箱地址',
        targetId: 'showcase-contact-email',
      },
    ]);
  });
});
