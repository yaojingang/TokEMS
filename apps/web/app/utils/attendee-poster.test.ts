import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS } from '@conference/contracts';
import {
  attendeeAvatarInitial,
  attendeePosterFilename,
  resolveAttendeePosterContent,
} from './attendee-poster';

describe('attendee avatar initial', () => {
  it('uses the first character of a Chinese attendee name', () => {
    expect(attendeeAvatarInitial('姚金刚')).toBe('姚');
  });

  it('trims surrounding whitespace and keeps Unicode characters intact', () => {
    expect(attendeeAvatarInitial('  🚀姚金刚  ')).toBe('🚀');
  });

  it('uses a stable fallback when the attendee has no display name', () => {
    expect(attendeeAvatarInitial('   ')).toBe('会');
    expect(attendeeAvatarInitial(null)).toBe('会');
  });
});

describe('attendee poster privacy', () => {
  it('removes every field the attendee chose to hide', () => {
    const content = resolveAttendeePosterContent({
      displayName: '参会者',
      company: '示例公司',
      title: '负责人',
      industryCode: 'ai',
      businessIntro: '希望认识行业伙伴',
      avatarUrl: '/avatar.webp',
      visibleFields: {
        ...DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
        avatar: false,
        displayName: false,
        company: false,
        title: false,
        industry: false,
        businessIntro: false,
      },
    });

    expect(content).toEqual({
      displayName: null,
      company: null,
      title: null,
      industryCode: null,
      businessIntro: null,
      avatarUrl: null,
    });
  });

  it('returns only poster-safe fields', () => {
    const content = resolveAttendeePosterContent({
      displayName: '参会者',
      company: '示例公司',
      title: '负责人',
      industryCode: 'ai',
      businessIntro: '希望认识行业伙伴',
      avatarUrl: '/avatar.webp',
      visibleFields: DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
    });

    expect(content).toMatchObject({ displayName: '参会者', avatarUrl: '/avatar.webp' });
    expect(content).not.toHaveProperty('contactPhone');
    expect(content).not.toHaveProperty('contactEmail');
    expect(content).not.toHaveProperty('wechatId');
  });

  it('keeps a hidden name out of the downloaded poster filename', () => {
    expect(attendeePosterFilename(null, 'GEO / AI 大会', 12)).toBe(
      '报名会员-012-GEO - AI 大会-报名海报.png',
    );
  });
});
