import { describe, expect, it } from 'vitest';
import { aliyunDomesticPhone, readAliyunSmsConfiguration } from './index.js';

describe('Aliyun SMS helpers', () => {
  it('normalizes mainland mobile numbers for SendSms', () => {
    expect(aliyunDomesticPhone('+8613800138000')).toBe('13800138000');
    expect(aliyunDomesticPhone('13900139000')).toBe('13900139000');
    expect(() => aliyunDomesticPhone('+85212345678')).toThrow('中国大陆手机号');
  });

  it('normalizes stored configuration without accepting a custom endpoint', () => {
    const configuration = readAliyunSmsConfiguration({
      enabled: true,
      signName: '大会通知',
      endpoint: 'attacker.example.com',
      templates: {
        customerOtp: { enabled: true, templateCode: 'SMS_123456' },
      },
    });
    expect(configuration.endpoint).toBe('dysmsapi.aliyuncs.com');
    expect(configuration.templates.customerOtp).toEqual({
      enabled: true,
      templateCode: 'SMS_123456',
      status: 'unverified',
      lastVerifiedAt: null,
      lastError: null,
    });
    expect(configuration.templates.paymentSucceeded.enabled).toBe(false);
    expect(configuration.templates.ticketIssued.enabled).toBe(false);
    expect(configuration.templates.refundSucceeded.enabled).toBe(false);
  });
});
