import { describe, expect, it } from 'vitest';
import {
  CreateSpeakerSchema,
  encodeSpeakerRouteCode,
  publicSpeakerPath,
  PublicEventSpeakerDetailSchema,
  ReorderSpeakersSchema,
  speakerAvatarText,
  SpeakerRouteCodeSchema,
  SpeakerSocialLinkSchema,
  UpdateSpeakerSchema,
} from './index.js';

const speakerId = '55555555-5555-4555-8555-555555555551';

describe('speaker profile contracts', () => {
  it('creates stable four-letter speaker routes without exposing sequential identifiers', () => {
    expect(encodeSpeakerRouteCode(1)).toBe('tyzb');
    expect(encodeSpeakerRouteCode(2)).toBe('zxxc');
    expect(
      new Set(Array.from({ length: 1_000 }, (_, index) => encodeSpeakerRouteCode(index + 1))),
    ).toHaveLength(1_000);
    expect(SpeakerRouteCodeSchema.safeParse('abcd').success).toBe(true);
    expect(SpeakerRouteCodeSchema.safeParse('a1cd').success).toBe(false);
    expect(SpeakerRouteCodeSchema.safeParse('ABCd').success).toBe(false);
    expect(publicSpeakerPath('tyzb')).toBe('/speakers/tyzb');
    expect(() => publicSpeakerPath('../a')).toThrow();
  });

  it('accepts a complete professional speaker profile', () => {
    const result = CreateSpeakerSchema.parse({
      name: '姚金刚',
      role: '大会发起人 · GEO 方法论研究者',
      topic: '如何在 AI 世界占领消费者心智',
      bio: '长期研究品牌在生成式搜索中的表达与增长。',
      topicAbstract: '从用户问题、品牌证据和内容供给三个层面拆解 GEO。',
      websiteUrl: 'https://example.com/speakers/yao-jingang',
      socialLinks: [{ label: '公众号', url: 'https://example.com/geodahui' }],
      avatarAssetId: '77777777-7777-4777-8777-777777777777',
      tags: ['品牌心智', 'GEO方法论'],
      sortOrder: 3,
    });

    expect(result.socialLinks).toHaveLength(1);
    expect(result.bio).toContain('生成式搜索');
  });

  it('rejects private or executable social link schemes', () => {
    expect(
      SpeakerSocialLinkSchema.safeParse({ label: '个人邮箱', url: 'mailto:private@example.com' })
        .success,
    ).toBe(false);
    expect(
      SpeakerSocialLinkSchema.safeParse({ label: '主页', url: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });

  it('uses the first visible name character while preserving short existing abbreviations', () => {
    expect(speakerAvatarText(' 姚金刚 ')).toBe('姚');
    expect(speakerAvatarText('艾杰', 'AJ')).toBe('AJ');
    expect(speakerAvatarText('嘉宾', '超长缩写')).toBe('超长');
  });

  it('requires a unique complete speaker order', () => {
    expect(ReorderSpeakersSchema.safeParse({ speakerIds: [speakerId, speakerId] }).success).toBe(
      false,
    );
  });

  it('keeps omitted fields absent in partial speaker updates', () => {
    expect(UpdateSpeakerSchema.parse({ bio: '更新后的简介' })).toEqual({
      bio: '更新后的简介',
    });
  });

  it('parses a public speaker detail from a released snapshot', () => {
    const result = PublicEventSpeakerDetailSchema.parse({
      id: speakerId,
      publicCode: 'tyzb',
      name: '姚金刚',
      role: '大会发起人',
      topic: '如何在 AI 世界占领消费者心智',
      initials: '姚',
      accentFrom: '#2448a8',
      accentTo: '#102759',
      tags: ['GEO方法论'],
      eventName: '第二届中国 GEO & AI 营销大会',
      eventSlug: 'geo-conference-2026',
      eventStartsAt: '2026-11-21T01:00:00.000Z',
      eventEndsAt: '2026-11-22T09:00:00.000Z',
      eventTimezone: 'Asia/Shanghai',
      eventCity: '深圳',
      socialLinks: [],
    });

    expect(result.eventSlug).toBe('geo-conference-2026');
    expect(result.publicCode).toBe('tyzb');
    expect(result.eventCity).toBe('深圳');
    expect(result.avatarUrl).toBeUndefined();
  });
});
