import { describe, expect, it } from 'vitest';
import {
  CustomerAttendeeServiceHubSchema,
  UpdateEventAttendeeServiceConfigurationSchema,
  UpdateRegistrationServiceAcknowledgementSchema,
} from './index.js';

const registration = {
  id: '10000000-0000-4000-8000-000000000001',
  eventId: 101,
  eventName: '第二届中国 GEO & AI 营销大会',
  eventSlug: 'tokems26',
  startsAt: '2026-11-21T01:00:00.000Z',
  endsAt: '2026-11-22T09:00:00.000Z',
  registrationCode: 'TOK-R-001',
  registrationStatus: 'confirmed' as const,
  attendeeName: '参会者',
  ticketTypeName: '大会通票',
  ticketCode: 'TOK-T-001',
  ticketStatus: 'valid' as const,
  createdAt: '2026-08-30T01:00:00.000Z',
  canManageOrder: false as const,
  orderId: null,
  orderNo: null,
  orderStatus: null,
  amount: null,
  currency: null,
  invoiceId: null,
  invoiceStatus: null,
  attendee: {
    name: '参会者',
    mobile: '138****0000',
    email: '',
    company: '示例公司',
    title: '市场负责人',
    city: '上海',
  },
};

describe('attendee service hub contracts', () => {
  it('accepts exactly six status-aware entries without storage paths', () => {
    const codes = [
      'ticket',
      'poster',
      'showcase',
      'needs',
      'organizer_contact',
      'invoice',
    ] as const;
    const result = CustomerAttendeeServiceHubSchema.parse({
      registration,
      items: codes.map((code, index) => ({
        code,
        state: index === 0 ? 'complete' : 'available',
        label: `状态 ${index}`,
        description: `说明 ${index}`,
      })),
      organizerContact: {
        enabled: true,
        eligible: true,
        organizerName: '大会小助手',
        organizerRole: '参会服务负责人',
        wechatId: 'tokems-helper',
        instructions: '添加时备注报名姓名',
        qrAvailable: true,
        confirmedAt: null,
      },
      latestPaymentStatus: null,
      actionRequiredCount: 0,
      updatedAt: '2026-08-30T02:00:00.000Z',
    });

    expect(result.items).toHaveLength(6);
    expect(JSON.stringify(result)).not.toMatch(/storageKey|objectKey|bucket/iu);
  });

  it('requires complete organizer information before enabling the service', () => {
    expect(
      UpdateEventAttendeeServiceConfigurationSchema.safeParse({
        version: 0,
        enabled: true,
        organizerName: '',
        organizerRole: '',
        wechatId: '',
        instructions: '',
        qrAssetId: null,
      }).success,
    ).toBe(false);
    expect(
      UpdateEventAttendeeServiceConfigurationSchema.safeParse({
        version: 0,
        enabled: false,
        organizerName: '',
        organizerRole: '',
        wechatId: '',
        instructions: '',
        qrAssetId: null,
      }).success,
    ).toBe(true);
  });

  it('only accepts an explicit acknowledgement boolean', () => {
    expect(UpdateRegistrationServiceAcknowledgementSchema.parse({ confirmed: true })).toEqual({
      confirmed: true,
    });
    expect(
      UpdateRegistrationServiceAcknowledgementSchema.safeParse({
        confirmed: true,
        actionCode: 'arbitrary_action',
      }).success,
    ).toBe(false);
  });
});
