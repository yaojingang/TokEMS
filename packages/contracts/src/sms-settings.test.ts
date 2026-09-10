import { describe, expect, it } from 'vitest';
import { UpdateAliyunSmsConfigurationSchema } from './index.js';

const templates = {
  customerOtp: { enabled: true, templateCode: 'SMS_123456' },
  registrationSubmitted: { enabled: false, templateCode: '' },
  registrationApproved: { enabled: false, templateCode: '' },
  registrationRejected: { enabled: false, templateCode: '' },
  paymentSucceeded: { enabled: false, templateCode: '' },
  waitlistAvailable: { enabled: false, templateCode: '' },
  invoiceDetailsRequested: { enabled: false, templateCode: '' },
  invoiceReady: { enabled: false, templateCode: '' },
  eventReminder: { enabled: false, templateCode: '' },
};

describe('Aliyun SMS settings contract', () => {
  it('accepts a complete configuration and trims credential values', () => {
    const result = UpdateAliyunSmsConfigurationSchema.parse({
      enabled: true,
      expectedUpdatedAt: null,
      signName: ' 大会通知 ',
      accessKeyId: ' LTAI1234567890123456 ',
      accessKeySecret: ' secret-value-1234567890 ',
      templates,
    });
    expect(result.signName).toBe('大会通知');
    expect(result.accessKeyId).toBe('LTAI1234567890123456');
  });

  it('rejects an enabled scenario without an approved template code', () => {
    const result = UpdateAliyunSmsConfigurationSchema.safeParse({
      enabled: true,
      expectedUpdatedAt: null,
      signName: '大会通知',
      templates: {
        ...templates,
        customerOtp: { enabled: true, templateCode: '' },
      },
    });
    expect(result.success).toBe(false);
  });
  it('requires a configuration version and accepts all notification scenes switched off', () => {
    const input = {
      enabled: true,
      signName: '测试签名',
      templates: Object.fromEntries(
        Object.entries(templates).map(([key, value]) => [key, { ...value, enabled: false }]),
      ),
    };
    expect(UpdateAliyunSmsConfigurationSchema.safeParse(input).success).toBe(false);
    expect(
      UpdateAliyunSmsConfigurationSchema.safeParse({ ...input, expectedUpdatedAt: null }).success,
    ).toBe(true);
  });
});
