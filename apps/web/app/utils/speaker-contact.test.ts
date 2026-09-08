import { describe, expect, it } from 'vitest';
import { isWechatContactUrl } from './speaker-contact';

describe('speaker WeChat contact links', () => {
  it('recognizes the contact URL encoded in a WeChat QR code', () => {
    expect(isWechatContactUrl('https://u.wechat.com/contact-example?s=2')).toBe(true);
  });

  it.each([
    'https://example.com/profile',
    'https://mp.weixin.qq.com/s/article-example',
    'https://u.wechat.com.evil.example/contact-example',
    'https://someone@u.wechat.com/contact-example',
    'https://u.wechat.com:8443/contact-example',
    'https://u.wechat.com/',
    'javascript:alert(1)',
    'invalid-url',
  ])('keeps %s out of the WeChat contact section', (value) => {
    expect(isWechatContactUrl(value)).toBe(false);
  });
});
